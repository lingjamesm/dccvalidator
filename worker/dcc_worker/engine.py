"""Rule engine: turns the AI's answers into pass, fail or needs-review findings
and a score per scheme. Everything here is deterministic, so the same answers
and the same rule set always give the same result.

Scoring (per scheme):
  score   = 100 x weight of passed rules / weight of all applicable rules
  verdict = "not_compliant" if any critical rule fails,
            "compliant"     if every applicable rule passes,
            "needs_review"  otherwise.
"""

from __future__ import annotations

from dataclasses import dataclass, field

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


def applicable(rules: list[dict], schemes: list[str], channel: str) -> list[dict]:
    return [r for r in rules if r["active"] and r["scheme"] in schemes and channel in r["channels"]]


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


def evaluate(rules: list[dict], facts: list[dict], ex: Extraction, schemes: list[str], channel: str) -> dict:
    """Return {"findings": [...], "schemes": {scheme: summary}} for the applicable rules."""
    by_key = {f["key"]: f for f in facts}
    findings = []
    for rule in applicable(rules, schemes, channel):
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
                "outcome": outcome,
                "evidence": evidence,
                "document": document,
            }
        )
    return {"findings": findings, "schemes": {s: summarise(findings, s) for s in schemes}}


def summarise(findings: list[dict], scheme: str) -> dict:
    mine = [f for f in findings if f["scheme"] == scheme]
    total = sum(f["weight"] for f in mine)
    passed = sum(f["weight"] for f in mine if f["outcome"] == "pass")
    count = {o: sum(1 for f in mine if f["outcome"] == o) for o in ("pass", "fail", "needs_review")}
    if not mine:
        verdict = "no_rules"
    elif any(f["outcome"] == "fail" and f["severity"] == "critical" for f in mine):
        verdict = "not_compliant"
    elif count["pass"] == len(mine):
        verdict = "compliant"
    else:
        verdict = "needs_review"
    return {
        "score": round(100 * passed / total) if total else None,
        "verdict": verdict,
        "passed": count["pass"],
        "failed": count["fail"],
        "needs_review": count["needs_review"],
        "rules": len(mine),
        "unverified_rules": sum(1 for f in mine if not f["verified"]),
    }
