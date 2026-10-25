import io
import json
from types import SimpleNamespace

import pytest
from PIL import Image

from dcc_worker import ai, main
from tests.test_engine import FACTS, rule


def png():
    buf = io.BytesIO()
    Image.new("RGB", (400, 300), "white").save(buf, "PNG")
    return buf.getvalue()


class FakeStream:
    def __init__(self, message):
        self.message = message

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get_final_message(self):
        return self.message


class FakeClient:
    def __init__(self, payload, stop_reason="end_turn"):
        text = json.dumps(payload) if payload is not None else None
        content = [SimpleNamespace(type="text", text=text)] if text else []
        self.message = SimpleNamespace(stop_reason=stop_reason, content=content, model=ai.MODEL)
        self.calls = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self.stream))

    def stream(self, **kwargs):
        self.calls.append(kwargs)
        return FakeStream(self.message)


class FakeDB:
    def __init__(self):
        self.outputs, self.updates = [], {}

    def masked_files(self, sub_id):
        return [{"id": "f1", "storage_path": "u/s/a.png", "original_name": "screen.png", "mime_type": "image/png"},
                {"id": "f2", "storage_path": "u/s/b.png", "original_name": "receipt.png", "mime_type": "image/png"}]

    def download_masked(self, path):
        return png()

    def published_rules(self):
        rules = [rule("V-01", fact_key="cs_both_options", severity="critical"),
                 rule("V-15", fact_key="rc_exchange_rate"),
                 rule("V-11", check_type="judgement"),
                 rule("M-01", scheme="mastercard", fact_key="cs_both_options")]
        return {"id": "rs", "number": 1, "published_at": "2026-10-26T00:00:00+00:00"}, rules, FACTS

    def save_output(self, sub, kind, name, data, mime):
        self.outputs.append((kind, name, data))

    def update_submission(self, sub_id, fields):
        self.updates = fields


SUB = {"id": "s1", "owner_id": "u", "title": "Store 12 terminal", "version": 1, "channel": "pos", "schemes": ["visa"]}

ANSWER = {
    "documents": [{"document": 1, "kind": "choice_screen", "description": "Currency choice"},
                  {"document": 2, "kind": "receipt", "description": "Customer receipt"}],
    "facts": [
        {"key": "cs_both_options", "answer": "yes", "number": None, "evidence": "Pay in EUR / Pay in USD", "document": 1},
        {"key": "rc_exchange_rate", "answer": "no", "number": None, "evidence": "No rate printed", "document": 2},
    ],
    "judgements": [{"code": "V-11", "outcome": "pass", "evidence": "Neutral wording", "document": 1}],
    "overview": "A POS choice screen and receipt.",
}


def test_validation_scores_and_writes_report():
    db, client = FakeDB(), FakeClient(ANSWER)
    main.validate(db, client, SUB)
    call = client.calls[0]
    assert call["model"] == "claude-opus-5-5" and call["fallbacks"] == "default"
    assert call["betas"] == ["server-side-fallback-2026-07-01"]
    assert call["output_config"]["effort"] == "high"
    schema = call["output_config"]["format"]["schema"]
    assert schema["properties"]["judgements"]["items"]["properties"]["code"]["enum"] == ["V-11"]
    # only facts used by applicable rules are asked
    assert set(schema["properties"]["facts"]["items"]["properties"]["key"]["enum"]) == {"cs_both_options", "rc_exchange_rate"}

    r = db.updates["result"]
    assert db.updates["status"] == "complete" and db.updates["rule_set_version"] == "v1"
    assert {f["code"]: f["outcome"] for f in r["findings"]} == {"V-01": "pass", "V-15": "fail", "V-11": "pass"}
    assert r["schemes"]["visa"]["verdict"] == "needs_review"
    assert r["documents"][1]["kind"] == "receipt" and r["documents"][1]["name"] == "receipt.png"
    assert r["findings"][1]["document"] == 1  # 0-based second document
    kind, name, pdf = db.outputs[0]
    assert kind == "report" and pdf.startswith(b"%PDF")


def test_refusal_fails_the_submission_with_a_clear_message():
    db = FakeDB()
    main.validate(db, FakeClient(None, stop_reason="refusal"), SUB)
    assert db.updates["status"] == "failed" and "could not be assessed" in db.updates["result"]["error"]
    assert db.outputs == []


def test_no_usable_files_fails():
    db = FakeDB()
    db.masked_files = lambda _: []
    main.validate(db, FakeClient(ANSWER), SUB)
    assert db.updates["status"] == "failed"


def test_large_images_are_shrunk_for_the_model():
    buf = io.BytesIO()
    Image.new("RGB", (6000, 3000), "white").save(buf, "PNG")
    [(mime, data)] = ai.page_images(buf.getvalue(), "image/png")
    assert max(Image.open(io.BytesIO(data)).size) == ai.MAX_SIDE


def test_out_of_range_document_numbers_are_ignored():
    raw = {**ANSWER, "facts": [{**ANSWER["facts"][0], "document": 9}]}
    ex, docs, _ = ai.parse(raw, 2, FACTS)
    assert ex.facts["cs_both_options"].document is None
