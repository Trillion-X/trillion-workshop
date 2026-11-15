//! Observe the existing SQLite executor without adding or replaying SQL.
//!
//! The existing source opener owns paths, rights, SQL and connection policy.
//! This owner only occupies that connection's exclusively supplied trace callback.
//! Prepared unexpanded SQL is transiently classified into fixed families only;
//! normal builds retain no SQL, parameters, values or arbitrary identifiers.
//! A feature-scoped, explicitly enabled fixture capture may retain unexpanded
//! templates in bounded in-memory entries; its Debug output remains redacted.
//! Actual SQLite loop visits are distinct from returned rows and from
//! provider billing. Counter failure/incompleteness is never an observed zero.

#[cfg(any(test, feature = "sql-statement-attribution"))]
mod statements;
#[cfg(any(test, feature = "sql-statement-attribution"))]
pub use statements::{StatementSnapshot, StatementWork};

use crate::scan::ReadWork;
use rusqlite::{ffi, Connection};
use std::{
    ffi::c_void,
    fmt,
    ops::Deref,
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicPtr, AtomicU64, AtomicU8, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const MAX_ACTIVE: usize = 64;
const MAX_LOOPS: i32 = 256;
const MAX_SQL_BYTES: usize = 16 * 1024;
const MAX_TOKENS: usize = 768;
const MAX_DEPTH: usize = 64;
const MASK: u32 =
    (ffi::SQLITE_TRACE_STMT | ffi::SQLITE_TRACE_ROW | ffi::SQLITE_TRACE_PROFILE) as u32;
#[derive(Clone, Copy)]
struct BudgetLimits {
    sql: u64,
    rows: u64,
    bytes: u64,
    vm: u64,
    elapsed: Duration,
}
impl BudgetLimits {
    const INVOCATION: Self = Self {
        sql: 128,
        rows: 4096,
        bytes: 8 * 1024 * 1024,
        vm: 2_000_000,
        elapsed: Duration::from_secs(5),
    };
}

/// Closed reasons for the shared invocation ceiling. No source text or caller
/// supplied diagnostics are retained in the meter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum BudgetStop {
    None = 0,
    Sql = 1,
    Rows = 2,
    Bytes = 3,
    Vm = 4,
    Deadline = 5,
    Cancelled = 6,
    Inactive = 7,
    Overflow = 8,
}

impl BudgetStop {
    fn from_raw(value: u8) -> Self {
        match value {
            1 => Self::Sql,
            2 => Self::Rows,
            3 => Self::Bytes,
            4 => Self::Vm,
            5 => Self::Deadline,
            6 => Self::Cancelled,
            7 => Self::Inactive,
            8 => Self::Overflow,
            _ => Self::None,
        }
    }
}

struct InvocationBudgetState {
    limits: BudgetLimits,
    started: Instant,
    cancelled: Arc<AtomicBool>,
    stopped: AtomicU8,
    sql: AtomicU64,
    rows: AtomicU64,
    bytes: AtomicU64,
    vm: AtomicU64,
}

impl InvocationBudgetState {
    fn stop(&self, reason: BudgetStop) -> BudgetStop {
        let _ = self.stopped.compare_exchange(
            BudgetStop::None as u8,
            reason as u8,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        BudgetStop::from_raw(self.stopped.load(Ordering::Acquire))
    }

    fn check(&self) -> BudgetStop {
        let stopped = BudgetStop::from_raw(self.stopped.load(Ordering::Acquire));
        if stopped != BudgetStop::None {
            return stopped;
        }
        if self.cancelled.load(Ordering::Acquire) {
            return self.stop(BudgetStop::Cancelled);
        }
        if self.started.elapsed() >= self.limits.elapsed {
            return self.stop(BudgetStop::Deadline);
        }
        BudgetStop::None
    }

    fn charge(&self, counter: &AtomicU64, amount: u64, ceiling: u64, reason: BudgetStop) -> BudgetStop {
        let state = self.check();
        if state != BudgetStop::None {
            return state;
        }
        loop {
            let old = counter.load(Ordering::Acquire);
            let Some(next) = old.checked_add(amount) else {
                return self.stop(BudgetStop::Overflow);
            };
            if next > ceiling {
                return self.stop(reason);
            }
            if counter.compare_exchange_weak(old, next, Ordering::AcqRel, Ordering::Acquire).is_ok() {
                return self.check();
            }
        }
    }
}

#[derive(Clone, Debug)]
pub enum Error {
    Unsupported(crate::refusal_cause::Cause),
    PreparedStatements(crate::refusal_cause::Cause),
    Hook(crate::refusal_cause::Cause),
    Busy(crate::refusal_cause::Cause),
    Incomplete(crate::refusal_cause::Cause),
    Overflow(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Unsupported(cause) => cause,
            Self::PreparedStatements(cause) => cause,
            Self::Hook(cause) => cause,
            Self::Busy(cause) => cause,
            Self::Incomplete(cause) => cause,
            Self::Overflow(cause) => cause,
        }
    }
}

impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool {
        match (self,other) {
            (Self::Unsupported(_),Self::Unsupported(_)) => true,
            (Self::PreparedStatements(_),Self::PreparedStatements(_)) => true,
            (Self::Hook(_),Self::Hook(_)) => true,
            (Self::Busy(_),Self::Busy(_)) => true,
            (Self::Incomplete(_),Self::Incomplete(_)) => true,
            (Self::Overflow(_),Self::Overflow(_)) => true,
            _ => false,
        }
    }
}
impl Eq for Error {}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Unsupported(_) => "SQLite work observation is unsupported",
            Self::PreparedStatements(_) => {
                "SQLite work observation requires an unborrowed fresh executor"
            }
            Self::Hook(_) => "SQLite work observation hook refused",
            Self::Busy(_) => "SQLite work observation is changing",
            Self::Incomplete(_) => "SQLite work observation is incomplete",
            Self::Overflow(_) => "SQLite work observation counters overflowed",
        })
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

/// Fixed diagnostic families, not configurable labels or an execution schema.
/// A mixed/unsupported statement remains Other instead of a guessed attribution.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[repr(u8)]
pub enum Family {
    #[serde(rename = "schema_catalogue")]
    Catalogue,
    #[serde(rename = "schema_columns")]
    Columns,
    #[serde(rename = "kept_pages_index")]
    Kept,
    #[serde(rename = "projection_frontier")]
    Projection,
    #[serde(rename = "journal")]
    Journal,
    #[serde(rename = "policy_session")]
    PolicySession,
    #[default]
    #[serde(rename = "other_unclassified")]
    Other,
}
impl Family {
    pub const ALL: [Self; 7] = [
        Self::Catalogue,
        Self::Columns,
        Self::Kept,
        Self::Projection,
        Self::Journal,
        Self::PolicySession,
        Self::Other,
    ];
    pub fn label(self) -> &'static str {
        match self {
            Self::Catalogue => "schema catalogue",
            Self::Columns => "schema columns",
            Self::Kept => "kept pages/index",
            Self::Projection => "projection frontier",
            Self::Journal => "journal",
            Self::PolicySession => "policy/session",
            Self::Other => "other/unclassified",
        }
    }
}
#[derive(Default)]
struct GroupCounters {
    statements: AtomicU64,
    visits: AtomicU64,
    fullscan: AtomicU64,
    vm: AtomicU64,
    rows: AtomicU64,
    writes: AtomicU64,
}
impl GroupCounters {
    fn snapshot(&self) -> ReadWork {
        ReadWork {
            sql_statements: self.statements.load(Ordering::Acquire),
            sqlite_scan_visits: self.visits.load(Ordering::Acquire),
            fullscan_steps: self.fullscan.load(Ordering::Acquire),
            vm_steps: self.vm.load(Ordering::Acquire),
            rows_returned: self.rows.load(Ordering::Acquire),
            rows_written: self.writes.load(Ordering::Acquire),
        }
    }
}

#[derive(Default)]
struct Counters {
    /// Flat account totals are distinct from this context's source/budget counters.
    aggregate: Option<Arc<Counters>>,
    invocation_budget: AtomicPtr<InvocationBudgetState>,
    invocation_budget_readers: AtomicU64,
    writers: AtomicU64,
    version: AtomicU64,
    statements: AtomicU64,
    visits: AtomicU64,
    fullscan: AtomicU64,
    vm: AtomicU64,
    rows: AtomicU64,
    writes: AtomicU64,
    live: AtomicU64,
    unattributed_row_events: AtomicU64,
    active: AtomicU64,
    incomplete: AtomicBool,
    incomplete_events: AtomicU64,
    overflow: AtomicBool,
    groups: [GroupCounters; 7],
    #[cfg(any(test, feature = "sql-statement-attribution"))]
    statements_detail: std::sync::OnceLock<statements::Statements>,
}

fn add(counter: &AtomicU64, value: u64, counters: &Counters) {
    if value == 0 {
        return;
    }
    if counter
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |old| {
            old.checked_add(value)
        })
        .is_err()
    {
        counters.overflow.store(true, Ordering::Release);
    }
}
fn every(counters: &Counters, mut update: impl FnMut(&Counters)) {
    update(counters);
    if let Some(aggregate) = &counters.aggregate { update(aggregate); }
}
fn charge(counters: &Counters, family: Family, work: ReadWork) {
    every(counters, |counters| {
        let group = &counters.groups[family as usize];
        for (total, member, value) in [
            (&counters.statements, &group.statements, work.sql_statements),
            (&counters.visits, &group.visits, work.sqlite_scan_visits),
            (&counters.fullscan, &group.fullscan, work.fullscan_steps),
            (&counters.vm, &group.vm, work.vm_steps),
            (&counters.rows, &group.rows, work.rows_returned),
            (&counters.writes, &group.writes, work.rows_written),
        ] {
            add(total, value, counters);
            add(member, value, counters);
        }
    });
}
#[cfg(any(test, feature = "sql-statement-attribution"))]
fn charge_detail(counters: &Counters, detail: Option<usize>, aggregate_detail: Option<usize>, work: ReadWork) {
    if let Some(capture) = counters.statements_detail.get() { capture.charge(detail, work.clone(), counters); }
    if let Some(aggregate) = &counters.aggregate {
        if let Some(capture) = aggregate.statements_detail.get() { capture.charge(aggregate_detail, work, aggregate); }
    }
}

/// Aggregate only exact connections deliberately attached to this meter. A
/// clone reads counters; it cannot access a connection or grant account rights.
#[derive(Clone)]
pub struct WorkMeter(Arc<Counters>);
impl Default for WorkMeter {
    fn default() -> Self {
        Self(Arc::new(Counters { aggregate: Some(Arc::new(Counters::default())), ..Default::default() }))
    }
}
impl fmt::Debug for WorkMeter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SqliteWorkMeter([aggregate counters])")
    }
}
#[derive(Debug, Clone)]
pub struct Observation {
    pub work: ReadWork,
    pub families: [FamilyWork; 7],
    pub live_connections: u64,
    pub active_statements: u64,
    /// TRACE_ROW events without a matching observed STMT. SQLite's cold
    /// schema loader can emit these. They remain INCLUDED in work.rows_returned;
    /// callers can distinguish them from explicit statement results without
    /// erasing lifecycle work or changing historical aggregate counters.
    pub unattributed_row_events: u64,
}
#[derive(Debug, Clone, serde::Serialize)]
pub struct FamilyWork {
    pub family: Family,
    pub work: ReadWork,
}
impl WorkMeter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Share complete observation totals with a new request context while
    /// giving its connections their own invocation allowance. Dropped requests
    /// leave their completed work in the totals; no child registry is retained.
    pub(crate) fn fork(&self) -> Self {
        Self(Arc::new(Counters { aggregate: Some(self.0.aggregate.as_ref().unwrap_or(&self.0).clone()), ..Default::default() }))
    }

    /// Explicit account observation; source witnesses keep using their local
    /// counters. This view is never attached as another source connection.
    pub(crate) fn account_view(&self) -> Self {
        Self(self.0.aggregate.as_ref().unwrap_or(&self.0).clone())
    }

    /// Start one fixed aggregate allowance shared by every connection attached
    /// to this meter. Hold the returned guard for the entire invocation. A
    /// meter can own only one invocation budget; limits never refill per query.
    pub fn begin_invocation_budget(
        &self,
        cancelled: Arc<AtomicBool>,
    ) -> Result<InvocationBudget, Error> {
        self.begin_with_limits(cancelled, BudgetLimits::INVOCATION)
    }

    #[cfg(test)]
    fn begin_test_budget(
        &self,
        cancelled: Arc<AtomicBool>,
        limits: BudgetLimits,
    ) -> Result<InvocationBudget, Error> {
        self.begin_with_limits(cancelled, limits)
    }

    fn begin_with_limits(
        &self,
        cancelled: Arc<AtomicBool>,
        limits: BudgetLimits,
    ) -> Result<InvocationBudget, Error> {
        if self.0.active.load(Ordering::Acquire) != 0 {
            return Err(crate::cause!(Error::Busy));
        }
        let state = Arc::new(InvocationBudgetState {
            limits,
            started: Instant::now(),
            cancelled,
            stopped: AtomicU8::new(BudgetStop::None as u8),
            sql: AtomicU64::new(0),
            rows: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            vm: AtomicU64::new(0),
        });
        let raw = Arc::into_raw(Arc::clone(&state)) as *mut InvocationBudgetState;
        if self.0.invocation_budget.compare_exchange(
            ptr::null_mut(), raw, Ordering::AcqRel, Ordering::Acquire,
        ).is_err() {
            // SAFETY: the raw strong reference was just created and not published.
            unsafe { drop(Arc::from_raw(raw)); }
            return Err(crate::cause!(Error::Busy));
        }
        Ok(InvocationBudget { state, counters: Arc::clone(&self.0) })
    }

    fn with_budget<T>(&self, use_state: impl FnOnce(&InvocationBudgetState) -> T) -> Option<T> {
        self.0.invocation_budget_readers.fetch_add(1, Ordering::AcqRel);
        let raw = self.0.invocation_budget.load(Ordering::Acquire);
        let result = if raw.is_null() {
            None
        } else {
            // The active reader count keeps the meter-owned Arc reference alive
            // until this call leaves, including across concurrent guard Drop.
            Some(unsafe { use_state(&*raw) })
        };
        self.0.invocation_budget_readers.fetch_sub(1, Ordering::Release);
        result
    }

    /// Refuse before starting the next owner operation when an invocation
    /// ceiling has already been consumed.
    pub fn budget_preflight(&self) -> BudgetStop {
        self.with_budget(InvocationBudgetState::check).unwrap_or(BudgetStop::None)
    }

    /// Charge one real SQLite statement or returned row from the trace owner.
    fn budget_statement(&self) -> BudgetStop {
        self.with_budget(|budget| {
            budget.charge(&budget.sql, 1, budget.limits.sql, BudgetStop::Sql)
        }).unwrap_or(BudgetStop::None)
    }
    fn budget_row(&self) -> BudgetStop {
        self.with_budget(|budget| {
            budget.charge(&budget.rows, 1, budget.limits.rows, BudgetStop::Rows)
        }).unwrap_or(BudgetStop::None)
    }

    /// Charge decoded output before its owned copy is created.
    pub fn budget_charge_bytes(&self, amount: usize) -> BudgetStop {
        self.with_budget(|budget| {
            budget.charge(&budget.bytes, amount as u64, budget.limits.bytes, BudgetStop::Bytes)
        }).unwrap_or(BudgetStop::None)
    }

    /// Reserve bounded output before a reader materializes it. Reservations
    /// make concurrent connections share one ceiling; dropping an unsettled
    pub fn budget_reserve_bytes(&self, amount: usize) -> Result<BudgetReservation, crate::refusal_cause::CodedError<BudgetStop>> {
        let amount = u64::try_from(amount).map_err(|_| crate::refusal_cause::CodedError::new(BudgetStop::Overflow))?;
        let reserved = self.with_budget(|budget| {
            let stop = budget.charge(&budget.bytes, amount, budget.limits.bytes, BudgetStop::Bytes);
            if stop == BudgetStop::None {
                let raw = budget as *const InvocationBudgetState;
                // SAFETY: with_budget's reader pin guarantees the meter-owned
                // Arc strong reference remains alive for this increment.
                unsafe { Arc::increment_strong_count(raw); }
                (stop, Some(unsafe { Arc::from_raw(raw) }))
            } else { (stop, None) }
        });
        let Some((stop, state)) = reserved else {
            return Ok(BudgetReservation { state: None, amount, settled: false });
        };
        if stop != BudgetStop::None { return Err(crate::refusal_cause::CodedError::new(stop)); }
        Ok(BudgetReservation { state, amount, settled: false })
    }

    /// Called by the already-owned per-connection progress callback. A unit is
    /// one SQLite VM instruction when invocation budgeting is active.
    pub fn budget_progress(&self, vm_units: u64) -> BudgetStop {
        self.with_budget(|budget| {
            budget.charge(&budget.vm, vm_units, budget.limits.vm, BudgetStop::Vm)
        }).unwrap_or(BudgetStop::None)
    }

    /// Remaining result materialization available to a bounded query owner.
    pub fn budget_remaining(&self) -> Option<(usize, usize)> {
        self.with_budget(|budget| {
            if budget.check() != BudgetStop::None { return (0, 0); }
            let rows = budget.limits.rows.saturating_sub(budget.rows.load(Ordering::Acquire));
            let bytes = budget.limits.bytes.saturating_sub(budget.bytes.load(Ordering::Acquire));
            (rows as usize, bytes as usize)
        })
    }

    pub fn budget_stop(&self) -> BudgetStop {
        self.budget_preflight()
    }

    /// A bounded, non-blocking coherent counter read. Completed statements can
    /// be observed while connections remain open. Active statements explicitly
    /// distinguish their uncompleted work from a finished observation.
    pub fn snapshot(&self) -> Result<Observation, Error> {
        self.sample(false).map(|(observed, _)| observed)
    }

    /// Observe a bounded caller operation after its fixture/startup work. No
    /// failure flag is reset. Any new coverage failure during the window makes
    /// its result unavailable, even if the lifetime was already incomplete.
    pub fn begin_observation(&self) -> Result<ObservationWindow, Error> {
        let (before, failures) = self.sample(true)?;
        if before.active_statements != 0 { return Err(crate::cause!(Error::Busy)); }
        Ok(ObservationWindow { meter: self.clone(), before, failures })
    }

    fn sample(&self, window: bool) -> Result<(Observation, u64), Error> {
        for _ in 0..8 {
            if self.0.writers.load(Ordering::Acquire) != 0 {
                continue;
            }
            let version = self.0.version.load(Ordering::Acquire);
            let answer = Observation {
                work: ReadWork {
                    sql_statements: self.0.statements.load(Ordering::Acquire),
                    sqlite_scan_visits: self.0.visits.load(Ordering::Acquire),
                    fullscan_steps: self.0.fullscan.load(Ordering::Acquire),
                    vm_steps: self.0.vm.load(Ordering::Acquire),
                    rows_returned: self.0.rows.load(Ordering::Acquire),
                    rows_written: self.0.writes.load(Ordering::Acquire),
                },
                families: std::array::from_fn(|index| FamilyWork {
                    family: Family::ALL[index],
                    work: self.0.groups[index].snapshot(),
                }),
                live_connections: self.0.live.load(Ordering::Acquire),
                active_statements: self.0.active.load(Ordering::Acquire),
                unattributed_row_events: self.0.unattributed_row_events.load(Ordering::Acquire),
            };
            let incomplete = self.0.incomplete.load(Ordering::Acquire);
            let failures = self.0.incomplete_events.load(Ordering::Acquire);
            let overflow = self.0.overflow.load(Ordering::Acquire);
            if self.0.writers.load(Ordering::Acquire) == 0
                && self.0.version.load(Ordering::Acquire) == version
            {
                return if overflow {
                    Err(crate::cause!(Error::Overflow))
                } else if incomplete && !window {
                    Err(crate::cause!(Error::Incomplete))
                } else {
                    Ok((answer, failures))
                };
            }
        }
        Err(crate::cause!(Error::Busy))
    }
}

/// A caller-operation interval over complete attached-account totals. A
/// window neither changes execution budgets nor clears a previous failure.
pub struct ObservationWindow {
    meter: WorkMeter,
    before: Observation,
    failures: u64,
}
impl ObservationWindow {
    pub fn finish(self) -> Result<Observation, Error> {
        let (mut after, failures) = self.meter.sample(true)?;
        if failures != self.failures { return Err(crate::cause!(Error::Incomplete)); }
        if after.active_statements != 0 { return Err(crate::cause!(Error::Busy)); }
        fn delta(after: &ReadWork, before: &ReadWork) -> Result<ReadWork, Error> {
            let sub = |a: u64, b: u64| a.checked_sub(b).ok_or(crate::cause!(Error::Incomplete));
            Ok(ReadWork {
                sql_statements: sub(after.sql_statements, before.sql_statements)?,
                sqlite_scan_visits: sub(after.sqlite_scan_visits, before.sqlite_scan_visits)?,
                fullscan_steps: sub(after.fullscan_steps, before.fullscan_steps)?,
                vm_steps: sub(after.vm_steps, before.vm_steps)?,
                rows_returned: sub(after.rows_returned, before.rows_returned)?,
                rows_written: sub(after.rows_written, before.rows_written)?,
            })
        }
        after.work = delta(&after.work, &self.before.work)?;
        for (after, before) in after.families.iter_mut().zip(&self.before.families) {
            after.work = delta(&after.work, &before.work)?;
        }
        after.unattributed_row_events = after.unattributed_row_events
            .checked_sub(self.before.unattributed_row_events).ok_or(crate::cause!(Error::Incomplete))?;
        Ok(after)
    }
}

/// Lifetime token for a single meter-wide invocation budget.
pub struct InvocationBudget {
    state: Arc<InvocationBudgetState>,
    counters: Arc<Counters>,
}

pub struct BudgetReservation {
    state: Option<Arc<InvocationBudgetState>>,
    amount: u64,
    settled: bool,
}
impl fmt::Debug for BudgetReservation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SqliteBudgetReservation([bounded output])")
    }
}
impl BudgetReservation {
    /// Settle a successful query at its exact returned byte count and return
    /// the unused portion to the same invocation-wide pool.
    pub fn settle(mut self, actual: usize) -> BudgetStop {
        let Ok(actual) = u64::try_from(actual) else {
            if let Some(budget) = &self.state { budget.stop(BudgetStop::Overflow); }
            self.settled = true;
            return BudgetStop::Overflow;
        };
        if actual > self.amount {
            if let Some(budget) = &self.state { budget.stop(BudgetStop::Bytes); }
            self.settled = true;
            return BudgetStop::Bytes;
        }
        if let Some(budget) = &self.state {
            let released = self.amount - actual;
            let old = budget.bytes.fetch_sub(released, Ordering::AcqRel);
            if old < released {
                budget.stop(BudgetStop::Overflow);
                self.settled = true;
                return BudgetStop::Overflow;
            }
            let result = budget.check();
            self.settled = true;
            return result;
        }
        self.settled = true;
        BudgetStop::None
    }
}
impl fmt::Debug for InvocationBudget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SqliteInvocationBudget([aggregate limits])")
    }
}
impl Drop for InvocationBudget {
    fn drop(&mut self) {
        let raw = Arc::as_ptr(&self.state) as *mut InvocationBudgetState;
        if self.counters.invocation_budget.compare_exchange(
            raw, ptr::null_mut(), Ordering::AcqRel, Ordering::Acquire,
        ).is_ok() {
            while self.counters.invocation_budget_readers.load(Ordering::Acquire) != 0 {
                std::hint::spin_loop();
            }
            // SAFETY: compare_exchange removed the meter-owned reference, and
            // all callback/reservation readers have drained above.
            unsafe { drop(Arc::from_raw(raw)); }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TokenKind {
    Bare,
    Quoted,
    Literal,
    Symbol(u8),
}
#[derive(Clone, Copy)]
struct Token {
    start: usize,
    end: usize,
    kind: TokenKind,
}
const EMPTY_TOKEN: Token = Token {
    start: 0,
    end: 0,
    kind: TokenKind::Symbol(0),
};
/// A statement's tokens, at most `MAX_TOKENS`. They grow as they are found: a fixed array of `MAX_TOKENS` was zeroed
/// and moved for every traced statement, the largest cost of tracing a short one.
struct Tokens<'a> {
    sql: &'a [u8],
    tokens: Vec<Token>,
    len: usize,
}
impl Tokens<'_> {
    fn bytes(&self, token: Token) -> &[u8] {
        &self.sql[token.start..token.end]
    }
    fn word(&self, token: Token, word: &[u8]) -> bool {
        token.kind == TokenKind::Bare && self.bytes(token).eq_ignore_ascii_case(word)
    }
    fn identifier(&self, token: Token, word: &[u8]) -> bool {
        matches!(token.kind, TokenKind::Bare | TokenKind::Quoted)
            && self.bytes(token).eq_ignore_ascii_case(word)
    }
    fn same_identifier(&self, left: Token, right: Token) -> bool {
        matches!(left.kind, TokenKind::Bare | TokenKind::Quoted)
            && matches!(right.kind, TokenKind::Bare | TokenKind::Quoted)
            && self.bytes(left).eq_ignore_ascii_case(self.bytes(right))
    }
}
fn tokenize(sql: &[u8]) -> Option<Tokens<'_>> {
    let mut out = Tokens {
        sql,
        tokens: Vec::with_capacity(32),
        len: 0,
    };
    let mut index = 0;
    while index < sql.len() {
        let byte = sql[index];
        if byte.is_ascii_whitespace() {
            index += 1;
            continue;
        }
        if byte == b'-' && sql.get(index + 1) == Some(&b'-') {
            index += 2;
            while index < sql.len() && sql[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if byte == b'/' && sql.get(index + 1) == Some(&b'*') {
            index += 2;
            while index + 1 < sql.len() && !(sql[index] == b'*' && sql[index + 1] == b'/') {
                index += 1;
            }
            if index + 1 >= sql.len() {
                return None;
            }
            index += 2;
            continue;
        }
        if out.len == MAX_TOKENS {
            return None;
        }
        let token = if matches!(byte, b'@' | b':' | b'$')
            && sql
                .get(index + 1)
                .is_some_and(|next| next.is_ascii_alphanumeric() || *next == b'_' || *next >= 128)
        {
            let start = index;
            index += 1;
            while index < sql.len()
                && (sql[index].is_ascii_alphanumeric()
                    || matches!(sql[index], b'_' | b'$')
                    || sql[index] >= 128
                    || (byte == b'$' && sql[index] == b':'))
            {
                index += 1;
            }
            if byte == b'$' && sql.get(index) == Some(&b'(') {
                index += 1;
                while *sql.get(index)? != b')' {
                    index += 1;
                }
                index += 1;
            }
            Token {
                start,
                end: index,
                kind: TokenKind::Literal,
            }
        } else if byte == b'?' {
            let start = index;
            index += 1;
            while sql.get(index).is_some_and(u8::is_ascii_digit) {
                index += 1;
            }
            Token {
                start,
                end: index,
                kind: TokenKind::Literal,
            }
        } else if matches!(byte, b'\'' | b'"' | b'`' | b'[') {
            let close = if byte == b'[' { b']' } else { byte };
            index += 1;
            let start = index;
            loop {
                let next = *sql.get(index)?;
                if next == close {
                    if byte != b'[' && sql.get(index + 1) == Some(&close) {
                        index += 2;
                        continue;
                    }
                    break;
                }
                index += 1;
            }
            let token = Token {
                start,
                end: index,
                kind: if byte == b'\'' {
                    TokenKind::Literal
                } else {
                    TokenKind::Quoted
                },
            };
            index += 1;
            token
        } else if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$' || byte >= 128 {
            let start = index;
            index += 1;
            while index < sql.len()
                && (sql[index].is_ascii_alphanumeric()
                    || matches!(sql[index], b'_' | b'$')
                    || sql[index] >= 128)
            {
                index += 1;
            }
            Token {
                start,
                end: index,
                kind: TokenKind::Bare,
            }
        } else {
            index += 1;
            Token {
                start: index - 1,
                end: index,
                kind: TokenKind::Symbol(byte),
            }
        };
        out.tokens.push(token);
        out.len += 1;
    }
    Some(out)
}
fn table_family(tokens: &Tokens<'_>, token: Token) -> Family {
    if !matches!(token.kind, TokenKind::Bare | TokenKind::Quoted) {
        return Family::Other;
    }
    let name = tokens.bytes(token);
    if [
        b"sqlite_schema".as_slice(),
        b"sqlite_master",
        b"sqlite_temp_schema",
        b"sqlite_temp_master",
    ]
    .iter()
    .any(|known| name.eq_ignore_ascii_case(known))
    {
        return Family::Catalogue;
    }
    if name.eq_ignore_ascii_case(b"pragma_table_info") {
        return Family::Columns;
    }
    if name.eq_ignore_ascii_case(b"record_keys_runs")
        || name.eq_ignore_ascii_case(b"record_keys_big")
    {
        return Family::Kept;
    }
    if name.len() > 16
        && name[..16].eq_ignore_ascii_case(b"record_keys_run_")
        && name[16..].iter().all(u8::is_ascii_digit)
    {
        return Family::Kept;
    }
    if name.eq_ignore_ascii_case(b"record_keys_meta") {
        return Family::Projection;
    }
    if name.eq_ignore_ascii_case(b"record_log")
        || (name.len() > 18
            && name[..18].eq_ignore_ascii_case(b"record_log_sealed_")
            && name[18..]
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_'))
    {
        return Family::Journal;
    }
    if name.eq_ignore_ascii_case(b"policy_directory") || name.eq_ignore_ascii_case(b"_mf_entries") {
        return Family::PolicySession;
    }
    Family::Other
}
fn after_parentheses(tokens: &Tokens<'_>, start: usize) -> Option<usize> {
    if tokens.tokens.get(start)?.kind != TokenKind::Symbol(b'(') {
        return None;
    }
    let mut depth = 0_usize;
    for index in start..tokens.len {
        match tokens.tokens[index].kind {
            TokenKind::Symbol(b'(') => {
                depth += 1;
                if depth > MAX_DEPTH {
                    return None;
                }
            }
            TokenKind::Symbol(b')') => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(index + 1);
                }
            }
            _ => {}
        }
    }
    None
}
// Gather CTE aliases first so lexical table references cannot mistake a local
// CTE named record_log for that physical table. Explicit schema qualification
// still denotes the physical source. Unsupported WITH syntax stays Other.
fn cte_names(tokens: &Tokens<'_>, start: usize, names: &mut [Token; MAX_DEPTH]) -> Option<usize> {
    if start >= tokens.len || !tokens.word(tokens.tokens[start], b"with") {
        return Some(0);
    }
    let mut index = start + 1;
    if index < tokens.len && tokens.word(tokens.tokens[index], b"recursive") {
        index += 1;
    }
    let mut count = 0;
    loop {
        let name = *tokens.tokens.get(index).filter(|_| index < tokens.len)?;
        if count == MAX_DEPTH || !matches!(name.kind, TokenKind::Bare | TokenKind::Quoted) {
            return None;
        }
        names[count] = name;
        count += 1;
        index += 1;
        if index < tokens.len && tokens.tokens[index].kind == TokenKind::Symbol(b'(') {
            index = after_parentheses(tokens, index)?;
        }
        if index >= tokens.len || !tokens.word(tokens.tokens[index], b"as") {
            return None;
        }
        index += 1;
        if index < tokens.len && tokens.word(tokens.tokens[index], b"not") {
            index += 1;
            if index >= tokens.len || !tokens.word(tokens.tokens[index], b"materialized") {
                return None;
            }
            index += 1;
        } else if index < tokens.len && tokens.word(tokens.tokens[index], b"materialized") {
            index += 1;
        }
        index = after_parentheses(tokens, index)?;
        if index < tokens.len && tokens.tokens[index].kind == TokenKind::Symbol(b',') {
            index += 1;
        } else {
            return Some(count);
        }
    }
}
enum Candidate {
    Virtual,
    Physical(Family),
    Unsupported,
}
fn candidate(tokens: &Tokens<'_>, mut index: usize, ctes: &[Token]) -> Candidate {
    if index >= tokens.len {
        return Candidate::Unsupported;
    }
    if tokens.tokens[index].kind == TokenKind::Symbol(b'(') {
        // Derived subqueries/VALUES are virtual sources. Their own physical
        // FROM/JOIN sources are encountered by the same bounded token walk.
        return Candidate::Virtual;
    }
    let mut qualified = false;
    if index + 2 < tokens.len && tokens.tokens[index + 1].kind == TokenKind::Symbol(b'.') {
        if !matches!(
            tokens.tokens[index].kind,
            TokenKind::Bare | TokenKind::Quoted
        ) {
            return Candidate::Unsupported;
        }
        index += 2;
        qualified = true;
    }
    let name = tokens.tokens[index];
    if !matches!(name.kind, TokenKind::Bare | TokenKind::Quoted) {
        return Candidate::Unsupported;
    }
    if !qualified && ctes.iter().any(|cte| tokens.same_identifier(*cte, name)) {
        return Candidate::Virtual;
    }
    Candidate::Physical(table_family(tokens, name))
}
fn classify(sql: &[u8]) -> Family {
    let Some(tokens) = tokenize(sql) else {
        return Family::Other;
    };
    if tokens.len == 0 {
        return Family::Other;
    }
    let mut first = 0;
    if tokens.word(tokens.tokens[first], b"explain") {
        first += 1;
        if first + 1 < tokens.len
            && tokens.word(tokens.tokens[first], b"query")
            && tokens.word(tokens.tokens[first + 1], b"plan")
        {
            first += 2;
        }
    }
    if first >= tokens.len {
        return Family::Other;
    }
    if tokens.word(tokens.tokens[first], b"pragma") {
        let mut name = first + 1;
        if name + 2 < tokens.len && tokens.tokens[name + 1].kind == TokenKind::Symbol(b'.') {
            if !matches!(
                tokens.tokens[name].kind,
                TokenKind::Bare | TokenKind::Quoted
            ) {
                return Family::Other;
            }
            name += 2;
        }
        return if name < tokens.len && tokens.identifier(tokens.tokens[name], b"table_info") {
            Family::Columns
        } else {
            Family::Other
        };
    }
    if ![
        b"select".as_slice(),
        b"with",
        b"insert",
        b"replace",
        b"update",
        b"delete",
    ]
    .iter()
    .any(|word| tokens.word(tokens.tokens[first], word))
    {
        return Family::Other;
    }
    let mut ctes = [EMPTY_TOKEN; MAX_DEPTH];
    let Some(cte_count) = cte_names(&tokens, first, &mut ctes) else {
        return Family::Other;
    };
    let mut from = [false; MAX_DEPTH + 1];
    let mut depth = 0_usize;
    let mut selected = None;
    for index in 0..tokens.len {
        let token = tokens.tokens[index];
        // Nested WITH scope is intentionally unsupported. Do not classify a
        // shadowing nested CTE as a physical source by flattening its names.
        if index != first && tokens.word(token, b"with") {
            return Family::Other;
        }
        let mut source = None;
        match token.kind {
            TokenKind::Symbol(b'(') => {
                depth += 1;
                if depth > MAX_DEPTH {
                    return Family::Other;
                }
                from[depth] = false;
            }
            TokenKind::Symbol(b')') => {
                let Some(previous) = depth.checked_sub(1) else {
                    return Family::Other;
                };
                depth = previous;
            }
            TokenKind::Symbol(b',') if from[depth] => source = Some(index + 1),
            TokenKind::Bare => {
                if tokens.word(token, b"from") || tokens.word(token, b"join") {
                    from[depth] = true;
                    source = Some(index + 1);
                } else if tokens.word(token, b"into") {
                    source = Some(index + 1);
                } else if tokens.word(token, b"update") {
                    let mut next = index + 1;
                    if next < tokens.len && tokens.word(tokens.tokens[next], b"or") {
                        next += 2;
                    }
                    source = Some(next);
                } else if [
                    b"where".as_slice(),
                    b"group",
                    b"order",
                    b"limit",
                    b"union",
                    b"except",
                    b"intersect",
                    b"returning",
                    b"select",
                    b"set",
                ]
                .iter()
                .any(|word| tokens.word(token, word))
                {
                    from[depth] = false;
                }
            }
            _ => {}
        }
        if let Some(source) = source {
            match candidate(&tokens, source, &ctes[..cte_count]) {
                Candidate::Virtual => {}
                Candidate::Unsupported | Candidate::Physical(Family::Other) => {
                    return Family::Other
                }
                Candidate::Physical(family) => {
                    if selected.is_some_and(|old| old != family) {
                        return Family::Other;
                    }
                    selected = Some(family);
                }
            }
        }
    }
    if depth != 0 {
        Family::Other
    } else {
        selected.unwrap_or(Family::Other)
    }
}
unsafe fn statement_family(statement: *mut ffi::sqlite3_stmt) -> Family {
    let sql = ffi::sqlite3_sql(statement).cast::<u8>();
    if sql.is_null() {
        return Family::Other;
    }
    for length in 0..=MAX_SQL_BYTES {
        if *sql.add(length) == 0 {
            return classify(std::slice::from_raw_parts(sql, length));
        }
    }
    Family::Other
}

/// Only the existing observer mints this weak handle witness. It expires with
/// its actual connection, so a recycled pointer cannot reuse another source.
#[derive(Clone)]
pub(crate) struct SchemaObservation {
    handle: usize,
    epoch: std::sync::Weak<AtomicU64>,
}
impl SchemaObservation {
    pub(crate) fn current(&self, db: &Connection) -> Option<u64> {
        if self.handle != unsafe { db.handle() } as usize { return None; }
        self.epoch.upgrade().and_then(|epoch| {
            let value = epoch.load(Ordering::Acquire);
            (value != u64::MAX).then_some(value)
        })
    }
}

// Bounded lexical classification only; no SQL, allocation or callback. The
// observer invalidates before schema-changing execution and transaction ends.
unsafe fn schema_change(statement: *mut ffi::sqlite3_stmt) -> bool {
    let sql = ffi::sqlite3_sql(statement).cast::<u8>();
    if sql.is_null() { return true; }
    let Some(length) = (0..=MAX_SQL_BYTES).find(|at| *sql.add(*at) == 0) else { return true; };
    let all = std::slice::from_raw_parts(sql, length);
    let mut rest = all;
    loop {
        while rest.first().is_some_and(u8::is_ascii_whitespace) { rest = &rest[1..]; }
        if rest.starts_with(b"--") {
            rest = rest.iter().position(|b| *b == b'\n').map_or(&[], |at| &rest[at+1..]);
        } else if rest.starts_with(b"/*") {
            let Some(at) = rest[2..].windows(2).position(|p| p == b"*/") else { return true; };
            rest = &rest[at+4..];
        } else { break; }
    }
    let word = &rest[..rest.iter().position(|b| !b.is_ascii_alphabetic()).unwrap_or(rest.len())];
    if [b"begin".as_slice(), b"commit", b"end", b"rollback", b"attach", b"detach"].iter().any(|k| word.eq_ignore_ascii_case(k)) { return true; }
    if word.eq_ignore_ascii_case(b"savepoint") && ffi::sqlite3_get_autocommit(ffi::sqlite3_db_handle(statement)) != 0 { return true; }
    if word.eq_ignore_ascii_case(b"pragma") && all.iter().any(|b| matches!(b, b'='|b'(')) { return true; }
    if ffi::sqlite3_stmt_readonly(statement) != 0 { return false; }
    if [b"insert".as_slice(), b"replace", b"update", b"delete"].iter().any(|k| word.eq_ignore_ascii_case(k)) {
        return [b"sqlite_schema".as_slice(), b"sqlite_master"].iter()
            .any(|name| all.windows(name.len()).any(|part| part.eq_ignore_ascii_case(name)));
    }
    true
}

#[derive(Clone, Copy, Default)]
struct StatementCounters {
    visits: u64,
    fullscan: u64,
    vm: u64,
    reprepare: u64,
}
#[derive(Clone, Default)]
struct Active {
    statement: usize,
    before: StatementCounters,
    family: Family,
    request: Option<crate::storage::request_work::RequestWork>,
    #[cfg(any(test, feature = "sql-statement-attribution"))]
    detail: Option<usize>,
    #[cfg(any(test, feature = "sql-statement-attribution"))]
    aggregate_detail: Option<usize>,
}
struct Context {
    meter: WorkMeter,
    schema_epoch: Arc<AtomicU64>,
    active: [Active; MAX_ACTIVE],
    last_changes: i64,
}
impl Context {
    fn incomplete(&self) {
        every(&self.meter.0, |counters| {
            counters.incomplete.store(true, Ordering::Release);
            add(&counters.incomplete_events, 1, counters);
        });
        crate::storage::request_work::RequestWork::uncovered();
        for active in &self.active {
            if let Some(work) = &active.request { work.incomplete(); }
        }
    }
    unsafe fn changes(&mut self, db: *mut ffi::sqlite3, family: Family) {
        let now = ffi::sqlite3_total_changes64(db);
        if let Some(delta) = now.checked_sub(self.last_changes).filter(|v| *v >= 0) {
            charge(
                &self.meter.0,
                family,
                ReadWork {
                    rows_written: delta as u64,
                    ..Default::default()
                },
            );
        } else {
            self.incomplete();
        }
        self.last_changes = now;
    }
}

// Called only for a live statement synchronously supplied by SQLite. The loop
// bound prevents instrumentation from adding unbounded counter work itself.
unsafe fn statement_counters(statement: *mut ffi::sqlite3_stmt) -> Option<StatementCounters> {
    let mut visits = 0_u64;
    let mut ended = false;
    for index in 0..=MAX_LOOPS {
        let mut value = 0_i64;
        if ffi::sqlite3_stmt_scanstatus(
            statement,
            index,
            ffi::SQLITE_SCANSTAT_NVISIT,
            (&mut value as *mut i64).cast(),
        ) != 0
        {
            ended = true;
            break;
        }
        if index == MAX_LOOPS || value < 0 {
            return None;
        }
        visits = visits.checked_add(value as u64)?;
    }
    if !ended {
        return None;
    }
    let counter = |kind| {
        let value = ffi::sqlite3_stmt_status(statement, kind, 0);
        (value >= 0).then_some(value as u64)
    };
    Some(StatementCounters {
        visits,
        fullscan: counter(ffi::SQLITE_STMTSTATUS_FULLSCAN_STEP)?,
        vm: counter(ffi::SQLITE_STMTSTATUS_VM_STEP)?,
        reprepare: counter(ffi::SQLITE_STMTSTATUS_REPREPARE)?,
    })
}

// No allocation, lock, SQL execution, panic-producing unwrap or application
// callback occurs across this FFI boundary. Each Connection serializes its own
// trace calls; moving its owning wrapper does not move this boxed context.
unsafe extern "C" fn trace(
    event: u32,
    context: *mut c_void,
    statement: *mut c_void,
    _: *mut c_void,
) -> i32 {
    if context.is_null() || statement.is_null() {
        return 0;
    }
    let context = &mut *context.cast::<Context>();
    let counters = Arc::clone(&context.meter.0);
    every(&counters, |counters| { counters.writers.fetch_add(1, Ordering::AcqRel); });
    let statement = statement.cast::<ffi::sqlite3_stmt>();
    let identity = statement as usize;
    match event as i32 {
        ffi::SQLITE_TRACE_STMT => {
            // SQLite emits STMT again for trigger subprograms on the same
            // statement; they are not a second prepared statement execution.
            if !context.active.iter().any(|row| row.statement == identity) {
                if schema_change(statement) {
                    let _ = context.schema_epoch.fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| Some(n.saturating_add(1)));
                }
                if context.meter.budget_statement() != BudgetStop::None {
                    // The trace callback's return value is ignored by SQLite.
                    // Interrupt the exact live connection before this newly
                    // started statement executes any VM instruction.
                    ffi::sqlite3_interrupt(ffi::sqlite3_db_handle(statement));
                }
                if let Some(before) = statement_counters(statement) {
                    if let Some(slot) = context.active.iter_mut().find(|row| row.statement == 0) {
                        #[cfg(any(test, feature = "sql-statement-attribution"))]
                        let detail = counters
                            .statements_detail
                            .get()
                            .and_then(|capture| capture.locate(statement));
                        #[cfg(any(test, feature = "sql-statement-attribution"))]
                        let aggregate_detail = counters.aggregate.as_ref().and_then(|aggregate| aggregate.statements_detail.get())
                            .and_then(|capture| capture.locate(statement));
                        *slot = Active {
                            statement: identity,
                            before,
                            family: statement_family(statement),
                            request: crate::storage::request_work::RequestWork::current(),
                            #[cfg(any(test, feature = "sql-statement-attribution"))]
                            detail,
                            #[cfg(any(test, feature = "sql-statement-attribution"))]
                            aggregate_detail,
                        };
                        if let Some(work) = &slot.request {
                            // The prepared executor is the semantic owner. This
                            // excludes transaction controls and mutating RETURNING,
                            // and includes read PRAGMAs regardless of SQL spelling.
                            work.start_statement(ffi::sqlite3_stmt_readonly(statement) != 0
                                && ffi::sqlite3_column_count(statement) > 0);
                        }
                        #[cfg(any(test, feature = "sql-statement-attribution"))]
                        charge_detail(&counters, detail, aggregate_detail, ReadWork { sql_statements: 1, ..Default::default() });
                        charge(
                            &counters,
                            slot.family,
                            ReadWork {
                                sql_statements: 1,
                                ..Default::default()
                            },
                        );
                        every(&counters, |counters| add(&counters.active, 1, counters));
                    } else {
                        context.incomplete();
                    }
                } else {
                    context.incomplete();
                }
            }
        }
        ffi::SQLITE_TRACE_ROW => {
            if context.meter.budget_row() != BudgetStop::None {
                // TRACE_ROW runs before rusqlite can expose/copy this row.
                ffi::sqlite3_interrupt(ffi::sqlite3_db_handle(statement));
            }
            let active = context.active.iter().find(|row| row.statement == identity);
            if let Some(work) = active.and_then(|active| active.request.as_ref()) {
                work.row();
            } else if active.is_none() {
                if let Some(work) = crate::storage::request_work::RequestWork::current() { work.unattributed_row(); }
            }
            if active.is_none() {
                every(&counters, |counters| add(&counters.unattributed_row_events, 1, counters));
            }
            let family = active.map_or(Family::Other, |row| row.family);
            #[cfg(any(test, feature = "sql-statement-attribution"))]
            if let Some(active) = active {
                charge_detail(&counters, active.detail, active.aggregate_detail, ReadWork { rows_returned: 1, ..Default::default() });
            }
            charge(
                &counters,
                family,
                ReadWork {
                    rows_returned: 1,
                    ..Default::default()
                },
            );
        }
        ffi::SQLITE_TRACE_PROFILE => {
            let mut family = Family::Other;
            let mut request = None;
            let mut request_work = None;
            #[cfg(any(test, feature = "sql-statement-attribution"))]
            let mut detail = None;
            #[cfg(any(test, feature = "sql-statement-attribution"))]
            let mut aggregate_detail = None;
            if let Some(slot) = context
                .active
                .iter_mut()
                .find(|row| row.statement == identity)
            {
                let before = slot.before;
                request = slot.request.take();
                family = slot.family;
                #[cfg(any(test, feature = "sql-statement-attribution"))]
                {
                    detail = slot.detail;
                    aggregate_detail = slot.aggregate_detail;
                }
                *slot = Active::default();
                every(&counters, |counters| { counters.active.fetch_sub(1, Ordering::AcqRel); });
                if let Some(after) = statement_counters(statement) {
                    let deltas = (
                        after.visits.checked_sub(before.visits),
                        after.fullscan.checked_sub(before.fullscan),
                        after.vm.checked_sub(before.vm),
                    );
                    if after.reprepare != before.reprepare {
                        context.incomplete();
                    } else if let (Some(visits), Some(fullscan), Some(vm)) = deltas {
                        request_work = Some((visits, vm));
                        #[cfg(any(test, feature = "sql-statement-attribution"))]
                        charge_detail(&counters, detail, aggregate_detail, ReadWork {
                            sqlite_scan_visits: visits, fullscan_steps: fullscan, vm_steps: vm, ..Default::default()
                        });
                        charge(
                            &counters,
                            family,
                            ReadWork {
                                sqlite_scan_visits: visits,
                                fullscan_steps: fullscan,
                                vm_steps: vm,
                                ..Default::default()
                            },
                        );
                    } else {
                        context.incomplete();
                    }
                } else {
                    context.incomplete();
                }
            } else {
                context.incomplete();
            }
            let write_family = if context.active.iter().any(|row| row.statement != 0) {
                // Interleaved/nested executions share total_changes. Avoid
                // attributing another active statement's mutations to this one.
                Family::Other
            } else {
                family
            };
            let before_changes = context.last_changes;
            context.changes(ffi::sqlite3_db_handle(statement), write_family);
            if let Some(work) = request {
                let writes = context.last_changes.checked_sub(before_changes).filter(|n| *n >= 0);
                match (request_work, writes) {
                    (Some((visits, vm)), Some(writes)) => work.finish_statement(visits, vm, writes as u64),
                    _ => { work.incomplete(); work.finish_statement(0, 0, 0); }
                }
            }
            #[cfg(any(test, feature = "sql-statement-attribution"))]
            if let Some(writes) = context.last_changes.checked_sub(before_changes).filter(|n| *n >= 0) {
                let nested = context.active.iter().any(|row| row.statement != 0);
                charge_detail(&counters, if nested { None } else { detail }, if nested { None } else { aggregate_detail },
                    ReadWork { rows_written: writes as u64, ..Default::default() });
            }
        }
        _ => context.incomplete(),
    }
    every(&counters, |counters| {
        counters.version.fetch_add(1, Ordering::Release);
        counters.writers.fetch_sub(1, Ordering::Release);
    });
    0
}

/// An attachment failure retains the original connection for its source owner.
/// Formatting never exposes the handle, SQL, paths or application state.
pub struct AttachFailure {
    pub cause: crate::refusal_cause::Cause,
    pub error: Error,
    connection: Connection,
}
impl AttachFailure {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { &self.cause }
    pub fn into_connection(self) -> Connection {
        self.connection
    }
}
crate::impl_caused!(AttachFailure);
crate::impl_caused!(Error);
impl fmt::Debug for AttachFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.error, f)
    }
}
impl fmt::Display for AttachFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.error, f)
    }
}
impl std::error::Error for AttachFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

/// Moves the existing connection and observer custody together. Root can retain
/// this wrapper when transferring CurrentSqlite into its canonical snapshot;
/// moving only a raw Connection would end observation instead.
pub struct ObservedConnection {
    connection: Connection,
    context: Box<Context>,
}
impl ObservedConnection {
    /// Attach immediately inside the existing trusted connection opener.
    ///
    /// # Safety
    /// The source owner must supply exclusive custody of a KNOWN vacant trace callback
    /// and must not replace it for this wrapper's lifetime. SQLite exposes
    /// no getter for a prior trace callback, so arbitrary supplied handles cannot
    /// be checked and this precondition must not be replaced by a guessed label.
    /// No statement/raw handle may escape the normal Connection lifetimes.
    pub unsafe fn attach_untraced(
        connection: Connection,
        meter: WorkMeter,
    ) -> Result<Self, AttachFailure> {
        let db = connection.handle();
        let error = if ffi::sqlite3_compileoption_used(c"ENABLE_STMT_SCANSTATUS".as_ptr()) != 1 {
            Some(crate::cause!(Error::Unsupported))
        } else if !ffi::sqlite3_next_stmt(db, ptr::null_mut()).is_null() {
            Some(crate::cause!(Error::PreparedStatements))
        } else {
            None
        };
        if let Some(error) = error {
            crate::storage::request_work::RequestWork::uncovered();
            return Err(AttachFailure { cause: error.cause(), error, connection });
        }
        let mut context = Box::new(Context {
            meter,
            schema_epoch: Arc::new(AtomicU64::new(0)),
            active: std::array::from_fn(|_| Active::default()),
            last_changes: ffi::sqlite3_total_changes64(db),
        });
        let code = ffi::sqlite3_trace_v2(
            db,
            MASK,
            Some(trace),
            (&mut *context as *mut Context).cast(),
        );
        if code != ffi::SQLITE_OK {
            crate::storage::request_work::RequestWork::uncovered();
            let error = crate::cause!(Error::Hook);
            return Err(AttachFailure {
                cause: error.cause(),
                error,
                connection,
            });
        }
        every(&context.meter.0, |counters| {
            counters.writers.fetch_add(1, Ordering::AcqRel);
            add(&counters.live, 1, counters);
            counters.version.fetch_add(1, Ordering::Release);
            counters.writers.fetch_sub(1, Ordering::Release);
        });
        Ok(Self {
            connection,
            context,
        })
    }
    pub(crate) fn schema_observation(&self) -> SchemaObservation {
        SchemaObservation { handle: unsafe { self.connection.handle() } as usize,
            epoch: Arc::downgrade(&self.context.schema_epoch) }
    }
    pub fn connection(&self) -> &Connection {
        &self.connection
    }
    /// Forward the existing transaction operation without exposing a mutable
    /// Connection field that safe code could replace independently of its hook.
    pub fn transaction(&mut self) -> rusqlite::Result<rusqlite::Transaction<'_>> {
        self.connection.transaction()
    }
    pub fn transaction_with_behavior(
        &mut self,
        behavior: rusqlite::TransactionBehavior,
    ) -> rusqlite::Result<rusqlite::Transaction<'_>> {
        self.connection.transaction_with_behavior(behavior)
    }
    pub fn meter(&self) -> WorkMeter {
        self.context.meter.clone()
    }
}
impl fmt::Debug for ObservedConnection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ObservedSqliteConnection([redacted])")
    }
}
impl Drop for ObservedConnection {
    fn drop(&mut self) {
        // Expire schema witnesses before the connection's address can be recycled,
        // even if another owner temporarily retains the observer's epoch Arc.
        self.context.schema_epoch.store(u64::MAX, Ordering::Release);
        // SAFETY: this wrapper still exclusively owns the live connection and
        // its known trace callback; unregister before freeing the stable context.
        // A forgotten/unfinished statement makes coverage incomplete rather
        // than pretending unobserved finish work was zero.
        unsafe {
            every(&self.context.meter.0, |counters| { counters.writers.fetch_add(1, Ordering::AcqRel); });
            let db = self.connection.handle();
            #[cfg(any(test, feature = "sql-statement-attribution"))]
            let before_changes = self.context.last_changes;
            self.context.changes(db, Family::Other);
            #[cfg(any(test, feature = "sql-statement-attribution"))]
            if let Some(writes) = self.context.last_changes.checked_sub(before_changes).filter(|n| *n >= 0) {
                charge_detail(&self.context.meter.0, None, None, ReadWork { rows_written: writes as u64, ..Default::default() });
            }
            let pending = self
                .context
                .active
                .iter()
                .filter(|row| row.statement != 0)
                .count();
            if pending != 0 {
                self.context.incomplete();
                every(&self.context.meter.0, |counters| { counters.active.fetch_sub(pending as u64, Ordering::AcqRel); });
            }
            let code = ffi::sqlite3_trace_v2(db, 0, None, ptr::null_mut());
            if code != ffi::SQLITE_OK {
                // This is unreachable under the live exclusive handle contract;
                // do not report a complete observation if it is ever violated.
                self.context.incomplete();
            }
            every(&self.context.meter.0, |counters| {
                counters.live.fetch_sub(1, Ordering::AcqRel);
                counters.version.fetch_add(1, Ordering::Release);
                counters.writers.fetch_sub(1, Ordering::Release);
            });
        }
    }
}

/// Existing readers can accept either their prior unobserved connection or the
/// exact owning observed wrapper. The immutable dereference preserves their
/// existing SQL APIs without allowing a safe replacement of the traced handle.
pub enum SuppliedConnection {
    Unobserved(Connection),
    Observed(ObservedConnection),
}
impl From<Connection> for SuppliedConnection {
    fn from(connection: Connection) -> Self {
        Self::Unobserved(connection)
    }
}
impl From<ObservedConnection> for SuppliedConnection {
    fn from(connection: ObservedConnection) -> Self {
        Self::Observed(connection)
    }
}
impl Deref for SuppliedConnection {
    type Target = Connection;
    fn deref(&self) -> &Self::Target {
        match self {
            Self::Unobserved(connection) => { crate::storage::request_work::RequestWork::uncovered(); connection },
            Self::Observed(connection) => connection.connection(),
        }
    }
}
impl SuppliedConnection {
    pub fn transaction(&mut self) -> rusqlite::Result<rusqlite::Transaction<'_>> {
        match self {
            Self::Unobserved(connection) => { crate::storage::request_work::RequestWork::uncovered(); connection.transaction() },
            Self::Observed(connection) => connection.transaction(),
        }
    }
    pub fn transaction_with_behavior(
        &mut self,
        behavior: rusqlite::TransactionBehavior,
    ) -> rusqlite::Result<rusqlite::Transaction<'_>> {
        match self {
            Self::Unobserved(connection) => { crate::storage::request_work::RequestWork::uncovered(); connection.transaction_with_behavior(behavior) },
            Self::Observed(connection) => connection.transaction_with_behavior(behavior),
        }
    }
    pub fn meter(&self) -> Option<WorkMeter> {
        match self {
            Self::Unobserved(_) => None,
            Self::Observed(connection) => Some(connection.meter()),
        }
    }
}
impl fmt::Debug for SuppliedConnection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Unobserved(_) => "SuppliedSqliteConnection([unobserved])",
            Self::Observed(_) => "SuppliedSqliteConnection([observed])",
        })
    }
}

#[cfg(test)]
mod invocation_budget_tests {
    use super::{BudgetLimits, BudgetStop, Error, ObservedConnection, WorkMeter};
    use rusqlite::Connection;
    use std::{
        sync::{atomic::{AtomicBool, Ordering}, Arc},
        time::Duration,
    };

    fn limits(sql: u64, rows: u64, bytes: u64, vm: u64) -> BudgetLimits {
        BudgetLimits { sql, rows, bytes, vm, elapsed: Duration::from_secs(60) }
    }

    fn attached(db: Connection, meter: WorkMeter) -> ObservedConnection {
        // SAFETY: these fixtures have not prepared statements or installed a trace hook.
        unsafe { ObservedConnection::attach_untraced(db, meter) }.unwrap()
    }

    fn progress(db: &ObservedConnection, meter: WorkMeter) {
        db.connection().progress_handler(1, Some(move || {
            meter.budget_progress(1) != BudgetStop::None
        }));
    }

    #[test]
    fn statement_ceiling_is_shared_across_fresh_attached_connections_and_stops_short_sql() {
        let meter = WorkMeter::new();
        let _budget = meter.begin_test_budget(
            Arc::new(AtomicBool::new(false)), limits(1, 10, 10, 100),
        ).unwrap();
        let first = attached(Connection::open_in_memory().unwrap(), meter.clone());
        let second = attached(Connection::open_in_memory().unwrap(), meter.clone());
        progress(&first, meter.clone());
        progress(&second, meter.clone());

        assert_eq!(first.connection().query_row("SELECT 1", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        let stopped = second.connection().query_row("SELECT 2", [], |row| row.get::<_, i64>(0));
        assert!(stopped.is_err());
        assert_eq!(meter.budget_stop(), BudgetStop::Sql);
    }

    #[test]
    fn row_ceiling_interrupts_before_the_over_budget_row_can_be_consumed() {
        let raw = Connection::open_in_memory().unwrap();
        raw.execute_batch("CREATE TABLE source(value INTEGER); INSERT INTO source VALUES(1),(2),(3);").unwrap();
        let meter = WorkMeter::new();
        let _budget = meter.begin_test_budget(
            Arc::new(AtomicBool::new(false)), limits(10, 2, 1024, 100),
        ).unwrap();
        let db = attached(raw, meter.clone());
        progress(&db, meter.clone());
        let mut statement = db.connection().prepare("SELECT value FROM source ORDER BY value").unwrap();
        let mut rows = statement.query([]).unwrap();
        let mut returned = 0;
        while rows.next().is_ok_and(|row| row.is_some()) {
            returned += 1;
        }
        assert!(returned <= 2);
        assert_eq!(meter.budget_stop(), BudgetStop::Rows);
    }

    #[test]
    fn byte_reservations_are_shared_and_refund_only_unused_successful_capacity() {
        let meter = WorkMeter::new();
        let _budget = meter.begin_test_budget(
            Arc::new(AtomicBool::new(false)), limits(10, 10, 10, 100),
        ).unwrap();
        let first = meter.budget_reserve_bytes(6).unwrap();
        assert_eq!(first.settle(4), BudgetStop::None);
        assert_eq!(meter.budget_remaining(), Some((10, 6)));
        assert_eq!(meter.budget_reserve_bytes(6).unwrap().settle(6), BudgetStop::None);

        let exhausted = WorkMeter::new();
        let _budget = exhausted.begin_test_budget(
            Arc::new(AtomicBool::new(false)), limits(10, 10, 10, 100),
        ).unwrap();
        let _reserved = exhausted.budget_reserve_bytes(6).unwrap();
        let failure = exhausted.budget_reserve_bytes(5).unwrap_err();
        assert_eq!(failure.code, BudgetStop::Bytes);
        assert_eq!(failure.cause().file(), "src/sqlite_work.rs");
        assert_eq!(failure.cause(), exhausted.budget_reserve_bytes(5).unwrap_err().cause(),
            "a repeated budget refusal retains its source condition");
    }

    #[test]
    fn cancellation_and_vm_ceiling_are_sticky_closed_reasons() {
        let meter = WorkMeter::new();
        let _budget = meter.begin_test_budget(
            Arc::new(AtomicBool::new(false)), limits(10, 10, 10, 2),
        ).unwrap();
        assert_eq!(meter.budget_progress(1), BudgetStop::None);
        assert_eq!(meter.budget_progress(1), BudgetStop::None);
        assert_eq!(meter.budget_progress(1), BudgetStop::Vm);
        assert_eq!(meter.budget_preflight(), BudgetStop::Vm);
    }

    #[test]
    fn retained_meter_allows_sequential_invocations_and_refuses_overlap() {
        let meter = WorkMeter::new();
        let db = attached(Connection::open_in_memory().unwrap(), meter.clone());
        db.connection().progress_handler(1, {
            let meter = meter.clone();
            Some(move || meter.budget_progress(1) != BudgetStop::None)
        });
        for _ in 0..2 {
            let budget = meter.begin_test_budget(
                Arc::new(AtomicBool::new(false)), limits(8, 8, 128, 100),
            ).unwrap();
            assert_eq!(db.connection().query_row("SELECT 1", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
            assert_eq!(meter.budget_stop(), BudgetStop::None);
            assert_eq!(meter.begin_test_budget(
                Arc::new(AtomicBool::new(false)), limits(8, 8, 128, 100),
            ).unwrap_err(), crate::cause!(Error::Busy));
            drop(budget);
            assert_eq!(meter.budget_preflight(), BudgetStop::None);
        }
        assert_eq!(db.connection().query_row("SELECT 2", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
    }

    #[test]
    fn retained_meter_cancellation_applies_only_to_its_active_invocation() {
        let meter = WorkMeter::new();
        let cancel = Arc::new(AtomicBool::new(false));
        let budget = meter.begin_test_budget(cancel.clone(), limits(8, 8, 128, 100)).unwrap();
        cancel.store(true, Ordering::Release);
        assert_eq!(meter.budget_progress(1), BudgetStop::Cancelled);
        drop(budget);
        assert_eq!(meter.budget_preflight(), BudgetStop::None);
        let _next = meter.begin_test_budget(
            Arc::new(AtomicBool::new(false)), limits(8, 8, 128, 100),
        ).unwrap();
        assert_eq!(meter.budget_preflight(), BudgetStop::None);
    }

    #[test]
    fn forked_observation_counts_dropped_contexts_without_sharing_budgets() {
        let total = WorkMeter::new();
        let a = total.fork();
        let b = a.fork();
        let ca = attached(Connection::open_in_memory().unwrap(), a.clone());
        let cb = attached(Connection::open_in_memory().unwrap(), b.clone());
        let cancel_a = Arc::new(AtomicBool::new(false));
        let _a_budget = a.begin_test_budget(cancel_a.clone(), limits(8, 8, 128, 100)).unwrap();
        let _b_budget = b.begin_test_budget(Arc::new(AtomicBool::new(false)), limits(8, 8, 128, 100)).unwrap();
        assert_eq!(ca.connection().query_row("SELECT 1", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(cb.connection().query_row("SELECT 2", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
        cancel_a.store(true, Ordering::Release);
        assert_eq!(a.budget_stop(), BudgetStop::Cancelled);
        assert_eq!(b.budget_stop(), BudgetStop::None);
        assert_eq!(total.budget_stop(), BudgetStop::None);
        assert_eq!(total.snapshot().unwrap().work.sql_statements, 0);
        assert_eq!(a.snapshot().unwrap().work.sql_statements, 1);
        assert_eq!(b.snapshot().unwrap().work.sql_statements, 1);
        let before_drop = total.account_view().snapshot().unwrap();
        assert_eq!(before_drop.work.sql_statements, 2);
        assert_eq!(before_drop.work.rows_returned, 2);
        assert_eq!(before_drop.live_connections, 2);
        drop(ca); drop(cb); drop(a); drop(b);
        let after_drop = total.account_view().snapshot().unwrap();
        assert_eq!(after_drop.work.sql_statements, 2);
        assert_eq!(after_drop.work.rows_returned, 2);
        assert_eq!(after_drop.live_connections, 0);
    }

    #[test]
    fn another_contexts_active_statement_does_not_refuse_a_fork_budget() {
        let total = WorkMeter::new();
        let a = total.fork();
        let b = total.fork();
        let ca = attached(Connection::open_in_memory().unwrap(), a.clone());
        let mut query = ca.connection().prepare("SELECT 1 UNION ALL SELECT 2").unwrap();
        let mut rows = query.query([]).unwrap();
        assert!(rows.next().unwrap().is_some());
        assert_eq!(total.account_view().snapshot().unwrap().active_statements, 1);
        assert_eq!(a.begin_test_budget(Arc::new(AtomicBool::new(false)), limits(8, 8, 128, 100)).unwrap_err(), crate::cause!(Error::Busy));
        let _other = b.begin_test_budget(Arc::new(AtomicBool::new(false)), limits(8, 8, 128, 100)).unwrap();
        drop(rows); drop(query);
        assert_eq!(total.account_view().snapshot().unwrap().active_statements, 0);
    }


    #[test]
    fn operation_window_keeps_old_failure_visible_and_refuses_a_new_failure() {
        let meter = WorkMeter::new();
        let db = attached(Connection::open_in_memory().unwrap(), meter.clone());
        db.connection().execute_batch("CREATE TABLE sample(value INTEGER)").unwrap();
        let mut statement = db.connection().prepare("SELECT * FROM sample").unwrap();
        db.connection().execute_batch("ALTER TABLE sample ADD COLUMN added TEXT").unwrap();
        assert!(statement.query([]).unwrap().next().unwrap().is_none());
        drop(statement);
        assert_eq!(meter.snapshot().unwrap_err(), crate::cause!(Error::Incomplete));
        let complete = meter.begin_observation().unwrap();
        assert_eq!(db.connection().query_row("SELECT 1", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(complete.finish().unwrap().work.sql_statements, 1);
        // The lifetime flag remains set; observation never resets it.
        assert_eq!(meter.snapshot().unwrap_err(), crate::cause!(Error::Incomplete));
        let incomplete = meter.begin_observation().unwrap();
        let mut statement = db.connection().prepare("SELECT * FROM sample").unwrap();
        db.connection().execute_batch("ALTER TABLE sample ADD COLUMN later TEXT").unwrap();
        assert!(statement.query([]).unwrap().next().unwrap().is_none());
        drop(statement);
        assert_eq!(incomplete.finish().unwrap_err(), crate::cause!(Error::Incomplete));
    }

}
