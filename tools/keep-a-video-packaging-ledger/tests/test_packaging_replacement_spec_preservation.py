"""Isolated regressions for replacement record order and editable spec retention."""
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


def read_records(path: Path) -> list[dict]:
    match = re.search(r'<script[^>]*id=["\']packaging["\'][^>]*>(.*?)</script>', path.read_text(), re.S)
    if not match:
        raise AssertionError(f"missing packaging JSON block: {path}")
    return json.loads(match.group(1))


def run_projector(root: Path, ledger: Path, source_key: str, html: Path, spec: Path,
                  previous: Path | None = None, replace_ids: tuple[str, ...] = ()) -> subprocess.CompletedProcess:
    command = [sys.executable, str(PROJECTOR), "--root", str(root), "--ledger", str(ledger),
               "--source-key", source_key, "--output-html", str(html), "--output-spec", str(spec)]
    if previous is not None:
        command.extend(["--previous-html", str(previous)])
    for video_id in replace_ids:
        command.extend(["--replace-video-id", video_id])
    return subprocess.run(command, text=True, capture_output=True)


class PackagingReplacementSpecPreservation(unittest.TestCase):
    def test_replacement_upserts_in_place_and_preserves_editable_spec(self):
        with tempfile.TemporaryDirectory(prefix="packaging-spec-replacement-") as directory:
            root = Path(directory)
            (root / "captions").mkdir()
            (root / "metadata").mkdir()
            caption = root / "captions" / "first.json3"
            caption.write_text(json.dumps({"events": [
                {"tStartMs": 0, "dDurationMs": 500, "segs": [{"utf8": "example"}]},
            ]}))
            metadata = root / "metadata" / "first.json"
            metadata.write_text(json.dumps({"description": "Current selected description"}))

            first, middle, last = "video-target-first", "video-preserved-mid", "video-target-last"
            prior_records = [
                {"id": first, "is_unit": True, "order": 4,
                 "fields": {"order": 4, "manual_unit_field": {"retain": True}},
                 "source_provenance": {"prior_unit": "first"}},
                {"id": "target-first.title", "unit": first, "region": "title", "record_order": 4,
                 "fields": {"metadata_title": "Old first title"}, "source_provenance": {"old": True}},
                {"id": "target-first.caption-source-ref-stable", "unit": first,
                 "region": "transcript-reference", "record_order": 501,
                 "fields": {"manual_annotation": "keep stable caption identity"},
                 "source_provenance": {"path": "captions/first.json3", "video_id": "target-first"}},
                {"id": "target-first.thumbnail-analysis", "unit": first,
                 "region": "thumbnail-analysis", "record_order": 54,
                 "fields": {"composition": "old first review"}, "source_provenance": {"old": True}},
                {"id": middle, "is_unit": True, "order": 5,
                 "fields": {"order": 5, "opaque": {"leave": [1, 2]}},
                 "source_provenance": {"opaque": ["untouched"]}},
                {"id": "preserved-mid.hook-pattern", "unit": middle, "region": "hook-analysis",
                 "record_order": 55, "fields": {"unknown_future_field": {"retain": True}},
                 "source_provenance": {"not_selected": True}},
                {"id": last, "is_unit": True, "order": 8,
                 "fields": {"order": 8, "manual_unit_field": "keep second unit"},
                 "source_provenance": {"prior_unit": "last"}},
                {"id": "target-last.title", "unit": last, "region": "title", "record_order": 8,
                 "fields": {"metadata_title": "Old last title"}, "source_provenance": {"old": True}},
                {"id": "target-last.thumbnail-analysis", "unit": last,
                 "region": "thumbnail-analysis", "record_order": 58,
                 "fields": {"composition": "old last review"}, "source_provenance": {"old": True}},
            ]
            previous = root / "previous.html"
            previous.write_text('<script type="application/json" id="packaging">'
                                + json.dumps(prior_records, separators=(",", ":")) + "</script>\n")
            previous_bytes = previous.read_bytes()

            authored_spec = {
                "schema": "word-template-spec@1",
                "piece": {"id": "old-id", "medium": "old-medium", "kind": "old-kind",
                          "source_key": "old-key", "author_note": {"retain": True}},
                "sources": {
                    "html_json_records": {"path": "old/packaging.html", "script_id": "packaging",
                                          "required": True, "source_note": "preserve this option"},
                    "custom_source": {"path": "notes.json", "reader": "custom-reader"},
                },
                "lines": {"video-target-first.title": {"jobs": {"device": "keep-existing-line"}}},
                "keep": [{"id": "video-target-first.title", "reason": "authored KEEP"}],
                "slots": [{"id": "manual-slot", "rule": "retain existing judgement"}],
                "custom_owner_field": {"revision": 7, "opaque": ["retain", 2]},
            }
            output_spec = root / "spec.json"
            output_spec.write_text(json.dumps(authored_spec, indent=2) + "\n")

            ledger = root / "VIDEO-PACKAGING.jsonl"
            rows = [
                {"source_key": "sample", "video_id": "target-first", "url": "https://example.test/first",
                 "metadata_title": "New first title", "metadata_source_path": "metadata/first.json",
                 "caption_sources": ["captions/first.json3"]},
                {"source_key": "sample", "video_id": "preserved-mid", "url": "https://example.test/middle",
                 "metadata_title": "Must not read unselected metadata", "metadata_source_path": "missing/mid.json",
                 "thumbnail_image_path": "missing/mid.jpg", "thumbnail_blake3": "0" * 64,
                 "thumbnail_analysis": {"source_review": "missing/mid-review.json"},
                 "caption_sources": ["missing/mid-caption.json3"],
                 "opening_hook_evidence": [{"text": "unselected", "source_path": "missing/mid-hook.json3",
                                             "start_s": 0, "end_s": 1}]},
                {"source_key": "sample", "video_id": "target-last", "url": "https://example.test/last",
                 "metadata_title": "New last title"},
            ]
            ledger.write_text("".join(json.dumps(row) + "\n" for row in rows))

            output_html = root / "out" / "packaging.html"
            run = run_projector(root, ledger, "sample", output_html, output_spec, previous,
                                ("target-first", "target-last"))
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)

            projected = read_records(output_html)
            old_ids = [record["id"] for record in prior_records]
            new_ids = {record["id"] for record in projected}
            replayed_old_id_order = [record["id"] for record in projected if record["id"] in set(old_ids)]
            self.assertEqual(replayed_old_id_order, old_ids)
            self.assertTrue(set(old_ids) <= new_ids)
            self.assertEqual([record["id"] for record in projected if record.get("is_unit")],
                             [first, middle, last])
            units = {record["id"]: record for record in projected if record.get("is_unit")}
            self.assertEqual(units[first]["order"], 4)
            self.assertEqual(units[first]["fields"], {"order": 4, "manual_unit_field": {"retain": True}})
            self.assertEqual(units[last]["order"], 8)
            self.assertEqual(units[last]["fields"], {"order": 8, "manual_unit_field": "keep second unit"})
            titles = {record["id"]: record["fields"]["metadata_title"]
                      for record in projected if record.get("region") == "title"}
            self.assertEqual(titles["target-first.title"], "New first title")
            self.assertEqual(titles["target-last.title"], "New last title")

            def unit_of(record):
                return record.get("unit") or (record.get("id") if record.get("is_unit") else None)

            old_non_targets = [r for r in prior_records if unit_of(r) == middle]
            new_non_targets = [r for r in projected if unit_of(r) == middle]
            self.assertEqual(new_non_targets, old_non_targets)
            self.assertEqual(previous.read_bytes(), previous_bytes)

            actual_spec = json.loads(output_spec.read_text())
            self.assertEqual(actual_spec["lines"], authored_spec["lines"])
            self.assertEqual(actual_spec["keep"], authored_spec["keep"])
            self.assertEqual(actual_spec["slots"], authored_spec["slots"])
            self.assertEqual(actual_spec["custom_owner_field"], authored_spec["custom_owner_field"])
            self.assertEqual(actual_spec["piece"]["author_note"], authored_spec["piece"]["author_note"])
            self.assertEqual(actual_spec["piece"]["id"], "youtube-source:sample")
            self.assertEqual(actual_spec["sources"]["html_json_records"]["path"], str(output_html))
            self.assertEqual(actual_spec["sources"]["html_json_records"]["source_note"], "preserve this option")
            self.assertEqual(actual_spec["sources"]["custom_source"], authored_spec["sources"]["custom_source"])
            # New record IDs are not silently assigned old explicit line definitions.
            self.assertEqual(set(actual_spec["lines"]), set(authored_spec["lines"]))

    def test_fresh_projection_creates_generated_spec(self):
        with tempfile.TemporaryDirectory(prefix="packaging-fresh-spec-") as directory:
            root = Path(directory)
            ledger = root / "VIDEO-PACKAGING.jsonl"
            ledger.write_text(json.dumps({"source_key": "fresh", "video_id": "fresh-video",
                                          "url": "https://example.test/fresh",
                                          "metadata_title": "Fresh source title"}) + "\n")
            output_html, output_spec = root / "fresh.html", root / "fresh.spec.json"
            run = run_projector(root, ledger, "fresh", output_html, output_spec)
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            spec = json.loads(output_spec.read_text())
            self.assertEqual(spec["schema"], "word-template-spec@1")
            self.assertEqual(spec["piece"], {"id": "youtube-source:fresh", "medium": "video-corpus",
                                             "kind": "reference", "source_key": "fresh"})
            self.assertEqual(spec["sources"], {"html_json_records": {"path": str(output_html),
                                                                          "script_id": "packaging", "required": True}})
            self.assertNotIn("lines", spec)
            self.assertNotIn("custom_owner_field", spec)


if __name__ == "__main__":
    unittest.main()
