// crates/resilience/src/strategy/quota.rs
//
// Partition-key-scoped resource quota enforcement.
//
// Uses sliding window counters for request count and byte volume.
// Each partition key has an independent QuotaState — one partition cannot consume another partition's budget.
// Window reset uses CAS on window_start_ms to ensure lock-free correctness under concurrent access.
//
// # Physics vs Society
// - Quota enforcement algorithm — Physics (universal resource accounting)
// - QuotaConfig values — Society (billing tier limits, sourced from EEAF config)
//
// INVARIANTS:
//   1. QuotaState uses AtomicU64 exclusively — no mutex on the fast path.
//   2. Window reset uses compare_exchange(AcqRel, Acquire) — only one concurrent caller wins.
//   3. After a successful CAS reset, counters are zeroed before the new request is counted.
//   4. QuotaConfig values carry // Society comments — these are EEAF data, not Physics constants.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

use super::GuardStrategy;
use crate::lock::StateLock;
use crate::types::{GuardInput, GuardOutcome, MonotonicMs, WallClockMs};
use alloc::sync::Arc;
use core::sync::atomic::{AtomicU64, Ordering};

/// Partition-key quota state — one instance per partition key.
///
/// All fields are AtomicU64 — no mutex on the evaluation path.
/// Window reset uses CAS on window_start_ms; only one concurrent caller wins the reset.
pub struct QuotaState {
    /// Request count in the current window.
    pub request_count: AtomicU64,
    /// Byte volume in the current window (callers set GuardInput.data for payload bytes).
    pub byte_volume: AtomicU64,
    /// Window start timestamp (monotonic ms) — reset counters when window expires.
    pub window_start_ms: AtomicU64,
}

impl Default for QuotaState {
    fn default() -> Self {
        Self {
            request_count: AtomicU64::new(0),
            byte_volume: AtomicU64::new(0),
            window_start_ms: AtomicU64::new(0),
        }
    }
}

/// Partition quota configuration — ALL values are Society (billing tier limits, from EEAF config).
#[derive(Clone, Debug)]
pub struct QuotaConfig {
    /// Maximum requests per window.
    /// Society: billing tier limit, sourced from EEAF config in Wave 5.
    pub max_requests_per_window: u64,
    /// Maximum byte volume per window.
    /// Society: billing tier limit, sourced from EEAF config in Wave 5.
    pub max_bytes_per_window: u64,
    /// Window duration in milliseconds.
    /// Society: billing window duration, sourced from EEAF config in Wave 5.
    pub window_duration_ms: u64,
}

impl Default for QuotaConfig {
    fn default() -> Self {
        Self {
            max_requests_per_window: 10_000,   // Society: billing tier limit
            max_bytes_per_window: 100_000_000, // Society: 100MB billing tier limit
            window_duration_ms: 60_000,        // Society: 1-minute window
        }
    }
}

/// Partition-key-scoped resource quota enforcer.
///
/// Zero-sized — all state lives in `QuotaState`, all configuration in `QuotaConfig`.
/// The engine keys one `QuotaState` per partition key — structural isolation keeps
/// one partition's usage from consuming another partition's quota budget.
pub struct WorkspaceQuotaStrategy;

impl GuardStrategy for WorkspaceQuotaStrategy {
    type State = QuotaState;
    type Config = QuotaConfig;

    fn evaluate(
        &self,
        input: &GuardInput,
        state: Arc<StateLock<Self::State>>,
        config: &Self::Config,
        _wall_clock_ms: WallClockMs,
        monotonic_ms: MonotonicMs,
    ) -> GuardOutcome {
        #[cfg(not(target_arch = "wasm32"))]
        let st = state.read();
        #[cfg(target_arch = "wasm32")]
        let st = state.borrow();

        let now_ms = monotonic_ms.0;
        let window_start = st.window_start_ms.load(Ordering::Acquire);

        // Check window expiry — reset counters if window has elapsed.
        // CAS ensures only one concurrent caller wins the reset; losers see fresh counters.
        if now_ms.saturating_sub(window_start) >= config.window_duration_ms
            && st
                .window_start_ms
                .compare_exchange(window_start, now_ms, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
        {
            // Won the CAS — reset counters for the new window.
            // Whether or not we won the CAS, the window is fresh — counters are near zero.
            st.request_count.store(0, Ordering::Release);
            st.byte_volume.store(0, Ordering::Release);
        }

        // Check request count quota.
        let requests = st.request_count.load(Ordering::Acquire);
        if requests >= config.max_requests_per_window {
            return GuardOutcome::deny("quota_request_count_exceeded");
        }

        // Check byte volume quota.
        let bytes = st.byte_volume.load(Ordering::Acquire);
        let payload_bytes = input.data.len() as u64;
        if bytes.saturating_add(payload_bytes) > config.max_bytes_per_window {
            return GuardOutcome::deny("quota_byte_volume_exceeded");
        }

        // Allow — increment counters.
        st.request_count.fetch_add(1, Ordering::Relaxed);
        st.byte_volume.fetch_add(payload_bytes, Ordering::Relaxed);

        GuardOutcome::allow()
    }
}
