//! This computer's resource connection at the account's routes: the routes its own
//! outbound connection and the forwarder use to agree on the short
//! connection credential (`trc_`) this computer issued for itself.
//!
//! - `POST /devices/resource-connections/current` (and `GET /devices/resource-connections`):
//!   the computer key (`tc_`) asks for its current credential.
//! - `POST /devices/resource-connections`: the computer key acknowledges that the
//!   current credential is the one it publishes. Nothing is written: this computer issued
//!   and registered the credential locally before it publishes.
//! - `POST /devices/resource-connections/admit`: the forwarder presents the
//!   short credential a computer connected with and is told its route and expiry.
//!
//! The revision these routes speak is the current credential's revision. `current`
//! answers the revision the current credential is at; a publication names the revision it saw
//! (`expected_revision`) and is acknowledged only when the current credential is now exactly
//! the published credential at the next revision, so the publisher's check that the
//! acknowledged revision is one past the one it saw (`resource_connection_publication`)
//! and this one are the same rule. A current credential that is not the published
//! credential answers 409; it is never written here.
//!
//! The credential checks, the current credential, its registration and expiry are the
//! existing owners' (`local_account::connection_credential`,
//! `account_rights::resource_connection`); this file only reads bearers and
//! bodies and maps answers to HTTP. A refused credential is 401, an unavailable
//! source 503.

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use content_crypto::advanced::blake3;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// Largest body a device route reads, in bytes.
const MAX_BODY_BYTES: usize = 4096;
/// Longest bearer a device route reads.
const MAX_BEARER: usize = 8192;
/// The largest integer JSON carries exactly.
const MAX_SAFE: i64 = 9_007_199_254_740_991;

/// One current credential as the routes answer it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Slot {
    pub account_id: String,
    pub device_id: String,
    pub resource_address: String,
    pub route_generation: String,
    pub revision: u64,
    pub expires_at_ms: i64,
    pub token_digest: String,
}

impl Slot {
    fn json(&self) -> Value {
        json!({
            "account_id": self.account_id, "device_id": self.device_id, "resource_address": self.resource_address,
            "route_generation": self.route_generation, "revision": self.revision, "expires_at_ms": self.expires_at_ms,
            "token_digest": self.token_digest,
        })
    }
}

/// Why a device route refuses.
#[derive(Clone, Debug)]
pub(crate) enum Refusal {
    /// The credential is unknown, expired, withdrawn or not registered.
    Refused(crate::refusal_cause::Cause),
    /// The account's source did not answer.
    Unavailable(crate::refusal_cause::Cause),
}
impl Refusal {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Refused(cause) => cause.clone(),
            Self::Unavailable(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Refusal);

impl PartialEq for Refusal {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Refused(_), Self::Refused(_)) => true,
            (Self::Unavailable(_), Self::Unavailable(_)) => true,
            _ => false,
        }
    }
}
impl Eq for Refusal {}


/// The current credentials of one account, as the existing credential owners answer them.
pub(crate) trait Slots: Send + Sync {
    /// The current credential of the computer key `tc`, or `None` when it has none that is current.
    fn current(&self, tc: &[u8], now: i64) -> Result<Option<Slot>, Refusal>;
    /// The current credential the short credential `trc` stands on, when it is admitted now.
    fn admit(&self, trc: &[u8], now: i64) -> Result<Slot, Refusal>;
}

impl Slots for crate::native_boot::mcp_credential::SelectedCredentialAdmission {
    fn current(&self, tc: &[u8], now: i64) -> Result<Option<Slot>, Refusal> {
        use crate::account_rights::resource_connection::credential::Error;
        match self.recover_current(tc, now) {
            Ok(Some(issued)) => {
                let grant = issued.grant();
                Ok(Some(Slot {
                    account_id: grant.route.account_id.clone(), device_id: grant.route.device_id.clone(),
                    resource_address: grant.route.resource_address.clone(), route_generation: grant.route.generation.clone(),
                    revision: issued.revision(), expires_at_ms: grant.expires_at_ms,
                    token_digest: blake3::hash(issued.as_bytes()).to_hex().to_string(),
                }))
            }
            Ok(None) => Ok(None),
            Err(error @ (Error::Unavailable(_) | Error::Unknown(_))) => Err(Refusal::Unavailable(error.cause())),
            Err(error) => Err(Refusal::Refused(error.cause())),
        }
    }

    fn admit(&self, trc: &[u8], now: i64) -> Result<Slot, Refusal> {
        use crate::account_rights::resource_connection::credential::Error;
        let (grant, revision) = self.admit_with_revision(trc, now).map_err(|error| {
            let cause = error.cause();
            match error {
                Error::Unavailable(_) | Error::Unknown(_) => Refusal::Unavailable(cause),
                _ => Refusal::Refused(cause),
            }
        })?;
        Ok(Slot {
            account_id: grant.route.account_id, device_id: grant.route.device_id,
            resource_address: grant.route.resource_address, route_generation: grant.route.generation,
            revision, expires_at_ms: grant.expires_at_ms, token_digest: blake3::hash(trc).to_hex().to_string(),
        })
    }
}

struct Supplies {
    slots: Arc<dyn Slots>,
    now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
}

/// The device routes over `slots`.
pub(crate) fn routes(slots: Arc<dyn Slots>, now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>) -> Router {
    Router::new()
        .route("/devices/resource-connections", get(current).post(register))
        .route("/devices/resource-connections/current", post(current))
        .route("/devices/resource-connections/admit", post(admit))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(Arc::new(Supplies { slots, now_ms }))
}

/// The bearer of a device route: exactly `Bearer <token>` (one space, case as written), as the publisher and the
/// forwarder send it.
fn bearer(headers: &HeaderMap) -> Option<&str> {
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    let token = value.strip_prefix("Bearer ")?;
    (!token.is_empty() && token.len() <= MAX_BEARER && token.bytes().all(|b| b.is_ascii_graphic())).then_some(token)
}

#[track_caller]
fn answer(status: StatusCode, body: Value) -> Response {
    answer_with_cause(status, body, crate::cause!(caller_site: device response_refused))
}

fn answer_with_cause(status: StatusCode, mut body: Value, cause: crate::refusal_cause::Cause) -> Response {
    let failed = status.is_client_error() || status.is_server_error();
    if failed {
        body["cause"] = json!(cause.id());
        crate::quiet_eprintln!("device-refusal status={} cause={cause}", status.as_u16());
    }
    let mut response = (status, [(header::CACHE_CONTROL, "no-store"), (header::CONTENT_TYPE, "application/json")], body.to_string()).into_response();
    if failed {
        response.headers_mut().insert("x-trillion-refusal-cause", cause.id().parse().expect("validated source identity is a header value"));
    }
    response
}

fn refusal(refusal: Refusal) -> Response {
    let cause = refusal.cause();
    match refusal {
        Refusal::Refused(_) => answer_with_cause(StatusCode::UNAUTHORIZED, json!({"error": "resource_connection_refused"}), cause),
        Refusal::Unavailable(_) => answer_with_cause(StatusCode::SERVICE_UNAVAILABLE, json!({"error": "resource_connection_unavailable"}), cause),
    }
}

/// The current credential of the presented computer key, with `revoked` (always false: a revoked one is refused).
async fn current(State(supplies): State<Arc<Supplies>>, headers: HeaderMap) -> Response {
    let Some(tc) = bearer(&headers).map(str::to_owned) else { return refusal(crate::cause!(Refusal::Refused)) };
    let slots = supplies.slots.clone();
    let now = supplies.now_ms.now_ms();
    match tokio::task::spawn_blocking(move || slots.current(tc.as_bytes(), now)).await {
        Ok(Ok(Some(slot))) => {
            let mut body = slot.json();
            body["revoked"] = Value::Bool(false);
            answer(StatusCode::OK, body)
        }
        Ok(Ok(None)) => refusal(crate::cause!(Refusal::Refused)),
        Ok(Err(error)) => refusal(error),
        Err(error) => refusal(crate::carry_cause!(Refusal::Unavailable, error)),
    }
}

/// A publication: exactly these five fields.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Publication {
    token: String,
    resource_address: String,
    route_generation: String,
    expected_revision: i64,
    expires_at_ms: i64,
}

/// The acknowledgment of a publication the current credential already is (see the module doc for the revision rule).
async fn register(State(supplies): State<Arc<Supplies>>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(tc) = bearer(&headers).map(str::to_owned) else { return refusal(crate::cause!(Refusal::Refused)) };
    let Ok(publication) = serde_json::from_slice::<Publication>(&body) else {
        return answer(StatusCode::BAD_REQUEST, json!({"error": "invalid_registration"}));
    };
    if !publication.token.starts_with("trc_") || publication.token.len() > MAX_BEARER
        || !(0..MAX_SAFE).contains(&publication.expected_revision)
        || !(1..=MAX_SAFE).contains(&publication.expires_at_ms)
    {
        return answer(StatusCode::BAD_REQUEST, json!({"error": "invalid_registration"}));
    }
    let slots = supplies.slots.clone();
    let now = supplies.now_ms.now_ms();
    let slot = match tokio::task::spawn_blocking(move || slots.current(tc.as_bytes(), now)).await {
        Ok(Ok(Some(slot))) => slot,
        Ok(Ok(None)) => return refusal(crate::cause!(Refusal::Refused)),
        Ok(Err(error)) => return refusal(error),
        Err(error) => return refusal(crate::carry_cause!(Refusal::Unavailable, error)),
    };
    if acknowledges(&slot, &publication) {
        answer(StatusCode::OK, slot.json())
    } else {
        answer(StatusCode::CONFLICT, json!({"error": "registration_conflict"}))
    }
}

/// Whether `slot` holds exactly the published credential, one revision past the one the publisher saw.
fn acknowledges(slot: &Slot, publication: &Publication) -> bool {
    slot.resource_address == publication.resource_address
        && slot.route_generation == publication.route_generation
        && slot.expires_at_ms == publication.expires_at_ms
        && slot.token_digest == blake3::hash(publication.token.as_bytes()).to_hex().to_string()
        && u64::try_from(publication.expected_revision).ok().and_then(|seen| seen.checked_add(1)) == Some(slot.revision)
}

/// The current credential an admitted short credential stands on.
async fn admit(State(supplies): State<Arc<Supplies>>, headers: HeaderMap) -> Response {
    let Some(trc) = bearer(&headers).map(str::to_owned) else { return refusal(crate::cause!(Refusal::Refused)) };
    let slots = supplies.slots.clone();
    let now = supplies.now_ms.now_ms();
    match tokio::task::spawn_blocking(move || slots.admit(trc.as_bytes(), now)).await {
        Ok(Ok(slot)) => answer(StatusCode::OK, slot.json()),
        Ok(Err(error)) => refusal(error),
        Err(error) => refusal(crate::carry_cause!(Refusal::Unavailable, error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn registration_conditions_keep_distinct_private_causes_and_their_public_codes() {
        let app = routes(Fake::holding("trc_held", 8), crate::storage::time_source::fixed(now()));
        let malformed = call(&app, "POST", "/devices/resource-connections", Some(TC), "private invalid json").await;
        let invalid = call(&app, "POST", "/devices/resource-connections", Some(TC), &json!({
            "token":"private-token", "resource_address":"private-address", "route_generation":"private-generation",
            "expected_revision":7, "expires_at_ms":2000}).to_string()).await;
        let conflict = call(&app, "POST", "/devices/resource-connections", Some(TC), &json!({
            "token":"trc_private-token", "resource_address":"private-address", "route_generation":"private-generation",
            "expected_revision":7, "expires_at_ms":2000}).to_string()).await;
        assert_eq!(malformed.0, StatusCode::BAD_REQUEST);
        assert_eq!(invalid.0, StatusCode::BAD_REQUEST);
        assert_eq!(conflict.0, StatusCode::CONFLICT);
        assert_eq!(malformed.1["error"], "invalid_registration");
        assert_eq!(invalid.1["error"], "invalid_registration");
        assert_eq!(conflict.1["error"], "registration_conflict");
        let causes: std::collections::HashSet<_> = [&malformed.1, &invalid.1, &conflict.1].into_iter()
            .map(|body| crate::refusal_cause::Cause::from_wire(body["cause"].as_str().unwrap()).unwrap()).collect();
        assert_eq!(causes.len(), 3);
        assert!(causes.iter().all(|cause| cause.file() == file!() && !cause.id().contains("private")));
        let producer = crate::cause!(device_test original_slots_failure);
        let response = refusal(Refusal::Unavailable(producer.clone()));
        assert_eq!(response.headers()["x-trillion-refusal-cause"], producer.id());
        let body: Value = serde_json::from_slice(&axum::body::to_bytes(response.into_body(), 1 << 16).await.unwrap()).unwrap();
        assert_eq!(body["cause"], producer.id());
    }

    use axum::body::Body;
    use axum::http::Request;
    use std::sync::Mutex;
    use tower::ServiceExt;

    const TC: &str = "tc_0000000000000000000000000000000000000000000000000000000000000000";

    /// One account's current credential in memory: the computer key `TC` and the short credential it holds.
    struct Fake {
        slot: Mutex<Option<(Slot, String)>>,
        unavailable: bool,
    }

    impl Fake {
        fn holding(trc: &str, revision: u64) -> Arc<Self> {
            let slot = Slot {
                account_id: "a".repeat(64), device_id: blake3::hash(TC.as_bytes()).to_hex().to_string(),
                resource_address: "@own-records".into(), route_generation: format!("connection:{}", "c".repeat(64)),
                revision, expires_at_ms: 2_000, token_digest: blake3::hash(trc.as_bytes()).to_hex().to_string(),
            };
            Arc::new(Fake { slot: Mutex::new(Some((slot, trc.to_string()))), unavailable: false })
        }
    }

    impl Slots for Fake {
        fn current(&self, tc: &[u8], _now: i64) -> Result<Option<Slot>, Refusal> {
            if self.unavailable { return Err(crate::cause!(Refusal::Unavailable)); }
            if tc != TC.as_bytes() { return Err(crate::cause!(Refusal::Refused)); }
            Ok(self.slot.lock().unwrap().as_ref().map(|(slot, _)| slot.clone()))
        }
        fn admit(&self, trc: &[u8], _now: i64) -> Result<Slot, Refusal> {
            if self.unavailable { return Err(crate::cause!(Refusal::Unavailable)); }
            match self.slot.lock().unwrap().as_ref() {
                Some((slot, held)) if held.as_bytes() == trc => Ok(slot.clone()),
                _ => Err(crate::cause!(Refusal::Refused)),
            }
        }
    }

    fn now() -> i64 {
        1_000
    }

    async fn call(app: &Router, method: &str, path: &str, bearer: Option<&str>, body: &str) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(bearer) = bearer {
            request = request.header(header::AUTHORIZATION, format!("Bearer {bearer}"));
        }
        let response = app.clone().oneshot(request.body(Body::from(body.to_string())).unwrap()).await.unwrap();
        let status = response.status();
        assert_eq!(response.headers().get(header::CACHE_CONTROL).unwrap(), "no-store");
        let cause = response.headers().get("x-trillion-refusal-cause").map(|cause| cause.to_str().unwrap().to_owned());
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 16).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if status.is_client_error() || status.is_server_error() {
            assert_eq!(cause.as_deref(), body["cause"].as_str(), "failure body and header retain one origin");
            assert!(cause.as_deref().and_then(crate::refusal_cause::Cause::from_wire).is_some());
        }
        (status, body)
    }

    #[tokio::test]
    async fn the_computer_key_reads_its_current_slot_and_others_are_refused() {
        let app = routes(Fake::holding("trc_held", 7), crate::storage::time_source::fixed(now()));
        let (status, body) = call(&app, "POST", "/devices/resource-connections/current", Some(TC), "{}").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["revision"], 7);
        assert_eq!(body["revoked"], false);
        let (status, same) = call(&app, "GET", "/devices/resource-connections", Some(TC), "").await;
        assert_eq!((status, same), (StatusCode::OK, body));
        assert_eq!(call(&app, "POST", "/devices/resource-connections/current", None, "{}").await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(call(&app, "POST", "/devices/resource-connections/current", Some("tc_other"), "{}").await.0, StatusCode::UNAUTHORIZED);
        let empty = Arc::new(Fake { slot: Mutex::new(None), unavailable: false });
        assert_eq!(call(&routes(empty, crate::storage::time_source::fixed(now())), "POST", "/devices/resource-connections/current", Some(TC), "{}").await.0,
            StatusCode::UNAUTHORIZED, "no current slot is a refusal");
        let down = Arc::new(Fake { slot: Mutex::new(None), unavailable: true });
        assert_eq!(call(&routes(down, crate::storage::time_source::fixed(now())), "POST", "/devices/resource-connections/current", Some(TC), "{}").await.0,
            StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn admit_answers_exactly_the_seven_fields_the_forwarder_reads() {
        let app = routes(Fake::holding("trc_held", 3), crate::storage::time_source::fixed(now()));
        let (status, body) = call(&app, "POST", "/devices/resource-connections/admit", Some("trc_held"), "{}").await;
        assert_eq!(status, StatusCode::OK);
        let mut fields: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();
        fields.sort();
        assert_eq!(fields, ["account_id", "device_id", "expires_at_ms", "resource_address", "revision", "route_generation", "token_digest"]);
        assert_eq!(body["token_digest"], blake3::hash(b"trc_held").to_hex().to_string());
        assert_eq!(call(&app, "POST", "/devices/resource-connections/admit", Some("trc_other"), "{}").await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(call(&app, "POST", "/devices/resource-connections/admit", None, "{}").await.0, StatusCode::UNAUTHORIZED);
    }

    fn publication(token: &str, expected: u64, expires: i64) -> String {
        json!({"token": token, "resource_address": "@own-records", "route_generation": format!("connection:{}", "c".repeat(64)),
            "expected_revision": expected, "expires_at_ms": expires}).to_string()
    }

    #[tokio::test]
    async fn a_publication_is_acknowledged_only_when_the_slot_holds_it_one_revision_on() {
        let app = routes(Fake::holding("trc_held", 8), crate::storage::time_source::fixed(now()));
        let (status, body) = call(&app, "POST", "/devices/resource-connections", Some(TC), &publication("trc_held", 7, 2_000)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["revision"], 8);
        assert!(body.get("revoked").is_none());
        for (token, expected, expires) in [("trc_held", 8, 2_000), ("trc_held", 6, 2_000), ("trc_other", 7, 2_000), ("trc_held", 7, 2_001)] {
            assert_eq!(call(&app, "POST", "/devices/resource-connections", Some(TC), &publication(token, expected, expires)).await.0,
                StatusCode::CONFLICT, "{token} {expected} {expires}");
        }
        for bad in ["{}", "not json", &publication("not-trc", 7, 2_000),
            &json!({"token":"trc_held","resource_address":"@own-records","route_generation":"x","expected_revision":7,"expires_at_ms":2000,"extra":1}).to_string()] {
            assert_eq!(call(&app, "POST", "/devices/resource-connections", Some(TC), bad).await.0, StatusCode::BAD_REQUEST, "{bad}");
        }
        assert_eq!(call(&app, "POST", "/devices/resource-connections", None, &publication("trc_held", 7, 2_000)).await.0,
            StatusCode::UNAUTHORIZED);
    }

    /// This program's own publisher (`resource_connection_publication::publish_to_endpoint`) against these routes: a current credential
    /// that already holds the published credential is acknowledged by `current` alone; one that holds the next revision
    /// by the time the publication arrives is acknowledged by the registration; any other is refused, on both sides.
    #[test]
    fn the_hosts_publisher_and_these_routes_keep_one_revision_rule() {
        use crate::native_boot::mcp_selected_personal::resource_connection_publication::publish_to_endpoint;
        use crate::{forwarder::session::ConnectionGrant, https::AuthorityHttpFailure};
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let grant = |trc: &str| {
            let slot = Fake::holding(trc, 1).slot.lock().unwrap().clone().unwrap().0;
            ConnectionGrant {
                route: crate::resource_authority::Route {
                    account_id: slot.account_id, device_id: slot.device_id,
                    resource_address: slot.resource_address, generation: slot.route_generation,
                },
                expires_at_ms: slot.expires_at_ms,
                admission_identity: None,
            }
        };
        // `advance` moves the current credential to the published credential at the next revision between the two calls, as a
        // concurrent issue of the same account would.
        let publish = |fake: Arc<Fake>, trc: &str, advance: Option<(String, u64)>| {
            let app = routes(fake.clone(), crate::storage::time_source::fixed(now()));
            let mut calls = 0;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            publish_to_endpoint(url::Url::parse("https://door.test/").unwrap(), TC, trc, &grant(trc), deadline, &|| true,
                |url, bearer, body, _, _, _| {
                    calls += 1;
                    if calls == 2 {
                        if let Some((held, revision)) = &advance {
                            let replaced = Fake::holding(held, *revision);
                            *fake.slot.lock().unwrap() = replaced.slot.lock().unwrap().clone();
                        }
                    }
                    let body = String::from_utf8(body.to_vec()).unwrap();
                    let (status, answer) = runtime.block_on(call(&app, "POST", url.path(), Some(bearer), &body));
                    if status == StatusCode::OK { Ok(answer.to_string().into_bytes()) } else { Err(crate::cause!(AuthorityHttpFailure::Unavailable)) }
                })
        };
        assert!(publish(Fake::holding("trc_mac", 4), "trc_mac", None).is_ok(), "a slot holding the credential needs no registration");
        assert!(publish(Fake::holding("trc_older", 4), "trc_mac", Some(("trc_mac".into(), 5))).is_ok(),
            "a slot that reached the credential one revision on is acknowledged");
        assert!(publish(Fake::holding("trc_older", 4), "trc_mac", None).is_err(), "a slot that does not hold it is refused");
        assert!(publish(Fake::holding("trc_older", 4), "trc_mac", Some(("trc_mac".into(), 6))).is_err(),
            "a slot two revisions on is not the one the publisher saw");
    }

    #[test]
    fn the_bearer_is_exactly_one_bearer_header() {
        let mut headers = HeaderMap::new();
        assert_eq!(bearer(&headers), None);
        headers.insert(header::AUTHORIZATION, "Bearer tc_x".parse().unwrap());
        assert_eq!(bearer(&headers), Some("tc_x"));
        headers.insert(header::AUTHORIZATION, "bearer tc_x".parse().unwrap());
        assert_eq!(bearer(&headers), None);
        headers.insert(header::AUTHORIZATION, "Bearer  tc_x".parse().unwrap());
        assert_eq!(bearer(&headers), None);
        headers.insert(header::AUTHORIZATION, "Bearer tc_x".parse().unwrap());
        headers.append(header::AUTHORIZATION, "Bearer tc_y".parse().unwrap());
        assert_eq!(bearer(&headers), None);
    }
}
