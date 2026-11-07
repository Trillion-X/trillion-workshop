"""Synthetic opposing controls for the source-first private-layout purpose."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

from docx import Document

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "do-work"))
import export_markdown_book_to_word as builder
import writing_gate as gate


class PrivateLayoutProofTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        os.chmod(self.root, 0o700)
        self.source = self.root / "synthetic.md"
        self.policy_path = self.root / "policy.json"
        self.job_path = self.root / "job.json"
        self.projection_path = self.root / "projection.json"
        self.gate_path = self.root / "scoped-gate.json"
        self.rules_path = self.root / "rules.json"
        self.settings_path = self.root / "settings.json"
        self.write(self.source, b"# Synthetic\n\nA plain synthetic paragraph.\n")
        source_hash = gate._hash(self.source)
        tree = {"props": {"text": "Synthetic"}, "children": [
            {"props": {"text": "A plain synthetic paragraph."}, "children": []}]}
        self.job = {"title": "Synthetic", "tree": tree,
                    "descriptor": {"format_id": "docx", "destination_dir": "/unused", "file_stem": "unused"},
                    "source": {"candidate_path": str(self.source), "candidate_content_identity": "1f:" + source_hash}}
        self.projection = {"schema": "documents-structured-file-projection-v1", "source_identity": "1f:" + source_hash,
                           "tree": copy.deepcopy(tree)}
        self.scoped_gate = {"gate_id": "synthetic-scoped-layout-v1", "passed": True}
        starter = Path(__file__).resolve().parent.parent / "read-data" / "starter-projection-rules.json"
        self.rules = json.loads(starter.read_text())
        self.write(self.job_path, self.job)
        self.write(self.projection_path, self.projection)
        self.write(self.gate_path, self.scoped_gate)
        self.write(self.rules_path, self.rules)
        self.selected = {"file_stem": "synthetic-unfinished-proof", "projection": str(self.projection_path),
                         "mechanical_gate_id": self.scoped_gate["gate_id"], "rules": str(self.rules_path)}
        self.rule = {"delivery_eligible": False, "requires_voice_qualification": False,
                     "title": "Private layout proof Unfinished manuscript", "output_root": "internal-layout",
                     "documents": {self.source.name: self.selected}}
        self.policy = {"schema": "book-writing-policy-v1", "unknown_documents": "deny",
                       "documents": {self.source.name: {"role": "current_prose", "source_blake3": source_hash,
                                                       "native_gate_result": str(self.gate_path)}},
                       "export_purposes": {"private_layout_proof": self.rule}}
        self.settings = {"role": "current_prose", "source_blake3": source_hash, "manuscript": str(self.source),
                         "export_purposes": {"private_layout_proof": {"input_root": str(self.root),
                                                                    "policy": str(self.policy_path)}}}
        self.repin()

    def write(self, path, value):
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        path.write_bytes(data)
        os.chmod(path, 0o600)

    def repin(self):
        for name, path in (("projection", self.projection_path), ("mechanical_gate", self.gate_path), ("rules", self.rules_path)):
            self.selected[name + "_blake3"] = gate._hash(path)
        self.write(self.policy_path, self.policy)
        self.settings["export_purposes"]["private_layout_proof"]["policy_blake3"] = gate._hash(self.policy_path)
        self.write(self.settings_path, self.settings)

    def render(self):
        return builder.render_private_layout_proof(self.source, self.settings, self.job_path)

    def assert_no_artifact(self):
        self.assertEqual(list(self.root.rglob("*.docx")), [])
        self.assertEqual(list(self.root.rglob("proof-result.json")), [])

    def test_cli_reads_back_unfinished_label_and_private_non_delivery_receipt(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(builder.main([str(self.source), "--settings", str(self.settings_path),
                "--purpose", "private_layout_proof", "--job-file", str(self.job_path)]), 0)
        answer = json.loads(output.getvalue())
        self.assertEqual(answer["status"], "private_layout_proof")
        self.assertFalse(answer["delivery_eligible"])
        receipt = answer["gate"]
        self.assertFalse(receipt["delivery_eligible"])
        self.assertEqual(receipt["voice_qualification"], "not_established")
        self.assertTrue(receipt["unfinished_label_readback"])
        artifact = Path(answer["written"])
        self.assertIn(self.rule["title"], [p.text for p in Document(artifact).paragraphs])
        self.assertEqual(receipt["artifact"]["content_identity"], "1f:" + gate._hash(artifact))
        self.assertEqual(json.loads((artifact.parent / "proof-result.json").read_text()), receipt)
        for path in [self.root / "internal-layout", artifact.parent, *artifact.parent.iterdir()]:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if path.is_dir() else 0o600)

    def test_request_cannot_add_an_unadmitted_purpose_or_change_role(self):
        for settings in ({"role": "current_prose", "source_blake3": self.settings["source_blake3"]},
                         {**self.settings, "role": "comparison"}, {**self.settings, "role": "historical_reference"}):
            with self.subTest(role=settings["role"]), self.assertRaises(ValueError):
                builder.render_private_layout_proof(self.source, settings, self.job_path)
        self.assert_no_artifact()

    def test_private_admission_does_not_admit_default_final_export(self):
        with self.assertRaises(ValueError):
            gate.enforce_writing_policy(self.source, self.source.read_bytes(), settings=self.settings)
        proof_receipt = {"schema": "private-layout-proof-result-v1", "purpose": "private_layout_proof",
                         "delivery_eligible": False, "voice_qualification": "not_established"}
        with self.assertRaisesRegex(ValueError, "checks were not run"):
            gate._check_receipt({"checks_branch": "synthetic-final"}, proof_receipt, self.settings["source_blake3"])
        self.assert_no_artifact()

    def test_final_cli_refuses_private_job_without_private_purpose(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            builder.main([str(self.source), "--settings", str(self.settings_path), "--job-file", str(self.job_path)])
        self.assert_no_artifact()

    def test_original_default_deny_and_exact_document_admission_are_required(self):
        for mutation in ("default", "document", "purpose_document", "delivery", "voice"):
            saved = copy.deepcopy(self.policy)
            if mutation == "default": self.policy["unknown_documents"] = "allow"
            elif mutation == "document": self.policy["documents"] = {}
            elif mutation == "purpose_document": self.rule["documents"] = {}
            elif mutation == "delivery": self.rule["delivery_eligible"] = True
            else: self.rule["requires_voice_qualification"] = True
            self.repin()
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): self.render()
            self.policy = saved
            self.rule = self.policy["export_purposes"]["private_layout_proof"]
            self.selected = self.rule["documents"][self.source.name]
        self.assert_no_artifact()

    def test_every_input_pin_is_enforced_before_output(self):
        for path in (self.source, self.policy_path, self.projection_path, self.gate_path, self.rules_path):
            original = path.read_bytes()
            self.write(path, original + b" ")
            with self.subTest(path=path.name), self.assertRaises(ValueError): self.render()
            self.write(path, original)
        self.assert_no_artifact()

    def test_repinning_a_failed_or_wrong_scoped_gate_does_not_admit_it(self):
        for changed in ({"gate_id": self.scoped_gate["gate_id"], "passed": False},
                        {"gate_id": "another-gate", "passed": True}):
            self.write(self.gate_path, changed)
            self.repin()
            with self.subTest(changed=changed), self.assertRaisesRegex(ValueError, "scoped mechanical gate"): self.render()
        self.assert_no_artifact()

    def test_projection_and_job_must_bind_source_and_exact_same_tree(self):
        for mutation in ("projection_source", "projection_tree", "job_source", "job_path", "job_tree"):
            projection, job = copy.deepcopy(self.projection), copy.deepcopy(self.job)
            if mutation == "projection_source": projection["source_identity"] = "1f:" + "0" * 64
            elif mutation == "projection_tree": projection["tree"] = {}
            elif mutation == "job_source": job["source"]["candidate_content_identity"] = "1f:" + "0" * 64
            elif mutation == "job_path": job["source"]["candidate_path"] = str(self.root / "other.md")
            else: job["tree"] = {}
            self.write(self.projection_path, projection)
            self.write(self.job_path, job)
            self.repin()
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): self.render()
        self.assert_no_artifact()

    def test_private_label_and_destination_cannot_be_weakened_by_policy(self):
        for field, bad in (("title", "Finished manuscript"), ("output_root", "deliverables/proof"),
                           ("output_root", "../elsewhere"), ("output_root", "/tmp/proof")):
            old = self.rule[field]
            self.rule[field] = bad
            self.repin()
            with self.subTest(field=field, bad=bad), self.assertRaises(ValueError): self.render()
            self.rule[field] = old
        self.assert_no_artifact()

    def test_nonprivate_inputs_and_output_directory_are_refused(self):
        os.chmod(self.projection_path, 0o644)
        with self.assertRaisesRegex(ValueError, "private"): self.render()
        os.chmod(self.projection_path, 0o600)
        (self.root / "internal-layout").mkdir(mode=0o755)
        with self.assertRaisesRegex(ValueError, "directories"): self.render()
        self.assert_no_artifact()

    def test_symlink_and_fifo_inputs_are_refused_without_following_or_blocking(self):
        target = self.root / "original-gate.json"
        self.gate_path.rename(target)
        self.gate_path.symlink_to(target)
        with self.assertRaises(OSError): self.render()
        self.gate_path.unlink()
        os.mkfifo(self.gate_path, 0o600)
        with self.assertRaisesRegex(ValueError, "regular files"): self.render()
        self.assert_no_artifact()

    def test_native_format_and_extension_cannot_escape_output_owner(self):
        self.rules[0]["formats"]["docx"]["extension"] = "../outside"
        self.write(self.rules_path, self.rules)
        self.repin()
        with self.assertRaisesRegex(ValueError, "native Word or PDF"): self.render()
        self.assert_no_artifact()

    def test_input_replaced_during_renderer_cannot_receive_a_proof_receipt(self):
        original_run = builder.subprocess.run
        def changed(*args, **kwargs):
            result = original_run(*args, **kwargs)
            if str(args[0][1]).endswith("render-structured-file-export.py"):
                replacement = self.root / "replacement.md"
                self.write(replacement, self.source.read_bytes())
                os.replace(replacement, self.source)
            return result
        with patch.object(builder.subprocess, "run", side_effect=changed):
            with self.assertRaisesRegex(ValueError, "changed or was replaced"): self.render()
        self.assertEqual(len(list(self.root.rglob("*.docx"))), 1)
        self.assertEqual(list(self.root.rglob("proof-result.json")), [])

    def test_prepared_job_mutation_during_renderer_cannot_receive_a_proof_receipt(self):
        original_run = builder.subprocess.run
        def changed(*args, **kwargs):
            result = original_run(*args, **kwargs)
            if str(args[0][1]).endswith("render-structured-file-export.py"):
                prepared = Path(args[0][3])
                self.write(prepared, prepared.read_bytes() + b" ")
            return result
        with patch.object(builder.subprocess, "run", side_effect=changed):
            with self.assertRaisesRegex(ValueError, "changed or was replaced"): self.render()
        self.assertEqual(list(self.root.rglob("proof-result.json")), [])

    def test_named_source_directory_replacement_is_detected(self):
        original_run = builder.subprocess.run
        moved = self.root.with_name(self.root.name + "-held")
        def changed(*args, **kwargs):
            result = original_run(*args, **kwargs)
            if str(args[0][1]).endswith("render-structured-file-export.py"):
                self.root.rename(moved)
                self.root.mkdir(mode=0o700)
            return result
        try:
            with patch.object(builder.subprocess, "run", side_effect=changed):
                with self.assertRaisesRegex(ValueError, "directory was replaced"): self.render()
            self.assertEqual(list(moved.rglob("proof-result.json")), [])
        finally:
            if moved.exists():
                self.root.rmdir()
                moved.rename(self.root)

    def test_wrong_input_owner_is_refused(self):
        with patch.object(gate.os, "getuid", return_value=os.getuid() + 1):
            with self.assertRaisesRegex(ValueError, "user-owned regular files"): self.render()
        self.assert_no_artifact()

    def test_same_length_artifact_tampering_cannot_receive_a_proof_receipt(self):
        original_run = builder.subprocess.run
        def changed(*args, **kwargs):
            result = original_run(*args, **kwargs)
            if str(args[0][1]).endswith("render-structured-file-export.py"):
                prepared = Path(args[0][3])
                result_path = prepared.parent / "renderer-result.json"
                artifact = Path(json.loads(result_path.read_text())["path"])
                data = bytearray(artifact.read_bytes())
                data[-1] ^= 1
                self.write(artifact, bytes(data))
            return result
        with patch.object(builder.subprocess, "run", side_effect=changed):
            with self.assertRaisesRegex(ValueError, "artifact identity"): self.render()
        self.assertEqual(list(self.root.rglob("proof-result.json")), [])

    def test_deep_input_paths_use_bounded_host_headroom_and_release_descriptors(self):
        owner = gate._private_layout_core().snapshot_owner()
        deep = self.root.joinpath(*("nested" + str(i) for i in range(6)))
        deep.mkdir(parents=True, mode=0o700)
        per_input = len((deep / "input.json").parts)
        count = 128 // per_input + 1
        self.assertLessEqual(count * per_input, owner.descriptor_budget,
                             "The host descriptor reserve must admit this bounded >128-descriptor control")
        self.assertGreater(count * len((deep / "input.json").parts), 128)
        with contextlib.ExitStack() as stack:
            for index in range(count):
                path = deep / (str(index) + ".json")
                self.write(path, {"synthetic": index})
                held = stack.enter_context(owner.held_source_snapshot(str(self.root), path.relative_to(self.root).as_posix()))
                held.validate()
            self.assertGreater(owner.peak_descriptors, 128)
            self.assertLessEqual(owner.peak_descriptors, owner.descriptor_budget)
        self.assertEqual(owner.descriptors, 0)

    def test_low_host_descriptor_limit_refuses_before_opening_input(self):
        import resource
        with patch.object(resource, "getrlimit", return_value=(64, 64)):
            owner = gate._private_layout_core().snapshot_owner()
        self.assertEqual(owner.descriptor_budget, 0)
        with self.assertRaisesRegex(ValueError, "descriptor budget"):
            with owner.held_source_snapshot(str(self.root), self.source.name):
                self.fail("A zero descriptor budget cannot open the source")
        self.assertEqual(owner.descriptors, 0)


if __name__ == "__main__":
    unittest.main()
