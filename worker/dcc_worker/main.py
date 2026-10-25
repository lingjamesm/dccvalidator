"""Masking worker: takes each newly uploaded file out of quarantine, masks any
card numbers, stores the masked copy, and deletes the original.

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

import httpx

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


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    db = Supabase(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    running = True

    def stop(*_):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    db.release_stuck()
    log.info("masking worker started")
    while running:
        try:
            row = db.claim_next()
            if row is None:
                time.sleep(POLL_SECONDS)
                continue
            try:
                process(db, row)
            except Exception:
                db.update_file(row["id"], {"status": "quarantine"})
                raise
        except Exception:
            log.exception("worker error; retrying shortly")
            time.sleep(POLL_SECONDS * 3)


if __name__ == "__main__":
    main()
