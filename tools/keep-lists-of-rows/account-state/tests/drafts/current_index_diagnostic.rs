//! Real SQLite/kept checkpoints and canonical stamp replay; no account access.
use super::*;
use crate::{
    current_record_keys::SharedRecordSql,
    import::{ImportResult, ReadLimits},
    record_source::SnapshotRecordSql,
    sqlite_work::{ObservedConnection, WorkMeter},
};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::json;
use std::sync::{atomic::AtomicBool, Arc};

type Source = SharedRecordSql<SnapshotRecordSql<fn() -> ImportResult<()>>>;
struct Fixture {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
}
impl Fixture {
    fn new(count: usize, body: Option<String>, malformed: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("original.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE record_keys_meta(key TEXT PRIMARY KEY,value TEXT) WITHOUT ROWID; INSERT INTO record_keys_meta VALUES('engine','\"record-log\"'); CREATE TABLE record_log(id TEXT,transaction_id TEXT,actor_context TEXT,application_time TEXT,system_time TEXT,part INTEGER,parts INTEGER,envelopes TEXT,keys TEXT); CREATE TABLE record_keys_runs(run INTEGER PRIMARY KEY,age INTEGER,pages INTEGER,last TEXT,page_format INTEGER,page_layout INTEGER); CREATE TABLE record_keys_big(ref TEXT,part INTEGER,body TEXT,PRIMARY KEY(ref,part)) WITHOUT ROWID; CREATE TABLE record_keys_run_1(page INTEGER PRIMARY KEY,first TEXT,body TEXT)").unwrap();
        db.execute(
            "INSERT INTO record_keys_meta VALUES('covered',?)",
            [if body.is_some() || malformed {
                "0"
            } else {
                "1"
            }],
        )
        .unwrap();
        let mut entries = Vec::new();
        for at in 0..count {
            let id = format!("decision:{at:05}");
            let date = format!("date:{at:05}");
            let raw = format!(
                r#"["decision","old-sequence",{{"created_at":{},"title":"\ud800","large":{}}},{{"at":"a"}}]"#,
                serde_json::to_string(&date).unwrap(),
                serde_json::to_string(&"x".repeat(8192)).unwrap()
            );
            entries.push((format!("i\0{id}"), raw));
            entries.push((
                format!(
                    "f\0decision\0created_at\0{}\0{id}",
                    serde_json::to_string(&date).unwrap()
                ),
                "1".into(),
            ));
        }
        entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
        if let Some((last, _)) = entries.last() {
            db.execute(
                "INSERT INTO record_keys_runs VALUES(1,1,?,?,0,1)",
                params![entries.len() as i64, serde_json::to_string(last).unwrap()],
            )
            .unwrap();
        }
        for (at, (key, value)) in entries.into_iter().enumerate() {
            let page = format!(
                "{}\n{value}",
                json!({"s":[key],"p":[0],"d":[value.encode_utf16().count()]})
            );
            db.execute(
                "INSERT INTO record_keys_run_1 VALUES(?,?,?)",
                params![at as i64, serde_json::to_string(&key).unwrap(), page],
            )
            .unwrap();
        }
        let body = if malformed {
            "not-json".into()
        } else {
            body.unwrap_or_else(|| "[]".into())
        };
        db.execute("INSERT INTO record_log VALUES('01234567-89ab-7cde-8f01-234567890abc','transaction','fixture','a','a',0,1,?,NULL)",[body]).unwrap();
        Self { _dir: dir, path }
    }
    fn source(&self) -> (Source, WorkMeter) {
        let db = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .unwrap();
        let meter = WorkMeter::new();
        let db = unsafe { ObservedConnection::attach_untraced(db, meter.clone()) }.unwrap();
        let witness: fn() -> ImportResult<()> = || Ok(());
        let source = SnapshotRecordSql::begin(
            db,
            ReadLimits::default(),
            witness,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        (
            SharedRecordSql::new_reusing_snapshot(source, Default::default()).unwrap(),
            meter,
        )
    }
}
struct Ready(String);
impl Readiness for Ready {
    fn assert_ready(&self, _: &record_indexes::Declaration, signature: &str) -> bool {
        self.0 == signature
    }
}
fn indexes() -> Indexes {
    Indexes::new(record_indexes::Data {
        indexes: vec![record_indexes::Declaration {
            record_type: "decision".into(),
            name: "created_at".into(),
            paths: vec![vec!["created_at".into()]],
            r#where: vec![],
            carry: vec![],
            carry_exists: None,
            backfill: None,
            retired: false,
        }],
    })
    .unwrap()
}
fn query(
    f: &Fixture,
    q: &Query,
    limits: CurrentIndexLimits,
) -> record_indexes::Result<(CurrentIndexPage, crate::scan::ReadWork)> {
    let (source, meter) = f.source();
    let mut records =
        LegacyRecords::open_for_current_head(source.clone(), Default::default()).unwrap();
    let indexes = indexes();
    let ready = Ready(indexes.signature("decision", "created_at").unwrap());
    let page = records.scan_index_with_tail(
        &LegacyKept::new(Default::default()).unwrap(),
        &indexes,
        "decision",
        "created_at",
        q,
        None,
        &ready,
        &|v| serde_json::to_string(v).map_err(record_indexes::Error::from),
        &mut record_indexes::PlainFields,
        record_indexes::current::default_read_budget(std::time::Duration::from_secs(5)).unwrap(),
        limits,
    )?;
    drop(records);
    source.finish().unwrap();
    Ok((page, meter.snapshot().unwrap().work))
}
fn changes(count: usize) -> String {
    serde_json::to_string(&(0..count).map(|at|json!({"id":format!("decision:{at:05}"),"type":"decision","set":{"created_at":format!("new:{at:05}")},"at":"z","seq":format!("new:{at:05}")})).collect::<Vec<_>>()).unwrap()
}

#[test]
fn bound_diagnostics_are_closed_and_retain_actual_discovered_dirty_count() {
    let f = Fixture::new(2, Some(changes(2)), false);
    let error = query(
        &f,
        &Query {
            limit: 1,
            ..Default::default()
        },
        CurrentIndexLimits {
            dirty_ids: 1,
            ..Default::default()
        },
    )
    .err()
    .unwrap();
    let record_indexes::Error::CurrentIndexBound(d, _) = error else {
        panic!("closed dirty limit failure required: {error:?}")
    };
    assert_eq!(d.reason, IndexBoundReason::DirtyRecords);
    assert_eq!(d.dirty_records, 1);
    assert_eq!(d.uncovered_log_rows, 1);
    assert!(d
        .numeric_header()
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"=,-".contains(&b)));
    let f = Fixture::new(0, None, true);
    let error = query(
        &f,
        &Query {
            limit: 1,
            ..Default::default()
        },
        Default::default(),
    )
    .err()
    .unwrap();
    let record_indexes::Error::CurrentIndexBound(d, _) = error else {
        panic!("closed refusal diagnostic required")
    };
    assert_eq!(d.reason, IndexBoundReason::DirtyTailRefused);
    assert_eq!(d.uncovered_log_rows, 1);
}
