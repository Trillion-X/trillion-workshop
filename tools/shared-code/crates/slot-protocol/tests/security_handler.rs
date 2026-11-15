// crates/slot-protocol/tests/security_handler.rs
//
// Category 9 from UWHA Plan §Task O: Red-Team Gauntlet.
// Security tests for slot-protocol: capability restriction, authorization
// boundary enforcement, latest-accepted-expiry rollback prevention, isolation guarantees.

use slot_protocol::auth::{AuthorizationContext, LatestAcceptedCapabilityExpiry};
use slot_protocol::newtypes::CapabilityHash;
use smallvec::SmallVec;

// ============================================================================
// Authorization boundary tests
// ============================================================================

#[test]
fn unauthenticated_no_caps_no_required_passes() {
    let ctx = AuthorizationContext {
        granted: SmallVec::new(),
        required: SmallVec::new(),
        authenticated: false,
    };
    assert!(ctx.has_permission(), "no restriction = open access");
}

#[test]
fn unauthenticated_no_caps_with_required_denied() {
    let cap = CapabilityHash::from_digest(0x1F, vec![1; 32]);
    let mut required = SmallVec::new();
    required.push(cap);

    let ctx = AuthorizationContext {
        granted: SmallVec::new(),
        required,
        authenticated: false,
    };
    assert!(!ctx.has_permission(), "missing capability = denied");
}

#[test]
fn unauthenticated_wrong_cap_denied() {
    let cap_a = CapabilityHash::from_digest(0x1F, vec![1; 32]);
    let cap_b = CapabilityHash::from_digest(0x1F, vec![2; 32]);

    let mut granted = SmallVec::new();
    granted.push(cap_a);
    let mut required = SmallVec::new();
    required.push(cap_b);

    let ctx = AuthorizationContext {
        granted,
        required,
        authenticated: false,
    };
    assert!(!ctx.has_permission(), "wrong capability = denied");
}

#[test]
fn unauthenticated_matching_cap_passes() {
    let cap = CapabilityHash::from_digest(0x1F, vec![42; 32]);
    let mut granted = SmallVec::new();
    granted.push(cap.clone());
    let mut required = SmallVec::new();
    required.push(cap);

    let ctx = AuthorizationContext {
        granted,
        required,
        authenticated: false,
    };
    assert!(ctx.has_permission(), "matching capability = access");
}

#[test]
fn authenticated_bypasses_all_checks() {
    let cap = CapabilityHash::from_digest(0x1F, vec![99; 32]);
    let mut required = SmallVec::new();
    required.push(cap);

    let ctx = AuthorizationContext {
        granted: SmallVec::new(), // zero caps but authenticated
        required,
        authenticated: true,
    };
    assert!(
        ctx.has_permission(),
        "authenticated = bypass (pre-token behavior)"
    );
}

#[test]
fn intersection_returns_only_shared_caps() {
    let cap_a = CapabilityHash::from_digest(0x1F, vec![1; 32]);
    let cap_b = CapabilityHash::from_digest(0x1F, vec![2; 32]);
    let cap_c = CapabilityHash::from_digest(0x1F, vec![3; 32]);

    let mut granted = SmallVec::new();
    granted.push(cap_a.clone());
    granted.push(cap_b.clone());

    let mut required = SmallVec::new();
    required.push(cap_b.clone());
    required.push(cap_c);

    let ctx = AuthorizationContext {
        granted,
        required,
        authenticated: false,
    };
    let inter = ctx.intersection();
    assert_eq!(inter.len(), 1);
    assert_eq!(inter[0], cap_b);
}

#[test]
fn intersection_empty_when_disjoint() {
    let cap_a = CapabilityHash::from_digest(0x1F, vec![1; 32]);
    let cap_b = CapabilityHash::from_digest(0x1F, vec![2; 32]);

    let mut granted = SmallVec::new();
    granted.push(cap_a);
    let mut required = SmallVec::new();
    required.push(cap_b);

    let ctx = AuthorizationContext {
        granted,
        required,
        authenticated: false,
    };
    assert!(ctx.intersection().is_empty());
}

// ============================================================================
// Latest accepted capability expiry (SP3) rollback prevention
// ============================================================================

#[test]
fn latest_accepted_capability_expiry_rejects_expired_capability() {
    let latest_expiry = LatestAcceptedCapabilityExpiry::new(1000);
    assert!(
        !latest_expiry.is_valid_expiry(999),
        "expiry before latest accepted capability expiry must be rejected"
    );
    assert!(
        !latest_expiry.is_valid_expiry(0),
        "zero expiry must be rejected"
    );
}

#[test]
fn latest_accepted_capability_expiry_accepts_current_and_future() {
    let latest_expiry = LatestAcceptedCapabilityExpiry::new(1000);
    assert!(
        latest_expiry.is_valid_expiry(1000),
        "exact latest accepted capability expiry is valid"
    );
    assert!(latest_expiry.is_valid_expiry(1001), "future is valid");
    assert!(
        latest_expiry.is_valid_expiry(u64::MAX),
        "max future is valid"
    );
}

#[test]
fn latest_accepted_capability_expiry_monotonic_update() {
    let mut latest_expiry = LatestAcceptedCapabilityExpiry::new(100);
    latest_expiry.accept_expiry(200);
    assert_eq!(latest_expiry.latest_accepted_expiry, 200);

    // Lower value must NOT reduce the latest accepted capability expiry.
    latest_expiry.accept_expiry(150);
    assert_eq!(
        latest_expiry.latest_accepted_expiry, 200,
        "latest accepted capability expiry must never decrease"
    );

    latest_expiry.accept_expiry(100);
    assert_eq!(
        latest_expiry.latest_accepted_expiry, 200,
        "latest accepted capability expiry must never decrease even to original"
    );

    latest_expiry.accept_expiry(0);
    assert_eq!(
        latest_expiry.latest_accepted_expiry, 200,
        "latest accepted capability expiry must never decrease to zero"
    );
}

#[test]
fn latest_accepted_capability_expiry_update_to_same_value_is_idempotent() {
    let mut latest_expiry = LatestAcceptedCapabilityExpiry::new(500);
    latest_expiry.accept_expiry(500);
    assert_eq!(latest_expiry.latest_accepted_expiry, 500);
}

#[test]
fn latest_accepted_capability_expiry_sequence_attack_scenario() {
    // Simulate: attacker tries to use capability from before latest accepted expiry was updated.
    let mut latest_expiry = LatestAcceptedCapabilityExpiry::new(0);

    // Legitimate capability issued at t=100
    latest_expiry.accept_expiry(100);
    assert!(latest_expiry.is_valid_expiry(100));

    // New capability issued at t=200
    latest_expiry.accept_expiry(200);

    // Attacker replays the old capability (expiry=100)
    assert!(
        !latest_expiry.is_valid_expiry(100),
        "replayed old capability must be rejected"
    );
    assert!(
        !latest_expiry.is_valid_expiry(150),
        "anything before current latest accepted capability expiry rejected"
    );
    assert!(
        latest_expiry.is_valid_expiry(200),
        "current latest accepted capability expiry still valid"
    );
    assert!(latest_expiry.is_valid_expiry(300), "future still valid");
}

// ============================================================================
// Capability hash uniqueness
// ============================================================================

#[test]
fn capability_hash_different_bytes_are_distinct() {
    let cap_a = CapabilityHash::from_digest(0x1F, vec![1; 32]);
    let cap_b = CapabilityHash::from_digest(0x1F, vec![2; 32]);
    assert_ne!(cap_a, cap_b);
}

#[test]
fn capability_hash_same_bytes_are_equal() {
    let cap_a = CapabilityHash::from_digest(0x1F, vec![42; 32]);
    let cap_b = CapabilityHash::from_digest(0x1F, vec![42; 32]);
    assert_eq!(cap_a, cap_b);
}

#[test]
fn capability_hash_clone_preserves_identity() {
    let cap = CapabilityHash::from_digest(0x1F, vec![7; 32]);
    let cloned = cap.clone();
    assert_eq!(cap, cloned);
}

// ============================================================================
// Multiple capabilities — OR semantics (any match = access)
// ============================================================================

#[test]
fn multiple_required_any_single_match_grants_access() {
    let cap_a = CapabilityHash::from_digest(0x1F, vec![1; 32]);
    let cap_b = CapabilityHash::from_digest(0x1F, vec![2; 32]);
    let cap_c = CapabilityHash::from_digest(0x1F, vec![3; 32]);

    // Principal has only cap_b
    let mut granted = SmallVec::new();
    granted.push(cap_b.clone());

    // Envelope requires cap_a OR cap_b OR cap_c
    let mut required = SmallVec::new();
    required.push(cap_a);
    required.push(cap_b);
    required.push(cap_c);

    let ctx = AuthorizationContext {
        granted,
        required,
        authenticated: false,
    };
    assert!(
        ctx.has_permission(),
        "any single match should grant access (OR semantics)"
    );
}

#[test]
fn many_granted_none_required_passes() {
    let mut granted = SmallVec::new();
    for i in 0..32u8 {
        granted.push(CapabilityHash::from_digest(0x1F, vec![i; 32]));
    }

    let ctx = AuthorizationContext {
        granted,
        required: SmallVec::new(),
        authenticated: false,
    };
    assert!(
        ctx.has_permission(),
        "no requirement = pass regardless of granted count"
    );
}
