//! Canonical bounded reads during one caller-owned typed write scope.
//! The handle stays private to the SQLite supply. This is a provisional,
//! immutable read phase: any change through the same handle invalidates it.
//! Actual source state still reports writing=true; no readonly fact is forged.
use super::Supply;
use crate::{
    import::{ImportError, ImportResult, QueryRows, ReadLimits},
    record_source::{BoundedRecordSql, QueryBudget, ReadSourceState, RecordSourceWitness},
    storage::Storage,
    sqlite_work::BudgetStop,
};
use rusqlite::{Connection, types::Value};
use std::{borrow::Borrow, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Instant};

pub struct ReadPhase<'a, C: Borrow<Connection>, W: RecordSourceWitness> {
    store: &'a Supply<C>,
    witness: W,
    limits: ReadLimits,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
    changes: u64,
}
#[track_caller]
fn refused() -> ImportError { ImportError::Refused("selected write-scope read phase changed", crate::cause!(caller_site: ImportError::Refused)) }
impl<'a, C: Borrow<Connection>, W: RecordSourceWitness> ReadPhase<'a, C, W> {
    pub fn new(store: &'a Supply<C>, witness: W, limits: ReadLimits, cancel: Arc<AtomicBool>, deadline: Instant) -> ImportResult<Self> {
        let changes = store.changes();
        let mut source = Self { store, witness, limits, cancel, deadline, changes };
        source.current()?;
        Ok(source)
    }
    fn operation_error(&self, error: ImportError) -> ImportError {
        // Match this SQLite error and this newly armed statement's callback
        // cause, never a clock observation after another kind of failure.
        if !matches!(&error, ImportError::Sqlite(rusqlite::Error::SqliteFailure(code, _), _)
            if code.code == rusqlite::ErrorCode::OperationInterrupted) {
            return error;
        }
        let cause = error.cause();
        match self.store.interruption() {
            super::Interruption::Deadline | super::Interruption::SharedDeadline =>
                ImportError::Deadline("selected read statement interrupted by its deadline", cause),
            super::Interruption::SharedBudget | super::Interruption::SharedCancelled =>
                ImportError::Budget("selected read statement interrupted by its shared work budget", cause),
            _ => error,
        }
    }
    fn custody(&self) -> ImportResult<()> {
        if self.cancel.load(Ordering::Acquire) {
            return Err(ImportError::Budget("selected write-scope read phase cancelled", crate::cause!()));
        }
        if Instant::now() >= self.deadline {
            return Err(ImportError::Deadline("selected write-scope read phase deadline exhausted", crate::cause!()));
        }
        self.store.custody().map_err(|_| refused())?;
        if !self.store.scoped() || !self.store.writing().map_err(|_| refused())? { return Err(refused()); }
        Ok(())
    }
    pub fn read_phase(&mut self) -> ImportResult<()> {
        self.custody()?;
        self.witness.assert_query_source()?;
        if self.store.changes() != self.changes { return Err(refused()); }
        self.custody()
    }
    /// Lend typed reads through this phase's bounded query engine. The view
    /// owns no transaction and cannot write; it preserves the actual write
    /// state, cancellation, source witness and same-handle mutation check.
    pub fn typed(&mut self, schema: &str, budget: QueryBudget) -> crate::storage::Result<super::bounded::Supply<'_, Self>> {
        super::bounded::lend_read_phase(self, schema, budget)
    }
    /// Fresh account/source admission is mandatory before this phase is used
    /// to publish derived results. It never grants a public disclosure right.
    pub fn current(&mut self) -> ImportResult<()> {
        self.custody()?;
        self.witness.assert_current()?;
        self.custody()
    }
}
impl<C: Borrow<Connection>, W: RecordSourceWitness> BoundedRecordSql for ReadPhase<'_, C, W> {
    fn read_source_state(&mut self) -> ImportResult<ReadSourceState> {
        self.read_phase()?;
        Ok(ReadSourceState { location: self.store.location().map(str::to_owned), changes: self.store.changes(),
            scoped: self.store.scoped(), writing: self.store.writing().map_err(|_| refused())?, custody: true, usable: true })
    }
    fn read_limits(&self) -> Option<&ReadLimits> { Some(&self.limits) }
    fn main_table_exists(&mut self, name: &str, mut cap: QueryBudget) -> crate::record_source::catalogue_point::Probe {
        use crate::record_source::catalogue_point::Probe;
        if let Err(error) = self.read_phase() { return Probe::refused(error); }
        cap.deadline = cap.deadline.min(self.deadline);
        let _armed = match self.store.allowance.as_ref().map(|allowance| allowance.arm()).transpose() {
            Ok(armed) => armed,
            Err(error) => return Probe::refused(storage_interruption(error)),
        };
        let mut result = crate::record_source::catalogue_point::probe_in_write_transaction(
            self.store.db(), name, &self.limits, cap, &self.cancel,
        );
        result.exists = result.exists.map_err(|error| self.operation_error(error));
        let postcheck = self.read_phase();
        if result.exists.is_ok() {
            if let Err(error) = postcheck { result.exists = Err(error); }
        }
        result
    }
    fn query(&mut self, sql: &str, params: &[Value]) -> ImportResult<QueryRows> {
        self.query_with_budget(sql, params, QueryBudget { rows: self.limits.rows, source_bytes: self.limits.result_bytes, deadline: self.deadline })
    }
    fn query_with_budget(&mut self, sql: &str, params: &[Value], mut cap: QueryBudget) -> ImportResult<QueryRows> {
        self.read_phase()?;
        cap.deadline = cap.deadline.min(self.deadline);
        let _armed = self.store.allowance.as_ref().map(|allowance| allowance.arm())
            .transpose().map_err(storage_interruption)?;
        let meter = self.store.allowance.as_ref().and_then(|allowance| allowance.meter.as_ref());
        let reservation = if let Some(meter) = meter {
            let stop = meter.budget_preflight();
            if stop != BudgetStop::None {
                return Err(shared_budget_error(stop));
            }
            if let Some((rows, bytes)) = meter.budget_remaining() {
                if rows == 0 || bytes == 0 {
                    return Err(shared_budget_error(if rows == 0 { BudgetStop::Rows } else { BudgetStop::Bytes }));
                }
                cap.rows = cap.rows.min(rows);
                cap.source_bytes = cap.source_bytes.min(bytes);
                Some(meter.budget_reserve_bytes(cap.source_bytes).map_err(|error| {
                    let cause = error.cause();
                    match shared_budget_error(error.code) {
                        ImportError::Deadline(detail, _) => ImportError::Deadline(detail, cause),
                        ImportError::Budget(detail, _) => ImportError::Budget(detail, cause),
                        other => other,
                    }
                })?)
            } else { None }
        } else { None };
        let held = crate::record_source::query_bounded_in_write_transaction(
            self.store.db(), &self.limits, sql, params, self.cancel.clone(), cap,
        );
        let postcheck = self.read_phase();
        match held {
            Err(error) => Err(self.operation_error(error)),
            Ok(rows) => {
                postcheck?;
                if let Some(reservation) = reservation {
                    let actual = query_rows_bytes(&rows).ok_or_else(|| ImportError::Refused(
                        "selected write-scope result byte count overflow", crate::cause!()))?;
                    let stop = reservation.settle(actual);
                    if stop != BudgetStop::None {
                        return Err(shared_budget_error(stop));
                    }
                }
                Ok(rows)
            }
        }
    }
}

#[track_caller]
fn shared_budget_error(stop: BudgetStop) -> ImportError {
    match stop {
        BudgetStop::Deadline => ImportError::Deadline("selected write-scope invocation deadline exhausted", crate::cause!(caller_site: ImportError::Deadline)),
        BudgetStop::Cancelled => ImportError::Budget("selected write-scope invocation cancelled", crate::cause!(caller_site: ImportError::Budget)),
        _ => ImportError::Budget("selected write-scope invocation work budget exhausted", crate::cause!(caller_site: ImportError::Budget)),
    }
}

fn storage_interruption(error: crate::storage::Error) -> ImportError {
    match error {
        crate::storage::Error::Deadline(cause) => ImportError::Deadline("selected write-scope invocation deadline exhausted", cause),
        crate::storage::Error::Interrupted(cause) => ImportError::Budget("selected write-scope invocation work budget exhausted", cause),
        error => ImportError::Refused("selected write-scope read phase changed", error.cause()),
    }
}

fn query_rows_bytes(rows: &QueryRows) -> Option<usize> {
    let mut bytes = rows.columns.iter().try_fold(0usize, |sum, name| sum.checked_add(name.len()))?;
    for row in &rows.rows {
        for value in row {
            let size = match value {
                crate::import::SqlValue::Text(value) | crate::import::SqlValue::Blob(value) => value.len(),
                _ => 8,
            };
            bytes = bytes.checked_add(size)?;
        }
    }
    Some(bytes)
}

#[cfg(test)]
#[path = "record_source/tests.rs"]
mod tests;

#[cfg(test)]
mod refusal_cause_tests {
    use super::*;

    fn one_site(stop: BudgetStop) -> ImportError { shared_budget_error(stop) }
    fn another_site(stop: BudgetStop) -> ImportError { shared_budget_error(stop) }

    #[test]
    fn generic_budget_refusals_keep_both_the_call_site_and_the_constructor_condition() {
        let cancelled = one_site(BudgetStop::Cancelled);
        let exhausted = one_site(BudgetStop::Rows);
        let elsewhere = another_site(BudgetStop::Rows);
        assert!(matches!(cancelled, ImportError::Budget(_, _)));
        assert!(matches!(exhausted, ImportError::Budget(_, _)));
        assert_ne!(cancelled.cause(), exhausted.cause(), "different constructor branches at one caller stay distinct");
        assert_ne!(exhausted.cause(), elsewhere.cause(), "one constructor reached by different callers stays distinct");
        assert_eq!(exhausted.cause(), one_site(BudgetStop::Rows).cause());
    }
}
