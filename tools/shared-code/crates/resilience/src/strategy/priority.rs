// crates/resilience/src/strategy/priority.rs
//
// Priority-based request shedding under load.
//
// Under high load (in_flight >= shed_threshold), DENY low-priority requests.
// High-priority requests (priority >= high_priority_threshold) always pass.
// Zero lock contention on the fast path — two atomics: in_flight + shed_active.
//
// # Priority Scale
// - 0: lowest (background tasks, analytics, batch jobs)
// - 127: normal (interactive requests)
// - 255: highest (auth, health checks, admin operations)
//
// # Physics vs Society
// - Priority ordering under load — Physics (universal: under resource contention,
//   differentiated service is structurally correct)
// - Priority threshold values — Society (operator policy from EEAF config)
//
// # Hysteresis
// shed_active is set when in_flight >= shed_threshold, cleared when in_flight < shed_release_threshold.
// This prevents oscillation at the boundary.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

use super::GuardStrategy;
use crate::{
    lock::StateLock,
    types::{GuardInput, GuardOutcome, MonotonicMs, WallClockMs},
};
use alloc::sync::Arc;
use core::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Priority shedding state — two atomics, zero lock contention on fast path.
pub struct PriorityState {
    /// Current in-flight request count.
    pub in_flight: AtomicU64,
    /// Shed mode active — true when in_flight >= shed_threshold.
    pub shed_active: AtomicBool,
}

impl Default for PriorityState {
    fn default() -> Self {
        Self {
            in_flight: AtomicU64::new(0),
            shed_active: AtomicBool::new(false),
        }
    }
}

/// Priority shedding configuration — ALL values are Society.
#[derive(Clone, Debug)]
pub struct PriorityConfig {
    /// in_flight threshold above which shedding activates.
    /// Society: operator-tuned from EEAF config in Wave 5.
    pub shed_threshold: u64,
    /// Minimum priority to admit under load.
    /// Requests with priority < min_priority_under_load are shed.
    /// Society: operator-tuned from EEAF config in Wave 5.
    pub min_priority_under_load: u8,
    /// Priority level that always passes, even under maximum load.
    /// Society: operator-tuned from EEAF config in Wave 5.
    pub high_priority_threshold: u8,
    /// in_flight below which shed mode deactivates (hysteresis gap).
    /// Must be <= shed_threshold to create the hysteresis window.
    /// Society: operator-tuned from EEAF config in Wave 5.
    pub shed_release_threshold: u64,
}

impl Default for PriorityConfig {
    fn default() -> Self {
        Self {
            shed_threshold: 512,          // Society: EEAF config in Wave 5
            min_priority_under_load: 64,  // Society: EEAF config in Wave 5
            high_priority_threshold: 200, // Society: EEAF config in Wave 5
            shed_release_threshold: 384,  // Society: EEAF config in Wave 5 (hysteresis gap)
        }
    }
}

/// Priority-based request shedder — zero-sized strategy struct.
///
/// All state lives in `PriorityState` (owned by `GuardStorage`).
pub struct PriorityShedStrategy;

impl PriorityShedStrategy {
    /// Decrement in_flight after request completes.
    ///
    /// MUST be called by the caller after every request that was allowed by `evaluate()`.
    /// Uses saturating_sub to guard against double-complete bugs (underflow = catastrophic).
    pub fn complete(state: &Arc<StateLock<PriorityState>>) {
        #[cfg(not(target_arch = "wasm32"))]
        let st = state.read();
        #[cfg(target_arch = "wasm32")]
        let st = state.borrow();

        let _ = st
            .in_flight
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |v| {
                Some(v.saturating_sub(1))
            });
    }
}

impl GuardStrategy for PriorityShedStrategy {
    type State = PriorityState;
    type Config = PriorityConfig;

    fn evaluate(
        &self,
        input: &GuardInput,
        state: Arc<StateLock<Self::State>>,
        config: &Self::Config,
        _wall_clock_ms: WallClockMs,
        _monotonic_ms: MonotonicMs,
    ) -> GuardOutcome {
        // Read lock suffices — all mutations go through atomics, no write lock needed.
        #[cfg(not(target_arch = "wasm32"))]
        let st = state.read();
        #[cfg(target_arch = "wasm32")]
        let st = state.borrow();

        let in_flight = st.in_flight.load(Ordering::Acquire);

        // Update shed_active with hysteresis — prevents oscillation at the threshold boundary.
        if in_flight >= config.shed_threshold {
            st.shed_active.store(true, Ordering::Release);
        } else if in_flight < config.shed_release_threshold {
            st.shed_active.store(false, Ordering::Release);
        }
        // In the hysteresis window [shed_release_threshold, shed_threshold): no change to shed_active.

        let shedding = st.shed_active.load(Ordering::Acquire);
        let priority = input.priority;

        // High-priority: always pass, even under full load.
        // This is Physics — high-priority requests must not be affected by load shedding.
        if priority >= config.high_priority_threshold {
            st.in_flight.fetch_add(1, Ordering::AcqRel);
            return GuardOutcome::allow();
        }

        // Under load: shed low-priority requests.
        if shedding && priority < config.min_priority_under_load {
            return GuardOutcome::deny("PRIORITY_SHED: low_priority_under_load");
        }

        // Normal pass — priority is above the shed floor (or shedding is not active).
        st.in_flight.fetch_add(1, Ordering::AcqRel);
        GuardOutcome::allow()
    }
}
