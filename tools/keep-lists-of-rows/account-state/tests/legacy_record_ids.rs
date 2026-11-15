//! Actual readonly SQLite suppliers and canonical stamps; no account/key owner
//! or provider is fabricated. Native owns serialized Cargo qualification.
use rusqlite::{params, types::Value, Connection, OpenFlags};
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};
use tempfile::TempDir;
use trillion_local::{
    ecma_json::JsString,
    import::{ImportResult, QueryRows, QueryTiming, ReadLimits},
    legacy_kept::{LegacyKept, Limits},
    legacy_records::{
        ids::{IdsLimits, IdsPage, IdsRequest},
        Bounds, Error, LegacyRecords,
    },
    record_source::{BoundedRecordSql, QueryBudget, SnapshotRecordSql},
};
const LOG: &str = "01234567-89ab-7cde-8f01-234567890abc";
type Witness = fn() -> ImportResult<()>;
struct Fixture {
    _dir: TempDir,
    path: PathBuf,
}
fn fixture(build: impl FnOnce(&Connection)) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA journal_mode=DELETE;CREATE TABLE record_keys_meta(key TEXT PRIMARY KEY,value TEXT) WITHOUT ROWID;INSERT INTO record_keys_meta VALUES('engine','\"record-log\"');CREATE TABLE record_log(id TEXT,transaction_id TEXT,actor_context TEXT,application_time TEXT,system_time TEXT,part INTEGER,parts INTEGER,envelopes TEXT,keys TEXT);CREATE TABLE record_keys_runs(run INTEGER PRIMARY KEY,age INTEGER,pages INTEGER,last TEXT,page_format INTEGER,page_layout INTEGER);CREATE TABLE record_keys_big(ref TEXT,part INTEGER,body TEXT,PRIMARY KEY(ref,part)) WITHOUT ROWID;").unwrap();
    build(&db);
    db.close().unwrap();
    Fixture { _dir: dir, path }
}
fn checkpoint(db: &Connection, mut entries: Vec<(String, String)>) {
    entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    if entries.is_empty() {
        return;
    }
    db.execute_batch(
        "CREATE TABLE record_keys_run_1(page INTEGER PRIMARY KEY,first TEXT,body TEXT)",
    )
    .unwrap();
    db.execute(
        "INSERT INTO record_keys_runs VALUES(1,1,?,?,0,1)",
        params![
            entries.len() as i64,
            serde_json::to_string(&entries.last().unwrap().0).unwrap()
        ],
    )
    .unwrap();
    for (index, (key, value)) in entries.into_iter().enumerate() {
        let body = format!(
            "{}\n{value}",
            json!({"s":[key],"p":[0],"d":[value.encode_utf16().count()]})
        );
        db.execute(
            "INSERT INTO record_keys_run_1 VALUES(?,?,?)",
            params![index as i64, serde_json::to_string(&key).unwrap(), body],
        )
        .unwrap();
    }
}
fn record(id: &str, kind: &str) -> Vec<(String, String)> {
    vec![
        (
            format!("i\0{id}"),
            json!([kind,"old",{"held":1},{"at":"a"}]).to_string(),
        ),
        (format!("t\0{kind}\0{id}"), "1".into()),
    ]
}
fn tail(db: &Connection, row: i64, id: &str, tx: &str, part: i64, parts: i64, body: &str) {
    db.execute("INSERT INTO record_log(rowid,id,transaction_id,actor_context,application_time,system_time,part,parts,envelopes,keys) VALUES(?,?,?,'actor','valid','system',?,?,?,?)",params![row,id,tx,part,parts,body,"private-key-slot-sentinel"]).unwrap();
}
struct Source {
    inner: SnapshotRecordSql<Witness>,
    calls: Arc<AtomicUsize>,
    cancel: Arc<AtomicBool>,
    sql: Vec<String>,
    finishes: usize,
    fail_finish: Option<usize>,
}
fn source(f: &Fixture, limits: ReadLimits) -> Source {
    let db = Connection::open_with_flags(
        &f.path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let witness: Witness = || Ok(());
    Source {
        inner: SnapshotRecordSql::begin(db, limits, witness, cancel.clone()).unwrap(),
        calls: Arc::new(AtomicUsize::new(0)),
        cancel,
        sql: Vec::new(),
        finishes: 0,
        fail_finish: None,
    }
}
impl BoundedRecordSql for Source {
    fn read_source_state(&mut self) -> ImportResult<trillion_local::record_source::ReadSourceState> {
        self.inner.read_source_state()
    }
    fn read_limits(&self) -> Option<&ReadLimits> {
        self.inner.read_limits()
    }
    fn query(&mut self, sql: &str, params: &[Value]) -> ImportResult<QueryRows> {
        self.inner.query(sql, params)
    }
    fn query_with_budget(
        &mut self,
        sql: &str,
        params: &[Value],
        budget: QueryBudget,
    ) -> ImportResult<QueryRows> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.sql.push(sql.into());
        if sql == "SELECT 1" {
            self.finishes += 1;
            if self.fail_finish == Some(self.finishes) {
                self.cancel.store(true, Ordering::SeqCst);
            }
        }
        self.inner.query_with_budget(sql, params, budget)
    }
    fn last_query_timing(&self) -> Option<QueryTiming> {
        self.inner.last_query_timing()
    }
}
fn reader(f: &Fixture) -> LegacyRecords<Source> {
    LegacyRecords::open_source(source(f, ReadLimits::default()), Bounds::default()).unwrap()
}
fn kept() -> LegacyKept {
    LegacyKept::new(Limits::default()).unwrap()
}
fn ids(
    reader: &mut LegacyRecords<Source>,
    kind: &str,
    prefix: &str,
    before: Option<&str>,
    limit: usize,
) -> Result<IdsPage, Error> {
    let prefix = JsString::from(prefix);
    let before = before.map(JsString::from);
    reader.ids_of_type(
        IdsRequest {
            record_type: kind,
            prefix: &prefix,
            before: before.as_ref(),
            limit,
        },
        IdsLimits::default(),
        &kept(),
    )
}
#[test]
fn checkpoint_ids_are_reverse_literal_and_strictly_before_with_real_continuation() {
    let f = fixture(|db| {
        checkpoint(
            db,
            ["a", "b", "c", "d", "x%_a", "x%_b", "xzza"]
                .into_iter()
                .map(|id| {
                    (
                        format!("t\0page\0{id}"),
                        "INVALID-UNOPENED-TYPE-VALUE".into(),
                    )
                })
                .collect(),
        )
    });
    let bytes = fs::read(&f.path).unwrap();
    let mut r = reader(&f);
    let first = ids(&mut r, "page", "", Some("d"), 2).unwrap();
    assert_eq!(first.ids, vec!["c", "b"]);
    assert_eq!(first.next.as_deref(), Some("b"));
    assert!(!first.complete);
    let second = ids(&mut r, "page", "", first.next.as_deref(), 2).unwrap();
    assert_eq!(second.ids, vec!["a"]);
    assert!(second.complete);
    assert_eq!(
        ids(&mut r, "page", "x%_", None, 9).unwrap().ids,
        vec!["x%_b", "x%_a"]
    );
    assert!(ids(&mut r, "page", "z", Some("a"), 2)
        .unwrap()
        .ids
        .is_empty());
    assert_eq!(fs::read(&f.path).unwrap(), bytes);
    let s = r.into_source();
    assert!(!s
        .sql
        .iter()
        .any(|sql| sql.contains("AS legacy FROM") && !sql.contains("instr(body")));
}

#[test]
fn complete_type_visitor_emits_bounded_chunks_from_one_canonical_merge() {
    let f = fixture(|db| {
        checkpoint(
            db,
            (0..40)
                .map(|number| {
                    let id = format!("id{number:02}");
                    (format!("t\0page\0{id}"), "1".into())
                })
                .collect(),
        );
        tail(
            db,
            1,
            LOG,
            "tx",
            0,
            1,
            r#"[{"id":"id39","remove":true,"at":"z","seq":"gone"},{"id":"id40","type":"page","value":{},"at":"b","seq":"new"}]"#,
        );
    });
    let prefix = JsString::default();
    let mut r = reader(&f);
    let mut chunks = Vec::new();
    let work = r
        .visit_ids_of_type(
            IdsRequest {
                record_type: "page",
                prefix: &prefix,
                before: None,
                limit: 32,
            },
            IdsLimits::default(),
            &kept(),
            4096,
            |chunk| {
                chunks.push(chunk);
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(chunks.iter().map(Vec::len).collect::<Vec<_>>(), vec![32, 8]);
    let ids = chunks.into_iter().flatten().collect::<Vec<_>>();
    let expected = std::iter::once(40)
        .chain((0..=38).rev())
        .map(|number| format!("id{number:02}"))
        .collect::<Vec<_>>();
    assert_eq!(ids, expected);
    assert_eq!(work.dirty_records, 2);
    assert_eq!(work.checkpoint_entries, 40);
}

#[test]
fn complete_type_visitor_accepts_the_exact_4096_checkpoint_entry_ceiling() {
    const COUNT: usize = 4096;
    let f = fixture(|db| {
        let keys = (0..COUNT)
            .map(|number| format!("t\0page\0id{number:04}"))
            .collect::<Vec<_>>();
        let first = keys.first().unwrap().clone();
        let last = keys.last().unwrap().clone();
        let body = format!(
            "{}\n{}",
            json!({
                "s": keys,
                "p": vec![0; COUNT],
                "d": vec![1; COUNT],
            }),
            "1".repeat(COUNT),
        );
        db.execute_batch(
            "CREATE TABLE record_keys_run_1(page INTEGER PRIMARY KEY,first TEXT,body TEXT)",
        )
        .unwrap();
        db.execute(
            "INSERT INTO record_keys_runs VALUES(1,1,1,?,0,1)",
            params![serde_json::to_string(&last).unwrap()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO record_keys_run_1 VALUES(0,?,?)",
            params![serde_json::to_string(&first).unwrap(), body],
        )
        .unwrap();
    });
    let prefix = JsString::default();
    let mut r = reader(&f);
    let mut visited = 0usize;
    let mut first = None;
    let mut last = None;
    let work = r
        .visit_ids_of_type(
            IdsRequest {
                record_type: "page",
                prefix: &prefix,
                before: None,
                limit: 32,
            },
            IdsLimits::default(),
            &kept(),
            4096,
            |chunk| {
                visited += chunk.len();
                first.get_or_insert_with(|| chunk.first().unwrap().clone());
                last = chunk.last().cloned();
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(visited, COUNT);
    assert_eq!(first.as_deref(), Some("id4095"));
    assert_eq!(last.as_deref(), Some("id0000"));
    assert_eq!(work.checkpoint_entries, COUNT);
}
#[test]
fn committed_dirty_types_delete_move_recreate_and_create_merge_with_checkpoint_keys() {
    let f = fixture(|db| {
        let mut entries = record("z", "page");
        entries.extend(record("y", "page"));
        entries.extend(record("x", "other"));
        entries.extend(record("w", "page"));
        checkpoint(db, entries);
        tail(
            db,
            1,
            LOG,
            "tx",
            0,
            1,
            &json!([
                {"id":"z","remove":true,"at":"z","seq":"remove"},
                {"id":"y","type":"other","value":{},"at":"b","seq":"moved"},
                {"id":"x","type":"page","value":{},"at":"b","seq":"moved-in"},
                {"id":"v","type":"page","value":{},"at":"b","seq":"new"}
            ])
            .to_string(),
        );
    });
    let mut r = reader(&f);
    let page = ids(&mut r, "page", "", None, 20).unwrap();
    assert_eq!(page.ids, vec!["x", "w", "v"]);
    assert_eq!(page.work.dirty_records, 4);
    assert!(page.complete);
    assert_eq!(ids(&mut r, "other", "", None, 20).unwrap().ids, vec!["y"]);
    let s = r.into_source();
    assert!(s
        .sql
        .iter()
        .filter(|q| q.contains("FROM record_log") && q.contains("envelopes"))
        .all(|q| q.contains("NULL") && !q.contains("source.keys")));
}
#[test]
fn canonical_removal_floor_rejects_stale_resurrection_and_later_patch_recreates() {
    for recreate in [false, true] {
        let f = fixture(|db| {
            checkpoint(db, record("x", "page"));
            let mut body = vec![
                json!({"id":"x","remove":true,"at":"z","seq":"gone"}),
                json!({"id":"x","type":"page","value":{"stale":1},"at":"b","seq":"stale"}),
            ];
            if recreate {
                body.push(
                    json!({"id":"x","type":"page","set":{"fresh":1},"at":"zz","seq":"fresh"}),
                );
            }
            tail(
                db,
                1,
                LOG,
                "tx",
                0,
                1,
                &serde_json::to_string(&body).unwrap(),
            );
        });
        assert_eq!(
            ids(&mut reader(&f), "page", "", None, 5).unwrap().ids,
            if recreate { vec!["x"] } else { vec![] }
        );
    }
}
#[test]
fn canonical_exact_and_purge_semantics_do_not_leave_stale_type_membership() {
    let f = fixture(|db| {
        let mut entries = record("z", "page");
        entries.extend(record("y", "other"));
        checkpoint(db, entries);
        tail(
            db,
            1,
            LOG,
            "tx",
            0,
            1,
            &json!([
                {"id":"z","purge":true},
                {"id":"y","type":"page","value":{},"at":"0","seq":"exact","exact":true}
            ])
            .to_string(),
        );
    });
    assert_eq!(
        ids(&mut reader(&f), "page", "", None, 5).unwrap().ids,
        vec!["y"]
    );
}
#[test]
fn multipart_tail_is_complete_in_order_before_membership_and_accepts_rowid_gaps() {
    let f = fixture(|db| {
        let body = r#"[{"id":"new","type":"page","value":{}}]"#;
        let split = 22;
        tail(db, 1, LOG, "tx", 0, 2, &body[..split]);
        tail(db, 3, &format!("{LOG}.1"), "tx", 1, 2, &body[split..]);
    });
    let mut r = reader(&f);
    assert_eq!(ids(&mut r, "page", "", None, 5).unwrap().ids, vec!["new"]);
}
#[test]
fn malformed_incomplete_or_reordered_tail_never_returns_checkpoint_ids_as_current() {
    for fault in [
        "missing",
        "transaction",
        "part-id",
        "stray",
        "json",
        "late-json",
    ] {
        let f = fixture(|db| {
            checkpoint(db, record("checkpoint", "page"));
            match fault {
                "missing" => tail(db, 1, LOG, "tx", 0, 2, "["),
                "transaction" => {
                    tail(db, 1, LOG, "tx", 0, 2, "[");
                    tail(db, 2, &format!("{LOG}.1"), "wrong", 1, 2, "]");
                }
                "part-id" => {
                    tail(db, 1, LOG, "tx", 0, 2, "[");
                    tail(db, 2, "wrong", "tx", 1, 2, "]");
                }
                "stray" => tail(db, 1, &format!("{LOG}.1"), "tx", 1, 2, "]"),
                "late-json" => {
                    tail(
                        db,
                        1,
                        LOG,
                        "tx",
                        0,
                        1,
                        r#"[{"id":"new","type":"page","value":{}}]"#,
                    );
                    tail(db, 2, LOG, "late", 0, 1, "[{invalid}]");
                }
                _ => tail(db, 1, LOG, "tx", 0, 1, "[{invalid}]"),
            }
        });
        assert!(
            ids(&mut reader(&f), "page", "", None, 5).is_err(),
            "{fault}"
        );
    }
}
#[test]
fn literal_interval_does_not_open_unrelated_dirty_checkpoint_bodies() {
    let f = fixture(|db| {
        checkpoint(
            db,
            vec![
                ("i\0elsewhere".into(), "CORRUPT-UNRELATED-POINTER".into()),
                (
                    "t\0page\0only:a".into(),
                    "INVALID-UNOPENED-TYPE-VALUE".into(),
                ),
            ],
        );
        tail(
            db,
            1,
            LOG,
            "tx",
            0,
            1,
            r#"[{"id":"elsewhere","type":"other","value":"not selected fields"}]"#,
        );
    });
    let page = ids(&mut reader(&f), "page", "only:", None, 3).unwrap();
    assert_eq!(page.ids, vec!["only:a"]);
    assert_eq!(page.work.dirty_records, 0);
}
#[test]
fn checkpoint_refills_past_shadowed_deleted_keys_to_fill_a_bounded_page() {
    let f = fixture(|db| {
        checkpoint(
            db,
            ["z", "y", "x", "w", "v"]
                .into_iter()
                .flat_map(|id| record(id, "page"))
                .collect(),
        );
        tail(
            db,
            1,
            LOG,
            "tx",
            0,
            1,
            &json!([{"id":"z","purge":true},{"id":"y","purge":true},{"id":"x","purge":true}])
                .to_string(),
        );
    });
    let page = ids(&mut reader(&f), "page", "", None, 2).unwrap();
    assert_eq!(page.ids, vec!["w", "v"]);
    assert!(page.complete);
}
#[test]
fn utf16_id_order_and_lone_surrogate_prefix_end_match_the_existing_index() {
    let f = fixture(|db| {
        checkpoint(
            db,
            ["p\u{d7ff}a", "p😀", "p\u{e000}"]
                .into_iter()
                .map(|id| (format!("t\0page\0{id}"), "1".into()))
                .collect(),
        )
    });
    let mut r = reader(&f);
    assert_eq!(
        ids(&mut r, "page", "p", None, 5).unwrap().ids,
        vec!["p\u{e000}", "p😀", "p\u{d7ff}a"]
    );
    assert_eq!(
        ids(&mut r, "page", "p\u{d7ff}", None, 5).unwrap().ids,
        vec!["p\u{d7ff}a"]
    );
    let prefix = JsString::from("p");
    let before = JsString::from_units(vec![b'p' as u16, 0xd800]);
    let page = r
        .ids_of_type(
            IdsRequest {
                record_type: "page",
                prefix: &prefix,
                before: Some(&before),
                limit: 5,
            },
            IdsLimits::default(),
            &kept(),
        )
        .unwrap();
    assert_eq!(page.ids, vec!["p\u{d7ff}a"]);
}
#[test]
fn covered_log_rows_are_not_replayed_or_scanned_as_current_tail() {
    let f = fixture(|db| {
        checkpoint(db, record("old", "page"));
        db.execute("INSERT INTO record_keys_meta VALUES('covered','1')", [])
            .unwrap();
        tail(db, 1, LOG, "covered", 0, 1, "COVERED-MALFORMED-NOT-READ");
        tail(
            db,
            2,
            LOG,
            "current",
            0,
            1,
            r#"[{"id":"new","type":"page","value":{}}]"#,
        );
    });
    let mut r = reader(&f);
    assert_eq!(
        ids(&mut r, "page", "", None, 5).unwrap().ids,
        vec!["old", "new"]
    );
    assert!(r
        .into_source()
        .sql
        .iter()
        .filter(|sql| sql.contains("envelopes") && sql.contains("FROM record_log"))
        .all(|sql| sql.contains("WHERE rowid>?") && sql.contains("rowid<=?")));
}
#[test]
fn aggregate_statement_allowance_charges_real_tail_points_ranges_and_never_dispatches_over_cap() {
    let f = fixture(|db| {
        checkpoint(db, record("x", "page"));
        tail(
            db,
            1,
            LOG,
            "tx",
            0,
            1,
            r#"[{"id":"x","remove":true,"at":"b","seq":"gone"}]"#,
        );
    });
    let s = source(&f, ReadLimits::default());
    let calls = s.calls.clone();
    let mut r = LegacyRecords::open_source(
        s,
        Bounds {
            statements: 10,
            ..Bounds::default()
        },
    )
    .unwrap();
    let before = calls.load(Ordering::SeqCst);
    assert!(matches!(
        ids(&mut r, "page", "", None, 5),
        Err(Error::Bounds(_))
    ));
    assert!(calls.load(Ordering::SeqCst) - before <= 10);
}
#[test]
fn dirty_count_held_output_and_checkpoint_work_caps_refuse_without_partial_success() {
    let f = fixture(|db| {
        checkpoint(
            db,
            ["aa", "bb", "cc"]
                .into_iter()
                .flat_map(|id| record(id, "page"))
                .collect(),
        );
        tail(
            db,
            1,
            LOG,
            "tx",
            0,
            1,
            r#"[{"id":"aa","type":"page","set":{"x":1},"at":"b","seq":"new"},{"id":"bb","type":"page","set":{"x":1},"at":"b","seq":"new"}]"#,
        );
    });
    let prefix = JsString::default();
    for which in ["dirty", "held", "output", "entries", "pages"] {
        let mut cap = IdsLimits::default();
        match which {
            "dirty" => cap.dirty_ids = 1,
            "held" => cap.held_bytes = 1,
            "output" => cap.output_bytes = 1,
            "entries" => cap.checkpoint_entries = 1,
            "pages" => cap.checkpoint_pages = 1,
            _ => unreachable!(),
        }
        assert!(
            matches!(
                reader(&f).ids_of_type(
                    IdsRequest {
                        record_type: "page",
                        prefix: &prefix,
                        before: None,
                        limit: 5
                    },
                    cap,
                    &kept()
                ),
                Err(Error::Bounds(_))
            ),
            "{which}"
        );
    }
}
#[test]
fn one_id_output_byte_cap_does_not_charge_the_type_prefix_or_withheld_lookahead() {
    let f = fixture(|db| {
        checkpoint(
            db,
            ["a", "b"]
                .into_iter()
                .map(|id| (format!("t\0page\0{id}"), "1".into()))
                .collect(),
        )
    });
    let prefix = JsString::default();
    let page = reader(&f)
        .ids_of_type(
            IdsRequest {
                record_type: "page",
                prefix: &prefix,
                before: None,
                limit: 1,
            },
            IdsLimits {
                output_bytes: 1,
                ..IdsLimits::default()
            },
            &kept(),
        )
        .unwrap();
    assert_eq!(page.ids, vec!["b"]);
    assert_eq!(page.next.as_deref(), Some("b"));
    assert_eq!(page.work.output_bytes, 1);
}
#[test]
fn final_current_witness_failure_and_cancellation_withhold_every_provisional_id() {
    let f = fixture(|db| {
        checkpoint(
            db,
            vec![("t\0page\0private-id-sentinel".into(), "1".into())],
        )
    });
    let mut s = source(&f, ReadLimits::default());
    s.fail_finish = Some(2);
    let mut r = LegacyRecords::open_source(s, Bounds::default()).unwrap();
    let failure = ids(&mut r, "page", "", None, 5).unwrap_err();
    assert_eq!(failure, trillion_local::cause!(Error::Source));
    assert!(!failure.to_string().contains("private-id-sentinel"));
    assert_eq!(r.into_source().finishes, 2);
    let s = source(&f, ReadLimits::default());
    let cancel = s.cancel.clone();
    let mut r = LegacyRecords::open_source(s, Bounds::default()).unwrap();
    cancel.store(true, Ordering::SeqCst);
    assert!(ids(&mut r, "page", "", None, 5).is_err());
}
#[test]
fn actual_smaller_supplier_packets_keep_multipart_tail_and_type_merge_coherent() {
    let f = fixture(|db| {
        let body = format!(
            "[{{\"id\":\"x\",\"type\":\"page\",\"value\":{{\"text\":\"{}\"}}}}]",
            "q".repeat(1200)
        );
        let split = 700;
        tail(db, 1, LOG, "tx", 0, 2, &body[..split]);
        tail(db, 3, &format!("{LOG}.1"), "tx", 1, 2, &body[split..]);
    });
    let mut limits = ReadLimits::default();
    limits.result_bytes = 1024;
    limits.cell_bytes = 1024;
    let s = source(&f, limits);
    let mut r = LegacyRecords::open_source(s, Bounds::default()).unwrap();
    assert_eq!(ids(&mut r, "page", "", None, 5).unwrap().ids, vec!["x"]);
}

#[test]
fn complete_type_visitor_refuses_overflow_cancel_and_final_witness_failure() {
    let f = fixture(|db| checkpoint(db, (0..65).map(|n|
        (format!("t\0page\0id{n:03}"), "1".into())).collect()));
    let prefix = JsString::default();
    for mode in ["count", "held", "output", "cancel", "finish", "sql"] {
        let mut s = source(&f, ReadLimits::default());
        let cancel = s.cancel.clone();
        if mode == "finish" { s.fail_finish = Some(3); }
        let mut bounds = Bounds::default();
        if mode == "sql" { bounds.statements = 5; }
        let mut r = LegacyRecords::open_source(s, bounds).unwrap();
        let mut limits = IdsLimits::default();
        if mode == "held" { limits.held_bytes = 1; }
        if mode == "output" { limits.output_bytes = 1; }
        let mut chunks = 0;
        let result = r.visit_ids_of_type(IdsRequest {
            record_type: "page", prefix: &prefix, before: None, limit: 32,
        }, limits, &kept(), if mode == "count" {64} else {4096}, |chunk| {
            assert!(chunk.len() <= 32);
            chunks += 1;
            if mode == "cancel" { cancel.store(true, Ordering::SeqCst); }
            Ok(())
        });
        assert!(result.is_err(), "{mode}");
        if mode == "cancel" { assert_eq!(chunks, 1); }
        else if mode == "finish" { assert_eq!(chunks, 3); }
        else { assert_eq!(chunks, 0); }
    }
}

#[test]
fn complete_type_visitor_preserves_literal_utf16_boundaries_without_page_reentry() {
    let f = fixture(|db| checkpoint(db, ["p\u{d7ff}a", "p😀", "p\u{e000}", "x%_a", "x%_b", "xzza"]
        .into_iter().map(|id| (format!("t\0page\0{id}"), "1".into())).collect()));
    for (prefix, before) in [(JsString::from("p"), None),
        (JsString::from("p\u{d7ff}"), None),
        (JsString::from("p"), Some(JsString::from_units(vec![b'p' as u16, 0xd800]))),
        (JsString::from("x%_"), None)] {
        let mut expected = reader(&f);
        let expected = expected.ids_of_type(IdsRequest {record_type: "page", prefix: &prefix,
            before: before.as_ref(), limit: 32}, IdsLimits::default(), &kept()).unwrap().ids;
        let mut actual = Vec::new();
        reader(&f).visit_ids_of_type(IdsRequest {record_type: "page", prefix: &prefix,
            before: before.as_ref(), limit: 1}, IdsLimits::default(), &kept(), 4096,
            |chunk| { actual.extend(chunk); Ok(()) }).unwrap();
        assert_eq!(actual, expected);
    }
}
