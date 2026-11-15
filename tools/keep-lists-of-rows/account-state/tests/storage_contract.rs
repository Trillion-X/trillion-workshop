// tests/storage_contract.rs
//
// Purpose: An independent consumer of the storage boundary (`trillion_local::storage::Storage`). The same test bodies
// run against every in-process supply (memory and SQLite) and assert the contract a provider-independent engine relies
// on: atomic rollback after a partial failure, read-your-writes, ordered scans over punctuation and Unicode keys,
// exact compare-and-set, cancellation and deadline bounds that never let a write escape its scope, and read-only
// observations by another handle while the canonical writer holds the write reservation.
//
// Non-Negotiable Invariants:
// - One body per property, run on each supply; a supply-specific branch in a test body is a defect of the suite.
//   The one declared exception is `Supply::bounded`: the memory supply has no work, time or cancellation allowance
//   (it holds no statement that could run long), so the bound tests name it as not applicable instead of passing it.
// - Expected answers are computed independently of the supplies (byte order of UTF-8 text, a model of committed rows),
//   never by asking one supply what another should answer.
//
// Key Concepts:
// - `Supply`: opens a fresh store of the `account_policy` schema and further handles on the same committed rows.
//
// Security Considerations:
// - Scratch storage only; no account, original or live data is read.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use trillion_local::storage::{
    hosted_sql,
    memory::Memory,
    sqlite::{self, hosted_stand_in, Bounds, Spend},
    Error, Intent, Range, Read, Scope, Storage, Value, When, Write,
};

const SCHEMA: &str = "account_policy";
const FAMILY: &str = "policy_directory";

fn text(value: &str) -> Value {
    Value::Text(value.into())
}
fn row<'a>(name: &str, value: &str) -> [(&'a str, Value); 2] {
    [("name", text(name)), ("value", text(value))]
}
fn read_value(store: &dyn Storage, name: &str) -> Option<Value> {
    store.get(FAMILY, &[text(name)], &[Read::whole("value")]).unwrap().map(|mut row| row.take(0))
}
fn names(store: &dyn Storage, range: &Range<'_>) -> Vec<String> {
    store
        .scan(FAMILY, range, &[Read::whole("name")])
        .unwrap()
        .into_iter()
        .map(|mut row| row.take(0).as_text().unwrap().to_owned())
        .collect()
}

fn bounds() -> Bounds {
    Bounds {
        value_bytes: 1 << 20,
        work: u64::MAX / 2,
        deadline: Duration::MAX,
        spend: Spend::EachOperation,
        cancel: None,
        busy: Duration::from_millis(50),
    }
}

/// One supply under test.
enum Supply {
    Memory(Memory),
    Sqlite { _dir: tempfile::TempDir, path: PathBuf },
    /// SQLite a computer's host lends only through one statement call (`storage::hosted_sql`), over the native
    /// stand-in of that call (`sqlite::hosted_stand_in`).
    Hosted { _dir: tempfile::TempDir, path: PathBuf },
}
impl Supply {
    fn all() -> Vec<Supply> {
        let dir = tempfile::tempdir().unwrap();
        // The supply refuses a path through a symbolic link (macOS /var is one), so the suite names the real folder.
        let path = dir.path().canonicalize().unwrap().join("contract.sqlite");
        let hosted = tempfile::tempdir().unwrap();
        let hosted_path = hosted.path().canonicalize().unwrap().join("hosted.sqlite");
        vec![Self::Memory(Memory::open(SCHEMA).unwrap()), Self::Sqlite { _dir: dir, path }, Self::Hosted { _dir: hosted, path: hosted_path }]
    }
    fn name(&self) -> &'static str {
        match self {
            Self::Memory(_) => "memory",
            Self::Sqlite { .. } => "sqlite",
            Self::Hosted { .. } => "hosted",
        }
    }
    /// A handle on this supply's committed rows; every call is another handle (another connection).
    fn handle(&self) -> Box<dyn Storage> {
        self.handle_with(bounds()).expect("this supply has no bounds to set")
    }
    /// A handle under the given work, time and cancellation bounds; None where the supply has none.
    fn handle_with(&self, bounds: Bounds) -> Option<Box<dyn Storage>> {
        match self {
            Self::Memory(root) => (bounds.cancel.is_none() && bounds.deadline == Duration::MAX && bounds.work == u64::MAX / 2)
                .then(|| Box::new(root.reopen()) as Box<dyn Storage>),
            Self::Sqlite { path, .. } => Some(Box::new(sqlite::open_owned(path, SCHEMA, bounds).unwrap())),
            // Like memory, the hosted supply has no work, time or cancellation allowance of its own: the host bounds
            // each turn of its object.
            Self::Hosted { path, .. } => (bounds.cancel.is_none() && bounds.deadline == Duration::MAX && bounds.work == u64::MAX / 2)
                .then(|| Box::new(hosted_sql::open(hosted_stand_in::open(path).unwrap(), SCHEMA, bounds.value_bytes as usize).unwrap()) as Box<dyn Storage>),
        }
    }
    /// Whether this supply enforces work, time and cancellation bounds.
    fn bounded(&self) -> bool {
        matches!(self, Self::Sqlite { .. })
    }
}

#[test]
fn a_partial_batch_failure_rolls_back_with_its_scope_and_the_failed_write_changes_nothing() {
    for supply in Supply::all() {
        let name = supply.name();
        let store = supply.handle();
        store.put(FAMILY, &row("kept", "before"), When::New).unwrap();
        {
            let scope = Scope::begin(&*store, Intent::Write).unwrap();
            let failed = scope.write_many(&[
                Write::Put { family: FAMILY, row: &row("a", "1"), when: When::New },
                Write::Put { family: FAMILY, row: &row("kept", "during"), when: When::Always },
                Write::Put { family: FAMILY, row: &row("kept", "refused"), when: When::New },
                Write::Put { family: FAMILY, row: &row("never", "x"), when: When::New },
            ]);
            assert_eq!(failed, Err(trillion_local::cause!(Error::Conflict)), "{name}");
            // The writes before the refusal stay done inside the scope; the refused one changed nothing; the one
            // after it never ran.
            assert_eq!(read_value(&*scope, "a"), Some(text("1")), "{name}");
            assert_eq!(read_value(&*scope, "kept"), Some(text("during")), "{name}");
            assert_eq!(read_value(&*scope, "never"), None, "{name}");
            // The scope stays usable after a failed operation.
            scope.put(FAMILY, &row("b", "2"), When::New).unwrap();
            scope.rollback().unwrap();
        }
        for handle in [&store, &supply.handle()] {
            assert_eq!(names(&**handle, &Range::all()), ["kept"], "{name}: the rollback undid every write of the scope");
            assert_eq!(read_value(&**handle, "kept"), Some(text("before")), "{name}");
        }
        // A scope dropped unfinished (an owner's early return) rolls back too.
        {
            let scope = Scope::begin(&*store, Intent::Write).unwrap();
            scope.put(FAMILY, &row("dropped", "x"), When::New).unwrap();
        }
        assert_eq!(read_value(&*supply.handle(), "dropped"), None, "{name}");
        assert!(!store.scoped(), "{name}");
    }
}

#[test]
fn a_scope_reads_its_own_writes_and_other_handles_read_them_once_committed() {
    for supply in Supply::all() {
        let name = supply.name();
        let store = supply.handle();
        let scope = Scope::begin(&*store, Intent::Write).unwrap();
        scope.put(FAMILY, &row("x", "1"), When::New).unwrap();
        assert_eq!(read_value(&*scope, "x"), Some(text("1")), "{name}");
        scope.put(FAMILY, &row("x", "2"), When::Matches(&[("value", text("1"))])).unwrap();
        assert_eq!(read_value(&*scope, "x"), Some(text("2")), "{name}");
        assert_eq!(names(&*scope, &Range::all()), ["x"], "{name}");
        assert_eq!(scope.count(FAMILY, &Range::all()).unwrap(), 1, "{name}");
        scope.put(FAMILY, &row("y", "3"), When::New).unwrap();
        assert_eq!(scope.erase(FAMILY, &Range::prefix("y")).unwrap(), 1, "{name}");
        assert_eq!(read_value(&*scope, "y"), None, "{name}");
        scope.commit().unwrap();
        let other = supply.handle();
        assert_eq!(read_value(&*other, "x"), Some(text("2")), "{name}");
        assert_eq!(read_value(&*other, "y"), None, "{name}");
        // Outside a scope, each write is its own commit and the next read sees it.
        other.put(FAMILY, &row("z", "4"), When::New).unwrap();
        assert_eq!(read_value(&*store, "z"), Some(text("4")), "{name}");
    }
}

/// Keys of punctuation, case, combining marks, the edges of the Basic Multilingual Plane around the surrogate gap,
/// supplementary characters and an interior NUL. Their expected order is the byte order of their UTF-8 forms (code
/// point order), computed here without any supply.
const KEYS: &[&str] = &[
    "", " ", "!", "\"", "#", "%", "'", "-", ".", "/", "0", "9", ":", ";", "<", "=", "?", "@", "A", "Z", "[", "\\", "_",
    "`", "a", "a\u{0}b", "a b", "a-b", "a.b", "a/b", "a:b", "a;b", "a_b", "a~", "z", "{", "|", "}", "~", "\u{7f}",
    "\u{80}", "é", "e\u{301}", "ß", "Ω", "中", "中文", "\u{D7FF}", "\u{E000}", "\u{FFFD}", "\u{FFFF}", "😀", "😀a",
    "\u{10FFFF}",
];

#[test]
fn ordered_scans_walk_punctuation_and_unicode_keys_in_code_point_order() {
    let mut expected: Vec<&str> = KEYS.to_vec();
    expected.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    for supply in Supply::all() {
        let name = supply.name();
        let store = supply.handle();
        // Arrive in an order unrelated to the key order.
        for key in KEYS.iter().rev() {
            store.put(FAMILY, &row(key, key), When::New).unwrap();
        }
        assert_eq!(names(&*store, &Range::all()), expected, "{name}: forward");
        let mut backward = expected.clone();
        backward.reverse();
        assert_eq!(names(&*store, &Range::all().reverse()), backward, "{name}: reverse");
        // Keyset pages of 3 in each direction visit every key once.
        for reverse in [false, true] {
            let mut seen = Vec::new();
            let mut cursor: Option<String> = None;
            loop {
                let mut range = if reverse { Range::all().reverse() } else { Range::all() };
                if let Some(after) = &cursor {
                    range = range.after(vec![text(after)]);
                }
                let page = names(&*store, &range.limit(3));
                if page.is_empty() {
                    break;
                }
                cursor = page.last().cloned();
                seen.extend(page);
            }
            assert_eq!(seen, if reverse { backward.clone() } else { expected.clone() }, "{name}: pages reverse={reverse}");
        }
        // Prefixes end at the next text, also across the surrogate gap and at the last code point.
        for prefix in ["a", "a:", "a\u{0}", "中", "\u{D7FF}", "😀", "\u{10FFFF}", "e", "/"] {
            let want: Vec<&str> = expected.iter().copied().filter(|key| key.starts_with(prefix)).collect();
            assert_eq!(names(&*store, &Range::prefix(prefix)), want, "{name}: prefix {prefix:?}");
            assert_eq!(store.count(FAMILY, &Range::prefix(prefix)).unwrap(), want.len() as u64, "{name}: count {prefix:?}");
        }
        // Each key reads back exactly, and erasing one prefix removes exactly its keys.
        for key in KEYS {
            assert_eq!(read_value(&*store, key), Some(text(key)), "{name}: {key:?}");
        }
        let removed = store.erase(FAMILY, &Range::prefix("a")).unwrap();
        assert_eq!(removed, expected.iter().filter(|key| key.starts_with('a')).count() as u64, "{name}");
        let left: Vec<&str> = expected.iter().copied().filter(|key| !key.starts_with('a')).collect();
        assert_eq!(names(&*supply.handle(), &Range::all()), left, "{name}");
    }
}

#[test]
fn compare_and_set_changes_a_row_only_on_an_exact_match() {
    for supply in Supply::all() {
        let name = supply.name();
        let store = supply.handle();
        store.put(FAMILY, &row("k", "é"), When::New).unwrap();
        let attempt = |expected: Value| store.put(FAMILY, &row("k", "next"), When::Matches(&[("value", expected)])).unwrap();
        // Near misses: another normalization, case, a trailing space, a prefix, NULL, a number, a blob of the same bytes.
        for near in [
            text("e\u{301}"),
            text("É"),
            text("é "),
            text(""),
            Value::Null,
            Value::Integer(0),
            Value::Blob("é".as_bytes().to_vec()),
        ] {
            assert_eq!(attempt(near.clone()), 0, "{name}: {near:?} must not match");
            assert_eq!(read_value(&*store, "k"), Some(text("é")), "{name}: a refused compare-and-set changed the row");
        }
        assert_eq!(attempt(text("é")), 1, "{name}");
        assert_eq!(read_value(&*store, "k"), Some(text("next")), "{name}");
        // The second writer with the same expectation loses.
        assert_eq!(attempt(text("é")), 0, "{name}");
        // Compare-and-set never inserts.
        assert_eq!(store.put(FAMILY, &row("absent", "x"), When::Matches(&[("value", Value::Null)])).unwrap(), 0, "{name}");
        assert_eq!(read_value(&*store, "absent"), None, "{name}");
        // Two handles racing on one expectation: exactly one wins.
        let other = supply.handle();
        let first = store.put(FAMILY, &row("k", "mine"), When::Matches(&[("value", text("next"))])).unwrap();
        let second = other.put(FAMILY, &row("k", "theirs"), When::Matches(&[("value", text("next"))])).unwrap();
        assert_eq!((first, second), (1, 0), "{name}");
        assert_eq!(read_value(&*other, "k"), Some(text("mine")), "{name}");
    }
}

#[test]
fn another_handle_reads_committed_rows_while_the_canonical_writer_is_held() {
    for supply in Supply::all() {
        let name = supply.name();
        let writer = supply.handle();
        let reader = supply.handle();
        writer.put(FAMILY, &row("x", "committed"), When::New).unwrap();
        let held = Scope::begin(&*writer, Intent::Write).unwrap();
        held.put(FAMILY, &row("x", "uncommitted"), When::Always).unwrap();
        held.put(FAMILY, &row("y", "uncommitted"), When::New).unwrap();
        held.erase(FAMILY, &Range::prefix("x")).unwrap();
        held.put(FAMILY, &row("x", "uncommitted again"), When::New).unwrap();
        // The reader sees exactly the committed rows: no uncommitted value, insert or erase.
        assert_eq!(read_value(&*reader, "x"), Some(text("committed")), "{name}: dirty read of a held write");
        assert_eq!(read_value(&*reader, "y"), None, "{name}: dirty read of a held insert");
        assert_eq!(names(&*reader, &Range::all()), ["x"], "{name}: dirty scan");
        assert_eq!(reader.count(FAMILY, &Range::all()).unwrap(), 1, "{name}: dirty count");
        // A consistent read scope keeps its view while the writer commits.
        let snapshot = Scope::begin(&*reader, Intent::Read).unwrap();
        assert_eq!(read_value(&*snapshot, "x"), Some(text("committed")), "{name}");
        // A second writer is refused within its bounded wait, not queued behind the held one and not let in.
        let second = supply.handle();
        let started = Instant::now();
        assert_eq!(Scope::begin(&*second, Intent::Write).err(), Some(trillion_local::cause!(Error::Busy)), "{name}: two writers held at once");
        assert_eq!(second.put(FAMILY, &row("z", "racer"), When::New), Err(trillion_local::cause!(Error::Busy)), "{name}: a write outside a scope bypassed the held writer");
        assert!(started.elapsed() < Duration::from_secs(5), "{name}: the refusal waited past its bound");
        // The refused handle is not damaged: it still reads, and writes once the writer is gone.
        assert_eq!(read_value(&*second, "x"), Some(text("committed")), "{name}: a refused writer could no longer read");
        held.commit().unwrap();
        assert_eq!(read_value(&*snapshot, "x"), Some(text("committed")), "{name}: the read scope moved under a commit");
        assert_eq!(read_value(&*snapshot, "y"), None, "{name}: the read scope moved under a commit");
        assert_eq!(names(&*snapshot, &Range::all()), ["x"], "{name}: the read scope moved under a commit");
        snapshot.rollback().unwrap();
        assert_eq!(read_value(&*reader, "x"), Some(text("uncommitted again")), "{name}");
        assert_eq!(read_value(&*reader, "y"), Some(text("uncommitted")), "{name}");
        second.put(FAMILY, &row("z", "after"), When::New).unwrap();
        let scope = Scope::begin(&*second, Intent::Write).unwrap();
        scope.put(FAMILY, &row("w", "after"), When::New).unwrap();
        scope.commit().unwrap();
        assert_eq!(names(&*writer, &Range::all()), ["w", "x", "y", "z"], "{name}");
    }
}

#[test]
fn a_writer_rolled_back_after_another_handle_committed_does_not_undo_that_commit() {
    for supply in Supply::all() {
        let name = supply.name();
        let first = supply.handle();
        let second = supply.handle();
        first.put(FAMILY, &row("k", "base"), When::New).unwrap();
        let held = Scope::begin(&*first, Intent::Write).unwrap();
        held.put(FAMILY, &row("k", "first"), When::Always).unwrap();
        // Whatever the second handle is told, a value it was told committed must survive the first's rollback.
        let answer = second.put(FAMILY, &row("k", "second"), When::Always);
        held.rollback().unwrap();
        let now = read_value(&*supply.handle(), "k");
        match answer {
            Ok(1) => assert_eq!(now, Some(text("second")), "{name}: a committed write was lost to another handle's rollback"),
            Err(Error::Busy(_)) => assert_eq!(now, Some(text("base")), "{name}"),
            other => panic!("{name}: unexpected answer {other:?}"),
        }
    }
}

/// Rows enough that erasing them all runs far past the supply's interruption granularity.
fn fill(store: &dyn Storage, rows: usize) {
    let scope = Scope::begin(store, Intent::Write).unwrap();
    for n in 0..rows {
        scope.put(FAMILY, &row(&format!("bulk-{n:05}"), "v"), When::New).unwrap();
    }
    scope.commit().unwrap();
}

#[test]
fn a_cancelled_write_inside_a_scope_never_lets_a_later_write_escape_the_scope() {
    for supply in Supply::all() {
        let name = supply.name();
        let cancel = Arc::new(AtomicBool::new(false));
        let Some(store) = supply.handle_with(Bounds { cancel: Some(cancel.clone()), ..bounds() }) else {
            assert!(!supply.bounded());
            eprintln!("{name}: not applicable, the supply has no cancellation");
            continue;
        };
        fill(&*store, 4_000);
        let scope = Scope::begin(&*store, Intent::Write).unwrap();
        scope.put(FAMILY, &row("early", "in scope"), When::New).unwrap();
        cancel.store(true, Ordering::Release);
        assert_eq!(scope.erase(FAMILY, &Range::prefix("bulk-")), Err(trillion_local::cause!(Error::Interrupted)), "{name}");
        cancel.store(false, Ordering::Release);
        // Whatever the supply did with the scope, a write made after the failure is either inside the scope or
        // refused; it is never committed on its own.
        let late = scope.put(FAMILY, &row("late", "after the cancel"), When::New);
        let closed = scope.rollback();
        let fresh = supply.handle();
        assert_eq!(read_value(&*fresh, "late"), None, "{name}: a write escaped its rolled-back scope ({late:?}, {closed:?})");
        assert_eq!(read_value(&*fresh, "early"), None, "{name}: a write escaped its rolled-back scope");
        assert_eq!(fresh.count(FAMILY, &Range::prefix("bulk-")).unwrap(), 4_000, "{name}: a cancelled erase removed rows");
        // The handle recovers: a new scope on the same handle works once the cancellation is cleared.
        let again = Scope::begin(&*store, Intent::Write).unwrap();
        again.put(FAMILY, &row("recovered", "yes"), When::New).unwrap();
        again.commit().unwrap();
        assert_eq!(read_value(&*fresh, "recovered"), Some(text("yes")), "{name}: the handle did not recover");
    }
}

#[test]
fn deadline_and_work_bounds_stop_an_operation_and_leave_the_scope_atomic() {
    for supply in Supply::all() {
        let name = supply.name();
        let Some(prefill) = supply.handle_with(bounds()) else { unreachable!() };
        fill(&*prefill, 4_000);
        for (label, limited) in [
            ("deadline", Bounds { deadline: Duration::from_nanos(1), ..bounds() }),
            ("work", Bounds { work: 5_000, ..bounds() }),
        ] {
            let Some(store) = supply.handle_with(limited) else {
                assert!(!supply.bounded());
                eprintln!("{name}: {label} bound not applicable, the supply has none");
                continue;
            };
            let expected = if label == "deadline" { trillion_local::cause!(Error::Deadline) } else { trillion_local::cause!(Error::Interrupted) };
            // A read past its bound is stopped, and the handle answers the next small operation.
            let started = Instant::now();
            assert_eq!(store.scan(FAMILY, &Range::all(), &[Read::whole("value")]).err(), Some(expected.clone()), "{name}: {label} read");
            assert!(started.elapsed() < Duration::from_secs(5), "{name}: {label} bound not kept");
            // A write past its bound inside a scope: nothing it or a later write did survives the rollback.
            let scope = Scope::begin(&*store, Intent::Write).unwrap();
            scope.put(FAMILY, &row("early", "x"), When::New).unwrap();
            assert_eq!(read_value(&*scope, "early"), Some(text("x")), "{name}: {label}");
            assert_eq!(scope.erase(FAMILY, &Range::prefix("bulk-")).err(), Some(expected), "{name}: {label} write");
            let late = scope.put(FAMILY, &row("late", "x"), When::New);
            assert!(late.is_err() || read_value(&*scope, "early").is_some(), "{name}: {label}: the scope lost its writes but took more");
            scope.rollback().unwrap();
            let fresh = supply.handle();
            assert_eq!(fresh.count(FAMILY, &Range::prefix("bulk-")).unwrap(), 4_000, "{name}: {label}");
            assert_eq!(read_value(&*fresh, "early"), None, "{name}: {label}: a write escaped its scope");
            assert_eq!(read_value(&*fresh, "late"), None, "{name}: {label}: a write escaped its scope");
            assert!(!store.scoped(), "{name}: {label}: the scope stayed open");
        }
    }
}


/// M08: one fresh scope on a retained second handle after each acknowledged
/// command. An old snapshot remains old and cannot be relabelled current.
#[test]
fn current_reads_include_100_committed_creates_updates_and_deletes() {
    for supply in Supply::all() {
        let name = supply.name();
        let writer = supply.handle();
        let reader = supply.handle();
        for n in 0..100 {
            for (phase, value) in [("create", Some(format!("created-{n}"))),
                ("update", Some(format!("updated-{n}"))), ("delete", None)] {
                let write = Scope::begin(&*writer, Intent::Write).unwrap();
                match &value {
                    Some(value) => { write.put(FAMILY, &row("current", value), When::Always).unwrap(); }
                    None => { assert_eq!(write.erase(FAMILY, &Range::prefix("current")).unwrap(), 1); }
                }
                write.commit().unwrap();
                let read = Scope::current_read(&*reader).unwrap();
                assert_eq!(read_value(&*read, "current"), value.as_deref().map(text), "{name}: {phase} {n}");
                assert!(matches!(Scope::current_read(&*reader), Err(Error::Invalid(_))),
                    "{name}: an already open snapshot must never qualify as a new read");
                read.commit().unwrap();
            }
        }
        // Establish an actual old snapshot, commit a newer value elsewhere,
        // and prove a negative control before taking the new current read.
        writer.put(FAMILY, &row("current", "before"), When::Always).unwrap();
        let old = Scope::current_read(&*reader).unwrap();
        assert_eq!(read_value(&*old, "current"), Some(text("before")));
        writer.put(FAMILY, &row("current", "after"), When::Always).unwrap();
        assert_eq!(read_value(&*old, "current"), Some(text("before")), "{name}: the negative control really is old");
        assert!(matches!(Scope::current_read(&*reader), Err(Error::Invalid(_))));
        old.rollback().unwrap();
        let current = Scope::current_read(&*reader).unwrap();
        assert_eq!(read_value(&*current, "current"), Some(text("after")), "{name}: new transaction, same retained handle");
        current.commit().unwrap();
    }
}


/// The state and the qualifying frontier are read from ONE real snapshot.
/// Lagged copies and evidence for a different scope/history never qualify.
#[test]
fn current_read_floors_refuse_lagged_wrong_history_and_future_evidence() {
    use trillion_local::storage::ReadPosition;
    let scope_id = *content_crypto::advanced::blake3::hash(b"synthetic-account/resource-a").as_bytes();
    let history = *content_crypto::advanced::blake3::hash(b"synthetic-history-a").as_bytes();
    let floor = ReadPosition { scope: scope_id, history, position: 1 };
    for (supply, lagged_supply) in Supply::all().into_iter().zip(Supply::all()) {
        let name = supply.name();
        let writer = supply.handle();
        let reader = supply.handle();
        let publish = |position: u64, value: &str| {
            let write = Scope::begin(&*writer, Intent::Write).unwrap();
            write.put(FAMILY, &row("scope", &serde_json::to_string(&scope_id).unwrap()), When::Always).unwrap();
            write.put(FAMILY, &row("history", &serde_json::to_string(&history).unwrap()), When::Always).unwrap();
            write.put(FAMILY, &row("frontier", &position.to_string()), When::Always).unwrap();
            write.put(FAMILY, &row("value", value), When::Always).unwrap();
            write.commit().unwrap();
        };
        let observe = |snapshot: &Scope<'_>| -> Result<ReadPosition, Error> {
            let position = read_value(&**snapshot, "frontier").unwrap().as_text().unwrap().parse().unwrap();
            let scope = serde_json::from_str(read_value(&**snapshot, "scope").unwrap().as_text().unwrap()).unwrap();
            let history = serde_json::from_str(read_value(&**snapshot, "history").unwrap().as_text().unwrap()).unwrap();
            Ok(ReadPosition { scope, history, position })
        };
        publish(1, "first");
        // A separate store with the same copied header and first applied commit.
        // The writer below advances to 2; this copy deliberately stays at 1.
        let replica = lagged_supply.handle();
        let copy = Scope::begin(&*replica, Intent::Write).unwrap();
        for (key, value) in [
            ("scope", serde_json::to_string(&scope_id).unwrap()),
            ("history", serde_json::to_string(&history).unwrap()),
            ("frontier", "1".to_owned()),
            ("value", "first".to_owned()),
        ] {
            copy.put(FAMILY, &row(key, &value), When::New).unwrap();
        }
        copy.commit().unwrap();
        let (read, seen) = Scope::current_read_after(&*reader, floor, |snapshot| {
            let seen = observe(snapshot)?;
            publish(2, "later");
            Ok(seen)
        }).unwrap();
        assert_eq!(seen.position, 1, "{name}: frontier belongs to old snapshot");
        assert_eq!(read_value(&*read, "value"), Some(text("first")), "{name}: rows belong to same snapshot");
        read.rollback().unwrap();
        let (read, seen) = Scope::current_read_after(&*reader, floor, observe).unwrap();
        assert_eq!(seen.position, 2, "{name}: same-or-later is legal");
        assert_eq!(read_value(&*read, "value"), Some(text("later")));
        read.commit().unwrap();
        let lagged = Scope::current_read_after(&*replica, seen, observe);
        assert!(matches!(lagged, Err(Error::Unavailable(_))), "{name}: a fresh transaction on a lagged replica does not include the acknowledged second commit");
        assert!(!replica.scoped());
        for (minimum, expected) in [
            (ReadPosition { position: 3, ..floor }, trillion_local::cause!(Error::Unavailable)),
            (ReadPosition { position: u64::MAX, ..floor }, trillion_local::cause!(Error::Unavailable)),
            (ReadPosition { scope: [7;32], ..floor }, trillion_local::cause!(Error::Conflict)),
            (ReadPosition { history: [9;32], ..floor }, trillion_local::cause!(Error::Conflict)),
        ] {
            let mut observations = 0;
            let failed = Scope::current_read_after(&*reader, minimum, |snapshot| {
                observations += 1;
                observe(snapshot)
            });
            assert!(matches!(failed, Err(error) if error == expected), "{name}: floor must refuse");
            assert_eq!(observations, 1, "{name}: bounded refusal, no retry loop");
            assert!(!reader.scoped(), "{name}: failed qualification releases its snapshot");
        }
        // A failed read also closes its fresh snapshot, without an unknown-write result.
        let failed = Scope::current_read_after(&*reader, floor, |_| Err(trillion_local::cause!(Error::Interrupted)));
        assert!(matches!(failed, Err(Error::Interrupted(_))));
        assert!(!reader.scoped());
    }
}
