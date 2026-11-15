// Purpose: The SQLite supply of the storage boundary: open or accept a SQLite handle, prove its custody, and
// implement every `Storage` operation by building statements from the DATA declarations in `families.json`.
//
// Non-Negotiable Invariants:
// - This folder is where product storage reaches rusqlite. Statements are built only from validated declared names;
//   values are always bound parameters, never spliced text. The one exception is a partial order's `only`
//   condition: validated DATA (null, an integer, or text with quotes doubled) written as a literal, because SQLite
//   uses a partial index only when the query states the index's own constant condition.
// - A bounded read never materializes an oversized value: `CASE WHEN octet_length(f)<=n THEN f END` plus the length.
// - A pinned source is opened read-only and immutable, hardened (no attached databases, no trusted schema, bounded
//   statement size, columns, compound selects, function arguments and trigger depth) and every operation runs under
//   its own work and deadline allowance.
// - A lent handle stays its owner's: this supply never changes its limits, handlers or pragmas.
// - A scope is atomic even when SQLite ends it: a statement that fails inside a transaction and leaves the handle in
//   autocommit (an interrupted, cancelled or deadline-stopped write rolls the whole transaction back) marks the scope
//   `ended`; every later operation is refused until the scope is closed, so no write of the scope can commit alone.
// - A BEGIN refused while the handle stays in autocommit (another writer holds the reservation: `Busy`) opened
//   nothing; the handle stays usable rather than being marked as having an unknown boundary.
//
// Key Concepts:
// - `Supply<C>`: one SQLite handle (owned `Connection`, or lent `&Connection`) plus its schema and declared access.
// - `Access`: the access the handle must keep; `custody` refuses a moved file or a changed read/write mode.
// - `Bounds`: generic limits for an opened source (value bytes, work steps, wall-clock, cancellation, busy wait),
//   spent per operation or once per handle (`Spend`).
// - `open_selected`: the one opener of a selected current file (replaces the copied open/limit/check blocks).
// - `open_owned`: open or create a file this supply owns, and create its declared families from the DATA rows
//   (a table keyed by the declared key, each named order an index, each partial order a partial index).
//
// Security Considerations:
// - HAS_MOVED catches a file replaced under an open handle; owners still pin and recheck their paths.
// - Errors leave as `storage::Error`; no SQLite error text or value is disclosed through them.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

pub mod bounded;
pub mod database;
pub mod first_copy;
pub mod first_write;
pub mod generations;
pub mod hosted_stand_in;
pub mod record_source;
pub mod record_tables;
pub(crate) mod resource_identity;

use super::{
    Bound, Error, Family, Intent, Order, Range, Read, Result, Row, Schema, Storage, Value, When,
    ARRIVAL,
};
use crate::sqlite_work::{BudgetStop, ObservedConnection, WorkMeter};
use rusqlite::{
    ffi,
    limits::Limit,
    params_from_iter,
    types::{Value as SqlValue, ValueRef},
    ErrorCode, OpenFlags,
};
/// The SQLite handle and transaction words a caller lends to `lend`: product code names them here, through the
/// storage owner.
pub use rusqlite::{
    Connection, DatabaseName, InterruptHandle, OptionalExtension, Transaction, TransactionBehavior,
};
use std::{
    borrow::Borrow,
    cell::Cell,
    fmt::Write as _,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

/// The access a handle was opened for and must keep.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
}

/// How an opened source spends its work and time allowance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Spend {
    /// Every operation starts with the whole allowance (a long-lived reader).
    EachOperation,
    /// The handle has one allowance from open until drop (one command or one maintenance pass).
    WholeHandle,
}

/// Limits of an opened source, applied by the supply.
#[derive(Clone, Debug)]
pub struct Bounds {
    /// The largest single value the source may materialize.
    pub value_bytes: usize,
    /// Work steps the allowance holds before an operation is interrupted.
    pub work: u64,
    /// Wall-clock time the allowance holds before an operation is interrupted (`Duration::MAX`: none).
    pub deadline: Duration,
    pub spend: Spend,
    /// Set by the owner to interrupt the running operation.
    pub cancel: Option<Arc<AtomicBool>>,
    /// How long an operation waits for another writer before `Error::Busy`.
    pub busy: Duration,
}

/// How a selected current file is opened.
pub struct Selected {
    pub access: Access,
    pub bounds: Bounds,
    /// The owner's work meter, attached to the fresh handle before any statement.
    pub meter: Option<WorkMeter>,
    /// Whether functions named by the stored schema (views, triggers) may run with full trust.
    pub trusted_schema: bool,
}

/// SQLite's name for the opened database.
const MAIN: &std::ffi::CStr = c"main";
const PROGRESS_STEPS: i32 = 1_000;
const MAX_STATEMENT_BYTES: i32 = 16 * 1024;
const MAX_COLUMNS: i32 = 64;
const MAX_COMPOUND_SELECT: i32 = 16;
const MAX_FUNCTION_ARGS: i32 = 16;
const MAX_PROGRAM_OPS: i32 = 250_000;

/// The allowance of an opened source.
struct Allowance {
    spend: Spend,
    window: Duration,
    steps: Arc<AtomicU64>,
    deadline: Arc<Mutex<Option<Instant>>>,
    interrupted: Arc<AtomicU8>,
    meter: Option<WorkMeter>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Interruption {
    None,
    Cancelled,
    Work,
    Deadline,
    SharedBudget,
    SharedCancelled,
    SharedDeadline,
    Unavailable,
}
impl Allowance {
    fn install(db: &Connection, bounds: &Bounds, meter: Option<WorkMeter>) -> Self {
        let steps = Arc::new(AtomicU64::new(0));
        let deadline = Arc::new(Mutex::new(None::<Instant>));
        let interrupted = Arc::new(AtomicU8::new(0));
        let cause = interrupted.clone();
        let (counted, until, cancel, work) = (
            steps.clone(),
            deadline.clone(),
            bounds.cancel.clone(),
            bounds.work,
        );
        let meter_for_progress = meter.clone();
        // Any metered handle uses exact SQLite VM quanta so a later invocation
        // can become active without replacing the already installed callback.
        let quantum = if meter.is_some() {
            1_u64
        } else {
            PROGRESS_STEPS as u64
        };
        db.progress_handler(
            quantum as i32,
            Some(move || {
                let reason = if cancel
                    .as_ref()
                    .is_some_and(|flag| flag.load(Ordering::Acquire))
                {
                    1
                } else if counted.fetch_add(quantum, Ordering::Relaxed) + quantum >= work {
                    2
                } else {
                    match until.lock() {
                        Ok(end) if end.is_some_and(|end| Instant::now() >= end) => 3,
                        Ok(_) => 0,
                        Err(_) => 4,
                    }
                };
                if reason != 0 {
                    cause.store(reason, Ordering::Release);
                    return true;
                }
                if let Some(meter) = &meter_for_progress {
                    match meter.budget_progress(quantum) {
                        BudgetStop::None => false,
                        BudgetStop::Deadline => {
                            cause.store(7, Ordering::Release);
                            true
                        }
                        BudgetStop::Cancelled => {
                            cause.store(6, Ordering::Release);
                            true
                        }
                        BudgetStop::Inactive => {
                            cause.store(8, Ordering::Release);
                            true
                        }
                        _ => {
                            cause.store(5, Ordering::Release);
                            true
                        }
                    }
                } else {
                    false
                }
            }),
        );
        let allowance = Self {
            spend: bounds.spend,
            window: bounds.deadline,
            steps,
            deadline,
            interrupted,
            meter,
        };
        if allowance.spend == Spend::WholeHandle {
            if let Ok(mut end) = allowance.deadline.lock() {
                *end = Instant::now().checked_add(allowance.window);
            }
        }
        allowance
    }
    fn arm(&self) -> Result<Option<Armed<'_>>> {
        // Clear only statement provenance, never the whole-handle work debt
        // or its deadline. A later interruption must carry its own cause.
        self.interrupted.store(0, Ordering::Release);
        if let Some(meter) = &self.meter {
            match meter.budget_preflight() {
                BudgetStop::None => {}
                BudgetStop::Deadline => return Err(crate::cause!(Error::Deadline)),
                BudgetStop::Cancelled => return Err(crate::cause!(Error::Interrupted)),
                _ => return Err(crate::cause!(Error::Interrupted)),
            }
        }
        if self.spend == Spend::WholeHandle {
            return Ok(None);
        }
        self.steps.store(0, Ordering::Relaxed);
        // A window past the clock's range means no deadline.
        *self.deadline.lock().map_err(|error| crate::carry_cause!(Error::Unavailable, error))? =
            Instant::now().checked_add(self.window);
        Ok(Some(Armed(self)))
    }
}
#[track_caller]
fn invocation_stop_error(stop: BudgetStop) -> Error {
    match stop {
        BudgetStop::None => crate::cause!(caller: Error::Unavailable),
        BudgetStop::Deadline => crate::cause!(caller: Error::Deadline),
        _ => crate::cause!(caller: Error::Interrupted),
    }
}
/// Disarms an operation's deadline when the operation ends, however it ends.
struct Armed<'a>(&'a Allowance);
impl Drop for Armed<'_> {
    fn drop(&mut self) {
        if let Ok(mut deadline) = self.0.deadline.lock() {
            *deadline = None;
        }
    }
}

/// A selected current file's handle, observed by the owner's work meter or not.
pub enum Handle {
    Plain(Connection),
    Observed(ObservedConnection),
}
impl Borrow<Connection> for Handle {
    fn borrow(&self) -> &Connection {
        match self {
            Self::Plain(db) => { crate::storage::request_work::RequestWork::uncovered(); db },
            Self::Observed(db) => db.connection(),
        }
    }
}

/// One SQLite handle supplying a declared schema.
pub struct Supply<C: Borrow<Connection>> {
    db: C,
    schema: &'static Schema,
    access: Access,
    allowance: Option<Allowance>,
    command_memo: Option<Arc<CommandMemo>>,
    /// Open nested scopes (savepoints), innermost last.
    nested: Cell<u32>,
    /// A failed scope boundary has an unknown outcome; no ancestor may close the still-counted child.
    scope_failed: Cell<bool>,
    /// SQLite ended the open transaction itself: a statement inside it failed in a way that rolls the whole
    /// transaction back (an interrupted, cancelled or deadline-stopped write; a full disk; an I/O error), which the
    /// handle's return to autocommit proves. Until the scope is closed every operation is refused, so no later write
    /// of the scope can commit on its own outside it; closing it then rolls back (nothing is left to undo) or refuses
    /// the commit (nothing of the scope is there to commit). A lent handle whose owner's transaction ended this way
    /// stays refused (the owner's transaction is the owner's to close); the owner lends its connection again.
    ended: Cell<bool>,
    /// Whether the handle was inside a transaction when its current statement began.
    began_scoped: Cell<bool>,
}

/// One command's schema/layout observations on one live observed write
/// transaction. Normal row changes do not invalidate schema facts. Actual DDL,
/// raw schema changes and rollback do, through the existing statement observer.
/// The map is bounded by names from this supply's declared families.
pub(crate) struct CommandMemo {
    source: crate::sqlite_work::SchemaObservation,
    state: Mutex<CommandMemoState>,
}
#[derive(Default)]
struct CommandMemoState {
    epoch: Option<u64>,
    tables: std::collections::HashMap<String, Option<String>>,
    page_size: Option<i64>,
}
impl CommandMemo {
    pub(crate) fn new(source: crate::sqlite_work::SchemaObservation) -> Arc<Self> {
        Arc::new(Self { source, state: Mutex::new(CommandMemoState::default()) })
    }
    fn state(&self, db: &Connection) -> Result<std::sync::MutexGuard<'_, CommandMemoState>> {
        let epoch = self.source.current(db).ok_or(crate::cause!(Error::Moved))?;
        if db.is_autocommit() || unsafe { ffi::sqlite3_txn_state(db.handle(), MAIN.as_ptr()) } != ffi::SQLITE_TXN_WRITE {
            return Err(crate::cause!(Error::Moved));
        }
        let mut state = self.state.lock().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if state.epoch != Some(epoch) || epoch == u64::MAX {
            *state = CommandMemoState { epoch: Some(epoch), ..Default::default() };
        }
        Ok(state)
    }
}

/// The handle's change counter for commits by other connections (`PRAGMA data_version`). Read outside a held
/// transaction; inside one it does not move.
pub fn data_version(db: &Connection) -> Result<i64> {
    db.query_row("PRAGMA data_version", [], |row| row.get(0))
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))
}

/// The path a database file is opened at: its directory made canonical, its name as given. `SQLITE_OPEN_NOFOLLOW` refuses a
/// path that has a symbolic link anywhere in it (macOS temp dirs sit under `/var`, a link to `/private/var`), so the links
/// above the file are resolved here, and the file itself stays visible to NOFOLLOW: a final symlink is still refused. A
/// directory that cannot be resolved is left as given, and the open reports it.
/// Make the folders a store file at `path` sits in (a joining computer's account folder has none of its store folders
/// until its first copy arrives). They are private to the engine's user: mode 0700, as the account folder is.
pub fn make_store_folder(path: &Path) -> Result<()> {
    let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) else {
        return Ok(());
    };
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(parent)
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))
}

pub fn no_follow_path(path: &Path) -> PathBuf {
    let parent = path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(Path::new("."));
    match (std::fs::canonicalize(parent), path.file_name()) {
        (Ok(parent), Some(name)) => parent.join(name),
        _ => path.to_path_buf(),
    }
}

/// The main schema's version (`PRAGMA main.schema_version`): it moves on every DDL.
pub fn schema_version(db: &Connection) -> Result<i64> {
    db.query_row("PRAGMA main.schema_version", [], |row| row.get(0))
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))
}

/// Open an existing file for a point read, without creating a database,
/// initializing schema or changing journal mode. Keep live WAL semantics:
/// SQLite's coordination sidecars are permitted, an immutable stale view is not.
pub fn read_existing_connection(path: &Path) -> Result<Connection> {
    // As with selected placement reads, resolve the parent alias only. The
    // final name must remain visible to NOFOLLOW; a final symlink is refused.
    let file = path.file_name().ok_or(crate::cause!(Error::Invalid))?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let path = std::fs::canonicalize(parent)
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?
        .join(file);
    if !std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_file()) {
        return Err(crate::cause!(Error::Unavailable));
    }
    let db = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|error| failure(error))?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| failure(error))?;
    read_existing_current(&db)?;
    Ok(db)
}

/// The same live-file custody check as a selected storage supply, for an
/// existing read handle borrowed by the journal adapter.
pub fn read_existing_current(db: &Connection) -> Result<()> {
    connection_custody(db, 1)
}

fn connection_custody(db: &Connection, expected: i32) -> Result<()> {
    let mut moved = 1_i32;
    // SAFETY: the handle is borrowed synchronously; the static name and output
    // integer outlive this call, and neither operation retains a pointer.
    let (readonly, status) = unsafe {
        (
            ffi::sqlite3_db_readonly(db.handle(), MAIN.as_ptr()),
            ffi::sqlite3_file_control(
                db.handle(),
                MAIN.as_ptr(),
                ffi::SQLITE_FCNTL_HAS_MOVED,
                (&mut moved as *mut i32).cast(),
            ),
        )
    };
    if status != ffi::SQLITE_OK || moved != 0 || readonly != expected {
        return Err(crate::cause!(Error::Moved));
    }
    Ok(())
}

/// Empty an old object file whose data has moved (an old trillion app's PersonStore or PersonWork): drop every table and
/// view in it but those `keep` names (a name ending in `*` keeps every name it starts), in one write transaction with
/// `secure_delete` (virtual tables first, which take their shadow tables with them, then views, then the rest; a
/// table's indexes and triggers go with it), then rewrite it so its bytes leave and it turns to incremental
/// auto-vacuum. The file itself stays, since the restore index that names it is pinned. A kept table that a dropped
/// view or trigger is not on stays readable as it was. Answers how many tables and views it dropped. The file must be
/// one no other handle has open (the app quit), opened without following a link.
pub fn empty_old_file(path: &Path, keep: &[String]) -> Result<u64> {
    let kept = |name: &str| {
        keep.iter().any(|kept| match kept.strip_suffix('*') {
            Some(prefix) => name.starts_with(prefix),
            None => name == kept,
        })
    };
    let db = Connection::open_with_flags(
        no_follow_path(path),
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|error| failure(error))?;
    db.execute_batch("PRAGMA secure_delete=ON; PRAGMA trusted_schema=OFF;")
        .map_err(|error| failure(error))?;
    let mut statement = db
        .prepare("SELECT type, name, sql FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
        .map_err(|error| failure(error))?;
    let mut objects = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|error| failure(error))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| failure(error))?;
    drop(statement);
    // Virtual tables first, then views, then plain tables.
    let rank = |(kind, _, sql): &(String, String, Option<String>)| match (
        kind.as_str(),
        sql.as_deref()
            .is_some_and(|sql| sql.starts_with("CREATE VIRTUAL")),
    ) {
        (_, true) => 0,
        ("view", _) => 1,
        _ => 2,
    };
    objects.retain(|(_, name, _)| !kept(name));
    objects.sort_by_key(rank);
    db.execute_batch("BEGIN IMMEDIATE").map_err(|error| failure(error))?;
    let mut dropped = 0u64;
    let dropping = (|| -> Result<()> {
        for (kind, name, _) in &objects {
            // A virtual table's shadow tables left with it.
            let present: bool = db
                .query_row(
                    "SELECT 1 FROM sqlite_schema WHERE type=?1 AND name=?2",
                    [kind, name],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|error| failure(error))?
                .is_some();
            if present {
                db.execute_batch(&format!(
                    "DROP {} \"{}\"",
                    kind.to_uppercase(),
                    name.replace('"', "\"\"")
                ))
                .map_err(|error| failure(error))?;
                dropped += 1;
            }
        }
        Ok(())
    })();
    db.execute_batch(if dropping.is_ok() {
        "COMMIT"
    } else {
        "ROLLBACK"
    })
    .map_err(|error| failure(error))?;
    dropping?;
    db.execute_batch("PRAGMA auto_vacuum=INCREMENTAL; VACUUM")
        .map_err(|error| failure(error))?;
    let busy: i64 = db
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
        .map_err(|error| failure(error))?;
    if busy != 0 {
        return Err(crate::cause!(Error::Busy));
    }
    Ok(dropped)
}

/// The write-ahead log beside one SQLite file, cleared beside the file's owner, never under its hold. A log can hold
/// gigabytes of log pages that are not yet in the file (and earlier images of removed rows), and SQLite copies them in
/// one pass it cannot pause: an interrupted copy records nothing, so it cannot be cut into short steps. The copy
/// therefore runs on this keeper's own connection (`copy`), which takes no lock a writer or reader waits on, while
/// the owner keeps replying to requests; only the reset that empties the log (`reset`) takes the file's write lock,
/// at once or not at all, and only after a copy no commit came after, so it writes nothing but the truncation.
pub struct LogKeeper {
    db: Connection,
    /// The log file beside the file (`<file>-wal`).
    log: PathBuf,
    /// The file's change counter (`data_version`) read just before the last copy that left no log page uncopied.
    copied_at: Cell<Option<i64>>,
}

impl LogKeeper {
    /// A keeper of the existing file at `path`, on a read-write connection of its own that never waits for a lock.
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open_with_flags(
            no_follow_path(path),
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|error| failure(error))?;
        db.busy_timeout(Duration::ZERO).map_err(|error| failure(error))?;
        let mut log = path.as_os_str().to_owned();
        log.push("-wal");
        Ok(Self {
            db,
            log: PathBuf::from(log),
            copied_at: Cell::new(None),
        })
    }

    /// Whether the log holds no log page: its file is absent or empty, as a reset leaves it until the next commit.
    pub fn empty(&self) -> bool {
        std::fs::symlink_metadata(&self.log)
            .map(|meta| meta.len())
            .unwrap_or(0)
            == 0
    }

    /// The handle that stops a running `copy` (it then answers `Interrupted`, having copied nothing it records).
    pub fn interrupter(&self) -> InterruptHandle {
        self.db.get_interrupt_handle()
    }

    /// Copy every page of the log that no reader still needs into the file (`PRAGMA wal_checkpoint(PASSIVE)`): it
    /// never takes the write lock and never waits, so writers and readers of the file go on during it. Answers
    /// whether no log page is left uncopied; a reader on an older state, or a commit during the copy, leaves some.
    pub fn copy(&self) -> Result<bool> {
        self.copied_at.set(None);
        let before = data_version(&self.db)?;
        let (busy, log, copied) = self.checkpoint("PASSIVE")?;
        let all = busy == 0 && log == copied;
        if all {
            self.copied_at.set(Some(before));
        }
        Ok(all)
    }

    /// Empty the log (`PRAGMA wal_checkpoint(TRUNCATE)`) when the last `copy` left nothing uncopied and no commit
    /// came after it: with every log page already in the file this writes nothing but the truncation. It takes the file's
    /// write lock without waiting, so its caller holds the file's own writers off (the account's owner) while it
    /// runs. Answers whether the log is now empty; a commit since the copy, a writer or a reader on the log leaves it,
    /// for the next copy.
    pub fn reset(&self) -> Result<bool> {
        let Some(copied_at) = self.copied_at.take() else {
            return Ok(false);
        };
        if data_version(&self.db)? != copied_at {
            return Ok(false);
        }
        let (busy, _, _) = self.checkpoint("TRUNCATE")?;
        Ok(busy == 0)
    }

    /// One checkpoint in `mode`: (busy, pages in the log, pages copied), as SQLite answers it.
    fn checkpoint(&self, mode: &str) -> Result<(i64, i64, i64)> {
        self.db
            .query_row(&format!("PRAGMA wal_checkpoint({mode})"), [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|error| failure(error))
    }
}

/// Let the handle keep up to `kib` KiB of the file's pages (`PRAGMA cache_size`), filled only as pages are read: a
/// handle kept between commands then reads the interior pages of the indexes they descend once.
pub fn keep_pages(db: &Connection, kib: u32) -> Result<()> {
    db.execute_batch(&format!("PRAGMA cache_size=-{kib}"))
        .map_err(|error| failure(error))
}

/// Accept a handle its owner opened and keeps. The owner's limits, handlers and pragmas stay as they are.
pub fn lend<'a>(
    db: &'a Connection,
    schema: &str,
    access: Access,
) -> Result<Supply<&'a Connection>> {
    Ok(Supply {
        db,
        schema: super::schema(schema)?,
        access,
        allowance: None,
        command_memo: None,
        nested: Cell::new(0),
        scope_failed: Cell::new(false),
        ended: Cell::new(false),
        began_scoped: Cell::new(false),
    })
}

/// Open a pinned SQLite file read-only and immutable. The caller has already verified the file's pin and sidecars;
/// no WAL, SHM or journal is created or consumed.
pub fn open_pinned(path: &Path, schema: &str, bounds: Bounds) -> Result<Supply<Connection>> {
    let schema = super::schema(schema)?;
    let value_bytes = i32::try_from(bounds.value_bytes).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    let uri = immutable_uri(path).ok_or(crate::cause!(Error::Invalid))?;
    let db = Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| failure(error))?;
    db.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY;")
        .map_err(|error| failure(error))?;
    for (limit, value) in [
        (Limit::SQLITE_LIMIT_LENGTH, value_bytes),
        (Limit::SQLITE_LIMIT_SQL_LENGTH, MAX_STATEMENT_BYTES),
        (Limit::SQLITE_LIMIT_COLUMN, MAX_COLUMNS),
        (Limit::SQLITE_LIMIT_VDBE_OP, MAX_PROGRAM_OPS),
        (Limit::SQLITE_LIMIT_ATTACHED, 0),
        (Limit::SQLITE_LIMIT_COMPOUND_SELECT, MAX_COMPOUND_SELECT),
        (Limit::SQLITE_LIMIT_FUNCTION_ARG, MAX_FUNCTION_ARGS),
        (Limit::SQLITE_LIMIT_TRIGGER_DEPTH, 0),
    ] {
        db.set_limit(limit, value);
    }
    let allowance = Some(Allowance::install(&db, &bounds, None));
    let supply = Supply {
        db,
        schema,
        access: Access::Read,
        allowance,
        command_memo: None,
        nested: Cell::new(0),
        scope_failed: Cell::new(false),
        ended: Cell::new(false),
        began_scoped: Cell::new(false),
    };
    supply.custody()?;
    Ok(supply)
}

/// Open the selected current SQLite file (a working WAL database, never created here) with the declared access.
/// The owner has already pinned the path (regular file, inode, sidecars); `NOFOLLOW` refuses a swapped symlink.
/// The existing native source owner retains this adapter only after selecting
/// its original source. No descriptor or caller path selects new authority.
pub(crate) fn selected_source(
    path: std::path::PathBuf, schema: &'static str, bounds: Bounds,
    meter: crate::sqlite_work::WorkMeter,
) -> std::sync::Arc<dyn super::SelectedSource> {
    struct Source {
        path: std::path::PathBuf,
        schema: &'static str,
        bounds: Bounds,
        meter: crate::sqlite_work::WorkMeter,
    }
    impl super::SelectedSource for Source {
        fn open(&self, intent: Intent,
            cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
            deadline: std::time::Instant) -> Result<Box<dyn Storage>> {
            if cancel.load(std::sync::atomic::Ordering::Acquire) || std::time::Instant::now() >= deadline {
                return Err(crate::cause!(Error::Unavailable));
            }
            let access = match intent { Intent::Read => Access::Read, Intent::Write => Access::Write,
                Intent::Nested => return Err(crate::cause!(Error::Invalid)) };
            let mut bounds = self.bounds.clone();
            bounds.deadline = deadline.saturating_duration_since(std::time::Instant::now());
            bounds.cancel = Some(cancel);
            let store = open_selected(&self.path, self.schema, Selected { access, bounds,
                meter: Some(self.meter.clone()), trusted_schema: false })?;
            store.custody()?;
            Ok(Box::new(store))
        }
    }
    std::sync::Arc::new(Source { path, schema, bounds, meter })
}

pub fn open_selected(path: &Path, schema: &str, open: Selected) -> Result<Supply<Handle>> {
    let schema = super::schema(schema)?;
    if let Some(meter) = &open.meter {
        let stop = meter.budget_preflight();
        if stop != BudgetStop::None {
            return Err(invocation_stop_error(stop));
        }
    }
    let value_bytes = i32::try_from(open.bounds.value_bytes).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    let access = match open.access {
        Access::Read => OpenFlags::SQLITE_OPEN_READ_ONLY,
        Access::Write => OpenFlags::SQLITE_OPEN_READ_WRITE,
    };
    let db = Connection::open_with_flags(
        no_follow_path(path),
        access | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|error| failure(error))?;
    let meter = open.meter.clone();
    let db = match open.meter {
        None => {
            // This opener owns a freshly vacant trace slot even without an
            // account meter. Numeric request work must include reused handles.
            // Unsupported observation never changes the source's eligibility:
            // the operation continues and its measurement is incomplete.
            match unsafe { ObservedConnection::attach_untraced(db, WorkMeter::new()) } {
                Ok(observed) => Handle::Observed(observed),
                Err(error) => Handle::Plain(error.into_connection()),
            }
        },
        // SAFETY: this handle was opened on the line above; no statement, trace callback or hook exists on it yet,
        // which is the observer's precondition. Custody moves with the observer into the supply.
        Some(meter) => Handle::Observed(
            unsafe { ObservedConnection::attach_untraced(db, meter) }
                .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,
        ),
    };
    let connection: &Connection = db.borrow();
    let allowance = Some(Allowance::install(connection, &open.bounds, meter));
    // A selected resource remains a working WAL database. Closing a bounded
    // operation must not silently run an unbounded last-connection checkpoint.
    // WAL commit/sync and automatic checkpoints retain their existing policy;
    // explicit physical reclamation still checkpoints and truncates below.
    if !connection
        .set_db_config(
            rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
            true,
        )
        .map_err(|error| failure(error))?
    {
        return Err(crate::cause!(Error::Unavailable));
    }
    connection.busy_timeout(open.bounds.busy).map_err(|error| failure(error))?;
    if open.access == Access::Read {
        connection
            .pragma_update(None, "query_only", true)
            .map_err(|error| failure(error))?;
    }
    if !open.trusted_schema {
        connection
            .pragma_update(None, "trusted_schema", false)
            .map_err(|error| failure(error))?;
    }
    connection.set_limit(Limit::SQLITE_LIMIT_LENGTH, value_bytes);
    let supply = Supply {
        db,
        schema,
        access: open.access,
        allowance,
        command_memo: None,
        nested: Cell::new(0),
        scope_failed: Cell::new(false),
        ended: Cell::new(false),
        began_scoped: Cell::new(false),
    };
    supply.custody()?;
    Ok(supply)
}

/// Open (creating when absent) a SQLite file this supply owns for writing; like `open_selected`, a path through a
/// symbolic link is refused (`NOFOLLOW`), so the owner passes the real path, and create every family of `schema`
/// that does not exist yet, from its DATA row only. Durable commits (`synchronous=FULL`, WAL), `secure_delete`
/// (removed cells are overwritten) and incremental auto-vacuum (freed space goes back in `reclaim_step`s) are the
/// owned file's settings; `Storage::reclaim` rewrites the file so bytes that B-tree rebalancing copied into free space
/// leave it too, and turns an older file to incremental auto-vacuum.
pub fn open_owned(path: &Path, schema: &str, bounds: Bounds) -> Result<Supply<Connection>> {
    make_store_folder(path)?;
    let schema = super::schema(schema)?;
    let value_bytes = i32::try_from(bounds.value_bytes).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    let db = Connection::open_with_flags(
        no_follow_path(path),
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|error| failure(error))?;
    prepare_owned(&db, schema, &bounds, value_bytes, None)?;
    let allowance = Some(Allowance::install(&db, &bounds, None));
    let supply = Supply {
        db,
        schema,
        access: Access::Write,
        allowance,
        command_memo: None,
        nested: Cell::new(0),
        scope_failed: Cell::new(false),
        ended: Cell::new(false),
        began_scoped: Cell::new(false),
    };
    supply.custody()?;
    Ok(supply)
}

/// Open an owned working file with the caller's work meter attached before its
/// first pragma or schema statement. This includes one-time schema creation,
/// later record store reads, and writes in the same measured connection lifetime.
pub fn open_owned_observed(
    path: &Path,
    schema: &str,
    bounds: Bounds,
    meter: WorkMeter,
) -> Result<Supply<Handle>> {
    open_owned_observed_paged(path, schema, bounds, meter, None)
}

/// `open_owned_observed`, with the page size a file made here starts with (`page_bytes`: a power of two from 512 to
/// 65,536; None keeps SQLite's own). It is set only on a file with nothing in it yet, before its first page is written;
/// a file that already has pages keeps its size (in WAL mode even a rewrite keeps it).
pub fn open_owned_observed_paged(
    path: &Path,
    schema: &str,
    bounds: Bounds,
    meter: WorkMeter,
    page_bytes: Option<u32>,
) -> Result<Supply<Handle>> {
    make_store_folder(path)?;
    let schema = super::schema(schema)?;
    let stop = meter.budget_preflight();
    if stop != BudgetStop::None {
        return Err(invocation_stop_error(stop));
    }
    let value_bytes = i32::try_from(bounds.value_bytes).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    let connection = Connection::open_with_flags(
        no_follow_path(path),
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|error| failure(error))?;
    // SAFETY: this connection was opened above and has run no statement or
    // trace callback. The observed handle stays exclusively inside Supply.
    let db = Handle::Observed(
        unsafe { ObservedConnection::attach_untraced(connection, meter.clone()) }
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,
    );
    let connection: &Connection = db.borrow();
    let allowance = Some(Allowance::install(connection, &bounds, Some(meter)));
    prepare_owned(connection, schema, &bounds, value_bytes, page_bytes)?;
    let supply = Supply {
        db,
        schema,
        access: Access::Write,
        allowance,
        command_memo: None,
        nested: Cell::new(0),
        scope_failed: Cell::new(false),
        ended: Cell::new(false),
        began_scoped: Cell::new(false),
    };
    supply.custody()?;
    Ok(supply)
}

fn prepare_owned(
    db: &Connection,
    schema: &Schema,
    bounds: &Bounds,
    value_bytes: i32,
    page_bytes: Option<u32>,
) -> Result<()> {
    if page_bytes.is_some_and(|bytes| !(512..=65536).contains(&bytes) || !bytes.is_power_of_two()) {
        return Err(crate::cause!(Error::Invalid));
    }
    db.busy_timeout(bounds.busy).map_err(|error| failure(error))?;
    // A file made here gives removed rows' space back in steps (`reclaim_step`). The mode is set only on a file with
    // nothing in it yet, before its first page is written (switching to WAL writes it); a file that already has
    // tables is left exactly as it is, and turns incremental through its next rewrite (`reclaim`).
    let objects = schema_objects(db)?;
    // A file with nothing in it yet is made without waiting on the disk for each step: the page size, the vacuum mode,
    // the switch to WAL and the families are written with `synchronous=OFF`, and the file is synced once at the end,
    // before this returns (`sync_made_file`). A crash before that sync leaves a file with no record in it, which the
    // next open makes again from the same DATA: every step here is idempotent (`IF NOT EXISTS`, and the modes are set
    // again while the file has no object), and a torn log tail is discarded by WAL's checksums. The one sync keeps the
    // file's first page, which says the file is in WAL mode, on disk before any record commit is acknowledged: SQLite
    // deletes the log of a file with no pages, so without it a later durable commit could be lost with its log.
    let fresh = objects == 0;
    if fresh {
        // The two steps before WAL (the vacuum mode and the switch itself) keep their undo in memory, not in a journal
        // file made and removed for each: a file with nothing in it has nothing to undo after a crash.
        db.execute_batch("PRAGMA synchronous=OFF; PRAGMA journal_mode=MEMORY;")
            .map_err(|error| failure(error))?;
        // The page size goes first: a record larger than a page's local share (about a quarter of a page in a
        // WITHOUT ROWID table) spills its rest to overflow pages of its own, so a page too small for the store's
        // records leaves most of each overflow page empty (src/storage/record_store/settings.json `page_bytes`).
        if let Some(bytes) = page_bytes {
            db.execute_batch(&format!("PRAGMA page_size={bytes};"))
                .map_err(|error| failure(error))?;
        }
        db.execute_batch("PRAGMA auto_vacuum=INCREMENTAL;")
            .map_err(|error| failure(error))?;
    }
    // journal_mode answers with the mode it set; anything but WAL is a refusal, not a silent fallback.
    let mode: String = db
        .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
        .map_err(|error| failure(error))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(crate::cause!(Error::Unavailable));
    }
    if !fresh {
        db.execute_batch("PRAGMA synchronous=FULL;")
            .map_err(|error| failure(error))?;
    }
    db.execute_batch("PRAGMA secure_delete=ON; PRAGMA trusted_schema=OFF;")
        .map_err(|error| failure(error))?;
    db.set_limit(Limit::SQLITE_LIMIT_LENGTH, value_bytes);
    // Every family that does not exist yet is made in one transaction: one durable commit for the whole schema, not one
    // per statement. A file that already has every declared table and index runs no statement and takes no write
    // lock, so opening it never waits on the file's live writer.
    if fresh || declared_missing(db, schema)? {
        // The statements' undo (each CREATE's statement journal) stays in memory for this transaction only.
        db.execute_batch("PRAGMA temp_store=MEMORY;")
            .map_err(|error| failure(error))?;
        let made = db
            .execute_batch(&format!(
                "BEGIN IMMEDIATE;{}COMMIT;",
                declared_tables(schema)?
            ))
            .map_err(|error| {
                let _ = db.execute_batch("ROLLBACK");
                failure(error)
            });
        db.execute_batch("PRAGMA temp_store=DEFAULT;")
            .map_err(|error| failure(error))?;
        made?;
    }
    if fresh {
        sync_made_file(db)?;
        db.execute_batch("PRAGMA synchronous=FULL;")
            .map_err(|error| failure(error))?;
    }
    Ok(())
}

/// The number of objects in the file's schema. A file that holds only zero bytes (a file whose making was cut off by a
/// crash before its first page reached the disk) holds no record and is not a database SQLite can read: it is emptied
/// and counted as a file with nothing in it, so the open makes it again. Any other unreadable file is refused as it is.
fn schema_objects(db: &Connection) -> Result<i64> {
    let count = |db: &Connection| {
        db.query_row("SELECT count(*) FROM sqlite_schema", [], |row| {
            row.get::<_, i64>(0)
        })
    };
    match count(db) {
        Ok(objects) => Ok(objects),
        Err(error) if error.sqlite_error_code() == Some(ErrorCode::NotADatabase) => {
            let path = db
                .path()
                .filter(|path| !path.is_empty())
                .ok_or_else(|| failure(error))?;
            if !only_zero_bytes(Path::new(path)).map_err(|error| crate::carry_cause!(Error::Unavailable, error))? {
                return Err(crate::cause!(Error::Unavailable));
            }
            std::fs::OpenOptions::new()
                .write(true)
                .open(path)
                .and_then(|file| file.set_len(0))
                .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            count(db).map_err(|error| failure(error))
        }
        Err(error) => Err(failure(error)),
    }
}

/// Whether every byte of the file at `path` is zero (read in 64 KiB pieces, stopping at the first other byte).
fn only_zero_bytes(path: &Path) -> std::io::Result<bool> {
    use std::io::Read as _;
    let mut file = crate::io_operation!((std::fs::File::open(path)).map_err(std::io::Error::from))?;
    let mut piece = vec![0_u8; 64 * 1024];
    loop {
        let read = crate::io_operation!((file.read(&mut piece)).map_err(std::io::Error::from))?;
        if read == 0 {
            return Ok(true);
        }
        if piece[..read].iter().any(|byte| *byte != 0) {
            return Ok(false);
        }
    }
}

/// Make a file made by `prepare_owned` durable with one sync of its main file: its first page (WAL mode, page size,
/// vacuum mode) is on the disk before any record commit can be acknowledged. The log and its folder entry are synced
/// by SQLite with the file's first durable commit (`synchronous=FULL`), which carries the families' log pages with it.
fn sync_made_file(db: &Connection) -> Result<()> {
    let path = db
        .path()
        .filter(|path| !path.is_empty())
        .ok_or(crate::cause!(Error::Unavailable))?;
    std::fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))
}

/// Whether a declared table or index of `schema` is missing from the file (read from `sqlite_schema` in one statement).
fn declared_missing(db: &Connection, schema: &Schema) -> Result<bool> {
    let mut statement = db
        .prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','index')")
        .map_err(|error| failure(error))?;
    let present = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| failure(error))?
        .collect::<rusqlite::Result<std::collections::HashSet<String>>>()
        .map_err(|error| failure(error))?;
    // A family made on its first write (`"made": "first_write"`) is missing until then by design.
    Ok(schema
        .families
        .iter()
        .filter(|family| family.made == super::Made::Open)
        .any(|family| {
            !present.contains(&family.family)
                || (family.arrival && !present.contains(&format!("{}__key", family.family)))
                || family
                    .orders
                    .keys()
                    .any(|name| !present.contains(&format!("{}__{name}", family.family)))
        }))
}

/// The statements that create every declared family of a schema that does not exist yet and is made when the store
/// opens (`"made": "open"`); a family whose DATA row says `"made": "first_write"` is left out and made by its first put
/// (`Supply::make_waiting`), so a store that never writes it never holds its table or indexes.
fn declared_tables(schema: &Schema) -> Result<String> {
    let mut sql = String::new();
    for family in schema
        .families
        .iter()
        .filter(|family| family.made == super::Made::Open)
    {
        sql.push_str(&family_tables(family)?);
    }
    Ok(sql)
}

/// The statements that create one family when it does not exist yet: a table keyed by the declared key (`WITHOUT
/// ROWID`, or a rowid table with a unique key index when the family keeps arrival order) and one index per named order,
/// partial when the order declares `only` conditions.
fn family_tables(family: &Family) -> Result<String> {
    let mut sql = String::new();
    {
        let table = quoted(&family.family);
        let fields: Vec<String> = family.fields.iter().map(|field| quoted(field)).collect();
        let key: Vec<String> = family.key.iter().map(|field| quoted(field)).collect();
        if family.arrival {
            let _ = write!(
                sql,
                "CREATE TABLE IF NOT EXISTS {table}({});CREATE UNIQUE INDEX IF NOT EXISTS {} ON {table}({});",
                fields.join(","),
                quoted(&format!("{}__key", family.family)),
                key.join(",")
            );
        } else {
            let _ = write!(
                sql,
                "CREATE TABLE IF NOT EXISTS {table}({},PRIMARY KEY({})) WITHOUT ROWID;",
                fields.join(","),
                key.join(",")
            );
        }
        for (name, order) in &family.orders {
            let columns: Vec<String> = order.fields.iter().map(|field| quoted(field)).collect();
            let only = order
                .only
                .iter()
                .map(|condition| only_condition(condition, None))
                .collect::<Result<Vec<_>>>()?;
            let _ = write!(
                sql,
                "CREATE INDEX IF NOT EXISTS {} ON {table}({}){};",
                quoted(&format!("{}__{name}", family.family)),
                columns.join(","),
                if only.is_empty() {
                    String::new()
                } else {
                    format!(" WHERE {}", only.join(" AND "))
                }
            );
        }
    }
    Ok(sql)
}

/// The SQLite URI that opens `path` read-only and immutable. None when the path is not UTF-8.
pub(crate) fn immutable_uri(path: &Path) -> Option<String> {
    let mut uri = String::from("file:");
    for byte in path.to_str()?.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~".contains(&byte) {
            uri.push(byte as char);
        } else {
            let _ = write!(uri, "%{byte:02X}");
        }
    }
    uri.push_str("?mode=ro&immutable=1");
    Some(uri)
}

#[track_caller]
fn failure(error: rusqlite::Error) -> Error {
    match error.sqlite_error_code() {
        // Another connection holds the lock: the operation did not start, so the class `Busy` travels with the cause.
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => match crate::cause!(caller: Error::Busy) {
            Error::Busy(cause) => Error::Busy(cause.with_retry(crate::refusal_cause::Retry::Busy)),
            other => other,
        },
        Some(ErrorCode::OperationInterrupted) => crate::cause!(caller: Error::Interrupted),
        Some(ErrorCode::TooBig) => crate::cause!(caller: Error::TooBig),
        Some(ErrorCode::ConstraintViolation) => crate::cause!(caller: Error::Conflict),
        Some(ErrorCode::ReadOnly) => crate::cause!(caller: Error::ReadOnly),
        Some(ErrorCode::DiskFull) => crate::cause!(caller: Error::DiskFull),
        // Every other SQLite code (CANTOPEN, IOERR, CORRUPT, ...) keeps the SQLite error, its code included, in the cause.
        _ => crate::carry_cause!(Error::Unavailable, error),
    }
}
fn bind(value: &Value) -> Result<SqlValue> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Integer(v) => SqlValue::Integer(*v),
        Value::Real(v) => SqlValue::Real(*v),
        Value::Text(v) => SqlValue::Text(v.clone()),
        Value::Blob(v) => SqlValue::Blob(v.clone()),
        Value::Oversized(_) => return Err(crate::cause!(Error::Invalid)),
    })
}
fn value(cell: ValueRef<'_>, meter: Option<&WorkMeter>) -> Result<Value> {
    let bytes = match cell {
        ValueRef::Text(value) | ValueRef::Blob(value) => value.len(),
        _ => 8,
    };
    if meter.is_some_and(|meter| meter.budget_charge_bytes(bytes) != BudgetStop::None) {
        return Err(crate::cause!(Error::Interrupted));
    }
    Ok(match cell {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(v) => Value::Integer(v),
        ValueRef::Real(v) => Value::Real(v),
        ValueRef::Text(v) => {
            Value::Text(String::from_utf8(v.to_vec()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?)
        }
        ValueRef::Blob(v) => Value::Blob(v.to_vec()),
    })
}
fn quoted(name: &str) -> String {
    format!("\"{name}\"")
}
/// A table or column name of an old table, safe to quote: lowercase letters, digits and `_`, not led by a digit, at
/// most 128 bytes (the old trillion app's typed tables are `rt_` and a 64-digit hash, above a declared family's 64), and
/// never one of SQLite's own tables.
fn plain_table_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z' | b'_'))
        && bytes.all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_'))
        && name.len() <= 128
        && !name.starts_with("sqlite_")
}

/// The result-column text of the requested reads; a bounded read takes two columns (value, stored length).
fn columns(family: &Family, read: &[Read<'_>]) -> Result<String> {
    if read.is_empty() {
        return Err(crate::cause!(Error::Invalid));
    }
    let mut text = String::new();
    for (at, one) in read.iter().enumerate() {
        if at > 0 {
            text.push(',');
        }
        let field = if one.field == ARRIVAL {
            if !family.arrival {
                return Err(crate::cause!(Error::Undeclared));
            }
            format!("{}.rowid", quoted(&family.family))
        } else if family.has(one.field) {
            format!("{}.{}", quoted(&family.family), quoted(one.field))
        } else {
            return Err(crate::cause!(Error::Undeclared));
        };
        match one.at_most {
            None => text.push_str(&field),
            Some(bytes) => {
                let _ = write!(text, "CASE WHEN octet_length({field})<={bytes} THEN {field} END,octet_length({field})");
            }
        }
    }
    Ok(text)
}
fn decode(
    row: &rusqlite::Row<'_>,
    read: &[Read<'_>],
    meter: Option<&WorkMeter>,
) -> rusqlite::Result<Result<Row>> {
    let mut values = Vec::with_capacity(read.len());
    let mut column = 0;
    for one in read {
        let cell = value(row.get_ref(column)?, meter);
        column += 1;
        let cell = match (one.at_most, cell) {
            (Some(_), Ok(Value::Null)) => match row.get_ref(column)? {
                ValueRef::Integer(bytes) => {
                    if meter.is_some_and(|meter| meter.budget_charge_bytes(8) != BudgetStop::None) {
                        Err(crate::cause!(Error::Interrupted))
                    } else {
                        Ok(Value::Oversized(bytes.max(0) as u64))
                    }
                }
                _ => Ok(Value::Null),
            },
            (_, cell) => cell,
        };
        if one.at_most.is_some() {
            column += 1;
        }
        match cell {
            Ok(cell) => values.push(cell),
            Err(error) => return Ok(Err(error)),
        }
    }
    Ok(Ok(Row(values)))
}

/// The quoted cursor fields of an order, and the row conditions of a partial order as SQL text.
struct Cursor {
    fields: Vec<String>,
    only: Vec<String>,
}
/// A partial order's condition as SQL text, its DATA value written as a literal (see the header).
fn only_condition(condition: &super::Only, table: Option<&str>) -> Result<String> {
    let literal = match &condition.equals {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::String(text) => format!("'{}'", text.replace('\'', "''")),
        other => other.as_i64().ok_or(crate::cause!(Error::Undeclared))?.to_string(),
    };
    let field = match table {
        Some(table) => format!("{}.{}", quoted(table), quoted(&condition.field)),
        None => quoted(&condition.field),
    };
    Ok(format!(
        "{field} IS {}{literal}",
        if condition.not { "NOT " } else { "" }
    ))
}
fn cursor(family: &Family, order: Order<'_>) -> Result<Cursor> {
    let field = |name: &str| format!("{}.{}", quoted(&family.family), quoted(name));
    match order {
        Order::Key => Ok(Cursor {
            fields: family.key.iter().map(|name| field(name)).collect(),
            only: Vec::new(),
        }),
        Order::Named(name) => {
            let order = family.order(name)?;
            let only = order
                .only
                .iter()
                .map(|condition| only_condition(condition, Some(&family.family)))
                .collect::<Result<Vec<_>>>()?;
            Ok(Cursor {
                fields: order.fields.iter().map(|name| field(name)).collect(),
                only,
            })
        }
        Order::Arrival if family.arrival => Ok(Cursor {
            fields: vec![field("rowid")],
            only: Vec::new(),
        }),
        Order::Arrival => Err(crate::cause!(Error::Undeclared)),
    }
}
/// The WHERE text and parameters of a range (without ORDER BY or LIMIT).
fn range_condition(
    family: &Family,
    range: &Range<'_>,
    params: &mut Vec<SqlValue>,
) -> Result<(String, Vec<String>)> {
    let Cursor { fields, only } = cursor(family, range.order)?;
    let (lower, upper) = if range.reverse {
        (&range.to, &range.from)
    } else {
        (&range.from, &range.to)
    };
    let mut parts = Vec::new();
    for (bound, below) in [(lower, false), (upper, true)] {
        let (values, inclusive) = match bound {
            Bound::Unbounded => continue,
            Bound::Included(values) => (values, true),
            Bound::Excluded(values) => (values, false),
        };
        if values.is_empty() || values.len() > fields.len() {
            return Err(crate::cause!(Error::Invalid));
        }
        let operator = match (below, inclusive) {
            (false, true) => ">=",
            (false, false) => ">",
            (true, true) => "<=",
            (true, false) => "<",
        };
        let mut holes = Vec::with_capacity(values.len());
        for one in values {
            params.push(bind(one)?);
            holes.push(format!("?{}", params.len()));
        }
        parts.push(format!(
            "({}){operator}({})",
            fields[..values.len()].join(","),
            holes.join(",")
        ));
    }
    parts.extend(only);
    let condition = if parts.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", parts.join(" AND "))
    };
    Ok((condition, fields))
}

fn get_statement(
    family: &Family,
    key: &[Value],
    read: &[Read<'_>],
) -> Result<(String, Vec<SqlValue>)> {
    if key.len() != family.key.len() {
        return Err(crate::cause!(Error::Invalid));
    }
    let mut params = Vec::with_capacity(key.len());
    let mut condition = String::new();
    for (at, (field, one)) in family.key.iter().zip(key).enumerate() {
        params.push(bind(one)?);
        let _ = write!(
            condition,
            "{}{}.{}=?{}",
            if at > 0 { " AND " } else { "" },
            quoted(&family.family),
            quoted(field),
            at + 1
        );
    }
    Ok((
        format!(
            "SELECT {} FROM {} WHERE {condition} LIMIT 1",
            columns(family, read)?,
            quoted(&family.family)
        ),
        params,
    ))
}
fn scan_statement(
    family: &Family,
    range: &Range<'_>,
    read: &[Read<'_>],
) -> Result<(String, Vec<SqlValue>)> {
    let mut params = Vec::new();
    let (condition, fields) = range_condition(family, range, &mut params)?;
    let direction = if range.reverse { " DESC" } else { "" };
    let order: Vec<String> = fields
        .iter()
        .map(|field| format!("{field}{direction}"))
        .collect();
    let mut sql = format!(
        "SELECT {} FROM {}{condition} ORDER BY {}",
        columns(family, read)?,
        quoted(&family.family),
        order.join(",")
    );
    if let Some(limit) = range.limit {
        params.push(SqlValue::Integer(
            i64::try_from(limit).map_err(|error| crate::carry_cause!(Error::Invalid, error))?,
        ));
        let _ = write!(sql, " LIMIT ?{}", params.len());
    }
    Ok((sql, params))
}

impl<C: Borrow<Connection>> Supply<C> {
    pub(crate) fn with_command_memo(mut self, memo: Arc<CommandMemo>) -> Result<Self> {
        drop(memo.state(self.db())?);
        self.command_memo = Some(memo);
        Ok(self)
    }
    fn db(&self) -> &Connection {
        self.db.borrow()
    }
    /// This handle lent for reading (`lend` on its own connection): a record store over it reads inside whatever read
    /// transaction the handle holds, under the handle's own limits and observer.
    pub fn lent_read(&self) -> Supply<&Connection> {
        Supply {
            db: self.db(),
            schema: self.schema,
            access: Access::Read,
            allowance: None,
            command_memo: None,
            nested: Cell::new(0),
            scope_failed: Cell::new(false),
            ended: Cell::new(false),
            began_scoped: Cell::new(false),
        }
    }
    /// The table names an old table of this file lists in its `column`, each with `prefix` put before it (the old
    /// trillion app's catalogues of its own tables, such as `_record_tables_kinds.table_name`). A table the file does not
    /// have lists none. The names are the file's, not trusted: `drop_old_tables` checks each one again.
    pub fn old_table_names(&self, table: &str, column: &str, prefix: &str) -> Result<Vec<String>> {
        if !plain_table_name(table) || !plain_table_name(column) {
            return Err(crate::cause!(Error::Invalid));
        }
        if !self.has_table(table)? {
            return Ok(Vec::new());
        }
        let _armed = self.armed()?;
        let sql = format!(
            "SELECT CAST({} AS TEXT) FROM {}",
            quoted(column),
            quoted(table)
        );
        let mut statement = self
            .db()
            .prepare(&sql)
            .map_err(|error| self.failed(error))?;
        let names = statement
            .query_map([], |row| row.get::<_, Option<String>>(0))
            .map_err(|error| self.failed(error))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| self.failed(error))?;
        Ok(names
            .into_iter()
            .flatten()
            .map(|name| format!("{prefix}{name}"))
            .collect())
    }
    /// Drop every table (or view) of `names` this file has, in one write transaction, and answer how many it dropped
    /// (a name the file does not have is not counted). The handle is the file's writer (`Access::Write`) outside any scope.
    /// Before anything is dropped, the whole call is refused for a name that is not plain (letters, digits and `_`,
    /// not a SQLite table), for a family this supply's schema declares (a store's own table is never old), and for a
    /// view or trigger of another table whose statement names a dropped table (it would stop working). A dropped
    /// table's own indexes and triggers go with it. With `secure_delete` (an owned file) each freed page is
    /// overwritten as the transaction commits; `Storage::reclaim` then gives the space back to the volume.
    pub fn drop_old_tables(&self, names: &[String]) -> Result<u64> {
        if self.access != Access::Write {
            return Err(crate::cause!(Error::ReadOnly));
        }
        if self.scoped() {
            return Err(crate::cause!(Error::Invalid));
        }
        if names
            .iter()
            .any(|name| !plain_table_name(name) || self.schema.family(name).is_ok())
        {
            return Err(crate::cause!(Error::Invalid));
        }
        self.open_scope(Intent::Write)?;
        let dropped = self.drop_in_scope(names);
        self.close_scope(dropped.is_ok())?;
        dropped
    }
    fn drop_in_scope(&self, names: &[String]) -> Result<u64> {
        let mut present = std::collections::BTreeMap::new();
        for name in names {
            if let Some(kind) = self.table_kind(name)? {
                present.insert(name.as_str(), kind);
            }
        }
        let _armed = self.armed()?;
        let mut statement = self
            .db()
            .prepare("SELECT tbl_name, sql FROM sqlite_schema WHERE type IN ('view','trigger') AND sql IS NOT NULL")
            .map_err(|error| self.failed(error))?;
        let dependents = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| self.failed(error))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| self.failed(error))?;
        let names_dropped = |sql: &str| {
            sql.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .any(|word| present.contains_key(word))
        };
        if dependents
            .iter()
            .any(|(table, sql)| !present.contains_key(table.as_str()) && names_dropped(sql))
        {
            return Err(crate::cause!(Error::Conflict));
        }
        // Views first: a view over old tables goes with them, and never outlives what it reads.
        for (name, kind) in present
            .iter()
            .filter(|(_, kind)| kind.as_str() == "view")
            .chain(present.iter().filter(|(_, kind)| kind.as_str() == "table"))
        {
            self.db()
                .execute_batch(&format!("DROP {} {}", kind.to_uppercase(), quoted(name)))
                .map_err(|error| self.failed(error))?;
        }
        Ok(present.len() as u64)
    }
    fn has_table(&self, name: &str) -> Result<bool> {
        Ok(self.table_kind(name)?.as_deref() == Some("table"))
    }
    /// `table` or `view` for a name the file has, None for one it does not.
    fn table_kind(&self, name: &str) -> Result<Option<String>> {
        let _armed = self.armed()?;
        // Only declared names enter the bounded memo. Historical retirement
        // of arbitrary old names keeps its existing uncached catalogue read.
        let memo = self.command_memo.as_ref().filter(|_| self.schema.family(name).is_ok());
        if let Some(memo) = memo {
            if let Some(kind) = memo.state(self.db())?.tables.get(name) { return Ok(kind.clone()); }
        }
        let kind = self.db()
            .query_row(
                "SELECT type FROM sqlite_schema WHERE type IN ('table','view') AND name=?1",
                [name],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| self.failed(error))?;
        if let Some(memo) = memo { memo.state(self.db())?.tables.insert(name.to_owned(), kind.clone()); }
        Ok(kind)
    }
    /// The cause observed for the most recently armed storage operation.
    /// Reading it neither changes the allowance nor proves scope clearance.
    pub(crate) fn interruption(&self) -> Interruption {
        let Some(allowance) = self.allowance.as_ref() else {
            return Interruption::None;
        };
        match allowance.interrupted.load(Ordering::Acquire) {
            0 => match allowance
                .meter
                .as_ref()
                .map(WorkMeter::budget_stop)
                .unwrap_or(BudgetStop::None)
            {
                BudgetStop::None => Interruption::None,
                BudgetStop::Deadline => Interruption::SharedDeadline,
                BudgetStop::Cancelled => Interruption::SharedCancelled,
                BudgetStop::Inactive => Interruption::Unavailable,
                _ => Interruption::SharedBudget,
            },
            1 => Interruption::Cancelled,
            2 => Interruption::Work,
            3 => Interruption::Deadline,
            5 => Interruption::SharedBudget,
            6 => Interruption::SharedCancelled,
            7 => Interruption::SharedDeadline,
            _ => Interruption::Unavailable,
        }
    }
    #[track_caller]
    fn failed(&self, error: rusqlite::Error) -> Error {
        if self.began_scoped.get() && self.db().is_autocommit() {
            self.ended.set(true);
        }
        let error = failure(error);
        match (error, self.interruption()) {
            (Error::Interrupted(cause), Interruption::Deadline | Interruption::SharedDeadline) => {
                Error::Deadline(cause)
            }
            (Error::Interrupted(cause), Interruption::SharedBudget | Interruption::SharedCancelled) => {
                Error::Interrupted(cause)
            }
            (error, _) => error,
        }
    }
    fn family(&self, name: &str) -> Result<&'static Family> {
        self.schema.family(name)
    }
    /// Whether a family made on its first write (`"made": "first_write"`) has no table yet: one schema lookup, no row
    /// read. A family made on open never asks. A table made by a put and taken back by a rollback is waiting again, so
    /// "no such table" for a declared family never reaches the caller.
    fn waiting(&self, family: &Family) -> Result<bool> {
        Ok(family.made == super::Made::FirstWrite && !self.has_table(&family.family)?)
    }
    /// One put into a family whose table exists.
    fn put_declared(&self, family: &Family, row: &[(&str, Value)], when: When<'_>) -> Result<u64> {
        if row.iter().any(|(field, _)| !family.has(field)) {
            return Err(crate::cause!(Error::Undeclared));
        }
        if !family
            .key
            .iter()
            .all(|key| row.iter().any(|(field, _)| field == key))
        {
            return Err(crate::cause!(Error::Invalid));
        }
        let table = quoted(&family.family);
        let is_key = |field: &str| family.key.iter().any(|key| key == field);
        let mut params = Vec::with_capacity(row.len());
        if let When::Matches(conditions) = when {
            let mut set = Vec::new();
            for (field, one) in row.iter().filter(|(field, _)| !is_key(field)) {
                params.push(bind(one)?);
                set.push(format!("{}=?{}", quoted(field), params.len()));
            }
            if set.is_empty() {
                return Err(crate::cause!(Error::Invalid));
            }
            let mut matched = Vec::new();
            for (field, one) in row.iter().filter(|(field, _)| is_key(field)) {
                params.push(bind(one)?);
                matched.push(format!(
                    "{}.{}=?{}",
                    quoted(&family.family),
                    quoted(field),
                    params.len()
                ));
            }
            for (field, one) in conditions {
                if !family.has(field) {
                    return Err(crate::cause!(Error::Undeclared));
                }
                if one.is_null() {
                    matched.push(format!(
                        "{}.{} IS NULL",
                        quoted(&family.family),
                        quoted(field)
                    ));
                } else {
                    params.push(bind(one)?);
                    matched.push(format!(
                        "{}.{}=?{}",
                        quoted(&family.family),
                        quoted(field),
                        params.len()
                    ));
                }
            }
            let sql = format!(
                "UPDATE {table} SET {} WHERE {}",
                set.join(","),
                matched.join(" AND ")
            );
            return self.run(&sql, &params);
        }
        let mut names = Vec::with_capacity(row.len());
        let mut holes = Vec::with_capacity(row.len());
        for (field, one) in row {
            params.push(bind(one)?);
            names.push(quoted(field));
            holes.push(format!("?{}", params.len()));
        }
        let insert = format!(
            "INTO {table}({}) VALUES({})",
            names.join(","),
            holes.join(",")
        );
        let sql = match when {
            When::New => format!("INSERT {insert}"),
            When::Absent => format!("INSERT OR IGNORE {insert}"),
            When::Always => {
                let keys: Vec<String> = family.key.iter().map(|key| quoted(key)).collect();
                let set: Vec<String> = row
                    .iter()
                    .filter(|(field, _)| !is_key(field))
                    .map(|(field, _)| format!("{0}=excluded.{0}", quoted(field)))
                    .collect();
                if set.is_empty() {
                    format!("INSERT {insert} ON CONFLICT({}) DO NOTHING", keys.join(","))
                } else {
                    format!(
                        "INSERT {insert} ON CONFLICT({}) DO UPDATE SET {}",
                        keys.join(","),
                        set.join(",")
                    )
                }
            }
            When::Matches(_) => unreachable!("handled above"),
        };
        self.run(&sql, &params)
    }

    /// Make a waiting family's table and order indexes, in the caller's transaction.
    fn make_waiting(&self, family: &Family) -> Result<()> {
        if self.access != Access::Write {
            return Err(crate::cause!(Error::ReadOnly));
        }
        let sql = family_tables(family)?;
        let _armed = self.armed()?;
        self.db()
            .execute_batch(&sql)
            .map_err(|error| self.failed(error))
    }
    /// Prepare only named families declared by this supply, inside the caller's already-held write transaction.
    /// This is schema preparation before a command captures its unchanged-schema witness, not permission for
    /// arbitrary DDL: every name resolves through the existing registry and uses its existing table builder.
    /// A read, an unscoped handle or a deferred transaction without its write reservation makes nothing. Registry
    /// validation precedes every DDL, and the caller's rollback takes back every table and index prepared here.
    pub fn prepare_declared_families(&self, names: &[&str]) -> Result<()> {
        if self.access != Access::Write {
            return Err(crate::cause!(Error::ReadOnly));
        }
        self.custody()?;
        if !self.scoped() || !self.writing()? {
            return Err(crate::cause!(Error::Unavailable));
        }
        let families = names
            .iter()
            .map(|name| self.family(name))
            .collect::<Result<Vec<_>>>()?;
        for family in families {
            if self.waiting(family)? {
                self.make_waiting(family)?;
            }
        }
        Ok(())
    }

    /// A put into a waiting family: its table made first, in the same transaction as the write (a savepoint of its own
    /// when no scope is open, so a refused put leaves no table behind).
    fn put_making(&self, family: &Family, put: impl FnOnce() -> Result<u64>) -> Result<u64> {
        if !self.waiting(family)? {
            return put();
        }
        let own = !self.scoped();
        if own {
            self.run("SAVEPOINT made_on_first_write", &[])?;
        }
        let done = self.make_waiting(family).and_then(|()| put());
        if own {
            let end = if done.is_ok() {
                "RELEASE made_on_first_write"
            } else {
                "ROLLBACK TO made_on_first_write; RELEASE made_on_first_write"
            };
            let _armed = self.armed();
            self.db()
                .execute_batch(end)
                .map_err(|error| self.failed(error))?;
        }
        done
    }
    fn armed(&self) -> Result<Option<Armed<'_>>> {
        if self.scope_failed.get() || self.ended.get() {
            return Err(crate::cause!(Error::Unavailable));
        }
        self.began_scoped.set(self.scoped());
        Ok(self
            .allowance
            .as_ref()
            .map(Allowance::arm)
            .transpose()?
            .flatten())
    }
    fn rows(&self, sql: &str, params: &[SqlValue], read: &[Read<'_>]) -> Result<Vec<Row>> {
        let _armed = self.armed()?;
        let mut statement = self
            .db()
            .prepare_cached(sql)
            .map_err(|error| self.failed(error))?;
        let mut rows = statement
            .query(params_from_iter(params.iter()))
            .map_err(|error| self.failed(error))?;
        let mut found = Vec::new();
        let meter = self
            .allowance
            .as_ref()
            .and_then(|allowance| allowance.meter.as_ref());
        while let Some(row) = rows.next().map_err(|error| self.failed(error))? {
            found.push(decode(row, read, meter).map_err(|error| failure(error))??);
        }
        Ok(found)
    }
    fn run(&self, sql: &str, params: &[SqlValue]) -> Result<u64> {
        let _armed = self.armed()?;
        let mut statement = self
            .db()
            .prepare_cached(sql)
            .map_err(|error| self.failed(error))?;
        statement
            .execute(params_from_iter(params.iter()))
            .map(|n| n as u64)
            .map_err(|error| self.failed(error))
    }
}

struct CommandCheckpoint {
    handle: usize,
    name: String,
}

impl<C: Borrow<Connection>> Storage for Supply<C> {
    fn prepare_declared_families(&self, names: &[&str]) -> Result<()> {
        Supply::prepare_declared_families(self, names)
    }
    fn checkpoint(&self) -> Result<super::Checkpoint> {
        self.custody()?;
        if !self.scoped() || !self.writing()? { return Err(crate::cause!(Error::Unavailable)); }
        let name = format!("storage_command_{}", super::checkpoint_number()?);
        let _armed = self.armed()?;
        self.db().execute_batch(&format!("SAVEPOINT {name}")).map_err(|error| self.failed(error))?;
        Ok(super::Checkpoint::new(CommandCheckpoint { handle: unsafe { self.db().handle() } as usize, name }))
    }
    fn close_checkpoint(&self, checkpoint: super::Checkpoint, commit: bool) -> Result<()> {
        let checkpoint = checkpoint.take::<CommandCheckpoint>()?;
        self.custody()?;
        if checkpoint.handle != unsafe { self.db().handle() } as usize || !self.scoped() || !self.writing()? {
            return Err(crate::cause!(Error::Unavailable));
        }
        let _armed = self.armed()?;
        let sql = if commit { format!("RELEASE SAVEPOINT {}", checkpoint.name) }
            else { format!("ROLLBACK TO SAVEPOINT {}; RELEASE SAVEPOINT {}", checkpoint.name, checkpoint.name) };
        self.db().execute_batch(&sql).map_err(|error| {
            self.scope_failed.set(true);
            self.failed(error)
        })
    }

    fn schema(&self) -> &'static Schema {
        self.schema
    }

    fn get(&self, family: &str, key: &[Value], read: &[Read<'_>]) -> Result<Option<Row>> {
        let family = self.family(family)?;
        let (sql, params) = get_statement(family, key, read)?;
        if self.waiting(family)? {
            return Ok(None);
        }
        Ok(self.rows(&sql, &params, read)?.pop())
    }

    fn scan(&self, family: &str, range: &Range<'_>, read: &[Read<'_>]) -> Result<Vec<Row>> {
        let family = self.family(family)?;
        let (sql, params) = scan_statement(family, range, read)?;
        if self.waiting(family)? {
            return Ok(Vec::new());
        }
        self.rows(&sql, &params, read)
    }

    fn put(&self, family: &str, row: &[(&str, Value)], when: When<'_>) -> Result<u64> {
        let family = self.family(family)?;
        if matches!(when, When::Matches(_)) && self.waiting(family)? {
            // A compare-and-set of a family with no table yet matches no row: it changes nothing and makes nothing.
            if row.iter().any(|(field, _)| !family.has(field)) {
                return Err(crate::cause!(Error::Undeclared));
            }
            return Ok(0);
        }
        self.put_making(family, || self.put_declared(family, row, when))
    }

    fn count(&self, family: &str, range: &Range<'_>) -> Result<u64> {
        let family = self.family(family)?;
        let mut params = Vec::new();
        let (condition, _) = range_condition(family, range, &mut params)?;
        if self.waiting(family)? {
            return Ok(0);
        }
        let mut source = format!("SELECT 1 FROM {}{condition}", quoted(&family.family));
        if let Some(limit) = range.limit {
            params.push(SqlValue::Integer(
                i64::try_from(limit).map_err(|error| crate::carry_cause!(Error::Invalid, error))?,
            ));
            let _ = write!(source, " LIMIT ?{}", params.len());
        }
        let _armed = self.armed()?;
        self.db()
            .prepare_cached(&format!("SELECT count(*) FROM ({source})"))
            .and_then(|mut statement| {
                statement.query_row(params_from_iter(params.iter()), |row| row.get::<_, i64>(0))
            })
            .map_err(|error| self.failed(error))
            .and_then(|count| u64::try_from(count).map_err(|error| crate::carry_cause!(Error::Unavailable, error)))
    }

    fn erase(&self, family: &str, range: &Range<'_>) -> Result<u64> {
        let family = self.family(family)?;
        if range.limit.is_some() {
            return Err(crate::cause!(Error::Invalid));
        }
        let mut params = Vec::new();
        let (condition, _) = range_condition(family, range, &mut params)?;
        if self.waiting(family)? {
            return Ok(0);
        }
        self.run(
            &format!("DELETE FROM {}{condition}", quoted(&family.family)),
            &params,
        )
    }

    fn present(&self, family: &str) -> Result<bool> {
        let family = self.family(family)?;
        let _armed = self.armed()?;
        let kind: Option<String> = self
            .db()
            .prepare_cached("SELECT type FROM sqlite_schema WHERE name=?1")
            .and_then(|mut statement| {
                let mut rows = statement.query([&family.family])?;
                rows.next()?.map(|row| row.get(0)).transpose()
            })
            .map_err(|error| self.failed(error))?;
        match kind.as_deref() {
            None => Ok(false),
            Some("table") => Ok(true),
            _ => Err(crate::cause!(Error::Unavailable)),
        }
    }

    fn custody(&self) -> Result<()> {
        if self.scope_failed.get() {
            return Err(crate::cause!(Error::Unavailable));
        }
        let expected = match self.access {
            Access::Read => 1,
            Access::Write => 0,
        };
        connection_custody(self.db(), expected)
    }

    fn location(&self) -> Option<&str> {
        self.db().path()
    }

    fn scoped(&self) -> bool {
        !self.db().is_autocommit()
    }

    fn writing(&self) -> Result<bool> {
        // SAFETY: as in `custody`; the handle is borrowed for the call and the name is static.
        let state = unsafe { ffi::sqlite3_txn_state(self.db().handle(), MAIN.as_ptr()) };
        if state < 0 {
            return Err(crate::cause!(Error::Unavailable));
        }
        Ok(state == ffi::SQLITE_TXN_WRITE)
    }

    fn changes(&self) -> u64 {
        self.db().total_changes()
    }

    fn mark(&self) -> Result<i64> {
        let _armed = self.armed()?;
        self.db()
            .query_row("PRAGMA main.data_version", [], |row| row.get(0))
            .map_err(|error| self.failed(error))
    }

    fn schema_mark(&self) -> Result<i64> {
        let _armed = self.armed()?;
        self.db()
            .query_row("PRAGMA main.schema_version", [], |row| row.get(0))
            .map_err(|error| self.failed(error))
    }

    fn allocated_bytes(&self) -> Result<u64> {
        let _armed = self.armed()?;
        let pages: i64 = self
            .db()
            .query_row("PRAGMA main.page_count", [], |row| row.get(0))
            .map_err(|error| self.failed(error))?;
        let cached = self.command_memo.as_ref().map(|memo| memo.state(self.db()).map(|state| state.page_size)).transpose()?.flatten();
        let size: i64 = match cached {
            Some(size) => size,
            None => {
                let size = self.db().query_row("PRAGMA main.page_size", [], |row| row.get(0))
                    .map_err(|error| self.failed(error))?;
                if let Some(memo) = &self.command_memo { memo.state(self.db())?.page_size = Some(size); }
                size
            }
        };
        u64::try_from(pages)
            .ok()
            .zip(u64::try_from(size).ok())
            .and_then(|(p, s)| p.checked_mul(s))
            .ok_or(crate::cause!(Error::Unavailable))
    }

    fn reclaim(&self) -> Result<()> {
        if self.scoped() {
            return Err(crate::cause!(Error::Invalid));
        }
        if self.access != Access::Write {
            return Err(crate::cause!(Error::ReadOnly));
        }
        let _armed = self.armed()?;
        // The rewrite also turns the file to incremental auto-vacuum (it takes effect only through a VACUUM), so after
        // it the space of removed rows goes back in short `reclaim_step`s and no later removal needs a rewrite.
        self.db()
            .execute_batch("PRAGMA auto_vacuum=INCREMENTAL; VACUUM")
            .map_err(|error| failure(error))?;
        // A checkpoint that cannot finish leaves the old pages in the WAL; that is a failure, not a pass.
        let busy: i64 = self
            .db()
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
            .map_err(|error| failure(error))?;
        if busy != 0 {
            return Err(crate::cause!(Error::Busy));
        }
        Ok(())
    }

    fn vacuum_state(&self) -> Result<Option<crate::storage::VacuumState>> {
        let _armed = self.armed()?;
        let read = |pragma: &str| -> Result<i64> {
            self.db().query_row(pragma, [], |row| row.get(0)).map_err(|error| self.failed(error))
        };
        let mode = read("PRAGMA auto_vacuum")?;
        Ok(Some(crate::storage::VacuumState {
            incremental: mode == 2,
            free_pages: u64::try_from(read("PRAGMA freelist_count")?).map_err(|_| crate::cause!(Error::Invalid))?,
            pages: u64::try_from(read("PRAGMA page_count")?).map_err(|_| crate::cause!(Error::Invalid))?,
            page_size: u64::try_from(read("PRAGMA page_size")?).map_err(|_| crate::cause!(Error::Invalid))?,
        }))
    }

    fn reclaim_step(&self, pages: u64) -> Result<u64> {
        if self.scoped() {
            return Err(crate::cause!(Error::Invalid));
        }
        if self.access != Access::Write {
            return Err(crate::cause!(Error::ReadOnly));
        }
        let _armed = self.armed()?;
        let incremental: i64 = self
            .db()
            .query_row("PRAGMA auto_vacuum", [], |row| row.get(0))
            .map_err(|error| self.failed(error))?;
        if incremental != 2 {
            // A file not yet turned to incremental auto-vacuum keeps its free pages (overwritten, never returned)
            // until a rewrite (`reclaim`): a step cannot give them back, so it says so instead of answering empty.
            return Err(crate::cause!(caller: Error::NeedsRewrite));
        }
        // One autocommit transaction that moves at most `pages` pages and truncates the file by them. The log beside
        // the file, which may still hold a page image from before a removal, is its owner's to clear beside it
        // (`LogKeeper`), never in a step: its copy is one pass as long as the log.
        self.db()
            .execute_batch(&format!("PRAGMA incremental_vacuum({pages})"))
            .map_err(|error| self.failed(error))?;
        let free: i64 = self
            .db()
            .query_row("PRAGMA freelist_count", [], |row| row.get(0))
            .map_err(|error| self.failed(error))?;
        u64::try_from(free).map_err(|error| crate::carry_cause!(Error::Unavailable, error))
    }

    fn overwrites_removed(&self) -> Result<bool> {
        let _armed = self.armed()?;
        let on: i64 = self
            .db()
            .query_row("PRAGMA secure_delete", [], |row| row.get(0))
            .map_err(|error| self.failed(error))?;
        Ok(on == 1)
    }

    fn open_scope(&self, intent: Intent) -> Result<()> {
        if self.scope_failed.get() {
            return Err(crate::cause!(Error::Unavailable));
        }
        let _armed = self.armed()?;
        let sql = match intent {
            Intent::Read => "BEGIN DEFERRED".to_string(),
            Intent::Write => "BEGIN IMMEDIATE".to_string(),
            Intent::Nested if self.scoped() => {
                format!("SAVEPOINT storage_nested_{}", self.nested.get() + 1)
            }
            Intent::Nested => return Err(crate::cause!(Error::Invalid)),
        };
        let outermost = intent != Intent::Nested;
        if outermost && self.scoped() {
            return Err(crate::cause!(Error::Invalid));
        }
        if let Err(error) = self.db().execute_batch(&sql) {
            // A refused BEGIN that left the handle in autocommit provably opened nothing (another writer holds the
            // reservation: `Busy`); the handle stays usable for reads and for a later attempt. Any other reported
            // boundary failure does not prove whether SQLite applied the boundary. Keep the prior depth and refuse
            // later closes, which might otherwise treat this scope's parent as the current savepoint.
            if !(outermost && self.db().is_autocommit()) {
                self.scope_failed.set(true);
            }
            return Err(failure(error));
        }
        if intent == Intent::Nested {
            self.nested.set(self.nested.get() + 1);
        }
        Ok(())
    }

    fn close_scope(&self, commit: bool) -> Result<()> {
        if self.ended.get() && !self.scope_failed.get() {
            // SQLite already rolled the transaction back (`ended`): no savepoint and no outer transaction is left, which
            // autocommit proves. Each scope closes without a statement; a rollback is done, a commit is refused. The
            // handle is usable again once the outermost scope it opened is closed.
            if !self.db().is_autocommit() {
                self.scope_failed.set(true);
                return Err(crate::cause!(Error::Unavailable));
            }
            match self.nested.get() {
                0 => self.ended.set(false),
                depth => self.nested.set(depth - 1),
            }
            return if commit {
                Err(crate::cause!(Error::Unavailable))
            } else {
                Ok(())
            };
        }
        if self.scope_failed.get() {
            return Err(crate::cause!(Error::Unavailable));
        }
        let _armed = match self.armed() {
            Ok(armed) => armed,
            Err(error) => {
                self.scope_failed.set(true);
                return Err(error);
            }
        };
        let depth = self.nested.get();
        if depth == 0 {
            return match self
                .db()
                .execute_batch(if commit { "COMMIT" } else { "ROLLBACK" })
            {
                Ok(()) => Ok(()),
                Err(error) => {
                    self.scope_failed.set(true);
                    Err(failure(error))
                }
            };
        }
        let sql = if commit {
            format!("RELEASE storage_nested_{depth}")
        } else {
            format!("ROLLBACK TO storage_nested_{depth}; RELEASE storage_nested_{depth}")
        };
        match self.db().execute_batch(&sql) {
            Ok(()) => {
                self.nested.set(depth - 1);
                Ok(())
            }
            Err(error) => {
                // A failed nested close leaves the current savepoint uncertain. Preserve its depth and block later
                // closes so an ancestor cannot accidentally roll back or release this scope as if it were its own.
                self.scope_failed.set(true);
                Err(failure(error))
            }
        }
    }
}

#[cfg(test)]
mod busy_tests {
    use super::failure;
    use crate::storage::Error;

    #[test]
    fn a_write_contended_by_another_connection_is_busy_and_not_a_refusal() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("contended.sqlite");
        let first = rusqlite::Connection::open(&path).unwrap();
        first.pragma_update(None, "journal_mode", "WAL").unwrap();
        first.execute_batch("CREATE TABLE held(x INTEGER)").unwrap();
        let second = rusqlite::Connection::open(&path).unwrap();
        second.busy_timeout(std::time::Duration::from_millis(50)).unwrap();
        first.execute_batch("BEGIN IMMEDIATE; INSERT INTO held VALUES (1)").unwrap();
        let error = second.execute_batch("BEGIN IMMEDIATE").unwrap_err();
        assert_eq!(failure(error), crate::cause!(Error::Busy));
        first.execute_batch("COMMIT").unwrap();
    }

    /// The class `Busy` survives the conversion an inner site makes into a record refusal (`carry_cause!`), so the caller
    /// that answers the record refusal can tell a lock that did not start the work from any other failure.
    #[test]
    fn a_busy_keeps_its_retry_class_through_the_records_conversion() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("contended.sqlite");
        let first = rusqlite::Connection::open(&path).unwrap();
        first.pragma_update(None, "journal_mode", "WAL").unwrap();
        first.execute_batch("CREATE TABLE held(x INTEGER)").unwrap();
        let second = rusqlite::Connection::open(&path).unwrap();
        second.busy_timeout(std::time::Duration::from_millis(50)).unwrap();
        first.execute_batch("BEGIN IMMEDIATE; INSERT INTO held VALUES (1)").unwrap();
        let busy = failure(second.execute_batch("BEGIN IMMEDIATE").unwrap_err());
        let carried = crate::carry_cause!(crate::records::Error::Unavailable, busy);
        assert_eq!(carried.cause().retry(), crate::refusal_cause::Retry::Busy);
        let other = failure(rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_FULL), None));
        let carried_other = crate::carry_cause!(crate::records::Error::Unavailable, other);
        assert_eq!(carried_other.cause().retry(), crate::refusal_cause::Retry::Other);
        first.execute_batch("COMMIT").unwrap();
    }
}

#[cfg(test)]
mod scope_failure_tests {
    use super::{lend, Access};
    use crate::storage::{Error, Intent, Scope};
    use rusqlite::Connection;

    fn connection() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE policy_directory(name TEXT PRIMARY KEY, value TEXT NOT NULL)",
        )
        .unwrap();
        db
    }

    #[test]
    fn failed_nested_release_keeps_depth_and_cannot_roll_back_its_parent() {
        let db = connection();
        let store = lend(&db, "account_policy", Access::Write).unwrap();
        let outer = Scope::begin(&store, Intent::Write).unwrap();
        let middle = Scope::begin(&*outer, Intent::Nested).unwrap();
        middle
            .put(
                "policy_directory",
                &[("name", "middle".into()), ("value", "kept".into())],
                crate::storage::When::New,
            )
            .unwrap();
        let inner = Scope::begin(&*middle, Intent::Nested).unwrap();

        // Simulate a RELEASE that succeeded at SQLite but whose result was lost before the storage boundary could
        // observe it. A later rollback at depth 1 would wrongly target `middle`.
        db.execute_batch("RELEASE storage_nested_2").unwrap();
        assert_eq!(inner.commit(), Err(crate::cause!(Error::Unavailable)));
        assert_eq!(
            store.nested.get(),
            2,
            "failed close keeps the last known depth"
        );
        assert_eq!(
            middle.commit(),
            Err(crate::cause!(Error::Unavailable)),
            "poisoned scope state forbids an ancestor close"
        );
        assert_eq!(outer.commit(), Err(crate::cause!(Error::Unavailable)));

        let kept: i64 = db
            .query_row(
                "SELECT count(*) FROM policy_directory WHERE name='middle'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            kept, 1,
            "the failed child close must not roll back its parent scope"
        );
        assert!(
            !db.is_autocommit(),
            "the unresolved outer transaction remains visible as scoped"
        );
    }

    #[test]
    fn failed_nested_rollback_keeps_depth_and_prevents_parent_close() {
        let db = connection();
        let store = lend(&db, "account_policy", Access::Write).unwrap();
        let outer = Scope::begin(&store, Intent::Write).unwrap();
        let nested = Scope::begin(&*outer, Intent::Nested).unwrap();

        // Removing the savepoint behind the supply makes its intended ROLLBACK TO fail. The outer transaction must
        // remain untouched; its Scope must not reinterpret the stale nested depth as its own boundary.
        db.execute_batch("RELEASE storage_nested_1").unwrap();
        assert_eq!(nested.rollback(), Err(crate::cause!(Error::Unavailable)));
        assert_eq!(store.nested.get(), 1);
        assert_eq!(outer.rollback(), Err(crate::cause!(Error::Unavailable)));
        assert!(
            !db.is_autocommit(),
            "failed close leaves the physical transaction open"
        );
    }

    #[test]
    fn interrupted_nested_rollback_is_not_retried_at_an_ancestor_level() {
        let db = connection();
        let store = lend(&db, "account_policy", Access::Write).unwrap();
        let outer = Scope::begin(&store, Intent::Write).unwrap();
        let nested = Scope::begin(&*outer, Intent::Nested).unwrap();

        db.progress_handler(1, Some(|| true));
        assert_eq!(nested.rollback(), Err(crate::cause!(Error::Interrupted)));
        assert_eq!(
            store.nested.get(),
            1,
            "cancellation must not discard nested custody"
        );
        assert_eq!(outer.rollback(), Err(crate::cause!(Error::Unavailable)));
        assert!(
            !db.is_autocommit(),
            "an interrupted rollback is still an open physical scope"
        );
    }
}

#[cfg(test)]
mod owned_observation_tests {
    use super::{open_owned_observed, Bounds, Spend};
    use crate::{
        sqlite_work::WorkMeter,
        storage::{Intent, Read, Scope, Storage, Value, When},
    };
    use std::time::Duration;

    #[test]
    fn owned_schema_write_and_first_and_repeat_reads_share_the_meter() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary
            .path()
            .canonicalize()
            .unwrap()
            .join("account.sqlite");
        let meter = WorkMeter::new();
        let store = open_owned_observed(
            &path,
            "account_policy",
            Bounds {
                value_bytes: 1 << 20,
                work: 1_000_000,
                deadline: Duration::from_secs(5),
                spend: Spend::EachOperation,
                cancel: None,
                busy: Duration::ZERO,
            },
            meter.clone(),
        )
        .unwrap();
        let prepared = meter.snapshot().unwrap();
        assert_eq!(prepared.active_statements, 0);
        assert!(
            prepared.work.sql_statements > 0,
            "schema work must not escape observation"
        );

        let tx = Scope::begin(&store, Intent::Write).unwrap();
        assert_eq!(
            tx.put(
                "policy_directory",
                &[("name", "one".into()), ("value", "kept".into())],
                When::New
            ),
            Ok(1)
        );
        tx.commit().unwrap();
        let written = meter.snapshot().unwrap();
        assert_eq!(written.active_statements, 0);
        assert!(
            written.work.rows_written > prepared.work.rows_written,
            "the owned write must be counted"
        );

        let key = [Value::from("one")];
        let fields = [Read::whole("value")];
        let first = store.get("policy_directory", &key, &fields).unwrap();
        assert_eq!(first.unwrap().0, vec![Value::from("kept")]);
        let after_first = meter.snapshot().unwrap();
        assert_eq!(
            after_first.work.sqlite_scan_visits - written.work.sqlite_scan_visits,
            1
        );
        assert_eq!(after_first.work.rows_written, written.work.rows_written);

        let repeat = store.get("policy_directory", &key, &fields).unwrap();
        assert_eq!(repeat.unwrap().0, vec![Value::from("kept")]);
        let after_repeat = meter.snapshot().unwrap();
        assert_eq!(after_repeat.active_statements, 0);
        assert_eq!(
            after_repeat.work.sqlite_scan_visits - after_first.work.sqlite_scan_visits,
            1
        );
        assert_eq!(
            after_repeat.work.rows_written,
            after_first.work.rows_written
        );
    }
}

#[cfg(test)]
mod declared_preparation_tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn declared_family_preparation_requires_the_owned_write_and_rolls_back_its_schema() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder
            .path()
            .canonicalize()
            .unwrap()
            .join("declared-preparation.sqlite");
        let bounds = Bounds {
            value_bytes: 1024 * 1024,
            work: u64::MAX / 2,
            deadline: Duration::MAX,
            spend: Spend::EachOperation,
            cancel: None,
            busy: Duration::ZERO,
        };
        let store = open_owned(&path, "storage_test", bounds).unwrap();
        let original = schema_version(store.db()).unwrap();
        assert_eq!(
            store.prepare_declared_families(&["drafts"]),
            Err(crate::cause!(Error::Unavailable))
        );
        assert!(!store.present("drafts").unwrap());
        store.open_scope(Intent::Read).unwrap();
        assert_eq!(
            store.prepare_declared_families(&["drafts"]),
            Err(crate::cause!(Error::Unavailable))
        );
        store.close_scope(false).unwrap();
        store.open_scope(Intent::Write).unwrap();
        let read_only = lend(store.db(), "storage_test", Access::Read).unwrap();
        assert_eq!(
            read_only.prepare_declared_families(&["drafts"]),
            Err(crate::cause!(Error::ReadOnly))
        );
        assert_eq!(
            store.prepare_declared_families(&["drafts", "undeclared-family"]),
            Err(crate::cause!(Error::Undeclared))
        );
        assert_eq!(
            schema_version(store.db()).unwrap(),
            original,
            "all registry names are checked before any DDL"
        );
        store.prepare_declared_families(&["drafts"]).unwrap();
        assert!(store.present("drafts").unwrap());
        assert_eq!(
            store.count("drafts", &Range::all()).unwrap(),
            0,
            "preparation seeds no rows"
        );
        let prepared = schema_version(store.db()).unwrap();
        assert!(prepared > original);
        store.prepare_declared_families(&["drafts"]).unwrap();
        assert_eq!(
            schema_version(store.db()).unwrap(),
            prepared,
            "an already prepared family makes nothing again"
        );
        store.close_scope(false).unwrap();
        assert_eq!(schema_version(store.db()).unwrap(), original);
        assert!(
            !store.present("drafts").unwrap(),
            "the caller's rollback also removes prepared schema"
        );
        store.open_scope(Intent::Write).unwrap();
        store.prepare_declared_families(&["drafts"]).unwrap();
        let witness = schema_version(store.db()).unwrap();
        store
            .put(
                "drafts",
                &[
                    ("id", Value::Text("one".into())),
                    ("title", Value::Text("prepared".into())),
                ],
                When::Always,
            )
            .unwrap();
        assert_eq!(
            schema_version(store.db()).unwrap(),
            witness,
            "the following real write preserves its schema witness"
        );
        store.close_scope(true).unwrap();
    }
}


#[cfg(test)]
mod command_memo_tests {
    use super::*;
    use crate::storage::{Scope, Read};

    fn observed() -> ObservedConnection {
        let db = Connection::open_in_memory().unwrap();
        // Fresh, synthetic handle with no prepared statement or trace callback.
        unsafe { ObservedConnection::attach_untraced(db, WorkMeter::new()) }.unwrap()
    }

    #[test]
    fn command_memo_observes_creation_raw_ddl_and_savepoint_rollback() {
        let observed = observed();
        let db = observed.connection();
        db.execute_batch("BEGIN IMMEDIATE").unwrap();
        let memo = CommandMemo::new(observed.schema_observation());
        let a = lend(db, "storage_test", Access::Write).unwrap().with_command_memo(memo.clone()).unwrap();
        assert_eq!(a.count("drafts", &Range::all()).unwrap(), 0);
        assert_eq!(a.count("drafts", &Range::all()).unwrap(), 0);
        a.put("drafts", &[("id", "a".into()), ("title", "kept".into())], When::New).unwrap();
        let b = lend(db, "storage_test", Access::Write).unwrap().with_command_memo(memo.clone()).unwrap();
        assert_eq!(b.count("drafts", &Range::all()).unwrap(), 1);
        db.execute_batch("SAVEPOINT held; DROP TABLE drafts").unwrap();
        assert_eq!(b.count("drafts", &Range::all()).unwrap(), 0);
        db.execute_batch("ROLLBACK TO held; RELEASE held").unwrap();
        assert_eq!(b.get("drafts", &["a".into()], &[Read::whole("title")]).unwrap().unwrap().0, vec![Value::Text("kept".into())]);
        db.execute_batch("DROP TABLE drafts; CREATE VIEW drafts AS SELECT 'view' AS id, 'view' AS title").unwrap();
        assert_eq!(b.table_kind("drafts").unwrap().as_deref(), Some("view"));
        assert_eq!(b.present("drafts"), Err(crate::cause!(Error::Unavailable)));
        db.execute_batch("ROLLBACK").unwrap();
        assert!(b.table_kind("drafts").is_err(), "no memo result escapes an ended transaction");
        db.execute_batch("BEGIN IMMEDIATE").unwrap();
        assert_eq!(b.count("drafts", &Range::all()).unwrap(), 0);
        db.execute_batch("ROLLBACK").unwrap();
    }

    #[test]
    fn failed_nested_create_invalidates_the_shared_command_memo() {
        let observed = observed();
        let db = observed.connection();
        db.execute_batch("BEGIN IMMEDIATE").unwrap();
        let memo = CommandMemo::new(observed.schema_observation());
        let a = lend(db, "storage_test", Access::Write).unwrap().with_command_memo(memo.clone()).unwrap();
        let b = lend(db, "storage_test", Access::Write).unwrap().with_command_memo(memo.clone()).unwrap();
        {
            let savepoint = Scope::begin(&a, Intent::Nested).unwrap();
            savepoint.put("drafts", &[("id", "a".into()), ("title", "lost".into())], When::New).unwrap();
            assert_eq!(b.count("drafts", &Range::all()).unwrap(), 1);
            savepoint.rollback().unwrap();
        }
        assert_eq!(b.count("drafts", &Range::all()).unwrap(), 0);
        b.put("drafts", &[("id", "b".into()), ("title", "kept".into())], When::New).unwrap();
        assert_eq!(a.count("drafts", &Range::all()).unwrap(), 1);
        db.execute_batch("COMMIT; SAVEPOINT another").unwrap();
        db.execute_batch("DROP TABLE drafts").unwrap();
        assert_eq!(a.count("drafts", &Range::all()).unwrap(), 0);
        db.execute_batch("ROLLBACK TO another; RELEASE another; BEGIN IMMEDIATE").unwrap();
        assert_eq!(a.count("drafts", &Range::all()).unwrap(), 1);
        db.execute_batch("ROLLBACK").unwrap();
        drop(a); drop(b); drop(observed);
        let replacement = Connection::open_in_memory().unwrap();
        replacement.execute_batch("BEGIN IMMEDIATE").unwrap();
        assert!(memo.state(&replacement).is_err(), "the source witness expires with its connection");
    }
}

#[cfg(test)]
#[path = "sqlite_tests.rs"]
mod scenario_tests;
