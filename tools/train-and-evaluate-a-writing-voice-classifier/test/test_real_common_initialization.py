"""Exercise the maintained CLI consumers with the real, initially unconfigured common.py.

Only torch, PEFT and the model-vendor modules are synthetic. Identity, DATA and
provenance validation and common.configure are real. The model constructor stops
the run before any weights, inference or training can be used.
"""
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stand_in_decider

OWNER = Path(__file__).resolve().parents[1]
COMMON = OWNER.parent / "fine-tune-a-small-model-on-a-persons-rules" / "read-data"
FIXTURES = OWNER / "test" / "fixtures" / "training"


class ModelBoundary(RuntimeError):
    pass


def load_consumer(name):
    spec = importlib.util.spec_from_file_location("real_common_" + name.replace("-", "_"), OWNER / "do-work" / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@contextlib.contextmanager
def actual_common_context():
    """Do not install the existing fake common; let main import the actual shared file."""
    calls = []

    class DecisionModel:
        def __init__(self, folder, **kwargs):
            calls.append((folder, kwargs))
            raise ModelBoundary("reached model construction after real common initialization")

    torch = types.ModuleType("torch")
    torch.__path__ = []
    torch.cuda = types.SimpleNamespace(is_available=lambda: False)
    torch.backends = types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False))
    torch.bfloat16 = "synthetic-bf16"
    torch.set_num_threads = lambda count: calls.append(("threads", count))
    torch.manual_seed = lambda seed: calls.append(("seed", seed))
    nn = types.ModuleType("torch.nn")
    nn.__path__ = []
    functional = types.ModuleType("torch.nn.functional")
    peft = types.ModuleType("peft")
    peft.LoraConfig = lambda **kwargs: kwargs
    peft.get_peft_model = lambda *args: None
    infer = types.ModuleType("decider.infer")
    infer.Example, infer.Q = stand_in_decider.Example, stand_in_decider.Q
    model = types.ModuleType("decider.model")
    model.DecisionModel = DecisionModel
    model.collate = lambda items, pad: {"items": items, "pad": pad}
    prompt = types.ModuleType("decider.prompt")
    prompt.MAX_OPTIONS, prompt.build = 8, stand_in_decider.build
    systemone = types.ModuleType("decider.systemone")
    systemone.render_question, systemone.render_state = stand_in_decider.render_question, stand_in_decider.render_state
    modules = {"torch": torch, "torch.nn": nn, "torch.nn.functional": functional, "peft": peft,
               "decider": types.ModuleType("decider"), "decider.infer": infer, "decider.model": model,
               "decider.prompt": prompt, "decider.systemone": systemone}
    previous_path = sys.path[:]
    previous_mask = os.umask(0o077)
    try:
        with mock.patch.dict(sys.modules, modules), mock.patch("os.nice", return_value=15):
            sys.modules.pop("common", None)
            yield calls, DecisionModel, model.collate, torch
    finally:
        sys.path[:] = previous_path
        os.umask(previous_mask)


def model_config(root):
    path, model_owner, config = stand_in_decider.write_model_config(root)
    snapshot = Path(config["model"]["weights"]["folder"])
    (snapshot / "decider").mkdir()
    return path, model_owner, config, snapshot.resolve()


def training_argv(root, trainer):
    model_path, model_owner, config, snapshot = model_config(root)
    data, provenance, source = root / "train.jsonl", root / "provenance.json", root / "source.json"
    data.write_bytes((FIXTURES / "wording16-train.jsonl").read_bytes())
    provenance.write_bytes((FIXTURES / "wording16-provenance.json").read_bytes())
    source.write_bytes((FIXTURES / "source-data.json").read_bytes())
    for field, path in [("training_data_identity", data), ("provenance_identity", provenance), ("source_data_identity", source)]:
        config[field] = "1f:" + trainer.digest(path)
    model_path.write_text(json.dumps(config))
    argv = ["trainer", "--common-dir", str(COMMON), "--model-config", str(model_path),
            "--model-owner-dir", str(model_owner), "--data", str(data), "--provenance", str(provenance),
            "--source-data", str(source), "--out", str(root / "trained")]
    return argv, config, snapshot


def scoring_argv(root, scorer):
    model_path, model_owner, config, snapshot = model_config(root)
    data = {"schema": "book-voice-decider-challenge-v3", "criteria": [{
        "id": "fit", "question": "Does the target name its object?", "primitive": "one-of",
        "options": [{"name": "pass"}, {"name": "fail"}], "reference_context": "Check the stated object.",
        "applies_to": ["paragraph"]}], "items": [{"id": "one", "family": "synthetic-one", "split": "eval",
        "source_kind": "constructed_regression", "block_kind": "paragraph", "text": "The box holds pencils.",
        "reader_context": "", "checks": {"fit": "pass"}}]}
    source = root / "input.json"
    source.write_text(json.dumps(data))
    adapter = root / "adapter"
    adapter.mkdir()
    weights = adapter / "adapter_model.safetensors"
    weights.write_bytes(b"synthetic bytes; never loaded")
    (adapter / "train-info.json").write_text(json.dumps({
        "adapter_model_blake3": scorer.digest(weights), "base_snapshot": str(snapshot),
        "frame": config["frame"], "device": config["device"], "ready_identity": config["ready"]["identity"],
        "model_record": config["model_record"], "ready_record": config["ready_record"]}))
    argv = ["scorer", "--common-dir", str(COMMON), "--model-config", str(model_path),
            "--model-owner-dir", str(model_owner), "--data", str(source), "--adapter", str(adapter),
            "--out", str(root / "score.json"), "--dataset-role", "synthetic-development"]
    return argv, config, snapshot


class RealCommonInitializationTests(unittest.TestCase):
    def check_consumer(self, name, make_argv, changed_ready=False):
        with tempfile.TemporaryDirectory() as folder, actual_common_context() as (calls, constructor, collate, torch):
            root = Path(folder)
            consumer = load_consumer(name)
            self.assertIsNone(consumer.common, "no fake common or earlier initialized module may be inherited")
            argv, config, snapshot = make_argv(root, consumer)
            if changed_ready:
                (snapshot / "adapter.safetensors").write_bytes(b"changed after its ready identity")
            try:
                with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaisesRegex(ValueError if changed_ready else ModelBoundary,
                                               "classifier-ready identity" if changed_ready else "after real common initialization"):
                        consumer.main()
                common = consumer.common
                self.assertEqual(Path(common.__file__).resolve(), (COMMON / "common.py").resolve())
                if changed_ready:
                    self.assertIsNone(common.MODEL)
                    self.assertIsNone(common.DEVICE)
                    self.assertIsNone(common.LORA_TARGETS)
                    self.assertEqual(calls, [])
                    self.assertFalse((root / "trained").exists())
                else:
                    self.assertEqual(common.MODEL, snapshot)
                    self.assertEqual(common.DEVICE, config["device"])
                    self.assertEqual(common.FRAME, config["frame"])
                    self.assertEqual(common.LORA_TARGETS, config["lora_targets"])
                    self.assertIs(common.torch, torch)
                    self.assertIs(common.DecisionModel, constructor)
                    self.assertIs(common.collate, collate)
                    self.assertEqual(common.MAX_OPTIONS, 8)
                    self.assertIs(common.build, stand_in_decider.build)
                    self.assertIn((str(snapshot), {"dtype": "synthetic-bf16", "grad_ckpt": False}), calls)
                self.assertFalse((root / "score.json").exists())
                self.assertFalse((root / "trained" / "adapter_model.safetensors").exists())
            finally:
                if hasattr(consumer, "faulthandler"):
                    consumer.faulthandler.cancel_dump_traceback_later()

    def test_trainer_initializes_the_real_shared_helper_before_model_construction(self):
        self.check_consumer("train-voice-adapter.py", training_argv)

    def test_scorer_initializes_the_real_shared_helper_before_model_construction(self):
        self.check_consumer("score-voice-adapter.py", scoring_argv)

    def test_trainer_refuses_changed_ready_bytes_without_initializing_the_helper(self):
        self.check_consumer("train-voice-adapter.py", training_argv, changed_ready=True)

    def test_scorer_refuses_changed_ready_bytes_without_initializing_the_helper(self):
        self.check_consumer("score-voice-adapter.py", scoring_argv, changed_ready=True)


if __name__ == "__main__":
    unittest.main()
