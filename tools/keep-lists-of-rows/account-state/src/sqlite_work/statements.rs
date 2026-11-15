//! Explicit, feature-scoped attribution for synthetic/copied local fixtures.
//! Entries are allocated BEFORE capture. Trace callbacks only read SQLite's
//! unexpanded SQL and use bounded atomic entries; no allocation, lock, SQL call,
//! parameter expansion, application callback or filesystem write occurs there.
//! Normal product builds do not compile this module or its hook branches.
use super::{add, Counters, Error, GroupCounters, ReadWork, WorkMeter};
use rusqlite::ffi;
use std::{
    fmt,
    sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
};
const MAX_SLOTS: usize = 512;
const MAX_TEMPLATE: usize = super::MAX_SQL_BYTES;
struct Slot {
    state: AtomicU8,
    length: AtomicU64,
    text: [AtomicU8; MAX_TEMPLATE],
    work: GroupCounters,
}
pub(super) struct Statements {
    slots: Box<[Slot]>,
    unknown: GroupCounters,
    incomplete: AtomicBool,
    baseline: ReadWork,
    baseline_unattributed_rows: u64,
    baseline_failures: u64,
}
pub struct StatementWork {
    pub sql_template: String,
    pub work: ReadWork,
}
impl fmt::Debug for StatementWork {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StatementWork([template redacted])")
    }
}
pub struct StatementSnapshot {
    pub statements: Vec<StatementWork>,
    pub unattributed_work: ReadWork,
    pub unattributed_row_events: u64,
    pub work: ReadWork,
    pub complete: bool,
}
impl fmt::Debug for StatementSnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StatementSnapshot([templates redacted])")
    }
}
fn difference(a: &ReadWork, b: &ReadWork) -> Result<ReadWork, Error> {
    let sub = |x: u64, y: u64| y.checked_sub(x).ok_or(crate::cause!(Error::Incomplete));
    Ok(ReadWork {
        sql_statements: sub(a.sql_statements, b.sql_statements)?,
        sqlite_scan_visits: sub(a.sqlite_scan_visits, b.sqlite_scan_visits)?,
        fullscan_steps: sub(a.fullscan_steps, b.fullscan_steps)?,
        vm_steps: sub(a.vm_steps, b.vm_steps)?,
        rows_returned: sub(a.rows_returned, b.rows_returned)?,
        rows_written: sub(a.rows_written, b.rows_written)?,
    })
}
fn same(a: &ReadWork, b: &ReadWork) -> bool {
    a.sql_statements == b.sql_statements
        && a.sqlite_scan_visits == b.sqlite_scan_visits
        && a.fullscan_steps == b.fullscan_steps
        && a.vm_steps == b.vm_steps
        && a.rows_returned == b.rows_returned
        && a.rows_written == b.rows_written
}
fn sum(a: &mut ReadWork, b: &ReadWork) -> Result<(), Error> {
    macro_rules! plus {
        ($field:ident) => {
            a.$field = a.$field.checked_add(b.$field).ok_or(crate::cause!(Error::Overflow))?;
        };
    }
    plus!(sql_statements);
    plus!(sqlite_scan_visits);
    plus!(fullscan_steps);
    plus!(vm_steps);
    plus!(rows_returned);
    plus!(rows_written);
    Ok(())
}
impl Statements {
    fn new(
        capacity: usize,
        baseline: ReadWork,
        baseline_unattributed_rows: u64,
    ) -> Result<Self, Error> {
        if capacity == 0 || capacity > MAX_SLOTS {
            return Err(crate::cause!(Error::Unsupported));
        }
        let mut slots = Vec::with_capacity(capacity);
        for _ in 0..capacity {
            slots.push(Slot {
                state: AtomicU8::new(0),
                length: AtomicU64::new(0),
                text: std::array::from_fn(|_| AtomicU8::new(0)),
                work: GroupCounters::default(),
            });
        }
        Ok(Self {
            slots: slots.into_boxed_slice(),
            unknown: GroupCounters::default(),
            incomplete: AtomicBool::new(false),
            baseline,
            baseline_unattributed_rows,
            baseline_failures: 0,
        })
    }
    pub(super) unsafe fn locate(&self, statement: *mut ffi::sqlite3_stmt) -> Option<usize> {
        let text = ffi::sqlite3_sql(statement);
        if text.is_null() {
            self.incomplete.store(true, Ordering::Release);
            return None;
        }
        let mut length = 0usize;
        while length <= MAX_TEMPLATE {
            if *text.add(length) == 0 {
                break;
            }
            length += 1;
        }
        if length > MAX_TEMPLATE {
            self.incomplete.store(true, Ordering::Release);
            return None;
        }
        let bytes = std::slice::from_raw_parts(text.cast::<u8>(), length);
        for (index, slot) in self.slots.iter().enumerate() {
            if slot.state.load(Ordering::Acquire) == 2
                && slot.length.load(Ordering::Acquire) == length as u64
                && bytes
                    .iter()
                    .zip(&slot.text)
                    .all(|(a, b)| *a == b.load(Ordering::Relaxed))
            {
                return Some(index);
            }
        }
        for (index, slot) in self.slots.iter().enumerate() {
            if slot
                .state
                .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                for (to, from) in slot.text.iter().zip(bytes) {
                    to.store(*from, Ordering::Relaxed);
                }
                slot.length.store(length as u64, Ordering::Relaxed);
                slot.state.store(2, Ordering::Release);
                return Some(index);
            }
        }
        self.incomplete.store(true, Ordering::Release);
        None
    }
    pub(super) fn charge(&self, index: Option<usize>, work: ReadWork, counters: &Counters) {
        let group = index
            .and_then(|n| self.slots.get(n))
            .map_or(&self.unknown, |slot| &slot.work);
        for (target, value) in [
            (&group.statements, work.sql_statements),
            (&group.visits, work.sqlite_scan_visits),
            (&group.fullscan, work.fullscan_steps),
            (&group.vm, work.vm_steps),
            (&group.rows, work.rows_returned),
            (&group.writes, work.rows_written),
        ] {
            add(target, value, counters);
        }
    }
    fn snapshot(&self, work: ReadWork, unattributed: u64) -> Result<StatementSnapshot, Error> {
        let work = difference(&self.baseline, &work)?;
        let unattributed_row_events = unattributed
            .checked_sub(self.baseline_unattributed_rows)
            .ok_or(crate::cause!(Error::Incomplete))?;
        let mut statements = Vec::new();
        let mut total = self.unknown.snapshot();
        for slot in &self.slots {
            match slot.state.load(Ordering::Acquire) {
                0 => continue,
                2 => {}
                _ => return Err(crate::cause!(Error::Busy)),
            }
            let length = usize::try_from(slot.length.load(Ordering::Acquire))
                .map_err(|error| crate::carry_cause!(Error::Incomplete, error))?;
            if length > MAX_TEMPLATE {
                return Err(crate::cause!(Error::Incomplete));
            }
            let bytes = slot.text[..length]
                .iter()
                .map(|b| b.load(Ordering::Relaxed))
                .collect();
            let sql_template = String::from_utf8(bytes).map_err(|error| crate::carry_cause!(Error::Incomplete, error))?;
            let piece = slot.work.snapshot();
            sum(&mut total, &piece)?;
            statements.push(StatementWork {
                sql_template,
                work: piece,
            });
        }
        total.rows_returned = total
            .rows_returned
            .checked_add(unattributed_row_events)
            .ok_or(crate::cause!(Error::Overflow))?;
        let complete = !self.incomplete.load(Ordering::Acquire) && same(&total, &work);
        Ok(StatementSnapshot {
            statements,
            unattributed_work: self.unknown.snapshot(),
            unattributed_row_events,
            work,
            complete,
        })
    }
}
impl WorkMeter {
    /// Opt in only for a fully owned fixture whose unexpanded SQL templates may
    /// be inspected. Parameters are NEVER expanded. Capture is bounded and
    /// volatile; Debug does not expose templates. No source/rights are granted.
    ///
    /// # Safety
    /// All attached connections must be idle and exclusively controlled while
    /// enabling; caller must ensure SQL source text itself contains no secrets
    /// or undisclosed private literals. Do not enable on a live customer account.
    pub unsafe fn enable_fixture_statement_attribution(
        &self,
        capacity: usize,
    ) -> Result<(), Error> {
        let version = self.0.version.load(Ordering::Acquire);
        let (baseline, failures) = self.sample(true)?;
        if baseline.active_statements != 0 {
            return Err(crate::cause!(Error::Busy));
        }
        let mut capture = Statements::new(capacity, baseline.work, baseline.unattributed_row_events)?;
        capture.baseline_failures = failures;
        if self.0.version.load(Ordering::Acquire) != version
            || self.0.writers.load(Ordering::Acquire) != 0
        {
            return Err(crate::cause!(Error::Busy));
        }
        self.0
            .statements_detail
            .set(capture)
            .map_err(|_uninstalled_capture| crate::cause!(Error::Busy))
    }
    pub fn fixture_statement_snapshot(&self) -> Result<StatementSnapshot, Error> {
        let capture = self.0.statements_detail.get().ok_or(crate::cause!(Error::Unsupported))?;
        for _ in 0..8 {
            let version = self.0.version.load(Ordering::Acquire);
            let (observed, failures) = self.sample(true)?;
            if failures != capture.baseline_failures { return Err(crate::cause!(Error::Incomplete)); }
            if observed.active_statements != 0 {
                return Err(crate::cause!(Error::Busy));
            }
            let answer = capture.snapshot(observed.work, observed.unattributed_row_events)?;
            if self.0.version.load(Ordering::Acquire) == version
                && self.0.writers.load(Ordering::Acquire) == 0
            {
                return Ok(answer);
            }
        }
        Err(crate::cause!(Error::Busy))
    }
}
