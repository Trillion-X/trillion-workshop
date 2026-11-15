"""The canonical batched MLX core, ported from the preserved AICC MlxDecider source.

Source baseline: ports/source-baselines/answer-questions-about-many-states/decide_in_batches_on_mlx.py.held
captured from ai-command-center commit 587335345151c2daf2e2712ec06deb45705585ac.

The source's model-folder loader and model-specific imports stay in the family adapter. This core receives the
already-loaded backbone and package prompt/tokenizer owners. It prepares independent question prefixes or one packed
prefix, then scores every state from the immutable prefix cache. The indexed Metal scan reads each row's gated-delta
state by index; no row copies or mutates a prefix state.

Upstream MLX-LM MIT license notice for the adapted gated-delta kernel:
MIT License

Copyright © 2023 Apple Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""
from dataclasses import dataclass
from types import MappingProxyType
import json
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn
import numpy as np

from questions_first import metal_scan
from questions_first import prompt as P
from questions_first.prompt import CONTEXT_OPENING

_COMPAT_SCAN_ENTRY = metal_scan.scan


class _CentredNorm(nn.Module):
    """transformers' Qwen3_5RMSNorm: normalise in float32, scale by (1 + weight) kept in float32, round once."""
    def __init__(self, weight, eps):
        super().__init__()
        weight = 1.0 + weight.astype(mx.float32)
        self.weight, self.eps = weight, eps

    def __call__(self, x):
        return mx.fast.rms_norm(x.astype(mx.float32), self.weight, self.eps).astype(x.dtype)


class _LoadedScaleNorm(nn.Module):
    """The captured norm over the sanitizer's already-centred float32 scale."""
    def __init__(self, weight, eps):
        super().__init__()
        self.weight, self.eps = weight, eps

    def __call__(self, x):
        return mx.fast.rms_norm(x.astype(mx.float32), self.weight, self.eps).astype(x.dtype)


CENTRED_NORMS = (".input_layernorm.weight", ".post_attention_layernorm.weight", "model.norm.weight",
                 ".q_norm.weight", ".k_norm.weight")


class SourceModel:
    """Captured model construction over the existing loader's admitted, unchanged raw tensors.

    The previous experiment cast and reconstructed centred scales into raw values. Here the
    source sanitizer's float32 scales remain direct norm inputs; backbone.w stays untouched.
    The actual native projections, convolution and MLP supply the indexed forward below.
    """
    def __init__(self, backbone, path):
        from mlx_lm.models import qwen3_5
        _CentredNorm = _LoadedScaleNorm
        self.path = str(path)
        config = json.loads(Path(self.path, "config.json").read_text())
        config = {**config.get("text_config", config), "tie_word_embeddings": backbone.cfg.tied}
        settings = json.loads(Path(self.path, "decider_config.json").read_text())
        self.temperature = float(settings.get("temperature_schema_first", settings.get("temperature", 1.0)))
        self.isolated_levels = bool(settings.get("isolated_levels", False))
        self.name = "decider-" + str(settings.get("version", "dev"))
        dtype = backbone.dtype
        self.dtype = dtype
        model = qwen3_5.Model(qwen3_5.ModelArgs.from_dict(config))
        for i, kind in enumerate(backbone.cfg.layer_types):
            linear = kind == "linear_attention"
            if model.language_model.model.layers[i].is_linear != linear:
                args = qwen3_5.TextModelArgs.from_dict({**config, "full_attention_interval": 2})
                model.language_model.model.layers[i] = qwen3_5.DecoderLayer(args, 0 if linear else 1)
        raw = {("lm_head.weight" if key == "lm_head.weight" else "model." + key): value
               for key, value in backbone.w.items()}
        weights = model.sanitize({key: value.astype(mx.float32) if key.endswith(CENTRED_NORMS) else value
                                  for key, value in raw.items()})
        centred = {key: value for key, value in weights.items() if key.endswith(CENTRED_NORMS)}
        model.load_weights(list(weights.items()))
        model.set_dtype(dtype)
        self.core = model.language_model.model
        eps = config["rms_norm_eps"]
        self.core.norm = _CentredNorm(centred["language_model.model.norm.weight"], eps)
        for i, layer in enumerate(self.core.layers):
            at = f"language_model.model.layers.{i}."
            layer.input_layernorm = _CentredNorm(centred[at + "input_layernorm.weight"], eps)
            layer.post_attention_layernorm = _CentredNorm(centred[at + "post_attention_layernorm.weight"], eps)
            if not layer.is_linear:
                layer.self_attn.q_norm = _CentredNorm(centred[at + "self_attn.q_norm.weight"], eps)
                layer.self_attn.k_norm = _CentredNorm(centred[at + "self_attn.k_norm.weight"], eps)
            else:
                layer.linear_attn.A_log = backbone.w[f"layers.{i}.linear_attn.A_log"].astype(mx.float32)
                layer.linear_attn.dt_bias = backbone.w[f"layers.{i}.linear_attn.dt_bias"].astype(mx.float32)
        model.eval()
        mx.eval(model.parameters())
        self.model = model


class _Keys:
    """Attention cache for one pass: the question's keys and values (none for the question itself) before each row's own."""

    def __init__(self, keys, values, rows):
        self.offset = keys.shape[2]
        self.keys = mx.broadcast_to(keys, (rows, *keys.shape[1:]))
        self.values = mx.broadcast_to(values, (rows, *values.shape[1:]))

    def update_and_fetch(self, keys, values):
        self.keys = mx.concatenate([self.keys, keys], axis=2)
        self.values = mx.concatenate([self.values, values], axis=2)
        return self.keys, self.values


def _keys_for_prefix(keys, values, rows, start):
    """Select immutable prefix rows before entering the captured append-only cache."""
    if start is not None and keys.shape[0] != 1:
        keys, values = keys[start], values[start]
    return _Keys(keys, values, rows)


class _Linear:
    def __init__(self, weight, project): self.weight, self.project = weight, project
    def __call__(self, x): return self.project(x, self.weight)


class _Conv:
    def __init__(self, weight): self.weight = weight.reshape(weight.shape[0], -1)
    def __call__(self, x):
        k = self.weight.shape[-1]
        out = None
        xf, wf = x.astype(mx.float32), self.weight.astype(mx.float32)
        for j in range(k):
            term = xf[:, j:j + x.shape[1] - k + 1] * wf[:, j]
            out = term if out is None else out + term
        return out.astype(x.dtype)


class _GatedNorm:
    def __init__(self, weight, eps): self.weight, self.eps = weight, eps
    def __call__(self, x, gate):
        from questions_first.backbone import gated_rms_norm
        return gated_rms_norm(x, gate, self.weight, self.eps)


class _DeltaLayer:
    """Thin callable facade for the raw tensors consumed by the captured ``_mix``."""
    def __init__(self, w, prefix, cfg, project):
        at = prefix + "linear_attn."
        self.in_proj_qkv, self.in_proj_z = _Linear(w[at + "in_proj_qkv.weight"], project), _Linear(w[at + "in_proj_z.weight"], project)
        self.in_proj_b, self.in_proj_a = _Linear(w[at + "in_proj_b.weight"], project), _Linear(w[at + "in_proj_a.weight"], project)
        self.conv1d, self.out_proj = _Conv(w[at + "conv1d.weight"]), _Linear(w[at + "out_proj.weight"], project)
        self.norm = _GatedNorm(w[at + "norm.weight"], cfg.eps)
        self.A_log, self.dt_bias = w[at + "A_log"].astype(mx.float32), w[at + "dt_bias"].astype(mx.float32)
        self.num_v_heads, self.num_k_heads = cfg.lv_heads, cfg.lk_heads
        self.head_v_dim, self.head_k_dim = cfg.lv_dim, cfg.lk_dim
        self.key_dim, self.conv_kernel_size = cfg.lk_heads * cfg.lk_dim, cfg.conv_k
        self.conv_dim = 2 * self.key_dim + cfg.lv_heads * cfg.lv_dim


def _scan_kernel(keep_state):
    """Captured gated-delta recurrence with uniform or indexed immutable prefix starts.

    The one-prefix path keeps the original shared-start contract:

    mlx_lm's kernel reads a start state per row and writes a final state per
    row. Every line asked one question starts from that question's state and
    nothing needs the state after the line, so this kernel reads the one
    shared start and writes only the outputs; a question's own prefix (one
    row) keeps its final state.

    Multiple prefixes use the same recurrence with start[row] selecting the
    source bank entry inside the kernel; neither case gathers per-row state copies.
    """
    keep = """
        auto o_state = state_out + (b_idx * Hv * Dv + hv_idx * Dv + dv_idx) * Dk;
        for (int i = 0; i < n_per_t; ++i) {
          o_state[n_per_t * dk_idx + i] = state[i];
        }
    """ if keep_state else ""
    source = r"""
        auto n = thread_position_in_grid.z;
        auto b_idx = n / Hv;
        auto hv_idx = n % Hv;
        auto hk_idx = hv_idx / (Hv / Hk);
        constexpr int n_per_t = Dk / 32;

        auto q_ = q + b_idx * T * Hk * Dk + hk_idx * Dk;
        auto k_ = k + b_idx * T * Hk * Dk + hk_idx * Dk;
        auto v_ = v + b_idx * T * Hv * Dv + hv_idx * Dv;
        y += b_idx * T * Hv * Dv + hv_idx * Dv;

        auto dk_idx = thread_position_in_threadgroup.x;
        auto dv_idx = thread_position_in_grid.y;

        auto i_state = state_in + ((start[b_idx] * Hv + hv_idx) * Dv + dv_idx) * Dk;

        float state[n_per_t];
        for (int i = 0; i < n_per_t; ++i) {
          state[i] = static_cast<float>(i_state[n_per_t * dk_idx + i]);
        }

        auto g_ = g + b_idx * T * Hv;
        auto beta_ = beta + b_idx * T * Hv;

        for (int t = 0; t < T; ++t) {
          float kv_mem = 0.0f;
          for (int i = 0; i < n_per_t; ++i) {
            auto s_idx = n_per_t * dk_idx + i;
            state[i] = state[i] * g_[hv_idx];
            kv_mem += state[i] * k_[s_idx];
          }
          kv_mem = simd_sum(kv_mem);

          auto delta = (v_[dv_idx] - kv_mem) * beta_[hv_idx];

          float out = 0.0f;
          for (int i = 0; i < n_per_t; ++i) {
            auto s_idx = n_per_t * dk_idx + i;
            state[i] = state[i] + k_[s_idx] * delta;
            out += state[i] * q_[s_idx];
          }
          out = simd_sum(out);
          if (thread_index_in_simdgroup == 0) {
            y[dv_idx] = static_cast<InT>(out);
          }
          q_ += Hk * Dk;
          k_ += Hk * Dk;
          v_ += Hv * Dv;
          y += Hv * Dv;
          g_ += Hv;
          beta_ += Hv;
        }
    """ + keep
    return mx.fast.metal_kernel(
        name="gated_delta_indexed_start" + ("_keep" if keep_state else ""),
        input_names=["q", "k", "v", "g", "beta", "state_in", "start", "T"],
        output_names=["y", "state_out"] if keep_state else ["y"],
        source=source,
    )


_SCAN = {}


def _indexed_scan(q, k, v, decay, beta, state_in, start):
    """Run the source-derived Metal recurrence with an immutable, indexed prefix state."""
    return _run_scan(q, k, v, decay, beta, state_in, start, keep_state=False)


def _run_scan(q, k, v, decay, beta, state_in, start, keep_state=False):
    if keep_state not in _SCAN:
        _SCAN[keep_state] = _scan_kernel(keep_state)
    B, T, Hk, Dk = q.shape
    Hv, Dv = v.shape[2:]
    if Dk % 32:
        raise ValueError(f"the Metal scan needs the key head size to be a multiple of 32, not {Dk}")
    outputs = _SCAN[keep_state](inputs=[q, k, v, decay, beta, state_in, start, T],
        template=[("InT", mx.float32), ("Dk", Dk), ("Dv", Dv), ("Hk", Hk), ("Hv", Hv)],
        grid=(32, Dv, B * Hv), threadgroup=(32, 4, 1),
        output_shapes=[(B, T, Hv, Dv)] + ([(B, Hv, Dv, Dk)] if keep_state else []),
        output_dtypes=[mx.float32] * (2 if keep_state else 1))
    return outputs if keep_state else outputs[0]


def _mix(layer, x, conv_start, state_start, keep, start=None, state_metal=None, use_metal=False, keep_mask=None):
    """mlx_lm's ``GatedDeltaNet.__call__`` for rows continuing prepared starts.

    q and k are scaled to unit length with transformers' L2 norm epsilon. The source
    shared start is adapted to a read-only indexed state bank; only prefix calls keep a
    final state, and the chunked rule remains the non-Metal fallback.
    """
    from questions_first.gated_delta import chunk_gated_delta_rule, l2norm
    B, S, _ = x.shape
    if keep_mask is not None:
        x = x * keep_mask[..., None].astype(x.dtype)
    qkv = layer.in_proj_qkv(x)
    z = layer.in_proj_z(x).reshape(B, S, layer.num_v_heads, layer.head_v_dim)
    b = layer.in_proj_b(x)
    a = layer.in_proj_a(x)
    if start is not None:
        conv_start = conv_start[start]
    conv_start = conv_start.astype(qkv.dtype)
    conv_input = mx.concatenate([mx.broadcast_to(conv_start, (B, *conv_start.shape[1:])), qkv], axis=1)
    conv_out = nn.silu(layer.conv1d(conv_input))
    q, k, v = [
        t.reshape(B, S, h, d)
        for t, h, d in zip(
            mx.split(conv_out, [layer.key_dim, 2 * layer.key_dim], -1),
            [layer.num_k_heads, layer.num_k_heads, layer.num_v_heads],
            [layer.head_k_dim, layer.head_k_dim, layer.head_v_dim],
        )
    ]
    dk = layer.head_k_dim
    q_raw, k_raw = q, k
    q = mx.fast.rms_norm(q.astype(mx.float32), None, 1e-6 / dk) * (dk ** -1.0)
    k = mx.fast.rms_norm(k.astype(mx.float32), None, 1e-6 / dk) * (dk ** -0.5)
    beta = mx.sigmoid(b).astype(mx.float32)
    af = a.astype(mx.float32) + layer.dt_bias
    g = -mx.exp(layer.A_log) * mx.logaddexp(af, mx.zeros(af.shape, dtype=mx.float32))

    if keep and use_metal and start is None:
        # A shared blank state starts every prefix row; an ordinary batch cache keeps its own row state.
        state_bank = state_metal if state_metal is not None else state_start.swapaxes(-1, -2)
        starts = mx.zeros((B,), dtype=mx.int32) if state_bank.shape[0] == 1 else mx.arange(B)
        out, stored = _run_scan(q, k, v.astype(mx.float32), mx.exp(g), beta,
                                state_bank, starts, keep_state=True)
        final_state = stored.swapaxes(-1, -2)
    elif use_metal and start is None and state_start.shape[0] == 1:
        # Every suffix row continues the same immutable prefix state. Select the
        # single bank entry inside the kernel instead of gathering B copies.
        state_bank = state_start.swapaxes(-1, -2)
        starts = mx.zeros((B,), dtype=mx.int32)
        out = _run_scan(q, k, v.astype(mx.float32), mx.exp(g), beta, state_bank, starts)
        final_state = None
    elif use_metal and start is not None and state_metal is not None:
        # Each suffix row reads its prefix state by index; no per-row state copy is made.
        scanner = _indexed_scan if metal_scan.scan is _COMPAT_SCAN_ENTRY else metal_scan.scan
        out = scanner(q, k, v.astype(mx.float32), mx.exp(g), beta, state_metal, start)
        final_state = None
    else:
        if state_metal is not None:
            initial = state_metal.swapaxes(-1, -2) if start is None else state_metal[start].swapaxes(-1, -2)
        else:
            initial = None if state_start is None else (state_start if start is None else state_start[start])
        repeat = layer.num_v_heads // layer.num_k_heads
        q_chunk = mx.repeat(q_raw, repeat, axis=2) if repeat > 1 else q_raw
        k_chunk = mx.repeat(k_raw, repeat, axis=2) if repeat > 1 else k_raw
        out, final_state = chunk_gated_delta_rule(q_chunk, k_chunk, v, g, beta, initial)

    outputs = out, final_state
    out = layer.out_proj(layer.norm(outputs[0].astype(x.dtype), z).reshape(B, S, -1))
    return (out, (conv_input[:, -(layer.conv_kernel_size - 1):], outputs[1])) if keep else out


class _Embedding:
    def __init__(self, weight): self.weight = weight
    def __call__(self, ids): return self.weight[ids]


class _Attention:
    def __init__(self, core, backbone, prefix):
        self.core, self.backbone, self.prefix = core, backbone, prefix
        self.num_key_value_heads, self.head_dim = backbone.cfg.kv_heads, backbone.cfg.head_dim
        source = getattr(backbone, "source_model", None)
        self.native = None if source is None else source.core.layers[int(prefix.split('.')[1])].self_attn

    def __call__(self, x, mask, keys):
        from questions_first.backbone import apply_rope
        c, w = self.backbone.cfg, self.backbone.w
        B, T, _ = x.shape
        d, p = c.head_dim, self.prefix
        qg = (self.native.q_proj(x) if self.native else self.core.linear(x, w[p + "q_proj.weight"])).reshape(B, T, c.heads, 2 * d)
        q, gate = qg[..., :d], qg[..., d:]
        q_norm = self.native.q_norm if self.native else _CentredNorm(w[p + "q_norm.weight"], c.eps)
        k_norm = self.native.k_norm if self.native else _CentredNorm(w[p + "k_norm.weight"], c.eps)
        q = q_norm(q).swapaxes(1, 2)
        k = k_norm((self.native.k_proj(x) if self.native else self.core.linear(x, w[p + "k_proj.weight"])).reshape(B, T, c.kv_heads, d)).swapaxes(1, 2)
        v = (self.native.v_proj(x) if self.native else self.core.linear(x, w[p + "v_proj.weight"])).reshape(B, T, c.kv_heads, d).swapaxes(1, 2)
        q = apply_rope(q, self.core.cos, self.core.sin, c.rotary_dim)
        k = apply_rope(k, self.core.cos, self.core.sin, c.rotary_dim)
        k, v = keys.update_and_fetch(k, v)
        out = mx.fast.scaled_dot_product_attention(q, k, v, scale=d ** -0.5, mask=mask)
        out = out.swapaxes(1, 2).reshape(B, T, c.heads * d)
        out = out * mx.sigmoid(gate.reshape(B, T, -1))
        return self.native.o_proj(out) if self.native else self.core.linear(out, w[p + "o_proj.weight"])


class _MLP:
    def __init__(self, core, prefix): self.core, self.prefix = core, prefix
    def __call__(self, x):
        p, w = self.prefix, self.core.backbone.w
        return self.core._mlp_compiled(x, w[p + "gate_proj.weight"], w[p + "up_proj.weight"], w[p + "down_proj.weight"])


class _Layer:
    def __init__(self, core, backbone, index):
        c, w = backbone.cfg, backbone.w
        prefix = f"layers.{index}."
        self.is_linear = c.layer_types[index] == "linear_attention"
        source = getattr(backbone, "source_model", None)
        native = None if source is None else source.core.layers[index]
        self.input_layernorm = native.input_layernorm if native else _CentredNorm(w[prefix + "input_layernorm.weight"], c.eps)
        self.post_attention_layernorm = native.post_attention_layernorm if native else _CentredNorm(w[prefix + "post_attention_layernorm.weight"], c.eps)
        if self.is_linear:
            self.linear_attn = native.linear_attn if native else _DeltaLayer(w, prefix, c, core.linear)
        else:
            self.self_attn = _Attention(core, backbone, prefix + "self_attn.")
        self.mlp = native.mlp if native else _MLP(core, prefix + "mlp.")


class _RawCore:
    def __init__(self, backbone):
        from questions_first import backbone as ops
        self.backbone = backbone
        source = getattr(backbone, "source_model", None)
        self.embed_tokens = source.core.embed_tokens if source else _Embedding(backbone.w["embed_tokens.weight"])
        self.norm = source.core.norm if source else _CentredNorm(backbone.w["norm.weight"], backbone.cfg.eps)
        self.linear = ops.linear
        self._mlp_compiled = ops._mlp_compiled
        self.use_metal = getattr(backbone, "_core_use_metal", False)
        self.layers = [_Layer(self, backbone, i) for i in range(backbone.cfg.layers)]


class _CapturedForward:
    """The captured forward owns layer traversal over the raw model facade."""

    def __init__(self, core):
        self.core = core
        dtype = core.backbone.dtype
        self.blank = []                                                                         # the start before any token
        for layer in self.core.layers:
            if layer.is_linear:
                m = layer.linear_attn
                self.blank.append((mx.zeros((1, m.conv_kernel_size - 1, m.conv_dim), dtype),
                                   mx.zeros((m.num_v_heads, m.head_v_dim, m.head_k_dim), mx.float32)))
            else:
                a = layer.self_attn
                self.blank.append((mx.zeros((1, a.num_key_value_heads, 0, a.head_dim), dtype),) * 2)

    def _forward(self, ids, starts, offset, keep=False, start=None, positions=None,
                 attention_mask=None, keep_mask=None):
        """ids [B, T] continuing `starts` (one state per layer, `offset` tokens long).
        -> final hidden states [B, T, H], and with keep every layer's state after these tokens.

        The raw model adapter also admits batched prefixes and explicit per-row positions/masks.
        """
        B, T = ids.shape
        x = self.core.embed_tokens(ids)
        mask = mx.arange(offset + T)[None, :] <= (offset + mx.arange(T))[:, None]
        if attention_mask is not None:
            mask = attention_mask
        if positions is None:
            positions = offset + mx.arange(T)[None, :]
        from questions_first.backbone import rope_cos_sin
        self.core.cos, self.core.sin = rope_cos_sin(positions, self.core.backbone.cfg, self.core.backbone.dtype)
        kept = []
        for layer, (first, second) in zip(self.core.layers, starts):
            h = layer.input_layernorm(x)
            if layer.is_linear:
                if isinstance(second, tuple):
                    state_start, state_metal = second
                else:
                    state_start, state_metal = second, None
                    if state_start.ndim == 3:
                        state_start = state_start.swapaxes(-1, -2)[None]
                r = _mix(layer.linear_attn, h, first, state_start, keep,
                    start=start, state_metal=state_metal,
                    use_metal=self.core.use_metal or state_metal is not None, keep_mask=keep_mask)
                if keep:
                    r, state = r
                    kept.append(state)
                else:
                    kept.append(None)
            else:
                keys = _keys_for_prefix(first, second, B, start)
                r = layer.self_attn(h, mask, keys)
                kept.append((keys.keys, keys.values))
            x = x + r
            x = x + layer.mlp(layer.post_attention_layernorm(x))
        return x, kept


def _forward_backbone(backbone, ids, positions, attn_mask, past=None, keep=None, start=None):
    """Run captured ``_forward`` over a cached raw-weight layer facade."""
    forward = getattr(backbone, "_captured_core_facade", None)
    if forward is None:
        forward = backbone._captured_core_facade = _CapturedForward(_RawCore(backbone))
    core = forward.core
    core.use_metal = getattr(backbone, "_core_use_metal", False)
    starts = []
    c = backbone.cfg
    for i in range(c.layers):
        prior = None if past is None else past[i]
        if c.layer_types[i] == "linear_attention":
            if prior is None:
                first, state = forward.blank[i]
                state_start, state_metal = state.swapaxes(-1, -2)[None], None
            else:
                first, state_start = prior[:2]
                state_metal = None if len(prior) < 3 else prior[2]
            starts.append((first, (state_start, state_metal)))
        else:
            starts.append(forward.blank[i] if prior is None else (prior[0], prior[1]))
    hidden, kept = forward._forward(ids, starts, 0, keep is not None, start,
                                   positions=positions, attention_mask=attn_mask, keep_mask=keep)
    caches = {i: state for i, state in enumerate(kept)}
    return core.norm(hidden), caches


@dataclass(frozen=True)
class Prepared:
    """An immutable set of question-prefix caches reused across state batches."""

    P: int
    nq: int
    independent: bool
    slots_per_row: int
    nopts: tuple
    tps: tuple
    tpmax: int
    cache: object
    shared: object = None


class Question:
    """One prepared question: its token count, every layer's state after its prefix, and its option count."""

    def __init__(self, tokens, states, options):
        states = tuple(states)
        self.tokens, self.states, self.options = tokens, states, options


class MlxDeciderCore:
    """Question-prefix preparation and batched scoring over a loaded Qwen3.5 backbone.

    This is the owner of prefix batching, the captured residual forward and the indexed gated-delta scan. The raw-weight
    loader in ``questions_first.backbone`` delegates here; ``questions_first.engine`` only re-exports this class.
    """

    def __init__(self, backbone, tok, pad_id, temperature=1.0, tokens_per_batch=16384, use_metal=None):
        self.b = backbone
        self.tok = tok
        self.pad = pad_id
        self.T = float(temperature)
        self.temperature = self.T
        self.labels = P.LabelTable(tok)
        self.opening = self.tok.encode(CONTEXT_OPENING, add_special_tokens=False)
        self.W = backbone.head_rows(self.labels.ids)                 # [255, hidden]
        self.letters = self.W
        self.tokens_per_batch = int(tokens_per_batch)
        # The indexed Metal scan takes key heads in multiples of 32; other shapes use the chunked rule.
        fits = backbone.cfg.lk_dim % 32 == 0
        self.use_metal = (metal_scan.available() and fits) if use_metal is None else bool(use_metal)
        self.b._core_use_metal = self.use_metal
        self.stats = dict(prefix_tokens=0, suffix_tokens=0, padded_suffix_tokens=0, batches=0)
        if not hasattr(backbone, "_captured_core_facade"):
            backbone._captured_core_facade = _CapturedForward(_RawCore(backbone))
        self._captured = backbone._captured_core_facade
        self.core, self.blank = self._captured.core, self._captured.blank

    def _forward(self, ids, starts, offset, keep=False):
        self.core.use_metal = self.use_metal
        return self._captured._forward(ids, starts, offset, keep=keep)

    def _prepare_shared(self, rows):
        """rows: [{"question", "options"}] (decider.systemone.plan_rows order) -> one Question per row."""
        prepared = []
        for row in rows:
            ids = P.prefix_ids(self.tok, self.labels, [row]) + self.opening
            _, states = self._forward(mx.array(ids)[None], self.blank, 0, keep=True)
            mx.eval([s for pair in states for s in pair])
            prepared.append(Question(len(ids), states, len(row["options"])))
        return prepared

    def _answer(self, question, ids, last):
        """ids [B, T] right-padded suffixes, last [B] slot positions -> [B, options] probabilities (lazy)."""
        x, _ = self._forward(ids, question.states, question.tokens)
        slot = self.core.norm(x[mx.arange(ids.shape[0]), last])
        logits = (slot @ self.letters.T).astype(mx.float32)[:, :question.options]
        return mx.softmax(logits / self.temperature, axis=-1)

    def answer(self, prepared, lines, tokens_per_pass=8192, *, shape, max_ctx_tokens=32768,
               on_batch=None, should_stop=None, on_done=None):
        """Return probabilities[line][question][option] for every line and prepared question.

        The source scheduler is bounded to one pending batch so completion callbacks and
        cancellation retain the indexed path's guarantees. Prefix state is broadcast.
        """
        suffixes = [self.tokenize(shape, line, max_ctx_tokens) for line in lines]
        found = np.zeros((len(lines), len(prepared), max(question.options for question in prepared)), dtype=np.float64)
        pending = []
        done = []

        def finish(batch):
            self._collect(batch, found)
            fresh = [state for _, group, _ in batch for state in group]
            done.extend(fresh)
            if on_done is not None:
                on_done(fresh, found)
            if on_batch is not None:
                on_batch(sorted(done), len(lines))

        for q_index, question in enumerate(prepared):
            padded = (([state for state, _ in pairs], ids, last)
                      for pairs, ids, last in self._batches(shape, suffixes, tokens_per_pass))
            for group, ids, last in padded:
                if should_stop is not None and should_stop():
                    break
                probs = self._answer(question, ids, last)
                mx.async_eval(probs)
                self.stats["suffix_tokens"] += sum(len(suffixes[state][0]) for state in group)
                self.stats["padded_suffix_tokens"] += int(ids.size)
                self.stats["batches"] += 1
                if pending:
                    finish(pending)
                    pending = []
                pending.append((q_index, group, probs))
        if pending:
            finish(pending)
        return found

    def answer_questions(self, questions, lines, *, independent, isolated_levels, max_state_tokens,
                        on_answers, should_stop, timings):
        """Run the captured question-to-answer orchestration with the existing streaming hooks."""
        from time import perf_counter
        render_question, render_state, plan_rows, assemble = P.render_question, P.render_state, P.plan_rows, P.assemble
        rendered = {key: render_question(spec) for key, spec in questions.items()}
        rows, index = plan_rows(rendered, isolated_levels and independent)
        started = perf_counter()
        prepared = self.prepare(rows, independent=independent)
        timings["prepare"] = perf_counter() - started
        started = perf_counter()
        probs = self.score(prepared, [render_state(line) for line in lines], max_ctx_tokens=max_state_tokens,
                           should_stop=should_stop,
                           on_done=lambda fresh, values: on_answers([(line, assemble(rendered, index, values[line])) for line in fresh]))
        timings["answer"] = perf_counter() - started
        return probs

    # ---- question prefixes
    def prepare(self, rows, independent=True):
        """rows: [{question, options}] in answer order -> immutable per-layer cache."""
        for row in rows:
            if not 2 <= len(row["options"]) <= P.MAX_OPTIONS:
                raise ValueError(f"a question needs 2 to {P.MAX_OPTIONS} options")
        if len(rows) == 1:
            question = self._prepare_shared(rows)[0]
            self.stats["prefix_tokens"] += question.tokens
            cache = {}
            for layer, state in enumerate(question.states):
                cache[layer] = state if self.b.cfg.layer_types[layer] == "full_attention" else (state[0], state[1], None)
            return Prepared(P=1, nq=1, independent=independent, slots_per_row=1,
                            nopts=(question.options,), tps=(question.tokens,), tpmax=question.tokens,
                            cache=MappingProxyType(cache), shared=question)
        groups = [[row] for row in rows] if independent else [rows]
        prefixes = [P.prefix_ids(self.tok, self.labels, group) + self.opening for group in groups]
        prefix_lengths = [len(prefix) for prefix in prefixes]
        longest_prefix = max(prefix_lengths)
        cfg = self.b.cfg
        parts = {layer: [] for layer in range(cfg.layers)}
        order = sorted(range(len(prefixes)), key=lambda j: prefix_lengths[j])
        placed = []
        start = 0
        while start < len(order):
            end = start + 1
            while end < len(order) and (end - start + 1) * prefix_lengths[order[end]] <= self.tokens_per_batch:
                end += 1
            indices = order[start:end]
            length = prefix_lengths[indices[-1]]
            ids = np.full((len(indices), length), self.pad, dtype=np.int32)
            keep = np.zeros((len(indices), length), dtype=np.float32)
            for row_index, prefix_index in enumerate(indices):
                ids[row_index, length - prefix_lengths[prefix_index]:] = prefixes[prefix_index]
                keep[row_index, length - prefix_lengths[prefix_index]:] = 1
            padlen = mx.array([length - prefix_lengths[index] for index in indices])[:, None]
            ar = mx.arange(length)[None, :]
            causal = mx.tril(mx.ones((length, length), dtype=mx.bool_))
            mask = (causal[None] & (ar >= padlen)[:, None, :]) | mx.eye(length, dtype=mx.bool_)[None]
            _, caches = self.b.forward(mx.array(ids), ar - padlen, mask[:, None], keep=mx.array(keep))
            for layer, state in caches.items():
                if cfg.layer_types[layer] == "full_attention":
                    extra = longest_prefix - length
                    if extra:
                        state = tuple(mx.pad(tensor, [(0, 0), (0, 0), (extra, 0), (0, 0)]) for tensor in state)
                elif self.use_metal:
                    state = (state[0], None, state[1].swapaxes(-1, -2))
                else:
                    state = (state[0], state[1], None)
                mx.eval([tensor for tensor in state if tensor is not None])
                parts[layer].append(state)
            placed += indices
            self.stats["prefix_tokens"] += len(indices) * length
            start = end
        restore_order = mx.array(np.argsort(np.array(placed)))
        cache = {}
        for layer, pieces in parts.items():
            cache[layer] = tuple(
                None if pieces[0][slot] is None else mx.concatenate([piece[slot] for piece in pieces], axis=0)[restore_order]
                for slot in range(len(pieces[0]))
            )
            mx.eval([tensor for tensor in cache[layer] if tensor is not None])
        return Prepared(
            P=len(groups), nq=len(rows), independent=independent,
            slots_per_row=1 if independent else len(rows), nopts=tuple(len(row["options"]) for row in rows),
            tps=tuple(prefix_lengths), tpmax=longest_prefix, cache=MappingProxyType(cache),
        )

    # ---- states
    def line_tokens(self, line, max_tokens=32768):
        """A line's suffix after the shared opening: its own tokens, then the answer slot. -> ids (the slot is the last)."""
        from questions_first.prompt import suffix_ids as schema_suffix_ids
        ids, slots = schema_suffix_ids(self.tok, line, 1, max_tokens)
        assert ids[:len(self.opening)] == self.opening and slots == [len(ids) - 1]
        return ids[len(self.opening):]

    def tokenize(self, prepared, context, max_ctx_tokens):
        if prepared.slots_per_row == 1:
            ids = self.line_tokens(context, max_ctx_tokens)
            return ids, [len(ids) - 1]
        return P.suffix_ids(self.tok, context, prepared.slots_per_row, max_ctx_tokens, opening=False)

    def _probabilities(self, prepared, suffixes, pairs, ids, last):
        """pairs: [(state index, prefix index)] -> lazy logits, with one row per answer slot."""
        suffix_length = max(len(suffixes[state][0]) for state, _ in pairs)
        row_count = len(pairs)
        rows, slots = [], []
        for row_index, (state_index, _) in enumerate(pairs):
            for slot in suffixes[state_index][1]:
                rows.append(row_index)
                slots.append(slot)
            self.stats["suffix_tokens"] += len(suffixes[state_index][0])
        start = mx.array(np.array([prefix for _, prefix in pairs], dtype=np.int32))
        prefix_lengths = mx.array(np.array([prepared.tps[prefix] for _, prefix in pairs], dtype=np.int32))[:, None]
        ar = mx.arange(suffix_length)[None, :]
        prefix_valid = mx.arange(prepared.tpmax)[None, :] >= (prepared.tpmax - prefix_lengths)
        causal = mx.tril(mx.ones((suffix_length, suffix_length), dtype=mx.bool_))
        mask = mx.concatenate([
            mx.broadcast_to(prefix_valid[:, None, :], (row_count, suffix_length, prepared.tpmax)),
            mx.broadcast_to(causal[None], (row_count, suffix_length, suffix_length)),
        ], axis=-1)[:, None]
        hidden, _ = self.b.forward(ids, prefix_lengths + ar, mask, past=prepared.cache, start=start)
        slot_hidden = hidden[mx.arange(row_count), last] if prepared.slots_per_row == 1 else hidden[mx.array(rows), mx.array(slots)]
        logits = (slot_hidden @ self.W.T).astype(mx.float32)
        self.stats["padded_suffix_tokens"] += row_count * suffix_length
        self.stats["batches"] += 1
        return logits

    def _batches(self, prepared, suffixes, tokens_per_pass=None):
        """Length-group states and their prefixes under the configured token budget."""
        lines = [(state, prefix) for state in range(len(suffixes)) for prefix in range(prepared.P)]
        suffixes = [suffixes[state][0] for state, _ in lines]
        tokens_per_pass = self.tokens_per_batch if tokens_per_pass is None else tokens_per_pass
        prefix_cost = prepared.tpmax // 4
        order = sorted(range(len(lines)), key=lambda i: len(suffixes[i]))
        groups, at = [], 0
        while at < len(order):                       # similar lengths share a pass, so little of it is padding
            longest = len(suffixes[order[at]]); take = 1
            while at + take < len(order) and (max(longest, len(suffixes[order[at + take]])) + prefix_cost) * (take + 1) <= tokens_per_pass:
                longest = max(longest, len(suffixes[order[at + take]])); take += 1
            groups.append(order[at:at + take]); at += take
        pad = self.pad
        for group in groups:
            T = max(len(suffixes[i]) for i in group)
            # Preserve the current bounded queue: do not materialize all padded state
            # batches before a cancellation or the first completed-state readback.
            ids = mx.array([suffixes[i] + [pad] * (T - len(suffixes[i])) for i in group])
            last = mx.array([len(suffixes[i]) - 1 for i in group])
            yield [lines[index] for index in group], ids, last

    def score(self, prepared, contexts, max_ctx_tokens=32768, on_batch=None, should_stop=None, on_done=None):
        """Return [states, questions, max-options] probabilities and stream completed-state callbacks.

        ``on_batch(done, total)`` reports completed state indices after each readback. ``on_done(fresh, out)`` hands
        each completed state's final answers off once. ``should_stop()`` is checked before each queued batch; states
        not completed before a stop retain zero rows. The immutable prefix cache is read only throughout scoring.
        One batch is queued on the device while the preceding batch is read back.
        """
        if prepared.shared is not None:
            return self.answer([prepared.shared], contexts, self.tokens_per_batch, shape=prepared,
                               max_ctx_tokens=max_ctx_tokens, on_batch=on_batch, should_stop=should_stop, on_done=on_done)
        suffixes = [self.tokenize(prepared, context, max_ctx_tokens) for context in contexts]
        state_count = len(contexts)
        out = np.zeros((state_count, prepared.nq, max(prepared.nopts)), dtype=np.float64)
        option_counts = np.array(prepared.nopts)
        left = {state: prepared.P for state in range(state_count)}
        done = []

        def read(batch, logits):
            rows = np.array(logits)
            question_for_row = []
            for state, prefix in batch:
                question_for_row += [(state, prefix)] if prepared.independent else [(state, question) for question in range(prepared.nq)]
            pending = {}
            for (state, question), row in zip(question_for_row, rows):
                values = row[:option_counts[question]].astype(np.float64)
                values = values / self.T
                values = np.exp(values - values.max())
                probabilities = np.zeros(out.shape[-1], dtype=out.dtype)
                probabilities[:option_counts[question]] = values / values.sum()
                group, answers = pending.setdefault(question, ([], []))
                group.append(state)
                answers.append(probabilities)
            self._collect([(question, group, np.array(answers)) for question, (group, answers) in pending.items()], out)
            fresh = []
            for state, _ in batch:
                left[state] -= 1
                if left[state] == 0:
                    done.append(state)
                    fresh.append(state)
            if on_done is not None and fresh:
                on_done(fresh, out)
            if on_batch is not None:
                on_batch(sorted(done), state_count)

        pending = None
        for batch, ids, last in self._batches(prepared, suffixes):
            if should_stop is not None and should_stop():
                break
            logits = self._probabilities(prepared, suffixes, batch, ids, last)
            mx.async_eval(logits)
            if pending is not None:
                read(*pending)
            pending = (batch, logits)
        if pending is not None:
            read(*pending)
        return out

    @staticmethod
    def _collect(pending, found):
        for q_index, group, probs in pending:
            for line, p in zip(group, probs.tolist()):
                found[line][q_index] = p


__all__ = ["MlxDeciderCore", "Prepared"]
