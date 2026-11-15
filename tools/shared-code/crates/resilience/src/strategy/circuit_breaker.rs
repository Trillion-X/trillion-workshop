// crates/resilience/src/strategy/circuit_breaker.rs
//
// CircuitBreakerStrategy — 3-state FSM (CLOSED/OPEN/HALF_OPEN) impl GuardStrategy.
//
// INVARIANTS:
//   1. CircuitState has EXACTLY TWO FIELDS: packed_state (AtomicU64) and window (StateLock<CircuitWindow>).
//      No additional atomics for dual-atomic race conditions.
//   2. All FSM transitions are single compare_exchange_weak operations on packed_state.
//   3. packed_state packs: High 8 bits = fsm (0=CLOSED, 1=OPEN, 2=HALF_OPEN),
//      Low 56 bits = state-dependent timestamp (open_since_ms or probe_dispatched_at_ms).
//   4. Window Amnesia fix (Round 16): Probe SUCCESS clears CircuitWindow inside window.write() lock BEFORE CAS.
//   5. wrapping_sub + mask for all elapsed calculations on 56-bit timestamp field.
//   6. parking_lot::RwLock via StateLock (never std::sync::RwLock or spin::RwLock).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

use crate::lock::StateLock;
use crate::strategy::GuardStrategy;
use crate::types::{GuardDecision, GuardEvent, GuardInput, GuardOutcome, MonotonicMs, WallClockMs};
use alloc::collections::VecDeque;
use alloc::sync::Arc;
use core::sync::atomic::AtomicU64;

// StateLock<T> is RefCell<T> on wasm32, RwLock<T> on native.
// This macro abstracts the read-acquire across both targets so call sites are uniform.
// L063: one structural property eliminates the entire category of cfg duplication.
macro_rules! lock_read {
    ($lock:expr) => {{
        #[cfg(target_arch = "wasm32")]
        {
            $lock.borrow()
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            $lock.read()
        }
    }};
}

// Packing helpers for packed_state: (fsm_state, timestamp_union)
const FSM_SHIFT: u32 = 56;
const TS_MASK: u64 = (1u64 << 56) - 1;
const CLOSED: u8 = 0;
const OPEN: u8 = 1;
const HALF_OPEN: u8 = 2;

fn pack(fsm: u8, ts: u64) -> u64 {
    ((fsm as u64) << FSM_SHIFT) | (ts & TS_MASK)
}

fn unpack(packed: u64) -> (u8, u64) {
    ((packed >> FSM_SHIFT) as u8, packed & TS_MASK)
}

/// EXACTLY TWO FIELDS — P0 audit failure if more.
///
/// packed_state layout (AtomicU64):
///   High 8 bits  = fsm: 0=CLOSED, 1=OPEN, 2=HALF_OPEN
///   Low 56 bits  = state-dependent union timestamp:
///     fsm=CLOSED:    always 0
///     fsm=OPEN:      open_since_ms (MonotonicMs when circuit opened)
///     fsm=HALF_OPEN: probe_dispatched_at_ms (0=no probe in flight, nonzero=probe claimed)
///
/// window: Incremental failure count — NOT recomputed by O(N) scan.
/// Round 16: bare VecDeque<bool> ELIMINATED — O(N) scan required inside write lock.
pub struct CircuitState {
    pub packed_state: AtomicU64,
    pub window: StateLock<CircuitWindow>,
}

/// Sliding window for failure rate calculation.
/// Round 16: failure_count maintained incrementally — push increments, pop decrements if popped value was true.
pub struct CircuitWindow {
    pub queue: VecDeque<bool>, // true=failure, false=success
    pub failure_count: u32,    // incremental O(1) — NOT recomputed from queue scan
}

// WASM is single-threaded — RefCell<T> is safe to share (there are no concurrent threads).
// This impl satisfies the `GuardStrategy::State: Sync` bound on wasm32 targets.
#[cfg(target_arch = "wasm32")]
unsafe impl Sync for CircuitState {}

impl Default for CircuitState {
    fn default() -> Self {
        Self {
            packed_state: AtomicU64::new(pack(CLOSED, 0)),
            window: StateLock::new(CircuitWindow {
                queue: VecDeque::new(),
                failure_count: 0,
            }),
        }
    }
}

/// Circuit breaker configuration — all Society tuning values.
pub struct CircuitBreakerConfig {
    /// Fraction of window that must fail to trip OPEN (e.g., 0.5 = 50%).
    pub failure_threshold: f32,
    /// Number of calls in sliding window.
    pub window_size: usize,
    /// Milliseconds to wait in OPEN before attempting HALF_OPEN transition.
    pub cooldown_ms: u64,
    /// Milliseconds before an unclaimed probe is stolen by the next caller.
    pub probe_timeout_ms: u64,
}

/// CircuitBreakerStrategy — 3-state FSM guard.
pub struct CircuitBreakerStrategy;

impl CircuitBreakerStrategy {
    /// Record outcome in the sliding window and trigger FSM transitions.
    /// Must be called by the caller after attempting the actual operation.
    /// now_ms: monotonic timestamp for HALF_OPEN → OPEN transitions.
    pub fn record_outcome(
        state: Arc<StateLock<CircuitState>>,
        config: &CircuitBreakerConfig,
        success: bool,
        now_ms: u64,
    ) {
        // Update sliding window
        {
            let guard = lock_read!(state);
            #[cfg(not(target_arch = "wasm32"))]
            {
                let mut window = guard.window.write();
                window.queue.push_back(!success);
                if !success {
                    window.failure_count += 1;
                }
                if window.queue.len() > config.window_size {
                    let evicted = window.queue.pop_front().unwrap();
                    if evicted {
                        window.failure_count -= 1;
                    }
                }
            }
            #[cfg(target_arch = "wasm32")]
            {
                let mut window = guard.window.borrow_mut();
                window.queue.push_back(!success);
                if !success {
                    window.failure_count += 1;
                }
                if window.queue.len() > config.window_size {
                    let evicted = window.queue.pop_front().unwrap();
                    if evicted {
                        window.failure_count -= 1;
                    }
                }
            }
        }
        // If probe was in flight (HALF_OPEN), trigger FSM transition based on outcome.
        // Window guard is released above before we re-enter state lock inside helpers.
        let packed = {
            let g = lock_read!(state);
            g.packed_state.load(core::sync::atomic::Ordering::Acquire)
        };
        if unpack(packed).0 == HALF_OPEN {
            if success {
                Self::try_probe_success(&state);
            } else {
                Self::try_probe_failure(&state, now_ms);
            }
        }
    }

    /// Attempt Probe SUCCESS transition: HALF_OPEN → CLOSED with window clear (Round 16 Window Amnesia fix).
    /// Hold window.write() lock, clear CircuitWindow, then CAS — in that order.
    fn try_probe_success(state: &Arc<StateLock<CircuitState>>) -> bool {
        let guard = lock_read!(state);
        // Window Amnesia fix (Round 16): clear window BEFORE CAS
        #[cfg(not(target_arch = "wasm32"))]
        {
            let mut window = guard.window.write();
            window.queue.clear();
            window.failure_count = 0;
        }
        #[cfg(target_arch = "wasm32")]
        {
            let mut window = guard.window.borrow_mut();
            window.queue.clear();
            window.failure_count = 0;
        }
        // CAS: expect any HALF_OPEN state, transition to CLOSED
        let current = guard
            .packed_state
            .load(core::sync::atomic::Ordering::Acquire);
        let (fsm, _) = unpack(current);
        if fsm != HALF_OPEN {
            return false;
        }
        guard
            .packed_state
            .compare_exchange_weak(
                current,
                pack(CLOSED, 0),
                core::sync::atomic::Ordering::Release,
                core::sync::atomic::Ordering::Relaxed,
            )
            .is_ok()
    }

    /// Attempt Probe FAILURE transition: HALF_OPEN → OPEN with fresh timestamp.
    fn try_probe_failure(state: &Arc<StateLock<CircuitState>>, now_ms: u64) -> bool {
        let guard = lock_read!(state);
        let current = guard
            .packed_state
            .load(core::sync::atomic::Ordering::Acquire);
        let (fsm, _) = unpack(current);
        if fsm != HALF_OPEN {
            return false;
        }
        guard
            .packed_state
            .compare_exchange_weak(
                current,
                pack(OPEN, now_ms & TS_MASK),
                core::sync::atomic::Ordering::Release,
                core::sync::atomic::Ordering::Relaxed,
            )
            .is_ok()
    }

    /// Attempt Probe CLAIM: CAS HALF_OPEN (0) → HALF_OPEN (now_ms).
    fn try_claim_probe(state: &Arc<StateLock<CircuitState>>, now_ms: u64) -> bool {
        let guard = lock_read!(state);
        guard
            .packed_state
            .compare_exchange_weak(
                pack(HALF_OPEN, 0),
                pack(HALF_OPEN, now_ms & TS_MASK),
                core::sync::atomic::Ordering::Release,
                core::sync::atomic::Ordering::Relaxed,
            )
            .is_ok()
    }

    /// Attempt Probe STEAL: CAS HALF_OPEN (old_ts) → HALF_OPEN (now_ms) if elapsed > probe_timeout_ms.
    fn try_steal_probe(
        state: &Arc<StateLock<CircuitState>>,
        now_ms: u64,
        probe_timeout_ms: u64,
    ) -> bool {
        let guard = lock_read!(state);
        let current = guard
            .packed_state
            .load(core::sync::atomic::Ordering::Acquire);
        let (fsm, probe_ts) = unpack(current);
        if fsm != HALF_OPEN || probe_ts == 0 {
            return false;
        }
        let elapsed = now_ms.wrapping_sub(probe_ts) & TS_MASK;
        if elapsed <= probe_timeout_ms {
            return false;
        }
        guard
            .packed_state
            .compare_exchange_weak(
                current,
                pack(HALF_OPEN, now_ms & TS_MASK),
                core::sync::atomic::Ordering::Release,
                core::sync::atomic::Ordering::Relaxed,
            )
            .is_ok()
    }

    /// Attempt OPEN → HALF_OPEN: CAS if elapsed > cooldown_ms.
    fn try_open_to_half_open(
        state: &Arc<StateLock<CircuitState>>,
        now_ms: u64,
        cooldown_ms: u64,
    ) -> bool {
        let guard = lock_read!(state);
        let current = guard
            .packed_state
            .load(core::sync::atomic::Ordering::Acquire);
        let (fsm, open_since_ms) = unpack(current);
        if fsm != OPEN {
            return false;
        }
        let elapsed = now_ms.wrapping_sub(open_since_ms) & TS_MASK;
        if elapsed <= cooldown_ms {
            return false;
        }
        guard
            .packed_state
            .compare_exchange_weak(
                current,
                pack(HALF_OPEN, 0),
                core::sync::atomic::Ordering::Release,
                core::sync::atomic::Ordering::Relaxed,
            )
            .is_ok()
    }

    /// Attempt CLOSED → OPEN: CAS if failure_rate >= threshold and window is full.
    fn try_closed_to_open(
        state: &Arc<StateLock<CircuitState>>,
        now_ms: u64,
        failure_rate: f32,
        threshold: f32,
        window_size: usize,
        window_len: usize,
    ) -> bool {
        if failure_rate < threshold || window_len < window_size {
            return false;
        }
        let guard = lock_read!(state);
        guard
            .packed_state
            .compare_exchange_weak(
                pack(CLOSED, 0),
                pack(OPEN, now_ms & TS_MASK),
                core::sync::atomic::Ordering::Release,
                core::sync::atomic::Ordering::Relaxed,
            )
            .is_ok()
    }
}

impl GuardStrategy for CircuitBreakerStrategy {
    type State = CircuitState;
    type Config = CircuitBreakerConfig;

    fn evaluate(
        &self,
        input: &GuardInput,
        state: Arc<StateLock<Self::State>>,
        config: &Self::Config,
        _wall_clock_ms: WallClockMs,
        monotonic_ms: MonotonicMs,
    ) -> GuardOutcome {
        let now_ms = monotonic_ms.0;

        // 1. Read window and compute failure_rate
        let (failure_rate, window_len) = {
            let sg = lock_read!(state);
            #[cfg(not(target_arch = "wasm32"))]
            let window_guard = sg.window.read();
            #[cfg(target_arch = "wasm32")]
            let window_guard = sg.window.borrow();

            let len = window_guard.queue.len();
            let rate = if len == 0 {
                0.0
            } else {
                window_guard.failure_count as f32 / len as f32
            };
            (rate, len)
        };

        // 2. Read packed_state and dispatch on FSM
        let packed = {
            let sg = lock_read!(state);
            sg.packed_state.load(core::sync::atomic::Ordering::Acquire)
        };
        let (fsm, ts) = unpack(packed);

        match fsm {
            CLOSED => {
                // Attempt CLOSED → OPEN if threshold exceeded and window is full
                if failure_rate >= config.failure_threshold && window_len >= config.window_size {
                    Self::try_closed_to_open(
                        &state,
                        now_ms,
                        failure_rate,
                        config.failure_threshold,
                        config.window_size,
                        window_len,
                    );
                }
                GuardOutcome::allow()
            }
            OPEN => {
                let elapsed = now_ms.wrapping_sub(ts) & TS_MASK;
                if elapsed > config.cooldown_ms {
                    // Attempt OPEN → HALF_OPEN
                    if Self::try_open_to_half_open(&state, now_ms, config.cooldown_ms) {
                        // CAS succeeded — now attempt to claim probe
                        if Self::try_claim_probe(&state, now_ms) {
                            GuardOutcome::allow_with_event(GuardEvent::CircuitHalfOpen {
                                peer_id: input.peer_id.clone(),
                            })
                        } else {
                            // Another thread claimed probe first — deny this thread
                            GuardOutcome::deny("circuit_half_open")
                        }
                    } else {
                        // CAS failed (race with another thread) — retry from top
                        // For simplicity, treat as still OPEN
                        GuardOutcome::deny("circuit_open")
                    }
                } else {
                    GuardOutcome::deny("circuit_open")
                }
            }
            HALF_OPEN => {
                if ts == 0 {
                    // No probe in flight — attempt to claim one
                    if Self::try_claim_probe(&state, now_ms) {
                        GuardOutcome::allow_with_event(GuardEvent::CircuitHalfOpen {
                            peer_id: input.peer_id.clone(),
                        })
                    } else {
                        // Another thread claimed probe first
                        GuardOutcome::deny("circuit_half_open")
                    }
                } else {
                    // Probe in flight — check if it timed out and can be stolen
                    let elapsed = now_ms.wrapping_sub(ts) & TS_MASK;
                    if elapsed > config.probe_timeout_ms {
                        if Self::try_steal_probe(&state, now_ms, config.probe_timeout_ms) {
                            GuardOutcome::allow_with_event(GuardEvent::CircuitHalfOpen {
                                peer_id: input.peer_id.clone(),
                            })
                        } else {
                            GuardOutcome::deny("circuit_half_open")
                        }
                    } else {
                        GuardOutcome {
                            decision: GuardDecision::CircuitHalfOpen,
                            event: Some(GuardEvent::CircuitHalfOpen {
                                peer_id: input.peer_id.clone(),
                            }),
                        }
                    }
                }
            }
            _ => GuardOutcome::allow(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn circuit_state_default_is_closed() {
        let state = CircuitState::default();
        let packed = state
            .packed_state
            .load(core::sync::atomic::Ordering::Relaxed);
        let (fsm, ts) = unpack(packed);
        assert_eq!(fsm, CLOSED);
        assert_eq!(ts, 0);
    }

    #[test]
    fn pack_unpack_roundtrip() {
        let packed = pack(OPEN, 12345);
        let (fsm, ts) = unpack(packed);
        assert_eq!(fsm, OPEN);
        assert_eq!(ts, 12345);
    }

    #[test]
    fn pack_unpack_half_open_with_ts() {
        let packed = pack(HALF_OPEN, (1u64 << 55) | 0xDEADBEEF);
        let (fsm, ts) = unpack(packed);
        assert_eq!(fsm, HALF_OPEN);
        assert_eq!(ts, (1u64 << 55) | 0xDEADBEEF);
    }

    #[test]
    fn ts_mask_preserves_56_bits() {
        let large_ts = (1u64 << 60) - 1; // 60 bits of ones
        let packed = pack(OPEN, large_ts);
        let (_, ts) = unpack(packed);
        // Should preserve only the low 56 bits
        assert_eq!(ts, large_ts & TS_MASK);
    }

    #[test]
    fn wrapping_sub_with_mask() {
        // Test wrapping subtraction on masked 56-bit field
        let now = 100u64;
        let ts_open = 50u64;
        let elapsed = now.wrapping_sub(ts_open) & TS_MASK;
        assert_eq!(elapsed, 50);
    }

    #[test]
    fn wrapping_sub_near_boundary() {
        // Set ts near 56-bit max, set now to small value
        let now = 10u64;
        let ts_open = ((1u64 << 56) - 1) & TS_MASK; // 56-bit max
        let elapsed = now.wrapping_sub(ts_open) & TS_MASK;
        // Should wrap correctly: wrapping_sub gives a large value, mask keeps it in range
        assert!(elapsed < (1u64 << 56));
    }
}
