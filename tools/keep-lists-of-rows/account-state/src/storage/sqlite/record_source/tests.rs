use super::ReadPhase;
use crate::{
    import::{ImportError, ReadLimits},
    record_source::{BoundedRecordSql, QueryBudget},
    storage::{self, sqlite, Intent, Scope, Storage, Value, When},
};
use crate::storage::sqlite::{Access, Bounds, Selected, Spend};
use rusqlite::{types::Value as SqlValue, Connection};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

fn selected_store() -> (tempfile::TempDir, sqlite::Supply<sqlite::Handle>) {
    let temp = tempfile::tempdir().unwrap();
    // `open_selected` applies SQLITE_OPEN_NOFOLLOW, so normalize the temporary
    // directory path just like the selected-source conformance fixture.
    let path = std::fs::canonicalize(temp.path()).unwrap().join("current.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE record_log(id TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE record_keys_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO record_keys_meta VALUES('record:one', '{\"id\":\"record:one\"}');",
    )
    .unwrap();
    drop(db);
    let store = sqlite::open_selected(
        &path,
        "record_log",
        Selected {
            access: Access::Write,
            bounds: Bounds {
                value_bytes: 1024 * 1024,
                work: 2_000_000,
                deadline: Duration::from_secs(5),
                spend: Spend::EachOperation,
                cancel: None,
                busy: Duration::ZERO,
            },
            meter: None,
            trusted_schema: true,
        },
    )
    .unwrap();
    (temp, store)
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

fn expect_import<T>(result: crate::import::ImportResult<T>) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("{error}"),
    }
}

fn ready_witness() -> impl FnMut() -> crate::import::ImportResult<()> {
    || Ok(())
}

fn canonical_point(
    phase: &mut impl BoundedRecordSql,
) -> crate::import::ImportResult<crate::import::QueryRows> {
    phase.query(
        "SELECT value FROM record_keys_meta WHERE key=?1 LIMIT 1",
        &[SqlValue::Text("record:one".into())],
    )
}

#[test]
fn read_phase_requires_a_held_write_scope_and_reports_its_real_write_state() {
    let (_temp, store) = selected_store();
    assert!(matches!(
        ReadPhase::new(
            &store,
            ready_witness(),
            ReadLimits::default(),
            Arc::new(AtomicBool::new(false)),
            deadline(),
        ),
        Err(ImportError::Refused(_, _))
    ));

    let scope = Scope::begin(&store, Intent::Write).unwrap();
    let mut phase = expect_import(ReadPhase::new(
        &store,
        ready_witness(),
        ReadLimits::default(),
        Arc::new(AtomicBool::new(false)),
        deadline(),
    ));
    let state = expect_import(phase.read_source_state());
    assert!(state.scoped && state.writing && state.custody && state.usable);

    // The older readonly loan is deliberately incompatible with this write phase.
    assert!(matches!(
        sqlite::bounded::lend(
            &mut phase,
            "record_log",
            QueryBudget { rows: 4, source_bytes: 1024, deadline: deadline() },
        ),
        Err(storage::Error::Moved(_))
    ));
    scope.rollback().unwrap();
}

#[test]
fn same_supply_write_invalidates_canonical_reads_but_current_can_validate_publication() {
    let (_temp, store) = selected_store();
    let scope = Scope::begin(&store, Intent::Write).unwrap();
    let mut phase = expect_import(ReadPhase::new(
        &store,
        ready_witness(),
        ReadLimits::default(),
        Arc::new(AtomicBool::new(false)),
        deadline(),
    ));

    let canonical = expect_import(canonical_point(&mut phase));
    assert_eq!(canonical.rows.len(), 1);

    // This is the same supply that owns the held scope. A typed write through it changes its mutation count.
    store
        .put(
            "record_keys_meta",
            &[
                ("key", Value::from("record:published")),
                ("value", Value::from("{\"id\":\"record:published\"}")),
            ],
            When::New,
        )
        .unwrap();
    assert!(matches!(canonical_point(&mut phase), Err(ImportError::Refused(_, _))));

    // The fresh witness remains authoritative for validating publication after the expected same-handle write.
    // `current` checks custody and current authority without pretending old canonical reads are still fresh.
    expect_import(phase.current());
    assert!(matches!(canonical_point(&mut phase), Err(ImportError::Refused(_, _))));
    scope.commit().unwrap();
}

#[test]
fn typed_facade_reads_the_same_held_supply_and_invalidates_after_mutation() {
    let (_temp, store) = selected_store();
    let scope = Scope::begin(&store, Intent::Write).unwrap();
    let mut phase = expect_import(ReadPhase::new(
        &store,
        ready_witness(),
        ReadLimits::default(),
        Arc::new(AtomicBool::new(false)),
        deadline(),
    ));

    let typed = phase
        .typed("record_log", QueryBudget { rows: 8, source_bytes: 4096, deadline: deadline() })
        .unwrap();
    let row = typed
        .get("record_keys_meta", &[Value::from("record:one")], &[storage::Read::whole("value")])
        .unwrap()
        .unwrap();
    assert_eq!(row.0, [Value::from("{\"id\":\"record:one\"}")]);

    store
        .put(
            "record_keys_meta",
            &[
                ("key", Value::from("record:published")),
                ("value", Value::from("{\"id\":\"record:published\"}")),
            ],
            When::New,
        )
        .unwrap();
    assert_eq!(
        typed.get("record_keys_meta", &[Value::from("record:one")], &[storage::Read::whole("value")]),
        Err(crate::cause!(storage::Error::Unavailable)),
    );
    drop(typed);
    scope.rollback().unwrap();
}

#[test]
fn typed_facade_refuses_after_cancellation() {
    let (_temp, store) = selected_store();
    let scope = Scope::begin(&store, Intent::Write).unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let mut phase = expect_import(ReadPhase::new(&store, ready_witness(), ReadLimits::default(), cancel.clone(), deadline()));
    let typed = phase
        .typed("record_log", QueryBudget { rows: 8, source_bytes: 4096, deadline: deadline() })
        .unwrap();
    cancel.store(true, Ordering::Release);
    assert_eq!(
        typed.get("record_keys_meta", &[Value::from("record:one")], &[storage::Read::whole("value")]),
        Err(crate::cause!(storage::Error::Interrupted)),
    );
    drop(typed);
    scope.rollback().unwrap();
}

#[test]
fn nested_close_failure_poisons_the_read_phase_custody_check() {
    let (_temp, store) = selected_store();
    let outer = Scope::begin(&store, Intent::Write).unwrap();
    let mut phase = expect_import(ReadPhase::new(
        &store,
        ready_witness(),
        ReadLimits::default(),
        Arc::new(AtomicBool::new(false)),
        deadline(),
    ));
    let nested = Scope::begin(&store, Intent::Nested).unwrap();
    expect_import(canonical_point(&mut phase));

    store.db().execute_batch("RELEASE storage_nested_1").unwrap();
    assert_eq!(nested.commit(), Err(crate::cause!(storage::Error::Unavailable)));
    assert!(matches!(phase.current(), Err(ImportError::Refused(_, _))));
    assert!(matches!(canonical_point(&mut phase), Err(ImportError::Refused(_, _))));

    drop(outer);
}

#[test]
fn cancellation_and_withdrawn_source_witness_refuse_the_phase() {
    let (_temp, store) = selected_store();
    let scope = Scope::begin(&store, Intent::Write).unwrap();

    let cancel = Arc::new(AtomicBool::new(false));
    let mut cancelled = expect_import(ReadPhase::new(
        &store,
        ready_witness(),
        ReadLimits::default(),
        cancel.clone(),
        deadline(),
    ));
    cancel.store(true, Ordering::Release);
    assert!(matches!(cancelled.read_source_state(), Err(ImportError::Budget(_, _))));

    let available = Arc::new(AtomicBool::new(true));
    let witness_state = available.clone();
    let witness = move || {
        if witness_state.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(ImportError::Refused("selected source witness withdrawn", crate::cause!()))
        }
    };
    let mut withdrawn = expect_import(ReadPhase::new(
        &store,
        witness,
        ReadLimits::default(),
        Arc::new(AtomicBool::new(false)),
        deadline(),
    ));
    available.store(false, Ordering::Release);
    assert!(matches!(withdrawn.current(), Err(ImportError::Refused(_, _))));
    assert!(matches!(canonical_point(&mut withdrawn), Err(ImportError::Refused(_, _))));

    scope.rollback().unwrap();
}

#[test]
fn expired_current_read_phase_has_a_typed_deadline_failure() {
    let (_temp, store) = selected_store();
    let scope = Scope::begin(&store, Intent::Write).unwrap();
    let expired = Instant::now() - Duration::from_millis(1);
    assert!(matches!(
        ReadPhase::new(
            &store,
            ready_witness(),
            ReadLimits::default(),
            Arc::new(AtomicBool::new(false)),
            expired,
        ),
        Err(ImportError::Deadline(_, _))
    ));
    scope.rollback().unwrap();
}

#[test]
fn hard_query_error_survives_a_later_read_phase_deadline() {
    let (_temp, store) = selected_store();
    let scope = Scope::begin(&store, Intent::Write).unwrap();
    let deadline = Instant::now() + Duration::from_millis(100);
    let mut checks = 0;
    let witness = move || {
        checks += 1;
        if checks == 3 {
            std::thread::sleep(Duration::from_millis(125));
        }
        Ok(())
    };
    let mut phase = expect_import(ReadPhase::new(
        &store,
        witness,
        ReadLimits::default(),
        Arc::new(AtomicBool::new(false)),
        deadline,
    ));

    assert!(matches!(
        phase.query_with_budget(
            "SELECT value FROM missing_source_table",
            &[],
            QueryBudget { rows: 1, source_bytes: 128, deadline },
        ),
        Err(ImportError::Sqlite(_, _))
    ));
    scope.rollback().unwrap();
}

#[test]
fn uncertain_nested_close_refuses_an_existing_canonical_read_phase() {
    let (_temp, store) = selected_store();
    let outer = Scope::begin(&store, Intent::Write).unwrap();
    let nested = Scope::begin(&store, Intent::Nested).unwrap();
    let mut phase = expect_import(ReadPhase::new(
        &store, ready_witness(), ReadLimits::default(),
        Arc::new(AtomicBool::new(false)), deadline(),
    ));
    // Simulate a close that took effect before its acknowledgement was lost.
    store.db().execute_batch("RELEASE storage_nested_1").unwrap();
    assert_eq!(nested.commit(), Err(crate::cause!(storage::Error::Unavailable)));
    assert!(matches!(phase.current(), Err(ImportError::Refused(_, _))));
    assert!(matches!(canonical_point(&mut phase), Err(ImportError::Refused(_, _))));
    assert_eq!(outer.rollback(), Err(crate::cause!(storage::Error::Unavailable)));
}


#[test]
fn current_statement_deadline_is_distinct_from_prior_deadline_and_work_exhaustion() {
    let (_temp, mut store) = selected_store();
    // Use the native whole-handle policy: rearming clears only statement cause,
    // never the callback work debt or absolute deadline.
    let allowance = store.allowance.as_mut().unwrap();
    allowance.spend = Spend::WholeHandle;
    let scope = Scope::begin(&store, Intent::Write).unwrap();
    let mut phase = expect_import(ReadPhase::new(&store, ready_witness(),
        ReadLimits::default(), Arc::new(AtomicBool::new(false)), deadline()));
    *store.allowance.as_ref().unwrap().deadline.lock().unwrap() = Some(Instant::now());
    let sql = "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000000) SELECT sum(x) FROM n";
    assert!(matches!(phase.query(sql, &[]), Err(ImportError::Deadline(_, _))));
    // The former callback deadline must not relabel this new syntax/schema error.
    assert!(matches!(phase.query("SELECT x FROM absent_after_deadline", &[]), Err(ImportError::Sqlite(_, _))));
    store.allowance.as_ref().unwrap().steps.store(2_000_000, Ordering::Relaxed);
    assert!(matches!(phase.query(sql, &[]), Err(ImportError::Sqlite(_, _))));
    // Let the caller confirm rollback without a consumed work allowance.
    *store.allowance.as_ref().unwrap().deadline.lock().unwrap() = None;
    store.allowance.as_ref().unwrap().steps.store(0, Ordering::Relaxed);
    scope.rollback().unwrap();
}


#[test]
fn explicit_query_deadline_never_relabels_an_exhausted_row_allowance() {
    let (_temp, store) = selected_store();
    let scope = Scope::begin(&store, Intent::Write).unwrap();
    let mut phase = expect_import(ReadPhase::new(&store, ready_witness(),
        ReadLimits::default(), Arc::new(AtomicBool::new(false)), deadline()));
    let expired = Instant::now() - Duration::from_millis(1);
    assert!(matches!(phase.query_with_budget("SELECT 1", &[], QueryBudget {
        rows: 0, source_bytes: 128, deadline: expired,
    }), Err(ImportError::Budget(_, _))));
    assert!(matches!(phase.query_with_budget("SELECT 1", &[], QueryBudget {
        rows: 1, source_bytes: 128, deadline: expired,
    }), Err(ImportError::Deadline(_, _))));
    scope.rollback().unwrap();
}
