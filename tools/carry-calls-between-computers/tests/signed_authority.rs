// tests/signed_authority.rs
//
// Purpose: Tests signed client grants, exact scope, freshness, expiry, trusted-key ambiguity, and revocation.
//
// Non-Negotiable Invariants:
// - Only a valid exact-scope grant from an unambiguous trusted key may commit, with rights rechecked at commit.
//
// Key Concepts:
// - Ed25519 grants bind purpose, issue time, lifetime, and exact account/resource/client scope.
// - Trusted-key uniqueness and fresh rights checks gate the SQL commit, including revocation after the write.
//
// Security Considerations:
// - Test keys and grants are synthetic; bad signatures, stale or overlong grants, wrong scope, ambiguity, and revocation refuse commit.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use content_crypto::advanced::blake3;
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use serde_json::json;
use std::sync::{
    atomic::{AtomicBool, AtomicI64, Ordering},
    Arc,
};
use trillion_local::{
    resource_authority::{admit, ClientAuthority, InvokeMessage, Refusal, Route, Scope},
    signed_authority::{AuthorityClock, ClientGrant, FreshRights, SignedAuthority, TrustedKey},
    store::{CommitContext, Error, Store},
};

struct Clock(AtomicI64);
impl AuthorityClock for Clock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}
struct Rights(AtomicBool);
impl FreshRights for Rights {
    fn current_revision(&self, _: &Scope, _: &str, _: i64) -> Option<String> {
        self.0.load(Ordering::SeqCst).then(|| "rights:one".into())
    }
}
struct Context {
    rights: Arc<Rights>,
    clock: Arc<Clock>,
    revoke_before_commit: bool,
    reads: AtomicI64,
}
impl CommitContext for Context {
    fn current_route(&self, _: &Scope) -> Option<Route> {
        if self.reads.fetch_add(1, Ordering::SeqCst) == 1 && self.revoke_before_commit {
            self.rights.0.store(false, Ordering::SeqCst);
        }
        Some(route())
    }
    fn now_ms(&self) -> i64 {
        self.clock.now_ms()
    }
}
fn route() -> Route {
    Route {
        account_id: "account:example".into(),
        device_id: "device:example".into(),
        resource_address: "project:example".into(),
        generation: "generation:example".into(),
    }
}
fn message() -> InvokeMessage {
    InvokeMessage { person_present: None,
        request_id: "request:example".into(),
        operation_resource: None,
        account_id: "account:example".into(),
        device_id: "device:example".into(),
        resource_address: "project:example".into(),
        generation: "generation:example".into(),
        operation: "record.mutate".into(),
        input: json!({"id":"record:example","expected_version":0,"value":{"answer":1}}),
        request_key: "request-key:example".into(),
        client_authorization: String::new(),
        deadline_at_ms: 5_000,
    }
}
fn scope(message: &InvokeMessage) -> Scope {
    Scope {
        account_id: message.account_id.clone(),
        device_id: message.device_id.clone(),
        resource_address: message.resource_address.clone(),
        generation: message.generation.clone(),
        operation: message.operation.clone(),
        request_key: message.request_key.clone(),
        input_identity: blake3::hash(&serde_json::to_vec(&message.input).unwrap())
            .to_hex()
            .to_string(),
    }
}
fn keypair() -> Ed25519KeyPair {
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
    Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap()
}
fn proof(pair: &Ed25519KeyPair, grant: &ClientGrant) -> String {
    let bytes = serde_json::to_vec(grant).unwrap();
    let mut signed = b"trillion.client-grant/v2\0".to_vec();
    signed.extend_from_slice(&bytes);
    json!({"key_id":"key:example","payload":URL_SAFE_NO_PAD.encode(&bytes),
        "signature":URL_SAFE_NO_PAD.encode(pair.sign(&signed).as_ref())})
    .to_string()
}
fn verifier(pair: &Ed25519KeyPair, rights: Arc<Rights>, clock: Arc<Clock>) -> SignedAuthority {
    SignedAuthority::new(
        vec![TrustedKey {
            account_id: "account:example".into(),
            key_id: "key:example".into(),
            public_key: pair.public_key().as_ref().try_into().unwrap(),
        }],
        rights,
        clock,
        b"trillion.client-grant/v2\0".to_vec(),
    )
}
fn grant(scope: Scope) -> ClientGrant {
    ClientGrant {
        version: 2,
        sign_in: "grant:example".into(),
        rights_revision: "rights:one".into(),
        scope,
        issued_at_ms: 1_000,
        expires_at_ms: 5_000,
    }
}

#[test]
fn signed_exact_scope_grant_reaches_physical_write_then_revocation_refuses_replay() {
    let pair = keypair();
    let rights = Arc::new(Rights(AtomicBool::new(true)));
    let clock = Arc::new(Clock(AtomicI64::new(1_000)));
    let authority = verifier(&pair, rights.clone(), clock.clone());
    let mut request = message();
    request.client_authorization = proof(&pair, &grant(scope(&request)));
    let admitted = admit(request, &route(), Some(&authority), 1_000).unwrap();
    assert_eq!(admitted.client_identity(), "grant:example");
    let context = Context {
        rights: rights.clone(),
        clock,
        revoke_before_commit: false,
        reads: AtomicI64::new(0),
    };
    let mut store = Store::open(":memory:").unwrap();
    store.mutate_admitted(&admitted, &context).unwrap();
    rights.0.store(false, Ordering::SeqCst);
    assert!(matches!(
        store.mutate_admitted(&admitted, &context),
        Err(Error::Refused(Refusal::ClientRevoked(_), _))
    ));
    assert_eq!(
        store
            .changes("account:example", "project:example", 0, 10)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn signature_scope_account_expiry_and_freshness_fail_closed() {
    let pair = keypair();
    let rights = Arc::new(Rights(AtomicBool::new(true)));
    let clock = Arc::new(Clock(AtomicI64::new(1_000)));
    let authority = verifier(&pair, rights.clone(), clock.clone());
    let mut request = message();
    request.client_authorization = proof(&pair, &grant(scope(&request)));
    let mut altered = request.clone();
    altered.input = json!({"id":"record:example","expected_version":0,"value":{"answer":2}});
    assert!(matches!(
        admit(altered, &route(), Some(&authority), 1_000),
        Err(Refusal::ClientRevoked(_))
    ));
    let mut tampered = request.clone();
    let mut envelope: serde_json::Value =
        serde_json::from_str(&tampered.client_authorization).unwrap();
    let mut signature = URL_SAFE_NO_PAD
        .decode(envelope["signature"].as_str().unwrap())
        .unwrap();
    signature[0] ^= 1;
    envelope["signature"] = json!(URL_SAFE_NO_PAD.encode(signature));
    tampered.client_authorization = envelope.to_string();
    assert!(matches!(
        admit(tampered, &route(), Some(&authority), 1_000),
        Err(Refusal::ClientRevoked(_))
    ));
    let other_account = SignedAuthority::new(
        vec![TrustedKey {
            account_id: "account:other".into(),
            key_id: "key:example".into(),
            public_key: pair.public_key().as_ref().try_into().unwrap(),
        }],
        rights.clone(),
        clock.clone(),
        b"trillion.client-grant/v2\0".to_vec(),
    );
    assert!(matches!(
        admit(request.clone(), &route(), Some(&other_account), 1_000),
        Err(Refusal::ClientRevoked(_))
    ));
    let mut wrong_revision = request.clone();
    let mut wrong_revision_grant = grant(scope(&wrong_revision));
    wrong_revision_grant.rights_revision = "rights:old".into();
    wrong_revision.client_authorization = proof(&pair, &wrong_revision_grant);
    assert!(matches!(
        admit(wrong_revision, &route(), Some(&authority), 1_000),
        Err(Refusal::ClientRevoked(_))
    ));
    let mut display_name = request.clone();
    let mut display_grant = grant(scope(&display_name));
    display_grant.sign_in = "chatgpt".into();
    display_name.client_authorization = proof(&pair, &display_grant);
    assert!(matches!(
        admit(display_name, &route(), Some(&authority), 1_000),
        Err(Refusal::ClientRevoked(_))
    ));
    rights.0.store(false, Ordering::SeqCst);
    assert!(matches!(
        admit(request.clone(), &route(), Some(&authority), 1_000),
        Err(Refusal::ClientRevoked(_))
    ));
    rights.0.store(true, Ordering::SeqCst);
    let mut expired = request;
    let mut expired_grant = grant(scope(&expired));
    expired_grant.expires_at_ms = 1_500;
    expired.client_authorization = proof(&pair, &expired_grant);
    clock.0.store(1_500, Ordering::SeqCst);
    assert!(matches!(
        admit(expired, &route(), Some(&authority), 1_500),
        Err(Refusal::ClientRevoked(_))
    ));
}

#[test]
fn duplicate_trusted_key_id_is_ambiguous_and_fails_closed() {
    let pair = keypair();
    let other_pair = keypair();
    let rights = Arc::new(Rights(AtomicBool::new(true)));
    let clock = Arc::new(Clock(AtomicI64::new(1_000)));
    let scope = scope(&message());
    let proof = proof(&pair, &grant(scope.clone()));
    let authority = SignedAuthority::new(
        vec![
            TrustedKey {
                account_id: "account:example".into(),
                key_id: "key:example".into(),
                public_key: pair.public_key().as_ref().try_into().unwrap(),
            },
            TrustedKey {
                account_id: "account:example".into(),
                key_id: "key:example".into(),
                public_key: other_pair.public_key().as_ref().try_into().unwrap(),
            },
        ],
        rights,
        clock,
        b"trillion.client-grant/v2\0".to_vec(),
    );

    assert!(authority.admit(&proof, &scope).is_none());
}

#[test]
fn grant_purpose_issue_time_and_total_lifetime_are_enforced() {
    let pair = keypair();
    let rights = Arc::new(Rights(AtomicBool::new(true)));
    let clock = Arc::new(Clock(AtomicI64::new(1_000)));
    let authority = verifier(&pair, rights.clone(), clock.clone());
    let scope = scope(&message());
    let grant = grant(scope.clone());
    let wrong_domain = SignedAuthority::new(
        vec![TrustedKey {
            account_id: "account:example".into(),
            key_id: "key:example".into(),
            public_key: pair.public_key().as_ref().try_into().unwrap(),
        }],
        rights,
        clock.clone(),
        b"other.client-grant/v2\0".to_vec(),
    );
    assert!(wrong_domain.admit(&proof(&pair, &grant), &scope).is_none());
    let bytes = serde_json::to_vec(&grant).unwrap();
    let wrong_purpose = json!({"key_id":"key:example","payload":URL_SAFE_NO_PAD.encode(&bytes),
        "signature":URL_SAFE_NO_PAD.encode(pair.sign(&bytes).as_ref())})
    .to_string();
    assert!(authority.admit(&wrong_purpose, &scope).is_none());
    let mut old_domain = b"trillion.client-grant/v1\0".to_vec();
    old_domain.extend_from_slice(&bytes);
    let old_proof = json!({"key_id":"key:example","payload":URL_SAFE_NO_PAD.encode(&bytes),
        "signature":URL_SAFE_NO_PAD.encode(pair.sign(&old_domain).as_ref())})
    .to_string();
    assert!(authority.admit(&old_proof, &scope).is_none());
    let mut old_version = grant.clone();
    old_version.version = 1;
    assert!(authority
        .admit(&proof(&pair, &old_version), &scope)
        .is_none());

    let mut future = grant.clone();
    future.issued_at_ms = 1_001;
    assert!(authority.admit(&proof(&pair, &future), &scope).is_none());

    let admitted = authority.admit(&proof(&pair, &grant), &scope).unwrap();
    assert!(admitted.assert_current(&scope));
    clock.0.store(999, Ordering::SeqCst);
    assert!(!admitted.assert_current(&scope));

    clock.0.store(200_000, Ordering::SeqCst);
    let mut old = grant;
    old.expires_at_ms = 200_010;
    assert!(authority.admit(&proof(&pair, &old), &scope).is_none());
}

#[test]
fn revocation_after_sql_write_prevents_signed_grant_commit() {
    let pair = keypair();
    let rights = Arc::new(Rights(AtomicBool::new(true)));
    let clock = Arc::new(Clock(AtomicI64::new(1_000)));
    let authority = verifier(&pair, rights.clone(), clock.clone());
    let mut request = message();
    request.client_authorization = proof(&pair, &grant(scope(&request)));
    let admitted = admit(request, &route(), Some(&authority), 1_000).unwrap();
    let context = Context {
        rights,
        clock,
        revoke_before_commit: true,
        reads: AtomicI64::new(0),
    };
    let mut store = Store::open(":memory:").unwrap();
    assert!(matches!(
        store.mutate_admitted(&admitted, &context),
        Err(Error::Refused(Refusal::ClientRevoked(_), _))
    ));
    assert!(store
        .get("account:example", "project:example", "record:example")
        .unwrap()
        .record
        .is_none());
    assert!(store
        .changes("account:example", "project:example", 0, 10)
        .unwrap()
        .is_empty());
}
