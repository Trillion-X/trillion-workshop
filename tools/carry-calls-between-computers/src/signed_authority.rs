// src/signed_authority.rs
//
// Purpose: Verify scoped remote-client grants with configured public keys and synchronous fresh-rights checks.
//
// Non-Negotiable Invariants:
// - Verify the domain-separated signature over the exact bounded payload bytes.
// - A valid signature alone is insufficient: check current rights and time at admission and commitment.
// - Keep signing keys with the account rights owner.
//
// Key Concepts:
// - Ed25519 verification, rights revisions and immutable scoped grants.
// - TrustedKey, FreshRights and supplied authority clock.
//
// Security Considerations:
// - Refuse unknown keys, malformed proofs, stale revisions, scope changes and expired grants.
// - Configured verifier fixtures do not establish production key custody or registration.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! Locally verifiable remote-client grants. The account's rights owner keeps
//! the signing key; this module only accepts configured public keys. The
//! signature covers the account owner's configured, versioned domain followed by the exact payload
//! bytes. A valid signature is insufficient without a synchronous current-rights
//! read at admission and at the resource's physical commit check.
use crate::resource_authority::{ClientAuthority, CurrentClient, Scope};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const MAX_PROOF_BYTES: usize = 8_192;
const MAX_PAYLOAD_BYTES: usize = 4_096;
const MAX_GRANT_LIFE_MS: i64 = 120_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ClientGrant {
    pub version: u8,
    /// Exact authenticated AccountControl sign-in, never an OAuth app name.
    pub sign_in: String,
    pub rights_revision: String,
    pub scope: Scope,
    pub issued_at_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    key_id: String,
    payload: String,
    signature: String,
}

pub struct TrustedKey {
    pub account_id: String,
    pub key_id: String,
    pub public_key: [u8; 32],
}

pub trait AuthorityClock: Send + Sync {
    fn now_ms(&self) -> i64;
}

/// Implemented by the actual account-rights owner on the Mac. It must read
/// current revocation and reach synchronously. Return a revision only while
/// this exact sign-in and scope are allowed; missing or stale state denies.
pub trait FreshRights: Send + Sync {
    fn current_revision(&self, scope: &Scope, sign_in: &str, now_ms: i64) -> Option<String>;
}

pub struct SignedAuthority {
    keys: Vec<TrustedKey>,
    rights: Arc<dyn FreshRights>,
    clock: Arc<dyn AuthorityClock>,
    signature_domain: Vec<u8>,
}

impl SignedAuthority {
    pub fn new(
        keys: Vec<TrustedKey>,
        rights: Arc<dyn FreshRights>,
        clock: Arc<dyn AuthorityClock>,
        signature_domain: Vec<u8>,
    ) -> Self {
        Self {
            keys,
            rights,
            clock,
            signature_domain,
        }
    }
}

struct SignedClient {
    grant: ClientGrant,
    rights: Arc<dyn FreshRights>,
    clock: Arc<dyn AuthorityClock>,
}

fn bounded(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.bytes().any(|byte| byte < 32)
}

fn valid_sign_in(value: &str) -> bool {
    let id = value
        .strip_prefix("jwt:")
        .or_else(|| value.strip_prefix("key:"))
        .or_else(|| value.strip_prefix("grant:"));
    id.is_some_and(|id| {
        !id.is_empty()
            && id.len() <= 200
            && id
                .bytes()
                .all(|byte| byte.is_ascii_graphic() && byte != b':')
    })
}

impl CurrentClient for SignedClient {
    fn identity(&self) -> &str {
        &self.grant.sign_in
    }

    fn assert_current(&self, scope: &Scope) -> bool {
        let now = self.clock.now_ms();
        self.grant.scope == *scope
            && now >= self.grant.issued_at_ms
            && now < self.grant.expires_at_ms
            && self
                .rights
                .current_revision(scope, &self.grant.sign_in, now)
                .as_deref()
                == Some(self.grant.rights_revision.as_str())
    }
}

impl ClientAuthority for SignedAuthority {
    fn admit(&self, proof: &str, scope: &Scope) -> Option<Box<dyn CurrentClient>> {
        if proof.len() > MAX_PROOF_BYTES
            || self.signature_domain.is_empty()
            || self.signature_domain.len() > 128
            || self.signature_domain.last() != Some(&0)
        {
            return None;
        }
        let envelope: Envelope = serde_json::from_str(proof).ok()?;
        if !bounded(&envelope.key_id, 160) {
            return None;
        }
        let payload = URL_SAFE_NO_PAD.decode(envelope.payload).ok()?;
        let signature = URL_SAFE_NO_PAD.decode(envelope.signature).ok()?;
        if payload.len() > MAX_PAYLOAD_BYTES || signature.len() != 64 {
            return None;
        }
        let grant: ClientGrant = serde_json::from_slice(&payload).ok()?;
        let now = self.clock.now_ms();
        if grant.version != 2
            || grant.scope != *scope
            || !valid_sign_in(&grant.sign_in)
            || !bounded(&grant.rights_revision, 160)
            || grant.issued_at_ms <= 0
            || grant.issued_at_ms > now
            || grant.expires_at_ms <= now
            || grant
                .expires_at_ms
                .checked_sub(grant.issued_at_ms)
                .is_none_or(|life| life > MAX_GRANT_LIFE_MS)
        {
            return None;
        }
        // A key ID is the account policy owner's stable lookup name. If the
        // configured trust set contains multiple entries for that name, its
        // meaning is ambiguous (and removing one entry during rotation could
        // otherwise leave the old key usable). Refuse the entire proof until
        // the trusted key set has one unambiguous owner for this ID.
        let mut matching_keys = self.keys.iter().filter(|key| {
            key.account_id == grant.scope.account_id && key.key_id == envelope.key_id
        });
        let key = matching_keys.next()?;
        if matching_keys.next().is_some() {
            return None;
        }
        let mut signed = Vec::with_capacity(self.signature_domain.len() + payload.len());
        signed.extend_from_slice(&self.signature_domain);
        signed.extend_from_slice(&payload);
        UnparsedPublicKey::new(&ED25519, &key.public_key)
            .verify(&signed, &signature)
            .ok()?;
        if self
            .rights
            .current_revision(scope, &grant.sign_in, now)
            .as_deref()
            != Some(grant.rights_revision.as_str())
        {
            return None;
        }
        Some(Box::new(SignedClient {
            grant,
            rights: self.rights.clone(),
            clock: self.clock.clone(),
        }))
    }
}
