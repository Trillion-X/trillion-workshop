//! Publish one already issued, locally checked short connection credential at
//! the account routes' own device routes (src/account/devices.rs), reached at the public
//! origin. Those routes read the current credential this same account issued; a publication is
//! acknowledged only when the current credential is the published credential one revision
//! past the one `current` answered. A failed or ambiguous publication prevents
//! the WSS connection.

use super::SelectedAccount;
use content_crypto::advanced::blake3;
use crate::{
    account_rights::resource_connection::credential::IssuedCredential,
    native::ResourceConnectionSettings,
    forwarder::session::ConnectionGrant,
    https::{post_authority_json, AuthorityHttpFailure},
};
use serde::{Deserialize, Serialize};
use std::{io, sync::{Arc, Mutex}, time::Instant};
use url::Url;
use zeroize::Zeroizing;

const MAX_REPLY_BYTES: usize = 4096;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Current {
    account_id: String,
    device_id: String,
    revision: u64,
    revoked: bool,
    resource_address: Option<String>,
    route_generation: Option<String>,
    expires_at_ms: Option<i64>,
    token_digest: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Published {
    account_id: String,
    device_id: String,
    resource_address: String,
    route_generation: String,
    revision: u64,
    expires_at_ms: i64,
    token_digest: String,
}

fn unavailable() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "current resource registration unavailable")
}

fn endpoint(selected: &Arc<Mutex<SelectedAccount>>) -> io::Result<Url> {
    let owner = crate::io_operation!((crate::workspace_session::owner_wait::acquire(selected, || false).map_err(|error| crate::refusal_cause::locate_io(unavailable(), crate::refusal_cause::Caused::cause(&error)))).map_err(std::io::Error::from))?;
    crate::io_operation!((owner.selection.assert_current().map_err(|error| crate::refusal_cause::locate_io(unavailable(), crate::refusal_cause::Caused::cause(&error)))).map_err(std::io::Error::from))?;
    let service = crate::io_operation!((crate::io_operation!((owner.selection.selected_mcp_service_endpoints()
        .map_err(|error| crate::refusal_cause::locate_io(unavailable(), crate::refusal_cause::Caused::cause(&error)))).map_err(std::io::Error::from))?.ok_or_else(unavailable)).map_err(std::io::Error::from))?;
    let url = crate::io_operation!((Url::parse(service.origin()).map_err(|error| crate::refusal_cause::locate_io(unavailable(), crate::refusal_cause::Caused::cause(&error)))).map_err(std::io::Error::from))?;
    crate::io_operation!((owner.selection.assert_current().map_err(|error| crate::refusal_cause::locate_io(unavailable(), crate::refusal_cause::Caused::cause(&error)))).map_err(std::io::Error::from))?;
    Ok(url)
}

#[derive(Serialize)]
struct Publication<'a> {
    token: &'a str,
    resource_address: &'a str,
    route_generation: &'a str,
    expected_revision: u64,
    expires_at_ms: i64,
}

/// The worker-side revision is read from the current account policy owner.
/// The callback is the caller's local current credential, grant and selected-source check;
/// it must never make another remote authority request.
pub(crate) fn publish_current(
    selected: &Arc<Mutex<SelectedAccount>>,
    settings: &ResourceConnectionSettings,
    credential: &IssuedCredential,
    deadline: Instant,
    local_current: &dyn Fn() -> bool,
) -> io::Result<()> {
    if !local_current() { return crate::io_operation!(Err(unavailable())); }
    let url = crate::io_operation!((endpoint(selected)).map_err(std::io::Error::from))?;
    let tc = crate::io_operation!((std::str::from_utf8(settings.key.as_bytes()).map_err(|error| crate::refusal_cause::locate_io(unavailable(), crate::refusal_cause::Caused::cause(&error)))).map_err(std::io::Error::from))?;
    let trc = crate::io_operation!((std::str::from_utf8(credential.as_bytes()).map_err(|error| crate::refusal_cause::locate_io(unavailable(), crate::refusal_cause::Caused::cause(&error)))).map_err(std::io::Error::from))?;
    crate::io_operation!(publish_to_endpoint(url, tc, trc, credential.grant(), deadline, local_current,
        post_authority_json))
}

// The production orchestration is shared with deterministic synthetic transport
// controls and with the door's own device routes' test (src/account/devices.rs).
// Real callers enter through publish_current's selected/issued owners.
pub(crate) fn publish_to_endpoint(
    mut url: Url,
    tc: &str,
    trc: &str,
    grant: &ConnectionGrant,
    deadline: Instant,
    local_current: &dyn Fn() -> bool,
    mut post: impl FnMut(&Url, &str, &[u8], usize, Instant, &dyn Fn() -> bool)
        -> Result<Vec<u8>, AuthorityHttpFailure>,
) -> io::Result<()> {
    if !local_current() { return crate::io_operation!(Err(unavailable())); }
    let digest = blake3::hash(trc.as_bytes()).to_hex().to_string();
    url.set_path("/devices/resource-connections/current");
    let current_bytes = Zeroizing::new(crate::io_operation!((post(
        &url, tc, br#"{}"#, MAX_REPLY_BYTES, deadline, local_current,
    ).map_err(|error| crate::refusal_cause::locate_io(unavailable(), crate::refusal_cause::Caused::cause(&error)))).map_err(std::io::Error::from))?);
    if !local_current() { return crate::io_operation!(Err(unavailable())); }
    let current: Current = crate::io_operation!((serde_json::from_slice(&current_bytes).map_err(|error| crate::refusal_cause::locate_io(unavailable(), crate::refusal_cause::Caused::cause(&error)))).map_err(std::io::Error::from))?;
    if current.account_id != grant.route.account_id || current.device_id != grant.route.device_id
        || current.revision > 9_007_199_254_740_991 || current.revoked
    { return crate::io_operation!(Err(unavailable())); }
    if current.resource_address.as_deref() == Some(grant.route.resource_address.as_str())
        && current.route_generation.as_deref() == Some(grant.route.generation.as_str())
        && current.expires_at_ms == Some(grant.expires_at_ms)
        && current.token_digest.as_deref() == Some(digest.as_str())
    { return if local_current() { Ok(()) } else { crate::io_operation!(Err(unavailable())) }; }

    url.set_path("/devices/resource-connections");
    // Borrow directly into the erased request buffer rather than creating an
    // intermediate JSON Value that owns another plaintext token.
    let body = Zeroizing::new(crate::io_operation!((serde_json::to_vec(&Publication {
        token: trc,
        resource_address: &grant.route.resource_address,
        route_generation: &grant.route.generation,
        expected_revision: current.revision,
        expires_at_ms: grant.expires_at_ms,
    }).map_err(|error| crate::refusal_cause::locate_io(unavailable(), crate::refusal_cause::Caused::cause(&error)))).map_err(std::io::Error::from))?);
    if !local_current() { return crate::io_operation!(Err(unavailable())); }
    let published_bytes = Zeroizing::new(crate::io_operation!((post(
        &url, tc, &body, MAX_REPLY_BYTES, deadline, local_current,
    ).map_err(|error| crate::refusal_cause::locate_io(unavailable(), crate::refusal_cause::Caused::cause(&error)))).map_err(std::io::Error::from))?);
    if !local_current() { return crate::io_operation!(Err(unavailable())); }
    let published: Published = crate::io_operation!((serde_json::from_slice(&published_bytes).map_err(|error| crate::refusal_cause::locate_io(unavailable(), crate::refusal_cause::Caused::cause(&error)))).map_err(std::io::Error::from))?;
    if published.account_id != grant.route.account_id
        || published.device_id != grant.route.device_id
        || published.resource_address != grant.route.resource_address
        || published.route_generation != grant.route.generation
        || published.expires_at_ms != grant.expires_at_ms
        || published.token_digest != digest
        || published.revision != current.revision + 1
    { return crate::io_operation!(Err(unavailable())); }
    if !local_current() { return crate::io_operation!(Err(unavailable())); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::atomic::{AtomicBool, Ordering}, time::Duration};

    const TC: &str = "tc_synthetic-publication-only";
    const TRC: &str = "trc_synthetic-publication-only";

    fn grant() -> ConnectionGrant {
        ConnectionGrant {
            route: crate::resource_authority::Route {
                account_id: "a".repeat(64), device_id: "d".repeat(64),
                resource_address: "@own-records".into(),
                generation: format!("connection:{}", "e".repeat(64)),
            },
            expires_at_ms: 123_456, admission_identity: None,
        }
    }

    fn current_reply(grant: &ConnectionGrant, matching: bool) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "account_id": grant.route.account_id,
            "device_id": grant.route.device_id,
            "revision": 7,
            "revoked": false,
            "resource_address": matching.then_some(grant.route.resource_address.as_str()),
            "route_generation": matching.then_some(grant.route.generation.as_str()),
            "expires_at_ms": matching.then_some(grant.expires_at_ms),
            "token_digest": matching.then(|| blake3::hash(TRC.as_bytes()).to_hex().to_string()),
        })).unwrap()
    }

    #[test]
    fn withdrawal_during_current_lookup_prevents_publication_post() {
        let grant = grant();
        let live = AtomicBool::new(true);
        let current = || live.load(Ordering::Acquire);
        let mut calls = Vec::new();
        let result = publish_to_endpoint(
            Url::parse("https://synthetic.example").unwrap(), TC, TRC, &grant,
            Instant::now() + Duration::from_secs(1), &current,
            |url, bearer, body, _, _, check| {
                calls.push(url.path().to_owned());
                assert!(check());
                assert_eq!(bearer, TC);
                assert_eq!(body, b"{}");
                assert_eq!(url.path(), "/devices/resource-connections/current");
                live.store(false, Ordering::Release);
                Ok(current_reply(&grant, false))
            },
        );
        assert!(result.is_err());
        assert_eq!(calls, ["/devices/resource-connections/current"]);
    }

    #[test]
    fn exact_remote_slot_is_reused_without_mutation() {
        let grant = grant();
        let mut calls = 0;
        publish_to_endpoint(
            Url::parse("https://synthetic.example").unwrap(), TC, TRC, &grant,
            Instant::now() + Duration::from_secs(1), &|| true,
            |url, bearer, body, max, _, check| {
                calls += 1;
                assert!(check());
                assert_eq!(bearer, TC);
                assert_eq!(body, b"{}");
                assert_eq!(max, MAX_REPLY_BYTES);
                assert_eq!(url.path(), "/devices/resource-connections/current");
                Ok(current_reply(&grant, true))
            },
        ).unwrap();
        assert_eq!(calls, 1);
    }

    #[test]
    fn publication_preserves_exact_grant_and_worker_revision() {
        let grant = grant();
        let mut calls = 0;
        publish_to_endpoint(
            Url::parse("https://synthetic.example").unwrap(), TC, TRC, &grant,
            Instant::now() + Duration::from_secs(1), &|| true,
            |url, bearer, body, _, _, check| {
                calls += 1;
                assert!(check());
                assert_eq!(bearer, TC);
                if calls == 1 {
                    assert_eq!(url.path(), "/devices/resource-connections/current");
                    return Ok(current_reply(&grant, false));
                }
                assert_eq!(calls, 2);
                assert_eq!(url.path(), "/devices/resource-connections");
                assert_eq!(serde_json::from_slice::<serde_json::Value>(body).unwrap(),
                    serde_json::json!({
                        "token": TRC,
                        "resource_address": grant.route.resource_address,
                        "route_generation": grant.route.generation,
                        "expected_revision": 7,
                        "expires_at_ms": grant.expires_at_ms,
                    }));
                Ok(serde_json::to_vec(&serde_json::json!({
                    "account_id": grant.route.account_id,
                    "device_id": grant.route.device_id,
                    "resource_address": grant.route.resource_address,
                    "route_generation": grant.route.generation,
                    "revision": 8,
                    "expires_at_ms": grant.expires_at_ms,
                    "token_digest": blake3::hash(TRC.as_bytes()).to_hex().to_string(),
                })).unwrap())
            },
        ).unwrap();
        assert_eq!(calls, 2);
    }
}
