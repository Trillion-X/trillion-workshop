"""Adversarial fixtures for identity-only metadata pinning and direct-review compatibility."""
import base64
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

TOOL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL))

import blake3
import ingest_channel_intake  # noqa: E402


class MetadataIdentityOnlyUpdate(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.ledger = self.root / "VIDEO-PACKAGING.jsonl"
        self.contract = self.root / "admission" / "IDENTITY-UPDATE.json"
        self.contract.parent.mkdir(parents=True)
        self.readback = self.root / "admission" / "READBACK.json"
        self.preimage = self.root / "admission" / "PREIMAGE.json"
        (self.root / "metadata").mkdir()
        self.metadata = self.root / "metadata" / "target.info.json"
        self.metadata.write_text('{"id":"target","title":"Original title","description":"Description"}\n')
        self.other_metadata = self.root / "metadata" / "other.info.json"
        self.other_metadata.write_text('{"id":"other","title":"Other"}\n')
        self.target = {
            "video_id": "target", "source_key": "channel-A", "channel": "Fixture channel",
            "inventory_title": "Música target", "metadata_source_path": "metadata/target.info.json",
            "metadata_source_identity": None, "description": "retained description",
            "thumbnail_image_path": "images/target.fixture", "thumbnail_blake3": {"value": "old-thumb"},
            "thumbnail_words": {"status": "directly reviewed", "value": ["KEEP"]},
            "thumbnail_analysis": {"source_review": "review/old.json", "keep": True},
            "thumbnail_review_provenance": {"review_note": "review/old.json"},
            "caption_sources": ["captions/target.json3"],
            "caption_source_identities": [{"path": "captions/target.json3", "identity": {"value": "old-caption"}}],
            "opening_hook_evidence": [{"source_path": "captions/target.json3", "claim": "keep"}],
            "internal_hook_evidence": [{"source_path": "captions/target.json3", "claim": "keep internal"}],
            "field_status": {"thumbnail_words": "directly reviewed", "metadata": "historical"},
            "manual_annotation": {"editor": "Mina", "note": "preserve café spelling"},
        }
        self.same_source_other_locator = {
            "video_id": "same-channel-other-locator", "source_key": "channel-A",
            "metadata_source_path": "metadata/other.info.json", "metadata_source_identity": None,
            "manual_annotation": "do not select by source key alone",
        }
        self.other_source = {"video_id": "other-source", "source_key": "channel-B", "metadata_source_path": "metadata/target.info.json"}
        # Whitespace and mixed line endings make preservation observable at raw-byte level.
        self.original_lines = [
            (json.dumps(self.same_source_other_locator, ensure_ascii=False, separators=(",", ":")) + "  \r\n").encode(),
            (json.dumps(self.target, ensure_ascii=False, separators=(",", ":")) + " \t\n").encode(),
            (json.dumps(self.other_source, ensure_ascii=False, separators=(",", ":")) + "   " + "\n").encode(),
        ]
        self.ledger.write_bytes(b"".join(self.original_lines))
        self.original_ledger = self.ledger.read_bytes()
        self.write_contract()

    def tearDown(self):
        self.temp.cleanup()

    def identity(self, path):
        path = Path(path)
        raw = path.read_bytes()
        return {"algorithm": "blake3", "value": blake3.blake3(raw).hexdigest(), "bytes": len(raw)}

    def write_contract(self, *, source_key="channel-A", locator="metadata/target.info.json", identity=None):
        self.contract.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema": "youtube-packaging-identity-only-update@1",
            "source_key": source_key,
            "metadata_source_path": locator,
            "metadata_identity": identity or self.identity(self.root / locator),
        }
        self.contract.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        return payload

    def run_cli(self, *, expected=None, ledger=None, contract=None, preimage=None, readback=None):
        argv = [
            "ingest_channel_intake.py", "--root", str(self.root), "--ledger", str(ledger or self.ledger),
            "--identity-only-update", str(contract or self.contract),
            "--expected-ledger-blake3", expected or ingest_channel_intake.blake3(ledger or self.ledger),
            "--preimage", str(preimage or self.preimage), "--readback", str(readback or self.readback),
        ]
        output = io.StringIO()
        with patch.object(sys, "argv", argv), contextlib.redirect_stdout(output):
            ingest_channel_intake.main()
        return json.loads(output.getvalue())

    def target_after(self, ledger=None):
        rows = [json.loads(line) for line in (ledger or self.ledger).read_bytes().splitlines() if line.strip()]
        return next(row for row in rows if row["video_id"] == "target")

    def test_updates_only_the_pinned_metadata_identity_and_preserves_all_other_bytes(self):
        before = json.loads(self.original_lines[1])
        result = self.run_cli(expected=ingest_channel_intake.blake3(self.ledger))
        after_bytes = self.ledger.read_bytes()
        after_lines = after_bytes.splitlines(keepends=True)
        self.assertEqual(len(after_lines), len(self.original_lines))
        self.assertEqual(after_lines[0], self.original_lines[0])
        self.assertEqual(after_lines[2], self.original_lines[2])
        self.assertTrue(after_lines[1].endswith(b"\n"))
        updated = json.loads(after_lines[1])
        actual_identity = self.identity(self.metadata)
        self.assertEqual(updated["metadata_source_identity"], actual_identity)
        self.assertEqual({key: value for key, value in updated.items() if key != "metadata_source_identity"}, {key: value for key, value in before.items() if key != "metadata_source_identity"})
        self.assertEqual(result["status"], "updated")
        readback = json.loads(self.readback.read_text())
        self.assertEqual(readback["selected_row_count"], 1)
        self.assertEqual(readback["source_key"], "channel-A")
        self.assertEqual(readback["metadata_source_path"], "metadata/target.info.json")
        self.assertTrue(readback["only_metadata_source_identity_changed"])
        self.assertTrue(readback["non_target_jsonl_lines_byte_exact"])
        self.assertTrue(readback["all_other_target_fields_equal"])
        self.assertTrue(readback["exact_inverse_verified"])
        preimage = json.loads(self.preimage.read_text())
        self.assertEqual(preimage["ledger_before"], readback["ledger_before"])
        self.assertEqual(base64.b64decode(preimage["selected_line_utf8_base64"]), self.original_lines[1])
        self.assertEqual(readback["ledger_after"], self.identity(self.ledger))

    def test_stale_ledger_pin_refuses_without_output_or_mutation(self):
        before = self.ledger.read_bytes()
        with self.assertRaisesRegex(SystemExit, "canonical ledger BLAKE3 differs"):
            self.run_cli(expected="0" * 64)
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertFalse(self.preimage.exists())
        self.assertFalse(self.readback.exists())

    def test_wrong_metadata_digest_or_path_refuses_without_mutation(self):
        before = self.ledger.read_bytes()
        bad_identity = {**self.identity(self.metadata), "value": "0" * 64}
        self.write_contract(identity=bad_identity)
        with self.assertRaisesRegex(SystemExit, "metadata source BLAKE3 or byte-count differs"):
            self.run_cli(expected=ingest_channel_intake.blake3(self.ledger))
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertFalse(self.preimage.exists())
        self.assertFalse(self.readback.exists())

        wrong_path = self.root / "metadata" / "unlisted.info.json"
        wrong_path.write_text("{\"id\":\"unlisted\"}\n")
        self.write_contract(locator="metadata/unlisted.info.json", identity=self.identity(wrong_path))
        with self.assertRaisesRegex(SystemExit, "selection must match exactly one ledger row; found 0"):
            self.run_cli(expected=ingest_channel_intake.blake3(self.ledger))
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertFalse(self.preimage.exists())
        self.assertFalse(self.readback.exists())

    def test_wrong_metadata_byte_count_refuses_without_mutation(self):
        before = self.ledger.read_bytes()
        wrong_bytes = {**self.identity(self.metadata), "bytes": self.metadata.stat().st_size + 1}
        self.write_contract(identity=wrong_bytes)
        with self.assertRaisesRegex(SystemExit, "metadata source BLAKE3 or byte-count differs"):
            self.run_cli(expected=ingest_channel_intake.blake3(self.ledger))
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertFalse(self.preimage.exists())
        self.assertFalse(self.readback.exists())

    def test_missing_and_duplicate_target_refuse_without_mutation(self):
        before = self.ledger.read_bytes()
        self.write_contract(source_key="missing-channel")
        with self.assertRaisesRegex(SystemExit, "selection must match exactly one ledger row; found 0"):
            self.run_cli(expected=ingest_channel_intake.blake3(self.ledger))
        self.assertEqual(self.ledger.read_bytes(), before)

        duplicate_line = (json.dumps(self.target, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        self.ledger.write_bytes(before + duplicate_line)
        duplicated = self.ledger.read_bytes()
        self.write_contract()
        with self.assertRaisesRegex(SystemExit, "selection must match exactly one ledger row; found 2"):
            self.run_cli(expected=ingest_channel_intake.blake3(self.ledger))
        self.assertEqual(self.ledger.read_bytes(), duplicated)
        self.assertFalse(self.preimage.exists())
        self.assertFalse(self.readback.exists())

    def test_root_escape_and_external_symlink_refuse(self):
        before = self.ledger.read_bytes()
        outside = self.root.parent / (self.root.name + "-outside-metadata.json")
        outside.write_text('{"id":"outside"}\n')
        try:
            self.write_contract(locator="../" + outside.name, identity=self.identity(outside))
            with self.assertRaisesRegex(SystemExit, "metadata source path escapes --root"):
                self.run_cli(expected=ingest_channel_intake.blake3(self.ledger))
            self.assertEqual(self.ledger.read_bytes(), before)

            symlink = self.root / "metadata" / "escape.info.json"
            symlink.symlink_to(outside)
            self.write_contract(locator="metadata/escape.info.json", identity=self.identity(outside))
            with self.assertRaisesRegex(SystemExit, "metadata source path escapes --root"):
                self.run_cli(expected=ingest_channel_intake.blake3(self.ledger))
            self.assertEqual(self.ledger.read_bytes(), before)
            self.assertFalse(self.preimage.exists())
            self.assertFalse(self.readback.exists())
        finally:
            outside.unlink(missing_ok=True)

    def test_contract_and_output_symlinks_cannot_escape_root(self):
        before = self.ledger.read_bytes()
        outside = self.root.parent / (self.root.name + "-outside.json")
        outside.write_text("{}\n")
        try:
            escaped_ledger = self.root / "admission" / "ESCAPED-LEDGER.jsonl"
            external_ledger = self.root.parent / (self.root.name + "-outside-ledger.jsonl")
            external_ledger.write_bytes(self.original_ledger)
            escaped_ledger.symlink_to(external_ledger)
            with self.assertRaisesRegex(SystemExit, "ledger path escapes --root"):
                self.run_cli(expected=ingest_channel_intake.blake3(external_ledger), ledger=escaped_ledger)
            self.assertEqual(external_ledger.read_bytes(), self.original_ledger)

            escaped_contract = self.root / "admission" / "ESCAPED-CONTRACT.json"
            escaped_contract.symlink_to(outside)
            with self.assertRaisesRegex(SystemExit, "contract path escapes --root"):
                self.run_cli(expected=ingest_channel_intake.blake3(self.ledger), contract=escaped_contract)
            self.assertEqual(self.ledger.read_bytes(), before)

            escaped_readback = self.root / "admission" / "ESCAPED-READBACK.json"
            escaped_readback.symlink_to(outside)
            with self.assertRaisesRegex(SystemExit, "readback path escapes --root"):
                self.run_cli(expected=ingest_channel_intake.blake3(self.ledger), readback=escaped_readback)
            self.assertEqual(self.ledger.read_bytes(), before)

            escaped_preimage = self.root / "admission" / "ESCAPED-PREIMAGE.json"
            escaped_preimage.symlink_to(outside)
            with self.assertRaisesRegex(SystemExit, "preimage path escapes --root"):
                self.run_cli(expected=ingest_channel_intake.blake3(self.ledger), preimage=escaped_preimage)
            self.assertEqual(self.ledger.read_bytes(), before)
            self.assertEqual(outside.read_text(), "{}\n")
        finally:
            outside.unlink(missing_ok=True)
            (self.root.parent / (self.root.name + "-outside-ledger.jsonl")).unlink(missing_ok=True)

    def test_conflicting_existing_identity_is_refused(self):
        before = self.ledger.read_bytes()
        target = json.loads(self.original_lines[1])
        target["metadata_source_identity"] = self.identity(self.other_metadata)
        self.original_lines[1] = (json.dumps(target, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        self.ledger.write_bytes(b"".join(self.original_lines))
        changed_before = self.ledger.read_bytes()
        self.write_contract()
        with self.assertRaisesRegex(SystemExit, "existing metadata_source_identity differs"):
            self.run_cli(expected=ingest_channel_intake.blake3(self.ledger))
        self.assertEqual(self.ledger.read_bytes(), changed_before)
        self.assertNotEqual(changed_before, before)
        self.assertFalse(self.preimage.exists())
        self.assertFalse(self.readback.exists())

    def test_repeat_keeps_ledger_and_recovery_preimage_byte_exact(self):
        first = self.run_cli(expected=ingest_channel_intake.blake3(self.ledger))
        first_ledger = self.ledger.read_bytes()
        first_preimage = self.preimage.read_bytes()
        retry_readback = self.root / "admission" / "RETRY-READBACK.json"
        second = self.run_cli(expected=ingest_channel_intake.blake3(self.ledger), readback=retry_readback)
        self.assertEqual(self.ledger.read_bytes(), first_ledger)
        self.assertEqual(second["status"], "already-applied")
        # The original selected line and prior whole-ledger pin remain the recovery source.
        self.assertEqual(self.preimage.read_bytes(), first_preimage)
        self.assertTrue(first["exact_inverse_verified"])
        retry_receipt = json.loads(retry_readback.read_text())
        self.assertTrue(retry_receipt["idempotent_bytes_preserved"])

    def test_already_applied_without_preimage_records_exact_current_state(self):
        self.run_cli(expected=ingest_channel_intake.blake3(self.ledger))
        current_ledger = self.ledger.read_bytes()
        self.preimage.unlink()
        retry_readback = self.root / "admission" / "RETRY-WITHOUT-PREIMAGE.json"

        result = self.run_cli(
            expected=ingest_channel_intake.blake3(self.ledger), readback=retry_readback)

        self.assertEqual(result["status"], "already-applied")
        self.assertEqual(self.ledger.read_bytes(), current_ledger)
        self.assertTrue(self.preimage.is_file())
        preimage = json.loads(self.preimage.read_text())
        self.assertEqual(preimage["ledger_before"], self.identity(self.ledger))
        self.assertEqual(
            base64.b64decode(preimage["selected_line_utf8_base64"]),
            self.ledger.read_bytes().splitlines(keepends=True)[1],
        )
        receipt = json.loads(retry_readback.read_text())
        self.assertTrue(receipt["idempotent_bytes_preserved"])
        self.assertFalse(receipt["preimage_reused_without_overwrite"])
        self.assertEqual(receipt["whole_ledger_prior_identity_retained"], self.identity(self.ledger))
        self.assertTrue(receipt["exact_inverse_verified"])

    def test_existing_readback_path_refuses_retry_without_overwrite(self):
        self.run_cli(expected=ingest_channel_intake.blake3(self.ledger))
        first_ledger = self.ledger.read_bytes()
        first_preimage = self.preimage.read_bytes()
        first_readback = self.readback.read_bytes()
        with self.assertRaisesRegex(SystemExit, "readback destination already exists"):
            self.run_cli(expected=ingest_channel_intake.blake3(self.ledger))
        self.assertEqual(self.ledger.read_bytes(), first_ledger)
        self.assertEqual(self.preimage.read_bytes(), first_preimage)
        self.assertEqual(self.readback.read_bytes(), first_readback)

    def test_existing_full_direct_review_batch_still_updates_review_fields(self):
        root = self.root
        vid = "direct-review-fixture"
        source_key = "channel-A"
        (root / "metadata").mkdir(exist_ok=True)
        (root / "captions").mkdir()
        (root / "images").mkdir()
        metadata = root / "metadata" / "direct.info.json"
        metadata.write_text(json.dumps({"id": vid, "title": "Direct title", "description": "Direct description", "upload_date": "20260314"}) + "\n")
        caption = root / "captions" / "direct.json3"
        caption.write_text(json.dumps({"events": [{"tStartMs": 1000, "dDurationMs": 2000, "segs": [{"utf8": "A fixture caption"}]}]}) + "\n")
        thumbnail = root / "images" / "direct.fixture"
        thumbnail.write_bytes(b"synthetic fixture bytes; not an image")
        metadata_identity = self.identity(metadata)
        caption_identity = self.identity(caption)
        thumbnail_identity = self.identity(thumbnail)
        target = {
            "video_id": vid, "source_key": source_key, "inventory_title": "Direct title",
            "metadata_source_path": "metadata/direct.info.json", "metadata_source_identity": None,
            "thumbnail_image_path": "images/direct.fixture", "thumbnail_blake3": thumbnail_identity,
            "thumbnail_words": {"status": "unreviewed"}, "caption_sources": ["metadata/direct.info.json", "captions/direct.json3"],
            "opening_hook_evidence": [{"existing": "opening"}], "internal_hook_evidence": [{"existing": "internal"}],
            "field_status": {"custom": "keep"}, "manual_annotation": {"keep": "target field"},
        }
        target_line = (json.dumps(target, separators=(",", ":")) + "\n").encode()
        non_target_line = b'{ "video_id": "other", "custom": "exact bytes" }  \r\n'
        ledger = root / "DIRECT-REVIEW.jsonl"
        ledger.write_bytes(non_target_line + target_line)
        note = {
            "schema": "thumbnail-source-review-note@1", "video_id": vid, "source_key": source_key,
            "ledger_source": {"line": 2, "thumbnail_status_at_selection": "unreviewed"},
            "title": {"inventory_title": "Direct title", "exact_metadata_value": "Direct title", "source_identity": {"path": "metadata/direct.info.json", **metadata_identity}},
            "description": {"exact_metadata_value": "Direct description"},
            "thumbnail": {"source_identity": {"path": "images/direct.fixture", **thumbnail_identity}, "visible_text": [{"text": "FIXTURE TEXT"}], "composition": "Synthetic fixture only.", "title_relation": "The fixture text aligns with the fixture title."},
            "opening_caption": {"source_identity": {"path": "captions/direct.json3", **caption_identity}, "cues": [{"event_index": 0, "start_s": 1.0, "end_s": 3.0, "text": "A fixture caption"}]},
        }
        note_path = root / "review" / "NOTE.json"
        note_path.parent.mkdir()
        note_path.write_text(json.dumps(note, ensure_ascii=False, indent=2) + "\n")
        batch = {
            "schema": "thumbnail-review-batch-readback@1",
            "selected_records": [{"video_id": vid, "source_key": source_key, "note_path": "review/NOTE.json", "note_identity": self.identity(note_path), "metadata_identity": metadata_identity, "thumbnail_identity": thumbnail_identity}],
        }
        batch_path = root / "review" / "BATCH.json"
        batch_path.write_text(json.dumps(batch, indent=2) + "\n")
        readback = root / "review" / "DIRECT-READBACK.json"
        expected = ingest_channel_intake.blake3(ledger)
        argv = ["ingest_channel_intake.py", "--root", str(root), "--ledger", str(ledger), "--direct-review-batch", str(batch_path), "--readback", str(readback), "--expected-ledger-blake3", expected]
        output = io.StringIO()
        with patch.object(sys, "argv", argv), contextlib.redirect_stdout(output):
            ingest_channel_intake.main()
        summary = json.loads(output.getvalue())
        self.assertEqual(summary["status"], "applied")
        self.assertTrue(summary["non_target_jsonl_lines_byte_exact"])
        after_lines = ledger.read_bytes().splitlines(keepends=True)
        self.assertEqual(after_lines[0], non_target_line)
        updated = json.loads(after_lines[1])
        self.assertEqual(updated["metadata_source_identity"], metadata_identity)
        self.assertEqual(updated["thumbnail_words"], {"status": "directly reviewed", "value": [{"text": "FIXTURE TEXT"}]})
        self.assertEqual(updated["opening_hook_evidence"], target["opening_hook_evidence"])
        self.assertEqual(updated["internal_hook_evidence"], target["internal_hook_evidence"])
        self.assertEqual(updated["manual_annotation"], target["manual_annotation"])
        direct_readback = json.loads(readback.read_text())
        self.assertEqual(direct_readback["target_count"], 1)
        self.assertTrue(direct_readback["targets"][0]["existing_caption_and_hook_evidence_preserved"])
        self.assertFalse(direct_readback["caption_text_copied_from_review_notes"])


if __name__ == "__main__":
    unittest.main()
