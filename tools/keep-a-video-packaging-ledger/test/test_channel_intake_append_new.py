"""Focused append-new coverage for a later batch under an existing channel key."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import sys

TOOL = Path(__file__).resolve().parents[1] / "do-work"
sys.path.insert(0, str(TOOL))

import blake3
import ingest_channel_intake  # noqa: E402


SOURCE_KEY = "ch-example-videos"
CHANNEL_ID = "UC-example"
CHANNEL = "Example Creator"


class AppendNewExistingSourceKey(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.batch = self.root / "admission" / "batch"
        self.batch.mkdir(parents=True)
        self.ledger = self.root / "VIDEO-PACKAGING.jsonl"
        self.source_coverage = self.root / "SOURCE-COVERAGE.json"
        self.coverage = self.root / "COVERAGE-REPORT.json"
        self.readback = self.batch / "READBACK.json"
        self.ids = ["new-video-1", "new-video-2"]
        self.old_rows = [
            {"video_id": f"old-video-{n}", "source_key": SOURCE_KEY, "channel": CHANNEL,
             "thumbnail_words": {"status": "directly reviewed"}, "opening_hook_evidence": [],
             "caption_sources": ["old-caption.json3"], "description": "old description"}
            for n in (1, 2, 3)
        ]
        self.other_row = {"video_id": "unrelated", "source_key": "other-key", "channel": "Other"}
        # Deliberately noncanonical whitespace proves the original JSONL prefix is retained byte-for-byte.
        self.original_lines = [json.dumps(row, separators=(",", ":")) + "  " for row in self.old_rows + [self.other_row]]
        self.ledger.write_text("\n".join(self.original_lines) + "\n")
        self.original_ledger = self.ledger.read_bytes()
        self.source_coverage.write_text(json.dumps([{
            "source_key": SOURCE_KEY, "channel": CHANNEL, "imported_ids": 3, "title_present": 3,
            "description_present": 3, "thumbnail_retained_unreviewed": 0, "caption_files_joined": 3,
            "opening_caption_spans": 0, "internal_hooks_analyzed": 0, "thumbnail_words_reviewed": 3,
        }], indent=2) + "\n")
        self.coverage.write_text(json.dumps({"scope": "fixture", "separately_admitted_sources": [], "direct_review_batches": []}, indent=2) + "\n")
        self.original_source_coverage = self.source_coverage.read_bytes()
        self.original_coverage = self.coverage.read_bytes()
        self.intake = self.batch / "INTAKE.json"
        self.catalog = self.batch / "CATALOG.json"
        self.review = self.batch / "REVIEW.json"
        videos, entries, items = [], [], []
        for idx, vid in enumerate(self.ids):
            meta = self.root / "sources" / f"{vid}.info.json"
            caption = self.root / "sources" / f"{vid}.json3"
            image = self.root / "images" / f"{vid}.bin"
            for path in (meta, caption, image): path.parent.mkdir(parents=True, exist_ok=True)
            meta.write_text(json.dumps({"title": f"Title {idx}", "description": f"Description {idx}"}))
            caption.write_text(json.dumps({"events": [{"tStartMs": 1000, "dDurationMs": 2000, "segs": [{"utf8": "Source-only caption text"}]}]}))
            image.write_bytes(f"image bytes {idx}".encode())
            videos.append({"video_id": vid, "title": f"Title {idx}", "metadata_path": f"../../sources/{vid}.info.json", "transcript_path": f"../../sources/{vid}.json3"})
            entries.append({"video_id": vid, "title": f"Title {idx}", "url": f"https://example.test/{vid}", "duration_seconds": 4})
            items.append({
                "video_id": vid, "image_path": f"images/{vid}.bin", "image_bytes": image.stat().st_size,
                "image_blake3": blake3.blake3(image.read_bytes()).hexdigest(), "thumbnail_words": ["TEXT"],
                "composition": "A reviewed fixture image.", "title_thumbnail_relation": "Fixture-only relationship.",
                "opening_evidence": {"status": "caption candidate", "candidate_function": "Fixture function.", "qualification": "Speech not verified.", "events": [{"event_index": 0, "normalized_segment_id": f"{vid}:E000000", "start_s": 1.0, "end_s": 3.0}]},
                "internal_hook_evidence": {"status": "not assessed", "candidate_function": None, "qualification": None, "events": []},
            })
        self.intake.write_text(json.dumps({"videos": videos}, indent=2) + "\n")
        self.catalog.write_text(json.dumps({"channel_id": CHANNEL_ID, "channel_name": CHANNEL, "entries": entries}, indent=2) + "\n")
        self.review.write_text(json.dumps({"items": items}, indent=2) + "\n")
        self.saved = {
            "--root": self.root,
            "--intake": self.intake,
            "--channel-catalog": self.catalog,
            "--review": self.review,
            "--source-key": SOURCE_KEY,
            "--ledger": self.ledger,
            "--coverage": self.coverage,
            "--source-coverage": self.source_coverage,
            "--readback": self.readback,
        }

    def tearDown(self):
        self.temp.cleanup()

    def run_ingest(self, extra=()):
        argv = ["ingest_channel_intake.py"]
        for key, value in self.saved.items():
            argv.extend((key, str(value)))
        argv.extend(extra)
        with patch.object(sys, "argv", argv):
            ingest_channel_intake.main()

    def test_second_batch_appends_once_and_preserves_all_prior_lines(self):
        self.run_ingest(("--append-new",))
        after_first = self.ledger.read_bytes()
        self.assertTrue(after_first.startswith(self.original_ledger))
        rows = [json.loads(line) for line in after_first.splitlines() if line.strip()]
        self.assertEqual([row["video_id"] for row in rows[:4]], [row["video_id"] for row in self.old_rows + [self.other_row]])
        self.assertEqual([row["video_id"] for row in rows[-2:]], self.ids)
        self.assertEqual(len(rows), 6)
        source_rows = json.loads(self.source_coverage.read_text())
        owner = next(row for row in source_rows if row["source_key"] == SOURCE_KEY)
        self.assertEqual(owner["imported_ids"], 5)
        self.assertEqual(owner["thumbnail_words_reviewed"], 5)
        self.assertEqual(owner["direct_review_batches"][0]["added_video_ids"], self.ids)
        self.assertEqual(json.loads(self.coverage.read_text())["direct_review_batches"][0]["added_video_ids"], self.ids)

        # A retry after the ledger append is an exact no-op on ledger bytes and does not add a second batch.
        self.run_ingest(("--append-new",))
        self.assertEqual(self.ledger.read_bytes(), after_first)
        owner_after_retry = next(row for row in json.loads(self.source_coverage.read_text()) if row["source_key"] == SOURCE_KEY)
        self.assertEqual(len(owner_after_retry["direct_review_batches"]), 1)

    def test_duplicate_review_id_refuses_before_mutation(self):
        review = json.loads(self.review.read_text())
        review["items"].append(dict(review["items"][0]))
        self.review.write_text(json.dumps(review))
        with self.assertRaisesRegex(SystemExit, "duplicate video_id in review items"):
            self.run_ingest(("--append-new",))
        self.assertEqual(self.ledger.read_bytes(), self.original_ledger)
        self.assertEqual(self.source_coverage.read_bytes(), self.original_source_coverage)
        self.assertEqual(self.coverage.read_bytes(), self.original_coverage)

    def test_preexisting_video_id_under_other_source_refuses_before_mutation(self):
        conflict = {"video_id": self.ids[0], "source_key": "other-key", "channel": "Other"}
        self.ledger.write_bytes(self.original_ledger + (json.dumps(conflict) + "\n").encode())
        with self.assertRaisesRegex(SystemExit, "append-new target ID is already owned by a conflicting ledger row"):
            self.run_ingest(("--append-new",))
        self.assertEqual(self.source_coverage.read_bytes(), self.original_source_coverage)
        self.assertEqual(self.coverage.read_bytes(), self.original_coverage)

    def test_existing_source_key_with_wrong_channel_refuses_before_mutation(self):
        rows = [json.loads(line) for line in self.original_ledger.splitlines() if line.strip()]
        rows[0]["channel"] = "Different Creator"
        self.ledger.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
        before = self.ledger.read_bytes()
        with self.assertRaisesRegex(SystemExit, "conflicting channel owner"):
            self.run_ingest(("--append-new",))
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertEqual(self.source_coverage.read_bytes(), self.original_source_coverage)
        self.assertEqual(self.coverage.read_bytes(), self.original_coverage)


if __name__ == "__main__":
    unittest.main()
