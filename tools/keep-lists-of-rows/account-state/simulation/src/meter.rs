//! Metered SQLite for every candidate: one owner of the connection, the
//! existing `sqlite_work` meter, an index-entry meter, interruption faults,
//! read-cause scopes, gauges and an unmetered inspector connection.
//!
//! What is counted, and from where:
//! - `sql_statements`, `scan_visits`, `fullscan_steps`, `vm_steps`,
//!   `rows_returned`, `row_changes`: trillion-local `sqlite_work::WorkMeter`
//!   (the same trace owner the real account observer uses). `row_changes` is
//!   SQLite `total_changes64`, which EXCLUDES index entries.
//! - `table_rows_written`: one per row SQLite's pre-update hook reports for a
//!   real table (insert, update, delete; includes REPLACE deletes and FTS5
//!   shadow-table rows, which `total_changes` does not see).
//! - `index_entries_written`: per written row, one per secondary index of
//!   that table whose key changes (insert/delete: every index; update: only
//!   indexes whose key columns changed; expression keys count as changed).
//!   A WITHOUT ROWID table's primary key is the table itself, not an index.
//!   This follows the provider's stated rule ("an additional written row when
//!   writes include the indexed column"); CAL-1 must still confirm it.
//! - Causes: every written row is attributed to its table's purpose by the
//!   candidate's `classify`; reads are attributed by the candidate's scope
//!   (`Spans::cut(cause)`) or by `sqlite_work`'s fixed query families.

use local_engine::{
    scan::ReadWork,
    sqlite_work::{Family, ObservedConnection, WorkMeter},
};
use rusqlite::{
    hooks::{Action, PreUpdateCase},
    Connection, OpenFlags,
};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use workload_simulation::{Interrupt, Meters, StoreError};

pub const STATEMENTS: &str = "sql_statements";
pub const SCAN_VISITS: &str = "scan_visits";
pub const FULLSCAN_STEPS: &str = "fullscan_steps";
pub const VM_STEPS: &str = "vm_steps";
pub const ROWS_RETURNED: &str = "rows_returned";
pub const ROW_CHANGES: &str = "row_changes";
pub const TABLE_ROWS_WRITTEN: &str = "table_rows_written";
pub const INDEX_ENTRIES_WRITTEN: &str = "index_entries_written";
pub const BYTES_STORED: &str = "bytes_stored";
pub const SCHEMA_OBJECTS: &str = "schema_objects";
/// Sealed-history archive writes (an R2 PUT each) and their bytes. Candidates
/// that never archive report a true zero, not an unknown.
pub const ARCHIVE_PUTS: &str = "archive_puts";
pub const ARCHIVE_BYTES: &str = "archive_bytes";
/// Archive reads (an R2 GET each): cold-tier point reads and page-locator rebuilds.
pub const ARCHIVE_GETS: &str = "archive_gets";
/// Database pages rewritten to physically erase deleted content.
pub const ERASURE_PAGES_REWRITTEN: &str = "erasure_pages_rewritten";
/// Inverted search: tail entries (changes not yet in a persisted segment) a search found in memory.
pub const SEARCH_TAIL_ENTRIES: &str = "search_tail_entries";
/// Inverted search: age in ms of the oldest unpersisted change when a search ran (persisted-index lag; results stay exact).
pub const SEARCH_LAG_MS: &str = "search_index_lag_ms";

/// Meter names every SQLite candidate reports.
pub const SQLITE_METERS: [&str; 16] = [
    STATEMENTS,
    SCAN_VISITS,
    FULLSCAN_STEPS,
    VM_STEPS,
    ROWS_RETURNED,
    ROW_CHANGES,
    TABLE_ROWS_WRITTEN,
    INDEX_ENTRIES_WRITTEN,
    BYTES_STORED,
    SCHEMA_OBJECTS,
    ARCHIVE_PUTS,
    ARCHIVE_BYTES,
    ARCHIVE_GETS,
    ERASURE_PAGES_REWRITTEN,
    SEARCH_TAIL_ENTRIES,
    SEARCH_LAG_MS,
];

/// VM instructions between progress callbacks (interruption granularity).
const PROGRESS_EVERY: i32 = 16;

pub fn err<E: std::fmt::Display>(e: E) -> StoreError {
    StoreError(e.to_string())
}

/// How reads of a measured span are attributed.
#[derive(Clone, Copy)]
pub enum ReadCause {
    /// The candidate knows the purpose of its statements.
    Scoped(&'static str),
    /// The statements belong to an existing engine; use `sqlite_work`'s
    /// fixed families as causes.
    Families,
}

pub fn family_cause(f: Family) -> &'static str {
    match f {
        Family::Catalogue | Family::Columns => "catalogue",
        Family::Kept => "record_pages",
        Family::Projection => "projection",
        Family::Journal => "journal",
        Family::PolicySession => "policy",
        Family::Other => "unclassified",
    }
}

struct WriteEvent {
    table: String,
    /// For updates: which columns changed. Inserts/deletes: None.
    changed: Option<Vec<bool>>,
}

#[derive(Clone)]
struct IndexInfo {
    name: String,
    /// Key column positions; None = an expression key (always counted).
    columns: Option<Vec<usize>>,
}

struct Mark {
    work: ReadWork,
    families: Vec<ReadWork>,
}

fn snapshot(meter: &WorkMeter) -> Result<Mark, StoreError> {
    let o = meter.snapshot().map_err(err)?;
    Ok(Mark {
        work: o.work,
        families: o.families.iter().map(|f| f.work.clone()).collect(),
    })
}

/// Read attribution within one measured attempt: each `cut` charges the
/// statements and scan visits since the previous cut to one cause.
pub struct Spans {
    meter: WorkMeter,
    last: Mark,
    pub meters: Meters,
}

impl Spans {
    pub fn cut(&mut self, cause: ReadCause) -> Result<(), StoreError> {
        let o = self.meter.snapshot().map_err(err)?;
        let d = |a: u64, b: u64| b.saturating_sub(a);
        let (w0, w1) = (&self.last.work, &o.work);
        let m = &mut self.meters;
        m.add(FULLSCAN_STEPS, d(w0.fullscan_steps, w1.fullscan_steps));
        m.add(VM_STEPS, d(w0.vm_steps, w1.vm_steps));
        m.add(ROWS_RETURNED, d(w0.rows_returned, w1.rows_returned));
        m.add(ROW_CHANGES, d(w0.rows_written, w1.rows_written));
        match cause {
            ReadCause::Scoped(c) => {
                m.add_caused(STATEMENTS, c, d(w0.sql_statements, w1.sql_statements));
                m.add_caused(
                    SCAN_VISITS,
                    c,
                    d(w0.sqlite_scan_visits, w1.sqlite_scan_visits),
                );
            }
            ReadCause::Families => {
                for (before, after) in self.last.families.iter().zip(o.families.iter()) {
                    let c = family_cause(after.family);
                    m.add_caused(
                        STATEMENTS,
                        c,
                        d(before.sql_statements, after.work.sql_statements),
                    );
                    m.add_caused(
                        SCAN_VISITS,
                        c,
                        d(before.sqlite_scan_visits, after.work.sqlite_scan_visits),
                    );
                }
            }
        }
        self.last = Mark {
            work: o.work,
            families: o.families.iter().map(|f| f.work.clone()).collect(),
        };
        Ok(())
    }
}

/// Owns the observed connection. Field order is drop order.
pub struct MeteredDb {
    observed: ObservedConnection,
    meter: WorkMeter,
    writes: Arc<Mutex<Vec<WriteEvent>>>,
    interrupt_left: Arc<AtomicU64>,
    interrupted: Arc<AtomicBool>,
    inspector: Connection,
    schema_version: i64,
    indexes: BTreeMap<String, Vec<IndexInfo>>,
    path: PathBuf,
    classify: fn(&str) -> &'static str,
}

impl MeteredDb {
    /// Open (creating if needed) `path`, attach the existing work meter and
    /// this module's hooks. `meter` persists across crash/reopen of a store.
    pub fn open(
        path: &Path,
        meter: WorkMeter,
        classify: fn(&str) -> &'static str,
    ) -> Result<Self, StoreError> {
        let raw = Connection::open(path).map_err(err)?;
        // SAFETY: a freshly opened connection has a vacant trace slot that only
        // this wrapper uses for its whole lifetime.
        let observed =
            unsafe { ObservedConnection::attach_untraced(raw, meter.clone()) }.map_err(err)?;
        let writes: Arc<Mutex<Vec<WriteEvent>>> = Arc::default();
        let sink = writes.clone();
        observed.connection().preupdate_hook(Some(
            move |action: Action, db: &str, table: &str, case: &PreUpdateCase| {
                if db != "main" {
                    return;
                }
                let changed = match (action, case) {
                    (
                        Action::SQLITE_UPDATE,
                        PreUpdateCase::Update {
                            old_value_accessor,
                            new_value_accessor,
                        },
                    ) => {
                        let n = old_value_accessor.get_column_count();
                        Some(
                            (0..n)
                                .map(|i| {
                                    match (
                                        old_value_accessor.get_old_column_value(i),
                                        new_value_accessor.get_new_column_value(i),
                                    ) {
                                        (Ok(a), Ok(b)) => a != b,
                                        _ => true,
                                    }
                                })
                                .collect(),
                        )
                    }
                    _ => None,
                };
                if let Ok(mut w) = sink.lock() {
                    w.push(WriteEvent {
                        table: table.to_owned(),
                        changed,
                    });
                }
            },
        ));
        let interrupt_left = Arc::new(AtomicU64::new(0));
        let interrupted = Arc::new(AtomicBool::new(false));
        let (left, fired) = (interrupt_left.clone(), interrupted.clone());
        observed.connection().progress_handler(
            PROGRESS_EVERY,
            Some(move || match left.load(Ordering::Relaxed) {
                0 => false,
                1 => {
                    left.store(0, Ordering::Relaxed);
                    fired.store(true, Ordering::Relaxed);
                    true
                }
                n => {
                    left.store(n - 1, Ordering::Relaxed);
                    false
                }
            }),
        );
        let inspector = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(err)?;
        Ok(Self {
            observed,
            meter,
            writes,
            interrupt_left,
            interrupted,
            inspector,
            schema_version: -1,
            indexes: BTreeMap::new(),
            path: path.to_owned(),
            classify,
        })
    }

    pub fn conn(&self) -> &Connection {
        self.observed.connection()
    }
    pub fn conn_mut(&mut self) -> &mut ObservedConnection {
        &mut self.observed
    }
    /// The unmetered connection (oracle reads and gauges only).
    pub fn inspector(&self) -> &Connection {
        &self.inspector
    }

    /// A non-owning `Connection` over the SAME observed handle, for engines
    /// that take a `Connection` by value.
    ///
    /// # Safety
    /// The returned connection must be dropped before this `MeteredDb`, and
    /// [`MeteredDb::release_hooks`] must be called before dropping it (a
    /// non-owning rusqlite connection clears the handle's hooks on close).
    pub unsafe fn borrowed_connection(&self) -> Result<Connection, StoreError> {
        Connection::from_handle(self.observed.connection().handle()).map_err(err)
    }

    /// Unregister and free this owner's hooks (before a borrowed connection closes).
    pub fn release_hooks(&self) {
        self.conn()
            .preupdate_hook(None::<fn(Action, &str, &str, &PreUpdateCase)>);
        self.conn().progress_handler(0, None::<fn() -> bool>);
    }

    /// Start measuring: snapshot counters and discard writes nobody claimed
    /// (oracle or setup work between operations is never charged).
    pub fn spans(&self) -> Result<Spans, StoreError> {
        if let Ok(mut w) = self.writes.lock() {
            w.clear();
        }
        Ok(Spans {
            last: snapshot(&self.meter)?,
            meter: self.meter.clone(),
            meters: Meters::new(),
        })
    }

    /// Close a measurement: charge reads not yet cut as `unclassified`, then
    /// every row written since `spans()`.
    pub fn finish(&mut self, mut spans: Spans) -> Result<Meters, StoreError> {
        spans.cut(ReadCause::Scoped("unclassified"))?;
        let mut m = spans.meters;
        self.charge_writes(&mut m)?;
        Ok(m)
    }

    /// Charge every row written since `spans()` / the previous charge.
    fn charge_writes(&mut self, meters: &mut Meters) -> Result<(), StoreError> {
        let events: Vec<WriteEvent> = match self.writes.lock() {
            Ok(mut w) => std::mem::take(&mut *w),
            Err(_) => return Err(StoreError("write meter poisoned".into())),
        };
        meters.add(TABLE_ROWS_WRITTEN, 0);
        meters.add(INDEX_ENTRIES_WRITTEN, 0);
        if events.is_empty() {
            return Ok(());
        }
        self.refresh_schema()?;
        for e in events {
            let cause = (self.classify)(&e.table);
            meters.add_caused(TABLE_ROWS_WRITTEN, cause, 1);
            if !self.indexes.contains_key(&e.table) {
                let info = index_info(&self.inspector, &e.table)?;
                self.indexes.insert(e.table.clone(), info);
            }
            for i in &self.indexes[&e.table] {
                let written = match (&e.changed, &i.columns) {
                    (None, _) | (Some(_), None) => true,
                    (Some(changed), Some(cols)) => cols
                        .iter()
                        .any(|c| changed.get(*c).copied().unwrap_or(true)),
                };
                if written {
                    // An index's own purpose wins; otherwise its table's.
                    let by_name = (self.classify)(&i.name);
                    let c = if by_name == "unclassified" {
                        cause
                    } else {
                        by_name
                    };
                    meters.add_caused(INDEX_ENTRIES_WRITTEN, c, 1);
                }
            }
        }
        Ok(())
    }

    fn refresh_schema(&mut self) -> Result<(), StoreError> {
        let v: i64 = self
            .inspector
            .query_row("PRAGMA schema_version", [], |r| r.get(0))
            .map_err(err)?;
        if v != self.schema_version {
            self.indexes.clear();
            self.schema_version = v;
        }
        Ok(())
    }

    /// Arm an interruption for the next attempt (None disarms).
    pub fn arm(&self, fault: Option<Interrupt>) {
        self.interrupted.store(false, Ordering::Relaxed);
        let calls = fault.map_or(0, |f| {
            f.after_vm_steps.div_ceil(PROGRESS_EVERY as u64).max(1)
        });
        self.interrupt_left.store(calls, Ordering::Relaxed);
    }
    /// Disarm and report whether the armed interruption fired.
    pub fn disarm(&self) -> bool {
        self.interrupt_left.store(0, Ordering::Relaxed);
        self.interrupted.swap(false, Ordering::Relaxed)
    }

    /// Database size (what the provider stores) and schema object count.
    pub fn gauges(&self) -> Result<Meters, StoreError> {
        let mut m = Meters::new();
        let pages: i64 = self
            .inspector
            .query_row("PRAGMA page_count", [], |r| r.get(0))
            .map_err(err)?;
        let size: i64 = self
            .inspector
            .query_row("PRAGMA page_size", [], |r| r.get(0))
            .map_err(err)?;
        let objects: i64 = self
            .inspector
            .query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))
            .map_err(err)?;
        m.add(BYTES_STORED, (pages * size) as u64);
        m.add(SCHEMA_OBJECTS, objects as u64);
        Ok(m)
    }

    /// Database, WAL and shared-memory files (erasure residue scan).
    pub fn files(&self) -> Vec<PathBuf> {
        let base = self.path.to_string_lossy().into_owned();
        vec![
            self.path.clone(),
            PathBuf::from(format!("{base}-wal")),
            PathBuf::from(format!("{base}-shm")),
        ]
    }
}

/// Call after DDL (CREATE/DROP TABLE or INDEX) on a measured connection.
///
/// A statement cached before a schema change re-prepares on its next step,
/// and `sqlite_work` refuses the counters of a re-prepared statement (they
/// restart mid-execution), which latches the whole observation `Incomplete`
/// and fails every later attempt on that meter. Dropping the cache makes
/// every later statement compile against the new schema instead.
pub fn schema_changed(conn: &Connection) {
    conn.flush_prepared_statement_cache();
}

/// Physical erasure of a closed store file on the local placement.
///
/// `secure_delete` zeroes a cell where it is deleted, but B-tree rebalancing
/// leaves older copies of live cells in unallocated page space; those copies
/// survive the delete (the residue oracle found an erased record's search
/// word this way). Rewriting the file is the only SQLite operation that
/// removes them. It runs on a plain connection with the store's metered
/// connection closed, because VACUUM's internal statements leave the
/// `sqlite_work` observation incomplete. A busy or partial WAL truncate keeps
/// erased bytes in the WAL, so it is an error, never a silent success.
pub fn rewrite_erased(path: &Path) -> Result<Meters, StoreError> {
    let db = Connection::open(path).map_err(err)?;
    db.execute_batch("PRAGMA secure_delete=ON; VACUUM;")
        .map_err(err)?;
    let (busy, log, done): (i64, i64, i64) = db
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(err)?;
    if busy != 0 || log != done {
        return Err(StoreError(format!(
            "erasure checkpoint incomplete: busy={busy} wal_frames={log} checkpointed={done}"
        )));
    }
    let pages: i64 = db
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .map_err(err)?;
    let mut m = Meters::new();
    m.add_caused(ERASURE_PAGES_REWRITTEN, "erasure", pages as u64);
    Ok(m)
}

fn index_info(db: &Connection, table: &str) -> Result<Vec<IndexInfo>, StoreError> {
    let without_rowid: bool = db
        .query_row(
            "SELECT sql LIKE '%WITHOUT ROWID%' FROM sqlite_master WHERE type='table' AND name=?1",
            [table],
            |r| r.get(0),
        )
        .unwrap_or(false);
    let mut list = db
        .prepare("SELECT name, origin FROM pragma_index_list(?1)")
        .map_err(err)?;
    let names: Vec<(String, String)> = list
        .query_map([table], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    let mut out = Vec::new();
    for (name, origin) in names {
        if without_rowid && origin == "pk" {
            continue;
        }
        let mut cols = db
            .prepare("SELECT cid FROM pragma_index_xinfo(?1) WHERE key=1")
            .map_err(err)?;
        let cids: Vec<i64> = cols
            .query_map([&name], |r| r.get(0))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        out.push(IndexInfo {
            name,
            columns: if cids.iter().any(|c| *c < 0) {
                None
            } else {
                Some(cids.into_iter().map(|c| c as usize).collect())
            },
        });
    }
    Ok(out)
}
