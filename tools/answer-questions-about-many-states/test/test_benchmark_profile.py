"""Profile the component/caller protocol without model or numerical-library dependencies."""
import os
import sys
import types
import unittest
import importlib.util
import json
import math
import tempfile
from unittest import mock
from contextlib import nullcontext

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import benchmark


class Handle:
    def __init__(self, hooks, hook):
        self.hooks, self.hook = hooks, hook

    def remove(self):
        self.hooks.remove(self.hook)


class Module:
    def __init__(self, action=lambda: None):
        self.action, self.pre, self.post = action, [], []

    def register_forward_pre_hook(self, hook):
        self.pre.append(hook)
        return Handle(self.pre, hook)

    def register_forward_hook(self, hook):
        self.post.append(hook)
        return Handle(self.post, hook)

    def __call__(self):
        for hook in self.pre:
            hook(self, ())
        result = self.action()
        for hook in self.post:
            hook(self, (), result)
        return result


def fixture(fail=False):
    modeling = types.SimpleNamespace(torch_chunk_gated_delta_rule=lambda: None,
                                    torch_recurrent_gated_delta_rule=lambda: None)
    delta = Module(lambda: modeling.torch_chunk_gated_delta_rule())
    attention = Module(lambda: modeling.torch_recurrent_gated_delta_rule())
    mlps = [Module(), Module()]
    modules = [delta, mlps[0], attention, mlps[1]]
    engine = types.SimpleNamespace(core=types.SimpleNamespace(layers=[
        types.SimpleNamespace(linear_attn=delta, mlp=mlps[0]),
        types.SimpleNamespace(self_attn=attention, mlp=mlps[1])]))

    class PrefixCache:
        def __init__(self):
            pass

    class SchemaEngine:
        def __init__(self, value):
            if value is not engine:
                raise AssertionError("the existing engine must be reused")

        def prepare(self, rows, independent):
            if independent is not True:
                raise AssertionError("the original profile uses independent questions")
            for _ in rows:
                PrefixCache()
                for module in modules:
                    module()
            return len(rows)

        def score(self, handle, lines, temperature):
            if temperature != 1.25 or len(lines) != 1:
                raise AssertionError("profile must preserve the stored temperature and one-state calls")
            for module in modules:
                module()
            if fail:
                raise RuntimeError("synthetic reference failure")
            return [[[0.25, 0.75] for _ in range(handle)]]

        def tokenize(self, handle, line):
            return list(line), []

    tick = [0.0]

    def clock():
        tick[0] += 0.01
        return tick[0]

    schema = types.SimpleNamespace(PrefixCache=PrefixCache, SchemaEngine=SchemaEngine, fill_ids=lambda *a: None)
    return engine, modules, modeling, schema, clock


class ComponentProfile(unittest.TestCase):
    def run_profile(self, engine, modeling, schema, clock):
        return benchmark.profile_reference(engine, [{"options": ["no", "yes"]}] * 2,
                                           ["box", "lamp"], 1.25, device="cpu",
                                           torch=types.SimpleNamespace(device=lambda _: nullcontext()), schema_engine=schema,
                                           modeling=modeling, clock=clock)

    def test_components_count_real_calls_and_restore_between_runs(self):
        engine, modules, modeling, schema, clock = fixture()
        original = (modeling.torch_chunk_gated_delta_rule, modeling.torch_recurrent_gated_delta_rule,
                    schema.PrefixCache.__init__)
        for _ in range(2):
            result = self.run_profile(engine, modeling, schema, clock)
            self.assertEqual(result["calls"], {
                "per-question state copies (PrefixCache)": 2,
                "gated-delta scan (chunked reference)": 4,
                "gated-delta scan (recurrent reference)": 4,
                "gated-delta layer (whole)": 4,
                "full-attention layer (whole)": 4,
                "MLP": 8})
            self.assertEqual(result["suffix_tokens"], [3, 4])
            self.assertEqual(result["probs"], [[[0.25, 0.75]] * 2] * 2)
            self.assertGreater(result["prepare_seconds"], 0)
            self.assertEqual(len(result["line_seconds"]), 2)
            self.assertTrue(all(x > 0 for x in result["prepare_spent"].values()))
            self.assertTrue(all(x > 0 for x in result["line_spent"].values()))
            self.assertEqual((modeling.torch_chunk_gated_delta_rule, modeling.torch_recurrent_gated_delta_rule,
                              schema.PrefixCache.__init__), original)
            self.assertTrue(all(not m.pre and not m.post for m in modules))

    def test_reference_failure_restores_patches_and_hooks(self):
        engine, modules, modeling, schema, clock = fixture(fail=True)
        original = (modeling.torch_chunk_gated_delta_rule, modeling.torch_recurrent_gated_delta_rule,
                    schema.PrefixCache.__init__)
        with self.assertRaisesRegex(RuntimeError, "synthetic reference failure"):
            self.run_profile(engine, modeling, schema, clock)
        self.assertEqual((modeling.torch_chunk_gated_delta_rule, modeling.torch_recurrent_gated_delta_rule,
                          schema.PrefixCache.__init__), original)
        self.assertTrue(all(not m.pre and not m.post for m in modules))


    def test_reference_engine_convolution_is_applied_and_restored_on_failure(self):
        original, configured = object(), object()
        modeling = types.SimpleNamespace(causal_conv1d_fn=original)
        calls = []

        def patch_conv():
            calls.append("owned engine setup")
            modeling.causal_conv1d_fn = configured

        engine = types.SimpleNamespace(patch_conv=patch_conv)
        for fail in (False, True):
            try:
                with benchmark.S.reference_convolution(engine_module=engine, modeling_module=modeling):
                    self.assertIs(modeling.causal_conv1d_fn, configured)
                    if fail:
                        raise RuntimeError("synthetic engine failure")
            except RuntimeError as error:
                self.assertEqual(str(error), "synthetic engine failure")
            self.assertIs(modeling.causal_conv1d_fn, original)
        self.assertEqual(calls, ["owned engine setup"] * 2)

    def test_reference_input_staging_is_blocking_and_restored_on_failure(self):
        calls, staged = [], object()

        class Tensor:
            def to(self, device, non_blocking):
                calls.append((device, non_blocking))
                return staged

        original = lambda *a: Tensor()
        schema = types.SimpleNamespace(fill_ids=original)
        torch = types.SimpleNamespace(device=lambda _: nullcontext())
        with self.assertRaisesRegex(RuntimeError, "synthetic staging failure"):
            with benchmark.S.reference_inputs("mps", torch_module=torch, schema_module=schema):
                self.assertIs(schema.fill_ids([], 0, 0, 0), staged)
                raise RuntimeError("synthetic staging failure")
        self.assertIs(schema.fill_ids, original)
        self.assertEqual(calls, [("mps", False)])


@unittest.skipUnless(os.environ.get("WRITING_LEGACY_BENCHMARK") and os.environ.get("WRITING_DECIDER_SOURCE"),
                     "needs the unchanged original benchmark and reference-package source for the synthetic adoption check")
class OriginalCallerAdoption(unittest.TestCase):
    def test_reference_slot_reader_matches_cpu_on_synthetic_logits(self):
        import torch
        previous_path = sys.path[:]
        sys.path.insert(0, os.environ["WRITING_DECIDER_SOURCE"])
        try:
            from decider.engine import read_slots
            device = os.environ.get("WRITING_PROFILE_DEVICE", "cpu")
            values = torch.arange(80, dtype=torch.float32).reshape(2, 5, 8) / 10
            expected = read_slots(values, [0, 1], [2, 4], [2, 3], 1.18, [2])[0]
            on_device = values.to(device)
            for _ in range(32):
                with torch.device(device):
                    actual = read_slots(on_device, [0, 1], [2, 4], [2, 3], 1.18, [2])[0]
                idx = torch.tensor([[0, 1], [2, 4], [2, 3]], dtype=torch.long, device=device)
                logits = on_device[idx[0], idx[1]]
                logits = logits.masked_fill(torch.arange(8, device=device)[None, :] >= idx[2][:, None], float("-inf"))
                blocking = torch.softmax(logits / 1.18, -1).cpu()
                actual_diff = float(torch.max(torch.abs(actual - expected)))
                blocking_diff = float(torch.max(torch.abs(blocking - expected)))
                if not math.isfinite(actual_diff) or actual_diff >= 1e-6 or blocking_diff >= 1e-6:
                    print(json.dumps({"device": device, "legacy_slot_max_diff": actual_diff,
                                      "direct_device_index_max_diff": blocking_diff,
                                      "expected": expected.tolist(), "actual": actual.tolist(),
                                      "direct_device_index": blocking.tolist()}), flush=True)
                self.assertLess(blocking_diff, 1e-6)
                self.assertLess(float(torch.max(torch.abs(actual - expected))), 1e-6)
        finally:
            sys.path[:] = previous_path

    def test_original_and_maintained_profile_use_the_same_engine_and_inputs(self):
        import torch
        from test_end_to_end import made_up_folder
        import test_questions_first

        spec = importlib.util.spec_from_file_location("original_benchmark_fixture", os.environ["WRITING_LEGACY_BENCHMARK"])
        original = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(original)
        previous_path = sys.path[:]
        sys.path.insert(0, os.environ["WRITING_DECIDER_SOURCE"])
        from decider import schema_engine
        from decider.engine import Engine
        from transformers.models.qwen3_5 import modeling_qwen3_5 as modeling

        saved = (modeling.torch_chunk_gated_delta_rule, modeling.torch_recurrent_gated_delta_rule,
                 schema_engine.PrefixCache.__init__, modeling.causal_conv1d_fn)

        def restore():
            (modeling.torch_chunk_gated_delta_rule, modeling.torch_recurrent_gated_delta_rule,
             schema_engine.PrefixCache.__init__, modeling.causal_conv1d_fn) = saved

        try:
            with tempfile.TemporaryDirectory() as folder:
                with mock.patch.dict(test_questions_first.TINY, {"linear_num_key_heads": 1,
                                                                "linear_num_value_heads": 2}):
                    made_up_folder(folder)
                config_path = os.path.join(folder, "tokenizer_config.json")
                with open(config_path) as file:
                    config = json.load(file)
                config["tokenizer_class"] = "PreTrainedTokenizerFast"
                with open(config_path, "w") as file:
                    json.dump(config, file)

                device = os.environ.get("WRITING_PROFILE_DEVICE", "cpu")
                dtype = os.environ.get("WRITING_PROFILE_DTYPE", "float32")
                original.SNAPSHOT, original.TORCH_DEVICE, original.TORCH_DTYPE = folder, device, dtype
                before = original.torch_reference(2, 2, timing=True)
                restore()
                with benchmark.S.reference_convolution():
                    engine = Engine(folder, device=device, dtype=getattr(torch, dtype),
                                    use_graphs=False, compile=False)
                    rows = original._rows(original.synthetic_questions(2), True)
                    with torch.no_grad():
                        after = benchmark.profile_reference(engine, rows, original.synthetic_lines(2), 1.18,
                                                            device=device, torch=torch,
                                                            schema_engine=schema_engine, modeling=modeling)
                self.assertEqual([[len(row) for row in state] for state in before["probs"]],
                                 [[len(row) for row in state] for state in after["probs"]])
                self.assertEqual(before["suffix_tokens"], after["suffix_tokens"])
                self.assertEqual(set(before["prepare_spent"]), set(after["prepare_spent"]))
                self.assertEqual(set(before["line_spent"]), set(after["line_spent"]))
                for name, count in before["calls"].items():
                    self.assertEqual(after["calls"][name], count, name)
                self.assertTrue(all(value >= 0 for value in after["prepare_spent"].values()))
                self.assertTrue(all(value >= 0 for value in after["line_spent"].values()))
                def health(result):
                    rows = [row for state in result["probs"] for row in state]
                    return {"rows": len(rows),
                            "nonfinite": sum(not all(math.isfinite(x) for x in row) for row in rows),
                            "unnormalized": sum(all(math.isfinite(x) for x in row) and abs(sum(row) - 1.0) > 1e-3
                                                for row in rows)}

                print(json.dumps({"scope": "original-versus-maintained telemetry adoption only",
                                  "device": device, "dtype": dtype,
                                  "shared_calls": before["calls"], "suffix_tokens": after["suffix_tokens"],
                                  "original_probability_health": health(before),
                                  "maintained_probability_health": health(after),
                                  "numerical_qualification": False}), flush=True)
        finally:
            restore()
            sys.path[:] = previous_path


if __name__ == "__main__":
    unittest.main()
