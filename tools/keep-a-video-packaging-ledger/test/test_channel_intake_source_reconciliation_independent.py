"""Independent failure-mode coverage for pinned source/status reconciliation."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1] / "do-work"
sys.path.insert(0, str(TOOL))

import blake3  # noqa: E402
import ingest_channel_intake  # noqa: E402


class SourceReconciliationFixture(unittest.TestCase):
    SOURCE_KEY = "fixture-source-reconciliation"
    AMBER_ID = "AMBERVID001"
    OPEN_ID = "COPPERVID02"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "metadata").mkdir()
        (self.root / "catalogs").mkdir()
        (self.root / "images").mkdir()
        (self.root / "reviews").mkdir()
        self.amber_metadata = self.root / "metadata" / "amber.json"
        self.amber_metadata.write_text(json.dumps({
            "id": self.AMBER_ID, "title": "Amber title", "channel": "Amber Channel",
            "channel_id": "UC-AMBER", "description": "Amber source description",
        }) + "\n")
        self.open_metadata = self.root / "metadata" / "open.json"
        self.open_metadata.write_text(json.dumps({
            "id": self.OPEN_ID, "title": "Open title", "channel": "Copper Lane",
            "channel_id": "UC-OPEN", "description": "Open source description",
        }) + "\n")
        self.catalog = self.root / "catalogs" / "UC-AMBER.catalog.json"
        self.catalog.write_text(json.dumps({
            "channel_id": "UC-AMBER", "channel_name": "Amber Channel",
            "entries": [{"video_id": self.AMBER_ID, "title": "Amber title"}],
        }) + "\n")
        self.image = self.root / "images" / "open.png"
        self.image.write_bytes(b"fixture-image-bytes\x00\x01")
        self.review = self.root / "reviews" / "open.json"
        self.review.write_text(json.dumps({
            "schema": "thumbnail-review-observations@1",
            "records": [{
                "video_id": self.OPEN_ID,
                "thumbnail_original_path": str(self.image),
                "thumbnail_blake3": self.identity(self.image)["value"],
                "thumbnail_bytes": self.identity(self.image)["bytes"],
                "visual_review_method": "direct pixel display of retained local original",
                "source_title_provenance_path": str(self.open_metadata),
                "visible_text": ["OPEN"],
                "composition": "Centered subject",
                "title_relation": "Title supplies context",
            }],
        }, ensure_ascii=False) + "\n")
        self.amber_row = {
            "video_id": self.AMBER_ID, "source_key": self.SOURCE_KEY,
            "channel": "Amber Channel", "metadata_title": "Amber title",
            "metadata_source_path": "metadata/amber.json", "metadata_source_identity": None,
            "source_channel_id": None, "description": None,
            "caption_sources": ["captions/amber.json3"],
            "opening_hook_evidence": [{"source_event_index": 2, "opaque": True}],
            "internal_hook_evidence": [{"source_event_index": 4, "opaque": True}],
            "manual_annotation": {"keep": ["exact"]},
            "field_status": {"opening_hook": "preserve this state", "other": "untouched"},
        }
        self.open_row = {
            "video_id": self.OPEN_ID, "source_key": self.SOURCE_KEY,
            "channel": "Copper Lane", "metadata_title": "Open title",
            "metadata_source_path": "metadata/open.json", "metadata_source_identity": None,
            "source_channel_id": "UC-OPEN", "description": None,
            "thumbnail_image_path": str(self.image),
            "thumbnail_blake3": self.identity(self.image),
            "thumbnail_words": {
                "status": "directly reviewed", "value": ["OPEN"],
                "composition": "Centered subject",
                "title_thumbnail_role_relation": "Title supplies context",
            },
            "caption_sources": ["captions/open.json3"],
            "opening_hook_evidence": [{"source_event_index": 1, "opaque": True}],
            "internal_hook_evidence": [{"source_event_index": 3, "opaque": True}],
            "manual_annotation": {"keep": ["open"]},
            "field_status": {
                "description": "metadata source absent",
                "thumbnail_image": "image absent",
                "thumbnail_words": "unreviewed",
                "opening_hook": "caption evidence exists; keep it",
                "other": "leave untouched",
            },
        }
        self.rows = [self.amber_row, self.open_row]
        self.original_lines = [
            (json.dumps(self.amber_row, ensure_ascii=False, separators=(",", ":")) + "\r\n").encode(),
            (json.dumps(self.open_row, ensure_ascii=False, separators=(",", ":")) + "\n").encode(),
            b'{ "video_id" : "unrelated", "source_key" : "other", "raw" : [1, 2] } \r\n',
        ]
        self.ledger = self.root / "VIDEO-PACKAGING.jsonl"
        self.ledger.write_bytes(b"".join(self.original_lines))
        self.contract = self.root / "reconciliation.json"
        self.readback = self.root / "READBACK.json"
        self.preimage = self.root / "PREIMAGE.json"
        self.prospective = self.root / "PROSPECTIVE.jsonl"
        self.set_contract()

    def identity(self, path):
        raw = path.read_bytes()
        return {"algorithm": "blake3", "value": blake3.blake3(raw).hexdigest(), "bytes": len(raw)}

    def set_contract(self, *, updates=None):
        if updates is None:
            updates = [
                {
                    "video_id": self.AMBER_ID,
                    "operations": ["channel_id_from_metadata"],
                    "expected_prior_fields": {"source_channel_id": None},
                    "metadata_identity": self.identity(self.amber_metadata),
                    "channel_catalog": {"path": "catalogs/UC-AMBER.catalog.json", "identity": self.identity(self.catalog)},
                },
                {
                    "video_id": self.OPEN_ID,
                    "operations": ["description_from_metadata", "thumbnail_review_status"],
                    "expected_prior_fields": {
                        "description": None, "field_status": copy.deepcopy(self.open_row["field_status"]),
                    },
                    "metadata_identity": self.identity(self.open_metadata),
                    "thumbnail_review": {"path": "reviews/open.json", "identity": self.identity(self.review)},
                },
            ]
        self.contract.write_text(json.dumps({
            "schema": "youtube-packaging-source-reconciliation@1",
            "source_key": self.SOURCE_KEY,
            "updates": updates,
        }, ensure_ascii=False, indent=2) + "\n")

    def run_update(self, *, expected=None, readback=None, preimage=None, prospective=None):
        return ingest_channel_intake.source_status_reconciliation(
            self.root, self.ledger, self.contract, readback or self.readback,
            preimage or self.preimage, expected or ingest_channel_intake.blake3(self.ledger),
            prospective or self.prospective, False,
        )

    def test_amber_channel_and_copper_lane_description_status_stage_exactly(self):
        original = self.ledger.read_bytes()
        self.run_update()
        self.assertEqual(self.ledger.read_bytes(), original)
        lines = self.prospective.read_bytes().splitlines(keepends=True)
        amber, opened = [json.loads(line) for line in lines[:2]]
        self.assertEqual(amber["source_channel_id"], "UC-AMBER")
        self.assertEqual(opened["description"], "Open source description")
        self.assertEqual(opened["field_status"]["description"], "retained open.json description; uploader-supplied and not independently verified")
        self.assertEqual(opened["field_status"]["thumbnail_image"], "retained original image; BLAKE3 checked; directly reviewed")
        self.assertEqual(opened["field_status"]["thumbnail_words"], "directly reviewed from the retained original; visible text and roles retained")
        for before, after in zip(self.rows, (amber, opened)):
            for key in ("caption_sources", "opening_hook_evidence", "internal_hook_evidence", "manual_annotation"):
                self.assertEqual(after[key], before[key])
        self.assertEqual(lines[2], self.original_lines[2])
        receipt = json.loads(self.readback.read_text())
        self.assertEqual(receipt["status"], "prospective")
        self.assertTrue(receipt["exact_inverse_verified"])
        self.assertTrue(receipt["non_target_jsonl_lines_byte_exact"])
        self.assertTrue(receipt["caption_and_hook_evidence_preserved"])
        self.assertEqual(json.loads(self.preimage.read_text())["ledger_before"]["value"], self.identity(self.ledger)["value"])

    def test_stale_ledger_and_metadata_source_identity_refuse_without_outputs(self):
        original = self.ledger.read_bytes()
        with self.assertRaisesRegex(SystemExit, "canonical ledger BLAKE3 differs"):
            self.run_update(expected="0" * 64)
        self.assertEqual(self.ledger.read_bytes(), original)
        self.assertFalse(self.readback.exists())
        self.assertFalse(self.preimage.exists())

        self.amber_metadata.write_text(self.amber_metadata.read_text().replace("Amber source description", "Changed metadata"))
        with self.assertRaisesRegex(SystemExit, "primary metadata BLAKE3 or byte-count differs from its pin"):
            self.run_update()
        self.assertEqual(self.ledger.read_bytes(), original)
        self.assertFalse(self.readback.exists())
        self.assertFalse(self.preimage.exists())

    def test_contradictory_existing_channel_id_refuses(self):
        row = copy.deepcopy(self.amber_row)
        row["source_channel_id"] = "UC-CONTRADICTION"
        lines = list(self.original_lines)
        lines[0] = (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\r\n").encode()
        self.ledger.write_bytes(b"".join(lines))
        update = json.loads(self.contract.read_text())["updates"][0]
        update["expected_prior_fields"]["source_channel_id"] = "UC-CONTRADICTION"
        self.set_contract(updates=[update])
        before = self.ledger.read_bytes()
        with self.assertRaisesRegex(SystemExit, "existing source_channel_id conflicts"):
            self.run_update()
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertFalse(self.readback.exists())
        self.assertFalse(self.preimage.exists())

    def test_nonmatching_target_and_catalog_join_refuse(self):
        updates = json.loads(self.contract.read_text())["updates"]
        updates[0]["video_id"] = "not-a-ledger-target"
        self.set_contract(updates=updates)
        before = self.ledger.read_bytes()
        with self.assertRaisesRegex(SystemExit, "target is not an existing row under source_key"):
            self.run_update()
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertFalse(self.preimage.exists())

        self.set_contract()
        catalog = json.loads(self.catalog.read_text())
        catalog["channel_id"] = "UC-WRONG"
        self.catalog.write_text(json.dumps(catalog) + "\n")
        updates = json.loads(self.contract.read_text())["updates"]
        updates[0]["channel_catalog"]["identity"] = self.identity(self.catalog)
        self.set_contract(updates=updates)
        with self.assertRaisesRegex(SystemExit, "channel catalog conflicts"):
            self.run_update()
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertFalse(self.readback.exists())
        self.assertFalse(self.preimage.exists())

    def test_catalog_must_uniquely_own_the_selected_video_and_title(self):
        for entries in (
            [{"video_id": self.AMBER_ID, "title": "Wrong title"}],
            [],
            [{"video_id": self.AMBER_ID, "title": "Amber title"}, {"video_id": self.AMBER_ID, "title": "Amber title"}],
        ):
            fixture = type(self)()
            fixture.setUp()
            self.addCleanup(fixture.temp.cleanup)
            catalog = {"channel_id": "UC-AMBER", "channel_name": "Amber Channel", "entries": entries}
            fixture.catalog.write_text(json.dumps(catalog) + "\n")
            updates = json.loads(fixture.contract.read_text())["updates"]
            updates[0]["channel_catalog"]["identity"] = fixture.identity(fixture.catalog)
            fixture.set_contract(updates=updates)
            before = fixture.ledger.read_bytes()
            with fixture.assertRaisesRegex(SystemExit, "channel catalog does not uniquely own this video/title"):
                fixture.run_update()
            fixture.assertEqual(fixture.ledger.read_bytes(), before)
            fixture.assertFalse(fixture.readback.exists())
            fixture.assertFalse(fixture.preimage.exists())

    def test_review_schema_and_video_join_refuse(self):
        review = json.loads(self.review.read_text())
        review["schema"] = "other-review@1"
        self.review.write_text(json.dumps(review) + "\n")
        updates = json.loads(self.contract.read_text())["updates"]
        updates[1]["thumbnail_review"]["identity"] = self.identity(self.review)
        self.set_contract(updates=updates)
        before = self.ledger.read_bytes()
        with self.assertRaisesRegex(SystemExit, "unsupported pinned thumbnail review source schema"):
            self.run_update()
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertFalse(self.preimage.exists())

        self.setUp()
        review = json.loads(self.review.read_text())
        review["records"][0]["video_id"] = "another-video"
        self.review.write_text(json.dumps(review) + "\n")
        updates = json.loads(self.contract.read_text())["updates"]
        updates[1]["thumbnail_review"]["identity"] = self.identity(self.review)
        self.set_contract(updates=updates)
        with self.assertRaisesRegex(SystemExit, "exactly one record for target"):
            self.run_update()
        self.assertFalse(self.readback.exists())
        self.assertFalse(self.preimage.exists())

    def test_prior_scope_outputs_and_preimage_retry_are_strict(self):
        updates = json.loads(self.contract.read_text())["updates"]
        updates[0]["expected_prior_fields"]["description"] = None
        self.set_contract(updates=updates)
        with self.assertRaisesRegex(SystemExit, "exactly match the selected operation scope"):
            self.run_update()
        self.assertFalse(self.preimage.exists())

        self.set_contract()
        self.run_update()
        saved_preimage = self.preimage.read_bytes()
        retry_readback = self.root / "RETRY-READBACK.json"
        retry_prospective = self.root / "RETRY-PROSPECTIVE.jsonl"
        self.run_update(readback=retry_readback, prospective=retry_prospective)
        self.assertTrue(json.loads(retry_readback.read_text())["preimage_reused_without_overwrite"])
        self.assertEqual(self.preimage.read_bytes(), saved_preimage)
        self.assertEqual(retry_prospective.read_bytes(), self.prospective.read_bytes())

        collision_readback = self.root / "COLLISION-READBACK.json"
        collision_prospective = self.root / "COLLISION-PROSPECTIVE.jsonl"
        collision_prospective.write_text("keep this output\n")
        with self.assertRaisesRegex(SystemExit, "prospective ledger destination already exists"):
            self.run_update(readback=collision_readback, prospective=collision_prospective)
        self.assertFalse(collision_readback.exists())
        self.assertEqual(collision_prospective.read_text(), "keep this output\n")
        self.assertEqual(self.preimage.read_bytes(), saved_preimage)



    def _original_thumbnail_contract(self, corrupt_image=False):
        image_identity = self.identity(self.image)
        metadata_identity = self.identity(self.open_metadata)
        review = {
            "schema": "original22-thumbnail-review-batch@1",
            "records": [{
                "video_id": self.OPEN_ID,
                "visual_review_status": "directly inspected from retained local original",
                "image_path": str(self.image), "image_bytes": image_identity["bytes"],
                "image_blake3": "0" * 64 if corrupt_image else image_identity["value"],
                "title_source_path": str(self.open_metadata),
                "title_source_bytes": metadata_identity["bytes"],
                "title_source_blake3": metadata_identity["value"],
                "visible_text": ["OPEN"], "composition": "Centered subject",
                "title_thumbnail_role_relation": "Title supplies context",
            }],
        }
        self.review.write_text(json.dumps(review))
        self.set_contract(updates=[{
            "video_id": self.OPEN_ID, "operations": ["thumbnail_analysis_from_review"],
            "expected_prior_fields": {"thumbnail_analysis": None},
            "metadata_identity": metadata_identity,
            "thumbnail_review": {"path": "reviews/open.json", "identity": self.identity(self.review)},
        }])

    def test_original_thumbnail_review_reconciles_fields_without_changing_hooks(self):
        self._original_thumbnail_contract()
        before = self.ledger.read_bytes()
        self.run_update()
        self.assertEqual(self.ledger.read_bytes(), before)
        projected = [json.loads(line) for line in self.prospective.read_text().splitlines()]
        analysis = projected[1]["thumbnail_analysis"]
        self.assertEqual(analysis["composition"], "Centered subject")
        self.assertEqual(analysis["title_thumbnail_role_relation"], "Title supplies context")
        self.assertEqual(analysis["source_review"], "reviews/open.json")
        for key in self.open_row:
            self.assertEqual(projected[1][key], self.open_row[key])
        self.assertEqual(self.prospective.read_bytes().splitlines(keepends=True)[0], self.original_lines[0])
        self.assertEqual(self.prospective.read_bytes().splitlines(keepends=True)[2], self.original_lines[2])

    def test_original_thumbnail_review_wrong_image_pin_refuses_without_mutation(self):
        self._original_thumbnail_contract(corrupt_image=True)
        before = self.ledger.read_bytes()
        with self.assertRaisesRegex(SystemExit, "image identity mismatch"):
            self.run_update()
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertFalse(self.prospective.exists())

if __name__ == "__main__":
    unittest.main()
