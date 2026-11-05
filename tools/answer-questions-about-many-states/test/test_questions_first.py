"""The MLX forward on its own: the kernel, the triangular inverse, the cache and the batching, over a tiny made-up
config and synthetic weights. Agreement with the decider's PyTorch code is agree_with_reference.py."""
import os, sys, unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "do-work"))

import mlx.core as mx  # noqa: E402

import synthetic as S  # noqa: E402
from questions_first import prompt as P  # noqa: E402
from questions_first.backbone import Backbone, Config  # noqa: E402
from questions_first.engine import QuestionsFirst  # noqa: E402
from questions_first.gated_delta import chunk_gated_delta_rule, recurrent_gated_delta_rule, unit_lower_inverse  # noqa: E402

TINY = {"model_type": "qwen3_5_text", "hidden_size": 64, "intermediate_size": 128, "num_hidden_layers": 4,
        "layer_types": ["linear_attention", "linear_attention", "linear_attention", "full_attention"],
        "rms_norm_eps": 1e-6, "vocab_size": 62000, "num_attention_heads": 4, "num_key_value_heads": 2, "head_dim": 16,
        "rope_parameters": {"rope_theta": 10000000, "partial_rotary_factor": 0.25, "rope_type": "default"},
        "linear_num_key_heads": 2, "linear_num_value_heads": 2, "linear_key_head_dim": 16, "linear_value_head_dim": 16,
        "linear_conv_kernel_dim": 4, "tie_word_embeddings": True, "attention_bias": False}


def tiny(seed=0):
    return Backbone.random(Config(TINY), mx.float32, seed=seed, std=0.2)


def full_forward_logits(bb, qf, ids, slots):
    """Run prefix + suffix as one plain sequence, no cache: the logits at the slots."""
    T = len(ids)
    mask = mx.tril(mx.ones((T, T), dtype=mx.bool_))[None, None]
    h, _ = bb.forward(mx.array([ids]), mx.arange(T)[None], mask)
    return np.array((h[0, mx.array(slots)] @ qf.W.T).astype(mx.float32))


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
        self.assertLess(float(mx.abs(o1 - o2).max()), 1e-5)
        self.assertLess(float(mx.abs(s1 - s2).max()), 1e-5)

    def test_unit_lower_inverse_with_correlated_entries(self):
        rng = np.random.default_rng(2)
        n = np.tril(0.9 + 0.1 * rng.random((5, 64, 64)), -1).astype(np.float32)
        inv = np.array(unit_lower_inverse(mx.array(n)))
        eye = np.eye(64, dtype=np.float32)
        self.assertLess(np.abs((eye + n) @ inv - eye).max(), 1e-3)


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
                self.assertLess(np.abs(got[s, q, :len(p)] - p).max(), 1e-4, (s, q))

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
                self.assertLess(np.abs(got[s, q, :len(p)] - p).max(), 1e-4, (s, q))

    def test_batch_size_does_not_change_answers(self):
        wide = QuestionsFirst(self.bb, self.tok, 0, temperature=1.0, tokens_per_batch=1 << 20)
        a = self.qf.score(self.qf.prepare(self.rows, independent=True), self.states)
        b = wide.score(wide.prepare(self.rows, independent=True), self.states)
        self.assertLess(np.abs(a - b).max(), 1e-5)

    def test_stop_and_progress(self):
        h = self.qf.prepare(self.rows, independent=True)
        seen = []
        out = self.qf.score(h, self.states, on_batch=lambda done, n: seen.append(list(done)), should_stop=lambda: len(seen) >= 1)
        self.assertEqual(len(seen), 1)
        finished = set(seen[-1])
        self.assertLess(len(finished), len(self.states))
        for s in finished:
            self.assertTrue(np.allclose(out[s].sum(axis=-1), 1.0))


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
