// tests/record_log_store_ported.rs
//
// Purpose: the behaviours old trillion's record-log store tests proved for a person, ported against the engine's record
// store (src/storage/record_store). Old file: Trillion-X/trillion test/record-log-store.test.mjs (tag
// old-trillion-before-worker-retire). Each test below names the old test and line it ports and the behaviour it holds:
// a write survives a reopen, a read is bounded, a refused or rolled-back step leaves nothing, a backfill finishes while
// writes arrive, a declared order equals the records. The old tests that held only the JS layout (kept-runs pages,
// fences, memtables, merges, compaction tiers, page caches, the SQL shape of the JS store) are listed as not applicable,
// with their reasons, in docs/record-log-store-test-port.md, with every other old test's row.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde_json::{json, Value};
use std::{
    cell::Cell,
    collections::BTreeMap,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use trillion_local::{
    records::{Mutation, Records},
    storage::{
        record_store::{orders::Declared, settings::{self, Limits, Settings}, Clock, OrderCursor, RecordStore, SCHEMA},
        sqlite::{self, Bounds, Spend},
        Intent, Range, Read, Row, Schema, Storage, Value as Stored, When, Write,
    },
};

const A: &str = "account";
const R: &str = "own-records";

#[derive(Clone)]
struct Manual(Arc<AtomicU64>);
impl Clock for Manual {
    fn now_ms(&self) -> i64 {
        self.0.fetch_add(1, Ordering::SeqCst) as i64
    }
}

/// When the next commit fails.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Fault {
    None,
    /// The commit does not land.
    BeforeCommit,
    /// The commit lands and its reply is lost.
    AfterCommit,
    /// The n-th write from now (a put, an erase, or a batch of them; 1 is the next) is refused before it changes
    /// anything, as a supply refuses a write that ran out of its allowance. Commits are not affected.
    Write(u32),
}

/// A supply wrapper that fails the next outermost commit, or the n-th write, as told.
struct Faulty<S: Storage> {
    inner: S,
    next: Cell<Fault>,
}
impl<S: Storage> Faulty<S> {
    /// Count one write toward a `Fault::Write`; the counted one is refused with `Interrupted`.
    fn write_fault(&self) -> trillion_local::storage::Result<()> {
        match self.next.get() {
            Fault::Write(n) if n <= 1 => {
                self.next.set(Fault::None);
                Err(trillion_local::cause!(trillion_local::storage::Error::Interrupted))
            }
            Fault::Write(n) => {
                self.next.set(Fault::Write(n - 1));
                Ok(())
            }
            _ => Ok(()),
        }
    }
}
impl<S: Storage> Storage for Faulty<S> {
    fn schema(&self) -> &'static Schema {
        self.inner.schema()
    }
    fn get(&self, f: &str, k: &[Stored], r: &[Read<'_>]) -> trillion_local::storage::Result<Option<Row>> {
        self.inner.get(f, k, r)
    }
    fn read_many(&self, q: &[trillion_local::storage::Query<'_>]) -> trillion_local::storage::Result<Vec<trillion_local::storage::Reply>> {
        self.inner.read_many(q)
    }
    fn scan(&self, f: &str, g: &Range<'_>, r: &[Read<'_>]) -> trillion_local::storage::Result<Vec<Row>> {
        self.inner.scan(f, g, r)
    }
    fn put(&self, f: &str, row: &[(&str, Stored)], w: When<'_>) -> trillion_local::storage::Result<u64> {
        self.write_fault()?;
        self.inner.put(f, row, w)
    }
    fn write_many(&self, writes: &[Write<'_>]) -> trillion_local::storage::Result<Vec<u64>> {
        self.write_fault()?;
        self.inner.write_many(writes)
    }
    fn count(&self, f: &str, g: &Range<'_>) -> trillion_local::storage::Result<u64> {
        self.inner.count(f, g)
    }
    fn erase(&self, f: &str, g: &Range<'_>) -> trillion_local::storage::Result<u64> {
        self.write_fault()?;
        self.inner.erase(f, g)
    }
    fn present(&self, f: &str) -> trillion_local::storage::Result<bool> {
        self.inner.present(f)
    }
    fn custody(&self) -> trillion_local::storage::Result<()> {
        self.inner.custody()
    }
    fn location(&self) -> Option<&str> {
        self.inner.location()
    }
    fn scoped(&self) -> bool {
        self.inner.scoped()
    }
    fn writing(&self) -> trillion_local::storage::Result<bool> {
        self.inner.writing()
    }
    fn changes(&self) -> u64 {
        self.inner.changes()
    }
    fn mark(&self) -> trillion_local::storage::Result<i64> {
        self.inner.mark()
    }
    fn schema_mark(&self) -> trillion_local::storage::Result<i64> {
        self.inner.schema_mark()
    }
    fn allocated_bytes(&self) -> trillion_local::storage::Result<u64> {
        self.inner.allocated_bytes()
    }
    fn reclaim(&self) -> trillion_local::storage::Result<()> {
        self.inner.reclaim()
    }
    fn reclaim_step(&self, pages: u64) -> trillion_local::storage::Result<u64> {
        self.inner.reclaim_step(pages)
    }
    fn overwrites_removed(&self) -> trillion_local::storage::Result<bool> {
        self.inner.overwrites_removed()
    }
    fn open_scope(&self, intent: Intent) -> trillion_local::storage::Result<()> {
        self.inner.open_scope(intent)
    }
    fn close_scope(&self, commit: bool) -> trillion_local::storage::Result<()> {
        match (commit, self.next.replace(Fault::None)) {
            (true, Fault::BeforeCommit) => {
                self.inner.close_scope(false)?;
                Err(trillion_local::cause!(trillion_local::storage::Error::Unavailable))
            }
            (true, Fault::AfterCommit) => {
                self.inner.close_scope(true)?;
                Err(trillion_local::cause!(trillion_local::storage::Error::Unavailable))
            }
            (commit, fault) => {
                self.next.set(fault);
                self.inner.close_scope(commit)
            }
        }
    }
}

fn bounds() -> Bounds {
    Bounds { value_bytes: 64 << 20, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::EachOperation, cancel: None, busy: Duration::from_secs(5) }
}
fn order(name: &str, kind: &str, path: &[&str], then: &[&[&str]]) -> Declared {
    Declared {
        why: "ported test".into(),
        order: name.into(),
        kind: Some(kind.into()),
        path: path.iter().map(|s| s.to_string()).collect(),
        then: then.iter().map(|p| p.iter().map(|s| s.to_string()).collect()).collect(),
        carry: Vec::new(),
    }
}
fn with_orders(orders: Vec<Declared>) -> &'static Settings {
    let mut chosen = settings::shipped().unwrap().clone();
    chosen.orders = orders;
    assert!(chosen.valid());
    Box::leak(Box::new(chosen))
}
type Store = RecordStore<Faulty<sqlite::Supply<sqlite::Connection>>>;
fn open(path: &Path, chosen: &'static Settings) -> Store {
    let supply = Faulty { inner: sqlite::open_owned(path, SCHEMA, bounds()).unwrap(), next: Cell::new(Fault::None) };
    RecordStore::with_settings(supply, Box::new(Manual(Arc::new(AtomicU64::new(1_800_000_000_000)))), chosen, Limits::fixed(32 << 20, 10 << 30)).unwrap()
}
/// A fresh request key per write (an unchanged write keeps its version, so a key made from the version would repeat).
fn key() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!("request-{}", NEXT.fetch_add(1, Ordering::SeqCst))
}
fn put(store: &mut Store, id: &str, value: Value) -> i64 {
    let expected = store.held_version(A, R, id).unwrap();
    store.mutate(A, R, Mutation { id: id.into(), expected_version: expected, request_key: key(), deleted: false, value }).unwrap().version
}
fn remove(store: &mut Store, id: &str) {
    let expected = store.held_version(A, R, id).unwrap();
    store.mutate(A, R, Mutation { id: id.into(), expected_version: expected, request_key: key(), deleted: true, value: Value::Null }).unwrap();
}
fn read(store: &Store, id: &str) -> Option<Value> {
    store.get(A, R, id).unwrap().record.map(|record| record.value)
}
/// Every id of a declared order, walked a page at a time.
fn walk(store: &Store, name: &str, reverse: bool) -> Vec<String> {
    let (mut out, mut cursor): (Vec<String>, Option<OrderCursor>) = (Vec::new(), None);
    loop {
        let page = store.ordered_page(A, R, name, cursor.as_ref(), reverse, 7).unwrap();
        out.extend(page.records.into_iter().map(|record| record.id));
        match page.next {
            Some(next) => cursor = Some(next),
            None => return out,
        }
    }
}
fn fill(store: &mut Store, name: &str, limit: usize) -> usize {
    for steps in 1..=1000 {
        if store.fill_order(A, R, name, limit).unwrap() {
            return steps;
        }
    }
    panic!("{name} never filled");
}
/// A generator from a fixed random start (old tests used LCGs started the same way).
struct Lcg(u64);
impl Lcg {
    fn pick(&mut self, n: u64) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) % n
    }
}

// L13 'own-field JSON keeps exact shared Unicode content across chunk boundaries, rollback and cold rewrite'.
// For a person: a large field of any Unicode text reads back exact after a reopen; a rewrite against a stale version is
// refused; a rewrite rolled back leaves the field as it was; a rewrite of one field keeps the others.
// Lone surrogates (old `\ud800`) are dropped: a record body here is UTF-8 JSON, which cannot hold one (listed).
#[test]
fn l13_a_large_unicode_field_reads_back_exact_and_a_rewrite_is_versioned_rolled_back_and_keeps_other_fields() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.sqlite");
    let chosen = with_orders(Vec::new());
    let mut store = open(&path, chosen);
    let word = json!({ "text": "needle 🪡 \"\n\t\\ \u{2028}", "start": 1.25, "end": 2.5, "final": false, "absent": null });
    let items: Vec<Value> = (0..4096).map(|n| json!({ "n": n, "words": [word, { "text": format!("{n} 🪡") }] })).collect();
    let payload = json!({ "label": "𠜎\u{2028}", "items": items, "long": "𐐀".repeat(40000), "scalars": { "empty": "", "zero": 0, "no": false, "nil": null } });
    let version = put(&mut store, "json-chunks", json!({ "kind": "note", "payload": payload, "kept": "unchanged" }));
    drop(store);
    let mut store = open(&path, chosen);
    let selected = store.read_selected(A, R, "json-chunks", &["payload"], 64 << 20, 64 << 20).unwrap().unwrap();
    assert_eq!(selected["payload"], payload, "exact after a reopen");
    assert!(store.read_selected(A, R, "json-chunks", &["missing"], 64 << 20, 64 << 20).unwrap().unwrap().is_empty());
    let mut rewrite = serde_json::Map::new();
    rewrite.insert("pointer".into(), json!("sealed"));
    assert!(store.write_own(A, R, "json-chunks", &rewrite, &["kept", "kind"], version - 1, "stale", 64 << 20).is_err(), "a stale rewrite is refused");
    store.storage().open_scope(Intent::Write).unwrap();
    store.write_own(A, R, "json-chunks", &rewrite, &["kept", "kind"], version, "rolled", 64 << 20).unwrap();
    store.storage().close_scope(false).unwrap();
    assert_eq!(read(&store, "json-chunks").unwrap()["payload"], payload, "a rolled-back rewrite leaves the field");
    store.write_own(A, R, "json-chunks", &rewrite, &["kept", "kind"], version, "kept", 64 << 20).unwrap();
    drop(store);
    let store = open(&path, chosen);
    assert_eq!(read(&store, "json-chunks").unwrap(), json!({ "kind": "note", "kept": "unchanged", "pointer": "sealed" }));
}

// L153 'range existence respects newest tombstones and stops before older runs or large values'.
// For a person: "is it there" honours the newest delete and never reads a large value to answer.
#[test]
fn l153_existence_honours_the_newest_delete_and_reads_no_value() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("b.sqlite"), with_orders(Vec::new()));
    put(&mut store, "a", json!({ "kind": "note", "big": "x".repeat(10_000) }));
    put(&mut store, "b", json!({ "kind": "note", "big": "y".repeat(10_000) }));
    remove(&mut store, "a");
    let before = store.work();
    assert!(!store.has_live_record(A, R, "a").unwrap(), "the newest delete wins");
    assert!(store.has_live_record(A, R, "b").unwrap());
    assert!(!store.has_live_record(A, R, "z").unwrap());
    let after = store.work();
    assert_eq!(after.seeks - before.seeks, 3, "one seek each");
    put(&mut store, "a", json!({ "kind": "note", "big": "z".repeat(10_000) }));
    assert!(store.has_live_record(A, R, "a").unwrap(), "put again after a delete");
    assert_eq!(store.ids(A, R, None, 10).unwrap().0, ["a", "b"], "the id walk answers ids without their values");
}

// L181 'independent index builds rotate durably past a larger unfinished group'.
// For a person: a small new order becomes ready, and stays ready across a reopen, while a large one is still filling;
// the order of the declarations does not matter.
#[test]
fn l181_a_small_order_is_ready_and_stays_ready_while_a_large_one_still_fills() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("c.sqlite");
    let mut plain = open(&path, with_orders(Vec::new()));
    for n in 0..240 {
        put(&mut plain, &format!("large-{n:03}"), json!({ "kind": "large", "at": n }));
    }
    for n in 0..3 {
        put(&mut plain, &format!("little-{n}"), json!({ "kind": "little", "at": n }));
    }
    drop(plain);
    let orders = vec![order("large/at", "large", &["at"], &[]), order("little/at", "little", &["at"], &[])];
    let mut store = open(&path, with_orders(orders.clone()));
    assert!(!store.fill_order(A, R, "large/at", 16).unwrap(), "the large order is not done in one step");
    fill(&mut store, "little/at", 1000);
    drop(store);
    let mut reversed = orders;
    reversed.reverse();
    let store = open(&path, with_orders(reversed));
    assert_eq!(walk(&store, "little/at", false), ["little-0", "little-1", "little-2"]);
    assert!(store.ordered_page(A, R, "large/at", None, false, 5).is_err(), "the large order still says it is filling");
}

// L205 'index backfill fixes its frontier while new records keep arriving'.
// For a person: a fill finishes while writes arrive, and the order then equals the records: an edited old record moves,
// a deleted one is gone, every new one is there.
#[test]
fn l205_a_fill_finishes_while_writes_arrive_and_the_order_equals_the_records() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("d.sqlite");
    let mut plain = open(&path, with_orders(Vec::new()));
    let mut model = BTreeMap::new();
    for n in 0..64 {
        put(&mut plain, &format!("n{n:03}"), json!({ "kind": "note", "at": n }));
        model.insert(format!("n{n:03}"), n);
    }
    drop(plain);
    let mut store = open(&path, with_orders(vec![order("note/at", "note", &["at"], &[])]));
    assert!(!store.fill_order(A, R, "note/at", 32).unwrap());
    for n in 64..96 {
        put(&mut store, &format!("n{n:03}"), json!({ "kind": "note", "at": n }));
        model.insert(format!("n{n:03}"), n);
    }
    put(&mut store, "n010", json!({ "kind": "note", "at": 1000 }));
    model.insert("n010".into(), 1000);
    remove(&mut store, "n040");
    model.remove("n040");
    fill(&mut store, "note/at", 32);
    // A declared order compares the field's JSON text (orders.rs), as the old declared indexes did: 1000 sorts as text.
    let mut expected: Vec<(String, String)> = model.into_iter().map(|(id, at)| (at.to_string(), id)).collect();
    expected.sort();
    assert_eq!(walk(&store, "note/at", false), expected.into_iter().map(|(_, id)| id).collect::<Vec<_>>());
}

// L231 'a refused index slice rolls back its progress while admitting the next independent group'.
// For a person: a fill step the storage refuses leaves no progress; another order still fills; the refused one fills on
// the next try.
#[test]
fn l231_a_refused_fill_step_leaves_no_progress_and_the_next_try_completes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("e.sqlite");
    let mut plain = open(&path, with_orders(Vec::new()));
    put(&mut plain, "large", json!({ "kind": "large", "at": 1 }));
    put(&mut plain, "little", json!({ "kind": "little", "at": 1 }));
    drop(plain);
    let mut store = open(&path, with_orders(vec![order("large/at", "large", &["at"], &[]), order("little/at", "little", &["at"], &[])]));
    store.storage().next.set(Fault::Write(1));
    assert!(store.fill_order(A, R, "large/at", 100).is_err(), "the step is refused");
    assert!(store.ordered_page(A, R, "large/at", None, false, 5).is_err(), "no progress was kept");
    fill(&mut store, "little/at", 100);
    fill(&mut store, "large/at", 100);
    assert_eq!(walk(&store, "large/at", false), ["large"]);
}

// L256 'index transaction commit failure restores the same instance and preserves independent admission', and
// L1246 'maintenance admission ... without caching rollback': for a person, a fill whose commit fails, or that runs
// inside a change that is rolled back, is never believed by the same store; reads stay right; a later fill completes.
#[test]
fn l256_l1246_a_fill_that_does_not_commit_is_never_believed_and_a_later_one_completes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("f.sqlite");
    let mut plain = open(&path, with_orders(Vec::new()));
    put(&mut plain, "a", json!({ "kind": "note", "at": 1 }));
    drop(plain);
    let mut store = open(&path, with_orders(vec![order("note/at", "note", &["at"], &[])]));
    store.storage().next.set(Fault::BeforeCommit);
    assert!(store.fill_order(A, R, "note/at", 100).is_err(), "the commit did not land");
    assert_eq!(read(&store, "a").unwrap()["at"], 1);
    assert!(store.ordered_page(A, R, "note/at", None, false, 5).is_err(), "the same instance does not believe it");
    // Inside a change its caller rolls back.
    store.storage().open_scope(Intent::Write).unwrap();
    assert!(store.fill_order(A, R, "note/at", 100).unwrap(), "filled inside the lent change");
    store.storage().close_scope(false).unwrap();
    assert!(store.ordered_page(A, R, "note/at", None, false, 5).is_err(), "a rolled-back fill is not remembered");
    fill(&mut store, "note/at", 100);
    assert_eq!(walk(&store, "note/at", false), ["a"]);
}

// L389 'the key space answers like a plain map through flushes, merges and reopening'.
// For a person: through thousands of random writes and deletes and reopens, every read and every walk equals a plain map.
#[test]
fn l389_random_writes_deletes_and_reopens_read_like_a_plain_map() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("g.sqlite");
    let chosen = with_orders(Vec::new());
    let mut store = open(&path, chosen);
    let mut model: BTreeMap<String, Value> = BTreeMap::new();
    let mut lcg = Lcg(0x5eed);
    for step in 0..3000 {
        let id = format!("k{:04}", lcg.pick(400));
        if lcg.pick(5) == 0 {
            if model.remove(&id).is_some() {
                remove(&mut store, &id);
            }
        } else {
            let value = json!({ "kind": "note", "step": step, "text": "v".repeat(lcg.pick(200) as usize) });
            put(&mut store, &id, value.clone());
            model.insert(id, value);
        }
        if step % 997 == 996 {
            drop(store);
            store = open(&path, chosen);
        }
    }
    for n in 0..400 {
        let id = format!("k{n:04}");
        assert_eq!(read(&store, &id), model.get(&id).cloned(), "{id}");
    }
    let (mut ids, mut after) = (Vec::new(), None::<String>);
    loop {
        let (page, next) = store.ids(A, R, after.as_deref(), 37).unwrap();
        ids.extend(page);
        match next {
            Some(next) => after = Some(next),
            None => break,
        }
    }
    assert_eq!(ids, model.keys().cloned().collect::<Vec<_>>());
    let newest: Vec<String> = model.keys().rev().take(5).cloned().collect();
    assert_eq!(store.ids_of_kind(A, R, "note", None, 5).unwrap().0, newest, "newest first, limit 5");
}

// L694 'a fragmented record bucket walk streams run pages ...' (its "all ids of a kind" half).
// For a person: the ids of a kind are complete and in order, a page at a time.
#[test]
fn l694_the_ids_of_a_kind_are_complete_and_descending() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("h.sqlite"), with_orders(Vec::new()));
    for n in 0..384 {
        put(&mut store, &format!("note:{n:03}"), json!({ "kind": "note", "title": format!("note {n}") }));
        put(&mut store, &format!("other:{n:03}"), json!({ "kind": "other" }));
    }
    let (mut ids, mut before) = (Vec::new(), None::<String>);
    loop {
        let (page, next) = store.ids_of_kind(A, R, "note", before.as_deref(), 100).unwrap();
        ids.extend(page);
        match next {
            Some(next) => before = Some(next),
            None => break,
        }
    }
    let expected: Vec<String> = (0..384).rev().map(|n| format!("note:{n:03}")).collect();
    assert_eq!(ids, expected);
}

// L926 'generated edits and deletes keep declared indexes equal to the current records across reopen and maintenance'.
// For a person: through random edits and deletes, with fields coming and going and reopens, every declared order (one
// field, a nested field, and a field then another) lists exactly the records that hold it, in order.
#[test]
fn l926_generated_edits_and_deletes_keep_every_declared_order_equal_to_the_records() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("i.sqlite");
    let orders = vec![
        order("note/room", "note", &["room"], &[]),
        order("note/goal", "note", &["input", "goal"], &[]),
        order("note/room_at", "note", &["room"], &[&["at"]]),
    ];
    let chosen = with_orders(orders);
    let mut store = open(&path, chosen);
    for name in ["note/room", "note/goal", "note/room_at"] {
        fill(&mut store, name, 100);
    }
    let mut model: BTreeMap<String, Value> = BTreeMap::new();
    let mut lcg = Lcg(0x83a3);
    let check = |store: &Store, model: &BTreeMap<String, Value>| {
        let mut by: Vec<(Value, String)> = model.iter().filter_map(|(id, v)| v.get("room").map(|r| (r.clone(), id.clone()))).collect();
        by.sort_by(|a, b| a.0.as_str().cmp(&b.0.as_str()).then(a.1.cmp(&b.1)));
        assert_eq!(walk(store, "note/room", false), by.into_iter().map(|(_, id)| id).collect::<Vec<_>>(), "room");
        let mut by: Vec<(i64, String)> = model.iter().filter_map(|(id, v)| v.pointer("/input/goal").and_then(Value::as_i64).map(|g| (g, id.clone()))).collect();
        by.sort();
        assert_eq!(walk(store, "note/goal", false), by.into_iter().map(|(_, id)| id).collect::<Vec<_>>(), "goal");
        let held: Vec<&String> = model.iter().filter(|(_, v)| v.get("room").is_some() && v.get("at").is_some()).map(|(id, _)| id).collect();
        let mut listed = walk(store, "note/room_at", false);
        let reversed = walk(store, "note/room_at", true);
        listed.sort();
        let mut expected: Vec<String> = held.into_iter().cloned().collect();
        expected.sort();
        assert_eq!(listed, expected, "room then at lists every record holding both");
        assert_eq!(reversed.len(), expected.len());
    };
    for step in 0..240u64 {
        let id = format!("n{:02}", lcg.pick(24));
        if lcg.pick(6) == 0 {
            if model.remove(&id).is_some() {
                remove(&mut store, &id);
            }
        } else {
            let mut value = serde_json::Map::new();
            value.insert("kind".into(), json!("note"));
            if lcg.pick(4) != 0 {
                value.insert("room".into(), json!(format!("r{}", lcg.pick(4))));
            }
            if lcg.pick(3) != 0 {
                value.insert("at".into(), json!(format!("t{:03}", step)));
            }
            if lcg.pick(2) == 0 {
                value.insert("input".into(), json!({ "goal": lcg.pick(3) }));
            }
            let value = Value::Object(value);
            put(&mut store, &id, value.clone());
            model.insert(id, value);
        }
        if step % 29 == 28 {
            check(&store, &model);
            drop(store);
            store = open(&path, chosen);
        }
    }
    check(&store, &model);
}

// L1222 'exact-empty kinds skip unrelated cold packed pages and never guess during upgrade'.
// For a person: listing a kind that has no records reads nothing of the others, and a new record of it shows at once.
#[test]
fn l1222_an_empty_kind_reads_nothing_of_the_others_and_a_new_record_shows_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("j.sqlite"), with_orders(Vec::new()));
    for n in 0..500 {
        put(&mut store, &format!("other:{n:03}"), json!({ "kind": "other" }));
    }
    let before = store.work();
    assert!(store.ids_of_kind(A, R, "absent", None, 100).unwrap().0.is_empty());
    let after = store.work();
    assert!(after.rows_read - before.rows_read <= 1, "no row of the 500 others is read");
    put(&mut store, "present", json!({ "kind": "absent" }));
    assert_eq!(store.ids_of_kind(A, R, "absent", None, 100).unwrap().0, ["present"]);
}

// L1246 (its changed-signature half): for a person, an order whose declaration changed under the same name is not
// answered from rows made under the old one; it fills again, its old rows leave, and it then equals the records.
#[test]
fn l1246_a_changed_declaration_under_the_same_name_fills_again_and_leaves_no_old_row() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("k.sqlite");
    let first = with_orders(vec![order("note/key", "note", &["room"], &[])]);
    let mut store = open(&path, first);
    for n in 0..30 {
        put(&mut store, &format!("n{n:02}"), json!({ "kind": "note", "room": format!("r{}", n % 3), "at": format!("{:02}", 29 - n) }));
    }
    fill(&mut store, "note/key", 7);
    assert_eq!(walk(&store, "note/key", false).len(), 30);
    drop(store);
    let changed = with_orders(vec![order("note/key", "note", &["at"], &[])]);
    let mut store = open(&path, changed);
    assert!(store.ordered_page(A, R, "note/key", None, false, 5).is_err(), "rows made under the old declaration are not answered");
    let steps = fill(&mut store, "note/key", 7);
    assert!(steps > 30 / 7, "the old rows leave and the order fills, a bounded step at a time");
    let expected: Vec<String> = (0..30).rev().map(|n| format!("n{n:02}")).collect();
    assert_eq!(walk(&store, "note/key", false), expected, "the order is the new declaration's, with no old row");
    drop(store);
    assert_eq!(walk(&open(&path, changed), "note/key", false).len(), 30, "kept across a reopen");
}

fn change(id: &str, expected: i64, key: &str, value: Value) -> Mutation {
    Mutation { id: id.into(), expected_version: expected, request_key: key.into(), deleted: false, value }
}

// L609 'a write is one log row, an unchanged write appends nothing, and reads come back fresh'.
// For a person: several records go in one write, together or not at all; writing what a record already holds adds no
// version and no history, and its retry still answers it.
#[test]
fn l609_several_records_are_one_write_and_an_unchanged_write_adds_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("l.sqlite");
    let mut store = open(&path, with_orders(vec![order("note/room", "note", &["room"], &[])]));
    fill(&mut store, "note/room", 10);
    let n1 = json!({ "kind": "note", "at": "2026-10-05T10:00:00Z", "room": "a", "text": "hello", "tags": ["x"] });
    let n2 = json!({ "kind": "note", "at": "2026-10-05T10:01:00Z", "room": "b", "text": "two" });
    let changes = store.mutate_many(A, R, vec![change("n1", 0, "w1", n1.clone()), change("n2", 0, "w2", n2.clone())]).unwrap();
    assert_eq!(changes.iter().map(|c| (c.id.as_str(), c.version)).collect::<Vec<_>>(), [("n1", 1), ("n2", 1)]);
    assert_eq!(walk(&store, "note/room", false), ["n1", "n2"]);
    // All or nothing: a batch with one stale change writes neither.
    let refused = store.mutate_many(A, R, vec![change("n3", 0, "w3", json!({ "kind": "note", "room": "c" })), change("n2", 0, "stale", n2.clone())]);
    assert!(refused.is_err());
    assert_eq!(read(&store, "n3"), None, "the batch left nothing");
    // The same batch again is its retry: each change answers as first made.
    let again = store.mutate_many(A, R, vec![change("n1", 0, "w1", n1.clone()), change("n2", 0, "w2", n2.clone())]).unwrap();
    assert_eq!(again.iter().map(|c| c.version).collect::<Vec<_>>(), [1, 1]);
    // Unchanged: nothing written at all.
    let before = store.storage().changes();
    let same = store.mutate(A, R, change("n1", 1, "unchanged", n1.clone())).unwrap();
    assert_eq!(same.version, 1, "no new version");
    assert_eq!(store.storage().changes(), before, "nothing changed, nothing written");
    assert_eq!(store.history(A, R, "n1", None, 10).unwrap().versions.len(), 1, "no history row");
    assert_eq!(store.mutate(A, R, change("n1", 1, "unchanged", n1.clone())).unwrap().version, 1, "its retry answers it");
    // A caller that makes its next key from the version still writes its next change.
    let next = store.mutate(A, R, change("n1", 1, "unchanged", json!({ "kind": "note", "room": "a", "text": "changed" }))).unwrap();
    assert_eq!(next.version, 2, "an unchanged write takes no key: a caller that makes its next key from the version writes its next change");
    // A handed-out copy never changes what is kept; a delete reads as nothing.
    let mut copy = read(&store, "n2").unwrap();
    copy["text"] = json!("changed locally");
    assert_eq!(read(&store, "n2").unwrap()["text"], "two");
    remove(&mut store, "n2");
    assert_eq!(read(&store, "n2"), None);
}

// L1182 'exact type counts survive replay, rollback and a bounded old-projection upgrade' (its count half).
// For a person: a count of each kind is exact through creates, a kind move, a delete, a rolled-back write and a reopen,
// and a batch asks each kind once.
#[test]
fn l1182_counts_per_kind_are_exact_through_moves_deletes_rollback_and_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("m.sqlite");
    let chosen = with_orders(Vec::new());
    let mut store = open(&path, chosen);
    let notes: Vec<Mutation> = (0..200).map(|n| change(&format!("n{n:04}"), 0, &key(), json!({ "kind": "note", "text": format!("Note {n}") }))).collect();
    store.mutate_many(A, R, notes).unwrap();
    for n in 200..600 {
        put(&mut store, &format!("n{n:04}"), json!({ "kind": "note", "text": format!("Note {n}") }));
    }
    assert_eq!(store.count_of_kind(A, R, "note").unwrap(), 600);
    assert_eq!(store.count_many(A, R, &["note", "message", "absent", "note"]).unwrap(), [("note".into(), 600), ("message".into(), 0), ("absent".into(), 0)]);
    drop(store);
    let mut store = open(&path, chosen);
    put(&mut store, "n0000", json!({ "kind": "message", "text": "Moved" }));
    remove(&mut store, "n0001");
    assert_eq!(store.count_many(A, R, &["note", "message"]).unwrap(), [("note".into(), 598), ("message".into(), 1)]);
    store.storage().open_scope(Intent::Write).unwrap();
    put(&mut store, "rollback", json!({ "kind": "note" }));
    store.storage().close_scope(false).unwrap();
    assert_eq!(store.count_of_kind(A, R, "note").unwrap(), 598, "a rolled-back write is not counted");
    let before = store.work();
    assert_eq!(store.count_many(A, R, &["note", "message", "absent"]).unwrap(), [("note".into(), 598), ("message".into(), 1), ("absent".into(), 0)]);
    assert_eq!(store.work().seeks - before.seeks, 3, "one count per kind asked");
}

use trillion_local::storage::record_store::{find::Find, order_reads::{OrderEntry, OrderScan}};

fn ids_of(entries: &[OrderEntry]) -> Vec<String> {
    entries.iter().map(|entry| entry.id.clone()).collect()
}
fn rooms_store(path: &Path, orders: Vec<Declared>, state: bool) -> Store {
    let chosen = with_orders(orders.clone());
    let mut store = open(path, chosen);
    for round in 0..3 {
        let batch: Vec<Mutation> = (0..48)
            .map(|n| {
                let mut value = json!({ "kind": "note", "room": format!("r{}", n % 8), "at": format!("t{round}-{n:02}") });
                if state {
                    value["state"] = json!("open");
                }
                change(&format!("n{round}-{n}"), 0, &key(), value)
            })
            .collect();
        store.mutate_many(A, R, batch).unwrap();
    }
    let mut moved = json!({ "kind": "note", "room": "r6", "at": "moved" });
    if state {
        moved["state"] = json!("open");
    }
    put(&mut store, "n0-1", moved);
    remove(&mut store, "n1-14");
    if state {
        remove(&mut store, "n0-6");
    }
    for declared in &orders {
        fill(&mut store, &declared.order, 100);
    }
    store
}

// L85 'empty selected parent prefixes share one existence seek regardless of parent count', and L456 'selected index
// prefixes keep exact order and current values across written runs'. For a person: the first entry under each of many
// parents of a compound order is exact (a moved record under its new room, a removed one gone), nothing for parents
// that hold nothing, and a later record under one of them is found.
#[test]
fn l85_l456_the_first_entry_under_each_selected_parent_is_exact() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = rooms_store(&dir.path().join("n.sqlite"), vec![order("note/room_at", "note", &["room"], &[&["at"]])], false);
    let empty: Vec<Value> = (0..80).map(|n| json!(format!("m{n:03}"))).collect();
    assert!(store.ordered_first_per_value(A, R, "note/room_at", &empty, false).unwrap().is_empty(), "80 empty parents answer nothing");
    let first = store.ordered_first_per_value(A, R, "note/room_at", &[json!("r1"), json!("r6"), json!("r1")], false).unwrap();
    assert_eq!(first.iter().map(|e| (e.id.as_str(), e.values.clone())).collect::<Vec<_>>(), [("n0-9", json!(["r1", "t0-09"])), ("n0-1", json!(["r6", "moved"]))],
        "each parent once, its first entry; the moved record is under r6");
    let r1 = store.ordered_scan(A, R, "note/room_at", &OrderScan { equal: vec![json!("r1")], limit: 100, ..OrderScan::default() }).unwrap();
    assert!(r1.iter().all(|e| e.values[0] == "r1") && r1.len() == 17, "r1 holds 18 less the moved one: {}", r1.len());
    assert!(!ids_of(&r1).contains(&"n1-14".to_string()), "removed records stay removed");
    put(&mut store, "later", json!({ "kind": "note", "room": "m000", "at": "later" }));
    let later = store.ordered_first_per_value(A, R, "note/room_at", &[json!("m000"), json!("m001")], false).unwrap();
    assert_eq!(later.iter().map(|e| (e.id.as_str(), e.values.clone())).collect::<Vec<_>>(), [("later", json!(["m000", "later"]))]);
}

// L493 'selected values after a fixed prefix batch pages and keep each live top page exact'. For a person: the top N
// under each selected value after a fixed prefix, forward, reverse and inside a time window, equal separate scans.
#[test]
fn l493_selected_values_after_a_fixed_prefix_equal_separate_scans() {
    let dir = tempfile::tempdir().unwrap();
    let store = rooms_store(&dir.path().join("o.sqlite"), vec![order("note/state_room_at", "note", &["state"], &[&["room"], &["at"]])], true);
    let rooms: Vec<Value> = (0..8).map(|n| json!(format!("r{n}"))).collect();
    let separately = |scan: &OrderScan| {
        let mut all: Vec<OrderEntry> = rooms
            .iter()
            .flat_map(|room| {
                let mut one = scan.clone();
                one.equal.push(room.clone());
                store.ordered_scan(A, R, "note/state_room_at", &one).unwrap()
            })
            .collect();
        all.sort_by(|a, b| (&a.cursor.value, &a.cursor.id).cmp(&(&b.cursor.value, &b.cursor.id)));
        if scan.reverse {
            all.reverse();
        }
        all
    };
    let mut asked = rooms.clone();
    asked.push(json!("r1"));
    for scan in [
        OrderScan { equal: vec![json!("open")], limit: 2, ..OrderScan::default() },
        OrderScan { equal: vec![json!("open")], limit: 2, reverse: true, ..OrderScan::default() },
        OrderScan { equal: vec![json!("open")], from: Some(json!("t1-00")), before: Some(json!("t2-00")), reverse: true, limit: 2, ..OrderScan::default() },
    ] {
        let together = store.ordered_selected(A, R, "note/state_room_at", &scan, &asked).unwrap();
        assert_eq!(ids_of(&together), ids_of(&separately(&scan)), "{scan:?}");
        assert_eq!(together.len(), 16, "two under each of 8 rooms");
        assert!(!ids_of(&together).iter().any(|id| id == "n1-14" || id == "n0-6"));
    }
    let window = store.ordered_selected(A, R, "note/state_room_at", &OrderScan { equal: vec![json!("open")], from: Some(json!("t1-00")), before: Some(json!("t2-00")), limit: 100, ..OrderScan::default() }, &rooms).unwrap();
    assert!(window.iter().all(|e| e.values[2].as_str().unwrap().starts_with("t1-")), "the window holds round 1 only");
}

// L905 'declared indexes answer ranges, equal values, groups and field reads; undeclared ones are refused'.
#[test]
fn l905_declared_orders_answer_ranges_equal_values_groups_and_words() {
    let dir = tempfile::tempdir().unwrap();
    let orders = vec![
        order("note/at", "note", &["at"], &[]),
        order("note/room", "note", &["room"], &[]),
        order("note/room_at", "note", &["room"], &[&["at"]]),
        order("note/goal", "note", &["input", "goal"], &[]),
    ];
    let mut store = open(&dir.path().join("p.sqlite"), with_orders(orders.clone()));
    for declared in &orders {
        fill(&mut store, &declared.order, 10);
    }
    for n in 0..60 {
        put(&mut store, &format!("n{n:02}"), json!({ "kind": "note", "at": format!("2026-10-05T10:{n:02}:00Z"), "room": format!("r{}", n % 4), "text": format!("note {n}"),
            "input": { "goal": if n % 2 == 1 { "odd goal" } else { "even goal" } } }));
    }
    put(&mut store, "n10", json!({ "kind": "note", "at": "2026-10-05T10:10:00Z", "room": "moved", "text": "note 10", "input": { "goal": "even goal" } }));
    let after = store.ordered_scan(A, R, "note/at", &OrderScan { from: Some(json!("2026-10-05T10:58:00Z")), limit: 10, ..OrderScan::default() }).unwrap();
    assert_eq!(ids_of(&after), ["n58", "n59"]);
    assert_eq!(store.ids_where(A, R, "note/room", &json!("moved"), 100).unwrap(), ["n10"]);
    assert_eq!(store.ids_where(A, R, "note/room", &json!("r2"), 100).unwrap().len(), 14, "n10 moved out of r2");
    let groups: Vec<Value> = ["moved", "r0", "r1", "r2", "r3"].iter().map(|g| json!(g)).collect();
    let newest = store.ordered_first_per_value(A, R, "note/room_at", &groups, true).unwrap();
    assert_eq!(newest.iter().map(|e| (e.values[0].as_str().unwrap().to_owned(), e.id.clone())).collect::<Vec<_>>(),
        [("moved", "n10"), ("r0", "n56"), ("r1", "n57"), ("r2", "n58"), ("r3", "n59")].map(|(g, id)| (g.to_owned(), id.to_owned())), "the newest per group");
    assert_eq!(store.ids_where(A, R, "note/goal", &json!("odd goal"), 100).unwrap().len(), 30);
    assert_eq!(ids_of(&store.ordered_scan(A, R, "note/at", &OrderScan { reverse: true, limit: 2, ..OrderScan::default() }).unwrap()), ["n59", "n58"]);
    let range = store.ordered_scan(A, R, "note/at", &OrderScan { from: Some(json!("2026-10-05T10:10:00Z")), to: Some(json!("2026-10-05T10:19:00Z")), limit: 100, ..OrderScan::default() }).unwrap();
    assert_eq!(range.len(), 10, "from and to both included");
    let begins = store.ordered_scan(A, R, "note/room", &OrderScan { starts_with: Some("mo".into()), limit: 100, ..OrderScan::default() }).unwrap();
    assert_eq!(ids_of(&begins), ["n10"]);
    assert!(store.ordered_scan(A, R, "note/text", &OrderScan { limit: 1, ..OrderScan::default() }).is_err(), "an undeclared order is refused");
    let (found, _) = store.find(A, R, &Find { words: &["note", "5"], fields: &[&["text"]], limit: Some(3), ..Find::default() }).unwrap();
    assert_eq!(found.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), ["n59", "n58", "n57"], "every word, newest change first");
    let (titled, _) = store.find(A, R, &Find { words: &["note 1"], fields: &[&["input", "goal"], &["text"]], kinds: Some(&["note"]), limit: Some(2), ..Find::default() }).unwrap();
    assert_eq!(titled.iter().map(|f| (f.id.as_str(), f.title.as_str())).collect::<Vec<_>>(), [("n10", "even goal"), ("n19", "odd goal")],
        "the first named field holding words is the title; n10's move is the newest change here (the old test's key sorted it by its first write)");
    // A bounded find resumes where it stopped.
    let (first, next) = store.find(A, R, &Find { words: &["note"], fields: &[&["text"]], budget: Some(5), ..Find::default() }).unwrap();
    assert_eq!(first.len(), 5);
    let (rest, _) = store.find(A, R, &Find { words: &["note"], fields: &[&["text"]], resume: next, limit: Some(200), ..Find::default() }).unwrap();
    assert_eq!(first.len() + rest.len(), 60);
}

// L285 'carried index replace / move / remove retires the old value' (its carried half), with L974's memberFields.
// For a person: an order can answer named fields of its records without reading them, always their current values;
// a list's members answer only the named fields asked.
#[test]
fn l285_l974_carried_fields_are_current_and_member_fields_read_only_what_is_asked() {
    let dir = tempfile::tempdir().unwrap();
    let mut carried = order("note/at", "note", &["at"], &[]);
    carried.carry = vec![vec!["title".into()], vec!["meta".into(), "owner".into()]];
    let mut store = open(&dir.path().join("q.sqlite"), with_orders(vec![carried]));
    fill(&mut store, "note/at", 10);
    put(&mut store, "a", json!({ "kind": "note", "at": "1", "title": "first", "meta": { "owner": "ann" }, "body": "x".repeat(8000) }));
    put(&mut store, "b", json!({ "kind": "note", "at": "2", "title": "second" }));
    let scan = OrderScan { limit: 10, carried: true, ..OrderScan::default() };
    let shown = |store: &Store| store.ordered_scan(A, R, "note/at", &scan).unwrap().into_iter().map(|e| (e.id, e.carried.unwrap())).collect::<Vec<_>>();
    assert_eq!(shown(&store), [("a".to_string(), json!({ "title": "first", "meta.owner": "ann" })), ("b".to_string(), json!({ "title": "second", "meta.owner": null }))]);
    put(&mut store, "a", json!({ "kind": "note", "at": "1", "title": "replaced", "meta": { "owner": "ann" } }));
    put(&mut store, "b", json!({ "kind": "note", "at": "0", "title": "moved" }));
    assert_eq!(shown(&store), [("b".to_string(), json!({ "title": "moved", "meta.owner": null })), ("a".to_string(), json!({ "title": "replaced", "meta.owner": "ann" }))], "a replace and a move carry the current value");
    remove(&mut store, "b");
    assert_eq!(shown(&store).len(), 1, "a remove takes its carried row with it");
    put(&mut store, "plan", json!({ "kind": "plan", "steps": [{ "step_id": "a", "text": "one", "big": "y".repeat(4000) }, { "step_id": "b" }, { "text": "three" }] }));
    let fields = store.member_fields(A, R, "plan", "steps", &["step_id", "text"], None, 1 << 20).unwrap();
    assert_eq!(fields, [(0, json!({ "step_id": "a", "text": "one" })), (1, json!({ "step_id": "b" })), (2, json!({ "text": "three" }))]
        .map(|(n, v)| (n, v.as_object().unwrap().clone())));
    let picked = store.member_fields(A, R, "plan", "steps", &["text"], Some(&[1, 2]), 1 << 20).unwrap();
    assert_eq!(picked, [(2, json!({ "text": "three" }).as_object().unwrap().clone())], "member 1 holds no text");
    assert!(store.member_fields(A, R, "plan", "steps", &[], None, 1 << 20).unwrap().is_empty());
}

use trillion_local::storage::record_store::cascade::{EraseLink, EraseWith};

fn by(kind: &str, order_name: &str) -> EraseLink {
    EraseLink { id: None, field: None, kind: Some(kind.into()), order: Some(order_name.into()), equal: Some("{key}".into()) }
}
/// The booking-link kinds as old trillion src/record-model.json and src/record-indexes.json declared them.
fn booking() -> &'static Settings {
    let mut chosen = settings::shipped().unwrap().clone();
    chosen.orders = vec![
        order("availability-reservation/by-link", "availability-reservation", &["link_id"], &[]),
        order("availability-reservation-hold/by-reservation", "availability-reservation-hold", &["reservation_id"], &[]),
        order("availability-operation/by-reservation", "availability-operation", &["reservation_id"], &[]),
    ];
    chosen.erase_with = vec![
        EraseWith { kind: "availability-link".into(), with: vec![by("availability-reservation", "availability-reservation/by-link")] },
        EraseWith {
            kind: "availability-reservation".into(),
            with: vec![by("availability-reservation-hold", "availability-reservation-hold/by-reservation"), by("availability-operation", "availability-operation/by-reservation")],
        },
    ];
    assert!(chosen.valid());
    Box::leak(Box::new(chosen))
}

// Old test/availability-link-eeaf-store.test.mjs:222 'record-log erasure cascades through availability reservations,
// holds and private operation inputs' (the engine half the Workshop's README names as a gap). For a person: erasing a
// booking link erases its reservations, their interval holds and their operations, together, and nothing else.
#[test]
fn erasing_a_booking_link_erases_its_reservations_holds_and_operations_together() {
    let dir = tempfile::tempdir().unwrap();
    let chosen = booking();
    let mut store = open(&dir.path().join("r.sqlite"), chosen);
    for declared in &chosen.orders {
        fill(&mut store, &declared.order, 10);
    }
    let link = |id: &str| json!({ "kind": "availability-link", "id": id, "title": id });
    let reservation = |id: &str, link: &str| json!({ "kind": "availability-reservation", "id": id, "link_id": link, "recipient": { "email": "guest@example.test" } });
    let hold = |reservation: &str| json!({ "kind": "availability-reservation-hold", "reservation_id": reservation, "calendar_identity": "cal" });
    let operation = |reservation: &str| json!({ "kind": "availability-operation", "reservation_id": reservation, "effect_input": { "attendees": ["guest@example.test"] } });
    store.mutate_many(A, R, vec![
        change("availability-link:erase-link", 0, &key(), link("erase-link")),
        change("availability-link:kept-link", 0, &key(), link("kept-link")),
        change("availability-reservation:r1", 0, &key(), reservation("r1", "erase-link")),
        change("availability-reservation:r2", 0, &key(), reservation("r2", "erase-link")),
        change("availability-reservation:r3", 0, &key(), reservation("r3", "kept-link")),
        change("availability-reservation-hold:r1:current:0", 0, &key(), hold("r1")),
        change("availability-reservation-hold:r1:pending:0", 0, &key(), hold("r1")),
        change("availability-reservation-hold:r3:current:0", 0, &key(), hold("r3")),
        change("availability-operation:op1", 0, &key(), operation("r1")),
    ]).unwrap();
    let erased = store.erase_cascading(A, R, "availability-link:erase-link").unwrap();
    assert_eq!(erased[0], "availability-link:erase-link", "the asked record first");
    let mut also: Vec<&str> = erased[1..].iter().map(String::as_str).collect();
    also.sort();
    assert_eq!(also, ["availability-operation:op1", "availability-reservation-hold:r1:current:0", "availability-reservation-hold:r1:pending:0",
        "availability-reservation:r1", "availability-reservation:r2"]);
    for gone in &erased {
        assert_eq!(read(&store, gone), None, "{gone} is erased");
    }
    for kept in ["availability-link:kept-link", "availability-reservation:r3", "availability-reservation-hold:r3:current:0"] {
        assert!(read(&store, kept).is_some(), "{kept} is another link's and stays");
    }
    assert!(store.erase_cascading(A, R, "availability-link:erase-link").unwrap().is_empty(), "an erased record has nothing left to erase");
}

// For a person: a cascade that cannot be followed whole (an order it reads is not filled yet) erases nothing.
#[test]
fn a_cascade_that_cannot_be_followed_whole_erases_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.sqlite");
    let mut plain = open(&path, with_orders(Vec::new()));
    put(&mut plain, "availability-link:l", json!({ "kind": "availability-link" }));
    put(&mut plain, "availability-reservation:r", json!({ "kind": "availability-reservation", "link_id": "l" }));
    drop(plain);
    let mut store = open(&path, booking());
    assert!(store.erase_cascading(A, R, "availability-link:l").is_err(), "the reservations' order is not filled: refused");
    assert!(read(&store, "availability-link:l").is_some() && read(&store, "availability-reservation:r").is_some(), "nothing was erased");
    for declared in &booking().orders {
        fill(&mut store, &declared.order, 10);
    }
    assert_eq!(store.erase_cascading(A, R, "availability-link:l").unwrap(), ["availability-link:l", "availability-reservation:r"]);
}

// L13 (its lone-surrogate half). For a person: a record's text keeps an unpaired UTF-16 surrogate exactly, across a
// reopen, as old trillion's JSON did. A record the door keeps holds its value as exact ECMA JSON text (`stored`, the
// native seam's stored form), which ecma_json reads as UTF-16 code units; a lone surrogate is never replaced or refused.
#[test]
fn l13_a_lone_surrogate_in_a_records_text_reads_back_exact_after_a_reopen() {
    use trillion_local::{ecma_json, legacy_records::StoredRecord, storage::record_store::native};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.sqlite");
    let chosen = with_orders(Vec::new());
    let mut store = open(&path, chosen);
    let text = r#"{"label":"\ud800 needle \udfff 🪡","pair":"🪡","nil":null,"no":false,"empty":""}"#;
    let record = StoredRecord { id: "json-chunks".into(), record_type: "note".into(), sequence: "seq-1".into(), value_json: text.into(), meta_json: None, protected_key_present: false };
    put(&mut store, "json-chunks", native::body(&record));
    drop(store);
    let store = open(&path, chosen);
    let held = native::stored_form("json-chunks", &read(&store, "json-chunks").unwrap()).unwrap();
    assert_eq!(held.value_json, text, "the stored text is byte for byte what was written");
    let limits = ecma_json::Limits::default();
    let parsed = ecma_json::parse(held.value_json.as_bytes(), limits).unwrap();
    let again = ecma_json::stringify(&parsed, limits).unwrap();
    assert!(again.contains(r"\ud800") && again.contains(r"\udfff"), "the lone surrogates survive a parse and stringify: {again}");
    assert_eq!(ecma_json::parse(again.as_bytes(), limits).unwrap(), parsed, "and read the same again");
}

// Ported from old trillion test/source-health-bounded.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243: "field reads answer named fields of many records without assembling any". The old
// record engine's field reads (`fields.after`, `newestPerGroup`, `fieldsOf`, `idsWhere`) are this record store's declared
// orders and their carried fields (order_reads.rs: `ordered_scan` with `carried`, `ids_where`) and its point reads; 3000
// old arrivals of 4000 words' characters each and three recent ones are seeded as the old test seeds them. The old byte
// counts of a counting SQLite handle are the store's own work count here (`work`: seeks and rows read), held to the few
// rows the reads answer, never a whole kind. The old second test (readHealth, the Automations screen's Sources) belongs
// to trillion-workshop tools/keep-and-wake-ai-sessions-on-this-computer/src/events.mjs and is not ported here.
#[test]
fn old_source_health_bounded_field_reads_answer_named_fields_of_many_records_without_assembling_any() {
    const OLD: usize = 3000;
    const BATCH: usize = 48;
    let words = "w".repeat(4000);
    let routes = ["Apple Notes", "Email", "Claude"];
    let now = chrono::DateTime::parse_from_rfc3339("2026-09-30T12:00:00.000Z").unwrap();
    let at = |time: chrono::DateTime<chrono::FixedOffset>| time.to_utc().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let start = chrono::DateTime::parse_from_rfc3339("2026-04-01T00:00:00.000Z").unwrap();
    let arrival = |i: usize, route: &str, when: String| json!({ "kind": "arrival", "job": format!("{i} {words}"), "route": route,
        "source_id": format!("s{i}"), "at": when, "message_id": format!("message:{i}"), "from_person": true, "title": format!("Note {i}") });
    let carried = |name: &str, path: &[&str], then: &[&[&str]], carry: &[&str]| {
        let mut declared = order(name, "arrival", path, then);
        declared.carry = carry.iter().map(|field| vec![field.to_string()]).collect();
        declared
    };
    let orders = vec![
        carried("arrival/at", &["at"], &[], &["route"]),
        carried("arrival/route_at", &["route"], &[&["at"]], &["title"]),
        order("arrival/message_id", "arrival", &["message_id"], &[]),
    ];
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(&dir.path().join("arrivals.sqlite"), with_orders(orders.clone()));
    for declared in &orders {
        fill(&mut store, &declared.order, 100);
    }
    for from in (0..OLD).step_by(BATCH) {
        let batch: Vec<Mutation> = (from..(from + BATCH).min(OLD))
            .map(|i| change(&format!("arrival:{i:06}"), 0, &key(), arrival(i, routes[i % 3], at(start + chrono::Duration::minutes(i as i64)))))
            .collect();
        store.mutate_many(A, R, batch).unwrap();
    }
    for (i, route, hours) in [(900001, "Email", 2), (900004, "Email", 5), (900003, "Apple Notes", 72)] {
        put(&mut store, &format!("arrival:{i:06}"), arrival(i, route, at(now - chrono::Duration::hours(hours))));
    }
    remove(&mut store, "arrival:000007");
    put(&mut store, "message:10", json!({ "kind": "message", "route": "Email", "at": "2026-04-01T00:10:00.000Z" }));
    let before = store.work();

    let week_ago = at(now - chrono::Duration::days(7));
    let recent = store.ordered_scan(A, R, "arrival/at", &OrderScan { from: Some(json!(week_ago)), limit: 100, carried: true, ..OrderScan::default() }).unwrap();
    let routes_of: Vec<(String, String)> = recent.iter().map(|e| (e.id.clone(), carried_text(e, "route"))).collect();
    assert_eq!(routes_of, [("arrival:900003", "Apple Notes"), ("arrival:900004", "Email"), ("arrival:900001", "Email")].map(|(id, route)| (id.to_owned(), route.to_owned())));
    let mut newest: Vec<(String, String, String)> = routes.iter().map(|route| {
        let entry = store.ordered_scan(A, R, "arrival/route_at", &OrderScan { equal: vec![json!(route)], reverse: true, limit: 1, carried: true, ..OrderScan::default() })
            .unwrap().pop().expect("each place has its newest arrival");
        (route.to_string(), entry.id.clone(), carried_text(&entry, "title"))
    }).collect();
    newest.sort();
    assert_eq!(newest, [("Apple Notes", "arrival:900003", "Note 900003"), ("Claude", "arrival:002999", "Note 2999"), ("Email", "arrival:900001", "Note 900001")]
        .map(|(a, b, c)| (a.to_owned(), b.to_owned(), c.to_owned())));
    let fields_of: Vec<(String, Value, Value)> = ["arrival:000010", "arrival:000007", "message:10"].iter()
        .filter_map(|id| store.get(A, R, id).unwrap().record)
        .filter(|record| record.value["kind"] == "arrival")
        .map(|record| (record.id.clone(), record.value["route"].clone(), record.value["at"].clone()))
        .collect();
    assert_eq!(fields_of, [("arrival:000010".to_owned(), json!("Email"), json!("2026-04-01T00:10:00.000Z"))], "a removed record and another kind answer nothing");
    assert_eq!(store.ids_where(A, R, "arrival/message_id", &json!("message:12"), 100).unwrap(), ["arrival:000012"]);
    assert!(store.ids_where(A, R, "arrival/message_id", &json!("message:7"), 100).unwrap().is_empty(), "a removed record is never answered");
    let work = store.work();
    assert!(work.rows_read - before.rows_read < 64, "the reads took {} rows of a store holding {OLD} arrivals: the rows answered, never a kind",
        work.rows_read - before.rows_read);
}

fn carried_text(entry: &OrderEntry, field: &str) -> String {
    let carried = entry.carried.as_ref().expect("the order answers its carried fields");
    let value = carried.get(field).or_else(|| carried.as_array().and_then(|values| values.first())).cloned().unwrap_or(Value::Null);
    value.as_str().map(str::to_owned).unwrap_or_else(|| panic!("carried {field}: {carried}"))
}
