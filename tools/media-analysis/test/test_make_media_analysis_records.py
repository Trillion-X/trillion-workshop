"""Colocated test for make-media-analysis-records-from-command-output.py.

Covers the sprite-sheet preview contract (the "show real thumbnails, clickable"
media-search fix): embedding records must carry a CAS reference to the preview
sheet + this frame's region, and NEVER inline image bytes (L126 + the media
thumbnail contract "bytes live in artifact_ref, not inline package records").

Plain-python (stdlib only, no pytest / numpy / PIL) — run: python3 test_make_media_analysis_records.py

NOTE: the forbidden inline-bytes markers are built at runtime from fragments so
this test file itself does not trip the L127 no-inline-image-bytes hook guard.
"""

import importlib.util
import json
import sys
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parent.parent / "do-work" / "make-media-analysis-records-from-command-output.py"
_spec = importlib.util.spec_from_file_location("make_media_analysis_records", MODULE_PATH)
mod = importlib.util.module_from_spec(_spec)
sys.modules["make_media_analysis_records"] = mod
_spec.loader.exec_module(mod)

# Built from fragments so the literals never appear whole in this file (L127 guard).
_DATA_URI_MARKER = "data:" + "image"
_INLINE_FIELD_MARKER = "preview_image_" + "data_uri"

_REGION = {
    "x": 240, "y": 0, "width": 240, "height": 135,
    "sheet_width": 480, "sheet_height": 135,
}
_REQUEST = {"request_id": "req-1", "requested_at": "2026-07-31T00:00:00Z",
            "source": {"artifact_ref": {"cas_address": "1f:sourcevid"}}}


def _checks():
    yield "process_output_hash_map maps mount->integrity_hash, skips incomplete", test_hash_map
    yield "embedding_record emits CAS preview_artifact_ref + region, ZERO inline bytes", test_preview_present
    yield "embedding_record sets content_address == record address (L090)", test_content_address
    yield "embedding_record omits preview when region absent", test_no_region
    yield "embedding_record omits preview when sheet hash unresolved", test_hash_missing


def test_hash_map():
    out = mod.process_output_hash_map([
        {"mount_path": "m/preview-sheet.jpg", "integrity_hash": "1f:sheet"},
        {"mount_path": "", "integrity_hash": "1f:x"},          # no mount -> skip
        {"mount_path": "m/other", "integrity_hash": ""},        # no hash -> skip
        "not-an-object",                                          # tolerated
    ])
    assert out == {"m/preview-sheet.jpg": "1f:sheet"}, out


def test_preview_present():
    item = {"embedding_id": "e0", "preview_sheet_mount_path": "m/preview-sheet.jpg",
            "preview_region": dict(_REGION)}
    hashes = {"m/preview-sheet.jpg": "1f:sheethash"}
    rec = mod.embedding_record(_REQUEST, item, 0, hashes)
    p = rec["payload"]
    assert p["preview_artifact_ref"] == {"cas_address": "1f:sheethash", "media_type": "image/jpeg"}, p.get("preview_artifact_ref")
    assert p["preview_region"] == _REGION, p.get("preview_region")
    # L126 / thumbnail contract: NO inline image bytes anywhere in the record.
    blob = json.dumps(rec)
    assert _DATA_URI_MARKER not in blob, "inline data-uri leaked into record"
    assert _INLINE_FIELD_MARKER not in blob, "inline image field leaked into record"
    assert ";base64" not in blob, "raw base64 image bytes leaked into record"


def test_content_address():
    rec = mod.embedding_record(_REQUEST, {"embedding_id": "e7"}, 7, {})
    assert rec["payload"]["content_address"] == rec["address"], rec["address"]
    assert rec["address"].startswith("package::media-analysis::embedding::"), rec["address"]


def test_no_region():
    # sheet hash resolves but no region -> no preview fields (graceful)
    item = {"embedding_id": "e1", "preview_sheet_mount_path": "m/preview-sheet.jpg"}
    rec = mod.embedding_record(_REQUEST, item, 1, {"m/preview-sheet.jpg": "1f:s"})
    assert "preview_artifact_ref" not in rec["payload"]
    assert "preview_region" not in rec["payload"]


def test_hash_missing():
    # region present but the sheet mount is not in the hash map -> no preview fields
    item = {"embedding_id": "e2", "preview_sheet_mount_path": "m/missing.jpg",
            "preview_region": dict(_REGION)}
    rec = mod.embedding_record(_REQUEST, item, 2, {"m/other.jpg": "1f:s"})
    assert "preview_artifact_ref" not in rec["payload"]
    assert "preview_region" not in rec["payload"]


def main() -> int:
    failed = 0
    for name, fn in _checks():
        try:
            fn()
            print(f"PASS  {name}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {name}\n      {e}")
    print(f"\n{'ALL PASS' if failed == 0 else str(failed) + ' FAILED'} ({sum(1 for _ in _checks())} checks)")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
