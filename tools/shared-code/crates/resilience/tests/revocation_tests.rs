// crates/resilience/tests/revocation_tests.rs
//
// Integration tests for RevocationStrategy.
//
// Verifies 7 correctness properties:
//   1. Non-revoked session → Allow
//   2. Revoked session → Deny("session_revoked")
//   3. Expired revocation evicted → Allow
//   4. heap.pop() always paired with set.remove() — no orphaned entries after eviction
//   5. Revoking session A does not affect session B
//   6. Head-of-line not a problem — short-lived sessions evict independently of long-lived
//   7. max_entries cap — overflow ejects oldest; set len stays at max_entries

extern crate alloc;

use alloc::sync::Arc;
use resilience::{
    GuardDecision, GuardInput, GuardStrategy, MonotonicMs, PeerId, RevocationConfig,
    RevocationState, RevocationStrategy, StateLock, WallClockMs,
};

/// Build a GuardInput with the given session ID as the data payload.
fn input_with_session(session_id: &str) -> GuardInput {
    GuardInput {
        peer_id: PeerId(alloc::string::String::from("peer-1")),
        data: session_id.as_bytes().to_vec(),
        partition_key: None,
        priority: 0,
    }
}

/// Evaluate RevocationStrategy for a session_id at a given wall_clock_ms.
fn evaluate(
    arc_state: Arc<StateLock<RevocationState>>,
    config: &RevocationConfig,
    session_id: &str,
    wall_clock_ms: u64,
) -> GuardDecision {
    let strategy = RevocationStrategy;
    GuardStrategy::evaluate(
        &strategy,
        &input_with_session(session_id),
        arc_state,
        config,
        WallClockMs(wall_clock_ms),
        MonotonicMs(wall_clock_ms),
    )
    .decision
}

#[test]
fn test_1_non_revoked_session_allows() {
    // Empty RevocationState — any session ID → Allow
    let state = RevocationState::default();
    let config = RevocationConfig { max_entries: 10 };
    let arc_state = Arc::new(StateLock::new(state));

    let decision = evaluate(arc_state, &config, "session-abc", 1000);

    assert_eq!(
        decision,
        GuardDecision::Allow,
        "Non-revoked session must Allow"
    );
}

#[test]
fn test_2_revoked_session_denies() {
    // Revoke session-abc with exp in the future → Deny
    let mut state = RevocationState::default();
    let config = RevocationConfig { max_entries: 10 };

    // Insert revocation at wall_clock=1000ms with exp=5000ms (far future)
    state.revoke(
        alloc::string::String::from("session-abc"),
        WallClockMs(5000),
        10,
    );

    let arc_state = Arc::new(StateLock::new(state));
    let decision = evaluate(arc_state, &config, "session-abc", 1000);

    assert_eq!(
        decision,
        GuardDecision::Deny("session_revoked"),
        "Revoked session with future exp must Deny"
    );
}

#[test]
fn test_3_expired_revocation_evicted_allows() {
    // Insert session with exp=T, evaluate at wall_clock=T+1 → evicted → Allow
    let mut state = RevocationState::default();
    let config = RevocationConfig { max_entries: 10 };

    let exp_ms = 1000u64;
    state.revoke(
        alloc::string::String::from("session-expired"),
        WallClockMs(exp_ms),
        10,
    );

    // Evaluate at T+1 (exp.0 = 1000 < wall_clock_ms.0 = 1001 → expired → evicted)
    let arc_state = Arc::new(StateLock::new(state));
    let decision = evaluate(arc_state, &config, "session-expired", exp_ms + 1);

    assert_eq!(
        decision,
        GuardDecision::Allow,
        "Expired revocation must be evicted and session must Allow"
    );
}

#[test]
fn test_4_heap_pop_always_paired_with_set_remove() {
    // Insert 3 sessions, advance time past all expirations.
    // After evaluate(), revoked_count() must be 0 — no orphaned entries.
    //
    // This test verifies the structural invariant: every heap.pop() is paired with
    // set.remove(&id). If any pop() is missing its set.remove(), orphaned entries
    // accumulate in the set — revoked_count() > 0 after full eviction.
    let mut state = RevocationState::default();
    let config = RevocationConfig { max_entries: 10 };

    state.revoke(alloc::string::String::from("s1"), WallClockMs(100), 10);
    state.revoke(alloc::string::String::from("s2"), WallClockMs(200), 10);
    state.revoke(alloc::string::String::from("s3"), WallClockMs(300), 10);

    // Verify state before evaluation — all 3 are revoked
    assert_eq!(
        state.revoked_count(),
        3,
        "Before eviction: 3 sessions must be revoked"
    );

    // Evaluate at 1000ms — all three have exp < 1000 → all must be evicted
    let arc_state = Arc::new(StateLock::new(state));
    let _decision = evaluate(arc_state.clone(), &config, "s-other", 1000);

    // After evaluation, inspect state — set must be empty (no orphaned entries)
    #[cfg(not(target_arch = "wasm32"))]
    {
        let guard = arc_state.read();
        assert_eq!(
            guard.revoked_count(),
            0,
            "After full eviction, revoked_count() must be 0 — no orphaned SessionIds"
        );
    }
    #[cfg(target_arch = "wasm32")]
    {
        let guard = arc_state.borrow();
        assert_eq!(
            guard.revoked_count(),
            0,
            "After full eviction, revoked_count() must be 0 — no orphaned SessionIds"
        );
    }
}

#[test]
fn test_5_revoking_a_does_not_affect_b() {
    // Revoke session-A, evaluate session-B → Allow
    let mut state = RevocationState::default();
    let config = RevocationConfig { max_entries: 10 };

    state.revoke(
        alloc::string::String::from("session-A"),
        WallClockMs(5000),
        10,
    );

    let arc_state = Arc::new(StateLock::new(state));
    let decision = evaluate(arc_state, &config, "session-B", 1000);

    assert_eq!(
        decision,
        GuardDecision::Allow,
        "Revoking session-A must not affect session-B"
    );
}

#[test]
fn test_6_no_head_of_line_blocking() {
    // Insert session-A with exp=T+1000 (far future), session-B with exp=T+1 (near future).
    // Advance time to T+2. Session-B must be evicted (Allow); session-A must still Deny.
    //
    // BinaryHeap (min-heap): session-B (exp=T+1) is at heap top → evicted first → correct.
    // VecDeque (insertion order): session-A at head → B cannot be evicted → HOL bug.
    // This test proves the BinaryHeap choice is structurally required for correct eviction.
    let t = 1000u64;
    let mut state = RevocationState::default();
    let config = RevocationConfig { max_entries: 10 };

    // Insert A first (far future exp) — would be at VecDeque head, blocking B's eviction
    state.revoke(
        alloc::string::String::from("session-A"),
        WallClockMs(t + 1000),
        10,
    );
    // Insert B second (near future exp) — should evict at T+2, NOT blocked by A
    state.revoke(
        alloc::string::String::from("session-B"),
        WallClockMs(t + 1),
        10,
    );

    let arc_state = Arc::new(StateLock::new(state));

    // Session-B must Allow at T+2: exp(T+1) < wall_clock(T+2) → evicted
    let decision_b = evaluate(arc_state.clone(), &config, "session-B", t + 2);
    assert_eq!(
        decision_b,
        GuardDecision::Allow,
        "Session-B (exp=T+1) at T+2 must Allow — BinaryHeap evicts in exp order, not insertion order"
    );

    // Session-A must still Deny at T+2: exp(T+1000) > wall_clock(T+2) → not expired
    let decision_a = evaluate(arc_state, &config, "session-A", t + 2);
    assert_eq!(
        decision_a,
        GuardDecision::Deny("session_revoked"),
        "Session-A (exp=T+1000) at T+2 must still Deny — not yet expired"
    );
}

#[test]
fn test_7_max_entries_cap() {
    // Fill RevocationState to max_entries (3), then insert one more.
    // Oldest (min exp) entry must be ejected; revoked_count() stays at max_entries (3).
    let config = RevocationConfig { max_entries: 3 };
    let mut state = RevocationState::default();

    state.revoke(
        alloc::string::String::from("s1"),
        WallClockMs(100),
        config.max_entries,
    );
    state.revoke(
        alloc::string::String::from("s2"),
        WallClockMs(200),
        config.max_entries,
    );
    state.revoke(
        alloc::string::String::from("s3"),
        WallClockMs(300),
        config.max_entries,
    );

    assert_eq!(state.revoked_count(), 3, "Before overflow: 3 entries");

    // Insert s4 — must eject s1 (lowest exp=100)
    state.revoke(
        alloc::string::String::from("s4"),
        WallClockMs(400),
        config.max_entries,
    );

    // set len must be max_entries (3), not 4
    assert_eq!(
        state.revoked_count(),
        config.max_entries,
        "After overflow, revoked_count() must be max_entries (oldest ejected)"
    );

    // s1 must have been ejected (oldest exp=100)
    assert!(
        !state.is_revoked("s1"),
        "s1 (oldest, exp=100) must be ejected when max_entries exceeded"
    );

    // s2, s3, s4 must be present
    assert!(state.is_revoked("s2"), "s2 must still be revoked");
    assert!(state.is_revoked("s3"), "s3 must still be revoked");
    assert!(
        state.is_revoked("s4"),
        "s4 must be revoked (newly inserted)"
    );
}
