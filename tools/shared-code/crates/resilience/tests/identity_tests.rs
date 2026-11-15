// tests/identity_tests.rs
// Integration tests for trust-tiered ConnectionIdentity types

use resilience::PeerId;
use resilience::{ConnectionIdentity, PersistResult, TierA, TierB, TierC};

#[test]
fn tier_a_has_persist_method() {
    let peer = PeerId("test-peer".to_string());
    let a = TierA {
        peer_id: peer,
        allowed_origins: vec!["https://localhost".to_string()],
        bundle_id: Some("com.example.app".to_string()),
        device_key: Some([0u8; 32]),
        persistence_key: "persistent-key".to_string(),
    };

    // TierA has .persist() method; returns StorageUnavailable until task-0515 wires storage.
    // Honest: callers must handle StorageUnavailable — it is not silent success.
    assert_eq!(a.persist(), PersistResult::StorageUnavailable);
    assert_eq!(a.trust_level(), 0);
}

#[test]
fn tier_b_has_expiry() {
    let peer = PeerId("remote-peer".to_string());
    let b = TierB {
        peer_id: peer,
        allowed_origins: vec!["https://api.example.com".to_string()],
        bundle_id: Some("com.example.mobile".to_string()),
        device_key: Some([1u8; 32]),
        expires_at: 1700000000, // Some timestamp in the past
    };

    assert_eq!(b.trust_level(), 1);
    // At high wall clock time, TierB is expired
    assert!(b.is_expired(2000000000000));
    // At low wall clock time, TierB is not expired
    assert!(!b.is_expired(1000000000000));
}

#[test]
fn tier_c_is_zero_trust() {
    let peer = PeerId("unknown-peer".to_string());
    let c = TierC {
        peer_id: peer.clone(),
        allowed_origins: vec![],
        bundle_id: None,
        device_key: None,
    };

    assert_eq!(c.trust_level(), 2);
    assert_eq!(c.peer_id(), &peer);
}

#[test]
fn connection_identity_encodes_all_tiers() {
    let peer_a = PeerId("tier-a-peer".to_string());
    let tier_a = TierA {
        peer_id: peer_a.clone(),
        allowed_origins: vec![],
        bundle_id: None,
        device_key: None,
        persistence_key: "key-a".to_string(),
    };
    let id_a = ConnectionIdentity::TierA(tier_a);
    assert_eq!(id_a.trust_level(), 0);
    assert_eq!(id_a.peer_id(), &peer_a);

    let peer_b = PeerId("tier-b-peer".to_string());
    let tier_b = TierB {
        peer_id: peer_b.clone(),
        allowed_origins: vec![],
        bundle_id: None,
        device_key: None,
        expires_at: u64::MAX,
    };
    let id_b = ConnectionIdentity::TierB(tier_b);
    assert_eq!(id_b.trust_level(), 1);
    assert_eq!(id_b.peer_id(), &peer_b);

    let peer_c = PeerId("tier-c-peer".to_string());
    let tier_c = TierC {
        peer_id: peer_c.clone(),
        allowed_origins: vec![],
        bundle_id: None,
        device_key: None,
    };
    let id_c = ConnectionIdentity::TierC(tier_c);
    assert_eq!(id_c.trust_level(), 2);
    assert_eq!(id_c.peer_id(), &peer_c);
}

#[test]
fn sp7_binding_fields_present_on_all_tiers() {
    let origins = vec!["https://example.com".to_string()];
    let bundle = Some("com.example".to_string());
    let device_key = Some([42u8; 32]);

    let peer = PeerId("test".to_string());

    // TierA
    let a = TierA {
        peer_id: peer.clone(),
        allowed_origins: origins.clone(),
        bundle_id: bundle.clone(),
        device_key,
        persistence_key: "key".to_string(),
    };
    assert_eq!(a.allowed_origins, origins);
    assert_eq!(a.bundle_id, bundle);
    assert_eq!(a.device_key, device_key);

    // TierB
    let b = TierB {
        peer_id: peer.clone(),
        allowed_origins: origins.clone(),
        bundle_id: bundle.clone(),
        device_key,
        expires_at: 1000,
    };
    assert_eq!(b.allowed_origins, origins);
    assert_eq!(b.bundle_id, bundle);
    assert_eq!(b.device_key, device_key);

    // TierC
    let c = TierC {
        peer_id: peer.clone(),
        allowed_origins: origins.clone(),
        bundle_id: bundle.clone(),
        device_key,
    };
    assert_eq!(c.allowed_origins, origins);
    assert_eq!(c.bundle_id, bundle);
    assert_eq!(c.device_key, device_key);
}
