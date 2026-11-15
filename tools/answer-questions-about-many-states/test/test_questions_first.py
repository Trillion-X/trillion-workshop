"""The MLX forward on its own: the kernel, the triangular inverse, the cache and the batching, over a tiny made-up
config and synthetic weights. Agreement with the decider's PyTorch code is agree_with_reference.py."""
import os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "do-work"))

import importlib.util  # noqa: E402

import synthetic as S  # noqa: E402
from questions_first import prompt as P  # noqa: E402

HAS_MLX = all(importlib.util.find_spec(m) is not None for m in ("mlx", "numpy"))
if HAS_MLX:
    import numpy as np
    import mlx.core as mx
    from questions_first.backbone import Backbone, Config
    from questions_first.engine import QuestionsFirst
    from questions_first.gated_delta import chunk_gated_delta_rule, recurrent_gated_delta_rule, unit_lower_inverse
    from mlx_decider_core import _CentredNorm
needs_mlx = unittest.skipUnless(HAS_MLX, "needs mlx and numpy (python3 -m pip install mlx numpy; on Linux mlx[cpu])")

# On Apple's GPU, float32 matmuls and reductions run in a different order than on the CPU; the Mac measured at most
# 1.2e-3 between two exact forms (M5 Max, 2026-11-05). There every bound is 5e-3, half the 0.01 the decider must be
# matched within; on the CPU each keeps its own tighter bound.
ON_GPU = HAS_MLX and mx.default_device() == mx.gpu


def tol(cpu):
    return 5e-3 if ON_GPU else cpu

TINY = {"model_type": "qwen3_5_text", "hidden_size": 64, "intermediate_size": 128, "num_hidden_layers": 4,
        "layer_types": ["linear_attention", "linear_attention", "linear_attention", "full_attention"],
        "rms_norm_eps": 1e-6, "vocab_size": 62000, "num_attention_heads": 4, "num_key_value_heads": 2, "head_dim": 16,
        "rope_parameters": {"rope_theta": 10000000, "partial_rotary_factor": 0.25, "rope_type": "default"},
        "linear_num_key_heads": 2, "linear_num_value_heads": 2, "linear_key_head_dim": 32, "linear_value_head_dim": 32,
        "linear_conv_kernel_dim": 4, "tie_word_embeddings": True, "attention_bias": False}


def tiny(seed=0):
    return Backbone.random(Config(TINY), mx.float32, seed=seed, std=0.2)


def full_forward_logits(bb, qf, ids, slots):
    """Run prefix + suffix as one plain sequence, no cache: the logits at the slots."""
    T = len(ids)
    mask = mx.tril(mx.ones((T, T), dtype=mx.bool_))[None, None]
    h, _ = bb.forward(mx.array([ids]), mx.arange(T)[None], mask)
    return np.array((h[0, mx.array(slots)] @ qf.W.T).astype(mx.float32))


class ReferenceComparison(unittest.TestCase):
    def test_assembled_probability_domains_and_rounding_are_independent_of_model_error(self):
        from agree_with_reference import compare_answers
        for valid, invalid in (({"type": "choice", "choice": "yes", "probabilities": {"no": 0.001, "yes": 0.999}},
                                {"type": "choice", "choice": "yes", "probabilities": {"no": -0.001, "yes": 1.001}}),
                               ({"type": "noul", "noul": 0.0}, {"type": "noul", "noul": -0.005}),
                               ({"type": "choice", "choice": "yes", "probabilities": {"no": 0.25, "yes": 0.75}},
                                {"type": "choice", "choice": "yes", "probabilities": {"no": 0.25, "yes": 0.745}})):
            for actual, expected in ((valid, invalid), (invalid, valid)):
                with self.subTest(actual=actual, expected=expected), self.assertRaises(ValueError):
                    compare_answers([{"q": actual}], [{"q": expected}])
        rounded = [{"q": {"type": "choice", "choice": "a", "probabilities": {"a": 0.3333, "b": 0.3333, "c": 0.3333}}}]
        self.assertEqual(compare_answers(rounded, rounded)["answers_max_abs_diff"], 0)
        rqs = {"q": P.render_question({"type": "score", "instructions": "How warm?", "criteria": ["cold", "warm"]})}
        _, index = P.plan_rows(rqs)
        zero_fit = [P.assemble(rqs, index, [[1.0, 0.0], [1.0, 0.0]])]
        self.assertEqual(zero_fit[0]["q"]["fit_mass"], 0)
        self.assertEqual(compare_answers(zero_fit, zero_fit)["answers_max_abs_diff"], 0)
        for answer in ({"type": "noul", "noul": 0.5, "confidence": -0.001},
                       {"type": "noul", "noul": 0.5, "certainty": 1.001},
                       {"type": "choice", "choice": "yes", "confidence": 0.745, "probabilities": {"no": 0.25, "yes": 0.75}},
                       {"type": "score", "score": 0.0, "legend": {"0": "low", "1": "high"}, "level_fit": {"0": 0.0, "1": 0.0}, "fit_mass": -0.005},
                       {"type": "score", "score": 0.0, "legend": {"0": "low", "1": "high"}, "level_fit": {"0": -0.001, "1": 0.0}, "fit_mass": 0.0}):
            with self.subTest(answer=answer), self.assertRaises(ValueError):
                compare_answers([{"q": answer}], [{"q": answer}])

    def test_normalization_bound_is_independent_of_agreement_tolerance(self):
        from agree_with_reference import compare_probabilities
        row = [[[0.10000000149, 0.20000000298, 0.69999998808]]]
        self.assertEqual(compare_probabilities(row, row, [3], 1, 0)["max_abs_diff"], 0)
        with self.assertRaisesRegex(ValueError, "unnormalized"):
            compare_probabilities([[[0.25, 0.745]]], [[[0.25, 0.745]]], [2], 1, 0.01)

    def test_complete_assembled_answers_are_checked(self):
        import copy
        from agree_with_reference import compare_answers
        actual = [{"q": {"type": "choice", "choice": "yes", "probabilities": {"no": 0.25, "yes": 0.75}}}]
        for change in (lambda q: q.update(choice="no"), lambda q: q.update(type="score"),
                       lambda q: q.update(probabilities={}), lambda q: q.update(legend={}),
                       lambda q: q["probabilities"].update(yes=float("nan"))):
            expected = copy.deepcopy(actual)
            change(expected[0]["q"])
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                compare_answers(actual, expected)
        with self.assertRaisesRegex(ValueError, "keys differ"):
            compare_answers(actual, [{**actual[0], "extra": actual[0]["q"]}])
        self.assertEqual(compare_answers(actual, actual)["answers_max_abs_diff"], 0)

    def test_small_valid_choice_flip_is_reported_separately_from_numerical_difference(self):
        from agree_with_reference import compare_answers
        actual = [{"q": {"type": "choice", "choice": "yes", "probabilities": {"no": 0.4999, "yes": 0.5001}}}]
        expected = [{"q": {"type": "choice", "choice": "no", "probabilities": {"no": 0.5001, "yes": 0.4999}}}]
        result = compare_answers(actual, expected)
        self.assertLess(result["answers_max_abs_diff"], 0.01)
        self.assertEqual(result["answer_choice_agreement"], 0)

    def test_finite_rows_and_zero_padding_compare(self):
        from agree_with_reference import compare_probabilities
        result = compare_probabilities([[[0.25, 0.75, 0.0]]], [[[0.25, 0.75]]], [2], 1, 0.01)
        self.assertEqual(result["max_abs_diff"], 0)
        self.assertEqual(result["rows"], 1)
        self.assertEqual(result["argmax_agreement"], 1)

    def test_nonfinite_probabilities_never_report_agreement(self):
        from agree_with_reference import compare_probabilities
        for value in (float("nan"), float("inf"), -float("inf")):
            for actual, expected in (([[[value, 0.75]]], [[[0.25, 0.75]]]),
                                     ([[[0.25, 0.75]]], [[[value, 0.75]]]),
                                     ([[[0.25, 0.75, value]]], [[[0.25, 0.75]]])):
                with self.subTest(value=value), self.assertRaisesRegex(ValueError, "nonfinite"):
                    compare_probabilities(actual, expected, [2], 1, 0.01)

    def test_missing_states_rows_options_and_invalid_probabilities_are_refused(self):
        from agree_with_reference import compare_probabilities
        for actual, expected in (([], [[[0.25, 0.75]]]), ([[[0.25, 0.75]]], []),
                                 ([[]], [[[0.25, 0.75]]]), ([[[0.25]]], [[[0.25, 0.75]]]),
                                 ([[[0.25, 0.75]]], [[[0.25]]]),
                                 ([[[0.0, 0.0]]], [[[0.25, 0.75]]]),
                                 ([[[-0.1, 1.1]]], [[[0.25, 0.75]]]),
                                 ([[[0.25, 0.75, 0.1]]], [[[0.25, 0.75]]])):
            with self.subTest(actual=actual, expected=expected), self.assertRaises(ValueError):
                compare_probabilities(actual, expected, [2], 1, 0.01)


@needs_mlx
class Kernel(unittest.TestCase):
    def test_chunked_equals_recurrent(self):
        rng = np.random.default_rng(1)
        B, T, H, D = 2, 133, 3, 8
        q, k, v = (rng.standard_normal((B, T, H, D)).astype(np.float32) for _ in range(3))
        k += 1.5
        g = (-np.abs(rng.standard_normal((B, T, H))) * 0.2).astype(np.float32)
        beta = (1 / (1 + np.exp(-rng.standard_normal((B, T, H))))).astype(np.float32)
        s0 = (rng.standard_normal((B, H, D, D)) * 0.1).astype(np.float32)
        a = [mx.array(x) for x in (q, k, v, g, beta, s0)]
        o1, s1 = chunk_gated_delta_rule(*a)
        o2, s2 = recurrent_gated_delta_rule(*a)
        self.assertLess(float(mx.abs(o1 - o2).max()), tol(1e-5))
        self.assertLess(float(mx.abs(s1 - s2).max()), tol(1e-5))

    def test_unit_lower_inverse_with_correlated_entries(self):
        rng = np.random.default_rng(2)
        n = np.tril(0.9 + 0.1 * rng.random((5, 64, 64)), -1).astype(np.float32)
        inv = np.array(unit_lower_inverse(mx.array(n)))
        eye = np.eye(64, dtype=np.float32)
        self.assertLess(np.abs((eye + n) @ inv - eye).max(), tol(1e-3))


@needs_mlx
class Cache(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tok = S.SyntheticTokenizer()
        cls.bb = tiny()
        cls.qf = QuestionsFirst(cls.bb, cls.tok, 0, temperature=1.0, tokens_per_batch=256)
        cls.rows = [{"question": "Is the lamp warm?", "options": ["no", "yes"]},
                    {"question": "Which thing is the late one?", "options": ["parcel", "river", "violin"]},
                    {"question": "Which is it, a much longer question so the prefixes differ in length?", "options": ["a", "b", "c", "d"]}]
        cls.states = ["The warm lamp glowed.", "The late parcel arrived and the river grew, then stopped.", "x"]

    def test_independent_rows_equal_the_plain_sequence(self):
        h = self.qf.prepare(self.rows, independent=True)
        got = self.qf.score(h, self.states)
        for s, st in enumerate(self.states):
            for q, r in enumerate(self.rows):
                pre = P.prefix_ids(self.tok, self.qf.labels, [r])
                suf, slots = P.suffix_ids(self.tok, st, 1, 32768)
                lg = full_forward_logits(self.bb, self.qf, pre + suf, [len(pre) + x for x in slots])[0][:len(r["options"])]
                p = np.exp(lg - lg.max()); p /= p.sum()
                self.assertLess(np.abs(got[s, q, :len(p)] - p).max(), tol(1e-4), (s, q))

    def test_packed_rows_equal_the_plain_sequence(self):
        h = self.qf.prepare(self.rows, independent=False)
        got = self.qf.score(h, self.states)
        pre = P.prefix_ids(self.tok, self.qf.labels, self.rows)
        for s, st in enumerate(self.states):
            suf, slots = P.suffix_ids(self.tok, st, len(self.rows), 32768)
            lg = full_forward_logits(self.bb, self.qf, pre + suf, [len(pre) + x for x in slots])
            for q, r in enumerate(self.rows):
                z = lg[q][:len(r["options"])]
                p = np.exp(z - z.max()); p /= p.sum()
                self.assertLess(np.abs(got[s, q, :len(p)] - p).max(), tol(1e-4), (s, q))

    def test_batch_size_does_not_change_answers(self):
        wide = QuestionsFirst(self.bb, self.tok, 0, temperature=1.0, tokens_per_batch=1 << 20)
        a = self.qf.score(self.qf.prepare(self.rows, independent=True), self.states)
        b = wide.score(wide.prepare(self.rows, independent=True), self.states)
        self.assertLess(np.abs(a - b).max(), tol(1e-5))

    def test_stop_and_progress(self):
        h = self.qf.prepare(self.rows, independent=True)
        seen, handed = [], {}

        def on_done(fresh, probs):
            for s in fresh:
                self.assertNotIn(s, handed)                     # each state is handed on once, when it finishes
                handed[s] = probs[s].copy()
        out = self.qf.score(h, self.states, on_batch=lambda done, n: seen.append(list(done)), should_stop=lambda: len(seen) >= 1,
                            on_done=on_done)
        self.assertGreaterEqual(len(seen), 1)
        finished = set(seen[-1])
        self.assertLess(len(finished), len(self.states))
        self.assertEqual(set(handed), finished)
        for s in finished:
            self.assertTrue(np.allclose(out[s].sum(axis=-1), 1.0))
            self.assertTrue(np.array_equal(handed[s], out[s]))   # what was handed on is the state's final answer


@needs_mlx
class CapturedFacades(unittest.TestCase):
    def test_bfloat16_nonperiodic_layers_and_untied_head_keep_immutable_prefixes(self):
        cfg = dict(TINY, layer_types=["full_attention", "linear_attention", "full_attention", "linear_attention"],
                   tie_word_embeddings=False)
        bb = Backbone.random(Config(cfg), mx.bfloat16, seed=31, std=0.2)
        bb.w["lm_head.weight"] = (mx.random.normal(bb.w["embed_tokens.weight"].shape) * 0.2).astype(mx.bfloat16)
        tok = S.SyntheticTokenizer()
        rows = [{"question": "Which parcel?", "options": ["late", "early"]},
                {"question": "Which lamp remains warm after sunset?", "options": ["blue", "green", "white"]}]
        states = ["A parcel arrived.", "The warm lamp glowed for a long time."]
        qf = QuestionsFirst(bb, tok, tok.pad_token_id, temperature=1.18, tokens_per_batch=1024)
        self.assertTrue(np.array_equal(np.array(qf.W.astype(mx.float32)),
                                       np.array(bb.w["lm_head.weight"][mx.array(qf.labels.ids)].astype(mx.float32))))
        for independent in (True, False):
            prepared = qf.prepare(rows, independent=independent)
            before = {(layer, slot): np.array(value.astype(mx.float32)) for layer, values in prepared.cache.items()
                      for slot, value in enumerate(values) if value is not None}
            first = qf.score(prepared, states)
            second = qf.score(prepared, states)
            self.assertTrue(np.array_equal(first, second))
            for (layer, slot), value in before.items():
                self.assertTrue(np.array_equal(value, np.array(prepared.cache[layer][slot].astype(mx.float32))))
            for state in range(len(states)):
                self.assertTrue(np.allclose(first[state].sum(axis=-1), 1.0))
        forward = bb._captured_core_facade
        self.assertEqual([layer.is_linear for layer in forward.core.layers], [False, True, False, True])
        for layer, state in zip(forward.core.layers, forward.blank):
            self.assertEqual(state[0].dtype, mx.bfloat16)
            self.assertEqual(state[1].dtype, mx.float32 if layer.is_linear else mx.bfloat16)

    def test_raw_checkpoint_norm_uses_positive_one_plus_weight_in_float32(self):
        weight = mx.array([0.0, 0.5], dtype=mx.float32)
        x = mx.array([[3.0, 4.0]], dtype=mx.float32)
        eps = 1e-6
        got = np.array(_CentredNorm(weight, eps)(x))
        xf, wf = np.array(x), np.array(weight)
        expected = xf / np.sqrt((xf * xf).mean(axis=-1, keepdims=True) + eps) * (1.0 + wf)
        self.assertLess(np.abs(got - expected).max(), 1e-6)
        self.assertGreater(float(got[0, 0]), 0.0)

    def test_grouped_key_heads_and_per_row_cache_continuation_match_plain(self):
        cfg = dict(TINY, linear_num_key_heads=1, linear_num_value_heads=2)
        bb = Backbone.random(Config(cfg), mx.float32, seed=12, std=0.2)
        prefixes = mx.array([[10, 11, 12], [13, 14, 15]])
        suffixes = mx.array([[16, 17], [18, 19]])
        all_ids = mx.concatenate([prefixes, suffixes], axis=1)
        batch = prefixes.shape[0]
        full_pos = mx.broadcast_to(mx.arange(5)[None], (batch, 5))
        full_mask = mx.tril(mx.ones((5, 5), dtype=mx.bool_))[None, None]
        full_mask = mx.broadcast_to(full_mask, (batch, 1, 5, 5))
        expected, _ = bb.forward(all_ids, full_pos, full_mask)

        prefix_pos = full_pos[:, :3]
        prefix_mask = mx.broadcast_to(mx.tril(mx.ones((3, 3), dtype=mx.bool_))[None, None], (batch, 1, 3, 3))
        _, past = bb.forward(prefixes, prefix_pos, prefix_mask, keep=mx.ones((batch, 3)))
        suffix_pos = full_pos[:, 3:]
        prefix_valid = mx.ones((batch, 2, 3), dtype=mx.bool_)
        suffix_causal = mx.broadcast_to(mx.tril(mx.ones((2, 2), dtype=mx.bool_))[None], (batch, 2, 2))
        suffix_mask = mx.concatenate([prefix_valid, suffix_causal], axis=-1)[:, None]
        actual, _ = bb.forward(suffixes, suffix_pos, suffix_mask, past=past)
        self.assertLess(np.abs(np.array(actual) - np.array(expected[:, 3:])).max(), tol(1e-4))


def contract_scan(q, k, v, decay, beta, state_in, start):
    """metal_scan.scan's documented contract in plain MLX: state_in [P, H, Dv, Dk], decay = exp(g), q/k normalised."""
    state = state_in[start].swapaxes(-1, -2)                                  # [B, H, Dk, Dv]
    outs = []
    for t in range(q.shape[1]):
        state = state * decay[:, t][..., None, None]
        kt = k[:, t]
        kv = (state * kt[..., None]).sum(axis=-2)
        delta = (v[:, t] - kv) * beta[:, t][..., None]
        state = state + kt[..., None] * delta[..., None, :]
        outs.append((state * q[:, t][..., None]).sum(axis=-2))
    return mx.stack(outs, axis=1)


@needs_mlx
class MetalPath(unittest.TestCase):
    """The indexed-start path (states in the kernel's layout, read by index) gives the gathered path's answers."""
    def run_with(self, scan):
        from questions_first import metal_scan
        tok = S.SyntheticTokenizer()
        bb = tiny(seed=3)
        rows = [{"question": "Is the lamp warm?", "options": ["no", "yes"]},
                {"question": "Which thing is the late one, if any of them is?", "options": ["parcel", "river", "violin"]}]
        states = ["The warm lamp glowed.", "The late parcel arrived and the river grew."]
        plain = QuestionsFirst(bb, tok, 0, use_metal=False)
        a = plain.score(plain.prepare(rows), states)
        real = metal_scan.scan
        metal_scan.scan = scan
        try:
            fast = QuestionsFirst(bb, tok, 0, use_metal=True)
            b = fast.score(fast.prepare(rows), states)
        finally:
            metal_scan.scan = real
        self.assertLess(np.abs(a - b).max(), tol(1e-4))

    def test_wiring_with_the_kernel_contract(self):
        self.run_with(contract_scan)

    @unittest.skipUnless(HAS_MLX and __import__("questions_first.metal_scan", fromlist=["available"]).available(), "needs Apple's GPU")
    def test_the_metal_kernel(self):
        from questions_first import metal_scan
        self.run_with(metal_scan.scan)


class Prompt(unittest.TestCase):
    def test_labels_need_255_single_tokens(self):
        class Chars:
            def encode(self, t, add_special_tokens=False):
                return [ord(c) for c in t]
        with self.assertRaises(ValueError):
            P.LabelTable(Chars())

    def test_question_types(self):
        self.assertEqual(P.render_question({"type": "noul", "instructions": "Is it?"})["options"], ["no", "yes"])
        r = P.render_question({"type": "score", "instructions": "How much?", "criteria": ["none", "some", "lots"]})
        rows, index = P.plan_rows({"s": r}, True)
        self.assertEqual(len(rows), 3)
        self.assertEqual(index, [("s", "iso", 0, 3)])
        with self.assertRaises(ValueError):
            P.render_question({"type": "choice", "instructions": "Which?", "criteria": ["only one"]})


if __name__ == "__main__":
    unittest.main()
