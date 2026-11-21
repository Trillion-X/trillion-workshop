"""Actual CLI consumer tests for the person's manuscript writing settings.

Moved from source-repo-a tools/private-book-reader/test_writing_gate.py. The writing settings are one settings
row's object (record:setting:export-documents-to-files~piece~<book-id>) instead of a .writing-policy.json beside the
manuscript; the book's checks branch receipt is handed in; the book-voice classifier is a stand-in
(voice-classifier-stand-in.mjs). Everything here is made up.
"""
import json
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from docx import Document

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "do-work"))
import export_markdown_book_to_word as builder  # noqa: E402
import writing_gate  # noqa: E402
from writing_gate import _reader_contexts, _validate_section_chunk_qualification, _writing_blocks, enforce_writing_policy  # noqa: E402

STAND_IN = HERE / "voice-classifier-stand-in.mjs"
BRANCH = "made-up-book-branch"


def digest(data):
    raw = data.encode("utf-8") if isinstance(data, str) else data
    return writing_gate._snapshot_hash(raw)


def fixture_confidence(probabilities):
    values = list(probabilities.values())
    if len(values) < 2:
        return 1.0
    peak = max(values)
    return round(min(1.0, max(0.0, (len(values) * peak - 1) / (len(values) - 1))), 4)


class WritingGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        voice = patch.object(writing_gate, "VOICE_CLASSIFIER", STAND_IN)
        voice.start()
        self.addCleanup(voice.stop)
        self.source = self.root / "current.md"
        self.source.write_text("# Fixture\n\nA clear passage.\n")
        self.template = self.root / "template.docx"
        Document().save(self.template)
        self.output = self.root / "result.docx"
        self.profile = {"schema": "writing-profile-v1", "document_role": "current_prose", "rejections": [{"id": "r", "text": "Known rejected phrase", "authority": "author_confirmed"}], "protected_literals": [], "superseded_terms": [], "required_components": []}
        (self.root / "profile.json").write_text(json.dumps(self.profile))
        self.settings = {"source_blake3": digest(self.source.read_text()), "role": "current_prose", "profile": "profile.json",
                         "evidence_folder": str(self.root), "checks_branch": BRANCH}
        self.save_policy()

    def tearDown(self):
        self.temp.cleanup()

    def test_section_chunk_qualification_checks_later_gold_and_confident_uncertain(self):
        manifest = {"chunks": [{"chunk_index": 0, "gold": "pass"},
                               {"chunk_index": 1, "gold": "fail"}]}
        decision = {"section_chunk_aggregate": {"label": "fail", "chunk_results": [
            {"chunk_index": 0, "gold": "pass", "predicted": "pass", "decision": "pass",
             "probabilities": {"pass": 0.9, "fail": 0.05, "uncertain": 0.05}},
            {"chunk_index": 1, "gold": "fail", "predicted": "fail", "decision": "fail",
             "probabilities": {"pass": 0.05, "fail": 0.9, "uncertain": 0.05}},
        ]}}
        _validate_section_chunk_qualification(decision, manifest, ["pass", "fail", "uncertain"], 0.5)
        wrong_later = json.loads(json.dumps(decision))
        wrong_later["section_chunk_aggregate"]["chunk_results"][1]["predicted"] = "pass"
        wrong_later["section_chunk_aggregate"]["chunk_results"][1]["decision"] = "pass"
        with self.assertRaisesRegex(ValueError, "policy-labelled section chunk"):
            _validate_section_chunk_qualification(wrong_later, manifest, ["pass", "fail", "uncertain"], 0.5)

        uncertain_manifest = {"chunks": [{"chunk_index": 0, "gold": "uncertain"}]}
        confident_uncertain = {"section_chunk_aggregate": {"label": "uncertain", "chunk_results": [
            {"chunk_index": 0, "gold": "uncertain", "predicted": "uncertain", "decision": "uncertain",
             "probabilities": {"pass": 0.1, "fail": 0.1, "uncertain": 0.8}},
        ]}}
        _validate_section_chunk_qualification(confident_uncertain, uncertain_manifest,
                                              ["pass", "fail", "uncertain"], 0.5)
        low_confidence = json.loads(json.dumps(confident_uncertain))
        low_confidence["section_chunk_aggregate"]["chunk_results"][0]["probabilities"]["uncertain"] = 0.5
        low_confidence["section_chunk_aggregate"]["chunk_results"][0]["probabilities"]["pass"] = 0.25
        low_confidence["section_chunk_aggregate"]["chunk_results"][0]["probabilities"]["fail"] = 0.25
        with self.assertRaisesRegex(ValueError, "uncertain section chunk"):
            _validate_section_chunk_qualification(low_confidence, uncertain_manifest,
                                                  ["pass", "fail", "uncertain"], 0.5)

    def save_policy(self):
        (self.root / "settings.json").write_text(json.dumps(self.settings))

    def receipt(self, source=None, status="passed"):
        """What export-a-book.mjs hands in after the branch mode judged these bytes."""
        return {"branch": BRANCH, "lineage": [BRANCH, "made-up-writing"], "status": status, "passed": status == "passed",
                "document_blake3": digest((source or self.source).read_bytes())}

    def enforce(self, source=None, settings=None, receipt=None):
        return enforce_writing_policy(source or self.source, settings=self.settings if settings is None else settings,
                                      checks_receipt=receipt or self.receipt(source))

    def admit_reviews(self):
        text = self.source.read_text()
        blocks = text.strip().split("\n\n")
        reviews = {"schema": "writing-review-v1", "document_blake3": digest(text), "blocks": [{"block_index": i, "block_blake3": digest(value), "reviewer_role": "model", "reviewer": "fixture", "reason": "Synthetic current-byte review.", "decision": "retain"} for i, value in enumerate(blocks)], "components": []}
        (self.root / "reviews.json").write_text(json.dumps(reviews))
        self.settings["reviews"] = "reviews.json"
        self.save_policy()

    def evaluation_report(self, data, data_path, model, serving, predictions):
        typed = data.get("schema") == "book-voice-decider-challenge-v3"
        plans = None
        if typed:
            plans = json.loads(subprocess.check_output(
                ["node", str(STAND_IN), "plans"], input=json.dumps(data), text=True))
        report_items = []
        for item in data["items"]:
            item_checks = item.get("checks", {})
            checks = {}
            asking = {}
            for criterion in data["criteria"]:
                criterion_id = criterion["id"]
                if criterion.get("deterministic", False):
                    continue
                if typed and criterion.get("applies_to") is not None and item["block_kind"] not in criterion["applies_to"]:
                    continue
                if not typed and item_checks and criterion_id not in item_checks:
                    continue
                answer = predictions[item["id"]][criterion_id]
                other_probability = 0.2 / max(1, len(criterion["options"]) - 1)
                probabilities = {option: (0.8 if option == answer else other_probability)
                                 for option in criterion["options"]}
                threshold = criterion.get("diagnostic_min_probability", 0.5)
                decision = answer if probabilities[answer] >= threshold else "uncertain"
                confidence = fixture_confidence(probabilities)
                raw_answer = {"choice": answer, "confidence": confidence, "probabilities": probabilities}
                asking[criterion_id] = (plans["items"][item["id"]]["asking"][criterion_id] if typed else
                                       {"question": criterion["question"],
                                        "shape": {"kind": "one-of", "options": criterion["options"]}})
                checks[criterion_id] = {
                    "gold": item_checks.get(criterion_id), "method": "Decider2B shared endpoint",
                    "decision": decision, "predicted": answer, "raw_answer": answer,
                    "primitive": "choice", "diagnostic_min_probability": threshold,
                    "confidence": confidence, "probabilities": probabilities,
                    "criterion_context_used": bool(criterion.get("reference_context")) if typed else False,
                    "elapsed_ms": 1.0,
                }
            state = plans["items"][item["id"]]["content"] if typed else f"Passage: {item['text']}"
            request = {"state": state, "model": model, "questions": {
                criterion_id: {"type": "choice", "instructions": value["question"],
                               "criteria": {option: None for option in value["shape"]["options"]}}
                for criterion_id, value in asking.items()}}
            response_answers = {criterion_id: {
                "choice": predictions[item["id"]][criterion_id],
                "confidence": fixture_confidence({option: (0.8 if option == predictions[item["id"]][criterion_id]
                                                              else 0.2 / max(1, len(value["shape"]["options"]) - 1))
                                                   for option in value["shape"]["options"]}),
                "probabilities": {option: (0.8 if option == predictions[item["id"]][criterion_id]
                                             else 0.2 / max(1, len(value["shape"]["options"]) - 1))
                                  for option in value["shape"]["options"]}}
                for criterion_id, value in asking.items()}
            report_items.append({
                "id": item["id"], "family": item["family"], "origin": item["origin"],
                **({"block_kind": item["block_kind"]} if typed else {}),
                "axes": item.get("axis"), "gold_checks": item_checks,
                "serving_identity_policy": "observed-health-and-response-v1",
                "request_evidence": {
                    "adapter_input": {"content": state, "asking": asking},
                    "exchanges": [{"url": "http://127.0.0.1:8099/v1/systemone", "status": 200,
                                   "request": json.dumps(request),
                                   "response": json.dumps({"model": model, "served_identity": serving,
                                                            "answers": response_answers})}],
                },
                "checks": checks,
            })
        criteria = data["criteria"]
        eval_count = sum(item.get("split") == "eval" for item in data["items"])
        return {
            "schema": "book-voice-decider-evaluation-v2", "model": model,
            "endpoint": "http://127.0.0.1:8099/v1/systemone",
            "route": "shared local classifier adapter -> /v1/systemone",
            "request_policy": plans["policy"] if typed else "neutral-passage-and-criterion-context-v1",
            "request_evidence_version": 1,
            "serving_identity_policy": "observed-health-and-response-v1", "serving": serving,
            "data": str(data_path.resolve()), "data_blake3": digest(data_path.read_bytes()),
            "complete": True, "errors": [], "expected_items": eval_count,
            "evaluated_items": len(report_items),
            "criteria": plans["criteria"] if typed else [{"id": criterion["id"], "question": criterion["question"],
                          "deterministic": bool(criterion.get("deterministic", False))}
                         for criterion in criteria],
            "question": None, "rubric_blake3": None, "dataset_role": data.get("dataset_role"),
            "source_derivative": data.get("source_derivative"),
            "assembled_docx": data.get("assembled_docx"), "split": "eval",
            "request_limits": {"samples": 1, "attempts": 1, "workers": 1},
            "items": report_items, "prior_errors": [],
            "serving_identity_assurance": "observed-health-and-response",
        }

    def admit_decider(self, choice="pass", model="fixture-classifier", qualification_predictions=None):
        text = self.source.read_text()
        blocks = text.strip().split("\n\n")
        criteria = [{"id": "voice", "primitive": "one-of", "question": "Does this paragraph pass?",
                     "options": ["pass", "fail", "uncertain"]}]
        current_data = {"schema": "book-voice-decider-challenge-v2", "document_blake3": digest(text),
                        "criteria": criteria,
                        "items": [{"id": f"p{i}", "family": f"current-{i}", "split": "eval", "text": block,
                                   "role": "authored", "origin": {"kind": "synthetic"}, "axis": None}
                                  for i, block in enumerate(blocks)]}
        current_data_path = self.root / "decider-data.json"
        current_data_path.write_text(json.dumps(current_data))
        serving = "blake3:fixture-serving-identity"
        current_predictions = {item["id"]: {"voice": choice} for item in current_data["items"]}
        current_report = self.evaluation_report(current_data, current_data_path, model, serving, current_predictions)
        current_report_path = self.root / "decider-report.json"
        current_report_path.write_text(json.dumps(current_report))
        self.settings.update({
            "decider_evidence": {"data": current_data_path.name, "report": current_report_path.name},
            "decider_requirements": {"model": model, "criteria": criteria},
        })
        self.save_policy()
        self.admit_qualification(model, serving, criteria, qualification_predictions)

    def admit_qualification(self, model, serving, criteria, predictions=None):
        data = {
            "schema": "book-voice-decider-challenge-v2", "dataset_role": "voice-qualification",
            "criteria": criteria,
            "items": [
                {"id": "benchmark-positive", "family": "benchmark-positive", "split": "eval",
                 "text": "A known positive example.", "role": "authored", "origin": {"kind": "synthetic"},
                 "axis": None, "checks": {criteria[0]["id"]: "pass"}},
                {"id": "benchmark-negative", "family": "benchmark-negative", "split": "eval",
                 "text": "A known negative example.", "role": "authored", "origin": {"kind": "synthetic"},
                 "axis": None, "checks": {criteria[0]["id"]: "fail"}},
            ],
        }
        data_path = self.root / "qualification-data.json"
        data_path.write_text(json.dumps(data))
        predictions = predictions or {
            "benchmark-positive": {criteria[0]["id"]: "pass"},
            "benchmark-negative": {criteria[0]["id"]: "fail"},
        }
        report = self.evaluation_report(data, data_path, model, serving, predictions)
        report_path = self.root / "qualification-report.json"
        report_path.write_text(json.dumps(report))
        self.settings["decider_qualification"] = {
            "data": data_path.name, "report": report_path.name,
            "data_blake3": digest(data_path.read_bytes()), "report_blake3": digest(report_path.read_bytes()),
            "required_labels": ["pass", "fail"],
        }
        self.save_policy()

    def admit_typed_decider(self):
        criteria = [
            {"id": "voice", "primitive": "one-of", "question": "Does the target use clear wording?",
             "options": ["pass", "fail", "uncertain"], "reference_context": "Use clear everyday words.",
             "applies_to": ["paragraph", "quote", "list", "mixed"]},
            {"id": "title", "primitive": "one-of", "question": "Does the target identify its subject?",
             "options": ["pass", "fail", "uncertain"], "reference_context": "Headings name their subject.",
             "applies_to": ["heading", "table"]},
        ]
        blocks = self.source.read_text().strip().split("\n\n")
        current = {"schema": "book-voice-decider-challenge-v3", "document_blake3": digest(self.source.read_bytes()),
                   "criteria": criteria, "items": [
                       {"id": f"p{i}", "family": f"current-{i}", "split": "eval", "text": block,
                        "role": "authored", "origin": {"kind": "synthetic"},
                        "block_kind": "heading" if re.fullmatch(r"#{1,6}\s+\S.*", block.strip()) else "paragraph",
                        "reader_context": "\n\n".join(blocks[max(0, i - 2):i])}
                       for i, block in enumerate(blocks)]}
        qualification = {"schema": current["schema"], "criteria": criteria, "dataset_role": "qualification-fixture",
                         "items": [
                             {"id": ident, "family": ident, "split": "eval", "text": text,
                              "block_kind": kind, "reader_context": "", "role": "authored",
                              "origin": {"kind": "synthetic"}, "checks": {criterion: answer}}
                             for ident, text, kind, criterion, answer in [
                                 ("prose-positive", "A concrete explanation.", "paragraph", "voice", "pass"),
                                 ("prose-negative", "An unclear explanation.", "paragraph", "voice", "fail"),
                                 ("heading-positive", "## Subject", "heading", "title", "pass"),
                                 ("heading-negative", "## Elsewhere", "heading", "title", "fail")]]}
        for prefix, data in [("decider", current), ("qualification", qualification)]:
            (self.root / f"{prefix}-data.json").write_text(json.dumps(data))
            self.rebuild_typed_capture(prefix)
        self.settings.update({
            "decider_evidence": {"data": "decider-data.json", "report": "decider-report.json"},
            "decider_requirements": {"model": "fixture-classifier", "criteria": criteria, "reader_context_blocks": 2},
            "decider_qualification": {"data": "qualification-data.json", "report": "qualification-report.json",
                                      "data_blake3": digest((self.root / "qualification-data.json").read_bytes()),
                                      "report_blake3": digest((self.root / "qualification-report.json").read_bytes()),
                                      "required_labels": ["pass", "fail"]}})
        self.save_policy()

    def rebuild_typed_capture(self, prefix, predictions=None):
        path = self.root / f"{prefix}-data.json"
        data = json.loads(path.read_text())
        predictions = predictions or {item["id"]: {
            criterion["id"]: item.get("checks", {}).get(criterion["id"], "pass")
            for criterion in data["criteria"]
            if item["block_kind"] in criterion["applies_to"]}
            for item in data["items"]}
        report = self.evaluation_report(data, path, "fixture-classifier", "blake3:fixture-serving-identity", predictions)
        (self.root / f"{prefix}-report.json").write_text(json.dumps(report))
        return report

    def admit_mixed_label_qualification(self, *, qualification_predictions=None,
                                       diagnostic_min_probability=0.5):
        """Build an isolated typed fixture with binary and tri-label criteria."""
        self.admit_reviews()
        self.admit_typed_decider()
        qualification_path = self.root / "qualification-data.json"
        for prefix in ("decider", "qualification"):
            path = self.root / f"{prefix}-data.json"
            data = json.loads(path.read_text())
            data["criteria"][0]["options"] = ["pass", "fail"]
            data["criteria"][0]["diagnostic_min_probability"] = diagnostic_min_probability
            data["criteria"][1]["diagnostic_min_probability"] = diagnostic_min_probability
            if prefix == "qualification":
                data["items"].append({
                    "id": "heading-uncertain", "family": "heading-uncertain", "split": "eval",
                    "text": "## Ambiguous subject", "block_kind": "heading", "reader_context": "",
                    "role": "authored", "origin": {"kind": "synthetic"},
                    "checks": {"title": "uncertain"},
                })
            path.write_text(json.dumps(data))
        current = json.loads((self.root / "decider-data.json").read_text())
        criteria = current["criteria"]
        qualification = json.loads(qualification_path.read_text())
        self.rebuild_typed_capture("decider")
        predictions = qualification_predictions or {
            item["id"]: {criterion["id"]: item.get("checks", {}).get(criterion["id"], "pass")
                         for criterion in criteria if item["block_kind"] in criterion["applies_to"]}
            for item in qualification["items"]
        }
        self.rebuild_typed_capture("qualification", predictions)
        policy_entry = self.settings
        policy_entry["decider_requirements"]["criteria"] = criteria
        policy_entry["decider_qualification"]["required_labels"] = {
            "voice": ["pass", "fail"],
            "title": ["pass", "fail", "uncertain"],
        }
        policy_entry["decider_qualification"]["data_blake3"] = digest(qualification_path.read_bytes())
        policy_entry["decider_qualification"]["report_blake3"] = digest(
            (self.root / "qualification-report.json").read_bytes())
        self.save_policy()

    def admit_earlier_reader_context(self):
        text = "# Fixture\n\nThe method means version A.\n\nShared middle.\n\nShared recent.\n\nA clear passage.\n"
        self.source.write_text(text)
        self.settings["source_blake3"] = digest(self.source.read_bytes())
        self.save_policy()
        self.admit_reviews()
        self.admit_typed_decider()

        blocks = text.strip().split("\n\n")
        binding = {"schema": "book-reader-context-bindings-v1",
                   "document_blake3": digest(self.source.read_bytes()),
                   "items": [{"block_index": i,
                              "earlier_block_indices": [1] if i == 4 else []}
                             for i in range(len(blocks))]}
        binding_path = self.root / "reader-context-bindings.json"
        binding_path.write_text(json.dumps(binding))
        current_path = self.root / "decider-data.json"
        current = json.loads(current_path.read_text())
        binding_spec = {"data": binding_path.name, "data_blake3": digest(binding_path.read_bytes())}
        for item, context in zip(current["items"], _reader_contexts(
                self.root.resolve(), {"reader_context_binding": binding_spec},
                current["document_blake3"], blocks)):
            item["reader_context"] = context
        current_path.write_text(json.dumps(current))
        self.rebuild_typed_capture("decider")
        self.settings["decider_requirements"]["reader_context_binding"] = {
            "data": binding_path.name,
            "data_blake3": digest(binding_path.read_bytes()),
        }
        self.save_policy()
        return binding_path

    def _v2_binding_data(self, text):
        blocks = _writing_blocks(text)
        items = []
        for index, block in enumerate(blocks):
            row = {"block_index": index, "earlier_block_indices": [0, 1] if index == 4 else []}
            heading = re.fullmatch(r"(#{1,6})\s+\S.*", block.strip())
            if heading:
                level = len(heading.group(1))
                end = len(blocks)
                for candidate in range(index + 1, len(blocks)):
                    next_heading = re.fullmatch(r"(#{1,6})\s+\S.*", blocks[candidate].strip())
                    if next_heading and len(next_heading.group(1)) <= level:
                        end = candidate
                        break
                row["following_section_block_indices"] = list(range(index + 1, end))
            items.append(row)
        return {"schema": "book-reader-context-bindings-v2",
                "document_blake3": digest(text), "items": items}

    def admit_heading_reader_context_v2(self):
        text = ("# Fixture\n\nThe method means version A.\n\nShared middle.\n\n"
                "Shared recent.\n\n## Preview\n\nThe section opens with its literal claim.\n\n"
                "### Nested details\n\nNested content stays in this section.\n\n"
                "## Next section\n\nOutside section content.\n")
        self.source.write_text(text)
        self.settings["source_blake3"] = digest(self.source.read_bytes())
        self.save_policy()
        self.admit_reviews()
        self.admit_typed_decider()
        binding = self._v2_binding_data(text)
        binding_path = self.root / "reader-context-bindings-v2.json"
        binding_path.write_text(json.dumps(binding))
        current_path = self.root / "decider-data.json"
        current = json.loads(current_path.read_text())
        binding_spec = {"data": binding_path.name, "data_blake3": digest(binding_path.read_bytes())}
        for item, context in zip(current["items"], _reader_contexts(
                self.root.resolve(), {"reader_context_binding": binding_spec},
                current["document_blake3"], _writing_blocks(text))):
            item["reader_context"] = context
        current_path.write_text(json.dumps(current))
        self.rebuild_typed_capture("decider")
        self.settings["decider_requirements"]["reader_context_binding"] = binding_spec
        self.save_policy()
        return binding_path

    def read_v2_context(self, data, text=None, pinned_hash=None, source_hash=None):
        text = text or ("# Root\n\nBefore.\n\n## Target\n\nInside one.\n\n"
                        "### Nested\n\nInside two.\n\n## Next\n\nOutside.\n")
        self.source.write_text(text)
        path = self.root / "direct-context-v2.json"
        path.write_text(json.dumps(data))
        raw_hash = pinned_hash or digest(path.read_bytes())
        return _reader_contexts(self.root.resolve(),
                                {"reader_context_binding": {"data": path.name,
                                                            "data_blake3": raw_hash}},
                                source_hash or digest(self.source.read_bytes()),
                                _writing_blocks(text))

    def rewrite_context_binding(self, binding_path, change, update_hash=True):
        binding = json.loads(binding_path.read_text())
        change(binding)
        binding_path.write_text(json.dumps(binding))
        if update_hash:
            self.settings["decider_requirements"]["reader_context_binding"]["data_blake3"] = digest(binding_path.read_bytes())
            self.save_policy()

    def test_typed_context_checks_all_blocks_with_applicable_criteria(self):
        self.admit_reviews()
        self.admit_typed_decider()
        self.assertEqual(self.invoke(), 0)
        self.assertTrue(self.output.exists())

    def test_typed_context_cannot_forge_manuscript_prefix(self):
        self.admit_reviews()
        self.admit_typed_decider()
        path = self.root / "decider-data.json"
        data = json.loads(path.read_text())
        data["items"][1]["reader_context"] = "An invented prior introduction."
        path.write_text(json.dumps(data))
        self.rebuild_typed_capture("decider")
        with self.assertRaisesRegex(ValueError, "reader context"):
            self.enforce()

    def test_policy_bound_earlier_context_changes_the_maintained_request_state(self):
        binding_path = self.admit_earlier_reader_context()
        self.assertEqual(self.invoke(), 0)
        capture = json.loads((self.root / "decider-report.json").read_text())
        state = json.loads(capture["items"][4]["request_evidence"]["adapter_input"]["content"])
        self.assertIn("The method means version A.", state["reader_context"])
        self.assertEqual(
            state["reader_context"],
            "EARLIER LITERAL READER CONTEXT (oldest first):\nThe method means version A."
            "\n\nIMMEDIATE PRECEDING TWO LITERAL BLOCKS:\nShared middle.\n\nShared recent.")
        self.assertNotIn("SELECTED FOLLOWING SECTION TEXT", state["reader_context"])
        self.assertTrue(binding_path.is_file())

    def test_v1_context_binding_preserves_exact_context_bytes(self):
        binding_path = self.admit_earlier_reader_context()
        blocks = _writing_blocks(self.source.read_text())
        binding = json.loads(binding_path.read_text())
        spec = {"reader_context_binding": {"data": binding_path.name,
                                           "data_blake3": digest(binding_path.read_bytes())}}
        contexts = _reader_contexts(self.root.resolve(), spec,
                                    binding["document_blake3"], blocks)
        self.assertEqual(contexts[4],
                         "EARLIER LITERAL READER CONTEXT (oldest first):\nThe method means version A."
                         "\n\nIMMEDIATE PRECEDING TWO LITERAL BLOCKS:\nShared middle.\n\nShared recent.")
        self.assertNotIn("SELECTED FOLLOWING SECTION TEXT", contexts[4])

    def test_v2_heading_preview_is_rebuilt_and_captured_by_the_actual_gate(self):
        binding_path = self.admit_heading_reader_context_v2()
        self.assertEqual(self.invoke(), 0)
        capture = json.loads((self.root / "decider-report.json").read_text())
        state = json.loads(capture["items"][4]["request_evidence"]["adapter_input"]["content"])
        self.assertIn("Shared middle.", state["reader_context"])
        self.assertIn("Shared recent.", state["reader_context"])
        self.assertIn("SELECTED FOLLOWING SECTION TEXT FOR HEADING REVIEW", state["reader_context"])
        self.assertIn("not already-read reader knowledge", state["reader_context"])
        self.assertIn("The section opens with its literal claim.", state["reader_context"])
        self.assertIn("### Nested details", state["reader_context"])
        self.assertNotIn("Outside section content.", state["reader_context"])
        self.assertTrue(binding_path.is_file())

    def test_v2_heading_preview_forgery_is_rejected_by_the_actual_evidence_reader(self):
        self.admit_heading_reader_context_v2()
        path = self.root / "decider-data.json"
        data = json.loads(path.read_text())
        data["items"][4]["reader_context"] += "\n\nInvented preview text."
        path.write_text(json.dumps(data))
        self.rebuild_typed_capture("decider")
        with self.assertRaisesRegex(ValueError, "reader context"):
            self.enforce()

    def test_v2_rejects_different_document_and_stale_raw_data_hashes(self):
        text = ("# Root\n\nBefore.\n\n## Target\n\nInside one.\n\n"
                "### Nested\n\nInside two.\n\n## Next\n\nOutside.\n")
        data = self._v2_binding_data(text)
        with self.assertRaisesRegex(ValueError, "document identity"):
            self.read_v2_context(data, source_hash=digest(text + " changed"))
        with self.assertRaisesRegex(ValueError, "binding hash"):
            self.read_v2_context(data, pinned_hash="0" * 64)
        tampered = json.loads(json.dumps(data))
        tampered["items"][2]["following_section_block_indices"] = [5]
        with self.assertRaisesRegex(ValueError, "binding hash"):
            self.read_v2_context(tampered, pinned_hash=digest(json.dumps(data)))

    def test_v2_rejects_cross_section_self_duplicate_boolean_unsorted_and_prose_future_refs(self):
        text = ("# Root\n\nBefore.\n\n## Target\n\nInside one.\n\n"
                "### Nested\n\nInside two.\n\n## Next\n\nOutside.\n")
        changes = [
            ("cross-section", lambda data: data["items"][2].update(following_section_block_indices=[7]), "cross the target heading section"),
            ("self", lambda data: data["items"][2].update(following_section_block_indices=[2]), "strictly after"),
            ("duplicate", lambda data: data["items"][2].update(following_section_block_indices=[5, 5]), "sorted, unique"),
            ("boolean-index", lambda data: data["items"][2].update(following_section_block_indices=[True]), "sorted, unique"),
            ("unsorted", lambda data: data["items"][2].update(following_section_block_indices=[5, 3]), "sorted, unique"),
            ("prose-future", lambda data: data["items"][3].update(following_section_block_indices=[4]), "only allowed on heading rows"),
            ("boolean-target-index", lambda data: data["items"][2].update(block_index=True), "rows are malformed"),
        ]
        for name, change, reason in changes:
            with self.subTest(name=name):
                data = self._v2_binding_data(text)
                change(data)
                with self.assertRaisesRegex(ValueError, reason):
                    self.read_v2_context(data, text=text)

    def test_earlier_context_binding_hash_is_policy_pinned(self):
        self.admit_earlier_reader_context()
        self.settings["decider_requirements"]["reader_context_binding"]["data_blake3"] = "0" * 64
        self.save_policy()
        with self.assertRaisesRegex(ValueError, "binding hash"):
            self.enforce()

    def test_earlier_context_binding_requires_typed_v3(self):
        self.admit_reviews()
        self.admit_decider()
        self.settings["decider_requirements"]["reader_context_binding"] = {
            "data": "unused.json", "data_blake3": "0" * 64}
        self.save_policy()
        with self.assertRaisesRegex(ValueError, "requires the typed Decider2B schema"):
            self.enforce()

    def test_earlier_context_binding_rejects_current_and_future_indices(self):
        for invalid in (4, 5):
            with self.subTest(invalid=invalid):
                binding_path = self.admit_earlier_reader_context()
                self.rewrite_context_binding(binding_path, lambda data: data["items"][2].update(earlier_block_indices=[invalid]))
                with self.assertRaisesRegex(ValueError, "chronology"):
                    self.enforce()

    def test_earlier_context_binding_rejects_duplicate_indices(self):
        binding_path = self.admit_earlier_reader_context()
        self.rewrite_context_binding(binding_path, lambda data: data["items"][4].update(earlier_block_indices=[0, 0]))
        with self.assertRaisesRegex(ValueError, "chronology"):
            self.enforce()

    def test_earlier_context_binding_requires_complete_rows(self):
        binding_path = self.admit_earlier_reader_context()
        self.rewrite_context_binding(binding_path, lambda data: data["items"].pop())
        with self.assertRaisesRegex(ValueError, "does not cover every current block"):
            self.enforce()

    def test_earlier_context_binding_rejects_arbitrary_challenge_context(self):
        self.admit_earlier_reader_context()
        path = self.root / "decider-data.json"
        data = json.loads(path.read_text())
        data["items"][4]["reader_context"] = "A caller-invented explanation."
        path.write_text(json.dumps(data))
        self.rebuild_typed_capture("decider")
        with self.assertRaisesRegex(ValueError, "reader context"):
            self.enforce()

    def test_typed_policy_cannot_omit_reference_or_applicability(self):
        for field, invalid_values in {
            "reference_context": [None, "", "   "],
            "applies_to": [None, [], ["not-a-block"], ["paragraph", "paragraph"]],
        }.items():
            for value in invalid_values:
                with self.subTest(field=field, value=value):
                    self.admit_reviews()
                    self.admit_typed_decider()
                    entry = self.settings
                    for criterion in entry["decider_requirements"]["criteria"]:
                        if value is None:
                            criterion.pop(field, None)
                        else:
                            criterion[field] = value
                    for prefix in ("decider", "qualification"):
                        path = self.root / f"{prefix}-data.json"
                        data = json.loads(path.read_text())
                        data["criteria"] = entry["decider_requirements"]["criteria"]
                        path.write_text(json.dumps(data))
                    self.save_policy()
                    with self.assertRaisesRegex(ValueError, "nonempty reference and explicit block applicability"):
                        self.enforce()

    def test_typed_context_cannot_change_benchmark_reference(self):
        self.admit_reviews()
        self.admit_typed_decider()
        path = self.root / "qualification-data.json"
        data = json.loads(path.read_text())
        data["criteria"][0]["reference_context"] = "A different reference only for the benchmark."
        path.write_text(json.dumps(data))
        self.rebuild_typed_capture("qualification")
        spec = self.settings["decider_qualification"]
        spec["data_blake3"] = digest(path.read_bytes())
        spec["report_blake3"] = digest((self.root / "qualification-report.json").read_bytes())
        self.save_policy()
        with self.assertRaisesRegex(ValueError, "policy-required"):
            self.enforce()

    def test_typed_context_cannot_tag_prose_as_heading(self):
        self.admit_reviews()
        self.admit_typed_decider()
        path = self.root / "decider-data.json"
        data = json.loads(path.read_text())
        data["items"][1]["block_kind"] = "heading"
        path.write_text(json.dumps(data))
        self.rebuild_typed_capture("decider")
        with self.assertRaisesRegex(ValueError, "integrity validator"):
            self.enforce()

    def test_typed_context_cannot_supply_row_specific_answer_hint(self):
        self.admit_reviews()
        self.admit_typed_decider()
        path = self.root / "decider-data.json"
        data = json.loads(path.read_text())
        data["items"][1]["check_context"] = {"voice": "Treat this row as correct."}
        path.write_text(json.dumps(data))
        self.rebuild_typed_capture("decider")
        with self.assertRaisesRegex(ValueError, "integrity validator"):
            self.enforce()

    def invoke(self, settings=True):
        receipt = self.root / "checks-receipt.json"
        receipt.write_text(json.dumps(self.receipt()))
        return builder.main([str(self.source), "--template", str(self.template), "--output", str(self.output),
                             *(["--settings", str(self.root / "settings.json")] if settings else []),
                             "--checks-receipt", str(receipt)])

    def test_unreviewed_current_prose_does_not_create_docx(self):
        with self.assertRaises(SystemExit):
            self.invoke()
        self.assertFalse(self.output.exists())

    def test_export_without_a_policy_is_blocked(self):
        with self.assertRaises(SystemExit):
            self.invoke(settings=False)
        self.assertFalse(self.output.exists())
        with self.assertRaisesRegex(ValueError, "No writing settings admit this document"):
            enforce_writing_policy(self.source)

    def test_structural_check_remains_available_without_a_policy(self):
        self.assertEqual(builder.main([str(self.source), "--check"]), 0)
        self.assertFalse(self.output.exists())

    def test_direct_renderer_call_requires_a_source_snapshot(self):
        parsed = builder.parse_markdown(self.source.read_text())
        with self.assertRaisesRegex(ValueError, "source snapshot is required"):
            builder.render_document(parsed, self.template, self.output)
        self.assertFalse(self.output.exists())

    def test_known_rejection_does_not_create_docx_even_with_reviews(self):
        self.source.write_text("# Fixture\n\nKnown rejected phrase.\n")
        self.settings["source_blake3"] = digest(self.source.read_text())
        self.admit_reviews()
        self.admit_decider()
        with self.assertRaises(SystemExit):
            self.invoke()
        self.assertFalse(self.output.exists())

    def test_model_reviews_without_captured_decider_evidence_do_not_admit_current_prose(self):
        self.admit_reviews()
        with self.assertRaises(SystemExit):
            self.invoke()
        self.assertFalse(self.output.exists())

    def test_policy_benchmark_qualifies_model_without_certifying_author_voice(self):
        self.admit_reviews()
        self.admit_decider(model="policy-selected-classifier")
        receipt = self.enforce()
        self.assertEqual(self.invoke(), 0)
        self.assertTrue(self.output.exists())
        self.assertEqual(receipt["decider2b_evidence"]["status"], "decider_execution_passed")
        self.assertEqual(receipt["decider2b_evidence"]["model"], "policy-selected-classifier")
        self.assertEqual(receipt["decider2b_evidence"]["model_qualification"], "qualified_on_policy_benchmark")
        self.assertEqual(receipt["decider2b_evidence"]["qualification_required_labels"], ["pass", "fail"])
        self.assertIn("not universal author approval", receipt["decider2b_evidence"]["voice_certification"])

    def test_false_pass_on_known_negative_blocks_even_when_current_prose_passes(self):
        self.admit_reviews()
        self.admit_decider(qualification_predictions={
            "benchmark-positive": {"voice": "pass"},
            "benchmark-negative": {"voice": "pass"},
        })
        with self.assertRaisesRegex(ValueError, "missed or abstained"):
            self.enforce()
        with self.assertRaises(SystemExit):
            self.invoke()
        self.assertFalse(self.output.exists())

    def test_missing_qualification_evidence_blocks_current_prose(self):
        self.admit_reviews()
        self.admit_decider()
        del self.settings["decider_qualification"]
        self.save_policy()
        with self.assertRaisesRegex(ValueError, "policy-pinned Decider2B qualification"):
            self.enforce()

    def test_policy_criterion_defaults_are_compared_with_data_fields(self):
        self.admit_reviews()
        self.admit_decider()
        data_path = self.root / "decider-data.json"
        data = json.loads(data_path.read_text())
        data["criteria"][0]["primitive"] = "true-or-false"
        data_path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, "question, option, or criterion default"):
            self.enforce()

        data["criteria"][0]["primitive"] = "one-of"
        data["criteria"][0]["deterministic"] = True
        data_path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, "question, option, or criterion default"):
            self.enforce()

        data["criteria"][0]["deterministic"] = False
        data["criteria"][0]["diagnostic_min_probability"] = 0.1
        data_path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, "question, option, or criterion default"):
            self.enforce()

    def test_qualification_criterion_and_default_must_match_current_policy(self):
        self.admit_reviews()
        self.admit_decider()
        qualification_path = self.root / "qualification-data.json"
        data = json.loads(qualification_path.read_text())
        data["criteria"][0]["options"] = ["pass", "uncertain"]
        qualification_path.write_text(json.dumps(data))
        self.settings["decider_qualification"]["data_blake3"] = digest(qualification_path.read_bytes())
        self.save_policy()
        with self.assertRaisesRegex(ValueError, "question, option, or criterion default"):
            self.enforce()

    def test_per_criterion_labels_qualify_mixed_binary_and_uncertain_answers(self):
        self.admit_mixed_label_qualification()
        receipt = self.enforce()
        self.assertEqual(receipt["decider2b_evidence"]["model_qualification"],
                         "qualified_on_policy_benchmark")
        self.assertEqual(receipt["decider2b_evidence"]["qualification_required_labels"], {
            "voice": ["pass", "fail"], "title": ["pass", "fail", "uncertain"]})
        self.assertEqual(receipt["decider2b_evidence"]["voice_certification"],
                         "not_established; benchmark qualification is not universal author approval")
        report = json.loads((self.root / "qualification-report.json").read_text())
        uncertain = next(item for item in report["items"] if item["id"] == "heading-uncertain")["checks"]["title"]
        self.assertEqual(uncertain["predicted"], "uncertain")
        self.assertEqual(uncertain["decision"], "uncertain")
        self.assertGreater(uncertain["probabilities"]["uncertain"],
                           uncertain["diagnostic_min_probability"])

    def test_per_criterion_mapping_is_exact_and_uncertain_requires_an_option(self):
        self.admit_mixed_label_qualification()
        spec = self.settings["decider_qualification"]
        spec["required_labels"] = {"voice": ["pass", "fail"]}
        self.save_policy()
        with self.assertRaisesRegex(ValueError, "must match required criteria"):
            self.enforce()

        self.admit_mixed_label_qualification()
        spec = self.settings["decider_qualification"]
        spec["required_labels"]["voice"] = ["pass", "uncertain"]
        self.save_policy()
        with self.assertRaisesRegex(ValueError, "must uniquely include pass and fail"):
            self.enforce()

        self.admit_mixed_label_qualification()
        # The policy may only require `uncertain` when that criterion's
        # answer options actually contain it.
        current_path = self.root / "decider-data.json"
        qualification_path = self.root / "qualification-data.json"
        for path in (current_path, qualification_path):
            data = json.loads(path.read_text())
            data["criteria"][1]["options"] = ["pass", "fail"]
            path.write_text(json.dumps(data))
        current = json.loads(current_path.read_text())
        qualification = json.loads(qualification_path.read_text())
        self.settings["decider_requirements"]["criteria"] = current["criteria"]
        self.rebuild_typed_capture("decider")
        spec = self.settings["decider_qualification"]
        spec["data_blake3"] = digest(qualification_path.read_bytes())
        self.save_policy()
        with self.assertRaisesRegex(ValueError, "must be answer options for their criterion"):
            self.enforce()

    def test_per_criterion_mapping_requires_each_declared_label_in_qualification_data(self):
        self.admit_mixed_label_qualification()
        path = self.root / "qualification-data.json"
        data = json.loads(path.read_text())
        data["items"] = [item for item in data["items"] if item["id"] != "heading-negative"]
        path.write_text(json.dumps(data))
        predictions = {item["id"]: {
            criterion["id"]: item.get("checks", {}).get(criterion["id"], "pass")
            for criterion in data["criteria"] if item["block_kind"] in criterion["applies_to"]}
            for item in data["items"]}
        self.rebuild_typed_capture("qualification", predictions)
        spec = self.settings["decider_qualification"]
        spec["data_blake3"] = digest(path.read_bytes())
        spec["report_blake3"] = digest((self.root / "qualification-report.json").read_bytes())
        self.save_policy()
        with self.assertRaisesRegex(ValueError, "omitted a policy-required expected label"):
            self.enforce()

    def test_confidence_abstention_does_not_satisfy_an_uncertain_benchmark_label(self):
        self.admit_mixed_label_qualification()
        report_path = self.root / "qualification-report.json"
        report = json.loads(report_path.read_text())
        row = next(item for item in report["items"] if item["id"] == "heading-uncertain")
        check = row["checks"]["title"]
        # The categorical answer is pass, but its peak probability equals the
        # policy threshold, so the evaluator's decision is an abstention.
        probabilities = {"pass": 0.5, "fail": 0.4, "uncertain": 0.1}
        confidence = fixture_confidence(probabilities)
        check.update({"predicted": "pass", "raw_answer": "pass", "decision": "uncertain",
                      "probabilities": probabilities, "confidence": confidence})
        exchange = row["request_evidence"]["exchanges"][0]
        response = json.loads(exchange["response"])
        response["answers"]["title"].update({"choice": "pass", "probabilities": probabilities,
                                              "confidence": confidence})
        exchange["response"] = json.dumps(response)
        report_path.write_text(json.dumps(report))
        self.settings["decider_qualification"]["report_blake3"] = digest(
            report_path.read_bytes())
        self.save_policy()
        with self.assertRaisesRegex(ValueError, "lacks captured probability above its criterion threshold"):
            self.enforce()

    def test_low_probability_uncertain_choice_does_not_satisfy_uncertain_label(self):
        self.admit_mixed_label_qualification()
        report_path = self.root / "qualification-report.json"
        report = json.loads(report_path.read_text())
        row = next(item for item in report["items"] if item["id"] == "heading-uncertain")
        check = row["checks"]["title"]
        # The raw answer is uncertain, but its captured probability is below
        # the policy threshold despite the evaluator's categorical decision.
        probabilities = {"pass": 0.3, "fail": 0.3, "uncertain": 0.4}
        confidence = fixture_confidence(probabilities)
        check.update({"predicted": "uncertain", "raw_answer": "uncertain", "decision": "uncertain",
                      "probabilities": probabilities, "confidence": confidence})
        exchange = row["request_evidence"]["exchanges"][0]
        response = json.loads(exchange["response"])
        response["answers"]["title"].update({"choice": "uncertain", "probabilities": probabilities,
                                              "confidence": confidence})
        exchange["response"] = json.dumps(response)
        report_path.write_text(json.dumps(report))
        self.settings["decider_qualification"]["report_blake3"] = digest(
            report_path.read_bytes())
        self.save_policy()
        with self.assertRaisesRegex(ValueError, "lacks captured probability above its criterion threshold"):
            self.enforce()

    def test_uncertain_label_uses_policy_specific_probability_threshold(self):
        self.admit_mixed_label_qualification(diagnostic_min_probability=0.7)
        report_path = self.root / "qualification-report.json"
        report = json.loads(report_path.read_text())
        row = next(item for item in report["items"] if item["id"] == "heading-uncertain")
        check = row["checks"]["title"]
        probabilities = {"pass": 0.2, "fail": 0.15, "uncertain": 0.65}
        check.update({"predicted": "uncertain", "raw_answer": "uncertain", "decision": "uncertain",
                      "probabilities": probabilities, "confidence": fixture_confidence(probabilities)})
        exchange = row["request_evidence"]["exchanges"][0]
        response = json.loads(exchange["response"])
        response["answers"]["title"].update({"choice": "uncertain", "probabilities": probabilities,
                                              "confidence": fixture_confidence(probabilities)})
        exchange["response"] = json.dumps(response)
        report_path.write_text(json.dumps(report))
        self.settings["decider_qualification"]["report_blake3"] = digest(
            report_path.read_bytes())
        self.save_policy()
        with self.assertRaisesRegex(ValueError, "lacks captured probability above its criterion threshold"):
            self.enforce()

    def test_qualification_model_serving_and_missing_labels_block(self):
        self.admit_reviews()
        self.admit_decider()
        self.settings["decider_requirements"]["model"] = "another-model"
        self.save_policy()
        with self.assertRaisesRegex(ValueError, "policy-owned model"):
            self.enforce()

        self.admit_decider()
        report_path = self.root / "qualification-report.json"
        report_path.write_text(report_path.read_text() + " ")
        with self.assertRaisesRegex(ValueError, "DATA/report hash does not match policy"):
            self.enforce()

        self.admit_decider()
        self.settings["decider_qualification"]["required_labels"] = ["uncertain", "fail"]
        self.save_policy()
        with self.assertRaisesRegex(ValueError, "qualification must declare unique required labels"):
            self.enforce()

        self.admit_decider()
        report_path = self.root / "qualification-report.json"
        report = json.loads(report_path.read_text())
        report["serving"] = "blake3:other-serving"
        for row in report["items"]:
            exchange = row["request_evidence"]["exchanges"][0]
            response = json.loads(exchange["response"])
            response["served_identity"] = report["serving"]
            exchange["response"] = json.dumps(response)
        report_path.write_text(json.dumps(report))
        self.settings["decider_qualification"]["report_blake3"] = digest(report_path.read_bytes())
        self.save_policy()
        with self.assertRaisesRegex(ValueError, "match the current report model, serving identity"):
            self.enforce()

        self.admit_decider()
        qualification_path = self.root / "qualification-data.json"
        data = json.loads(qualification_path.read_text())
        data["items"][1]["checks"] = {}
        qualification_path.write_text(json.dumps(data))
        self.settings["decider_qualification"]["data_blake3"] = digest(qualification_path.read_bytes())
        self.save_policy()
        with self.assertRaisesRegex(ValueError, "omitted required labels"):
            self.enforce()

    def test_uncertain_or_unsupported_decider_results_block_export(self):
        self.admit_reviews()
        self.admit_decider(choice="uncertain")
        with self.assertRaises(SystemExit):
            self.invoke()
        self.assertFalse(self.output.exists())
        self.admit_decider(model="fixture-selected-model")
        self.settings["decider_requirements"]["model"] = "different-policy-model"
        self.save_policy()
        with self.assertRaisesRegex(ValueError, "policy-owned model"):
            self.enforce()
        self.assertFalse(self.output.exists())

    def test_changed_source_and_unknown_filename_are_blocked(self):
        self.admit_reviews()
        self.source.write_text("# Fixture\n\nChanged after review.\n")
        with self.assertRaises(ValueError):
            self.enforce()
        other = self.root / "other.md"
        other.write_text("New prose")
        with self.assertRaises(ValueError):
            self.enforce(other)

    def test_bound_comparison_can_preserve_rejected_copy_without_current_approval(self):
        self.source.write_text("# Comparison\n\nKnown rejected phrase.\n")
        self.settings = {"role": "comparison", "source_blake3": digest(self.source.read_text())}
        self.save_policy()
        self.assertEqual(self.invoke(), 0)

    def test_missing_or_corrupt_evidence_fails_closed(self):
        (self.root / "profile.json").unlink()
        with self.assertRaises(ValueError):
            self.enforce()
        (self.root / "settings.json").write_text("not json")
        with self.assertRaises(SystemExit):
            builder.main([str(self.source), "--template", str(self.template), "--output", str(self.output),
                          "--settings", str(self.root / "settings.json")])
        self.assertFalse(self.output.exists())

    def test_malformed_policy_shapes_fail_closed(self):
        for malformed in ([], "policy", {"documents": []}, {"role": "approved", "source_blake3": digest(self.source.read_bytes())},
                          {"role": "current_prose"}, {**self.settings, "evidence_folder": "relative/folder"}):
            with self.subTest(policy=malformed), self.assertRaises(ValueError):
                self.enforce(settings=malformed)

    def test_evidence_paths_cannot_escape_policy_root(self):
        outside = self.root.parent / (self.root.name + "-outside-profile.json")
        try:
            outside.write_text(json.dumps(self.profile))
            self.settings["profile"] = "../" + outside.name
            self.save_policy()
            with self.assertRaisesRegex(ValueError, "within its policy directory"):
                self.enforce()
        finally:
            outside.unlink(missing_ok=True)

    def test_symlinked_source_uses_its_resolved_policy_root(self):
        actual_root = self.root / "actual"
        actual_root.mkdir()
        actual = actual_root / "current.md"
        actual.write_text(self.source.read_text())
        (actual_root / "profile.json").write_text(json.dumps(self.profile))
        actual.write_text(self.source.read_text() + "\nOnly in the linked file.\n")
        settings = {"source_blake3": digest(actual.read_text()), "role": "comparison"}
        link = self.root / "linked.md"
        link.symlink_to(actual)
        self.assertEqual(self.enforce(link, settings=settings)["status"], "declared_reference")

    def test_concurrent_new_approval_cannot_authorize_a_different_parsed_snapshot(self):
        self.admit_reviews()
        original_parse = builder.parse_markdown
        def changed_after_read(value):
            parsed = original_parse(value)
            self.source.write_text("# Fixture\n\nA different approved snapshot.\n")
            self.settings["source_blake3"] = digest(self.source.read_text())
            self.admit_reviews()
            return parsed
        with patch.object(builder, "parse_markdown", side_effect=changed_after_read):
            with self.assertRaises(SystemExit):
                self.invoke()
        self.assertFalse(self.output.exists())


    # The book's checks: the branch of list:checks its settings name (new in the Workshop port).
    def test_current_prose_requires_the_books_checks_branch(self):
        self.admit_reviews()
        self.admit_decider()
        self.assertEqual(self.enforce()["book_checks"]["branch"], BRANCH)
        del self.settings["checks_branch"]
        with self.assertRaisesRegex(ValueError, "checks branch"):
            self.enforce()

    def test_checks_receipt_must_be_for_these_bytes_and_that_branch(self):
        self.admit_reviews()
        self.admit_decider()
        other = self.root / "other.md"
        other.write_text("# Something else\n")
        with self.assertRaisesRegex(ValueError, "not run on this exact manuscript"):
            self.enforce(receipt=self.receipt(other))
        with self.assertRaisesRegex(ValueError, "not run on this exact manuscript"):
            self.enforce(receipt={**self.receipt(), "branch": "another-branch"})
        with self.assertRaisesRegex(ValueError, "not run on this exact manuscript"):
            enforce_writing_policy(self.source, settings=self.settings)

    def test_failed_or_unsettled_checks_create_no_docx(self):
        self.admit_reviews()
        self.admit_decider()
        for status in ("failed", "uncertain", "no-applicable-rule"):
            with self.subTest(status=status), self.assertRaisesRegex(ValueError, "did not pass"):
                self.enforce(receipt=self.receipt(status=status))
        receipt = self.root / "checks-receipt.json"
        receipt.write_text(json.dumps(self.receipt(status="failed")))
        with self.assertRaises(SystemExit):
            builder.main([str(self.source), "--template", str(self.template), "--output", str(self.output),
                          "--settings", str(self.root / "settings.json"), "--checks-receipt", str(receipt)])
        self.assertFalse(self.output.exists())

    def test_comparison_needs_no_checks_receipt(self):
        self.settings = {"role": "comparison", "source_blake3": digest(self.source.read_bytes())}
        self.assertEqual(enforce_writing_policy(self.source, settings=self.settings)["status"], "declared_reference")


REAL_VOICE_CLASSIFIER = HERE.parents[1] / "train-and-evaluate-a-writing-voice-classifier" / "read-data" / "evaluation-integrity.mjs"


@unittest.skipUnless(REAL_VOICE_CLASSIFIER.is_file(), "tools/train-and-evaluate-a-writing-voice-classifier is not in this checkout")
class RealVoiceClassifierGateTests(WritingGateTests):
    """Every gate test again, with the Workshop's own voice-capture validator in place of the stand-in."""

    def setUp(self):
        super().setUp()
        real = patch.object(writing_gate, "VOICE_CLASSIFIER", REAL_VOICE_CLASSIFIER)
        real.start()
        self.addCleanup(real.stop)


@unittest.skipUnless((HERE.parents[1] / "settings" / "read-data" / "settings.py").is_file(), "tools/settings is not in this checkout")
class SettingsRowTests(unittest.TestCase):
    """The settings come from the book's row of list:settings, read through tools/settings."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "book.md"
        self.source.write_text("# A made-up book\n\nA made-up passage.\n")
        Document().save(self.root / "template.docx")
        settings = {"role": "comparison", "source_blake3": digest(self.source.read_bytes()),
                    "manuscript": str(self.source), "template": str(self.root / "template.docx"),
                    "output_folder": str(self.root / "out")}
        self.record = self.root / "row.json"
        self.record.write_text(json.dumps({"id": "record:setting:export-documents-to-files~piece~made-up-book",
                                           "type": "record:setting", "value": {
                                               "name": "made-up book export", "tool": builder.TOOL_ID,
                                               "scope_kind": "piece", "scope_id": "made-up-book",
                                               "settings": json.dumps(settings), "from": "made-up@0", "status": "active"}}))

    def tearDown(self):
        self.temp.cleanup()

    def test_the_row_names_manuscript_template_and_output_folder(self):
        self.assertEqual(builder.main(["--settings-record", str(self.record), "--book-id", "made-up-book"]), 0)
        self.assertTrue((self.root / "out" / "made-up-book.docx").is_file())

    def test_another_book_or_a_retired_row_is_refused(self):
        with self.assertRaises(SystemExit):
            builder.main(["--settings-record", str(self.record), "--book-id", "another-book"])
        row = json.loads(self.record.read_text())
        row["value"]["status"] = "retired"
        self.record.write_text(json.dumps(row))
        with self.assertRaises(SystemExit):
            builder.main(["--settings-record", str(self.record), "--book-id", "made-up-book"])
        self.assertFalse((self.root / "out").exists())


if __name__ == "__main__":
    unittest.main()
