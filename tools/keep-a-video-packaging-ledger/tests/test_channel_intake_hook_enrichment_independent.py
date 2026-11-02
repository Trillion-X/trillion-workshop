"""Independent failure-mode coverage for hook-only packaging enrichment."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL))

import blake3  # noqa: E402
import ingest_channel_intake  # noqa: E402
import project_packaging_ledger  # noqa: E402


class HookEnrichmentFixture(unittest.TestCase):
    SOURCE_KEY = "fixture-channel"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "captions").mkdir()
        (self.root / "admission").mkdir()
        self.caption_a = self.root / "captions" / "a.json3"
        self.caption_b = self.root / "captions" / "b.json3"
        self.caption_a.write_text(json.dumps({"events": [
            {"tStartMs": 120, "dDurationMs": 500,
             "segs": [{"utf8": "Exact "}, {"utf8": "opening."}]},
            {"tStartMs": 620, "dDurationMs": 380,
             "segs": [{"utf8": "Internal claim."}]},
        ]}) + "\n")
        self.caption_b.write_text(json.dumps({"events": [
            {"tStartMs": 2000, "dDurationMs": 400,
             "segs": [{"utf8": "Second-source cue."}]},
        ]}) + "\n")
        self.analysis_path = self.root / "admission" / "HOOK-OBSERVATIONS.json"
        self.analysis_path.write_text(json.dumps({"observations": [
            {"id": "OBS-A", "events": [{"event_index": 1, "start_s": 0.62,
                                            "end_s": 1.0, "text": "Internal claim."}]},
            {"id": "OBS-B", "events": [{"event_index": 0, "start_s": 2.0,
                                            "end_s": 2.4, "text": "Second-source cue."}]},
            {"id": "OBS-OPENING", "events": [{"event_index": 0, "start_s": 0.12,
                                                  "end_s": 0.62, "text": "Exact opening."}]},
        ]}) + "\n")
        self.ledger = self.root / "VIDEO-PACKAGING.jsonl"
        self.contract = self.root / "admission" / "HOOK-ENRICHMENT.json"
        self.readback = self.root / "admission" / "READBACK.json"
        self.preimage = self.root / "admission" / "PREIMAGE.json"
        self.prospective = self.root / "admission" / "PROSPECTIVE.jsonl"
        self.rows = [self.make_row("target-one", ["captions/a.json3", "captions/b.json3"]),
                     self.make_row("target-two", ["captions/a.json3"]),
                     {"video_id": "other", "source_key": "other-channel", "note": "leave exact raw bytes"}]
        self.original_lines = [
            (json.dumps(self.rows[0], ensure_ascii=False, separators=(",", ":")) + " \t\r\n").encode(),
            (json.dumps(self.rows[1], ensure_ascii=False, separators=(",", ":")) + "\n").encode(),
            b'{ "video_id" : "other", "source_key" : "other-channel", "note" : "leave exact raw bytes" }  \r\n',
        ]
        self.ledger.write_bytes(b"".join(self.original_lines))

    def identity(self, path):
        raw = path.read_bytes()
        return {"algorithm": "blake3", "value": blake3.blake3(raw).hexdigest(), "bytes": len(raw)}

    def make_row(self, video_id, caption_sources):
        refs = []
        identities = []
        for source in caption_sources:
            path = self.root / source
            identities.append({"path": source, "identity": self.identity(path)})
        if video_id == "target-one":
            refs = [{
                "source_path": "captions/a.json3",
                "source_file_identity": self.identity(self.caption_a),
                "source_event_index": 0,
                "start_s": 0.12,
                "end_s": 0.62,
                "caption_text_copied": False,
            }]
        return {
            "video_id": video_id,
            "source_key": self.SOURCE_KEY,
            "url": f"https://example.test/{video_id}",
            "metadata_source_path": f"metadata/{video_id}.json",
            "thumbnail_words": {"status": "directly reviewed", "value": ["KEEP"]},
            "caption_sources": caption_sources,
            "caption_source_identities": identities,
            "opening_hook_evidence": refs,
            "opening_hook_status": "caption evidence captured" if refs else "pending",
            "opening_hook_interpretation": None,
            "opening_hook_qualification": None,
            "internal_hook_evidence": [],
            "internal_hook_status": "not yet analyzed",
            "internal_hook_interpretation": None,
            "internal_hook_qualification": None,
            "field_status": {
                "opening_hook": "keep opening state",
                "internal_hooks": "keep internal state",
                "thumbnail_words": "directly reviewed",
            },
            "manual_annotation": {"keep": [1, {"opaque": True}]},
        }

    def locator(self, caption, path, index, start_s, end_s, excerpt):
        return {
            "source_path": path,
            "source_file_identity": self.identity(caption),
            "source_event_index": index,
            "start_s": start_s,
            "end_s": end_s,
            "excerpt": excerpt,
        }

    def hook_spec(self, row, kind, locators, *, interpretation="Caption sequence suggests a bounded candidate.", status="caption candidate; speech not independently verified"):
        return {
            "merge_strategy": "append_distinct",
            "expected_prior_fields": {
                f"{kind}_evidence": copy.deepcopy(row.get(f"{kind}_evidence")),
                f"{kind}_status": row.get(f"{kind}_status"),
                f"{kind}_interpretation": row.get(f"{kind}_interpretation"),
                f"{kind}_qualification": row.get(f"{kind}_qualification"),
            },
            "status": status,
            "interpretation": interpretation,
            "qualification": "Caption-derived; audio and audience response are unknown.",
            "caption_locators": locators,
        }

    def set_contract(self, updates):
        self.contract.write_text(json.dumps({
            "schema": "youtube-packaging-hook-enrichment@1",
            "source_key": self.SOURCE_KEY,
            "updates": updates,
        }, ensure_ascii=False, indent=2) + "\n")

    def run_update(self, *, expected=None, readback=None, preimage=None, prospective=None):
        return ingest_channel_intake.hook_enrichment_update(
            self.root, self.ledger, self.contract,
            readback or self.readback, preimage or self.preimage,
            expected or ingest_channel_intake.blake3(self.ledger),
            prospective or self.prospective, False,
        )

    def test_multi_target_add_preserves_old_hook_and_unrelated_data_with_two_caption_sources(self):
        target_one, target_two = copy.deepcopy(self.rows[:2])
        first_locator = self.locator(self.caption_a, "captions/a.json3", 1, 0.62, 1.0, "Internal claim.")
        first_locator["analysis_reference"] = {
            "path": "admission/HOOK-OBSERVATIONS.json",
            "identity": self.identity(self.analysis_path),
            "observation_id": "OBS-A",
        }
        second_locator = self.locator(self.caption_b, "captions/b.json3", 0, 2.0, 2.4, "Second-source cue.")
        second_locator["analysis_reference"] = {
            "path": "admission/HOOK-OBSERVATIONS.json",
            "identity": self.identity(self.analysis_path),
            "json_pointer": "/observations/1",
        }
        self.set_contract([
            {"video_id": "target-one", "internal_hook": self.hook_spec(target_one, "internal_hook", [first_locator, second_locator])},
            {"video_id": "target-two", "opening_hook": self.hook_spec(target_two, "opening_hook", [
                self.locator(self.caption_a, "captions/a.json3", 0, 0.12, 0.62, "Exact opening."),
            ])},
        ])
        ledger_before = self.ledger.read_bytes()

        self.run_update()

        self.assertEqual(self.ledger.read_bytes(), ledger_before)
        candidate = self.prospective.read_bytes().splitlines(keepends=True)
        projected = [json.loads(line) for line in candidate if line.strip()]
        one, two = projected[:2]
        self.assertEqual(one["opening_hook_evidence"], self.rows[0]["opening_hook_evidence"])
        self.assertEqual(one["opening_hook_status"], self.rows[0]["opening_hook_status"])
        self.assertEqual(one["internal_hook_evidence"][0]["source_path"], "captions/a.json3")
        self.assertEqual(one["internal_hook_evidence"][1]["source_path"], "captions/b.json3")
        self.assertEqual(one["internal_hook_evidence"][0]["analysis_reference"]["observation_id"], "OBS-A")
        self.assertEqual(one["internal_hook_evidence"][1]["analysis_reference"]["json_pointer"], "/observations/1")
        projected_refs = project_packaging_ledger.project_hook_references(one["internal_hook_evidence"])
        self.assertEqual(projected_refs[0]["analysis_reference"]["observation_id"], "OBS-A")
        self.assertEqual(projected_refs[1]["analysis_reference"]["json_pointer"], "/observations/1")
        self.assertNotIn("excerpt", projected_refs[0])
        self.assertFalse(projected_refs[0]["caption_text_copied"])
        self.assertEqual(one["manual_annotation"], self.rows[0]["manual_annotation"])
        self.assertEqual(one["metadata_source_path"], self.rows[0]["metadata_source_path"])
        self.assertEqual(one["thumbnail_words"], self.rows[0]["thumbnail_words"])
        self.assertEqual(one["field_status"]["opening_hook"], "keep opening state")
        self.assertEqual(two["internal_hook_status"], "not yet analyzed")
        self.assertEqual(two["field_status"]["internal_hooks"], "keep internal state")
        self.assertEqual(candidate[2], self.original_lines[2])
        receipt = json.loads(self.readback.read_text())
        self.assertEqual(receipt["status"], "prospective")
        self.assertTrue(receipt["exact_inverse_verified"])
        self.assertTrue(receipt["non_target_jsonl_lines_byte_exact"])
        self.assertFalse(receipt["caption_text_copied"])
        preimage = json.loads(self.preimage.read_text())
        self.assertEqual(len(preimage["selected_lines"]), 2)

    def test_additive_append_preserves_existing_refs_and_blocks_duplicate_locator(self):
        row = copy.deepcopy(self.rows[0])
        self.set_contract([{"video_id": "target-one", "opening_hook": self.hook_spec(row, "opening_hook", [
            self.locator(self.caption_b, "captions/b.json3", 0, 2.0, 2.4, "Second-source cue."),
        ])}])
        self.run_update()
        appended = json.loads(self.prospective.read_bytes().splitlines()[0])
        self.assertEqual(appended["opening_hook_evidence"][0], row["opening_hook_evidence"][0])
        self.assertEqual(appended["opening_hook_evidence"][1]["source_event_index"], 0)

        duplicate_fixture = type(self)()
        duplicate_fixture.setUp()
        self.addCleanup(duplicate_fixture.temp.cleanup)
        duplicate_row = copy.deepcopy(duplicate_fixture.rows[0])
        # Clock rounding must not make the same source event look distinct.
        locator = duplicate_fixture.locator(duplicate_fixture.caption_a, "captions/a.json3", 0, 0.1200005, 0.6200005, "Exact opening.")
        duplicate_fixture.set_contract([{"video_id": "target-one", "opening_hook": duplicate_fixture.hook_spec(
            duplicate_row, "opening_hook", [locator])}])
        with self.assertRaisesRegex(SystemExit, "duplicate caption locator"):
            duplicate_fixture.run_update()
        self.assertEqual(duplicate_fixture.ledger.read_bytes(), b"".join(duplicate_fixture.original_lines))
        self.assertFalse(duplicate_fixture.readback.exists())
        self.assertFalse(duplicate_fixture.preimage.exists())

    def test_near_float_clock_is_canonicalized_and_half_ms_drift_is_rejected(self):
        row = copy.deepcopy(self.rows[1])
        locator = self.locator(self.caption_a, "captions/a.json3", 0, 0.1200005, 0.6200005, "Exact opening.")
        self.set_contract([{"video_id": "target-two", "opening_hook": self.hook_spec(row, "opening_hook", [locator])}])
        self.run_update()
        projected = json.loads(self.prospective.read_bytes().splitlines()[1])
        self.assertEqual(projected["opening_hook_evidence"][0]["start_s"], 0.12)
        self.assertEqual(projected["opening_hook_evidence"][0]["end_s"], 0.62)

        fixture = type(self)()
        fixture.setUp()
        self.addCleanup(fixture.temp.cleanup)
        target = copy.deepcopy(fixture.rows[1])
        shifted = fixture.locator(fixture.caption_a, "captions/a.json3", 0, 0.1205, 0.6205, "Exact opening.")
        fixture.set_contract([{"video_id": "target-two", "opening_hook": fixture.hook_spec(target, "opening_hook", [shifted])}])
        before = fixture.ledger.read_bytes()
        with fixture.assertRaisesRegex(SystemExit, "clock or exact excerpt"):
            fixture.run_update()
        fixture.assertEqual(fixture.ledger.read_bytes(), before)
        fixture.assertFalse(fixture.readback.exists())
        fixture.assertFalse(fixture.preimage.exists())

    def test_stale_ledger_and_source_evidence_refuse_without_outputs(self):
        row = copy.deepcopy(self.rows[1])
        locator = self.locator(self.caption_a, "captions/a.json3", 0, 0.12, 0.62, "Exact opening.")
        self.set_contract([{"video_id": "target-two", "opening_hook": self.hook_spec(row, "opening_hook", [locator])}])
        original = self.ledger.read_bytes()
        with self.assertRaisesRegex(SystemExit, "canonical ledger BLAKE3 differs"):
            self.run_update(expected="0" * 64)
        self.assertEqual(self.ledger.read_bytes(), original)
        self.assertFalse(self.readback.exists())
        self.assertFalse(self.preimage.exists())

        for change, message in (
            (lambda item: item.update(source_file_identity={"algorithm": "blake3", "value": "0" * 64, "bytes": 1}), "caption source identity differs"),
            (lambda item: item.update(excerpt="Wrong caption text."), "exact excerpt does not match source"),
            (lambda item: item.update(end_s=0.622), "clock or exact excerpt does not match source"),
            (lambda item: item.update(source_event_index=999), "invalid caption event index"),
            (lambda item: item.update(source_path="../../outside.json3"), "escapes --root"),
        ):
            fixture = type(self)()
            fixture.setUp()
            self.addCleanup(fixture.temp.cleanup)
            target = copy.deepcopy(fixture.rows[1])
            bad_locator = fixture.locator(fixture.caption_a, "captions/a.json3", 0, 0.12, 0.62, "Exact opening.")
            change(bad_locator)
            fixture.set_contract([{"video_id": "target-two", "opening_hook": fixture.hook_spec(target, "opening_hook", [bad_locator])}])
            before = fixture.ledger.read_bytes()
            with fixture.assertRaisesRegex(SystemExit, message):
                fixture.run_update()
            fixture.assertEqual(fixture.ledger.read_bytes(), before)
            fixture.assertFalse(fixture.readback.exists())
            fixture.assertFalse(fixture.preimage.exists())

    def test_duplicate_target_is_ambiguous_and_refuses(self):
        row = copy.deepcopy(self.rows[1])
        spec = self.hook_spec(row, "opening_hook", [
            self.locator(self.caption_a, "captions/a.json3", 0, 0.12, 0.62, "Exact opening.")])
        self.set_contract([{"video_id": "target-two", "opening_hook": spec},
                           {"video_id": "target-two", "opening_hook": spec}])
        before = self.ledger.read_bytes()
        with self.assertRaisesRegex(SystemExit, "distinct video IDs"):
            self.run_update()
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertFalse(self.readback.exists())
        self.assertFalse(self.preimage.exists())

    def test_duplicate_analysis_observation_id_refuses(self):
        data = json.loads(self.analysis_path.read_text())
        data["observations"].append(copy.deepcopy(data["observations"][0]))
        self.analysis_path.write_text(json.dumps(data) + "\n")
        row = copy.deepcopy(self.rows[1])
        locator = self.locator(self.caption_a, "captions/a.json3", 1, 0.62, 1.0, "Internal claim.")
        locator["analysis_reference"] = {
            "path": "admission/HOOK-OBSERVATIONS.json",
            "identity": self.identity(self.analysis_path),
            "observation_id": "OBS-A",
        }
        self.set_contract([{"video_id": "target-two", "internal_hook": self.hook_spec(row, "internal_hook", [locator])}])
        before = self.ledger.read_bytes()
        with self.assertRaisesRegex(SystemExit, "analysis observation_id does not resolve uniquely"):
            self.run_update()
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertFalse(self.readback.exists())
        self.assertFalse(self.preimage.exists())

    def test_analysis_references_must_resolve_and_contain_exact_locator(self):
        for observation_id, locator_index, message in (
            ("invented-observation", 1, "analysis observation_id does not resolve uniquely"),
            ("OBS-A", 0, "selected caption locator is not present in the linked analysis observation"),
        ):
            fixture = type(self)()
            fixture.setUp()
            self.addCleanup(fixture.temp.cleanup)
            target = copy.deepcopy(fixture.rows[1])
            locator = fixture.locator(fixture.caption_a, "captions/a.json3", locator_index,
                                      0.12 if locator_index == 0 else 0.62,
                                      0.62 if locator_index == 0 else 1.0,
                                      "Exact opening." if locator_index == 0 else "Internal claim.")
            locator["analysis_reference"] = {
                "path": "admission/HOOK-OBSERVATIONS.json",
                "identity": fixture.identity(fixture.analysis_path),
                "observation_id": observation_id,
            }
            fixture.set_contract([{"video_id": "target-two", "opening_hook": fixture.hook_spec(
                target, "opening_hook", [locator])}])
            before = fixture.ledger.read_bytes()
            with fixture.assertRaisesRegex(SystemExit, message):
                fixture.run_update()
            fixture.assertEqual(fixture.ledger.read_bytes(), before)
            fixture.assertFalse(fixture.readback.exists())
            fixture.assertFalse(fixture.preimage.exists())

    def test_existing_outputs_and_path_aliases_refuse_before_writing_preimage(self):
        row = copy.deepcopy(self.rows[1])
        self.set_contract([{"video_id": "target-two", "opening_hook": self.hook_spec(row, "opening_hook", [
            self.locator(self.caption_a, "captions/a.json3", 0, 0.12, 0.62, "Exact opening.")])}])
        self.prospective.write_text("existing prospective output\n")
        with self.assertRaisesRegex(SystemExit, "prospective ledger destination already exists"):
            self.run_update()
        self.assertFalse(self.preimage.exists())
        self.assertFalse(self.readback.exists())

        fresh = type(self)()
        fresh.setUp()
        self.addCleanup(fresh.temp.cleanup)
        target = copy.deepcopy(fresh.rows[1])
        fresh.set_contract([{"video_id": "target-two", "opening_hook": fresh.hook_spec(target, "opening_hook", [
            fresh.locator(fresh.caption_a, "captions/a.json3", 0, 0.12, 0.62, "Exact opening.")])}])
        with self.assertRaisesRegex(SystemExit, "distinct|same|alias|path"):
            fresh.run_update(readback=fresh.prospective)
        self.assertFalse(fresh.preimage.exists())

        for destination_key in ("readback", "preimage"):
            fixture = type(self)()
            fixture.setUp()
            self.addCleanup(fixture.temp.cleanup)
            target = copy.deepcopy(fixture.rows[1])
            fixture.set_contract([{"video_id": "target-two", "opening_hook": fixture.hook_spec(target, "opening_hook", [
                fixture.locator(fixture.caption_a, "captions/a.json3", 0, 0.12, 0.62, "Exact opening.")])}])
            destination = getattr(fixture, destination_key)
            destination.write_text("existing bytes\n")
            with fixture.assertRaisesRegex(SystemExit, "destination already exists|refusing to overwrite|existing hook preimage is unreadable"):
                fixture.run_update()
            fixture.assertEqual(destination.read_text(), "existing bytes\n")
            other = fixture.preimage if destination_key == "readback" else fixture.readback
            fixture.assertFalse(other.exists())

    def test_stale_ledger_caption_identity_refuses(self):
        row = copy.deepcopy(self.rows[1])
        row["caption_source_identities"][0]["identity"] = {
            "algorithm": "blake3", "value": "0" * 64, "bytes": 1,
        }
        lines = list(self.original_lines)
        lines[1] = (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        self.ledger.write_bytes(b"".join(lines))
        locator = self.locator(self.caption_a, "captions/a.json3", 0, 0.12, 0.62, "Exact opening.")
        self.set_contract([{"video_id": "target-two", "opening_hook": self.hook_spec(row, "opening_hook", [locator])}])
        before = self.ledger.read_bytes()
        with self.assertRaisesRegex(SystemExit, "retained caption source identity list conflicts"):
            self.run_update()
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertFalse(self.readback.exists())
        self.assertFalse(self.preimage.exists())

    def test_malformed_retained_caption_source_lists_refuse(self):
        for malformed in ("captions/a.json3", ["captions/a.json3", 4], ["captions/a.json3", "captions/a.json3"]):
            fixture = type(self)()
            fixture.setUp()
            self.addCleanup(fixture.temp.cleanup)
            row = copy.deepcopy(fixture.rows[1])
            row["caption_sources"] = malformed
            lines = list(fixture.original_lines)
            lines[1] = (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
            fixture.ledger.write_bytes(b"".join(lines))
            locator = fixture.locator(fixture.caption_a, "captions/a.json3", 0, 0.12, 0.62, "Exact opening.")
            fixture.set_contract([{"video_id": "target-two", "opening_hook": fixture.hook_spec(row, "opening_hook", [locator])}])
            before = fixture.ledger.read_bytes()
            with fixture.assertRaisesRegex(SystemExit, "retained caption_sources must be a unique list of nonempty paths"):
                fixture.run_update()
            fixture.assertEqual(fixture.ledger.read_bytes(), before)
            fixture.assertFalse(fixture.readback.exists())
            fixture.assertFalse(fixture.preimage.exists())

    def test_exact_preimage_retry_is_reused_without_overwrite_and_changed_selection_refuses(self):
        row = copy.deepcopy(self.rows[1])
        locator = self.locator(self.caption_a, "captions/a.json3", 0, 0.12, 0.62, "Exact opening.")
        self.set_contract([{"video_id": "target-two", "opening_hook": self.hook_spec(row, "opening_hook", [locator])}])
        self.run_update()
        saved_preimage = self.preimage.read_bytes()

        retry_readback = self.root / "admission" / "RETRY-READBACK.json"
        retry_prospective = self.root / "admission" / "RETRY-PROSPECTIVE.jsonl"
        self.run_update(readback=retry_readback, prospective=retry_prospective)
        retry_receipt = json.loads(retry_readback.read_text())
        self.assertTrue(retry_receipt["preimage_reused_without_overwrite"])
        self.assertEqual(self.preimage.read_bytes(), saved_preimage)
        self.assertEqual(retry_prospective.read_bytes(), self.prospective.read_bytes())

        changed_locator = self.locator(self.caption_a, "captions/a.json3", 1, 0.62, 1.0, "Internal claim.")
        self.set_contract([{"video_id": "target-two", "internal_hook": self.hook_spec(row, "internal_hook", [changed_locator])}])
        changed_readback = self.root / "admission" / "CHANGED-READBACK.json"
        changed_prospective = self.root / "admission" / "CHANGED-PROSPECTIVE.jsonl"
        with self.assertRaisesRegex(SystemExit, "existing hook preimage differs"):
            self.run_update(readback=changed_readback, prospective=changed_prospective)
        self.assertEqual(self.preimage.read_bytes(), saved_preimage)
        self.assertFalse(changed_readback.exists())
        self.assertFalse(changed_prospective.exists())

    def test_dual_hook_update_preserves_both_field_statuses_and_malformed_status_refuses(self):
        row = copy.deepcopy(self.rows[0])
        opening = self.hook_spec(row, "opening_hook", [
            self.locator(self.caption_b, "captions/b.json3", 0, 2.0, 2.4, "Second-source cue.")])
        internal = self.hook_spec(row, "internal_hook", [
            self.locator(self.caption_a, "captions/a.json3", 1, 0.62, 1.0, "Internal claim.")])
        self.set_contract([{"video_id": "target-one", "opening_hook": opening, "internal_hook": internal}])
        self.run_update()
        projected = json.loads(self.prospective.read_bytes().splitlines()[0])
        self.assertEqual(len(projected["opening_hook_evidence"]), 2)
        self.assertEqual(len(projected["internal_hook_evidence"]), 1)
        self.assertIn("caption event evidence only", projected["field_status"]["opening_hook"])
        self.assertIn("caption event evidence only", projected["field_status"]["internal_hooks"])

        fixture = type(self)()
        fixture.setUp()
        self.addCleanup(fixture.temp.cleanup)
        malformed = copy.deepcopy(fixture.rows[1])
        malformed["field_status"] = ["not an object"]
        lines = list(fixture.original_lines)
        lines[1] = (json.dumps(malformed, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        fixture.ledger.write_bytes(b"".join(lines))
        locator = fixture.locator(fixture.caption_a, "captions/a.json3", 0, 0.12, 0.62, "Exact opening.")
        fixture.set_contract([{"video_id": "target-two", "opening_hook": fixture.hook_spec(malformed, "opening_hook", [locator])}])
        before = fixture.ledger.read_bytes()
        with fixture.assertRaisesRegex(SystemExit, "field_status must be an object"):
            fixture.run_update()
        fixture.assertEqual(fixture.ledger.read_bytes(), before)
        fixture.assertFalse(fixture.readback.exists())
        fixture.assertFalse(fixture.preimage.exists())


if __name__ == "__main__":
    unittest.main()
