from dcc_worker.engine import Answer, Extraction, Judgement, evaluate

FACTS = [
    {"key": "cs_both_options", "document": "choice_screen", "kind": "yes_no", "question": "q?"},
    {"key": "cs_exchange_rate", "document": "choice_screen", "kind": "yes_no", "question": "q?"},
    {"key": "cs_markup_percent", "document": "choice_screen", "kind": "number", "question": "q?"},
    {"key": "rc_exchange_rate", "document": "receipt", "kind": "yes_no", "question": "q?"},
]


def rule(code, scheme="visa", severity="major", weight=5, check_type="fact", fact_key=None, expected="yes",
         threshold=None, channels=("pos", "atm", "ecommerce"), active=True):
    return {
        "id": code, "code": code, "scheme": scheme, "channels": list(channels), "title": code,
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
    r = evaluate(rules, FACTS, ex, ["visa"], "pos")
    assert outcomes(r) == {"A": "pass", "B": "fail", "C": "needs_review"}
    assert "No receipt" in r["findings"][2]["evidence"]
    v = r["schemes"]["visa"]
    assert v["score"] == 50 and v["verdict"] == "needs_review"
    assert v["unverified_rules"] == 3


def test_critical_failure_means_not_compliant_whatever_the_score():
    rules = [rule("A", fact_key="cs_both_options", severity="critical", weight=1),
             rule("B", fact_key="cs_exchange_rate", weight=10)]
    ex = Extraction(["choice_screen"], {"cs_both_options": Answer("no"), "cs_exchange_rate": Answer("yes")})
    v = evaluate(rules, FACTS, ex, ["visa"], "pos")["schemes"]["visa"]
    assert v["score"] == 91 and v["verdict"] == "not_compliant"


def test_all_pass_is_compliant():
    rules = [rule("A", fact_key="cs_both_options")]
    ex = Extraction(["choice_screen"], {"cs_both_options": Answer("yes")})
    v = evaluate(rules, FACTS, ex, ["visa"], "pos")["schemes"]["visa"]
    assert v == {**v, "score": 100, "verdict": "compliant"}


def test_not_visible_needs_review():
    rules = [rule("A", fact_key="cs_both_options")]
    ex = Extraction(["choice_screen"], {"cs_both_options": Answer("not_visible", evidence="Screen is blurred")})
    f = evaluate(rules, FACTS, ex, ["visa"], "pos")["findings"][0]
    assert f["outcome"] == "needs_review" and f["evidence"] == "Screen is blurred"


def test_number_thresholds():
    rules = [rule("A", fact_key="cs_markup_percent", expected="at_most", threshold=4),
             rule("B", fact_key="cs_markup_percent", expected="at_least", threshold=4)]
    ex = Extraction(["choice_screen"], {"cs_markup_percent": Answer("yes", number=3.5)})
    assert outcomes(evaluate(rules, FACTS, ex, ["visa"], "pos")) == {"A": "pass", "B": "fail"}


def test_judgement_rules_use_the_ai_assessment():
    rules = [rule("J", check_type="judgement"), rule("K", check_type="judgement")]
    ex = Extraction(["choice_screen"], judgements={"J": Judgement("fail", "Says 'recommended'", 0)})
    r = evaluate(rules, FACTS, ex, ["visa"], "pos")
    assert outcomes(r) == {"J": "fail", "K": "needs_review"}
    assert r["findings"][0]["document"] == 0


def test_only_matching_scheme_channel_and_active_rules_apply():
    rules = [
        rule("V", fact_key="cs_both_options"),
        rule("M", scheme="mastercard", fact_key="cs_both_options"),
        rule("ATM", fact_key="cs_both_options", channels=["atm"]),
        rule("OFF", fact_key="cs_both_options", active=False),
    ]
    ex = Extraction(["choice_screen"], {"cs_both_options": Answer("yes")})
    r = evaluate(rules, FACTS, ex, ["visa"], "pos")
    assert outcomes(r) == {"V": "pass"}
    assert set(r["schemes"]) == {"visa"}
