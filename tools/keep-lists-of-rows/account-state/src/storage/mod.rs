// Purpose: The one storage boundary. Product code reaches stored families only through the generic typed
// operations of `Storage`; a supply (today `sqlite`) implements them, so another database can stand behind it.
//
// Non-Negotiable Invariants:
// - A family, its key, its fields and its orders are DATA rows in `families.json`. Nothing outside a row exists:
//   every operation naming an undeclared family, field or order is refused before any storage work.
// - The operation set is small and generic (get, scan, read_many, put, erase, write_many, present, scope, custody,
//   marks). No operation is shaped after one caller's SQL statement, and no caller passes query text.
// - A read may bound each field's bytes. An oversized stored value comes back as `Value::Oversized(bytes)` and is
//   never materialized; the caller decides what that means.
// - A scope is the supply's atomic unit. Dropping an unfinished scope rolls it back.
// - The scope rule: an operation that fails inside a scope changes nothing and leaves the scope usable. The owner
//   decides whether to go on or to roll the scope back. A supply on a server that aborts a whole transaction at one
//   failed statement (PostgreSQL) must contain the failure itself, with a savepoint around the statement.
// - The batch operations (`read_many`, `write_many`) are the same operations as their single forms, asked together so a
//   supply on a network can send them in one trip. Their answers are what the single forms would have given. There is
//   one batch read, not one per shape: a point get, a range and an ordered page ride in the same `read_many`.
//
// Key Concepts:
// - `Storage`: the object-safe operation contract. `Scope`: begin/commit/rollback with rollback on drop.
// - `Query`/`Reply`: one point get or range of a `read_many` batch, and its answer.
// - `Write`: one put or erase of a `write_many` batch.
// - `Range`: a cursor over a declared order (the key, a named order, or arrival), with bounds and a limit.
// - `When`: how a put meets an existing row (replace, keep, refuse, or only where named fields still match).
//
// Security Considerations:
// - Identifiers are never caller text: they are validated DATA, so a supply can quote them safely.
// - `custody` proves the supplied physical handle is still the one opened with its declared access; it is not
//   account authority. Owners keep their own admission checks around these operations.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! The storage boundary: generic typed operations over DATA-declared families, and the supplies that implement them.
//! Read `README.md` in this folder and `docs/storage-boundary.md` for the inventory and the migration notes.

// The wasm32 build (`computer_build/`, cfg `computer_build`) compiles this boundary for a computer whose storage its host lends
// (wasm32): the operations, the schema, the memory supply and the hosted-SQL supply. The supplies and owners below that
// need a database file or the rest of trillion-local are left out of it, each named here so the gap stays visible
// (.cargo/build-targets.json, the wasm32-unknown-unknown row).
#[cfg(not(computer_build))]
pub mod time_source;
pub mod kind_views;
#[cfg(not(computer_build))]
pub(crate) mod original_kv;
pub mod memory;
pub mod hosted_sql;
#[cfg(not(computer_build))]
pub(crate) mod old_record_tables;
// The module computer (src/native_entry/module_computer, cfg `hosted_records`) adds the record store to that build:
// what in it needs a database file or the rest of trillion-local is left out in its own files.
#[cfg(any(not(computer_build), hosted_records))]
pub mod record_store;
#[cfg(any(not(computer_build), hosted_records))]
pub mod record_store_resources;
mod schema;
#[cfg(not(computer_build))]
pub mod sqlite;
#[cfg(all(test, not(computer_build)))]
mod tests;

pub use schema::{runtime_family, schema, Family, Made, Only, OrderDeclaration, Schema};
use std::{fmt, ops::Deref};

/// Numeric request observation, carried by the existing request owners. It
/// retains no account identity, SQL, value or credential. Old trillion
/// src/placed-lists.mjs:10-41 separated useful work from its physical supplier;
/// observation here changes neither execution nor authority.
#[cfg(all(not(host = "module"), not(computer_build)))]
pub mod request_work {
    use std::{cell::RefCell, future::Future, marker::PhantomData, pin::Pin, rc::Rc,
        sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}}, task::{Context, Poll}};
    #[derive(Default)]
    struct Counters {
        statements: AtomicU64, reads: AtomicU64, rows: AtomicU64, writes: AtomicU64,
        visits: AtomicU64, vm: AtomicU64, active: AtomicU64, jobs: AtomicU64,
        unattributed: AtomicU64, incomplete: AtomicBool, finished: AtomicBool,
    }
    #[derive(Clone, Default)]
    pub struct RequestWork(Arc<Counters>);
    #[derive(Clone, Debug, serde::Serialize)]
    pub struct Summary {
        pub statements: u64, pub read_queries: u64, pub rows_returned: u64,
        pub rows_written: u64, pub scan_visits: u64, pub vm_steps: u64,
        pub unattributed_rows: u64, pub complete: bool,
    }
    thread_local! { static CURRENT: RefCell<Option<RequestWork>> = const { RefCell::new(None) }; }
    /// A thread-bound scope never lives across an await.
    pub struct Entered { previous: Option<RequestWork>, _thread: PhantomData<Rc<()>> }
    impl Drop for Entered {
        fn drop(&mut self) { CURRENT.with(|current| { *current.borrow_mut() = self.previous.take(); }); }
    }
    impl RequestWork {
        pub fn current() -> Option<Self> {
            CURRENT.try_with(|current| current.try_borrow().ok().and_then(|current| current.clone())).ok().flatten()
        }
        pub fn enter(&self) -> Entered {
            let previous = CURRENT.with(|current| current.borrow_mut().replace(self.clone()));
            Entered { previous, _thread: PhantomData }
        }
        pub fn observe<F: Future>(&self, future: F) -> Observed<F> {
            Observed { work: self.clone(), future: Box::pin(future) }
        }
        pub fn spawn_blocking<F, R>(&self, run: F) -> tokio::task::JoinHandle<R>
        where F: FnOnce() -> R + Send + 'static, R: Send + 'static {
            blocking_with(Some(self.clone()), run)
        }
        fn add(&self, counter: &AtomicU64, amount: u64) {
            if self.0.finished.load(Ordering::Acquire) { self.incomplete(); }
            if counter.fetch_update(Ordering::AcqRel, Ordering::Acquire, |old| old.checked_add(amount)).is_err() { self.incomplete(); }
        }
        pub(crate) fn incomplete(&self) { self.0.incomplete.store(true, Ordering::Release); }
        pub(crate) fn start_statement(&self, reads: bool) {
            self.add(&self.0.statements, 1); self.add(&self.0.reads, u64::from(reads)); self.add(&self.0.active, 1);
        }
        pub(crate) fn row(&self) { self.add(&self.0.rows, 1); }
        pub(crate) fn unattributed_row(&self) { self.row(); self.add(&self.0.unattributed, 1); }
        pub(crate) fn finish_statement(&self, visits: u64, vm: u64, writes: u64) {
            self.add(&self.0.visits, visits); self.add(&self.0.vm, vm); self.add(&self.0.writes, writes);
            if self.0.active.fetch_update(Ordering::AcqRel, Ordering::Acquire, |old| old.checked_sub(1)).is_err() { self.incomplete(); }
        }
        /// An unobserved supplier is never an observed zero.
        pub(crate) fn uncovered() { if let Some(work) = Self::current() { work.incomplete(); } }
        pub fn finish(&self) -> Summary {
            let complete = !self.0.incomplete.load(Ordering::Acquire) && self.0.active.load(Ordering::Acquire) == 0 && self.0.jobs.load(Ordering::Acquire) == 0;
            self.0.finished.store(true, Ordering::Release);
            Summary {
                statements: self.0.statements.load(Ordering::Acquire), read_queries: self.0.reads.load(Ordering::Acquire),
                rows_returned: self.0.rows.load(Ordering::Acquire), rows_written: self.0.writes.load(Ordering::Acquire),
                scan_visits: self.0.visits.load(Ordering::Acquire), vm_steps: self.0.vm.load(Ordering::Acquire),
                unattributed_rows: self.0.unattributed.load(Ordering::Acquire), complete,
            }
        }
    }

    pub struct Observed<F> { work: RequestWork, future: Pin<Box<F>> }
    impl<F: Future> Future for Observed<F> {
        type Output = F::Output;
        fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
            let _entered = self.work.enter(); self.future.as_mut().poll(cx)
        }
    }
    struct Job(Option<RequestWork>);
    impl Drop for Job { fn drop(&mut self) { if let Some(work) = &self.0 { work.0.jobs.fetch_sub(1, Ordering::AcqRel); } } }
    /// Capture before scheduling: queued/detached work remains outstanding even
    /// if its HTTP future is cancelled before the blocking thread starts.
    pub fn spawn_blocking<F, R>(run: F) -> tokio::task::JoinHandle<R>
    where F: FnOnce() -> R + Send + 'static, R: Send + 'static {
        blocking_with(RequestWork::current(), run)
    }
    pub(crate) fn blocking_with<F, R>(work: Option<RequestWork>, run: F) -> tokio::task::JoinHandle<R>
    where F: FnOnce() -> R + Send + 'static, R: Send + 'static {
        if let Some(work) = &work { work.add(&work.0.jobs, 1); }
        let job = Job(work);
        tokio::task::spawn_blocking(move || {
            let entered = job.0.as_ref().map(RequestWork::enter);
            let result = run(); drop(entered); drop(job); result
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::sqlite_work::{ObservedConnection, SuppliedConnection, WorkMeter};
        use rusqlite::Connection;
        fn attached(meter: WorkMeter) -> ObservedConnection {
            // SAFETY: freshly owned fixture, with no statement or callback.
            unsafe { ObservedConnection::attach_untraced(Connection::open_in_memory().unwrap(), meter) }.unwrap()
        }
        fn number(work: &RequestWork, counter: fn(&Counters) -> &AtomicU64) -> u64 {
            counter(&work.0).load(Ordering::Acquire)
        }
        #[test]
        fn reused_connection_keeps_each_statement_with_its_original_request() {
            let db = attached(WorkMeter::new());
            let a = RequestWork::default();
            let b = RequestWork::default();
            let mut prepared = db.connection().prepare("SELECT 1 UNION ALL SELECT 2").unwrap();
            let entered = a.enter();
            let mut rows = prepared.query([]).unwrap();
            assert!(rows.next().unwrap().is_some());
            drop(entered);
            let entered = b.enter();
            assert_eq!(db.connection().query_row("SELECT 3", [], |row| row.get::<_, i64>(0)).unwrap(), 3);
            assert!(rows.next().unwrap().is_some());
            drop(rows); drop(prepared); drop(entered);
            assert_eq!(number(&a, |c| &c.statements), 1);
            assert_eq!(number(&a, |c| &c.rows), 2);
            assert_eq!(number(&b, |c| &c.statements), 1);
            assert_eq!(number(&b, |c| &c.rows), 1);
            assert!(a.finish().complete);
            assert!(b.finish().complete);
        }
        #[test]
        fn concurrent_requests_and_unscoped_upkeep_do_not_share_counts() {
            let meter = WorkMeter::new();
            let start = Arc::new(std::sync::Barrier::new(3));
            let mut threads = Vec::new();
            for count in [7, 13] {
                let (meter, start) = (meter.clone(), start.clone());
                threads.push(std::thread::spawn(move || {
                    let db = attached(meter);
                    let work = RequestWork::default();
                    let entered = work.enter();
                    start.wait();
                    for _ in 0..count { db.connection().query_row("SELECT 1", [], |row| row.get::<_, i64>(0)).unwrap(); }
                    drop(entered);
                    assert_eq!(number(&work, |c| &c.statements), count);
                    assert_eq!(number(&work, |c| &c.reads), count);
                    assert!(work.finish().complete);
                }));
            }
            let upkeep = attached(meter.clone()); start.wait();
            for _ in 0..23 { upkeep.connection().query_row("SELECT 1", [], |row| row.get::<_, i64>(0)).unwrap(); }
            for thread in threads { thread.join().unwrap(); }
            assert_eq!(meter.snapshot().unwrap().work.sql_statements, 43);
        }
        #[test]
        fn prepared_result_shape_defines_reads_and_raw_sources_refuse_complete_coverage() {
            let db = attached(WorkMeter::new());
            db.connection().execute_batch("CREATE TABLE source(value INTEGER)").unwrap();
            let work = RequestWork::default();
            let entered = work.enter();
            db.connection().execute_batch("BEGIN").unwrap();
            db.connection().query_row("SELECT 1", [], |row| row.get::<_, i64>(0)).unwrap();
            db.connection().query_row("WITH chosen AS (SELECT 2) SELECT * FROM chosen", [], |row| row.get::<_, i64>(0)).unwrap();
            db.connection().query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0)).unwrap();
            db.connection().query_row("INSERT INTO source VALUES(3) RETURNING value", [], |row| row.get::<_, i64>(0)).unwrap();
            db.connection().execute_batch("COMMIT").unwrap();
            drop(entered);
            assert_eq!(number(&work, |c| &c.statements), 6);
            assert_eq!(number(&work, |c| &c.reads), 3);
            assert_eq!(number(&work, |c| &c.writes), 1);
            assert!(work.finish().complete);
            let raw = SuppliedConnection::from(Connection::open_in_memory().unwrap());
            let work = RequestWork::default(); let entered = work.enter();
            raw.query_row("SELECT 1", [], |row| row.get::<_, i64>(0)).unwrap();
            drop(entered);
            assert!(!work.finish().complete);
        }

    }
}

/// One stored scalar. `Oversized` is only ever returned by a bounded read; a put refuses it.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
    /// The stored value is larger than the read's byte bound; it holds the stored byte length.
    Oversized(u64),
}
impl Value {
    pub fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            _ => None,
        }
    }
    pub fn as_integer(&self) -> Option<i64> {
        match self {
            Self::Integer(value) => Some(*value),
            _ => None,
        }
    }
}
impl From<&str> for Value {
    fn from(text: &str) -> Self {
        Self::Text(text.into())
    }
}
impl From<String> for Value {
    fn from(text: String) -> Self {
        Self::Text(text)
    }
}
impl From<i64> for Value {
    fn from(value: i64) -> Self {
        Self::Integer(value)
    }
}

/// One field to read, optionally bounded in stored bytes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Read<'a> {
    pub field: &'a str,
    pub at_most: Option<usize>,
}
impl<'a> Read<'a> {
    pub const fn whole(field: &'a str) -> Self {
        Self { field, at_most: None }
    }
    pub const fn at_most(field: &'a str, bytes: usize) -> Self {
        Self { field, at_most: Some(bytes) }
    }
    /// The row's arrival position, the cursor of `Order::Arrival` (families declaring `"arrival": true`).
    pub const fn arrival() -> Self {
        Self { field: ARRIVAL, at_most: None }
    }
}

/// The reserved field name of a row's arrival position; never a declared field.
pub const ARRIVAL: &str = "@arrival";

/// The values of one read row, in the order of the requested `Read`s.
#[derive(Clone, Debug, PartialEq)]
pub struct Row(pub Vec<Value>);
impl Row {
    /// Move one value out, leaving `Null` instead.
    pub fn take(&mut self, at: usize) -> Value {
        self.0.get_mut(at).map(|value| std::mem::replace(value, Value::Null)).unwrap_or(Value::Null)
    }
}

/// The order a scan walks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Order<'a> {
    /// The family's declared key.
    Key,
    /// An order declared by name in the family's `orders` row; its fields are the cursor. A partial order holds only
    /// the rows its `only` conditions match.
    Named(&'a str),
    /// The order rows arrived in (families declaring `"arrival": true`). The cursor is `Read::arrival()`.
    Arrival,
}

/// One end of a range, over the order's cursor fields (a prefix of them is allowed).
#[derive(Clone, Debug, PartialEq)]
pub enum Bound {
    Unbounded,
    Included(Vec<Value>),
    Excluded(Vec<Value>),
}

/// A walk over one declared order. `from` is where the walk starts and `to` where it ends, in walk direction.
#[derive(Clone, Debug, PartialEq)]
pub struct Range<'a> {
    pub order: Order<'a>,
    pub from: Bound,
    pub to: Bound,
    pub reverse: bool,
    pub limit: Option<usize>,
}
impl<'a> Range<'a> {
    /// Every row in key order.
    pub fn all() -> Self {
        Self { order: Order::Key, from: Bound::Unbounded, to: Bound::Unbounded, reverse: false, limit: None }
    }
    /// Rows whose single text cursor field starts with `prefix` (byte order; case is significant).
    pub fn prefix(prefix: &str) -> Self {
        let mut range = Self::all();
        range.from = Bound::Included(vec![Value::Text(prefix.into())]);
        range.to = match successor(prefix) {
            Some(end) => Bound::Excluded(vec![Value::Text(end)]),
            None => Bound::Unbounded,
        };
        range
    }
    /// Rows strictly after `cursor` in the range's order.
    pub fn after(mut self, cursor: Vec<Value>) -> Self {
        self.from = Bound::Excluded(cursor);
        self
    }
    pub fn order(mut self, order: Order<'a>) -> Self {
        self.order = order;
        self
    }
    /// Walk the other way. `from` stays where the walk starts, so the two ends swap.
    pub fn reverse(mut self) -> Self {
        self.reverse = !self.reverse;
        std::mem::swap(&mut self.from, &mut self.to);
        self
    }
    pub fn limit(mut self, rows: usize) -> Self {
        self.limit = Some(rows);
        self
    }
}

/// The smallest text greater than every text starting with `prefix`, or None when no such text exists.
fn successor(prefix: &str) -> Option<String> {
    let mut chars: Vec<char> = prefix.chars().collect();
    while let Some(last) = chars.pop() {
        let next = match last as u32 {
            0xD7FF => Some('\u{E000}'),
            code => char::from_u32(code + 1),
        };
        if let Some(next) = next {
            chars.push(next);
            return Some(chars.into_iter().collect());
        }
    }
    None
}

/// How a put meets a row that already has the same key.
#[derive(Clone, Copy, Debug)]
pub enum When<'a> {
    /// Insert, or replace the named fields of the existing row.
    Always,
    /// Insert only when no row holds the key; otherwise change nothing.
    Absent,
    /// Insert; an existing key is `Error::Conflict`.
    New,
    /// Change the existing row only while each named field still holds its value (`Null` matches a null field).
    /// No row is inserted. The returned count says whether the row still matched.
    Matches(&'a [(&'a str, Value)]),
}

/// One read of a `Storage::read_many` batch: the arguments of `get` or of `scan`.
#[derive(Clone, Copy, Debug)]
pub enum Query<'a> {
    Get { family: &'a str, key: &'a [Value], read: &'a [Read<'a>] },
    Scan { family: &'a str, range: &'a Range<'a>, read: &'a [Read<'a>] },
}

/// The answer to one `Query`: what `get` (`Row`) or `scan` (`Rows`) would have returned.
#[derive(Clone, Debug, PartialEq)]
pub enum Reply {
    Row(Option<Row>),
    Rows(Vec<Row>),
}
impl Reply {
    /// The answer to a `Query::Get`.
    pub fn row(self) -> Result<Option<Row>> {
        match self {
            Self::Row(row) => Ok(row),
            Self::Rows(_) => Err(crate::cause!(Error::Invalid)),
        }
    }
    /// The answer to a `Query::Scan`.
    pub fn rows(self) -> Result<Vec<Row>> {
        match self {
            Self::Rows(rows) => Ok(rows),
            Self::Row(_) => Err(crate::cause!(Error::Invalid)),
        }
    }
}

/// One write of a `Storage::write_many` batch: the arguments of `put` or of `erase`.
#[derive(Clone, Copy, Debug)]
pub enum Write<'a> {
    Put { family: &'a str, row: &'a [(&'a str, Value)], when: When<'a> },
    Erase { family: &'a str, range: &'a Range<'a> },
}

/// The intent of a scope: a consistent read, the write reservation, or a nested unit inside an open scope that
/// commits or rolls back on its own without ending the outer scope.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Intent {
    Read,
    Write,
    Nested,
}

/// Storage failures carried to owners. No database error type crosses this boundary.
#[derive(Clone, Debug)]
pub enum Error {
    /// A family, field or order is not declared in `families.json`, or a schema is unknown.
    Undeclared(crate::refusal_cause::Cause),
    /// The operation is malformed (wrong key arity, an `Oversized` value written, an unsupported shape).
    Invalid(crate::refusal_cause::Cause),
    /// Another writer holds the storage.
    Busy(crate::refusal_cause::Cause),
    /// The operation's work or time allowance ran out, or it was cancelled.
    Interrupted(crate::refusal_cause::Cause),
    /// The supply observed its wall-clock deadline interrupt this operation.
    /// This does not establish that an enclosing transaction has closed.
    Deadline(crate::refusal_cause::Cause),
    /// A value exceeds the supply's configured value bound.
    TooBig(crate::refusal_cause::Cause),
    /// A put met an existing key, or a declared constraint refused it.
    Conflict(crate::refusal_cause::Cause),
    /// The physical handle is no longer the one opened, or its access is not the declared access.
    Moved(crate::refusal_cause::Cause),
    /// The storage cannot be written.
    ReadOnly(crate::refusal_cause::Cause),
    /// The selected source could not qualify this read as current. This is
    /// distinct from a missing row and from a physical/custody failure.
    NotCurrent(crate::refusal_cause::Cause),
    /// The volume has no room left for the write (SQLite `SQLITE_FULL`): the owner keeps its space, it is not a broken store.
    DiskFull(crate::refusal_cause::Cause),
    /// The file is not yet incremental auto-vacuum, so a reclaim step cannot give its free pages back: the one-time
    /// vacuum (`Storage::reclaim`) converts it first. Not a failure, and not an empty step.
    NeedsRewrite(crate::refusal_cause::Cause),
    /// Any other storage failure.
    Unavailable(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Undeclared(cause) => cause,
            Self::Invalid(cause) => cause,
            Self::Busy(cause) => cause,
            Self::Interrupted(cause) => cause,
            Self::Deadline(cause) => cause,
            Self::TooBig(cause) => cause,
            Self::Conflict(cause) => cause,
            Self::Moved(cause) => cause,
            Self::ReadOnly(cause) => cause,
            Self::NotCurrent(cause) => cause,
            Self::NeedsRewrite(cause) => cause,
            Self::DiskFull(cause) => cause,
            Self::Unavailable(cause) => cause,
        }
    }
}
crate::impl_caused!(Error);


impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool {
        match (self,other) {
            (Self::Undeclared(_),Self::Undeclared(_)) => true,
            (Self::Invalid(_),Self::Invalid(_)) => true,
            (Self::Busy(_),Self::Busy(_)) => true,
            (Self::Interrupted(_),Self::Interrupted(_)) => true,
            (Self::Deadline(_),Self::Deadline(_)) => true,
            (Self::TooBig(_),Self::TooBig(_)) => true,
            (Self::Conflict(_),Self::Conflict(_)) => true,
            (Self::Moved(_),Self::Moved(_)) => true,
            (Self::ReadOnly(_),Self::ReadOnly(_)) => true,
            (Self::NotCurrent(_),Self::NotCurrent(_)) => true,
            (Self::NeedsRewrite(_),Self::NeedsRewrite(_)) => true,
            (Self::DiskFull(_),Self::DiskFull(_)) => true,
            (Self::Unavailable(_),Self::Unavailable(_)) => true,
            _ => false,
        }
    }
}
impl Eq for Error {}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Undeclared(_) => "storage family, field or order is not declared",
            Self::Invalid(_) => "storage operation is malformed",
            Self::Busy(_) => "storage is held by another writer",
            Self::Interrupted(_) => "storage operation ran out of its allowance",
            Self::Deadline(_) => "storage operation reached its deadline",
            Self::TooBig(_) => "storage value exceeds its bound",
            Self::Conflict(_) => "storage key or constraint conflicts",
            Self::Moved(_) => "storage handle changed",
            Self::ReadOnly(_) => "storage is read-only",
            Self::NotCurrent(_) => "selected storage source not current",
            Self::NeedsRewrite(_) => "storage file needs its one-time vacuum before its free pages come back",
            Self::DiskFull(_) => "storage volume is full",
            Self::Unavailable(_) => "storage unavailable",
        })
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
pub type Result<T> = std::result::Result<T, Error>;

/// The storage operation contract. Every method takes `&self`; a supply serializes its own handle.
/// An independently selected storage source, supplied by its existing owner.
/// This is an opener, not a discovery map or account-authority claim. Request
/// cancellation/deadline and physical custody belong to the selected adapter;
/// the caller retains current admission and the original source witness.
/// A different supplier implements the same contract without a caller branch.
#[cfg(not(computer_build))]
pub(crate) trait SelectedSource: Send + Sync {
    fn open(&self, intent: Intent,
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
        deadline: std::time::Instant) -> Result<Box<dyn Storage>>;
}

/// A supplier-owned, single-use checkpoint in one exact held write session.
/// Its private payload is not a causal position, permission, path or data row.
/// Only its original supplier may close it. Full close/re-BEGIN and another
/// handle invalidate it even when both handles report an open write scope.
pub struct Checkpoint(Box<dyn std::any::Any>);
impl Checkpoint {
    fn new<T: std::any::Any>(value: T) -> Self { Self(Box::new(value)) }
    fn take<T: std::any::Any>(self) -> Result<T> {
        self.0.downcast::<T>().map(|value| *value).map_err(|error| crate::carry_cause!(Error::Invalid, error))
    }
}
impl fmt::Debug for Checkpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Checkpoint([redacted])")
    }
}
fn checkpoint_number() -> Result<u64> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    NEXT.fetch_update(std::sync::atomic::Ordering::Relaxed,
        std::sync::atomic::Ordering::Relaxed, |number| number.checked_add(1))
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))
}

/// The vacuum state of a store file (`Storage::vacuum_state`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VacuumState {
    /// Whether the file is already incremental auto-vacuum (`PRAGMA auto_vacuum` 2): its free pages then go back in steps.
    pub incremental: bool,
    pub free_pages: u64,
    pub pages: u64,
    pub page_size: u64,
}

pub trait Storage {
    /// The declared schema this handle was opened for.
    fn schema(&self) -> &'static Schema;
    /// One row by its full key.
    fn get(&self, family: &str, key: &[Value], read: &[Read<'_>]) -> Result<Option<Row>>;
    /// Rows along a declared order.
    fn scan(&self, family: &str, range: &Range<'_>, read: &[Read<'_>]) -> Result<Vec<Row>>;
    /// Several reads, point gets and ranges mixed: one `Reply` per query, in the order asked, each exactly what `get`
    /// or `scan` would have answered. Asked together so a supply on a network sends one request instead of one per
    /// read (an ordered page's records, the current row with the ranges that decide a write). The first refusal ends
    /// the batch with its error. The default asks one at a time, which is right for a supply that lives in the process.
    fn read_many(&self, queries: &[Query<'_>]) -> Result<Vec<Reply>> {
        queries
            .iter()
            .map(|query| match query {
                Query::Get { family, key, read } => self.get(family, key, read).map(Reply::Row),
                Query::Scan { family, range, read } => self.scan(family, range, read).map(Reply::Rows),
            })
            .collect()
    }
    /// Write one row (its key fields included). Returns the number of rows changed (0 or 1).
    fn put(&self, family: &str, row: &[(&str, Value)], when: When<'_>) -> Result<u64>;
    /// Several puts and erases, in order, each returning what the single operation would (rows changed): exactly the
    /// same as asking them one at a time. The first refusal ends the batch with its error and the writes before it stay
    /// done (inside a scope its rollback undoes them; `changes` may not count them). A supply on a network sends the
    /// whole batch in one request. The default asks one at a time.
    fn write_many(&self, writes: &[Write<'_>]) -> Result<Vec<u64>> {
        writes
            .iter()
            .map(|write| match write {
                Write::Put { family, row, when } => self.put(family, row, *when),
                Write::Erase { family, range } => self.erase(family, range),
            })
            .collect()
    }
    /// How many rows a range holds (its limit, if any, caps the count). The supply counts without returning rows.
    fn count(&self, family: &str, range: &Range<'_>) -> Result<u64>;
    /// Remove the rows of a range. A limit is not supported. Returns the number of rows removed.
    fn erase(&self, family: &str, range: &Range<'_>) -> Result<u64>;
    /// Whether the declared family exists in this storage.
    fn present(&self, family: &str) -> Result<bool>;
    /// Prepare the physical shapes of these declared families before an owner
    /// captures its unchanged-schema witness. This creates no logical rows and
    /// joins the caller's already-held write scope. Validation of all names
    /// precedes preparation; rollback removes any prepared shapes. Supplies
    /// unable to make this guarantee refuse rather than changing shape later.
    fn prepare_declared_families(&self, _names: &[&str]) -> Result<()> {
        Err(crate::cause!(Error::Unavailable))
    }
    /// The supplied handle is still the one opened, with its declared access.
    fn custody(&self) -> Result<()>;
    /// Where this storage lives, when it is a named location.
    fn location(&self) -> Option<&str>;
    /// Whether a scope is open on this handle.
    fn scoped(&self) -> bool;
    /// Whether this handle holds the write reservation.
    fn writing(&self) -> Result<bool>;
    /// Rows changed through this handle since it was opened.
    fn changes(&self) -> u64;
    /// A mark that moves whenever a handle other than this one commits a change to this storage. Every supply here
    /// takes this handle's own commits out (SQLite's `data_version`; the memory, SQL and key-value supplies count their
    /// own), but a supply may still move it on a commit of its own whose outcome it did not learn (a failed close), so a
    /// moved mark means "the storage may have changed since the last reading", never "another handle changed it". Compare it only with an earlier reading from the
    /// same handle; an unmoved mark means no other handle committed. Read inside a write scope, it covers every commit
    /// made before the scope took the write reservation: an owner that caches what it derived from stored rows (record store's
    /// newest stamps and search memory) reads it there and drops the cache when it moved.
    fn mark(&self) -> Result<i64>;
    /// A mark that moves when the storage's declared shape changes (a family added, altered or dropped).
    fn schema_mark(&self) -> Result<i64>;
    /// Bytes the storage occupies for its rows and orders (not counting logs a supply keeps beside it).
    fn allocated_bytes(&self) -> Result<u64>;
    /// Rewrite the storage so the bytes of removed rows leave its files (a removed row may otherwise survive in free
    /// space, including copies B-tree rebalancing left there). Refused inside a scope. Costs a pass over the storage.
    /// A supply that cannot rewrite its storage answers `Unavailable`; its owner keeps the bytes until it can.
    fn reclaim(&self) -> Result<()> {
        Err(crate::cause!(Error::Unavailable))
    }
    /// One short step of giving the space of removed rows back to the volume, outside any scope: at most `pages` pages
    /// (the supply's unit of space) leave the storage's free space, and the answer is how many free pages are left
    /// for later steps. A step holds the storage no longer than its own pages take, so an owner runs steps between
    /// requests (an idle tick), never inside one. A log beside the storage that could still hold an earlier image of a
    /// removed row is not a step's: its owner clears it beside the storage, off any hold (`sqlite::LogKeeper`). A
    /// supply that gives no space back in steps answers `Unavailable`; its owner keeps the space.
    fn reclaim_step(&self, _pages: u64) -> Result<u64> {
        Err(crate::cause!(Error::Unavailable))
    }
    /// The file's vacuum state (what an owner's vacuum decision reads): whether it is already incremental, its free and
    /// total pages, and the page size. None where the supply keeps no file of its own.
    fn vacuum_state(&self) -> Result<Option<VacuumState>> {
        Ok(None)
    }
    /// Whether a removal overwrites the removed row's bytes as it commits, so nothing of a destroyed record survives
    /// in the storage's free space whatever later steps do. A supply that keeps no bytes of its own after a removal
    /// (memory, a remote service) answers true; record store releases a destroyed record from custody only on one that does.
    fn overwrites_removed(&self) -> Result<bool> {
        Ok(true)
    }
    /// Capture a nested checkpoint in this exact already-held write session.
    /// No checkpoint can be recreated after its outer session has ended.
    /// Unsupported suppliers refuse before command effects are dispatched.
    fn checkpoint(&self) -> Result<Checkpoint> { Err(crate::cause!(Error::Unavailable)) }
    /// Consume that exact checkpoint, preserving its changes on commit or
    /// undoing only its changes on rollback. A failed close is never retried;
    /// the supplier must retain unresolved state and forbid unsafe ancestor
    /// closes. An unrelated handle cannot close or adopt this checkpoint.
    fn close_checkpoint(&self, _checkpoint: Checkpoint, _commit: bool) -> Result<()> {
        Err(crate::cause!(Error::Unavailable))
    }
    /// Open a scope. Owners call `Scope::begin`, which closes it.
    fn open_scope(&self, intent: Intent) -> Result<()>;
    /// Close the open scope, committing or rolling back.
    fn close_scope(&self, commit: bool) -> Result<()>;
}

/// A logical read floor, supplied by the resource's admitted history owner.
/// `scope` binds the complete canonical account/resource identity; `history`
/// binds its incarnation/lineage independently of authority and rights revisions.
/// Both are fixed content identities, not paths, labels or a handle's `mark()`.
/// This is inclusion evidence only: it never grants permission to read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReadPosition {
    pub scope: [u8; 32],
    pub history: [u8; 32],
    pub position: u64,
}

/// An open scope on one storage. Dropping it unfinished rolls it back.
pub struct Scope<'a> {
    storage: &'a dyn Storage,
    open: bool,
    close_attempted: bool,
}
impl<'a> Scope<'a> {
    /// Begin a tokenless current read on the selected authoritative supply.
    /// A previously opened snapshot cannot qualify: it might predate an
    /// acknowledged command. Check custody at the fresh boundary; operation
    /// owners still check current rights before disclosing the returned bytes.
    /// No handle-local `mark` is treated as a cross-handle commit position.
    pub fn current_read(storage: &'a dyn Storage) -> Result<Self> {
        if storage.scoped() {
            return Err(crate::cause!(Error::Invalid));
        }
        storage.custody()?;
        let scope = Self::begin(storage, Intent::Read)?;
        storage.custody()?;
        Ok(scope)
    }
    /// Open a fresh snapshot and qualify its OWN persisted frontier against a
    /// previously acknowledged floor. The observer must read the selected
    /// resource's history header and applied frontier through this scope, never
    /// an adjacent handle or cache. Keep the returned position with this scope's
    /// rows. A later update or deletion is valid; a different history is not.
    ///
    /// There is one observation and no polling/catch-up loop: a lagged replica
    /// or a far-future untrusted floor refuses within the caller's storage budget.
    /// Resource owners authenticate/validate external evidence and current rights;
    /// this helper does not make a caller-supplied identity authoritative.
    pub fn current_read_after(
        storage: &'a dyn Storage,
        minimum: ReadPosition,
        observe: impl FnOnce(&Self) -> Result<ReadPosition>,
    ) -> Result<(Self, ReadPosition)> {
        let scope = Self::current_read(storage)?;
        let seen = observe(&scope)?;
        if seen.scope != minimum.scope || seen.history != minimum.history {
            return Err(crate::cause!(Error::Conflict));
        }
        if seen.position < minimum.position {
            return Err(crate::cause!(Error::Unavailable));
        }
        Ok((scope, seen))
    }

    pub fn begin(storage: &'a dyn Storage, intent: Intent) -> Result<Self> {
        storage.open_scope(intent)?;
        Ok(Self { storage, open: true, close_attempted: false })
    }
    /// Commit this scope. An error leaves the outcome unresolved; dropping the consumed scope will not issue a
    /// second boundary operation that could close an ancestor after the first close took effect.
    pub fn commit(mut self) -> Result<()> {
        let result = self.storage.close_scope(true);
        self.close_attempted = true;
        if result.is_ok() {
            self.open = false;
        }
        result
    }
    /// Roll back this scope. On error the outcome remains unresolved and is not retried by `Drop`.
    pub fn rollback(mut self) -> Result<()> {
        let result = self.storage.close_scope(false);
        self.close_attempted = true;
        if result.is_ok() {
            self.open = false;
        }
        result
    }
}
impl<'a> Deref for Scope<'a> {
    type Target = dyn Storage + 'a;
    fn deref(&self) -> &Self::Target {
        self.storage
    }
}
impl Drop for Scope<'_> {
    fn drop(&mut self) {
        if self.open && !self.close_attempted {
            // Drop cannot return a rollback error. The supply must retain that unresolved state and refuse unsafe
            // follow-up closes rather than letting an ancestor scope act on this one. Once an explicit close
            // returns an error, its outcome may be unknown, so Drop does not issue a second boundary operation.
            let _ = self.storage.close_scope(false);
        }
    }
}

/// A supply behind a pointer is the supply: every operation goes to the one it points at, unchanged (a computer opens its
/// stores as `Box<dyn Storage + Send>`, whichever supply its storage is, and lends one by reference into a write).
macro_rules! storage_through {
    ($($pointer:tt)*) => {
        impl<T: Storage + ?Sized> Storage for $($pointer)* {
            fn schema(&self) -> &'static Schema { (**self).schema() }
            fn get(&self, family: &str, key: &[Value], read: &[Read<'_>]) -> Result<Option<Row>> { (**self).get(family, key, read) }
            fn scan(&self, family: &str, range: &Range<'_>, read: &[Read<'_>]) -> Result<Vec<Row>> { (**self).scan(family, range, read) }
            fn read_many(&self, queries: &[Query<'_>]) -> Result<Vec<Reply>> { (**self).read_many(queries) }
            fn put(&self, family: &str, row: &[(&str, Value)], when: When<'_>) -> Result<u64> { (**self).put(family, row, when) }
            fn write_many(&self, writes: &[Write<'_>]) -> Result<Vec<u64>> { (**self).write_many(writes) }
            fn count(&self, family: &str, range: &Range<'_>) -> Result<u64> { (**self).count(family, range) }
            fn erase(&self, family: &str, range: &Range<'_>) -> Result<u64> { (**self).erase(family, range) }
            fn present(&self, family: &str) -> Result<bool> { (**self).present(family) }
            fn prepare_declared_families(&self, names: &[&str]) -> Result<()> { (**self).prepare_declared_families(names) }
            fn custody(&self) -> Result<()> { (**self).custody() }
            fn location(&self) -> Option<&str> { (**self).location() }
            fn scoped(&self) -> bool { (**self).scoped() }
            fn writing(&self) -> Result<bool> { (**self).writing() }
            fn changes(&self) -> u64 { (**self).changes() }
            fn mark(&self) -> Result<i64> { (**self).mark() }
            fn schema_mark(&self) -> Result<i64> { (**self).schema_mark() }
            fn allocated_bytes(&self) -> Result<u64> { (**self).allocated_bytes() }
            fn reclaim(&self) -> Result<()> { (**self).reclaim() }
            fn reclaim_step(&self, pages: u64) -> Result<u64> { (**self).reclaim_step(pages) }
            fn vacuum_state(&self) -> Result<Option<VacuumState>> { (**self).vacuum_state() }
            fn overwrites_removed(&self) -> Result<bool> { (**self).overwrites_removed() }
            fn checkpoint(&self) -> Result<Checkpoint> { (**self).checkpoint() }
            fn close_checkpoint(&self, checkpoint: Checkpoint, commit: bool) -> Result<()> { (**self).close_checkpoint(checkpoint, commit) }
            fn open_scope(&self, intent: Intent) -> Result<()> { (**self).open_scope(intent) }
            fn close_scope(&self, commit: bool) -> Result<()> { (**self).close_scope(commit) }
        }
    };
}
storage_through!(Box<T>);
storage_through!(&T);
