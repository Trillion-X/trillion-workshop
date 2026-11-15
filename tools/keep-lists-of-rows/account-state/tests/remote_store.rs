// tests/remote_store.rs
//
// Purpose: Tests admitted remote record writes, physical receipt reuse, and retry read authorization.
//
// Non-Negotiable Invariants:
// - Record and receipt commit atomically; retry readback remains subject to the current route and live client authority.
//
// Key Concepts:
// - Admitted remote writes persist a record and physical retry receipt within one transaction.
// - Current route and live client checks gate receipt readback; revocation before commit rolls back both writes.
//
// Security Considerations:
// - Fixture credentials do not prove production rights; revocation before commit rolls back, and moved routes or revoked clients cannot read receipts.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde_json::json;
use std::{
    cell::Cell,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use trillion_local::{
    resource_authority::{
        admit, ClientAuthority, CurrentClient, InvokeMessage, Refusal, Route, Scope,
    },
    store::{CommitContext, Error, Store},
};

fn route() -> Route {
    Route {
        account_id: "account:one".into(),
        device_id: "device:one".into(),
        resource_address: "project:one".into(),
        generation: "generation:one".into(),
    }
}
struct Authority(Arc<AtomicBool>);
struct Client {
    scope: Scope,
    live: Arc<AtomicBool>,
}
impl CurrentClient for Client {
    fn identity(&self) -> &str {
        "client:one"
    }
    fn assert_current(&self, scope: &Scope) -> bool {
        self.scope == *scope && self.live.load(Ordering::SeqCst)
    }
}
impl ClientAuthority for Authority {
    fn admit(&self, proof: &str, scope: &Scope) -> Option<Box<dyn CurrentClient>> {
        (proof == "fixture-proof").then(|| {
            Box::new(Client {
                scope: scope.clone(),
                live: self.0.clone(),
            }) as Box<dyn CurrentClient>
        })
    }
}
struct Context {
    route: Option<Route>,
    live: Arc<AtomicBool>,
    revoke_on_second_check: bool,
    checks: Cell<usize>,
}
impl CommitContext for Context {
    fn current_route(&self, _: &Scope) -> Option<Route> {
        let checks = self.checks.get() + 1;
        self.checks.set(checks);
        if self.revoke_on_second_check && checks == 2 {
            self.live.store(false, Ordering::SeqCst);
        }
        self.route.clone()
    }
    fn now_ms(&self) -> i64 {
        1_001
    }
}
fn message() -> InvokeMessage {
    InvokeMessage { person_present: None,
        request_id: "request:one".into(),
        operation_resource: None,
        account_id: "account:one".into(),
        device_id: "device:one".into(),
        resource_address: "project:one".into(),
        generation: "generation:one".into(),
        operation: "record.mutate".into(),
        input: json!({"id":"record:one","expected_version":0,"value":{"name":"First"}}),
        request_key: "stable-key".into(),
        client_authorization: "fixture-proof".into(),
        deadline_at_ms: 5_000,
    }
}

#[test]
fn admitted_remote_write_and_retry_reuse_one_physical_receipt() {
    let live = Arc::new(AtomicBool::new(true));
    let authority = Authority(live.clone());
    let call = admit(message(), &route(), Some(&authority), 1_000).unwrap();
    let context = Context {
        route: Some(route()),
        live,
        revoke_on_second_check: false,
        checks: Cell::new(0),
    };
    let mut store = Store::open(":memory:").unwrap();
    let first = store.mutate_admitted(&call, &context).unwrap();
    let retry = store.mutate_admitted(&call, &context).unwrap();
    assert_eq!(first, retry);
    assert_eq!(context.checks.get(), 4);
    assert_eq!(
        store
            .changes("account:one", "project:one", 0, 10)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store
            .get("account:one", "project:one", "record:one")
            .unwrap()
            .record
            .unwrap()
            .value,
        json!({"name":"First"})
    );
}

#[test]
fn revocation_before_commit_rolls_back_both_record_and_receipt() {
    let live = Arc::new(AtomicBool::new(true));
    let authority = Authority(live.clone());
    let call = admit(message(), &route(), Some(&authority), 1_000).unwrap();
    let context = Context {
        route: Some(route()),
        live,
        revoke_on_second_check: true,
        checks: Cell::new(0),
    };
    let mut store = Store::open(":memory:").unwrap();
    assert!(matches!(
        store.mutate_admitted(&call, &context),
        Err(Error::Refused(Refusal::ClientRevoked(_), _))
    ));
    assert_eq!(context.checks.get(), 2);
    assert!(store
        .get("account:one", "project:one", "record:one")
        .unwrap()
        .record
        .is_none());
    assert!(store
        .changes("account:one", "project:one", 0, 10)
        .unwrap()
        .is_empty());
}

#[test]
fn moved_route_or_revoked_client_cannot_read_back_a_retry_receipt() {
    let live = Arc::new(AtomicBool::new(true));
    let authority = Authority(live.clone());
    let call = admit(message(), &route(), Some(&authority), 1_000).unwrap();
    let context = Context {
        route: Some(route()),
        live: live.clone(),
        revoke_on_second_check: false,
        checks: Cell::new(0),
    };
    let mut store = Store::open(":memory:").unwrap();
    store.mutate_admitted(&call, &context).unwrap();
    live.store(false, Ordering::SeqCst);
    assert!(matches!(
        store.mutate_admitted(&call, &context),
        Err(Error::Refused(Refusal::ClientRevoked(_), _))
    ));
    live.store(true, Ordering::SeqCst);
    let moved = Context {
        route: Some(Route {
            generation: "generation:two".into(),
            ..route()
        }),
        live,
        revoke_on_second_check: false,
        checks: Cell::new(0),
    };
    assert!(matches!(
        store.mutate_admitted(&call, &moved),
        Err(Error::Refused(Refusal::RouteChanged(_), _))
    ));
    assert_eq!(
        store
            .changes("account:one", "project:one", 0, 10)
            .unwrap()
            .len(),
        1
    );
}
