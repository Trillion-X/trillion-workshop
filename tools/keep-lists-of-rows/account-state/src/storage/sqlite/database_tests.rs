// Purpose: `database.rs` on real SQLite files. Ported from old trillion test/database-supply.test.mjs (12 tests, same
// names where trillion-local allows): PostgreSQL SQL becomes SQLite SQL (`?` parameters, the `main` schema), the snapshot
// owner's term check becomes `Rights::fence_current`, and the legacy in-database receipt test becomes the refusal of
// the supply's own tables to the caller's SQL (this supply never had legacy receipts).
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::*;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

const ADDRESS: &str = "resource:customer-db";

fn task(request_key: &str) -> Command {
    Command { address: ADDRESS.into(), actor: "account:one".into(), permit_id: format!("permit:{request_key}"), request_key: request_key.into() }
}
fn fence(ask: &Ask) -> Value {
    json!({ "resource": ask.address, "actor": ask.actor, "permit_id": ask.permit_id, "request_key": ask.request_key, "generation": 1 })
}
/// Rights that record every ask, answer a term check at commit, and refuse while `allowed` is false.
#[derive(Clone, Default)]
struct Checked {
    asks: Rc<RefCell<Vec<Ask>>>,
    allowed: Rc<Cell<bool>>,
    revoke_at_query_commit: bool,
    stale_fence_at_query_commit: bool,
}
impl Checked {
    fn new() -> Self {
        Checked { allowed: Rc::new(Cell::new(true)), ..Default::default() }
    }
}
impl Rights for Checked {
    fn authorize(&self, ask: &Ask) -> Result<Option<Value>, DbError> {
        self.asks.borrow_mut().push(ask.clone());
        if self.revoke_at_query_commit && ask.operation == "query" && ask.at_commit {
            self.allowed.set(false);
        }
        if self.stale_fence_at_query_commit && ask.operation == "query" && ask.at_commit {
            self.allowed.set(false);
            return Ok(Some(fence(ask)));
        }
        if !self.allowed.get() {
            return fail("current rights revoked", "database_permit_revoked", 403, crate::cause!());
        }
        Ok(ask.at_commit.then(|| fence(ask)))
    }
    fn fence_current(&self, fence: &Value, address: &str, request_key: &str) -> bool {
        fence["resource"] == address && fence["request_key"] == request_key && self.allowed.get()
    }
}
fn revision_of(root: &std::path::Path) -> Option<String> {
    let supply = DatabaseSupply::new(root, Checked::new());
    let answer = supply.with_db(ADDRESS, false, |open| Ok(revision_text(DatabaseSupply::<Checked>::revision(&open.db)?))).ok()?;
    answer
}
fn receipt_exists(root: &std::path::Path, key: &str) -> bool {
    let supply = DatabaseSupply::new(root, Checked::new());
    supply
        .with_db(ADDRESS, false, |open| Ok(open.db.query_row(&format!("SELECT count(*) FROM {OWNER}commitments WHERE request_key = ?"), [key], |row| row.get::<_, i64>(0)).map_err(|error| sql_failure(error, crate::cause!()))? > 0))
        .unwrap()
}

#[test]
fn a_database_is_provisioned_and_runs_arbitrary_schema_and_row_operations() {
    let dir = tempfile::tempdir().unwrap();
    let rights = Checked::new();
    let supply = DatabaseSupply::new(dir.path(), rights.clone());
    let provisioned = supply.invoke("provision", &json!({ "name": "Sales data" }), &task("provision")).unwrap();
    assert_eq!(provisioned, json!({ "resource": ADDRESS, "name": "Sales data", "state": "provisioned", "engine": "SQLite", "revision": "revision:1" }));
    assert_eq!(revision_of(dir.path()).as_deref(), Some("revision:1"));
    supply
        .invoke("transaction", &json!({ "expected_revision": "revision:1", "statements": [
            { "sql": "CREATE TABLE deals (id text PRIMARY KEY, stage text NOT NULL, amount numeric)" },
            { "sql": "CREATE INDEX deals_by_stage ON deals(stage)" },
            { "sql": "INSERT INTO deals(id, stage, amount) VALUES (?, ?, ?)", "params": ["o-1", "open", 1250] },
        ] }), &task("schema-and-first-row"))
        .unwrap();
    let shape = supply.invoke("schema", &json!({ "expected_revision": "revision:2", "schema": "main" }), &task("read-schema")).unwrap();
    let columns: Vec<&str> = shape["columns"].as_array().unwrap().iter().map(|row| row["column_name"].as_str().unwrap()).collect();
    assert_eq!(columns, ["id", "stage", "amount"]);
    let result = supply.invoke("read", &json!({ "expected_revision": "revision:2", "sql": "SELECT stage, amount FROM deals WHERE id = ?", "params": ["o-1"] }), &task("read-row")).unwrap();
    assert_eq!(result["rows"], json!([{ "stage": "open", "amount": 1250 }]));
    assert_eq!(rights.asks.borrow().len(), 8, "current resource rights are checked before each dispatch and again at each commit");
}

#[test]
fn commands_are_atomic_request_key_replay_is_stable_and_reopened_databases_retain_rows() {
    let dir = tempfile::tempdir().unwrap();
    let supply = DatabaseSupply::new(dir.path(), Checked::new());
    supply.invoke("provision", &json!({}), &task("create")).unwrap();
    supply.invoke("query", &json!({ "expected_revision": "revision:1", "sql": "CREATE TABLE people (id integer PRIMARY KEY, name text)" }), &task("make-table")).unwrap();
    let input = json!({ "expected_revision": "revision:2", "sql": "INSERT INTO people VALUES(?, ?) RETURNING *", "params": [1, "Ada"] });
    let inserted = supply.invoke("write", &input, &task("insert-person")).unwrap();
    let duplicate = supply.invoke("write", &input, &task("insert-person")).unwrap();
    assert_eq!(duplicate, inserted, "replay returns the receipt instead of running the INSERT twice");
    let refused = supply
        .invoke("transaction", &json!({ "expected_revision": "revision:3", "statements": [
            { "sql": "INSERT INTO people VALUES(?, ?)", "params": [2, "Grace"] },
            { "sql": "INSERT INTO people VALUES(?, ?)", "params": [1, "conflict"] },
        ] }), &task("rollback-batch"))
        .unwrap_err();
    assert!(refused.message.to_lowercase().contains("unique"), "{refused:?}");
    assert_eq!(revision_of(dir.path()).as_deref(), Some("revision:3"), "failed transaction leaves the revision unchanged");
    supply.close(ADDRESS).unwrap();
    let reopened = DatabaseSupply::new(dir.path(), Checked::new());
    let rows = reopened.invoke("read", &json!({ "expected_revision": "revision:3", "sql": "SELECT id, name FROM people" }), &task("read-after-reopen")).unwrap();
    assert_eq!(rows["rows"], json!([{ "id": 1, "name": "Ada" }]));
}

#[test]
fn current_rights_revocation_at_commit_discards_the_uncommitted_change() {
    let dir = tempfile::tempdir().unwrap();
    let rights = Checked { revoke_at_query_commit: true, ..Checked::new() };
    let supply = DatabaseSupply::new(dir.path(), rights.clone());
    supply.invoke("provision", &json!({}), &task("create")).unwrap();
    let refused = supply.invoke("query", &json!({ "expected_revision": "revision:1", "sql": "CREATE TABLE revoke_test (id integer)" }), &task("revoked-write")).unwrap_err();
    assert!(refused.message.contains("current rights revoked"));
    assert_eq!(revision_of(dir.path()).as_deref(), Some("revision:1"));
    rights.allowed.set(true);
    supply.close(ADDRESS).unwrap();
    let reopened = DatabaseSupply::new(dir.path(), Checked::new());
    let shape = reopened.invoke("schema", &json!({ "expected_revision": "revision:1", "schema": "main" }), &task("schema-after-revoke")).unwrap();
    assert!(!shape["columns"].as_array().unwrap().iter().any(|column| column["table_name"] == "revoke_test"));
}

#[test]
fn expected_revision_compare_and_swap_refuses_concurrent_stale_work() {
    let dir = tempfile::tempdir().unwrap();
    let supply = DatabaseSupply::new(dir.path(), Checked::new());
    supply.invoke("provision", &json!({}), &task("create")).unwrap();
    supply.invoke("query", &json!({ "expected_revision": "revision:1", "sql": "CREATE TABLE cas_test (id integer)" }), &task("first-change")).unwrap();
    let stale = supply.invoke("query", &json!({ "expected_revision": "revision:1", "sql": "CREATE TABLE stale_test (id integer)" }), &task("stale-change")).unwrap_err();
    assert_eq!((stale.code, stale.status), ("database_revision_conflict", 409));
    assert_eq!(revision_of(dir.path()).as_deref(), Some("revision:2"));
}

#[test]
fn warm_supplies_see_another_supplys_commit_before_checking_revisions_and_executing_reads() {
    let dir = tempfile::tempdir().unwrap();
    let first = DatabaseSupply::new(dir.path(), Checked::new());
    let second = DatabaseSupply::new(dir.path(), Checked::new());
    first.invoke("provision", &json!({}), &task("create")).unwrap();
    second.invoke("read", &json!({ "expected_revision": "revision:1", "sql": "SELECT 1 AS value" }), &task("warm-read")).unwrap();
    first.invoke("query", &json!({ "expected_revision": "revision:1", "sql": "CREATE TABLE refreshed (value integer)" }), &task("change")).unwrap();
    first.invoke("write", &json!({ "expected_revision": "revision:2", "sql": "INSERT INTO refreshed VALUES(7)" }), &task("insert")).unwrap();
    let current = second.invoke("read", &json!({ "expected_revision": "revision:3", "sql": "SELECT value FROM refreshed" }), &task("fresh-read")).unwrap();
    assert_eq!(current["rows"], json!([{ "value": 7 }]), "a warm handle reads another supply's commit");
}

#[test]
fn read_is_transactionally_read_only_and_does_not_create_a_revision_or_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let supply = DatabaseSupply::new(dir.path(), Checked::new());
    supply.invoke("provision", &json!({}), &task("create")).unwrap();
    let selected = supply.invoke("read", &json!({ "expected_revision": "revision:1", "sql": "SELECT 4 AS value" }), &task("select")).unwrap();
    assert_eq!(selected["rows"], json!([{ "value": 4 }]));
    assert_eq!(revision_of(dir.path()).as_deref(), Some("revision:1"));
    assert!(!receipt_exists(dir.path(), "select"));
    assert!(supply.invoke("read", &json!({ "expected_revision": "revision:1", "sql": "CREATE TABLE forbidden (id integer)" }), &task("mutating-read")).is_err());
    assert_eq!(revision_of(dir.path()).as_deref(), Some("revision:1"));
    let shape = supply.invoke("inspect", &json!({ "expected_revision": "revision:1" }), &task("inspect")).unwrap();
    assert_eq!(shape["schemas"], json!([]), "the mutating read made nothing, and the owner tables are not listed");
}

#[test]
fn the_commit_checks_the_current_permit_fence_while_storing_the_change_and_receipt_together() {
    let dir = tempfile::tempdir().unwrap();
    let supply = DatabaseSupply::new(dir.path(), Checked { stale_fence_at_query_commit: true, ..Checked::new() });
    supply.invoke("provision", &json!({}), &task("create")).unwrap();
    let refused = supply.invoke("query", &json!({ "expected_revision": "revision:1", "sql": "CREATE TABLE rejected (id integer)" }), &task("stale-permit")).unwrap_err();
    assert_eq!((refused.code, refused.status), ("database_permit_revoked", 403));
    assert_eq!(revision_of(dir.path()).as_deref(), Some("revision:1"));
    assert!(!receipt_exists(dir.path(), "stale-permit"));
}

#[test]
fn reconciliation_reads_the_original_durable_commitment_without_replaying_sql() {
    let dir = tempfile::tempdir().unwrap();
    let supply = DatabaseSupply::new(dir.path(), Checked::new());
    let input = json!({ "expected_revision": "revision:1", "sql": "CREATE TABLE once (id integer)" });
    supply.invoke("provision", &json!({}), &task("create")).unwrap();
    assert_eq!(supply.reconcile("query", &input, &task("original-command")).unwrap(), json!({ "state": "not_sent" }));
    supply.invoke("query", &input, &task("original-command")).unwrap();
    let reconciled = supply.reconcile("query", &input, &task("original-command")).unwrap();
    assert_eq!(reconciled, json!({ "state": "completed", "output": { "rows": [], "fields": [], "affected_rows": 0 } }));
    assert_eq!(revision_of(dir.path()).as_deref(), Some("revision:2"));
    let other = json!({ "expected_revision": "revision:2", "sql": "CREATE TABLE twice (id integer)" });
    assert_eq!(supply.reconcile("query", &other, &task("original-command")).unwrap_err().code, "database_request_conflict");
}

// Replaces old 'legacy in-database receipts are surfaced as unknown and never silently replayed': the receipts are the
// supply's own tables, which the caller's SQL can neither read, write, drop nor shadow, and no statement leaves the
// command's transaction.
#[test]
fn the_callers_sql_cannot_reach_the_receipts_or_leave_the_commands_transaction() {
    let dir = tempfile::tempdir().unwrap();
    let supply = DatabaseSupply::new(dir.path(), Checked::new());
    supply.invoke("provision", &json!({}), &task("create")).unwrap();
    for (at, sql) in [
        "SELECT * FROM _supply_commitments",
        "DELETE FROM _supply_commitments",
        "UPDATE _supply_state SET revision = 99",
        "DROP TABLE _supply_state",
        "CREATE TABLE _supply_shadow (id integer)",
        "COMMIT",
        "SAVEPOINT escape",
        "ATTACH DATABASE ':memory:' AS other",
        "CREATE TABLE a (id integer); COMMIT",
    ]
    .iter()
    .enumerate()
    {
        let refused = supply.invoke("query", &json!({ "expected_revision": "revision:1", "sql": sql }), &task(&format!("escape-{at}")));
        assert!(refused.is_err(), "{sql} must be refused");
    }
    assert_eq!(revision_of(dir.path()).as_deref(), Some("revision:1"));
    assert!(supply.invoke("query", &json!({ "expected_revision": "revision:1", "sql": "CREATE TABLE allowed (id integer)" }), &task("allowed")).is_ok());
}

#[test]
fn lifecycle_derives_the_current_actor_permit_and_request_from_the_original_task() {
    let dir = tempfile::tempdir().unwrap();
    let rights = Checked::new();
    let supply = DatabaseSupply::new(dir.path(), rights.clone());
    supply.invoke("provision", &json!({}), &task("create")).unwrap();
    supply.invoke("lifecycle", &json!({ "action": "close" }), &task("close-resource")).unwrap();
    let last = rights.asks.borrow().last().cloned().unwrap();
    assert_eq!((last.actor.as_str(), last.permit_id.as_str(), last.request_key.as_str()), ("account:one", "permit:close-resource", "close-resource"));
    supply.invoke("lifecycle", &json!({ "action": "delete", "expected_revision": "revision:1" }), &task("delete-resource")).unwrap();
    assert_eq!(revision_of(dir.path()), None, "the database is gone");
    assert_eq!(supply.invoke("read", &json!({ "expected_revision": "revision:1", "sql": "SELECT 1" }), &task("after-delete")).unwrap_err().code, "database_not_found");
}

#[test]
fn typed_descriptors_expose_one_database_implementation_to_every_door() {
    let descriptors = database_tool_descriptors();
    let operations: Vec<&str> = descriptors.iter().map(|item| item["invoke"]["operation"].as_str().unwrap()).collect();
    assert_eq!(operations, ["provision", "inspect", "schema", "read", "write", "query", "transaction", "lifecycle"]);
    assert!(descriptors.iter().all(|item| item["invoke"]["implementation_ref"] == "native:sqlite-database"));
    assert!(descriptors.iter().all(|item| item["input_schema"]["required"].as_array().unwrap().contains(&json!("resource_ref"))));
    assert!(descriptors.iter().find(|item| item["invoke"]["operation"] == "transaction").unwrap()["input_schema"]["properties"]["statements"].is_object());
}

#[test]
fn an_external_capability_cannot_self_grant_record_transaction_authority_from_metadata() {
    let absent = TransactionAuthority::new(None);
    assert!(!absent.available());
    let ask = Ask { address: ADDRESS.into(), actor: "account:one".into(), permit_id: "permit:x".into(), request_key: "x".into(), operation: "eeaf:transaction:commit".into(), input: json!({}), expected_revision: None, at_commit: true };
    assert_eq!(absent.check(&ask).unwrap_err().code, "eeaf_authority_unavailable");
    let untrusted = TransactionAuthority::new(Some(Box::new(|_| json!({ "authoritative": false }))));
    assert_eq!(untrusted.check(&ask).unwrap_err().code, "eeaf_authority_unavailable");
    let complete = TransactionAuthority::new(Some(Box::new(|_| json!({ "authoritative": true, "current": true, "contract_id": AUTHORITY_CONTRACT.0, "contract_revision": AUTHORITY_CONTRACT.1, "atomicity": AUTHORITY_CONTRACT.2, "semantics": AUTHORITY_SEMANTICS }))));
    assert!(complete.check(&ask).is_ok());
}

/// Thread-safe rights for synthetic concurrency controls.
struct ConcurrentRights;
impl Rights for ConcurrentRights {
    fn authorize(&self, ask: &Ask) -> Result<Option<Value>, DbError> {
        Ok(ask.at_commit.then(|| fence(ask)))
    }
}

#[test]
fn another_address_commits_while_an_address_is_held_cold_and_warm() {
    use std::{sync::mpsc, thread, time::Duration};
    for warm in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let supply = DatabaseSupply::new(dir.path(), ConcurrentRights);
        let a = "resource:independent-a";
        let b = Command { address: "resource:independent-b".into(), ..task("b-provision") };
        if warm { supply.with_db(a, true, |_| Ok(())).unwrap(); }
        thread::scope(|threads| {
            let (held_tx, held_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let supply = &supply;
            let holder = threads.spawn(move || {
                let entry = supply.entry(a).unwrap();
                let held = entry.lock().unwrap();
                assert_eq!(held.is_some(), warm);
                held_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            });
            held_rx.recv().unwrap();
            let (done_tx, done_rx) = mpsc::channel();
            let worker = threads.spawn(move || {
                let answer = supply.invoke("provision", &json!({}), &b)
                    .and_then(|_| supply.invoke("query", &json!({"expected_revision": "revision:1", "sql": "CREATE TABLE proof (value TEXT NOT NULL)"}), &Command { request_key: "b-schema".into(), ..b.clone() }))
                    .and_then(|_| supply.invoke("write", &json!({"expected_revision": "revision:2", "sql": "INSERT INTO proof VALUES (?)", "params": ["committed"]}), &Command { request_key: "b-write".into(), ..b.clone() }))
                    .and_then(|_| supply.invoke("read", &json!({"expected_revision": "revision:3", "sql": "SELECT value FROM proof"}), &Command { request_key: "b-read".into(), ..b }));
                done_tx.send(answer).unwrap();
            });
            // A deadline is a deadlock watchdog; channels establish ordering.
            let completed = done_rx.recv_timeout(Duration::from_secs(10));
            release_tx.send(()).unwrap();
            holder.join().unwrap();
            worker.join().unwrap();
            assert_eq!(completed.expect("B finishes before A releases").unwrap()["rows"], json!([{"value": "committed"}]));
        });
    }
}

#[test]
fn close_and_delete_keep_one_slot_for_queued_and_later_callers() {
    let dir = tempfile::tempdir().unwrap();
    let supply = DatabaseSupply::new(dir.path(), ConcurrentRights);
    supply.invoke("provision", &json!({}), &task("provision")).unwrap();
    let queued = supply.entry(ADDRESS).unwrap();
    assert_eq!(supply.close(ADDRESS).unwrap().as_deref(), Some("revision:1"));
    assert!(Arc::ptr_eq(&queued, &supply.entry(ADDRESS).unwrap()));
    supply.invoke("inspect", &json!({"expected_revision": "revision:1"}), &task("inspect")).unwrap();
    supply.invoke("lifecycle", &json!({"action": "delete", "expected_revision": "revision:1"}), &task("delete")).unwrap();
    assert!(Arc::ptr_eq(&queued, &supply.entry(ADDRESS).unwrap()));
    assert!(queued.lock().unwrap().is_none());
    assert_eq!(supply.invoke("inspect", &json!({"expected_revision": "revision:1"}), &task("missing")).unwrap_err().code, "database_not_found");
    supply.invoke("provision", &json!({}), &task("recreate")).unwrap();
    assert!(Arc::ptr_eq(&queued, &supply.entry(ADDRESS).unwrap()));
}


#[test]
fn failed_opens_and_unknown_closes_retain_no_idle_address() {
    let dir = tempfile::tempdir().unwrap();
    let supply = DatabaseSupply::new(dir.path(), ConcurrentRights);
    for n in 0..100 {
        let address = format!("resource:missing-{n}");
        assert_eq!(supply.with_db(&address, false, |_| Ok(())).unwrap_err().code, "database_not_found");
        assert_eq!(supply.close(&address).unwrap(), None);
        assert!(supply.open.lock().unwrap().is_empty());
    }
}

#[test]
fn idle_handle_eviction_keeps_durable_receipts_and_skips_an_active_slot() {
    use std::{sync::mpsc, thread};
    let dir = tempfile::tempdir().unwrap();
    let supply = DatabaseSupply::new(dir.path(), ConcurrentRights);
    let command = task("first");
    supply.invoke("provision", &json!({}), &command).unwrap();
    thread::scope(|threads| {
        let (held_tx, held_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let supply = &supply;
        let holder = threads.spawn(move || supply.with_db(ADDRESS, false, |_| {
            held_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok(())
        }).unwrap());
        held_rx.recv().unwrap();
        let held = supply.entry(ADDRESS).unwrap();
        for n in 0..idle_handles().unwrap() + 10 {
            let another = Command { address: format!("resource:idle-{n}"), ..task(&format!("idle-{n}")) };
            supply.invoke("provision", &json!({}), &another).unwrap();
            assert!(Arc::ptr_eq(&held, &supply.entry(ADDRESS).unwrap()));
        }
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        drop(held);
    });
    // More activity allows the now-idle first handle to leave; disk receipts
    // remain the authority regardless of which open handles are retained.
    for n in 0..idle_handles().unwrap() + 1 {
        let another = Command { address: format!("resource:later-{n}"), ..task(&format!("later-{n}")) };
        supply.invoke("provision", &json!({}), &another).unwrap();
    }
    assert!(supply.open.lock().unwrap().len() <= idle_handles().unwrap());
    assert_eq!(supply.reconcile("provision", &json!({}), &command).unwrap()["state"], "completed");
    assert_eq!(supply.invoke("provision", &json!({}), &command).unwrap()["revision"], "revision:1");
}


#[test]
fn an_unconfirmed_commit_does_not_leave_a_writer_transaction_for_the_next_call() {
    let dir = tempfile::tempdir().unwrap();
    let supply = DatabaseSupply::new(dir.path(), ConcurrentRights);
    supply.invoke("provision", &json!({}), &task("provision")).unwrap();
    supply.with_db(ADDRESS, false, |open| {
        open.db.authorizer(Some(|context: AuthContext<'_>| {
            match context.action {
                // rusqlite 0.32 classifies COMMIT as Unknown (Release is
                // savepoint RELEASE). The test denies that terminal action.
                AuthAction::Transaction { operation: rusqlite::hooks::TransactionOperation::Unknown } => Authorization::Deny,
                _ => Authorization::Allow,
            }
        }));
        Ok(())
    }).unwrap();
    let input = json!({"expected_revision": "revision:1", "sql": "CREATE TABLE candidate(value INTEGER)"});
    let error = supply.invoke("write", &input, &task("retry-same-key")).unwrap_err();
    assert_eq!(error.code, "database_commit_unconfirmed");
    assert_eq!(error.status, 503);
    assert_eq!(supply.reconcile("write", &input, &task("retry-same-key")).unwrap()["state"], "not_sent");
    assert_eq!(supply.close(ADDRESS).unwrap().as_deref(), Some("revision:1"));
    supply.invoke("write", &input, &task("retry-same-key")).unwrap();
    assert_eq!(supply.reconcile("write", &input, &task("retry-same-key")).unwrap()["state"], "completed");
}


fn addressed(address: &str, request_key: &str) -> Command {
    Command { address: address.into(), ..task(request_key) }
}

// Retain the production execution lease while a deterministic test barrier
// holds that exact slot, including its cold (not yet opened) state.
fn with_slot<R: Rights, T>(supply: &DatabaseSupply<R>, address: &str,
    work: impl FnOnce(&mut Option<Open>) -> Result<T, DbError>) -> Result<T, DbError> {
    let lease = supply.lease(address)?;
    let mut held = lease.slot.as_ref().unwrap().lock().map_err(|_| DatabaseSupply::<R>::unavailable(crate::cause!()))?;
    work(&mut held)
}

/// The timeout only bounds a failing implementation. Channels establish the hold and its release; B must return a
/// committed receipt and a fresh read of the committed row before the test sends the release, in both cache states.
#[test]
fn a_held_address_never_blocks_another_addresses_cold_or_warm_commit_and_read() {
    use std::{sync::mpsc, thread, time::Duration};
    for warm in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let supply = DatabaseSupply::new(dir.path(), ConcurrentRights);
        let a = "resource:independent-a";
        let b = "resource:independent-b";
        if warm {
            supply.invoke("provision", &json!({}), &addressed(a, "create-a")).unwrap();
            supply.invoke("provision", &json!({}), &addressed(b, "create-b")).unwrap();
        }
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        thread::scope(|scope| {
            let supply = &supply;
            let hold = scope.spawn(move || with_slot(supply, a, |held| {
                assert_eq!(held.is_some(), warm);
                if let Some(open) = held {
                    open.db.execute_batch("BEGIN IMMEDIATE").map_err(|error| sql_failure(error, crate::cause!()))?;
                }
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                if let Some(open) = held {
                    open.db.execute_batch("ROLLBACK").map_err(|error| sql_failure(error, crate::cause!()))?;
                }
                Ok(())
            }));
            entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            let work = scope.spawn(move || {
                let result = (|| {
                    if !warm {
                        supply.invoke("provision", &json!({}), &addressed(b, "create-b"))?;
                    }
                    let receipt = supply.invoke("transaction", &json!({ "expected_revision": "revision:1", "statements": [
                        { "sql": "CREATE TABLE independent (value integer)" },
                        { "sql": "INSERT INTO independent VALUES(73)" }
                    ] }), &addressed(b, "change-b"))?;
                    let read = supply.invoke("read", &json!({ "expected_revision": "revision:2", "sql": "SELECT value FROM independent" }), &addressed(b, "read-b"))?;
                    Ok::<_, DbError>((receipt, read))
                })();
                done_tx.send(result).unwrap();
            });
            let completed_while_a_held = done_rx.recv_timeout(Duration::from_secs(10));
            release_tx.send(()).unwrap();
            hold.join().unwrap().unwrap();
            work.join().unwrap();
            let (receipt, read) = completed_while_a_held.expect("B must finish before A is released").unwrap();
            assert_eq!(receipt["results"][1]["affected_rows"], 1);
            assert_eq!(read["rows"], json!([{ "value": 73 }]));
        });
    }
}

#[test]
fn same_address_waiters_share_one_slot_across_close_delete_and_reopen() {
    use std::{sync::mpsc, thread, time::Duration};
    let dir = tempfile::tempdir().unwrap();
    let supply = DatabaseSupply::new(dir.path(), ConcurrentRights);
    supply.invoke("provision", &json!({}), &task("create")).unwrap();
    let original = supply.entry(ADDRESS).unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (closed_tx, closed_rx) = mpsc::channel();
    let (lookup_tx, lookup_rx) = mpsc::channel();
    thread::scope(|scope| {
        let supply = &supply;
        let hold = scope.spawn(move || supply.with_db(ADDRESS, false, |open| {
            open.db.execute_batch("BEGIN IMMEDIATE; UPDATE _supply_state SET revision = 2 WHERE id = 1").map_err(|error| sql_failure(error, crate::cause!()))?;
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            open.db.execute_batch("COMMIT").map_err(|error| sql_failure(error, crate::cause!()))
        }));
        entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let close = scope.spawn(move || closed_tx.send(supply.close(ADDRESS)).unwrap());
        // Publishing/reusing the slot must remain possible while this address's writer and closer wait. Run it
        // on a worker so a regression that keeps the registry guard cannot deadlock the test's release path.
        let original_ref = &original;
        let lookup = scope.spawn(move || lookup_tx.send(Arc::ptr_eq(original_ref, &supply.entry(ADDRESS).unwrap())).unwrap());
        let lookup_while_held = lookup_rx.recv_timeout(Duration::from_secs(10));
        release_tx.send(()).unwrap();
        hold.join().unwrap().unwrap();
        let closed = closed_rx.recv_timeout(Duration::from_secs(10)).unwrap().unwrap();
        close.join().unwrap();
        lookup.join().unwrap();
        assert!(lookup_while_held.expect("registry lookup must finish before the address hold is released"));
        assert_eq!(closed.as_deref(), Some("revision:2"), "close follows the held writer");
    });
    assert!(Arc::ptr_eq(&original, &supply.entry(ADDRESS).unwrap()), "close must not strand queued callers in a retired slot");
    let read = supply.invoke("read", &json!({ "expected_revision": "revision:2", "sql": "SELECT 1 AS value" }), &task("reopen")).unwrap();
    assert_eq!(read["rows"], json!([{ "value": 1 }]));
    supply.invoke("lifecycle", &json!({ "action": "delete", "expected_revision": "revision:2" }), &task("delete")).unwrap();
    assert!(Arc::ptr_eq(&original, &supply.entry(ADDRESS).unwrap()), "delete must preserve the execution slot too");
    assert_eq!(supply.invoke("read", &json!({ "expected_revision": "revision:2", "sql": "SELECT 1" }), &task("deleted-read")).unwrap_err().code, "database_not_found");
    supply.invoke("provision", &json!({}), &task("recreate")).unwrap();
    assert!(Arc::ptr_eq(&original, &supply.entry(ADDRESS).unwrap()));
    assert_eq!(supply.reconcile("provision", &json!({}), &task("create")).unwrap()["state"], "not_sent", "the deleted file's receipt cannot survive in a stale open handle");
}

#[test]
fn simultaneous_cold_same_address_creation_has_one_commit_and_one_revision() {
    use std::{sync::Barrier, thread};
    let dir = tempfile::tempdir().unwrap();
    let supply = DatabaseSupply::new(dir.path(), ConcurrentRights);
    let start = Barrier::new(3);
    thread::scope(|scope| {
        let first = scope.spawn(|| {
            start.wait();
            supply.invoke("provision", &json!({}), &task("first-create"))
        });
        let second = scope.spawn(|| {
            start.wait();
            supply.invoke("provision", &json!({}), &task("second-create"))
        });
        start.wait();
        let results = [first.join().unwrap(), second.join().unwrap()];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter_map(|result| result.as_ref().err()).next().unwrap().code, "database_already_provisioned");
    });
    let revision = supply.with_db(ADDRESS, false, |open| DatabaseSupply::<ConcurrentRights>::revision(&open.db)).unwrap();
    assert_eq!(revision, 1);
}
