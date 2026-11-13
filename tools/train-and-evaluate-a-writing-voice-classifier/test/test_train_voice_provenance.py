"""Regression tests for explicit, source-bound trainer provenance labels."""
import importlib.util
import stand_in_decider
stand_in_decider.install()
import json
import os
import copy
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock
from pathlib import Path


TRAINER_PATH = Path(__file__).resolve().parents[1] / "do-work" / "train-voice-adapter.py"
SPEC = importlib.util.spec_from_file_location("train_book_voice_adapter", TRAINER_PATH)
TRAINER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TRAINER)
# Made-up training DATA in the shapes the person's frozen sets use (test/fixtures/training): sixteen legacy rows whose
# question is the criterion's own, and twenty-six whose question carries the reference routing hint.
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "training"
WORDING16_DATA = FIXTURES / "wording16-train.jsonl"
WORDING16_PROVENANCE = FIXTURES / "wording16-provenance.json"
VOICE_RANGE16_DATA = FIXTURES / "voice-range26-train.jsonl"
VOICE_RANGE16_PROVENANCE = FIXTURES / "voice-range26-provenance.json"


def read_provenance(path):
    """A fixture provenance names its source DATA beside it; the trainer reads it by absolute path."""
    provenance = json.loads(path.read_text(encoding="utf-8"))
    provenance["source_dataset"] = str(path.parent / provenance["source_dataset"])
    return provenance


STRICT_REQUEST_POLICY = "typed-target-and-pinned-reference-v1"


def row(target="a source-bound target", gold="pass"):
    state = {
        "reference_text": "reference",
        "reader_context": "",
        "target_kind": "paragraph",
        "target_text": target,
    }
    return (json.dumps(state), {"names": ["pass", "fail"]}, ["pass", "fail"].index(gold))


def provenance(source_id="arbitrary-source-key", family="source-family", text="a source-bound target", **fields):
    return {"rows": [{"id": source_id, "family": family, "text": text, **fields}]}


class TrainingParameterValidationTests(unittest.TestCase):
    def parse(self, *extra):
        parser = TRAINER.build_argument_parser()
        return parser.parse_args(["--data", "train.jsonl", "--out", "adapter", *extra])

    def test_step_diagnostic_ids_are_opaque_jsonl_ordinals(self):
        self.assertEqual(TRAINER.opaque_training_row_id(0), "row-0001")
        self.assertEqual(TRAINER.opaque_training_row_id(90), "row-0091")
        for invalid in (-1, True, 1.5):
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(ValueError, "nonnegative integer"):
                    TRAINER.opaque_training_row_id(invalid)

    def test_lora_dropout_defaults_to_current_probability(self):
        args = self.parse()
        self.assertEqual(args.lora_dropout, 0.05)
        TRAINER.validate_training_parameters(args)

    def test_zero_and_intermediate_lora_dropout_are_valid(self):
        for value in ("0", "0.2", "0.999"):
            with self.subTest(value=value):
                args = self.parse(f"--lora-dropout={value}")
                TRAINER.validate_training_parameters(args)

    def test_lora_dropout_rejects_out_of_range_and_nonfinite_values(self):
        for value in ("-0.001", "1", "nan", "inf", "-inf"):
            with self.subTest(value=value):
                args = self.parse(f"--lora-dropout={value}")
                with self.assertRaisesRegex(ValueError, r"lora-dropout.*\[0, 1\)"):
                    TRAINER.validate_training_parameters(args)


class ClassifierReadyIdentityTests(unittest.TestCase):
    def test_model_resolution_uses_exact_classifier_ready_identity_without_fetching(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            model_path, owner_dir, model = stand_in_decider.write_model_config(root)
            resolved, snapshot = TRAINER.resolve_verified_model(model_path, owner_dir)
            self.assertEqual(snapshot, Path(model["model"]["weights"]["folder"]).resolve())
            self.assertEqual(resolved["ready"]["identity"], model["ready"]["identity"])
            (snapshot / "adapter.safetensors").write_bytes(b"changed weights")
            with self.assertRaisesRegex(ValueError, "do not match.*classifier-ready identity"):
                TRAINER.resolve_verified_model(model_path, owner_dir)

    def test_training_record_files_must_match_all_exact_dataset_identities(self):
        data_bytes = b'{"training":"rows"}\n'
        provenance_bytes = b'{"provenance":"rows"}\n'
        source_hash = "a" * 64
        model = {
            "training_data_identity": "1f:" + TRAINER.digest_bytes(data_bytes),
            "provenance_identity": "1f:" + TRAINER.digest_bytes(provenance_bytes),
            "source_data_identity": "1f:" + source_hash,
        }
        TRAINER.validate_training_input_identities(model, data_bytes, provenance_bytes, source_hash)
        with self.assertRaisesRegex(ValueError, "Training DATA does not match"):
            TRAINER.validate_training_input_identities(model, data_bytes + b" ", provenance_bytes, source_hash)
        with self.assertRaisesRegex(ValueError, "Training provenance does not match"):
            TRAINER.validate_training_input_identities(model, data_bytes, provenance_bytes + b" ", source_hash)
        with self.assertRaisesRegex(ValueError, "Source DATA does not match"):
            TRAINER.validate_training_input_identities(model, data_bytes, provenance_bytes, "b" * 64)

    def test_ready_file_manifest_refuses_duplicate_and_unsafe_names(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            model_path, owner_dir, model = stand_in_decider.write_model_config(root)
            model["ready"]["files"].append(dict(model["ready"]["files"][0]))
            model_path.write_text(json.dumps(model), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate or unsafe"):
                TRAINER.resolve_verified_model(model_path, owner_dir)


class ExplicitProvenanceLabelTests(unittest.TestCase):
    def test_arbitrary_id_with_explicit_matching_label_is_accepted(self):
        rows = [row()]
        supplied = provenance(label="pass")
        self.assertEqual(TRAINER.validate_provenance(rows, supplied), supplied["rows"])

    def test_misleading_prefix_cannot_override_mismatched_explicit_label(self):
        with self.assertRaisesRegex(ValueError, "explicit gold label"):
            TRAINER.validate_provenance([row(gold="pass")], provenance(source_id="p-looks-approved", label="fail"))

    def test_missing_label_is_refused(self):
        with self.assertRaisesRegex(ValueError, "explicit nonempty label or gold"):
            TRAINER.validate_provenance([row()], provenance())

    def test_changed_target_is_refused(self):
        with self.assertRaisesRegex(ValueError, "does not match its target"):
            TRAINER.validate_provenance([row()], provenance(label="pass", text="different source text"))

    def test_missing_source_identity_fields_are_refused(self):
        with self.assertRaisesRegex(ValueError, "source family"):
            TRAINER.validate_provenance([row()], provenance(label="pass", family="  "))


class InSampleFitDiagnosticTests(unittest.TestCase):
    def test_confusion_and_mean_cross_entropy_retain_every_training_row(self):
        specs = [
            {"id": "positive-a", "family": "positive", "gold": "pass", "option_names": ["pass", "fail"]},
            {"id": "negative-a", "family": "negative", "gold": "fail", "option_names": ["pass", "fail"]},
            {"id": "negative-b", "family": "negative", "gold": "fail", "option_names": ["pass", "fail"]},
        ]
        summary = TRAINER.summarize_fit_diagnostics(specs, [[3.0, 0.0], [2.0, 0.0], [0.0, 2.0]])

        self.assertEqual(summary["rows"], 3)
        self.assertEqual(summary["correct"], 2)
        self.assertEqual(summary["confusion"]["pass"], {"pass": 1, "fail": 0})
        self.assertEqual(summary["confusion"]["fail"], {"pass": 1, "fail": 1})
        self.assertEqual(summary["per_class"]["pass"], {"count": 1, "correct": 1, "accuracy": 1.0})
        self.assertEqual(summary["per_class"]["fail"], {"count": 2, "correct": 1, "accuracy": 0.5})
        self.assertEqual([item["id"] for item in summary["items"]], ["positive-a", "negative-a", "negative-b"])
        self.assertAlmostEqual(summary["mean_cross_entropy"], sum(item["mean_cross_entropy"] for item in summary["items"]) / 3)
        self.assertEqual(summary["items"][1]["logits"], {"pass": 2.0, "fail": 0.0})

    def test_fit_diagnostic_rejects_missing_or_nonfinite_logits(self):
        specs = [{"id": "one", "gold": "pass", "option_names": ["pass", "fail"]}]
        with self.assertRaisesRegex(ValueError, "every training row"):
            TRAINER.summarize_fit_diagnostics(specs, [])
        with self.assertRaisesRegex(ValueError, "must be finite"):
            TRAINER.summarize_fit_diagnostics(specs, [[float("nan"), 0.0]])


class FrozenSourceInputBindingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not WORDING16_DATA.is_file() or not WORDING16_PROVENANCE.is_file():
            raise unittest.SkipTest("the private wording-connections-v1 DATA is unavailable")
        cls.provenance = read_provenance(WORDING16_PROVENANCE)
        cls.raw_rows = [json.loads(line) for line in WORDING16_DATA.read_text(encoding="utf-8").splitlines() if line.strip()]

    def validate_rows(self, rows, provenance=None):
        provenance = provenance or self.provenance
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "training.jsonl"
            path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n", encoding="utf-8")
            parsed = TRAINER.load_rows(path)
            provenance_rows = TRAINER.validate_provenance(parsed, provenance)
            return TRAINER.validate_source_dataset(provenance, provenance_rows, parsed)

    def request_plan_projection(self, provenance):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node is required to read the maintained requestPlan projection")
        module = (TRAINER_PATH.parent.parent / "read-data" / "evaluation-integrity.mjs").as_uri()
        source = r'''import fs from "node:fs";
import { requestPlan, TYPED_REQUEST_POLICY } from "MODULE_URI";
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const criterionId = process.argv[2];
const out = Object.fromEntries(data.items.map(item => {
  const plan = requestPlan(data, item);
  return [item.id, {state: JSON.parse(plan.content), question: plan.asking[criterionId]?.question}];
}));
process.stdout.write(JSON.stringify({policy: TYPED_REQUEST_POLICY, projections: out}));'''.replace("MODULE_URI", module)
        result = subprocess.run([node, "--input-type=module", "-e", source,
                                 provenance["source_dataset"], provenance["criterion_id"]],
                                check=True, capture_output=True, text=True)
        contract = json.loads(result.stdout)
        self.assertEqual(contract["policy"], STRICT_REQUEST_POLICY)
        return contract["projections"]

    def strict_request_rows(self, rows, provenance):
        projection = self.request_plan_projection(provenance)
        for row, source in zip(rows, provenance["rows"]):
            row["state"] = projection[source["id"]]["state"]
            row["question"] = projection[source["id"]]["question"]
        strict_provenance = copy.deepcopy(provenance)
        strict_provenance["request_projection_policy"] = STRICT_REQUEST_POLICY
        return strict_provenance

    def test_current_wording16_rows_match_frozen_v3_projection(self):
        self.assertEqual(len(self.raw_rows), 16)
        identity = self.validate_rows(self.raw_rows)
        self.assertEqual(identity["criterion_id"], "wording-and-connections")

    def test_eval_source_item_cannot_be_bound_as_training_even_with_magic_role(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = json.loads(Path(self.provenance["source_dataset"]).read_text(encoding="utf-8"))
            source["dataset_role"] = "intentional training supervision, not heldout"
            source["items"][0]["split"] = "eval"
            source_path = root / "source.json"
            source_path.write_text(json.dumps(source), encoding="utf-8")
            provenance = copy.deepcopy(self.provenance)
            provenance["source_dataset"] = str(source_path)
            provenance["source_dataset_blake3"] = TRAINER.digest(source_path)
            with self.assertRaisesRegex(ValueError, "selected source split"):
                self.validate_rows(self.raw_rows, provenance)

    def test_source_family_cannot_cross_train_and_eval_splits(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = json.loads(Path(self.provenance["source_dataset"]).read_text(encoding="utf-8"))
            source["items"].append(dict(source["items"][0], id="family-leak", split="eval"))
            source_path = root / "source.json"
            source_path.write_text(json.dumps(source), encoding="utf-8")
            provenance = copy.deepcopy(self.provenance)
            provenance["source_dataset"] = str(source_path)
            provenance["source_dataset_blake3"] = TRAINER.digest(source_path)
            with self.assertRaisesRegex(ValueError, "family .* crosses split boundaries"):
                self.validate_rows(self.raw_rows, provenance)

    def test_current_voice_range26_rows_match_frozen_v3_projection(self):
        if not VOICE_RANGE16_DATA.is_file() or not VOICE_RANGE16_PROVENANCE.is_file():
            self.skipTest("the private voice-range v2 DATA is unavailable")
        provenance = read_provenance(VOICE_RANGE16_PROVENANCE)
        rows = [json.loads(line) for line in VOICE_RANGE16_DATA.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertEqual(len(rows), 26)
        identity = self.validate_rows(rows, provenance)
        self.assertEqual(identity["criterion_id"], "wording-and-connections")

    def test_strict_projection_accepts_actual_request_plan_and_requires_routing_hint(self):
        provenance = read_provenance(VOICE_RANGE16_PROVENANCE)
        rows = copy.deepcopy([json.loads(line) for line in VOICE_RANGE16_DATA.read_text(encoding="utf-8").splitlines() if line.strip()])
        strict = self.strict_request_rows(rows, provenance)
        identity = self.validate_rows(rows, strict)
        self.assertEqual(identity["criterion_id"], "wording-and-connections")

        omitted_hint = copy.deepcopy(rows)
        source = json.loads(Path(provenance["source_dataset"]).read_text(encoding="utf-8"))
        criterion = next(one for one in source["criteria"] if one["id"] == provenance["criterion_id"])
        omitted_hint[0]["question"] = criterion["question"]
        with self.assertRaisesRegex(ValueError, "question or ordered options"):
            self.validate_rows(omitted_hint, strict)

    def test_unknown_request_projection_policy_is_refused(self):
        for value in ("unrecognized-projection", None):
            with self.subTest(value=value):
                provenance = copy.deepcopy(self.provenance)
                provenance["request_projection_policy"] = value
                with self.assertRaisesRegex(ValueError, "Unsupported training request_projection_policy"):
                    self.validate_rows(self.raw_rows, provenance)

    def test_strict_projection_matches_keyed_request_plan_reference_routing(self):
        if not shutil.which("node"):
            self.skipTest("Node is required to read the maintained requestPlan projection")
        criterion = {
            "id": "spoken-style", "primitive": "one-of", "question": "Which voice fits?",
            "options": [{"name": "pass", "description": "Fits."}, {"name": "fail", "description": "Does not fit."}],
            "reference_context": "reference A", "applies_to": ["paragraph"],
        }
        other = {
            "id": "specificity", "primitive": "one-of", "question": "Is it specific?",
            "options": [{"name": "pass", "description": "Specific."}, {"name": "fail", "description": "Vague."}],
            "reference_context": "reference B", "applies_to": ["paragraph"],
        }
        item = {"id": "sample", "family": "family-a", "split": "train", "text": "Target text.",
                "block_kind": "paragraph", "reader_context": "Previous text.", "checks": {"spoken-style": "pass"}}
        source_data = {"schema": "book-voice-decider-challenge-v3", "dataset_role": "training examples",
                       "criteria": [criterion, other], "items": [item]}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_path = root / "DATA.json"
            source_path.write_text(json.dumps(source_data), encoding="utf-8")
            provenance = {
                "schema": "book-voice-training-provenance-v2", "source_dataset": str(source_path),
                "source_dataset_blake3": TRAINER.digest(source_path), "criterion_id": criterion["id"],
                "request_projection_policy": STRICT_REQUEST_POLICY,
                "rows": [{"id": item["id"], "family": item["family"], "text": item["text"], "label": "pass"}],
            }
            projection = self.request_plan_projection(provenance)[item["id"]]
            self.assertEqual(projection["question"], "Which voice fits? Use reference_text.spoken-style.")
            row = {"schema": TRAINER.ROW_SCHEMA, "split": "train", "state": projection["state"],
                   "question": projection["question"], "options": {o["name"]: o["description"] for o in criterion["options"]},
                   "gold": "pass"}
            row_path = root / "train.jsonl"
            row_path.write_text(json.dumps(row) + "\n", encoding="utf-8")
            parsed = TRAINER.load_rows(row_path)
            source_rows = TRAINER.validate_provenance(parsed, provenance)
            self.assertEqual(TRAINER.validate_source_dataset(provenance, source_rows, parsed)["criterion_id"], criterion["id"])

    def test_changed_reference_text_is_refused_with_same_target_id_and_gold(self):
        changed = copy.deepcopy(self.raw_rows)
        changed[0]["state"]["reference_text"] += " altered"
        with self.assertRaisesRegex(ValueError, "state does not match"):
            self.validate_rows(changed)

    def test_changed_reader_context_is_refused_with_same_target_id_and_gold(self):
        changed = copy.deepcopy(self.raw_rows)
        changed[0]["state"]["reader_context"] += " altered"
        with self.assertRaisesRegex(ValueError, "state does not match"):
            self.validate_rows(changed)

    def test_changed_question_is_refused_with_same_target_id_and_gold(self):
        changed = copy.deepcopy(self.raw_rows)
        changed[0]["question"] = "Different question?"
        with self.assertRaisesRegex(ValueError, "question or ordered options"):
            self.validate_rows(changed)

    def test_changed_option_description_is_refused_with_same_target_id_and_gold(self):
        changed = copy.deepcopy(self.raw_rows)
        changed[0]["options"]["pass"] += " altered"
        with self.assertRaisesRegex(ValueError, "question or ordered options"):
            self.validate_rows(changed)

    def test_changed_option_order_is_refused_with_same_target_id_and_gold(self):
        changed = copy.deepcopy(self.raw_rows)
        changed[0]["options"] = dict(reversed(list(changed[0]["options"].items())))
        with self.assertRaisesRegex(ValueError, "question or ordered options"):
            self.validate_rows(changed)


class MultiCriterionRequestPlanBindingTests(unittest.TestCase):
    """Exact maintained requestPlan bindings for mixed one-of criteria."""

    def make_bundle(self, root):
        if not shutil.which("node") or not shutil.which("b3sum"):
            self.skipTest("Node and b3sum are required for maintained requestPlan fixtures")
        source = {
            "schema": "book-voice-decider-challenge-v3",
            "dataset_role": "author-selected training examples",
            "criteria": [
                {"id": "heading-voice", "primitive": "one-of", "question": "Does the heading fit the author's voice?",
                 "reference_context": "Heading voice reference A.", "applies_to": ["heading"],
                 "options": [{"name": "pass", "description": "The heading fits."},
                             {"name": "fail", "description": "The heading misses."}]},
                {"id": "heading-order", "primitive": "one-of", "question": "Does the heading explain why this order is used?",
                 "reference_context": "Heading order reference B.", "applies_to": ["heading"],
                 "options": [{"name": "pass", "description": "The rationale is clear."},
                             {"name": "fail", "description": "The rationale is absent."}]},
                {"id": "table-coverage", "primitive": "one-of", "question": "Does the table cover its intended fields?",
                 "reference_context": "Table reference C.", "applies_to": ["table"],
                 "options": [{"name": "complete", "description": "Every required field is present."},
                             {"name": "partial", "description": "Some required fields are absent."},
                             {"name": "empty", "description": "The required fields are absent."}]},
            ],
            "items": [
                # This heading is invented for the projection fixture.
                {"id": "why-this-order", "family": "heading-pair", "split": "train",
                 "origin": {"kind": "root-adjudicated-heading"}, "text": "## Moss On Saturn",
                 "block_kind": "heading", "reader_context": "",
                 "checks": {"heading-voice": "pass", "heading-order": "pass"}},
                {"id": "three-column-table", "family": "table-pair", "split": "train",
                 "origin": {"kind": "root-adjudicated-table"},
                 "text": "| Field | Reason |\n| --- | --- |\n| Body | Keeps a person alive. |",
                 "block_kind": "table", "reader_context": "",
                 "checks": {"table-coverage": "complete"}},
            ],
        }
        source_path = root / "DATA.json"
        source_path.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
        bindings = [
            {"source_item_id": "why-this-order", "criterion_id": "heading-voice"},
            {"source_item_id": "why-this-order", "criterion_id": "heading-order"},
            {"source_item_id": "three-column-table", "criterion_id": "table-coverage"},
        ]
        projections = TRAINER.project_multi_criterion_requests(source, [
            {**row, "training_row_id": f"training-{index}"} for index, row in enumerate(bindings, 1)
        ])
        source_items = {item["id"]: item for item in source["items"]}
        rows, bindings_out = [], []
        for index, (binding, projection) in enumerate(zip(bindings, projections), 1):
            item = source_items[binding["source_item_id"]]
            request = projection["request"]
            ordered = request["shape"]["options"]
            gold = item["checks"][binding["criterion_id"]]
            state = json.loads(projection["content"])
            training_id = f"training-{index}"
            rows.append({"schema": TRAINER.MULTI_CRITERION_ROW_SCHEMA, "split": "train",
                         "training_row_id": training_id, "state": state,
                         "question": request["question"],
                         "options": {option["name"]: option["description"] for option in ordered},
                         "gold": gold})
            bindings_out.append({"training_row_id": training_id, "source_item_id": item["id"],
                                 "criterion_id": binding["criterion_id"], "family": item["family"],
                                 "text": item["text"], "state": state,
                                 "question": request["question"], "options": ordered, "gold_check": gold})
        provenance = {"schema": TRAINER.MULTI_CRITERION_PROVENANCE_SCHEMA,
                      "source_dataset": str(source_path),
                      "source_dataset_blake3": TRAINER.digest(source_path),
                      "request_projection_policy": TRAINER.MULTI_CRITERION_REQUEST_PROJECTION_POLICY,
                      "rows": bindings_out}
        return {"root": root, "source": source, "source_path": source_path,
                "data_rows": rows, "provenance": provenance}

    def validate_bundle(self, bundle):
        data_path = bundle["root"] / "train.jsonl"
        data_path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in bundle["data_rows"]) + "\n",
                             encoding="utf-8")
        rows = TRAINER.load_rows(data_path)
        provenance_rows = TRAINER.validate_provenance(rows, bundle["provenance"])
        return TRAINER.validate_source_dataset(bundle["provenance"], provenance_rows, rows)

    def test_actual_requestplan_projection_handles_two_heading_references_and_three_table_options(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = self.make_bundle(Path(temporary))
            identity = self.validate_bundle(bundle)
            self.assertEqual(identity["criterion_ids"], ["heading-order", "heading-voice", "table-coverage"])
            self.assertEqual(identity["training_row_ids"], ["training-1", "training-2", "training-3"])
            self.assertEqual(bundle["data_rows"][0]["state"]["reference_text"], {
                "heading-voice": "Heading voice reference A.",
                "heading-order": "Heading order reference B.",
            })
            self.assertTrue(bundle["data_rows"][0]["question"].endswith("Use reference_text.heading-voice."))
            self.assertTrue(bundle["data_rows"][1]["question"].endswith("Use reference_text.heading-order."))
            self.assertEqual(list(bundle["data_rows"][2]["options"]), ["complete", "partial", "empty"])

    def test_old_eval_as_train_with_magic_role_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = self.make_bundle(Path(temporary))
            bundle["source"]["dataset_role"] = "intentional training supervision, not heldout"
            for item in bundle["source"]["items"]:
                item["split"] = "eval"
            bundle["source_path"].write_text(json.dumps(bundle["source"], ensure_ascii=False), encoding="utf-8")
            bundle["provenance"]["source_dataset_blake3"] = TRAINER.digest(bundle["source_path"])
            with self.assertRaisesRegex(ValueError, "no explicitly designated train items"):
                self.validate_bundle(bundle)

    def test_family_cannot_cross_source_splits_even_when_bound_row_is_train(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = self.make_bundle(Path(temporary))
            bundle["source"]["items"].append(dict(bundle["source"]["items"][0],
                id="same-family-heldout", split="eval"))
            bundle["source_path"].write_text(json.dumps(bundle["source"], ensure_ascii=False), encoding="utf-8")
            bundle["provenance"]["source_dataset_blake3"] = TRAINER.digest(bundle["source_path"])
            with self.assertRaisesRegex(ValueError, "family .* crosses split boundaries"):
                self.validate_bundle(bundle)

    def test_missing_and_duplicate_bindings_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = self.make_bundle(Path(temporary))
            bundle["provenance"]["rows"].pop()
            with self.assertRaisesRegex(ValueError, "bind every DATA row"):
                self.validate_bundle(bundle)
        with tempfile.TemporaryDirectory() as temporary:
            bundle = self.make_bundle(Path(temporary))
            duplicate = copy.deepcopy(bundle["provenance"]["rows"][0])
            duplicate["training_row_id"] = "training-duplicate"
            bundle["data_rows"][1] = {**bundle["data_rows"][1], "training_row_id": "training-duplicate",
                                      "state": duplicate["state"], "question": duplicate["question"],
                                      "options": {o["name"]: o["description"] for o in duplicate["options"]},
                                      "gold": duplicate["gold_check"]}
            bundle["provenance"]["rows"][1] = duplicate
            with self.assertRaisesRegex(ValueError, "Duplicate source item/criterion binding"):
                self.validate_bundle(bundle)

    def test_nonapplicable_and_missing_source_checks_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = self.make_bundle(Path(temporary))
            bundle["provenance"]["rows"][2]["criterion_id"] = "heading-order"
            with self.assertRaisesRegex(ValueError, "nonapplicable criterion"):
                self.validate_bundle(bundle)
        with tempfile.TemporaryDirectory() as temporary:
            bundle = self.make_bundle(Path(temporary))
            bundle["source"]["items"][0]["checks"].pop("heading-voice")
            bundle["source_path"].write_text(json.dumps(bundle["source"], ensure_ascii=False), encoding="utf-8")
            bundle["provenance"]["source_dataset_blake3"] = TRAINER.digest(bundle["source_path"])
            with self.assertRaisesRegex(ValueError, "no source gold check"):
                self.validate_bundle(bundle)

    def test_malformed_source_shape_and_block_kinds_are_refused_cleanly(self):
        mutations = [
            (lambda source: source.update(criteria=[{**source["criteria"][0], "applies_to": [["heading"]]}]),
             "valid applies_to block kinds"),
            (lambda source: source["items"][0].update(block_kind=["heading"]),
             "source item is incomplete"),
            (lambda source: source["items"][0]["checks"].update({"heading-voice": []}),
             "checks must use string criterion ids and labels"),
        ]
        for mutate, expected_error in mutations:
            with self.subTest(expected_error=expected_error), tempfile.TemporaryDirectory() as temporary:
                bundle = self.make_bundle(Path(temporary))
                mutate(bundle["source"])
                bundle["source_path"].write_text(json.dumps(bundle["source"], ensure_ascii=False), encoding="utf-8")
                bundle["provenance"]["source_dataset_blake3"] = TRAINER.digest(bundle["source_path"])
                with self.assertRaisesRegex(ValueError, expected_error):
                    self.validate_bundle(bundle)

    def test_safe_source_snapshot_accepts_regular_files_and_refuses_fifos(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            regular = root / "DATA.json"
            regular.write_bytes(b'{"schema":"book-voice-decider-challenge-v3"}')
            self.assertEqual(TRAINER.read_stable_source_bytes(regular), regular.read_bytes())
            fifo = root / "DATA.fifo"
            os.mkfifo(fifo)
            with self.assertRaisesRegex(ValueError, "regular file"):
                TRAINER.read_stable_source_bytes(fifo)

    def test_replacing_source_file_during_projection_uses_the_captured_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = self.make_bundle(Path(temporary))
            original_hash = bundle["provenance"]["source_dataset_blake3"]
            original_project = TRAINER.project_multi_criterion_requests

            def replace_source_then_project(source_snapshot, provenance_rows, *, mode="training"):
                changed = copy.deepcopy(bundle["source"])
                changed["criteria"][0]["question"] = "Replaced after the hash snapshot."
                bundle["source_path"].write_text(json.dumps(changed, ensure_ascii=False), encoding="utf-8")
                return original_project(source_snapshot, provenance_rows, mode=mode)

            with mock.patch.object(TRAINER, "project_multi_criterion_requests", side_effect=replace_source_then_project):
                identity = self.validate_bundle(bundle)
            self.assertEqual(identity["blake3"], original_hash)
            self.assertNotEqual(TRAINER.digest(bundle["source_path"]), original_hash)

    def test_source_dataset_root_must_be_an_object(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = self.make_bundle(Path(temporary))
            bundle["source_path"].write_text("[]", encoding="utf-8")
            bundle["provenance"]["source_dataset_blake3"] = TRAINER.digest(bundle["source_path"])
            with self.assertRaisesRegex(ValueError, "not maintained schema-v3 DATA"):
                self.validate_bundle(bundle)

    def test_forged_reference_and_option_order_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = self.make_bundle(Path(temporary))
            forged = copy.deepcopy(bundle["data_rows"][0]["state"])
            forged["reference_text"]["heading-order"] = "Caller supplied forged reference."
            bundle["data_rows"][0]["state"] = forged
            bundle["provenance"]["rows"][0]["state"] = copy.deepcopy(forged)
            with self.assertRaisesRegex(ValueError, "does not match maintained requestPlan projection"):
                self.validate_bundle(bundle)
        with tempfile.TemporaryDirectory() as temporary:
            bundle = self.make_bundle(Path(temporary))
            row = bundle["data_rows"][2]
            row["options"] = dict(reversed(list(row["options"].items())))
            bundle["provenance"]["rows"][2]["options"] = list(
                reversed(bundle["provenance"]["rows"][2]["options"]))
            with self.assertRaisesRegex(ValueError, "does not match maintained requestPlan projection"):
                self.validate_bundle(bundle)


if __name__ == "__main__":
    unittest.main()
