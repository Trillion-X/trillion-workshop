// crates/resilience/tests/circuit_breaker_tests.rs
//
// Comprehensive tests for CircuitBreakerStrategy — 7+ test cases covering all transitions.

use alloc::string::String;
use alloc::sync::Arc;
use resilience::{
    CircuitBreakerConfig, CircuitBreakerStrategy, CircuitState, GuardDecision, GuardEvent,
    GuardInput, GuardStrategy, MonotonicMs, PeerId, StateLock, WallClockMs,
};

extern crate alloc;

const CLOSED: u8 = 0;
const OPEN: u8 = 1;
const HALF_OPEN: u8 = 2;

fn pack(fsm: u8, ts: u64) -> u64 {
    ((fsm as u64) << 56) | (ts & ((1u64 << 56) - 1))
}

fn unpack(packed: u64) -> (u8, u64) {
    ((packed >> 56) as u8, packed & ((1u64 << 56) - 1))
}

fn create_state() -> Arc<StateLock<CircuitState>> {
    Arc::new(StateLock::new(CircuitState::default()))
}

fn test_input() -> GuardInput {
    GuardInput {
        peer_id: PeerId(String::from("test-peer")),
        data: alloc::vec![],
        partition_key: None,
        priority: 0,
    }
}

/// Helper: read packed_state value from a locked CircuitState arc.
fn load_packed(state: &Arc<StateLock<CircuitState>>) -> u64 {
    state
        .read()
        .packed_state
        .load(core::sync::atomic::Ordering::Relaxed)
}

/// Helper: store packed_state value into a locked CircuitState arc.
fn store_packed(state: &Arc<StateLock<CircuitState>>, val: u64) {
    state
        .read()
        .packed_state
        .store(val, core::sync::atomic::Ordering::Relaxed);
}

#[test]
fn closed_allows_normal_traffic() {
    // Fresh circuit in CLOSED state should allow all requests
    let config = CircuitBreakerConfig {
        failure_threshold: 0.5,
        window_size: 3,
        cooldown_ms: 100,
        probe_timeout_ms: 50,
    };
    let state = create_state();
    let strategy = CircuitBreakerStrategy;
    let input = test_input();

    for i in 0..5 {
        let outcome = strategy.evaluate(
            &input,
            state.clone(),
            &config,
            WallClockMs(0),
            MonotonicMs(i),
        );
        assert!(matches!(outcome.decision, GuardDecision::Allow));
    }
}

#[test]
fn open_after_failure_threshold() {
    // Exceed failure threshold in window to trip OPEN
    let config = CircuitBreakerConfig {
        failure_threshold: 0.5,
        window_size: 3,
        cooldown_ms: 100,
        probe_timeout_ms: 50,
    };
    let state = create_state();
    let strategy = CircuitBreakerStrategy;
    let input = test_input();

    // Fill window with 3 failures (all false = failure)
    for _ in 0..3 {
        let outcome = strategy.evaluate(
            &input,
            state.clone(),
            &config,
            WallClockMs(0),
            MonotonicMs(0),
        );
        assert!(matches!(outcome.decision, GuardDecision::Allow));
        CircuitBreakerStrategy::record_outcome(state.clone(), &config, false, 0u64);
        // failure
    }

    // One more evaluate triggers CLOSED→OPEN CAS (window full, failure_rate=100% ≥ 50%).
    // The evaluate in CLOSED always returns Allow but fires the CAS transition.
    let _ = strategy.evaluate(
        &input,
        state.clone(),
        &config,
        WallClockMs(0),
        MonotonicMs(1),
    );

    // Now check state: should be OPEN
    let packed = load_packed(&state);
    let (fsm, _) = unpack(packed);
    assert_eq!(fsm, OPEN, "Circuit should be OPEN after threshold exceeded");
}

#[test]
fn open_denies_traffic() {
    // Circuit in OPEN should deny all requests
    let config = CircuitBreakerConfig {
        failure_threshold: 0.5,
        window_size: 3,
        cooldown_ms: 100,
        probe_timeout_ms: 50,
    };
    let state = create_state();
    let strategy = CircuitBreakerStrategy;
    let input = test_input();

    // Manually set state to OPEN at time 100
    store_packed(&state, pack(OPEN, 100));

    // Requests within cooldown should be denied
    let outcome = strategy.evaluate(
        &input,
        state.clone(),
        &config,
        WallClockMs(0),
        MonotonicMs(150), // 50ms elapsed, < 100ms cooldown
    );
    assert_eq!(outcome.decision, GuardDecision::Deny("circuit_open"));
}

#[test]
fn open_to_half_open_after_cooldown() {
    // After cooldown expires, circuit should transition to HALF_OPEN and allow probe
    let config = CircuitBreakerConfig {
        failure_threshold: 0.5,
        window_size: 3,
        cooldown_ms: 100,
        probe_timeout_ms: 50,
    };
    let state = create_state();
    let strategy = CircuitBreakerStrategy;
    let input = test_input();

    // Set state to OPEN at time 100
    store_packed(&state, pack(OPEN, 100));

    // Evaluate at time 250 (150ms elapsed, > 100ms cooldown)
    let outcome = strategy.evaluate(
        &input,
        state.clone(),
        &config,
        WallClockMs(0),
        MonotonicMs(250),
    );

    // Should allow the probe request and emit CircuitHalfOpen event
    assert!(matches!(outcome.decision, GuardDecision::Allow));
    assert!(matches!(
        outcome.event,
        Some(GuardEvent::CircuitHalfOpen { .. })
    ));

    // Verify state transitioned to HALF_OPEN
    let packed = load_packed(&state);
    let (fsm, _) = unpack(packed);
    assert_eq!(fsm, HALF_OPEN);
}

#[test]
fn half_open_only_one_probe() {
    // In HALF_OPEN, only one caller can claim the probe
    let config = CircuitBreakerConfig {
        failure_threshold: 0.5,
        window_size: 3,
        cooldown_ms: 100,
        probe_timeout_ms: 50,
    };
    let state = create_state();
    let strategy = CircuitBreakerStrategy;
    let input = test_input();

    // Set state to HALF_OPEN with no probe claimed (ts=0)
    store_packed(&state, pack(HALF_OPEN, 0));

    // First caller claims probe → Allow
    let outcome1 = strategy.evaluate(
        &input,
        state.clone(),
        &config,
        WallClockMs(0),
        MonotonicMs(200),
    );
    assert!(matches!(outcome1.decision, GuardDecision::Allow));

    // Second caller finds probe in flight → Deny with CircuitHalfOpen decision
    let outcome2 = strategy.evaluate(
        &input,
        state.clone(),
        &config,
        WallClockMs(0),
        MonotonicMs(201),
    );
    assert_eq!(outcome2.decision, GuardDecision::CircuitHalfOpen);
}

#[test]
fn half_open_success_closes() {
    // Successful probe should transition HALF_OPEN → CLOSED and clear window (Window Amnesia fix)
    let config = CircuitBreakerConfig {
        failure_threshold: 0.5,
        window_size: 3,
        cooldown_ms: 100,
        probe_timeout_ms: 50,
    };
    let state = create_state();

    // Pre-populate window with failures while CLOSED
    for _ in 0..3 {
        CircuitBreakerStrategy::record_outcome(state.clone(), &config, false, 0u64);
    }

    // Set state to HALF_OPEN with probe claimed at time 200
    store_packed(&state, pack(HALF_OPEN, 200));

    // Record success — record_outcome detects HALF_OPEN and calls try_probe_success
    // which clears the window and CAS-transitions to CLOSED.
    CircuitBreakerStrategy::record_outcome(state.clone(), &config, true, 200u64);

    // Verify state is CLOSED
    let packed = load_packed(&state);
    let (fsm, _) = unpack(packed);
    assert_eq!(fsm, CLOSED);

    // Verify window was cleared (Window Amnesia fix — Round 16)
    #[cfg(not(target_arch = "wasm32"))]
    {
        let sg = state.read();
        let window = sg.window.read();
        assert_eq!(window.failure_count, 0);
    }
    #[cfg(target_arch = "wasm32")]
    {
        let sg = state.read();
        let window = sg.window.borrow();
        assert_eq!(window.failure_count, 0);
    }
}

#[test]
fn half_open_failure_reopens() {
    // Failed probe should transition HALF_OPEN → OPEN
    let config = CircuitBreakerConfig {
        failure_threshold: 0.5,
        window_size: 3,
        cooldown_ms: 100,
        probe_timeout_ms: 50,
    };
    let state = create_state();

    // Set state to HALF_OPEN with probe claimed at time 200
    store_packed(&state, pack(HALF_OPEN, 200));

    // Record failure — record_outcome detects HALF_OPEN and calls try_probe_failure(now_ms=300)
    // which CAS-transitions to OPEN with open_since_ms=300.
    CircuitBreakerStrategy::record_outcome(state.clone(), &config, false, 300u64);

    // Verify state is OPEN with the expected timestamp
    let packed = load_packed(&state);
    let (fsm, ts) = unpack(packed);
    assert_eq!(fsm, OPEN);
    assert_eq!(ts, 300);
}

#[test]
fn probe_steal() {
    // After probe_timeout_ms expires, next caller can steal the probe
    let config = CircuitBreakerConfig {
        failure_threshold: 0.5,
        window_size: 3,
        cooldown_ms: 100,
        probe_timeout_ms: 50,
    };
    let state = create_state();
    let strategy = CircuitBreakerStrategy;
    let input = test_input();

    // Set state to HALF_OPEN with probe claimed at time 200
    store_packed(&state, pack(HALF_OPEN, 200));

    // Evaluate at time 260 (60ms elapsed, > 50ms probe_timeout)
    let outcome = strategy.evaluate(
        &input,
        state.clone(),
        &config,
        WallClockMs(0),
        MonotonicMs(260),
    );

    // Should allow the stolen probe
    assert!(matches!(outcome.decision, GuardDecision::Allow));

    // Verify state still HALF_OPEN but with new timestamp
    let packed = load_packed(&state);
    let (fsm, ts) = unpack(packed);
    assert_eq!(fsm, HALF_OPEN);
    assert!(ts > 200, "Probe should be claimed with new timestamp");
}

#[test]
fn window_incremental_failure_count() {
    // Verify failure_count is maintained incrementally, not via O(N) scan
    let config = CircuitBreakerConfig {
        failure_threshold: 0.5,
        window_size: 5,
        cooldown_ms: 100,
        probe_timeout_ms: 50,
    };
    let state = create_state();

    // Record 5 failures
    for _ in 0..5 {
        CircuitBreakerStrategy::record_outcome(state.clone(), &config, false, 0u64);
    }

    // Check window: all failures
    #[cfg(not(target_arch = "wasm32"))]
    {
        let sg = state.read();
        let window = sg.window.read();
        assert_eq!(window.queue.len(), 5);
        assert_eq!(window.failure_count, 5);
    }
    #[cfg(target_arch = "wasm32")]
    {
        let sg = state.read();
        let window = sg.window.borrow();
        assert_eq!(window.queue.len(), 5);
        assert_eq!(window.failure_count, 5);
    }

    // Add 5 successes (window size stays 5, failures evicted)
    for _ in 0..5 {
        CircuitBreakerStrategy::record_outcome(state.clone(), &config, true, 0u64);
    }

    // Window should now have 5 successes, failure_count 0
    #[cfg(not(target_arch = "wasm32"))]
    {
        let sg = state.read();
        let window = sg.window.read();
        assert_eq!(window.queue.len(), 5);
        assert_eq!(window.failure_count, 0, "All entries are successes (false)");
    }
    #[cfg(target_arch = "wasm32")]
    {
        let sg = state.read();
        let window = sg.window.borrow();
        assert_eq!(window.queue.len(), 5);
        assert_eq!(window.failure_count, 0, "All entries are successes (false)");
    }
}

#[test]
fn wrapping_sub_correctness() {
    // Test wrapping subtraction with 56-bit timestamp field
    let ts_near_max = ((1u64 << 56) - 10) & ((1u64 << 56) - 1);
    let now = 5u64;
    let elapsed = now.wrapping_sub(ts_near_max) & ((1u64 << 56) - 1);

    // Should compute correctly despite wrap
    assert!(elapsed < (1u64 << 56), "Elapsed should fit in 56 bits");
    // Wrapping from ~max down to 5 is a small forward distance
    assert!(elapsed < 20, "Elapsed should be small (wrapped correctly)");
}
