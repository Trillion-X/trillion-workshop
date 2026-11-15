// Purpose: A native stand-in for a host that lends a computer SQLite only through one statement call
// (`storage::hosted_sql::HostSql`), over a file on this computer, so the hosted-SQL supply runs the same conformance
// suites as the disk and memory supplies in `cargo test` on any computer.
//
// Non-Negotiable Invariants:
// - It refuses what such a host refuses: a transaction statement (BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT, RELEASE),
//   PRAGMA, VACUUM, ATTACH, DETACH, and any name under the host's reserved `_cf_` prefix. So a supply that passes here
//   never needed any of them.
// - A cell crosses as a host language carries it: a SQLite integer comes back as a 64-bit float, as a JavaScript
//   number would, and an integer is never bound. The supply's exact-integer form is what keeps a stamp exact.
// - A scope's bracket (`hold`/`release`) is the stand-in's own transaction on its own connection: it models a host
//   that makes one turn of its object atomic. It never rolls back on its own; only `crash` (the turn ends before it was
//   made durable) does. Every rollback a test sees is the supply's undo journal.
// - Each `open` is another connection (another handle); the stand-in answers `mark` from SQLite's `data_version`, so
//   another handle's commit moves it as the disk supply's does.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::storage::{
    hosted_sql::{Cell, HostSql},
    Error, Intent, Result,
};
use rusqlite::{params_from_iter, types::{Value as SqlValue, ValueRef}, Connection, ErrorCode};
use std::{cell::Cell as Counter, path::Path, time::Duration};

/// The first words of the statements such a host refuses.
const REFUSED: [&str; 10] = ["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE", "PRAGMA", "VACUUM", "ATTACH", "DETACH"];

/// How long a handle waits for another handle's write before it answers `Busy`.
const BUSY_WAIT: Duration = Duration::from_millis(1_000);

/// One handle on a hosted database file.
pub struct StandIn {
    db: Option<Connection>,
    /// Statements run through `exec`: the host calls this handle made.
    calls: Counter<u64>,
}

/// Open another handle on the database at `path` (made when absent).
pub fn open(path: &Path) -> Result<StandIn> {
    let db = Connection::open(path).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    // A bounded wait for another handle's write, as short as the disk supply's test bounds: a refused writer answers
    // `Busy` well inside the storage contract's bound (two refusals in a row stay under it).
    db.busy_timeout(BUSY_WAIT).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let mode: String = db.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0)).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(crate::cause!(Error::Unavailable));
    }
    db.execute_batch("PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;").map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    Ok(StandIn { db: Some(db), calls: Counter::new(0) })
}

#[track_caller]
fn failure(error: rusqlite::Error) -> Error {
    match error.sqlite_error_code() {
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => crate::cause!(caller: Error::Busy),
        Some(ErrorCode::TooBig) => crate::cause!(caller: Error::TooBig),
        Some(ErrorCode::ConstraintViolation) => crate::cause!(caller: Error::Conflict),
        Some(ErrorCode::ReadOnly) => crate::cause!(caller: Error::ReadOnly),
        Some(ErrorCode::DiskFull) => crate::cause!(caller: Error::DiskFull),
        _ => crate::cause!(caller: Error::Unavailable),
    }
}

/// Whether the host refuses this statement text.
pub fn refused(sql: &str) -> bool {
    let first = sql.trim_start().split(|c: char| !c.is_ascii_alphabetic()).next().unwrap_or("").to_ascii_uppercase();
    REFUSED.contains(&first.as_str()) || sql.to_ascii_lowercase().contains("_cf_")
}

impl StandIn {
    fn db(&self) -> Result<&Connection> {
        self.db.as_ref().ok_or(crate::cause!(Error::Unavailable))
    }
    /// The host calls this handle made.
    pub fn calls(&self) -> u64 {
        self.calls.get()
    }
    /// The turn ends before its writes were made durable: what the open bracket held is gone, and the handle is closed.
    pub fn crash(&mut self) {
        self.db = None;
    }
}

impl HostSql for StandIn {
    fn exec(&self, sql: &str, bind: &[Cell]) -> Result<Vec<Vec<Cell>>> {
        if refused(sql) {
            return Err(crate::cause!(Error::Invalid));
        }
        self.calls.set(self.calls.get() + 1);
        let db = self.db()?;
        let params: Vec<SqlValue> = bind
            .iter()
            .map(|cell| match cell {
                Cell::Null => SqlValue::Null,
                Cell::Real(v) => SqlValue::Real(*v),
                Cell::Text(v) => SqlValue::Text(v.clone()),
                Cell::Blob(v) => SqlValue::Blob(v.clone()),
            })
            .collect();
        let mut statement = db.prepare_cached(sql).map_err(|error| failure(error))?;
        let width = statement.column_count();
        let mut rows = statement.query(params_from_iter(params.iter())).map_err(|error| failure(error))?;
        let mut answered = Vec::new();
        while let Some(row) = rows.next().map_err(|error| failure(error))? {
            let mut cells = Vec::with_capacity(width);
            for at in 0..width {
                cells.push(match row.get_ref(at).map_err(|error| failure(error))? {
                    ValueRef::Null => Cell::Null,
                    ValueRef::Integer(v) => Cell::Real(v as f64),
                    ValueRef::Real(v) => Cell::Real(v),
                    ValueRef::Text(v) => Cell::Text(String::from_utf8(v.to_vec()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?),
                    ValueRef::Blob(v) => Cell::Blob(v.to_vec()),
                });
            }
            answered.push(cells);
        }
        Ok(answered)
    }
    fn hold(&self, intent: Intent) -> Result<()> {
        let db = self.db()?;
        db.execute_batch(if intent == Intent::Write { "BEGIN IMMEDIATE" } else { "BEGIN DEFERRED" }).map_err(|error| failure(error))
    }
    fn release(&self) -> Result<()> {
        self.db()?.execute_batch("COMMIT").map_err(|error| failure(error))
    }
    fn mark(&self) -> Result<i64> {
        self.db()?.query_row("PRAGMA main.data_version", [], |row| row.get(0)).map_err(|error| failure(error))
    }
    fn bytes(&self) -> Result<u64> {
        let db = self.db()?;
        let pages: i64 = db.query_row("PRAGMA main.page_count", [], |row| row.get(0)).map_err(|error| failure(error))?;
        let size: i64 = db.query_row("PRAGMA main.page_size", [], |row| row.get(0)).map_err(|error| failure(error))?;
        u64::try_from(pages * size).map_err(|error| crate::carry_cause!(Error::Unavailable, error))
    }
    fn custody(&self) -> Result<()> {
        self.db().map(|_| ())
    }
    fn overwrites_removed(&self) -> bool {
        false
    }
}
