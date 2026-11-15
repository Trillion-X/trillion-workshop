// src/storage/supplies/tests/write_reads.rs
//
// Purpose: Count the reads the record store makes per write on the relational and key-value supplies, on a prefilled
// store, and hold them to the memory supply's count. Before this test the server supplies counted their own commits
// in `Storage::mark`, so every write saw a moved mark and dropped the record store's newest stamps and search memory:
// about two extra row reads, a search memory reload and the mark read on every write. Their mark now leaves out the
// handle's own commits (as SQLite's `data_version` and the memory supply do), and this test is the bound.
//
// Non-Negotiable Invariants:
// - Steady writes from one handle read no more rows, and make no more seeks, than the same writes on the memory
//   supply (the record store's own `work` counter, logical reads).
// - Another handle's commit still moves the mark: the next write reloads, its stamp follows the other handle's, and a
//   search finds the other handle's record.
//
// Key Concepts:
// - The relational supply runs over SQLite through rusqlite (the `Dialect::Sqlite` statements libSQL also takes), and
//   the key-value supply over an in-process ordered map, so the test needs no server. The wire and the backend also
//   count the statements and requests they answered.
//
// Security Considerations:
// - Scratch files in a temporary folder only; no account, credential or personal state.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use local_engine::{
    records::{Mutation, Records},
    storage::{
        memory::Memory,
        record_store::{settings::Limits, Clock, RecordStore, Work},
        Error, Result, Storage,
    },
};
use serde_json::json;
use std::{
    cell::Cell as Count,
    collections::BTreeMap,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use storage_supplies::{
    kv::{Atomicity, Backend, Kv, Limits as KvLimits, Outcome, Write},
    sql::{Answer, Cell, Dialect, Param, Shape, Step, Supply, Wire},
    SCHEMA,
};

#[derive(Clone)]
struct Manual(Arc<AtomicU64>);
impl Clock for Manual {
    fn now_ms(&self) -> i64 {
        self.0.fetch_add(1, Ordering::SeqCst) as i64
    }
}

/// A relational wire over one SQLite connection: SQLite's own dialect, statements run one after another.
struct Sqlite {
    db: rusqlite::Connection,
    selects: Count<u64>,
}
impl Sqlite {
    fn open(path: &Path) -> Self {
        let db = rusqlite::Connection::open(path).unwrap();
        db.busy_timeout(std::time::Duration::from_millis(50)).unwrap();
        Self { db, selects: Count::new(0) }
    }
}
fn failure(error: rusqlite::Error) -> Error {
    match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::ConstraintViolation) => local_engine::cause!(Error::Conflict),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => local_engine::cause!(Error::Busy),
        Some(rusqlite::ErrorCode::TooBig) => local_engine::cause!(Error::TooBig),
        _ => local_engine::cause!(Error::Unavailable),
    }
}
impl Wire for Sqlite {
    fn dialect(&self) -> Dialect {
        Dialect::Sqlite
    }
    fn pipeline(&self, steps: &[Step]) -> Result<Vec<Answer>> {
        let mut answers = Vec::with_capacity(steps.len());
        for step in steps {
            let mut statement = self.db.prepare(&step.sql).map_err(failure)?;
            let params: Vec<rusqlite::types::Value> = step
                .params
                .iter()
                .map(|param| match param {
                    Param::Bytes(bytes) => rusqlite::types::Value::Blob(bytes.clone()),
                    Param::Int(number) => rusqlite::types::Value::Integer(*number),
                })
                .collect();
            let params = rusqlite::params_from_iter(params);
            match step.shape {
                Shape::Rows => {
                    self.selects.set(self.selects.get() + 1);
                    let width = statement.column_count();
                    let mut rows = statement.query(params).map_err(failure)?;
                    let mut found = Vec::new();
                    while let Some(row) = rows.next().map_err(failure)? {
                        let mut cells = Vec::with_capacity(width);
                        for at in 0..width {
                            cells.push(match row.get_ref(at).map_err(failure)? {
                                rusqlite::types::ValueRef::Null => Cell::Null,
                                rusqlite::types::ValueRef::Integer(number) => Cell::Int(number),
                                rusqlite::types::ValueRef::Blob(bytes) | rusqlite::types::ValueRef::Text(bytes) => Cell::Bytes(bytes.to_vec()),
                                rusqlite::types::ValueRef::Real(_) => return Err(local_engine::cause!(Error::Unavailable)),
                            });
                        }
                        found.push(cells);
                    }
                    answers.push(Answer::Rows(found));
                }
                Shape::Changed => match statement.execute(params) {
                    Ok(changed) => answers.push(Answer::Changed(changed as u64)),
                    Err(rusqlite::Error::ExecuteReturnedResults) => answers.push(Answer::Changed(0)),
                    Err(error) => return Err(failure(error)),
                },
            }
        }
        Ok(answers)
    }
    fn script(&self, statements: &[String]) -> Result<()> {
        statements.iter().try_for_each(|sql| self.db.execute_batch(sql).map_err(failure))
    }
    fn rounds(&self) -> u64 {
        self.selects.get()
    }
    fn place(&self) -> String {
        "sqlite (test wire)".into()
    }
}

/// A key-value backend over one ordered map shared by every handle, each request under one lock.
#[derive(Clone, Default)]
struct Map {
    entries: Arc<Mutex<BTreeMap<Vec<u8>, Vec<u8>>>>,
}
struct Handle {
    map: Map,
    requests: Count<u64>,
}
impl Handle {
    fn ask(&self) {
        self.requests.set(self.requests.get() + 1);
    }
}
impl Backend for Handle {
    fn atomicity(&self) -> Atomicity {
        Atomicity::Full
    }
    fn limits(&self) -> KvLimits {
        KvLimits { max_key: 1 << 16, max_value: 1 << 24, max_writes: 1 << 16 }
    }
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.ask();
        Ok(self.map.entries.lock().unwrap().get(key).cloned())
    }
    fn get_many(&self, keys: &[Vec<u8>]) -> Result<Vec<Option<Vec<u8>>>> {
        self.ask();
        let entries = self.map.entries.lock().unwrap();
        Ok(keys.iter().map(|key| entries.get(key).cloned()).collect())
    }
    fn range(&self, lo: &[u8], hi: Option<&[u8]>, reverse: bool, limit: usize, _values: bool) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
        self.ask();
        let entries = self.map.entries.lock().unwrap();
        let upper = match hi {
            Some(hi) => std::ops::Bound::Excluded(hi.to_vec()),
            None => std::ops::Bound::Unbounded,
        };
        let walk = entries.range((std::ops::Bound::Included(lo.to_vec()), upper));
        let pick = |(key, value): (&Vec<u8>, &Vec<u8>)| (key.clone(), value.clone());
        Ok(if reverse { walk.rev().take(limit).map(pick).collect() } else { walk.take(limit).map(pick).collect() })
    }
    fn apply(&self, guard: (&[u8], Option<&[u8]>), writes: &[Write]) -> Result<Outcome> {
        self.ask();
        let mut entries = self.map.entries.lock().unwrap();
        if entries.get(guard.0).map(Vec::as_slice) != guard.1 {
            return Ok(Outcome::Refused);
        }
        for write in writes {
            match write {
                Write::Set(key, value) => entries.insert(key.clone(), value.clone()),
                Write::Delete(key) => entries.remove(key),
            };
        }
        Ok(Outcome::Applied)
    }
    fn rounds(&self) -> u64 {
        self.requests.get()
    }
    fn place(&self) -> String {
        "memory map (test backend)".into()
    }
}

const ACCOUNT: &str = "account";
const RESOURCE: &str = "own-records";
const PREFILLED: usize = 200;
const MEASURED: u64 = 20;

fn store<S: Storage>(storage: S, clock: &Manual) -> RecordStore<S> {
    RecordStore::new(storage, Box::new(clock.clone()), Limits::fixed(1 << 20, 10 << 30)).unwrap()
}

fn put(id: &str, expected: i64, key: &str, title: &str) -> Mutation {
    Mutation { id: id.into(), expected_version: expected, request_key: key.into(), deleted: false, value: json!({"kind": "note", "title": title}) }
}

/// Prefill the store, warm it with one write, then measure `MEASURED` updates of one record: the record store's work
/// over them, and the requests the supply answered (from `rounds`).
fn steady<S: Storage + Send>(store: &mut RecordStore<S>, rounds: impl Fn(&S) -> u64) -> (Work, u64) {
    for n in 0..PREFILLED {
        store.mutate(ACCOUNT, RESOURCE, put(&format!("note:{n:03}"), 0, &format!("prefill{n}"), &format!("prefilled note {n}"))).unwrap();
    }
    store.mutate(ACCOUNT, RESOURCE, put("note:000", 1, "warm", "warm")).unwrap();
    let (work, sent) = (store.work(), rounds(store.storage()));
    for n in 0..MEASURED {
        store.mutate(ACCOUNT, RESOURCE, put("note:000", 2 + n as i64, &format!("edit{n}"), &format!("edit {n}"))).unwrap();
    }
    let now = store.work();
    (Work { seeks: now.seeks - work.seeks, rows_read: now.rows_read - work.rows_read }, rounds(store.storage()) - sent)
}

/// Another handle writes a record; the measured handle's next write must see it: its stamp is later, a search finds
/// the other record, and that write pays the reload the steady writes do not.
fn another_handle_is_seen<S: Storage + Send>(mine: &mut RecordStore<S>, theirs: &mut RecordStore<S>, steady: Work) {
    let other = theirs.mutate(ACCOUNT, RESOURCE, put("note:other", 0, "other", "zanzibar from another handle")).unwrap();
    let before = mine.work();
    let next = mine.mutate(ACCOUNT, RESOURCE, put("note:000", 2 + MEASURED as i64, "after-other", "after other")).unwrap();
    let paid = mine.work().rows_read - before.rows_read;
    assert!(next.sequence > other.sequence, "a write after another handle's commit is stamped before it: {} <= {}", next.sequence, other.sequence);
    assert!(paid * MEASURED > steady.rows_read, "another handle's commit did not make the next write reload: {paid} rows");
    let found = mine.search(ACCOUNT, RESOURCE, Some("title"), "zanzibar", 5).unwrap();
    assert_eq!(found.records.iter().map(|record| record.id.as_str()).collect::<Vec<_>>(), vec!["note:other"]);
}

#[test]
fn a_write_reads_no_more_than_on_the_memory_supply() {
    let clock = Manual(Arc::new(AtomicU64::new(1_800_000_000_000)));

    let memory = Memory::open(SCHEMA).unwrap();
    let mut memory_store = store(memory.reopen(), &clock);
    let (bound, _) = steady(&mut memory_store, |_| 0);
    let mut memory_other = store(memory.reopen(), &clock);
    another_handle_is_seen(&mut memory_store, &mut memory_other, bound);

    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("store.sqlite");
    let mut sql_store = store(Supply::open(Sqlite::open(&file), SCHEMA).unwrap(), &clock);
    let (sql, sql_selects) = steady(&mut sql_store, |supply| supply.rounds());
    let mut sql_other = store(Supply::open(Sqlite::open(&file), SCHEMA).unwrap(), &clock);
    another_handle_is_seen(&mut sql_store, &mut sql_other, sql);

    let map = Map::default();
    let handle = || Kv::open(Handle { map: map.clone(), requests: Count::new(0) }, SCHEMA).unwrap();
    let mut kv_store = store(handle(), &clock);
    let (kv, kv_requests) = steady(&mut kv_store, |supply| supply.rounds());
    let mut kv_other = store(handle(), &clock);
    another_handle_is_seen(&mut kv_store, &mut kv_other, kv);

    println!(
        "WRITE_READS {}",
        json!({"writes": MEASURED, "prefilled": PREFILLED,
               "memory": {"seeks": bound.seeks, "rows_read": bound.rows_read},
               "sql": {"seeks": sql.seeks, "rows_read": sql.rows_read, "select_statements": sql_selects},
               "kv": {"seeks": kv.seeks, "rows_read": kv.rows_read, "requests": kv_requests}})
    );
    for (supply, work) in [("sql", sql), ("kv", kv)] {
        assert!(work.seeks <= bound.seeks, "{supply}: {} seeks over {MEASURED} writes, memory {}", work.seeks, bound.seeks);
        assert!(work.rows_read <= bound.rows_read, "{supply}: {} rows read over {MEASURED} writes, memory {}", work.rows_read, bound.rows_read);
    }
}
