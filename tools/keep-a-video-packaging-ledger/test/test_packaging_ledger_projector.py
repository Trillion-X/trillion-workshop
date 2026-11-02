"""Focused compatibility coverage for packaging ledger thumbnail identities."""
import tempfile
import unittest
from pathlib import Path
import sys

TOOL = Path(__file__).resolve().parents[1] / "do-work"
sys.path.insert(0, str(TOOL))

from project_packaging_ledger import (effective_thumbnail_analysis, normalize_thumbnail_identity,
                                     project_hook_references)  # noqa: E402


class ThumbnailIdentityCompatibility(unittest.TestCase):
    def test_current_objects_and_verified_legacy_digest_strings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "thumb.bin"
            raw = b"retained thumbnail bytes"
            image.write_bytes(raw)
            # The projector's identity algorithm is BLAKE3; use a small fixture so
            # the test does not depend on retained production assets.
            import blake3
            digest = blake3.blake3(raw).hexdigest()
            legacy = normalize_thumbnail_identity(digest, "thumb.bin", root)
            self.assertEqual(legacy, {
                "algorithm": "blake3", "value": digest, "bytes": len(raw),
            })

            current = {"algorithm": "blake3", "value": digest, "bytes": len(raw)}
            self.assertIs(normalize_thumbnail_identity(current, "thumb.bin", root), current)

            with self.assertRaisesRegex(ValueError, "does not match"):
                normalize_thumbnail_identity("0" * 64, "thumb.bin", root)


class LegacyThumbnailAnalysisCompatibility(unittest.TestCase):
    def test_nested_review_data_survives_projection_when_analysis_field_is_absent(self):
        row = {
            "thumbnail_words": {
                "status": "directly reviewed",
                "value": [{"text": "HEADLINE"}],
                "composition": "Portrait on the right with headline on the left.",
                "title_thumbnail_role_relation": "The image narrows the title topic.",
                "review_source": "review/legacy-row.json",
            },
        }
        self.assertEqual(effective_thumbnail_analysis(row), {
            "composition": "Portrait on the right with headline on the left.",
            "title_thumbnail_role_relation": "The image narrows the title topic.",
            "within_batch_pattern_sample": None,
            "pattern_scope": None,
            "source_review": "review/legacy-row.json",
        })

    def test_current_analysis_fields_take_precedence_over_legacy_values(self):
        row = {
            "thumbnail_words": {
                "composition": "Old description.",
                "title_thumbnail_role_relation": "Old relation.",
                "review_source": "old-review.json",
            },
            "thumbnail_analysis": {
                "composition": "Current description.",
                "title_thumbnail_role_relation": "Current relation.",
                "source_review": "current-review.json",
            },
        }
        result = effective_thumbnail_analysis(row)
        self.assertEqual(result["composition"], "Current description.")
        self.assertEqual(result["title_thumbnail_role_relation"], "Current relation.")
        self.assertEqual(result["source_review"], "current-review.json")


class HookReferenceProjection(unittest.TestCase):
    def test_excerpt_bearing_reference_keeps_locators_but_omits_source_text(self):
        source = [{
            "source_path": "captions/source.json3",
            "source_file_identity": {"algorithm": "blake3", "value": "a" * 64, "bytes": 42},
            "source_event_index": 7,
            "start_s": 1.25,
            "end_s": 2.5,
            "text": "caption excerpt",
            "source_units": [{"id": "cue-7", "text": "nested excerpt",
                              "timestamp_line": "00:00:01.250 --> 00:00:02.500",
                              "raw_caption_payload_lines": ["nested raw excerpt"]}],
            "source_evidence": {
                "path": "captions/source.json3",
                "source_file_identity": {"algorithm": "blake3", "value": "b" * 64, "bytes": 42},
                "event_index_range": [7, 12],
                "text": "nested source excerpt",
            },
            "caption_text_copied": False,
        }]

        projected = project_hook_references(source)

        self.assertEqual(source[0]["text"], "caption excerpt")
        self.assertEqual(source[0]["source_units"][0]["text"], "nested excerpt")
        self.assertEqual(source[0]["source_evidence"]["text"], "nested source excerpt")
        self.assertEqual(projected, [{
            "source_path": "captions/source.json3",
            "source_file_identity": {"algorithm": "blake3", "value": "a" * 64, "bytes": 42},
            "source_event_index": 7,
            "start_s": 1.25,
            "end_s": 2.5,
            "source_units": [{"id": "cue-7", "timestamp_line": "00:00:01.250 --> 00:00:02.500"}],
            "source_evidence": {
                "path": "captions/source.json3",
                "source_file_identity": {"algorithm": "blake3", "value": "b" * 64, "bytes": 42},
                "event_index_range": [7, 12],
            },
            "caption_text_copied": False,
        }])

    def test_locator_only_reference_remains_an_unchanged_locator(self):
        source = [{
            "source_path": "captions/source.json3",
            "source_event_index_range": [7, 12],
            "start_s": 1.25,
            "end_s": 4.0,
            "source_evidence": {
                "path": "captions/source.json3",
                "source_file_identity": {"algorithm": "blake3", "value": "c" * 64, "bytes": 42},
                "event_index_range": [7, 12],
            },
            "caption_text_copied": False,
        }]

        self.assertEqual(project_hook_references(source), source)


if __name__ == "__main__":
    unittest.main()
