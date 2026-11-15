// src/account_rights/run_cause/tests.rs
//
// Purpose: Prove the one cause issuer on a registered resolver and a real wake book: a run's pass is minted from its
// live cause only, never wider than the row declares nor, for a scheduled child, than its root row declares now; a cause
// no longer standing issues nothing; a wake switch records the party that wrote it and nothing else (no key, no grant),
// and that party is what the wake's causes carry to their runs and children. The account's real sign-in, its parties and
// their rights are proven in native_boot/mcp_local.rs `standing_tests`.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::*;
use crate::{
    account_rights::run_capability::{held, Admitted},
    mcp::{http::AuthenticationFailure, Operation, Principal},
    record_value::account_routes::Door,
    storage::{
        memory::Memory,
        record_store::{settings, RecordStore, RealClock},
    },
};
use std::sync::atomic::{AtomicBool, Ordering};

const ACCOUNT: &str = "run-cause-account";
const CHILD_ACCOUNT: &str = "run-cause-child-account";
const ADDRESS: &str = "synthetic-run-cause-address";
const PARTY: &str = "party:synthetic-run-cause-address";
const TOOL: &str = "tool-a";
const WAKE: &str = "on-notes";
const MINUTE: Duration = Duration::from_secs(60);

fn door() -> &'static Door {
    Door::shipped().unwrap()
}

fn records(rights: Value) -> Value {
    json!({"fd": 3, "rights": rights})
}

fn route() -> &'static Route {
    static ROUTE: OnceLock<Route> = OnceLock::new();
    ROUTE.get_or_init(|| Route { door: "127.0.0.1:28811".parse().unwrap(), address: ADDRESS.into() })
}

fn call(operation: &str, input: Value) -> Operation {
    Operation { person_present: None, resource: door().resource().to_owned(), operation: operation.to_owned(), input, request_key: "k".to_owned() }
}

fn principal() -> Principal {
    Principal { kind: crate::mcp::PrincipalKind::Person, account_id: ACCOUNT.to_owned(), sign_in: PARTY.to_owned(), client_id: String::new() }
}

/// A party that stands while `ended` is false: the account routes' own resolver is proven against the real sign-in in
/// mcp_local.rs; this one isolates the issuer.
struct Party(Arc<AtomicBool>, String);
impl ParentAuthority for Party {
    fn authenticate(&self) -> Result<Principal, AuthenticationFailure> {
        if self.0.load(Ordering::Acquire) { return Err(crate::cause!(AuthenticationFailure::Unauthorized)) }
        Ok(Principal { account_id: self.1.clone(), ..principal() })
    }
    fn invoke(&self, _: &Principal, _: Operation, _: &Admitted, _: &crate::mcp::RequestDisclosure)
        -> Result<Value, crate::mcp::OperationFailure> {
        Ok(Value::Null)
    }
}
struct Resolver(Arc<AtomicBool>);
impl ParentResolver for Resolver {
    fn resolve_cause(&self, account: &str, cause: &str) -> Result<Arc<dyn ParentAuthority>, Refusal> {
        if ![ACCOUNT, CHILD_ACCOUNT].contains(&account) || cause != PARTY { return Err(crate::cause!(Refusal::NotGranted)); }
        Ok(Arc::new(Party(self.0.clone(), account.to_owned())))
    }
}

fn issuer(sign_in: &str, root: Option<Root<'static>>) -> CauseIssuer<'static> {
    let sign_in: &'static str = Box::leak(sign_in.to_owned().into_boxed_str());
    CauseIssuer { account: ACCOUNT, sign_in, cause: Some("cause-1"), route: route(), root }
}

#[test]
fn a_run_gets_its_live_causes_pass_for_its_rows_declaration_only_and_none_once_the_cause_ends() {
    let ended = Arc::new(AtomicBool::new(false));
    let _registered = register_resolver(ACCOUNT, Arc::new(Resolver(ended.clone()))).unwrap();
    let (read, list) = (door().read_operation(), door().list_operation());
    let row = records(json!([{"kind": "note", "operations": [read]}]));
    let issued = issuer(PARTY, None).issue(&row, MINUTE).unwrap();
    let run = held(issued.capability.token().as_bytes()).unwrap().unwrap();
    assert!(run.narrow(&principal(), &call(read, json!({"id": "a", "type": "note"}))).is_ok());
    assert_eq!(run.narrow(&principal(), &call(list, json!({"type": "note"}))).err(), Some(crate::cause!(Refusal::NotGranted)),
        "never wider than the row declares");
    assert!(issuer(PARTY, None).task_context().unwrap().value(ACCOUNT).is_ok());
    // A name no party stands under, and a cause that ended, issue nothing.
    assert!(issuer("party:another-address", None).issue(&row, MINUTE).is_err());
    ended.store(true, Ordering::Release);
    assert_eq!(issuer(PARTY, None).issue(&row, MINUTE).err(), Some(crate::cause!(Refusal::NotGranted)));
    assert!(issuer(PARTY, None).task_context().unwrap().value(ACCOUNT).is_err());
}

#[test]
fn a_scheduled_child_is_never_wider_than_its_root_row_now() {
    let ended = Arc::new(AtomicBool::new(false));
    // Its own account, so the other test's resolver (one per account, process-wide) is never this one.
    let _registered = register_resolver(CHILD_ACCOUNT, Arc::new(Resolver(ended))).unwrap();
    let issuer = |sign_in: &str, root| CauseIssuer { account: CHILD_ACCOUNT, ..issuer(sign_in, root) };
    let (read, list) = (door().read_operation(), door().list_operation());
    let child_row = records(json!([{"kind": "note", "operations": [read, list]}, {"kind": "message", "operations": [read]}]));
    // The root row now declares only reads of notes: the child gets that ∩ its own row.
    let root_now: &'static Value = Box::leak(Box::new(records(json!([{"kind": "note", "operations": [read]}]))));
    let issued = issuer(PARTY, Some(Root { records: Some(root_now) })).issue(&child_row, MINUTE).unwrap();
    let run = held(issued.capability.token().as_bytes()).unwrap().unwrap();
    let who = Principal { account_id: CHILD_ACCOUNT.to_owned(), ..principal() };
    assert!(run.narrow(&who, &call(read, json!({"id": "a", "type": "note"}))).is_ok());
    assert_eq!(run.narrow(&who, &call(list, json!({"type": "note"}))).err(), Some(crate::cause!(Refusal::NotGranted)), "wider than the root now");
    assert_eq!(run.narrow(&who, &call(read, json!({"id": "a", "type": "message"}))).err(), Some(crate::cause!(Refusal::NotGranted)));
    // A root row that declares no records now (or is gone) gives the child nothing.
    assert_eq!(issuer(PARTY, Some(Root { records: None })).issue(&child_row, MINUTE).err(), Some(crate::cause!(Refusal::NotGranted)));
}

#[test]
fn switching_a_wake_records_the_party_that_wrote_it_and_keeps_nothing_else() {
    let limits = settings::Limits::fixed(1 << 20, 10 << 30);
    let mut book = RecordStore::new(Memory::open("record_store").unwrap(), Box::new(RealClock), limits).unwrap();
    let waker = Waker::shipped().unwrap();
    let rows = vec![crate::wake::Row { origin: crate::wake::Origin::Workshop, tool: TOOL.to_owned(),
        wakes: json!([{"id": WAKE, "on": {"time": {"every_ms": 3_600_000, "from_ms": 0}}, "budget": {"steps": 1, "wall_ms": 600_000}}]) }];
    let declared = waker.declared(&rows).unwrap();
    let wakes = Wakes { waker: &waker, account: ACCOUNT, declared: &declared };
    let asked = |on: bool| json!({"tool": TOOL, "id": WAKE, "on": on});
    let (on, off) = (asked(true), asked(false));
    switch(&wakes, &mut book, Switch::asked(&on).unwrap(), "grant:synthetic-app").unwrap();
    let kept = crate::records::Records::list_page(&book, ACCOUNT, "wake-book", "", 10).unwrap();
    let written = serde_json::to_string(&kept.items).unwrap();
    assert!(written.contains("grant:synthetic-app"), "the switch names the party that wrote it");
    switch(&wakes, &mut book, Switch::asked(&off).unwrap(), "grant:synthetic-app").unwrap();
    // A wake the row does not declare is never switched; a switch names its party.
    let missing = json!({"tool": TOOL, "id": "no-such-wake", "on": true});
    assert_eq!(switch(&wakes, &mut book, Switch::asked(&missing).unwrap(), PARTY), Err(crate::cause!(SwitchFailure::Input)));
    assert_eq!(switch(&wakes, &mut book, Switch::asked(&on).unwrap(), ""), Err(crate::cause!(SwitchFailure::Input)));
}

#[test]
fn a_switch_names_exactly_its_tool_its_wake_and_on_or_off() {
    let on = json!({"tool": "t", "id": "w", "on": true});
    assert_eq!(Switch::asked(&on), Some(Switch { tool: "t", id: "w", on: true }));
    for refused in [
        json!({"tool": "t", "id": "w"}),
        json!({"tool": "t", "id": "w", "on": "yes"}),
        json!({"tool": "", "id": "w", "on": true}),
        json!({"tool": "t", "id": "w", "on": true, "extra": 1}),
        json!([]),
    ] {
        assert_eq!(Switch::asked(&refused), None, "{refused}");
    }
}
