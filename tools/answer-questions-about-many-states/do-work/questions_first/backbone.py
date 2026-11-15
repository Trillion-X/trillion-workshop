"""Raw Qwen3.5 text config and weight owner for the questions-first core.

It reads a Hugging Face `config.json` (model_type `qwen3_5_text`) and its safetensors weights. It is a port of
transformers' `modeling_qwen3_5.py` (5.17.0) for text input: with text positions the three multimodal rope sections
carry the same position, so the rope is the plain one over the first `partial_rotary_factor` of each head.

The core in ``read-data/mlx_decider_core.py`` runs the active captured hybrid forward over this raw-weight mapping.
"""
import glob, json, math, os

import mlx.core as mx

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
                keep_f32 = short.endswith(("A_log", "dt_bias", "input_layernorm.weight", "post_attention_layernorm.weight",
                                           "self_attn.q_norm.weight", "self_attn.k_norm.weight")) or short == "norm.weight"
                out[short] = arr if keep_f32 and arr.dtype == mx.float32 else arr.astype(dtype)
    missing = [n for n in ("embed_tokens.weight", "norm.weight") if n not in out]
    if missing:
        raise ValueError(f"weights in {model_dir} lack {missing}")
    return out


def gated_rms_norm(x, gate, w, eps):
    """The delta-net output norm: normalise in float32, back to x's dtype, times w, times silu(gate) in float32."""
    dt = x.dtype
    xf = x.astype(mx.float32)
    y = (xf * mx.rsqrt((xf * xf).mean(axis=-1, keepdims=True) + eps)).astype(dt)
    y = w * y
    gf = gate.astype(mx.float32)
    return (y.astype(mx.float32) * (gf * mx.sigmoid(gf))).astype(dt)


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
        result = cls(cfg, load_weights(model_dir, cfg, dtype), dtype)
        # The raw checkpoint mapping remains authoritative and unmodified. The captured
        # framework owns the actual layers; its indexed adapter receives those layers.
        import sys
        read_data = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "read-data"))
        if read_data not in sys.path:
            sys.path.insert(0, read_data)
        from mlx_decider_core import SourceModel
        result.source_model = SourceModel(result, model_dir)
        return result

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

    # ---- passes
    def forward(self, ids, positions, attn_mask, past=None, keep=None, start=None):
        """ids [B, T]; positions [B, T]; attn_mask bool [B, 1, T, Tp + T]; past: {layer: cache} or None;
        start [B] int: row b continues prefix start[b] of a prepared past (whose caches are [P, ...]).
        Returns (final hidden [B, T, hidden], {layer: cache of this pass}; none when start is given)."""
        # The questions-first core is the sole owner of the active hybrid forward.  Keep this
        # method as the stable weight-container boundary used by the family adapter and tests.
        import os, sys
        read_data = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "read-data"))
        if read_data not in sys.path:
            sys.path.insert(0, read_data)
        from mlx_decider_core import _forward_backbone
        return _forward_backbone(self, ids, positions, attn_mask, past=past, keep=keep, start=start)
