// src/store/mod.rs
//
// Purpose: Where the person's files keep their names index: the names, folders, files, chunks, aliases and spans (and the few small rows
// beside them: origins, shares, uploads, locks, release and recent lists, results, usage days) as plain rows in the person's own SQL
// database. `Rows` is the whole of what the files ask of it: read a row, read rows by id, list a scope in id order a page at a time,
// change one row only if it is still the version the caller read, the scope's change stamp, the declared totals, and a word search of the
// file names. `SqlStore` is the one implementation: SQLite (a file) or Postgres (the person's database), the same statements.
//
// Non-Negotiable Invariants:
// - A change succeeds only when the row is at the version the caller read (`expected_version`; 0 is "no row yet", and a deleted row keeps
//   the version it had, so a new row after a delete expects it). Anything else is `Error::Conflict` and changes nothing.
// - The change and the scope's stamp are written in one transaction. A write that would leave the row as it is writes nothing.
// - A retry of the last change a row had (the same request key and the same change) answers that change again and changes nothing.
// - Ids compare as bytes and a page ends strictly after its cursor, so a walk by cursor sees every row once, in the same order, in
//   either database.
// - No table is named outside `tables.json` and this module; no record leaves a field behind (a field that fits no column is kept in
//   the row's `extra`).
// - Every change takes the next number of the store's one change order (`ns_order`) inside its own transaction, and the row (or its
//   tombstone) keeps it as `changed`. The order row is locked from that statement to the commit, so changes commit in their order and a
//   walk of changes after a cursor (`changes`) never passes over one that commits later with a smaller number.
// - A table's `minted` column (tables.json) is the store's own: a new row whose value does not carry it gets its change's order, a
//   changed row keeps the one it has, and its tombstone keeps it. Nothing else writes it unless the value carries it.
//
// Key Concepts:
// - A scope is the string a family of rows is kept under (`@namespace/files`, `@namespace/names/<folder>`). `tables.json` says which
//   table a scope is in; a scope no table claims is in `ns_record`, one JSON value a row.
// - The change order is the store's own record order: `order` is the last number given, `changes` reads the rows and tombstones of some
//   scopes changed after a number in that order, and `wait_for_order` holds a caller until a change after a number commits or its time
//   ends. A commit in this process wakes the waiters at once; on Postgres a commit in any process does too (`NOTIFY`, heard by the
//   connection `hearing` gives the store). A SQLite file is one run's own, so only its own commits wake it.
//
// Security Considerations:
// - A statement carries values only as bound parameters. A database's own message never leaves this module (it can name a host or user).
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

pub mod by_calls;
pub mod link;
#[cfg(unix)]
pub mod through_the_door;
mod through_the_run_proxy;

use link::{Cell, Dialect, Link};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    fmt,
    sync::{Arc, Condvar, Mutex, OnceLock},
    time::Instant,
};

pub const MAX_RECORD_BYTES: usize = 1024 * 1024;
/// A page's serialized values, in bytes; a page ends before a value that would pass it (the first value is always taken).
pub const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_PAGE_ITEMS: usize = 1000;
/// Ids a statement names at once.
const IDS_AT_ONCE: usize = 400;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Record {
    pub id: String,
    pub version: i64,
    pub value: Value,
    /// The store's change order of the row's last change (0 for a row copied in before any change).
    #[serde(default)]
    pub changed: i64,
}

/// One row of a walk of changes (`Rows::changes`): the row as it is now, or its tombstone.
#[derive(Debug, Clone, PartialEq)]
pub struct Changed {
    pub scope: String,
    pub id: String,
    /// The store's change order of the row's last change.
    pub changed: i64,
    pub version: i64,
    /// The row, or none when its last change removed it.
    pub record: Option<Record>,
    /// The row's minted value (tables.json `minted`), kept on its tombstone too.
    pub minted: Option<i64>,
}

/// One row asked for: the record, or none when there is no such row (or it was deleted).
#[derive(Debug)]
pub struct Read {
    pub record: Option<Record>,
}

/// A page of ordered rows. `next` is the cursor to resume strictly after; none means this page was the last.
#[derive(Debug)]
pub struct Page<T, C> {
    pub items: Vec<T>,
    pub next: Option<C>,
    pub serialized_item_bytes: usize,
}

/// What one change did.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Change {
    /// The scope's change stamp after this change.
    pub sequence: i64,
    /// The store's change order of the row's last change (this one, unless it wrote nothing).
    #[serde(default)]
    pub changed: i64,
    pub id: String,
    pub version: i64,
    pub deleted: bool,
    pub value: Option<Value>,
}

/// What `add_new` did: how many rows it added, and how many it left because the store held them (or their tombstones) already.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Added {
    pub added: u64,
    pub skipped: u64,
}

/// A change to one row, made only if the row is still at `expected_version`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mutation {
    pub id: String,
    pub expected_version: i64,
    pub request_key: String,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub value: Value,
}

/// One declared total: how many rows, and their summed size, in a group (`group` is none for a total with no group).
#[derive(Debug, Clone, PartialEq)]
pub struct Total {
    pub total: String,
    pub group: Option<String>,
    pub count: i64,
    pub sum: i64,
}

#[derive(Debug, Clone)]
pub enum Error {
    /// The row is not at the version the caller read, or the request key was used for another change.
    Conflict(crate::refusal_cause::Cause),
    Invalid(&'static str, crate::refusal_cause::Cause),
    Unavailable(crate::refusal_cause::Cause),
    /// A commit may have been applied; retry the original request key.
    OutcomeUnknown(crate::refusal_cause::Cause),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict(_) => f.write_str("record version or request identity conflicts"),
            Self::Invalid(message, _) => f.write_str(message),
            Self::Unavailable(_) => f.write_str("record supply unavailable"),
            Self::OutcomeUnknown(_) => f.write_str("record outcome unknown; retain original request key"),
        }
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.cause_ref())
    }
}
impl Error {
    /// The original condition's site.
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        self.cause_ref().clone()
    }
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Conflict(cause) | Self::Unavailable(cause) | Self::OutcomeUnknown(cause) | Self::Invalid(_, cause) => cause,
        }
    }
    /// The site of an uncertain effect.
    pub fn outcome_cause(&self) -> Option<crate::refusal_cause::Cause> {
        match self {
            Self::OutcomeUnknown(cause) => Some(cause.clone()),
            _ => None,
        }
    }
}
crate::impl_caused!(Error);
impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Conflict(_), Self::Conflict(_)) | (Self::Unavailable(_), Self::Unavailable(_)) | (Self::OutcomeUnknown(_), Self::OutcomeUnknown(_)) => true,
            (Self::Invalid(a, _), Self::Invalid(b, _)) => a == b,
            _ => false,
        }
    }
}
impl Eq for Error {}

/// What the person's files ask of the database that keeps their rows.
pub trait Rows: Send + Sync {
    /// One row by id.
    fn get(&self, scope: &str, id: &str) -> Result<Read, Error>;
    /// The rows of `ids`, in the order asked; none where there is no such row.
    fn get_many(&self, scope: &str, ids: &[&str]) -> Result<Vec<Option<Record>>, Error>;
    /// The rows of `pairs` (each a scope and an id), in the order asked; none where there is no such row. Rows of many scopes are
    /// read together, so a batch across scopes costs the reads of one scope's batch, not one read per scope.
    fn get_scoped(&self, pairs: &[(&str, &str)]) -> Result<Vec<Option<Record>>, Error>;
    /// The row's version, counting a deleted row's (what a change expects), and the row if it is there.
    fn held_record_with_version(&self, scope: &str, id: &str) -> Result<(i64, Option<Record>), Error>;
    /// The rows of a scope in id order, strictly after `after` (empty: from the first), at most `limit` of them.
    fn list_page(&self, scope: &str, after: &str, limit: usize) -> Result<Page<Record, String>, Error>;
    /// The ids of a scope in id order, strictly after `after`, at most `limit`, and the cursor to resume at when there are more.
    fn ids(&self, scope: &str, after: Option<&str>, limit: usize) -> Result<(Vec<String>, Option<String>), Error>;
    /// Change one row only if it is still at `expected_version`.
    fn mutate(&self, scope: &str, input: Mutation) -> Result<Change, Error>;
    /// How many changes the scope has had; moves whenever any row of the scope changes.
    fn stamp(&self, scope: &str) -> Result<i64, Error>;
    /// Every declared total.
    fn totals(&self) -> Result<Vec<Total>, Error>;
    /// The file rows whose names, together, hold every one of `words` (anywhere in a name, any case), at most `hits`, in id order.
    /// They are the candidates: the caller decides which one name of a file holds the words the way a person reads them.
    fn search(&self, words: &[String], hits: usize) -> Result<Vec<Record>, Error>;
    /// Where the rows are, for a person to read (a file path, or `postgres://host:port/name`).
    fn place(&self) -> String;
    /// The last number of the store's change order (0 before any change).
    fn order(&self) -> Result<i64, Error>;
    /// The rows and tombstones of the scopes that start with one of `prefixes` whose last change is after `after` in the change
    /// order, in that order, at most `limit`; `next` is the order of the last one when there are more.
    fn changes(&self, prefixes: &[&str], after: i64, limit: usize) -> Result<Page<Changed, i64>, Error>;
    /// The row of a scope starting with one of `prefixes` whose minted column holds `minted` (the newest, while a carry has it in two
    /// places), or none.
    fn minted(&self, prefixes: &[&str], minted: i64) -> Result<Option<(String, Record)>, Error>;
    /// The change order, once it is past `after` or once `until` comes, whichever is first.
    fn wait_for_order(&self, after: i64, until: Instant) -> Result<i64, Error>;
}

/// The column the store fills for the rows of `scope` (tables.json `minted`), when its table has one.
pub fn minted_field(scope: &str) -> Option<&'static str> {
    SqlStore::table_of(scope).and_then(|table| table.minted.as_deref())
}

/// The rows a person's files are kept in, shared by everything that reads or changes them in one run.
pub type Store = Arc<dyn Rows>;

/// What `tables.json` declares.
#[derive(Deserialize)]
struct Declared {
    tables: Vec<DeclaredTable>,
    generic: String,
    totals: Vec<DeclaredTotal>,
}
#[derive(Deserialize)]
struct DeclaredTable {
    table: String,
    #[serde(default)]
    prefixes: Vec<String>,
    #[serde(default)]
    exact: Vec<String>,
    #[serde(default)]
    minted: Option<String>,
    columns: Vec<DeclaredColumn>,
}
#[derive(Deserialize, Clone)]
struct DeclaredColumn {
    name: String,
    kind: Kind,
}
#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Int,
    Text,
    Json,
}
impl Kind {
    /// The column type a value of this kind is kept in.
    fn sql_type(self) -> &'static str {
        if self == Kind::Int { "BIGINT" } else { "TEXT" }
    }
}

/// The column every row and tombstone keeps its last change's place in the store's change order in.
const CHANGED: &str = "changed BIGINT NOT NULL DEFAULT 0";
#[derive(Deserialize)]
struct DeclaredTotal {
    total: String,
    kind: String,
    #[serde(default)]
    table: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    sum: Option<String>,
}

const DECLARED: &[u8] = include_bytes!("tables.json");

fn declared() -> &'static Declared {
    static HELD: OnceLock<Declared> = OnceLock::new();
    HELD.get_or_init(|| serde_json::from_slice(DECLARED).expect("src/store/tables.json is read once and is valid"))
}

impl DeclaredTable {
    fn holds(&self, scope: &str) -> bool {
        self.exact.iter().any(|exact| exact == scope) || self.prefixes.iter().any(|prefix| scope.starts_with(prefix.as_str()))
    }
    fn column_list(&self) -> String {
        self.columns.iter().map(|column| format!("\"{}\"", column.name)).collect::<Vec<_>>().join(", ")
    }
    /// The columns every row of a table is read by: id, version, the request, the table's columns, `extra`, `changed`.
    fn selected(&self) -> String {
        format!("id, version, request_key, request_identity, {}, extra, changed", self.column_list())
    }
    /// True when a scope starting with `prefix` may be in this table.
    fn may_hold(&self, prefix: &str) -> bool {
        self.exact.iter().any(|exact| exact.starts_with(prefix))
            || self.prefixes.iter().any(|held| held.starts_with(prefix) || prefix.starts_with(held.as_str()))
    }
}

/// The statement text that keeps a row to scopes starting with one of `prefixes`, and its values.
fn scope_starts(prefixes: &[&str]) -> (String, Vec<Cell>) {
    let mut params = Vec::new();
    let tests: Vec<&str> = prefixes
        .iter()
        .map(|prefix| {
            params.extend([Cell::int(prefix.len() as i64), Cell::text(prefix)]);
            "substr(scope, 1, CAST(? AS INTEGER)) = ?"
        })
        .collect();
    (format!("({})", tests.join(" OR ")), params)
}

/// The channel a Postgres commit notifies (`NOTIFY`), heard by every store opened `hearing` it.
const CHANNEL: &str = "ns_changes";

/// Wakes the callers waiting for a change: a count of the changes heard, and the condition they wait on.
#[derive(Default)]
struct Signal {
    beats: Mutex<u64>,
    woken: Condvar,
}
impl Signal {
    fn beat(&self) {
        if let Ok(mut beats) = self.beats.lock() {
            *beats = beats.wrapping_add(1);
        }
        self.woken.notify_all();
    }
}

/// A removed row's tombstone.
struct Gone {
    version: i64,
    key: Option<String>,
    identity: Option<String>,
    changed: i64,
}

/// The person's rows in a SQL database.
#[derive(Clone)]
pub struct SqlStore {
    links: Arc<Links>,
    dialect: Dialect,
    place: String,
    signal: Arc<Signal>,
}

/// The connections of one store (src/store/links.json): a call takes the first free one, else waits its turn on the next.
struct Links {
    all: Vec<Mutex<Link>>,
    next: std::sync::atomic::AtomicUsize,
}

/// The pool size of a Postgres store, from src/store/links.json.
#[derive(Deserialize)]
struct LinkSettings {
    postgres_connections: usize,
}
const LINK_SETTINGS: &[u8] = include_bytes!("links.json");

/// How many connections a Postgres store opens (src/store/links.json), at least one.
pub fn postgres_connections() -> usize {
    static HELD: OnceLock<usize> = OnceLock::new();
    *HELD.get_or_init(|| serde_json::from_slice::<LinkSettings>(LINK_SETTINGS).expect("src/store/links.json is read once and is valid").postgres_connections.max(1))
}

fn unavailable<E>(_: E) -> Error {
    crate::cause!(Error::Unavailable)
}

impl SqlStore {
    /// The rows in `link`'s database, its tables made when they are not there.
    pub fn open(link: Link) -> Result<Self, Error> {
        Self::open_many(vec![link])
    }

    /// The rows in one database over several connections to it, each call on a free one (src/store/links.json); a SQLite
    /// store, which has one writer, is refused more than one.
    pub fn open_many(links: Vec<Link>) -> Result<Self, Error> {
        let first = links.first().ok_or(Error::Invalid("a store needs a connection", crate::cause!()))?;
        let (dialect, place) = (first.dialect(), first.place().to_owned());
        if links.len() > 1 && (dialect != Dialect::Postgres || links.iter().any(|link| link.dialect() != Dialect::Postgres)) {
            return Err(Error::Invalid("only a Postgres store holds more than one connection", crate::cause!()));
        }
        let links = Links { all: links.into_iter().map(Mutex::new).collect(), next: Default::default() };
        let store = Self { links: Arc::new(links), dialect, place, signal: Arc::default() };
        store.prepare()?;
        Ok(store)
    }

    /// A free connection, or, when every one is busy, the next in turn once it is free.
    fn link(&self) -> Result<std::sync::MutexGuard<'_, Link>, Error> {
        for link in &self.links.all {
            if let Ok(free) = link.try_lock() {
                return Ok(free);
            }
        }
        let turn = self.links.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % self.links.all.len();
        self.links.all[turn].lock().map_err(unavailable)
    }

    /// The same store, woken by every commit to its database from any process: `listener` is a second connection to the same
    /// Postgres database, kept by one thread that only listens. A SQLite store has no other process to hear and refuses one.
    pub fn hearing(self, mut listener: Link) -> Result<Self, Error> {
        if self.dialect != Dialect::Postgres || listener.dialect() != Dialect::Postgres {
            return Err(Error::Invalid("only a Postgres store hears other processes' changes", crate::cause!()));
        }
        listener.listen(CHANNEL)?;
        let signal = self.signal.clone();
        // The listener opens its connection again when it ends (link.rs); while it cannot, it is asked again each second.
        std::thread::Builder::new()
            .name("store-hearing".into())
            .spawn(move || loop {
                match listener.heard() {
                    Ok(()) => signal.beat(),
                    Err(_) => std::thread::sleep(std::time::Duration::from_secs(1)),
                }
            })
            .map_err(unavailable)?;
        Ok(self)
    }

    /// Rows that live only as long as the store (tests).
    pub fn memory() -> Result<Self, Error> {
        Self::open(Link::memory()?)
    }

    /// Another handle to the same database, the way a second process opens it.
    pub fn same_database(&self) -> Self {
        self.clone()
    }

    fn prepare(&self) -> Result<(), Error> {
        let id = self.dialect.id_type();
        let mut sql = String::new();
        for table in &declared().tables {
            let columns: String = table.columns.iter().map(|column| format!("\"{}\" {}, ", column.name, column.kind.sql_type())).collect();
            sql.push_str(&format!(
                "CREATE TABLE IF NOT EXISTS {t} (scope {id} NOT NULL, id {id} NOT NULL, version BIGINT NOT NULL, request_key TEXT, request_identity TEXT, {columns}extra TEXT, {CHANGED}, PRIMARY KEY (scope, id));\n",
                t = table.table
            ));
        }
        sql.push_str(&format!(
            "CREATE TABLE IF NOT EXISTS {g} (scope {id} NOT NULL, id {id} NOT NULL, version BIGINT NOT NULL, request_key TEXT, request_identity TEXT, value TEXT NOT NULL, {CHANGED}, PRIMARY KEY (scope, id));\n\
             CREATE TABLE IF NOT EXISTS ns_gone (scope {id} NOT NULL, id {id} NOT NULL, version BIGINT NOT NULL, request_key TEXT, request_identity TEXT, minted BIGINT, {CHANGED}, PRIMARY KEY (scope, id));\n\
             CREATE TABLE IF NOT EXISTS ns_stamp (scope {id} NOT NULL PRIMARY KEY, stamp BIGINT NOT NULL);\n\
             CREATE TABLE IF NOT EXISTS ns_order (one BIGINT NOT NULL PRIMARY KEY, last BIGINT NOT NULL);\n",
            g = declared().generic
        ));
        for table in declared().tables.iter().map(|table| table.table.as_str()).chain([declared().generic.as_str(), "ns_gone"]) {
            sql.push_str(&format!("CREATE INDEX IF NOT EXISTS {table}_changed ON {table} (changed);\n"));
        }
        for table in &declared().tables {
            if let Some(minted) = &table.minted {
                sql.push_str(&format!("CREATE INDEX IF NOT EXISTS {t}_{minted} ON {t} (\"{minted}\");\n", t = table.table));
            }
        }
        self.link()?.batch(&sql)
    }

    fn table_of(scope: &str) -> Option<&'static DeclaredTable> {
        declared().tables.iter().find(|table| table.holds(scope))
    }

    /// A row of `table` as a record.
    fn record(table: &DeclaredTable, cells: &[Cell]) -> Result<(Record, Option<String>, Option<String>), Error> {
        let (id, version) = (cells[0].as_text().ok_or(crate::cause!(Error::Unavailable))?, cells[1].as_int().unwrap_or(0));
        let mut value = Map::new();
        for (column, cell) in table.columns.iter().zip(&cells[4..]) {
            let Some(text) = cell.as_text() else { continue };
            let field = match column.kind {
                Kind::Int => cell.as_int().map(Value::from).ok_or(crate::cause!(Error::Unavailable))?,
                Kind::Text => Value::String(text),
                Kind::Json => serde_json::from_str(&text).map_err(unavailable)?,
            };
            value.insert(column.name.clone(), field);
        }
        if let Some(extra) = cells[4 + table.columns.len()].as_text() {
            if let Value::Object(fields) = serde_json::from_str(&extra).map_err(unavailable)? {
                value.extend(fields);
            }
        }
        let changed = cells[5 + table.columns.len()].as_int().unwrap_or(0);
        Ok((Record { id, version, value: Value::Object(value), changed }, cells[2].as_text(), cells[3].as_text()))
    }

    /// A row of the generic table as a record.
    fn generic_record(cells: &[Cell]) -> Result<(Record, Option<String>, Option<String>), Error> {
        let value = serde_json::from_str(&cells[4].as_text().ok_or(crate::cause!(Error::Unavailable))?).map_err(unavailable)?;
        Ok((
            Record {
                id: cells[0].as_text().ok_or(crate::cause!(Error::Unavailable))?,
                version: cells[1].as_int().unwrap_or(0),
                value,
                changed: cells[5].as_int().unwrap_or(0),
            },
            cells[2].as_text(),
            cells[3].as_text(),
        ))
    }

    /// The columns of a record's value for `table`: each declared column its cell, and `extra` the fields that fit none.
    fn cells_of(table: &DeclaredTable, value: &Value) -> Result<Vec<Cell>, Error> {
        let Some(object) = value.as_object() else {
            return Err(Error::Invalid("a record of these rows is an object", crate::cause!()));
        };
        let mut left = object.clone();
        let mut cells = Vec::with_capacity(table.columns.len() + 1);
        for column in &table.columns {
            let cell = match (column.kind, left.get(&column.name)) {
                (Kind::Int, Some(Value::Number(number))) if number.as_i64().is_some() => Cell::Int(number.as_i64()),
                (Kind::Text, Some(Value::String(text))) => Cell::Text(Some(text.clone())),
                (Kind::Json, Some(field @ (Value::Array(_) | Value::Object(_)))) => {
                    Cell::Text(Some(serde_json::to_string(field).map_err(unavailable)?))
                }
                (Kind::Int, _) => {
                    cells.push(Cell::Int(None));
                    continue;
                }
                _ => {
                    cells.push(Cell::Text(None));
                    continue;
                }
            };
            left.remove(&column.name);
            cells.push(cell);
        }
        cells.push(Cell::Text((!left.is_empty()).then(|| serde_json::to_string(&Value::Object(left))).transpose().map_err(unavailable)?));
        Ok(cells)
    }

    fn read_rows(&self, link: &mut Link, scope: &str, sql_tail: &str, params: &[Cell]) -> Result<Vec<(Record, Option<String>, Option<String>)>, Error> {
        let rows = match Self::table_of(scope) {
            Some(table) => {
                let text = format!("SELECT {} FROM {} WHERE scope = ?{sql_tail}", table.selected(), table.table);
                let mut all = vec![Cell::text(scope)];
                all.extend_from_slice(params);
                link.query(&text, &all)?.iter().map(|cells| Self::record(table, cells)).collect::<Result<Vec<_>, _>>()?
            }
            None => {
                let text = format!("SELECT id, version, request_key, request_identity, value, changed FROM {} WHERE scope = ?{sql_tail}", declared().generic);
                let mut all = vec![Cell::text(scope)];
                all.extend_from_slice(params);
                link.query(&text, &all)?.iter().map(|cells| Self::generic_record(cells)).collect::<Result<Vec<_>, _>>()?
            }
        };
        Ok(rows)
    }

    /// The row `id` of `scope` (with the request that last changed it) and its tombstone, read together: both statements are sent
    /// before either answer is awaited, so a database far away costs one round trip for the two. `lock` is the dialect's lock a read
    /// inside a transaction takes, or empty.
    fn row_and_tombstone(&self, link: &mut Link, scope: &str, id: &str, lock: &str) -> Result<(Option<(Record, Option<String>, Option<String>)>, Option<Gone>), Error> {
        let table = Self::table_of(scope);
        let read = match table {
            Some(table) => format!("SELECT {} FROM {} WHERE scope = ? AND id = ?{lock}", table.selected(), table.table),
            None => format!("SELECT id, version, request_key, request_identity, value, changed FROM {} WHERE scope = ? AND id = ?{lock}", declared().generic),
        };
        let gone = format!("SELECT version, request_key, request_identity, changed FROM ns_gone WHERE scope = ? AND id = ?{lock}");
        let params = [Cell::text(scope), Cell::text(id)];
        let mut answered = link.query_together(&[(read.as_str(), &params[..]), (gone.as_str(), &params[..])])?.into_iter();
        let (rows, gone_rows) = (answered.next().unwrap_or_default(), answered.next().unwrap_or_default());
        let row = match (rows.first(), table) {
            (Some(cells), Some(table)) => Some(Self::record(table, cells)?),
            (Some(cells), None) => Some(Self::generic_record(cells)?),
            (None, _) => None,
        };
        let gone = gone_rows.first().map(|cells| Gone {
            version: cells[0].as_int().unwrap_or(0),
            key: cells[1].as_text(),
            identity: cells[2].as_text(),
            changed: cells[3].as_int().unwrap_or(0),
        });
        Ok((row, gone))
    }

    fn identity_of(input: &Mutation) -> String {
        let canonical = serde_json::to_vec(&serde_json::json!([input.id, input.expected_version, input.deleted, input.value])).unwrap_or_default();
        content_crypto::advanced::blake3::hash(&canonical).to_hex().to_string()
    }

    /// Add rows the store does not hold yet, many in one transaction: the way a whole index made elsewhere (an earlier store's
    /// export) comes in, where one `mutate` a row would cost a round trip or more each. Each row is `(scope, id, value)` and is
    /// added at version 1, as a `mutate` at expected version 0 would add it (its minted field, when its table has one and the value
    /// carries none, is its change order; its request key is `request_key_prefix` and its id). A row the store holds already, or
    /// holds a tombstone of (someone removed it), is left as it is and counted as skipped, so the same rows added again change
    /// nothing. The rows' change orders are taken together, every scope's stamp moves once, and other processes hear one change.
    pub fn add_new(&self, rows: &[(String, String, Value)], request_key_prefix: &str) -> Result<Added, Error> {
        if rows.is_empty() {
            return Ok(Added { added: 0, skipped: 0 });
        }
        for (_, id, value) in rows {
            if id.is_empty() {
                return Err(Error::Invalid("a record has an id", crate::cause!()));
            }
            if serde_json::to_vec(value).map_err(unavailable)?.len() > MAX_RECORD_BYTES {
                return Err(Error::Invalid("a record is at most one mebibyte", crate::cause!()));
            }
        }
        let mut link = self.link()?;
        link.begin()?;
        match self.add_new_in(&mut link, rows, request_key_prefix) {
            Ok(added) => {
                link.commit()?;
                drop(link);
                self.signal.beat();
                Ok(added)
            }
            Err(error) => {
                link.rollback();
                Err(error)
            }
        }
    }

    fn add_new_in(&self, link: &mut Link, rows: &[(String, String, Value)], request_key_prefix: &str) -> Result<Added, Error> {
        let count = rows.len() as i64;
        let last = link
            .query("INSERT INTO ns_order (one, last) VALUES (1, ?) ON CONFLICT (one) DO UPDATE SET last = ns_order.last + ? RETURNING last", &[Cell::int(count), Cell::int(count)])?
            .first()
            .and_then(|cells| cells[0].as_int())
            .ok_or(crate::cause!(Error::Unavailable))?;
        let first = last - count + 1;
        // Rows of one table go in one statement of at most this many rows (Postgres binds at most 65535 values in one statement).
        const ROWS_AT_ONCE: usize = 500;
        let mut by_table: Vec<(Option<&'static DeclaredTable>, Vec<(usize, &(String, String, Value))>)> = Vec::new();
        for (at, row) in rows.iter().enumerate() {
            let table = Self::table_of(&row.0);
            match by_table.iter_mut().find(|(held, _)| held.map(|t| t.table.as_str()) == table.map(|t| t.table.as_str())) {
                Some((_, held)) => held.push((at, row)),
                None => by_table.push((table, vec![(at, row)])),
            }
        }
        let mut added = 0_u64;
        for (table, held) in by_table {
            for batch in held.chunks(ROWS_AT_ONCE) {
                let (name, columns) = match table {
                    Some(table) => (table.table.as_str(), format!("{}, extra", table.column_list())),
                    None => (declared().generic.as_str(), "value".to_owned()),
                };
                let mut params = Vec::new();
                let mut tuples = Vec::with_capacity(batch.len());
                let mut width = 0;
                for (at, (scope, id, value)) in batch {
                    let order = first + *at as i64;
                    let mut value = value.clone();
                    if let (Some(field), Some(fields)) = (table.and_then(|table| table.minted.as_deref()), value.as_object_mut()) {
                        if fields.get(field).is_none_or(Value::is_null) {
                            fields.insert(field.to_owned(), Value::from(order));
                        }
                    }
                    let identity = Self::identity_of(&Mutation { id: id.clone(), expected_version: 0, request_key: String::new(), deleted: false, value: value.clone() });
                    let mut cells = vec![Cell::text(scope), Cell::text(id), Cell::int(1), Cell::text(&format!("{request_key_prefix}{id}")), Cell::text(&identity)];
                    match table {
                        Some(table) => cells.extend(Self::cells_of(table, &value)?),
                        None => cells.push(Cell::text(&serde_json::to_string(&value).map_err(unavailable)?)),
                    }
                    cells.push(Cell::int(order));
                    width = cells.len();
                    tuples.push(format!("({})", vec!["?"; cells.len()].join(", ")));
                    params.extend(cells);
                }
                // The values' own column names differ by dialect: Postgres names them, SQLite calls them column1, column2, ...
                let (alias, scope_column, id_column) = match self.dialect {
                    Dialect::Postgres => (format!("v({})", (1..=width).map(|n| format!("c{n}")).collect::<Vec<_>>().join(", ")), "v.c1", "v.c2"),
                    Dialect::Sqlite => ("v".to_owned(), "v.column1", "v.column2"),
                };
                let sql = format!(
                    "INSERT INTO {name} (scope, id, version, request_key, request_identity, {columns}, changed) \
                     SELECT * FROM (VALUES {}) AS {alias} \
                     WHERE NOT EXISTS (SELECT 1 FROM ns_gone g WHERE g.scope = {scope_column} AND g.id = {id_column}) \
                     ON CONFLICT (scope, id) DO NOTHING",
                    tuples.join(", ")
                );
                added += link.execute(&sql, &params)?;
            }
        }
        let mut scopes: Vec<&str> = rows.iter().map(|(scope, _, _)| scope.as_str()).collect();
        scopes.sort_unstable();
        scopes.dedup();
        for batch in scopes.chunks(ROWS_AT_ONCE * 8) {
            let tuples = vec!["(?, 1)"; batch.len()].join(", ");
            let params: Vec<Cell> = batch.iter().map(|scope| Cell::text(scope)).collect();
            link.defer(&format!("INSERT INTO ns_stamp (scope, stamp) VALUES {tuples} ON CONFLICT (scope) DO UPDATE SET stamp = ns_stamp.stamp + 1"), &params)?;
        }
        if self.dialect == Dialect::Postgres {
            link.defer_plain(&format!("NOTIFY {CHANNEL}"))?;
        }
        Ok(Added { added, skipped: rows.len() as u64 - added })
    }

    /// The next number of the store's change order. The order row stays locked until the transaction ends, so the changes commit
    /// in the order of their numbers.
    fn next_order(link: &mut Link) -> Result<i64, Error> {
        link.query("INSERT INTO ns_order (one, last) VALUES (1, 1) ON CONFLICT (one) DO UPDATE SET last = ns_order.last + 1 RETURNING last", &[])?
            .first()
            .and_then(|cells| cells[0].as_int())
            .ok_or(crate::cause!(Error::Unavailable))
    }

    fn change(&self, link: &mut Link, scope: &str, input: &Mutation) -> Result<Change, Error> {
        let lock = self.dialect.lock_read();
        let identity = Self::identity_of(input);
        let table = Self::table_of(scope);
        let minted = table.and_then(|table| table.minted.as_deref());
        let (current, gone) = self.row_and_tombstone(link, scope, &input.id, lock)?;
        let gone = if current.is_none() { gone } else { None };
        let held = current.as_ref().map(|(record, _, _)| record.version).or(gone.as_ref().map(|gone| gone.version)).unwrap_or(0);
        let (last_key, last_identity) = match (&current, &gone) {
            (Some((_, key, identity)), _) => (key.clone(), identity.clone()),
            (None, Some(gone)) => (gone.key.clone(), gone.identity.clone()),
            _ => (None, None),
        };
        // The retry of the last change the row had answers that change again.
        if last_key.as_deref() == Some(input.request_key.as_str()) && held > 0 {
            if last_identity.as_deref() != Some(identity.as_str()) {
                return Err(crate::cause!(Error::Conflict));
            }
            return Ok(Change {
                sequence: Self::stamp_in(link, scope)?,
                changed: current.as_ref().map(|(record, _, _)| record.changed).or(gone.as_ref().map(|gone| gone.changed)).unwrap_or(0),
                id: input.id.clone(),
                version: held,
                deleted: current.is_none(),
                value: current.map(|(record, _, _)| record.value),
            });
        }
        if input.deleted && !input.value.is_null() {
            return Err(Error::Invalid("a delete must not include a new value", crate::cause!()));
        }
        if input.expected_version != held || (held == 0 && input.deleted) {
            return Err(crate::cause!(Error::Conflict));
        }
        // A changed row keeps its minted value when the new value does not carry one.
        let mut value = input.value.clone();
        if let (Some(field), Some((record, _, _)), Some(fields)) = (minted, current.as_ref(), value.as_object_mut()) {
            if fields.get(field).is_none_or(Value::is_null) {
                if let Some(kept) = record.value.get(field).filter(|kept| !kept.is_null()) {
                    fields.insert(field.to_owned(), kept.clone());
                }
            }
        }
        // A change that leaves the row as it is writes nothing: no version, no stamp, no order.
        if let Some((record, _, _)) = current.as_ref().filter(|_| !input.deleted) {
            if record.value == value {
                return Ok(Change {
                    sequence: Self::stamp_in(link, scope)?,
                    changed: record.changed,
                    id: input.id.clone(),
                    version: record.version,
                    deleted: false,
                    value: Some(value),
                });
            }
        }
        if !input.deleted && serde_json::to_vec(&value).map_err(unavailable)?.len() > MAX_RECORD_BYTES {
            return Err(Error::Invalid("a record is at most one mebibyte", crate::cause!()));
        }
        let order = Self::next_order(link)?;
        // A new row that does not carry its minted value gets this change's order.
        if let (Some(field), Some(fields)) = (minted, value.as_object_mut()) {
            if fields.get(field).is_none_or(Value::is_null) {
                fields.insert(field.to_owned(), Value::from(order));
            }
        }
        let version = held + 1;
        let request = [Cell::text(&input.request_key), Cell::text(&identity)];
        if input.deleted {
            let kept = minted.and_then(|field| current.as_ref().and_then(|(record, _, _)| record.value.get(field)).and_then(Value::as_i64));
            link.defer("DELETE FROM ns_gone WHERE scope = ? AND id = ?", &[Cell::text(scope), Cell::text(&input.id)])?;
            link.defer(
                "INSERT INTO ns_gone (scope, id, version, request_key, request_identity, minted, changed) VALUES (?, ?, ?, ?, ?, ?, ?)",
                &[Cell::text(scope), Cell::text(&input.id), Cell::int(version), request[0].clone(), request[1].clone(), Cell::Int(kept), Cell::int(order)],
            )?;
            match table {
                Some(table) => link.defer(&format!("DELETE FROM {} WHERE scope = ? AND id = ?", table.table), &[Cell::text(scope), Cell::text(&input.id)])?,
                None => link.defer(&format!("DELETE FROM {} WHERE scope = ? AND id = ?", declared().generic), &[Cell::text(scope), Cell::text(&input.id)])?,
            };
        } else {
            match table {
                Some(table) => {
                    let cells = Self::cells_of(table, &value)?;
                    let names = table.column_list();
                    let marks = vec!["?"; table.columns.len() + 1].join(", ");
                    let set = table.columns.iter().map(|column| format!("\"{}\" = ?", column.name)).collect::<Vec<_>>().join(", ");
                    if current.is_some() {
                        let mut params = vec![Cell::int(version), request[0].clone(), request[1].clone()];
                        params.extend(cells);
                        params.extend([Cell::int(order), Cell::text(scope), Cell::text(&input.id)]);
                        link.defer(
                            &format!("UPDATE {} SET version = ?, request_key = ?, request_identity = ?, {set}, extra = ?, changed = ? WHERE scope = ? AND id = ?", table.table),
                            &params,
                        )?;
                    } else {
                        link.defer("DELETE FROM ns_gone WHERE scope = ? AND id = ?", &[Cell::text(scope), Cell::text(&input.id)])?;
                        let mut params = vec![Cell::text(scope), Cell::text(&input.id), Cell::int(version), request[0].clone(), request[1].clone()];
                        params.extend(cells);
                        params.push(Cell::int(order));
                        link.defer(
                            &format!("INSERT INTO {} (scope, id, version, request_key, request_identity, {names}, extra, changed) VALUES (?, ?, ?, ?, ?, {marks}, ?)", table.table),
                            &params,
                        )?;
                    }
                }
                None => {
                    let text = serde_json::to_string(&value).map_err(unavailable)?;
                    if current.is_some() {
                        link.defer(
                            &format!("UPDATE {} SET version = ?, request_key = ?, request_identity = ?, value = ?, changed = ? WHERE scope = ? AND id = ?", declared().generic),
                            &[Cell::int(version), request[0].clone(), request[1].clone(), Cell::text(&text), Cell::int(order), Cell::text(scope), Cell::text(&input.id)],
                        )?;
                    } else {
                        link.defer("DELETE FROM ns_gone WHERE scope = ? AND id = ?", &[Cell::text(scope), Cell::text(&input.id)])?;
                        link.defer(
                            &format!("INSERT INTO {} (scope, id, version, request_key, request_identity, value, changed) VALUES (?, ?, ?, ?, ?, ?, ?)", declared().generic),
                            &[Cell::text(scope), Cell::text(&input.id), Cell::int(version), request[0].clone(), request[1].clone(), Cell::text(&text), Cell::int(order)],
                        )?;
                    }
                }
            }
        }
        let sequence = link
            .query(
                "INSERT INTO ns_stamp (scope, stamp) VALUES (?, 1) ON CONFLICT (scope) DO UPDATE SET stamp = ns_stamp.stamp + 1 RETURNING stamp",
                &[Cell::text(scope)],
            )?
            .first()
            .and_then(|cells| cells[0].as_int())
            .ok_or(crate::cause!(Error::Unavailable))?;
        if self.dialect == Dialect::Postgres {
            link.defer_plain(&format!("NOTIFY {CHANNEL}"))?;
        }
        Ok(Change { sequence, changed: order, id: input.id.clone(), version, deleted: input.deleted, value: (!input.deleted).then_some(value) })
    }

    fn stamp_in(link: &mut Link, scope: &str) -> Result<i64, Error> {
        Ok(link.query("SELECT stamp FROM ns_stamp WHERE scope = ?", &[Cell::text(scope)])?.first().and_then(|cells| cells[0].as_int()).unwrap_or(0))
    }
}

impl Rows for SqlStore {
    fn get(&self, scope: &str, id: &str) -> Result<Read, Error> {
        let mut link = self.link()?;
        let rows = self.read_rows(&mut link, scope, " AND id = ?", &[Cell::text(id)])?;
        Ok(Read { record: rows.into_iter().next().map(|(record, _, _)| record) })
    }

    fn get_many(&self, scope: &str, ids: &[&str]) -> Result<Vec<Option<Record>>, Error> {
        let mut link = self.link()?;
        let mut found = std::collections::BTreeMap::new();
        for batch in ids.chunks(IDS_AT_ONCE) {
            let marks = vec!["?"; batch.len()].join(", ");
            let params: Vec<Cell> = batch.iter().map(|id| Cell::text(id)).collect();
            for (record, _, _) in self.read_rows(&mut link, scope, &format!(" AND id IN ({marks})"), &params)? {
                found.insert(record.id.clone(), record);
            }
        }
        Ok(ids.iter().map(|id| found.get(*id).cloned()).collect())
    }

    fn get_scoped(&self, pairs: &[(&str, &str)]) -> Result<Vec<Option<Record>>, Error> {
        let mut link = self.link()?;
        // The pairs are grouped by the table their scope is kept in, so each table is read in batches of (scope, id).
        let mut groups: std::collections::BTreeMap<String, (Option<&'static DeclaredTable>, Vec<(&str, &str)>)> = std::collections::BTreeMap::new();
        for &(scope, id) in pairs {
            let table = Self::table_of(scope);
            let name = table.map_or_else(|| declared().generic.clone(), |table| table.table.clone());
            groups.entry(name).or_insert_with(|| (table, Vec::new())).1.push((scope, id));
        }
        let mut found: std::collections::BTreeMap<(String, String), Record> = std::collections::BTreeMap::new();
        for (name, (table, asked)) in groups {
            let columns = match table {
                Some(table) => table.selected(),
                None => "id, version, request_key, request_identity, value, changed".to_owned(),
            };
            for batch in asked.chunks(IDS_AT_ONCE / 2) {
                let marks = vec!["(?, ?)"; batch.len()].join(", ");
                let text = format!("SELECT scope, {columns} FROM {name} WHERE (scope, id) IN (VALUES {marks})");
                let params: Vec<Cell> = batch.iter().flat_map(|(scope, id)| [Cell::text(scope), Cell::text(id)]).collect();
                for cells in link.query(&text, &params)? {
                    let scope = cells[0].as_text().ok_or(crate::cause!(Error::Unavailable))?;
                    let (record, _, _) = match table {
                        Some(table) => Self::record(table, &cells[1..])?,
                        None => Self::generic_record(&cells[1..])?,
                    };
                    found.insert((scope, record.id.clone()), record);
                }
            }
        }
        Ok(pairs.iter().map(|(scope, id)| found.get(&((*scope).to_owned(), (*id).to_owned())).cloned()).collect())
    }

    fn held_record_with_version(&self, scope: &str, id: &str) -> Result<(i64, Option<Record>), Error> {
        let mut link = self.link()?;
        match self.row_and_tombstone(&mut link, scope, id, "")? {
            (Some((record, _, _)), _) => Ok((record.version, Some(record))),
            (None, gone) => Ok((gone.map_or(0, |gone| gone.version), None)),
        }
    }

    fn list_page(&self, scope: &str, after: &str, limit: usize) -> Result<Page<Record, String>, Error> {
        let limit = limit.clamp(1, MAX_PAGE_ITEMS);
        let mut link = self.link()?;
        let rows = self.read_rows(&mut link, scope, " AND id > ? ORDER BY id LIMIT ?", &[Cell::text(after), Cell::int(limit as i64 + 1)])?;
        let mut items = Vec::new();
        let (mut bytes, mut more) = (0usize, false);
        for (record, _, _) in rows {
            let size = serde_json::to_vec(&record.value).map_err(unavailable)?.len();
            if items.len() == limit || (!items.is_empty() && bytes + size > MAX_PAGE_BYTES) {
                more = true;
                break;
            }
            bytes += size;
            items.push(record);
        }
        let next = more.then(|| items.last().map(|record| record.id.clone())).flatten();
        Ok(Page { items, next, serialized_item_bytes: bytes })
    }

    fn ids(&self, scope: &str, after: Option<&str>, limit: usize) -> Result<(Vec<String>, Option<String>), Error> {
        let limit = limit.clamp(1, MAX_PAGE_ITEMS);
        let mut link = self.link()?;
        let table = match Self::table_of(scope) {
            Some(table) => table.table.as_str(),
            None => declared().generic.as_str(),
        };
        let rows = link.query(
            &format!("SELECT id FROM {table} WHERE scope = ? AND id > ? ORDER BY id LIMIT ?"),
            &[Cell::text(scope), Cell::text(after.unwrap_or("")), Cell::int(limit as i64 + 1)],
        )?;
        let mut ids: Vec<String> = rows.iter().filter_map(|cells| cells[0].as_text()).collect();
        let more = ids.len() > limit;
        ids.truncate(limit);
        let next = more.then(|| ids.last().cloned()).flatten();
        Ok((ids, next))
    }

    fn mutate(&self, scope: &str, input: Mutation) -> Result<Change, Error> {
        if input.id.is_empty() {
            return Err(Error::Invalid("a record has an id", crate::cause!()));
        }
        let mut link = self.link()?;
        link.begin()?;
        match self.change(&mut link, scope, &input) {
            Ok(change) => {
                link.commit()?;
                drop(link);
                self.signal.beat();
                Ok(change)
            }
            Err(error) => {
                link.rollback();
                Err(error)
            }
        }
    }

    fn stamp(&self, scope: &str) -> Result<i64, Error> {
        Self::stamp_in(&mut *self.link()?, scope)
    }

    fn totals(&self) -> Result<Vec<Total>, Error> {
        let mut link = self.link()?;
        let mut totals = Vec::new();
        for declared in &declared().totals {
            match (&declared.table, &declared.scope) {
                (Some(table), _) => {
                    let sum = declared.sum.as_deref().map_or("CAST(0 AS BIGINT)".to_owned(), |column| format!("CAST(COALESCE(SUM(\"{column}\"), 0) AS BIGINT)"));
                    let (select, group) = match declared.group.as_deref() {
                        Some(group) => (format!("\"{group}\", COUNT(*), {sum}"), format!(" GROUP BY \"{group}\" ORDER BY \"{group}\"")),
                        None => (format!("NULL, COUNT(*), {sum}"), String::new()),
                    };
                    let rows = link.query(&format!("SELECT {select} FROM {table} WHERE \"kind\" = ?{group}"), &[Cell::text(&declared.kind)])?;
                    for cells in rows {
                        totals.push(Total { total: declared.total.clone(), group: cells[0].as_text(), count: cells[1].as_int().unwrap_or(0), sum: cells[2].as_int().unwrap_or(0) });
                    }
                }
                (None, Some(scope)) => {
                    let rows = self.read_rows(&mut link, scope, "", &[])?;
                    let (mut count, mut sum) = (0i64, 0i64);
                    for (record, _, _) in rows {
                        if record.value.get("kind").and_then(Value::as_str) != Some(declared.kind.as_str()) {
                            continue;
                        }
                        count += 1;
                        sum += declared.sum.as_deref().and_then(|field| record.value.get(field)).and_then(Value::as_i64).unwrap_or(0);
                    }
                    totals.push(Total { total: declared.total.clone(), group: None, count, sum });
                }
                (None, None) => return Err(crate::cause!(Error::Unavailable)),
            }
        }
        Ok(totals)
    }

    fn search(&self, words: &[String], hits: usize) -> Result<Vec<Record>, Error> {
        if words.is_empty() {
            return Ok(Vec::new());
        }
        let mut tail = String::new();
        let mut params = Vec::new();
        for word in words {
            let escaped: String = word.to_lowercase().chars().flat_map(|c| if matches!(c, '%' | '_' | '\\') { vec!['\\', c] } else { vec![c] }).collect();
            tail.push_str(" AND LOWER(\"names\") LIKE ? ESCAPE '\\'");
            params.push(Cell::text(&format!("%{escaped}%")));
        }
        tail.push_str(" ORDER BY id LIMIT ?");
        params.push(Cell::int(hits as i64));
        let mut link = self.link()?;
        Ok(self.read_rows(&mut link, "@namespace/files", &tail, &params)?.into_iter().map(|(record, _, _)| record).collect())
    }

    fn place(&self) -> String {
        self.place.clone()
    }

    fn order(&self) -> Result<i64, Error> {
        let mut link = self.link()?;
        Ok(link.query("SELECT last FROM ns_order WHERE one = 1", &[])?.first().and_then(|cells| cells[0].as_int()).unwrap_or(0))
    }

    fn changes(&self, prefixes: &[&str], after: i64, limit: usize) -> Result<Page<Changed, i64>, Error> {
        let limit = limit.clamp(1, MAX_PAGE_ITEMS);
        let (starts, scope_params) = scope_starts(prefixes);
        let take = |mut params: Vec<Cell>| {
            params.insert(0, Cell::int(after));
            params.push(Cell::int(limit as i64 + 1));
            params
        };
        let tail = format!(" WHERE changed > ? AND {starts} ORDER BY changed LIMIT ?");
        let mut found = Vec::new();
        let mut link = self.link()?;
        let tables: Vec<&DeclaredTable> = declared().tables.iter().filter(|table| prefixes.iter().any(|prefix| table.may_hold(prefix))).collect();
        for table in &tables {
            let text = format!("SELECT scope, {} FROM {}{tail}", table.selected(), table.table);
            for cells in link.query(&text, &take(scope_params.clone()))? {
                let (record, _, _) = Self::record(table, &cells[1..])?;
                let minted = table.minted.as_deref().and_then(|field| record.value.get(field)).and_then(Value::as_i64);
                found.push(Changed { scope: cells[0].as_text().unwrap_or_default(), id: record.id.clone(), changed: record.changed, version: record.version, record: Some(record), minted });
            }
        }
        // A scope no declared table claims whole may be kept in the generic table.
        if !prefixes.iter().all(|prefix| declared().tables.iter().any(|table| table.prefixes.iter().any(|held| prefix.starts_with(held.as_str())))) {
            let text = format!("SELECT scope, id, version, request_key, request_identity, value, changed FROM {}{tail}", declared().generic);
            for cells in link.query(&text, &take(scope_params.clone()))? {
                let (record, _, _) = Self::generic_record(&cells[1..])?;
                found.push(Changed { scope: cells[0].as_text().unwrap_or_default(), id: record.id.clone(), changed: record.changed, version: record.version, record: Some(record), minted: None });
            }
        }
        let text = format!("SELECT scope, id, version, minted, changed FROM ns_gone{tail}");
        for cells in link.query(&text, &take(scope_params))? {
            found.push(Changed {
                scope: cells[0].as_text().unwrap_or_default(),
                id: cells[1].as_text().unwrap_or_default(),
                version: cells[2].as_int().unwrap_or(0),
                minted: cells[3].as_int(),
                changed: cells[4].as_int().unwrap_or(0),
                record: None,
            });
        }
        drop(link);
        found.sort_by_key(|change| change.changed);
        let more = found.len() > limit;
        found.truncate(limit);
        let next = more.then(|| found.last().map(|change| change.changed)).flatten();
        Ok(Page { items: found, next, serialized_item_bytes: 0 })
    }

    fn minted(&self, prefixes: &[&str], minted: i64) -> Result<Option<(String, Record)>, Error> {
        let (starts, scope_params) = scope_starts(prefixes);
        let mut newest: Option<(String, Record)> = None;
        let mut link = self.link()?;
        for table in declared().tables.iter().filter(|table| table.minted.is_some() && prefixes.iter().any(|prefix| table.may_hold(prefix))) {
            let field = table.minted.as_deref().unwrap_or_default();
            let mut params = vec![Cell::int(minted)];
            params.extend(scope_params.clone());
            let text = format!("SELECT scope, {} FROM {} WHERE \"{field}\" = ? AND {starts} ORDER BY changed DESC LIMIT 1", table.selected(), table.table);
            if let Some(cells) = link.query(&text, &params)?.first() {
                let (record, _, _) = Self::record(table, &cells[1..])?;
                if newest.as_ref().is_none_or(|(_, held)| held.changed < record.changed) {
                    newest = Some((cells[0].as_text().unwrap_or_default(), record));
                }
            }
        }
        Ok(newest)
    }

    fn wait_for_order(&self, after: i64, until: Instant) -> Result<i64, Error> {
        loop {
            let beats = *self.signal.beats.lock().map_err(unavailable)?;
            let order = self.order()?;
            let now = Instant::now();
            if order > after || now >= until {
                return Ok(order);
            }
            let held = self.signal.beats.lock().map_err(unavailable)?;
            let _ = self.signal.woken.wait_timeout_while(held, until - now, |heard| *heard == beats).map_err(unavailable)?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The store the tests run on: SQLite in memory, or, when `NAMESPACE_POSTGRES_TEST_CONNECTION` holds the connection string of a throwaway
    /// Postgres database, a schema of its own in that database, so every statement is also proved on Postgres.
    fn under_test() -> SqlStore {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let Ok(connection) = std::env::var("NAMESPACE_POSTGRES_TEST_CONNECTION") else {
            return SqlStore::memory().unwrap();
        };
        let schema = format!("t{}_{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        Link::postgres(&connection).unwrap().batch(&format!("CREATE SCHEMA {schema}")).unwrap();
        let joiner = if connection.contains('?') { '&' } else { '?' };
        SqlStore::open(Link::postgres(&format!("{connection}{joiner}options=-c%20search_path%3D{schema}")).unwrap()).unwrap()
    }

    fn put(store: &SqlStore, scope: &str, id: &str, expected: i64, key: &str, value: Value) -> Result<Change, Error> {
        store.mutate(scope, Mutation { id: id.into(), expected_version: expected, request_key: key.into(), deleted: false, value })
    }
    fn remove(store: &SqlStore, scope: &str, id: &str, expected: i64, key: &str) -> Result<Change, Error> {
        store.mutate(scope, Mutation { id: id.into(), expected_version: expected, request_key: key.into(), deleted: true, value: Value::Null })
    }
    fn chunk(bytes: i64, origin: &str) -> Value {
        json!({"kind": "namespace-chunk", "byte_length": bytes, "origin": origin, "key": "k", "stored_at": "2026-11-16T00:00:00.000Z"})
    }

    /// A SQLite store, which has one writer, refuses a second connection; a pool of one is the store it always was, and the
    /// Postgres pool size is DATA (src/store/links.json), at least one.
    #[test]
    fn a_sqlite_store_keeps_one_connection() {
        assert!(SqlStore::open_many(vec![Link::memory().unwrap(), Link::memory().unwrap()]).is_err());
        assert!(SqlStore::open_many(Vec::new()).is_err());
        assert!(SqlStore::open_many(vec![Link::memory().unwrap()]).is_ok());
        assert!(postgres_connections() >= 1);
    }

    #[test]
    fn rows_added_together_are_kept_at_version_one_and_rows_held_or_removed_are_left_as_they_are() {
        let store = under_test();
        put(&store, "@namespace/names/A", "/A/held", 0, "k-held", json!({"kind": "namespace-name", "name": "/A/held"})).unwrap();
        put(&store, "@namespace/names/A", "/A/removed", 0, "k-r1", json!({"kind": "namespace-name", "name": "/A/removed"})).unwrap();
        remove(&store, "@namespace/names/A", "/A/removed", 1, "k-r2").unwrap();
        let stamp = store.stamp("@namespace/names/A").unwrap();
        let rows = vec![
            ("@namespace/names/A".to_owned(), "/A/new".to_owned(), json!({"kind": "namespace-name", "name": "/A/new"})),
            ("@namespace/names/A".to_owned(), "/A/held".to_owned(), json!({"kind": "namespace-name", "name": "/A/other"})),
            ("@namespace/names/A".to_owned(), "/A/removed".to_owned(), json!({"kind": "namespace-name", "name": "/A/removed"})),
            ("@namespace/chunks".to_owned(), "1f:aa".to_owned(), json!({"kind": "namespace-chunk", "byte_length": 3, "origin": "o", "key": "k"})),
            ("@someone/else".to_owned(), "x".to_owned(), json!({"kind": "plain", "n": 1})),
        ];
        assert_eq!(store.add_new(&rows, "import:").unwrap(), Added { added: 3, skipped: 2 });
        let new = store.get("@namespace/names/A", "/A/new").unwrap().record.unwrap();
        assert_eq!(new.version, 1);
        assert!(new.value["item"].as_i64().is_some_and(|item| item > 0));
        assert_eq!(store.get("@namespace/names/A", "/A/held").unwrap().record.unwrap().value["name"], "/A/held");
        assert!(store.get("@namespace/names/A", "/A/removed").unwrap().record.is_none());
        assert_eq!(store.get("@namespace/chunks", "1f:aa").unwrap().record.unwrap().value["byte_length"], 3);
        assert_eq!(store.get("@someone/else", "x").unwrap().record.unwrap().value["n"], 1);
        assert!(store.stamp("@namespace/names/A").unwrap() > stamp);
        put(&store, "@namespace/names/A", "/A/new", 1, "k-next", json!({"kind": "namespace-name", "name": "/A/new", "byte_length": 5})).unwrap();
        assert_eq!(store.add_new(&rows, "import:").unwrap(), Added { added: 0, skipped: 5 });
    }

    #[test]
    fn a_row_is_made_changed_and_deleted_only_at_the_version_the_caller_read() {
        let store = under_test();
        let scope = "@namespace/chunks";
        assert_eq!(store.held_record_with_version(scope, "c").unwrap(), (0, None));
        let made = put(&store, scope, "c", 0, "make", chunk(5, "b2")).unwrap();
        assert_eq!((made.version, made.deleted), (1, false));
        assert_eq!(put(&store, scope, "c", 0, "again", chunk(6, "b2")), Err(crate::cause!(Error::Conflict)), "a row that is there is not made twice");
        let changed = put(&store, scope, "c", 1, "change", chunk(6, "b2")).unwrap();
        assert_eq!(changed.version, 2);
        assert_eq!(store.get(scope, "c").unwrap().record.unwrap().value, chunk(6, "b2"));
        assert_eq!(remove(&store, scope, "c", 1, "stale"), Err(crate::cause!(Error::Conflict)));
        let gone = remove(&store, scope, "c", 2, "remove").unwrap();
        assert_eq!((gone.version, gone.deleted, gone.value), (3, true, None));
        assert!(store.get(scope, "c").unwrap().record.is_none());
        assert_eq!(store.held_record_with_version(scope, "c").unwrap(), (3, None), "a deleted row keeps its version");
        assert_eq!(put(&store, scope, "c", 0, "new", chunk(7, "b2")), Err(crate::cause!(Error::Conflict)), "a new row after a delete expects the version it had");
        assert_eq!(put(&store, scope, "c", 3, "new", chunk(7, "b2")).unwrap().version, 4);
        assert_eq!(remove(&store, scope, "never", 0, "nothing"), Err(crate::cause!(Error::Conflict)), "nothing is deleted that was never there");
        assert!(matches!(store.mutate(scope, Mutation { id: "d".into(), expected_version: 0, request_key: "d".into(), deleted: true, value: json!({"a": 1}) }), Err(Error::Invalid(..))));
    }

    #[test]
    fn the_retry_of_a_rows_last_change_answers_that_change_and_another_change_under_its_key_is_refused() {
        let store = under_test();
        let scope = "@namespace/chunks";
        let first = put(&store, scope, "c", 0, "key-1", chunk(5, "b2")).unwrap();
        let replay = put(&store, scope, "c", 0, "key-1", chunk(5, "b2")).unwrap();
        assert_eq!((replay.version, replay.value.clone()), (first.version, first.value.clone()));
        assert_eq!(store.stamp(scope).unwrap(), 1, "a replay changes nothing");
        assert_eq!(put(&store, scope, "c", 0, "key-1", chunk(9, "b2")), Err(crate::cause!(Error::Conflict)), "the key was another change");
        put(&store, scope, "c", 1, "key-2", chunk(6, "b2")).unwrap();
        assert_eq!(put(&store, scope, "c", 0, "key-1", chunk(5, "b2")), Err(crate::cause!(Error::Conflict)), "only the last change is replayed");
        let gone = remove(&store, scope, "c", 2, "key-3").unwrap();
        assert_eq!(remove(&store, scope, "c", 2, "key-3").unwrap().version, gone.version, "a delete replays too");
    }

    #[test]
    fn a_change_that_leaves_the_row_as_it_is_writes_nothing() {
        let store = under_test();
        let scope = "@namespace/chunks";
        put(&store, scope, "c", 0, "a", chunk(5, "b2")).unwrap();
        let stamp = store.stamp(scope).unwrap();
        let same = put(&store, scope, "c", 1, "b", chunk(5, "b2")).unwrap();
        assert_eq!(same.version, 1);
        assert_eq!(store.stamp(scope).unwrap(), stamp);
        assert_eq!(store.get(scope, "c").unwrap().record.unwrap().version, 1);
    }

    #[test]
    fn every_field_of_a_record_comes_back_whether_it_has_a_column_or_not() {
        let store = under_test();
        let value = json!({
            "kind": "namespace-file", "byte_length": 12, "media_type": "text/plain", "origin": "b2", "key": "k", "spans": 0,
            "aliases": [{"alias": "12:aa", "grade": "checked"}], "names": ["/a.txt"],
            "extra_field": {"nested": [1, 2, {"x": null}]}, "also": true,
            "part_bytes": "not a number",
        });
        put(&store, "@namespace/files", "1f:aa", 0, "file", value.clone()).unwrap();
        assert_eq!(store.get("@namespace/files", "1f:aa").unwrap().record.unwrap().value, value);
        let other = json!({"kind": "namespace-origin", "rank": 1, "reach": {"bucket": {"value": "b"}}, "takes_new_bytes": true});
        put(&store, "@namespace/origins", "local", 0, "origin", other.clone()).unwrap();
        assert_eq!(store.get("@namespace/origins", "local").unwrap().record.unwrap().value, other, "a scope no table claims keeps its value whole");
        assert!(matches!(put(&store, "@namespace/files", "1f:bb", 0, "bad", json!("text")), Err(Error::Invalid(..))), "a row of a table is an object");
    }

    #[test]
    fn a_scope_lists_in_byte_order_a_page_at_a_time_and_only_its_own_rows() {
        let store = under_test();
        let names = "@namespace/names/Notes";
        for (at, id) in ["/Notes/b", "/Notes/B", "/Notes/a", "/Notes/é", "/Notes/10", "/Notes/9"].iter().enumerate() {
            put(&store, names, id, 0, &format!("n{at}"), json!({"kind": "namespace-name", "name": id})).unwrap();
        }
        put(&store, "@namespace/names/Other", "/Other/z", 0, "z", json!({"kind": "namespace-name", "name": "/Other/z"})).unwrap();
        let mut seen = Vec::new();
        let mut after = String::new();
        loop {
            let page = store.list_page(names, &after, 2).unwrap();
            assert!(page.items.len() <= 2);
            seen.extend(page.items.iter().map(|record| record.id.clone()));
            match page.next {
                Some(next) => after = next,
                None => break,
            }
        }
        assert_eq!(seen, ["/Notes/10", "/Notes/9", "/Notes/B", "/Notes/a", "/Notes/b", "/Notes/é"], "bytes, not language, order the ids");
        let (ids, next) = store.ids(names, Some("/Notes/9"), 2).unwrap();
        assert_eq!((ids, next), (vec!["/Notes/B".to_owned(), "/Notes/a".to_owned()], Some("/Notes/a".to_owned())));
        assert_eq!(store.list_page("@namespace/names/Nothing", "", 10).unwrap().items.len(), 0);
        let many = store.get_many(names, &["/Notes/a", "/Notes/none", "/Notes/b"]).unwrap();
        assert_eq!(many.iter().map(|row| row.is_some()).collect::<Vec<_>>(), [true, false, true]);
    }

    #[test]
    fn a_scopes_stamp_moves_with_each_change_in_it_and_no_other() {
        let store = under_test();
        let (a, b) = ("@namespace/names/A", "@namespace/names/B");
        assert_eq!(store.stamp(a).unwrap(), 0);
        put(&store, a, "/A/1", 0, "1", json!({"kind": "namespace-name"})).unwrap();
        put(&store, a, "/A/2", 0, "2", json!({"kind": "namespace-name"})).unwrap();
        assert_eq!((store.stamp(a).unwrap(), store.stamp(b).unwrap()), (2, 0));
        remove(&store, a, "/A/1", 1, "3").unwrap();
        assert_eq!(store.stamp(a).unwrap(), 3);
    }

    #[test]
    fn the_declared_totals_count_files_by_store_names_chunks_and_uploads() {
        let store = under_test();
        let file = |origin: &str, bytes: i64| json!({"kind": "namespace-file", "origin": origin, "byte_length": bytes});
        put(&store, "@namespace/files", "1f:1", 0, "a", file("b2", 100)).unwrap();
        put(&store, "@namespace/files", "1f:2", 0, "b", file("b2", 1)).unwrap();
        put(&store, "@namespace/files", "1f:3", 0, "c", file("r2", 12)).unwrap();
        put(&store, "@namespace/names/", "/a", 0, "d", json!({"kind": "namespace-name", "name": "/a"})).unwrap();
        put(&store, "@namespace/set-aside/names/", "/b", 0, "e", json!({"kind": "namespace-set-aside", "name": "/b"})).unwrap();
        put(&store, "@namespace/chunks", "c1", 0, "f", chunk(40, "b2")).unwrap();
        put(&store, "@namespace/chunks", "c2", 0, "g", chunk(2, "b2")).unwrap();
        put(&store, "@namespace/uploads", "up:1", 0, "h", json!({"kind": "namespace-upload", "byte_length": 5000})).unwrap();
        let totals = store.totals().unwrap();
        let of = |name: &str| -> Vec<(Option<String>, i64, i64)> { totals.iter().filter(|row| row.total == name).map(|row| (row.group.clone(), row.count, row.sum)).collect() };
        assert_eq!(of("namespace-file/origin"), [(Some("b2".into()), 2, 101), (Some("r2".into()), 1, 12)]);
        assert_eq!(of("namespace-name/all"), [(None, 1, 0)], "the names set aside are not the person's names");
        assert_eq!(of("namespace-chunk/all"), [(None, 2, 42)]);
        assert_eq!(of("namespace-upload/all"), [(None, 1, 5000)]);
    }

    #[test]
    fn a_word_search_finds_the_files_whose_names_hold_every_word() {
        let store = under_test();
        let file = |names: Value| json!({"kind": "namespace-file", "origin": "b2", "byte_length": 1, "names": names});
        put(&store, "@namespace/files", "1f:1", 0, "a", file(json!(["/Reports/Annual Report 2026.pdf"]))).unwrap();
        put(&store, "@namespace/files", "1f:2", 0, "b", file(json!(["/Reports/annual-budget.xlsx", "/Old/Report.txt"]))).unwrap();
        put(&store, "@namespace/files", "1f:3", 0, "c", file(json!(["/Photos/100%_done.png"]))).unwrap();
        let found = |words: &[&str]| -> Vec<String> { store.search(&words.iter().map(|word| word.to_string()).collect::<Vec<_>>(), 10).unwrap().into_iter().map(|record| record.id).collect() };
        assert_eq!(found(&["annual"]), ["1f:1", "1f:2"]);
        assert_eq!(found(&["annual", "report"]), ["1f:1", "1f:2"], "the words may be in different names of one file: the caller keeps the file one name holds them all");
        assert_eq!(found(&["REPORT", "budget"]), ["1f:2"]);
        assert_eq!(found(&["100%"]), ["1f:3"], "a percent sign in a word is a character, not a wildcard");
        assert!(found(&["_"]).len() == 1 && found(&["zzz"]).is_empty());
        assert_eq!(store.search(&["annual".to_owned()], 1).unwrap().len(), 1);
    }

    #[test]
    fn two_handles_on_one_database_see_each_others_changes() {
        let first = under_test();
        let second = first.same_database();
        put(&first, "@namespace/chunks", "c", 0, "k", chunk(1, "b2")).unwrap();
        assert_eq!(second.get("@namespace/chunks", "c").unwrap().record.unwrap().version, 1);
        assert_eq!(put(&second, "@namespace/chunks", "c", 0, "other", chunk(2, "b2")), Err(crate::cause!(Error::Conflict)));
    }

    #[test]
    fn rows_in_a_file_are_there_when_the_file_is_opened_again() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("names.sqlite");
        put(&SqlStore::open(Link::sqlite(&path).unwrap()).unwrap(), "@namespace/chunks", "c", 0, "k", chunk(1, "b2")).unwrap();
        let again = SqlStore::open(Link::sqlite(&path).unwrap()).unwrap();
        assert_eq!(again.get("@namespace/chunks", "c").unwrap().record.unwrap().value, chunk(1, "b2"));
        assert_eq!(again.place(), path.display().to_string());
    }
}
