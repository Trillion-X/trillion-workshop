// tests/records_conformance.rs
//
// Purpose: One conformance suite for the versioned-record contract (`trillion_local::records::Records`), run against
// every store that supplies it: the record store on the in-memory supply, the record store on the SQLite supply, and the
// old flat SQLite store (`store::Store`) for the parts of the contract it has.
//
// Non-Negotiable Invariants:
// - The same test body runs against each store; a store-specific branch in a test is a defect of the suite.
// - Crash and retry: a commit that fails before it lands leaves nothing; a commit that lands but loses its reply is
//   answered with the first change when retried after a restart, never applied twice.
// - record store-only properties (as-of in one row whatever the history, destruction custody and exit, the search port, rows
//   written per change) run on both supplies.
//
// Key Concepts:
// - `Engine`: opens a fresh store, and reopens it after a crash on the same durable rows.
// - `Faulty`: a storage supply wrapper that fails the next commit before or after it lands.
//
// Security Considerations:
// - Scratch storage only; no account, original or live data is read.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde_json::{json, Value};
use std::{
    cell::Cell,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use trillion_local::{
    records::{Error, Mutation, Records},
    storage::{
        memory::Memory,
        record_store::{
            search::Layout,
            orders::Declared,
            settings::{self as record_store_settings, Budget, Limits, Receipts, Settings, UndoWindows, Volume},
            Clock, OrderCursor, RecordStore, CURRENT,
        },
        hosted_sql,
        sqlite::{self, hosted_stand_in, Bounds, Spend},
        Intent, Range, Read, Row, Schema, Storage, Value as Stored, When, Write,
    },
    store::Store,
};

const A: &str = "account";
// A declared resource (src/storage/record_store_resources.json): record store refuses every other name.
const R: &str = "own-records";
const DAY_MS: u64 = 86_400_000;

/// A test clock the suite moves by hand.
#[derive(Clone)]
struct Manual(Arc<AtomicU64>);
impl Manual {
    fn new() -> Self {
        Self(Arc::new(AtomicU64::new(1_800_000_000_000)))
    }
    fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}
impl Clock for Manual {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst) as i64
    }
}

/// The settings the suite uses: the shipped shape with a one-day receipt window, a two-day undo window, search
/// segments flushed at 8 records (256-byte parts, fan-in 4) so a short test crosses flushes and merges, and one
/// declared order (`note/created_at`). Each store names its own limits (`conformance_limits`).
fn settings() -> &'static Settings {
    Box::leak(Box::new(Settings {
        what: "conformance".into(),
        receipts: Receipts { window_ms: DAY_MS, max_entries: 8 },
        undo_windows: UndoWindows { why: String::new(), records: 2 * DAY_MS, vault: DAY_MS },
        exit_step_rows: 64,
        reclaim_step_pages: 1024,
        kind_field: "kind".into(),
        search: Layout::Segments {
            fields: vec!["title".into(), "text".into()],
            flush_records: 8,
            flush_seconds: 86_400,
            part_bytes: 256,
            fan_in: 4,
            within: None,
            every_text: None,
            walk_rows: 8,
            merge_bytes: 1024,
        },
        orders: vec![Declared {
            why: "conformance".into(),
            order: "note/created_at".into(),
            kind: Some("note".into()),
            path: vec!["created_at".into()],
            then: Vec::new(),
            carry: Vec::new(),
        }],
        // No declared totals: the rows-per-operation this suite measures stay the record's own (totals are measured
        // in tests/record_store_totals.rs).
        totals: Vec::new(),
        computer_record_bytes: 1 << 20,
        // The shipped size rows, volume stores, history bound and page size: the suite's stores are far below every
        // level, so replaced versions keep the undo window above.
        ..trillion_local::storage::record_store::settings::shipped().expect("shipped settings").clone()
    }))
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
    Bounds {
        value_bytes: 2 * 1024 * 1024,
        work: u64::MAX / 2,
        deadline: Duration::MAX,
        spend: Spend::EachOperation,
        cancel: None,
        busy: Duration::from_secs(5),
    }
}

/// One store under test: open fresh, and reopen on the same durable rows after a crash.
enum Engine {
    Memory { root: Memory, clock: Manual },
    Sqlite { _dir: tempfile::TempDir, path: PathBuf, clock: Manual },
    /// SQLite a computer's host lends only through one statement call (`storage::hosted_sql`), over the native
    /// stand-in of that call (`sqlite::hosted_stand_in`).
    Hosted { _dir: tempfile::TempDir, path: PathBuf, clock: Manual },
    OldStore { _dir: tempfile::TempDir, path: PathBuf },
}
impl Engine {
    fn all() -> Vec<Engine> {
        let mut engines = Self::record_stores();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.sqlite");
        engines.push(Self::OldStore { _dir: dir, path });
        engines
    }
    fn record_stores() -> Vec<Engine> {
        let dir = tempfile::tempdir().unwrap();
        // The supply refuses a path through a symbolic link (macOS /var is one), so the suite names the real folder.
        let path = dir.path().canonicalize().unwrap().join("s2h.sqlite");
        vec![
            Self::Memory { root: Memory::open("record_store").unwrap(), clock: Manual::new() },
            Self::Sqlite { _dir: dir, path, clock: Manual::new() },
            Self::hosted(),
        ]
    }
    fn hosted() -> Engine {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("hosted.sqlite");
        Self::Hosted { _dir: dir, path, clock: Manual::new() }
    }
    fn hosted_supply(path: &std::path::Path) -> hosted_sql::Supply<hosted_stand_in::StandIn> {
        hosted_sql::open(hosted_stand_in::open(path).unwrap(), "record_store", bounds().value_bytes as usize).unwrap()
    }
    fn name(&self) -> &'static str {
        match self {
            Self::Memory { .. } => "record_store/memory",
            Self::Sqlite { .. } => "record_store/sqlite",
            Self::Hosted { .. } => "record_store/hosted",
            Self::OldStore { .. } => "old store",
        }
    }
    /// A record store on this store's durable rows (a restart when one existed before).
    fn open(&self) -> Box<dyn Records> {
        match self {
            Self::OldStore { path, .. } => Box::new(Store::open(path).unwrap()),
            _ => Box::new(self.record_store(Fault::None)),
        }
    }
    fn clock(&self) -> Manual {
        match self {
            Self::Memory { clock, .. } | Self::Sqlite { clock, .. } | Self::Hosted { clock, .. } => clock.clone(),
            Self::OldStore { .. } => Manual::new(),
        }
    }
    /// Another handle on this store's durable rows, open at the same time as the others (another connection).
    fn supply(&self) -> Box<dyn StorageSend> {
        match self {
            Self::Memory { root, .. } => Box::new(root.reopen()),
            Self::Sqlite { path, .. } => Box::new(sqlite::open_owned(path, "record_store", bounds()).unwrap()),
            Self::Hosted { path, .. } => Box::new(Self::hosted_supply(path)),
            Self::OldStore { .. } => unreachable!("the old store is not a record store supply"),
        }
    }
    /// The record store whose next commit fails as told, with the suite's settings.
    fn record_store(&self, fault: Fault) -> RecordStore<Faulty<Box<dyn StorageSend>>> {
        self.record_store_with(fault, u64::MAX / 2)
    }
    /// The store with a 1 MiB record bound and `byte_budget`.
    fn record_store_with(&self, fault: Fault, byte_budget: u64) -> RecordStore<Faulty<Box<dyn StorageSend>>> {
        let settings = settings();
        let (inner, clock): (Box<dyn StorageSend>, Manual) = match self {
            Self::Memory { root, clock } => (Box::new(root.reopen()), clock.clone()),
            Self::Hosted { path, clock, .. } => (Box::new(Self::hosted_supply(path)), clock.clone()),
            Self::Sqlite { path, clock, .. } => {
                (Box::new(sqlite::open_owned(path, "record_store", bounds()).unwrap()), clock.clone())
            }
            Self::OldStore { .. } => unreachable!("the old store is not a record store supply"),
        };
        RecordStore::with_settings(Faulty { inner, next: Cell::new(fault) }, Box::new(clock), settings, Limits::fixed(1 << 20, byte_budget)).unwrap()
    }
}

/// A supply the store can own across threads.
trait StorageSend: Storage + Send {}
impl<S: Storage + Send> StorageSend for S {}
// `Box<dyn StorageSend>` is a supply through the storage boundary's own pointer impl (`storage_through!`).

fn put(id: &str, expected: i64, key: &str, value: Value) -> Mutation {
    Mutation { id: id.into(), expected_version: expected, request_key: key.into(), deleted: false, value }
}
fn delete(id: &str, expected: i64, key: &str) -> Mutation {
    Mutation { id: id.into(), expected_version: expected, request_key: key.into(), deleted: true, value: Value::Null }
}
fn rows(storage: &dyn Storage, family: &str) -> u64 {
    storage.count(family, &Range::all()).unwrap()
}

#[test]
fn versions_compare_and_set_and_deletes_hide_records() {
    for engine in Engine::all() {
        let name = engine.name();
        let mut store = engine.open();
        let created = store.mutate(A, R, put("n1", 0, "k1", json!({"title": "one"}))).unwrap();
        assert_eq!((created.version, created.deleted), (1, false), "{name}");
        assert_eq!(store.get(A, R, "n1").unwrap().record.unwrap().value, json!({"title": "one"}), "{name}");
        assert_eq!(store.mutate(A, R, put("n1", 0, "k2", json!({}))).unwrap_err(), trillion_local::cause!(Error::Conflict), "{name}");
        assert_eq!(store.mutate(A, R, put("n1", 5, "k3", json!({}))).unwrap_err(), trillion_local::cause!(Error::Conflict), "{name}");
        assert_eq!(store.mutate(A, R, delete("nope", 0, "k4")).unwrap_err(), trillion_local::cause!(Error::Conflict), "{name}");
        let updated = store.mutate(A, R, put("n1", 1, "k5", json!({"title": "two"}))).unwrap();
        assert!(updated.sequence > created.sequence, "{name}: sequences increase");
        let gone = store.mutate(A, R, delete("n1", 2, "k6")).unwrap();
        assert_eq!((gone.version, gone.deleted, gone.value), (3, true, None), "{name}");
        assert!(store.get(A, R, "n1").unwrap().record.is_none(), "{name}");
        assert!(store.list_page(A, R, "", 10).unwrap().items.is_empty(), "{name}");
        assert!(matches!(
            store.mutate(A, R, Mutation { value: json!(1), ..delete("n1", 3, "k7") }),
            Err(Error::Invalid(_, _))
        ));
        let other_scope = store.get("other", R, "n1").unwrap();
        assert!(other_scope.record.is_none(), "{name}: scopes are separate");
    }
}

#[test]
fn retries_return_the_first_change_and_refuse_changed_input() {
    for engine in Engine::all() {
        let name = engine.name();
        let mut store = engine.open();
        let first = store.mutate(A, R, put("r", 0, "create", json!({"text": "a"}))).unwrap();
        let again = store.mutate(A, R, put("r", 0, "create", json!({"text": "a"}))).unwrap();
        assert_eq!(first, again, "{name}: same key, same input -> the first change");
        assert_eq!(
            store.mutate(A, R, put("r", 0, "create", json!({"text": "b"}))).unwrap_err(),
            trillion_local::cause!(Error::Conflict),
            "{name}: same key, changed input"
        );
        store.mutate(A, R, put("r", 1, "edit", json!({"text": "c"}))).unwrap();
        let late = store.mutate(A, R, put("r", 0, "create", json!({"text": "a"}))).unwrap();
        assert_eq!(late, first, "{name}: a retry after later changes still gets its own change");
        assert_eq!(store.get(A, R, "r").unwrap().record.unwrap().version, 2, "{name}: applied once");
        let removed = store.mutate(A, R, delete("r", 2, "remove")).unwrap();
        assert_eq!(store.mutate(A, R, delete("r", 2, "remove")).unwrap(), removed, "{name}: retried delete");
    }
}

#[test]
fn crash_before_commit_leaves_nothing_and_crash_after_commit_answers_the_retry() {
    for engine in Engine::record_stores() {
        let name = engine.name();
        {
            let mut store = engine.record_store(Fault::BeforeCommit);
            let lost = store.mutate(A, R, put("c", 0, "first", json!({"text": "x"})));
            assert!(matches!(lost.unwrap_err(), Error::OutcomeUnknown(_)), "{name}");
        }
        let mut store = engine.open();
        assert!(store.get(A, R, "c").unwrap().record.is_none(), "{name}: nothing landed");
        drop(store);
        let landed = {
            let mut store = engine.record_store(Fault::AfterCommit);
            let unknown = store.mutate(A, R, put("c", 0, "first", json!({"text": "x"})));
            assert!(matches!(unknown.unwrap_err(), Error::OutcomeUnknown(_)), "{name}");
            // The same store keeps going after the uncertain commit: its next stamp is recovered, not reused.
            let after = store.mutate(A, R, put("d", 0, "other", json!({}))).unwrap();
            after.sequence
        };
        store = engine.open();
        let retried = store.mutate(A, R, put("c", 0, "first", json!({"text": "x"}))).unwrap();
        assert_eq!(retried.version, 1, "{name}: the landed change is the answer");
        assert!(retried.sequence < landed, "{name}: stamps stay unique and ordered across the uncertain commit");
        assert_eq!(store.get(A, R, "c").unwrap().record.unwrap().version, 1, "{name}: applied once");
    }
    // The old store has no supply seam to fail a commit; a restart and a retry is its whole crash story.
    let engine = Engine::all().pop().unwrap();
    let first = engine.open().mutate(A, R, put("c", 0, "first", json!({"text": "x"}))).unwrap();
    assert_eq!(engine.open().mutate(A, R, put("c", 0, "first", json!({"text": "x"}))).unwrap(), first);
}

#[test]
fn list_pages_walk_live_records_in_id_order_with_explicit_continuation() {
    for engine in Engine::all() {
        let name = engine.name();
        let mut store = engine.open();
        for n in 0..25 {
            store.mutate(A, R, put(&format!("id-{n:02}"), 0, &format!("c{n}"), json!({"n": n}))).unwrap();
        }
        for n in (0..25).step_by(5) {
            store.mutate(A, R, delete(&format!("id-{n:02}"), 1, &format!("d{n}"))).unwrap();
        }
        let mut seen = Vec::new();
        let mut after = String::new();
        loop {
            let page = store.list_page(A, R, &after, 7).unwrap();
            seen.extend(page.items.iter().map(|record| record.id.clone()));
            match page.next {
                Some(next) => after = next,
                None => break,
            }
        }
        let expected: Vec<String> = (0..25).filter(|n| n % 5 != 0).map(|n| format!("id-{n:02}")).collect();
        assert_eq!(seen, expected, "{name}");
    }
}

#[test]
fn the_change_feed_brings_a_feed_reader_to_the_current_state() {
    for engine in Engine::all() {
        let name = engine.name();
        let mut store = engine.open();
        for n in 0..6 {
            store.mutate(A, R, put(&format!("f{n}"), 0, &format!("c{n}"), json!({"v": 1}))).unwrap();
        }
        store.mutate(A, R, put("f1", 1, "u1", json!({"v": 2}))).unwrap();
        store.mutate(A, R, delete("f2", 1, "x2")).unwrap();
        let mut rebuilt = std::collections::BTreeMap::new();
        let mut cursor = 0;
        loop {
            let page = store.changes_page(A, R, cursor, 3).unwrap();
            for change in &page.items {
                if change.deleted {
                    rebuilt.remove(&change.id);
                } else {
                    rebuilt.insert(change.id.clone(), change.value.clone().unwrap());
                }
            }
            match page.next {
                Some(next) => cursor = next,
                None => break,
            }
        }
        let current: std::collections::BTreeMap<String, Value> =
            store.list_page(A, R, "", 100).unwrap().items.into_iter().map(|r| (r.id, r.value)).collect();
        assert_eq!(rebuilt, current, "{name}");
    }
}

#[test]
fn as_of_reads_one_row_whatever_the_history_size() {
    for engine in Engine::record_stores() {
        let name = engine.name();
        let mut store = engine.record_store(Fault::None);
        let mut proofs = Vec::new();
        for (id, versions) in [("ten", 10_i64), ("hundred-thousand", 100_000)] {
            let mut stamps = Vec::new();
            for v in 0..versions {
                let change = store.mutate(A, R, put(id, v, &format!("{id}-{v}"), json!({"v": v + 1}))).unwrap();
                stamps.push(change.sequence);
            }
            for probe in [0, versions as usize / 2, versions as usize - 1] {
                let before = store.work();
                let read = store.as_of(A, R, id, stamps[probe]).unwrap();
                let after = store.work();
                assert_eq!(read.record.unwrap().value, json!({"v": probe as i64 + 1}), "{name} {id} v{probe}");
                proofs.push((id, probe, after.seeks - before.seeks, after.rows_read - before.rows_read));
            }
            let before_first = store.as_of(A, R, id, stamps[0] - 1).unwrap();
            assert!(before_first.record.is_none(), "{name}: nothing before the create");
        }
        println!("{name} as-of (record, version index, seeks, rows read): {proofs:?}");
        assert!(proofs.iter().all(|(_, _, seeks, rows)| *seeks == 1 && *rows == 1), "{name}: {proofs:?}");
    }
}

#[test]
fn rows_written_per_change_are_one_plus_orders_on_create_and_two_plus_orders_on_update() {
    for engine in Engine::record_stores() {
        let name = engine.name();
        let mut store = engine.record_store(Fault::None);
        let written = |store: &RecordStore<Faulty<Box<dyn StorageSend>>>| store.storage().changes();
        let start = written(&store);
        store.mutate(A, R, put("w", 0, "c", json!({"n": 1}))).unwrap();
        let create = written(&store) - start;
        let start = written(&store);
        store.mutate(A, R, put("w", 1, "u", json!({"n": 2}))).unwrap();
        let update = written(&store) - start;
        let start = written(&store);
        store.mutate(A, R, put("w", 2, "t", json!({"n": 3, "title": "hello world"}))).unwrap();
        let update_with_terms = written(&store) - start;
        println!("{name} table rows written: create {create}, update {update}, update that adds terms {update_with_terms}");
        assert_eq!((create, update, update_with_terms), (1, 2, 2), "{name}: new terms wait in the search tail (0 rows)");
    }
}

#[test]
fn erase_is_unreachable_at_once_restorable_in_the_window_and_gone_after_it() {
    for engine in Engine::record_stores() {
        let name = engine.name();
        let clock = engine.clock();
        let mut store = engine.record_store(Fault::None);
        let first = store.mutate(A, R, put("e", 0, "c", json!({"title": "secret plan"}))).unwrap();
        store.mutate(A, R, put("e", 1, "u", json!({"title": "secret plan two"}))).unwrap();
        let erased = store.erase(A, R, "e").unwrap().unwrap();
        assert_eq!(erased.versions, 2, "{name}");
        assert!(store.get(A, R, "e").unwrap().record.is_none(), "{name}: current");
        assert!(store.as_of(A, R, "e", first.sequence).unwrap().record.is_none(), "{name}: history");
        assert!(store.search(A, R, None, "secret", 10).unwrap().records.is_empty(), "{name}: search");
        assert!(store.list_page(A, R, "", 10).unwrap().items.is_empty(), "{name}: list");
        let feed = store.changes_page(A, R, 0, 10).unwrap();
        assert!(feed.items.iter().all(|change| change.deleted && change.value.is_none()), "{name}: feed");
        assert!(!parts_mention(store.storage(), "e"), "{name}: no search part holds the destroyed record");
        let retried = store.mutate(A, R, put("e", 0, "c", json!({"title": "secret plan"}))).unwrap();
        assert_eq!(
            (retried.sequence, retried.version, retried.value),
            (first.sequence, 1, None),
            "{name}: a retried create is answered from the tombstone's receipts, never re-applied or disclosed"
        );
        assert!(store.restore(&erased, A, R, "e").unwrap(), "{name}: the operator restores inside the window");
        let restored = store.get(A, R, "e").unwrap().record.unwrap();
        assert_eq!(restored.value["title"], "secret plan two", "{name}");
        // A restore is a new version at a new stamp (one above the erase's tombstone), so a change feed carries it.
        assert_eq!(restored.version, 4, "{name}: the restore is a new version");
        let feed = store.changes_page(A, R, erased.erased_at, 10).unwrap();
        assert!(feed.items.iter().any(|change| change.id == "e" && !change.deleted), "{name}: the feed after the erase carries the restore");
        assert!(store.as_of(A, R, "e", erased.erased_at).unwrap().record.is_none(), "{name}: deleted between the erase and the restore");
        assert_eq!(store.as_of(A, R, "e", first.sequence).unwrap().record.unwrap().value["title"], "secret plan", "{name}: history is back");
        assert_eq!(store.search(A, R, Some("title"), "plan", 10).unwrap().records.len(), 1, "{name}");
        let erased = store.erase(A, R, "e").unwrap().unwrap();
        // The two versions, the first erase's tombstone and the restored version.
        assert_eq!(rows(store.storage(), "custody"), 4, "{name}");
        clock.advance(2 * DAY_MS + 1);
        let removed = store.retire(A, R).unwrap();
        assert_eq!(rows(store.storage(), "versions"), 0, "{name}");
        if store.storage().overwrites_removed().unwrap() {
            assert!(removed >= 3, "{name}: custody and the tombstone leave ({removed})");
            assert_eq!(rows(store.storage(), "custody"), 0, "{name}");
            assert!(!store.restore(&erased, A, R, "e").unwrap(), "{name}: nothing left to restore");
        } else {
            // A supply whose removals do not overwrite the removed bytes (a host that does not say it does) keeps a
            // destroyed record in custody, unreachable, so its bytes never sit in free space; only the tombstone leaves.
            assert_eq!((removed, rows(store.storage(), "custody")), (1, 4), "{name}: custody stays where removals do not overwrite");
            assert!(store.get(A, R, "e").unwrap().record.is_none(), "{name}: the destroyed record stays unreachable");
        }
    }
}

#[test]
fn replaced_versions_and_tombstones_leave_when_the_undo_window_ends() {
    for engine in Engine::record_stores() {
        let name = engine.name();
        let clock = engine.clock();
        let mut store = engine.record_store(Fault::None);
        store.mutate(A, R, put("h", 0, "1", json!({"v": 1}))).unwrap();
        store.mutate(A, R, put("h", 1, "2", json!({"v": 2}))).unwrap();
        store.mutate(A, R, put("t", 0, "3", json!({"v": 1}))).unwrap();
        let deleted = store.mutate(A, R, delete("t", 1, "4")).unwrap();
        assert_eq!(rows(store.storage(), "versions"), 4, "{name}: two current, two replaced");
        clock.advance(DAY_MS);
        store.mutate(A, R, put("other", 0, "5", json!({}))).unwrap();
        assert_eq!(rows(store.storage(), "versions"), 5, "{name}: inside the window nothing leaves");
        assert!(store.as_of(A, R, "t", deleted.sequence - 1).unwrap().record.is_some(), "{name}: history readable");
        clock.advance(DAY_MS + 1);
        store.mutate(A, R, put("other", 1, "6", json!({"n": 2}))).unwrap();
        let left: Vec<(String, i64)> = store
            .storage()
            .scan("versions", &Range::all(), &[Read::whole("id"), Read::whole("valid_to")])
            .unwrap()
            .into_iter()
            .map(|mut row| (row.take(0).as_text().unwrap().to_owned(), row.take(1).as_integer().unwrap()))
            .collect();
        assert_eq!(
            left.iter().map(|(id, to)| (id.as_str(), *to == CURRENT)).collect::<Vec<_>>(),
            [("h", true), ("other", false), ("other", true)],
            "{name}: the replaced version of h and the tombstone of t left; other's fresh history stays"
        );
    }
}

/// Whether any persisted search part names record `id` in a posting.
fn parts_mention(storage: &dyn Storage, id: &str) -> bool {
    // A part body is the packed form (src/storage/record_store/segments.rs `encode_part`: first byte 1, then the part's
    // table of record ids, each written once as a varint length and its bytes) or the earlier JSON form (`"k":"<id>"`).
    let json = format!("\"k\":\"{id}\"");
    let mut packed = Vec::new();
    let mut len = id.len() as u64;
    while len >= 0x80 {
        packed.push(len as u8 | 0x80);
        len >>= 7;
    }
    packed.push(len as u8);
    packed.extend_from_slice(id.as_bytes());
    storage
        .scan("search_parts", &Range::all(), &[Read::whole("body")])
        .unwrap()
        .into_iter()
        .any(|mut row| match row.take(0) {
            Stored::Blob(body) if body.first() == Some(&1) => body.windows(packed.len()).any(|window| window == packed),
            Stored::Blob(body) => String::from_utf8_lossy(&body).contains(&json),
            _ => false,
        })
}

/// The newest-first ids whose current title or text holds `word`, from a plain model of the current values.
fn expected_hits(model: &std::collections::BTreeMap<String, (u64, String)>, word: &str, limit: usize) -> Vec<String> {
    let mut hits: Vec<(u64, String)> = model
        .iter()
        .filter(|(_, (_, title))| title.split(' ').any(|held| held == word))
        .map(|(id, (at, _))| (*at, id.clone()))
        .collect();
    hits.sort_by(|a, b| b.0.cmp(&a.0));
    hits.into_iter().take(limit).map(|(_, id)| id).collect()
}

#[test]
fn search_segments_are_exact_cheap_to_write_bounded_to_restart_and_erased_with_the_record() {
    const WORDS: [&str; 6] = ["alpha", "beta", "gamma", "delta", "omega", "zeta"];
    for engine in Engine::record_stores() {
        let name = engine.name();
        let clock = engine.clock();
        let mut store = engine.record_store(Fault::None);
        // The model: each live record's change order and title, to compare every search with.
        let mut model: std::collections::BTreeMap<String, (u64, String)> = Default::default();
        let mut versions: std::collections::BTreeMap<String, i64> = Default::default();
        let mut order = 0u64;
        let mut state = 7u64;
        let mut next = |n: u64| {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (state >> 33) % n
        };
        let (mut creates, mut create_rows) = (0u64, 0u64);
        for step in 0..300u64 {
            clock.advance(1);
            let id = format!("n{:03}", next(80));
            let held = versions.get(&id).copied().unwrap_or(0);
            let before = store.storage().changes();
            // A delete leaves a tombstone at the next version; a later put recreates the record from that version.
            if model.contains_key(&id) && next(6) == 0 {
                store.mutate(A, R, delete(&id, held, &format!("d{step}"))).unwrap();
                versions.insert(id.clone(), held + 1);
                model.remove(&id);
            } else {
                let title = format!("{} {} n{step}", WORDS[next(6) as usize], WORDS[next(6) as usize]);
                store.mutate(A, R, put(&id, held, &format!("p{step}"), json!({"title": title}))).unwrap();
                if held == 0 {
                    creates += 1;
                    create_rows += store.storage().changes() - before;
                }
                versions.insert(id.clone(), held + 1);
                order += 1;
                model.insert(id, (order, title));
            }
            if step % 37 == 0 {
                for word in WORDS {
                    let found = store.search(A, R, None, word, 10).unwrap();
                    let ids: Vec<String> = found.records.into_iter().map(|record| record.id).collect();
                    assert_eq!(ids, expected_hits(&model, word, 10), "{name}: step {step}, {word}");
                }
            }
        }
        let segments = rows(store.storage(), "search_segments");
        assert!(segments > 0, "{name}: flushes happened");
        println!("{name} search: {creates} creates wrote {create_rows} rows ({:.2} per create); {segments} segments", create_rows as f64 / creates as f64);

        // Warm search cost, then a restart: the first search rebuilds the tail from at most the unflushed changes.
        let warm = store.search(A, R, Some("title"), "omega", 20).unwrap();
        let warm_ids: Vec<String> = warm.records.iter().map(|record| record.id.clone()).collect();
        assert_eq!(warm_ids, expected_hits(&model, "omega", 20), "{name}");
        drop(store);
        let mut store = engine.record_store(Fault::None);
        let cold = store.search(A, R, Some("title"), "omega", 20).unwrap();
        let cold_ids: Vec<String> = cold.records.iter().map(|record| record.id.clone()).collect();
        assert_eq!(cold_ids, warm_ids, "{name}: a restart answers the same");
        let rebuild = cold.work["rows_read"].as_u64().unwrap() - warm.work["rows_read"].as_u64().unwrap();
        println!("{name} search rows read: warm {}, cold start +{rebuild} (segment metas + unflushed tail)", warm.work["rows_read"]);
        assert!(rebuild <= segments + 8, "{name}: the restart read {rebuild} rows");

        // Erasure rewrites the segments that hold the record; restore makes it searchable again, across a restart.
        let victim = model.iter().find(|(id, _)| parts_mention(store.storage(), id)).map(|(id, _)| id.clone()).unwrap();
        let erased = store.erase(A, R, &victim).unwrap().unwrap();
        assert!(!parts_mention(store.storage(), &victim), "{name}: no posting of the destroyed record remains");
        let (_, title) = model.remove(&victim).unwrap();
        let word = title.split(' ').next().unwrap().to_owned();
        let ids: Vec<String> = store.search(A, R, None, &word, 50).unwrap().records.into_iter().map(|r| r.id).collect();
        assert!(!ids.contains(&victim), "{name}: destroyed records are unreachable by search at once");
        assert!(store.restore(&erased, A, R, &victim).unwrap(), "{name}");
        drop(store);
        let store = engine.record_store(Fault::None);
        let ids: Vec<String> = store.search(A, R, None, &word, 50).unwrap().records.into_iter().map(|r| r.id).collect();
        assert!(ids.contains(&victim), "{name}: a restored record is searchable after a restart");

        // A quiet tail is persisted by the first write after flush_seconds, even below flush_records.
        let mut store = store;
        let before = rows(store.storage(), "search_segments");
        clock.advance(86_400_001);
        store.mutate(A, R, put("late", 0, "late", json!({"title": "zeta"}))).unwrap();
        clock.advance(86_400_001);
        store.mutate(A, R, put("later", 0, "later", json!({"title": "zeta"}))).unwrap();
        assert_ne!(rows(store.storage(), "search_segments"), before, "{name}: the day-old tail was persisted");
        assert!(matches!(store.search(A, R, Some("body"), "zeta", 5), Err(Error::Invalid(_, _))), "{name}: undeclared field");
    }
}

#[test]
fn the_byte_budget_refuses_a_change_that_would_exceed_it() {
    for engine in Engine::record_stores() {
        let name = engine.name();
        // The budget is the store's own empty allocation plus room for one 150 KB record: an engine's empty store
        // can already hold more than the record itself (the hosted stand-in's schema pages).
        let empty = engine.record_store_with(Fault::None, u64::MAX).storage().allocated_bytes().unwrap();
        let mut store = engine.record_store_with(Fault::None, empty + 200_000);
        let big = json!({"payload": "x".repeat(150_000)});
        store.mutate(A, R, put("b1", 0, "1", big.clone())).unwrap();
        let refused = store.mutate(A, R, put("b2", 0, "2", big.clone()));
        assert!(matches!(refused, Err(Error::Invalid(_, _))), "{name}: {refused:?}");
        assert!(store.get(A, R, "b2").unwrap().record.is_none(), "{name}: the refused change left nothing");
    }
}

#[test]
fn a_computer_keeps_its_own_limits() {
    // A computer's limits: the computer's record bound, and the byte budget its own report gives, sized to the disk.
    let volume = Volume { store_bytes: 12 << 30, free_bytes: 100 << 30 };
    let report = |storage| trillion_local::account::computers::ComputerReport {
        storage,
        reach: "https://computer.example".into(),
        cost_per_month_cents: 0,
        contained_tools: false,
        always_on: None,
        local_ports: Default::default(),
        program_folders: vec![],
        takes_new_accounts: false,
        sealed_versions: None,
        store_size: None,
        unknown_keys: Default::default(),
    };
    let computer = |storage| trillion_local::storage::record_store_resources::computer_limits_from(&report(storage), &volume).expect("computer limits");
    let roomy = computer(Budget::KeepFreeBytes(10 << 30));
    assert_eq!((roomy.max_record_bytes, roomy.byte_budget), (8 << 20, (12 << 30) + (90 << 30)), "keeps 10 GiB free");
    let small = computer(Budget::KeepFreeBytes(0));
    assert_eq!(small.byte_budget, (12 << 30) + (100 << 30), "a computer that reports no floor may use the whole disk");
    let fixed = computer(Budget::Bytes(1 << 20));
    assert_eq!(fixed.byte_budget, 1 << 20);
    assert!(record_store_settings::shipped().is_some());
    // A 2 MiB record: above a 1 MiB store's bound, inside the computer's.
    let big = json!({"payload": "x".repeat(2 << 20)});
    for (limits, kept) in [(Limits::fixed(1 << 20, 10 << 30), false), (roomy, true)] {
        let mut store = RecordStore::new(Memory::open("record_store").unwrap(), Box::new(Manual::new()), limits).unwrap();
        let answer = store.mutate(A, R, put("big", 0, "1", big.clone()));
        assert_eq!(answer.is_ok(), kept, "{limits:?}: {answer:?}");
        assert_eq!(store.import(A, R, &[("big2".into(), big.clone())]).is_ok(), kept, "{limits:?}: import");
    }
}

/// Old trillion's index order: the field's JSON text by UTF-16 code unit, then id.
fn index_order(a: &(String, String), b: &(String, String)) -> std::cmp::Ordering {
    a.0.encode_utf16().cmp(b.0.encode_utf16()).then_with(|| a.1.encode_utf16().cmp(b.1.encode_utf16()))
}

#[test]
fn ordered_pages_follow_the_declared_field_at_one_scan_plus_one_get_per_record() {
    for engine in Engine::record_stores() {
        let name = engine.name();
        let mut store = engine.record_store(Fault::None);
        // 40 notes with created_at (ties, numbers and strings, written out of order), 5 notes without it, 5 other kinds.
        let mut expected = Vec::new();
        for n in 0..40u64 {
            let at = match n % 4 {
                0 => json!(format!("2026-10-{:02}T10:00:00Z", 1 + (n * 7) % 28)),
                1 => json!(1_700_000_000_000u64 + (n * 13) % 50),
                2 => json!("2026-10-05T10:00:00Z"),
                _ => json!(format!("2026-09-{:02}", 1 + n % 9)),
            };
            let id = format!("note:{:02}", (n * 17) % 40);
            expected.push((serde_json::to_string(&at).unwrap(), id.clone()));
            store.mutate(A, R, put(&id, 0, "c", json!({"kind": "note", "created_at": at}))).unwrap();
        }
        for n in 0..5 {
            store.mutate(A, R, put(&format!("note:bare{n}"), 0, "c", json!({"kind": "note"}))).unwrap();
            store.mutate(A, R, put(&format!("other:{n}"), 0, "c", json!({"kind": "other", "created_at": "2026"}))).unwrap();
        }
        assert_eq!(rows(store.storage(), "ordered"), 40, "{name}: one row per covered record");
        // The scope held records before anyone filled the order: pages refuse until it is filled, a step at a time.
        assert!(matches!(store.ordered_page(A, R, "note/created_at", None, true, 5), Err(Error::Invalid(_, _))), "{name}: unfilled");
        let mut steps = 1;
        while !store.fill_order(A, R, "note/created_at", 7).unwrap() {
            steps += 1;
        }
        // The fill walks the order's own kind (old trillion buildIndexes walked the index's type): 45 notes, not 50.
        assert_eq!(steps, 7, "{name}: 45 live notes in steps of 7");
        assert_eq!(rows(store.storage(), "ordered"), 40, "{name}: filling rewrote, never duplicated");
        expected.sort_by(|a, b| index_order(b, a));
        let expected: Vec<String> = expected.into_iter().map(|(_, id)| id).collect();

        // Newest first, in pages of 15, then the same oldest first.
        for reverse in [true, false] {
            let (mut seen, mut cursor): (Vec<String>, Option<OrderCursor>) = (Vec::new(), None);
            loop {
                let page = store.ordered_page(A, R, "note/created_at", cursor.as_ref(), reverse, 15).unwrap();
                let shown = page.records.len() as u64;
                assert_eq!(page.work["seeks"], 1 + shown, "{name}: one scan plus one get per record");
                assert_eq!(page.work["rows_read"], (shown + u64::from(page.next.is_some())) + shown, "{name}");
                seen.extend(page.records.into_iter().map(|record| record.id));
                match page.next {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
            let mut want = expected.clone();
            if !reverse {
                want.reverse();
            }
            assert_eq!(seen, want, "{name}: the old engine's index order (reverse {reverse})");
        }

        // Write cost: an update that leaves the ordered value alone writes no order row; one that changes it moves it.
        let written = |store: &RecordStore<Faulty<Box<dyn StorageSend>>>| store.storage().changes();
        let start = written(&store);
        store.mutate(A, R, put("note:new", 0, "c", json!({"kind": "note", "created_at": "2027"}))).unwrap();
        let create = written(&store) - start;
        let start = written(&store);
        store.mutate(A, R, put("note:new", 1, "u", json!({"kind": "note", "created_at": "2027", "n": 1}))).unwrap();
        let same_value = written(&store) - start;
        let start = written(&store);
        // JSON text order: a quoted string sorts below any number (`"` is 0x22), so the highest value here is a number.
        store.mutate(A, R, put("note:new", 2, "m", json!({"kind": "note", "created_at": 1_800_000_000_000u64, "n": 1}))).unwrap();
        let moved = written(&store) - start;
        println!("{name} rows written with one covering order: create {create}, update {same_value}, update that moves it {moved}");
        assert_eq!((create, same_value), (2, 2), "{name}: +1 row on create, +0 on an update that keeps the value");
        let first = store.ordered_page(A, R, "note/created_at", None, true, 1).unwrap();
        assert_eq!(first.records[0].id, "note:new", "{name}: the moved value is now first");
        assert_eq!(rows(store.storage(), "ordered"), 41, "{name}: moved, not added");

        // Delete and erase take the row with the record; restore brings it back.
        store.mutate(A, R, delete("note:new", 3, "d")).unwrap();
        assert_eq!(rows(store.storage(), "ordered"), 40, "{name}: a delete removes its order row");
        let erased = store.erase(A, R, &expected[0]).unwrap().unwrap();
        assert_eq!(rows(store.storage(), "ordered"), 39, "{name}: an erase removes its order row");
        let page = store.ordered_page(A, R, "note/created_at", None, true, 1).unwrap();
        assert_eq!(page.records[0].id, expected[1], "{name}: the erased record is unreachable in the order");
        assert!(store.restore(&erased, A, R, &expected[0]).unwrap(), "{name}");
        assert_eq!(rows(store.storage(), "ordered"), 40, "{name}: restore brings the row back");
        assert!(matches!(store.ordered_page(A, R, "undeclared", None, true, 1), Err(Error::Invalid(_, _))), "{name}");
    }
}

/// Every row of every record store family, for comparing the whole stored state before and after a failed change.
fn stored_state(storage: &dyn Storage) -> Vec<(String, Vec<Row>)> {
    storage
        .schema()
        .families
        .iter()
        .map(|family| {
            let mut read: Vec<Read<'_>> = family.fields.iter().map(|field| Read::whole(field)).collect();
            if family.arrival {
                read.push(Read::arrival());
            }
            (family.family.clone(), storage.scan(&family.family, &Range::all(), &read).unwrap())
        })
        .collect()
}

#[test]
fn a_write_refused_anywhere_inside_a_change_leaves_nothing_and_the_retry_applies_once() {
    for engine in Engine::record_stores() {
        let name = engine.name();
        let mut store = engine.record_store(Fault::None);
        // A record covered by the declared order, the search fields and a later flush, so every write a change makes
        // (version rows, order rows, search segments) is among the positions refused below.
        for n in 0..7 {
            store.mutate(A, R, put(&format!("state-{n}"), 0, "s", json!({"kind": "note", "title": "state words"}))).unwrap();
        }
        let base = store.mutate(A, R, put("p", 0, "c", json!({"kind": "note", "created_at": "2026", "title": "first"}))).unwrap();
        drop(store);
        let mut version = base.version;
        let mut refused_positions = 0;
        for position in 1.. {
            let mut store = engine.record_store(Fault::Write(position));
            let before = stored_state(store.storage());
            let feed_before = store.changes_page(A, R, 0, 100).unwrap().items;
            let key = format!("u{position}");
            let value = json!({"kind": "note", "created_at": format!("2027-{position:02}"), "title": format!("edit {position}")});
            let answer = store.mutate(A, R, put("p", version, &key, value.clone()));
            if matches!(store.storage().next.get(), Fault::Write(_)) {
                // The change made fewer writes than `position`: every position has been refused once.
                let change = answer.unwrap();
                assert_eq!(change.version, version + 1, "{name}");
                break;
            }
            refused_positions += 1;
            let error = answer.unwrap_err();
            assert!(matches!(error, Error::OutcomeUnknown(_) | Error::Unavailable(_)), "{name}: write {position}: {error:?}");
            // Nothing of the refused change is stored or shown, on this store and on a fresh one.
            assert_eq!(stored_state(store.storage()), before, "{name}: write {position} left rows behind");
            for reader in [&store as &dyn Records, &*engine.open()] {
                let held = reader.get(A, R, "p").unwrap().record.unwrap();
                assert_eq!(held.version, version, "{name}: write {position}");
                assert_eq!(reader.changes_page(A, R, 0, 100).unwrap().items, feed_before, "{name}: write {position}");
            }
            assert!(store.search(A, R, Some("title"), &format!("{position}"), 10).unwrap().records.is_empty(), "{name}");
            // The same store keeps going: the retry of the same request applies once and is answered again after.
            let applied = store.mutate(A, R, put("p", version, &key, value.clone())).unwrap();
            assert_eq!(applied.version, version + 1, "{name}: write {position}");
            assert_eq!(store.mutate(A, R, put("p", version, &key, value.clone())).unwrap(), applied, "{name}");
            assert_eq!(store.get(A, R, "p").unwrap().record.unwrap().value, value, "{name}");
            let found = store.search(A, R, Some("title"), &format!("{position}"), 10).unwrap().records;
            assert_eq!(found.len(), 1, "{name}: write {position}: the retried change is searchable once");
            version = applied.version;
        }
        assert!(refused_positions >= 1, "{name}: no write was refused");
        println!("{name}: a change refused at each of its {refused_positions} writes left nothing");
    }
}

/// Record ids of punctuation, case, combining marks, both sides of the surrogate gap and supplementary characters.
/// Their expected order is the byte order of their UTF-8 forms (code point order), computed without any store.
const IDS: &[&str] = &[
    " ", "!", "\"", "#", "%", "'", "-", ".", "/", "0", ":", ";", "<", "?", "@", "A", "Z", "[", "\\", "_", "`", "a",
    "a b", "a-b", "a.b", "a/b", "a:b", "a_b", "a~", "z", "{", "~", "\u{7f}", "é", "e\u{301}", "ß", "Ω", "中", "中文",
    "\u{D7FF}", "\u{E000}", "\u{FFFD}", "😀", "\u{10FFFF}",
];

#[test]
fn records_with_punctuation_and_unicode_ids_list_and_follow_in_code_point_order() {
    let mut expected: Vec<&str> = IDS.to_vec();
    expected.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    for engine in Engine::all() {
        let name = engine.name();
        let mut store = engine.open();
        for (n, id) in IDS.iter().rev().enumerate() {
            store.mutate(A, R, put(id, 0, &format!("c{n}"), json!({"id": id}))).unwrap();
        }
        let mut seen = Vec::new();
        let mut after = String::new();
        loop {
            let page = store.list_page(A, R, &after, 3).unwrap();
            seen.extend(page.items.iter().map(|record| record.id.clone()));
            match page.next {
                Some(next) => after = next,
                None => break,
            }
        }
        assert_eq!(seen, expected, "{name}: list pages");
        for id in IDS {
            assert_eq!(store.get(A, R, id).unwrap().record.unwrap().value, json!({"id": id}), "{name}: {id:?}");
        }
        // Canonically equivalent ids are still different ids; a change to one never touches the other.
        store.mutate(A, R, put("é", 1, "u", json!({"id": "changed"}))).unwrap();
        assert_eq!(store.get(A, R, "e\u{301}").unwrap().record.unwrap().version, 1, "{name}");
        let mut rebuilt = std::collections::BTreeMap::new();
        let mut cursor = 0;
        loop {
            let page = store.changes_page(A, R, cursor, 4).unwrap();
            for change in page.items {
                rebuilt.insert(change.id, change.value);
            }
            match page.next {
                Some(next) => cursor = next,
                None => break,
            }
        }
        assert_eq!(rebuilt.keys().map(String::as_str).collect::<Vec<_>>(), expected, "{name}: change feed");
        assert_eq!(rebuilt["é"], Some(json!({"id": "changed"})), "{name}");
    }
}

#[test]
fn a_deleted_record_never_shows_an_older_value_when_its_tombstone_and_history_leave() {
    for engine in Engine::record_stores() {
        let name = engine.name();
        let clock = engine.clock();
        let mut store = engine.record_store(Fault::None);
        let old = store.mutate(A, R, put("t", 0, "c", json!({"title": "old"}))).unwrap();
        let newer = store.mutate(A, R, put("t", 1, "u", json!({"title": "newer"}))).unwrap();
        let gone = store.mutate(A, R, delete("t", 2, "d")).unwrap();
        let shows_nothing = |store: &RecordStore<Faulty<Box<dyn StorageSend>>>, label: &str| {
            assert!(store.get(A, R, "t").unwrap().record.is_none(), "{name}: {label}: get");
            assert!(store.list_page(A, R, "", 10).unwrap().items.is_empty(), "{name}: {label}: list");
            assert!(store.as_of(A, R, "t", gone.sequence).unwrap().record.is_none(), "{name}: {label}: as of the delete");
            let feed = store.changes_page(A, R, 0, 10).unwrap().items;
            assert!(feed.iter().all(|change| change.value.is_none()), "{name}: {label}: feed {feed:?}");
            assert!(store.search(A, R, Some("title"), "old", 10).unwrap().records.is_empty(), "{name}: {label}: search");
            assert!(store.search(A, R, Some("title"), "newer", 10).unwrap().records.is_empty(), "{name}: {label}");
            assert!(store.ids(A, R, None, 10).unwrap().0.is_empty(), "{name}: {label}: ids");
        };
        shows_nothing(&store, "inside the window");
        // Inside the window the history is still readable as history, never as the current record.
        assert_eq!(store.as_of(A, R, "t", newer.sequence).unwrap().record.unwrap().value["title"], "newer", "{name}");
        // A retry of an earlier request is answered from the tombstone's receipts, not re-applied.
        let retried = store.mutate(A, R, put("t", 0, "c", json!({"title": "old"}))).unwrap();
        assert_eq!((retried.sequence, retried.version), (old.sequence, 1), "{name}");
        shows_nothing(&store, "after a retried create");
        // A stale writer is refused by version.
        assert_eq!(store.mutate(A, R, put("t", 2, "stale", json!({"title": "stale"}))).unwrap_err(), trillion_local::cause!(Error::Conflict), "{name}");
        clock.advance(2 * DAY_MS + 1);
        store.retire(A, R).unwrap();
        assert_eq!(rows(store.storage(), "versions"), 0, "{name}: the tombstone and the history left");
        shows_nothing(&store, "after the window");
        assert!(store.as_of(A, R, "t", old.sequence).unwrap().record.is_none(), "{name}: history left with the window");
        assert!(store.as_of(A, R, "t", newer.sequence).unwrap().record.is_none(), "{name}: history left with the window");
        let fresh = engine.record_store(Fault::None);
        shows_nothing(&fresh, "after a restart");
        // A new record under the same id starts from nothing; nothing of the old one comes back with it.
        let reborn = store.mutate(A, R, put("t", 0, "again", json!({"text": "new"}))).unwrap();
        assert_eq!(reborn.version, 1, "{name}");
        assert_eq!(store.get(A, R, "t").unwrap().record.unwrap().value, json!({"text": "new"}), "{name}");
        assert!(store.as_of(A, R, "t", newer.sequence).unwrap().record.is_none(), "{name}: no older value under the new record");
    }
}

#[test]
fn the_same_store_answers_retries_after_an_unknown_outcome_without_applying_twice() {
    for engine in Engine::record_stores() {
        let name = engine.name();
        for fault in [Fault::BeforeCommit, Fault::AfterCommit] {
            let id = format!("{fault:?}");
            let mut store = engine.record_store(fault);
            let first = store.mutate(A, R, put(&id, 0, "create", json!({"text": "x"})));
            assert!(matches!(first.unwrap_err(), Error::OutcomeUnknown(_)), "{name}: {fault:?}");
            // Another request with the same expectation: exactly one of the two may ever apply.
            let rival = store.mutate(A, R, put(&id, 0, "rival", json!({"text": "y"})));
            let retried = store.mutate(A, R, put(&id, 0, "create", json!({"text": "x"})));
            match fault {
                Fault::BeforeCommit => {
                    assert_eq!(rival.unwrap().version, 1, "{name}: nothing landed, so the rival creates");
                    assert_eq!(retried.unwrap_err(), trillion_local::cause!(Error::Conflict), "{name}: the lost request now meets the rival's version");
                }
                _ => {
                    assert_eq!(rival.unwrap_err(), trillion_local::cause!(Error::Conflict), "{name}: the landed change holds version 1");
                    let retried = retried.unwrap();
                    assert_eq!((retried.version, retried.value), (1, Some(json!({"text": "x"}))), "{name}: answered once");
                }
            }
            let held = store.get(A, R, &id).unwrap().record.unwrap();
            assert_eq!(held.version, 1, "{name}: {fault:?}: applied exactly once");
            let feed = store.changes_page(A, R, 0, 100).unwrap().items;
            assert_eq!(feed.iter().filter(|change| change.id == id).count(), 1, "{name}: {fault:?}");
        }
    }
}

#[test]
fn readers_see_only_committed_records_while_another_handle_holds_the_writer() {
    for engine in Engine::record_stores() {
        let name = engine.name();
        let mut reader = engine.record_store(Fault::None);
        reader.mutate(A, R, put("w", 0, "c", json!({"title": "committed"}))).unwrap();
        let mut writer = RecordStore::with_settings(
            Faulty { inner: engine.supply(), next: Cell::new(Fault::None) },
            Box::new(engine.clock()),
            settings(),
            Limits::fixed(1 << 20, u64::MAX / 2),
        )
        .unwrap();
        // The canonical writer holds its write reservation across a change it has not committed yet.
        writer.storage().open_scope(Intent::Write).unwrap();
        writer.mutate(A, R, put("w", 1, "held", json!({"title": "uncommitted"}))).unwrap();
        writer.mutate(A, R, put("n", 0, "held-new", json!({"title": "uncommitted"}))).unwrap();
        let shown = reader.get(A, R, "w").unwrap().record.unwrap();
        assert_eq!((shown.version, shown.value), (1, json!({"title": "committed"})), "{name}: a held change was read");
        assert!(reader.get(A, R, "n").unwrap().record.is_none(), "{name}: a held create was read");
        assert_eq!(reader.list_page(A, R, "", 10).unwrap().items.len(), 1, "{name}");
        assert_eq!(reader.changes_page(A, R, 0, 10).unwrap().items.len(), 1, "{name}");
        // A second writer is refused while the reservation is held, and stays a working reader.
        let refused = reader.mutate(A, R, put("w", 1, "rival", json!({"title": "rival"})));
        assert!(matches!(refused, Err(Error::Unavailable(_) | Error::OutcomeUnknown(_))), "{name}: {refused:?}");
        assert_eq!(reader.get(A, R, "w").unwrap().record.unwrap().version, 1, "{name}: the refused writer stopped reading");
        writer.storage().close_scope(true).unwrap();
        assert_eq!(reader.get(A, R, "w").unwrap().record.unwrap().value, json!({"title": "uncommitted"}), "{name}");
        assert!(reader.get(A, R, "n").unwrap().record.is_some(), "{name}");
        // Once released, the refused writer's retry meets the committed version exactly.
        assert_eq!(reader.mutate(A, R, put("w", 1, "rival", json!({"title": "rival"}))).unwrap_err(), trillion_local::cause!(Error::Conflict), "{name}");
        assert_eq!(reader.mutate(A, R, put("w", 2, "next", json!({"title": "next"}))).unwrap().version, 3, "{name}");
    }
}

#[test]
fn two_stores_on_one_storage_mint_increasing_stamps_and_a_feed_reader_misses_no_change() {
    for engine in Engine::record_stores() {
        let name = engine.name();
        let other = |engine: &Engine| {
            RecordStore::with_settings(
                Faulty { inner: engine.supply(), next: Cell::new(Fault::None) },
                Box::new(engine.clock()),
                settings(),
                Limits::fixed(1 << 20, u64::MAX / 2),
            )
            .unwrap()
        };
        let mut first = engine.record_store(Fault::None);
        let mut second = other(&engine);
        // Both stores warm their caches (newest stamp, search memory) before the other writes.
        first.mutate(A, R, put("a", 0, "a0", json!({"title": "alpha"}))).unwrap();
        second.mutate(A, R, put("b", 0, "b0", json!({"title": "beta"}))).unwrap();
        assert_eq!(second.search(A, R, Some("title"), "alpha", 10).unwrap().records.len(), 1, "{name}");
        let mut feed_cursor = second.changes_page(A, R, 0, 100).unwrap().items.last().unwrap().sequence;
        let mut sequences = Vec::new();
        for round in 0..6_i64 {
            // The clock stands still, so each stamp comes from the newest one the store knows of.
            let (writer, reader) = if round % 2 == 0 { (&mut first, &mut second) } else { (&mut second, &mut first) };
            let id = format!("r{round}");
            let change = writer.mutate(A, R, put(&id, 0, &id, json!({"title": format!("word{round}")}))).unwrap();
            sequences.push(change.sequence);
            // The other store's rebuilt sees it after its cursor, and its search finds it.
            let page = reader.changes_page(A, R, feed_cursor, 100).unwrap();
            assert_eq!(page.items.iter().map(|change| change.id.as_str()).collect::<Vec<_>>(), [id.as_str()], "{name}: round {round}");
            feed_cursor = page.items[0].sequence;
            let found = reader.search(A, R, Some("title"), &format!("word{round}"), 10).unwrap().records;
            assert_eq!(found.len(), 1, "{name}: round {round}: the other store's search missed a committed change");
            // A record the other store changed is updated here at its committed version.
            let held = reader.get(A, R, "a").unwrap().record.unwrap().version;
            let updated = reader.mutate(A, R, put("a", held, &format!("a-update-{round}"), json!({"title": "alpha", "n": round})));
            updated.unwrap_or_else(|error| panic!("{name}: round {round}: {error:?}"));
            feed_cursor = reader.changes_page(A, R, feed_cursor, 100).unwrap().items.last().unwrap().sequence;
        }
        assert!(sequences.windows(2).all(|pair| pair[0] < pair[1]), "{name}: stamps {sequences:?}");
    }
}
