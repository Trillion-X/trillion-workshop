// tests/record_suppliers.rs
//
// Purpose: Checks supplied record behavior through HTTP and admitted dispatch, then checks the concrete SQLite contract.
//
// Non-Negotiable Invariants:
// - Injected supply metadata remains explicit, while durability, CAS, history, and commit fencing are verified against the real Store.
//
// Key Concepts:
// - A scripted record supply exposes injected behavior and explicit page metadata without SQLite.
// - The concrete Store contract separately exercises CAS, durable receipts, history, and commit-time revocation.
//
// Security Considerations:
// - Scripted proofs are synthetic and are not production authority or a complete alternate engine; revoked or invalid operations must refuse.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! Purpose: exercise supplied records through actual HTTP and admitted dispatch.
//! Invariants: consumer tests must not require SQLite to implement the supply.
//! Key concepts: a scripted supply exposes boundary calls/translation only;
//! concrete durability, CAS, history and check conformance use the real Store.
//! Security: fixture proofs/tokens are synthetic. The scripted supply is NOT a
//! production authority, alternate durable engine, or whole-EEAF implementation.
use axum::{body::{to_bytes, Body}, http::{header, Request, StatusCode}};
use serde_json::{json, Value};
use std::{cell::Cell, sync::{Arc, Mutex}};
use tower::ServiceExt;
use trillion_local::{
    records::{Change, CommitContext, Error, Mutation, Page, Read, Record, Records},
    resource_authority::{dispatch_record_message, ClientAuthority, CurrentClient,
        DispatchFailure, InvokeMessage, Refusal, Route, Scope},
    server::{route_table, ServerConfig},
    store::Store,
};

/// Deliberately no map, database or new durability implementation. Returning
/// sentinel data proves the consumer actually used this injected behavior.
struct ScriptedSupply { calls: Arc<Mutex<Vec<String>>>, error: Option<Error> }
impl ScriptedSupply {
    fn observe(&self, operation: &str, account: &str, resource: &str) -> Result<(), Error> {
        self.calls.lock().unwrap().push(format!("{operation}:{account}:{resource}"));
        self.error.clone().map_or(Ok(()), Err)
    }
}
fn record() -> Record { Record { id: "sentinel".into(), version: 7, value: json!({"supplied":true}) } }
fn change() -> Change { Change { sequence: 19, id: "sentinel".into(), version: 7, deleted: false, value: Some(json!({"supplied":true})) } }
fn page<T: serde::Serialize, C>(item: T, next: C) -> Page<T, C> {
    let items = vec![item];
    let bytes = serde_json::to_vec(&items).unwrap().len();
    Page { items, next: Some(next), serialized_item_bytes: bytes, work: json!({"supplier":"scripted-boundary-fixture","lookups":1}) }
}
impl Records for ScriptedSupply {
    fn get(&self, account: &str, resource: &str, _: &str) -> Result<Read, Error> {
        self.observe("get", account, resource)?;
        Ok(Read { record: Some(record()), work: json!({"supplier":"scripted-boundary-fixture","lookups":1}) })
    }
    fn mutate(&mut self, account: &str, resource: &str, _: Mutation) -> Result<Change, Error> {
        self.observe("mutate", account, resource)?; Ok(change())
    }
    fn list_page(&self, account: &str, resource: &str, _: &str, _: usize) -> Result<Page<Record, String>, Error> {
        self.observe("list", account, resource)?; Ok(page(record(), "sentinel".into()))
    }
    fn changes_page(&self, account: &str, resource: &str, _: i64, _: usize) -> Result<Page<Change, i64>, Error> {
        self.observe("changes", account, resource)?; Ok(page(change(), 19))
    }
    fn mutate_admitted(&mut self, call: &trillion_local::resource_authority::AdmittedCall, _: &dyn CommitContext) -> Result<Change, Error> {
        self.observe("admitted", &call.scope().account_id, &call.scope().resource_address)?;
        Ok(change())
    }
}

fn config(directory: &tempfile::TempDir) -> ServerConfig {
    let path = directory.path().join("token");
    std::fs::write(&path, b"fixture-token-only-never-a-service-secret").unwrap();
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    ServerConfig::from_token_file("account", "resource", path).unwrap()
}
async fn http(app: axum::Router, method: &str, path: &str, body: Option<Value>, authenticated: bool) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(path).header(header::HOST, "127.0.0.1");
    if authenticated { request = request.header(header::AUTHORIZATION, "Bearer fixture-token-only-never-a-service-secret"); }
    let bytes = body.map(|v| serde_json::to_vec(&v).unwrap()).unwrap_or_default();
    let response = app.oneshot(request.header(header::CONTENT_TYPE, "application/json").body(Body::from(bytes)).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 6 * 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn http_uses_injected_supply_and_preserves_its_explicit_page_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let app = route_table(ScriptedSupply { calls: calls.clone(), error: None }, config(&directory));
    let (status, _) = http(app.clone(), "GET", "/v1/records/sentinel", None, false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(calls.lock().unwrap().is_empty());
    let (status, read) = http(app.clone(), "GET", "/v1/records/sentinel", None, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read["record"], serde_json::to_value(record()).unwrap());
    assert_eq!(read["work"]["lookups"], 1);
    let (_, list) = http(app.clone(), "GET", "/v1/records?limit=1&page=true", None, true).await;
    assert_eq!(list["next"], "sentinel");
    assert_eq!(list["serialized_item_bytes"], serde_json::to_vec(&list["items"]).unwrap().len());
    let (_, changes) = http(app.clone(), "GET", "/v1/changes?limit=1&page=true", None, true).await;
    assert_eq!(changes["next"], 19);
    let (status, write) = http(app, "PUT", "/v1/records/sentinel", Some(json!({"expected_version":0,"request_key":"key","value":null})), true).await;
    assert_eq!(status, StatusCode::OK); assert_eq!(write["sequence"], 19);
    assert_eq!(*calls.lock().unwrap(), ["get:account:resource", "list:account:resource", "changes:account:resource", "mutate:account:resource"]);
}

fn route() -> Route { Route { account_id: "account".into(), device_id: "device".into(), resource_address: "resource".into(), generation: "generation".into() } }
struct Context { checks: Cell<usize>, revoke_check: Option<usize> }
impl CommitContext for Context {
    fn current_route(&self, _: &Scope) -> Option<Route> {
        let count = self.checks.get() + 1; self.checks.set(count);
        (self.revoke_check != Some(count)).then(route)
    }
    fn now_ms(&self) -> i64 { 1000 }
}
struct Authority;
struct Client(Scope);
impl CurrentClient for Client {
    fn identity(&self) -> &str { "fixture-client" }
    fn assert_current(&self, scope: &Scope) -> bool { self.0 == *scope }
}
impl ClientAuthority for Authority {
    fn admit(&self, proof: &str, scope: &Scope) -> Option<Box<dyn CurrentClient>> {
        (proof == "fixture-proof").then(|| Box::new(Client(scope.clone())) as Box<dyn CurrentClient>)
    }
}
fn message() -> Vec<u8> { serde_json::to_vec(&InvokeMessage { person_present: None,
    operation_resource: None,
    request_id: "request".into(), account_id: "account".into(), device_id: "device".into(),
    resource_address: "resource".into(), generation: "generation".into(), operation: "record.mutate".into(),
    input: json!({"id":"r","expected_version":0,"value":null}), request_key: "key".into(),
    client_authorization: "fixture-proof".into(), deadline_at_ms: 2000,
}).unwrap() }
fn context(revoke_check: Option<usize>) -> Context { Context { checks: Cell::new(0), revoke_check } }

#[test]
fn admitted_dispatch_uses_supplied_behavior_and_domain_errors_without_sql() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let mut supply = ScriptedSupply { calls: calls.clone(), error: None };
    let refused: Value = serde_json::from_slice(&dispatch_record_message(&message(), &mut supply, &context(None), None).unwrap()).unwrap();
    assert_eq!(refused["code"], "client_authority_unavailable"); assert!(calls.lock().unwrap().is_empty());
    let completed: Value = serde_json::from_slice(&dispatch_record_message(&message(), &mut supply, &context(None), Some(&Authority)).unwrap()).unwrap();
    assert_eq!(completed["value"]["sequence"], 19);
    for (error, code) in [(trillion_local::cause!(Error::Conflict), "record_conflict"), (Error::Invalid("fixture", trillion_local::cause!()), "invalid_record_request"),
        (trillion_local::cause!(Error::Unavailable), "resource_unavailable"), (Error::Refused(trillion_local::cause!(Refusal::ClientRevoked), trillion_local::cause!()), "client_not_authorized")] {
        let cause = error.cause();
        supply.error = Some(error);
        let reply: Value = serde_json::from_slice(&dispatch_record_message(&message(), &mut supply, &context(None), Some(&Authority)).unwrap()).unwrap();
        assert_eq!(reply["state"], "refused"); assert_eq!(reply["code"], code);
        assert_eq!(reply["cause"], cause.id(), "dispatch preserves the exact supplier condition beside its code");
    }
    let error = trillion_local::cause!(Error::OutcomeUnknown);
    let cause = error.cause();
    supply.error = Some(error);
    match dispatch_record_message(&message(), &mut supply, &context(None), Some(&Authority)) {
        Err(DispatchFailure::OutcomeUnknown(actual)) => assert_eq!(actual, cause),
        other => panic!("expected the original uncertain supplier failure, got {other:?}"),
    }
}

#[tokio::test]
async fn http_preserves_each_supplier_cause_without_logging_private_payloads() {
    let errors = [
        (trillion_local::cause!(Error::Conflict), StatusCode::CONFLICT),
        (Error::Invalid("private-field-fixture", trillion_local::cause!()), StatusCode::BAD_REQUEST),
        (Error::Refused(trillion_local::cause!(Refusal::ClientRevoked), trillion_local::cause!()), StatusCode::FORBIDDEN),
        (trillion_local::cause!(Error::Unavailable), StatusCode::SERVICE_UNAVAILABLE),
        (trillion_local::cause!(Error::OutcomeUnknown), StatusCode::INTERNAL_SERVER_ERROR),
    ];
    let mut observed = std::collections::HashSet::new();
    for (error, expected_status) in errors {
        let directory = tempfile::tempdir().unwrap();
        let cause = error.cause();
        let app = route_table(ScriptedSupply { calls: Arc::new(Mutex::new(Vec::new())), error: Some(error) }, config(&directory));
        let (status, reply) = http(app, "GET", "/v1/records/sentinel", None, true).await;
        assert_eq!(status, expected_status);
        assert_eq!(reply["cause"], cause.id());
        assert_eq!(cause.file(), file!());
        assert!(!cause.id().contains("private-field-fixture"));
        assert!(observed.insert(cause.id()), "distinct source conditions stay distinct at the caller");
    }
}

/// Actual durable supply conformance goes through the neutral trait and real
/// dispatcher, including both new-write and recovered-receipt check windows.
#[test]
fn sqlite_contract_survives_reopen_retry_and_rechecks_commit_and_recovery() {
    let directory = tempfile::tempdir().unwrap(); let path = directory.path().join("records.sqlite");
    let bytes = message();
    {
        let mut supply: Box<dyn Records> = Box::new(Store::open(&path).unwrap());
        let refused: Value = serde_json::from_slice(&dispatch_record_message(&bytes, supply.as_mut(), &context(Some(3)), Some(&Authority)).unwrap()).unwrap();
        assert_eq!(refused["code"], "resource_route_changed");
        let cause = trillion_local::refusal_cause::Cause::from_wire(refused["cause"].as_str().unwrap()).unwrap();
        assert_eq!(cause.file(), "src/store.rs", "the SQLite supplier keeps the original route-fence failure");
        assert_eq!(cause.condition(), "Refusal::RouteChanged");
        assert!(supply.get("account", "resource", "r").unwrap().record.is_none());
        assert!(supply.changes_page("account", "resource", 0, 10).unwrap().items.is_empty());
    }
    let first = {
        let mut supply: Box<dyn Records> = Box::new(Store::open(&path).unwrap());
        dispatch_record_message(&bytes, supply.as_mut(), &context(None), Some(&Authority)).unwrap()
    };
    let mut supply: Box<dyn Records> = Box::new(Store::open(&path).unwrap());
    let refused: Value = serde_json::from_slice(&dispatch_record_message(&bytes, supply.as_mut(), &context(Some(3)), Some(&Authority)).unwrap()).unwrap();
    assert_eq!(refused["code"], "resource_route_changed");
    let cause = trillion_local::refusal_cause::Cause::from_wire(refused["cause"].as_str().unwrap()).unwrap();
    assert_eq!(cause.file(), "src/store.rs", "recovered receipt rechecks keep the supplier's original cause");
    assert_eq!(cause.condition(), "Refusal::RouteChanged");
    let retry = dispatch_record_message(&bytes, supply.as_mut(), &context(None), Some(&Authority)).unwrap();
    assert_eq!(first, retry);
    let changes = supply.changes_page("account", "resource", 0, 10).unwrap();
    assert_eq!(changes.items.len(), 1); assert!(!changes.items[0].deleted);
    assert_eq!(supply.get("account", "resource", "r").unwrap().record.unwrap().value, Value::Null);
}
