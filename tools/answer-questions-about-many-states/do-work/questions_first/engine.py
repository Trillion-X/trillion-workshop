"""The questions-first cache in MLX: run the questions once (`prepare`), then score many states against them in
batches (`score`). The same contract as the decider's own SchemaEngine (decider/schema_engine.py), without CUDA:

- packed (independent=False): one prefix holds every question; a state costs one row of state + one slot per question.
- independent (independent=True, the decider's default): one prefix per question; a state costs one row per question,
  and no question can influence another's answer.

A prefix is its questions plus the "\\n\\nContext:\\n" that opens every state (it depends on no state), so a row runs
only its state's own tokens and its answer slots. Prefixes are run in left-padded batches and kept left-padded to the
longest. A batch holds rows of many prefixes: each row's mask hides its prefix's padding, its positions continue from
its prefix's true length, and its delta-net layers start from that prefix's conv and recurrent state, read by index
(on Metal, inside the scan kernel, with no per-row copy). Nothing a row computes is written back, so one prepared set
serves every batch.
"""
import mlx.core as mx
import numpy as np

from questions_first import metal_scan
from questions_first import prompt as P


class Prepared:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class QuestionsFirst:
    def __init__(self, backbone, tok, pad_id, temperature=1.0, tokens_per_batch=16384, use_metal=None):
        self.b = backbone
        self.tok = tok
        self.pad = pad_id
        self.T = float(temperature)
        self.labels = P.LabelTable(tok)
        self.opening = tok.encode(P.CONTEXT_OPENING)
        self.W = backbone.head_rows(self.labels.ids)                 # [255, hidden]
        self.tokens_per_batch = int(tokens_per_batch)
        # the Metal scan takes key heads in multiples of 32 (one simdgroup per head); any other shape runs the chunked rule
        fits = backbone.cfg.lk_dim % 32 == 0
        self.use_metal = (metal_scan.available() and fits) if use_metal is None else bool(use_metal)
        self.stats = dict(prefix_tokens=0, suffix_tokens=0, padded_suffix_tokens=0, batches=0)

    # ---- prefixes
    def prepare(self, rows, independent=True):
        """rows: [{"question", "options"}] in answer order. -> Prepared (the per-layer cache of every prefix)."""
        for r in rows:
            if not 2 <= len(r["options"]) <= P.MAX_OPTIONS:
                raise ValueError(f"a question needs 2 to {P.MAX_OPTIONS} options")
        groups = [[r] for r in rows] if independent else [rows]
        pres = [P.prefix_ids(self.tok, self.labels, g) + self.opening for g in groups]
        tps = [len(p) for p in pres]
        tpmax = max(tps)
        cfg = self.b.cfg
        parts = {i: [] for i in range(cfg.layers)}
        order = sorted(range(len(pres)), key=lambda j: tps[j])
        placed = []
        start = 0
        while start < len(order):
            end = start + 1                                                    # prefixes of like length, within the budget
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
            causal = mx.tril(mx.ones((L, L), dtype=mx.bool_))
            mask = (causal[None] & (ar >= padlen)[:, None, :]) | mx.eye(L, dtype=mx.bool_)[None]   # a pad sees itself only
            _, c = self.b.forward(mx.array(ids), ar - padlen, mask[:, None], keep=mx.array(keep))
            for i, v in c.items():
                if cfg.layer_types[i] == "full_attention":
                    extra = tpmax - L                                          # left-pad to the longest prefix
                    if extra:
                        v = tuple(mx.pad(t, [(0, 0), (0, 0), (extra, 0), (0, 0)]) for t in v)
                elif self.use_metal:
                    v = (v[0], None, v[1].swapaxes(-1, -2))                    # the kernel's [P, H, Dv, Dk]
                else:
                    v = (v[0], v[1], None)
                mx.eval([t for t in v if t is not None])
                parts[i].append(v)
            placed += idx
            self.stats["prefix_tokens"] += len(idx) * L
            start = end
        back = mx.array(np.argsort(np.array(placed)))
        cache = {}
        for i, ps in parts.items():
            cache[i] = tuple(None if ps[0][n] is None else mx.concatenate([p[n] for p in ps], axis=0)[back] for n in range(len(ps[0])))
            mx.eval([t for t in cache[i] if t is not None])
        return Prepared(P=len(groups), nq=len(rows), independent=independent, slots_per_row=1 if independent else len(rows),
                        nopts=[len(r["options"]) for r in rows], tps=tps, tpmax=tpmax, cache=cache)

    # ---- states
    def tokenize(self, h, context, max_ctx_tokens):
        return P.suffix_ids(self.tok, context, h.slots_per_row, max_ctx_tokens, opening=False)

    def _probabilities(self, h, suffixes, pairs):
        """pairs: [(state index, prefix index)] -> lazy [n slots, 255] probabilities, one row per slot in pair order."""
        Ts = max(len(suffixes[s][0]) for s, _ in pairs)
        N = len(pairs)
        ids = np.full((N, Ts), self.pad, dtype=np.int32)
        rows, slots = [], []
        for r, (s, _) in enumerate(pairs):
            ids[r, :len(suffixes[s][0])] = suffixes[s][0]
            for sl in suffixes[s][1]:
                rows.append(r)
                slots.append(sl)
            self.stats["suffix_tokens"] += len(suffixes[s][0])
        start = mx.array(np.array([p for _, p in pairs], dtype=np.int32))
        tps = mx.array(np.array([h.tps[p] for _, p in pairs], dtype=np.int32))[:, None]
        ar = mx.arange(Ts)[None, :]
        pre_valid = mx.arange(h.tpmax)[None, :] >= (h.tpmax - tps)            # [N, tpmax]: this row's prefix, not its padding
        causal = mx.tril(mx.ones((Ts, Ts), dtype=mx.bool_))
        mask = mx.concatenate([mx.broadcast_to(pre_valid[:, None, :], (N, Ts, h.tpmax)),
                               mx.broadcast_to(causal[None], (N, Ts, Ts))], axis=-1)[:, None]
        hidden, _ = self.b.forward(mx.array(ids), tps + ar, mask, past=h.cache, start=start)
        hs = hidden[mx.array(rows), mx.array(slots)]                            # [n slots, hidden]
        logits = (hs @ self.W.T).astype(mx.float32)
        self.stats["padded_suffix_tokens"] += N * Ts
        self.stats["batches"] += 1
        return logits

    def _batches(self, h, suffixes):
        """Rows grouped by state length (so a batch is little padding), many prefixes per batch, within the budget."""
        order = sorted(range(len(suffixes)), key=lambda s: len(suffixes[s][0]))
        pairs = [(s, p) for s in order for p in range(h.P)]
        i = 0
        while i < len(pairs):
            j = i + 1
            Tm = len(suffixes[pairs[i][0]][0])
            while j < len(pairs):
                Tn = max(Tm, len(suffixes[pairs[j][0]][0]))
                if (j - i + 1) * (Tn + h.tpmax // 4) > self.tokens_per_batch:
                    break
                Tm = Tn
                j += 1
            yield pairs[i:j]
            i = j

    def score(self, h, contexts, max_ctx_tokens=32768, on_batch=None, should_stop=None):
        """-> [n contexts, nq, max nopts] numpy probabilities (columns past a question's nopts are 0).
        on_batch(finished state indices, total) is called after each batch is read; should_stop() is asked before each
        batch is queued, and a stop leaves the states that did not finish at 0 (on_batch names the ones that did).
        One batch is queued on the device while the previous one is read back."""
        suffixes = [self.tokenize(h, c, max_ctx_tokens) for c in contexts]
        n = len(contexts)
        out = np.zeros((n, h.nq, max(h.nopts)), dtype=np.float64)
        nopts = np.array(h.nopts)
        left = {s: h.P for s in range(n)}
        done = []

        def read(batch, logits):
            lg = np.array(logits)
            q_of = []
            for s, p in batch:
                q_of += [(s, p)] if h.independent else [(s, q) for q in range(h.nq)]
            for (s, q), row in zip(q_of, lg):
                z = row[:nopts[q]].astype(np.float64) / self.T
                z = np.exp(z - z.max())
                out[s, q, :nopts[q]] = z / z.sum()
            for s, _ in batch:
                left[s] -= 1
                if left[s] == 0:
                    done.append(s)
            if on_batch is not None:
                on_batch(sorted(done), n)

        pending = None
        for batch in self._batches(h, suffixes):
            if should_stop is not None and should_stop():
                break
            logits = self._probabilities(h, suffixes, batch)
            mx.async_eval(logits)
            if pending is not None:
                read(*pending)
            pending = (batch, logits)
        if pending is not None:
            read(*pending)
        return out
