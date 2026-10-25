import io

from PIL import Image

from dcc_worker.main import MASKED, QUARANTINE, process
from tests.test_masker import DCC_SCREEN, encode, screen


class FakeSupabase:
    def __init__(self, files: dict[tuple[str, str], bytes]):
        self.files = files
        self.updates: dict = {}

    def download(self, path):
        return self.files.get((QUARANTINE, path)) or self.files[(MASKED, path)]

    def store_masked(self, path, data, mime):
        self.files[(MASKED, path)] = data

    def delete(self, bucket, path):
        self.files.pop((bucket, path), None)

    def update_file(self, file_id, fields):
        self.updates = fields


def test_masked_copy_replaces_original():
    path = "user/sub/screen.png"
    db = FakeSupabase({(QUARANTINE, path): encode(screen(DCC_SCREEN), "PNG")})
    process(db, {"id": "f1", "storage_path": path, "mime_type": "image/png"})
    assert (QUARANTINE, path) not in db.files  # the unmasked original is gone
    assert db.updates["status"] == "masked" and db.updates["pan_masked_count"] == 1
    Image.open(io.BytesIO(db.files[(MASKED, path)])).verify()


def test_unreadable_file_is_rejected_and_deleted():
    path = "user/sub/broken.png"
    db = FakeSupabase({(QUARANTINE, path): b"not an image"})
    process(db, {"id": "f2", "storage_path": path, "mime_type": "image/png"})
    assert db.files == {}
    assert db.updates["status"] == "rejected"
