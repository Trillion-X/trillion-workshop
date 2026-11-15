//! Actual selected-account SQLite consumers of the concrete native producer.
//! Operation/binding/schema DATA is synthetic and deliberately named fixture.
//! No callback stands in for capture, result encryption, keys or record reads:
//! a command writes the account's own records, their keys and its command
//! record to record store only, in its one transaction, and these controls attack each.
use super::*;
use content_crypto::advanced::blake3;
use std::{
    cell::Cell,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use trillion_local::{
    ecma_json::{self, JsString, Value as Ecma},
    local_account::record_writer::{
        native_command_context::{NativeCommandCall, NativeCommandResult, NativeTransaction},
        Error, Result as NativeResult,
    },
    record_log::{Context, LogIds, Request},
    records::{Mutation, Records},
    storage::{
        record_store::{settings, RecordStore, RealClock},
        sqlite::{self, Bounds, Spend},
    },
    workspace::WorkspaceSession,
    workspace_domain::DomainCommand,
};

const CURRENT: i64 = i64::MAX;

fn ecma(raw: &str) -> Ecma {
    ecma_json::parse(raw.as_bytes(), Default::default()).unwrap()
}
fn encoded(v: &Ecma) -> String {
    ecma_json::stringify(v, Default::default()).unwrap()
}
/// An account whose original records hold one page and an (empty) erasable-key table, as the old engine left it.
fn setup() -> Fixture {
    let f = Fixture::new().with_workspace("@own-records");
    add_current_record_log(&f, "{}");
    Connection::open(f.root.join("records.sqlite")).unwrap().execute_batch(
        "ALTER TABLE record_log ADD COLUMN keys TEXT;
         CREATE TABLE record_erasable_keys(record_id TEXT PRIMARY KEY,key BLOB,erased_at TEXT,erased_fields TEXT) WITHOUT ROWID;"
    ).unwrap();
    f
}
/// Open the account and run its first start: the migration fills the account's own records (record store) before any
/// command, as the native startup task does before the app is served. A command record then needs its execution
/// record before it: record store writes both in the command's one transaction, in that order.
fn open(f: &Fixture) -> LocalAccount {
    let mut owner = f.open().unwrap();
    first_start(&mut owner, &f.session);
    Connection::open(f.root.join("records.sqlite")).unwrap().execute_batch(
        &format!("CREATE TRIGGER capture_before_command BEFORE INSERT ON versions
         WHEN NEW.resource='own-commands' AND NOT EXISTS(SELECT 1 FROM versions WHERE resource='own-records' AND id='execution:'||NEW.id AND valid_to={CURRENT})
         BEGIN SELECT RAISE(ABORT,'execution must precede command'); END;")
    ).unwrap();
    owner
}
fn bounds() -> Bounds {
    Bounds {
        value_bytes: 2 * 1024 * 1024,
        work: u64::MAX / 2,
        deadline: Duration::MAX,
        spend: Spend::EachOperation,
        cancel: None,
        busy: Duration::from_secs(5),
    }
}
fn store(f: &Fixture) -> RecordStore<sqlite::Supply<Connection>> {
    let supply = sqlite::open_owned(&f.root.join("records.sqlite"), "record_store", bounds()).unwrap();
    RecordStore::new(supply, Box::new(RealClock), settings::Limits::fixed(1 << 20, 10 << 30)).unwrap()
}
fn account() -> String {
    "a".repeat(64)
}
/// The current body of one record of one of the account's record store resources.
fn current(f: &Fixture, resource: &str, id: &str) -> Option<Value> {
    store(f).get(&account(), resource, id).unwrap().record.map(|record| record.value)
}
/// Replace (or delete, for None) one current record of one of the account's record store resources, as a hostile or broken
/// writer would.
fn rewrite(f: &Fixture, resource: &str, id: &str, change: impl FnOnce(Value) -> Option<Value>) {
    let mut store = store(f);
    let (version, held) = store.held_record_with_version(&account(), resource, id).unwrap();
    let next = change(held.map(|record| record.value).unwrap_or(Value::Null));
    store.mutate(&account(), resource, Mutation {
        id: id.into(),
        expected_version: version,
        request_key: format!("fixture-rewrite-{resource}-{id}-{version}"),
        deleted: next.is_none(),
        value: next.unwrap_or(Value::Null),
    }).unwrap();
}
/// Every record store version row (history included): any write adds one.
fn current_rows(f: &Fixture) -> i64 {
    Connection::open(f.root.join("records.sqlite")).unwrap()
        .query_row("SELECT COUNT(*) FROM versions", [], |row| row.get(0)).unwrap()
}
/// Version rows of the account's own records, its command records and its field keys.
fn counts(f: &Fixture) -> (i64, i64, i64) {
    let db = Connection::open(f.root.join("records.sqlite")).unwrap();
    let rows = |resource: &str| -> i64 {
        db.query_row("SELECT COUNT(*) FROM versions WHERE resource=?", [resource], |r| r.get(0)).unwrap()
    };
    (rows("own-records"), rows("own-commands"), rows("own-record-keys"))
}
fn added(after: (i64, i64, i64), before: (i64, i64, i64)) -> (i64, i64, i64) {
    (after.0 - before.0, after.1 - before.1, after.2 - before.2)
}
/// The old engine's tables the account still holds for the one-time migration: a command writes none of them.
fn old_rows(f: &Fixture) -> (i64, i64) {
    let db = Connection::open(f.root.join("records.sqlite")).unwrap();
    (
        db.query_row("SELECT COUNT(*) FROM record_log", [], |r| r.get(0)).unwrap(),
        db.query_row("SELECT COUNT(*) FROM record_erasable_keys", [], |r| r.get(0)).unwrap(),
    )
}
#[derive(Default)]
struct Ids(u16);
impl LogIds for Ids {
    fn next_log_id(&mut self) -> Option<String> {
        self.0 += 1;
        Some(format!("01234567-89ab-7{:03x}-8f01-000000000001", self.0))
    }
}
struct Parent {
    session: WorkspaceSession,
    command: DomainCommand,
    schema: Ecma,
    permit: String,
    identity: String,
    request: Request,
    context: Context,
}
impl Parent {
    fn new(owner: &mut LocalAccount, key: &str) -> Self {
        let raw = owner.session_identity();
        let admission = current_browser(owner, &raw).unwrap();
        Self {
            session: WorkspaceSession {
                account_id: admission.account.user_id.clone(),
                session_id: raw.to_string(),
            },
            command: DomainCommand {
                operation: "fixture:setting-batch".into(),
                input: json!({"secret":"PRIVATE_INPUT_CANARY","visible":true}),
                request_key: key.into(),
                key_carried: true,
            },
            schema: ecma(
                r#"{"type":"object","properties":{"secret":{"type":"string","writeOnly":true},"visible":{"type":"boolean"}}}"#,
            ),
            permit: format!("fixture-command:{key}"),
            identity: format!("1f:{}", blake3::hash(key.as_bytes()).to_hex()),
            request: Request {
                key: key.into(),
                sent_at_ms: 1,
            },
            context: Context {
                actor: json!({"ignored":"UNTRUSTED_ACTOR_CANARY"}),
                application_time: "2026-10-26T00:00:00.000Z".into(),
                system_time: "2026-10-26T00:00:00.000Z".into(),
                accepted_at_ms: 1,
            },
        }
    }
    fn result_id(&self) -> String {
        format!("resource-command-result:{}", self.permit)
    }
    fn invoke<F>(
        &self,
        owner: &mut LocalAccount,
        ids: &mut Ids,
        cancel: Arc<AtomicBool>,
        effect: F,
    ) -> NativeResult<NativeCommandResult>
    where
        F: FnOnce(&mut NativeTransaction<'_, '_, '_>) -> NativeResult<()>,
    {
        owner.execute_native_setting_batch(
            &NativeCommandCall {
                session: &self.session,
                cancel,
                command: &self.command,
                input_schema: &self.schema,
                permit_id: &self.permit,
                original_identity: &self.identity,
                request: &self.request,
                log_context: &self.context,
                deadline: Instant::now() + Duration::from_secs(5),
            },
            ids,
            effect,
        )
    }
}
fn stop() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}
fn stored(body: &Value) -> Value {
    serde_json::from_str(body["stored"].as_str().unwrap()).unwrap()
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn actual_parent_capture_multi_cas_result_and_completion_are_atomic_in_one_record_store_transaction() {
    let f = setup();
    let mut owner = open(&f);
    let parent = Parent::new(&mut owner, "multi");
    let mut ids = Ids::default();
    let (before, old_before) = (counts(&f), old_rows(&f));
    let answer = parent
        .invoke(&mut owner, &mut ids, stop(), |tx| {
            tx.compare_and_set_setting(&JsString::from("private-name"), None, &Ecma::Bool(true))?;
            tx.compare_and_set_setting(
                &JsString::from("private-name"),
                Some(&Ecma::Bool(true)),
                &Ecma::Bool(false),
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        encoded(&answer.value),
        r#"{"changed":true,"write_count":2}"#
    );
    assert!(!answer.duplicate);
    assert_eq!(answer.work.journal_rows_appended, 0, "nothing is appended to the old journal");
    // Two setting versions, the execution and the sealed result, and the result's key.
    assert_eq!(answer.work.business_envelopes_appended, 5);
    // The setting's first version is history beside its current one; one command record; one new key.
    assert_eq!(added(counts(&f), before), (4, 1, 1));
    assert_eq!(old_rows(&f), old_before);
    let command = current(&f, "own-commands", &parent.permit).unwrap();
    assert_eq!(command["state"], "committed");
    let input = command["input"].as_str().unwrap();
    assert!(!input.contains("PRIVATE_INPUT_CANARY"));
    assert!(input.contains("[write-only]"));
    assert!(!command["context"].as_str().unwrap().contains("UNTRUSTED_ACTOR_CANARY"));
    assert_eq!(command["result"]["result_ref"], parent.permit);
    assert!(command["result"]["result_identity"].as_str().unwrap().starts_with("1f:"));
    assert_eq!(command["execution_ref"], format!("execution:{}", parent.permit));
    let execution = current(&f, "own-records", &format!("execution:{}", parent.permit)).unwrap();
    assert_eq!(stored(&execution)["phase"], "returned");
    let result = current(&f, "own-records", &parent.result_id()).unwrap();
    assert_eq!(result["protected"], true);
    let sealed = result["stored"].as_str().unwrap();
    assert!(sealed.contains("\\u0000sealed"));
    assert!(!sealed.contains("write_count"));
    assert!(current(&f, "own-record-keys", &parent.result_id()).unwrap()["key"].is_string());
    let db = Connection::open(f.root.join("records.sqlite")).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM versions WHERE instr(CAST(body AS TEXT),'PRIVATE_INPUT_CANARY')>0", [], |r| r.get::<_, i64>(0)).unwrap(),
        0,
        "no record, key or command record keeps the write-only input"
    );
    drop(db);
    let record = owner
        .current_logical_record(
            &parent.session.session_id,
            "setting:private-name",
            Default::default(),
            stop(),
        )
        .unwrap();
    assert_eq!(encoded(record.unwrap().value()), r#"{"value":false}"#);
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn committed_retry_and_cold_restart_decrypt_original_result_without_dispatch_or_remint() {
    let f = setup();
    let mut ids = Ids::default();
    let parent;
    {
        let mut owner = open(&f);
        parent = Parent::new(&mut owner, "retry");
        parent
            .invoke(&mut owner, &mut ids, stop(), |tx| {
                tx.compare_and_set_setting(&"one".into(), None, &Ecma::Bool(true))?;
                Ok(())
            })
            .unwrap();
    }
    let before = current_rows(&f);
    let mut owner = f.open().unwrap();
    let calls = Cell::new(0);
    let answer = parent
        .invoke(&mut owner, &mut ids, stop(), |_| {
            calls.set(calls.get() + 1);
            Err(trillion_local::cause!(Error::Refused))
        })
        .unwrap();
    assert!(answer.duplicate);
    assert_eq!(calls.get(), 0);
    assert_eq!(
        encoded(&answer.value),
        r#"{"changed":true,"write_count":1}"#
    );
    assert_eq!(current_rows(&f), before);
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn result_write_failure_rolls_back_execution_command_and_every_setting() {
    let f = setup();
    let mut owner = open(&f);
    Connection::open(f.root.join("records.sqlite")).unwrap().execute_batch(
        "CREATE TRIGGER refuse_result BEFORE INSERT ON versions WHEN NEW.resource='own-records' AND NEW.id LIKE 'resource-command-result:%'
         BEGIN SELECT RAISE(ABORT,'fixture result owner failure'); END"
    ).unwrap();
    let parent = Parent::new(&mut owner, "rollback");
    let before = current_rows(&f);
    assert!(parent
        .invoke(&mut owner, &mut Ids::default(), stop(), |tx| {
            tx.compare_and_set_setting(&"one".into(), None, &Ecma::Bool(true))?;
            Ok(())
        })
        .is_err());
    assert_eq!(current_rows(&f), before);
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn completion_failure_after_keyed_result_write_rolls_back_its_key_and_all_work() {
    let f = setup();
    let mut owner = open(&f);
    Connection::open(f.root.join("records.sqlite")).unwrap().execute_batch(
        "CREATE TRIGGER refuse_complete BEFORE INSERT ON versions WHEN NEW.resource='own-commands'
         BEGIN SELECT RAISE(ABORT,'fixture terminal failure'); END"
    ).unwrap();
    let parent = Parent::new(&mut owner, "terminal-rollback");
    let before = current_rows(&f);
    assert!(parent
        .invoke(&mut owner, &mut Ids::default(), stop(), |tx| {
            tx.compare_and_set_setting(&"one".into(), None, &Ecma::Bool(true))?;
            Ok(())
        })
        .is_err());
    assert_eq!(current_rows(&f), before);
    assert!(current(&f, "own-record-keys", &parent.result_id()).is_none());
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn a_held_result_key_refuses_before_local_work_is_invoked() {
    let f = setup();
    let mut owner = open(&f);
    let parent = Parent::new(&mut owner, "held-key");
    rewrite(&f, "own-record-keys", &parent.result_id(), |_| Some(json!({"key": "AAAA"})));
    let before = current_rows(&f);
    let calls = Cell::new(0);
    assert!(parent
        .invoke(&mut owner, &mut Ids::default(), stop(), |_| {
            calls.set(calls.get() + 1);
            Ok(())
        })
        .is_err());
    assert_eq!(calls.get(), 0);
    assert_eq!(current_rows(&f), before);
    assert!(current(&f, "own-commands", &parent.permit).is_none());
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn a_command_before_the_migration_is_ready_refuses_without_writes() {
    let f = setup();
    let mut owner = f.open().unwrap();
    let parent = Parent::new(&mut owner, "not-ready");
    let calls = Cell::new(0);
    assert!(matches!(parent
            .invoke(&mut owner, &mut Ids::default(), stop(), |_| {
                calls.set(calls.get() + 1);
                Ok(())
            })
            .unwrap_err(), Error::Source(_)));
    assert_eq!(calls.get(), 0);
    assert!(current(&f, "own-commands", &parent.permit).is_none());
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn caught_cas_failure_cannot_commit_an_earlier_setting_or_partial_parent() {
    let f = setup();
    let mut owner = open(&f);
    let parent = Parent::new(&mut owner, "caught-conflict");
    let before = current_rows(&f);
    assert!(parent
        .invoke(&mut owner, &mut Ids::default(), stop(), |tx| {
            tx.compare_and_set_setting(&"one".into(), None, &Ecma::Bool(true))?;
            assert!(tx
                .compare_and_set_setting(&"one".into(), None, &Ecma::Bool(false))
                .is_err());
            Ok(())
        })
        .is_err());
    assert_eq!(current_rows(&f), before);
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn cancellation_after_a_local_write_rolls_back_the_whole_parent() {
    let f = setup();
    let mut owner = open(&f);
    let parent = Parent::new(&mut owner, "cancel");
    let cancelled = stop();
    let inside = cancelled.clone();
    let before = current_rows(&f);
    assert!(parent
        .invoke(&mut owner, &mut Ids::default(), cancelled, |tx| {
            tx.compare_and_set_setting(&"one".into(), None, &Ecma::Bool(true))?;
            inside.store(true, Ordering::Release);
            Ok(())
        })
        .is_err());
    assert_eq!(current_rows(&f), before);
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn full_input_change_under_same_original_binding_refuses_before_dispatch() {
    let f = setup();
    let mut owner = open(&f);
    let mut parent = Parent::new(&mut owner, "identity");
    let mut ids = Ids::default();
    parent
        .invoke(&mut owner, &mut ids, stop(), |_| Ok(()))
        .unwrap();
    let before = current_rows(&f);
    parent.command.input["secret"] = json!("DIFFERENT_PRIVATE_INPUT");
    let calls = Cell::new(0);
    assert!(parent
        .invoke(&mut owner, &mut ids, stop(), |_| {
            calls.set(calls.get() + 1);
            Ok(())
        })
        .is_err());
    assert_eq!(calls.get(), 0);
    assert_eq!(current_rows(&f), before);
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn a_command_record_not_committed_is_never_relabelled_fresh_or_redispatched() {
    let f = setup();
    let mut owner = open(&f);
    let parent = Parent::new(&mut owner, "unknown");
    let mut ids = Ids::default();
    parent
        .invoke(&mut owner, &mut ids, stop(), |_| Ok(()))
        .unwrap();
    rewrite(&f, "own-commands", &parent.permit, |mut record| {
        record["state"] = json!("working");
        Some(record)
    });
    let before = current_rows(&f);
    let calls = Cell::new(0);
    assert!(matches!(parent
            .invoke(&mut owner, &mut ids, stop(), |_| {
                calls.set(calls.get() + 1);
                Ok(())
            })
            .unwrap_err(), Error::OutcomeUnknown(_)));
    assert_eq!(calls.get(), 0);
    assert_eq!(current_rows(&f), before);
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn erased_original_result_withholds_and_cannot_mint_a_new_key_or_dispatch() {
    let f = setup();
    let mut owner = open(&f);
    let parent = Parent::new(&mut owner, "erase");
    let mut ids = Ids::default();
    parent
        .invoke(&mut owner, &mut ids, stop(), |_| Ok(()))
        .unwrap();
    rewrite(&f, "own-record-keys", &parent.result_id(), |_| Some(json!({"erased": true})));
    let before = current_rows(&f);
    let calls = Cell::new(0);
    assert!(matches!(parent
            .invoke(&mut owner, &mut ids, stop(), |_| {
                calls.set(calls.get() + 1);
                Ok(())
            })
            .unwrap_err(), Error::ProtectedResultUnavailable(_)));
    assert_eq!(calls.get(), 0);
    assert_eq!(current_rows(&f), before);
    assert_eq!(current(&f, "own-commands", &parent.permit).unwrap()["state"], "committed");
    assert_eq!(current(&f, "own-record-keys", &parent.result_id()).unwrap(), json!({"erased": true}));
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn noop_setting_still_captures_one_parent_and_protected_fixed_metadata_result() {
    let f = setup();
    let mut owner = open(&f);
    let parent = Parent::new(&mut owner, "noop");
    let before = counts(&f);
    let answer = parent
        .invoke(&mut owner, &mut Ids::default(), stop(), |tx| {
            tx.compare_and_set_setting(&"absent".into(), None, &Ecma::Null)?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        encoded(&answer.value),
        r#"{"changed":false,"write_count":1}"#
    );
    // The execution and the result, one command record, the result's key: the no-op setting writes nothing.
    assert_eq!(added(counts(&f), before), (2, 1, 1));
    assert!(current(&f, "own-records", "setting:absent").is_none());
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn result_key_withdrawal_during_its_write_rolls_back_all_effects() {
    let f = setup();
    let mut owner = open(&f);
    Connection::open(f.root.join("records.sqlite")).unwrap().execute_batch(
        "CREATE TRIGGER withdraw_written_key AFTER INSERT ON versions WHEN NEW.resource='own-record-keys'
         BEGIN UPDATE versions SET body=CAST('{\"erased\":true}' AS BLOB)
           WHERE account=NEW.account AND resource=NEW.resource AND id=NEW.id AND valid_to=NEW.valid_to; END;"
    ).unwrap();
    let parent = Parent::new(&mut owner, "result-key-withdrawal");
    let before = current_rows(&f);
    assert!(parent.invoke(&mut owner, &mut Ids::default(), stop(), |tx| {
        tx.compare_and_set_setting(&"one".into(), None, &Ecma::Bool(true))?;
        Ok(())
    }).is_err());
    assert_eq!(current_rows(&f), before);
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn orphan_existing_execution_cannot_be_hidden_by_local_memory_capture() {
    let f = setup();
    let mut owner = open(&f);
    let parent = Parent::new(&mut owner, "batch-orphan");
    let mut ids = Ids::default();
    parent.invoke(&mut owner, &mut ids, stop(), |_| Ok(())).unwrap();
    rewrite(&f, "own-commands", &parent.permit, |_| None);
    let before = current_rows(&f);
    let calls = Cell::new(0);
    assert!(matches!(parent.invoke(&mut owner, &mut ids, stop(), |_| {
        calls.set(calls.get()+1);
        Ok(())
    }).unwrap_err(), Error::OutcomeUnknown(_)));
    assert_eq!(calls.get(), 0);
    assert_eq!(current_rows(&f), before);
}

#[test]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
fn a_native_setting_writes_record_store_only_in_the_same_command_transaction() {
    let f = setup();
    let mut owner = open(&f);
    let parent = Parent::new(&mut owner, "s2h-setting");
    #[cfg(feature = "sql-statement-attribution")]
    unsafe { owner.enable_native_fixture_statements(512).unwrap(); }
    let mut ids = Ids::default();
    let (before, old_before) = (counts(&f), old_rows(&f));
    let work_before = owner.sql_work().unwrap().work;
    let answer = parent.invoke(&mut owner, &mut ids, stop(), |tx| {
        tx.compare_and_set_setting(&"one".into(), None, &Ecma::Bool(true))?;
        Ok(())
    }).unwrap();
    let work_after = owner.sql_work().unwrap().work;
    let written = added(counts(&f), before);
    eprintln!("native-record-store-setting {}", json!({"sql":work_after.sql_statements-work_before.sql_statements,
        "visits":work_after.sqlite_scan_visits-work_before.sqlite_scan_visits,
        "row_changes":work_after.rows_written-work_before.rows_written,
        "s2h_versions":{"own-records":written.0,"own-commands":written.1,"own-record-keys":written.2},
        "old_engine_rows_written":0}));
    #[cfg(feature = "sql-statement-attribution")]
    {
        let detail = owner.native_fixture_statement_snapshot().unwrap();
        assert!(detail.complete, "fixture SQL attribution was incomplete");
        eprintln!("native-record-store-attribution-unattributed {:?}", detail.unattributed_work);
        let mut statements = detail.statements.into_iter()
            .filter(|row| row.work.sqlite_scan_visits > 0 || row.work.rows_written > 0)
            .collect::<Vec<_>>();
        statements.sort_by(|a, b| b.work.sqlite_scan_visits.cmp(&a.work.sqlite_scan_visits)
            .then_with(|| b.work.rows_written.cmp(&a.work.rows_written)));
        for row in statements {
            eprintln!("native-record-store-template visits={} changes={} sql={}",
                row.work.sqlite_scan_visits, row.work.rows_written, row.sql_template);
        }
    }
    assert!(!answer.duplicate);
    assert_eq!(written, (3, 1, 1), "setting, execution and result; one command record; one key");
    assert_eq!(old_rows(&f), old_before, "the old journal and key table are never written");
    let setting = current(&f, "own-records", "setting:one").unwrap();
    assert_eq!(setting["kind"], "setting");
    assert_eq!(stored(&setting), json!({"value": true}));
    let execution = current(&f, "own-records", &format!("execution:{}", parent.permit)).unwrap();
    assert_eq!(execution["kind"], "execution");
    assert_eq!(stored(&execution)["phase"], "returned");
    let result = current(&f, "own-records", &parent.result_id()).unwrap();
    assert_eq!(result["kind"], "resource-command-result");
    assert_eq!(result["protected"], true);
    let retry_before = owner.sql_work().unwrap().work;
    let rows_before = current_rows(&f);
    let replay = parent.invoke(&mut owner, &mut ids, stop(), |_| panic!("retry ran effect")).unwrap();
    let retry_after = owner.sql_work().unwrap().work;
    assert!(replay.duplicate);
    assert_eq!(replay.work.sqlite_user_rows_changed, 0);
    assert_eq!(retry_after.rows_written - retry_before.rows_written, 0);
    assert_eq!(current_rows(&f), rows_before);
    assert_eq!(counts(&f).1 - before.1, 1, "retry kept one original command");
}
