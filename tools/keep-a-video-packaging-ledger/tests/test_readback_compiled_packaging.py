"""Known-good and reconstructed known-bad legacy projection contract fixtures."""

import copy
import json
import tempfile
import unittest
from pathlib import Path
import sys

TOOL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL))

import blake3  # noqa: E402
from readback_compiled_packaging import compare_legacy_package, validate, validate_legacy_hook_reference  # noqa: E402


class LegacyCompiledPreservation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.caption = self.root / "source.json3"
        self.caption_bytes = json.dumps({"events": [{"tStartMs": 80, "dDurationMs": 4000, "segs": [{"utf8": "not copied"}]}]}).encode()
        self.caption.write_bytes(self.caption_bytes)
        self.caption_digest = blake3.blake3(self.caption_bytes).hexdigest()
        self.row = {
            "video_id": "OLD12345678",
            "source_key": "ch-dankoe-intake-videos",
            "metadata_title": "Old title",
            "opening_hook_evidence": [{
                "start_s": 0.08,
                "end_s": 4.08,
                "text": "historical inline text must not survive",
                "source_path": str(self.caption),
                "source_blake3": self.caption_digest,
            }],
            "thumbnail_words": {"value": [{"text": "OLD THUMB", "role": "thumbnail overlay", "glyph_confidence": "clear"}]},
        }
        self.old_records = [
            {"id": "OLD12345678.title", "unit": "video-OLD12345678", "region": "title", "fields": {"title": "Old title", "metadata_title": "Old title"}},
            {"id": "OLD12345678.description", "unit": "video-OLD12345678", "region": "description", "fields": {"description": "Old description"}},
            {"id": "OLD12345678.thumbnail-text-1", "unit": "video-OLD12345678", "region": "thumbnail", "fields": {"thumbnail_text": "OLD THUMB"}},
            {"id": "OLD12345678.caption.opening.001", "unit": "video-OLD12345678", "region": "captions", "fields": {"opening_caption_text": "historical inline text must not survive"}},
        ]
        self.current_records = [
            copy.deepcopy(self.old_records[0]),
            copy.deepcopy(self.old_records[1]),
            {
                "id": "OLD12345678.thumbnail-text-1", "unit": "video-OLD12345678", "region": "thumbnail",
                "fields": {"thumbnail_text": "OLD THUMB"},
                "source_provenance": {"role": "thumbnail overlay", "glyph_confidence": "clear"},
            },
            {
                "id": "OLD12345678.caption.opening.001", "unit": "video-OLD12345678", "region": "captions",
                "fields": {},
                "source_provenance": {
                    "path": str(self.caption),
                    "source_file_identity": {"bytes": len(self.caption_bytes), "blake3": self.caption_digest},
                    "video_id": "OLD12345678",
                    "source_event_index": 0,
                    "t0": 0.08,
                    "t1": 4.08,
                    "caption_text_copied": False,
                },
            },
        ]
        self.before_compiled = self.root / "before.json"
        self.before_compiled.write_text(json.dumps({"notes": {"html_json_records_source": {"raw_records": self.old_records}}}))
        self.before_ledger = self.root / "before.jsonl"
        self.before_ledger.write_text(json.dumps(self.row) + "\n")

    def check_current(self, records):
        return compare_legacy_package(
            self.root,
            self.before_compiled,
            self.before_ledger,
            [self.row],
            {record["id"]: record for record in records},
        )

    def test_corrected_locator_and_old_fields_pass(self):
        result = self.check_current(self.current_records)
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["preexisting_compiled_records_preserved"], 4)
        self.assertEqual(result["legacy_selected_opening_locators"], 1)
        self.assertFalse(result["legacy_caption_text_copied"])

    def test_reconstructed_known_bad_projection_is_rejected(self):
        # These corruptions reproduce the failure classes in the root regression
        # proof; they are synthetic because the exact rejected83 bytes were gone.
        cases = {}
        cases["description dropped"] = [record for record in self.current_records if record["id"] != "OLD12345678.description"]
        title_alias = copy.deepcopy(self.current_records)
        title_alias[0]["fields"].pop("metadata_title")
        cases["metadata_title alias dropped"] = title_alias
        thumbnail_object = copy.deepcopy(self.current_records)
        thumbnail_object[2]["fields"]["thumbnail_text"] = {"text": "OLD THUMB", "role": "thumbnail overlay"}
        cases["thumbnail_text changed to object"] = thumbnail_object
        copied_caption = copy.deepcopy(self.current_records)
        copied_caption[3]["fields"] = {"opening_caption_text": "historical inline text must not survive"}
        cases["caption text copied instead of locator"] = copied_caption
        missing_locator = copy.deepcopy(self.current_records)
        missing_locator.pop()
        cases["selected opening locator missing"] = missing_locator
        for label, bad_records in cases.items():
            with self.subTest(label=label), self.assertRaises(ValueError):
                self.check_current(bad_records)


class CompiledChannelJoinCompatibility(unittest.TestCase):
    """Pin the narrow compiled legacy channel alias without relaxing source proof."""

    VIDEO_ID = "CHANNELFIXTURE123"
    SOURCE_KEY = "channel-fixture"
    CHANNEL_ID = "UC-channel-fixture"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.metadata_path = self.root / "metadata.json"
        self.image_path = self.root / "thumbnail.fixture"
        self.ledger_path = self.root / "VIDEO-PACKAGING.jsonl"
        self.compiled_path = self.root / "compiled.json"
        self.row, self.compiled = self.make_fixture()

    @staticmethod
    def identity(path):
        raw = path.read_bytes()
        return {"algorithm": "blake3", "value": blake3.blake3(raw).hexdigest(), "bytes": len(raw)}

    def make_fixture(self, *, metadata_channel=CHANNEL_ID, ledger_channel=CHANNEL_ID,
                     canonical_channel=None, legacy_channel=CHANNEL_ID,
                     metadata_pin=True, metadata_pin_value=None, metadata_pin_bytes=None,
                     omit_metadata_channel=False, omit_canonical=False, omit_legacy=False,
                     metadata_reference_shape="canonical", legacy_metadata_path=None,
                     legacy_metadata_digest=None, legacy_metadata_bytes=None,
                     omit_legacy_metadata_path=False, omit_legacy_metadata_identity=False,
                     canonical_metadata_digest=None):
        metadata = {"id": self.VIDEO_ID, "title": "Fixture title"}
        if not omit_metadata_channel:
            metadata["channel_id"] = metadata_channel
        self.metadata_path.write_text(json.dumps(metadata, ensure_ascii=False) + "\n")
        metadata_identity = self.identity(self.metadata_path)
        self.image_path.write_bytes(b"synthetic bytes only; not a decoded image")
        image_identity = self.identity(self.image_path)

        row = {
            "video_id": self.VIDEO_ID,
            "source_key": self.SOURCE_KEY,
            "source_channel_id": ledger_channel,
            "url": "https://example.test/channel-fixture",
            "inventory_title": "Fixture title",
            "metadata_title": "Fixture title",
            "metadata_source_path": "metadata.json",
            "metadata_source_identity": ({
                **metadata_identity,
                **({"value": metadata_pin_value} if metadata_pin_value is not None else {}),
                **({"bytes": metadata_pin_bytes} if metadata_pin_bytes is not None else {}),
            } if metadata_pin else None),
            "thumbnail_image_path": "thumbnail.fixture",
            "thumbnail_blake3": {"value": image_identity["value"], "bytes": image_identity["bytes"]},
            "thumbnail_words": {"value": []},
            "thumbnail_analysis": {"composition": "fixture composition", "title_thumbnail_role_relation": "fixture relation"},
            "caption_sources": [],
        }
        if not metadata_pin:
            row.pop("metadata_source_identity")
        if ledger_channel is None:
            row.pop("source_channel_id")

        unit_provenance = {
            "source_key": self.SOURCE_KEY,
            "url": row["url"],
            "caption_source_references": [],
        }
        if metadata_reference_shape in ("canonical", "both"):
            canonical_identity = dict(metadata_identity)
            if canonical_metadata_digest is not None:
                canonical_identity["value"] = canonical_metadata_digest
            unit_provenance["metadata_source_reference"] = {"path": "metadata.json", "identity": canonical_identity}
        if metadata_reference_shape in ("legacy", "both"):
            legacy_identity = {
                "bytes": metadata_identity["bytes"] if legacy_metadata_bytes is None else legacy_metadata_bytes,
                "blake3": metadata_identity["value"] if legacy_metadata_digest is None else legacy_metadata_digest,
            }
            if not omit_legacy_metadata_path:
                unit_provenance["source_metadata_path"] = legacy_metadata_path or "metadata.json"
            if not omit_legacy_metadata_identity:
                unit_provenance["metadata_file_identity"] = legacy_identity
        if not omit_canonical:
            unit_provenance["source_channel_id"] = canonical_channel
        if not omit_legacy:
            unit_provenance["channel_id"] = legacy_channel

        unit_id = f"video-{self.VIDEO_ID}"
        records = [
            {"id": unit_id, "unit": unit_id, "is_unit": True, "source_provenance": unit_provenance},
            {"id": f"{self.VIDEO_ID}.title", "unit": unit_id, "region": "title",
             "fields": {"title": "Fixture title", "metadata_title": "Fixture title"},
             "source_provenance": {"video_id": self.VIDEO_ID, "path": "metadata.json", "source_file_identity": metadata_identity}},
            {"id": f"{self.VIDEO_ID}.thumbnail-analysis", "unit": unit_id, "region": "thumbnail-analysis",
             "fields": {"composition": "fixture composition", "title_thumbnail_role_relation": "fixture relation"}},
        ]
        compiled = {"piece": {"source_key": self.SOURCE_KEY}, "notes": {"html_json_records_source": {"raw_records": records}}}
        self.ledger_path.write_text(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        self.compiled_path.write_text(json.dumps(compiled, ensure_ascii=False, indent=2) + "\n")
        return row, compiled

    def read(self):
        return validate(self.root, self.SOURCE_KEY, self.ledger_path, self.compiled_path, [self.VIDEO_ID])

    def test_null_canonical_uses_identity_pinned_legacy_channel_id(self):
        result = self.read()
        resolved = result["resolved"][self.VIDEO_ID]
        self.assertEqual(resolved["source_channel_id"], self.CHANNEL_ID)
        self.assertEqual(resolved["channel_join_basis"], "channel_id+identity-pinned-metadata")
        self.assertEqual(resolved["metadata_reference_basis"], "metadata_source_reference")
        self.assertEqual(resolved["metadata_identity"]["blake3"], self.identity(self.metadata_path)["value"])

    def test_complete_actual_legacy_metadata_pair_joins_with_ledger_pinned_channel(self):
        self.make_fixture(metadata_reference_shape="legacy")
        resolved = self.read()["resolved"][self.VIDEO_ID]
        self.assertEqual(resolved["channel_join_basis"], "channel_id+identity-pinned-metadata")
        self.assertEqual(resolved["metadata_reference_basis"], "source_metadata_path+metadata_file_identity")

    def test_matching_canonical_and_legacy_metadata_references_are_verified(self):
        self.make_fixture(metadata_reference_shape="both")
        resolved = self.read()["resolved"][self.VIDEO_ID]
        self.assertEqual(resolved["metadata_reference_basis"], "metadata_source_reference+verified-legacy-aliases")

    def test_legacy_metadata_reference_requires_complete_path_and_identity(self):
        cases = (
            ({"omit_legacy_metadata_path": True}, "requires both source_metadata_path and metadata_file_identity"),
            ({"omit_legacy_metadata_identity": True}, "requires both source_metadata_path and metadata_file_identity"),
            ({"legacy_metadata_path": "elsewhere.json"}, "path differs from ledger locator"),
            ({"legacy_metadata_digest": "0" * 64}, "metadata identity mismatch"),
            ({"legacy_metadata_bytes": 999}, "metadata identity mismatch"),
            ({"metadata_pin": False}, "require a verified ledger metadata identity"),
            ({"metadata_reference_shape": "both", "legacy_metadata_digest": "0" * 64}, "metadata identity mismatch"),
            ({"metadata_reference_shape": "both", "canonical_metadata_digest": "0" * 64}, "metadata identity mismatch"),
        )
        for kwargs, message in cases:
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(ValueError, message):
                fixture_kwargs = {"metadata_reference_shape": "legacy", **kwargs}
                self.make_fixture(**fixture_kwargs)
                self.read()

    def test_concrete_canonical_channel_keeps_existing_join_basis(self):
        self.make_fixture(canonical_channel=self.CHANNEL_ID, legacy_channel=self.CHANNEL_ID)
        result = self.read()
        self.assertEqual(result["resolved"][self.VIDEO_ID]["channel_join_basis"], "source_channel_id")

    def test_conflicting_compiled_canonical_and_legacy_ids_refuse(self):
        self.make_fixture(canonical_channel=self.CHANNEL_ID, legacy_channel="UC-conflict")
        with self.assertRaisesRegex(ValueError, "compiled source channel ID aliases conflict"):
            self.read()

    def test_wrong_ledger_expected_id_refuses_legacy_channel_join(self):
        self.make_fixture(ledger_channel="UC-wrong-ledger")
        with self.assertRaisesRegex(ValueError, "legacy source channel join mismatch"):
            self.read()

    def test_wrong_metadata_channel_refuses_legacy_channel_join(self):
        self.make_fixture(metadata_channel="UC-wrong-metadata")
        with self.assertRaisesRegex(ValueError, "legacy source channel join mismatch"):
            self.read()

    def test_wrong_compiled_legacy_channel_refuses_join(self):
        self.make_fixture(legacy_channel="UC-wrong-compiled")
        with self.assertRaisesRegex(ValueError, "legacy source channel join mismatch"):
            self.read()

    def test_metadata_identity_digest_or_bytes_mismatch_refuses_legacy_fallback(self):
        cases = (
            {"metadata_pin_value": "0" * 64},
            {"metadata_pin_bytes": 999},
        )
        for kwargs in cases:
            with self.subTest(kwargs=kwargs):
                self.make_fixture(**kwargs)
                with self.assertRaisesRegex(ValueError, "metadata source identity mismatch"):
                    self.read()

    def test_missing_metadata_pin_channel_or_compiled_ids_refuse(self):
        cases = (
            ({"metadata_pin": False}, "legacy channel ID requires a verified metadata source identity"),
            ({"omit_metadata_channel": True}, "retained metadata channel ID missing"),
            ({"omit_canonical": True, "omit_legacy": True}, "compiled source channel ID missing"),
            ({"legacy_channel": None}, "compiled source channel ID missing"),
        )
        for kwargs, message in cases:
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(ValueError, message):
                self.make_fixture(**kwargs)
                self.read()

class GroupedLegacyHookSourceValidation(unittest.TestCase):
    def _source(self, root, value):
        path = root / "legacy.json"
        path.write_text(json.dumps(value))
        return path, {"path": str(path), "blake3": "b3:" + blake3.blake3(path.read_bytes()).hexdigest()}

    def test_json3_group_resolves_exact_native_index_text_and_clocks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, source = self._source(root, {"events": [
                {"tStartMs": 1200, "dDurationMs": 800, "segs": [{"utf8": "first\nsecond"}]}
            ]})
            row = {"video_id": "fixture", "hook_analysis": {"source_provenance": {"source_file": source}}}
            sample = {"verbatim_source_excerpt": [
                {"event_index_0based": 0, "start_s": 1.2, "end_s": 2.0,
                 "source_text_exact": "first\nsecond"}
            ]}
            checked = validate_legacy_hook_reference(root, row, sample)
            self.assertEqual(checked["source_units"], 1)
            sample["verbatim_source_excerpt"][0]["source_text_exact"] = "wrong text"
            with self.assertRaisesRegex(ValueError, "one pinned source"):
                validate_legacy_hook_reference(root, row, sample)

    def test_asr_group_uses_word_id_and_rejects_changed_clock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, source = self._source(root, {"words": [
                {"id": "w7", "start": 3.5, "end": 3.9, "text": "caption"}
            ]})
            row = {"video_id": "fixture", "hook_analysis": {"source_provenance": {"source_file": source}}}
            sample = {"verbatim_source_excerpt": [
                {"id": "w7", "start_s": 3.5, "end_s": 3.9, "text_exact": "caption"}
            ]}
            self.assertEqual(validate_legacy_hook_reference(root, row, sample)["source_units"], 1)
            sample["verbatim_source_excerpt"][0]["end_s"] = 4.2
            with self.assertRaisesRegex(ValueError, "one pinned source"):
                validate_legacy_hook_reference(root, row, sample)

    def test_group_refuses_changed_source_and_ambiguous_source_owners(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path, source = self._source(root, {"events": [
                {"tStartMs": 0, "dDurationMs": 1000, "segs": [{"utf8": "caption"}]}
            ]})
            source["role"] = "caption_or_transcript"
            row = {"video_id": "fixture", "hook_analysis": {"source_provenance": {"source_files": [source]}}}
            sample = {"source_units": [{"id": "json-event-index-0", "start": 0, "end": 1, "text": "caption"}]}
            self.assertEqual(validate_legacy_hook_reference(root, row, sample)["source_units"], 1)
            row["hook_analysis"]["source_provenance"]["source_files"].append(dict(source))
            with self.assertRaisesRegex(ValueError, "one pinned source"):
                validate_legacy_hook_reference(root, row, sample)
            row["hook_analysis"]["source_provenance"]["source_files"].pop()
            path.write_text("{}")
            with self.assertRaisesRegex(ValueError, "one pinned source"):
                validate_legacy_hook_reference(root, row, sample)

if __name__ == "__main__":
    unittest.main()
