"""Worker: takes each newly uploaded file out of quarantine, masks any card
numbers, stores the masked copy, and deletes the original. Once all of a
submission's files are masked, it validates the submission against the
published rule set (when ANTHROPIC_API_KEY is set) and writes the PDF report.

Runs as a long-lived process on Render. Talks to Supabase over its REST APIs
with the service role key, so it must never run anywhere users can reach.
"""

from __future__ import annotations

import logging
import os
import signal
import time
from datetime import datetime, timezone
from urllib.parse import quote

import anthropic
import httpx

from . import ai, engine, report
from .masker import UnmaskableError, mask_file

log = logging.getLogger("dcc-worker")

POLL_SECONDS = float(os.environ.get("POLL_SECONDS", "5"))
QUARANTINE, MASKED = "quarantine", "submissions"


class Supabase:
    def __init__(self, url: str, key: str):
        headers = {"apikey": key}
        if key.startswith("eyJ"):  # legacy service_role JWT
            headers["Authorization"] = f"Bearer {key}"
        self.http = httpx.Client(base_url=url.rstrip("/"), headers=headers, timeout=60)

    def _object(self, bucket: str, path: str) -> str:
        return f"/storage/v1/object/{bucket}/{quote(path)}"

    def claim_next(self) -> dict | None:
        """Mark the oldest quarantined file as processing; None when there is none."""
        r = self.http.get(
            "/rest/v1/submission_files",
            params={"status": "eq.quarantine", "order": "created_at", "limit": "1", "select": "id"},
        )
        r.raise_for_status()
        if not r.json():
            return None
        file_id = r.json()[0]["id"]
        r = self.http.patch(
            "/rest/v1/submission_files",
            params={"id": f"eq.{file_id}", "status": "eq.quarantine"},
            json={"status": "processing"},
            headers={"Prefer": "return=representation"},
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None

    def release_stuck(self) -> None:
        """Files left mid-processing by a previous run go back in the queue."""
        self.http.patch(
            "/rest/v1/submission_files", params={"status": "eq.processing"}, json={"status": "quarantine"}
        ).raise_for_status()

    def download(self, path: str) -> bytes:
        r = self.http.get(self._object(QUARANTINE, path))
        if r.status_code in (400, 404):
            # Uploaded before masking existed: the original sits in the main bucket.
            r = self.http.get(self._object(MASKED, path))
        r.raise_for_status()
        return r.content

    def store_masked(self, path: str, data: bytes, mime: str) -> None:
        self.http.post(
            self._object(MASKED, path), content=data, headers={"Content-Type": mime, "x-upsert": "true"}
        ).raise_for_status()

    def delete(self, bucket: str, path: str) -> None:
        self.http.request("DELETE", f"/storage/v1/object/{bucket}", json={"prefixes": [path]}).raise_for_status()

    def update_file(self, file_id: str, fields: dict) -> None:
        self.http.patch("/rest/v1/submission_files", params={"id": f"eq.{file_id}"}, json=fields).raise_for_status()

    # --- validation ---

    def claim_submission(self) -> dict | None:
        """Mark the oldest uploaded submission whose files are all masked as processing."""
        r = self.http.get(
            "/rest/v1/submissions",
            params={
                "status": "eq.uploaded",
                "order": "updated_at",
                "limit": "20",
                "select": "id,submission_files(status)",
            },
        )
        r.raise_for_status()
        for row in r.json():
            if any(f["status"] in ("quarantine", "processing") for f in row["submission_files"]):
                continue
            r = self.http.patch(
                "/rest/v1/submissions",
                params={"id": f"eq.{row['id']}", "status": "eq.uploaded"},
                json={"status": "processing"},
                headers={"Prefer": "return=representation"},
            )
            r.raise_for_status()
            if r.json():
                return r.json()[0]
        return None

    def release_stuck_submissions(self) -> None:
        self.http.patch(
            "/rest/v1/submissions", params={"status": "eq.processing"}, json={"status": "uploaded"}
        ).raise_for_status()

    def masked_files(self, submission_id: str) -> list[dict]:
        r = self.http.get(
            "/rest/v1/submission_files",
            params={"submission_id": f"eq.{submission_id}", "status": "eq.masked", "order": "created_at",
                    "select": "id,storage_path,original_name,mime_type"},
        )
        r.raise_for_status()
        return r.json()

    def download_masked(self, path: str) -> bytes:
        r = self.http.get(self._object(MASKED, path))
        r.raise_for_status()
        return r.content

    def published_rules(self) -> tuple[dict, list[dict], list[dict]]:
        r = self.http.get(
            "/rest/v1/rule_sets", params={"status": "eq.published", "select": "id,number,published_at"}
        )
        r.raise_for_status()
        if not r.json():
            raise RuntimeError("no published rule set")
        rule_set = r.json()[0]
        rules = self.http.get(
            "/rest/v1/rules", params={"rule_set_id": f"eq.{rule_set['id']}", "order": "sort,code", "select": "*"}
        )
        rules.raise_for_status()
        facts = self.http.get("/rest/v1/fact_definitions", params={"order": "sort,key", "select": "*"})
        facts.raise_for_status()
        return rule_set, rules.json(), facts.json()

    def save_output(self, sub: dict, kind: str, file_name: str, data: bytes, mime: str) -> None:
        path = f"{sub['owner_id']}/{sub['id']}/{file_name}"
        self.store_masked(path, data, mime)
        self.http.post(
            "/rest/v1/submission_outputs",
            params={"on_conflict": "submission_id,kind"},
            json={"submission_id": sub["id"], "owner_id": sub["owner_id"], "kind": kind,
                  "storage_path": path, "file_name": file_name, "mime_type": mime},
            headers={"Prefer": "resolution=merge-duplicates"},
        ).raise_for_status()

    def update_submission(self, submission_id: str, fields: dict) -> None:
        self.http.patch("/rest/v1/submissions", params={"id": f"eq.{submission_id}"}, json=fields).raise_for_status()


def process(db: Supabase, row: dict) -> None:
    path = row["storage_path"]
    try:
        result = mask_file(db.download(path), row["mime_type"])
    except UnmaskableError as e:
        log.warning("rejected file %s: %s", row["id"], e)
        db.delete(QUARANTINE, path)
        db.delete(MASKED, path)
        db.update_file(row["id"], {"status": "rejected", "rejection_reason": str(e)})
        return
    except Exception as e:  # unreadable or corrupt file
        if isinstance(e, httpx.HTTPError):
            raise
        log.warning("could not read file %s: %s", row["id"], e)
        db.delete(QUARANTINE, path)
        db.delete(MASKED, path)
        db.update_file(row["id"], {"status": "rejected", "rejection_reason": "The file could not be read. Please upload it again."})
        return

    db.store_masked(path, result.data, result.mime_type)
    db.delete(QUARANTINE, path)
    db.update_file(
        row["id"],
        {
            "status": "masked",
            "pan_masked_count": result.pans_masked,
            "size_bytes": len(result.data),
            "masked_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    log.info("masked file %s: %d card number(s)", row["id"], result.pans_masked)


def validate(db: Supabase, client: anthropic.Anthropic, sub: dict) -> None:
    files = db.masked_files(sub["id"])
    if not files:
        db.update_submission(
            sub["id"], {"status": "failed", "result": {"error": "None of the uploaded files could be used. Please submit them again."}}
        )
        return
    rule_set, rules, facts = db.published_rules()
    rules = engine.applicable(rules, sub["schemes"], sub["channel"])
    used_facts = {r["fact_key"] for r in rules if r["check_type"] == "fact"}
    facts_asked = [f for f in facts if f["key"] in used_facts or f["key"] == "dcc_offer_shown"]
    judgement_rules = [r for r in rules if r["check_type"] == "judgement"]

    documents = [ai.Document(f["original_name"], ai.page_images(db.download_masked(f["storage_path"]), f["mime_type"]))
                 for f in files]
    try:
        extraction, docs, overview, model = ai.assess(client, documents, facts_asked, judgement_rules, sub["channel"])
    except ai.AIUnavailable as e:
        log.warning("submission %s not assessed: %s", sub["id"], e)
        db.update_submission(sub["id"], {"status": "failed", "result": {"error": str(e)}})
        return

    outcome = engine.evaluate(rules, facts, extraction, sub["schemes"], sub["channel"])
    result = {
        "validated_at": datetime.now(timezone.utc).isoformat(),
        "model": model,
        "rule_set": rule_set,
        "overview": overview,
        "documents": [{"file_id": f["id"], "name": f["original_name"], **d} for f, d in zip(files, docs)],
        "facts": {k: vars(a) for k, a in extraction.facts.items()},
        **outcome,
    }
    db.save_output(sub, "report", "validation-report.pdf", report.build(sub, result), "application/pdf")
    db.update_submission(
        sub["id"], {"status": "complete", "result": result, "rule_set_version": f"v{rule_set['number']}"}
    )
    log.info("validated submission %s: %s", sub["id"], {k: v["verdict"] for k, v in outcome["schemes"].items()})


def next_job(db: Supabase, client: anthropic.Anthropic | None) -> bool:
    """Do one piece of work; False when there was nothing to do."""
    row = db.claim_next()
    if row is not None:
        try:
            process(db, row)
        except Exception:
            db.update_file(row["id"], {"status": "quarantine"})
            raise
        return True
    if client is None:
        return False
    sub = db.claim_submission()
    if sub is None:
        return False
    try:
        validate(db, client, sub)
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError):
        # A key problem is ours to fix, not the submitter's: leave it queued.
        db.update_submission(sub["id"], {"status": "uploaded"})
        log.error("Anthropic API key rejected; check ANTHROPIC_API_KEY on Render")
        time.sleep(300)
    except (anthropic.APIConnectionError, anthropic.RateLimitError, anthropic.InternalServerError, httpx.HTTPError):
        db.update_submission(sub["id"], {"status": "uploaded"})
        raise
    except Exception:
        log.exception("validation failed for submission %s", sub["id"])
        db.update_submission(
            sub["id"],
            {"status": "failed", "result": {"error": "Validation could not be completed. Please submit a new version."}},
        )
    return True


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    db = Supabase(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    running = True

    def stop(*_):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    key = os.environ.get("ANTHROPIC_API_KEY")
    client = anthropic.Anthropic(api_key=key, max_retries=4) if key else None
    db.release_stuck()
    if client:
        db.release_stuck_submissions()
    log.info("worker started; validation %s", "on" if client else "off (no ANTHROPIC_API_KEY)")
    while running:
        try:
            if not next_job(db, client):
                time.sleep(POLL_SECONDS)
        except Exception:
            log.exception("worker error; retrying shortly")
            time.sleep(POLL_SECONDS * 3)


if __name__ == "__main__":
    main()
