//! Shared forwarder connection check through canonical AccountControl and device
//! credential owners. This module stores no route authority: its bounded,
//! short-lived secret cache only lets `ConnectionAdmission::is_current` present
//! the original trc_ credential again to the canonical issuer.

use crate::refusal_cause::CodedError;
use crate::forwarder::session::{ConnectionAdmission, ConnectionGrant, Registration};
use crate::https::{post_authority_json, AuthorityHttpFailure};
use content_crypto::advanced::blake3;
use serde::Deserialize;
use std::{collections::HashMap, sync::Mutex, time::{Duration, Instant}};
use url::Url;
use zeroize::Zeroizing;

// The ingress allows 64 active sockets and 32 pending connection checks. The cache
// cannot become an unbounded second registry during repeated failed handshakes.
const MAX_SESSIONS: usize = 96;
const MAX_REPLY_BYTES: usize = 4096;
const MAX_LIFE_MS: i64 = 120_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CanonicalAdmission {
    account_id: String,
    device_id: String,
    resource_address: String,
    route_generation: String,
    revision: u64,
    expires_at_ms: i64,
    token_digest: String,
}

struct RetainedCredential {
    raw: Zeroizing<Vec<u8>>,
    expires_at_ms: i64,
}

pub struct CanonicalConnectionAdmission {
    endpoint: Url,
    credentials: Mutex<HashMap<String, RetainedCredential>>,
}

impl CanonicalConnectionAdmission {
    pub fn new(endpoint: Url) -> Result<Self, CodedError<&'static str>> {
        if endpoint.scheme() != "https"
            || endpoint.username() != ""
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || endpoint.path() != "/devices/resource-connections/admit"
        {
            return Err(CodedError::new("canonical admission endpoint refused"));
        }
        Ok(Self { endpoint, credentials: Mutex::new(HashMap::new()) })
    }

    /// The grant the owner answers for `raw` now. `Err(Withdrawn)` when the owner refused it or answered a different
    /// grant; `Err(Unknown)` when it could not be asked or its answer could not be read.
    fn current(&self, raw: &[u8], now_ms: i64) -> Result<ConnectionGrant, Registration> {
        if now_ms <= 0 || raw.len() != 133 || !raw.starts_with(b"trc_")
            || raw[68] != b'_'
            || !raw[4..68].iter().chain(raw[69..].iter()).all(|b|
                b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        { return Err(crate::cause!(Registration::Withdrawn)); }
        let bearer = std::str::from_utf8(raw).map_err(|error| crate::carry_cause!(Registration::Withdrawn, error))?;
        let digest = blake3::hash(raw).to_hex().to_string();
        let deadline = Instant::now().checked_add(Duration::from_secs(5)).ok_or(crate::cause!(Registration::Unknown))?;
        let reply = Zeroizing::new(post_authority_json(
            &self.endpoint, bearer, br#"{}"#, MAX_REPLY_BYTES, deadline, &|| true,
        ).map_err(|failure| match failure {
            AuthorityHttpFailure::CredentialRejected(cause) => Registration::Withdrawn(cause),
            AuthorityHttpFailure::Unavailable(cause) => Registration::Unknown(cause),
        })?);
        let reply: CanonicalAdmission = serde_json::from_slice(&reply).map_err(|error| crate::carry_cause!(Registration::Unknown, error))?;
        let expires_in = reply.expires_at_ms.checked_sub(now_ms).ok_or(crate::cause!(Registration::Withdrawn))?;
        if reply.account_id.len() != 64
            || !reply.account_id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || reply.device_id.as_bytes() != &raw[4..68]
            || reply.resource_address != "@own-records"
            || reply.route_generation.len() != 75
            || !reply.route_generation.starts_with("connection:")
            || !reply.route_generation[11..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || reply.revision == 0
            || reply.token_digest != digest
            || reply.expires_at_ms <= now_ms
            || expires_in > MAX_LIFE_MS
        { return Err(crate::cause!(Registration::Withdrawn)); }
        Ok(ConnectionGrant {
            route: crate::resource_authority::Route {
                account_id: reply.account_id,
                device_id: reply.device_id,
                resource_address: reply.resource_address,
                generation: reply.route_generation,
            },
            expires_at_ms: reply.expires_at_ms,
            admission_identity: Some(digest),
        })
    }
}

impl ConnectionAdmission for CanonicalConnectionAdmission {
    fn admit(&self, credential: &[u8], now_ms: i64) -> Option<ConnectionGrant> {
        let grant = self.current(credential, now_ms).ok()?;
        let digest = grant.admission_identity.as_ref()?.clone();
        let mut retained = self.credentials.lock().ok()?;
        retained.retain(|_, value| value.expires_at_ms > now_ms);
        if !retained.contains_key(&digest) && retained.len() >= MAX_SESSIONS { return None; }
        retained.insert(digest, RetainedCredential {
            raw: Zeroizing::new(credential.to_vec()), expires_at_ms: grant.expires_at_ms,
        });
        Some(grant)
    }

    fn is_current(&self, grant: &ConnectionGrant, now_ms: i64) -> bool {
        self.registration(grant, now_ms) == Registration::Current
    }

    /// Asks the owner again with the retained credential. Only a refusal or a different grant withdraws it (and
    /// forgets the credential); an owner that could not be read leaves it retained for the next read.
    fn registration(&self, grant: &ConnectionGrant, now_ms: i64) -> Registration {
        let Some(digest) = grant.admission_identity.as_ref() else { return crate::cause!(Registration::Withdrawn); };
        let raw = {
            let Ok(retained) = self.credentials.lock() else { return crate::cause!(Registration::Unknown); };
            let Some(value) = retained.get(digest).filter(|v| v.expires_at_ms > now_ms) else {
                return crate::cause!(Registration::Withdrawn);
            };
            Zeroizing::new(value.raw.to_vec())
        };
        let answer = match self.current(&raw, now_ms) {
            Ok(current) if current.route == grant.route
                && current.expires_at_ms == grant.expires_at_ms
                && current.admission_identity == grant.admission_identity => Registration::Current,
            Ok(_) => crate::cause!(Registration::Withdrawn),
            Err(answer) => answer,
        };
        if matches!(answer, Registration::Withdrawn(_)) {
            if let Ok(mut retained) = self.credentials.lock() { retained.remove(digest); }
        }
        answer
    }
}

/// The generation of a route a computer's own session credential opens: `connection:` + the credential's BLAKE3, so the
/// computer knows the exact route the forwarder acknowledges and every new session is a new generation.
pub fn computer_route(credential: &str, now_ms: i64) -> Option<(crate::resource_authority::Route, i64)> {
    let (computer, account, at) = crate::account::computers::read_computer_credential(credential, now_ms)?;
    let expires_at_ms = at.checked_add(crate::forwarder::session::MAX_SESSION_LIFE_MS)?;
    Some((crate::resource_authority::Route {
        account_id: account,
        device_id: computer,
        resource_address: "@own-records".to_owned(),
        generation: format!("connection:{}", blake3::hash(credential.as_bytes()).to_hex()),
    }, expires_at_ms))
}

/// The connection check of a computer that proves its own key (`trp_` credential, src/account/computers.rs `ComputerSigner`). It stores
/// nothing and asks no one: the credential's signature is checked against the computer id it names, and its time must be
/// within the proof window. The check says only which computer opened a session for which account; the forwarder answers
/// that account from the session only when the account's own signed computers row, told with the account's key,
/// names that computer as one that may answer (`ConnectedComputers::current_route`).
pub struct ComputerAdmission;

/// The start of the identity a grant from `ComputerAdmission` carries, so the forwarder rechecks it there.
const COMPUTER_IDENTITY_PREFIX: &str = "computer-";

impl ConnectionAdmission for ComputerAdmission {
    fn admit(&self, credential: &[u8], now_ms: i64) -> Option<ConnectionGrant> {
        let text = std::str::from_utf8(credential).ok()?;
        let (route, expires_at_ms) = computer_route(text, now_ms)?;
        if expires_at_ms <= now_ms { return None; }
        Some(ConnectionGrant {
            route,
            expires_at_ms: expires_at_ms.min(now_ms.checked_add(MAX_LIFE_MS)?),
            admission_identity: Some(format!("{COMPUTER_IDENTITY_PREFIX}{}", blake3::hash(credential).to_hex())),
        })
    }

    fn is_current(&self, grant: &ConnectionGrant, now_ms: i64) -> bool {
        grant.admission_identity.as_deref().is_some_and(|identity| identity.starts_with(COMPUTER_IDENTITY_PREFIX))
            && now_ms > 0 && now_ms < grant.expires_at_ms
    }
}

/// The forwarder's connection check: a computer's own proof (`trp_`) is checked by `ComputerAdmission`; any other credential
/// goes to the account routes' canonical connection check when this forwarder serves their hosting app.
pub struct DoorOrComputerAdmission {
    door: Option<CanonicalConnectionAdmission>,
}

impl DoorOrComputerAdmission {
    pub fn new(door: Option<CanonicalConnectionAdmission>) -> Self {
        Self { door }
    }
}

impl ConnectionAdmission for DoorOrComputerAdmission {
    fn admit(&self, credential: &[u8], now_ms: i64) -> Option<ConnectionGrant> {
        if credential.starts_with(crate::account::computers::COMPUTER_PROOF_PREFIX.as_bytes()) {
            return ComputerAdmission.admit(credential, now_ms);
        }
        self.door.as_ref()?.admit(credential, now_ms)
    }

    fn is_current(&self, grant: &ConnectionGrant, now_ms: i64) -> bool {
        self.registration(grant, now_ms) == Registration::Current
    }

    fn registration(&self, grant: &ConnectionGrant, now_ms: i64) -> Registration {
        if grant.admission_identity.as_deref().is_some_and(|identity| identity.starts_with(COMPUTER_IDENTITY_PREFIX)) {
            return ComputerAdmission.registration(grant, now_ms);
        }
        self.door.as_ref().map_or(crate::cause!(Registration::Withdrawn), |door| door.registration(grant, now_ms))
    }
}
