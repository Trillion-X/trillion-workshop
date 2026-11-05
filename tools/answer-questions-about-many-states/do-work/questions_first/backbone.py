"""The Qwen3.5 hybrid text backbone (gated delta-net layers plus gated full attention) in MLX, shaped for a
questions-first cache: a prefix pass that returns every layer's cache, and a suffix pass that continues many rows,
each from its own prefix, in one batch.

It reads a Hugging Face `config.json` (model_type `qwen3_5_text`) and its safetensors weights. It is a port of
transformers' `modeling_qwen3_5.py` (5.17.0) for text input: with text positions the three multimodal rope sections
carry the same position, so the rope is the plain one over the first `partial_rotary_factor` of each head.

Rows are right-padded. A prefix batch is LEFT-padded instead: the pad positions are masked out of attention and their
input to every delta-net layer is zeroed, so a pad leaves the recurrent and conv states exactly zero and every
prefix ends with the state it would have had alone.
"""
import glob, json, math, os

import mlx.core as mx

from questions_first import metal_scan
from questions_first.gated_delta import chunk_gated_delta_rule, l2norm

SUPPORTED_MODEL_TYPES = ("qwen3_5_text",)


class Config:
    def __init__(self, raw):
        c = raw.get("text_config", raw)
        if c.get("model_type") not in SUPPORTED_MODEL_TYPES:
            raise ValueError(f"config.json model_type is {c.get('model_type')!r}; this backbone runs {', '.join(SUPPORTED_MODEL_TYPES)}")
        self.raw = c
        self.hidden = c["hidden_size"]
        self.layers = c["num_hidden_layers"]
        self.layer_types = c["layer_types"]
        self.eps = c["rms_norm_eps"]
        self.vocab = c["vocab_size"]
        self.inter = c["intermediate_size"]
        self.heads = c["num_attention_heads"]
        self.kv_heads = c["num_key_value_heads"]
        self.head_dim = c.get("head_dim") or self.hidden // self.heads
        rope = c.get("rope_parameters") or {}
        self.rope_theta = rope.get("rope_theta", c.get("rope_theta", 10000.0))
        self.rotary_dim = int(self.head_dim * rope.get("partial_rotary_factor", c.get("partial_rotary_factor", 1.0)))
        self.lk_heads = c["linear_num_key_heads"]
        self.lv_heads = c["linear_num_value_heads"]
        self.lk_dim = c["linear_key_head_dim"]
        self.lv_dim = c["linear_value_head_dim"]
        self.conv_k = c["linear_conv_kernel_dim"]
        self.tied = bool(raw.get("tie_word_embeddings", c.get("tie_word_embeddings", False)))
        if c.get("attention_bias"):
            raise ValueError("config.json attention_bias is true; this backbone runs attention without bias")


def load_config(model_dir):
    with open(os.path.join(model_dir, "config.json")) as f:
        return Config(json.load(f))


def _strip(name):
    for p in ("model.language_model.", "language_model.model.", "model."):
        if name.startswith(p):
            return name[len(p):]
    return name


def load_weights(model_dir, cfg, dtype):
    """-> {short name: array}. Keeps only the text backbone (embed_tokens, layers.*, norm) and lm_head when untied."""
    files = sorted(glob.glob(os.path.join(model_dir, "*.safetensors")))
    if not files:
        raise FileNotFoundError(f"no .safetensors weights in {model_dir}")
    out = {}
    for f in files:
        for name, arr in mx.load(f).items():
            if name.startswith(("mtp.", "model.visual.", "visual.")):
                continue
            short = "lm_head.weight" if name == "lm_head.weight" else _strip(name)
            if short.startswith(("embed_tokens.", "layers.", "norm.")) or short == "lm_head.weight":
                keep_f32 = short.endswith(("A_log", "dt_bias"))
                out[short] = arr if keep_f32 and arr.dtype == mx.float32 else arr.astype(dtype)
    missing = [n for n in ("embed_tokens.weight", "norm.weight") if n not in out]
    if missing:
        raise ValueError(f"weights in {model_dir} lack {missing}")
    return out


def rms_norm(x, w, eps):
    """Qwen3.5's zero-centred RMSNorm: (x / rms(x)) * (1 + w), computed in float32, returned in x's dtype."""
    return mx.fast.rms_norm(x.astype(mx.float32), 1.0 + w.astype(mx.float32), eps).astype(x.dtype)


def gated_rms_norm(x, gate, w, eps):
    """The delta-net output norm: normalise in float32, back to x's dtype, times w, times silu(gate) in float32."""
    dt = x.dtype
    xf = x.astype(mx.float32)
    y = (xf * mx.rsqrt((xf * xf).mean(axis=-1, keepdims=True) + eps)).astype(dt)
    y = w * y
    gf = gate.astype(mx.float32)
    return (y.astype(mx.float32) * (gf * mx.sigmoid(gf))).astype(dt)


def silu(x):
    return x * mx.sigmoid(x)


def softplus(x):
    return mx.logaddexp(x, mx.zeros_like(x))


def linear(x, w):
    return x @ w.T


def _mlp_fn(x, wg, wu, wd):
    g = x @ wg.T
    return ((g * mx.sigmoid(g)) * (x @ wu.T)) @ wd.T


_mlp_compiled = mx.compile(_mlp_fn)                                   # fuses the gate's elementwise work


def rope_cos_sin(positions, cfg, dtype):
    """positions [B, T] int -> cos, sin [B, T, rotary_dim] in dtype (computed in float32, then cast, as the reference)."""
    d = cfg.rotary_dim
    inv = 1.0 / (cfg.rope_theta ** (mx.arange(0, d, 2, dtype=mx.float32) / d))
    f = positions.astype(mx.float32)[..., None] * inv
    emb = mx.concatenate([f, f], axis=-1)
    return mx.cos(emb).astype(dtype), mx.sin(emb).astype(dtype)


def apply_rope(x, cos, sin, d):
    """x [B, H, T, D]; rotate the first d dims (rotate_half convention)."""
    cos = cos[:, None]
    sin = sin[:, None]
    xr, xp = x[..., :d], x[..., d:]
    h = d // 2
    rot = mx.concatenate([-xr[..., h:], xr[..., :h]], axis=-1)
    return mx.concatenate([xr * cos + rot * sin, xp], axis=-1)


class Backbone:
    def __init__(self, cfg, weights, dtype=mx.bfloat16):
        self.cfg = cfg
        self.w = weights
        self.dtype = dtype

    @classmethod
    def load(cls, model_dir, dtype=mx.bfloat16):
        cfg = load_config(model_dir)
        return cls(cfg, load_weights(model_dir, cfg, dtype), dtype)

    @classmethod
    def random(cls, cfg, dtype=mx.bfloat16, seed=0, std=0.02):
        """Synthetic weights of the right shapes (normal(0, std) like transformers' init; norms at their identity).
        For tests and for timing a config without its weights."""
        mx.random.seed(seed)
        c = cfg
        w = {}

        def n(*shape):
            return (mx.random.normal(shape) * std).astype(dtype)
        w["embed_tokens.weight"] = n(c.vocab, c.hidden)
        w["norm.weight"] = mx.zeros((c.hidden,), dtype=dtype)
        kd, vd = c.lk_heads * c.lk_dim, c.lv_heads * c.lv_dim
        for i in range(c.layers):
            p = f"layers.{i}."
            w[p + "input_layernorm.weight"] = mx.zeros((c.hidden,), dtype=dtype)
            w[p + "post_attention_layernorm.weight"] = mx.zeros((c.hidden,), dtype=dtype)
            w[p + "mlp.gate_proj.weight"] = n(c.inter, c.hidden)
            w[p + "mlp.up_proj.weight"] = n(c.inter, c.hidden)
            w[p + "mlp.down_proj.weight"] = n(c.hidden, c.inter)
            if c.layer_types[i] == "linear_attention":
                q = p + "linear_attn."
                w[q + "in_proj_qkv.weight"] = n(2 * kd + vd, c.hidden)
                w[q + "in_proj_z.weight"] = n(vd, c.hidden)
                w[q + "in_proj_b.weight"] = n(c.lv_heads, c.hidden)
                w[q + "in_proj_a.weight"] = n(c.lv_heads, c.hidden)
                w[q + "conv1d.weight"] = (mx.random.normal((2 * kd + vd, 1, c.conv_k)) * (1 / math.sqrt(c.conv_k))).astype(dtype)
                w[q + "A_log"] = mx.log(mx.random.uniform(0.01, 16, (c.lv_heads,)))
                w[q + "dt_bias"] = mx.ones((c.lv_heads,), dtype=dtype)
                w[q + "norm.weight"] = mx.ones((c.lv_dim,), dtype=dtype)
                w[q + "out_proj.weight"] = n(c.hidden, vd)
            else:
                q = p + "self_attn."
                w[q + "q_proj.weight"] = n(c.heads * c.head_dim * 2, c.hidden)
                w[q + "k_proj.weight"] = n(c.kv_heads * c.head_dim, c.hidden)
                w[q + "v_proj.weight"] = n(c.kv_heads * c.head_dim, c.hidden)
                w[q + "o_proj.weight"] = n(c.hidden, c.heads * c.head_dim)
                w[q + "q_norm.weight"] = mx.zeros((c.head_dim,), dtype=dtype)
                w[q + "k_norm.weight"] = mx.zeros((c.head_dim,), dtype=dtype)
        mx.eval(w)
        return cls(c, w, dtype)

    def head_rows(self, token_ids):
        """The output-head rows for these tokens (lm_head, or the tied embedding): [K, hidden]."""
        w = self.w.get("lm_head.weight") if not self.cfg.tied else None
        w = self.w["embed_tokens.weight"] if w is None else w
        return w[mx.array(token_ids)]

    # ---- layers
    def _mlp(self, i, x):
        p = f"layers.{i}.mlp."
        return _mlp_compiled(x, self.w[p + "gate_proj.weight"], self.w[p + "up_proj.weight"], self.w[p + "down_proj.weight"])

    def _attention(self, i, x, cos, sin, past, mask, start=None):
        """past: (k, v) [B, KVH, Tp, D] or None (or [P, ...] with start [B]: row b continues prefix start[b]);
        mask: bool [B, 1, T, Tp + T] (True = may attend)."""
        c = self.cfg; p = f"layers.{i}.self_attn."
        B, T, _ = x.shape
        D = c.head_dim
        qg = linear(x, self.w[p + "q_proj.weight"]).reshape(B, T, c.heads, 2 * D)
        q, gate = qg[..., :D], qg[..., D:]
        gate = gate.reshape(B, T, c.heads * D)
        q = rms_norm(q, self.w[p + "q_norm.weight"], c.eps).swapaxes(1, 2)
        k = rms_norm(linear(x, self.w[p + "k_proj.weight"]).reshape(B, T, c.kv_heads, D), self.w[p + "k_norm.weight"], c.eps).swapaxes(1, 2)
        v = linear(x, self.w[p + "v_proj.weight"]).reshape(B, T, c.kv_heads, D).swapaxes(1, 2)
        q = apply_rope(q, cos, sin, c.rotary_dim)
        k = apply_rope(k, cos, sin, c.rotary_dim)
        new_kv = (k, v)
        if past is not None:
            if start is not None:
                past = (past[0][start], past[1][start])
            k = mx.concatenate([past[0], k], axis=2)
            v = mx.concatenate([past[1], v], axis=2)
        o = mx.fast.scaled_dot_product_attention(q, k, v, scale=D ** -0.5, mask=mask)
        o = o.swapaxes(1, 2).reshape(B, T, c.heads * D)
        o = o * mx.sigmoid(gate)
        return linear(o, self.w[p + "o_proj.weight"]), new_kv

    def _delta(self, i, x, past, keep, start=None):
        """past: (conv [B, conv_k - 1, C], rec [B, H, Dk, Dv] float32) or None, or with start [B] the prepared
        (conv [P, ...], rec [P, ...], rec on Metal's layout [P, H, Dv, Dk] or None) that row b continues at start[b];
        keep: [B, T] (0 = a left pad) or None. Returns (out, (conv tail, final state)); with start, (out, None)."""
        c = self.cfg; p = f"layers.{i}.linear_attn."
        if keep is not None:
            x = x * keep[..., None].astype(x.dtype)
        B, T, _ = x.shape
        qkv = linear(x, self.w[p + "in_proj_qkv.weight"])                       # [B, T, C]
        z = linear(x, self.w[p + "in_proj_z.weight"]).reshape(B, T, c.lv_heads, c.lv_dim)
        b = linear(x, self.w[p + "in_proj_b.weight"])
        a = linear(x, self.w[p + "in_proj_a.weight"])
        K = c.conv_k
        cw = self.w[p + "conv1d.weight"].reshape(-1, K)                         # [C, K]
        if past is None:
            head = mx.zeros((B, K - 1, qkv.shape[-1]), dtype=qkv.dtype)
        else:
            head = (past[0] if start is None else past[0][start]).astype(qkv.dtype)
        full = mx.concatenate([head, qkv], axis=1)                              # [B, K - 1 + T, C]
        ff, cwf = full.astype(mx.float32), cw.astype(mx.float32)               # accumulate in float32, round once
        conv = ff[:, 0:T] * cwf[:, 0]
        for j in range(1, K):
            conv = conv + ff[:, j:j + T] * cwf[:, j]
        conv = silu(conv.astype(qkv.dtype).astype(mx.float32)).astype(qkv.dtype)
        tail = full[:, -(K - 1):]
        kd, vd = c.lk_heads * c.lk_dim, c.lv_heads * c.lv_dim
        q = conv[..., :kd].reshape(B, T, c.lk_heads, c.lk_dim)
        k = conv[..., kd:2 * kd].reshape(B, T, c.lk_heads, c.lk_dim)
        v = conv[..., 2 * kd:].reshape(B, T, c.lv_heads, c.lv_dim)
        beta = mx.sigmoid(b)
        g = -mx.exp(self.w[p + "A_log"].astype(mx.float32)) * softplus(a.astype(mx.float32) + self.w[p + "dt_bias"].astype(mx.float32))
        rep = c.lv_heads // c.lk_heads
        if rep > 1:
            q = mx.repeat(q, rep, axis=2)
            k = mx.repeat(k, rep, axis=2)
        if start is not None and len(past) > 2 and past[2] is not None:
            # one Metal pass: each row reads its prefix's state by index (no per-row copy), outputs only
            qn = l2norm(q.astype(mx.float32)) * (c.lk_dim ** -0.5)
            kn = l2norm(k.astype(mx.float32))
            out = metal_scan.scan(qn, kn, v.astype(mx.float32), mx.exp(g), beta.astype(mx.float32), past[2], start).astype(q.dtype)
            state = None
        else:
            init = None if past is None else (past[1] if start is None else past[1][start])
            out, state = chunk_gated_delta_rule(q, k, v, g, beta, init)
        out = gated_rms_norm(out, z, self.w[p + "norm.weight"], c.eps).reshape(B, T, vd)
        return linear(out, self.w[p + "out_proj.weight"]), (None if start is not None else (tail, state))

    # ---- passes
    def forward(self, ids, positions, attn_mask, past=None, keep=None, start=None):
        """ids [B, T]; positions [B, T]; attn_mask bool [B, 1, T, Tp + T]; past: {layer: cache} or None;
        start [B] int: row b continues prefix start[b] of a prepared past (whose caches are [P, ...]).
        Returns (final hidden [B, T, hidden], {layer: cache of this pass}; none when start is given)."""
        c = self.cfg
        h = self.w["embed_tokens.weight"][ids]
        cos, sin = rope_cos_sin(positions, c, self.dtype)
        caches = {}
        for i in range(c.layers):
            r = h
            x = rms_norm(h, self.w[f"layers.{i}.input_layernorm.weight"], c.eps)
            if c.layer_types[i] == "linear_attention":
                x, caches[i] = self._delta(i, x, None if past is None else past[i], keep, start)
            else:
                x, caches[i] = self._attention(i, x, cos, sin, None if past is None else past[i], attn_mask, start)
            h = r + x
            r = h
            h = r + self._mlp(i, rms_norm(h, self.w[f"layers.{i}.post_attention_layernorm.weight"], c.eps))
        return rms_norm(h, self.w["norm.weight"], c.eps), caches
