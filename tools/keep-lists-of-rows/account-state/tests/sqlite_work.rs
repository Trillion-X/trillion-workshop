//! Actual synthetic SQLite controls for the generic observer. Root owns export,
//! Cargo execution and source-pin qualification; no application rights or cloud
//! price equivalence follows from these fixtures.
use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    Connection, OpenFlags, StatementStatus,
};
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use trillion_local::{
    scan::ReadWork,
    sqlite_work::{Error, Family, Observation, ObservedConnection, SuppliedConnection, WorkMeter},
};

fn fields(work: &ReadWork) -> [u64; 6] {
    [
        work.sql_statements,
        work.sqlite_scan_visits,
        work.fullscan_steps,
        work.vm_steps,
        work.rows_returned,
        work.rows_written,
    ]
}
fn conserved(observation: &Observation) {
    let mut total = [0_u64; 6];
    for (index, group) in observation.families.iter().enumerate() {
        assert_eq!(group.family, Family::ALL[index]);
        for (sum, value) in total.iter_mut().zip(fields(&group.work)) {
            *sum += value;
        }
    }
    assert_eq!(
        total,
        fields(&observation.work),
        "fixed families must conserve every actual aggregate counter"
    );
}
fn family(observation: &Observation, family: Family) -> &ReadWork {
    &observation
        .families
        .iter()
        .find(|group| group.family == family)
        .unwrap()
        .work
}
fn family_fixture() -> Connection {
    let connection = fixture();
    connection.execute_batch("CREATE TABLE record_keys_runs(run INTEGER PRIMARY KEY,pages INTEGER); INSERT INTO record_keys_runs VALUES(7,1);
        CREATE TABLE record_keys_run_7(page INTEGER PRIMARY KEY,body TEXT); INSERT INTO record_keys_run_7 VALUES(1,'private-page-sentinel');
        CREATE TABLE record_keys_big(ref TEXT PRIMARY KEY,body TEXT); INSERT INTO record_keys_big VALUES('x','private-big-sentinel');
        CREATE TABLE record_keys_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO record_keys_meta VALUES('frontier','private-frontier-sentinel');
        CREATE TABLE record_log(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO record_log VALUES(1,'private-journal-sentinel');
        CREATE TABLE record_log_sealed_1(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO record_log_sealed_1 VALUES(1,'private-sealed-sentinel');
        CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT); INSERT INTO policy_directory VALUES('x','private-policy-sentinel');
        CREATE TABLE _mf_entries(key TEXT PRIMARY KEY,blob_id TEXT); INSERT INTO _mf_entries VALUES('x','private-blob-sentinel');
        CREATE TABLE unrelated(record_log TEXT); INSERT INTO unrelated VALUES('private-column-sentinel');").unwrap();
    connection
}

fn fixture() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch("CREATE TABLE item(id INTEGER PRIMARY KEY,value TEXT NOT NULL); WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1024) INSERT INTO item SELECT i,CASE WHEN i=1024 THEN 'last' ELSE 'other' END FROM n").unwrap();
    connection
}
fn attach(connection: Connection, meter: WorkMeter) -> ObservedConnection {
    // SAFETY: this fixture owns its fresh connection; no trace slot or borrowed
    // statement exists, and all subsequent access remains through its wrapper.
    unsafe { ObservedConnection::attach_untraced(connection, meter) }.unwrap()
}
fn point(connection: &ObservedConnection) {
    let value: String = connection
        .connection()
        .query_row("SELECT value FROM item WHERE id=?", [1024], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(value, "last");
}

#[test]
fn indexed_point_and_full_scan_have_same_one_result_but_actual_distinct_visits() {
    let point_meter = WorkMeter::new();
    let point_connection = attach(fixture(), point_meter.clone());
    point(&point_connection);
    let p = point_meter.snapshot().unwrap();
    assert_eq!(p.work.sql_statements, 1);
    assert_eq!(p.work.rows_returned, 1);
    assert_eq!(p.work.sqlite_scan_visits, 1);
    assert_eq!(p.work.rows_written, 0);
    assert_eq!(p.unattributed_row_events, 0);
    let scan_meter = WorkMeter::new();
    let scan_connection = attach(fixture(), scan_meter.clone());
    let count: i64 = scan_connection
        .connection()
        .query_row("SELECT count(*) FROM item WHERE value='last'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 1);
    let s = scan_meter.snapshot().unwrap();
    assert_eq!(s.work.rows_returned, 1);
    assert_eq!(s.work.sqlite_scan_visits, 1024);
    assert_eq!(s.work.fullscan_steps, 1023);
    assert!(s.work.vm_steps > p.work.vm_steps);
    assert_eq!(s.work.rows_written, 0);
    conserved(&p);
    conserved(&s);
    assert_eq!(family(&p, Family::Other).sqlite_scan_visits, 1);
    assert_eq!(family(&s, Family::Other).sqlite_scan_visits, 1024);
}

#[test]
fn cold_schema_row_events_remain_in_gross_totals_but_are_not_statement_results() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("cold.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE item(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO item VALUES(1024,'last')").unwrap();
    drop(db);
    let meter = WorkMeter::new();
    let db = attach(Connection::open(&path).unwrap(), meter.clone());
    point(&db);
    let first = meter.snapshot().unwrap();
    assert_eq!(first.work.sql_statements, 1);
    assert_eq!(first.work.sqlite_scan_visits, 1);
    assert_eq!(
        first.work.rows_returned, 2,
        "gross lifecycle events remain visible"
    );
    assert_eq!(first.unattributed_row_events, 1);
    assert_eq!(first.work.rows_returned - first.unattributed_row_events, 1);
    conserved(&first);
    point(&db);
    let second = meter.snapshot().unwrap();
    assert_eq!(second.work.rows_returned, 3);
    assert_eq!(
        second.unattributed_row_events, 1,
        "a real second result cannot be excluded"
    );
    assert_eq!(
        second.work.rows_returned - second.unattributed_row_events,
        2
    );
    assert_eq!(second.work.sqlite_scan_visits, 2);
    conserved(&second);
}

#[test]
fn cached_executions_charge_deltas_without_resetting_other_owner_counters() {
    let meter = WorkMeter::new();
    let connection = attach(fixture(), meter.clone());
    let mut statement = connection
        .connection()
        .prepare_cached("SELECT value FROM item WHERE id=?")
        .unwrap();
    let mut first = 0;
    for n in 1..=3 {
        let value: String = statement.query_row([1024], |row| row.get(0)).unwrap();
        assert_eq!(value, "last");
        let vm = statement.get_status(StatementStatus::VmStep);
        if n == 1 {
            first = vm;
        }
        assert_eq!(
            vm,
            first * n,
            "observer must not reset statement owner counters"
        );
    }
    drop(statement);
    let observed = meter.snapshot().unwrap();
    assert_eq!(observed.work.sql_statements, 3);
    assert_eq!(observed.work.sqlite_scan_visits, 3);
    assert_eq!(observed.work.rows_returned, 3);
    assert_eq!(observed.work.vm_steps, u64::try_from(first * 3).unwrap());
}

#[test]
fn connection_and_stable_callback_context_move_together_across_thread_and_drop() {
    let meter = WorkMeter::new();
    let connection = attach(fixture(), meter.clone());
    let connection = std::thread::spawn(move || {
        point(&connection);
        connection
    })
    .join()
    .unwrap();
    point(&connection);
    assert_eq!(meter.snapshot().unwrap().live_connections, 1);
    drop(connection);
    let work = meter.snapshot().unwrap();
    assert_eq!(work.live_connections, 0);
    assert_eq!(work.active_statements, 0);
    assert_eq!(work.work.sql_statements, 2);
    assert_eq!(work.work.sqlite_scan_visits, 2);
}

#[test]
fn multiple_exact_connections_share_only_aggregate_counters() {
    let meter = WorkMeter::new();
    let first = attach(fixture(), meter.clone());
    let second = attach(fixture(), meter.clone());
    point(&first);
    point(&second);
    assert_eq!(meter.snapshot().unwrap().live_connections, 2);
    drop(first);
    assert_eq!(meter.snapshot().unwrap().live_connections, 1);
    drop(second);
    let work = meter.snapshot().unwrap();
    assert_eq!(work.live_connections, 0);
    assert_eq!(work.work.sqlite_scan_visits, 2);
    assert_eq!(work.work.rows_returned, 2);
}

#[test]
fn authorizer_and_progress_cancellation_remain_the_existing_execution_owners() {
    fn authorizer(context: AuthContext<'_>) -> Authorization {
        if matches!(context.action, AuthAction::Update { .. }) {
            Authorization::Deny
        } else {
            Authorization::Allow
        }
    }
    let connection = fixture();
    connection.authorizer(Some(authorizer));
    let meter = WorkMeter::new();
    let observed = attach(connection, meter.clone());
    assert!(observed
        .connection()
        .execute("UPDATE item SET value='denied'", [])
        .is_err());
    point(&observed);
    let cancel = Arc::new(AtomicBool::new(false));
    let stop = cancel.clone();
    observed
        .connection()
        .progress_handler(10, Some(move || stop.load(Ordering::Acquire)));
    cancel.store(true, Ordering::Release);
    assert!(observed
        .connection()
        .query_row(
            "SELECT sum(a.id*b.id) FROM item a CROSS JOIN item b",
            [],
            |row| row.get::<_, i64>(0)
        )
        .is_err());
    let result = meter.snapshot().unwrap();
    assert_eq!(
        result.work.sql_statements, 2,
        "denied prepare did not execute a statement"
    );
    assert!(result.work.vm_steps > 0);
    assert_eq!(result.work.rows_written, 0);
    assert_eq!(result.active_statements, 0);
    conserved(&result);
}

#[test]
fn preexisting_cached_statement_is_refused_without_consuming_its_connection() {
    let connection = fixture();
    drop(
        connection
            .prepare_cached("SELECT value FROM item WHERE id=?")
            .unwrap(),
    );
    let meter = WorkMeter::new();
    // SAFETY: the trace slot is known vacant; this intentionally violates only
    // the separately checked fresh-prepared-executor condition.
    let error =
        unsafe { ObservedConnection::attach_untraced(connection, meter.clone()) }.unwrap_err();
    assert_eq!(error.error, trillion_local::cause!(Error::PreparedStatements));
    let recovered = error.into_connection();
    assert_eq!(
        recovered
            .query_row("SELECT count(*) FROM item", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1024
    );
    assert_eq!(meter.snapshot().unwrap().live_connections, 0);
    assert_eq!(meter.snapshot().unwrap().work.sql_statements, 0);
}

#[test]
fn readonly_file_observation_does_not_change_source_bytes_or_create_writes() {
    let directory = tempfile::tempdir().unwrap();
    let path = fs::canonicalize(directory.path())
        .unwrap()
        .join("selected.sqlite");
    let writer = Connection::open(&path).unwrap();
    writer.execute_batch("CREATE TABLE item(id INTEGER PRIMARY KEY,value TEXT NOT NULL); INSERT INTO item VALUES(1024,'last')").unwrap();
    drop(writer);
    let before = fs::read(&path).unwrap();
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .unwrap();
    let meter = WorkMeter::new();
    let observed = attach(connection, meter.clone());
    point(&observed);
    drop(observed);
    let observation = meter.snapshot().unwrap();
    assert_eq!(observation.work.sqlite_scan_visits, 1);
    assert_eq!(observation.work.rows_written, 0);
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn unfinished_cursor_is_explicitly_active_then_its_reset_profiles_actual_partial_work() {
    let meter = WorkMeter::new();
    let connection = attach(fixture(), meter.clone());
    let mut statement = connection
        .connection()
        .prepare("SELECT id FROM item ORDER BY id")
        .unwrap();
    let mut rows = statement.query([]).unwrap();
    assert!(rows.next().unwrap().is_some());
    let active = meter.snapshot().unwrap();
    assert_eq!(active.active_statements, 1);
    assert_eq!(active.work.rows_returned, 1);
    drop(rows);
    drop(statement);
    let complete = meter.snapshot().unwrap();
    assert_eq!(complete.active_statements, 0);
    assert_eq!(complete.work.rows_returned, 1);
    assert_eq!(complete.work.sqlite_scan_visits, 1);
}

#[test]
fn trigger_subprogram_is_not_a_second_execution_and_mutation_count_is_not_doubled() {
    let connection = fixture();
    connection.execute_batch("CREATE TABLE audit(value INTEGER); CREATE TRIGGER note AFTER INSERT ON item BEGIN INSERT INTO audit VALUES(new.id); END").unwrap();
    let meter = WorkMeter::new();
    let observed = attach(connection, meter.clone());
    observed
        .connection()
        .execute("INSERT INTO item VALUES(2048,'private-value-sentinel')", [])
        .unwrap();
    let result = meter.snapshot().unwrap();
    assert_eq!(result.work.sql_statements, 1);
    assert_eq!(
        result.work.rows_written, 2,
        "SQLite total_changes includes the trigger once"
    );
    assert_eq!(result.work.rows_returned, 0);
    assert!(!format!("{observed:?} {meter:?} {result:?}").contains("private-value-sentinel"));
}

#[test]
fn forwarded_transaction_is_observed_and_rollback_is_not_relabelled_durable_writes() {
    let meter = WorkMeter::new();
    let mut connection = attach(fixture(), meter.clone());
    let transaction = connection.transaction().unwrap();
    transaction
        .execute("UPDATE item SET value='changed' WHERE id=1024", [])
        .unwrap();
    transaction.rollback().unwrap();
    let result = meter.snapshot().unwrap();
    assert_eq!(result.work.sql_statements, 3);
    assert_eq!(
        result.work.rows_written, 1,
        "SQLite change counters include rolled-back mutations"
    );
    point(&connection);
}

#[test]
fn common_supply_preserves_observed_custody_and_marks_raw_connections_unobserved() {
    fn consume(connection: impl Into<SuppliedConnection>) -> SuppliedConnection {
        connection.into()
    }
    let raw = consume(fixture());
    assert!(
        raw.meter().is_none(),
        "unobserved must not become measured zero"
    );
    let meter = WorkMeter::new();
    let mut observed = consume(attach(fixture(), meter.clone()));
    let kept = observed.meter().unwrap();
    let value: String = observed
        .query_row("SELECT value FROM item WHERE id=?", [1024], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(value, "last");
    let tx = observed.transaction().unwrap();
    tx.commit().unwrap();
    drop(observed);
    let final_work = kept.snapshot().unwrap();
    assert_eq!(final_work.live_connections, 0);
    assert_eq!(final_work.work.sql_statements, 3);
    assert_eq!(final_work.work.sqlite_scan_visits, 1);
}

#[test]
fn fixed_query_families_cover_actual_sqlite_work_and_conserve_all_aggregate_units() {
    let meter = WorkMeter::new();
    let observed = attach(family_fixture(), meter.clone());
    let db = observed.connection();
    db.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE type='table'",
        [],
        |row| row.get::<_, i64>(0),
    )
    .unwrap();
    let mut columns = db.prepare("PRAGMA main.table_info('record_log')").unwrap();
    let rows = columns
        .query_map([], |_| Ok(()))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(rows.len(), 2);
    drop(columns);
    for sql in [
        "SELECT body FROM main.\"record_keys_run_7\" WHERE page=1",
        "SELECT pages FROM record_keys_runs WHERE run=7",
        "SELECT body FROM record_keys_big WHERE ref='x'",
        "SELECT value FROM record_keys_meta WHERE key='frontier'",
        "SELECT body FROM record_log WHERE id=1",
        "SELECT body FROM record_log_sealed_1 WHERE id=1",
        "SELECT value FROM policy_directory WHERE name='x'",
        "SELECT blob_id FROM _mf_entries WHERE key='x'",
    ] {
        db.query_row(sql, [], |_| Ok(())).unwrap();
    }
    point(&observed);
    drop(observed);
    let result = meter.snapshot().unwrap();
    conserved(&result);
    assert_eq!(result.live_connections, 0);
    assert_eq!(result.active_statements, 0);
    assert_eq!(family(&result, Family::Catalogue).sql_statements, 1);
    assert!(family(&result, Family::Catalogue).sqlite_scan_visits > 0);
    assert_eq!(family(&result, Family::Columns).sql_statements, 1);
    assert_eq!(family(&result, Family::Columns).rows_returned, 2);
    assert_eq!(family(&result, Family::Kept).sql_statements, 3);
    assert_eq!(family(&result, Family::Kept).sqlite_scan_visits, 3);
    assert_eq!(family(&result, Family::Projection).sqlite_scan_visits, 1);
    assert_eq!(family(&result, Family::Journal).sqlite_scan_visits, 2);
    assert_eq!(family(&result, Family::PolicySession).sqlite_scan_visits, 2);
    assert_eq!(family(&result, Family::Other).sqlite_scan_visits, 1);
    assert_eq!(result.work.rows_written, 0);
    let output = serde_json::to_string(&result.families).unwrap();
    for private in [
        "private-",
        "record_log",
        "record_keys_run",
        "policy_directory",
        "blob_id",
        "WHERE",
    ] {
        assert!(!output.contains(private));
    }
}

#[test]
fn literals_comments_column_aliases_and_cte_shadowing_cannot_spoof_physical_families() {
    let meter = WorkMeter::new();
    let observed = attach(family_fixture(), meter.clone());
    for sql in [
        "SELECT 'FROM record_log JOIN sqlite_schema PRAGMA table_info record_keys_run_1' FROM item WHERE id=1024",
        "SELECT value AS record_log FROM item WHERE id=1024 /* FROM policy_directory */ -- JOIN _mf_entries",
        "SELECT 'record_keys_meta' AS \"FROM\" FROM item WHERE id=1024",
        "WITH record_log AS (SELECT id FROM item WHERE id=1024) SELECT count(*) FROM record_log",
        "WITH \"record_keys_run_7\" AS (SELECT id FROM item WHERE id=1024) SELECT count(*) FROM record_keys_run_7",
        "SELECT count(*) FROM (WITH record_log AS (SELECT id FROM item WHERE id=1024) SELECT * FROM record_log)",
    ] {
        observed.connection().query_row(sql, [], |_| Ok(())).unwrap();
    }
    observed
        .connection()
        .query_row(
            "SELECT @from, record_log FROM unrelated",
            rusqlite::named_params! {"@from":0},
            |_| Ok(()),
        )
        .unwrap();
    let result = meter.snapshot().unwrap();
    conserved(&result);
    assert_eq!(family(&result, Family::Other).sql_statements, 7);
    for group in &result.families {
        if group.family != Family::Other {
            assert_eq!(fields(&group.work), [0; 6]);
        }
    }
}

#[test]
fn physical_quoted_names_recursive_queries_and_qualified_cte_shadows_are_classified() {
    let meter = WorkMeter::new();
    let observed = attach(family_fixture(), meter.clone());
    for sql in [
        "SELECT body FROM [record_log] WHERE id=1",
        "WITH record_log AS (VALUES(1024)) SELECT body FROM main.record_log WHERE id=1",
        "WITH RECURSIVE r(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM r WHERE n<2) SELECT body FROM record_keys_run_7 WHERE page IN (SELECT n FROM r)",
    ] { observed.connection().query_row(sql,[],|_|Ok(())).unwrap(); }
    let result = meter.snapshot().unwrap();
    conserved(&result);
    assert_eq!(family(&result, Family::Journal).sql_statements, 2);
    assert_eq!(family(&result, Family::Kept).sql_statements, 1);
    assert_eq!(family(&result, Family::Other).sql_statements, 0);
}

#[test]
fn classifier_byte_token_and_mixed_family_limits_fall_back_without_losing_work() {
    let meter = WorkMeter::new();
    let observed = attach(family_fixture(), meter.clone());
    let byte_bound = format!(
        "SELECT body FROM record_log WHERE id=1 /*{}*/",
        "x".repeat(16 * 1024)
    );
    let token_bound = format!(
        "SELECT {} FROM record_log WHERE id=1",
        std::iter::repeat("1")
            .take(390)
            .collect::<Vec<_>>()
            .join("+")
    );
    for sql in [
        &byte_bound,
        &token_bound,
        "SELECT a.body FROM record_log a JOIN policy_directory p ON p.name='x' WHERE a.id=1",
    ] {
        observed
            .connection()
            .query_row(sql, [], |_| Ok(()))
            .unwrap();
    }
    let result = meter.snapshot().unwrap();
    conserved(&result);
    assert_eq!(family(&result, Family::Other).sql_statements, 3);
    assert!(family(&result, Family::Other).sqlite_scan_visits >= 3);
    assert_eq!(family(&result, Family::Journal).sql_statements, 0);
    assert_eq!(family(&result, Family::PolicySession).sql_statements, 0);
}

#[test]
fn family_assignment_preserves_actual_scan_and_mutation_units_through_trigger_and_rollback() {
    let meter = WorkMeter::new();
    let connection = family_fixture();
    connection.execute_batch("CREATE TABLE audit(value TEXT); CREATE TRIGGER audit_policy AFTER UPDATE ON policy_directory BEGIN INSERT INTO audit VALUES(new.value); END").unwrap();
    let mut observed = attach(connection, meter.clone());
    observed
        .connection()
        .query_row(
            "SELECT count(*) FROM record_log WHERE body='not-present'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    let tx = observed.transaction().unwrap();
    tx.execute(
        "UPDATE policy_directory SET value='private-update-sentinel' WHERE name='x'",
        [],
    )
    .unwrap();
    tx.rollback().unwrap();
    drop(observed);
    let result = meter.snapshot().unwrap();
    conserved(&result);
    assert_eq!(family(&result, Family::Journal).sqlite_scan_visits, 1);
    assert_eq!(family(&result, Family::PolicySession).rows_written, 2);
    assert_eq!(
        family(&result, Family::Other).sql_statements,
        2,
        "BEGIN and ROLLBACK remain other"
    );
    assert_eq!(
        result.work.rows_written, 2,
        "these are SQLite mutations, including rolled-back trigger writes"
    );
}

// Exact public source template from legacy_kept::seek_page. This query is555
// lexical tokens, above the original diagnostic classifier's512-token ceiling.
// Fixtures and query data are synthetic; no application identity is supplied.
#[test]
fn canonical_recursive_boundary_key_template_is_classified_without_changing_its_work() {
    let connection = family_fixture();
    connection.execute_batch("CREATE TABLE record_keys_run_8(page INTEGER PRIMARY KEY,first TEXT); INSERT INTO record_keys_run_8 VALUES(0,'\"a\"'),(1,'\"b\"'),(2,'\"c\"'),(3,'\"d\"'),(4,'\"e\"'),(5,'\"f\"'),(6,'\"g\"'),(7,'\"h\"')").unwrap();
    let meter = WorkMeter::new();
    let observed = attach(connection, meter.clone());
    let table = "record_keys_run_8";
    let valid="CASE WHEN typeof(probe.first)='text' THEN CASE WHEN json_valid(probe.first) THEN CASE WHEN json_type(probe.first)='text' THEN 1 ELSE 0 END ELSE 0 END ELSE 0 END";
    let below = format!(
        "CASE WHEN ({valid})=1 THEN json_extract(probe.first,'$') COLLATE BINARY<=?2 ELSE 0 END"
    );
    let sql=format!("WITH RECURSIVE seeking(lo,hi,found,here,next,seen,valid,step) AS (SELECT 0,?1-1,-1,NULL,NULL,NULL,1,0 UNION ALL SELECT CASE WHEN {below} THEN (lo+hi)/2+1 ELSE lo END,CASE WHEN {below} THEN hi ELSE (lo+hi)/2-1 END,CASE WHEN {below} THEN (lo+hi)/2 ELSE found END,CASE WHEN {below} THEN probe.first ELSE here END,CASE WHEN {below} THEN next ELSE probe.first END,probe.first,{valid},step+1 FROM seeking LEFT JOIN {table} AS probe ON probe.page=(lo+hi)/2 WHERE lo<=hi AND valid=1 AND step<32) SELECT seen AS probe,lo,hi,found,CASE WHEN lo>hi THEN here END AS here,CASE WHEN lo>hi THEN next END AS next,valid FROM seeking WHERE step>0 ORDER BY step");
    let mut statement = observed.connection().prepare(&sql).unwrap();
    let rows = statement
        .query_map(rusqlite::params![8, "f"], |_| Ok(()))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(rows.len(), 3);
    drop(statement);
    drop(observed);
    let result = meter.snapshot().unwrap();
    conserved(&result);
    assert_eq!(family(&result, Family::Other).sql_statements, 0);
    let kept = family(&result, Family::Kept);
    assert_eq!(kept.sql_statements, 1);
    assert_eq!(kept.rows_returned, 3);
    assert_eq!(kept.sqlite_scan_visits, 3 * kept.rows_returned + 2);
    assert_eq!(kept.rows_written, 0);
}

#[test]
fn known_and_unknown_physical_sources_remain_other_while_cte_sources_are_virtual() {
    let meter = WorkMeter::new();
    let observed = attach(family_fixture(), meter.clone());
    for sql in [
        "SELECT l.body FROM record_log l JOIN unrelated u ON 1=1 WHERE l.id=1",
        "SELECT l.body FROM unrelated u JOIN record_log l ON 1=1 WHERE l.id=1",
        "SELECT l.body FROM record_log l, unrelated u WHERE l.id=1",
        "WITH unknown_rows AS (SELECT record_log FROM unrelated) SELECT l.body FROM record_log l JOIN unknown_rows u ON 1=1 WHERE l.id=1",
    ] {
        observed.connection().query_row(sql,[],|_|Ok(())).unwrap();
    }
    for sql in [
        "WITH generated(n) AS (VALUES(1)) SELECT l.body FROM record_log l JOIN generated g ON g.n=1 WHERE l.id=1",
        "WITH logged AS (SELECT body FROM record_log WHERE id=1) SELECT body FROM logged",
    ] {
        observed.connection().query_row(sql,[],|_|Ok(())).unwrap();
    }
    drop(observed);
    let result = meter.snapshot().unwrap();
    conserved(&result);
    assert_eq!(result.work.sql_statements, 6);
    assert_eq!(family(&result, Family::Other).sql_statements, 4);
    assert!(family(&result, Family::Other).sqlite_scan_visits > 0);
    assert_eq!(family(&result, Family::Journal).sql_statements, 2);
    assert!(family(&result, Family::Journal).sqlite_scan_visits > 0);
    assert_eq!(result.work.rows_written, 0);
}

#[cfg(feature = "sql-statement-attribution")]
mod statement_attribution_controls {
    use super::*;
    fn enabled(capacity: usize) -> WorkMeter {
        let meter = WorkMeter::new();
        // SAFETY: every statement is a private generated fixture template, no
        // connection is active and no SQL source contains private values.
        unsafe { meter.enable_fixture_statement_attribution(capacity) }.unwrap();
        meter
    }
    #[test]
    fn exact_template_totals_keep_bound_values_out_and_conserve_base_work() {
        let meter = enabled(8);
        let db = attach(fixture(), meter.clone());
        point(&db);
        let v: String = db
            .connection()
            .query_row("SELECT ?", ["private-bound-sentinel"], |r| r.get(0))
            .unwrap();
        assert_eq!(v, "private-bound-sentinel");
        let detail = meter.fixture_statement_snapshot().unwrap();
        assert!(detail.complete);
        assert_eq!(
            fields(&detail.work),
            fields(&meter.snapshot().unwrap().work)
        );
        assert_eq!(detail.statements.len(), 2);
        assert!(detail
            .statements
            .iter()
            .all(|s| !s.sql_template.contains("private-bound-sentinel")));
        assert!(!format!("{detail:?}").contains("SELECT"));
        assert_eq!(
            detail
                .statements
                .iter()
                .map(|s| s.work.sqlite_scan_visits)
                .sum::<u64>(),
            1
        );
    }
    #[test]
    fn cached_statement_profiles_charge_actual_deltas_and_writes() {
        let meter = enabled(8);
        let db = attach(fixture(), meter.clone());
        let mut statement = db
            .connection()
            .prepare_cached("SELECT value FROM item WHERE id=?")
            .unwrap();
        for _ in 0..3 {
            let _: String = statement.query_row([1024], |r| r.get(0)).unwrap();
        }
        drop(statement);
        db.connection()
            .execute(
                "UPDATE item SET value=? WHERE id=?",
                rusqlite::params!["changed", 1024],
            )
            .unwrap();
        let detail = meter.fixture_statement_snapshot().unwrap();
        assert!(detail.complete);
        let select = detail
            .statements
            .iter()
            .find(|s| s.sql_template.starts_with("SELECT value"))
            .unwrap();
        assert_eq!(
            (
                select.work.sql_statements,
                select.work.sqlite_scan_visits,
                select.work.rows_returned
            ),
            (3, 3, 3)
        );
        let write = detail
            .statements
            .iter()
            .find(|s| s.sql_template.starts_with("UPDATE"))
            .unwrap();
        assert_eq!(write.work.rows_written, 1);
    }
    #[test]
    fn capacity_exhaustion_reports_incomplete_attribution_without_losing_work() {
        let meter = enabled(1);
        let db = attach(fixture(), meter.clone());
        for sql in ["SELECT 1", "SELECT 2"] {
            let _: i64 = db.connection().query_row(sql, [], |r| r.get(0)).unwrap();
        }
        let detail = meter.fixture_statement_snapshot().unwrap();
        assert!(!detail.complete);
        assert_eq!(detail.work.sql_statements, 2);
        assert_eq!(detail.unattributed_work.sql_statements, 1);
        assert_eq!(detail.unattributed_work.rows_returned, 1);
        assert!(meter.snapshot().is_ok());
    }
    #[test]
    fn cold_unmatched_schema_events_remain_visible_outside_statement_results() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("cold.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE item(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO item VALUES(1024,'last')").unwrap();
        drop(db);
        let meter = enabled(8);
        let db = attach(Connection::open(path).unwrap(), meter.clone());
        point(&db);
        let detail = meter.fixture_statement_snapshot().unwrap();
        assert!(detail.complete);
        assert_eq!(detail.work.rows_returned, 2);
        assert_eq!(detail.unattributed_row_events, 1);
        assert_eq!(
            detail
                .statements
                .iter()
                .map(|s| s.work.rows_returned)
                .sum::<u64>(),
            1
        );
    }
    #[test]
    fn partial_active_statement_is_busy_and_capture_cannot_be_reset() {
        let meter = enabled(8);
        let db = attach(fixture(), meter.clone());
        let mut stmt = db.connection().prepare("SELECT value FROM item").unwrap();
        let mut rows = stmt.query([]).unwrap();
        rows.next().unwrap().unwrap();
        assert_eq!(meter.fixture_statement_snapshot().unwrap_err(), trillion_local::cause!(Error::Busy));
        // SAFETY: this intentionally violates the idle precondition to verify
        // that an active statement is refused before any state changes.
        assert_eq!(
            unsafe { meter.enable_fixture_statement_attribution(8) }.unwrap_err(),
            trillion_local::cause!(Error::Busy)
        );
        drop(rows);
        drop(stmt);
        assert!(meter.fixture_statement_snapshot().unwrap().complete);
    }
    #[test]
    fn distinct_connections_can_share_exact_attribution_without_a_callback_lock() {
        let meter = enabled(8);
        let a = attach(fixture(), meter.clone());
        let b = attach(fixture(), meter.clone());
        let threads = [a, b].map(|db| {
            std::thread::spawn(move || {
                for _ in 0..20 {
                    point(&db);
                }
            })
        });
        for t in threads {
            t.join().unwrap();
        }
        let detail = meter.fixture_statement_snapshot().unwrap();
        assert!(detail.complete);
        assert_eq!(detail.work.sql_statements, 40);
        assert_eq!(detail.work.sqlite_scan_visits, 40);
        assert_eq!(
            detail
                .statements
                .iter()
                .map(|s| s.work.sql_statements)
                .sum::<u64>(),
            40
        );
    }
}
