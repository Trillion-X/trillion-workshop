// Purpose: Log generations: an append-only log table is sealed whole (renamed after its first row, a fresh open log made
// in the same transaction), its rows are read back a bounded page at a time in the order they were written (sized from
// each row's header before any row is read), where its copying elsewhere has reached is kept one row per page, and once
// every row is kept the generation leaves a bounded piece per step: its children first (views and triggers that name
// it, then its indexes, one per step), then rows only while it spans more rowids than one drop may free, then the
// whole table in one DROP. A dropped table costs no row written; deleting kept rows one by one costs one each.
//
// Ported one to one from old trillion (tag old-trillion-before-worker-retire): `parts/eeaf/do-work/eeaf-sqlite-store.mjs`
// `sealLog` :1157, `sealedLogs` :827, `sealedLogPage` :1171, `sealedLogKept` :1201, `keepSealedLogThrough` :1202,
// `dropSealedLog` :1214, `oldestLogId` / `lastLogId` :1143-1153, and `src/let-go-of-table.mjs` `letGoStep` (with its
// settings `src/let-go-of-table.json`, here `generations.json`). Which log has generations is its owner's DATA: the
// `Log` it opens with (its table name, its CREATE statement and its id column).
//
// Non-Negotiable Invariants:
// - Sealing renames the open log and makes a fresh one in one transaction; an empty log is not sealed.
// - A page never holds a row past its byte bound but always at least one row; one row larger than four times the bound
//   is refused before it is read.
// - The kept position only moves forward; with `reclaim`, the newly kept rows are deleted in the same transaction as
//   the position moves, never a row not yet kept.
// - A let-go step changes one thing: one child, one batch of rows, or nothing (answering `Drop`); the table's span is
//   read by two seeks (min and max rowid), never by walking its rows.
// - Only a sealed generation of this log is paged, kept, let go or dropped.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use std::sync::OnceLock;

/// The bounds of letting a generation go and sizing a page (`generations.json`).
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct LetGo {
    pub drop_rows: i64,
    pub delete_rows: i64,
    pub row_overhead_bytes: i64,
}
/// The shipped bounds.
pub fn shipped() -> LetGo {
    #[derive(Deserialize)]
    struct File {
        drop_rows: i64,
        delete_rows: i64,
        row_overhead_bytes: i64,
    }
    static SHIPPED: OnceLock<LetGo> = OnceLock::new();
    *SHIPPED.get_or_init(|| {
        let file: File = serde_json::from_str(include_str!("generations.json")).expect("generations.json");
        LetGo { drop_rows: file.drop_rows, delete_rows: file.delete_rows, row_overhead_bytes: file.row_overhead_bytes }
    })
}

/// One let-go step's piece.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Piece {
    /// A view or trigger naming the table was dropped.
    Child,
    /// One of the table's own indexes was dropped.
    Index,
    /// A batch of its oldest rows was deleted.
    Rows,
    /// Nothing is left but what one DROP frees: the owner drops it now.
    Drop,
}

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// One step of letting `table` go (old `letGoStep`): its children first, then rows while it spans more than `drop_rows`.
pub fn let_go_step(db: &Connection, table: &str, settings: LetGo) -> rusqlite::Result<Piece> {
    // Children first: a view or trigger that names the table never outlives what it reads.
    let child: Option<(String, String)> = db
        .query_row(
            "SELECT type, name FROM sqlite_schema WHERE type IN ('view', 'trigger') AND name <> ?1 AND (tbl_name = ?1 OR sql LIKE '%' || ?1 || '%') LIMIT 1",
            [table],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((kind, name)) = child {
        db.execute_batch(&format!("DROP {} {}", kind.to_uppercase(), quoted(&name)))?;
        return Ok(Piece::Child);
    }
    let index: Option<String> = db.query_row("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL LIMIT 1", [table], |row| row.get(0)).optional()?;
    if let Some(index) = index {
        db.execute_batch(&format!("DROP INDEX {}", quoted(&index)))?;
        return Ok(Piece::Index);
    }
    if span_of(db, table)? > settings.drop_rows {
        db.execute(&format!("DELETE FROM {0} WHERE rowid IN (SELECT rowid FROM {0} ORDER BY rowid LIMIT ?)", quoted(table)), [settings.delete_rows])?;
        return Ok(Piece::Rows);
    }
    Ok(Piece::Drop)
}
/// How many rowids a table spans, by two seeks.
pub fn span_of(db: &Connection, table: &str) -> rusqlite::Result<i64> {
    let low: Option<i64> = db.query_row(&format!("SELECT MIN(rowid) FROM {}", quoted(table)), [], |row| row.get(0))?;
    let Some(low) = low else { return Ok(0) };
    let high: i64 = db.query_row(&format!("SELECT MAX(rowid) FROM {}", quoted(table)), [], |row| row.get(0))?;
    Ok(high - low + 1)
}

/// A log whose generations are sealed and let go: its open table, the statement that makes it (with `{table}` where its
/// name goes), the column holding each row's id (sortable text), and the prefix of its sealed tables.
#[derive(Clone, Debug)]
pub struct Log {
    pub table: String,
    pub create: String,
    pub id_column: String,
    pub sealed_prefix: String,
    /// The columns a page's size estimate adds up (each row's header length, never its text).
    pub sized_columns: Vec<String>,
}

/// A sealed page: its rows (each column's value), and the rowid to continue after.
#[derive(Debug, PartialEq)]
pub struct Page {
    pub rows: Vec<Vec<rusqlite::types::Value>>,
    pub rowids: Vec<i64>,
    pub last: i64,
}

/// Refusals of a generation operation.
#[derive(Debug)]
pub enum GenerationError {
    NotSealed(String, crate::refusal_cause::Cause),
    TooLarge(crate::refusal_cause::Cause),
    Backwards(crate::refusal_cause::Cause),
    Sql(rusqlite::Error, crate::refusal_cause::Cause),
}
impl GenerationError {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::NotSealed(_, cause) => cause.clone(),
            Self::TooLarge(cause) => cause.clone(),
            Self::Backwards(cause) => cause.clone(),
            Self::Sql(_, cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(GenerationError);


impl From<rusqlite::Error> for GenerationError {
    #[track_caller]
    fn from(error: rusqlite::Error) -> Self {
        Self::Sql(error, crate::cause!(caller_site: Self::Sql))
    }
}

/// The generations of one log over one connection.
pub struct Generations<'c> {
    db: &'c Connection,
    log: Log,
}
impl<'c> Generations<'c> {
    /// Open the log, making its open table and the kept-position table when absent.
    pub fn open(db: &'c Connection, log: Log) -> rusqlite::Result<Self> {
        db.execute_batch(&log.create.replace("{table}", &quoted(&log.table)))?;
        db.execute_batch(&format!("CREATE TABLE IF NOT EXISTS {} (sealed_table TEXT PRIMARY KEY, kept_through INTEGER NOT NULL)", quoted(&format!("{}_moves", log.table))))?;
        Ok(Generations { db, log })
    }
    fn moves(&self) -> String {
        quoted(&format!("{}_moves", self.log.table))
    }
    /// The sealed tables, oldest first.
    pub fn sealed(&self) -> rusqlite::Result<Vec<String>> {
        let mut statement = self.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND substr(name, 1, length(?1)) = ?1 ORDER BY name")?;
        let names = statement.query_map([&self.log.sealed_prefix], |row| row.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(names)
    }
    fn require_sealed(&self, table: &str) -> Result<(), GenerationError> {
        if self.sealed()?.iter().any(|name| name == table) { Ok(()) } else { Err(GenerationError::NotSealed(table.to_string(), crate::cause!())) }
    }
    /// The id of the oldest row of the open log, None when it is empty.
    pub fn oldest_id(&self) -> rusqlite::Result<Option<String>> {
        self.db.query_row(&format!("SELECT {} FROM {} ORDER BY rowid LIMIT 1", quoted(&self.log.id_column), quoted(&self.log.table)), [], |row| row.get(0)).optional()
    }
    /// The newest id still held, open log first, then each sealed generation newest first: one seek each.
    pub fn last_id(&self) -> rusqlite::Result<Option<String>> {
        for table in std::iter::once(self.log.table.clone()).chain(self.sealed()?.into_iter().rev()) {
            let id: Option<String> = self.db.query_row(&format!("SELECT {} FROM {} ORDER BY rowid DESC LIMIT 1", quoted(&self.log.id_column), quoted(&table)), [], |row| row.get(0)).optional()?;
            if id.is_some() {
                return Ok(id);
            }
        }
        Ok(None)
    }
    /// Seal the open log after its first row and open a fresh one, in one transaction; None when it is empty.
    pub fn seal(&self) -> rusqlite::Result<Option<String>> {
        let Some(first) = self.oldest_id()? else { return Ok(None) };
        let suffix: String = first.chars().filter(char::is_ascii_hexdigit).collect::<String>().to_lowercase();
        let name = format!("{}{suffix}", self.log.sealed_prefix);
        self.db.execute_batch(&format!(
            "SAVEPOINT seal_log; ALTER TABLE {} RENAME TO {}; {}; RELEASE seal_log;",
            quoted(&self.log.table),
            quoted(&name),
            self.log.create.replace("{table}", &quoted(&self.log.table))
        ))?;
        Ok(Some(name))
    }
    /// A sealed table's rows after rowid `after`, at most `limit`; `max_bytes` bounds the page by a size-only pass first.
    pub fn page(&self, table: &str, after: i64, limit: i64, max_bytes: Option<i64>) -> Result<Page, GenerationError> {
        self.require_sealed(table)?;
        let mut take = limit;
        if let Some(max_bytes) = max_bytes {
            let sized: Vec<String> = self.log.sized_columns.iter().map(|column| format!("COALESCE(octet_length({}), 0)", quoted(column))).collect();
            let estimate = format!("{} + {}", shipped().row_overhead_bytes, if sized.is_empty() { "0".to_string() } else { sized.join(" + ") });
            let mut statement = self.db.prepare(&format!("SELECT {estimate} FROM {} WHERE rowid > ? ORDER BY rowid LIMIT ?", quoted(table)))?;
            let sizes = statement.query_map(params![after, limit], |row| row.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<i64>>>()?;
            take = 0;
            let mut bytes = 0;
            for size in sizes {
                if take == 0 && size > max_bytes * 4 {
                    return Err(crate::cause!(GenerationError::TooLarge));
                }
                if take > 0 && bytes + size > max_bytes {
                    break;
                }
                take += 1;
                bytes += size;
            }
        }
        if take == 0 {
            return Ok(Page { rows: Vec::new(), rowids: Vec::new(), last: after });
        }
        let mut statement = self.db.prepare(&format!("SELECT rowid, * FROM {} WHERE rowid > ? ORDER BY rowid LIMIT ?", quoted(table)))?;
        let width = statement.column_count();
        let mut rows = Vec::new();
        let mut rowids = Vec::new();
        let mut found = statement.query(params![after, take])?;
        while let Some(row) = found.next()? {
            rowids.push(row.get::<_, i64>(0)?);
            rows.push((1..width).map(|at| row.get::<_, rusqlite::types::Value>(at)).collect::<rusqlite::Result<Vec<_>>>()?);
        }
        let last = rowids.last().copied().unwrap_or(after);
        Ok(Page { rows, rowids, last })
    }
    /// The last rowid of a sealed table kept elsewhere (0 when none).
    pub fn kept(&self, table: &str) -> rusqlite::Result<i64> {
        Ok(self.db.query_row(&format!("SELECT kept_through FROM {} WHERE sealed_table = ?", self.moves()), [table], |row| row.get(0)).optional()?.unwrap_or(0))
    }
    /// Record that a sealed table is kept elsewhere through `rowid`; with `reclaim`, delete the newly kept rows in the
    /// same transaction.
    pub fn keep_through(&self, table: &str, rowid: i64, reclaim: bool) -> Result<(), GenerationError> {
        self.require_sealed(table)?;
        let after = self.kept(table)?;
        if rowid < after {
            return Err(crate::cause!(GenerationError::Backwards));
        }
        self.db.execute_batch("SAVEPOINT keep_generation")?;
        let done = (|| {
            if reclaim {
                self.db.execute(&format!("DELETE FROM {} WHERE rowid > ? AND rowid <= ?", quoted(table)), params![after, rowid])?;
            }
            self.db.execute(&format!("INSERT INTO {} (sealed_table, kept_through) VALUES (?, ?) ON CONFLICT (sealed_table) DO UPDATE SET kept_through = excluded.kept_through", self.moves()), params![table, rowid])?;
            Ok::<(), rusqlite::Error>(())
        })();
        match done {
            Ok(()) => self.db.execute_batch("RELEASE keep_generation")?,
            Err(error) => {
                self.db.execute_batch("ROLLBACK TO keep_generation; RELEASE keep_generation")?;
                return Err(error.into());
            }
        }
        Ok(())
    }
    /// One bounded step of letting a sealed table go; once it answers `Drop`, `drop_sealed` finishes it.
    pub fn let_go(&self, table: &str, settings: LetGo) -> Result<Piece, GenerationError> {
        self.require_sealed(table)?;
        Ok(let_go_step(self.db, table, settings)?)
    }
    /// Drop a sealed table whole, with its kept position, in one transaction.
    pub fn drop_sealed(&self, table: &str) -> Result<(), GenerationError> {
        self.require_sealed(table)?;
        self.db.execute_batch(&format!("SAVEPOINT drop_generation; DROP TABLE {}; RELEASE drop_generation;", quoted(table)))?;
        self.db.execute(&format!("DELETE FROM {} WHERE sealed_table = ?", self.moves()), [table])?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "generations_tests.rs"]
mod tests;
