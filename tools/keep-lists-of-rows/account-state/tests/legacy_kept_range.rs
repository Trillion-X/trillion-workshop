// Real SQLite fixtures for original kept indexed range reads. No real account,
// source authority, key material, provider or running app. Winning values preserve
// exact JSON text; keys-only proves no value/multipart opening by real calls.
use rusqlite::{params, types::Value, Connection, OpenFlags};
use std::{
    fs,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant},
};
use tempfile::TempDir;
use trillion_local::{
    ecma_json::JsString,
    import::{ImportResult, QueryRows, QueryTiming, ReadLimits},
    legacy_kept::{
        range::{self, Cursor, Page, RangeLimits, Request},
        LegacyKept, Limits, PointBudget, Refusal,
    },
    record_source::{BoundedRecordSql, QueryBudget, SnapshotRecordSql},
};
type Witness = fn() -> ImportResult<()>;
struct Fixture {
    _dir: TempDir,
    path: PathBuf,
}
fn fixture(build: impl FnOnce(&Connection)) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("kept.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA journal_mode=DELETE;CREATE TABLE record_keys_runs(run INTEGER PRIMARY KEY,age INTEGER,pages INTEGER,last TEXT,page_format INTEGER,page_layout INTEGER);CREATE TABLE record_keys_big(ref TEXT,part INTEGER,body TEXT,PRIMARY KEY(ref,part)) WITHOUT ROWID;").unwrap();
    build(&db);
    db.close().unwrap();
    Fixture { _dir: dir, path }
}
fn run(db: &Connection, number: i64, age: i64, pages: Vec<(&str, &str)>, last: &str) {
    db.execute(
        "INSERT INTO record_keys_runs VALUES(?,?,?,?,0,1)",
        params![
            number,
            age,
            pages.len() as i64,
            serde_json::to_string(last).unwrap()
        ],
    )
    .unwrap();
    db.execute_batch(&format!(
        "CREATE TABLE record_keys_run_{number}(page INTEGER PRIMARY KEY,first TEXT,body TEXT)"
    ))
    .unwrap();
    for (page, (first, body)) in pages.into_iter().enumerate() {
        db.execute(
            &format!("INSERT INTO record_keys_run_{number} VALUES(?,?,?)"),
            params![page as i64, serde_json::to_string(first).unwrap(), body],
        )
        .unwrap();
    }
}
fn packed(entries: &[(&str, Option<&str>)]) -> String {
    let keys = entries.iter().map(|(k, _)| *k).collect::<Vec<_>>();
    let sizes = entries
        .iter()
        .map(|(_, v)| v.map_or(0, |s| s.encode_utf16().count()))
        .collect::<Vec<_>>();
    format!(
        "{}\n{}",
        serde_json::json!({"s":keys,"p":vec![0;keys.len()],"d":sizes}),
        entries.iter().filter_map(|(_, v)| *v).collect::<String>()
    )
}
struct Source {
    inner: SnapshotRecordSql<Witness>,
    calls: usize,
    full: usize,
    full_pages: Vec<i64>,
    big: usize,
    sql: Vec<String>,
    cancel: Arc<AtomicBool>,
    fail_final: bool,
}
fn source(f: &Fixture) -> Source {
    let connection = Connection::open_with_flags(
        &f.path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let witness: Witness = || Ok(());
    let inner =
        SnapshotRecordSql::begin(connection, ReadLimits::default(), witness, cancel.clone())
            .unwrap();
    Source {
        inner,
        calls: 0,
        full: 0,
        full_pages: Vec::new(),
        big: 0,
        sql: Vec::new(),
        cancel,
        fail_final: false,
    }
}
impl BoundedRecordSql for Source {
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
        cap: QueryBudget,
    ) -> ImportResult<QueryRows> {
        self.calls += 1;
        if self.fail_final && sql == "SELECT 1" {
            self.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        let full_body = sql.contains("AS legacy FROM") && !sql.contains("instr(body");
        if full_body {
            self.full += 1;
        }
        if sql.contains("FROM record_keys_big") {
            self.big += 1;
        }
        self.sql.push(sql.into());
        let rows = self.inner.query_with_budget(sql, params, cap)?;
        if full_body {
            self.full_pages
                .extend(rows.rows.iter().filter_map(|row| match row.first() {
                    Some(trillion_local::import::SqlValue::Integer(page)) => Some(*page),
                    _ => None,
                }));
        }
        Ok(rows)
    }
    fn last_query_timing(&self) -> Option<QueryTiming> {
        self.inner.last_query_timing()
    }
}
fn kept() -> LegacyKept {
    LegacyKept::new(Limits::default()).unwrap()
}
fn read(
    s: &mut Source,
    lo: &str,
    hi: &str,
    reverse: bool,
    keys: bool,
    limit: usize,
    cursor: Option<&Cursor>,
) -> Result<Page, trillion_local::legacy_kept::Error> {
    let (lo, hi) = (JsString::from(lo), JsString::from(hi));
    kept().range(
        s,
        Request {
            lo: &lo,
            hi: &hi,
            reverse,
            keys_only: keys,
            limit,
            cursor,
        },
        RangeLimits::default(),
    )
}
#[test]
fn newest_age_run_and_tombstones_merge_without_opening_losing_values() {
    let old = packed(&[
        ("t\0page\0a", Some("INVALID-LOSING-JSON")),
        ("t\0page\0b", Some("1.00")),
    ]);
    let new = packed(&[
        ("t\0page\0a", None),
        ("t\0page\0b", Some("2e0")),
        ("t\0page\0c", Some("3")),
    ]);
    let tie = packed(&[("t\0page\0c", Some("4.00"))]);
    let f = fixture(|db| {
        run(db, 1, 1, vec![("t\0page\0a", &old)], "t\0page\0b");
        run(db, 2, 2, vec![("t\0page\0a", &new)], "t\0page\0c");
        run(db, 3, 2, vec![("t\0page\0c", &tie)], "t\0page\0c");
    });
    let before = fs::read(&f.path).unwrap();
    let mut s = source(&f);
    let page = read(&mut s, "t\0page\0", "t\0page\u{1}", false, false, 20, None).unwrap();
    assert!(page.complete);
    assert!(page.next.is_none());
    assert_eq!(
        page.items
            .iter()
            .map(|r| (r.key.as_str(), r.value.as_deref()))
            .collect::<Vec<_>>(),
        vec![("t\0page\0b", Some("2e0")), ("t\0page\0c", Some("4.00"))]
    );
    assert_eq!(s.full, 2);
    assert_eq!(fs::read(&f.path).unwrap(), before);
}

#[test]
fn range_batches_single_page_boundary_keys_across_runs_without_changing_merge() {
    let f = fixture(|db| {
        for run_number in 0..24 {
            let key = format!("t\0ids\0{run_number:02}");
            let value = format!("{run_number}");
            let raw = packed(&[(&key, Some(&value))]);
            run(db, run_number, run_number, vec![(&key, &raw)], &key);
        }
    });
    let mut source = source(&f);
    let page = read(
        &mut source,
        "t\0ids\0",
        "t\0ids\u{1}",
        false,
        true,
        64,
        None,
    )
    .unwrap();
    assert!(page.complete);
    assert_eq!(page.items.len(), 24);
    assert_eq!(
        page.items.iter().map(|item| item.key.clone()).collect::<Vec<_>>(),
        (0..24)
            .map(|number| format!("t\0ids\0{number:02}"))
            .collect::<Vec<_>>()
    );
    // Run metadata, one cross-run boundary key query, one page fetch per winning
    // run, and the final snapshot check remain inside the old source limits.
    assert!(page.work.sql_statements <= 28, "{}", page.work.sql_statements);
}

#[test]
fn range_initializes_many_runs_with_only_the_first_demanded_page() {
    let f = fixture(|db| {
        for run_number in 0..48 {
            let keys = (0..8)
                .map(|page| format!("t\0first-heads\0{page:02}"))
                .collect::<Vec<_>>();
            let bodies = keys
                .iter()
                .map(|key| packed(&[(key.as_str(), Some("1"))]))
                .collect::<Vec<_>>();
            let pages = keys
                .iter()
                .zip(&bodies)
                .map(|(key, body)| (key.as_str(), body.as_str()))
                .collect::<Vec<_>>();
            run(
                db,
                run_number,
                run_number,
                pages,
                keys.last().unwrap(),
            );
        }
    });
    let mut source = source(&f);
    let lo = JsString::from("t\0first-heads\0");
    let hi = JsString::from("t\0first-heads\u{1}");
    let mut limits = RangeLimits::default();
    limits.pages = 256;
    // The former eager window requested 8 pages for each of 48 lanes (384
    // total), exceeding this same cap before the first merged result existed.
    // A one-item request needs only one selected page from each lane.
    let page = kept()
        .range(
            &mut source,
            Request {
                lo: &lo,
                hi: &hi,
                reverse: false,
                keys_only: true,
                limit: 1,
                cursor: None,
            },
            limits,
        )
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].key, format!("t\0first-heads\0{0:02}", 0));
    assert!(!page.complete);
    assert_eq!(page.work.page_bodies, 48);
}

#[test]
fn range_without_candidate_runs_is_a_complete_empty_read() {
    for populated in [false, true] {
        let f = fixture(|db| {
            if populated {
                let raw = packed(&[("a", Some("1"))]);
                run(db, 1, 1, vec![("a", &raw)], "a");
            }
        });
        for reverse in [false, true] {
            let page = read(&mut source(&f), "z", "zz", reverse, true, 4, None).unwrap();
            assert!(page.complete);
            assert!(page.items.is_empty());
            assert!(page.next.is_none());
        }
    }
}

#[test]
fn range_batches_more_than_one_boundary_key_group_under_the_same_budget() {
    let f = fixture(|db| {
        for number in 0..65 {
            let key = format!("t\0many\0{number:02}");
            let raw = packed(&[(&key, Some("1"))]);
            run(db, number, number, vec![(&key, &raw)], &key);
        }
    });
    let mut limits = Limits::default();
    limits.runs = 65;
    let kept = LegacyKept::new(limits).unwrap();
    let lo = JsString::from("t\0many\0");
    let hi = JsString::from("t\0many\u{1}");
    let page = kept.range(&mut source(&f), Request {
        lo: &lo, hi: &hi, reverse: false, keys_only: true, limit: 100, cursor: None,
    }, RangeLimits::default()).unwrap();
    assert!(page.complete);
    assert_eq!(page.items.len(), 65);
    assert!(page.work.sql_statements < 128);
}

#[test]
fn multi_prefix_keeps_duplicate_groups_and_newest_tombstones() {
    let old = packed(&[("p\0a", Some("INVALID-LOSING-JSON")), ("p\0b", Some("1"))]);
    let new = packed(&[("p\0a", None), ("p\0b", Some("2"))]);
    let f = fixture(|db| {
        run(db, 1, 1, vec![("p\0a", &old)], "p\0b");
        run(db, 2, 2, vec![("p\0a", &new)], "p\0b");
    });
    let a = JsString::from("p\0a");
    let b = JsString::from("p\0b");
    let c = JsString::from("p\0c");
    let bounds = vec![(a.clone(), b.clone()), (b.clone(), c.clone()), (b, c)];
    let mut source = source(&f);
    let page = kept()
        .prefixes_with_budget(
            &mut source,
            &bounds,
            10,
            RangeLimits::default(),
            PointBudget {
                statements: 2048,
                rows: 4096,
                source_bytes: 16 * 1024 * 1024,
                deadline: Instant::now() + Duration::from_secs(5),
            },
        )
        .unwrap();
    assert_eq!(page.groups.len(), 3);
    assert!(page.groups[0].is_empty());
    for group in &page.groups[1..] {
        assert_eq!(group.len(), 1);
        assert_eq!(group[0].key, "p\0b");
        assert!(group[0].value.is_none());
    }
    assert_eq!(source.big, 0);
}

#[test]
fn key_only_packed_range_never_parses_json_values_or_opens_multipart() {
    let raw = format!(
        "{}\nINVALID",
        serde_json::json!({"s":["a","b"],"p":[0,0],"d":[7,0],"b":{"1":["missing-ref",2]}})
    );
    let f = fixture(|db| run(db, 1, 1, vec![("a", &raw)], "b"));
    let mut s = source(&f);
    let page = read(&mut s, "a", "z", false, true, 20, None).unwrap();
    assert_eq!(
        page.items
            .iter()
            .map(|r| r.key.as_str())
            .collect::<Vec<_>>(),
        vec!["a", "b"]
    );
    assert!(page.items.iter().all(|r| r.value.is_none()));
    assert_eq!((s.full, s.big), (0, 0));
    let mut s = source(&f);
    assert!(read(&mut s, "a", "z", false, false, 20, None).is_err());
}
#[test]
fn continuation_is_exclusive_and_binds_interval_direction_and_mode() {
    let a = packed(&[("a", Some("1")), ("b", Some("2"))]);
    let c = packed(&[("c", Some("3")), ("d", Some("4"))]);
    let f = fixture(|db| run(db, 1, 1, vec![("a", &a), ("c", &c)], "d"));
    let mut s = source(&f);
    let first = read(&mut s, "a", "z", true, true, 2, None).unwrap();
    assert_eq!(
        first
            .items
            .iter()
            .map(|r| r.key.as_str())
            .collect::<Vec<_>>(),
        vec!["d", "c"]
    );
    assert!(!first.complete);
    let next = first.next.as_ref().unwrap();
    let second = read(&mut s, "a", "z", true, true, 2, Some(next)).unwrap();
    assert_eq!(
        second
            .items
            .iter()
            .map(|r| r.key.as_str())
            .collect::<Vec<_>>(),
        vec!["b", "a"]
    );
    let finalpage = read(&mut s, "a", "z", true, true, 2, second.next.as_ref()).unwrap();
    assert!(finalpage.items.is_empty() && finalpage.complete);
    assert!(read(&mut s, "a", "y", true, true, 2, Some(next)).is_err());
    assert!(read(&mut s, "a", "z", false, true, 2, Some(next)).is_err());
    assert!(read(&mut s, "a", "z", true, false, 2, Some(next)).is_err());
}
#[test]
fn utf16_merge_and_lone_surrogate_prefix_end_bounds_match_source_order() {
    let a = packed(&[
        ("p\u{d7ff}a", Some("1")),
        ("p😀", Some("2")),
        ("p\u{e000}", Some("3")),
    ]);
    let f = fixture(|db| run(db, 1, 1, vec![("p\u{d7ff}a", &a)], "p\u{e000}"));
    let mut s = source(&f);
    let page = read(&mut s, "p", "q", false, true, 10, None).unwrap();
    assert_eq!(
        page.items
            .iter()
            .map(|r| r.key.as_str())
            .collect::<Vec<_>>(),
        vec!["p\u{d7ff}a", "p😀", "p\u{e000}"]
    );
    let prefix = JsString::from("p\u{d7ff}");
    let hi = range::prefix_end(&prefix).unwrap();
    assert_eq!(hi.units(), &[b'p' as u16, 0xd800]);
    let mut s = source(&f);
    let page = kept()
        .range(
            &mut s,
            Request {
                lo: &prefix,
                hi: &hi,
                reverse: true,
                keys_only: true,
                limit: 10,
                cursor: None,
            },
            RangeLimits::default(),
        )
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].key, "p\u{d7ff}a");
}
#[test]
fn winning_multipart_keeps_exact_raw_json_and_missing_parts_refuse() {
    let raw = "[[\"a\",\"fixture-ref\",2]]";
    let f = fixture(|db| {
        run(db, 1, 1, vec![("a", raw)], "a");
        db.execute(
            "INSERT INTO record_keys_big VALUES('fixture-ref',0,?)",
            ["{\"z\":1.00,"],
        )
        .unwrap();
        db.execute(
            "INSERT INTO record_keys_big VALUES('fixture-ref',1,?)",
            ["\"a\":2}"],
        )
        .unwrap();
    });
    let mut s = source(&f);
    let page = read(&mut s, "a", "z", false, false, 2, None).unwrap();
    assert_eq!(page.items[0].value.as_deref(), Some("{\"z\":1.00,\"a\":2}"));
    assert!(s.big > 0);
    let f = fixture(|db| run(db, 1, 1, vec![("a", raw)], "a"));
    let mut s = source(&f);
    assert!(read(&mut s, "a", "z", false, false, 2, None).is_err());
}
#[test]
fn indexed_seek_does_not_fetch_unrelated_page_bodies() {
    let z = packed(&[("z", Some("1"))]);
    let f = fixture(|db| {
        run(
            db,
            1,
            1,
            vec![
                ("a", "bad unrelated body"),
                ("m", "bad unrelated body"),
                ("z", &z),
            ],
            "z",
        );
    });
    let mut s = source(&f);
    let page = read(&mut s, "z", "zz", false, false, 2, None).unwrap();
    assert_eq!(page.items[0].value.as_deref(), Some("1"));
    // The complete-body retry must return only the selected page. Batch
    // headers may cover adjacent pages, but they retain the truncating
    // projection and never return unrelated bodies.
    assert_eq!(s.full_pages, [2]);
    assert_eq!(s.full, 1);
}
#[test]
fn overlapping_adjacent_page_keys_refuse_instead_of_skipping_or_reordering() {
    let first = packed(&[("a", Some("1")), ("z", Some("2"))]);
    let second = packed(&[("m", Some("3")), ("zz", Some("4"))]);
    let f = fixture(|db| run(db, 1, 1, vec![("a", &first), ("m", &second)], "zz"));
    assert!(read(&mut source(&f), "a", "zzz", false, true, 10, None).is_err());
}
#[test]
fn exhausted_statement_allowance_stops_before_next_actual_sql_dispatch() {
    let raw = packed(&[("a", Some("1"))]);
    let f = fixture(|db| run(db, 1, 1, vec![("a", &raw)], "a"));
    let mut s = source(&f);
    let lo = "a".into();
    let hi = "z".into();
    let error = kept()
        .range_with_budget(
            &mut s,
            Request {
                lo: &lo,
                hi: &hi,
                reverse: false,
                keys_only: true,
                limit: 5,
                cursor: None,
            },
            RangeLimits::default(),
            PointBudget {
                statements: 2,
                rows: 4096,
                source_bytes: 8 * 1024 * 1024,
                deadline: Instant::now() + Duration::from_secs(5),
            },
        )
        .unwrap_err();
    assert!(error.budget_exhausted);
    assert_eq!(s.calls, 2);
    assert_eq!(error.work.sql_statements, 2);
}
/// A value refused only because the values before it used the page's output budget is the page's refusal
/// (`Refusal::PageBudget`: a page with fewer values holds it); the same value alone in a page whose budget it exceeds
/// is the value's (`Refusal::ValueBound`). Both an inline winner and a multipart winner answer the same way.
#[test]
fn a_value_over_the_pages_remaining_budget_is_a_page_refusal_and_alone_is_a_value_refusal() {
    let long = format!("\"{}\"", "x".repeat(28));
    let inline = packed(&[("a", Some("1")), ("b", Some(&long))]);
    let multipart = "[[\"a\",\"small-ref\",1],[\"b\",\"fixture-ref\",2]]".to_owned();
    for (name, raw) in [("inline", inline), ("multipart", multipart)] {
        let f = fixture(|db| {
            run(db, 1, 1, vec![("a", &raw)], "b");
            db.execute("INSERT INTO record_keys_big VALUES('small-ref',0,'1')", []).unwrap();
            db.execute("INSERT INTO record_keys_big VALUES('fixture-ref',0,?)", [&long[..15]]).unwrap();
            db.execute("INSERT INTO record_keys_big VALUES('fixture-ref',1,?)", [&long[15..]]).unwrap();
        });
        let range_from = |lo: &str, output_bytes: usize| {
            let (lo, hi) = (JsString::from(lo), JsString::from("z"));
            let caps = RangeLimits { output_bytes, ..RangeLimits::default() };
            let request = Request { lo: &lo, hi: &hi, reverse: false, keys_only: false, limit: 10, cursor: None };
            kept().range(&mut source(&f), request, caps)
        };
        // After "a" (2 bytes with its key), "b" has 25 - 2 - 1 = 22 bytes left for a 30-byte value.
        let error = range_from("a", 25).unwrap_err();
        assert_eq!(error.kind, trillion_local::cause!(Refusal::PageBudget), "{name}");
        // Alone, "b" has 24 bytes for its 30: no smaller page holds it.
        let error = range_from("b", 25).unwrap_err();
        assert_eq!(error.kind, trillion_local::cause!(Refusal::ValueBound), "{name}");
        // With room for it, the page answers both values.
        let page = range_from("a", 64).unwrap();
        assert_eq!(page.items.len(), 2, "{name}");
        assert_eq!(page.items[1].value.as_deref(), Some(long.as_str()), "{name}");
    }
}
#[test]
fn held_page_output_and_entry_bounds_refuse_without_partial_success() {
    let raw = packed(&[("a", Some("1")), ("b", Some("2"))]);
    let f = fixture(|db| run(db, 1, 1, vec![("a", &raw)], "b"));
    let lo = "a".into();
    let hi = "z".into();
    for which in ["held", "output", "entries", "pages"] {
        let mut caps = RangeLimits::default();
        match which {
            "held" => caps.held_bytes = 1,
            "output" => caps.output_bytes = 1,
            "entries" => caps.entries = 1,
            "pages" => caps.pages = 1,
            _ => unreachable!(),
        };
        let mut s = source(&f);
        let error = kept()
            .range(
                &mut s,
                Request {
                    lo: &lo,
                    hi: &hi,
                    reverse: false,
                    keys_only: false,
                    limit: 10,
                    cursor: None,
                },
                caps,
            )
            .unwrap_err();
        assert!(error.budget_exhausted, "{which}");
    }
}
#[test]
fn cancelled_current_snapshot_withholds_every_range_value() {
    use std::sync::atomic::Ordering;
    let raw = packed(&[("a", Some("1"))]);
    let f = fixture(|db| run(db, 1, 1, vec![("a", &raw)], "a"));
    let mut s = source(&f);
    s.cancel.store(true, Ordering::SeqCst);
    assert!(read(&mut s, "a", "z", false, false, 5, None).is_err());
    assert_eq!(s.calls, 1);
}
#[test]
fn exact_run_and_literal_prefix_boundaries_do_not_treat_percent_or_underscore_as_sql_patterns() {
    let raw = packed(&[
        ("x%_a", Some("1")),
        ("x%_b", Some("2")),
        ("xzza", Some("3")),
    ]);
    let f = fixture(|db| run(db, 1, 1, vec![("x%_a", &raw)], "xzza"));
    let page = read(&mut source(&f), "x%_", "x%`", false, true, 20, None).unwrap();
    assert_eq!(
        page.items
            .iter()
            .map(|r| r.key.as_str())
            .collect::<Vec<_>>(),
        vec!["x%_a", "x%_b"]
    );
}

#[test]
fn final_current_witness_failure_withholds_already_collected_range_items() {
    let raw = packed(&[("private-sentinel", Some("123"))]);
    let f = fixture(|db| {
        run(
            db,
            1,
            1,
            vec![("private-sentinel", &raw)],
            "private-sentinel",
        )
    });
    let mut s = source(&f);
    s.fail_final = true;
    let failure = read(&mut s, "a", "z", false, false, 10, None).unwrap_err();
    assert!(!failure.to_string().contains("private-sentinel"));
    assert_eq!(s.full, 1);
    assert!(s.sql.iter().any(|sql| sql == "SELECT 1"));
}
#[test]
fn unsupported_supplier_ceilings_refuse_before_any_sql() {
    struct Unsupported;
    impl BoundedRecordSql for Unsupported {
        fn query(&mut self, _: &str, _: &[Value]) -> ImportResult<QueryRows> {
            panic!("no query for unsupported ceilings")
        }
    }
    let lo = "a".into();
    let hi = "z".into();
    assert!(kept()
        .range(
            &mut Unsupported,
            Request {
                lo: &lo,
                hi: &hi,
                reverse: false,
                keys_only: true,
                limit: 10,
                cursor: None
            },
            RangeLimits::default()
        )
        .is_err());
}

#[test]
fn layout_two_forward_pages_resume_across_deleted_heads_and_preserve_exact_selected_text() {
    let first = "~{\"p\":[0,0],\"d\":[4,1]}\u{2}a\u{3}b\n1.002";
    let second = "~{\"p\":[0,0],\"d\":[1,1]}\u{2}c\u{3}d\n34";
    let newer = packed(&[("b", None), ("c", Some("5e0"))]);
    let f = fixture(|db| {
        run(db, 1, 1, vec![("a", first), ("c", second)], "d");
        run(db, 2, 2, vec![("b", &newer)], "c");
    });
    let mut source = source(&f);
    let mut cursor = None;
    let mut values = Vec::new();
    for _ in 0..4 {
        let page = read(&mut source, "a", "z", false, false, 1, cursor.as_ref()).unwrap();
        values.extend(
            page.items
                .into_iter()
                .map(|item| (item.key, item.value.unwrap())),
        );
        if page.complete {
            break;
        }
        cursor = page.next;
    }
    assert_eq!(
        values,
        vec![
            ("a".into(), "1.00".into()),
            ("c".into(), "5e0".into()),
            ("d".into(), "4".into())
        ]
    );
}
