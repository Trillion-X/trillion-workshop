//! The command journal over a real temporary SQLite file holding the record store
//! store. These explicit fixture principals test transaction/capture behavior,
//! not installed account authority.
use super::*;
use rusqlite::{Transaction, TransactionBehavior};
use serde_json::json;

const PERMIT: &str = "fixture-atomic";
const OWNER: &str = "fixture-owner";
const EXECUTION: &str = "execution:fixture-atomic";
struct Fixture {
    _folder: tempfile::TempDir,
    path: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let folder = tempfile::tempdir().unwrap();
        let path = std::fs::canonicalize(folder.path())
            .unwrap()
            .join("source.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE business(value TEXT);
            CREATE TABLE execution(id TEXT PRIMARY KEY);
            CREATE TABLE result(identity TEXT PRIMARY KEY);
            INSERT INTO execution VALUES('execution:fixture-atomic');
            INSERT INTO result VALUES('1f:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd');").unwrap();
        drop(db);
        let bounds = crate::storage::sqlite::Bounds {
            value_bytes: 1024 * 1024,
            work: 2_000_000,
            deadline: std::time::Duration::from_secs(5),
            spend: crate::storage::sqlite::Spend::EachOperation,
            cancel: None,
            busy: std::time::Duration::ZERO,
        };
        drop(crate::storage::sqlite::open_owned(&path, "record_store", bounds).unwrap());
        Self {
            _folder: folder,
            path,
        }
    }
    fn open(&self) -> Connection {
        Connection::open(&self.path).unwrap()
    }
}
fn limits() -> Limits {
    Limits {
        max_record_bytes: 1024 * 1024,
        byte_budget: 1 << 30,
    }
}
fn binding() -> CommandBinding {
    CommandBinding {
        permit_id: PERMIT.into(),
        identity: "fixture-binding".into(),
        owner: OWNER.into(),
        resource: "fixture-resource".into(),
        generation: json!(1),
        operation: "fixture-operation".into(),
        request_key: "fixture-key".into(),
        input_identity: "a".repeat(64),
    }
}
fn context() -> String {
    json!({"permit_id":PERMIT,"owner":OWNER,"resource":"fixture-resource","generation":1,"operation":"fixture-operation","request_key":"fixture-key","input_identity":"a".repeat(64),"recorder":{"reader":"fixture-reader"}}).to_string()
}
fn receipt() -> Completion {
    Completion {
        result_identity: format!("1f:{}", "d".repeat(64)),
        native_nonretaining: false,
    }
}
struct Current {
    source: bool,
    public: bool,
}
impl Current {
    fn new() -> Self {
        Self {
            source: true,
            public: true,
        }
    }
}
impl CurrentCommand for Current {
    fn assert_current(&mut self, _: &Connection, _: &CommandBinding) -> Result<()> {
        if self.source && self.public {
            Ok(())
        } else {
            Err(trillion_local::cause!(Error::Changed))
        }
    }
    fn assert_capture(
        &mut self,
        db: &Connection,
        b: &CommandBinding,
        c: &Capture<'_>,
    ) -> Result<()> {
        self.assert_current(db, b)?;
        let count: i64 = db
            .query_row(
                "SELECT count(*) FROM execution WHERE id=?",
                [c.execution_ref],
                |r| r.get(0),
            )
            .unwrap();
        if count == 1 {
            Ok(())
        } else {
            Err(trillion_local::cause!(Error::Changed))
        }
    }
    fn assert_completion(
        &mut self,
        db: &Connection,
        _: &CommandBinding,
        c: &Completion,
    ) -> Result<()> {
        if !self.source {
            return Err(trillion_local::cause!(Error::Changed));
        }
        let count: i64 = db
            .query_row(
                "SELECT count(*) FROM result WHERE identity=?",
                [&c.result_identity],
                |r| r.get(0),
            )
            .unwrap();
        if count == 1 {
            Ok(())
        } else {
            Err(trillion_local::cause!(Error::Changed))
        }
    }
}
fn open<'a>(db: &'a Connection, current: &mut Current) -> CommandJournal<'a> {
    CommandJournal::open(db, current, binding(), limits(), crate::storage::record_store::settings::shipped().unwrap()).unwrap()
}
fn begin_with(
    journal: &mut CommandJournal<'_>,
    current: &mut Current,
    input: &str,
) -> Result<Load> {
    journal.begin_local_atomic(
        Capture {
            durable_input: input,
            durable_context: &context(),
            execution_ref: EXECUTION,
        },
        current,
    )
}
fn begin(journal: &mut CommandJournal<'_>, current: &mut Current) -> Result<Load> {
    begin_with(journal, current, "{}")
}
fn rows(db: &Connection, table: &str) -> i64 {
    db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn immediate(db: &Connection) -> Transaction<'_> {
    Transaction::new_unchecked(db, TransactionBehavior::Immediate).unwrap()
}
fn deferred(db: &Connection) -> Transaction<'_> {
    Transaction::new_unchecked(db, TransactionBehavior::Deferred).unwrap()
}
/// This permit's committed command record, read on the caller's held write transaction.
fn record(db: &Connection) -> Option<serde_json::Value> {
    InCommand::lend(db, OWNER, limits())
        .unwrap()
        .command(PERMIT)
        .unwrap()
        .1
}
/// The same read from a fresh write transaction of its own, rolled back.
fn committed(db: &Connection) -> Option<serde_json::Value> {
    let tx = immediate(db);
    let answer = record(&tx);
    tx.rollback().unwrap();
    answer
}
/// A committed record for this permit, written as an earlier invocation would have.
fn prefill_state(db: &Connection, context: &str, input: &str, state: &str) {
    let tx = immediate(db);
    let value = json!({"identity":"fixture-binding","operation":"fixture-operation","input":input,"context":context,
        "state":state,"result":{"result_ref":PERMIT,"result_identity":receipt().result_identity},"execution_ref":EXECUTION});
    InCommand::lend(&tx, OWNER, limits())
        .unwrap()
        .put_command(PERMIT, 0, value, || Ok(()))
        .unwrap();
    tx.commit().unwrap();
}
fn prefill(db: &Connection, context: &str, input: &str) {
    prefill_state(db, context, input, "committed");
}

#[test]
fn atomic_capture_writes_only_one_final_record_and_survives_cold_reopen() {
    let fixture = Fixture::new();
    let db = fixture.open();
    let tx = immediate(&db);
    let mut current = Current::new();
    let mut journal = open(&db, &mut current);
    let before = db.total_changes();
    assert!(matches!(
        begin(&mut journal, &mut current).unwrap(),
        Load::Fresh
    ));
    assert_eq!(
        db.total_changes(),
        before,
        "a capture writes nothing before completion"
    );
    assert!(record(&db).is_none());
    let rival = fixture.open();
    rival.busy_timeout(std::time::Duration::ZERO).unwrap();
    assert!(rival.execute_batch("BEGIN IMMEDIATE").is_err());
    db.execute("INSERT INTO business VALUES('effect')", [])
        .unwrap();
    journal.complete(&receipt(), &mut current).unwrap();
    let written = record(&db).expect("the committed record");
    assert_eq!(written["state"], "committed");
    assert_eq!(written["input"], "{}");
    let after = db.total_changes();
    journal.complete(&receipt(), &mut current).unwrap();
    assert_eq!(
        db.total_changes(),
        after,
        "a repeated completion proves the same receipt and writes nothing"
    );
    let other = Completion {
        result_identity: format!("1f:{}", "e".repeat(64)),
        native_nonretaining: false,
    };
    assert!(journal.complete(&other, &mut current).is_err());
    drop(journal);
    tx.commit().unwrap();
    drop(db);
    let db = fixture.open();
    let tx = immediate(&db);
    let mut journal = open(&db, &mut current);
    assert!(matches!(
        begin(&mut journal, &mut current).unwrap(),
        Load::Committed
    ));
    assert!(journal.exists(&mut current).unwrap());
    assert_eq!(rows(&db, "business"), 1);
    drop(journal);
    tx.rollback().unwrap();
}

#[test]
fn atomic_failure_rolls_back_effect_without_leaving_a_fresh_or_terminal_marker() {
    let fixture = Fixture::new();
    let db = fixture.open();
    let tx = immediate(&db);
    let mut current = Current::new();
    let mut journal = open(&db, &mut current);
    assert!(matches!(
        begin(&mut journal, &mut current).unwrap(),
        Load::Fresh
    ));
    db.execute("INSERT INTO business VALUES('must-roll-back')", [])
        .unwrap();
    current.source = false;
    assert!(matches!(journal.complete(&receipt(), &mut current), Err(Error::Changed(_))));
    drop(journal);
    tx.rollback().unwrap();
    assert_eq!(rows(&db, "business"), 0);
    assert!(committed(&db).is_none());
}

#[test]
fn atomic_pending_cannot_cross_commit_or_rollback_then_rebegin_on_same_handle() {
    for (mode, end) in [
        ("DELETE", "COMMIT"),
        ("DELETE", "ROLLBACK"),
        ("WAL", "COMMIT"),
        ("WAL", "ROLLBACK"),
    ] {
        let fixture = Fixture::new();
        let db = fixture.open();
        db.execute_batch(&format!("PRAGMA journal_mode={mode}"))
            .unwrap();
        db.execute_batch("BEGIN IMMEDIATE").unwrap();
        let mut current = Current::new();
        let mut journal = open(&db, &mut current);
        assert!(matches!(
            begin(&mut journal, &mut current).unwrap(),
            Load::Fresh
        ));
        db.execute("INSERT INTO business VALUES('effect')", [])
            .unwrap();
        db.execute_batch(&format!("{end}; BEGIN IMMEDIATE"))
            .unwrap();
        assert!(matches!(journal.complete(&receipt(), &mut current), Err(Error::Changed(_))));
        assert!(record(&db).is_none());
        db.execute_batch("ROLLBACK").unwrap();
    }
}

#[test]
fn a_committed_record_naming_other_work_or_another_capture_is_never_fresh() {
    let mut changed: serde_json::Value = serde_json::from_str(&context()).unwrap();
    changed["input_identity"] = json!("different-input");
    for (context, input, begin_input) in [
        (changed.to_string(), "{}".to_owned(), "{}"),
        (context(), "{}".to_owned(), r#"{"other":true}"#),
    ] {
        let fixture = Fixture::new();
        let db = fixture.open();
        prefill(&db, &context, &input);
        let tx = immediate(&db);
        let mut current = Current::new();
        let mut journal = open(&db, &mut current);
        assert!(matches!(
            begin_with(&mut journal, &mut current, begin_input),
            Err(Error::Conflict(_))
        ));
        drop(journal);
        tx.rollback().unwrap();
    }
}

/// Read the actual journal resource through the physical read-only supplier;
/// the journal parser receives only the value and has no write capability.
fn read_original_fixture(fixture: &Fixture, competing_writer: bool) -> Result<Option<Completion>> {
    let readers = crate::storage::record_store_resources::Readers::new(
        fixture.path.clone(),
        crate::sqlite_work::WorkMeter::new(),
    );
    readers
        .read(|store| -> std::result::Result<_, crate::records::Error> {
            let (_, held) = store.held_record_with_version(
                OWNER,
                crate::local_account::own_records::COMMANDS,
                PERMIT,
            )?;
            if competing_writer {
                let rival = fixture.open();
                rival.busy_timeout(std::time::Duration::ZERO).unwrap();
                rival
                    .execute_batch("BEGIN IMMEDIATE")
                    .expect("a real read-only snapshot holds no writer reservation");
                rival.execute_batch("ROLLBACK").unwrap();
            }
            Ok(read_original_record(
                &binding(),
                &Capture {
                    durable_input: "{}",
                    durable_context: &context(),
                    execution_ref: EXECUTION,
                },
                held.map(|record| record.value),
            ))
        })
        .unwrap()
}

#[test]
fn read_original_uses_a_physical_read_only_snapshot_and_matches_committed_capture() {
    let fixture = Fixture::new();
    let db = fixture.open();
    prefill(&db, &context(), "{}");
    let before = db.total_changes();
    assert_eq!(
        read_original_fixture(&fixture, true).unwrap(),
        Some(receipt())
    );
    assert_eq!(
        db.total_changes(),
        before,
        "readback writes no journal or result"
    );
}

#[test]
fn read_original_keeps_missing_partial_and_altered_results_unknown_or_refused() {
    let fixture = Fixture::new();
    assert_eq!(read_original_fixture(&fixture, false).unwrap(), None);
    for (state, input, expected) in [
        ("working", "{}", trillion_local::cause!(Error::Unknown)),
        ("committed", r#"{"changed":true}"#, trillion_local::cause!(Error::Conflict)),
    ] {
        let fixture = Fixture::new();
        let db = fixture.open();
        prefill_state(&db, &context(), input, state);
        assert_eq!(std::mem::discriminant(&read_original_fixture(&fixture, false).unwrap_err()), std::mem::discriminant(&expected));
    }
}

#[test]
fn legacy_receipt_route_wins_before_fresh_disjoint_record_selection() {
    use crate::local_account::resource_affinity::{
        native_binding, store::AffinityDirectory, Identity, ResourceAddress,
    };
    use crate::{sqlite_work::WorkMeter, storage::record_store_resources};
    let fixture = Fixture::new();
    let db = fixture.open();
    prefill(&db, &context(), "{}");
    let directory =
        AffinityDirectory::new(fixture._folder.path(), WorkMeter::new(), OWNER, "1").unwrap();
    let mut original = record_store_resources::open(&fixture.path, WorkMeter::new()).unwrap();
    let fresh = Identity {
        kind: "own-record".into(),
        id: "never-written-before".into(),
    };
    assert!(
        !native_binding::has_original_history(&mut original, OWNER, &[fresh.clone()]).unwrap(),
        "record history alone misses this permit's existing canonical receipt"
    );
    let expected = ResourceAddress {
        owner: OWNER.into(),
        resource: "@own-records".into(),
    };
    let verify = |address: &ResourceAddress| {
        assert_eq!(address, &expected);
        assert!(fixture.path.is_file());
        Ok(())
    };
    assert_eq!(
        native_binding::existing_own_command_route(
            &directory,
            &mut original,
            OWNER,
            PERMIT,
            verify
        )
        .unwrap(),
        Some(expected.clone())
    );
    assert!(
        directory
            .resolve_points(&[fresh], || Ok(()))
            .unwrap()
            .is_none(),
        "changed-input ids must not acquire affinity before the original receipt is consulted"
    );
    drop(original);
    let tx = immediate(&db);
    let mut current = Current::new();
    let mut journal = open(&db, &mut current);
    assert!(
        matches!(
            begin_with(
                &mut journal,
                &mut current,
                r#"{"id":"never-written-before"}"#
            ),
            Err(Error::Conflict(_))
        ),
        "the real original command journal must refuse changed input instead of declaring it fresh"
    );
    drop(journal);
    tx.rollback().unwrap();
    drop(directory);
    let directory =
        AffinityDirectory::new(fixture._folder.path(), WorkMeter::new(), OWNER, "1").unwrap();
    let mut original = record_store_resources::open(&fixture.path, WorkMeter::new()).unwrap();
    assert_eq!(
        native_binding::existing_own_command_route(
            &directory,
            &mut original,
            OWNER,
            PERMIT,
            verify
        )
        .unwrap(),
        Some(expected)
    );
}

#[test]
fn command_route_reserved_before_receipt_survives_restart_and_refuses_rebinding() {
    use crate::local_account::resource_affinity::{
        native_binding,
        store::{AffinityDirectory, StoreError},
        ResolveRequest, ResourceAddress,
    };
    use crate::{sqlite_work::WorkMeter, storage::record_store_resources};
    let fixture = Fixture::new();
    let directory =
        AffinityDirectory::new(fixture._folder.path(), WorkMeter::new(), OWNER, "1").unwrap();
    let request = ResolveRequest {
        owner: OWNER.into(),
        generation: "1".into(),
        identities: native_binding::own_record_route_identities(&["fresh-record".into()]).unwrap(),
        group: Some("fresh-record-group".into()),
    };
    let route = directory.install_and_resolve(&request, || Ok(())).unwrap();
    let selected = route.resolution.address.clone();
    let legacy = ResourceAddress {
        owner: OWNER.into(),
        resource: "@own-records".into(),
    };
    let verify = |address: &ResourceAddress| {
        if address == &legacy {
            assert!(fixture.path.is_file());
            return Ok(());
        }
        let complete = directory
            .resolve_points(&request.identities, || Ok(()))?
            .ok_or(trillion_local::cause!(StoreError::Unavailable))?;
        if &complete.resolution.address != address {
            return Err(trillion_local::cause!(StoreError::Conflict));
        }
        Ok(())
    };
    let mut original = record_store_resources::open(&fixture.path, WorkMeter::new()).unwrap();
    assert_eq!(
        native_binding::reserve_own_command_route(
            &directory,
            &mut original,
            OWNER,
            PERMIT,
            &selected,
            verify
        )
        .unwrap(),
        selected
    );
    assert!(
        original
            .held_record_with_version(OWNER, crate::local_account::own_records::COMMANDS, PERMIT)
            .unwrap()
            .1
            .is_none(),
        "the route reservation must not invent a receipt"
    );
    drop(original);
    let reopened =
        AffinityDirectory::new(fixture._folder.path(), WorkMeter::new(), OWNER, "1").unwrap();
    let mut original = record_store_resources::open(&fixture.path, WorkMeter::new()).unwrap();
    assert_eq!(
        native_binding::existing_own_command_route(&reopened, &mut original, OWNER, PERMIT, verify)
            .unwrap(),
        Some(selected.clone())
    );
    assert!(native_binding::reserve_own_command_route(
        &reopened,
        &mut original,
        OWNER,
        PERMIT,
        &legacy,
        verify
    )
    .is_err());
    assert_eq!(
        reopened
            .resolve_points(&request.identities, || Ok(()))
            .unwrap()
            .unwrap()
            .resolution
            .identities
            .len(),
        1,
        "command reservations never grow the record group's membership"
    );
    assert!(native_binding::existing_own_command_route(
        &reopened,
        &mut original,
        OWNER,
        PERMIT,
        |_| Err(trillion_local::cause!(StoreError::GenerationChanged))
    )
    .is_err());
    let db = fixture.open();
    prefill(&db, &context(), "{}");
    assert!(
        matches!(
            native_binding::existing_own_command_route(
                &reopened,
                &mut original,
                OWNER,
                PERMIT,
                verify
            ),
            Err(StoreError::Conflict(_))
        ),
        "a conflicting canonical receipt must never be hidden by an internal reservation"
    );
}

#[test]
fn atomic_known_completion_retains_custody_after_public_access_is_withdrawn() {
    let fixture = Fixture::new();
    let db = fixture.open();
    let tx = immediate(&db);
    let mut current = Current::new();
    let mut journal = open(&db, &mut current);
    assert!(matches!(
        begin(&mut journal, &mut current).unwrap(),
        Load::Fresh
    ));
    current.public = false;
    journal.complete(&receipt(), &mut current).unwrap();
    assert!(journal.load(&mut current).is_err());
    drop(journal);
    assert!(record(&db).is_some());
    tx.commit().unwrap();
}

#[test]
fn atomic_publication_cannot_lose_its_protected_result_and_pass_completion() {
    let fixture = Fixture::new();
    let db = fixture.open();
    let tx = immediate(&db);
    let mut current = Current::new();
    let mut journal = open(&db, &mut current);
    assert!(matches!(
        begin(&mut journal, &mut current).unwrap(),
        Load::Fresh
    ));
    db.execute("INSERT INTO business VALUES('must-roll-back')", [])
        .unwrap();
    db.execute("DELETE FROM result", []).unwrap();
    assert!(matches!(journal.complete(&receipt(), &mut current), Err(Error::Changed(_))));
    drop(journal);
    tx.rollback().unwrap();
    assert_eq!(rows(&db, "business"), 0);
    assert!(committed(&db).is_none());
    assert_eq!(rows(&db, "result"), 1);
}

#[test]
fn local_effect_freshness_uses_private_capture_without_changing_public_absence() {
    let fixture = Fixture::new();
    let db = fixture.open();
    let tx = immediate(&db);
    let mut current = Current::new();
    let mut journal = open(&db, &mut current);
    assert!(
        journal.assert_local_fresh(&mut current).is_err(),
        "no capture, no freshness"
    );
    assert!(matches!(
        begin(&mut journal, &mut current).unwrap(),
        Load::Fresh
    ));
    assert!(matches!(journal.load(&mut current).unwrap(), Load::Unknown));
    let before = db.total_changes();
    journal.assert_local_fresh(&mut current).unwrap();
    db.execute("INSERT INTO business VALUES('local effect')", [])
        .unwrap();
    journal.assert_local_fresh(&mut current).unwrap();
    assert_eq!(db.total_changes(), before + 1);
    assert!(record(&db).is_none());
    current.source = false;
    assert!(journal.assert_local_fresh(&mut current).is_err());
    tx.rollback().unwrap();
}

#[test]
fn local_effect_freshness_rejects_a_record_that_appeared_under_the_capture() {
    let fixture = Fixture::new();
    let db = fixture.open();
    let tx = immediate(&db);
    let mut current = Current::new();
    let mut journal = open(&db, &mut current);
    assert!(matches!(
        begin(&mut journal, &mut current).unwrap(),
        Load::Fresh
    ));
    let value = json!({"identity":"fixture-binding","operation":"fixture-operation","input":"{}","context":context(),
        "state":"committed","result":{"result_ref":PERMIT,"result_identity":receipt().result_identity},"execution_ref":EXECUTION});
    InCommand::lend(&db, OWNER, limits())
        .unwrap()
        .put_command(PERMIT, 0, value, || Ok(()))
        .unwrap();
    assert!(journal.assert_local_fresh(&mut current).is_err());
    assert!(matches!(journal.complete(&receipt(), &mut current), Err(Error::Conflict(_))));
    tx.rollback().unwrap();
}
