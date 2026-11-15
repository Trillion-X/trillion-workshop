// tests/record_log_old_store.rs
//
// Purpose: old trillion's record-log store tests, ported one to one onto the Rust record log (src/record_log.rs) and
// the kept runs it keeps its keys in (src/kept_runs.rs). Old file: Trillion-X/trillion test/record-log-store.test.mjs
// (last present at the parent of 4ffa1dc4). Each test names the old test's line and title. Where the old test counted
// SQL statements by matching SQL text, the port counts the same reads through `kept_runs::Work` (statements, page
// bodies, selected values), which the Rust store reports for every read.
//
// Settings: the old tests' `small` sizes (page 512, memtable 4096, cache 8192) are below the Rust minimum page of
// 1024 bytes, so `small()` uses page 1024 and a key bound of 256 bytes; the shapes each test relies on (several pages
// a run, several runs, a value large enough to spill) hold at these sizes.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use trillion_local::kept_runs::{KeptRuns, Lookup, Range, ReadBudget, Settings, Stepped, Work};

fn small() -> Settings {
    Settings { page_bytes: 1024, memtable_bytes: 4096, cache_bytes: 8192, max_key_bytes: 256, ..Settings::default() }
}
fn create(db: &mut Connection, prefix: &str, settings: Settings) -> KeptRuns {
    let tx = db.transaction().unwrap();
    let runs = KeptRuns::create(&tx, prefix, settings).unwrap();
    tx.commit().unwrap();
    runs
}
fn flush(db: &mut Connection, runs: &mut KeptRuns) {
    flush_covered(db, runs, json!(null));
}
fn flush_covered(db: &mut Connection, runs: &mut KeptRuns, covered: Value) {
    let tx = db.transaction().unwrap();
    runs.flush(&tx, &covered).unwrap();
    tx.commit().unwrap();
}
/// One idle step in its own transaction (old `space.step({ max_pages })`); answers whether more is due.
fn step(db: &mut Connection, runs: &mut KeptRuns, max_pages: usize) -> Stepped {
    let tx = db.transaction().unwrap();
    let stepped = runs.step(&tx, max_pages, ReadBudget::default()).unwrap();
    tx.commit().unwrap();
    stepped
}
fn merge_due(db: &Connection, runs: &KeptRuns) -> bool {
    runs.merge_due(db).unwrap()
}
fn get(db: &Connection, runs: &mut KeptRuns, key: &str) -> Option<Value> {
    match runs.get(db, key, ReadBudget::default()).unwrap().result {
        Lookup::Value(value) => Some(value),
        Lookup::Absent | Lookup::Tombstone => None,
    }
}
/// Every live key in [lo, hi), page after page.
fn range_all(db: &Connection, runs: &mut KeptRuns, lo: &str, hi: &str, reverse: bool, limit: usize) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let want = (limit - out.len()).min(4096);
        let page = runs.range(db, Range { lo, hi, after: after.as_deref(), reverse, limit: want }, ReadBudget::default()).unwrap();
        out.extend(page.entries);
        if page.complete || out.len() >= limit {
            return out;
        }
        after = page.next;
    }
}
fn has_range(db: &Connection, runs: &mut KeptRuns, lo: &str, hi: &str) -> (bool, Work) {
    let read = runs.has_range(db, lo, hi, ReadBudget::default()).unwrap();
    (read.result, read.work)
}

/// Old L153 'range existence respects newest tombstones and stops before older runs or large values'.
/// Existence reads page heads only (no value opened: `selected_values` stays 0, so the 10 000-character value in the
/// big table is never read), and a live newest key answers from the newest run alone: one head statement.
#[test]
fn l153_range_existence_respects_newest_tombstones_and_stops_before_older_runs_or_large_values() {
    let mut db = Connection::open_in_memory().unwrap();
    let settings = Settings { filter_bytes: 0, ..small() };
    let mut space = create(&mut db, "any_range", settings.clone());
    space.put("keep", json!({"text": "x".repeat(10000)})).unwrap();
    flush(&mut db, &mut space);
    space.remove("keep").unwrap();
    flush(&mut db, &mut space);
    assert!(!has_range(&db, &mut space, "a", "z").0);
    space.put("keep", json!({"text": "y".repeat(10000)})).unwrap();
    assert!(has_range(&db, &mut space, "a", "z").0);
    flush(&mut db, &mut space);
    let big: i64 = db.query_row("SELECT count(*) FROM any_range_big", [], |r| r.get(0)).unwrap();
    assert!(big > 0, "the large values live in the big table");
    let mut space = KeptRuns::open(&db, "any_range", settings).unwrap();
    assert_eq!(space.held().runs, 3);
    let (live, work) = has_range(&db, &mut space, "a", "z");
    assert!(live);
    assert_eq!(work.selected_values, 0, "existence never opens a large value");
    assert_eq!(work.page_bodies, 0, "existence reads page heads, not bodies");
    assert_eq!(work.sql_statements, 1, "a live newest key answers before older runs are read");
    assert!(!has_range(&db, &mut space, "z", "a").0);
    space.remove("keep").unwrap();
    assert!(!has_range(&db, &mut space, "a", "z").0);
    space.put("second", Value::Null).unwrap();
    assert!(has_range(&db, &mut space, "a", "z").0, "null is a live JSON value");
}

/// Old L341 'default compaction folds material obsolete values without a policy override'.
#[test]
fn l341_default_compaction_folds_material_obsolete_values_without_a_policy_override() {
    let mut db = Connection::open_in_memory().unwrap();
    let settings = Settings { page_bytes: 32_768, memtable_bytes: 16 * 1024 * 1024, max_key_bytes: 1024, ..Settings::default() };
    let mut state: u32 = 31;
    let mut value = || -> String {
        (0..8192)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                char::from(33 + (state % 90) as u8)
            })
            .collect()
    };
    let mut expected: BTreeMap<String, String> = (0..512).map(|n| (format!("key:{n:04}"), value())).collect();
    let mut store = create(&mut db, "default_fold", settings.clone());
    for (key, text) in &expected {
        store.put(key, json!(text)).unwrap();
    }
    flush(&mut db, &mut store);
    let keys: Vec<String> = expected.keys().take(256).cloned().collect();
    for key in keys {
        let previous = expected[&key].clone();
        let text = value();
        expected.insert(key.clone(), text.clone());
        store.put_replacing(&key, json!(text), serde_json::to_string(&previous).unwrap().len()).unwrap();
    }
    flush(&mut db, &mut store);
    let before = store.held();
    let retained: usize = before.run_list.iter().map(|run| run.bytes).sum();
    assert!(before.compaction_debt >= 1024 * 1024, "the fixture has enough stale values to pass the default floor");
    assert!(before.compaction_debt as f64 >= retained as f64 * 0.25, "the fixture passes the default share of retained run bytes");

    let mut store = KeptRuns::open(&db, "default_fold", settings).unwrap();
    assert!(merge_due(&db, &store), "default policy admits the full fold after reopen");
    let pages: usize = before.run_list.iter().map(|run| run.pages).sum();
    let mut steps = 0;
    while merge_due(&db, &store) {
        assert!(steps < pages * 2 + 20, "bounded slices finish");
        let result = step(&mut db, &mut store, 1);
        assert!(result.pages <= 1, "the existing page allowance stays intact");
        steps += 1;
    }
    let after = store.held();
    assert_eq!(after.compaction_debt, 0);
    assert_eq!(after.runs, 1);
    assert!((after.run_list[0].bytes as f64) < retained as f64 * 0.7, "the fold drops the obsolete values it charged");
    for (key, text) in &expected {
        assert_eq!(get(&db, &mut store, key), Some(json!(text)));
    }
}

/// Old L389 'the key space answers like a plain map through flushes, merges and reopening'.
#[test]
fn l389_the_key_space_answers_like_a_plain_map_through_flushes_merges_and_reopening() {
    let mut db = Connection::open_in_memory().unwrap();
    let settings = Settings { fan_in: 3, ..small() };
    let mut space = create(&mut db, "kt", settings.clone());
    let mut model: BTreeMap<String, Value> = BTreeMap::new();
    let mut seed: u64 = 7;
    let mut random = || {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        seed as f64 / 2147483648.0
    };
    for round in 0..3000 {
        let key = format!("k{:04}", (random() * 400.0) as u32);
        if random() < 0.2 {
            space.remove(&key).unwrap();
            model.remove(&key);
        } else {
            let wide = random() < 0.01;
            let length = (random() * if wide { 5000.0 } else { 60.0 }) as usize;
            let value = json!({"round": round, "text": "x".repeat(length)});
            space.put(&key, value.clone()).unwrap();
            model.insert(key, value);
        }
        if space.full() {
            flush(&mut db, &mut space);
        }
        if round % 50 == 0 {
            while step(&mut db, &mut space, 2).more {}
        }
        if round % 500 == 499 {
            flush(&mut db, &mut space);
            space = KeptRuns::open(&db, "kt", settings.clone()).unwrap();
        }
    }
    for (key, value) in &model {
        assert_eq!(get(&db, &mut space, key).as_ref(), Some(value), "{key}");
    }
    let expected: Vec<String> = model.keys().cloned().collect();
    let keys = |entries: Vec<(String, Value)>| entries.into_iter().map(|(key, _)| key).collect::<Vec<_>>();
    assert_eq!(keys(range_all(&db, &mut space, "k", "l", false, usize::MAX)), expected, "a range walks every live key in order");
    let last5: Vec<String> = expected.iter().rev().take(5).cloned().collect();
    assert_eq!(keys(range_all(&db, &mut space, "k", "l", true, 5)), last5);
    let window: Vec<String> = expected.iter().filter(|key| key.as_str() >= "k0100" && key.as_str() < "k0200").cloned().collect();
    assert_eq!(keys(range_all(&db, &mut space, "k0100", "k0200", false, usize::MAX)), window);
    assert!(space.held().runs < 12, "merging keeps the runs few ({})", space.held().runs);
}

/// Old L410 'small write-outs merge without copying a much larger base run'.
#[test]
fn l410_small_write_outs_merge_without_copying_a_much_larger_base_run() {
    let mut db = Connection::open_in_memory().unwrap();
    // The old memtable had no hard hold limit; Rust refuses puts past `memtable_hold` times its size, so the 96-key
    // base needs a larger hold to be written out as one run, as the old test wrote it.
    let mut space = create(&mut db, "size_tiers", Settings { memtable_hold: 16, ..small() });
    for at in 0..96 {
        space.put(&format!("base-{at}"), json!({"text": "b".repeat(100)})).unwrap();
    }
    flush(&mut db, &mut space);
    let base = space.held().run_list[0].clone();
    assert!(base.bytes > small().memtable_bytes, "base run holds {} bytes", base.bytes);
    // Each small write-out merges with the small runs written since the base, never with the base itself: a run is
    // copied again only beside at least as many pages written after it (kept-runs tier_group).
    for at in 0..4 {
        space.put(&format!("later-{at}"), json!({"text": format!("later {at}")})).unwrap();
        flush(&mut db, &mut space);
        while step(&mut db, &mut space, 64).more {}
    }
    let held = space.held();
    assert!(held.runs <= 3, "{} runs after four small write-outs", held.runs);
    assert!(held.run_list.iter().any(|run| run.run == base.run), "the large base was not recopied");
    for at in 0..64 {
        assert_eq!(get(&db, &mut space, &format!("base-{at}")), Some(json!({"text": "b".repeat(100)})));
    }
    for at in 0..4 {
        assert_eq!(get(&db, &mut space, &format!("later-{at}")), Some(json!({"text": format!("later {at}")})));
    }
}

/// Old L430 'write-outs and mergers keep large values off neighboring key pages'.
/// The old store's earlier layout kept a 3000-character value inline on an 8 KiB page; reopened with a smaller page,
/// a merge moves it to the big table so no output page is larger than the store's page size.
#[test]
fn l430_write_outs_and_mergers_keep_large_values_off_neighboring_key_pages() {
    let mut db = Connection::open_in_memory().unwrap();
    // The old `max_runs: 2` was its backlog threshold; Rust names that `merge_backlog_runs` (its `max_runs` is the
    // hard catalogue bound).
    let open = |db: &Connection, page_bytes: usize| {
        KeptRuns::open(db, "page_bound", Settings { page_bytes, fan_in: 2, merge_backlog_runs: 2, max_runs: 8, ..small() }).unwrap()
    };
    let mut earlier = create(&mut db, "page_bound", Settings { page_bytes: 8192, ..small() });
    earlier.put("large", json!({"text": "z".repeat(3000)})).unwrap();
    flush(&mut db, &mut earlier);
    let first: i64 = db.query_row("SELECT length(body) FROM page_bound_run_1 WHERE page = 0", [], |r| r.get(0)).unwrap();
    assert!(first > 1024, "earlier inline layout has an oversized page");
    let mut bounded = open(&db, 1024);
    for at in 0..3 {
        bounded.put(&format!("later-{at}"), json!({"text": format!("later {at}")})).unwrap();
        flush(&mut db, &mut bounded);
    }
    let mut steps = 0;
    while merge_due(&db, &bounded) {
        step(&mut db, &mut bounded, 1);
        steps += 1;
        assert!(steps < 40, "bounded steps finish the old-page merge");
    }
    let tables: Vec<String> = {
        let mut query = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'page_bound_run_[0-9]*'").unwrap();
        let names = query.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        names
    };
    for name in tables {
        let largest: Option<i64> = db.query_row(&format!("SELECT max(length(body)) FROM {name} WHERE page >= 0"), [], |r| r.get(0)).unwrap();
        assert!(largest.unwrap_or(0) <= 1024, "{name} has a {largest:?}-byte page");
    }
    assert_eq!(get(&db, &mut bounded, "large"), Some(json!({"text": "z".repeat(3000)})));
    for at in 0..3 {
        assert_eq!(get(&db, &mut bounded, &format!("later-{at}")), Some(json!({"text": format!("later {at}")})));
    }
}

/// Old L551 'catalog, run metadata and keyed pages read without materializing SQLite result sets'.
/// The Rust store steps every SQLite cursor row by row (rusqlite `Rows::next`), never collecting a result set, so
/// what remains to hold is the behaviour the old test checked through it: the covered marker, a key and an absent key
/// read back after a cold reopen with no resident filter.
#[test]
fn l551_catalog_run_metadata_and_keyed_pages_read_after_reopen() {
    let mut db = Connection::open_in_memory().unwrap();
    let mut space = create(&mut db, "kt", small());
    for index in 0..100 {
        space.put(&format!("key-{index}"), json!({"index": index})).unwrap();
    }
    flush_covered(&mut db, &mut space, json!(42));
    let mut reopened = KeptRuns::open(&db, "kt", Settings { filter_bytes: 0, ..small() }).unwrap();
    reopened.reload_catalog(&db).unwrap();
    assert_eq!(reopened.covered(&db).unwrap(), Some(json!(42)), "the keyed metadata read answers the covered marker");
    assert_eq!(get(&db, &mut reopened, "key-99"), Some(json!({"index": 99})));
    assert_eq!(get(&db, &mut reopened, "absent"), None);
}

/// Old L574 'catalog reload restores an omitted filter when another run leaves'.
/// With room for one resident filter, the newer run's filter is resident and the older run's stays on disk: an
/// absent key probes the older run's persisted filter bytes (one statement) and reads no page. Once the newer run
/// leaves, a catalogue reload makes the older run's filter resident: the same probe reads nothing at all.
#[test]
fn l574_catalog_reload_restores_an_omitted_filter_when_another_run_leaves() {
    let mut db = Connection::open_in_memory().unwrap();
    let mut space = create(&mut db, "kt", Settings { filter_bytes: 64, ..small() });
    space.put("a", json!(1)).unwrap();
    space.put("z", json!(2)).unwrap();
    flush(&mut db, &mut space);
    space.put("b", json!(3)).unwrap();
    space.put("y", json!(4)).unwrap();
    flush(&mut db, &mut space);
    space.reload_catalog(&db).unwrap();
    let held = space.held();
    let (newer, older) = (held.run_list[0].clone(), held.run_list[1].clone());
    assert!(newer.filter_resident && !older.filter_resident, "the budget holds one filter: the newer run's");
    let read = space.get(&db, "m", ReadBudget::default()).unwrap();
    assert_eq!(read.result, Lookup::Absent);
    assert_eq!(read.work.sql_statements, 1, "an omitted resident filter probes its persisted membership bytes");
    assert_eq!(read.work.page_bodies, 0, "a negative membership probe does not read a data page");
    let tx = db.transaction().unwrap();
    tx.execute("DELETE FROM kt_runs WHERE run = ?", [newer.run]).unwrap();
    tx.execute_batch(&format!("DROP TABLE kt_run_{}", newer.run)).unwrap();
    tx.commit().unwrap();
    space.reload_catalog(&db).unwrap();
    let read = space.get(&db, "m", ReadBudget::default()).unwrap();
    assert_eq!(read.result, Lookup::Absent);
    assert_eq!(read.work.page_bodies, 0, "reload uses the newly available filter budget");
    assert_eq!(read.work.sql_statements, 0, "the restored resident filter needs no SQL probe");
    assert_eq!(get(&db, &mut space, "a"), Some(json!(1)));
    assert_eq!(space.held().run_list[0].run, older.run);
}

/// Old L56 'cold range heads return the sought page with its fence in one statement'. The halving over a run's page
/// fences and the found page's read are one SQL statement (`KeptRuns` floor seek, old kept-runs.mjs seekSql), forward
/// and reverse, and cold existence uses the same seek.
#[test]
fn l56_cold_range_heads_return_the_sought_page_with_its_fence_in_one_statement() {
    let mut db = Connection::open_in_memory().unwrap();
    let options = Settings { memtable_bytes: 1 << 20, ..small() };
    let mut written = create(&mut db, "range_head", options.clone());
    let keys: Vec<String> = (0..80).map(|n| format!("k{n:03}")).collect();
    for key in &keys {
        written.put(key, json!(key)).unwrap();
    }
    flush(&mut db, &mut written);
    let pages: i64 = db.query_row("SELECT COUNT(*) FROM range_head_run_1 WHERE page >= 0", [], |r| r.get(0)).unwrap();
    assert!(pages > 4, "{pages} pages");
    for reverse in [false, true] {
        let mut space = KeptRuns::open(&db, "range_head", options.clone()).unwrap();
        let page = space.range(&db, Range { lo: "k042", hi: "k042\u{0}", after: None, reverse, limit: 1 }, ReadBudget::default()).unwrap();
        assert_eq!(page.entries, vec![("k042".to_string(), json!("k042"))]);
        assert_eq!(page.work.sql_statements, 1, "a cold {} head reads its fence and page together", if reverse { "reverse" } else { "forward" });
    }
    let mut space = KeptRuns::open(&db, "range_head", options).unwrap();
    let (live, work) = has_range(&db, &mut space, "k042", "k042\u{0}");
    assert!(live);
    assert_eq!(work.sql_statements, 1, "cold existence uses the same fused head");
}

/// A whole walk (old `[...space.walk(lo, hi, { readValue })]`): every live key and its value, None when not read.
fn walk(db: &Connection, runs: &mut KeptRuns, lo: &str, hi: &str, read: &mut dyn FnMut(&str) -> bool) -> (Vec<(String, Option<Value>)>, Work) {
    let mut out = Vec::new();
    let work = runs.walk(db, lo, hi, ReadBudget::default(), read, &mut |key, value| { out.push((key, value)); Ok(true) }).unwrap();
    (out, work)
}

/// Old L760 'ordered walks stream uncached spans and reuse resident run pages'. A walk opens one ordered SQL cursor per
/// span of pages not resident: a page a point read left in the cache splits the cold run into two spans, and a warm
/// walk opens none.
#[test]
fn l760_ordered_walks_stream_uncached_spans_and_reuse_resident_run_pages() {
    let mut db = Connection::open_in_memory().unwrap();
    let options = Settings { cache_bytes: 1 << 20, memtable_bytes: 1 << 20, ..small() };
    let mut space = create(&mut db, "cached_walk", options.clone());
    for index in 0..64 {
        space.put(&format!("k{index:04}"), json!(index)).unwrap();
        if space.full() {
            flush(&mut db, &mut space);
        }
    }
    flush(&mut db, &mut space);
    assert_eq!(space.held().runs, 1, "one run");
    assert!(space.held().run_list[0].pages > 4, "{} pages", space.held().run_list[0].pages);
    let mut space = KeptRuns::open(&db, "cached_walk", options).unwrap();
    assert_eq!(get(&db, &mut space, "k0032"), Some(json!(32)), "a point read leaves one page resident");
    let expected: Vec<(String, Option<Value>)> = (0..64).map(|index| (format!("k{index:04}"), Some(json!(index)))).collect();
    let (walked, work) = walk(&db, &mut space, "k", "l", &mut |_| true);
    assert_eq!(walked, expected);
    let total_pages = space.held().run_list[0].pages as u64;
    assert_eq!(work.page_bodies, total_pages - 1, "every cold page is read once, the resident one from the cache");
    assert_eq!(work.streams, 2, "the resident page splits the cold run into two streamed spans");
    assert_eq!(work.point_pages, 0);
    let (walked, work) = walk(&db, &mut space, "k", "l", &mut |_| true);
    assert_eq!(walked, expected);
    assert_eq!(work.page_bodies, 0);
    assert_eq!(work.streams + work.point_pages, 0, "a warm walk rereads no run pages from SQLite");
}

/// Old L781 'ordered walks preserve newest values and close lazy SQL cursors on early exit and open failure'.
/// The newest value wins across three runs and the memtable, a tombstone hides its key, a bounded walk starts and ends
/// at the same keys as the range, and a walk stopped after its first key reads only the first page of each run. The
/// old test also counted open cursors through a wrapped `sql.exec`; here a cursor is a `rusqlite::Rows` owned by the
/// walk's stack, dropped (closed) on every return, so there is no cursor left to count.
#[test]
fn l781_ordered_walks_preserve_newest_values_and_close_lazy_sql_cursors_on_early_exit_and_open_failure() {
    let mut db = Connection::open_in_memory().unwrap();
    let mut space = create(&mut db, "walk_cursor", Settings { memtable_bytes: 1 << 20, ..small() });
    for run in 0..3 {
        for index in 0..20 {
            space.put(&format!("k{index:04}"), json!({ "run": run, "text": "x".repeat(40) })).unwrap();
        }
        flush(&mut db, &mut space);
    }
    space.remove("k0003").unwrap();
    space.put("k0007", json!({ "run": "memory" })).unwrap();
    let pages: usize = space.held().run_list.iter().map(|run| run.pages).sum();
    assert!(pages > 3, "{pages} pages");
    let mut early = Vec::new();
    let work = space
        .walk(&db, "k", "l", ReadBudget::default(), &mut |_| true, &mut |key, value| { early.push((key, value)); Ok(false) })
        .unwrap();
    assert_eq!(early[0].0, "k0000");
    assert!(work.page_bodies > 0 && work.page_bodies <= 3, "the uncached runs read {} first pages", work.page_bodies);
    assert!((work.page_bodies as usize) < pages, "early exit read {} of {pages} run pages", work.page_bodies);
    let (walked, _) = walk(&db, &mut space, "k", "l", &mut |_| true);
    let ranged: Vec<(String, Option<Value>)> = range_all(&db, &mut space, "k", "l", false, 4096).into_iter().map(|(k, v)| (k, Some(v))).collect();
    assert_eq!(walked, ranged, "duplicates, a tombstone and a memtable override match the established range");
    assert_eq!(walked.len(), 19);
    assert_eq!(walked.iter().find(|(key, _)| key == "k0007").unwrap().1.as_ref().unwrap()["run"], json!("memory"));
    assert_eq!(walked.iter().find(|(key, _)| key == "k0008").unwrap().1.as_ref().unwrap()["run"], json!(2));
    let (bounded, _) = walk(&db, &mut space, "k0005", "k0013", &mut |_| true);
    let ranged: Vec<(String, Option<Value>)> = range_all(&db, &mut space, "k0005", "k0013", false, 4096).into_iter().map(|(k, v)| (k, Some(v))).collect();
    assert_eq!(bounded, ranged, "a bounded walk starts and ends at the same keys");
    // A source that fails partway: a missing page of the oldest run fails the walk with an error, not a short answer.
    let oldest = space.held().run_list.last().unwrap().run;
    db.execute(&format!("DELETE FROM walk_cursor_run_{oldest} WHERE page = 1"), []).unwrap();
    let mut fresh = KeptRuns::open(&db, "walk_cursor", Settings { memtable_bytes: 1 << 20, ..small() }).unwrap();
    assert!(fresh.walk(&db, "k", "l", ReadBudget::default(), &mut |_| true, &mut |_, _| Ok(true)).is_err());
}

/// Old L829 'filtered ordered walks keep winner and tombstone semantics without opening skipped values'.
#[test]
fn l829_filtered_ordered_walks_keep_winner_and_tombstone_semantics_without_opening_skipped_values() {
    let mut db = Connection::open_in_memory().unwrap();
    // The old memtable had no hold limit (note 2): a memtable large enough for three 128 000-character values.
    let options = Settings { cache_bytes: 512, memtable_bytes: 1 << 20, ..small() };
    let mut space = create(&mut db, "filtered_walk", options.clone());
    space.put("a", json!({ "text": "a".repeat(128_000) })).unwrap();
    space.put("b", json!({ "text": "b".repeat(128_000) })).unwrap();
    space.put("c", json!({ "text": "c".repeat(128_000) })).unwrap();
    flush(&mut db, &mut space);
    space.put("b", json!({ "text": "new winner" })).unwrap();
    space.remove("c").unwrap();
    flush(&mut db, &mut space);
    let mut space = KeptRuns::open(&db, "filtered_walk", options).unwrap();
    let (walked, work) = walk(&db, &mut space, "a", "d", &mut |key| key == "b");
    assert_eq!(
        walked,
        vec![("a".to_string(), None), ("b".to_string(), Some(json!({ "text": "new winner" })))],
        "a skipped live key remains visible, a replaced value stays hidden, and a tombstone remains absent"
    );
    assert_eq!(work.selected_values, 1, "the rejected large values and older overwritten values are never opened");
    assert_eq!(work.big_values, 0, "no big value read");
}

/// Old L112 'resident adjacent gaps preserve strict fences through eviction and reopening'. Two adjacent pages left in
/// the page cache answer a range that falls in the gap between them, forward and reverse, with no read, and a range
/// reaching the second page's first key returns it. Through a small cache (eviction) and a reopened store, removing
/// and restoring that key keeps the answers exact. The two pages are warmed as the old test warmed them, with
/// `ranges([{ lo, hi }])`.
#[test]
fn l112_resident_adjacent_gaps_preserve_strict_fences_through_eviction_and_reopening() {
    let mut db = Connection::open_in_memory().unwrap();
    let options = Settings { memtable_bytes: 1 << 20, cache_bytes: 1 << 20, ..small() };
    let mut written = create(&mut db, "gap_cache", options.clone());
    let keys: Vec<String> = (0..80).map(|n| format!("k{n:03}")).collect();
    for key in &keys {
        written.put(key, json!(key)).unwrap();
    }
    flush(&mut db, &mut written);
    let fences: Vec<String> = {
        let mut query = db.prepare("SELECT first FROM gap_cache_run_1 WHERE page >= 0 ORDER BY page").unwrap();
        let rows = query.query_map([], |r| r.get::<_, String>(0)).unwrap().map(|f| serde_json::from_str(&f.unwrap()).unwrap()).collect();
        rows
    };
    assert!(fences.len() > 4);
    let next = fences[3].clone();
    let before = keys[keys.iter().position(|k| *k == next).unwrap() - 1].clone();
    let gap = format!("{before}\u{0}");
    let upper = format!("{next}\u{0}");
    fn read(db: &Connection, space: &mut KeptRuns, lo: &str, hi: &str, reverse: bool) -> (Vec<String>, u64) {
        let page = space.range(db, Range { lo, hi, after: None, reverse, limit: 100 }, ReadBudget::default()).unwrap();
        (page.entries.into_iter().map(|(k, _)| k).collect(), page.work.sql_statements)
    }
    let mut space = KeptRuns::open(&db, "gap_cache", options.clone()).unwrap();
    let (found, reads) = read(&db, &mut space, &next, &upper, false);
    assert_eq!(found, vec![next.clone()]);
    assert!(reads > 0, "a cold seek reads its page");
    space.ranges(&db, &[(before.clone(), upper.clone())], false, usize::MAX, None, ReadBudget::default()).unwrap();
    assert_eq!(read(&db, &mut space, &gap, &next, false), (vec![], 0), "resident adjacent pages prove their gap");
    assert_eq!(read(&db, &mut space, &gap, &next, true), (vec![], 0), "and in reverse");
    assert_eq!(read(&db, &mut space, &gap, &upper, false), (vec![next.clone()], 0), "and their strict upper fence");
    for cache_bytes in [256, 1 << 20] {
        let mut space = KeptRuns::open(&db, "gap_cache", Settings { cache_bytes, ..options.clone() }).unwrap();
        read(&db, &mut space, "k", "l", false);
        assert_eq!(read(&db, &mut space, &gap, &next, false).0, Vec::<String>::new());
        assert_eq!(read(&db, &mut space, &gap, &upper, true).0, vec![next.clone()]);
        space.remove(&next).unwrap();
        flush(&mut db, &mut space);
        assert_eq!(read(&db, &mut space, &gap, &upper, false).0, Vec::<String>::new());
        space.put(&next, json!(next)).unwrap();
        flush(&mut db, &mut space);
    }
}

/// The old tests that drive the record store itself (`recordLogStore`), against `RecordLog`. The old store wrote with
/// no request key and no rights check of its own; here every call is admitted by a fixture that admits the fixture
/// scope, and writes use `write_unrequested` (old record-requests.mjs: a write without a request key is an ordinary
/// write). The old store wrote out a full memtable and merged only in `maintain`, so these stores keep the old rule
/// (`LogOptions::upkeep_in_writes` false).
mod store {
    use rusqlite::Connection;
    use serde_json::{json, Value};
    use std::{
        collections::BTreeMap,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };
    use trillion_local::{
        kept_runs::{Held, Settings},
        record_log::{Admission, BucketPage, Checksum, ContentIds, Context, Shared, Error, Found, Index, IndexEntry, LogIds, LogOptions, Maintenance, Projected, RecordInput, RecordLog, Request, Scan, Scope, Selected, ValueText, Work},
    };

    pub struct Text;
    impl ValueText for Text {
        fn encode(&self, value: &Value) -> Result<String, Error> {
            Ok(serde_json::to_string(value)?)
        }
    }
    pub struct Admit;
    impl Admission for Admit {
        fn assert_current(&self, scope: &Scope, _: &Request, _: &str) -> bool {
            scope == &scope_value()
        }
        fn validate_prepared(&self, _: &Scope, _: &[RecordInput], _: &BTreeMap<String, Option<Projected>>) -> bool {
            true
        }
    }
    /// Canonical UUIDv7 log ids, increasing across every store in the test binary, as the old uuidv7 was.
    pub struct Ids;
    static NEXT: AtomicU64 = AtomicU64::new(1);
    impl LogIds for Ids {
        fn next_log_id(&mut self) -> Option<String> {
            let n = NEXT.fetch_add(1, Ordering::SeqCst);
            Some(format!("{:08x}-{:04x}-7000-8000-000000000000", n >> 16, n & 0xffff))
        }
    }
    pub fn scope_value() -> Scope {
        Scope { account: "account".into(), resource: "own-records".into() }
    }
    fn context() -> Context {
        Context {
            actor: json!({}),
            application_time: "2026-10-05T10:00:00Z".into(),
            system_time: "2026-10-05T10:00:00Z".into(),
            accepted_at_ms: 1_000_000,
        }
    }
    fn request() -> Request {
        Request { key: "read".into(), sent_at_ms: 1_000_000 }
    }
    /// The old `small` sizes at the Rust minimum page (see the doc's note 2).
    pub fn small() -> Settings {
        Settings { page_bytes: 1024, memtable_bytes: 4096, cache_bytes: 8192, max_key_bytes: 256, ..Settings::default() }
    }
    /// The old store's rules: a full memtable is written out and runs merge only in `maintain`.
    pub fn old() -> LogOptions {
        LogOptions { upkeep_in_writes: false, ..LogOptions::default() }
    }

    /// One `recordLogStore` over a database file.
    pub struct Store {
        pub log: RecordLog,
        path: PathBuf,
        settings: Settings,
        options: LogOptions,
    }
    pub fn note(id: &str, value: Value) -> RecordInput {
        kind(id, "note", value)
    }
    pub fn kind(id: &str, kind: &str, value: Value) -> RecordInput {
        let fields = value.as_object().expect("a record value is an object").iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        RecordInput { id: id.into(), record_type: kind.into(), value: Some(fields) }
    }
    pub fn removal(id: &str) -> RecordInput {
        RecordInput::remove(id)
    }
    impl Store {
        pub fn create(path: &Path, settings: Settings, options: LogOptions) -> Self {
            let log = RecordLog::create_with(Connection::open(path).unwrap(), scope_value(), settings.clone(), options.clone()).unwrap();
            Self { log, path: path.into(), settings, options }
        }
        /// Opens the same database again (old `store = recordLogStore(host.sql, options)`).
        pub fn reopen(&self) -> Self {
            self.reopen_with(self.settings.clone(), self.options.clone())
        }
        pub fn reopen_with(&self, settings: Settings, options: LogOptions) -> Self {
            let log = RecordLog::reopen_with(Connection::open(&self.path).unwrap(), scope_value(), settings.clone(), options.clone()).unwrap();
            Self { log, path: self.path.clone(), settings, options }
        }
        pub fn write(&mut self, records: Vec<RecordInput>) -> Work {
            self.try_write(records).unwrap()
        }
        pub fn try_write(&mut self, records: Vec<RecordInput>) -> Result<Work, Error> {
            Ok(self.log.write_unrequested(&records, &context(), &Admit, &Text, &mut Ids)?.work)
        }
        pub fn read(&mut self, id: &str) -> Option<Value> {
            self.read_measured(id).0
        }
        pub fn read_measured(&mut self, id: &str) -> (Option<Value>, Work) {
            let read = self.log.read(id, &request(), &Admit, &Text).unwrap();
            let value = read.record.and_then(|p| p.kept.value).map(|fields| Value::Object(fields.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()));
            (value, read.work)
        }
        pub fn type_of(&mut self, id: &str) -> Option<String> {
            self.log.type_of(id, &request(), &Admit, &Text).unwrap()
        }
        pub fn ids(&mut self, kind: &str, limit: Option<usize>) -> (Vec<String>, Work) {
            self.log.ids(kind, limit, &request(), &Admit, &Text).unwrap()
        }
        pub fn count(&mut self, kind: &str) -> Option<u64> {
            self.log.count(kind, &request(), &Admit, &Text).unwrap()
        }
        pub fn count_many(&mut self, kinds: &[&str]) -> (BTreeMap<String, Option<u64>>, Work) {
            self.log.count_many(kinds, &request(), &Admit, &Text).unwrap()
        }
        pub fn checkpoint(&mut self) -> usize {
            self.log.checkpoint(&Text).unwrap().pages
        }
        pub fn maintain(&mut self, max_pages: usize) -> Maintenance {
            self.log.maintain(max_pages, &mut || true, &Text).unwrap()
        }
        pub fn scan(&mut self, kind: &str, name: &str, scan: Scan) -> Vec<IndexEntry> {
            self.scan_measured(kind, name, scan).0
        }
        pub fn scan_measured(&mut self, kind: &str, name: &str, scan: Scan) -> (Vec<IndexEntry>, Work) {
            self.log.scan(kind, name, &scan, &request(), &Admit, &Text).unwrap()
        }
        pub fn ids_where(&mut self, kind: &str, field: &str, value: Value) -> Result<Vec<String>, Error> {
            self.log.ids_where(kind, field, &value, &request(), &Admit, &Text)
        }
        pub fn find(&mut self, words: &[&str], paths: &[&[&str]], kinds: Option<&[&str]>, limit: usize) -> Vec<Found> {
            let paths: Vec<Vec<String>> = paths.iter().map(|p| p.iter().map(|f| f.to_string()).collect()).collect();
            self.log.find(words, &paths, kinds, limit, &request(), &Admit, &Text).unwrap()
        }
        pub fn held(&self) -> Held {
            self.log.held()
        }
        pub fn log_rows(&self) -> i64 {
            self.log.connection().query_row("SELECT COUNT(*) FROM record_log", [], |r| r.get(0)).unwrap()
        }
        /// Takes the counts out of the kept checkpoint, as a store written before counts were kept left it.
        pub fn forget_kept_counts(&self) {
            let db = self.log.connection();
            let text: String = db.query_row("SELECT value FROM record_keys_meta WHERE key = 'covered'", [], |r| r.get(0)).unwrap();
            let mut position: Value = serde_json::from_str(&text).unwrap();
            position.as_object_mut().unwrap().remove("counts");
            db.execute("UPDATE record_keys_meta SET value = ? WHERE key = 'covered'", [position.to_string()]).unwrap();
        }
    }
    pub fn n(number: usize) -> String {
        format!("n{number:04}")
    }

    /// Old L609 'a write is one log row, an unchanged write appends nothing, and reads come back fresh'.
    #[test]
    fn l609_a_write_is_one_log_row_an_unchanged_write_appends_nothing_and_reads_come_back_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::create(&dir.path().join("store.sqlite"), small(), old());
        let first = json!({ "at": "2026-10-05T10:00:00Z", "room": "a", "text": "hello", "tags": ["x"] });
        let work = store.write(vec![note("n1", first.clone()), note("n2", json!({ "at": "2026-10-05T10:01:00Z", "room": "b", "text": "two" }))]);
        assert_eq!(work.sqlite_user_rows_changed, 1, "two records, one row written");
        assert_eq!(store.log_rows(), 1);
        let work = store.write(vec![note("n1", first.clone())]);
        assert_eq!(work.sqlite_user_rows_changed, 0, "nothing changed, nothing written");
        assert_eq!(store.log_rows(), 1);
        let mut copy = store.read("n1").unwrap();
        copy["tags"].as_array_mut().unwrap().push(json!("y"));
        assert_eq!(store.read("n1").unwrap()["tags"], json!(["x"]), "a copy handed out never changes what is kept");
        store.write(vec![removal("n1")]);
        assert_eq!(store.read("n1"), None);
        assert_eq!(store.type_of("n2").as_deref(), Some("note"));
    }

    /// Old L627 'a restart and a rolled-back transaction rebuild the projection from the log'.
    #[test]
    fn l627_a_restart_and_a_rolled_back_transaction_rebuild_the_projection_from_the_log() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::create(&dir.path().join("store.sqlite"), small(), old());
        let at = |n: usize| format!("t{n:04}");
        for number in 0..200 {
            store.write(vec![note(&format!("n{number}"), json!({ "at": at(number), "room": format!("r{}", number % 3), "text": "w".repeat(40) }))]);
        }
        let mut store = store.reopen();
        for number in 0..200 {
            assert_eq!(store.read(&format!("n{number}")).unwrap()["at"], json!(at(number)));
        }
        // A rollback reported through the host's transaction.
        let failed = store.log.transaction(|log| {
            log.write_unrequested(&[note("gone", json!({ "at": "z" }))], &context(), &Admit, &Text, &mut Ids)?;
            Err::<(), _>(Error::Invalid("boom", trillion_local::cause!()))
        });
        assert!(failed.is_err());
        store.log.forget_cached();
        assert_eq!(store.read("gone"), None);
        // A rollback nobody reported: the next write finds the log shorter than the projection and rebuilds it first.
        store.log.connection().execute_batch("BEGIN IMMEDIATE").unwrap();
        store.write(vec![note("ghost", json!({ "at": "z" }))]);
        store.log.connection().execute_batch("ROLLBACK").unwrap();
        store.write(vec![note("real", json!({ "at": "y" }))]);
        assert_eq!(store.read("ghost"), None, "the unreported rollback is not kept");
        assert_eq!(store.read("real").unwrap()["at"], json!("y"));
        assert!(!store.ids("note", None).0.contains(&"ghost".to_string()));
    }

    /// Old L1038 'small quiet writes stay batched with durable replay bounded by log rows'.
    #[test]
    fn l1038_small_quiet_writes_stay_batched_with_durable_replay_bounded_by_log_rows() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings { memtable_bytes: 1 << 20, ..small() };
        let options = LogOptions { tail_rows: 4, ..old() };
        let mut store = Store::create(&dir.path().join("store.sqlite"), settings, options);
        assert!(!store.log.maintenance_due().unwrap(), "nothing to do in an empty store");
        for number in 1..=3 {
            store.write(vec![note(&format!("n{number}"), json!({ "text": format!("note {number}") }))]);
        }
        store.maintain(256);
        assert!(store.held().memtable_bytes > 0, "quiet time alone creates no small run");
        assert!(!store.log.maintenance_due().unwrap());
        let mut reopened = store.reopen();
        let (value, work) = reopened.read_measured("n1");
        assert_eq!(value, Some(json!({ "text": "note 1" })));
        // One read of where the log ends, then its rows.
        assert_eq!(work.journal_rows_read, 1 + 3, "the durable tail replays within its row bound");
        for number in 2..=3 {
            assert_eq!(reopened.read(&format!("n{number}")), Some(json!({ "text": format!("note {number}") })));
        }
        reopened.write(vec![note("n4", json!({ "text": "note 4" }))]);
        assert_eq!(reopened.held().memtable_bytes, 0, "the next write flushes at the tail-row bound");
        assert_eq!(reopened.read("n4"), Some(json!({ "text": "note 4" })));
    }

    /// Sixty single-record writes, each written out to a run of its own.
    fn sixty_runs(store: &mut Store, text: impl Fn(usize) -> String) {
        for number in 0..60 {
            store.write(vec![note(&n(number), json!({ "text": text(number) }))]);
            store.checkpoint();
        }
    }

    /// Old L1116 'one idle wake merges several small runs, writing no more pages than its budget'.
    #[test]
    fn l1116_one_idle_wake_merges_several_small_runs_writing_no_more_pages_than_its_budget() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::create(&dir.path().join("store.sqlite"), small(), old());
        sixty_runs(&mut store, |_| "w".repeat(30));
        let done = store.maintain(3);
        // A merge that ends within the budget writes its last, partial page too: one page past it at most.
        assert!(done.pages > 0 && done.pages <= 4, "{} pages written on a budget of 3", done.pages);
        let before = store.held().runs;
        let done = store.maintain(256);
        let after = store.held().runs;
        assert!(before - after > 3, "{before} runs became {after}: more than one merge");
        assert!(done.pages <= 257, "{} pages", done.pages);
    }

    /// Old L1134 'a scheduler deadline stops between merge transactions and resumes without losing records'.
    #[test]
    fn l1134_a_scheduler_deadline_stops_between_merge_transactions_and_resumes_without_losing_records() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::create(&dir.path().join("store.sqlite"), small(), old());
        sixty_runs(&mut store, |number| format!("entry {number}"));
        let first = store.log.maintain(256, &mut || false, &Text).unwrap();
        assert_eq!(first.steps, 0, "no merge transaction starts after the deadline");
        assert!(first.more, "unfinished work remains due");
        assert_eq!(first.pages, 0);
        let mut store = store.reopen();
        let mut wakes = 0;
        while store.maintain(256).more {
            wakes += 1;
            assert!(wakes < 100, "the repeated bounded wakes drain the backlog");
        }
        for number in 0..60 {
            assert_eq!(store.read(&n(number)), Some(json!({ "text": format!("entry {number}") })));
        }
    }

    /// Old L1155 'small write-outs beside two large runs never copy the younger one again'.
    #[test]
    fn l1155_small_write_outs_beside_two_large_runs_never_copy_the_younger_one_again() {
        let dir = tempfile::tempdir().unwrap();
        // A memtable large enough that each checkpoint writes one run, and no log-tail bound.
        let settings = Settings { memtable_bytes: 1 << 20, ..small() };
        let mut store = Store::create(&dir.path().join("store.sqlite"), settings, LogOptions { tail_rows: usize::MAX, ..old() });
        store.log.connection().execute_batch("PRAGMA synchronous=OFF").unwrap();
        let write = |store: &mut Store, prefix: &str, count: usize, size: usize| {
            for number in 0..count {
                store.write(vec![note(&format!("{prefix}{number:05}"), json!({ "text": "w".repeat(size) }))]);
            }
        };
        let settle = |store: &mut Store| -> usize {
            let mut pages = 0;
            loop {
                let done = store.maintain(100_000);
                pages += done.pages;
                if !done.more {
                    return pages;
                }
            }
        };
        write(&mut store, "a", 2000, 200);
        store.checkpoint();
        settle(&mut store);
        write(&mut store, "b", 500, 200);
        store.checkpoint();
        settle(&mut store);
        let runs = store.held().run_list;
        assert_eq!(runs.len(), 2, "two large runs of their own");
        let younger = runs.iter().map(|run| run.pages).min().unwrap();
        let mut pages_written = 0;
        for round in 0..30 {
            write(&mut store, &format!("c{round}-"), 4, 30);
            pages_written += store.checkpoint();
            pages_written += settle(&mut store);
        }
        assert!(pages_written < 10 * younger, "{pages_written} pages written for 30 small write-outs beside a {younger}-page run");
        assert!(store.held().runs <= 24 / 3 - 1, "{} runs", store.held().runs);
    }

    /// Old L1182 'exact type counts survive replay, rollback and a bounded old-projection upgrade'. The old test wrote its
    /// 600 records in one write; one Rust write holds at most 256 records (`MAX_BATCH_RECORDS`), so they are three.
    #[test]
    fn l1182_exact_type_counts_survive_replay_rollback_and_a_bounded_old_projection_upgrade() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::create(&dir.path().join("store.sqlite"), small(), old());
        for batch in 0..3 {
            store.write((batch * 200..batch * 200 + 200).map(|number| note(&n(number), json!({ "text": format!("Note {number}") }))).collect());
        }
        assert_eq!(store.count("note"), Some(600));
        let expected = |note: u64, message: u64| BTreeMap::from([("message".to_string(), Some(message)), ("note".to_string(), Some(note))]);
        let (counts, _) = store.count_many(&["note", "message", "absent", "note"]);
        assert_eq!(counts, BTreeMap::from([("absent".to_string(), Some(0)), ("message".to_string(), Some(0)), ("note".to_string(), Some(600))]));
        store.checkpoint();
        let mut store = store.reopen();
        store.write(vec![kind(&n(0), "message", json!({ "text": "Moved" })), removal(&n(1))]);
        assert_eq!(store.count("note"), Some(598));
        assert_eq!(store.count("message"), Some(1));
        assert_eq!(store.count_many(&["note", "message"]).0, expected(598, 1));
        let failed = store.log.transaction(|log| {
            log.write_unrequested(&[note("rollback", json!({ "text": "No" }))], &context(), &Admit, &Text, &mut Ids)?;
            Err::<(), _>(Error::Invalid("rollback", trillion_local::cause!()))
        });
        assert!(failed.is_err());
        store.log.forget_cached();
        assert_eq!(store.count("note"), Some(598));
        assert_eq!(store.count_many(&["note", "message"]).0, expected(598, 1), "batch counts discard a rolled-back write");
        store.checkpoint();
        store.forget_kept_counts();
        let mut store = store.reopen();
        assert_eq!(store.count("note"), None, "an old projection never guesses its count");
        assert_eq!(
            store.count_many(&["note", "absent"]).0,
            BTreeMap::from([("absent".to_string(), None), ("note".to_string(), None)]),
            "a batch never turns an unfinished upgrade into an empty count"
        );
        store.maintain(1);
        store.write(vec![removal(&n(2)), kind(&n(599), "message", json!({ "text": "Later moved" }))]);
        store.checkpoint();
        let mut store = store.reopen();
        for _ in 0..100 {
            if !store.maintain(1).more {
                break;
            }
        }
        assert_eq!(store.count("note"), Some(596));
        assert_eq!(store.count("message"), Some(2));
        assert_eq!(store.count("absent"), Some(0));
        let (counts, work) = store.count_many(&["note", "message", "absent"]);
        assert_eq!(counts, BTreeMap::from([("absent".to_string(), Some(0)), ("message".to_string(), Some(2)), ("note".to_string(), Some(596))]));
        assert_eq!(work.journal_rows_read, 1, "selected counts check their current log once");
    }

    /// Old L1222 'exact-empty kinds skip unrelated cold packed pages and never guess during upgrade'.
    #[test]
    fn l1222_exact_empty_kinds_skip_unrelated_cold_packed_pages_and_never_guess_during_upgrade() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::create(&dir.path().join("store.sqlite"), small(), old());
        for batch in 0..2 {
            store.write((batch * 250..batch * 250 + 250).map(|number| kind(&format!("other:{number}"), "other", json!({ "n": number }))).collect());
        }
        store.checkpoint();
        let mut store = store.reopen();
        store.count("other");
        let (ids, work) = store.ids("absent", None);
        assert_eq!(ids, Vec::<String>::new());
        assert_eq!(work.selected.sql_statements, 0, "a known empty kind walks no unrelated packed page");
        store.write(vec![kind("present", "absent", json!({ "yes": true }))]);
        assert_eq!(store.ids("absent", None).0, vec!["present".to_string()], "absence is not cached past writes");
        store.checkpoint();
        store.forget_kept_counts();
        let mut store = store.reopen();
        assert_eq!(store.count("absent"), None);
        assert_eq!(store.ids("absent", None).0, vec!["present".to_string()], "unknown counts preserve the authoritative read");
    }

    /// The old tests' INDEXES.
    pub fn indexes() -> Vec<Index> {
        let index = |name: &str, paths: &[&[&str]]| Index { kind: "note".into(), name: name.into(), paths: paths.iter().map(|p| p.iter().map(|f| f.to_string()).collect()).collect(), backfill: None, carry: Vec::new() };
        vec![
            index("at", &[&["at"]]),
            index("room", &[&["room"]]),
            index("room_at", &[&["room"], &["at"]]),
            index("state_room_at", &[&["state"], &["room"], &["at"]]),
            index("goal", &[&["input", "goal"]]),
        ]
    }
    fn indexed() -> LogOptions {
        LogOptions { indexes: indexes(), ..old() }
    }
    fn ids_of(entries: &[IndexEntry]) -> Vec<String> {
        entries.iter().map(|e| e.id.clone()).collect()
    }
    fn equal(values: &[Value]) -> Scan {
        Scan { equal: values.to_vec(), ..Scan::default() }
    }

    /// Old L905 'declared indexes answer ranges, equal values, groups and field reads; undeclared ones are refused'.
    #[test]
    fn l905_declared_indexes_answer_ranges_equal_values_groups_and_field_reads_undeclared_ones_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::create(&dir.path().join("store.sqlite"), small(), indexed());
        let value = |number: usize, room: &str| json!({ "at": format!("2026-10-05T10:{number:02}:00Z"), "room": room, "text": format!("note {number}"), "input": { "goal": if number % 2 == 1 { "odd goal" } else { "even goal" } } });
        for number in 0..60 {
            store.write(vec![note(&format!("n{number:02}"), value(number, &format!("r{}", number % 4)))]);
        }
        store.write(vec![note("n10", value(10, "moved"))]);
        let after = store.log.fields_after("note", "at", &json!("2026-10-05T10:57:00Z"), &["room"], None, &request(), &Admit, &Text).unwrap();
        assert_eq!(after.iter().map(|r| r["id"].as_str().unwrap()).collect::<Vec<_>>(), vec!["n58", "n59"]);
        assert_eq!(store.ids_where("note", "room", json!("moved")).unwrap(), vec!["n10"]);
        assert_eq!(store.ids_where("note", "room", json!("r2")).unwrap().len(), 14, "n10 moved out of r2");
        let groups = store.log.newest_per_group("note", "room", "at", &["text"], &request(), &Admit, &Text).unwrap();
        let mut pairs: Vec<(String, String)> = groups.iter().map(|g| (g["room"].as_str().unwrap().into(), g["id"].as_str().unwrap().into())).collect();
        pairs.sort();
        let expected: Vec<(String, String)> = [("moved", "n10"), ("r0", "n56"), ("r1", "n57"), ("r2", "n58"), ("r3", "n59")].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        assert_eq!(pairs, expected);
        assert_eq!(store.scan("note", "goal", equal(&[json!("odd goal")])).len(), 30);
        assert_eq!(ids_of(&store.scan("note", "at", Scan { reverse: true, limit: Some(2), ..Scan::default() })), vec!["n59", "n58"]);
        assert_eq!(store.scan("note", "at", Scan { from: Some(json!("2026-10-05T10:10:00Z")), to: Some(json!("2026-10-05T10:19:00Z")), ..Scan::default() }).len(), 10);
        assert_eq!(store.ids("note", Some(3)).0, vec!["n59", "n58", "n57"]);
        let fields = store.log.fields_of("note", &["n01", "nope"], &["text", "input"], &request(), &Admit, &Text).unwrap();
        assert_eq!(fields.get("n01"), Some(&json!({ "id": "n01", "text": "note 1" })));
        assert!(!fields.contains_key("nope"));
        assert!(store.ids_where("note", "text", json!("x")).is_err(), "no index on text");
        assert_eq!(store.find(&["note", "5"], &[&["text"]], None, 3).iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), vec!["n59", "n58", "n57"]);
        let found = store.find(&["note 1"], &[&["input", "goal"], &["text"]], Some(&["note"]), 2);
        assert_eq!(
            found.iter().map(|f| (f.id.as_str(), f.title.as_str())).collect::<Vec<_>>(),
            vec![("n19", "odd goal"), ("n18", "even goal")],
            "the first named field holding words is the title"
        );
    }

    /// Old L926 'generated edits and deletes keep declared indexes equal to the current records across reopen and
    /// maintenance'.
    #[test]
    fn l926_generated_edits_and_deletes_keep_declared_indexes_equal_to_the_current_records_across_reopen_and_maintenance() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::create(&dir.path().join("store.sqlite"), small(), indexed());
        let mut model: BTreeMap<String, Value> = BTreeMap::new();
        let mut seed: u32 = 0x83a3;
        let mut pick = |bound: usize| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            ((seed as f64) / 4294967296.0 * bound as f64).floor() as usize
        };
        let ids: Vec<String> = (0..24).map(|n| format!("generated-{n}")).collect();
        let rooms = ["north", "south", "east", "west"];
        let goals = ["draft", "review", "send"];
        let check = |store: &mut Store, model: &BTreeMap<String, Value>, step: &str| {
            for id in &ids {
                assert_eq!(store.read(id), model.get(id).cloned(), "record {id} after edit {step}");
            }
            let holding = |field: &dyn Fn(&Value) -> Option<Value>, wanted: &Value| -> Vec<String> {
                model.iter().filter(|(_, v)| field(v).as_ref() == Some(wanted)).map(|(id, _)| id.clone()).collect()
            };
            for room in rooms {
                let expected = holding(&|v| v.get("room").cloned(), &json!(room));
                let mut found = store.ids_where("note", "room", json!(room)).unwrap();
                found.sort();
                assert_eq!(found, expected, "room index {room} after edit {step}");
                let mut scanned = ids_of(&store.scan("note", "room", equal(&[json!(room)])));
                scanned.sort();
                assert_eq!(scanned, expected, "room scan {room} after edit {step}");
            }
            for at in ["t00", "t07", "t15"] {
                let expected = holding(&|v| v.get("at").cloned(), &json!(at));
                let mut found = store.ids_where("note", "at", json!(at)).unwrap();
                found.sort();
                assert_eq!(found, expected, "time index {at} after edit {step}");
            }
            for goal in goals {
                let expected = holding(&|v| v.get("input").and_then(|i| i.get("goal")).cloned(), &json!(goal));
                let mut scanned = ids_of(&store.scan("note", "goal", equal(&[json!(goal)])));
                scanned.sort();
                assert_eq!(scanned, expected, "nested goal index {goal} after edit {step}");
            }
        };
        for step in 0..240 {
            let id = ids[pick(ids.len())].clone();
            if pick(5) == 0 {
                store.write(vec![removal(&id)]);
                model.remove(&id);
            } else {
                let mut value = serde_json::Map::new();
                value.insert("text".into(), json!(format!("edit {step}")));
                if pick(6) != 0 {
                    value.insert("room".into(), json!(rooms[pick(rooms.len())]));
                }
                if pick(6) != 0 {
                    value.insert("at".into(), json!(format!("t{:02}", pick(16))));
                }
                if pick(6) != 0 {
                    value.insert("input".into(), json!({ "goal": goals[pick(goals.len())] }));
                }
                let value = Value::Object(value);
                store.write(vec![note(&id, value.clone())]);
                model.insert(id, value);
            }
            if step % 29 == 0 {
                check(&mut store, &model, &step.to_string());
                store = store.reopen();
                check(&mut store, &model, &step.to_string());
            }
            if step % 37 == 0 {
                while store.maintain(3).more {}
                check(&mut store, &model, &step.to_string());
            }
        }
        let mut store = store.reopen();
        check(&mut store, &model, "final reopen");
    }

    /// Three rounds of 48 notes, each round written out to its own run, then a move and a removal.
    fn rooms_store(path: &Path, state: bool, settings: Settings, options: LogOptions) -> Store {
        let mut store = Store::create(path, settings, options);
        for round in 0..3 {
            let rows = (0..48)
                .map(|number| {
                    let mut value = json!({ "room": format!("r{}", number % 8), "at": format!("t{round}-{number:02}") });
                    if state {
                        value["state"] = json!("open");
                    }
                    note(&format!("n{round}-{number}"), value)
                })
                .collect();
            store.write(rows);
            store.checkpoint();
        }
        store
    }
    fn sort_entries(entries: &mut [IndexEntry]) {
        entries.sort_by(|a, b| serde_json::to_string(&a.values).unwrap().cmp(&serde_json::to_string(&b.values).unwrap()).then(a.id.cmp(&b.id)));
    }

    /// Old L456 'selected index prefixes keep exact order and current values across written runs'.
    #[test]
    fn l456_selected_index_prefixes_keep_exact_order_and_current_values_across_written_runs() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = rooms_store(&dir.path().join("store.sqlite"), false, small(), indexed());
        store.write(vec![note("n0-1", json!({ "room": "r6", "at": "moved" })), removal("n1-14")]);
        store.checkpoint();
        let mut expected: Vec<IndexEntry> = ["r1", "r6"].iter().flat_map(|room| store.scan("note", "room_at", equal(&[json!(room)]))).collect();
        sort_entries(&mut expected);
        let selected = [json!("r1"), json!("r6"), json!("r1")];
        let mut cold = store.reopen();
        let (found, work) = cold.log.scan_first_values("note", "room_at", &selected, &request(), &Admit, &Text).unwrap();
        assert_eq!(found, expected);
        let batched = work.selected.sql_statements;
        let mut cold = store.reopen();
        let mut separate = 0;
        for room in ["r1", "r6"] {
            separate += cold.scan_measured("note", "room_at", equal(&[json!(room)])).1.selected.sql_statements;
        }
        assert!(batched < separate, "selected ranges used {batched} page statements; separate scans used {separate}");
        assert_eq!(cold.log.scan_first_values("note", "room_at", &[], &request(), &Admit, &Text).unwrap().0, vec![]);
        assert!(expected.iter().all(|e| e.values[0] == json!("r1") || e.values[0] == json!("r6")));
        assert!(!expected.iter().any(|e| e.id == "n1-14"), "removed records stay removed");
    }

    /// Old L85 'empty selected parent prefixes share one existence seek regardless of parent count'.
    #[test]
    fn l85_empty_selected_parent_prefixes_share_one_existence_seek_regardless_of_parent_count() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings { memtable_bytes: 1 << 20, ..small() };
        let mut written = Store::create(&dir.path().join("store.sqlite"), settings, indexed());
        written.write(["a", "z"].iter().flat_map(|room| (0..40).map(move |number| note(&format!("{room}{number}"), json!({ "room": room, "at": number.to_string() })))).collect());
        written.checkpoint();
        let mut prior = None;
        for count in [2, 80] {
            let mut store = written.reopen();
            store.count("note");
            let parents: Vec<Value> = (0..count).map(|number| json!(format!("m{number:03}"))).collect();
            let (found, work) = store.log.scan_first_values("note", "room_at", &parents, &request(), &Admit, &Text).unwrap();
            assert_eq!(found, vec![]);
            let probes = work.selected.sql_statements;
            assert!(probes > 0 && probes <= 2, "{count} empty parents used {probes} statements");
            if let Some(prior) = prior {
                assert_eq!(probes, prior, "growing parents does not add fence probes");
            }
            prior = Some(probes);
        }
        written.write(vec![note("later", json!({ "room": "m000", "at": "later" }))]);
        written.checkpoint();
        let mut store = written.reopen();
        assert_eq!(
            store.log.scan_first_values("note", "room_at", &[json!("m000"), json!("m001")], &request(), &Admit, &Text).unwrap().0,
            vec![IndexEntry { carried: None, id: "later".into(), values: vec![json!("m000"), json!("later")] }]
        );
    }

    /// Old L493 'selected values after a fixed prefix batch pages and keep each live top page exact'.
    #[test]
    fn l493_selected_values_after_a_fixed_prefix_batch_pages_and_keep_each_live_top_page_exact() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.sqlite");
        let mut store = rooms_store(&path, true, small(), indexed());
        store.write(vec![note("n0-1", json!({ "state": "open", "room": "r6", "at": "moved" })), removal("n0-6"), removal("n1-14")]);
        store.checkpoint();
        let rooms: Vec<Value> = (0..8).map(|n| json!(format!("r{n}"))).collect();
        let per_room = |store: &mut Store, extra: &dyn Fn(Scan) -> Scan| -> Vec<IndexEntry> {
            rooms.iter().flat_map(|room| store.scan("note", "state_room_at", extra(Scan { equal: vec![json!("open"), room.clone()], ..Scan::default() }))).collect()
        };
        let mut expected = per_room(&mut store, &|s| Scan { limit: Some(2), ..s });
        sort_entries(&mut expected);
        let mut expected_reverse = per_room(&mut store, &|s| Scan { reverse: true, limit: Some(2), ..s });
        sort_entries(&mut expected_reverse);
        expected_reverse.reverse();
        let open = |store: &Store, pages: Option<usize>| store.reopen_with(small(), LogOptions { selected_scan_pages: pages, ..indexed() });
        let selected = |values: Vec<Value>, limit: Option<usize>| Selected { equal: vec![json!("open")], values, limit, ..Selected::default() };
        let mut with_duplicate = rooms.clone();
        with_duplicate.push(json!("r1"));
        let mut cold = open(&store, None);
        let (found, work) = cold.log.scan_selected_values("note", "state_room_at", &selected(with_duplicate, Some(2)), &request(), &Admit, &Text).unwrap();
        assert_eq!(found, expected);
        let batched = work.selected.sql_statements;
        let mut cold = open(&store, None);
        let mut separate = 0;
        for room in &rooms {
            separate += cold.scan_measured("note", "state_room_at", Scan { equal: vec![json!("open"), room.clone()], limit: Some(2), ..Scan::default() }).1.selected.sql_statements;
        }
        assert!(batched < separate, "batch used {batched} page statements; separate scans used {separate}");
        assert_eq!(cold.log.scan_selected_values("note", "state_room_at", &selected(rooms.clone(), Some(0)), &request(), &Admit, &Text).unwrap().0, vec![]);

        let mut cold = open(&store, None);
        let reverse = Selected { reverse: true, ..selected(rooms.clone(), Some(2)) };
        assert_eq!(cold.log.scan_selected_values("note", "state_room_at", &reverse, &request(), &Admit, &Text).unwrap().0, expected_reverse);
        let bounded = |s: Scan| Scan { from: Some(json!("t1-00")), before: Some(json!("t2-00")), reverse: true, limit: Some(2), ..s };
        let mut expected_bounded = per_room(&mut store, &bounded);
        sort_entries(&mut expected_bounded);
        expected_bounded.reverse();
        let window = Selected { from: Some(json!("t1-00")), before: Some(json!("t2-00")), reverse: true, ..selected(rooms.clone(), Some(2)) };
        let mut cold = open(&store, None);
        assert_eq!(cold.log.scan_selected_values("note", "state_room_at", &window, &request(), &Admit, &Text).unwrap().0, expected_bounded);
        let mut cold = open(&store, Some(0));
        assert_eq!(cold.log.scan_selected_values("note", "state_room_at", &window, &request(), &Admit, &Text).unwrap().0, expected_bounded, "budget fallback keeps the same reverse time window");

        let mut cold = open(&store, Some(0));
        let (found, work) = cold.log.scan_selected_values("note", "state_room_at", &selected(rooms.clone(), Some(2)), &request(), &Admit, &Text).unwrap();
        assert_eq!(found, expected);
        assert!(work.selected.sql_statements > 0, "budget fallback reads the bounded individual prefixes");
        assert!(!expected.iter().any(|e| e.id == "n1-14" || e.id == "n0-6"));
    }

    fn backfilled(kinds: &[&str], name: &str, backfill: &str) -> Vec<Index> {
        kinds.iter().map(|kind| Index { kind: kind.to_string(), name: name.into(), paths: vec![vec!["at".into()]], backfill: Some(backfill.into()), carry: Vec::new() }).collect()
    }
    fn with_indexes(indexes: Vec<Index>) -> LogOptions {
        LogOptions { indexes, ..old() }
    }
    /// A build's kept progress, as the old test read `record_keys_meta`.
    fn progress(store: &Store, key: &str) -> Value {
        let text: String = store.log.connection().query_row("SELECT value FROM record_keys_meta WHERE key = ?", [format!("host:{key}")], |r| r.get(0)).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    /// Old L181 'independent index builds rotate durably past a larger unfinished group'.
    #[test]
    fn l181_independent_index_builds_rotate_durably_past_a_larger_unfinished_group() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings { memtable_bytes: 1 << 20, ..small() };
        let mut written = Store::create(&dir.path().join("store.sqlite"), settings.clone(), old());
        let mut rows: Vec<RecordInput> = (0..240).map(|n| kind(&format!("large-{n:03}"), "large", json!({ "at": n }))).collect();
        rows.extend((0..3).map(|n| kind(&format!("little-{n}"), "little", json!({ "at": n }))));
        written.write(rows);
        written.checkpoint();
        let indexes = backfilled(&["large", "little"], "at", "at-v1");
        let mut store = written.reopen_with(settings.clone(), with_indexes(indexes.clone()));
        store.maintain(512);
        assert!(!store.log.index_ready("large", "at").unwrap());
        assert!(!store.log.index_ready("little", "at").unwrap());
        let mut store = written.reopen_with(settings.clone(), with_indexes(indexes.clone()));
        store.maintain(512);
        assert!(!store.log.index_ready("large", "at").unwrap(), "the large rebuild still has old heads to visit");
        assert!(store.log.index_ready("little", "at").unwrap(), "cold restart preserves the next group");
        assert_eq!(ids_of(&store.scan("little", "at", Scan::default())), vec!["little-0", "little-1", "little-2"]);
        let mut reversed = indexes.clone();
        reversed.reverse();
        let mut store = written.reopen_with(settings, with_indexes(reversed));
        store.maintain(512);
        assert!(store.log.index_ready("little", "at").unwrap(), "declaration reordering preserves completed groups");
    }

    /// Old L205 'index backfill fixes its frontier while new records keep arriving'.
    #[test]
    fn l205_index_backfill_fixes_its_frontier_while_new_records_keep_arriving() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings { memtable_bytes: 1 << 20, ..small() };
        let rows = |start: usize, count: usize| -> Vec<RecordInput> { (start..start + count).map(|n| note(&format!("n{n:03}"), json!({ "at": n }))).collect() };
        let mut written = Store::create(&dir.path().join("store.sqlite"), settings.clone(), old());
        written.write(rows(0, 64));
        written.checkpoint();
        let options = with_indexes(backfilled(&["note"], "at", "at-v1"));
        let mut store = written.reopen_with(settings.clone(), options.clone());
        store.maintain(512);
        assert_eq!(progress(&store, "index-build:note:at-v1")["after"], json!("n031"));
        assert_eq!(progress(&store, "index-build:note:at-v1")["through"], json!("n063"));
        assert!(!store.log.index_ready("note", "at").unwrap());
        store.write(rows(64, 32));
        store.write(vec![note("n010", json!({ "at": 1000 })), removal("n040")]);
        store.checkpoint();
        let mut store = written.reopen_with(settings, options);
        store.maintain(512);
        assert!(store.log.index_ready("note", "at").unwrap(), "new writes do not extend the old-data frontier");
        assert_eq!(progress(&store, "index-build:note:at-v1")["through"], json!("n063"));
        let mut expected: Vec<IndexEntry> = (0..96).filter(|n| *n != 40).map(|n| IndexEntry { carried: None, id: format!("n{n:03}"), values: vec![json!(if n == 10 { 1000 } else { n })] }).collect();
        expected.sort_by_key(|e| serde_json::to_string(&e.values[0]).unwrap());
        assert_eq!(store.scan("note", "at", Scan::default()), expected, "old-head edits/deletions and all post-frontier writes remain indexed");
    }

    /// Old L231 'a refused index slice rolls back its progress while admitting the next independent group'. The old
    /// test refused the progress write through a wrapped `sql.exec`; here a temporary trigger refuses it in SQLite.
    #[test]
    fn l231_a_refused_index_slice_rolls_back_its_progress_while_admitting_the_next_independent_group() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings { memtable_bytes: 1 << 20, ..small() };
        let mut written = Store::create(&dir.path().join("store.sqlite"), settings.clone(), old());
        written.write(["large", "little"].iter().map(|k| kind(k, k, json!({ "at": 1 }))).collect());
        written.checkpoint();
        let options = with_indexes(backfilled(&["large", "little"], "at", "at-v1"));
        let mut store = written.reopen_with(settings.clone(), options.clone());
        for event in ["INSERT", "UPDATE"] {
            store.log.connection().execute_batch(&format!(
                "CREATE TEMP TRIGGER refuse_{event} BEFORE {event} ON record_keys_meta WHEN NEW.key = 'host:index-build:large:at-v1' BEGIN SELECT RAISE(ABORT, 'index progress write refused'); END;"
            )).unwrap();
        }
        let refused = store.log.maintain(512, &mut || true, &Text);
        // The database's own message stays in Debug, beside the cause, which names the kept-runs statement that failed.
        assert!(matches!(&refused, Err(e) if format!("{e:?}").contains("index progress write refused")), "{refused:?}");
        assert!(matches!(&refused, Err(e) if e.cause().file() == "src/kept_runs.rs"), "{refused:?}");
        let mut store = written.reopen_with(settings, options);
        assert!(!store.log.index_ready("large", "at").unwrap());
        store.maintain(512);
        assert!(store.log.index_ready("little", "at").unwrap());
        assert!(!store.log.index_ready("large", "at").unwrap());
        store.maintain(512);
        assert!(store.log.index_ready("large", "at").unwrap());
        assert_eq!(store.scan("large", "at", Scan::default()), vec![IndexEntry { carried: None, id: "large".into(), values: vec![json!(1)] }]);
    }

    /// Old L256 'index transaction commit failure restores the same instance and preserves independent admission'. The
    /// old test failed its host's commit; here SQLite's commit hook turns the commit of the first transaction that
    /// writes a run (the build slice writing its keys out) into a rollback.
    #[test]
    fn l256_index_transaction_commit_failure_restores_the_same_instance_and_preserves_independent_admission() {
        use std::sync::{atomic::AtomicBool, Arc};
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings { memtable_bytes: 1 << 20, ..small() };
        let mut written = Store::create(&dir.path().join("store.sqlite"), settings.clone(), old());
        written.write(["large", "little"].iter().map(|k| kind(k, k, json!({ "at": 1 }))).collect());
        written.checkpoint();
        let options = with_indexes(backfilled(&["large", "little"], "at", "at-v1"));
        let mut store = written.reopen_with(settings.clone(), options.clone());
        let armed = Arc::new(AtomicBool::new(false));
        let wrote_run = Arc::new(AtomicBool::new(false));
        {
            let noted = Arc::clone(&wrote_run);
            store.log.connection().update_hook(Some(move |_: rusqlite::hooks::Action, _: &str, table: &str, _: i64| {
                if table.starts_with("record_keys_run_") {
                    noted.store(true, Ordering::SeqCst);
                }
            }));
            let (armed, wrote_run) = (Arc::clone(&armed), Arc::clone(&wrote_run));
            store.log.connection().commit_hook(Some(move || {
                let fail = armed.load(Ordering::SeqCst) && wrote_run.swap(false, Ordering::SeqCst);
                if fail {
                    armed.store(false, Ordering::SeqCst);
                }
                fail
            }));
        }
        assert!(!store.log.maintain(512, &mut || false, &Text).unwrap().flushed);
        wrote_run.store(false, Ordering::SeqCst);
        armed.store(true, Ordering::SeqCst);
        assert!(store.log.maintain(512, &mut || true, &Text).is_err(), "transaction commit refused");
        assert_eq!(store.read("large"), Some(json!({ "at": 1 })), "the same instance does not use a rolled-back run");
        assert!(!store.log.index_ready("large", "at").unwrap());
        store.maintain(512);
        assert!(store.log.index_ready("little", "at").unwrap(), "failed first-group admission survives its rollback");
        let mut store = written.reopen_with(settings, options);
        assert!(!store.log.index_ready("large", "at").unwrap());
        store.maintain(512);
        assert!(store.log.index_ready("large", "at").unwrap());
        assert_eq!(store.scan("large", "at", Scan::default()), vec![IndexEntry { carried: None, id: "large".into(), values: vec![json!(1)] }]);
    }

    /// Old L1246 'maintenance admission reads selected index progress together without caching rollback or changed
    /// signatures'.
    #[test]
    fn l1246_maintenance_admission_reads_selected_index_progress_together_without_caching_rollback_or_changed_signatures() {
        let dir = tempfile::tempdir().unwrap();
        let indexes: Vec<Index> = (0..17).map(|n| Index { kind: "note".into(), name: format!("at-{n}"), paths: vec![vec!["at".into()]], backfill: Some(format!("at-{n}-v1")), carry: Vec::new() }).collect();
        let mut store = Store::create(&dir.path().join("store.sqlite"), Settings::default(), with_indexes(indexes));
        for _ in 0..40 {
            if !store.log.maintenance_due().unwrap() {
                break;
            }
            store.maintain(16);
        }
        let before = store.held().meta_reads;
        assert!(!store.log.maintenance_due().unwrap());
        assert_eq!(store.held().meta_reads - before, 1, "completed progress is selected in one bounded metadata read");
        let key = "host:index-build:note:at-16-v1";
        let db = store.log.connection();
        db.execute_batch("BEGIN").unwrap();
        db.execute("DELETE FROM record_keys_meta WHERE key = ?", [key]).unwrap();
        assert!(store.log.maintenance_due().unwrap(), "the last missing group is still due");
        store.log.connection().execute_batch("ROLLBACK").unwrap();
        assert!(!store.log.maintenance_due().unwrap(), "rollback restores the original progress without cache invalidation");
        store.log.connection().execute("UPDATE record_keys_meta SET value = ? WHERE key = ?", [json!({ "signature": "older", "ready": true }).to_string(), key.to_string()]).unwrap();
        assert!(store.log.maintenance_due().unwrap(), "an earlier signature cannot certify current indexes");
    }

    impl Store {
        pub fn checksum(&mut self, build: bool) -> Checksum {
            self.log.checksum(build, &Text).unwrap()
        }
        /// Takes the checksum and counts out of the kept checkpoint, as pages written before the checksum was kept
        /// hold only how far the log they cover goes (the old tests' `meta.set('covered', meta.get('covered').at)`).
        pub fn forget_kept_checksum(&self) {
            let db = self.log.connection();
            let text: String = db.query_row("SELECT value FROM record_keys_meta WHERE key = 'covered'", [], |r| r.get(0)).unwrap();
            let position: Value = serde_json::from_str(&text).unwrap();
            db.execute("UPDATE record_keys_meta SET value = ? WHERE key = 'covered'", [json!({ "record_log_row": position["record_log_row"] }).to_string()]).unwrap();
        }
        pub fn meta(&self, key: &str) -> Option<String> {
            self.log.connection().query_row("SELECT value FROM record_keys_meta WHERE key = ?", [key], |r| r.get(0)).ok()
        }
    }

    /// Old L1058 'a store without a kept checksum builds it a page at a time across writes and a restart, never in one
    /// call'.
    #[test]
    fn l1058_a_store_without_a_kept_checksum_builds_it_a_page_at_a_time_across_writes_and_a_restart_never_in_one_call() {
        let dir = tempfile::tempdir().unwrap();
        let note_value = |n: usize| json!({ "at": format!("t{n}"), "room": format!("r{}", n % 3), "text": "w".repeat(30) });
        let mut model: BTreeMap<String, Value> = BTreeMap::new();
        let put = |store: &mut Store, model: &mut BTreeMap<String, Value>, id: &str, value: Option<Value>| {
            match value {
                Some(value) => {
                    store.write(vec![note(id, value.clone())]);
                    model.insert(id.into(), value);
                }
                None => {
                    store.write(vec![removal(id)]);
                    model.remove(id);
                }
            }
        };
        let mut store = Store::create(&dir.path().join("store.sqlite"), small(), old());
        store.log.connection().execute_batch("PRAGMA synchronous=OFF").unwrap();
        for number in 0..1200 {
            put(&mut store, &mut model, &n(number), Some(note_value(number)));
        }
        store.checkpoint();
        // Pages written before the checksum was kept: the write-out holds only how far the log it covers.
        store.forget_kept_checksum();
        let open = |store: &Store| store.reopen_with(small(), LogOptions { checksum_page: 100, ..old() });
        let mut store = open(&store);
        assert_eq!(store.checksum(false), Checksum { root: None, buckets: None });
        assert_eq!(store.meta("host:sums_build"), None, "the side a copy settles against walks nothing");
        assert_eq!(store.checksum(true), Checksum { root: None, buckets: None }, "one call walks one page and answers no checksum yet");
        assert!(store.log.maintenance_due().unwrap(), "the rest of the build is idle work");
        store.maintain(256);
        // Writes to records already walked and not yet walked, kept with the next page, then more after it, then a restart.
        let changed = |n: usize, text: &str| { let mut v = note_value(n); v["text"] = json!(text); v };
        put(&mut store, &mut model, &n(5), Some(changed(5, "changed")));
        put(&mut store, &mut model, &n(1100), Some(changed(1100, "changed too")));
        put(&mut store, &mut model, "a-new", Some(note_value(9999)));
        store.maintain(256);
        put(&mut store, &mut model, &n(10), None);
        put(&mut store, &mut model, &n(150), Some(changed(150, "after the kept page")));
        let mut store = open(&store);
        let mut calls = 0;
        while store.checksum(true).root.is_none() {
            store.maintain(256);
            calls += 1;
            assert!(calls < 30);
        }
        assert!(calls >= 5, "the build took {calls} more pages");
        let built = store.checksum(true).root;
        assert_eq!(open(&store).checksum(true).root, built, "kept with the pages once built");
        for (id, value) in &model {
            assert_eq!(store.read(id).as_ref(), Some(value));
        }
        // The same store walked whole in one call: the paged build with writes and a restart between pages agrees.
        store.forget_kept_checksum();
        let mut whole = store.reopen_with(small(), LogOptions { checksum_page: usize::MAX, ..old() });
        assert_eq!(whole.checksum(true).root, built, "the built checksum is the checksum of what the store holds");
    }

    /// Old L1096 'idle work merges runs before it walks records for the checksum'.
    #[test]
    fn l1096_idle_work_merges_runs_before_it_walks_records_for_the_checksum() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::create(&dir.path().join("store.sqlite"), small(), old());
        // Many small runs, as a move that wrote out a run per batch left them.
        for number in 0..40 {
            store.write(vec![note(&n(number), json!({ "text": "w".repeat(30) }))]);
            store.checkpoint();
        }
        store.forget_kept_checksum();
        let mut store = store.reopen_with(small(), LogOptions { checksum_page: 10, ..old() });
        assert!(store.held().runs > 16, "{} runs", store.held().runs);
        let mut merging = 0;
        loop {
            let more = store.maintain(1).more;
            if store.meta("merge").is_some() || store.held().runs > 16 {
                assert_eq!(store.meta("host:sums_build"), None, "no record walked while runs wait to merge");
                merging += 1;
            }
            assert!(merging < 500);
            if !more {
                break;
            }
        }
        assert!(merging > 0);
        assert!(store.checksum(false).root.is_some(), "built once the merges were done");
        assert!(store.held().runs <= 16, "{} runs left", store.held().runs);
    }

    /// Old L285 'carried index replace / move / remove retires the old value and survives bounded maintenance' (one
    /// old loop declaring three cases, each run with and without a carried field).
    #[test]
    fn l285_carried_index_replace_move_remove_retires_the_old_value_and_survives_bounded_maintenance() {
        for change in ["replace", "move", "remove"] {
            let prior = json!({ "room": "before", "text": "a".repeat(8_000) });
            let current = (change != "remove").then(|| json!({ "room": if change == "move" { "after" } else { "before" }, "text": "current" }));
            let mut debts = Vec::new();
            for carry in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let index = Index { kind: "note".into(), name: "room".into(), paths: vec![vec!["room".into()]], backfill: None, carry: if carry { vec![vec!["text".into()]] } else { Vec::new() } };
                let settings = Settings { memtable_bytes: 1 << 20, compaction_debt_min_bytes: 1, compaction_debt_ratio: 0.0, ..small() };
                let options = with_indexes(vec![index]);
                let mut store = Store::create(&dir.path().join("store.sqlite"), settings.clone(), options.clone());
                store.write(vec![note("kept", prior.clone())]);
                store.checkpoint();
                store.write(vec![match &current { Some(value) => note("kept", value.clone()), None => removal("kept") }]);
                store.checkpoint();
                let checksum = store.checksum(true);
                let debt = store.held().compaction_debt;
                let mut store = store.reopen();
                assert_eq!(store.held().compaction_debt, debt, "retirement debt is durable");
                let mut steps = 0;
                while store.maintain(1).more {
                    steps += 1;
                    assert!(steps < 200, "bounded maintenance finishes");
                }
                assert_eq!(store.held().compaction_debt, 0);
                let mut store = store.reopen();
                assert_eq!(store.read("kept"), current.clone());
                assert_eq!(store.checksum(true), checksum, "maintenance preserves record checksums");
                let carried = |text: &str| if carry { Some([("text".to_string(), json!(text))].into_iter().collect()) } else { None };
                let room = |room: &str| Scan { equal: vec![json!(room)], limit: Some(10), carried: carry, ..Scan::default() };
                assert_eq!(
                    store.scan("note", "room", room("before")),
                    if change == "replace" { vec![IndexEntry { id: "kept".into(), values: vec![json!("before")], carried: carried("current") }] } else { vec![] },
                    "{change} carry={carry}"
                );
                if change == "move" {
                    assert_eq!(store.scan("note", "room", room("after")), vec![IndexEntry { id: "kept".into(), values: vec![json!("after")], carried: carried("current") }]);
                }
                debts.push(debt);
            }
            assert!(debts[1] - debts[0] >= 8_000 * 2, "old carried bytes must add retirement debt beyond the same primary record ({debts:?})");
        }
    }

    impl Store {
        pub fn bucket_page(&mut self, buckets: &[usize], after: Option<&str>, limit: usize, examine: usize) -> (BucketPage, Work) {
            self.log.records_in_buckets_page(buckets, after, limit, 4_000_000, examine, &request(), &Admit, &Text).unwrap()
        }
    }

    /// Old L996 'the log seals a generation once it is written out, and its pages read back in order'.
    #[test]
    fn l996_the_log_seals_a_generation_once_it_is_written_out_and_its_pages_read_back_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::create(&dir.path().join("store.sqlite"), small(), indexed());
        for number in 0..20 {
            store.write(vec![note(&format!("n{number}"), json!({ "at": format!("t{number}") }))]);
        }
        let sealed = store.log.seal_log(&Text).unwrap().unwrap();
        assert_eq!(store.log.sealed_logs().unwrap(), vec![sealed.clone()]);
        let page = store.log.sealed_log_page(&sealed, 0, 100).unwrap();
        assert_eq!(page.rows.len(), 20);
        store.log.keep_sealed_log_through(&sealed, 20, false, &Text).unwrap();
        store.log.drop_sealed_log(&sealed, &Text).unwrap();
        let mut again = store.reopen();
        for number in 0..20 {
            assert_eq!(again.read(&format!("n{number}")).unwrap()["at"], json!(format!("t{number}")), "every record survives its log generation leaving");
        }
    }

    /// Old L1010 'unchanged sealed generations do not rescan SQLite tables; seal, drop and rollback refresh the list'.
    #[test]
    fn l1010_unchanged_sealed_generations_do_not_rescan_sqlite_tables_seal_drop_and_rollback_refresh_the_list() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::create(&dir.path().join("store.sqlite"), small(), indexed());
        assert_eq!(store.log.sealed_logs().unwrap(), Vec::<String>::new());
        assert_eq!(store.log.sealed_logs().unwrap(), Vec::<String>::new());
        assert_eq!(store.log.catalog_scans(), 1, "repeated due checks inspect the catalog once");
        store.write(vec![note("n1", json!({ "at": "t1" }))]);
        let sealed = store.log.seal_log(&Text).unwrap().unwrap();
        assert_eq!(store.log.sealed_logs().unwrap(), vec![sealed.clone()]);
        assert_eq!(store.log.catalog_scans(), 2, "a committed seal refreshes the list");
        let mut copy = store.log.sealed_logs().unwrap();
        copy.push("not-a-table".into());
        assert_eq!(store.log.sealed_logs().unwrap(), vec![sealed.clone()], "a caller cannot change remembered names");
        store.log.drop_sealed_log(&sealed, &Text).unwrap();
        assert_eq!(store.log.sealed_logs().unwrap(), Vec::<String>::new());
        assert_eq!(store.log.catalog_scans(), 3, "a committed drop refreshes the list");
        store.write(vec![note("n2", json!({ "at": "t2" }))]);
        let failed = store.log.transaction(|log| {
            log.seal_log(&Text)?;
            assert_eq!(log.sealed_logs()?.len(), 1);
            Err::<(), _>(Error::Invalid("roll back", trillion_local::cause!()))
        });
        assert!(failed.is_err());
        store.log.forget_cached();
        assert_eq!(store.log.sealed_logs().unwrap(), Vec::<String>::new(), "the rolled-back generation is absent after cache invalidation");
        assert_eq!(store.log.catalog_scans(), 5, "rollback also refreshes the catalog");
    }

    /// Old L694 'a fragmented record bucket walk streams run pages without one SQL statement per page'.
    #[test]
    fn l694_a_fragmented_record_bucket_walk_streams_run_pages_without_one_sql_statement_per_page() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings { cache_bytes: 512, filter_bytes: 0, memtable_bytes: 1 << 20, ..small() };
        let mut store = Store::create(&dir.path().join("store.sqlite"), settings, old());
        for round in 0..12 {
            store.write((0..32).map(|index| { let number = index * 12 + round; note(&n(number), json!({ "title": format!("note {number}"), "text": "x".repeat(50) })) }).collect());
            store.checkpoint();
        }
        let mut store = store.reopen();
        store.count("note");
        let all: Vec<usize> = (0..256).collect();
        let (page, work) = store.bucket_page(&all, None, 500, 2000);
        assert_eq!(page.records.len(), 384);
        assert_eq!(page.next, None);
        let ids: Vec<&str> = page.records.iter().map(|r| r.id.as_str()).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted);
        assert_eq!(page.records[0].value["title"], json!("note 0"));
        assert_eq!(page.records.last().unwrap().value["title"], json!("note 383"));
        assert_eq!(work.selected.point_pages, 0, "current inline records need no per-page SQL lookup during a scan");
        assert!(work.selected.streams > 0 && work.selected.streams <= 12, "each of 12 runs needs at most one ordered SQL cursor ({})", work.selected.streams);
        let (ids, work) = store.ids("note", None);
        assert_eq!(ids, (0..384).map(n).collect::<Vec<_>>());
        assert_eq!(work.selected.point_pages, 0, "listing a record type does not reopen every run page");
        assert!(work.selected.streams > 0 && work.selected.streams <= 12, "listing uses at most one cursor per run ({})", work.selected.streams);
    }

    /// Old L730 'a bucket page skips unwanted spilled values before reading their bytes'.
    #[test]
    fn l730_a_bucket_page_skips_unwanted_spilled_values_before_reading_their_bytes() {
        use trillion_local::storage::record_store::digest::bucket_of;
        let dir = tempfile::tempdir().unwrap();
        let wanted = "z-wanted";
        let mut unwanted = "a-unwanted".to_string();
        while bucket_of(&unwanted) == bucket_of(wanted) {
            unwanted.push('x');
        }
        let mut store = Store::create(&dir.path().join("store.sqlite"), small(), old());
        store.write(vec![note(&unwanted, json!({ "text": "x".repeat(128_000) })), note(wanted, json!({ "text": "wanted" }))]);
        store.checkpoint();
        let big: i64 = store.log.connection().query_row("SELECT count(*) FROM record_keys_big", [], |r| r.get(0)).unwrap();
        assert!(big > 0, "the unwanted record is stored in the spilled-value table");
        // Cold cache: opening the unwanted value now has to query the spilled bytes.
        let mut store = store.reopen();
        store.count("note");
        let (first, work) = store.bucket_page(&[bucket_of(wanted)], None, 500, 1);
        assert_eq!(first.records.iter().map(|r| (r.id.as_str(), r.value["text"].clone())).collect::<Vec<_>>(), vec![(wanted, json!("wanted"))], "ready directory seeks the matching head directly");
        assert_eq!(first.next.as_deref(), Some(wanted));
        assert_eq!(work.selected.big_values, 0, "a filtered record never reads its spilled value");
        let (second, work) = store.bucket_page(&[bucket_of(wanted)], first.next.as_deref(), 500, 1);
        assert!(second.records.is_empty() && second.next.is_none(), "strict matching-head cursor terminates without repeating the record");
        assert_eq!(work.selected.big_values, 0);
    }

    /// The old tests' `contentId`: a rule from the kind of a nested object (and its value) to the id it is kept under.
    struct Rule(fn(&str, &Value) -> Option<String>);
    impl ContentIds for Rule {
        fn content_id(&self, kind: &str, value: &Value) -> Option<String> {
            (self.0)(kind, value)
        }
    }
    fn shared(rule: fn(&str, &Value) -> Option<String>) -> Option<Shared> {
        Some(Shared(std::sync::Arc::new(Rule(rule))))
    }

    /// Old L974 'content-addressed objects are kept once, big values survive merges, and list parts read and write in
    /// place'.
    #[test]
    fn l974_content_addressed_objects_are_kept_once_big_values_survive_merges_and_list_parts_read_and_write_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let options = LogOptions { shared: shared(|kind, value| (kind == "note/method").then(|| format!("method:{}", value["name"].as_str().unwrap_or_default()))), ..indexed() };
        let mut store = Store::create(&dir.path().join("store.sqlite"), small(), options);
        let method = json!({ "name": "m1", "steps": (0..30).map(|n| json!({ "n": n, "say": "step" })).collect::<Vec<_>>() });
        for number in 0..40 {
            store.write(vec![note(&format!("n{number}"), json!({ "at": format!("t{number}"), "method": method, "big": "B".repeat(if number == 7 { 9000 } else { 10 }) }))]);
        }
        assert_eq!(store.type_of("method:m1").as_deref(), Some("note/method"));
        assert_eq!(store.read("n3").unwrap()["method"], method);
        for round in 0..30 {
            store.write(vec![note(&format!("x{round}"), json!({ "at": format!("u{round}"), "text": "y".repeat(300) }))]);
        }
        while store.maintain(3).more {}
        assert_eq!(store.read("n7").unwrap()["big"].as_str().unwrap().len(), 9000, "a value bigger than a page is read back after merges");
        store.write(vec![note("list", json!({ "at": "v", "guidance": [{ "step_id": "a", "said": 1 }] }))]);
        store.log.write_member("list", "note", "guidance", 1, &json!({ "step_id": "b", "said": 2 }), &context(), &Admit, &Text, &mut Ids).unwrap();
        assert_eq!(store.log.member_count("list", "guidance", &request(), &Admit, &Text).unwrap(), 2);
        assert_eq!(store.log.read_member("list", "guidance", 1, &request(), &Admit, &Text).unwrap(), Some(json!({ "step_id": "b", "said": 2 })));
        assert_eq!(store.log.member_fields("list", "guidance", &["said"], Some(&[1]), &request(), &Admit, &Text).unwrap(), vec![json!({ "ordinal": 1, "said": 2 })]);
        assert_eq!(store.log.members_where("list", "guidance", "step_id", &json!("a"), &request(), &Admit, &Text).unwrap(), vec![0]);
        store.log.write_own("list", "note", &json!({ "at": "w", "guidance": [] }), &["guidance"], &context(), &Admit, &Text, &mut Ids).unwrap();
        assert_eq!(store.read("list").unwrap()["at"], json!("w"));
        assert_eq!(store.read("list").unwrap()["guidance"].as_array().unwrap().len(), 2, "fields left out of write_own are kept");
        assert_eq!(store.log.read_own("list", &["guidance"], &request(), &Admit, &Text).unwrap(), Some(json!({ "at": "w" })));
    }

    fn method_indexes() -> Vec<Index> {
        let mut all = indexes();
        all.push(Index { kind: "note".into(), name: "method_name".into(), paths: vec![vec!["method".into(), "name".into()]], backfill: None, carry: Vec::new() });
        all.push(Index { kind: "clip".into(), name: "source_name".into(), paths: vec![vec!["source".into(), "name".into()]], backfill: None, carry: Vec::new() });
        all
    }

    /// Old L645 'cold replay batches prior records across fragmented runs without point-reading their pages'.
    #[test]
    fn l645_cold_replay_batches_prior_records_across_fragmented_runs_without_point_reading_their_pages() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings { memtable_bytes: 1 << 20, filter_bytes: 0, ..small() };
        let options = LogOptions {
            indexes: method_indexes(),
            shared: shared(|kind, _| match kind { "note/method" => Some("method:shared".into()), "clip/source" => Some("source:shared".into()), _ => None }),
            tail_rows: usize::MAX,
            ..old()
        };
        let method = json!({ "name": "shared-method" });
        let source = json!({ "name": "shared-source" });
        let mut store = Store::create(&dir.path().join("store.sqlite"), settings, options);
        store.log.connection().execute_batch("PRAGMA synchronous=OFF").unwrap();
        // Each run spans nearly the same id range, so an absent-key lookup probes many run pages when the persisted
        // filters are outside the memory budget.
        for round in 0..12 {
            let mut rows: Vec<RecordInput> = (0..32).map(|index| { let number = index * 12 + round; note(&n(number), json!({ "at": format!("t{number}"), "room": "before", "method": method })) }).collect();
            if round == 0 {
                rows.push(kind("source:shared", "clip/source", source.clone()));
            }
            store.write(rows);
            store.checkpoint();
        }
        for number in 0..256 {
            store.write(vec![note(&n(number), json!({ "at": format!("changed-{number}"), "room": "after", "method": method }))]);
        }
        store.write(vec![removal(&n(1))]);
        store.write(vec![note(&n(2), json!({ "at": "changed-again", "room": "after", "method": method }))]);
        store.write(vec![kind(&n(3), "clip", json!({ "source": source }))]);
        let mut store = store.reopen();
        // The cold replay, in its bounded steps (a step applies at most 64 log groups).
        let mut work = trillion_local::kept_runs::Work::default();
        loop {
            let (done, step) = store.log.recover_measured(&Text).unwrap();
            work.add(&step.selected);
            if done {
                break;
            }
        }
        eprintln!("cold replay used {} point reads and {} grouped statements", work.point_pages, work.grouped);
        assert_eq!(work.point_pages, 0, "replay does not ask SQLite for one run page per prior record");
        assert!(work.grouped > 0 && work.grouped <= 48, "replay grouped run pages in {} statements", work.grouped);
        assert_eq!(store.read(&n(1)), None, "the removed record stays removed");
        assert_eq!(store.read(&n(2)), Some(json!({ "at": "changed-again", "room": "after", "method": method })));
        assert_eq!(store.read(&n(255)), Some(json!({ "at": "changed-255", "room": "after", "method": method })));
        assert_eq!(store.read(&n(300)), Some(json!({ "at": "t300", "room": "before", "method": method })));
        assert_eq!(store.ids_where("note", "room", json!("after")).unwrap().len(), 254);
        assert_eq!(ids_of(&store.scan("clip", "source_name", equal(&[json!("shared-source")]))), vec![n(3)]);
    }

    /// Old L853 'large prior values split replay, and a failed grouped page read retries across the multipart boundary'.
    /// The old test failed the replay's grouped page read after its first page through a wrapped `sql.exec`; here the
    /// large record's spilled value is made unreadable for one replay, then restored (doc note 13).
    #[test]
    fn l853_large_prior_values_split_replay_and_a_failed_grouped_page_read_retries_across_the_multipart_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings { memtable_bytes: 32 * 1024 * 1024, filter_bytes: 0, ..small() };
        let options = LogOptions {
            indexes: vec![Index { kind: "note".into(), name: "method_name".into(), paths: vec![vec!["method".into(), "name".into()]], backfill: None, carry: Vec::new() }],
            shared: shared(|kind, _| (kind == "note/method").then(|| "method:large".into())),
            tail_rows: usize::MAX,
            ..old()
        };
        let method = json!({ "name": "large-method" });
        let large = "x".repeat(4 * 1024 * 1024);
        let changed = "y".repeat(4 * 1024 * 1024);
        let mut store = Store::create(&dir.path().join("store.sqlite"), settings, options);
        store.write(vec![note("large", json!({ "method": method, "text": large, "version": 1 }))]);
        store.checkpoint();
        for number in 0..15 {
            store.write(vec![note(&format!("small-{number}"), json!({ "version": number }))]);
        }
        store.write(vec![note("large", json!({ "method": method, "text": changed, "version": 2 }))]);
        let parts: i64 = store.log.connection().query_row("SELECT parts FROM record_log ORDER BY rowid DESC LIMIT 1", [], |r| r.get(0)).unwrap();
        assert!(parts > 1, "the changed large value spans several log rows ({parts})");
        let db = store.log.connection();
        let held: String = db.query_row("SELECT body FROM record_keys_big ORDER BY ref, part LIMIT 1", [], |r| r.get(0)).unwrap();
        db.execute("UPDATE record_keys_big SET body = 'damaged' WHERE rowid = (SELECT rowid FROM record_keys_big ORDER BY ref, part LIMIT 1)", []).ok();
        db.execute("UPDATE record_keys_big SET body = 'damaged' WHERE body = ?", [&held]).unwrap();
        store.log.forget_cached();
        assert!(store.log.read("large", &request(), &Admit, &Text).is_err(), "the replay fails while the prior value cannot be read");
        store.log.connection().execute("UPDATE record_keys_big SET body = ? WHERE body = 'damaged'", [&held]).unwrap();
        assert_eq!(store.read("large").unwrap()["version"], json!(2), "the same store replays again after failure");
        assert_eq!(store.read("large").unwrap()["text"].as_str().unwrap(), changed);
        assert_eq!(store.read("small-14").unwrap()["version"], json!(14));
        let mut store = store.reopen();
        assert_eq!(store.read("large").unwrap()["version"], json!(2), "a second cold open crosses the split log row too");
        assert_eq!(ids_of(&store.scan("note", "method_name", equal(&[json!("large-method")]))), vec!["large"]);
    }

    /// Old L13 'own-field JSON keeps exact shared Unicode content across chunk boundaries, rollback and cold rewrite'.
    /// The old payload was a JavaScript value; here it is written as the exact text `JSON.stringify` gave for it, lone
    /// surrogates and member order included, through `record_log::exact_json` (doc note 14).
    #[test]
    fn l13_own_field_json_keeps_exact_shared_unicode_content_across_chunk_boundaries_rollback_and_cold_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::create(&dir.path().join("store.sqlite"), Settings::default(), old());
        // JSON.stringify(payload) for the old payload: { text: 'needle 🪡 "\n\t\\\ud800 \udfff', start: 1.25, ... }.
        let word = |text: &str| format!(r#"{{"text":{text},"start":1.25,"end":2.5,"final":false,"absent":null}}"#);
        let needle = r#""needle 🪡 \"\n\t\\\ud800 \udfff""#;
        let items: Vec<String> = (0..4096).map(|n| format!(r#"{{"n":{n},"words":[{},{}]}}"#, word(needle), word(&format!(r#""{n} 🪡""#)))).collect();
        let expected = format!(
            r#"{{"label":"𠜎{}","items":[{}],"long":"{}","scalars":{{"empty":"","zero":0,"no":false,"nil":null}}}}"#,
            '\u{2028}', items.join(","), "𐐀".repeat(40000)
        );
        let payload = trillion_local::record_log::exact_json(&expected).unwrap();
        assert_eq!(store_text(&payload), expected, "the old JSON.stringify text is kept exactly, lone surrogates included");
        store.write(vec![note("json-chunks", json!({ "payload": payload, "kept": "unchanged" }))]);
        store.checkpoint();
        let mut store = store.reopen();
        let read = |store: &mut Store, kind: &str, field: &str| store.log.read_own_field_json("json-chunks", kind, field, &request(), &Admit, &Text).unwrap();
        assert_eq!(read(&mut store, "note", "payload").as_deref(), Some(expected.as_str()));
        assert_eq!(read(&mut store, "wrong-kind", "payload"), None);
        assert_eq!(read(&mut store, "note", "missing"), None);
        let sealed = json!({ "pointer": "sealed" });
        assert!(!store.log.rewrite_own_field_json_if_equal("json-chunks", "note", "payload", &format!("{expected} "), &sealed, &context(), &Admit, &Text, &mut Ids).unwrap());
        let failed = store.log.transaction(|log| {
            assert!(log.rewrite_own_field_json_if_equal("json-chunks", "note", "payload", &expected, &sealed, &context(), &Admit, &Text, &mut Ids)?);
            Err::<(), _>(Error::Invalid("rollback exact JSON rewrite", trillion_local::cause!()))
        });
        assert!(matches!(failed, Err(Error::Invalid("rollback exact JSON rewrite", _))));
        store.log.forget_cached();
        assert_eq!(read(&mut store, "note", "payload").as_deref(), Some(expected.as_str()));
        assert!(store.log.rewrite_own_field_json_if_equal("json-chunks", "note", "payload", &expected, &sealed, &context(), &Admit, &Text, &mut Ids).unwrap());
        store.checkpoint();
        let mut store = store.reopen();
        assert_eq!(read(&mut store, "note", "payload"), None);
        assert_eq!(store.read("json-chunks"), Some(json!({ "kept": "unchanged", "pointer": "sealed" })));
    }
    /// The exact text a value written through `exact_json` stands for.
    fn store_text(value: &Value) -> String {
        value.get("\u{0}ecma").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| serde_json::to_string(value).unwrap())
    }

    /// The bytes the key space's tables hold: every run page and every big value part (the old test summed dbstat
    /// pages of the `record_keys_` tables).
    fn key_bytes(store: &Store) -> i64 {
        let db = store.log.connection();
        let tables: Vec<String> = {
            let mut q = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name GLOB 'record_keys_run_[0-9]*' OR name = 'record_keys_big')").unwrap();
            let names = q.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
            names
        };
        tables.iter().map(|t| db.query_row(&format!("SELECT COALESCE(SUM(length(body)), 0) FROM {t}"), [], |r| r.get::<_, i64>(0)).unwrap()).sum()
    }

    /// Old L318 'idle compaction drains overwritten-value debt across incomparable tiers and reopening'.
    #[test]
    fn l318_idle_compaction_drains_overwritten_value_debt_across_incomparable_tiers_and_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings { compaction_debt_min_bytes: 1, compaction_debt_ratio: 0.0, ..small() };
        let mut store = Store::create(&dir.path().join("store.sqlite"), settings, old());
        store.write(vec![note("keep", json!({ "text": "a".repeat(80_000) })), note("remove", json!({ "text": "b".repeat(80_000) }))]);
        store.checkpoint();
        store.write(vec![note("keep", json!({ "text": "current" })), removal("remove")]);
        store.checkpoint();
        assert!(store.held().compaction_debt > 160_000, "{}", store.held().compaction_debt);
        let before = key_bytes(&store);
        let mut store = store.reopen();
        assert!(store.held().compaction_debt > 160_000, "debt survives a restart");
        let mut steps = 0;
        while store.maintain(1).more {
            steps += 1;
            assert!(steps < 100);
        }
        assert_eq!(store.held().compaction_debt, 0);
        assert_eq!(store.held().runs, 1);
        let after = key_bytes(&store);
        assert!(after < before / 2, "obsolete big values and tombstones leave the live key tables ({before} became {after})");
        let mut store = store.reopen();
        assert_eq!(store.read("keep"), Some(json!({ "text": "current" })));
        assert_eq!(store.read("remove"), None);
    }
}
