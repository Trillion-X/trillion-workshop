// Purpose: Prove every generic storage operation against the real SQLite supply.
// Invariants: fixtures open scratch databases only; no original or account data is read.

use super::{
    sqlite::{self, Access, Bounds, Selected, Spend},
    Error, Intent, Order, Query, Range, Read, Reply, Row, Scope, Storage, Value, When, Write,
};
use rusqlite::Connection;
use std::{
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};

fn bounds(spend: Spend, cancel: Option<Arc<AtomicBool>>) -> Bounds {
    Bounds { value_bytes: 1024 * 1024, work: 2_000_000, deadline: Duration::from_secs(5), spend, cancel, busy: Duration::ZERO }
}

#[test]
fn selected_close_keeps_committed_wal_and_reopen_reads_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = std::fs::canonicalize(dir.path()).unwrap().join("selected.sqlite");
    let prefill = Connection::open(&path).unwrap();
    prefill.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL)").unwrap();
    drop(prefill);
    let main_before = std::fs::read(&path).unwrap();
    let store = sqlite::open_selected(&path, "account_policy", Selected {
        access: Access::Write, bounds: bounds(Spend::WholeHandle, None), meter: None, trusted_schema: false,
    }).unwrap();
    let tx = Scope::begin(&store, Intent::Write).unwrap();
    tx.put("policy_directory", &[("name", text("committed")), ("value", text("durable-wal"))], When::New).unwrap();
    tx.commit().unwrap();
    drop(store);
    let wal = std::path::PathBuf::from(format!("{}-wal", path.display()));
    assert!(std::fs::metadata(&wal).unwrap().len() > 32, "selected close must leave committed WAL frames");
    assert_eq!(std::fs::read(&path).unwrap(), main_before, "close must not checkpoint committed pages into the main file");
    let reader = sqlite::open_selected(&path, "account_policy", Selected {
        access: Access::Read, bounds: bounds(Spend::WholeHandle, None), meter: None, trusted_schema: false,
    }).unwrap();
    let row = reader.get("policy_directory", &[text("committed")], &[Read::whole("value")]).unwrap().unwrap();
    assert_eq!(row.0, vec![text("durable-wal")]);
}

#[test]
fn selected_explicit_reclaim_still_truncates_wal_and_preserves_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = std::fs::canonicalize(dir.path()).unwrap().join("reclaim.sqlite");
    let prefill = Connection::open(&path).unwrap();
    prefill.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL)").unwrap();
    drop(prefill);
    let store = sqlite::open_selected(&path, "account_policy", Selected {
        access: Access::Write, bounds: bounds(Spend::WholeHandle, None), meter: None, trusted_schema: false,
    }).unwrap();
    let tx = Scope::begin(&store, Intent::Write).unwrap();
    tx.put("policy_directory", &[("name", text("kept")), ("value", text("preserved"))], When::New).unwrap();
    tx.commit().unwrap();
    store.reclaim().unwrap();
    let wal = std::path::PathBuf::from(format!("{}-wal", path.display()));
    assert_eq!(std::fs::metadata(&wal).unwrap().len(), 0, "explicit reclaim must still truncate WAL");
    drop(store);
    let db = Connection::open(&path).unwrap();
    let row: String = db.query_row("SELECT value FROM policy_directory WHERE name='kept'", [], |r|r.get(0)).unwrap();
    assert_eq!(row, "preserved");
}

#[test]
fn selected_reclaim_refuses_a_pinned_reader_until_it_releases() {
    let dir = tempfile::tempdir().unwrap();
    let path = std::fs::canonicalize(dir.path()).unwrap().join("busy-reclaim.sqlite");
    let prefill = Connection::open(&path).unwrap();
    prefill.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL)").unwrap();
    drop(prefill);
    let store = sqlite::open_selected(&path, "account_policy", Selected {
        access: Access::Write, bounds: bounds(Spend::WholeHandle, None), meter: None, trusted_schema: false,
    }).unwrap();
    let write = |value: &str| {
        let tx = Scope::begin(&store, Intent::Write).unwrap();
        tx.put("policy_directory", &[("name", text("kept")), ("value", text(value))], When::Always).unwrap();
        tx.commit().unwrap();
    };
    write("before");
    let reader = Connection::open(&path).unwrap();
    reader.execute_batch("BEGIN DEFERRED").unwrap();
    let old: String = reader.query_row("SELECT value FROM policy_directory WHERE name='kept'", [], |r|r.get(0)).unwrap();
    assert_eq!(old, "before");
    write("after");
    assert_eq!(store.reclaim(), Err(crate::cause!(Error::Busy)), "pinned WAL pages must never be reported reclaimed");
    reader.execute_batch("ROLLBACK").unwrap();
    drop(reader);
    store.reclaim().unwrap();
    let wal = std::path::PathBuf::from(format!("{}-wal", path.display()));
    assert_eq!(std::fs::metadata(wal).unwrap().len(), 0);
    assert_eq!(store.get("policy_directory", &[text("kept")], &[Read::whole("value")]).unwrap().unwrap().0, vec![text("after")]);
}

fn policy() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL);
         CREATE TABLE policy_gates(name TEXT PRIMARY KEY,sign_in TEXT NOT NULL,resource TEXT NOT NULL);",
    )
    .unwrap();
    db
}
fn text(value: &str) -> Value {
    Value::Text(value.into())
}
fn names(rows: Vec<Row>) -> Vec<String> {
    rows.into_iter().map(|mut row| row.take(0).as_text().unwrap().to_string()).collect()
}

#[test]
fn put_meets_existing_rows_as_declared() {
    let db = policy();
    let store = sqlite::lend(&db, "account_policy", Access::Write).unwrap();
    let row = |value: &str| [("name", text("a")), ("value", text(value))];
    assert_eq!(store.put("policy_directory", &row("1"), When::New).unwrap(), 1);
    assert_eq!(store.put("policy_directory", &row("2"), When::New), Err(crate::cause!(Error::Conflict)));
    assert_eq!(store.put("policy_directory", &row("2"), When::Absent).unwrap(), 0);
    assert_eq!(store.put("policy_directory", &row("3"), When::Always).unwrap(), 1);
    let read = |store: &dyn Storage| {
        store.get("policy_directory", &[text("a")], &[Read::whole("value")]).unwrap().unwrap().take(0)
    };
    assert_eq!(read(&store), text("3"));
    let stale = [("value", text("9"))];
    assert_eq!(store.put("policy_directory", &row("4"), When::Matches(&stale)).unwrap(), 0);
    let current = [("value", text("3"))];
    assert_eq!(store.put("policy_directory", &row("4"), When::Matches(&current)).unwrap(), 1);
    assert_eq!(read(&store), text("4"));
    assert!(store.get("policy_directory", &[text("missing")], &[Read::whole("value")]).unwrap().is_none());
}

#[test]
fn bounded_reads_report_oversized_values_without_returning_them() {
    let db = policy();
    let store = sqlite::lend(&db, "account_policy", Access::Write).unwrap();
    store.put("policy_directory", &[("name", text("big")), ("value", text(&"x".repeat(100)))], When::New).unwrap();
    let mut row = store
        .get("policy_directory", &[text("big")], &[Read::at_most("value", 99), Read::at_most("name", 8)])
        .unwrap()
        .unwrap();
    assert_eq!(row.take(0), Value::Oversized(100));
    assert_eq!(row.take(1), text("big"));
}

#[test]
fn scans_walk_declared_orders_with_cursors_prefixes_and_limits() {
    let db = policy();
    let store = sqlite::lend(&db, "account_policy", Access::Write).unwrap();
    for name in ["a", "source-snapshot:1", "source-snapshot:2", "source-snapshot;", "z"] {
        store.put("policy_gates", &[("name", text(name)), ("sign_in", text("s")), ("resource", text("r"))], When::New)
            .unwrap();
    }
    let read = [Read::whole("name")];
    assert_eq!(names(store.scan("policy_gates", &Range::all().after(vec![text("a")]).limit(1), &read).unwrap()), [
        "source-snapshot:1"
    ]);
    assert_eq!(names(store.scan("policy_gates", &Range::all().reverse().limit(1), &read).unwrap()), ["z"]);
    assert_eq!(names(store.scan("policy_gates", &Range::prefix("source-snapshot:"), &read).unwrap()), [
        "source-snapshot:1",
        "source-snapshot:2"
    ]);
    assert_eq!(
        names(
            store.scan("policy_gates", &Range::prefix("source-snapshot:").reverse().after(vec![text("source-snapshot:2")]), &read)
                .unwrap()
        ),
        ["source-snapshot:1"]
    );
    assert_eq!(store.erase("policy_gates", &Range::prefix("source-snapshot:")).unwrap(), 2);
    assert_eq!(names(store.scan("policy_gates", &Range::all(), &read).unwrap()), ["a", "source-snapshot;", "z"]);
    assert_eq!(store.erase("policy_gates", &Range::all().limit(1)), Err(crate::cause!(Error::Invalid)));
    assert_eq!(store.scan("policy_gates", &Range::all().order(Order::Arrival), &read), Err(crate::cause!(Error::Undeclared)));
}

#[test]
fn undeclared_families_and_fields_refuse_before_any_statement() {
    let db = policy();
    db.execute_batch("CREATE TABLE preserved_original(value TEXT)").unwrap();
    let store = sqlite::lend(&db, "account_policy", Access::Write).unwrap();
    assert_eq!(store.get("preserved_original", &[text("x")], &[Read::whole("value")]), Err(crate::cause!(Error::Undeclared)));
    assert_eq!(store.get("policy_directory", &[text("x")], &[Read::whole("other")]), Err(crate::cause!(Error::Undeclared)));
    assert_eq!(store.put("policy_directory", &[("name", text("x")), ("other", text("y"))], When::New), Err(crate::cause!(Error::Undeclared)));
    assert_eq!(store.put("policy_directory", &[("value", text("y"))], When::New), Err(crate::cause!(Error::Invalid)));
    assert_eq!(store.get("policy_directory", &[], &[Read::whole("value")]), Err(crate::cause!(Error::Invalid)));
    assert!(sqlite::lend(&db, "no_such_schema", Access::Write).is_err());
    assert!(store.present("policy_directory").unwrap());
    let empty = Connection::open_in_memory().unwrap();
    assert!(!sqlite::lend(&empty, "account_policy", Access::Write).unwrap().present("policy_gates").unwrap());
}

#[test]
fn scopes_commit_or_roll_back_and_report_their_state() {
    let db = policy();
    let store = sqlite::lend(&db, "account_policy", Access::Write).unwrap();
    let row = [("name", text("a")), ("value", text("1"))];
    {
        let scope = Scope::begin(&store, Intent::Write).unwrap();
        assert!(scope.scoped() && scope.writing().unwrap());
        scope.put("policy_directory", &row, When::New).unwrap();
    }
    assert!(!store.scoped());
    assert!(store.get("policy_directory", &[text("a")], &[Read::whole("value")]).unwrap().is_none());
    let scope = Scope::begin(&store, Intent::Read).unwrap();
    assert!(scope.scoped() && !scope.writing().unwrap());
    scope.rollback().unwrap();
    let before = store.changes();
    let scope = Scope::begin(&store, Intent::Write).unwrap();
    scope.put("policy_directory", &row, When::New).unwrap();
    scope.commit().unwrap();
    assert_eq!(store.changes(), before + 1);
    assert!(store.get("policy_directory", &[text("a")], &[Read::whole("value")]).unwrap().is_some());
}

#[test]
fn custody_marks_and_access_follow_the_physical_handle() {
    let temp = tempfile::tempdir().unwrap();
    let path = std::fs::canonicalize(temp.path()).unwrap().join("policy.sqlite");
    let writer = Connection::open(&path).unwrap();
    writer.execute_batch("CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL)").unwrap();
    let observer = Connection::open(&path).unwrap();
    let watched = sqlite::lend(&observer, "account_policy", Access::Write).unwrap();
    watched.custody().unwrap();
    assert_eq!(watched.location(), path.to_str());
    let mark = watched.mark().unwrap();
    writer.execute("INSERT INTO policy_directory VALUES('a','1')", []).unwrap();
    assert_ne!(watched.mark().unwrap(), mark, "another handle's commit moves the mark");
    assert_eq!(sqlite::lend(&observer, "account_policy", Access::Read).unwrap().custody(), Err(crate::cause!(Error::Moved)));
    let readonly = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(sqlite::lend(&readonly, "account_policy", Access::Write).unwrap().custody(), Err(crate::cause!(Error::Moved)));
    std::fs::rename(&path, temp.path().join("moved.sqlite")).unwrap();
    assert_eq!(watched.custody(), Err(crate::cause!(Error::Moved)));
}

#[test]
fn pinned_sources_open_immutable_and_bound_every_operation() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("ledger 1.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE metadata(name TEXT PRIMARY KEY,value TEXT);
         CREATE TABLE objects(key TEXT PRIMARY KEY,size INTEGER,etag TEXT,payload TEXT);
         INSERT INTO metadata VALUES('inventory','{\"complete\":true}');",
    )
    .unwrap();
    drop(db);
    let ledger = sqlite::open_pinned(&path, "r2_inventory_ledger", bounds(Spend::EachOperation, None)).unwrap();
    assert!(ledger.present("metadata").unwrap() && ledger.present("objects").unwrap());
    assert!(!ledger.present("copies").unwrap());
    let mut row = ledger.get("metadata", &[text("inventory")], &[Read::at_most("value", 64)]).unwrap().unwrap();
    assert_eq!(row.take(0), text("{\"complete\":true}"));
    assert_eq!(ledger.put("metadata", &[("name", text("x")), ("value", text("y"))], When::New), Err(crate::cause!(Error::ReadOnly)));
    assert!(!temp.path().join("ledger 1.sqlite-wal").exists(), "an immutable open creates no sidecar");
    assert!(sqlite::immutable_uri(&path).unwrap().ends_with("ledger%201.sqlite?mode=ro&immutable=1"));
}

#[test]
fn prefix_ranges_end_at_the_next_text() {
    assert_eq!(super::successor("ab"), Some("ac".into()));
    assert_eq!(super::successor("a\u{D7FF}"), Some("a\u{E000}".into()));
    assert_eq!(super::successor("a\u{10FFFF}"), Some("b".into()));
    assert_eq!(super::successor("\u{10FFFF}"), None);
}

#[test]
fn selected_files_open_with_their_access_meter_and_allowance() {
    let temp = tempfile::tempdir().unwrap();
    let path = std::fs::canonicalize(temp.path()).unwrap().join("policy.sqlite");
    let prefill = Connection::open(&path).unwrap();
    prefill.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL)")
        .unwrap();
    let meter = crate::sqlite_work::WorkMeter::new();
    let open = |access, spend, cancel| Selected { access, bounds: bounds(spend, cancel), meter: None, trusted_schema: false };
    let writer = sqlite::open_selected(
        &path,
        "account_policy",
        Selected { meter: Some(meter.clone()), ..open(Access::Write, Spend::WholeHandle, None) },
    )
    .unwrap();
    writer.custody().unwrap();
    let scope = Scope::begin(&writer, Intent::Write).unwrap();
    for at in 0..3000 {
        scope.put("policy_directory", &[("name", text(&format!("n{at:05}"))), ("value", text("v"))], When::New).unwrap();
    }
    scope.commit().unwrap();
    assert!(meter.snapshot().unwrap().work.rows_written >= 3000, "the owner's meter observes the supply's work");
    let reader = sqlite::open_selected(&path, "account_policy", open(Access::Read, Spend::EachOperation, None)).unwrap();
    reader.custody().unwrap();
    assert_eq!(reader.put("policy_directory", &[("name", text("x")), ("value", text("y"))], When::New), Err(crate::cause!(Error::ReadOnly)));
    assert_eq!(reader.scan("policy_directory", &Range::all(), &[Read::whole("name")]).unwrap().len(), 3000);
    assert!(reader.allocated_bytes().unwrap() > 0);
    let cancel = Arc::new(AtomicBool::new(true));
    let cancelled =
        sqlite::open_selected(&path, "account_policy", open(Access::Read, Spend::EachOperation, Some(cancel))).unwrap();
    assert_eq!(cancelled.scan("policy_directory", &Range::all(), &[Read::whole("name")]), Err(crate::cause!(Error::Interrupted)));
    let unbounded = Selected {
        bounds: Bounds { work: u64::MAX, deadline: Duration::MAX, ..bounds(Spend::EachOperation, None) },
        ..open(Access::Read, Spend::EachOperation, None)
    };
    let unbounded = sqlite::open_selected(&path, "account_policy", unbounded).unwrap();
    assert_eq!(unbounded.count("policy_directory", &Range::all()).unwrap(), 3000);
    assert!(sqlite::open_selected(&temp.path().join("absent.sqlite"), "account_policy", open(Access::Read, Spend::EachOperation, None))
        .is_err(), "a selected file is never created");
}

#[test]
fn nested_scopes_commit_or_roll_back_without_ending_the_outer_scope() {
    let db = policy();
    let store = sqlite::lend(&db, "account_policy", Access::Write).unwrap();
    assert_eq!(Scope::begin(&store, Intent::Nested).err(), Some(crate::cause!(Error::Invalid)), "a nested scope needs an outer one");
    let mark = store.schema_mark().unwrap();
    let outer = Scope::begin(&store, Intent::Write).unwrap();
    {
        let kept = Scope::begin(&*outer, Intent::Nested).unwrap();
        kept.put("policy_directory", &[("name", text("kept")), ("value", text("1"))], When::New).unwrap();
        kept.commit().unwrap();
    }
    {
        let dropped = Scope::begin(&*outer, Intent::Nested).unwrap();
        dropped.put("policy_directory", &[("name", text("dropped")), ("value", text("1"))], When::New).unwrap();
    }
    assert!(outer.scoped());
    outer.commit().unwrap();
    let read = [Read::whole("name")];
    assert_eq!(names(store.scan("policy_directory", &Range::all(), &read).unwrap()), ["kept"]);
    db.execute_batch("CREATE TABLE later(x)").unwrap();
    assert_ne!(store.schema_mark().unwrap(), mark);
}

#[test]
fn partial_orders_and_counts_walk_only_their_rows() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE items(id TEXT PRIMARY KEY,space TEXT,kind TEXT,withdrawn_at TEXT);
         CREATE INDEX items_live ON items(space,kind) WHERE withdrawn_at IS NULL;",
    )
    .unwrap();
    let store = sqlite::lend(&db, "storage_test", Access::Write).unwrap();
    for (id, space, kind, withdrawn) in
        [("a", "s1", "note", None), ("b", "s1", "note", Some("t")), ("c", "s1", "file", None), ("d", "s2", "note", None)]
    {
        let withdrawn = withdrawn.map_or(Value::Null, text);
        let row = [("id", text(id)), ("space", text(space)), ("kind", text(kind)), ("withdrawn_at", withdrawn)];
        store.put("items", &row, When::New).unwrap();
    }
    let live = |from: Vec<Value>, to: Vec<Value>| Range {
        order: Order::Named("live_by_space_kind"),
        from: super::Bound::Included(from),
        to: super::Bound::Included(to),
        reverse: false,
        limit: None,
    };
    assert_eq!(store.count("items", &live(vec![text("s1")], vec![text("s1")])).unwrap(), 2);
    assert_eq!(store.count("items", &live(vec![text("s1"), text("note")], vec![text("s1"), text("note")])).unwrap(), 1);
    assert_eq!(names(store.scan("items", &live(vec![text("s1")], vec![text("s1")]), &[Read::whole("id")]).unwrap()), [
        "c", "a"
    ]);
    assert_eq!(store.count("items", &Range::all().limit(3)).unwrap(), 3);
    let mut tail = store.scan("items", &Range::all().order(Order::Arrival).reverse().limit(1), &[Read::whole("id"), Read::arrival()]).unwrap();
    assert_eq!(tail[0].take(0), text("d"));
    assert_eq!(tail[0].take(1), Value::Integer(4));
    assert_eq!(store.scan("items", &Range::all().order(Order::Named("absent")), &[Read::whole("id")]), Err(crate::cause!(Error::Undeclared)));
}

/// A small deterministic generator for the differential test.
struct Lcg(u64);
impl Lcg {
    fn below(&mut self, n: u64) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) % n
    }
}

#[test]
fn the_memory_supply_answers_every_operation_as_the_sqlite_supply_does() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("differential.sqlite");
    let disk = sqlite::open_owned(&path, "record_store", bounds(Spend::EachOperation, None)).unwrap();
    let memory = super::memory::Memory::open("record_store").unwrap();
    let stores: [&dyn Storage; 2] = [&disk, &memory];
    let mut rng = Lcg(42);
    let pick = |rng: &mut Lcg, values: &[Value]| values[rng.below(values.len() as u64) as usize].clone();
    let accounts = [text("a"), text("b")];
    let ids: Vec<Value> = (0..6).map(|n| text(&format!("id{n}"))).collect();
    let stamps = [Value::Integer(1), Value::Integer(2), Value::Integer(3), Value::Integer(i64::MAX)];
    let orders = [Order::Key, Order::Named("live"), Order::Named("changed"), Order::Named("ending"), Order::Named("gone")];
    let read = [Read::whole("account"), Read::whole("id"), Read::whole("valid_to"), Read::whole("version"), Read::at_most("body", 3)];
    for step in 0..4000 {
        let key = [pick(&mut rng, &accounts), text("r"), pick(&mut rng, &ids), pick(&mut rng, &stamps)];
        let answers: Vec<String> = match rng.below(6) {
            0 | 1 => {
                let row = [
                    ("account", key[0].clone()),
                    ("resource", key[1].clone()),
                    ("id", key[2].clone()),
                    ("valid_to", key[3].clone()),
                    ("valid_from", Value::Integer(rng.below(5) as i64)),
                    ("version", Value::Integer(rng.below(3) as i64)),
                    ("deleted", Value::Integer(rng.below(2) as i64)),
                    ("body", if rng.below(4) == 0 { Value::Null } else { Value::Blob(vec![7; rng.below(6) as usize]) }),
                ];
                let expected = [("version", Value::Integer(rng.below(3) as i64))];
                let when = match rng.below(4) {
                    0 => When::Always,
                    1 => When::Absent,
                    2 => When::New,
                    _ => When::Matches(&expected),
                };
                stores.iter().map(|store| format!("{:?}", store.put("versions", &row, when))).collect()
            }
            2 => {
                let prefix = key[..1 + rng.below(4) as usize].to_vec();
                let range = Range { from: super::Bound::Included(prefix.clone()), to: super::Bound::Included(prefix), ..Range::all() };
                stores.iter().map(|store| format!("{:?}", store.erase("versions", &range))).collect()
            }
            3 => {
                let open = rng.below(2) == 0;
                stores
                    .iter()
                    .map(|store| {
                        if open && !store.scoped() {
                            format!("{:?}", store.open_scope(Intent::Write))
                        } else if store.scoped() {
                            format!("{:?}", store.close_scope(open))
                        } else {
                            "none".into()
                        }
                    })
                    .collect()
            }
            _ => {
                let order = orders[rng.below(orders.len() as u64) as usize];
                let cursor = match order {
                    Order::Key => vec![key[0].clone(), key[1].clone(), key[2].clone(), key[3].clone()],
                    _ => vec![key[0].clone(), key[1].clone(), key[2].clone()],
                };
                let bound = |rng: &mut Lcg| {
                    let prefix = cursor[..1 + rng.below(cursor.len() as u64) as usize].to_vec();
                    match rng.below(3) {
                        0 => super::Bound::Unbounded,
                        1 => super::Bound::Included(prefix),
                        _ => super::Bound::Excluded(prefix),
                    }
                };
                let mut range = Range { order, from: bound(&mut rng), to: bound(&mut rng), reverse: false, limit: None };
                if rng.below(2) == 0 {
                    range = range.reverse();
                }
                if rng.below(2) == 0 {
                    range = range.limit(1 + rng.below(4) as usize);
                }
                stores
                    .iter()
                    .map(|store| format!("{:?} {:?}", store.scan("versions", &range, &read), store.count("versions", &range)))
                    .collect()
            }
        };
        // Each supply names its own construction site, so the sites differ by design. The answers must match once
        // those sites are set aside, and each refusal must still carry the cause of its own supply.
        assert_eq!(
            without_causes(&answers[0]),
            without_causes(&answers[1]),
            "step {step}: sqlite (left) and memory (right) differ"
        );
        if answers[0].contains("Cause(") {
            assert!(answers[0].contains("trillion_local::storage::sqlite@"), "step {step}: sqlite cause");
        }
        if answers[1].contains("Cause(") {
            assert!(answers[1].contains("trillion_local::storage::memory@"), "step {step}: memory cause");
        }
    }
}

/// The `items` table the test families declare, on a connection of its own.
fn items_connection() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE items(id TEXT PRIMARY KEY,space TEXT,kind TEXT,withdrawn_at TEXT);
         CREATE INDEX items_live ON items(space,kind) WHERE withdrawn_at IS NULL;",
    )
    .unwrap();
    db
}

fn item(id: &str, space: Option<&str>, kind: Option<&str>) -> Vec<(&'static str, Value)> {
    vec![
        ("id", text(id)),
        ("space", space.map_or(Value::Null, text)),
        ("kind", kind.map_or(Value::Null, text)),
        ("withdrawn_at", Value::Null),
    ]
}

#[test]
fn a_null_in_a_cursor_or_a_bound_decides_only_where_the_comparison_is_decided() {
    // SQLite's row-value comparison is decided at the first position where the two sides differ; a NULL there is no
    // answer, a NULL after that position does not matter. The memory supply must select the same rows.
    let db = items_connection();
    let disk = sqlite::lend(&db, "storage_test", Access::Write).unwrap();
    let memory = super::memory::Memory::open("storage_test").unwrap();
    let rows = [
        ("a", Some("s1"), Some("note")),
        ("b", Some("s1"), None),
        ("c", None, Some("note")),
        ("d", None, None),
        ("e", Some("s2"), Some("note")),
        ("f", Some("s2"), None),
        ("g", Some("s1"), Some("file")),
    ];
    for (id, space, kind) in rows {
        for store in [&disk as &dyn Storage, &memory] {
            store.put("items", &item(id, space, kind), When::New).unwrap();
        }
    }
    let prefixes: Vec<Vec<Value>> = vec![
        vec![text("s1")],
        vec![text("s1"), text("note")],
        vec![text("s1"), Value::Null],
        vec![Value::Null],
        vec![Value::Null, text("note")],
        vec![text("s2"), Value::Null],
        vec![text("s0")],
        vec![text("s3"), text("note")],
    ];
    let mut bounds = vec![super::Bound::Unbounded];
    for prefix in &prefixes {
        bounds.push(super::Bound::Included(prefix.clone()));
        bounds.push(super::Bound::Excluded(prefix.clone()));
    }
    let mut compared = 0;
    for from in &bounds {
        for to in &bounds {
            for reverse in [false, true] {
                let range = Range { order: Order::Named("live_by_space_kind"), from: from.clone(), to: to.clone(), reverse, limit: None };
                let read = [Read::whole("id")];
                let (left, right) = (disk.scan("items", &range, &read), memory.scan("items", &range, &read));
                assert_eq!(left, right, "scan {range:?}");
                assert_eq!(disk.count("items", &range), memory.count("items", &range), "count {range:?}");
                compared += 1;
            }
        }
    }
    assert_eq!(compared, bounds.len() * bounds.len() * 2);
}

#[test]
fn batch_reads_and_writes_answer_as_the_single_operations_do() {
    let db = items_connection();
    let disk = sqlite::lend(&db, "storage_test", Access::Write).unwrap();
    let memory = super::memory::Memory::open("storage_test").unwrap();
    for store in [&disk as &dyn Storage, &memory] {
        let rows = [item("a", Some("s1"), Some("note")), item("b", Some("s1"), None), item("a", Some("s2"), None), item("c", None, None)];
        let writes: Vec<Write<'_>> = rows.iter().map(|row| Write::Put { family: "items", row, when: When::New }).collect();
        // Outside a scope each write stands alone: the third is refused (`a` is held) and the fourth is never asked.
        assert_eq!(store.write_many(&writes), Err(crate::cause!(Error::Conflict)));
        let read = [Read::whole("space")];
        let keys = [vec![text("a")], vec![text("c")], vec![text("b")], vec![text("a")]];
        let queries: Vec<Query<'_>> = keys.iter().map(|key| Query::Get { family: "items", key, read: &read }).collect();
        let found: Vec<Option<Row>> = store.read_many(&queries).unwrap().into_iter().map(|reply| reply.row().unwrap()).collect();
        assert_eq!(found.len(), 4);
        assert_eq!(found[0], Some(Row(vec![text("s1")])), "{}", store.location().unwrap_or("memory"));
        assert_eq!(found[1], None);
        assert_eq!(found[2], Some(Row(vec![text("s1")])));
        assert_eq!(found[3], found[0]);
        // Point gets and a range in one batch answer what each would alone, in the order asked.
        let all = Range::all();
        let mixed = [
            Query::Get { family: "items", key: &keys[1], read: &read },
            Query::Scan { family: "items", range: &all, read: &read },
            Query::Get { family: "items", key: &keys[0], read: &read },
        ];
        let replies = store.read_many(&mixed).unwrap();
        assert_eq!(replies[0], Reply::Row(None));
        assert_eq!(replies[1], Reply::Rows(store.scan("items", &all, &read).unwrap()));
        assert_eq!(replies[2], Reply::Row(found[0].clone()));
        // The same batch inside a scope: the refusal leaves the writes before it done and the scope usable.
        store.open_scope(Intent::Write).unwrap();
        let more = [item("d", None, None), item("a", None, None), item("e", None, None)];
        let writes: Vec<Write<'_>> = more.iter().map(|row| Write::Put { family: "items", row, when: When::New }).collect();
        assert_eq!(store.write_many(&writes), Err(crate::cause!(Error::Conflict)));
        assert_eq!(store.put("items", &item("f", None, None), When::New), Ok(1));
        let erased = Range::all();
        let batch = [Write::Erase { family: "items", range: &erased }];
        assert_eq!(store.write_many(&batch).unwrap().len(), 1);
        assert_eq!(store.count("items", &Range::all()), Ok(0));
        store.close_scope(false).unwrap();
        assert_eq!(store.count("items", &Range::all()), Ok(2));
    }
}

#[test]
fn declared_partial_orders_become_partial_indexes_the_queries_use() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("plan.sqlite");
    let store = sqlite::open_owned(&path, "record_store", bounds(Spend::EachOperation, None)).unwrap();
    store.put("versions", &[("account", text("a")), ("resource", text("r")), ("id", text("i")), ("valid_to", Value::Integer(i64::MAX))], When::New).unwrap();
    drop(store);
    let db = Connection::open(&path).unwrap();
    let plan = |sql: &str| -> String {
        let mut statement = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let rows: Vec<String> = statement.query_map([], |row| row.get::<_, String>(3)).unwrap().map(Result::unwrap).collect();
        rows.join("; ")
    };
    // The exact text the supply builds for a walk of the live order (its partial condition as literals).
    let live = plan(
        "SELECT \"id\" FROM \"versions\" WHERE (\"account\",\"resource\",\"id\")>('a','r','') AND (\"account\",\"resource\")<=('a','r') AND \"valid_to\" IS 9223372036854775807 AND \"deleted\" IS 0 ORDER BY \"account\",\"resource\",\"id\"",
    );
    assert!(live.contains("versions__live"), "{live}");
    let ending = plan(
        "SELECT \"id\" FROM \"versions\" WHERE (\"account\",\"resource\")>=('a','r') AND (\"account\",\"resource\",\"valid_to\")<('a','r',5) AND \"valid_to\" IS NOT 9223372036854775807 ORDER BY \"account\",\"resource\",\"valid_to\"",
    );
    assert!(ending.contains("versions__ending"), "{ending}");
}

/// The tables and indexes a scratch file holds, by name.
fn tables_at(path: &std::path::Path) -> Vec<String> {
    let db = Connection::open(path).unwrap();
    let mut statement = db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").unwrap();
    statement.query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect()
}

/// A family whose DATA row says `"made": "first_write"` (old trillion `schema-on-first-write.mjs`, here per family):
/// the store opens without its table; reads, counts, erases and compare-and-sets answer as an empty table and make
/// nothing; the first put makes the table and its order index, and later reads see the row.
#[test]
fn a_first_write_family_is_made_by_its_first_put_and_reads_as_empty_until_then() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("first-write.sqlite");
    let store = sqlite::open_owned(&path, "storage_test", bounds(Spend::EachOperation, None)).unwrap();
    assert!(tables_at(&path).contains(&"items".to_string()), "a family made on open is made on open");
    assert!(!tables_at(&path).iter().any(|name| name.starts_with("drafts")), "opening writes nothing for a first-write family");
    assert_eq!(store.get("drafts", &[text("a")], &[Read::whole("title")]).unwrap(), None);
    assert!(store.scan("drafts", &Range::all().order(Order::Named("by_title")), &[Read::whole("id")]).unwrap().is_empty());
    assert_eq!(store.count("drafts", &Range::all()).unwrap(), 0);
    assert_eq!(store.erase("drafts", &Range::prefix("a")).unwrap(), 0);
    assert_eq!(store.put("drafts", &[("id", text("a")), ("title", text("b"))], When::Matches(&[("title", text("x"))])).unwrap(), 0);
    assert!(!store.present("drafts").unwrap());
    assert!(!tables_at(&path).iter().any(|name| name.starts_with("drafts")), "reads, counts, erases and compare-and-sets make nothing");
    assert_eq!(store.put("drafts", &[("id", text("a")), ("title", text("Alpha")), ("size", Value::Integer(3))], When::New).unwrap(), 1);
    assert!(tables_at(&path).contains(&"drafts".to_string()) && tables_at(&path).contains(&"drafts__by_title".to_string()), "the put made its table and index");
    assert!(store.present("drafts").unwrap());
    let rows = store.scan("drafts", &Range::all().order(Order::Named("by_title")), &[Read::whole("id"), Read::whole("size")]).unwrap();
    assert_eq!(rows, vec![Row(vec![text("a"), Value::Integer(3)])]);
    assert_eq!(store.count("drafts", &Range::all()).unwrap(), 1);
}

/// A table a put made inside a scope that rolled back is gone with it; the next read still answers empty and the next put
/// makes it again. A put refused outside a scope leaves no table behind.
#[test]
fn a_first_write_family_taken_back_by_a_rollback_is_made_again_by_the_next_put() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("first-write-rollback.sqlite");
    let store = sqlite::open_owned(&path, "storage_test", bounds(Spend::EachOperation, None)).unwrap();
    {
        let tx = Scope::begin(&store, Intent::Write).unwrap();
        tx.put("drafts", &[("id", text("a")), ("title", text("Alpha"))], When::Always).unwrap();
        assert_eq!(tx.count("drafts", &Range::all()).unwrap(), 1, "the scope sees its own write");
        tx.rollback().unwrap();
    }
    assert!(!tables_at(&path).iter().any(|name| name.starts_with("drafts")), "the rollback took the table back");
    assert_eq!(store.get("drafts", &[text("a")], &[Read::whole("id")]).unwrap(), None, "a read of it does not fail");
    assert_eq!(store.put("drafts", &[("title", text("no key"))], When::Always), Err(crate::cause!(Error::Invalid)));
    assert!(!tables_at(&path).iter().any(|name| name.starts_with("drafts")), "a refused put made nothing");
    store.put("drafts", &[("id", text("b")), ("title", text("Beta"))], When::Always).unwrap();
    drop(store);
    let reopened = sqlite::open_owned(&path, "storage_test", bounds(Spend::EachOperation, None)).unwrap();
    assert_eq!(reopened.get("drafts", &[text("b")], &[Read::whole("title")]).unwrap(), Some(Row(vec![text("Beta")])));
}

/// The memory supply has no tables; a first-write family answers there exactly as on SQLite.
#[test]
fn a_first_write_family_answers_the_same_on_memory_and_sqlite() {
    let dir = tempfile::tempdir().unwrap();
    let disk = sqlite::open_owned(&dir.path().join("first-write-same.sqlite"), "storage_test", bounds(Spend::EachOperation, None)).unwrap();
    let memory = super::memory::Memory::open("storage_test").unwrap();
    for store in [&disk as &dyn Storage, &memory] {
        assert_eq!(store.count("drafts", &Range::all()).unwrap(), 0);
        assert_eq!(store.put("drafts", &[("id", text("a")), ("title", text("Alpha"))], When::Absent).unwrap(), 1);
        assert_eq!(store.put("drafts", &[("id", text("a")), ("title", text("Again"))], When::Absent).unwrap(), 0);
        assert_eq!(store.get("drafts", &[text("a")], &[Read::whole("title")]).unwrap(), Some(Row(vec![text("Alpha")])));
        assert_eq!(store.erase("drafts", &Range::all()).unwrap(), 1);
    }
}

/// A file is made in one schema commit and one sync: every family, its WAL mode, page size and incremental vacuum are
/// there, and reopening it while another connection holds its write reservation runs no statement that would wait.
#[test]
fn a_made_file_has_every_family_and_reopening_it_never_waits_on_its_writer() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("made.sqlite");
    let made = sqlite::open_owned(&path, "record_store", bounds(Spend::EachOperation, None)).unwrap();
    drop(made);
    let raw = Connection::open(&path).unwrap();
    let mode: String = raw.query_row("PRAGMA journal_mode", [], |row| row.get(0)).unwrap();
    let vacuum: i64 = raw.query_row("PRAGMA auto_vacuum", [], |row| row.get(0)).unwrap();
    let tables: i64 = raw.query_row("SELECT count(*) FROM sqlite_schema WHERE type = 'table'", [], |row| row.get(0)).unwrap();
    assert_eq!((mode.as_str(), vacuum), ("wal", 2), "WAL and incremental vacuum");
    // A family made on its first write (`"made": "first_write"`) has no table until then.
    let made_on_open = super::schema("record_store").unwrap().families.iter().filter(|family| family.made == super::Made::Open).count();
    assert_eq!(tables as usize, made_on_open, "every family made on open is a table");
    // Another connection holds the write reservation; `busy` is zero, so any write the open tried would fail at once.
    raw.execute_batch("BEGIN IMMEDIATE").unwrap();
    let reopened = sqlite::open_owned(&path, "record_store", bounds(Spend::EachOperation, None));
    assert!(reopened.is_ok(), "a file with every family opens without the write lock: {:?}", reopened.err());
    raw.execute_batch("ROLLBACK").unwrap();
}

/// A file whose making a crash cut off before its first page reached the disk holds only zero bytes: it is made
/// again. A file with any other unreadable content is refused, never emptied.
#[test]
fn a_file_of_zero_bytes_is_made_again_and_any_other_unreadable_file_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let zeros = dir.path().canonicalize().unwrap().join("zeros.sqlite");
    std::fs::write(&zeros, vec![0_u8; 32 * 1024]).unwrap();
    let store = sqlite::open_owned(&zeros, "record_store", bounds(Spend::EachOperation, None)).unwrap();
    assert!(store.count("versions", &Range::all()).is_ok(), "the zeroed file is a working store again");
    drop(store);
    let garbage = dir.path().canonicalize().unwrap().join("garbage.sqlite");
    let mut bytes = vec![0_u8; 32 * 1024];
    bytes[1000] = 7;
    std::fs::write(&garbage, &bytes).unwrap();
    assert!(sqlite::open_owned(&garbage, "record_store", bounds(Spend::EachOperation, None)).is_err());
    assert_eq!(std::fs::read(&garbage).unwrap(), bytes, "an unreadable file with content is left exactly as it was");
}

// ---- Ported from old trillion tests deleted by Trillion-X/trillion #243 (tag old-trillion-before-worker-retire,
// b6ae0ebf81): test/current-start-table-rebuild.test.mjs, test/schema-version-skips-index-retirement.test.mjs and
// test/delete-everything-lazy-tables.test.mjs. The old person store's constructor (its `schema_version` row and the DDL
// it skipped once current) is this supply's open (`sqlite::open_owned`, `prepare_owned`): it makes from the schema's
// DATA every family that does not exist yet, and runs no statement on a file that already has every table and index.
// The harness opens scratch files of the test schema (`storage_test`) instead of booting a person store; tables the
// old store kept that nothing here owns are named in the port report.

/// The tables, indexes and triggers a scratch file holds, by name (the old `sqlite_master` read).
fn objects_at(path: &std::path::Path) -> Vec<String> {
    let db = Connection::open(path).unwrap();
    let mut statement = db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").unwrap();
    statement.query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect()
}

/// The file's DDL counter (`PRAGMA schema_version`): it moves on every CREATE or DROP.
fn ddl_version_at(path: &std::path::Path) -> i64 {
    Connection::open(path).unwrap().query_row("PRAGMA schema_version", [], |row| row.get(0)).unwrap()
}

fn old_item(store: &impl Storage, id: &str) {
    store.put("items", &[("id", text(id)), ("space", text("s")), ("kind", text("k"))], When::New).unwrap();
}

/// Ported from old test/current-start-table-rebuild.test.mjs, "a current store holding the key-only release queue
/// starts, keeps its rows and has the rebuilt table and index". A current file that lost one family's index (as the old
/// one-time rebuild left `namespace_release_keys_open`) starts, keeps the family's rows and has the index again, and the
/// start after that is an ordinary one. The old key-only to (key, origin) key rebuild has no owner: the release queue is
/// a new family that never had the old key (record_store_resources.json `@account-files/release/`, "not carried").
#[test]
fn old_current_start_table_rebuild_a_current_file_missing_an_index_starts_keeps_its_rows_and_has_the_index() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("current.sqlite");
    let store = sqlite::open_owned(&path, "storage_test", bounds(Spend::EachOperation, None)).unwrap();
    old_item(&store, "kept-key");
    drop(store);
    Connection::open(&path).unwrap().execute_batch("DROP INDEX items__live_by_space_kind").unwrap();
    assert!(!objects_at(&path).contains(&"items__live_by_space_kind".to_string()));
    let store = sqlite::open_owned(&path, "storage_test", bounds(Spend::EachOperation, None)).unwrap();
    assert!(objects_at(&path).contains(&"items__live_by_space_kind".to_string()), "the index is made again");
    let rows = store.scan("items", &Range::all(), &[Read::whole("id")]).unwrap();
    assert_eq!(rows, vec![Row(vec![text("kept-key")])], "the family keeps its rows");
    drop(store);
    // And the start after that is an ordinary current start.
    sqlite::open_owned(&path, "storage_test", bounds(Spend::EachOperation, None)).unwrap();
}

/// Ported from old test/current-start-table-rebuild.test.mjs, "a current store kept before its admission and
/// control-source tables were named gets them on its next start": a current file without a family's table (and so its
/// indexes) gets them on its next start. The old `native_behavior_control_sources` and `resource_admission_meta` are
/// retired tables here (record_store_resources.json `retire`); the test family `items` stands in for them.
#[test]
fn old_current_start_table_rebuild_a_current_file_without_a_familys_table_gets_it_on_its_next_start() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("before.sqlite");
    drop(sqlite::open_owned(&path, "storage_test", bounds(Spend::EachOperation, None)).unwrap());
    let made_on_open = objects_at(&path);
    Connection::open(&path).unwrap().execute_batch("DROP TABLE items").unwrap();
    assert!(!objects_at(&path).iter().any(|name| name.starts_with("items")));
    let store = sqlite::open_owned(&path, "storage_test", bounds(Spend::EachOperation, None)).unwrap();
    assert_eq!(objects_at(&path), made_on_open, "the table and every index of it are made again");
    old_item(&store, "a");
}

/// Ported from old test/schema-version-skips-index-retirement.test.mjs, "a store already at the schema version drops no
/// index on a cold start" and "... repeats no table, index or trigger statement on a cold start". A second cold open of
/// a current file changes no table, index or trigger (its DDL counter stays), writes no row, and issues at most the old
/// cap of 93 statements (the old test's limit, "only goes down"), counted by the supply's own work meter.
#[test]
fn old_schema_version_skips_index_retirement_a_current_file_makes_and_drops_nothing_on_a_cold_start() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("current.sqlite");
    let first = sqlite::open_owned(&path, "storage_test", bounds(Spend::EachOperation, None)).unwrap();
    old_item(&first, "a");
    drop(first);
    let objects = objects_at(&path);
    let version = ddl_version_at(&path);
    let meter = crate::sqlite_work::WorkMeter::new();
    let cold = sqlite::open_owned_observed(&path, "storage_test", bounds(Spend::EachOperation, None), meter.clone()).unwrap();
    let work = meter.snapshot().unwrap().work;
    assert_eq!(ddl_version_at(&path), version, "a current file must not make or drop a table, index or trigger again");
    assert_eq!(objects_at(&path), objects);
    assert_eq!(work.rows_written, 0, "a cold start of a current file writes nothing");
    assert!(work.sql_statements <= 93, "a cold start of a current file issued {} statements", work.sql_statements);
    assert_eq!(cold.count("items", &Range::all()).unwrap(), 1);
}

/// Ported from old test/schema-version-skips-index-retirement.test.mjs, "a table added since a current store last
/// started is made on its next cold start, with no version bump": the table is made on the next open, and the open after
/// that makes nothing again. (The old "construction stages" test logged Durable Object identities; no owner here.)
#[test]
fn old_schema_version_skips_index_retirement_a_table_added_since_is_made_on_the_next_cold_start_and_not_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("added.sqlite");
    drop(sqlite::open_owned(&path, "storage_test", bounds(Spend::EachOperation, None)).unwrap());
    Connection::open(&path).unwrap().execute_batch("DROP TABLE items").unwrap();
    drop(sqlite::open_owned(&path, "storage_test", bounds(Spend::EachOperation, None)).unwrap());
    assert!(objects_at(&path).contains(&"items".to_string()), "the new table exists after the next cold start");
    let version = ddl_version_at(&path);
    drop(sqlite::open_owned(&path, "storage_test", bounds(Spend::EachOperation, None)).unwrap());
    assert_eq!(ddl_version_at(&path), version, "the following start makes nothing again");
}

/// Ported from old test/delete-everything-lazy-tables.test.mjs, "after deleting everything, every lazy table owner
/// makes its table again" and "a delete that stopped after its tables were dropped finishes when the store is opened
/// again". The old lazy tables (made on first use and remembered) are this supply's first-write families (`"made":
/// "first_write"`); with every table dropped, as the old deleteAll left the store, the next open makes every family made
/// on open, a first-write family reads as empty and its next put makes it again: nothing answers "no such table". The
/// old alarm test is left out: no alarm drives a deletion here (src/account/erase.rs, "the alarm ... dropped").
#[test]
fn old_delete_everything_lazy_tables_after_every_table_is_dropped_every_family_is_made_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("emptied.sqlite");
    let store = sqlite::open_owned(&path, "storage_test", bounds(Spend::EachOperation, None)).unwrap();
    old_item(&store, "a");
    store.put("drafts", &[("id", text("a")), ("title", text("Alpha"))], When::New).unwrap();
    drop(store);
    let raw = Connection::open(&path).unwrap();
    let tables: Vec<String> = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").unwrap()
        .query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect();
    for table in tables {
        raw.execute_batch(&format!("DROP TABLE IF EXISTS \"{table}\"")).unwrap();
    }
    drop(raw);
    assert!(objects_at(&path).is_empty());
    let store = sqlite::open_owned(&path, "storage_test", bounds(Spend::EachOperation, None)).unwrap();
    assert_eq!(store.count("items", &Range::all()).unwrap(), 0, "a family made on open is there again, empty");
    assert_eq!(store.get("drafts", &[text("a")], &[Read::whole("title")]).unwrap(), None, "a first-write family reads as empty");
    old_item(&store, "b");
    store.put("drafts", &[("id", text("b")), ("title", text("Beta"))], When::New).unwrap();
    assert_eq!(store.get("drafts", &[text("b")], &[Read::whole("title")]).unwrap(), Some(Row(vec![text("Beta")])));
}

#[test]
fn storage_refusals_keep_the_exact_condition_without_key_values() {
    let store = super::memory::Memory::open("account_policy").unwrap();
    let private_key = "private-storage-condition-marker";
    let malformed_key = store
        .get("policy_directory", &[text(private_key), text("extra-key")], &[Read::whole("value")])
        .unwrap_err();
    let limited_erase = store
        .erase("policy_directory", &Range::all().limit(1))
        .unwrap_err();
    assert!(matches!(&malformed_key, Error::Invalid(_)));
    assert!(matches!(&limited_erase, Error::Invalid(_)));
    assert_eq!(malformed_key, limited_erase, "the existing error classification is unchanged");
    assert_ne!(malformed_key.cause(), limited_erase.cause());

    let source = include_str!("memory.rs");
    for (error, condition) in [
        (&malformed_key, "if key.len() != family.key.len()"),
        (&limited_erase, "if range.limit.is_some()"),
    ] {
        let condition_at = source.find(condition).unwrap();
        let site = condition_at + source[condition_at..].find("crate::cause!(Error::Invalid)").unwrap();
        let line = source[..site].bytes().filter(|byte| *byte == b'\n').count() + 1;
        let column = site - source[..site].rfind('\n').map_or(0, |at| at + 1) + 1;
        assert_eq!(error.cause().file(), "src/storage/memory.rs");
        assert_eq!(error.cause().line() as usize, line);
        assert_eq!(error.cause().column() as usize, column);
        assert_eq!(error.cause().condition(), "Error::Invalid");
        assert!(!format!("{error:?}").contains(private_key));
    }
    let same_condition = store
        .get("policy_directory", &[], &[Read::whole("value")])
        .unwrap_err();
    assert_eq!(malformed_key.cause(), same_condition.cause(), "values do not change a condition's identity");
}

/// The answer text with each cause's site replaced by a fixed word: the site is the one thing the two supplies
/// are meant to differ in.
fn without_causes(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("Cause(") {
        out.push_str(&rest[..start]);
        out.push_str("Cause(site)");
        rest = match rest[start..].find(')') {
            Some(end) => &rest[start + end + 1..],
            None => "",
        };
    }
    out.push_str(rest);
    out
}
