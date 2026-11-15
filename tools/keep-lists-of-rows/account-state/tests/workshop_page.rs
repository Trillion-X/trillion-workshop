// Synthetic original-schema SQLite controls. Root deliberately adopts/exports
// this target; no fixture path, supplied Row or passing test grants account rights.
use rusqlite::{params, Connection, OpenFlags};
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
    ecma_json,
    import::{ImportError, ImportResult, QueryRows, ReadLimits},
    record_source::{BoundedRecordSql, RecordSourceWitness, SnapshotRecordSql},
    tool_fact_page::{tool_values_page, Kind, Limits, Page, PageRequest, MAX_PAGE_ITEMS},
};

struct Fixture {
    _dir: TempDir,
    path: PathBuf,
}
impl Fixture {
    fn new(prefill: impl FnOnce(&Connection)) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("original.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE workshop_facts(seq INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,entity TEXT NOT NULL,value TEXT NOT NULL); CREATE INDEX workshop_facts_current ON workshop_facts(entity,seq); CREATE TABLE workshop_current(entity TEXT PRIMARY KEY,seq INTEGER NOT NULL,kind TEXT,scope TEXT,due INTEGER,expires INTEGER) WITHOUT ROWID; CREATE TABLE workshop_current_filled(id INTEGER PRIMARY KEY CHECK(id=1),after TEXT NOT NULL,done INTEGER NOT NULL); INSERT INTO workshop_current_filled VALUES(1,'',1);").unwrap();
        prefill(&db);
        db.close().unwrap();
        Self { _dir: dir, path }
    }
    fn source<W: RecordSourceWitness>(
        &self,
        cancel: Arc<AtomicBool>,
        witness: W,
    ) -> SnapshotRecordSql<W> {
        let db = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .unwrap();
        let limits = ReadLimits {
            rows: 4096,
            result_bytes: 32 * 1024 * 1024,
            cell_bytes: 8 * 1024 * 1024,
            ..Default::default()
        };
        SnapshotRecordSql::begin(db, limits, witness, cancel).unwrap()
    }
}
fn fact(db: &Connection, entity: &str, value: &str) -> i64 {
    db.execute(
        "INSERT INTO workshop_facts(at,entity,value) VALUES('synthetic',?,?)",
        params![entity, value],
    )
    .unwrap();
    db.last_insert_rowid()
}
fn put(db: &Connection, entity: &str, value: &str) -> i64 {
    let seq = fact(db, entity, value);
    db.execute("INSERT INTO workshop_current(entity,seq) VALUES(?,?) ON CONFLICT(entity) DO UPDATE SET seq=excluded.seq",params![entity,seq]).unwrap();
    seq
}
fn request(after: &str, limit: usize) -> PageRequest {
    PageRequest {
        after: after.into(),
        limit,
    }
}
fn read(f: &Fixture, after: &str, limit: usize) -> Page {
    let cancel = Arc::new(AtomicBool::new(false));
    let mut source = f.source(cancel.clone(), || Ok(()));
    let page = tool_values_page(
        &mut source,
        &request(after, limit),
        &Limits::default(),
        &cancel,
    )
    .unwrap();
    source.finish().unwrap();
    page
}
fn encoded(value: &ecma_json::Value) -> String {
    ecma_json::stringify(
        value,
        ecma_json::Limits {
            depth: ecma_json::HARD_DEPTH,
            ..Default::default()
        },
    )
    .unwrap()
}

#[test]
fn original_current_join_paginates_entities_and_keeps_unfiltered_source_values() {
    let f = Fixture::new(|db| {
        put(db, "tool:a", r#"{"id":"tool:a","old":true}"#);
        put(db, "tool:a", r#"{"id":"tool:a","status":"deleted"}"#);
        put(db, "tool:b", r#"{"id":"tool:b","shipped":true}"#);
        put(db, "tool:c", r#"{"id":"tool:c","status":"inactive"}"#);
        put(db, "other:private", "null");
        put(db, "tool:", "false");
        put(db, "tool;excluded", "false");
    });
    let first = read(&f, "", 2);
    assert_eq!(
        first
            .rows
            .iter()
            .map(|r| r.entity.as_str())
            .collect::<Vec<_>>(),
        ["tool:a", "tool:b"]
    );
    assert_eq!(first.next.as_deref(), Some("tool:b"));
    assert_eq!(
        encoded(&first.rows[0].value),
        r#"{"id":"tool:a","status":"deleted"}"#
    );
    let second = read(&f, first.next.as_deref().unwrap(), 2);
    assert_eq!(second.rows.len(), 1);
    assert_eq!(second.rows[0].entity, "tool:c");
    assert!(second.next.is_none());
    assert_eq!(read(&f, "", 3).next, None);
    assert!(read(&f, "tool:z", 3).rows.is_empty());
}
#[test]
fn sql_binary_entity_order_and_lossless_ecmascript_values_are_preserved() {
    let f = Fixture::new(|db| {
        put(db, "tool:\u{10000}", "null");
        put(db, "tool:\u{e000}", "true");
        put(
            db,
            "tool:a",
            r#"{"z":1.00,"2":"two","1":"one","lone":"\ud800","n":9007199254740993}"#,
        );
    });
    let page = read(&f, "", 3);
    assert_eq!(
        page.rows
            .iter()
            .map(|r| r.entity.as_str())
            .collect::<Vec<_>>(),
        ["tool:a", "tool:\u{e000}", "tool:\u{10000}"]
    );
    assert_eq!(
        encoded(&page.rows[0].value),
        r#"{"1":"one","2":"two","z":1,"lone":"\ud800","n":9007199254740992}"#
    );
    assert_eq!(
        read(&f, "tool:\u{e000}", 1).rows[0].entity,
        "tool:\u{10000}"
    );
    assert_eq!(read(&f, "aaa", 1).rows[0].entity, "tool:a");
}
#[test]
fn malformed_excluded_lookahead_is_not_decoded_but_fails_when_selected() {
    let f = Fixture::new(|db| {
        put(db, "tool:a", "1");
        put(db, "tool:b", "2");
        put(db, "tool:c", "not-json");
    });
    assert_eq!(read(&f, "", 2).next.as_deref(), Some("tool:b"));
    let cancel = Arc::new(AtomicBool::new(false));
    let mut source = f.source(cancel.clone(), || Ok(()));
    assert!(matches!(tool_values_page(
            &mut source,
            &request("tool:b", 2),
            &Limits::default(),
            &cancel
        )
        .unwrap_err()
        .kind, Kind::Corrupt(_)));
}
#[test]
fn completed_index_is_required_and_read_never_initializes_or_fills_it() {
    for missing in [false, true] {
        let f = Fixture::new(|db| {
            put(db, "tool:a", "1");
            if missing {
                db.execute("DELETE FROM workshop_current_filled", [])
                    .unwrap();
            } else {
                db.execute("UPDATE workshop_current_filled SET done=0", [])
                    .unwrap();
            }
        });
        let before = fs::read(&f.path).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let mut source = f.source(cancel.clone(), || Ok(()));
        let error = tool_values_page(&mut source, &request("", 2), &Limits::default(), &cancel)
            .unwrap_err();
        assert!(matches!(error.kind, Kind::Pending(_)));
        source.finish().unwrap();
        assert_eq!(before, fs::read(&f.path).unwrap());
    }
}
#[test]
fn stale_current_pointer_refuses_instead_of_old_value_or_history_fallback() {
    let f = Fixture::new(|db| {
        put(db, "tool:a", "1");
        fact(db, "tool:a", "2");
    });
    let cancel = Arc::new(AtomicBool::new(false));
    let mut source = f.source(cancel.clone(), || Ok(()));
    assert!(matches!(tool_values_page(&mut source, &request("", 2), &Limits::default(), &cancel)
            .unwrap_err()
            .kind, Kind::Corrupt(_)));
}
#[test]
fn dangling_and_foreign_current_pointers_never_disappear_as_an_empty_page() {
    for dangling in [false, true] {
        let f = Fixture::new(|db| {
            let seq = if dangling {
                999
            } else {
                fact(db, "other:private", "1")
            };
            db.execute(
                "INSERT INTO workshop_current(entity,seq) VALUES('tool:a',?)",
                [seq],
            )
            .unwrap();
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let mut source = f.source(cancel.clone(), || Ok(()));
        assert!(matches!(tool_values_page(&mut source, &request("", 2), &Limits::default(), &cancel)
                .unwrap_err()
                .kind, Kind::Corrupt(_)));
    }
}
#[test]
fn views_missing_tables_and_missing_required_index_are_refused_without_schema_changes() {
    for mode in [0, 1, 2, 3] {
        let f = Fixture::new(|db| {
            put(db, "tool:a", "1");
            match mode {
                0 => db.execute_batch("DROP TABLE workshop_current; CREATE VIEW workshop_current AS SELECT entity,seq FROM workshop_facts").unwrap(),
                1 => db.execute_batch("DROP TABLE workshop_current_filled").unwrap(),
                2 => db.execute_batch("DROP INDEX workshop_facts_current").unwrap(),
                _ => db.execute_batch("DROP TABLE workshop_current_filled; CREATE TABLE workshop_current_filled(id INTEGER,after TEXT,done INTEGER); INSERT INTO workshop_current_filled VALUES(1,'',1)").unwrap(),
            }
        });
        let before = fs::read(&f.path).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let mut source = f.source(cancel.clone(), || Ok(()));
        assert!(matches!(tool_values_page(&mut source, &request("", 2), &Limits::default(), &cancel)
                .unwrap_err()
                .kind, Kind::Schema(_)));
        drop(source);
        assert_eq!(before, fs::read(&f.path).unwrap());
    }
}
#[test]
fn current_join_does_not_copy_large_superseded_or_unrelated_history_bodies() {
    let f = Fixture::new(|db| {
        let large = format!("\"{}\"", "x".repeat(512 * 1024));
        put(db, "tool:a", &large);
        put(db, "tool:a", "1");
        put(db, "other:private", &large);
    });
    let cancel = Arc::new(AtomicBool::new(false));
    let mut source = f.source(cancel.clone(), || Ok(()));
    let limits = Limits {
        source_bytes: 8192,
        ..Default::default()
    };
    let page = tool_values_page(&mut source, &request("", 1), &limits, &cancel).unwrap();
    assert_eq!(encoded(&page.rows[0].value), "1");
    assert!(page.work.source_bytes < 8192);
    source.finish().unwrap();
}
#[test]
fn original_lookahead_bytes_count_even_though_its_json_is_not_parsed() {
    let f = Fixture::new(|db| {
        put(db, "tool:a", "1");
        put(db, "tool:b", &format!("\"{}\"", "x".repeat(32 * 1024)));
    });
    let cancel = Arc::new(AtomicBool::new(false));
    let mut source = f.source(cancel.clone(), || Ok(()));
    let limits = Limits {
        source_bytes: 8192,
        ..Default::default()
    };
    assert!(matches!(tool_values_page(&mut source, &request("", 1), &limits, &cancel)
            .unwrap_err()
            .kind, Kind::Bounds(_)));
}
#[test]
fn aggregate_source_byte_and_row_bounds_refuse_instead_of_truncated_success() {
    let f = Fixture::new(|db| {
        put(db, "tool:a", "1");
        put(db, "tool:b", "2");
    });
    let baseline = read(&f, "", 2).work.source_bytes;
    for exact in [false, true] {
        let cancel = Arc::new(AtomicBool::new(false));
        let mut source = f.source(cancel.clone(), || Ok(()));
        let limits = Limits {
            source_bytes: baseline - usize::from(!exact),
            ..Default::default()
        };
        let result = tool_values_page(&mut source, &request("", 2), &limits, &cancel);
        if exact {
            assert_eq!(result.unwrap().rows.len(), 2);
        } else {
            assert!(matches!(result.unwrap_err().kind, Kind::Bounds(_)));
        }
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let mut source = f.source(cancel.clone(), || Ok(()));
    assert!(matches!(tool_values_page(
            &mut source,
            &request("", 2),
            &Limits {
                rows: 1,
                ..Default::default()
            },
            &cancel
        )
        .unwrap_err()
        .kind, Kind::Bounds(_)));
}
#[test]
fn normalized_json_value_budget_accepts_exact_and_refuses_one_short() {
    let f = Fixture::new(|db| {
        put(db, "tool:a", "1.00");
    });
    let cancel = Arc::new(AtomicBool::new(false));
    let mut source = f.source(cancel.clone(), || Ok(()));
    assert_eq!(
        tool_values_page(
            &mut source,
            &request("", 1),
            &Limits {
                value_bytes: 1,
                ..Default::default()
            },
            &cancel
        )
        .unwrap()
        .work
        .value_bytes,
        1
    );
    let f = Fixture::new(|db| {
        put(db, "tool:a", "[1,2]");
    });
    let cancel = Arc::new(AtomicBool::new(false));
    let mut source = f.source(cancel.clone(), || Ok(()));
    assert!(matches!(tool_values_page(
            &mut source,
            &request("", 1),
            &Limits {
                value_bytes: 4,
                ..Default::default()
            },
            &cancel
        )
        .unwrap_err()
        .kind, Kind::Bounds(_)));
}
#[test]
fn invalid_request_and_original_cancellation_do_no_page_queries() {
    let f = Fixture::new(|db| {
        put(db, "tool:a", "1");
    });
    for ask in [
        request("", 0),
        request("", MAX_PAGE_ITEMS + 1),
        request(&"😀".repeat(2049), 1),
    ] {
        let cancel = Arc::new(AtomicBool::new(false));
        let mut source = f.source(cancel.clone(), || Ok(()));
        let error = tool_values_page(&mut source, &ask, &Limits::default(), &cancel).unwrap_err();
        assert!(matches!(error.kind, Kind::Invalid(_)));
        assert_eq!(error.work.sql_statements, 0);
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let mut source = f.source(cancel.clone(), || Ok(()));
    cancel.store(true, Ordering::Release);
    let error =
        tool_values_page(&mut source, &request("", 1), &Limits::default(), &cancel).unwrap_err();
    assert!(matches!(error.kind, Kind::Cancelled(_)));
    assert_eq!(error.work.sql_statements, 0);
}
#[test]
fn fresh_source_withdrawal_after_query_never_discloses_a_partial_page() {
    let f = Fixture::new(|db| {
        put(db, "tool:a", "1");
    });
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let mut source = f.source(cancel.clone(), move || {
        if counted.fetch_add(1, Ordering::SeqCst) >= 3 {
            Err(ImportError::Refused("synthetic withdrawn source", trillion_local::cause!()))
        } else {
            Ok(())
        }
    });
    assert!(matches!(tool_values_page(&mut source, &request("", 1), &Limits::default(), &cancel)
            .unwrap_err()
            .kind, Kind::Source(_)));
    assert!(calls.load(Ordering::SeqCst) >= 4);
}
#[test]
fn cancellation_during_actual_source_check_uses_the_original_flag() {
    let f = Fixture::new(|db| {
        put(db, "tool:a", "1");
    });
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let original = cancel.clone();
    let mut source = f.source(cancel.clone(), move || {
        if counted.fetch_add(1, Ordering::SeqCst) >= 3 {
            original.store(true, Ordering::Release);
        }
        Ok(())
    });
    assert!(matches!(tool_values_page(&mut source, &request("", 1), &Limits::default(), &cancel)
            .unwrap_err()
            .kind, Kind::Cancelled(_)));
}
#[test]
fn supplier_without_enforced_caller_budget_never_falls_back_to_unbounded_query() {
    struct Unsupported;
    impl BoundedRecordSql for Unsupported {
        fn query(&mut self, _: &str, _: &[rusqlite::types::Value]) -> ImportResult<QueryRows> {
            panic!("unbudgeted fallback must not run")
        }
    }
    assert!(matches!(tool_values_page(
            &mut Unsupported,
            &request("", 1),
            &Limits::default(),
            &AtomicBool::new(false)
        )
        .unwrap_err()
        .kind, Kind::Bounds(_)));
}
#[test]
fn debug_and_failures_do_not_echo_private_cursor_or_values() {
    let f = Fixture::new(|db| {
        put(db, "tool:private-cursor", r#"{"private":"private-value"}"#);
    });
    let page = read(&f, "", 1);
    for text in [
        format!("{page:?}"),
        format!("{:?}", page.rows[0]),
        format!("{:?}", request("tool:private-cursor", 1)),
    ] {
        assert!(!text.contains("private-cursor"));
        assert!(!text.contains("private-value"));
    }
}
