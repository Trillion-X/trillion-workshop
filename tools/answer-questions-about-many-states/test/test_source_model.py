"""Exercise the captured framework loader against the retained raw tensor forward; no downloaded model."""
import json
import importlib.util
import os
import sys
import tempfile
import unittest
from unittest import mock
from dataclasses import replace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "..", "do-work")]

HAS_FRAMEWORK = all(importlib.util.find_spec(name) is not None for name in ("mlx", "numpy", "mlx_lm"))
if HAS_FRAMEWORK:
    import mlx.core as mx
    import numpy as np
    from questions_first.backbone import Backbone, Config
    from questions_first.engine import QuestionsFirst
    from test_questions_first import TINY, tol
    from synthetic import SyntheticTokenizer


@unittest.skipUnless(HAS_FRAMEWORK, "needs the declared classifier-framework Python profile (mlx, numpy and mlx_lm)")
class SourceModel(unittest.TestCase):
    def test_actual_shared_answers_match_indexed_reference_and_assembled_semantics(self):
        from agree_with_reference import compare_answers, compare_probabilities
        from questions_first import prompt as P
        raw = Backbone.random(Config(TINY), mx.float32, seed=23, std=0.2)
        tok = SyntheticTokenizer()
        states = ["A parcel arrived.", {"item": "lamp", "state": "warm"}]
        cases = [
            ("choice", {"type": "choice", "instructions": "Which item arrived?", "criteria": ["parcel", "lamp", "ticket"]}, False),
            ("noul", {"type": "noul", "instructions": "Is the lamp warm?"}, False),
            ("score", {"type": "score", "instructions": "How warm is the lamp?", "criteria": ["cold", "warm", "hot"]}, False),
            ("isolated", {"type": "score", "instructions": "How warm is the lamp?", "criteria": ["cold", "warm", "hot"]}, True),
        ]
        for key, spec, isolated in cases:
            with self.subTest(kind=key):
                rendered = {key: P.render_question(spec)}
                rows, index = P.plan_rows(rendered, isolated=isolated)
                mine = np.zeros((len(states), len(rows), max(len(row["options"]) for row in rows)))
                reference = np.zeros_like(mine)
                for q, row in enumerate(rows):
                    qf = QuestionsFirst(raw, tok, 0, temperature=1.18, tokens_per_batch=128)
                    prepared = qf.prepare([row])
                    self.assertIsNotNone(prepared.shared)
                    callbacks = []
                    actual = qf.score(prepared, [P.render_state(state) for state in states],
                                      on_done=lambda fresh, values: callbacks.extend((state, values[state].copy()) for state in fresh))
                    # This route retains CPU float64 normalization of actual indexed logits;
                    # it neither calls the shared MLX softmax nor copies its probabilities.
                    expected = qf.score(replace(prepared, shared=None), [P.render_state(state) for state in states])
                    self.assertEqual(sorted(state for state, _ in callbacks), list(range(len(states))))
                    self.assertEqual(len(callbacks), len(states))
                    for state, values in callbacks:
                        self.assertTrue(np.array_equal(values, actual[state]))
                    n = len(row["options"])
                    mine[:, q, :n], reference[:, q, :n] = actual[:, 0, :n], expected[:, 0, :n]
                comparison = compare_probabilities(mine.tolist(),
                    [[list(reference[state, q, :len(row["options"])]) for q, row in enumerate(rows)] for state in range(len(states))],
                    [len(row["options"]) for row in rows], len(states), tol(0.0001))
                self.assertLess(comparison["max_abs_diff"], tol(0.0001))
                self.assertEqual(comparison["argmax_agreement"], 1)
                actual_json = [P.assemble(rendered, index, state) for state in mine]
                expected_json = [P.assemble(rendered, index, state) for state in reference]
                # The existing independent checker rejects malformed domains, selected-choice
                # contradictions, inconsistent confidence, rounding and isolated fit mass.
                assembled = compare_answers(actual_json, expected_json)
                self.assertLess(assembled["answers_max_abs_diff"], tol(0.0001))
                if key == "choice":
                    self.assertEqual(assembled["answer_choice_agreement"], 1)
                    for answer in actual_json:
                        value = answer[key]
                        self.assertEqual(value["confidence"], max(value["probabilities"].values()))
                        self.assertEqual(value["probabilities"][value["choice"]], value["confidence"])
                if isolated:
                    for answer in actual_json:
                        value = answer[key]
                        self.assertAlmostEqual(sum(value["level_fit"].values()), value["fit_mass"], delta=(len(rows) + 1) * 0.5e-4)
                # Execute the controller's actual render/plan/assemble/callback entry as well.
                whole = QuestionsFirst(raw, tok, 0, temperature=1.18, tokens_per_batch=128)
                callbacks = {}
                def received(batch):
                    for state, answer in batch:
                        self.assertNotIn(state, callbacks)
                        callbacks[state] = answer
                whole.answer_questions({key: spec}, states, independent=True, isolated_levels=isolated,
                    max_state_tokens=32768, on_answers=received, should_stop=lambda: False, timings={})
                self.assertEqual(sorted(callbacks), list(range(len(states))))
                callback_check = compare_answers([callbacks[state] for state in range(len(states))], expected_json)
                self.assertLess(callback_check["answers_max_abs_diff"], tol(0.0001))
                if key == "choice":
                    self.assertEqual(callback_check["answer_choice_agreement"], 1)

    def test_zero_fit_json_comes_from_actual_shared_and_indexed_probabilities(self):
        from agree_with_reference import compare_answers, compare_probabilities
        from questions_first import prompt as P
        raw = Backbone.random(Config(TINY), mx.float32, seed=29, std=0.2)
        tok = SyntheticTokenizer()
        rendered = {"fit": P.render_question({"type": "score", "instructions": "How warm is the lamp?", "criteria": ["cold", "warm"]})}
        rows, index = P.plan_rows(rendered, isolated=True)
        actual_rows, reference_rows = [], []
        state = "A lamp glowed."
        for row in rows:
            qf = QuestionsFirst(raw, tok, 0, temperature=1.18, tokens_per_batch=128)
            prepared = qf.prepare([row])
            prefix = P.prefix_ids(tok, qf.labels, [row])
            suffix, slots = P.suffix_ids(tok, state, 1, 32768)
            ids = prefix + suffix
            hidden, _ = raw.forward(mx.array([ids]), mx.arange(len(ids))[None],
                                   mx.tril(mx.ones((len(ids), len(ids)), dtype=mx.bool_))[None, None])
            # A generated output head makes "yes" underflow to exactly zero. The forward,
            # both softmax paths and assembler remain real; no probabilities are mocked.
            direction = hidden[0, len(prefix) + slots[0]].astype(mx.float32)
            head = mx.stack([direction * 1000, -direction * 1000])
            qf.W = qf.letters = head
            actual = qf.score(prepared, [state])
            expected = qf.score(replace(prepared, shared=None), [state])
            compare_probabilities(actual.tolist(), expected.tolist(), [2], 1, 0)
            self.assertTrue(np.array_equal(actual, expected))
            self.assertEqual(actual[0, 0].tolist(), [1.0, 0.0])
            actual_rows.append(actual[0, 0].tolist())
            reference_rows.append(expected[0, 0].tolist())
        actual_json = {"fit": P.assemble(rendered, index, actual_rows)["fit"]}
        reference_json = {"fit": P.assemble(rendered, index, reference_rows)["fit"]}
        # This fixed boundary expectation independently specifies the established zero-fit
        # contract, rather than validating the assembler by comparing it with itself.
        expected_json = {"fit": {"type": "score", "score": 0.0, "confidence": 0.0, "certainty": 1.0,
            "legend": {"0": "cold", "1": "warm"}, "probabilities": {"0": 0.0, "1": 0.0},
            "level_fit": {"0": 0.0, "1": 0.0}, "fit_mass": 0.0}}
        self.assertEqual(actual_json, expected_json)
        self.assertEqual(reference_json, expected_json)
        self.assertEqual(compare_answers([actual_json], [expected_json])["answers_max_abs_diff"], 0)

    def test_one_prefix_uses_captured_prepare_answer_and_broadcasts_without_gathering(self):
        import mlx_decider_core as core
        raw = Backbone.random(Config(TINY), mx.float32, seed=3, std=0.2)
        tok = SyntheticTokenizer()
        qf = QuestionsFirst(raw, tok, 0, temperature=1.18, tokens_per_batch=128)
        rows = [{"question": "Which parcel arrives?", "options": ["late", "early", "on time"]}]
        states = ["A parcel arrived.", "A lamp glowed for a long time.", "x"]
        with mock.patch.object(qf, "_prepare_shared", wraps=qf._prepare_shared) as prepare:
            prepared = qf.prepare(rows)
            prepare.assert_called_once()
        self.assertIsNotNone(prepared.shared)
        before = [np.array(value.astype(mx.float32)) for pair in prepared.shared.states for value in pair]
        handed = []
        with mock.patch.object(qf, "_answer", wraps=qf._answer) as answer:
            shared = qf.score(prepared, states, on_done=lambda fresh, _: handed.extend(fresh))
            self.assertGreater(answer.call_count, 0)
        indexed = qf.score(replace(prepared, shared=None), states)
        self.assertLess(np.abs(shared - indexed).max(), tol(0.0001))
        self.assertEqual(sorted(handed), [0, 1, 2])
        self.assertEqual(len(handed), len(set(handed)))
        for old, value in zip(before, [value for pair in prepared.shared.states for value in pair]):
            self.assertTrue(np.array_equal(old, np.array(value.astype(mx.float32))))
        completed = []
        qf.tokens_per_batch = 1
        qf.score(prepared, states, on_batch=lambda done, _: completed.append(done), should_stop=lambda: bool(completed))
        self.assertLess(len(completed[-1]), len(states))

        class Prefix:
            shape = (1, 2, 4, 8)
            def __getitem__(self, _):
                raise AssertionError("a uniform prefix must not be advanced-indexed")
        with mock.patch.object(core.mx, "broadcast_to", side_effect=lambda value, _: value):
            keys, values = Prefix(), Prefix()
            cache = core._keys_for_prefix(keys, values, 3, object())
            self.assertIs(cache.keys, keys)
            self.assertIs(cache.values, values)

    def test_padding_materializes_only_the_requested_batch(self):
        raw = Backbone.random(Config(TINY), mx.float32, seed=1, std=0.2)
        tok = SyntheticTokenizer()
        qf = QuestionsFirst(raw, tok, 0, tokens_per_batch=1)
        prepared = qf.prepare([{"question": "Which parcel?", "options": ["late", "early"]}])
        suffixes = [qf.tokenize(prepared, f"A parcel number {index} arrived.", 32768) for index in range(20)]
        with mock.patch.object(mx, "array", wraps=mx.array) as arrays:
            batches = qf._batches(prepared, suffixes)
            self.assertEqual(arrays.call_count, 0)
            pairs, ids, last = next(batches)
            self.assertEqual(len(pairs), 1)
            self.assertEqual(arrays.call_count, 2, "future padded batches must not allocate before cancellation can run")
            self.assertEqual(ids.shape[0], 1)
            self.assertEqual(int(last[0]), len(suffixes[pairs[0][0]][0]) - 1)

    def test_loaded_native_layers_equal_raw_forward_without_roundtripping_checkpoint_scales(self):
        rows = [{"question": "Which parcel?", "options": ["late", "early"]},
                {"question": "Which lamp glows long after sunset?", "options": ["blue", "green", "white"]}]
        states = ["A parcel arrived.", "The warm lamp glowed for a long time."]
        tok = SyntheticTokenizer()
        for dtype in (mx.float32, mx.bfloat16):
            with self.subTest(dtype=str(dtype)), tempfile.TemporaryDirectory() as folder:
                config = dict(TINY, layer_types=["full_attention", "linear_attention", "full_attention", "linear_attention"],
                              tie_word_embeddings=False)
                raw = Backbone.random(Config(config), dtype, seed=42, std=0.2)
                raw.w["lm_head.weight"] = (mx.random.normal(raw.w["embed_tokens.weight"].shape) * 0.2).astype(dtype)
                # Values below one bfloat16 ULP must survive as float32 checkpoint scales.
                for name in list(raw.w):
                    if name.endswith(("input_layernorm.weight", "post_attention_layernorm.weight", "q_norm.weight", "k_norm.weight")) or name == "norm.weight":
                        raw.w[name] = mx.full(raw.w[name].shape, 0.0031, dtype=mx.float32)
                with open(os.path.join(folder, "config.json"), "w") as file:
                    json.dump(config, file)
                with open(os.path.join(folder, "decider_config.json"), "w") as file:
                    json.dump({"temperature_schema_first": 1.18}, file)
                # Multiple files exercise the existing raw owner's shard support.
                entries = list(raw.w.items())
                for part, portion in enumerate((entries[::2], entries[1::2])):
                    mx.save_safetensors(os.path.join(folder, f"model-{part}.safetensors"),
                                        {"model." + key: value for key, value in portion})
                loaded = Backbone.load(folder, dtype)
                for name, value in raw.w.items():
                    self.assertTrue(np.array_equal(np.array(value.astype(mx.float32)),
                                                   np.array(loaded.w[name].astype(mx.float32))), name)
                self.assertEqual([layer.is_linear for layer in loaded.source_model.core.layers], [False, True, False, True])
                self.assertEqual(loaded.source_model.core.norm.weight.dtype, mx.float32)
                self.assertLess(float(mx.abs(loaded.source_model.core.norm.weight - 1.0031).max()), 1e-7)
                for independent in (True, False):
                    a = QuestionsFirst(raw, tok, 0, temperature=1.18, tokens_per_batch=1024)
                    b = QuestionsFirst(loaded, tok, 0, temperature=1.18, tokens_per_batch=1024)
                    expected = a.score(a.prepare(rows, independent=independent), states)
                    prepared = b.prepare(rows, independent=independent)
                    before = {(layer, index): np.array(value.astype(mx.float32))
                              for layer, values in prepared.cache.items() for index, value in enumerate(values) if value is not None}
                    actual = b.score(prepared, states)
                    # Use the existing numerical suite's measured Apple-GPU bound: native
                    # Conv1d and the raw convolution sum execute different reduction orders.
                    self.assertLess(np.abs(expected - actual).max(), 0.005 if dtype == mx.bfloat16 else tol(0.0001))
                    for (layer, index), value in before.items():
                        self.assertTrue(np.array_equal(value, np.array(prepared.cache[layer][index].astype(mx.float32))))
                facade = loaded._captured_core_facade.core
                self.assertIs(facade.layers[1].linear_attn, loaded.source_model.core.layers[1].linear_attn)
                self.assertIs(facade.layers[0].mlp, loaded.source_model.core.layers[0].mlp)
                self.assertIs(facade.layers[0].self_attn.native, loaded.source_model.core.layers[0].self_attn)


if __name__ == "__main__":
    unittest.main()
