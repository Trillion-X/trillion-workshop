// src/forwarder.rs
//
// Purpose: Route authenticated MCP operations through supplied current-route, proof-issuer and computer-connection owners.
//
// Non-Negotiable Invariants:
// - Missing directory, proof authority or connection must refuse the operation.
// - Bind proof, route generation, scope, deadline and original request key to the same invocation.
// - The Mac resource independently verifies current rights at its physical commitment boundary.
//
// Key Concepts:
// - RouteDirectory, ClientProofIssuer and ComputerConnections supplies.
// - Scoped invocation messages and bounded device replies.
//
// Security Considerations:
// - Public routing does not create client or device authority.
// - Preserve uncertain-effect semantics when connection delivery or response is unknown.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! Public MCP to Mac-resource routing. Authentication supplies `Principal`;
//! the directory, proof issuer and connection are separate trusted owners.
//! An absent owner refuses the call. The Mac must independently verify the
//! issued proof and its current rights inside the physical transaction.
use crate::{
    mcp::{Operation, OperationFailure, Principal, CallAnswerer},
    resource_authority::{decode_message, InvokeMessage, Route},
};
use content_crypto::advanced::blake3;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::{Zeroize, Zeroizing};

pub(crate) mod answers;
pub mod gateway;
pub mod ingress;
pub mod origins;
pub mod origin_dns;
pub mod connected_computers;
pub mod session;
pub mod tls;
pub mod remote_connection_check;
pub mod websocket;

const DEADLINE_WINDOW_MS: i64 = 30_000;
/// The refusal code of a message whose deadline passed before it was sent or
/// dispatched: the operation never started, so its outcome is known.
pub(crate) const DEADLINE_ELAPSED: &str = "resource_deadline_elapsed";
/// The refusal code of an operation with no live route: none is chosen, or the
/// chosen session no longer stands when its message would leave. Never started.
pub(crate) const ROUTE_UNAVAILABLE: &str = "resource_route_unavailable";
/// The most bytes of one computer's answer: answers keep their 64 KiB bound and page. A request is bounded by the
/// the account's routes's one request limit instead (`crate::mcp::carried_message_bytes`).
const MAX_REPLY_BYTES: usize = 65_536;

pub trait RouteDirectory: Send + Sync {
    /// The route this account's resource is answered on now: a live computer that the account's signed placement rows
    /// allow to answer. `None` when there is none, so the operation is refused before it is sent.
    fn current_route(&self, account_id: &str, resource_address: &str) -> Option<Route>;
}

pub trait ClientProofIssuer: Send + Sync {
    /// Issue a locally verifiable proof for the original authenticated
    /// `principal.sign_in` and exact message. `client_id` is display metadata;
    /// the device must check current sign-in rights again at commitment.
    fn issue(&self, principal: &Principal, message: &InvokeMessage) -> Option<String>;

    /// The same credential authenticated this HTTP request. Existing proof
    /// issuers keep their original behavior; a credential-forwarding supply
    /// must explicitly opt in and the resource still verifies current rights.
    fn issue_with_bearer(&self, principal: &Principal, _bearer: &[u8], message: &InvokeMessage) -> Option<String> {
        self.issue(principal, message)
    }
}

pub trait ComputerConnections: Send + Sync {
    /// The connection transports bytes; it does not establish client authority.
    fn invoke(&self, route: &Route, message: &[u8]) -> Result<Vec<u8>, crate::refusal_cause::CodedError<()>>;
}

/// A computer's answer to one message the forwarder sent it, read on the wire. It is read by the rule every wire shape
/// follows: a field a release may leave out defaults, an unknown field is ignored (a newer computer may add one), and a
/// cause that is not a valid cause word is no cause (the answer still reads). A computer of any release that still
/// runs must have its answers read here (`reply_shape` names what a reply that does not read has).
#[derive(Deserialize, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum DeviceReply {
    Completed { request_id: String, value: Value },
    Refused {
        request_id: String,
        code: String,
        #[serde(default = "absent_cause", deserialize_with = "lenient_cause")]
        cause: crate::refusal_cause::ReportedCause,
    },
    /// The device returned a correlated answer without claiming that its
    /// original operation did not commit. No protected value is released.
    OutcomeUnknown {
        request_id: String,
        #[serde(default = "absent_cause", deserialize_with = "lenient_cause")]
        cause: crate::refusal_cause::ReportedCause,
    },
}

/// A cause on the wire, when it is a valid cause word (`ReportedCause::from_wire`). Anything else is the reader's own cause
/// (`absent_cause`): the answer still reads, and it says that its cause was not a cause word.
fn lenient_cause<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<crate::refusal_cause::ReportedCause, D::Error> {
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(value.as_ref().and_then(Value::as_str).and_then(crate::refusal_cause::ReportedCause::from_wire).unwrap_or_else(absent_cause))
}

/// The cause of a reply that carries none (a computer before `954c1e2e7`), or whose cause is not a cause word.
fn absent_cause() -> crate::refusal_cause::ReportedCause {
    crate::cause!(condition: reply_cause_absent)
}

/// What a reply that `DeviceReply` does not read has, for the log: its state word and its top-level field names, and the
/// field the reader stopped at. Never a value.
pub(crate) fn reply_shape(bytes: &[u8]) -> String {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else { return "not-json".to_owned() };
    let Some(object) = value.as_object() else { return "not-object".to_owned() };
    let mut keys: Vec<String> = object.keys().take(16).cloned().collect();
    keys.sort_unstable();
    let state = object.get("state").and_then(Value::as_str).filter(|state| shape_word(state)).unwrap_or("other").to_owned();
    let reason = match serde_json::from_value::<DeviceReply>(value) {
        Ok(_) => "read".to_owned(),
        Err(error) => reader_stop(&error.to_string()),
    };
    format!("state={state} keys={} reason={reason}", keys.join(","))
}

/// A state or field word for the log: short, lower-case ascii letters and `_` only.
fn shape_word(word: &str) -> bool {
    word.len() <= 32 && word.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'_')
}

/// The field a reader error names (`missing field `x``), as a word; `invalid` when the error names none.
fn reader_stop(message: &str) -> String {
    for kind in ["missing field", "unknown field"] {
        let Some(at) = message.find(kind) else { continue };
        let rest = message[at + kind.len()..].trim_start();
        if let Some(name) = rest.strip_prefix('`').and_then(|rest| rest.split('`').next()) {
            if shape_word(name) {
                return format!("{}:{name}", kind.replace(' ', "-"));
            }
        }
    }
    "invalid".to_owned()
}

pub struct McpForwarder<'a> {
    pub directory: &'a dyn RouteDirectory,
    pub issuer: &'a dyn ClientProofIssuer,
    pub connections: &'a dyn ComputerConnections,
    /// Provided by the trusted server clock, in Unix milliseconds.
    pub now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
}

fn refused(code: &str, cause: impl Into<crate::refusal_cause::ReportedCause>) -> OperationFailure {
    OperationFailure { cause: cause.into(),
        code: code.into(),
        outcome_unknown: false,
        detail: None,
    }
}

fn unknown(cause: impl Into<crate::refusal_cause::ReportedCause>) -> OperationFailure {
    OperationFailure { cause: cause.into(),
        code: "resource_outcome_unknown".into(),
        outcome_unknown: true,
        detail: None,
    }
}

/// Route one exact operation and obtain its proof while the route and message
/// are fixed. The selected-account receiver can retain its key witness inside
/// `issue`; ordinary routing uses the same transport and uncertainty rules.
pub(crate) fn invoke_with_admission(
    directory: &dyn RouteDirectory,
    connections: &dyn ComputerConnections,
    now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
    principal: &Principal,
    call: Operation,
    issue: impl FnMut(&Route, &InvokeMessage) -> Result<Option<String>, OperationFailure>,
) -> Result<Value, OperationFailure> {
    if !principal.valid() {
        return Err(refused("client_authority_unavailable", crate::cause!()));
    }
    let owning_resource = crate::resource_authority::operation_reach::route_resource(&call.resource, &call.operation);
    let route = directory
        .current_route(&principal.account_id, owning_resource)
        .ok_or_else(|| refused(ROUTE_UNAVAILABLE, crate::cause!()))?;
    if route.account_id != principal.account_id || route.resource_address != owning_resource {
        return Err(refused("resource_route_changed", crate::cause!()));
    }
    send_on_route(directory, connections, now_ms, &route, &principal.sign_in, call, issue)
}

/// Send one exact operation on `route` and read its device reply. `sign_in` names the request's caller in its
/// identity (`request_id`); the proof `issue` gives travels only inside the message.
pub(crate) fn send_on_route(
    directory: &dyn RouteDirectory,
    connections: &dyn ComputerConnections,
    now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
    route: &Route,
    sign_in: &str,
    call: Operation,
    mut issue: impl FnMut(&Route, &InvokeMessage) -> Result<Option<String>, OperationFailure>,
) -> Result<Value, OperationFailure> {
    let route = route.clone();
    let started_at_ms = now_ms.now_ms();
    let deadline_at_ms = started_at_ms
        .checked_add(DEADLINE_WINDOW_MS)
        .ok_or_else(|| refused("invalid_server_time", crate::cause!()))?;
    let identity = serde_json::to_vec(&(
        "public-resource-request-v2",
        &route.account_id,
        sign_in,
        &call.resource,
        &call.operation,
        &call.request_key,
        &call.input,
    ))
    .map_err(|_| refused("invalid_resource_request", crate::cause!()))?;
    let request_id = format!("req:{}", blake3::hash(&identity).to_hex());
    let mut message = InvokeMessage {
        request_id: request_id.clone(),
        account_id: route.account_id.clone(),
        device_id: route.device_id.clone(),
        resource_address: route.resource_address.clone(),
        operation_resource: (call.resource != route.resource_address).then_some(call.resource),
        generation: route.generation.clone(),
        operation: call.operation,
        input: call.input,
        request_key: call.request_key,
        person_present: call.person_present,
        client_authorization: String::new(),
        deadline_at_ms,
    };
    message.client_authorization = issue(&route, &message)?
        .filter(|proof| !proof.is_empty() && proof.len() <= 8_192)
        .ok_or_else(|| refused("client_authority_unavailable", crate::cause!()))?;
    let bytes = Zeroizing::new(serde_json::to_vec(&message).map_err(|_| refused("invalid_resource_request", crate::cause!()))?);
    message.client_authorization.zeroize();
    // One invoke message carries one account request (src/mcp/settings.json `request_bytes`, 1 MiB of records plus the
    // call) inside its envelope: the same bound the computer reads it with (`resource_authority::decode_message`).
    if bytes.len() > crate::mcp::carried_message_bytes() {
        return Err(refused("resource_request_exceeds_limit", crate::cause!()));
    }
    let mut checked = decode_message(&bytes).map_err(|_| refused("invalid_resource_request", crate::cause!()))?;
    checked.client_authorization.zeroize();
    // Proof callbacks may wait for the selected account or signing owner.
    // Recheck both deadline and route at the physical send boundary, so an
    // expired proof is never sent and stale generation/device bytes cannot
    // follow a concurrent route replacement.
    if directory
        .current_route(&route.account_id, &route.resource_address)
        .as_ref()
        != Some(&route)
    {
        return Err(refused("resource_route_changed", crate::cause!()));
    }
    if now_ms.now_ms() >= deadline_at_ms {
        return Err(refused(DEADLINE_ELAPSED, crate::cause!()));
    }
    let reply = connections.invoke(&route, &bytes).map_err(|error| unknown(error.cause()))?;
    if now_ms.now_ms() >= deadline_at_ms || reply.len() > MAX_REPLY_BYTES {
        return Err(unknown(crate::cause!()));
    }
    match serde_json::from_slice::<DeviceReply>(&reply).map_err(|_| unknown(crate::cause!(condition: invalid_or_missing_device_reply_cause)))? {
        DeviceReply::Completed {
            request_id: id,
            value,
        } if id == request_id => Ok(value),
        DeviceReply::OutcomeUnknown { request_id: id, cause } if id == request_id => Err(unknown(cause)),
        DeviceReply::Refused {
            request_id: id,
            code,
            cause,
        } if id == request_id => {
            if code.is_empty()
                || code.len() > 160
                || !code
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            {
                return Err(unknown(crate::cause!()));
            }
            Err(refused(&code, cause))
        }
        _ => Err(unknown(crate::cause!())),
    }
}

impl CallAnswerer for McpForwarder<'_> {
    fn invoke_with_bearer(&self, principal: &Principal, bearer: &[u8], call: Operation) -> Result<Value, OperationFailure> {
        invoke_with_admission(
            self.directory, self.connections, self.now_ms.clone(), principal, call,
            |_, message| Ok(self.issuer.issue_with_bearer(principal, bearer, message)),
        )
    }

    fn invoke(&self, principal: &Principal, call: Operation) -> Result<Value, OperationFailure> {
        invoke_with_admission(
            self.directory,
            self.connections,
            self.now_ms.clone(),
            principal,
            call,
            |_, message| Ok(self.issuer.issue(principal, message)),
        )
    }
}

#[cfg(test)]
mod selected_admission_tests {
    use super::*;
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicI64, AtomicUsize, Ordering},
        Mutex,
    };

    static TEST_NOW_MS: AtomicI64 = AtomicI64::new(1);
    static TEST_NOW_LOCK: Mutex<()> = Mutex::new(());

    fn test_now_ms() -> i64 {
        TEST_NOW_MS.load(Ordering::SeqCst)
    }

    struct TestNow;
    impl crate::storage::time_source::Clock for TestNow {
        fn now_ms(&self) -> i64 {
            test_now_ms()
        }
    }

    struct Directory(Mutex<Route>);
    impl RouteDirectory for Directory {
        fn current_route(&self, _: &str, _: &str) -> Option<Route> {
            Some(self.0.lock().unwrap().clone())
        }
    }

    struct Connections(AtomicUsize);
    impl ComputerConnections for Connections {
        fn invoke(&self, _: &Route, bytes: &[u8]) -> Result<Vec<u8>, crate::refusal_cause::CodedError<()>> {
            self.0.fetch_add(1, Ordering::SeqCst);
            let message: InvokeMessage = serde_json::from_slice(bytes).map_err(|_| crate::refusal_cause::CodedError::new(()))?;
            serde_json::to_vec(&json!({
                "state":"completed","request_id":message.request_id,"value":{}
            }))
            .map_err(|_| crate::refusal_cause::CodedError::new(()))
        }
    }

    fn route(generation: &str) -> Route {
        Route {
            account_id: "account:one".into(),
            device_id: "device:one".into(),
            resource_address: "@own-records".into(),
            generation: generation.into(),
        }
    }

    fn principal() -> Principal {
        Principal { kind: crate::mcp::PrincipalKind::Person,
            account_id: "account:one".into(),
            sign_in: "key:one".into(),
            client_id: String::new(),
        }
    }

    fn call() -> Operation {
        Operation { person_present: None,
            resource: "@own-records".into(),
            operation: "record.read".into(),
            request_key: "request:one".into(),
            input: json!({}),
        }
    }

    #[test]
    fn route_generation_change_during_proof_issuance_prevents_connection_send() {
        let directory = Directory(Mutex::new(route("generation:one")));
        let connections = Connections(AtomicUsize::new(0));
        let result = invoke_with_admission(
            &directory,
            &connections,
            crate::storage::time_source::fixed(1),
            &principal(),
            call(),
            |_, _| {
                *directory.0.lock().unwrap() = route("generation:two");
                Ok(Some("current-proof".into()))
            },
        );
        assert_eq!(result.unwrap_err().code, "resource_route_changed");
        assert_eq!(connections.0.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn expired_proof_is_not_sent_to_the_connection() {
        let _guard = TEST_NOW_LOCK.lock().unwrap();
        TEST_NOW_MS.store(1, Ordering::SeqCst);
        let directory = Directory(Mutex::new(route("generation:one")));
        let connections = Connections(AtomicUsize::new(0));
        let result = invoke_with_admission(
            &directory,
            &connections,
            std::sync::Arc::new(TestNow),
            &principal(),
            call(),
            |_, _| {
                TEST_NOW_MS.store(30_001, Ordering::SeqCst);
                Ok(Some("current-proof".into()))
            },
        );
        let failure = result.unwrap_err();
        assert_eq!(failure.code, "resource_deadline_elapsed");
        assert!(!failure.outcome_unknown);
        assert_eq!(connections.0.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn correlated_unknown_reply_keeps_original_request_without_automatic_retry() {
        struct Replies(Mutex<Vec<String>>, crate::refusal_cause::Cause);
        impl ComputerConnections for Replies {
            fn invoke(&self, _: &Route, bytes: &[u8]) -> Result<Vec<u8>, crate::refusal_cause::CodedError<()>> {
                let message = decode_message(bytes).map_err(|error| crate::refusal_cause::CodedError::with_cause((), error.cause()))?;
                let mut keys = self.0.lock().map_err(|_| crate::refusal_cause::CodedError::new(()))?;
                keys.push(message.request_key);
                let reply = if keys.len() == 1 {
                    DeviceReply::OutcomeUnknown { cause: self.1.clone().into(), request_id: message.request_id }
                } else {
                    DeviceReply::Completed { request_id: message.request_id, value: json!({"current":true}) }
                };
                serde_json::to_vec(&reply).map_err(|_| crate::refusal_cause::CodedError::new(()))
            }
        }
        let directory = Directory(Mutex::new(route("generation:one")));
        let connections = Replies(Mutex::new(Vec::new()), crate::cause!());
        let first = invoke_with_admission(&directory, &connections, crate::storage::time_source::fixed(1), &principal(), call(),
            |_, _| Ok(Some("current-proof".into()))).unwrap_err();
        assert_eq!(first.code, "resource_outcome_unknown");
        assert!(first.outcome_unknown, "a correlated unknown answer must never imply no effect");
        assert_eq!(first.cause.id(), connections.1.id(), "JSON transport keeps the source that produced the uncertainty");
        assert_eq!(*connections.0.lock().unwrap(), vec!["request:one"]);
        let mut next = call();
        next.request_key = "request:two".into();
        let second = invoke_with_admission(&directory, &connections, crate::storage::time_source::fixed(1), &principal(), next,
            |_, _| Ok(Some("current-proof".into()))).unwrap();
        assert_eq!(second, json!({"current":true}));
        assert_eq!(*connections.0.lock().unwrap(), vec!["request:one", "request:two"]);
    }

    #[test]
    fn unknown_reply_cannot_release_values_or_ignore_request_correlation() {
        struct Reply(bool);
        impl ComputerConnections for Reply {
            fn invoke(&self, _: &Route, bytes: &[u8]) -> Result<Vec<u8>, crate::refusal_cause::CodedError<()>> {
                let message = decode_message(bytes).map_err(|error| crate::refusal_cause::CodedError::with_cause((), error.cause()))?;
                let reply = if self.0 {
                    json!({"state":"outcome_unknown","request_id":message.request_id,"value":"protected"})
                } else {
                    json!({"state":"outcome_unknown","request_id":"different-request"})
                };
                serde_json::to_vec(&reply).map_err(|_| crate::refusal_cause::CodedError::new(()))
            }
        }
        let directory = Directory(Mutex::new(route("generation:one")));
        for extra_value in [true, false] {
            let failure = invoke_with_admission(&directory, &Reply(extra_value), crate::storage::time_source::fixed(1),
                &principal(), call(), |_, _| Ok(Some("current-proof".into()))).unwrap_err();
            assert_eq!(failure.code, "resource_outcome_unknown");
            assert!(failure.outcome_unknown);
        }
    }

    /// A call through the forwarder carries a write as large as the account's routes takes (src/mcp/settings.json `request_bytes`):
    /// 44 KB, 200 KB and 512 KB of records reach the computer whole; one message past the carried bound is refused
    /// before anything is sent.
    #[test]
    fn a_write_as_large_as_the_door_takes_reaches_the_computer() {
        struct Sizes(Mutex<Vec<usize>>);
        impl ComputerConnections for Sizes {
            fn invoke(&self, _: &Route, bytes: &[u8]) -> Result<Vec<u8>, crate::refusal_cause::CodedError<()>> {
                let message = decode_message(bytes).map_err(|error| crate::refusal_cause::CodedError::with_cause((), error.cause()))?;
                self.0.lock().map_err(|_| crate::refusal_cause::CodedError::new(()))?.push(bytes.len());
                serde_json::to_vec(&DeviceReply::Completed { request_id: message.request_id, value: json!({"written":true}) })
                    .map_err(|_| crate::refusal_cause::CodedError::new(()))
            }
        }
        let directory = Directory(Mutex::new(route("generation:one")));
        let connections = Sizes(Mutex::new(Vec::new()));
        let write = |bytes: usize| Operation { person_present: None,
            resource: "@own-records".into(),
            operation: "records.write".into(),
            request_key: format!("request:{bytes}"),
            input: json!({"records":[{"kind":"note","value":{"text":"x".repeat(bytes)}}]}),
        };
        for bytes in [44_000, 200_000, 512 * 1024] {
            let answer = invoke_with_admission(&directory, &connections, crate::storage::time_source::fixed(1), &principal(), write(bytes),
                |_, _| Ok(Some("current-proof".into())));
            assert_eq!(answer.unwrap(), json!({"written":true}), "{bytes} bytes");
        }
        let sent = connections.0.lock().unwrap().clone();
        assert_eq!(sent.len(), 3);
        assert!(sent[2] > 512 * 1024 && sent[2] <= crate::mcp::carried_message_bytes(), "{sent:?}");
        let past = invoke_with_admission(&directory, &connections, crate::storage::time_source::fixed(1), &principal(),
            write(crate::mcp::carried_message_bytes()), |_, _| Ok(Some("current-proof".into())));
        assert_eq!(past.unwrap_err().code, "resource_request_exceeds_limit");
        assert_eq!(connections.0.lock().unwrap().len(), 3, "nothing past the bound is sent");
    }


    #[test]
    fn correlated_refusal_keeps_the_public_code_and_the_computers_source_cause() {
        struct Refusing(crate::refusal_cause::Cause);
        impl ComputerConnections for Refusing {
            fn invoke(&self, _: &Route, bytes: &[u8]) -> Result<Vec<u8>, crate::refusal_cause::CodedError<()>> {
                let message = decode_message(bytes).map_err(|error| crate::refusal_cause::CodedError::with_cause((), error.cause()))?;
                serde_json::to_vec(&DeviceReply::Refused {
                    request_id: message.request_id,
                    code: "current_workspace_rights_refused".into(),
                    cause: self.0.clone().into(),
                }).map_err(|_| crate::refusal_cause::CodedError::new(()))
            }
        }
        let source = crate::cause!(condition: synthetic_computer_current_rights_withdrawn);
        let connections = Refusing(source.clone());
        let directory = Directory(Mutex::new(route("generation:one")));
        let failure = invoke_with_admission(&directory, &connections, crate::storage::time_source::fixed(1), &principal(), call(),
            |_, _| Ok(Some("current-proof".into()))).unwrap_err();
        assert_eq!(failure.code, "current_workspace_rights_refused");
        assert!(!failure.outcome_unknown);
        assert_eq!(failure.cause.id(), source.id());
        assert!(failure.log_line().contains(&source.id()));
    }


    #[test]
    fn transport_failure_keeps_its_original_source_through_the_forwarder() {
        struct Failed(crate::refusal_cause::Cause);
        impl ComputerConnections for Failed {
            fn invoke(&self, _: &Route, _: &[u8]) -> Result<Vec<u8>, crate::refusal_cause::CodedError<()>> {
                Err(crate::refusal_cause::CodedError::with_cause((), self.0.clone()))
            }
        }
        let source = crate::cause!(condition: synthetic_connection_answer_lost);
        let connections = Failed(source.clone());
        let directory = Directory(Mutex::new(route("generation:one")));
        let failure = invoke_with_admission(&directory, &connections, crate::storage::time_source::fixed(1), &principal(), call(),
            |_, _| Ok(Some("current-proof".into()))).unwrap_err();
        assert_eq!(failure.code, "resource_outcome_unknown");
        assert!(failure.outcome_unknown);
        assert_eq!(failure.cause.id(), source.id());
    }

}

/// The injected lease clock and scheduler.
pub mod lease_time;

#[cfg(test)]
mod reply_wire_tests {
    //! The replies computers of each release that still runs write, as their own code writes them: the shapes before
    //! `954c1e2e7` (no cause), the shape of `b88b88f4` (a cause word), and a newer computer's extra field. Synthetic
    //! ids only. Each must read, and a reply that does not read says why, with no value in the words.
    use super::*;

    const CAUSE: &str = "trillion_local::native_entry::computer@src/native_entry/computer.rs:2957:86:refusal#b88b88f40130d1a9c5b13b9d8ae691d98d8730a5";

    fn read(json: &str) -> Result<DeviceReply, serde_json::Error> {
        serde_json::from_str(json)
    }

    #[test]
    fn the_replies_of_every_release_that_still_runs_read() {
        let completed = r#"{"state":"completed","request_id":"req-synthetic-completed","value":{"written":true}}"#;
        assert!(matches!(read(completed), Ok(DeviceReply::Completed { .. })));
        // Before 954c1e2e7: no cause on refused or outcome_unknown.
        let refused_before_cause = r#"{"state":"refused","request_id":"req-synthetic-refused","code":"not_writer"}"#;
        assert!(matches!(read(refused_before_cause), Ok(DeviceReply::Refused { .. })));
        let unknown_before_cause = r#"{"state":"outcome_unknown","request_id":"req-synthetic-unknown"}"#;
        assert!(matches!(read(unknown_before_cause), Ok(DeviceReply::OutcomeUnknown { .. })));
        // b88b88f4: a cause word.
        let refused_with_cause = format!(r#"{{"state":"refused","request_id":"req-synthetic-refused","code":"not_writer","cause":"{CAUSE}"}}"#);
        assert!(matches!(read(&refused_with_cause), Ok(DeviceReply::Refused { .. })));
        let unknown_with_cause = format!(r#"{{"state":"outcome_unknown","request_id":"req-synthetic-unknown","cause":"{CAUSE}"}}"#);
        assert!(matches!(read(&unknown_with_cause), Ok(DeviceReply::OutcomeUnknown { .. })));
        // A newer computer's extra field is ignored.
        let newer = r#"{"state":"completed","request_id":"req-synthetic-completed","value":{},"added_later":1}"#;
        assert!(matches!(read(newer), Ok(DeviceReply::Completed { .. })));
    }

    #[test]
    fn a_cause_that_is_not_a_cause_word_is_the_readers_own_and_the_answer_still_reads() {
        let bad = r#"{"state":"refused","request_id":"req-synthetic-refused","code":"not_writer","cause":"caller@../x.rs:1:1:refusal"}"#;
        assert!(matches!(read(bad), Ok(DeviceReply::Refused { .. })));
        let not_text = r#"{"state":"refused","request_id":"req-synthetic-refused","code":"not_writer","cause":{"a":1}}"#;
        assert!(matches!(read(not_text), Ok(DeviceReply::Refused { .. })));
    }

    #[test]
    fn a_reply_that_does_not_read_says_which_field_stopped_it_and_no_value() {
        let missing_code = r#"{"state":"refused","request_id":"value-that-must-not-be-logged"}"#;
        let shape = reply_shape(missing_code.as_bytes());
        assert_eq!(shape, "state=refused keys=request_id,state reason=missing-field:code");
        assert!(!shape.contains("value-that-must-not-be-logged"));
        assert_eq!(reply_shape(b"not json"), "not-json");
        assert_eq!(reply_shape(b"[1]"), "not-object");
        let read = reply_shape(format!(r#"{{"state":"outcome_unknown","request_id":"r","cause":"{CAUSE}"}}"#).as_bytes());
        assert_eq!(read, "state=outcome_unknown keys=cause,request_id,state reason=read");
    }
}
