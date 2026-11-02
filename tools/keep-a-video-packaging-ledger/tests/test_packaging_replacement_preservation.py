"""Regression coverage for target replacement in the packaging ledger projector."""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1]
PROJECTOR = TOOL / "project_packaging_ledger.py"


def packaging_records(path: Path) -> list[dict]:
    match = re.search(r'<script[^>]*id=["\']packaging["\'][^>]*>(.*?)</script>', path.read_text(), re.S)
    if not match:
        raise AssertionError(f"missing packaging JSON block: {path}")
    return json.loads(match.group(1))


class PackagingReplacementPreservation(unittest.TestCase):
    def test_replacement_keeps_prior_target_ids_and_exact_non_target_records(self):
        with tempfile.TemporaryDirectory(prefix="packaging-replacement-") as directory:
            root = Path(directory)
            (root / "captions").mkdir()
            caption = root / "captions" / "target.json3"
            caption.write_text(json.dumps({"events": [
                {"tStartMs": 0, "dDurationMs": 500, "segs": [{"utf8": "example"}]},
            ]}))

            target_unit = "video-target-abc"
            preserved_unit = "video-preserved-xyz"
            prior_records = [
                {"id": target_unit, "is_unit": True, "order": 4,
                 "fields": {"order": 4, "unit_note": "retain prior authored unit fields"},
                 "source_provenance": {"prior_unit_note": "retained identity"}},
                {"id": "target-abc.title", "unit": target_unit, "region": "title",
                 "record_order": 4, "fields": {"title": "Old title", "opaque": {"keep": True}},
                 "source_provenance": {"legacy": "target title payload"}},
                {"id": "target-abc.caption-source-ref-004", "unit": target_unit,
                 "region": "transcript-reference", "record_order": 501,
                 "fields": {"legacy_annotation": "preserve stable caption ID"},
                 "source_provenance": {"path": "captions/target.json3", "video_id": "target-abc",
                                       "prior_only": {"nested": [1, 2, 3]}}},
                {"id": "target-abc.thumbnail-analysis", "unit": target_unit,
                 "region": "thumbnail-analysis", "record_order": 54,
                 "fields": {"composition": "old target composition"},
                 "source_provenance": {"prior_review": "target remains replaceable"}},
                {"id": "target-abc.authored-question-sequence", "unit": target_unit,
                 "region": "hook-analysis", "record_order": 66,
                 "fields": {"unknown_authored_analysis": {"keep": ["A", "B"]}},
                 "source_provenance": {"prior_only": True}},
                {"id": preserved_unit, "is_unit": True, "order": 9,
                 "fields": {"order": 9, "raw": {"keep": "byte-for-byte payload"}},
                 "source_provenance": {"opaque": ["do not rebuild", {"nested": True}]}},
                {"id": "preserved-xyz.hook-pattern", "unit": preserved_unit,
                 "region": "hook-analysis", "record_order": 77,
                 "fields": {"unknown_future_field": {"values": ["A", "B"]}},
                 "source_provenance": {"not_regenerated_by_this_ledger": True}},
            ]
            previous = root / "prior.html"
            previous.write_text(
                '<!doctype html><script type="application/json" id="packaging">'
                + json.dumps(prior_records, ensure_ascii=False, separators=(",", ":"))
                + "</script>\n"
            )
            previous_bytes = previous.read_bytes()

            def record_unit(record):
                return record.get("unit") or (record.get("id") if record.get("is_unit") else None)

            ledger = root / "VIDEO-PACKAGING.jsonl"
            rows = [
                {"source_key": "sample", "video_id": "target-abc", "url": "https://example.test/target",
                 "metadata_title": "New target title", "caption_sources": ["captions/target.json3"]},
                {"source_key": "sample", "video_id": "preserved-xyz", "url": "https://example.test/preserved",
                 "metadata_title": "A newer title that must not replace the unselected prior payload",
                 "metadata_source_path": "missing/preserved-metadata.json",
                 "thumbnail_image_path": "missing/preserved-thumbnail.jpg",
                 "thumbnail_blake3": "0" * 64,
                 "thumbnail_analysis": {"source_review": "missing/preserved-review.json"},
                 "caption_sources": ["missing/preserved-caption.json3"],
                 "opening_hook_evidence": [{"text": "unselected hook", "source_path": "missing/preserved-hook.json3",
                                             "start_s": 0, "end_s": 1}]},
            ]
            ledger.write_text("".join(json.dumps(row) + "\n" for row in rows))
            output_html, output_spec = root / "out" / "packaging.html", root / "out" / "spec.json"

            run = subprocess.run([
                sys.executable, str(PROJECTOR), "--root", str(root), "--ledger", str(ledger),
                "--source-key", "sample", "--previous-html", str(previous),
                "--replace-video-id", "target-abc", "--output-html", str(output_html),
                "--output-spec", str(output_spec),
            ], text=True, capture_output=True)

            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            projected = packaging_records(output_html)
            prior_target_ids = {record["id"] for record in prior_records if record_unit(record) == target_unit}
            new_target_ids = {record["id"] for record in projected if record_unit(record) == target_unit}
            self.assertTrue(prior_target_ids <= new_target_ids)
            updated_unit = next(record for record in projected if record.get("id") == target_unit)
            self.assertEqual(updated_unit["order"], 4)
            self.assertEqual(updated_unit["fields"], {"order": 4, "unit_note": "retain prior authored unit fields"})
            self.assertEqual(updated_unit["source_provenance"]["source_key"], "sample")
            updated_title = next(record for record in projected if record.get("id") == "target-abc.title")
            self.assertEqual(updated_title["fields"]["metadata_title"], "New target title")
            self.assertIn("target-abc.caption-source-ref-004", new_target_ids)
            self.assertNotIn("target-abc.caption-source-ref-001", new_target_ids)

            prior_non_target = [record for record in prior_records if record_unit(record) != target_unit]
            projected_non_target = [record for record in projected if record_unit(record) != target_unit]
            self.assertEqual(projected_non_target, prior_non_target)
            prior_authored = next(record for record in prior_records
                                  if record["id"] == "target-abc.authored-question-sequence")
            current_authored = next(record for record in projected
                                    if record["id"] == "target-abc.authored-question-sequence")
            self.assertEqual(current_authored, prior_authored)
            self.assertEqual(previous.read_bytes(), previous_bytes)
            self.assertTrue(output_spec.is_file())


if __name__ == "__main__":
    unittest.main()
