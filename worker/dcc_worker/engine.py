"""Rule engine: decides which rules apply to a submission, then turns the AI's
answers into pass, fail, needs-review or not-applicable findings and a score
per scheme. Everything here is deterministic, so the same answers and the same
rule set always give the same result.

Which rules apply: the submission's schemes and environment, the rule's status
and effective dates on the day of validation, and whether the rule can be
checked from uploaded screens and receipts at all (registration, certification,
message-data and dispute rules cannot, and are listed separately).

Rule types: MUST and MUST_NOT are scored. SHOULD is advisory: reported, never
scored. MAY and INFO are context for the AI (exemptions, consequences).

Scoring (per scheme, over scored rules that apply):
  score   = 100 x weight of passed rules / weight of scored rules
  verdict = "not_compliant" if any critical rule fails,
            "compliant"     if every scored rule passes,
            "needs_review"  otherwise.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

DOCUMENT_NAMES = {"choice_screen": "currency choice screen", "receipt": "receipt"}


@dataclass
class Answer:
    answer: str  # "yes" | "no" | "not_visible"
    number: float | None = None
    evidence: str = ""
    document: int | None = None


@dataclass
class Judgement:
    outcome: str  # "pass" | "fail" | "needs_review"
    evidence: str = ""
    document: int | None = None


@dataclass
class Extraction:
    document_kinds: list[str]  # kind of each uploaded document, in order
    facts: dict[str, Answer] = field(default_factory=dict)
    judgements: dict[str, Judgement] = field(default_factory=dict)


# Submission channel -> ruleset environment code.
ENVIRONMENTS = {
    "pos": "POS_ATTENDED",
    "pos_unattended": "POS_UNATTENDED",
    "atm": "ATM",
    "branch": "BRANCH",
    "ecommerce": "ECOM",
    "mail": "MAIL",
    "phone": "PHONE",
    "priority": "PRIORITY",
    "stored": "STORED",
}
# What uploads can show. Rules that evaluate only other things (REGISTRATION,
# CERTIFICATION, PROC, EVIDENCE, DISPUTE, AUDIT) cannot be checked from them.
CHECKABLE = ("SCREEN", "RECEIPT", "FLOW", "AGREEMENT", "CLASSIFICATION", "SCRIPT")
SCORED = ("MUST", "MUST_NOT")
JUDGED = ("MUST", "MUST_NOT", "SHOULD")


def _day(value) -> date | None:
    return date.fromisoformat(value) if isinstance(value, str) and value else value


def in_force(rule: dict, today: date) -> bool:
    status = rule.get("rule_status", "ACTIVE")
    starts, ends = _day(rule.get("valid_from")), _day(rule.get("valid_to"))
    if status == "EXPIRED" or (ends and ends < today) or (starts and starts > today):
        return False
    return status != "FUTURE" or starts is not None


def in_scope(rule: dict, schemes: list[str], channel: str, today: date) -> bool:
    env = ENVIRONMENTS[channel]
    envs = rule.get("environments") or ["ALL"]
    return (
        rule["active"]
        and rule["scheme"] in schemes
        and ("ALL" in envs or env in envs)
        and env not in (rule.get("excluded_environments") or [])
        and in_force(rule, today)
    )


def checkable(rule: dict) -> bool:
    parts = [p.strip().upper() for p in (rule.get("evaluates") or "SCREEN").split("/")]
    return any(p.startswith(CHECKABLE) for p in parts)


def rule_type(rule: dict) -> str:
    return rule.get("rule_type", "MUST")


def select(rules: list[dict], schemes: list[str], channel: str, today: date) -> dict[str, list[dict]]:
    """Split the rule set into what the AI assesses, the context it reads, and
    the rules that apply but cannot be checked from uploads."""
    mine = [r for r in rules if in_scope(r, schemes, channel, today)]
    return {
        "assessed": [r for r in mine if rule_type(r) in JUDGED and checkable(r)],
        "context": [r for r in mine if rule_type(r) not in JUDGED],
        "not_checked": [r for r in mine if rule_type(r) in JUDGED and not checkable(r)],
    }


def _fact_finding(rule: dict, fact: dict | None, ex: Extraction) -> tuple[str, str, int | None]:
    if fact is None:
        return "needs_review", "This rule's question is no longer in the fact list.", None
    doc = fact["document"]
    if doc in DOCUMENT_NAMES and doc not in ex.document_kinds:
        return "needs_review", f"No {DOCUMENT_NAMES[doc]} was found in the uploaded files.", None
    a = ex.facts.get(fact["key"])
    if a is None or a.answer == "not_visible":
        why = a.evidence if a and a.evidence else "This could not be seen in the uploaded files."
        return "needs_review", why, a.document if a else None

    expected = rule["expected"]
    if expected in ("yes", "no"):
        if fact["kind"] == "number":
            ok = (a.number is not None) == (expected == "yes")
        else:
            ok = a.answer == expected
        return ("pass" if ok else "fail"), a.evidence, a.document

    if a.number is None:
        return "needs_review", a.evidence or "No figure could be read.", a.document
    threshold = float(rule["threshold"])
    ok = a.number >= threshold if expected == "at_least" else a.number <= threshold
    shown = f"{a.number:g}"
    detail = f"Shown: {shown}; required {'at least' if expected == 'at_least' else 'at most'} {threshold:g}."
    return ("pass" if ok else "fail"), f"{a.evidence} {detail}".strip(), a.document


def evaluate(
    rules: list[dict], facts: list[dict], ex: Extraction, schemes: list[str], channel: str, today: date
) -> dict:
    """Return {"findings": [...], "not_checked": [...], "schemes": {scheme: summary}}."""
    by_key = {f["key"]: f for f in facts}
    chosen = select(rules, schemes, channel, today)
    findings = []
    for rule in chosen["assessed"]:
        if rule["check_type"] == "fact":
            outcome, evidence, document = _fact_finding(rule, by_key.get(rule["fact_key"]), ex)
        else:
            j = ex.judgements.get(rule["code"])
            if j is None:
                outcome, evidence, document = "needs_review", "No assessment was returned for this rule.", None
            else:
                outcome, evidence, document = j.outcome, j.evidence, j.document
        findings.append(
            {
                "rule_id": rule["id"],
                "code": rule["code"],
                "scheme": rule["scheme"],
                "title": rule["title"],
                "requirement": rule["requirement"],
                "source": rule["source_reference"],
                "severity": rule["severity"],
                "weight": rule["weight"],
                "verified": rule["verified"],
                "check_type": rule["check_type"],
                "rule_type": rule_type(rule),
                "sort": rule.get("sort", 0),
                "domain": rule.get("domain", ""),
                "outcome": outcome,
                "evidence": evidence,
                "document": document,
            }
        )
    not_checked = [
        {"code": r["code"], "scheme": r["scheme"], "title": r["title"], "rule_type": rule_type(r),
         "evaluates": r.get("evaluates", ""), "source": r["source_reference"]}
        for r in chosen["not_checked"]
    ]
    return {
        "findings": findings,
        "not_checked": not_checked,
        "schemes": {s: summarise(findings, not_checked, s) for s in schemes},
    }


def summarise(findings: list[dict], not_checked: list[dict], scheme: str) -> dict:
    mine = [f for f in findings if f["scheme"] == scheme]
    scored = [f for f in mine if f["rule_type"] in SCORED and f["outcome"] != "not_applicable"]
    advisory = [f for f in mine if f["rule_type"] not in SCORED and f["outcome"] != "not_applicable"]
    total = sum(f["weight"] for f in scored)
    passed = sum(f["weight"] for f in scored if f["outcome"] == "pass")
    count = {o: sum(1 for f in scored if f["outcome"] == o) for o in ("pass", "fail", "needs_review")}
    if not scored:
        verdict = "no_rules"
    elif any(f["outcome"] == "fail" and f["severity"] == "critical" for f in scored):
        verdict = "not_compliant"
    elif count["pass"] == len(scored):
        verdict = "compliant"
    else:
        verdict = "needs_review"
    return {
        "score": round(100 * passed / total) if total else None,
        "verdict": verdict,
        "passed": count["pass"],
        "failed": count["fail"],
        "needs_review": count["needs_review"],
        "rules": len(scored),
        "advisory_failed": sum(1 for f in advisory if f["outcome"] == "fail"),
        "not_applicable": sum(1 for f in mine if f["outcome"] == "not_applicable"),
        "not_checked": sum(1 for r in not_checked if r["scheme"] == scheme),
        "unverified_rules": sum(1 for f in mine if not f["verified"]),
    }
