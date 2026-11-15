// tests/forwarder.rs
//
// Purpose: Tests public resource routing from authenticated clients to Mac-owned device dispatch.
//
// Non-Negotiable Invariants:
// - Current route and client authority are checked before dispatch; late or lost replies remain unknown to preserve retry ownership.
//
// Key Concepts:
// - The forwarder resolves a current resource route and issues client-scoped proofs before device dispatch.
// - Lost or late replies remain unknown; route movement and client identity determine who may retry.
//
// Security Considerations:
// - All principals, routes, and proofs are fixtures; absent, mismatched, moved, or revoked authority fails closed.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde_json::{json, Value};
use content_crypto::advanced::blake3;
use std::sync::{
    atomic::{AtomicBool, AtomicI64, Ordering},
    Arc, Mutex,
};
use trillion_local::{
    mcp::{handle_message, Operation, Principal, CallAnswerer},
    forwarder::{ClientProofIssuer, ComputerConnections, RouteDirectory, McpForwarder},
    resource_authority::{
        admit, decode_message, ClientAuthority, CurrentClient, InvokeMessage, Route, Scope,
    },
};

fn now() -> i64 {
    1_000
}
/// A clock that reads `now_ms` at every call: the forwarder takes its time as a clock.
struct FixedClock(fn() -> i64);
impl trillion_local::storage::time_source::Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        (self.0)()
    }
}
fn clock_at(now_ms: fn() -> i64) -> std::sync::Arc<dyn trillion_local::storage::time_source::Clock> {
    std::sync::Arc::new(FixedClock(now_ms))
}
static LATE_REPLY_NOW: AtomicI64 = AtomicI64::new(1_000);
fn late_reply_now() -> i64 {
    LATE_REPLY_NOW.load(Ordering::SeqCst)
}
fn route() -> Route {
    Route {
        account_id: "account:one".into(),
        device_id: "device:one".into(),
        resource_address: "project:one".into(),
        generation: "generation:one".into(),
    }
}
struct Directory(Option<Route>);
impl RouteDirectory for Directory {
    fn current_route(&self, _: &str, _: &str) -> Option<Route> {
        self.0.clone()
    }
}
struct Issuer(bool);
impl ClientProofIssuer for Issuer {
    fn issue(&self, principal: &Principal, _: &InvokeMessage) -> Option<String> {
        self.0
            .then(|| format!("fixture-proof:{}", principal.sign_in))
    }
}
struct Authority(Arc<AtomicBool>);
struct Client {
    identity: String,
    scope: Scope,
    live: Arc<AtomicBool>,
}
impl CurrentClient for Client {
    fn identity(&self) -> &str {
        &self.identity
    }
    fn assert_current(&self, scope: &Scope) -> bool {
        self.scope == *scope && self.live.load(Ordering::SeqCst)
    }
}
impl ClientAuthority for Authority {
    fn admit(&self, proof: &str, scope: &Scope) -> Option<Box<dyn CurrentClient>> {
        Some(Box::new(Client {
            identity: proof.strip_prefix("fixture-proof:")?.into(),
            scope: scope.clone(),
            live: self.0.clone(),
        }))
    }
}
struct Connections {
    authority: Authority,
    seen: Mutex<Vec<(String, String)>>,
    lose_reply: bool,
}
impl ComputerConnections for Connections {
    fn invoke(&self, current_route: &Route, bytes: &[u8]) -> Result<Vec<u8>, trillion_local::refusal_cause::CodedError<()>> {
        let message = decode_message(bytes).map_err(|error| trillion_local::refusal_cause::CodedError::with_cause((), error.cause()))?;
        let admitted = admit(message, current_route, Some(&self.authority), now()).map_err(|error| trillion_local::refusal_cause::CodedError::with_cause((), error.cause()))?;
        admitted
            .assert_current(current_route, now())
            .map_err(|_| trillion_local::refusal_cause::CodedError::new(()))?;
        self.seen.lock().unwrap().push((
            admitted.client_identity().into(),
            admitted.owned_request_key().into(),
        ));
        if self.lose_reply {
            return Err(trillion_local::refusal_cause::CodedError::new(()));
        }
        Ok(
            json!({"state":"completed","request_id":admitted.request_id(),
            "value":{"resource":"project:one","revision":1}})
            .to_string()
            .into_bytes(),
        )
    }
}
struct LateReplyConnections {
    authority: Authority,
    refused: bool,
}
impl ComputerConnections for LateReplyConnections {
    fn invoke(&self, current_route: &Route, bytes: &[u8]) -> Result<Vec<u8>, trillion_local::refusal_cause::CodedError<()>> {
        let message = decode_message(bytes).map_err(|error| trillion_local::refusal_cause::CodedError::with_cause((), error.cause()))?;
        let admitted = admit(message, current_route, Some(&self.authority), now()).map_err(|error| trillion_local::refusal_cause::CodedError::with_cause((), error.cause()))?;
        admitted
            .assert_current(current_route, now())
            .map_err(|_| trillion_local::refusal_cause::CodedError::new(()))?;
        // The device produces its response after the forwarder's trusted deadline.
        LATE_REPLY_NOW.store(31_001, Ordering::SeqCst);
        let reply = if self.refused {
            json!({"state":"refused", "cause": trillion_local::cause!().id(),"request_id":admitted.request_id(),"code":"access_revoked"})
        } else {
            json!({"state":"completed","request_id":admitted.request_id(),"value":{"revision":1}})
        };
        Ok(reply.to_string().into_bytes())
    }
}
fn call(client: &str, forwarder: &McpForwarder<'_>) -> Value {
    let principal = Principal { kind: trillion_local::mcp::PrincipalKind::Person,
        account_id: "account:one".into(),
        sign_in: format!("grant:{}", client.replace(':', "-")),
        client_id: client.into(),
    };
    call_as(&principal, forwarder)
}
fn call_as(principal: &Principal, forwarder: &McpForwarder<'_>) -> Value {
    handle_message(
        br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run_resource_operation","arguments":{"resource":"project:one","operation":"read","request_key":"same-key","input":{}}}}"#,
        Some(principal),
        Some(forwarder),
    )
    .unwrap()
}

#[test]
fn mounted_operation_addresses_use_the_same_account_route_and_original_scope() {
    struct ExactDirectory;
    impl RouteDirectory for ExactDirectory {
        fn current_route(&self, account: &str, resource: &str) -> Option<Route> {
            (account == "account:one" && resource == "@own-records").then(|| Route {
                resource_address: "@own-records".into(), ..route()
            })
        }
    }
    struct MountedConnections;
    impl ComputerConnections for MountedConnections {
        fn invoke(&self, route: &Route, bytes: &[u8]) -> Result<Vec<u8>, trillion_local::refusal_cause::CodedError<()>> {
            let message = decode_message(bytes).map_err(|error| trillion_local::refusal_cause::CodedError::with_cause((), error.cause()))?;
            assert_eq!(message.resource_address, "@own-records");
            assert_eq!(message.operation_resource.as_deref(), Some("@workshop-tools"));
            assert_eq!(message.operation, "tools:list");
            let admitted = admit(message, route, Some(&Authority(Arc::new(AtomicBool::new(true)))), now()).map_err(|error| trillion_local::refusal_cause::CodedError::with_cause((), error.cause()))?;
            admitted.assert_current(route, now()).map_err(|error| trillion_local::refusal_cause::CodedError::with_cause((), error.cause()))?;
            serde_json::to_vec(&json!({"state":"completed", "request_id":admitted.request_id(),
                "value":{"same_owner":true,"input_identity":admitted.scope().input_identity}})).map_err(|_| trillion_local::refusal_cause::CodedError::new(()))
        }
    }
    let forwarder = McpForwarder { directory: &ExactDirectory, issuer: &Issuer(true), connections: &MountedConnections, now_ms: clock_at(now) };
    let principal = Principal { kind: trillion_local::mcp::PrincipalKind::Person, account_id: "account:one".into(), sign_in: "grant:fixture".into(), client_id: "fixture".into() };
    let mounted = Operation { person_present: None, resource: "@workshop-tools".into(), operation: "tools:list".into(), request_key: "mounted-list".into(), input: json!({}) };
    let answer = forwarder.invoke(&principal, mounted.clone()).unwrap();
    assert_eq!(answer["same_owner"], true);
    assert_ne!(answer["input_identity"], blake3::hash(b"{}").to_hex().to_string(), "the original child address is in its authority scope");
    let mut foreign = principal.clone(); foreign.account_id = "account:two".into();
    assert_eq!(forwarder.invoke(&foreign, mounted.clone()).unwrap_err().code, "resource_route_unavailable");
    let mut unknown = mounted.clone(); unknown.resource = "@caller-alias".into();
    assert_eq!(forwarder.invoke(&principal, unknown).unwrap_err().code, "resource_route_unavailable");
    let mut unknown = mounted; unknown.operation = "tools:caller-invented".into();
    assert_eq!(forwarder.invoke(&principal, unknown).unwrap_err().code, "resource_route_unavailable");
}

#[test]
fn mounted_calls_keep_two_customer_owners_separate_and_refuse_a_swapped_route() {
    struct Customers(bool);
    impl RouteDirectory for Customers {
        fn current_route(&self, account: &str, resource: &str) -> Option<Route> {
            if resource != "@own-records" || !["account:one", "account:two"].contains(&account) { return None; }
            Some(Route { account_id: if self.0 { "account:two" } else { account }.into(),
                device_id: format!("device:{account}"), resource_address: "@own-records".into(), generation: "current".into() })
        }
    }
    struct OwnerConnections(Mutex<Vec<String>>);
    impl ComputerConnections for OwnerConnections {
        fn invoke(&self, route: &Route, bytes: &[u8]) -> Result<Vec<u8>, trillion_local::refusal_cause::CodedError<()>> {
            let message = decode_message(bytes).map_err(|error| trillion_local::refusal_cause::CodedError::with_cause((), error.cause()))?;
            let admitted = admit(message, route, Some(&Authority(Arc::new(AtomicBool::new(true)))), now()).map_err(|error| trillion_local::refusal_cause::CodedError::with_cause((), error.cause()))?;
            admitted.assert_current(route, now()).map_err(|error| trillion_local::refusal_cause::CodedError::with_cause((), error.cause()))?;
            self.0.lock().map_err(|_| trillion_local::refusal_cause::CodedError::new(()))?.push(admitted.scope().account_id.clone());
            serde_json::to_vec(&json!({"state":"completed","request_id":admitted.request_id(),
                "value":{"owner":admitted.scope().account_id}})).map_err(|_| trillion_local::refusal_cause::CodedError::new(()))
        }
    }
    let connections = OwnerConnections(Mutex::new(Vec::new()));
    let forwarder = McpForwarder { directory: &Customers(false), issuer: &Issuer(true), connections: &connections, now_ms: clock_at(now) };
    let call = || Operation { person_present: None, resource: "@workshop-tools".into(), operation: "tools:list".into(), request_key: "same-key".into(), input: json!({}) };
    for account in ["account:one", "account:two"] {
        let who = Principal { kind: trillion_local::mcp::PrincipalKind::Person, account_id: account.into(), sign_in: format!("grant:{}", account.replace(':', "-")), client_id: "same-app".into() };
        assert_eq!(forwarder.invoke(&who, call()).unwrap()["owner"], account);
    }
    let before = connections.0.lock().unwrap().clone();
    let swapped = McpForwarder { directory: &Customers(true), issuer: &Issuer(true), connections: &connections, now_ms: clock_at(now) };
    let who = Principal { kind: trillion_local::mcp::PrincipalKind::Person, account_id: "account:one".into(), sign_in: "grant:one".into(), client_id: "same-app".into() };
    assert_eq!(swapped.invoke(&who, call()).unwrap_err().code, "resource_route_changed");
    assert_eq!(*connections.0.lock().unwrap(), before, "a foreign route is refused before dispatch");
}

#[test]
fn authenticated_sign_in_owns_retries_even_when_client_display_name_is_shared_or_changed() {
    let directory = Directory(Some(route()));
    let issuer = Issuer(true);
    let connections = Connections {
        authority: Authority(Arc::new(AtomicBool::new(true))),
        seen: Mutex::default(),
        lose_reply: false,
    };
    let forwarder = McpForwarder {
        directory: &directory,
        issuer: &issuer,
        connections: &connections,
        now_ms: clock_at(now),
    };
    let first = Principal { kind: trillion_local::mcp::PrincipalKind::Person,
        account_id: "account:one".into(),
        sign_in: "grant:one".into(),
        client_id: "same-app".into(),
    };
    let second = Principal {
        sign_in: "grant:two".into(),
        ..first.clone()
    };
    let renamed = Principal {
        client_id: "renamed-app".into(),
        ..first.clone()
    };
    for principal in [&first, &second, &renamed] {
        assert_eq!(call_as(principal, &forwarder)["result"]["isError"], false);
    }
    let seen = connections.seen.lock().unwrap();
    assert_eq!(seen[0].0, "grant:one");
    assert_eq!(seen[1].0, "grant:two");
    assert_eq!(seen[2].0, "grant:one");
    assert_ne!(seen[0].1, seen[1].1);
    assert_eq!(seen[0].1, seen[2].1);
    let previous_identity = serde_json::to_vec(&(
        "public-resource-request-v1",
        "account:one",
        "grant:one",
        "project:one",
        "read",
        "same-key",
        json!({}),
    ))
    .unwrap();
    let previous_request_id = format!("req:{}", blake3::hash(&previous_identity).to_hex());
    assert_ne!(seen[0].1, previous_request_id);
}

#[test]
fn two_authenticated_clients_reach_one_mac_resource_with_separate_retry_owners() {
    let directory = Directory(Some(route()));
    let issuer = Issuer(true);
    let connections = Connections {
        authority: Authority(Arc::new(AtomicBool::new(true))),
        seen: Mutex::default(),
        lose_reply: false,
    };
    let forwarder = McpForwarder {
        directory: &directory,
        issuer: &issuer,
        connections: &connections,
        now_ms: clock_at(now),
    };
    for client in ["chatgpt", "claude"] {
        let answer = call(client, &forwarder);
        assert_eq!(answer["result"]["structuredContent"]["revision"], 1);
    }
    let seen = connections.seen.lock().unwrap();
    assert_eq!(seen[0].0, "grant:chatgpt");
    assert_eq!(seen[1].0, "grant:claude");
    assert_ne!(seen[0].1, seen[1].1);
}

#[test]
fn absent_or_mismatched_authority_refuses_before_device_dispatch() {
    let connections = Connections {
        authority: Authority(Arc::new(AtomicBool::new(true))),
        seen: Mutex::default(),
        lose_reply: false,
    };
    let issuer = Issuer(true);
    let absent = Directory(None);
    let forwarder = McpForwarder {
        directory: &absent,
        issuer: &issuer,
        connections: &connections,
        now_ms: clock_at(now),
    };
    assert_eq!(
        call("chatgpt", &forwarder)["result"]["structuredContent"]["code"],
        "resource_route_unavailable"
    );
    let display_only = Principal { kind: trillion_local::mcp::PrincipalKind::Person,
        account_id: "account:one".into(),
        sign_in: "chatgpt".into(),
        client_id: "chatgpt".into(),
    };
    assert_eq!(
        forwarder
            .invoke(
                &display_only,
                Operation { person_present: None,
                    resource: "project:one".into(),
                    operation: "read".into(),
                    request_key: "same-key".into(),
                    input: json!({}),
                }
            )
            .unwrap_err()
            .code,
        "client_authority_unavailable"
    );
    let wrong = Directory(Some(Route {
        account_id: "account:other".into(),
        ..route()
    }));
    let forwarder = McpForwarder {
        directory: &wrong,
        issuer: &issuer,
        connections: &connections,
        now_ms: clock_at(now),
    };
    assert_eq!(
        call("chatgpt", &forwarder)["result"]["structuredContent"]["code"],
        "resource_route_changed"
    );
    let valid = Directory(Some(route()));
    let unavailable_issuer = Issuer(false);
    let forwarder = McpForwarder {
        directory: &valid,
        issuer: &unavailable_issuer,
        connections: &connections,
        now_ms: clock_at(now),
    };
    assert_eq!(
        call("chatgpt", &forwarder)["result"]["structuredContent"]["code"],
        "client_authority_unavailable"
    );
    assert!(connections.seen.lock().unwrap().is_empty());
}

#[test]
fn lost_reply_reports_unknown_without_changing_the_retry_owner() {
    let directory = Directory(Some(route()));
    let issuer = Issuer(true);
    let connections = Connections {
        authority: Authority(Arc::new(AtomicBool::new(true))),
        seen: Mutex::default(),
        lose_reply: true,
    };
    let forwarder = McpForwarder {
        directory: &directory,
        issuer: &issuer,
        connections: &connections,
        now_ms: clock_at(now),
    };
    let answer = call("chatgpt", &forwarder);
    assert_eq!(answer["result"]["structuredContent"]["outcome"], "unknown");
    let first_key = connections.seen.lock().unwrap()[0].1.clone();
    call("chatgpt", &forwarder);
    assert_eq!(connections.seen.lock().unwrap()[1].1, first_key);
}

#[test]
fn a_late_device_reply_is_unknown_even_when_it_claims_completion_or_refusal() {
    for refused in [false, true] {
        LATE_REPLY_NOW.store(1_000, Ordering::SeqCst);
        let directory = Directory(Some(route()));
        let issuer = Issuer(true);
        let connections = LateReplyConnections {
            authority: Authority(Arc::new(AtomicBool::new(true))),
            refused,
        };
        let forwarder = McpForwarder {
            directory: &directory,
            issuer: &issuer,
            connections: &connections,
            now_ms: clock_at(late_reply_now),
        };
        let answer = call("chatgpt", &forwarder);
        assert_eq!(answer["result"]["structuredContent"]["outcome"], "unknown");
        assert_eq!(
            answer["result"]["structuredContent"]["code"],
            "resource_outcome_unknown"
        );
    }
}
