// crates/resilience/tests/quota_tests.rs
//
// Integration tests for WorkspaceQuotaStrategy.
// Covers: allow under limit, deny at limit, window expiry reset,
// partition isolation (A independent of B), and concurrent CAS reset safety.

use resilience::{
    GuardDecision, GuardInput, GuardOutcome, GuardStrategy, MonotonicMs, PeerId, QuotaConfig,
    QuotaState, StateLock, WallClockMs, WorkspaceQuotaStrategy,
};
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn make_state() -> Arc<StateLock<QuotaState>> {
    Arc::new(StateLock::new(QuotaState::default()))
}

fn make_input(payload_bytes: usize) -> GuardInput {
    GuardInput {
        peer_id: PeerId(String::from("test-peer")),
        data: vec![0u8; payload_bytes],
        partition_key: None,
        priority: 0,
    }
}

fn evaluate(
    state: Arc<StateLock<QuotaState>>,
    config: &QuotaConfig,
    monotonic_ms: u64,
    payload_bytes: usize,
) -> GuardOutcome {
    let strategy = WorkspaceQuotaStrategy;
    let input = make_input(payload_bytes);
    strategy.evaluate(
        &input,
        state,
        config,
        WallClockMs(monotonic_ms),
        MonotonicMs(monotonic_ms),
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// Requests under the limit are allowed.
#[test]
fn quota_allow_under_limit() {
    let state = make_state();
    let config = QuotaConfig {
        max_requests_per_window: 5,
        max_bytes_per_window: 1_000_000,
        window_duration_ms: 60_000,
    };

    for _ in 0..5 {
        let outcome = evaluate(Arc::clone(&state), &config, 1000, 0);
        assert!(
            matches!(outcome.decision, GuardDecision::Allow),
            "expected Allow for requests under limit"
        );
    }
}

/// The request at the limit (== max_requests_per_window) is denied.
#[test]
fn quota_deny_at_limit() {
    let state = make_state();
    let config = QuotaConfig {
        max_requests_per_window: 3,
        max_bytes_per_window: 1_000_000,
        window_duration_ms: 60_000,
    };

    // Consume all 3 allowed requests.
    for _ in 0..3 {
        let outcome = evaluate(Arc::clone(&state), &config, 1000, 0);
        assert!(matches!(outcome.decision, GuardDecision::Allow));
    }

    // The 4th request (count == max) must be denied.
    let outcome = evaluate(Arc::clone(&state), &config, 1000, 0);
    assert!(
        matches!(
            outcome.decision,
            GuardDecision::Deny("quota_request_count_exceeded")
        ),
        "expected Deny at limit, got {:?}",
        outcome.decision
    );
}

/// After the window duration elapses, the counter resets and requests are allowed again.
#[test]
fn quota_window_resets_after_expiry() {
    let state = make_state();
    let config = QuotaConfig {
        max_requests_per_window: 2,
        max_bytes_per_window: 1_000_000,
        window_duration_ms: 1_000, // 1-second window
    };

    // Fill the quota at T=0.
    for _ in 0..2 {
        let outcome = evaluate(Arc::clone(&state), &config, 0, 0);
        assert!(matches!(outcome.decision, GuardDecision::Allow));
    }

    // Confirm denial at T=500 (still in window).
    let outcome = evaluate(Arc::clone(&state), &config, 500, 0);
    assert!(
        matches!(
            outcome.decision,
            GuardDecision::Deny("quota_request_count_exceeded")
        ),
        "expected Deny within window"
    );

    // At T=1001 the window has expired — counter resets, request is allowed.
    let outcome = evaluate(Arc::clone(&state), &config, 1001, 0);
    assert!(
        matches!(outcome.decision, GuardDecision::Allow),
        "expected Allow after window expiry, got {:?}",
        outcome.decision
    );
}

/// Partition A's quota exhaustion does not affect partition B.
/// Each partition key uses a separate `QuotaState` instance — structural isolation.
#[test]
fn quota_workspace_a_independent_of_b() {
    let state_a = make_state();
    let state_b = make_state();
    let config = QuotaConfig {
        max_requests_per_window: 2,
        max_bytes_per_window: 1_000_000,
        window_duration_ms: 60_000,
    };

    // Exhaust partition A's quota.
    for _ in 0..2 {
        let outcome = evaluate(Arc::clone(&state_a), &config, 1000, 0);
        assert!(matches!(outcome.decision, GuardDecision::Allow));
    }
    let denied = evaluate(Arc::clone(&state_a), &config, 1000, 0);
    assert!(
        matches!(
            denied.decision,
            GuardDecision::Deny("quota_request_count_exceeded")
        ),
        "partition A should be denied"
    );

    // Partition B is completely unaffected — its QuotaState is independent.
    let outcome_b = evaluate(Arc::clone(&state_b), &config, 1000, 0);
    assert!(
        matches!(outcome_b.decision, GuardDecision::Allow),
        "partition B must be unaffected by partition A's quota exhaustion"
    );
}

/// Concurrent window resets via CAS are safe — no double-reset, no counter explosion.
#[test]
fn quota_concurrent_resets_safe() {
    use std::thread;

    let state = make_state();
    let config = Arc::new(QuotaConfig {
        max_requests_per_window: 1_000,
        max_bytes_per_window: u64::MAX,
        window_duration_ms: 1, // 1ms window — will expire between threads
    });

    // Fill the window at T=0.
    for _ in 0..10 {
        evaluate(Arc::clone(&state), &config, 0, 0);
    }

    // Spawn 8 threads all evaluating at T=100 (window expired).
    // All will attempt the CAS reset — exactly one wins, others see fresh counters.
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let state_clone = Arc::clone(&state);
            let config_clone = Arc::clone(&config);
            thread::spawn(move || evaluate(state_clone, &config_clone, 100, 0))
        })
        .collect();

    let outcomes: Vec<GuardOutcome> = handles.into_iter().map(|h| h.join().unwrap()).collect();

    // All 8 threads should be allowed — window reset, fresh counters (8 << 1000 limit).
    for outcome in &outcomes {
        assert!(
            matches!(outcome.decision, GuardDecision::Allow),
            "all concurrent resets should allow: {:?}",
            outcome.decision
        );
    }

    // Verify the counter is sane — should be 8 (one per thread after reset), not 18.
    #[cfg(not(target_arch = "wasm32"))]
    {
        let st = state.read();
        let count = st.request_count.load(core::sync::atomic::Ordering::Acquire);
        assert!(
            count <= 8,
            "request_count after concurrent resets must be <= 8, got {count}"
        );
    }
}
