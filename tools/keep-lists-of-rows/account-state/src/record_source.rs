// src/record_source.rs
//
// Purpose: Supply the existing logical record readers with bounded typed SQLite reads.
// Non-Negotiable Invariants: Reuse original read limits and authorizer semantics; a physical connection is not account authority. Current reads retain one readonly snapshot and independently supplied fresh rights/source witnesses.
// Key Concepts: BoundedRecordSql, RecordSourceWitness, exact SQLite scalar bytes, cancellation and deterministic snapshot retirement.
// Security Considerations: No path opening, new store, decoder, authority inference, provider, write or background task. No partial result escapes a failed bound or stale witness.
// AI Assistant Directive: Preserve and extend this contract. Logical schemas, keys, account policy and original provenance remain with their existing owners.

pub mod catalogue_point;
use crate::import::{ImportError, ImportResult, QueryRows, QueryTiming, ReadLimits, SqlValue};
use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    limits::Limit,
    params_from_iter,
    types::Value,
    Connection,
};
/// The value bound to each `?` of a bounded query. Callers of this supply name
/// it here, never through the SQLite crate itself.
pub use rusqlite::types::Value as Parameter;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

/// Physical read boundary only. Implementations retain their own original or
/// current-account authority, transaction, source witness and cancellation.
#[derive(Debug, Clone, Copy)]
pub struct QueryBudget {
    pub rows: usize,
    pub source_bytes: usize,
    pub deadline: Instant,
}

/// Physical facts of a retained read source. This conveys no account
/// authority. A supplier that cannot prove these facts must refuse the observation.
#[derive(Clone, Debug)]
pub struct ReadSourceState {
    pub location: Option<String>,
    pub changes: u64,
    pub scoped: bool,
    pub writing: bool,
    pub custody: bool,
    pub usable: bool,
}

pub trait BoundedRecordSql {
    /// Optional physical supply observation; existing implementations remain valid
    /// and refuse typed storage lending until they can observe their real read handle.
    fn read_source_state(&mut self) -> ImportResult<ReadSourceState> {
        Err(ImportError::Refused("supplier has no readonly snapshot state", crate::cause!()))
    }

    /// Actual supplier ceilings only. None means unsupported; callers must
    /// refuse rather than invent an unbounded/default physical allowance.
    fn read_limits(&self) -> Option<&ReadLimits> {
        None
    }

    fn query(&mut self, sql: &str, params: &[Value]) -> ImportResult<QueryRows>;
    /// Unsupported suppliers must refuse; they may not silently ignore a caller cap.
    fn query_with_budget(
        &mut self,
        _sql: &str,
        _params: &[Value],
        _budget: QueryBudget,
    ) -> ImportResult<QueryRows> {
        Err(ImportError::Budget(
            "record supplier does not support caller budgets",
         crate::cause!()))
    }
    /// Optional ordered packet prefix. The consumer must resume after its last
    /// row until its separately observed frontier, and withhold partial answers.
    /// Ordinary query methods still reject every result-bound excess.
    fn supports_ordered_prefix(&self) -> bool { false }
    fn query_ordered_prefix_with_budget(
        &mut self, _sql: &str, _params: &[Value], _budget: QueryBudget,
    ) -> ImportResult<QueryRows> {
        Err(ImportError::Refused("supplier has no ordered packet prefix", crate::cause!()))
    }
    /// Canonical owner asserts that this read is deterministic within its held
    /// snapshot. Ordinary suppliers execute it normally. Only a supplier that
    /// owns one retained immutable snapshot may reuse the exact SQL/parameters;
    /// it must recheck source custody/cancellation and retain final admission.
    fn query_reusable_with_budget(
        &mut self,
        sql: &str,
        params: &[Value],
        budget: QueryBudget,
    ) -> ImportResult<QueryRows> {
        self.query_with_budget(sql, params, budget)
    }
    /// Raw checkpoint queries; ordinary suppliers retain existing execution.
    /// A private writer owner may reuse exact bytes only after checking actual
    /// custody, cancellation and a schema/whole-mutation epoch on every hit.
    fn query_checkpoint_with_budget(
        &mut self,
        sql: &str,
        params: &[Value],
        budget: QueryBudget,
    ) -> ImportResult<QueryRows> {
        self.query_reusable_with_budget(sql, params, budget)
    }
    /// Native exact-main-table metadata is optional. Unsupported/ambiguous
    /// results retain the original counted SQL; never infer absent from error.
    /// Native API/preparation/schema work is separate from SQL/provider units.
    fn main_table_exists(&mut self, _name: &str, _budget: QueryBudget) -> catalogue_point::Probe {
        catalogue_point::Probe::unsupported()
    }
    /// None is unmeasured; an unsupported supplier must not invent zero timing.
    fn last_query_timing(&self) -> Option<QueryTiming> {
        None
    }
}

/// The selected current account owner implements this against its retained
/// generation, current rights and source custody. A successful constructor or
/// a readable SQLite file must never substitute for this witness.
pub trait RecordSourceWitness {
    fn assert_current(&mut self) -> ImportResult<()>;
    /// Default: fresh authority for each query. A private operation owner may
    /// use a cheaper custody check only while it retains the entire provisional
    /// answer and exclusive account borrow until mandatory fresh finish.
    fn assert_query_source(&mut self) -> ImportResult<()> {
        self.assert_current()
    }
}
impl<F: FnMut() -> ImportResult<()>> RecordSourceWitness for F {
    fn assert_current(&mut self) -> ImportResult<()> {
        self()
    }
}

#[track_caller]
fn refused<T>(reason: &'static str) -> ImportResult<T> {
    Err(ImportError::Refused(reason, crate::cause!(caller_site: ImportError::Refused)))
}
fn cancellation(cancelled: Option<&AtomicBool>) -> ImportResult<()> {
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return refused("record read was cancelled");
    }
    Ok(())
}

/// Verify SQLite's physical handle, including replacement of its remembered
/// named file. The account witness still owns the independently selected path.
pub(crate) fn check_readonly_connection(connection: &Connection) -> ImportResult<()> {
    let mut moved = 1_i32;
    // SAFETY: the connection is exclusively supplied to this reader; the main
    // name is static NUL-terminated storage and moved lives through the call.
    let (readonly, result) = unsafe {
        (
            rusqlite::ffi::sqlite3_db_readonly(connection.handle(), b"main\0".as_ptr().cast()),
            rusqlite::ffi::sqlite3_file_control(
                connection.handle(),
                b"main\0".as_ptr().cast(),
                rusqlite::ffi::SQLITE_FCNTL_HAS_MOVED,
                (&mut moved as *mut i32).cast(),
            ),
        )
    };
    if readonly != 1 || result != rusqlite::ffi::SQLITE_OK || moved != 0 {
        return refused("record read requires its unchanged readonly SQLite handle");
    }
    Ok(())
}

/// Apply the original importer's actual SQLite ceilings and read authorizer.
/// This changes only the supplied connection, never its physical database.
pub(crate) fn configure_read(connection: &Connection, limits: &ReadLimits) -> ImportResult<()> {
    configure_environment(connection, limits)?;
    constrain_queries(connection, limits);
    Ok(())
}
fn configure_environment(connection: &Connection, limits: &ReadLimits) -> ImportResult<()> {
    limits.validate()?;
    check_readonly_connection(connection)?;
    connection.busy_timeout(Duration::ZERO)?;
    connection.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY")?;
    Ok(())
}
fn constrain_queries(connection: &Connection, limits: &ReadLimits) {
    connection.set_limit(Limit::SQLITE_LIMIT_LENGTH, limits.cell_bytes as i32);
    connection.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, limits.sql_bytes as i32);
    // Loading the original schema may require more columns than an individual
    // result is allowed to return; result columns retain their separate bound.
    connection.set_limit(Limit::SQLITE_LIMIT_COLUMN, 1024);
    connection.authorizer(Some(read_authorizer));
}

struct ProgressReset<'a>(&'a Connection);
impl Drop for ProgressReset<'_> {
    fn drop(&mut self) {
        self.0.progress_handler(0, None::<fn() -> bool>);
    }
}

/// Common execution engine extracted from ReadonlyOriginal::query. The caller
/// rechecks its own authority/source before and after this function. Installing
/// a callback on a concurrently shared connection is outside this contract.
pub(crate) fn query_bounded(
    connection: &Connection,
    limits: &ReadLimits,
    sql: &str,
    params: &[Value],
    cancelled: Option<Arc<AtomicBool>>,
) -> ImportResult<QueryRows> {
    query_core(connection, limits, sql, params, cancelled, None)
}

pub(crate) fn query_bounded_with_budget(
    connection: &Connection,
    limits: &ReadLimits,
    sql: &str,
    params: &[Value],
    cancelled: Option<Arc<AtomicBool>>,
    budget: QueryBudget,
) -> ImportResult<QueryRows> {
    query_core(connection, limits, sql, params, cancelled, Some(budget))
}

fn query_core(
    connection: &Connection,
    limits: &ReadLimits,
    sql: &str,
    params: &[Value],
    cancelled: Option<Arc<AtomicBool>>,
    budget: Option<QueryBudget>,
) -> ImportResult<QueryRows> {
    query_core_mode(connection, limits, sql, params, cancelled, budget, false, false, None)
}

pub(crate) fn query_ordered_prefix_with_budget(
    connection: &Connection, limits: &ReadLimits, sql: &str, params: &[Value],
    cancelled: Option<Arc<AtomicBool>>, budget: QueryBudget,
) -> ImportResult<QueryRows> {
    query_core_mode(connection, limits, sql, params, cancelled, Some(budget), false, true, None)
}

// Only internal selected-account write consumers use this. The caller retains
// its IMMEDIATE transaction and global VM progress handler across these reads.
pub(crate) fn query_bounded_in_write_transaction(
    connection: &Connection,
    limits: &ReadLimits,
    sql: &str,
    params: &[Value],
    cancelled: Arc<AtomicBool>,
    budget: QueryBudget,
) -> ImportResult<QueryRows> {
    query_core_mode(
        connection,
        limits,
        sql,
        params,
        Some(cancelled),
        Some(budget),
        true,
        false,
        None,
    )
}
pub(crate) fn check_query_connection(connection: &Connection, write: bool) -> ImportResult<()> {
    if !write {
        return check_readonly_connection(connection);
    }
    let mut moved = 1i32;
    let (readonly, state, rc) = unsafe {
        (
            rusqlite::ffi::sqlite3_db_readonly(connection.handle(), b"main\0".as_ptr().cast()),
            rusqlite::ffi::sqlite3_txn_state(connection.handle(), b"main\0".as_ptr().cast()),
            rusqlite::ffi::sqlite3_file_control(
                connection.handle(),
                b"main\0".as_ptr().cast(),
                rusqlite::ffi::SQLITE_FCNTL_HAS_MOVED,
                (&mut moved as *mut i32).cast(),
            ),
        )
    };
    if connection.is_autocommit()
        || readonly != 0
        || state != rusqlite::ffi::SQLITE_TXN_WRITE
        || rc != rusqlite::ffi::SQLITE_OK
        || moved != 0
    {
        return refused("record read requires its unchanged caller-held write transaction");
    }
    Ok(())
}

fn query_core_mode(
    connection: &Connection,
    limits: &ReadLimits,
    sql: &str,
    params: &[Value],
    cancelled: Option<Arc<AtomicBool>>,
    budget: Option<QueryBudget>,
    write_transaction: bool,
    ordered_prefix: bool,
    meter: Option<crate::sqlite_work::WorkMeter>,
) -> ImportResult<QueryRows> {
    limits.validate()?;
    cancellation(cancelled.as_deref())?;
    if let Some(meter) = &meter {
        match meter.budget_preflight() {
            crate::sqlite_work::BudgetStop::None => {}
            crate::sqlite_work::BudgetStop::Deadline => return Err(ImportError::Deadline("record invocation deadline exhausted", crate::cause!())),
            crate::sqlite_work::BudgetStop::Cancelled => return Err(ImportError::Budget("record invocation cancelled", crate::cause!())),
            _ => return Err(ImportError::Budget("record invocation work budget exhausted", crate::cause!())),
        }
    }
    if let Some(budget) = budget {
        if budget.rows == 0 || budget.source_bytes == 0 {
            return Err(ImportError::Budget("record caller budget is exhausted", crate::cause!()));
        }
        if Instant::now() >= budget.deadline {
            return Err(if write_transaction { ImportError::Deadline("record caller deadline exhausted", crate::cause!()) }
                else { ImportError::Budget("record caller deadline exhausted", crate::cause!()) });
        }
    }
    check_query_connection(connection, write_transaction)?;
    if sql.is_empty()
        || sql.len() > limits.sql_bytes
        || sql.contains(';')
        || sql.contains('\0')
        || params.len() > 256
    {
        return refused("original query exceeds its single-statement bound");
    }
    let steps = Arc::new(AtomicU64::new(0));
    let counter = steps.clone();
    let stop_cause = Arc::new(AtomicU8::new(0));
    let callback_cause = stop_cause.clone();
    let stop = cancelled.clone();
    let shared_meter = meter.clone();
    let max = limits.vm_steps;
    // Callers' callback budgets count callbacks of `callback_steps` VM steps. A
    // shared work meter needs every step, so its handler runs per step, but the
    // reported callback count keeps the callers' unit.
    let callback_steps = max.min(1000);
    let quantum = if meter.is_some() { 1_u64 } else { callback_steps };
    let original_deadline = Instant::now() + limits.elapsed;
    let deadline = budget.map_or(original_deadline, |b| b.deadline.min(original_deadline));
    let row_limit = budget.map_or(limits.rows, |b| b.rows.min(limits.rows));
    let byte_limit = budget.map_or(limits.result_bytes, |b| {
        b.source_bytes.min(limits.result_bytes)
    });
    #[track_caller]
    fn exhausted(message: &'static str, caller: bool) -> ImportError {
        if caller {
            ImportError::Budget(message, crate::cause!(caller_site: ImportError::Budget))
        } else {
            ImportError::Refused(message, crate::cause!(caller_site: ImportError::Refused))
        }
    }
    #[track_caller]
    fn time_exhausted(message: &'static str, caller: bool, write_transaction: bool) -> ImportError {
        if write_transaction {
            ImportError::Deadline(message, crate::cause!(caller_site: ImportError::Deadline))
        } else {
            exhausted(message, caller)
        }
    }
    if !write_transaction {
        connection.progress_handler(
            quantum as i32,
            Some(move || {
                // Preserve this reader's existing callback priority and record
                // only this statement's actual stop, never a later clock flag.
                let cause = if counter.fetch_add(quantum, Ordering::Relaxed) + quantum >= max { 2 }
                    else if Instant::now() >= deadline { 3 }
                    else if stop.as_ref().is_some_and(|flag| flag.load(Ordering::Acquire)) { 1 }
                    else { 0 };
                if cause != 0 {
                    callback_cause.store(cause, Ordering::Release);
                    return true;
                }
                if let Some(meter) = &shared_meter {
                    match meter.budget_progress(quantum) {
                        crate::sqlite_work::BudgetStop::None => false,
                        crate::sqlite_work::BudgetStop::Deadline => { callback_cause.store(4, Ordering::Release); true }
                        crate::sqlite_work::BudgetStop::Cancelled => { callback_cause.store(5, Ordering::Release); true }
                        _ => { callback_cause.store(6, Ordering::Release); true }
                    }
                } else { false }
            }),
        );
    }
    let _reset = (!write_transaction).then(|| ProgressReset(connection));
    let result = (|| {
        let mut stmt = connection.prepare(sql)?;
        if !stmt.readonly() || stmt.column_count() == 0 || stmt.column_count() > limits.columns {
            return refused("only bounded original read statements are allowed");
        }
        let mut columns = Vec::with_capacity(stmt.column_count());
        let mut bytes = 0usize;
        for name in stmt.column_names() {
            bytes = bytes
                .checked_add(name.len())
                .ok_or(ImportError::Refused("original query byte count overflow", crate::cause!()))?;
            if bytes > byte_limit {
                return Err(exhausted(
                    "original query column-name byte bound exceeded",
                    budget.is_some_and(|b| b.source_bytes <= limits.result_bytes),
                ));
            }
            if meter.as_ref().is_some_and(|meter| meter.budget_charge_bytes(name.len()) != crate::sqlite_work::BudgetStop::None) {
                return Err(ImportError::Budget("original query aggregate byte bound exceeded", crate::cause!()));
            }
            columns.push(name.to_owned());
        }
        let count = stmt.column_count();
        let mut cursor = stmt.query(params_from_iter(params.iter()))?;
        let mut output = Vec::new();
        while let Some(row) = cursor.next()? {
            cancellation(cancelled.as_deref())?;
            if output.len() >= row_limit {
                return Err(exhausted(
                    "original query row or time bound exceeded",
                    budget.is_some_and(|b| b.rows <= limits.rows),
                ));
            }
            if Instant::now() >= deadline {
                return Err(time_exhausted(
                    "original query time bound exceeded",
                    budget.is_some_and(|b| b.deadline <= original_deadline),
                    write_transaction,
                ));
            }
            if ordered_prefix {
                // Inspect borrowed lengths before any payload in this row is
                // copied. Only the supplier's tighter packet ceiling can end
                // a prefix; exhausting the caller's aggregate remains failure.
                let mut row_bytes = 0usize;
                for column in 0..count {
                    let size = match row.get_ref(column)? {
                        rusqlite::types::ValueRef::Text(value)
                        | rusqlite::types::ValueRef::Blob(value) => value.len(),
                        _ => 8,
                    };
                    if size > limits.cell_bytes {
                        return refused("original SQLite cell exceeds its bound");
                    }
                    row_bytes = row_bytes.checked_add(size)
                        .ok_or(ImportError::Refused("original query byte count overflow", crate::cause!()))?;
                }
                let next = bytes.checked_add(row_bytes)
                    .ok_or(ImportError::Refused("original query byte count overflow", crate::cause!()))?;
                if next > byte_limit {
                    if budget.is_some_and(|b| limits.result_bytes < b.source_bytes) {
                        break;
                    }
                    return Err(exhausted(
                        "original query result byte bound exceeded",
                        budget.is_some_and(|b| b.source_bytes <= limits.result_bytes),
                    ));
                }
            }
            let mut values = Vec::with_capacity(count);
            for column in 0..count {
                let raw = row.get_ref(column)?;
                let size = match raw {
                    rusqlite::types::ValueRef::Text(value)
                    | rusqlite::types::ValueRef::Blob(value) => value.len(),
                    _ => 8,
                };
                // Charge the borrowed cell before allocating its owned copy.
                if size > limits.cell_bytes {
                    return refused("original SQLite cell exceeds its bound");
                }
                bytes = bytes
                    .checked_add(size)
                    .ok_or(ImportError::Refused("original query byte count overflow", crate::cause!()))?;
                if bytes > byte_limit {
                    return Err(exhausted(
                        "original query result byte bound exceeded",
                        budget.is_some_and(|b| b.source_bytes <= limits.result_bytes),
                    ));
                }
                cancellation(cancelled.as_deref())?;
                if meter.as_ref().is_some_and(|meter| meter.budget_charge_bytes(size) != crate::sqlite_work::BudgetStop::None) {
                    return Err(ImportError::Budget("original query aggregate byte bound exceeded", crate::cause!()));
                }
                values.push(SqlValue::from_ref(raw));
            }
            output.push(values);
        }
        if Instant::now() >= deadline {
            return Err(time_exhausted(
                "original query time bound exceeded",
                budget.is_some_and(|b| b.deadline <= original_deadline),
                write_transaction,
            ));
        }
        Ok(QueryRows {
            columns,
            rows: output,
            progress_callbacks: steps.load(Ordering::Relaxed) / callback_steps,
        })
    })();
    if result.is_err() {
        if !write_transaction && matches!(&result,
            Err(ImportError::Sqlite(rusqlite::Error::SqliteFailure(code, _), _))
                if code.code == rusqlite::ErrorCode::OperationInterrupted)
        {
            match stop_cause.load(Ordering::Acquire) {
                1 => return refused("record read was cancelled"),
                3 => return Err(exhausted("original query time bound exceeded",
                    budget.is_some_and(|b| b.deadline <= original_deadline))),
                4 => return Err(ImportError::Deadline("record invocation deadline exhausted", crate::cause!())),
                5 => return Err(ImportError::Budget("record invocation cancelled", crate::cause!())),
                6 => return Err(ImportError::Budget("record invocation work budget exhausted", crate::cause!())),
                _ => {},
            }
            if let Some(meter) = &meter {
                match meter.budget_stop() {
                    crate::sqlite_work::BudgetStop::Deadline => return Err(ImportError::Deadline("record invocation deadline exhausted", crate::cause!())),
                    crate::sqlite_work::BudgetStop::Cancelled => return Err(ImportError::Budget("record invocation cancelled", crate::cause!())),
                    crate::sqlite_work::BudgetStop::None => {},
                    _ => return Err(ImportError::Budget("record invocation work budget exhausted", crate::cause!())),
                }
            }
        }
        return result;
    }
    cancellation(cancelled.as_deref())?;
    check_query_connection(connection, write_transaction)?;
    if budget.is_some_and(|b| Instant::now() >= b.deadline) {
        return Err(time_exhausted("record caller deadline exhausted", true, write_transaction));
    }
    if let Some(meter) = &meter {
        match meter.budget_preflight() {
            crate::sqlite_work::BudgetStop::None => {}
            crate::sqlite_work::BudgetStop::Deadline => return Err(ImportError::Deadline("record invocation deadline exhausted", crate::cause!())),
            crate::sqlite_work::BudgetStop::Cancelled => return Err(ImportError::Budget("record invocation cancelled", crate::cause!())),
            _ => return Err(ImportError::Budget("record invocation work budget exhausted", crate::cause!())),
        }
    }
    result
}

/// A caller-supplied current physical read, retained as one SQLite snapshot.
/// The witness must validate fresh authority outside this historical snapshot.
/// Any failure immediately retires the connection and its uncommitted read.
pub struct SnapshotRecordSql<W: RecordSourceWitness> {
    connection: Option<crate::sqlite_work::SuppliedConnection>,
    limits: ReadLimits,
    witness: W,
    cancelled: Arc<AtomicBool>,
    timing: Option<QueryTiming>,
}
impl<W: RecordSourceWitness> SnapshotRecordSql<W> {
    pub fn begin(
        connection: impl Into<crate::sqlite_work::SuppliedConnection>,
        limits: ReadLimits,
        mut witness: W,
        cancelled: Arc<AtomicBool>,
    ) -> ImportResult<Self> {
        let connection = connection.into();
        limits.validate()?;
        cancellation(Some(&cancelled))?;
        witness.assert_current()?;
        check_readonly_connection(&connection)?;
        if !connection.is_autocommit() {
            return refused("record snapshot requires an unborrowed connection");
        }
        // Run only trusted setup before applying client-query limits. A valid
        // small sql_bytes bound must not prevent this fixed BEGIN statement;
        // client transaction and PRAGMA mutations are then denied normally.
        configure_environment(&connection, &limits)?;
        connection.execute_batch("BEGIN DEFERRED")?;
        constrain_queries(&connection, &limits);
        let mut reader = Self {
            connection: Some(connection),
            limits,
            witness,
            cancelled,
            timing: None,
        };
        reader.check()?;
        Ok(reader)
    }
    pub(crate) fn check(&mut self) -> ImportResult<()> {
        self.check_witness(false)
    }
    fn check_witness(&mut self, disclosure: bool) -> ImportResult<()> {
        let result = (|| {
            cancellation(Some(&self.cancelled))?;
            if self.connection.is_none() {
                return refused("record snapshot was retired");
            }
            if disclosure {
                self.witness.assert_current()?;
            } else {
                self.witness.assert_query_source()?;
            }
            cancellation(Some(&self.cancelled))?;
            check_readonly_connection(self.connection.as_ref().unwrap())
        })();
        if result.is_err() {
            self.connection.take();
        }
        result
    }
    /// Final current-rights/source check and deterministic connection retirement.
    /// Dropping an unfinished reader also closes and rolls back its read snapshot.
    pub fn finish(mut self) -> ImportResult<()> {
        let result = self.check_witness(true);
        self.connection.take();
        result
    }
}
impl<W: RecordSourceWitness> SnapshotRecordSql<W> {
    fn execute(
        &mut self,
        sql: &str,
        params: &[Value],
        budget: Option<QueryBudget>,
        ordered_prefix: bool,
    ) -> ImportResult<QueryRows> {
        self.timing = None;
        let before = Instant::now();
        let checked = self.check();
        let mut timing = QueryTiming {
            precheck_us: micros(before),
            ..QueryTiming::default()
        };
        self.timing = Some(timing);
        checked?;
        let started = Instant::now();
        let meter = self.connection.as_ref().and_then(|connection| connection.meter());
        let result = query_core_mode(
            self.connection.as_ref().unwrap(),
            &self.limits,
            sql,
            params,
            Some(self.cancelled.clone()),
            budget,
            false,
            ordered_prefix,
            meter,
        );
        timing.sql_us = micros(started);
        let after = Instant::now();
        let checked = self.check();
        timing.postcheck_us = micros(after);
        self.timing = Some(timing);
        if result.is_err() || checked.is_err() {
            self.connection.take();
        }
        if result.is_err() {
            return result;
        }
        checked?;
        if budget.is_some_and(|b| Instant::now() >= b.deadline) {
            self.connection.take();
            return Err(ImportError::Budget("record caller deadline exhausted", crate::cause!()));
        }
        result
    }
}
fn micros(started: Instant) -> u64 {
    started.elapsed().as_micros().min(u64::MAX as u128) as u64
}
impl<W: RecordSourceWitness> BoundedRecordSql for SnapshotRecordSql<W> {
    fn read_source_state(&mut self) -> ImportResult<ReadSourceState> {
        let connection = self.connection.as_ref().ok_or(ImportError::Refused("record snapshot was retired", crate::cause!()))?;
        // Physical facts only: no fresh authority, source value, SQL, or budget
        // is read here. Cancellation/admission stay with actual query/finish.
        let transaction = unsafe { rusqlite::ffi::sqlite3_txn_state(connection.handle(), c"main".as_ptr()) };
        if transaction < 0 { return refused("record transaction state unavailable"); }
        Ok(ReadSourceState {
            location: connection.path().map(str::to_owned),
            changes: connection.total_changes(),
            scoped: !connection.is_autocommit(),
            writing: transaction == rusqlite::ffi::SQLITE_TXN_WRITE,
            custody: check_readonly_connection(connection).is_ok(),
            usable: !self.cancelled.load(Ordering::Acquire),
        })
    }

    fn read_limits(&self) -> Option<&ReadLimits> {
        Some(&self.limits)
    }

    fn query(&mut self, sql: &str, params: &[Value]) -> ImportResult<QueryRows> {
        self.execute(sql, params, None, false)
    }
    fn query_with_budget(
        &mut self,
        sql: &str,
        params: &[Value],
        budget: QueryBudget,
    ) -> ImportResult<QueryRows> {
        self.execute(sql, params, Some(budget), false)
    }
    fn supports_ordered_prefix(&self) -> bool { true }
    fn query_ordered_prefix_with_budget(&mut self, sql: &str, params: &[Value], budget: QueryBudget) -> ImportResult<QueryRows> {
        self.execute(sql, params, Some(budget), true)
    }
    fn main_table_exists(&mut self, name: &str, budget: QueryBudget) -> catalogue_point::Probe {
        self.timing = None;
        if let Err(error) = self.check() {
            return catalogue_point::Probe::refused(error);
        }
        let mut probe = catalogue_point::probe(
            self.connection.as_ref().unwrap(),
            name,
            &self.limits,
            budget,
            &self.cancelled,
        );
        if let Err(error) = self.check() {
            probe.exists = Err(error);
        }
        if probe.exists.is_err() {
            self.connection.take();
        }
        probe
    }
    fn last_query_timing(&self) -> Option<QueryTiming> {
        self.timing
    }
}

pub(crate) fn read_authorizer(context: AuthContext<'_>) -> Authorization {
    if context.database_name.is_some_and(|name| name != "main") {
        return Authorization::Deny;
    }
    let allowed = match context.action {
        AuthAction::Select | AuthAction::Read { .. } | AuthAction::Recursive => true,
        AuthAction::Function { function_name } => matches!(
            function_name.to_ascii_lowercase().as_str(),
            "abs"
                | "avg"
                | "count"
                | "sum"
                | "total"
                | "min"
                | "max"
                | "typeof"
                | "length"
                | "octet_length"
                | "hex"
                | "unhex"
                | "quote"
                | "lower"
                | "upper"
                | "substr"
                | "substring"
                | "instr"
                | "trim"
                | "ltrim"
                | "rtrim"
                | "replace"
                | "coalesce"
                | "ifnull"
                | "nullif"
                | "iif"
                | "json"
                | "json_valid"
                | "json_type"
                | "json_extract"
                | "json_array_length"
                | "json_object"
                | "json_array"
                | "like"
                | "glob"
                | "match"
                | "bm25"
                | "snippet"
                | "highlight"
                | "round"
                | "unicode"
        ),
        AuthAction::Pragma {
            pragma_name,
            pragma_value,
        } => {
            (pragma_name.eq_ignore_ascii_case("schema_version") && pragma_value.is_none())
                || matches!(
                    pragma_name.to_ascii_lowercase().as_str(),
                    "table_info"
                        | "table_xinfo"
                        | "table_list"
                        | "index_info"
                        | "index_xinfo"
                        | "index_list"
                        | "foreign_key_list"
                )
        }
        _ => false,
    };
    if allowed {
        Authorization::Allow
    } else {
        Authorization::Deny
    }
}

#[cfg(test)]
mod callback_unit_tests {
    use super::*;
    use rusqlite::OpenFlags;

    /// A shared work meter makes the progress handler run on every VM step, yet
    /// callers' callback budgets (for example the kept reader's 20,000) are in
    /// callbacks of `vm_steps.min(1000)` steps: a metered and an unmetered read
    /// of the same statement must report the same callback count.
    #[test]
    fn metered_read_reports_callbacks_in_the_unmetered_unit() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("callbacks.sqlite");
        Connection::open(&path).unwrap().execute_batch("CREATE TABLE t(x INTEGER)").unwrap();
        let limits = ReadLimits::default();
        let sql = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<20000) SELECT count(*) FROM c";
        let read = |meter: Option<crate::sqlite_work::WorkMeter>| {
            let connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            configure_read(&connection, &limits).unwrap();
            query_core_mode(&connection, &limits, sql, &[], None, None, false, false, meter).unwrap().progress_callbacks
        };
        let unmetered = read(None);
        let metered = read(Some(crate::sqlite_work::WorkMeter::new()));
        assert!(unmetered > 0);
        assert_eq!(metered, unmetered);
    }
}
