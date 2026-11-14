from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("prepare-semantic-index-process-input.py")
SPEC = importlib.util.spec_from_file_location("prepare", SCRIPT)
prepare = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(prepare)


def descriptor(index_id="idx"):
    return {"items": [{"payload": {"kind": "semantic-index-descriptor", "index_id": index_id, "ann_params": {"seed": 1}}}]}


class PreparationTest(unittest.TestCase):
    def test_projects_exact_descriptor_and_empty_state(self):
        self.assertEqual(prepare.exact_descriptor(descriptor(), "idx")["index_id"], "idx")
        self.assertEqual(prepare.optional_ann_state({"items": []}, "idx"), "{}")

    def test_accepts_full_collection_reply_without_positional_selection(self):
        reply = descriptor()["items"]
        self.assertEqual(prepare.exact_descriptor(reply, "idx")["index_id"], "idx")
        self.assertEqual(prepare.optional_ann_state([], "idx"), "{}")

    def test_rejects_duplicate_descriptor(self):
        reply = descriptor(); reply["items"].append(reply["items"][0])
        with self.assertRaisesRegex(ValueError, "exactly one"):
            prepare.exact_descriptor(reply, "idx")

    def test_rejects_duplicate_state(self):
        row = {"table": "attribute_fact", "property_id": "prop:semantic-ann-index:idx", "value_json": "{}"}
        with self.assertRaisesRegex(ValueError, "zero or one"):
            prepare.optional_ann_state({"items": [row, row]}, "idx")

    def test_embedding_request_is_derived_once_from_unvectorized_upserts(self):
        request = prepare.embedding_request({
            "upserts": [
                {"content_address": "a", "content_text": "Alpha"},
                {
                    "content_address": "b",
                    "content_text": "Beta",
                    "content_vector_base64": "eyJ2ZWN0b3IiOlsxXX0=",
                },
            ],
        })
        self.assertEqual(request, {"items": [{"id": "a", "text": "Alpha"}]})

    def test_embedding_request_rejects_duplicate_upserts(self):
        with self.assertRaisesRegex(ValueError, "duplicate semantic index upsert"):
            prepare.embedding_request({
                "upserts": [
                    {"content_address": "a", "content_text": "Alpha"},
                    {"content_address": "a", "content_text": "Again"},
                ],
            })

    def test_cli_can_publish_ann_state_as_a_separate_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current_descriptor = {
                "kind": "semantic-index-descriptor",
                "index_id": "idx",
                "ann_params": {"seed": 1},
            }
            state = {"index_id": "idx", "vector_count": 120_000}
            inputs = {
                "d.json": {"items": [{"payload": current_descriptor}]},
                "s.json": {
                    "items": [
                        {
                            "payload": {
                                "table": "attribute_fact",
                                "property_id": "prop:semantic-ann-index:idx",
                                "value_json": json.dumps(state),
                            }
                        }
                    ]
                },
                "plan.json": {"upserts": [], "retracts": []},
            }
            for name, value in inputs.items():
                (root / name).write_text(json.dumps(value), encoding="utf-8")
            result = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "--index-id",
                    "idx",
                    "--descriptor-reply-json",
                    str(root / "d.json"),
                    "--ann-state-reply-json",
                    str(root / "s.json"),
                    "--plan-json",
                    str(root / "plan.json"),
                    "--embedding-request-json",
                    str(root / "request.json"),
                    "--output-state-json",
                    str(root / "state.json"),
                    "--output-json",
                    str(root / "output.json"),
                ],
                text=True,
                capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            output = json.loads((root / "output.json").read_text())
            self.assertEqual(output["descriptor"]["index_id"], "idx")
            self.assertEqual(output["descriptor"]["ann_params"], {"seed": 1})
            self.assertNotIn("ann_state_value_json", output)
            self.assertEqual(json.loads((root / "state.json").read_text()), state)

    def test_cli_without_a_plan_publishes_only_descriptor_and_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current_descriptor = {
                "kind": "semantic-index-descriptor",
                "index_id": "idx",
                "ann_params": {"seed": 1},
            }
            (root / "d.json").write_text(
                json.dumps({"items": [{"payload": current_descriptor}]}),
                encoding="utf-8",
            )
            (root / "s.json").write_text('{"items":[]}', encoding="utf-8")
            result = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "--index-id",
                    "idx",
                    "--descriptor-reply-json",
                    str(root / "d.json"),
                    "--ann-state-reply-json",
                    str(root / "s.json"),
                    "--output-state-json",
                    str(root / "state.json"),
                    "--output-json",
                    str(root / "output.json"),
                ],
                text=True,
                capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            output = json.loads((root / "output.json").read_text())
            self.assertEqual(output["descriptor"]["index_id"], "idx")
            self.assertEqual(output["descriptor"]["ann_params"], {"seed": 1})
            self.assertNotIn("ann_state_value_json", output)
            self.assertEqual((root / "state.json").read_text(), "{}")

    def test_ann_leaf_executes_from_an_isolated_mounted_directory(self):
        """The helper is a job mount, never an accidental source-tree import."""
        scripts = SCRIPT.parent
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copy2(scripts / "ann-index.py", root / "ann-index.py")
            shutil.copy2(scripts / "canonical_multihash.py", root / "canonical_multihash.py")
            (root / "state.json").write_text("{}", encoding="utf-8")
            (root / "vector.json").write_text("[1.0,0.0]", encoding="utf-8")
            (root / "params.json").write_text('{"hyperplane_count":2,"table_count":1,"seed":1,"candidate_limit":4,"min_score":-1,"result_limit":4}', encoding="utf-8")
            digest = "1f:" + "a" * 64
            result = subprocess.run([
                "python3", "ann-index.py", "--mode", "upsert", "--state-json", "state.json",
                "--vector-json", "vector.json", "--params-json", "params.json", "--index-id", "idx",
                "--subject-id", "subject", "--canonical-address", "address", "--revision", digest,
                "--payload-hash", digest, "--source-snapshot-ref", digest,
                "--at", "2026-07-25T00:00:00Z", "--output-state-json", "state.out.json",
                "--output-facts-json", "facts.out.json",
            ], cwd=root, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
