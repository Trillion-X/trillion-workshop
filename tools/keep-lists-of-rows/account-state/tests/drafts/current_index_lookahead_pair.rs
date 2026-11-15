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
pub(super) struct Fixture {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
}
impl Fixture {
    pub(super) fn new(count: usize, body: Option<String>, malformed: bool) -> Self {
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
        unsafe { meter.enable_fixture_statement_attribution(512).unwrap(); }
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
pub(super) fn query(
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
    );
    eprintln!("INDEX_SOURCE_LEDGER shared={:?} page_ok={}",source.work().unwrap(),page.is_ok());
    drop(records);
    source.finish().unwrap();
    let work = meter.snapshot().unwrap().work;
    let statements=meter.fixture_statement_snapshot().unwrap();
    assert!(statements.complete);
    let mut families=std::collections::BTreeMap::<&str,(u64,u64,u64)>::new();
    for statement in statements.statements {
        let sql=statement.sql_template.to_ascii_lowercase();
        let family=if sql.contains("record_log where") { "log_replay" }
            else if sql.contains("record_log order by") { "log_frontier" }
            else if sql.contains("pragma") { "pragmas" }
            else if sql.contains("record_keys_meta") { "engine_frontier_meta" }
            else if sql.contains("record_keys_runs as catalogue") { "checkpoint_catalogue" }
            else if sql.starts_with("with recursive seeking") { "checkpoint_fence_seek" }
            else if sql.starts_with("select length(cast(body") { "checkpoint_point_body" }
            else if sql.starts_with("select page,first,length") { "checkpoint_range_page" }
            else { "other" };
        let entry=families.entry(family).or_default();
        entry.0+=statement.work.sql_statements;entry.1+=statement.work.sqlite_scan_visits;entry.2+=statement.work.rows_returned;
    }
    eprintln!("INDEX_SQL_FAMILIES {}",serde_json::to_string(&families).unwrap());
    if let Err(error) = &page {
        eprintln!("current-index refused total statements={} visits={} writes={} returned={} error={error:?}",work.sql_statements,work.sqlite_scan_visits,work.rows_written,work.rows_returned);
    }
    Ok((page?, work))
}
fn changes(count: usize) -> String {
    serde_json::to_string(&(0..count).map(|at|json!({"id":format!("decision:{at:05}"),"type":"decision","set":{"created_at":format!("new:{at:05}")},"at":"z","seq":format!("new:{at:05}")})).collect::<Vec<_>>()).unwrap()
}

#[test]
fn matched_exact_and_continued_checkpoint_pages() {
    for count in [100usize, 101, 400] {
        let f = Fixture::new(count, None, false);
        let mut q = Query {
            limit: 100,
            reverse: true,
            ..Default::default()
        };
        let mut seen = Vec::new();
        let pages = count.div_ceil(100);
        for page_number in 0..pages {
            let (page, work) = query(&f, &q, Default::default())
                .expect("existing caps must allow one useful page");
            eprintln!("current-index lookahead count={} page={} statements={} visits={} writes={} returned={} selected={} checkpoint_pages={} complete={}",count,page_number+1,work.sql_statements,work.sqlite_scan_visits,work.rows_written,work.rows_returned,page.entries.len(),page.work.checkpoint.page_bodies,page.complete);
            assert_eq!(page.entries.len(), (count - page_number * 100).min(100));
            assert_eq!(page.complete, page_number + 1 == pages);
            assert_eq!(page.next.is_none(), page.complete);
            seen.extend(page.entries.into_iter().map(|entry| entry.id));
            q.cursor = page.next;
        }
        let expected = (0..count)
            .rev()
            .map(|at| format!("decision:{at:05}"))
            .collect::<Vec<_>>();
        assert_eq!(seen, expected);
    }
}
#[test]
fn duplicate_envelopes_deletion_retype_and_moves_keep_exact_paginated_results() {
    let body = json!([
        {"id":"decision:00001","set":{"created_at":"z1"},"at":"z","seq":"move"},
        {"id":"decision:00002","remove":true,"at":"z","seq":"remove"},
        {"id":"decision:00003","type":"other","value":{"created_at":"z3"},"at":"z","seq":"retype"},
        {"id":"decision:new","type":"decision","value":{"created_at":"z2"},"at":"z","seq":"new"},
        {"id":"decision:00001","set":{"extra":true},"at":"zz","seq":"again"}
    ])
    .to_string();
    let f = Fixture::new(20, Some(body), false);
    let mut q = Query {
        limit: 3,
        reverse: true,
        ..Default::default()
    };
    let mut found = Vec::new();
    for _ in 0..10 {
        let (page, _) = query(&f, &q, Default::default()).unwrap();
        found.extend(page.entries.iter().map(|e| e.id.clone()));
        if page.complete {
            break;
        }
        q.cursor = page.next;
    }
    assert_eq!(
        &found[..2],
        &[String::from("decision:new"), String::from("decision:00001")]
    );
    assert_eq!(found.len(), 19);
    assert_eq!(found.iter().collect::<BTreeSet<_>>().len(), 19);
    assert!(!found
        .iter()
        .any(|id| id == "decision:00002" || id == "decision:00003"));
}

#[test]
fn checkpoint_page_cap_remains_a_real_refusal() {
    let f = Fixture::new(400, None, false);
    let q = Query {
        limit: 100,
        reverse: true,
        ..Default::default()
    };
    let limits = CurrentIndexLimits {
        checkpoint_pages: 1,
        ..Default::default()
    };
    assert!(matches!(
        query(&f, &q, limits),
        Err(record_indexes::Error::CheckpointRange {
            budget_exhausted: true,
            ..
        })
    ));
}

#[test]
fn dirty_one_record_across_132_log_rows_keeps_current_index_result_under_original_caps() {
    for count in [1usize, 20, 101, 400] {
        let f=Fixture::new(count, Some("[]".into()), false);
        let db=Connection::open(&f.path).unwrap();
        db.execute("DELETE FROM record_log",[]).unwrap();
        for row in 0..132 {
            let body=json!([{"id":"decision:00000","type":"decision","set":{"created_at":format!("new:{row:05}")},"at":format!("z{row:05}"),"seq":format!("seq:{row:05}")}]).to_string();
            db.execute("INSERT INTO record_log VALUES(?,?,'fixture','a','a',0,1,?,NULL)",params![format!("01234567-89ab-7cde-8f01-{row:012}"),format!("tx:{row}"),body]).unwrap();
        }
        drop(db);
        let q=Query{limit:100,reverse:true,..Default::default()};
        match query(&f,&q,Default::default()) {
            Ok((page,work))=>{
                eprintln!("DIRTY132 count={} calls={} returned={} bytes={} dirty={} selected={} sql={} visits={} writes={}",count,page.work.record_log_statements,page.work.record_log_rows,page.work.record_log_source_bytes,page.work.dirty_records,page.entries.len(),work.sql_statements,work.sqlite_scan_visits,work.rows_written);
                assert_eq!(page.work.dirty_records,1);
                assert_eq!(page.entries.len(),count.min(100));
                assert_eq!(page.entries[0].id,"decision:00000");
                assert!(page.work.record_log_statements<=128);
                assert_eq!(work.rows_written,0);
            },
            Err(error)=>{
                eprintln!("DIRTY132 count={} error={error:?}",count);
                panic!("132 rows with one dirty id must not require 132 supplier calls");
            }
        }
    }
}

include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/current_index_matrix.rs"));
include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/current_index_multipart132.rs"));

include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/current_index_multipart_supplemental.rs"));
