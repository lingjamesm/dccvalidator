from datetime import date

from dcc_worker.engine import Answer, Extraction, Judgement, evaluate, select

TODAY = date(2026, 11, 4)

FACTS = [
    {"key": "cs_both_options", "document": "choice_screen", "kind": "yes_no", "question": "q?"},
    {"key": "cs_exchange_rate", "document": "choice_screen", "kind": "yes_no", "question": "q?"},
    {"key": "cs_markup_percent", "document": "choice_screen", "kind": "number", "question": "q?"},
    {"key": "rc_exchange_rate", "document": "receipt", "kind": "yes_no", "question": "q?"},
]


def rule(code, scheme="visa", severity="major", weight=5, check_type="fact", fact_key=None, expected="yes",
         threshold=None, environments=("ALL",), active=True, rule_type="MUST", evaluates="SCREEN/RECEIPT",
         rule_status="ACTIVE", valid_from=None, valid_to=None, excluded=()):
    return {
        "id": code, "code": code, "scheme": scheme, "environments": list(environments),
        "excluded_environments": list(excluded), "rule_type": rule_type, "evaluates": evaluates,
        "rule_status": rule_status, "valid_from": valid_from, "valid_to": valid_to, "title": code,
        "requirement": "r", "source_reference": "s", "check_type": check_type,
        "fact_key": fact_key, "expected": expected if check_type == "fact" else None,
        "threshold": threshold, "severity": severity, "weight": weight, "verified": False, "active": active,
    }


def outcomes(result):
    return {f["code"]: f["outcome"] for f in result["findings"]}


def test_pass_fail_and_needs_review():
    rules = [
        rule("A", fact_key="cs_both_options", severity="critical", weight=10),
        rule("B", fact_key="cs_exchange_rate", weight=6),
        rule("C", fact_key="rc_exchange_rate", weight=4),
    ]
    ex = Extraction(["choice_screen"], {
        "cs_both_options": Answer("yes", evidence="Pay in EUR / Pay in USD"),
        "cs_exchange_rate": Answer("no", evidence="No rate shown"),
    })
    r = evaluate(rules, FACTS, ex, ["visa"], "pos", TODAY)
    assert outcomes(r) == {"A": "pass", "B": "fail", "C": "needs_review"}
    assert "No receipt" in r["findings"][2]["evidence"]
    v = r["schemes"]["visa"]
    assert v["score"] == 50 and v["verdict"] == "needs_review"
    assert v["unverified_rules"] == 3


def test_critical_failure_means_not_compliant_whatever_the_score():
    rules = [rule("A", fact_key="cs_both_options", severity="critical", weight=1),
             rule("B", fact_key="cs_exchange_rate", weight=10)]
    ex = Extraction(["choice_screen"], {"cs_both_options": Answer("no"), "cs_exchange_rate": Answer("yes")})
    v = evaluate(rules, FACTS, ex, ["visa"], "pos", TODAY)["schemes"]["visa"]
    assert v["score"] == 91 and v["verdict"] == "not_compliant"


def test_all_pass_is_compliant():
    rules = [rule("A", fact_key="cs_both_options")]
    ex = Extraction(["choice_screen"], {"cs_both_options": Answer("yes")})
    v = evaluate(rules, FACTS, ex, ["visa"], "pos", TODAY)["schemes"]["visa"]
    assert v == {**v, "score": 100, "verdict": "compliant"}


def test_not_visible_needs_review():
    rules = [rule("A", fact_key="cs_both_options")]
    ex = Extraction(["choice_screen"], {"cs_both_options": Answer("not_visible", evidence="Screen is blurred")})
    f = evaluate(rules, FACTS, ex, ["visa"], "pos", TODAY)["findings"][0]
    assert f["outcome"] == "needs_review" and f["evidence"] == "Screen is blurred"


def test_number_thresholds():
    rules = [rule("A", fact_key="cs_markup_percent", expected="at_most", threshold=4),
             rule("B", fact_key="cs_markup_percent", expected="at_least", threshold=4)]
    ex = Extraction(["choice_screen"], {"cs_markup_percent": Answer("yes", number=3.5)})
    assert outcomes(evaluate(rules, FACTS, ex, ["visa"], "pos", TODAY)) == {"A": "pass", "B": "fail"}


def test_judgement_rules_use_the_ai_assessment():
    rules = [rule("J", check_type="judgement"), rule("K", check_type="judgement")]
    ex = Extraction(["choice_screen"], judgements={"J": Judgement("fail", "Says 'recommended'", 0)})
    r = evaluate(rules, FACTS, ex, ["visa"], "pos", TODAY)
    assert outcomes(r) == {"J": "fail", "K": "needs_review"}
    assert r["findings"][0]["document"] == 0


def test_only_matching_scheme_channel_and_active_rules_apply():
    rules = [
        rule("V", fact_key="cs_both_options"),
        rule("M", scheme="mastercard", fact_key="cs_both_options"),
        rule("ATM", fact_key="cs_both_options", environments=["ATM"]),
        rule("OFF", fact_key="cs_both_options", active=False),
    ]
    ex = Extraction(["choice_screen"], {"cs_both_options": Answer("yes")})
    r = evaluate(rules, FACTS, ex, ["visa"], "pos", TODAY)
    assert outcomes(r) == {"V": "pass"}
    assert set(r["schemes"]) == {"visa"}


def test_environments_dates_and_checkability_decide_what_applies():
    rules = [
        rule("ALL", check_type="judgement"),
        rule("ATT", check_type="judgement", environments=["POS_ATTENDED"]),
        rule("UNATT", check_type="judgement", environments=["POS_UNATTENDED"]),
        rule("NOT-MAIL", check_type="judgement", excluded=["POS_ATTENDED"]),
        rule("FUTURE", check_type="judgement", rule_status="FUTURE", valid_from="2027-04-13"),
        rule("STARTED", check_type="judgement", rule_status="FUTURE", valid_from="2026-08-18"),
        rule("ENDED", check_type="judgement", valid_to="2026-09-30"),
        rule("EXPIRED", check_type="judgement", rule_status="EXPIRED"),
        rule("REG", check_type="judgement", evaluates="REGISTRATION"),
        rule("MIXED", check_type="judgement", evaluates="RECEIPT/PROC"),
        rule("LAYOUT", check_type="judgement", evaluates="SCREEN (layout order)"),
        rule("INFO", check_type="judgement", rule_type="INFO"),
        rule("MAY", check_type="judgement", rule_type="MAY"),
    ]
    chosen = select(rules, ["visa"], "pos", TODAY)
    codes = {k: [r["code"] for r in v] for k, v in chosen.items()}
    assert codes == {
        "assessed": ["ALL", "ATT", "STARTED", "MIXED", "LAYOUT"],
        "context": ["INFO", "MAY"],
        "not_checked": ["REG"],
    }


def test_should_is_advisory_and_not_applicable_is_not_scored():
    rules = [
        rule("M1", check_type="judgement", severity="critical"),
        rule("M2", check_type="judgement", rule_type="MUST_NOT", severity="critical"),
        rule("S1", check_type="judgement", rule_type="SHOULD", severity="minor"),
        rule("NA", check_type="judgement", severity="critical"),
        rule("REG", check_type="judgement", evaluates="REGISTRATION"),
    ]
    ex = Extraction(["choice_screen"], judgements={
        "M1": Judgement("pass"), "M2": Judgement("pass"), "S1": Judgement("fail"), "NA": Judgement("not_applicable"),
    })
    r = evaluate(rules, FACTS, ex, ["visa"], "pos", TODAY)
    v = r["schemes"]["visa"]
    assert v["verdict"] == "compliant" and v["score"] == 100 and v["rules"] == 2
    assert v["advisory_failed"] == 1 and v["not_applicable"] == 1 and v["not_checked"] == 1
    assert [n["code"] for n in r["not_checked"]] == ["REG"]
