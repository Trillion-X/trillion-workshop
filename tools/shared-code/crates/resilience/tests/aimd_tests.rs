// crates/resilience/tests/aimd_tests.rs
//
// Integration tests for AimdStrategy — 7 tests covering:
//   allow below limit, deny at limit, multiplicative decrease on deny,
//   additive increase on success_window, min_limit floor, max_limit ceiling,
//   and complete() decrementing in_flight.

use core::sync::atomic::Ordering;
use resilience::{
    AimdConfig, AimdState, AimdStrategy, GuardDecision, GuardInput, GuardStrategy, MonotonicMs,
    PeerId, StateLock, WallClockMs,
};
use std::sync::Arc;

fn make_input() -> GuardInput {
    GuardInput {
        peer_id: PeerId("test-peer".into()),
        data: vec![],
        partition_key: None,
        priority: 0,
    }
}

fn make_state(in_flight: u64, limit: f64) -> Arc<StateLock<AimdState>> {
    let s = AimdState::default();
    s.in_flight.store(in_flight, Ordering::Relaxed);
    s.limit_fixed
        .store((limit * 1_000.0) as u64, Ordering::Relaxed);
    Arc::new(StateLock::new(s))
}

fn evaluate(state: Arc<StateLock<AimdState>>, config: &AimdConfig) -> GuardDecision {
    let strategy = AimdStrategy;
    let outcome = strategy.evaluate(&make_input(), state, config, WallClockMs(0), MonotonicMs(0));
    outcome.decision
}

// ---------------------------------------------------------------------------
// Test 1: Allow when in_flight < limit
// ---------------------------------------------------------------------------
#[test]
fn aimd_allow_below_limit() {
    let config = AimdConfig {
        min_limit: 10.0,
        max_limit: 1024.0,
        additive_increase: 1.0,
        multiplicative_decrease: 0.5,
        success_window: 100,
    };
    // in_flight=0, limit=10 → should Allow
    let state = make_state(0, 10.0);
    let decision = evaluate(Arc::clone(&state), &config);
    assert_eq!(decision, GuardDecision::Allow);
}

// ---------------------------------------------------------------------------
// Test 2: Deny when in_flight == limit
// ---------------------------------------------------------------------------
#[test]
fn aimd_deny_at_limit() {
    let config = AimdConfig {
        min_limit: 10.0,
        max_limit: 1024.0,
        additive_increase: 1.0,
        multiplicative_decrease: 0.5,
        success_window: 100,
    };
    // in_flight=10, limit=10 → in_flight >= limit → Deny
    let state = make_state(10, 10.0);
    let decision = evaluate(Arc::clone(&state), &config);
    assert!(matches!(decision, GuardDecision::Deny(_)));
}

// ---------------------------------------------------------------------------
// Test 3: Multiplicative decrease on Deny
// ---------------------------------------------------------------------------
#[test]
fn aimd_multiplicative_decrease_on_deny() {
    let config = AimdConfig {
        min_limit: 5.0,
        max_limit: 1024.0,
        additive_increase: 1.0,
        multiplicative_decrease: 0.5,
        success_window: 100,
    };
    // in_flight=20, limit=20 → Deny → new_limit = 20 * (1 - 0.5) = 10
    let state = make_state(20, 20.0);
    let _ = evaluate(Arc::clone(&state), &config);

    #[cfg(not(target_arch = "wasm32"))]
    let st = state.read();
    #[cfg(target_arch = "wasm32")]
    let st = state.borrow();

    let limit_fixed = st.limit_fixed.load(Ordering::Relaxed);
    let limit = (limit_fixed as f64) / 1_000.0;
    assert!(
        (limit - 10.0).abs() < 0.01,
        "expected limit ~10.0 after 50% decrease from 20.0, got {limit}"
    );
}

// ---------------------------------------------------------------------------
// Test 4: Additive increase after success_window successes
// ---------------------------------------------------------------------------
#[test]
fn aimd_additive_increase_on_success_window() {
    let config = AimdConfig {
        min_limit: 10.0,
        max_limit: 1024.0,
        additive_increase: 1.0,
        multiplicative_decrease: 0.5,
        success_window: 5, // small window for test speed
    };
    // Start at limit=10, in_flight=0
    // After success_window=5 allows, limit should become 11.0
    let state = make_state(0, 10.0);

    // Set success_count to 4 so the next (5th) allow triggers increase
    {
        #[cfg(not(target_arch = "wasm32"))]
        let st = state.read();
        #[cfg(target_arch = "wasm32")]
        let st = state.borrow();
        st.success_count.store(4, Ordering::Relaxed);
        // Reset in_flight to 0 for each call
    }

    // 5th success triggers additive increase
    let _ = evaluate(Arc::clone(&state), &config);

    #[cfg(not(target_arch = "wasm32"))]
    let st = state.read();
    #[cfg(target_arch = "wasm32")]
    let st = state.borrow();

    let limit_fixed = st.limit_fixed.load(Ordering::Relaxed);
    let limit = (limit_fixed as f64) / 1_000.0;
    assert!(
        (limit - 11.0).abs() < 0.01,
        "expected limit ~11.0 after additive increase (+1.0 from 10.0), got {limit}"
    );
}

// ---------------------------------------------------------------------------
// Test 5: limit never goes below min_limit
// ---------------------------------------------------------------------------
#[test]
fn aimd_never_below_min_limit() {
    let config = AimdConfig {
        min_limit: 5.0,
        max_limit: 1024.0,
        additive_increase: 1.0,
        multiplicative_decrease: 0.9, // aggressive decrease
        success_window: 100,
    };
    // Apply many deny events — limit should never fall below min_limit=5.0
    let mut limit = 20.0_f64;
    for _ in 0..20 {
        let state = make_state(limit as u64, limit);
        let _ = evaluate(Arc::clone(&state), &config);

        #[cfg(not(target_arch = "wasm32"))]
        let st = state.read();
        #[cfg(target_arch = "wasm32")]
        let st = state.borrow();

        let new_fixed = st.limit_fixed.load(Ordering::Relaxed);
        limit = (new_fixed as f64) / 1_000.0;

        assert!(
            limit >= config.min_limit,
            "limit {limit} dropped below min_limit={}",
            config.min_limit
        );
    }
}

// ---------------------------------------------------------------------------
// Test 6: limit never exceeds max_limit
// ---------------------------------------------------------------------------
#[test]
fn aimd_never_above_max_limit() {
    let config = AimdConfig {
        min_limit: 10.0,
        max_limit: 15.0, // tight ceiling for test
        additive_increase: 2.0,
        multiplicative_decrease: 0.5,
        success_window: 1, // increase on every success
    };
    // Drive many successes — limit should never exceed max_limit=15.0
    let state = make_state(0, 10.0);
    for _ in 0..20 {
        // Reset in_flight to 0 before each call so it stays below limit
        {
            #[cfg(not(target_arch = "wasm32"))]
            let st = state.read();
            #[cfg(target_arch = "wasm32")]
            let st = state.borrow();
            st.in_flight.store(0, Ordering::Relaxed);
        }

        let strategy = AimdStrategy;
        let outcome = strategy.evaluate(
            &make_input(),
            Arc::clone(&state),
            &config,
            WallClockMs(0),
            MonotonicMs(0),
        );
        assert_eq!(outcome.decision, GuardDecision::Allow);

        #[cfg(not(target_arch = "wasm32"))]
        let st = state.read();
        #[cfg(target_arch = "wasm32")]
        let st = state.borrow();

        let limit_fixed = st.limit_fixed.load(Ordering::Relaxed);
        let limit = (limit_fixed as f64) / 1_000.0;
        assert!(
            limit <= config.max_limit,
            "limit {limit} exceeded max_limit={}",
            config.max_limit
        );
    }
}

// ---------------------------------------------------------------------------
// Test 7: complete() decrements in_flight
// ---------------------------------------------------------------------------
#[test]
fn aimd_complete_decrements_inflight() {
    let config = AimdConfig {
        min_limit: 10.0,
        max_limit: 1024.0,
        additive_increase: 1.0,
        multiplicative_decrease: 0.5,
        success_window: 100,
    };
    // Start with in_flight=0, evaluate → Allow → in_flight becomes 1
    let state = make_state(0, 10.0);
    let decision = evaluate(Arc::clone(&state), &config);
    assert_eq!(decision, GuardDecision::Allow);

    {
        #[cfg(not(target_arch = "wasm32"))]
        let st = state.read();
        #[cfg(target_arch = "wasm32")]
        let st = state.borrow();
        assert_eq!(
            st.in_flight.load(Ordering::Relaxed),
            1,
            "in_flight should be 1 after Allow"
        );
    }

    // complete() → in_flight decrements back to 0
    AimdStrategy::complete(&state);

    #[cfg(not(target_arch = "wasm32"))]
    let st = state.read();
    #[cfg(target_arch = "wasm32")]
    let st = state.borrow();

    assert_eq!(
        st.in_flight.load(Ordering::Relaxed),
        0,
        "in_flight should be 0 after complete()"
    );
}
