//! A/B control for one retained record: one indexed SQLite row versus the
//! canonical Rust record reader on the same disposable file and same answer.
//! The direct side is a physical lower bound only. It does not check account
//! rights, replay later journal writes, resolve protected fields, or qualify a
//! public response. These gaps must remain visible when interpreting the cost.

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::sync::{atomic::AtomicBool, Arc};
use trillion_local::{
    import::{ReadLimits, SqlValue},
    legacy_kept::LegacyKept,
    legacy_records::{Bounds, LegacyRecords},
    record_source::{BoundedRecordSql, SnapshotRecordSql},
    sqlite_work::{ObservedConnection, WorkMeter},
};

fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("records.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE record_keys_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
         INSERT INTO record_keys_meta VALUES('engine','\"record-log\"');
         CREATE TABLE record_log(id TEXT,transaction_id TEXT,actor_context TEXT,application_time TEXT,system_time TEXT,part INTEGER,parts INTEGER,envelopes TEXT);
         CREATE TABLE record_keys_runs(run INTEGER PRIMARY KEY,age INTEGER,pages INTEGER,last TEXT,page_format INTEGER,page_layout INTEGER);
         CREATE TABLE record_keys_big(ref TEXT,part INTEGER,body TEXT,PRIMARY KEY(ref,part)) WITHOUT ROWID;
         CREATE TABLE record_keys_run_1(page INTEGER PRIMARY KEY,first TEXT,body TEXT NOT NULL);",
    ).unwrap();
    let key = "i\0root";
    let first = serde_json::to_string(key).unwrap();
    let value = r#"{"answer":"one"}"#;
    let raw = format!(r#"["page","retained-sequence",{value},{{"at":"retained-stamp"}}]"#);
    let body = format!(
        "{}\n{raw}",
        json!({"p":[0],"s":[key],"d":[raw.encode_utf16().count()]})
    );
    db.execute("INSERT INTO record_keys_runs VALUES(1,1,1,?,0,1)", [&first])
        .unwrap();
    db.execute(
        "INSERT INTO record_keys_run_1 VALUES(0,?,?)",
        rusqlite::params![first, body],
    )
    .unwrap();
    drop(db);
    (temp, path)
}

fn reader(
    path: &std::path::Path,
    meter: WorkMeter,
) -> SnapshotRecordSql<impl FnMut() -> trillion_local::import::ImportResult<()>> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    // SAFETY: this is a new, exclusively owned read-only handle with no prior trace hook.
    let observed = unsafe { ObservedConnection::attach_untraced(db, meter) }.unwrap();
    SnapshotRecordSql::begin(
        observed,
        ReadLimits::default(),
        || Ok(()),
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap()
}

#[test]
fn one_indexed_row_and_canonical_reader_return_the_same_answer_with_measured_work() {
    let (_temp, path) = fixture();

    let direct_meter = WorkMeter::new();
    let mut direct = reader(&path, direct_meter.clone());
    let before_direct = direct_meter.snapshot().unwrap().work;
    let rows = direct
        .query("SELECT body FROM record_keys_run_1 WHERE page=0", &[])
        .unwrap()
        .rows;
    direct.finish().unwrap();
    let after_direct = direct_meter.snapshot().unwrap().work;
    assert_eq!(rows.len(), 1);
    let SqlValue::Text(body) = &rows[0][0] else {
        panic!("expected text checkpoint body")
    };
    let raw = std::str::from_utf8(body)
        .unwrap()
        .split_once('\n')
        .unwrap()
        .1;
    let direct_value: Value = serde_json::from_str(raw).unwrap();
    assert_eq!(direct_value[2], json!({"answer":"one"}));

    let canonical_meter = WorkMeter::new();
    let canonical_source = reader(&path, canonical_meter.clone());
    let before_canonical = canonical_meter.snapshot().unwrap().work;
    let kept = LegacyKept::new(Default::default()).unwrap();
    let mut canonical = LegacyRecords::open_source(canonical_source, Bounds::default()).unwrap();
    let record = canonical.read_stored("root", &kept).unwrap().unwrap();
    canonical.into_source().finish().unwrap();
    let after_canonical = canonical_meter.snapshot().unwrap().work;
    let canonical_value: Value = serde_json::from_str(&record.value_json).unwrap();
    assert_eq!(canonical_value, direct_value[2]);
    assert_eq!(record.id, "root");
    assert_eq!(
        after_direct.sqlite_scan_visits - before_direct.sqlite_scan_visits,
        1
    );
    assert_eq!(after_direct.rows_written - before_direct.rows_written, 0);
    assert_eq!(
        after_canonical.rows_written - before_canonical.rows_written,
        0
    );
    eprintln!("ONE_ROW_AB direct_sql={} direct_visits={} direct_writes={} canonical_sql={} canonical_visits={} canonical_writes={}",
        after_direct.sql_statements - before_direct.sql_statements,
        after_direct.sqlite_scan_visits - before_direct.sqlite_scan_visits,
        after_direct.rows_written - before_direct.rows_written,
        after_canonical.sql_statements - before_canonical.sql_statements,
        after_canonical.sqlite_scan_visits - before_canonical.sqlite_scan_visits,
        after_canonical.rows_written - before_canonical.rows_written);
}
