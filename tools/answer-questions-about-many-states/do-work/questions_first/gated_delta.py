"""The chunked gated delta rule in MLX: a port of transformers' `torch_chunk_gated_delta_rule` (the reference the
decider runs where flash-linear-attention cannot, as on a Mac), written for batches of rows that each start from
their own recurrent state.

Everything is computed in float32, as the reference does. The one change is how the unit lower-triangular system of
each chunk is solved. The reference calls `torch.linalg.solve_triangular`; here the inverse is built by recursive
block inversion (1x1 blocks up to the chunk), which is exact in exact arithmetic, needs only matmuls (so it runs on
the GPU), and keeps every intermediate equal to an entry of the true inverse, so it does not overflow the way a
Neumann series in powers of the strictly lower part would when keys are correlated.
"""
import mlx.core as mx

CHUNK = 64


def l2norm(x, eps=1e-6):
    return x * mx.rsqrt((x * x).sum(axis=-1, keepdims=True) + eps)


def unit_lower_inverse(n_strict):
    """Inverse of I + N for N strictly lower triangular, shape [..., C, C] with C a power of two."""
    C = n_strict.shape[-1]
    lead = n_strict.shape[:-2]
    inv = mx.ones((*lead, C, 1, 1), dtype=n_strict.dtype)          # C diagonal blocks of size 1, each the inverse 1
    s = 1
    while s < C:
        nb = C // (2 * s)
        # the off-diagonal block C_k of each 2s diagonal block k: rows k*2s+s .. (k+1)*2s, columns k*2s .. k*2s+s
        offs = mx.stack([n_strict[..., k * 2 * s + s:(k + 1) * 2 * s, k * 2 * s:k * 2 * s + s] for k in range(nb)], axis=-3)
        a_inv = inv[..., 0::2, :, :]
        d_inv = inv[..., 1::2, :, :]
        lower = -(d_inv @ offs @ a_inv)
        zeros = mx.zeros_like(a_inv)
        top = mx.concatenate([a_inv, zeros], axis=-1)
        bottom = mx.concatenate([lower, d_inv], axis=-1)
        inv = mx.concatenate([top, bottom], axis=-2)                 # [..., nb, 2s, 2s]
        s *= 2
    return inv.reshape(*lead, C, C)


def chunk_gated_delta_rule(q, k, v, g, beta, initial_state=None, chunk=CHUNK):
    """q, k: [B, T, H, Dk]; v: [B, T, H, Dv]; g (log decay, <= 0), beta: [B, T, H];
    initial_state: [B, H, Dk, Dv] or None. Returns (out [B, T, H, Dv] in q's dtype, final state [B, H, Dk, Dv] float32).
    Queries and keys are L2-normalised here and queries scaled by Dk ** -0.5, as the reference's
    use_qk_l2norm_in_kernel=True does."""
    out_dtype = q.dtype
    B, T, H, Dk = k.shape
    Dv = v.shape[-1]
    f32 = mx.float32
    q, k, v, beta, g = (x.astype(f32).swapaxes(1, 2) for x in (q, k, v, beta, g))   # [B, H, T, ...]
    q = l2norm(q)
    k = l2norm(k)
    q = q * (Dk ** -0.5)

    pad = (chunk - T % chunk) % chunk
    if pad:
        q, k, v = (mx.pad(x, [(0, 0), (0, 0), (0, pad), (0, 0)]) for x in (q, k, v))
        beta, g = (mx.pad(x, [(0, 0), (0, 0), (0, pad)]) for x in (beta, g))
    Tp = T + pad
    n = Tp // chunk

    v_beta = v * beta[..., None]
    k_beta = k * beta[..., None]
    q, k, k_beta, v_beta = (x.reshape(B, H, n, chunk, x.shape[-1]) for x in (q, k, k_beta, v_beta))
    g = g.reshape(B, H, n, chunk)

    upper = mx.triu(mx.ones((chunk, chunk), dtype=mx.bool_), k=1)
    cum = mx.cumsum(g, axis=-1)
    pair = cum[..., :, None] - cum[..., None, :]
    pair = mx.exp(mx.where(upper, -mx.inf, pair))

    ut = (k_beta @ k.swapaxes(-1, -2)) * pair
    intra = (q @ k.swapaxes(-1, -2)) * pair
    decayed_k_beta = k_beta * mx.exp(cum)[..., None]

    strict = mx.where(mx.tril(mx.ones((chunk, chunk), dtype=mx.bool_), k=-1), ut, 0.0)
    inv = unit_lower_inverse(strict)
    new_values = inv @ v_beta
    k_cumdecay = inv @ decayed_k_beta

    state = mx.zeros((B, H, Dk, Dv), dtype=f32) if initial_state is None else initial_state.astype(f32)
    qd = q * mx.exp(cum)[..., None]
    kd = k * mx.exp(cum[..., -1:] - cum)[..., None]
    chunk_decay = mx.exp(cum[..., -1])[..., None, None]             # [B, H, n, 1, 1]

    outs = []
    for i in range(n):
        v_new = new_values[:, :, i] - k_cumdecay[:, :, i] @ state
        outs.append(qd[:, :, i] @ state + intra[:, :, i] @ v_new)
        state = state * chunk_decay[:, :, i] + kd[:, :, i].swapaxes(-1, -2) @ v_new
    out = mx.stack(outs, axis=2).reshape(B, H, Tp, Dv)[:, :, :T]
    return out.swapaxes(1, 2).astype(out_dtype), state


def recurrent_gated_delta_rule(q, k, v, g, beta, initial_state=None):
    """One token at a time (the reference's `torch_recurrent_gated_delta_rule`); used by the tests as a second check."""
    out_dtype = q.dtype
    B, T, H, Dk = k.shape
    f32 = mx.float32
    q, k, v, beta, g = (x.astype(f32).swapaxes(1, 2) for x in (q, k, v, beta, g))
    q = l2norm(q) * (Dk ** -0.5)
    k = l2norm(k)
    state = mx.zeros((B, H, Dk, v.shape[-1]), dtype=f32) if initial_state is None else initial_state.astype(f32)
    outs = []
    for t in range(T):
        state = state * mx.exp(g[:, :, t])[..., None, None]
        kv = (state * k[:, :, t][..., None]).sum(axis=-2)
        delta = (v[:, :, t] - kv) * beta[:, :, t][..., None]
        state = state + k[:, :, t][..., None] * delta[..., None, :]
        outs.append((state * q[:, :, t][..., None]).sum(axis=-2))
    return mx.stack(outs, axis=2).swapaxes(1, 2).astype(out_dtype), state
