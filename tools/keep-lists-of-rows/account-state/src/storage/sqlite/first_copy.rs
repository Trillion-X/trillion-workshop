// src/storage/sqlite/first_copy.rs
//
// Purpose: fill a new computer's store from a taken copy of another computer's store, in keyset pages, then hand it to the
// feed (src/storage/record_store/follow.rs) to follow from the stamp it was taken at. This is the port of the old engine's account carry
// between hosts (Trillion-X/trillion src/resource-state-carry.mjs): stop the source, carry its rows in keyset pages
// of 1 MiB (a page up to 4 MiB taken, one row up to 16 MiB as its own page), and read the counts and identities back
// before the source copy is let go. What changed: the source is not taken, a copy of it is (`take_copy`, SQLite's
// VACUUM INTO, one read transaction, so the source keeps writing), and what comes after the stamp the copy was taken at is the
// ordinary feed of the account's writer, not a second carry.
//
// Non-Negotiable Invariants:
// - a taken copy is one consistent snapshot: every row of one committed state of the source, nothing after it.
// - A fill writes only a store file that does not exist yet. It never writes over a store.
// - One page is one transaction at the new store: a page is all there, or none of it.
// - A page is filled to `page_bytes`; a page larger than `accepted_page_bytes` is only ever one row; a row larger than
//   `row_max_bytes` refuses the fill. No row is split, none is skipped.
// - The fill counts as done only when every table's row count and identity, read back from the new store, are the ones
//   the taken copy was described with (`TakenCopy`). A store that does not match is removed, with its WAL files.
// - The schema comes from the taken copy, and only tables and indexes are taken (`statements`): never a trigger or a
//   view, so a taken copy cannot make the new store run anything.
// - No value is printed, logged or put in an error. Errors name a fixed reason only.
//
// Key Concepts:
// - `take_copy(source, out)`: the taken copy and its description (`TakenCopy`: each table, its rows and its identity).
// - `describe(file)`: the description of a store file, read in each table's key order.
// - `fill(taken, expected, target)`: the new store, paged, checked against `expected`; answers what it took
//   (`Filled`: pages, rows, bytes, the largest page, milliseconds).
// - Key order: a `WITHOUT ROWID` table by its primary key; a rowid table (one that keeps arrival order) by its rowid,
//   which the fill keeps, so arrival order is the same at the new store.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use content_crypto::advanced::blake3;
use rusqlite::{types::Value, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{fmt, path::Path, sync::OnceLock, time::Instant};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    _what: String,
    page_bytes: u64,
    accepted_page_bytes: u64,
    row_max_bytes: u64,
    statements: Vec<String>,
    identity_context: String,
}

fn settings() -> &'static Settings {
    static VALUE: OnceLock<Settings> = OnceLock::new();
    VALUE.get_or_init(|| {
        let value: Settings = serde_json::from_slice(include_bytes!("first_copy.json")).expect("sqlite/first_copy.json is valid");
        assert!(!value._what.is_empty() && value.page_bytes <= value.accepted_page_bytes
            && value.accepted_page_bytes <= value.row_max_bytes, "sqlite/first_copy.json holds together");
        value
    })
}

/// The page bounds of one fill: the size a page is filled to, the largest page of more than one row, the largest row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bounds {
    pub page_bytes: u64,
    pub accepted_page_bytes: u64,
    pub row_max_bytes: u64,
}

impl Bounds {
    /// The shipped bounds (`first_copy.json`).
    pub fn shipped() -> Self {
        let settings = settings();
        Bounds { page_bytes: settings.page_bytes, accepted_page_bytes: settings.accepted_page_bytes, row_max_bytes: settings.row_max_bytes }
    }
}

/// Why taking a copy or a fill did not finish. No variant carries a value, a key or a path.
#[derive(Debug, Clone)]
pub enum FillError {
    /// The source or taken file could not be read.
    Unreadable(&'static str, crate::refusal_cause::Cause),
    /// The new store could not be written.
    Unwritable(&'static str, crate::refusal_cause::Cause),
    /// The taken copy holds a schema statement that is not a table or an index.
    Schema(crate::refusal_cause::Cause),
    /// One row is larger than `row_max_bytes`.
    RowTooLarge(crate::refusal_cause::Cause),
    /// The new store does not hold what the taken copy was described with.
    Mismatch(crate::refusal_cause::Cause),
}
impl FillError {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Unreadable(_, cause) => cause,
            Self::Unwritable(_, cause) => cause,
            Self::Schema(cause) => cause,
            Self::RowTooLarge(cause) => cause,
            Self::Mismatch(cause) => cause,
        }
    }
}
crate::impl_caused!(FillError);


impl PartialEq for FillError {
    fn eq(&self, other: &Self) -> bool {
        match (self,other) {
            (Self::Unreadable(a0, _),Self::Unreadable(b0, _)) => a0 == b0,
            (Self::Unwritable(a0, _),Self::Unwritable(b0, _)) => a0 == b0,
            (Self::Schema(_),Self::Schema(_)) => true,
            (Self::RowTooLarge(_),Self::RowTooLarge(_)) => true,
            (Self::Mismatch(_),Self::Mismatch(_)) => true,
            _ => false,
        }
    }
}
impl Eq for FillError {}


impl fmt::Display for FillError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreadable(why, _) => write!(f, "the taken copy could not be read: {why}"),
            Self::Unwritable(why, _) => write!(f, "the new store could not be written: {why}"),
            Self::Schema(_) => write!(f, "the taken copy holds a schema statement that is not a table or an index"),
            Self::RowTooLarge(_) => write!(f, "one row of the taken copy is larger than a fill takes"),
            Self::Mismatch(_) => write!(f, "the new store does not hold the rows the taken copy was described with"),
        }
    }
}

impl std::error::Error for FillError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

/// One table of a store as described: its name, its row count, and its identity (BLAKE3 over every row in key order).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Table {
    pub name: String,
    pub rows: u64,
    pub identity: String,
}

/// What a taken copy holds: every table, in name order.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct TakenCopy {
    pub tables: Vec<Table>,
}

/// What one fill took.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct Filled {
    pub pages: u64,
    pub rows: u64,
    pub bytes: u64,
    pub largest_page_bytes: u64,
    pub ms: u64,
}

/// How a table is walked: its columns, and the key it is ordered and paged by.
struct Walk {
    table: String,
    columns: Vec<String>,
    /// The key columns; for a rowid table, the rowid alone.
    key: Vec<String>,
    rowid: bool,
}

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn open_read(path: &Path) -> Result<Connection, FillError> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|_| FillError::Unreadable("it did not open", crate::cause!()))?;
    connection.execute_batch("PRAGMA trusted_schema=OFF;").map_err(|_| FillError::Unreadable("it did not open", crate::cause!()))?;
    Ok(connection)
}

/// The tables of `db` (not SQLite's own), in name order, each with its walk.
fn walks(db: &Connection) -> Result<Vec<Walk>, FillError> {
    let mut tables: Vec<(String, bool)> = db
        .prepare("SELECT name, wr FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
        .and_then(|mut statement| {
            statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0)))?.collect()
        })
        .map_err(|_| FillError::Unreadable("its schema could not be read", crate::cause!()))?;
    tables.sort();
    let mut walks = Vec::with_capacity(tables.len());
    for (table, without_rowid) in tables {
        let info: Vec<(String, i64)> = db
            .prepare("SELECT name, pk FROM pragma_table_info(?1) ORDER BY cid")
            .and_then(|mut statement| statement.query_map([&table], |row| Ok((row.get(0)?, row.get(1)?)))?.collect())
            .map_err(|_| FillError::Unreadable("its schema could not be read", crate::cause!()))?;
        let columns: Vec<String> = info.iter().map(|(name, _)| name.clone()).collect();
        let key = if without_rowid {
            let mut key: Vec<(i64, String)> = info.iter().filter(|(_, pk)| *pk > 0).map(|(name, pk)| (*pk, name.clone())).collect();
            key.sort();
            key.into_iter().map(|(_, name)| name).collect()
        } else {
            vec!["rowid".to_owned()]
        };
        if key.is_empty() || columns.is_empty() {
            return Err(FillError::Unreadable("a table has no key", crate::cause!()));
        }
        walks.push(Walk { table, columns, key, rowid: !without_rowid });
    }
    Ok(walks)
}

impl Walk {
    /// The selected columns: the rowid first for a rowid table, then every column.
    fn selected(&self) -> Vec<String> {
        let mut selected = Vec::with_capacity(self.columns.len() + 1);
        if self.rowid {
            selected.push("rowid".to_owned());
        }
        selected.extend(self.columns.iter().cloned());
        selected
    }

    /// Where each key column is among the selected columns.
    fn key_at(&self) -> Vec<usize> {
        let selected = self.selected();
        self.key.iter().map(|key| selected.iter().position(|name| name == key).unwrap_or(0)).collect()
    }

    /// The page query: every selected column in key order, after the key `?` when `after` (a row value comparison).
    fn query(&self, after: bool) -> String {
        let selected: Vec<String> = self.selected().iter().map(|name| quoted(name)).collect();
        let key: Vec<String> = self.key.iter().map(|name| quoted(name)).collect();
        let place: Vec<String> = (1..=self.key.len()).map(|at| format!("?{at}")).collect();
        let filter = if after { format!(" WHERE ({}) > ({})", key.join(","), place.join(",")) } else { String::new() };
        format!("SELECT {} FROM {}{filter} ORDER BY {}", selected.join(","), quoted(&self.table), key.join(","))
    }

    fn insert(&self) -> String {
        let selected: Vec<String> = self.selected().iter().map(|name| quoted(name)).collect();
        let place: Vec<String> = (1..=selected.len()).map(|at| format!("?{at}")).collect();
        format!("INSERT INTO {}({}) VALUES({})", quoted(&self.table), selected.join(","), place.join(","))
    }
}

/// The bytes one value takes: its text or blob length, eight for a number, none for null.
fn value_bytes(value: &Value) -> u64 {
    match value {
        Value::Null => 0,
        Value::Integer(_) | Value::Real(_) => 8,
        Value::Text(text) => text.len() as u64,
        Value::Blob(blob) => blob.len() as u64,
    }
}

/// Add one value to a table identity: a type tag, its length, its bytes.
fn hash_value(hasher: &mut blake3::Hasher, value: &Value) {
    let (tag, bytes): (u8, Vec<u8>) = match value {
        Value::Null => (0, Vec::new()),
        Value::Integer(number) => (1, number.to_le_bytes().to_vec()),
        Value::Real(number) => (2, number.to_bits().to_le_bytes().to_vec()),
        Value::Text(text) => (3, text.as_bytes().to_vec()),
        Value::Blob(blob) => (4, blob.clone()),
    };
    hasher.update(&[tag]);
    hasher.update(&(bytes.len() as u64).to_le_bytes());
    hasher.update(&bytes);
}

fn read_row(row: &rusqlite::Row<'_>, width: usize) -> rusqlite::Result<Vec<Value>> {
    (0..width).map(|at| row.get::<_, Value>(at)).collect()
}

/// The description of the store file `file`: every table, its rows and its identity, read in key order.
pub fn describe(file: &Path) -> Result<TakenCopy, FillError> {
    let db = open_read(file)?;
    describe_open(&db)
}

fn describe_open(db: &Connection) -> Result<TakenCopy, FillError> {
    let mut tables = Vec::new();
    for walk in walks(db)? {
        let width = walk.selected().len();
        let mut hasher = blake3::Hasher::new_derive_key(&settings().identity_context);
        hasher.update(walk.table.as_bytes());
        let mut statement = db.prepare(&walk.query(false)).map_err(|_| FillError::Unreadable("a table could not be read", crate::cause!()))?;
        let mut rows = statement.query([]).map_err(|_| FillError::Unreadable("a table could not be read", crate::cause!()))?;
        let mut count = 0u64;
        while let Some(row) = rows.next().map_err(|_| FillError::Unreadable("a table could not be read", crate::cause!()))? {
            for value in read_row(row, width).map_err(|_| FillError::Unreadable("a table could not be read", crate::cause!()))? {
                hash_value(&mut hasher, &value);
            }
            count += 1;
        }
        tables.push(Table { name: walk.table, rows: count, identity: hasher.finalize().to_hex().to_string() });
    }
    Ok(TakenCopy { tables })
}

/// Take a copy of the store file `source` into `out` (which must not exist): one consistent snapshot, made in one read
/// transaction while the source keeps writing (SQLite's VACUUM INTO). Answers its description.
pub fn take_copy(source: &Path, out: &Path) -> Result<TakenCopy, FillError> {
    if out.exists() {
        return Err(FillError::Unwritable("the taken copy is already there", crate::cause!()));
    }
    let target = out.to_str().ok_or(FillError::Unwritable("the taken copy's path is not text", crate::cause!()))?;
    let db = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|_| FillError::Unreadable("it did not open", crate::cause!()))?;
    db.busy_timeout(std::time::Duration::from_secs(10)).map_err(|_| FillError::Unreadable("it did not open", crate::cause!()))?;
    db.execute("VACUUM INTO ?1", [target]).map_err(|_| FillError::Unwritable("the snapshot could not be made", crate::cause!()))?;
    drop(db);
    describe(out)
}

/// Remove a store file that did not fill whole, with its WAL files.
fn remove_store(path: &Path) {
    let _ = std::fs::remove_file(path);
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut beside = path.as_os_str().to_owned();
        beside.push(suffix);
        let _ = std::fs::remove_file(std::path::PathBuf::from(beside));
    }
}

/// Fill the store file `target` (which must not exist) from the taken copy `taken`, in pages within the shipped
/// bounds, and check it against `expected` (the taken copy's description, made where it was taken).
pub fn fill(taken: &Path, expected: &TakenCopy, target: &Path) -> Result<Filled, FillError> {
    fill_within(taken, expected, target, Bounds::shipped())
}

/// `fill` within `bounds`.
pub fn fill_within(taken: &Path, expected: &TakenCopy, target: &Path, bounds: Bounds) -> Result<Filled, FillError> {
    if target.exists() {
        return Err(FillError::Unwritable("a store is already there", crate::cause!()));
    }
    let started = Instant::now();
    let source = open_read(taken)?;
    let result = (|| {
        let db = Connection::open(target).map_err(|_| FillError::Unwritable("it could not be made", crate::cause!()))?;
        let mut Filled = fill_open(&source, &db, bounds)?;
        if describe_open(&db)? != *expected {
            return Err(crate::cause!(FillError::Mismatch));
        }
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").map_err(|_| FillError::Unwritable("it could not be settled", crate::cause!()))?;
        Filled.ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        Ok(Filled)
    })();
    if result.is_err() {
        remove_store(target);
    }
    result
}

fn fill_open(source: &Connection, db: &Connection, bounds: Bounds) -> Result<Filled, FillError> {
    // A new file keeps the store's own modes: space given back in steps, WAL, full sync (src/storage/sqlite.rs).
    db.execute_batch("PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;")
        .map_err(|_| FillError::Unwritable("it could not be made", crate::cause!()))?;
    // The schema: tables first, then indexes, each a statement this fill takes.
    let schema: Vec<(String, String)> = source
        .prepare("SELECT type, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type='index', rowid")
        .and_then(|mut statement| statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?.collect())
        .map_err(|_| FillError::Unreadable("its schema could not be read", crate::cause!()))?;
    for (kind, sql) in &schema {
        let taken = (kind == "table" || kind == "index")
            && settings().statements.iter().any(|start| sql.len() >= start.len() && sql[..start.len()].eq_ignore_ascii_case(start));
        if !taken {
            return Err(crate::cause!(FillError::Schema));
        }
        db.execute_batch(sql).map_err(|_| FillError::Unwritable("its schema could not be made", crate::cause!()))?;
    }
    let mut Filled = Filled::default();
    for walk in walks(source)? {
        let width = walk.selected().len();
        let key_at = walk.key_at();
        let insert = walk.insert();
        let mut after: Option<Vec<Value>> = None;
        loop {
            // One page: rows in key order after the last row of the page before, filled to `page_bytes`.
            let mut page: Vec<Vec<Value>> = Vec::new();
            let mut page_bytes = 0u64;
            {
                let mut statement = source.prepare(&walk.query(after.is_some())).map_err(|_| FillError::Unreadable("a page could not be read", crate::cause!()))?;
                let mut rows = match &after {
                    Some(key) => statement.query(rusqlite::params_from_iter(key.iter())),
                    None => statement.query([]),
                }
                .map_err(|_| FillError::Unreadable("a page could not be read", crate::cause!()))?;
                while let Some(row) = rows.next().map_err(|_| FillError::Unreadable("a page could not be read", crate::cause!()))? {
                    let values = read_row(row, width).map_err(|_| FillError::Unreadable("a page could not be read", crate::cause!()))?;
                    let bytes: u64 = values.iter().map(value_bytes).sum();
                    if bytes > bounds.row_max_bytes {
                        return Err(crate::cause!(FillError::RowTooLarge));
                    }
                    // A row that would take a page of others past what is accepted starts the next page instead.
                    if !page.is_empty() && page_bytes + bytes > bounds.accepted_page_bytes {
                        break;
                    }
                    page_bytes += bytes;
                    page.push(values);
                    if page_bytes >= bounds.page_bytes {
                        break;
                    }
                }
            }
            let Some(last) = page.last() else { break };
            after = Some(key_at.iter().map(|at| last[*at].clone()).collect());
            let transaction = db.unchecked_transaction().map_err(|_| FillError::Unwritable("a page could not be written", crate::cause!()))?;
            {
                let mut statement = transaction.prepare_cached(&insert).map_err(|_| FillError::Unwritable("a page could not be written", crate::cause!()))?;
                for values in &page {
                    statement.execute(rusqlite::params_from_iter(values.iter())).map_err(|_| FillError::Unwritable("a page could not be written", crate::cause!()))?;
                }
            }
            transaction.commit().map_err(|_| FillError::Unwritable("a page could not be written", crate::cause!()))?;
            Filled.pages += 1;
            Filled.rows += page.len() as u64;
            Filled.bytes += page_bytes;
            Filled.largest_page_bytes = Filled.largest_page_bytes.max(page_bytes);
        }
    }
    Ok(Filled)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(path: &Path) -> Connection {
        let db = Connection::open(path).unwrap();
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE kv(family TEXT, key TEXT, value BLOB, n INTEGER, PRIMARY KEY(family, key)) WITHOUT ROWID;
             CREATE INDEX kv_n ON kv(n);
             CREATE TABLE arrival(at TEXT, value TEXT);
             CREATE UNIQUE INDEX arrival_key ON arrival(at);",
        )
        .unwrap();
        db
    }

    fn add_rows(db: &Connection, rows: usize, bytes: usize, from: usize) {
        let transaction = db.unchecked_transaction().unwrap();
        for at in from..from + rows {
            let value = vec![(at % 251) as u8; bytes];
            transaction.execute("INSERT INTO kv VALUES(?1, ?2, ?3, ?4)", rusqlite::params![format!("f{}", at % 3), format!("k{at:08}"), value, at as i64]).unwrap();
            transaction.execute("INSERT INTO arrival(at, value) VALUES(?1, ?2)", rusqlite::params![format!("a{at:08}"), "x".repeat(at % 17)]).unwrap();
        }
        transaction.commit().unwrap();
    }

    #[test]
    fn a_taken_copy_fills_a_new_store_in_bounded_pages_with_the_same_rows_and_order() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.sqlite");
        let db = store(&source);
        add_rows(&db, 600, 5000, 0);
        // A row removed before the copy was taken leaves a gap in the arrival rowids, which the fill keeps.
        db.execute("DELETE FROM arrival WHERE at='a00000010'", []).unwrap();
        let taken = dir.path().join("taken.sqlite");
        let described = take_copy(&source, &taken).unwrap();
        // The source keeps writing after the copy was taken; the taken copy does not move.
        add_rows(&db, 5, 10, 600);
        assert_eq!(describe(&taken).unwrap(), described);
        assert_ne!(describe(&source).unwrap(), described);
        assert_eq!(described.tables.iter().map(|table| (table.name.as_str(), table.rows)).collect::<Vec<_>>(), vec![("arrival", 599), ("kv", 600)]);

        let bounds = Bounds { page_bytes: 64 * 1024, accepted_page_bytes: 256 * 1024, row_max_bytes: 1024 * 1024 };
        let target = dir.path().join("target.sqlite");
        let Filled = fill_within(&taken, &described, &target, bounds).unwrap();
        assert_eq!(Filled.rows, 1199);
        assert!(Filled.pages > 40, "{Filled:?}");
        assert!(Filled.largest_page_bytes <= bounds.accepted_page_bytes, "{Filled:?}");
        assert_eq!(describe(&target).unwrap(), described, "counts and identities read back the same");
        // Arrival order and the indexes came along.
        let target_db = Connection::open(&target).unwrap();
        let gap: i64 = target_db.query_row("SELECT count(*) FROM arrival WHERE rowid=11", [], |row| row.get(0)).unwrap();
        assert_eq!(gap, 0, "the removed row's rowid stays a gap");
        let indexes: i64 = target_db.query_row("SELECT count(*) FROM sqlite_schema WHERE type='index' AND name IN ('kv_n','arrival_key')", [], |row| row.get(0)).unwrap();
        assert_eq!(indexes, 2);
        // A fill never writes over a store.
        assert_eq!(fill_within(&taken, &described, &target, bounds), Err(FillError::Unwritable("a store is already there", crate::cause!())));
    }

    #[test]
    fn a_large_row_goes_alone_and_a_row_past_the_limit_refuses_and_leaves_no_store() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.sqlite");
        let db = store(&source);
        add_rows(&db, 3, 100, 0);
        db.execute("INSERT INTO kv VALUES('f9', 'big', ?1, 1)", [vec![7u8; 300 * 1024]]).unwrap();
        let taken = dir.path().join("taken.sqlite");
        let described = take_copy(&source, &taken).unwrap();
        let bounds = Bounds { page_bytes: 1024, accepted_page_bytes: 4096, row_max_bytes: 512 * 1024 };
        let target = dir.path().join("target.sqlite");
        let Filled = fill_within(&taken, &described, &target, bounds).unwrap();
        assert_eq!(Filled.largest_page_bytes, 300 * 1024 + 8 + 2 + 3, "the large row went as its own page");
        assert_eq!(describe(&target).unwrap(), described);

        let target = dir.path().join("refused.sqlite");
        let small = Bounds { row_max_bytes: 64 * 1024, ..bounds };
        assert_eq!(fill_within(&taken, &described, &target, small), Err(crate::cause!(FillError::RowTooLarge)));
        assert!(!target.exists(), "a refused fill leaves no store");
    }

    #[test]
    fn a_fill_that_does_not_match_its_description_is_removed_and_a_trigger_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.sqlite");
        let db = store(&source);
        add_rows(&db, 10, 10, 0);
        let taken = dir.path().join("taken.sqlite");
        let mut described = take_copy(&source, &taken).unwrap();
        described.tables[1].rows += 1;
        let target = dir.path().join("target.sqlite");
        assert_eq!(fill(&taken, &described, &target), Err(crate::cause!(FillError::Mismatch)));
        assert!(!target.exists());

        db.execute_batch("CREATE TRIGGER t AFTER INSERT ON kv BEGIN DELETE FROM arrival; END;").unwrap();
        let taken = dir.path().join("frozen-trigger.sqlite");
        let described = take_copy(&source, &taken).unwrap();
        assert_eq!(fill(&taken, &described, &target), Err(crate::cause!(FillError::Schema)));
        assert!(!target.exists());
    }
}
