// crates/resilience/tests/priority_tests.rs
//
// Integration tests for PriorityShedStrategy.
//
// Verifies 6 correctness properties:
//   1. High-priority (>= high_priority_threshold) always passes, even when shedding active
//   2. Low-priority (< min_priority_under_load) is shed when in_flight >= shed_threshold
//   3. Normal priority (>= min_priority_under_load, < high_priority_threshold) passes under load
//   4. Shed deactivates via hysteresis when in_flight < shed_release_threshold
//   5. Low-priority passes when in_flight < shed_threshold (no load)
//   6. complete() decrements in_flight correctly

extern crate alloc;

use alloc::sync::Arc;
use core::sync::atomic::Ordering;
use resilience::{
    GuardDecision, GuardInput, GuardStrategy, MonotonicMs, PeerId, PriorityConfig,
    PriorityShedStrategy, PriorityState, StateLock, WallClockMs,
};

/// Build a GuardInput with the given priority level.
fn input_with_priority(priority: u8) -> GuardInput {
    GuardInput {
        peer_id: PeerId(alloc::string::String::from("peer-1")),
        data: alloc::vec![],
        partition_key: None,
        priority,
    }
}

/// Create a config with small thresholds for test convenience.
fn test_config() -> PriorityConfig {
    PriorityConfig {
        shed_threshold: 10,
        min_priority_under_load: 64,
        high_priority_threshold: 200,
        shed_release_threshold: 5,
    }
}

/// Evaluate the strategy once, returning the GuardDecision.
fn evaluate(
    state: Arc<StateLock<PriorityState>>,
    config: &PriorityConfig,
    priority: u8,
) -> GuardDecision {
    let strategy = PriorityShedStrategy;
    GuardStrategy::evaluate(
        &strategy,
        &input_with_priority(priority),
        state,
        config,
        WallClockMs(0),
        MonotonicMs(0),
    )
    .decision
}

/// Read current in_flight count from state.
fn read_in_flight(state: &Arc<StateLock<PriorityState>>) -> u64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        state.read().in_flight.load(Ordering::Acquire)
    }
    #[cfg(target_arch = "wasm32")]
    {
        state.borrow().in_flight.load(Ordering::Acquire)
    }
}

/// Force in_flight + shed_active directly without going through evaluate().
fn force_shed_active(state: &Arc<StateLock<PriorityState>>, in_flight: u64) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let st = state.read();
        st.in_flight.store(in_flight, Ordering::Release);
        st.shed_active.store(true, Ordering::Release);
    }
    #[cfg(target_arch = "wasm32")]
    {
        let st = state.borrow();
        st.in_flight.store(in_flight, Ordering::Release);
        st.shed_active.store(true, Ordering::Release);
    }
}

/// Set in_flight directly without changing shed_active.
fn force_in_flight(state: &Arc<StateLock<PriorityState>>, in_flight: u64) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        state.read().in_flight.store(in_flight, Ordering::Release);
    }
    #[cfg(target_arch = "wasm32")]
    {
        state.borrow().in_flight.store(in_flight, Ordering::Release);
    }
}

#[test]
fn priority_high_always_passes() {
    // High-priority requests must pass even when shedding is active.
    let state = Arc::new(StateLock::default());
    let config = test_config();

    // Force shedding state: in_flight = shed_threshold, shed_active = true
    force_shed_active(&state, config.shed_threshold);

    // High-priority request → Allow despite shedding
    let decision = evaluate(state.clone(), &config, config.high_priority_threshold);
    assert_eq!(
        decision,
        GuardDecision::Allow,
        "high_priority_threshold request must pass under load"
    );

    // Max priority 255 also passes
    let decision = evaluate(state.clone(), &config, 255);
    assert_eq!(
        decision,
        GuardDecision::Allow,
        "max priority 255 must pass under load"
    );
}

#[test]
fn priority_low_shed_under_load() {
    // Low-priority requests are shed when in_flight >= shed_threshold.
    let state = Arc::new(StateLock::default());
    let config = test_config();

    // Force shedding state
    force_shed_active(&state, config.shed_threshold);

    // Low-priority request (below min_priority_under_load) → Deny
    let priority_zero = 0u8;
    assert!(
        priority_zero < config.min_priority_under_load,
        "test setup: priority_zero must be below min"
    );

    let decision = evaluate(state.clone(), &config, priority_zero);
    assert_eq!(
        decision,
        GuardDecision::Deny("PRIORITY_SHED: low_priority_under_load"),
        "priority below min_priority_under_load must be shed under load"
    );
}

#[test]
fn priority_normal_passes_under_load() {
    // Normal-priority requests (>= min_priority_under_load, < high_priority_threshold)
    // still pass under load — they are above the shed floor.
    let state = Arc::new(StateLock::default());
    let config = test_config();

    // Force shedding state
    force_shed_active(&state, config.shed_threshold);

    // Normal priority = exactly at min_priority_under_load → passes (floor is exclusive on <)
    let normal_priority = config.min_priority_under_load;
    let decision = evaluate(state.clone(), &config, normal_priority);
    assert_eq!(
        decision,
        GuardDecision::Allow,
        "priority >= min_priority_under_load must pass even under load"
    );

    // Priority between min and high threshold also passes (u16 to avoid u8 overflow in addition)
    let mid_priority =
        ((config.min_priority_under_load as u16 + config.high_priority_threshold as u16) / 2) as u8;
    let decision = evaluate(state.clone(), &config, mid_priority);
    assert_eq!(
        decision,
        GuardDecision::Allow,
        "mid-range priority must pass under load"
    );
}

#[test]
fn priority_shed_deactivates_on_hysteresis() {
    // After shed activates, it must deactivate when in_flight drops below shed_release_threshold.
    let state = Arc::new(StateLock::default());
    let config = test_config();

    // 1. Force shedding state: in_flight = shed_threshold, shed_active = true
    force_shed_active(&state, config.shed_threshold);

    // 2. Confirm low-priority is shed
    let decision = evaluate(state.clone(), &config, 0);
    assert_eq!(
        decision,
        GuardDecision::Deny("PRIORITY_SHED: low_priority_under_load"),
        "low-priority must be shed while shed_active=true and in_flight >= shed_threshold"
    );

    // 3. Force in_flight below shed_release_threshold so next evaluate() clears shed_active
    force_in_flight(&state, config.shed_release_threshold.saturating_sub(1));

    // 4. Next evaluation observes in_flight < shed_release_threshold → clears shed_active
    //    Low-priority request → Allow (shed deactivated via hysteresis)
    let decision = evaluate(state.clone(), &config, 0);
    assert_eq!(
        decision,
        GuardDecision::Allow,
        "low-priority must be allowed after in_flight drops below shed_release_threshold"
    );
}

#[test]
fn priority_no_shed_below_threshold() {
    // When in_flight < shed_threshold and shed_active = false, ALL priorities pass.
    let state = Arc::new(StateLock::default());
    let config = test_config();

    // Default state: in_flight = 0, shed_active = false
    let decision = evaluate(state.clone(), &config, 0);
    assert_eq!(
        decision,
        GuardDecision::Allow,
        "priority=0 must pass when in_flight < shed_threshold"
    );

    // in_flight just below threshold, shed_active still false
    force_in_flight(&state, config.shed_threshold - 1);

    let decision = evaluate(state.clone(), &config, 0);
    assert_eq!(
        decision,
        GuardDecision::Allow,
        "priority=0 must pass when in_flight is one below shed_threshold"
    );
}

#[test]
fn priority_complete_decrements_inflight() {
    // After an Allow, complete() must decrement in_flight by exactly 1.
    // Calling complete() when in_flight=0 must saturate at 0 (no underflow).
    let state = Arc::new(StateLock::default());
    let config = test_config();

    // Allow one request — in_flight should become 1
    let decision = evaluate(state.clone(), &config, 127);
    assert_eq!(decision, GuardDecision::Allow);
    assert_eq!(
        read_in_flight(&state),
        1,
        "in_flight must be 1 after one Allow"
    );

    // complete() → in_flight must drop to 0
    PriorityShedStrategy::complete(&state);
    assert_eq!(
        read_in_flight(&state),
        0,
        "in_flight must be 0 after complete()"
    );

    // complete() on in_flight=0 → must not underflow (saturating_sub)
    PriorityShedStrategy::complete(&state);
    assert_eq!(
        read_in_flight(&state),
        0,
        "complete() on 0 must saturate at 0, not underflow"
    );
}
