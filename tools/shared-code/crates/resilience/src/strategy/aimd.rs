// crates/resilience/src/strategy/aimd.rs
//
// AIMD (Additive Increase / Multiplicative Decrease) Concurrency Limiter.
//
// Applies TCP congestion control semantics to concurrent request limiting:
//   - On success: limit += additive_increase (linear growth toward ceiling)
//   - On timeout/error: limit *= (1 - multiplicative_decrease) (fast drop, slow recovery)
//
// # Physics vs Society
//   - The AIMD algorithm is Physics (universal congestion signal response)
//   - AimdConfig values are Society (operator-tuned, sourced from EEAF config)
//
// # Invariants
//   1. `in_flight` is an AtomicU64 — incremented on evaluate(Allow), decremented by caller on completion.
//   2. `limit` is stored as f64 × FIXED_SCALE in an AtomicU64 (fixed-point, avoids float atomics).
//   3. `limit` never goes below `min_limit` or above `max_limit`.
//   4. CAS loop is used for limit_fixed updates — no mutex, wait-free on the fast path.
//   5. Caller MUST call AimdStrategy::complete() after every allowed request completes.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

use super::GuardStrategy;
use crate::{
    lock::StateLock,
    types::{GuardEvent, GuardInput, GuardOutcome, MonotonicMs, WallClockMs},
};
use alloc::sync::Arc;
use core::sync::atomic::{AtomicU64, Ordering};

/// Fixed-point scale for storing f64 limit as u64.
/// limit_fixed = (limit * FIXED_SCALE) as u64
const FIXED_SCALE: f64 = 1_000.0;

/// AIMD concurrency limiter state.
///
/// # Thread Safety
/// `in_flight` and `limit_fixed` are separate AtomicU64s — no lock needed for the common path.
/// A read-lock on `StateLock` is sufficient because all mutations go through atomic CAS.
/// `success_count` and `drop_count` are monotonically increasing diagnostic counters.
pub struct AimdState {
    /// Current number of in-flight requests.
    pub in_flight: AtomicU64,
    /// Current concurrency limit stored as (limit * FIXED_SCALE) as u64.
    /// Default: min_limit (10.0) × FIXED_SCALE = 10_000.
    pub limit_fixed: AtomicU64,
    /// Monotonic success counter — drives additive increase trigger.
    pub success_count: AtomicU64,
    /// Monotonic drop count — diagnostic counter, incremented on every Deny.
    pub drop_count: AtomicU64,
}

impl Default for AimdState {
    fn default() -> Self {
        Self {
            in_flight: AtomicU64::new(0),
            limit_fixed: AtomicU64::new((10.0 * FIXED_SCALE) as u64), // default min=10
            success_count: AtomicU64::new(0),
            drop_count: AtomicU64::new(0),
        }
    }
}

/// AIMD configuration — all values are Society (operator-tuned from EEAF config in Wave 5).
#[derive(Clone, Debug)]
pub struct AimdConfig {
    /// Additive increase per success window (e.g. 1.0 = +1 per window).
    pub additive_increase: f64, // Society: EEAF config in Wave 5
    /// Multiplicative decrease factor on congestion (e.g. 0.5 = halve the limit).
    pub multiplicative_decrease: f64, // Society: EEAF config in Wave 5
    /// Minimum concurrency limit — never go below this.
    pub min_limit: f64, // Society: EEAF config in Wave 5
    /// Maximum concurrency limit — never go above this.
    pub max_limit: f64, // Society: EEAF config in Wave 5
    /// Number of successes before applying one additive increase.
    pub success_window: u64, // Society: EEAF config in Wave 5
}

impl Default for AimdConfig {
    fn default() -> Self {
        Self {
            additive_increase: 1.0,       // Society: EEAF config in Wave 5
            multiplicative_decrease: 0.5, // Society: EEAF config in Wave 5
            min_limit: 10.0,              // Society: EEAF config in Wave 5
            max_limit: 1024.0,            // Society: EEAF config in Wave 5
            success_window: 100,          // Society: EEAF config in Wave 5
        }
    }
}

/// AIMD concurrency limiter — `GuardStrategy` implementation.
///
/// Zero-sized struct. All state lives in `AimdState` (owned by `GuardStorage`).
pub struct AimdStrategy;

impl AimdStrategy {
    /// Decrement `in_flight` after request completes.
    ///
    /// MUST be called by the caller after every request that was allowed by `evaluate()`.
    /// The strategy cannot observe request completion — the caller (daemon dispatch path)
    /// calls this in a Drop guard or after the request awaits completion.
    ///
    /// Only a read lock is needed — all mutations are atomic CAS on `in_flight`.
    pub fn complete(state: &Arc<StateLock<AimdState>>) {
        #[cfg(not(target_arch = "wasm32"))]
        let st = state.read();
        #[cfg(target_arch = "wasm32")]
        let st = state.borrow();

        // Saturating sub guards against double-complete bugs (underflow would be catastrophic)
        let prev = st
            .in_flight
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |v| {
                Some(v.saturating_sub(1))
            });
        let _ = prev; // fetch_update always returns Ok when the closure returns Some
    }
}

impl GuardStrategy for AimdStrategy {
    type State = AimdState;
    type Config = AimdConfig;

    fn evaluate(
        &self,
        input: &GuardInput,
        state: Arc<StateLock<Self::State>>,
        config: &Self::Config,
        _wall_clock_ms: WallClockMs,
        _monotonic_ms: MonotonicMs,
    ) -> GuardOutcome {
        // Read lock suffices — all mutations go through atomic CAS, no write lock needed.
        #[cfg(not(target_arch = "wasm32"))]
        let st = state.read();
        #[cfg(target_arch = "wasm32")]
        let st = state.borrow();

        let in_flight = st.in_flight.load(Ordering::Acquire);
        let limit_fixed = st.limit_fixed.load(Ordering::Acquire);
        let limit = (limit_fixed as f64) / FIXED_SCALE;

        if (in_flight as f64) >= limit {
            // Over limit — DENY + multiplicative decrease
            st.drop_count.fetch_add(1, Ordering::Relaxed);

            // Multiplicative decrease: new_limit = limit * (1 - multiplicative_decrease)
            // Clamped to min_limit from below.
            let new_limit = (limit * (1.0 - config.multiplicative_decrease)).max(config.min_limit);
            let new_limit_fixed = (new_limit * FIXED_SCALE) as u64;

            // CAS loop: only decrease if current limit > new_limit (prevent racing increase from winning)
            let mut current = limit_fixed;
            loop {
                match st.limit_fixed.compare_exchange_weak(
                    current,
                    new_limit_fixed,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                ) {
                    Ok(_) => break,
                    Err(actual) => {
                        // Another thread already reduced below our new_limit — stop.
                        if actual <= new_limit_fixed {
                            break;
                        }
                        current = actual;
                    }
                }
            }

            return GuardOutcome::deny_with_event(
                "aimd_concurrency_exceeded",
                GuardEvent::Custom {
                    peer_id: input.peer_id.clone(),
                    kind: "aimd_deny",
                },
            );
        }

        // Under limit — ALLOW + increment in_flight
        st.in_flight.fetch_add(1, Ordering::AcqRel);

        // Additive increase: every success_window successes, increase limit by additive_increase
        let successes = st.success_count.fetch_add(1, Ordering::Relaxed) + 1;
        if successes % config.success_window == 0 {
            let new_limit = (limit + config.additive_increase).min(config.max_limit);
            let new_limit_fixed = (new_limit * FIXED_SCALE) as u64;

            // CAS loop: only increase if current limit < new_limit (prevent racing decrease from winning)
            let mut current = limit_fixed;
            loop {
                match st.limit_fixed.compare_exchange_weak(
                    current,
                    new_limit_fixed,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                ) {
                    Ok(_) => break,
                    Err(actual) => {
                        // Another thread already increased beyond our new_limit — stop.
                        if actual >= new_limit_fixed {
                            break;
                        }
                        current = actual;
                    }
                }
            }
        }

        GuardOutcome::allow_with_event(GuardEvent::Custom {
            peer_id: input.peer_id.clone(),
            kind: "aimd_allow",
        })
    }
}
