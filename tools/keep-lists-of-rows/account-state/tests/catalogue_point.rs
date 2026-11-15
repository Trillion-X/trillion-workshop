//! Authored actual SQLite/observer controls; no execution/pass is claimed.
use rusqlite::{types::Value, Connection, OpenFlags};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use trillion_local::{
    import::{ImportResult, QueryRows, ReadLimits},
    record_source::{BoundedRecordSql, QueryBudget, SnapshotRecordSql},
    scan::ReadWork,
    sqlite_work::{ObservedConnection, WorkMeter},
};
type Witness = fn() -> ImportResult<()>;
type Source = SnapshotRecordSql<Witness>;
struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
}
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("metadata.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL").unwrap();
    // Hundreds of unrelated objects PRECEDE the target in sqlite_schema.
    for n in 0..256 {
        db.execute_batch(&format!("CREATE TABLE unrelated_{n}(id INTEGER PRIMARY KEY,word TEXT); CREATE INDEX unrelated_index_{n} ON unrelated_{n}(word);")).unwrap();
    }
    db.execute_batch(
        "CREATE TABLE target(id INTEGER PRIMARY KEY,payload TEXT);
        CREATE TABLE without_rowid(id TEXT PRIMARY KEY,payload TEXT) WITHOUT ROWID;
        CREATE TABLE MixedCase(id INTEGER PRIMARY KEY);
        CREATE VIEW target_view AS SELECT id FROM target;
        CREATE VIRTUAL TABLE virtual_target USING fts5(words);",
    )
    .unwrap();
    drop(db);
    Fixture { _dir: dir, path }
}
fn cap() -> QueryBudget {
    QueryBudget {
        rows: 8,
        source_bytes: 4096,
        deadline: Instant::now() + Duration::from_secs(5),
    }
}
fn start(path: &Path, temp: bool, stop: Arc<AtomicBool>) -> ImportResult<(Source, WorkMeter)> {
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    if temp {
        db.execute_batch(
            "CREATE TEMP TABLE target(other TEXT); CREATE TEMP TABLE temp_only(id TEXT)",
        )?;
    }
    let meter = WorkMeter::new();
    // SAFETY: fresh actual fixture connection, no existing trace owner.
    let observed = unsafe { ObservedConnection::attach_untraced(db, meter.clone()) }.unwrap();
    let witness: Witness = || Ok(());
    Ok((
        SnapshotRecordSql::begin(observed, ReadLimits::default(), witness, stop)?,
        meter,
    ))
}
fn sql_exists(source: &mut impl BoundedRecordSql, name: &str) -> bool {
    let rows = source
        .query_with_budget(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?) AS present",
            &[Value::Text(name.into())],
            cap(),
        )
        .unwrap();
    match rows.rows.as_slice() {
        [row] if row.len() == 1 => matches!(row[0], trillion_local::import::SqlValue::Integer(1)),
        _ => panic!("one bounded existence scalar required"),
    }
}
fn resolved(source: &mut impl BoundedRecordSql, name: &str) -> bool {
    let probe = source.main_table_exists(name, cap());
    match probe
        .exists
        .unwrap_or_else(|error| panic!("synthetic metadata probe for {name} refused: {error}"))
    {
        Some(present) => present,
        None => sql_exists(source, name),
    }
}
fn delta(a: &ReadWork, b: &ReadWork) -> ReadWork {
    ReadWork {
        sql_statements: b.sql_statements.checked_sub(a.sql_statements).unwrap(),
        sqlite_scan_visits: b
            .sqlite_scan_visits
            .checked_sub(a.sqlite_scan_visits)
            .unwrap(),
        fullscan_steps: b.fullscan_steps.checked_sub(a.fullscan_steps).unwrap(),
        vm_steps: b.vm_steps.checked_sub(a.vm_steps).unwrap(),
        rows_returned: b.rows_returned.checked_sub(a.rows_returned).unwrap(),
        rows_written: b.rows_written.checked_sub(a.rows_written).unwrap(),
    }
}
#[test]
fn positive_empty_table_point_removes_explicit_catalogue_walk_but_reports_native_work() {
    let f = fixture();
    let (mut old, old_meter) = start(&f.path, false, Arc::new(AtomicBool::new(false))).unwrap();
    let before = old_meter.snapshot().unwrap().work;
    assert!(sql_exists(&mut old, "target"));
    let old_work = delta(&before, &old_meter.snapshot().unwrap().work);
    assert!(
        old_work.sqlite_scan_visits >= 512,
        "actual SQL catalogue walk sees the unrelated table/index rows"
    );
    old.finish().unwrap();
    let (mut native, meter) = start(&f.path, false, Arc::new(AtomicBool::new(false))).unwrap();
    let before = meter.snapshot().unwrap().work;
    let probe = native.main_table_exists("target", cap());
    assert_eq!(probe.exists.unwrap(), Some(true));
    assert_eq!(probe.work.pin_sql_statements, 1);
    assert_eq!(probe.work.pin_rows_returned, 1);
    assert_eq!(probe.work.metadata_calls, 1);
    assert_eq!(probe.work.origin_prepares, 1);
    assert_eq!(probe.work.origin_name_calls, 2);
    assert!(probe.work.schema_initialization_work_unmeasured);
    let native_sql = delta(&before, &meter.snapshot().unwrap().work);
    assert!(native_sql.sqlite_scan_visits < old_work.sqlite_scan_visits);
    assert_eq!(native_sql.rows_written, 0);
    eprintln!("same empty native table metadata: old_observed_sql={} new_observed_sql={} separate_native_work={} schema_init_not_counted_as_zero=true provider_equivalence_unproved=true",
        serde_json::to_string(&old_work).unwrap(),serde_json::to_string(&native_sql).unwrap(),serde_json::to_string(&probe.work).unwrap());
    native.finish().unwrap();
}
#[test]
fn exact_main_names_without_rowid_views_virtual_and_missing_retain_old_semantics() {
    let f = fixture();
    let (mut source, _) = start(&f.path, true, Arc::new(AtomicBool::new(false))).unwrap();
    for (name, expected) in [
        ("target", true),
        ("without_rowid", true),
        ("MixedCase", true),
        ("mixedcase", false),
        ("target_view", false),
        ("virtual_target", true),
        ("missing", false),
        ("temp_only", false),
    ] {
        assert_eq!(resolved(&mut source, name), expected, "{name}");
        assert_eq!(sql_exists(&mut source, name), expected, "baseline {name}");
    }
    let absent = source.main_table_exists("missing", cap());
    assert_eq!(
        absent.exists.unwrap(),
        None,
        "an SQLite error is unknown, never invented absence"
    );
    assert_eq!(
        source
            .main_table_exists("target_view", cap())
            .exists
            .unwrap(),
        None
    );
    assert_eq!(
        source
            .main_table_exists("mixedcase", cap())
            .exists
            .unwrap(),
        Some(false),
        "actual main object name preserves binary-name semantics"
    );
    assert_eq!(
        source
            .main_table_exists("unsafe;identifier", cap())
            .exists
            .unwrap(),
        None
    );
    source.finish().unwrap();
}
#[test]
fn held_snapshot_keeps_old_schema_and_new_snapshot_sees_ddl() {
    let f = fixture();
    let (mut old, _) = start(&f.path, false, Arc::new(AtomicBool::new(false))).unwrap();
    assert_eq!(
        old.main_table_exists("target", cap()).exists.unwrap(),
        Some(true)
    );
    let writer = Connection::open(&f.path).unwrap();
    writer
        .execute_batch("DROP TABLE target; CREATE VIEW target AS SELECT id FROM MixedCase;")
        .unwrap();
    assert_eq!(
        old.main_table_exists("target", cap()).exists.unwrap(),
        Some(true),
        "pin and origin refer to the same retained main snapshot"
    );
    assert!(sql_exists(&mut old, "target"));
    old.finish().unwrap();
    let (mut fresh, _) = start(&f.path, false, Arc::new(AtomicBool::new(false))).unwrap();
    assert!(
        !resolved(&mut fresh, "target"),
        "new snapshot does not inherit a prior native positive"
    );
    fresh.finish().unwrap();
}
#[test]
fn malformed_schema_or_invalidated_source_never_becomes_absent() {
    let f = fixture();
    let writer = Connection::open(&f.path).unwrap();
    let version: i64 = writer
        .query_row("PRAGMA schema_version", [], |r| r.get(0))
        .unwrap();
    writer.execute_batch(&format!("PRAGMA writable_schema=ON; UPDATE sqlite_schema SET sql='not a valid table declaration' WHERE name='target'; PRAGMA schema_version={}; PRAGMA writable_schema=OFF;",version+1)).unwrap();
    drop(writer);
    if let Ok((mut source, _)) = start(&f.path, false, Arc::new(AtomicBool::new(false))) {
        assert!(
            source
                .main_table_exists("target", cap())
                .exists
                .is_err(),
            "bad schema is not false or a successful unsupported absence"
        );
        assert!(source.finish().is_err());
    }
    let f = fixture();
    let stop = Arc::new(AtomicBool::new(false));
    let (mut source, _) = start(&f.path, false, stop.clone()).unwrap();
    stop.store(true, Ordering::Release);
    let cancelled = source.main_table_exists("target", cap());
    assert!(cancelled.exists.is_err());
    assert_eq!(cancelled.work.metadata_calls, 0);
    assert!(source.finish().is_err());
    let (mut source, _) = start(&f.path, false, Arc::new(AtomicBool::new(false))).unwrap();
    std::fs::rename(&f.path, f.path.with_file_name("retained.sqlite")).unwrap();
    assert!(source
        .main_table_exists("target", cap())
        .exists
        .is_err());
    assert!(source.finish().is_err());
}
#[test]
fn exhausted_caller_allowance_is_not_a_zero_cost_exists_result() {
    for which in ["rows", "bytes", "deadline"] {
        let f = fixture();
        let (mut source, _) = start(&f.path, false, Arc::new(AtomicBool::new(false))).unwrap();
        let mut budget = cap();
        match which {
            "rows" => budget.rows = 0,
            "bytes" => budget.source_bytes = 0,
            _ => budget.deadline = Instant::now() - Duration::from_millis(1),
        }
        let result = source.main_table_exists("target", budget);
        assert!(result.exists.is_err(), "{which}");
        assert_eq!(result.work.metadata_calls, 0);
        assert_eq!(result.work.pin_sql_statements, 0);
        assert!(source.finish().is_err());
    }
}
struct DefaultSupply(Source);
impl BoundedRecordSql for DefaultSupply {
    fn read_limits(&self) -> Option<&ReadLimits> {
        self.0.read_limits()
    }
    fn query(&mut self, sql: &str, p: &[Value]) -> ImportResult<QueryRows> {
        self.0.query(sql, p)
    }
    fn query_with_budget(
        &mut self,
        sql: &str,
        p: &[Value],
        b: QueryBudget,
    ) -> ImportResult<QueryRows> {
        self.0.query_with_budget(sql, p, b)
    }
}
#[test]
fn unspecialized_supply_keeps_original_observed_sql_behavior() {
    let f = fixture();
    let (source, meter) = start(&f.path, false, Arc::new(AtomicBool::new(false))).unwrap();
    let mut source = DefaultSupply(source);
    let probe = source.main_table_exists("target", cap());
    assert_eq!(probe.exists.unwrap(), None);
    assert_eq!(probe.work.metadata_calls, 0);
    let before = meter.snapshot().unwrap().work;
    assert!(resolved(&mut source, "target"));
    let work = delta(&before, &meter.snapshot().unwrap().work);
    assert!(
        work.sqlite_scan_visits >= 512,
        "default did not silently reinterpret SQL as native metadata"
    );
    source.0.finish().unwrap();
}
