// tests/legacy_kept.rs
// Purpose: Qualify bounded original-schema point reads on pinned synthetic SQLite.
// Non-Negotiable Invariants: no source writes, newest-winner truth, exact text,
// explicit refusals, and independent source pins on restart/change controls.
// Key Concepts: real SQLite schema; synthetic data is not real-account parity.
// Security Considerations: fixtures contain no credentials or provider traffic.
// AI Assistant Directive: retain limits; do not substitute this cohort for replay.
use rusqlite::{params, Connection};
use content_crypto::advanced::blake3;
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tempfile::{tempdir, TempDir};
use trillion_local::{
    import::{AccountIdentity, FilePin, NativeCatalog, ReadLimits, ReadonlyOriginal},
    legacy_kept::{Entry, LegacyKept, Limits, PointBudget},
};

#[test]
fn source_failure_diagnostics_keep_only_safe_classes_codes_and_static_reasons() {
    use trillion_local::{import::ImportError, legacy_kept::SourceFailure};
    let io = ImportError::Io(std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "private-path-sentinel",
    ), trillion_local::cause!());
    let io = SourceFailure::capture(&io).to_string();
    assert!(io.contains("PermissionDenied"));
    assert!(!io.contains("private-path-sentinel"));
    let sql = ImportError::Sqlite(rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
        Some("private-sql-and-value-sentinel".into()),
    ), trillion_local::cause!());
    assert_eq!(
        SourceFailure::capture(&sql).to_string(),
        "source-sqlite: primary=1 extended=1"
    );
    let json = ImportError::Json(
        serde_json::from_str::<serde_json::Value>("private-json-sentinel").unwrap_err(),
     trillion_local::cause!());
    assert_eq!(SourceFailure::capture(&json).to_string(), "source-json");
    assert_eq!(
        SourceFailure::capture(&ImportError::Refused("static original pin refusal", trillion_local::cause!())).to_string(),
        "source-refused: static original pin refusal"
    );
}
struct Fixture {
    _root: TempDir,
    state: PathBuf,
    database: PathBuf,
    receipt: FilePin,
    sqlite: FilePin,
}
fn pin(path: &Path) -> FilePin {
    let bytes = fs::read(path).unwrap();
    FilePin {
        bytes: bytes.len() as u64,
        blake3: blake3::hash(&bytes).to_hex().to_string(),
    }
}
fn fixture(build: impl FnOnce(&Connection)) -> Fixture {
    let root = tempdir().unwrap();
    let state = root.path().join("original");
    fs::create_dir(&state).unwrap();
    let database = state.join("original.sqlite");
    let db = Connection::open(&database).unwrap();
    db.execute_batch("PRAGMA journal_mode=DELETE; CREATE TABLE record_keys_runs(run INTEGER PRIMARY KEY,age INTEGER,pages INTEGER,last TEXT,page_format INTEGER,page_layout INTEGER); CREATE TABLE record_keys_big(ref TEXT,part INTEGER,body TEXT,PRIMARY KEY(ref,part)) WITHOUT ROWID").unwrap();
    build(&db);
    db.close().unwrap();
    let sqlite = pin(&database);
    let descriptor = json!({"binding":"NETWORK","originalId":"a".repeat(64),"localId":"c".repeat(64),"names":["fixture"],"sqlite":"original.sqlite","rows":2,"hiddenIdentity":"d".repeat(64),"sourceIdentity":"e".repeat(64),"className":"Network"});
    let index = serde_json::to_string(&descriptor).unwrap() + "\n";
    fs::write(state.join("objects.ndjson"), &index).unwrap();
    let receipt = json!({"version":"trillion.local-restore-indexed/v1","complete":true,"account":{"userId":"fixture-user","ownerId":"b".repeat(64)},"proof":{"workerdStructuredClone":true,"userSQLIntegrity":true,"providerContacted":false},"replay":{"runtimeStarted":false,"alarmsRestored":false,"alarmsArmed":false},"source":{"bundleManifestIdentity":"f".repeat(64),"version":"trillion.local-transfer-bundle/v1"},"objects":{"path":"objects.ndjson","bytes":index.len(),"fileIdentity":blake3::hash(index.as_bytes()).to_hex().to_string(),"count":1},"accountSlices":{"partial_original":true,"complete_original":false,"objects":[{"sql":{"rows":0}}]}});
    fs::write(
        state.join("restore-receipt.json"),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    let receipt = pin(&state.join("restore-receipt.json"));
    Fixture {
        _root: root,
        state,
        database,
        receipt,
        sqlite,
    }
}
fn open(f: &Fixture) -> ReadonlyOriginal {
    let catalog = NativeCatalog::open(
        &f.state,
        f.receipt.clone(),
        AccountIdentity {
            user_id: "fixture-user".into(),
            owner_id: "b".repeat(64),
        },
        ReadLimits::default(),
    )
    .unwrap();
    catalog
        .open_object("NETWORK", &"a".repeat(64), f.sqlite.clone())
        .unwrap()
}
fn reader() -> LegacyKept {
    LegacyKept::new(Limits::default()).unwrap()
}
fn run(db: &Connection, number: i64, age: i64, pages: &[(&str, String)], format: i64, layout: i64) {
    db.execute(
        "INSERT INTO record_keys_runs VALUES(?,?,?,?,?,?)",
        params![
            number,
            age,
            pages.len() as i64,
            serde_json::to_string(pages.last().unwrap().0).unwrap(),
            format,
            layout
        ],
    )
    .unwrap();
    db.execute_batch(&format!("CREATE TABLE record_keys_run_{number}(page INTEGER PRIMARY KEY,first TEXT,body TEXT NOT NULL)")).unwrap();
    for (index, (first, body)) in pages.iter().enumerate() {
        db.execute(
            &format!("INSERT INTO record_keys_run_{number} VALUES(?,?,?)"),
            params![index as i64, serde_json::to_string(first).unwrap(), body],
        )
        .unwrap();
    }
}
fn packed(key: &str, text: &str) -> String {
    format!(
        "{}\n{text}",
        json!({"p":[0],"s":[key],"d":[text.encode_utf16().count()]})
    )
}
#[test]
fn exact_selected_text_newest_wins_and_restart_uses_same_original() {
    let text = r#"["type",7,{"z":1.00,"a":1e2,"z":3}]"#;
    let f = fixture(|db| {
        run(db, 1, 1, &[("i\0id", packed("i\0id", "null"))], 0, 1);
        run(db, 2, 2, &[("i\0id", packed("i\0id", text))], 0, 1);
    });
    let before = fs::read(&f.database).unwrap();
    let mut original = open(&f);
    let got = reader().point(&mut original, "i\0id").unwrap();
    assert_eq!(got.entry, Entry::Json(text.into()));
    assert_eq!(got.work.page_bodies, 1);
    assert_eq!(got.work.runs_examined, 1);
    assert!(
        got.work.elapsed_us
            >= got.work.source_precheck_us
                + got.work.source_sql_us
                + got.work.source_postcheck_us
                + got.work.head_decode_us
                + got.work.page_decode_us
    );
    drop(original);
    assert_eq!(
        reader().point(&mut open(&f), "i\0id").unwrap().entry,
        got.entry
    );
    assert_eq!(fs::read(&f.database).unwrap(), before);
}
#[test]
fn newest_tombstone_stops_before_corrupt_older_body() {
    let f = fixture(|db| {
        run(db, 1, 1, &[("key", "broken older body".into())], 0, 1);
        run(db, 2, 2, &[("key", packed("key", ""))], 0, 1);
    });
    let got = reader().point(&mut open(&f), "key").unwrap();
    assert_eq!(got.entry, Entry::Tombstone);
    assert_eq!(got.work.page_bodies, 1);
}
#[test]
fn newer_selected_corruption_never_falls_back() {
    let f = fixture(|db| {
        run(db, 1, 1, &[("key", packed("key", "12"))], 0, 1);
        run(db, 2, 2, &[("key", packed("key", "invalid"))], 0, 1);
    });
    let err = reader().point(&mut open(&f), "key").unwrap_err();
    assert_eq!(err.work.page_bodies, 1);
    assert_eq!(err.work.runs_examined, 1);
}
#[test]
fn legacy_list_and_layout2_preserve_raw_text() {
    let f = fixture(|db| {
        run(
            db,
            1,
            1,
            &[("a", r#"[["a",{"z":1.00,"a":2}]]"#.into())],
            0,
            0,
        );
        run(
            db,
            2,
            2,
            &[("b", "~{\"p\":[0],\"d\":[4]}\u{2}b\n1e+2".into())],
            0,
            2,
        );
    });
    assert_eq!(
        reader().point(&mut open(&f), "a").unwrap().entry,
        Entry::Json(r#"{"z":1.00,"a":2}"#.into())
    );
    assert_eq!(
        reader().point(&mut open(&f), "b").unwrap().entry,
        Entry::Json("1e+2".into())
    );
}
#[test]
fn binary_boundary_keys_use_javascript_utf16_order() {
    let f = fixture(|db| {
        run(
            db,
            1,
            1,
            &[
                ("a", packed("a", "1")),
                ("😀", packed("😀", "2")),
                ("\u{e000}", packed("\u{e000}", "3")),
            ],
            0,
            1,
        )
    });
    assert_eq!(
        reader().point(&mut open(&f), "😀").unwrap().entry,
        Entry::Json("2".into())
    );
    assert_eq!(
        reader().point(&mut open(&f), "\u{e000}").unwrap().entry,
        Entry::Json("3".into())
    );
}
#[test]
fn batched_exact_points_keep_newest_tombstone_and_bounded_sql() {
    let source_keys = (0..303)
        .map(|at| format!("i\0id{at:03}"))
        .collect::<Vec<_>>();
    let mut keys = source_keys[..100].to_vec();
    keys.extend(["i\0id150a".into(), "i\0id049".into(), "i\0id302".into()]);
    let f = fixture(|db| {
        let pages = source_keys
            .iter()
            .enumerate()
            .map(|(at, key)| (key.as_str(), packed(key, &format!("{at}"))))
            .collect::<Vec<_>>();
        run(db, 1, 1, &pages, 0, 1);
        run(db, 2, 2, &[("i\0id050", packed("i\0id050", ""))], 0, 1);
    });
    let kept = reader();
    let mut original = open(&f);
    let batch = kept
        .points_with_budget(
            &mut original,
            &keys,
            PointBudget {
                statements: 128,
                rows: 4096,
                source_bytes: 16 * 1024 * 1024,
                deadline: std::time::Instant::now() + std::time::Duration::from_secs(5),
            },
        )
        .unwrap();
    assert_eq!(batch.entries.len(), 103);
    assert_eq!(batch.entries[0], Entry::Json("0".into()));
    assert_eq!(batch.entries[50], Entry::Tombstone);
    assert_eq!(batch.entries[99], Entry::Json("99".into()));
    assert_eq!(batch.entries[100], Entry::Absent);
    assert_eq!(batch.entries[101], batch.entries[49]);
    assert_eq!(batch.entries[102], Entry::Json("302".into()));
    assert!(
        batch.work.sql_statements < 50,
        "batch SQL: {}",
        batch.work.sql_statements
    );
    eprintln!("BATCH_303 sql={} rows={} pages={}",
        batch.work.sql_statements, batch.work.rows_returned, batch.work.page_bodies);
    assert_eq!(
        kept.point(&mut open(&f), &keys[50]).unwrap().entry,
        batch.entries[50]
    );
    assert_eq!(
        kept.point(&mut open(&f), &keys[99]).unwrap().entry,
        batch.entries[99]
    );
    let limited = kept.points_with_budget(
        &mut open(&f),
        &keys,
        PointBudget {
            statements: 128,
            rows: 16,
            source_bytes: 16 * 1024 * 1024,
            deadline: std::time::Instant::now() + std::time::Duration::from_secs(5),
        },
    );
    let refusal = match limited {
        Ok(_) => panic!("the 303-page request must obey its row allowance"),
        Err(error) => error,
    };
    assert!(refusal.budget_exhausted);
    assert!(refusal.work.rows_returned <= 16);
}
#[test]
fn large_run_batched_boundary_keys_keep_exact_values_and_missing_key() {
    let source_keys = (0..513)
        .map(|at| format!("i\0id{at:03}"))
        .collect::<Vec<_>>();
    let f = fixture(|db| {
        let pages = source_keys
            .iter()
            .enumerate()
            .map(|(at, key)| (key.as_str(), packed(key, &at.to_string())))
            .collect::<Vec<_>>();
        run(db, 1, 1, &pages, 0, 1);
    });
    let keys = ["i\0id000", "i\0id256", "i\0id256a", "i\0id512", "i\0id256"]
        .map(str::to_owned);
    let got = reader().points_with_budget(
        &mut open(&f),
        &keys,
        PointBudget {
            statements: 128,
            rows: 4096,
            source_bytes: 16 * 1024 * 1024,
            deadline: std::time::Instant::now() + std::time::Duration::from_secs(5),
        },
    ).unwrap();
    assert_eq!(got.entries, vec![
        Entry::Json("0".into()),
        Entry::Json("256".into()),
        Entry::Absent,
        Entry::Json("512".into()),
        Entry::Json("256".into()),
    ]);
    assert!(got.work.sql_statements < 40, "{}", got.work.sql_statements);
    assert!(got.work.rows_returned < 100, "{}", got.work.rows_returned);
    eprintln!("LARGE_RUN_BATCH_513 sql={} rows={} pages={}",
        got.work.sql_statements, got.work.rows_returned, got.work.page_bodies);
}
#[test]
fn large_run_many_keys_share_boundary_keys_across_the_whole_selected_batch() {
    let source_keys = (0..513)
        .map(|at| format!("i\0id{at:03}"))
        .collect::<Vec<_>>();
    let f = fixture(|db| {
        let pages = source_keys
            .iter()
            .enumerate()
            .map(|(at, key)| (key.as_str(), packed(key, &at.to_string())))
            .collect::<Vec<_>>();
        run(db, 1, 1, &pages, 0, 1);
    });
    let mut keys = source_keys[..100].to_vec();
    keys.extend(["i\0id256", "i\0id256a", "i\0id512", "i\0id049"].map(str::to_owned));
    let got = reader().points_with_budget(
        &mut open(&f),
        &keys,
        PointBudget {
            statements: 128,
            rows: 4096,
            source_bytes: 16 * 1024 * 1024,
            deadline: std::time::Instant::now() + std::time::Duration::from_secs(5),
        },
    ).unwrap();
    for at in 0..100 {
        assert_eq!(got.entries[at], Entry::Json(at.to_string()));
    }
    assert_eq!(got.entries[100], Entry::Json("256".into()));
    assert_eq!(got.entries[101], Entry::Absent);
    assert_eq!(got.entries[102], Entry::Json("512".into()));
    assert_eq!(got.entries[103], got.entries[49]);
    assert!(got.work.sql_statements < 60, "{}", got.work.sql_statements);
    eprintln!("LARGE_RUN_BATCH_513_104 sql={} rows={} pages={}",
        got.work.sql_statements, got.work.rows_returned, got.work.page_bodies);
}
#[test]
fn multipart_exact_text_crosses_utf8_chunk_boundary_and_restarts() {
    let text = format!("{{\"z\":\"{}😀\",\"a\":1.00}}", "x".repeat(65527));
    let f = fixture(|db| {
        run(
            db,
            1,
            1,
            &[("key", r#"[["key","opaque-original-ref",2]]"#.into())],
            0,
            0,
        );
        let split = 65528;
        db.execute(
            "INSERT INTO record_keys_big VALUES(?,1,?)",
            params!["opaque-original-ref", &text[split..]],
        )
        .unwrap();
        db.execute(
            "INSERT INTO record_keys_big VALUES(?,0,?)",
            params!["opaque-original-ref", &text[..split]],
        )
        .unwrap();
    });
    let got = reader().point(&mut open(&f), "key").unwrap();
    assert_eq!(got.entry, Entry::Json(text));
    assert!(got.work.multipart_chunks >= 2);
    assert_eq!(
        reader().point(&mut open(&f), "key").unwrap().entry,
        got.entry
    );
}
#[test]
fn multipart_missing_and_extra_parts_refuse() {
    for extra in [false, true] {
        let f = fixture(|db| {
            run(db, 1, 1, &[("key", r#"[["key","r",2]]"#.into())], 0, 0);
            db.execute("INSERT INTO record_keys_big VALUES('r',0,'1')", [])
                .unwrap();
            if extra {
                db.execute("INSERT INTO record_keys_big VALUES('r',2,'2')", [])
                    .unwrap();
            }
        });
        assert!(reader().point(&mut open(&f), "key").is_err());
    }
}
#[test]
fn source_change_refuses_current_handle_and_old_pin_on_restart() {
    let f = fixture(|db| run(db, 1, 1, &[("key", packed("key", "1"))], 0, 1));
    let mut original = open(&f);
    assert!(reader().point(&mut original, "key").is_ok());
    let db = Connection::open(&f.database).unwrap();
    db.execute(
        "UPDATE record_keys_run_1 SET body=?",
        [packed("key", "123456789")],
    )
    .unwrap();
    db.close().unwrap();
    assert!(reader().point(&mut original, "key").is_err());
    drop(original);
    let catalog = NativeCatalog::open(
        &f.state,
        f.receipt.clone(),
        AccountIdentity {
            user_id: "fixture-user".into(),
            owner_id: "b".repeat(64),
        },
        ReadLimits::default(),
    )
    .unwrap();
    assert!(catalog
        .open_object("NETWORK", &"a".repeat(64), f.sqlite.clone())
        .is_err());
}
#[test]
fn sparse_unknown_and_invalid_layout_refuse_explicitly() {
    for (format, layout) in [(1, 2), (99, 2), (0, 99)] {
        let f = fixture(|db| run(db, 1, 1, &[("key", packed("key", "1"))], format, layout));
        let err = reader().point(&mut open(&f), "key").unwrap_err();
        assert!(err.reason.contains("format") || err.reason.contains("layout"));
        assert_eq!(err.work.page_bodies, 0);
    }
}
#[test]
fn sql_run_value_and_page_bounds_fail_without_truncating() {
    let f = fixture(|db| {
        run(db, 1, 1, &[("key", packed("key", "1"))], 0, 1);
        run(db, 2, 2, &[("a", packed("a", "1"))], 0, 1);
    });
    let mut limits = Limits::default();
    limits.statements = 1;
    assert!(LegacyKept::new(limits)
        .unwrap()
        .point(&mut open(&f), "key")
        .unwrap_err()
        .reason
        .contains("SQL budget"));
    let mut limits = Limits::default();
    limits.runs = 1;
    assert!(LegacyKept::new(limits)
        .unwrap()
        .point(&mut open(&f), "key")
        .unwrap_err()
        .reason
        .contains("candidate-run"));
    let f = fixture(|db| {
        run(
            db,
            1,
            1,
            &[("key", packed("key", &format!("\"{}\"", "x".repeat(2000))))],
            0,
            1,
        )
    });
    let mut limits = Limits::default();
    limits.value_bytes = 1024;
    assert!(LegacyKept::new(limits)
        .unwrap()
        .point(&mut open(&f), "key")
        .is_err());
    let mut limits = Limits::default();
    limits.page_bytes = 1024;
    limits.key_bytes = 128;
    assert!(LegacyKept::new(limits)
        .unwrap()
        .point(&mut open(&f), "key")
        .unwrap_err()
        .reason
        .contains("page exceeds"));
}
#[test]
fn invalid_utf8_text_and_missing_boundary_key_refuse() {
    let f = fixture(|db| {
        run(db, 1, 1, &[("key", packed("key", "1"))], 0, 1);
        db.execute(
            "UPDATE record_keys_run_1 SET body=CAST(X'80FF' AS TEXT)",
            [],
        )
        .unwrap();
    });
    assert!(reader()
        .point(&mut open(&f), "key")
        .unwrap_err()
        .reason
        .contains("UTF-8"));
    let f = fixture(|db| {
        run(db, 1, 1, &[("key", packed("key", "1"))], 0, 1);
        db.execute("DELETE FROM record_keys_run_1", []).unwrap();
    });
    assert!(reader()
        .point(&mut open(&f), "key")
        .unwrap_err()
        .reason
        .contains("boundary key missing"));
}

#[test]
fn compressed_key_expansion_refuses_before_allocating_full_projection() {
    let key = "k".repeat(9000);
    let mut suffixes = vec![key.clone()];
    let mut prefixes = vec![0];
    for i in 0..600 {
        suffixes.push(format!("{i:04}"));
        prefixes.push(9000);
    }
    let raw = format!("{}\n", json!({"s":suffixes,"p":prefixes,"d":vec![0;601]}));
    let f = fixture(|db| run(db, 1, 1, &[(&key, raw)], 0, 1));
    assert!(reader().point(&mut open(&f), &key).is_err());
}

// Counts dispatches through the real pinned SQLite supplier. No fabricated
// QueryRows or substitute page reader is used to qualify the statement bound.
struct CountedSource {
    original: ReadonlyOriginal,
    queries: usize,
    bodies: Vec<i64>,
    serial_boundary_keys: usize,
    measured: bool,
}
impl CountedSource {
    fn new(f: &Fixture) -> Self {
        Self {
            original: open(f),
            queries: 0,
            bodies: Vec::new(),
            serial_boundary_keys: 0,
            measured: true,
        }
    }
    fn record(&mut self, sql: &str, params: &[rusqlite::types::Value]) {
        self.queries += 1;
        if sql.starts_with("SELECT first FROM record_keys_run_") {
            self.serial_boundary_keys += 1;
        }
        if sql.contains("AS body FROM record_keys_run_") {
            if let Some(rusqlite::types::Value::Integer(page)) = params.get(1) {
                self.bodies.push(*page);
            }
        }
    }
}
impl trillion_local::record_source::BoundedRecordSql for CountedSource {
    fn query(
        &mut self,
        sql: &str,
        params: &[rusqlite::types::Value],
    ) -> trillion_local::import::ImportResult<trillion_local::import::QueryRows> {
        self.record(sql, params);
        self.original.query(sql, params)
    }
    fn query_with_budget(
        &mut self,
        sql: &str,
        params: &[rusqlite::types::Value],
        budget: trillion_local::record_source::QueryBudget,
    ) -> trillion_local::import::ImportResult<trillion_local::import::QueryRows> {
        self.record(sql, params);
        self.original.query_with_budget(sql, params, budget)
    }
    fn last_query_timing(&self) -> Option<trillion_local::import::QueryTiming> {
        self.measured.then(|| self.original.last_query_timing())
    }
}
fn budget(
    statements: usize,
    rows: usize,
    source_bytes: usize,
) -> trillion_local::legacy_kept::PointBudget {
    trillion_local::legacy_kept::PointBudget {
        statements,
        rows,
        source_bytes,
        deadline: std::time::Instant::now() + std::time::Duration::from_secs(5),
    }
}
#[test]
fn fifty_three_run_absence_fits_remaining_record_statements_with_real_sqlite_reads() {
    let f = fixture(|db| {
        let names = ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "z0"];
        let pages = names
            .iter()
            .map(|key| (*key, packed(key, "1")))
            .collect::<Vec<_>>();
        for number in 1..=53 {
            run(db, number, number, &pages, 0, 1);
        }
    });
    let before = fs::read(&f.database).unwrap();
    let mut source = CountedSource::new(&f);
    let got = reader()
        .point_with_budget(
            &mut source,
            "target",
            budget(122, 4081, 8 * 1024 * 1024 - 10379),
        )
        .unwrap();
    assert_eq!(got.entry, Entry::Absent);
    assert_eq!(got.work.runs_examined, 53);
    assert_eq!(got.work.page_bodies, 53);
    assert!(source.queries <= 122);
    assert_eq!(source.queries as u64, got.work.sql_statements);
    assert_eq!(source.bodies.len(), 53);
    assert_eq!(fs::read(&f.database).unwrap(), before);
}
#[test]
fn remaining_statement_cap_stops_before_next_real_body_query() {
    let f = fixture(|db| run(db, 1, 1, &[("key", packed("key", "1"))], 0, 1));
    let mut source = CountedSource::new(&f);
    let error = reader()
        .point_with_budget(&mut source, "key", budget(3, 4096, 8 * 1024 * 1024))
        .unwrap_err();
    assert!(error.budget_exhausted);
    assert_eq!(source.queries, 3);
    assert_eq!(error.work.sql_statements, 3);
    assert!(source.bodies.is_empty());
    assert_eq!(
        reader().point(&mut source, "key").unwrap().entry,
        Entry::Json("1".into())
    );
}
#[test]
fn zero_remaining_and_expired_deadline_never_dispatch_sql() {
    let f = fixture(|db| run(db, 1, 1, &[("key", packed("key", "1"))], 0, 1));
    for which in ["statement", "row", "byte", "time"] {
        let mut source = CountedSource::new(&f);
        let mut cap = budget(10, 100, 1024 * 1024);
        match which {
            "statement" => cap.statements = 0,
            "row" => cap.rows = 0,
            "byte" => cap.source_bytes = 0,
            "time" => cap.deadline = std::time::Instant::now(),
            _ => unreachable!(),
        }
        let error = reader()
            .point_with_budget(&mut source, "key", cap)
            .unwrap_err();
        assert!(error.budget_exhausted, "must refuse {which}");
        assert_eq!(source.queries, 0, "no SQL after exhausted {which}");
        assert_eq!(error.work.sql_statements, 0);
    }
}
#[test]
fn remaining_row_and_byte_caps_stop_before_catalogue_or_body_copies() {
    let f = fixture(|db| run(db, 1, 1, &[("key", packed("key", "1"))], 0, 1));
    let mut source = CountedSource::new(&f);
    let error = reader()
        .point_with_budget(&mut source, "key", budget(10, 6, 1024 * 1024))
        .unwrap_err();
    assert!(error.budget_exhausted);
    assert_eq!(source.queries, 1);
    assert_eq!(error.work.rows_returned, 6);
    assert!(source.bodies.is_empty());
    let mut source = CountedSource::new(&f);
    let error = reader()
        .point_with_budget(&mut source, "key", budget(10, 100, 1))
        .unwrap_err();
    assert!(error.budget_exhausted);
    assert_eq!(source.queries, 1);
    assert!(source.bodies.is_empty());
    assert_eq!(
        reader().point(&mut source, "key").unwrap().entry,
        Entry::Json("1".into())
    );
}
#[test]
fn utf16_disagreement_is_repaired_before_fetching_any_wrong_page_body() {
    let f = fixture(|db| {
        run(
            db,
            1,
            1,
            &[
                ("a", "corrupt unselected body".into()),
                ("😀", packed("😀", "1")),
                ("\u{e000}", packed("\u{e000}", "2")),
            ],
            0,
            1,
        )
    });
    let mut source = CountedSource::new(&f);
    let got = reader().point(&mut source, "\u{e000}").unwrap();
    assert_eq!(got.entry, Entry::Json("2".into()));
    assert!(source.serial_boundary_keys > 0);
    assert_eq!(source.bodies, vec![2]);
}
#[test]
fn unmeasured_supplier_timing_stays_explicitly_unknown() {
    let f = fixture(|db| run(db, 1, 1, &[("key", packed("key", "1"))], 0, 1));
    let mut source = CountedSource::new(&f);
    source.measured = false;
    let got = reader().point(&mut source, "key").unwrap();
    assert_eq!(got.entry, Entry::Json("1".into()));
    assert!(!got.work.source_timing_complete);
}
#[test]
fn newer_tombstone_does_not_touch_missing_older_run_or_decode_its_metadata() {
    let f = fixture(|db| {
        run(db, 1, 1, &[("key", "corrupt older body".into())], 99, 99);
        db.execute_batch("DROP TABLE record_keys_run_1").unwrap();
        db.execute(
            "UPDATE record_keys_runs SET last=? WHERE run=1",
            ["malformed older last"],
        )
        .unwrap();
        run(db, 2, 2, &[("key", packed("key", ""))], 0, 1);
    });
    let mut source = CountedSource::new(&f);
    let got = reader().point(&mut source, "key").unwrap();
    assert_eq!(got.entry, Entry::Tombstone);
    assert_eq!(got.work.runs_examined, 1);
    assert_eq!(source.bodies.len(), 1);
}

#[path = "legacy_kept/one_page.rs"]
mod one_page_controls;

#[path = "legacy_kept/filter.rs"]
mod filter_controls;
