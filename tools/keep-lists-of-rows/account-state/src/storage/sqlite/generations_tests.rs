// Purpose: `generations.rs` over real SQLite. Ported from old trillion (tag old-trillion-before-worker-retire):
// test/let-go-of-table.test.mjs (3 tests, same names) and the generation tests of test/record-history.test.mjs ('an older
// log with a key and indexes is sealed whole, copied, dropped, and replaced by a log with neither', 'a kept generation
// too large to drop in one statement goes a bounded piece per wake before its drop', 'a byte-capped sealed history page
// stops reading candidate sizes after its first full row', 'an oversized first history row stays in SQLite without a
// file or deletion') and test/record-history-page-reclaim.test.mjs ('ordinary archival retains pages; full recovery
// deletes only its newly verified interval'), plus children-first teardown.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::*;

fn count(db: &Connection, sql: &str) -> i64 {
    db.query_row(sql, [], |row| row.get(0)).unwrap()
}
fn names(db: &Connection, kind: &str, table: &str) -> Vec<String> {
    let mut statement = db.prepare("SELECT name FROM sqlite_schema WHERE type = ? AND tbl_name = ? AND sql IS NOT NULL ORDER BY name").unwrap();
    statement.query_map([kind, table], |row| row.get(0)).unwrap().map(Result::unwrap).collect()
}

// test/let-go-of-table.test.mjs

#[test]
fn indexes_go_first_rows_only_above_the_drop_size_then_the_owner_drops_what_is_left() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE big (id TEXT PRIMARY KEY, kind TEXT, at TEXT); CREATE INDEX big_kind ON big (kind); CREATE INDEX big_at ON big (at);").unwrap();
    for n in 0..1050 {
        db.execute("INSERT INTO big VALUES (?, ?, ?)", params![format!("r{n}"), format!("k{}", n % 7), format!("t{n}")]).unwrap();
    }
    let settings = LetGo { drop_rows: 300, delete_rows: 250, row_overhead_bytes: 256 };
    let mut pieces = Vec::new();
    loop {
        let piece = let_go_step(&db, "big", settings).unwrap();
        pieces.push(piece);
        assert!(pieces.len() < 20);
        if piece == Piece::Drop {
            break;
        }
    }
    assert_eq!(pieces, [Piece::Index, Piece::Index, Piece::Rows, Piece::Rows, Piece::Rows, Piece::Drop]);
    assert_eq!(count(&db, "SELECT COUNT(*) FROM big"), 300, "rows below the drop size are left for the drop, never paid for one by one");
    assert!(names(&db, "index", "big").is_empty());
}

#[test]
fn a_table_already_small_goes_straight_to_its_drop() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE small (id TEXT PRIMARY KEY); INSERT INTO small VALUES ('a'); CREATE TABLE empty (id INTEGER);").unwrap();
    assert_eq!(let_go_step(&db, "small", shipped()).unwrap(), Piece::Drop);
    assert_eq!(let_go_step(&db, "empty", shipped()).unwrap(), Piece::Drop);
}

#[test]
fn a_let_go_step_reads_the_tables_span_by_seeks_never_by_walking_its_rows() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE big (id TEXT PRIMARY KEY, v TEXT)").unwrap();
    for n in 0..5000 {
        db.execute("INSERT INTO big VALUES (?, 'x')", [format!("r{n}")]).unwrap();
    }
    for query in ["SELECT MIN(rowid) FROM \"big\"", "SELECT MAX(rowid) FROM \"big\""] {
        let mut plan = db.prepare(&format!("EXPLAIN QUERY PLAN {query}")).unwrap();
        let details: Vec<String> = plan.query_map([], |row| row.get::<_, String>(3)).unwrap().map(Result::unwrap).collect();
        assert!(!details.iter().any(|detail| detail.starts_with("SCAN big")), "{query}: {details:?}");
    }
    assert_eq!(let_go_step(&db, "big", LetGo { drop_rows: 100, delete_rows: 50, row_overhead_bytes: 256 }).unwrap(), Piece::Rows);
    assert_eq!(span_of(&db, "big").unwrap(), 4950);
}

// Generations of a log.

fn log() -> Log {
    Log {
        table: "change_log".into(),
        create: "CREATE TABLE IF NOT EXISTS {table} (id TEXT NOT NULL, record_id TEXT, patch TEXT)".into(),
        id_column: "id".into(),
        sealed_prefix: "change_log_sealed_".into(),
        sized_columns: vec!["id".into(), "record_id".into(), "patch".into()],
    }
}
fn write(db: &Connection, from: usize, to: usize, patch: &str) {
    for n in from..to {
        db.execute("INSERT INTO change_log (id, record_id, patch) VALUES (?, ?, ?)", params![format!("0000{n:08x}"), format!("r{}", n % 5), patch]).unwrap();
    }
}

// test/record-history.test.mjs: 'an older log with a key and indexes is sealed whole, copied, dropped, and replaced by a
// log with neither'
#[test]
fn a_log_is_sealed_whole_copied_a_page_at_a_time_dropped_and_replaced_by_a_fresh_open_log() {
    let db = Connection::open_in_memory().unwrap();
    let generations = Generations::open(&db, log()).unwrap();
    db.execute_batch("CREATE INDEX change_log_by_record ON change_log (record_id)").unwrap();
    assert_eq!(generations.seal().unwrap(), None, "an empty log is not sealed");
    write(&db, 0, 25, "p");
    let sealed = generations.seal().unwrap().unwrap();
    assert_eq!(sealed, "change_log_sealed_000000000000");
    assert_eq!(generations.sealed().unwrap(), [sealed.clone()]);
    assert_eq!(count(&db, "SELECT count(*) FROM change_log"), 0, "a fresh open log");
    assert!(names(&db, "index", "change_log").is_empty(), "the fresh log has no index");
    write(&db, 25, 27, "q");
    assert_eq!(generations.oldest_id().unwrap().as_deref(), Some("000000000019"));
    assert_eq!(generations.last_id().unwrap().as_deref(), Some("00000000001a"));
    let mut copied = Vec::new();
    let mut after = generations.kept(&sealed).unwrap();
    loop {
        let page = generations.page(&sealed, after, 10, None).unwrap();
        if page.rows.is_empty() {
            break;
        }
        copied.extend(page.rows.iter().map(|row| row[0].clone()));
        generations.keep_through(&sealed, page.last, false).unwrap();
        after = generations.kept(&sealed).unwrap();
    }
    assert_eq!(copied.len(), 25, "every row copied once, in the order written");
    let mut pieces = Vec::new();
    while let piece @ (Piece::Child | Piece::Index | Piece::Rows) = generations.let_go(&sealed, shipped()).unwrap() {
        pieces.push(piece);
    }
    assert_eq!(pieces, [Piece::Index], "the sealed table's own index went first");
    generations.drop_sealed(&sealed).unwrap();
    assert!(generations.sealed().unwrap().is_empty());
    assert_eq!(generations.kept(&sealed).unwrap(), 0, "its kept position went with it");
    assert!(matches!(generations.page(&sealed, 0, 1, None), Err(GenerationError::NotSealed(_, _))));
    assert!(matches!(generations.page("change_log", 0, 1, None), Err(GenerationError::NotSealed(_, _))), "the open log is never paged");
}

// test/record-history.test.mjs: 'a kept generation too large to drop in one statement goes a bounded piece per wake
// before its drop'
#[test]
fn a_generation_too_large_to_drop_in_one_statement_goes_a_bounded_piece_per_step() {
    let db = Connection::open_in_memory().unwrap();
    let generations = Generations::open(&db, log()).unwrap();
    write(&db, 0, 1000, "p");
    let sealed = generations.seal().unwrap().unwrap();
    let settings = LetGo { drop_rows: 200, delete_rows: 300, row_overhead_bytes: 256 };
    let mut rows = 0;
    while generations.let_go(&sealed, settings).unwrap() == Piece::Rows {
        rows += 1;
        assert!(rows < 10);
    }
    assert_eq!(rows, 3);
    assert!(span_of(&db, &sealed).unwrap() <= 200);
    generations.drop_sealed(&sealed).unwrap();
}

// test/record-history.test.mjs: 'a byte-capped sealed history page stops reading candidate sizes after its first full
// row', 'history pages stop at whole rows under the byte cap', 'an oversized first history row stays in SQLite'
#[test]
fn a_byte_capped_page_stops_at_whole_rows_and_an_oversized_first_row_is_refused_before_it_is_read() {
    let db = Connection::open_in_memory().unwrap();
    let generations = Generations::open(&db, log()).unwrap();
    write(&db, 0, 10, &"x".repeat(100));
    let sealed = generations.seal().unwrap().unwrap();
    // Each row is about 256 + 12 + 2 + 100 bytes: three fit 1200.
    let page = generations.page(&sealed, 0, 100, Some(1200)).unwrap();
    assert_eq!(page.rows.len(), 3);
    assert_eq!(page.last, page.rowids[2]);
    let rest = generations.page(&sealed, page.last, 100, Some(1200)).unwrap();
    assert_eq!(rest.rows.len(), 3, "the next page starts after the last whole row");
    assert!(matches!(generations.page(&sealed, 0, 100, Some(50)), Err(GenerationError::TooLarge(_))), "one row over four times the cap");
    assert_eq!(count(&db, &format!("SELECT count(*) FROM \"{sealed}\"")), 10, "nothing was deleted");
}

// test/record-history-page-reclaim.test.mjs: 'ordinary archival retains pages; full recovery deletes only its newly
// verified interval'
#[test]
fn ordinary_keeping_retains_rows_and_reclaim_deletes_only_the_newly_kept_interval() {
    let db = Connection::open_in_memory().unwrap();
    let generations = Generations::open(&db, log()).unwrap();
    write(&db, 0, 30, "p");
    let sealed = generations.seal().unwrap().unwrap();
    let first = generations.page(&sealed, 0, 10, None).unwrap();
    generations.keep_through(&sealed, first.last, false).unwrap();
    assert_eq!(count(&db, &format!("SELECT count(*) FROM \"{sealed}\"")), 30, "ordinary keeping retains its rows until the drop");
    let second = generations.page(&sealed, first.last, 10, None).unwrap();
    generations.keep_through(&sealed, second.last, true).unwrap();
    assert_eq!(count(&db, &format!("SELECT count(*) FROM \"{sealed}\"")), 20, "only the newly kept interval left");
    assert_eq!(count(&db, &format!("SELECT min(rowid) FROM \"{sealed}\"")), 1, "the rows kept without reclaim stay");
    assert!(matches!(generations.keep_through(&sealed, first.last, true), Err(GenerationError::Backwards(_))));
}

// Children first: a view and a trigger that name a generation go before its indexes, and before it.
#[test]
fn a_generation_goes_children_first_views_and_triggers_then_indexes_then_itself() {
    let db = Connection::open_in_memory().unwrap();
    let generations = Generations::open(&db, log()).unwrap();
    write(&db, 0, 5, "p");
    let sealed = generations.seal().unwrap().unwrap();
    db.execute_batch(&format!(
        "CREATE INDEX sealed_by_record ON \"{sealed}\" (record_id);
         CREATE VIEW sealed_view AS SELECT id FROM \"{sealed}\";
         CREATE TRIGGER sealed_trigger AFTER DELETE ON \"{sealed}\" BEGIN SELECT 1; END;"
    ))
    .unwrap();
    let mut pieces = Vec::new();
    loop {
        let piece = generations.let_go(&sealed, shipped()).unwrap();
        pieces.push(piece);
        if piece == Piece::Drop {
            break;
        }
    }
    assert_eq!(pieces, [Piece::Child, Piece::Child, Piece::Index, Piece::Drop]);
    generations.drop_sealed(&sealed).unwrap();
    assert_eq!(count(&db, "SELECT count(*) FROM sqlite_schema WHERE name LIKE 'sealed_%'"), 0);
}
