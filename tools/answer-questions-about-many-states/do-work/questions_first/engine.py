"""The questions-first cache in MLX: run the questions once (`prepare`), then score many states against them in
batches (`score`). The same contract as the decider's own SchemaEngine (decider/schema_engine.py), without CUDA:

- packed (independent=False): one prefix holds every question; a state costs one row of state + one slot per question.
- independent (independent=True, the decider's default): one prefix per question; a state costs one row per question,
  and no question can influence another's answer.

Prefixes are run in left-padded batches and kept left-padded to the longest; a row's mask hides the padding of its own
prefix, its positions continue from that prefix's true length, and its delta-net layers start from that prefix's
final conv and recurrent state. Nothing a row computes is written back, so one prepared set serves every batch.
"""
import time

import mlx.core as mx
import numpy as np

from questions_first import prompt as P


class Prepared:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class QuestionsFirst:
    def __init__(self, backbone, tok, pad_id, temperature=1.0, tokens_per_batch=16384):
        self.b = backbone
        self.tok = tok
        self.pad = pad_id
        self.T = float(temperature)
        self.labels = P.LabelTable(tok)
        self.W = backbone.head_rows(self.labels.ids)                 # [255, hidden]
        self.tokens_per_batch = int(tokens_per_batch)
        self.stats = dict(prefix_tokens=0, suffix_tokens=0, batches=0)

    # ---- prefixes
    def prepare(self, rows, independent=True):
        """rows: [{"question", "options"}] in answer order. -> Prepared (the per-layer cache of every prefix)."""
        for r in rows:
            if not 2 <= len(r["options"]) <= P.MAX_OPTIONS:
                raise ValueError(f"a question needs 2 to {P.MAX_OPTIONS} options")
        groups = [[r] for r in rows] if independent else [rows]
        pres = [P.prefix_ids(self.tok, self.labels, g) for g in groups]
        tps = [len(p) for p in pres]
        tpmax = max(tps)
        cfg = self.b.cfg
        caches = {i: [] for i in range(cfg.layers)}
        order = sorted(range(len(pres)), key=lambda j: tps[j])
        start = 0
        while start < len(order):
            # a group of prefixes of similar length, bounded by the token budget
            end = start + 1
            while end < len(order) and (end - start + 1) * tps[order[end]] <= self.tokens_per_batch:
                end += 1
            idx = order[start:end]
            L = tps[idx[-1]]
            ids = np.full((len(idx), L), self.pad, dtype=np.int32)
            keep = np.zeros((len(idx), L), dtype=np.float32)
            for r, j in enumerate(idx):
                ids[r, L - tps[j]:] = pres[j]
                keep[r, L - tps[j]:] = 1
            padlen = mx.array([L - tps[j] for j in idx])[:, None]
            ar = mx.arange(L)[None, :]
            pos = ar - padlen
            valid_key = ar >= padlen                                           # [G, L]
            causal = mx.tril(mx.ones((L, L), dtype=mx.bool_))
            mask = (causal[None] & valid_key[:, None, :]) | mx.eye(L, dtype=mx.bool_)[None]
            _, c = self.b.forward(mx.array(ids), pos, mask[:, None], keep=mx.array(keep))
            for i, v in c.items():
                if cfg.layer_types[i] == "full_attention":
                    k, vv = v
                    extra = tpmax - L                                          # left-pad to the longest prefix
                    if extra:
                        k = mx.pad(k, [(0, 0), (0, 0), (extra, 0), (0, 0)])
                        vv = mx.pad(vv, [(0, 0), (0, 0), (extra, 0), (0, 0)])
                    v = (k, vv)
                mx.eval(v)
                caches[i].append((idx, v))
            self.stats["prefix_tokens"] += len(idx) * L
            start = end
        inv = np.argsort(np.concatenate([np.array(ix) for ix, _ in caches[0]]))
        merged = {}
        for i, parts in caches.items():
            a = mx.concatenate([p[1][0] for p in parts], axis=0)
            b = mx.concatenate([p[1][1] for p in parts], axis=0)
            perm = mx.array(inv)
            merged[i] = (a[perm], b[perm])
        mx.eval(merged)
        return Prepared(P=len(groups), nq=len(rows), independent=independent, slots_per_row=1 if independent else len(rows),
                        nopts=[len(r["options"]) for r in rows], tps=tps, tpmax=tpmax, cache=merged)

    # ---- states
    def tokenize(self, h, context, max_ctx_tokens):
        return P.suffix_ids(self.tok, context, h.slots_per_row, max_ctx_tokens)

    def _rows(self, h, suffixes, pairs):
        """pairs: [(state index, prefix index)] -> logits rows for every slot: [(pair, slot k, logits [K])] in order."""
        cfg = self.b.cfg
        Ts = max(len(suffixes[s][0]) for s, _ in pairs)
        N = len(pairs)
        ids = np.full((N, Ts), self.pad, dtype=np.int32)
        for r, (s, _) in enumerate(pairs):
            ids[r, :len(suffixes[s][0])] = suffixes[s][0]
        pidx = mx.array([p for _, p in pairs])
        tps = mx.array([h.tps[p] for _, p in pairs])[:, None]
        ar = mx.arange(Ts)[None, :]
        pos = tps + ar
        pre_valid = mx.arange(h.tpmax)[None, :] >= (h.tpmax - tps)            # [N, tpmax]
        causal = mx.tril(mx.ones((Ts, Ts), dtype=mx.bool_))
        mask = mx.concatenate([mx.broadcast_to(pre_valid[:, None, :], (N, Ts, h.tpmax)),
                               mx.broadcast_to(causal[None], (N, Ts, Ts))], axis=-1)[:, None]
        past = {i: (a[pidx], b[pidx]) for i, (a, b) in h.cache.items()}
        hidden, _ = self.b.forward(mx.array(ids), pos, mask, past=past)
        rows, slots = [], []
        for r, (s, _) in enumerate(pairs):
            for sl in suffixes[s][1]:
                rows.append(r)
                slots.append(sl)
        hs = hidden[mx.array(rows), mx.array(slots)]                            # [n slots, hidden]
        logits = (hs @ self.W.T).astype(mx.float32)
        self.stats["suffix_tokens"] += N * Ts
        self.stats["batches"] += 1
        return logits

    def score(self, h, contexts, max_ctx_tokens=32768, on_batch=None, should_stop=None):
        """-> [n contexts, nq, max nopts] numpy probabilities (columns past a question's nopts are 0).
        on_batch(finished state indices, total) is called after each batch; should_stop() is asked before each batch,
        and a stop leaves the unscored states' rows at 0 (the caller knows which finished from on_batch)."""
        suffixes = [self.tokenize(h, c, max_ctx_tokens) for c in contexts]
        n = len(contexts)
        width = max(h.nopts)
        out = np.zeros((n, h.nq, width), dtype=np.float64)
        order = sorted(range(n), key=lambda s: len(suffixes[s][0]))           # like lengths together: less padding
        pairs_all = [(s, p) for s in order for p in range(h.P)]
        i = 0
        done = set()
        left = {s: h.P for s in range(n)}
        nopts = np.array(h.nopts)
        while i < len(pairs_all):
            if should_stop is not None and should_stop():
                break
            j = i + 1
            Tm = len(suffixes[pairs_all[i][0]][0])
            while j < len(pairs_all):
                Tm = max(Tm, len(suffixes[pairs_all[j][0]][0]))
                if (j - i + 1) * (Tm + h.tpmax // 4) > self.tokens_per_batch:
                    break
                j += 1
            batch = pairs_all[i:j]
            logits = np.array(self._rows(h, suffixes, batch))
            q_of = []
            for s, p in batch:
                q_of += [(s, p)] if h.independent else [(s, q) for q in range(h.nq)]
            for (s, q), lg in zip(q_of, logits):
                k = nopts[q]
                z = lg[:k] / self.T
                z = np.exp(z - z.max())
                out[s, q, :k] = z / z.sum()
            for s, _ in batch:
                left[s] -= 1
                if left[s] == 0:
                    done.add(s)
            if on_batch is not None:
                on_batch(sorted(done), n)
            i = j
        return out


def timed(fn, *a, **k):
    t = time.perf_counter()
    r = fn(*a, **k)
    return r, time.perf_counter() - t
