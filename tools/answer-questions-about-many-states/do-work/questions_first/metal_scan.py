"""The gated-delta recurrence as one Metal kernel, for rows that each continue one of several prepared start states.

From the decider lane's earlier MLX build (ai-command-center .claude/hooks/judges/decide_in_batches_on_mlx.py, measured
on the M5 Max on 2026-11-05), itself mlx_lm's gated-delta kernel with the start state shared: here a row reads its
start from `state_in[start[row]]`, so many questions' rows share one pass and no state is copied per row, and only
the outputs are written (nothing reads the state after a line).

Inputs, all float32 except `start` (int32):
    q, k: [B, T, Hk, Dk] already L2-normalised (q also scaled by Dk ** -0.5); v: [B, T, Hv, Dv];
    decay: [B, T, Hv] = exp(g), the factor the state is multiplied by; beta: [B, T, Hv];
    state_in: [P, Hv, Dv, Dk] (note: Dv before Dk); start: [B].
Output y: [B, T, Hv, Dv] float32. Dk must be a multiple of 32.
"""
import mlx.core as mx

_SOURCE = """
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

    auto p_idx = start[b_idx];
    auto i_state = state_in + ((p_idx * Hv + hv_idx) * Dv + dv_idx) * Dk;

    float state[n_per_t];
    for (int i = 0; i < n_per_t; ++i) {
      state[i] = static_cast<float>(i_state[n_per_t * dk_idx + i]);
    }

    auto g_ = decay + b_idx * T * Hv;
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
        y[dv_idx] = static_cast<float>(out);
      }
      q_ += Hk * Dk;
      k_ += Hk * Dk;
      v_ += Hv * Dv;
      y += Hv * Dv;
      g_ += Hv;
      beta_ += Hv;
    }
"""

_KERNEL = None


def available():
    try:
        return mx.metal.is_available()
    except Exception:
        return False


def scan(q, k, v, decay, beta, state_in, start):
    global _KERNEL
    if _KERNEL is None:
        _KERNEL = mx.fast.metal_kernel(name="gated_delta_indexed_start",
                                       input_names=["q", "k", "v", "decay", "beta", "state_in", "start", "T"],
                                       output_names=["y"], source=_SOURCE)
    B, T, Hk, Dk = q.shape
    Hv, Dv = v.shape[2], v.shape[3]
    if Dk % 32:
        raise ValueError(f"the Metal scan needs the key head size to be a multiple of 32, not {Dk}")
    return _KERNEL(inputs=[q, k, v, decay, beta, state_in, start, T],
                   template=[("Dk", Dk), ("Dv", Dv), ("Hk", Hk), ("Hv", Hv)],
                   grid=(32, Dv, B * Hv), threadgroup=(32, 4, 1),
                   output_shapes=[(B, T, Hv, Dv)], output_dtypes=[mx.float32])[0]
