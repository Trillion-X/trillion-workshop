//! Purpose: share ONE admitted current record snapshot and its physical budget
//! between the canonical stored reader and canonical erasable-key lookup.
//! Invariants: no second LocalAccount borrow, path opener, key mint/getter or
//! cross-request key cache. Optional raw SQL reuse exists only on one retained
//! readonly snapshot or an internal checked stable read phase; its bounded
//! buffers are wiped before that phase ends or its source can be mutated.
//! No authority copy or fallback from unknown schema/transport to a missing key.
//! Key custody: returned keys are SecretFieldKey; owned key-bearing query/JSON
//! buffers are zeroized. Only final exclusive custody returns the original
//! supplier so its real owner can finish the snapshot and current-rights check.
//! Source: record-log-store.mjs keyInLog/projection frontier, erasable.mjs.

use crate::{
    import::{ImportError, ImportResult, QueryRows, QueryTiming, ReadLimits, SqlValue},
    legacy_kept::{Entry, LegacyKept, PointBudget},
    record_sealed::SecretFieldKey,
    record_source::{BoundedRecordSql, QueryBudget, RecordSourceWitness, SnapshotRecordSql},
    record_value::{CurrentKeys, Error, KeyState, Result},
};
use base64::{
    alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
    Engine,
};
use rusqlite::types::Value;
use serde_json::value::RawValue;
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    fmt,
    rc::Rc,
    time::{Duration, Instant},
};
use zeroize::{Zeroize, Zeroizing};
mod snapshot_memo;

#[derive(Clone, Copy)]
pub struct SharedLimits {
    pub statements: usize,
    pub rows: usize,
    pub source_bytes: usize,
    pub elapsed: Duration,
}
impl Default for SharedLimits {
    fn default() -> Self {
        Self {
            statements: 128,
            rows: 4096,
            source_bytes: 8 * 1024 * 1024,
            elapsed: Duration::from_secs(5),
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
/// Source-call attempts and actually returned metadata/cells, not SQLite scan
/// visits, policy-witness SQL on another owner, or a whole-workload cost claim.
pub struct SharedWork {
    pub sql_statements: usize,
    pub rows_returned: usize,
    pub source_bytes: usize,
    pub progress_callbacks: u64,
    /// Exact deterministic results reused on this retained snapshot, each with
    /// a new custody/cancellation check. These are not physical SQL executions.
    pub reused_queries: usize,
    /// Native calls/preparations, NOT SQL scan visits or Cloudflare units.
    pub native_metadata: crate::record_source::catalogue_point::Work,
}
struct Shared<S> {
    source: S,
    limits: SharedLimits,
    work: SharedWork,
    deadline: Instant,
    poisoned: bool,
    snapshot_check: Option<fn(&mut S) -> ImportResult<()>>,
    memo: snapshot_memo::Memo,
}
pub(crate) fn wipe_rows(rows: &mut QueryRows) {
    for row in &mut rows.rows {
        for value in row {
            if let SqlValue::Text(bytes) | SqlValue::Blob(bytes) = value {
                bytes.zeroize();
            }
        }
    }
}

/// Clone shares the SAME retained source and global counters, not account
/// authority. No source getter exists. Drop all aliases before try_into_source.
pub struct SharedRecordSql<S: BoundedRecordSql> {
    inner: Rc<RefCell<Shared<S>>>,
    limits: ReadLimits,
    timing: Option<QueryTiming>,
}
impl<S: BoundedRecordSql> Clone for SharedRecordSql<S> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            limits: self.limits.clone(),
            timing: None,
        }
    }
}
impl<S: BoundedRecordSql> fmt::Debug for SharedRecordSql<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SharedCurrentRecordSource([redacted])")
    }
}
impl<S: BoundedRecordSql> SharedRecordSql<S> {
    pub fn new(source: S, limits: SharedLimits) -> ImportResult<Self> {
        if limits.statements == 0
            || limits.statements > 4096
            || limits.rows == 0
            || limits.rows > 30_000
            || limits.source_bytes == 0
            || limits.source_bytes > 32 * 1024 * 1024
            || limits.elapsed.is_zero()
            || limits.elapsed > Duration::from_secs(30)
        {
            return Err(ImportError::Refused("shared current record limits refused", crate::cause!()));
        }
        let physical = source
            .read_limits()
            .ok_or(ImportError::Refused(
                "current record supplier limits unavailable",
             crate::cause!()))?
            .clone();
        physical.validate()?;
        Ok(Self {
            inner: Rc::new(RefCell::new(Shared {
                source,
                limits,
                work: SharedWork::default(),
                deadline: Instant::now() + limits.elapsed,
                poisoned: false,
                snapshot_check: None,
                memo: Default::default(),
            })),
            limits: physical,
            timing: None,
        })
    }
    pub fn work(&self) -> ImportResult<SharedWork> {
        self.inner
            .try_borrow()
            .map(|s| s.work)
            .map_err(|_| ImportError::Refused("current record source already borrowed", crate::cause!()))
    }
    pub fn try_into_source(self) -> ImportResult<S> {
        Ok(self.exclusive()?.source)
    }
    fn exclusive(self) -> ImportResult<Shared<S>> {
        let cell = match Rc::try_unwrap(self.inner) {
            Ok(cell) => cell,
            Err(_) => {
                return Err(ImportError::Refused("current record source still has readers", crate::cause!()));
            }
        };
        let held = cell.into_inner();
        if held.poisoned {
            return Err(ImportError::Budget("shared current record source poisoned", crate::cause!()));
        }
        if Instant::now() >= held.deadline {
            return Err(ImportError::Deadline("shared current record operation deadline exhausted", crate::cause!()));
        }
        Ok(held)
    }
    fn remaining(&self) -> ImportResult<PointBudget> {
        let h = self
            .inner
            .try_borrow()
            .map_err(|_| ImportError::Refused("current record source already borrowed", crate::cause!()))?;
        if h.poisoned {
            return Err(ImportError::Budget("shared current record source poisoned", crate::cause!()));
        }
        if Instant::now() >= h.deadline {
            return Err(ImportError::Deadline("shared current record operation deadline exhausted", crate::cause!()));
        }
        Ok(PointBudget {
            statements: h.limits.statements.saturating_sub(h.work.sql_statements),
            rows: h.limits.rows.saturating_sub(h.work.rows_returned),
            source_bytes: h.limits.source_bytes.saturating_sub(h.work.source_bytes),
            deadline: h.deadline,
        })
    }
    fn execute(
        &mut self,
        sql: &str,
        params: &[Value],
        caller: Option<QueryBudget>,
        reusable: bool,
        checkpoint: bool,
        ordered_prefix: bool,
    ) -> ImportResult<QueryRows> {
        self.timing = None;
        let mut h = self
            .inner
            .try_borrow_mut()
            .map_err(|_| ImportError::Refused("current record source already borrowed", crate::cause!()))?;
        if h.poisoned {
            return Err(ImportError::Budget("shared current record source poisoned", crate::cause!()));
        }
        if Instant::now() >= h.deadline {
            h.poisoned = true;
            return Err(ImportError::Deadline("shared current record operation deadline exhausted", crate::cause!()));
        }
        // Caller/result bounds apply to BOTH cached and physical answers. The
        // remaining physical allowance applies only when issuing new SQL:
        // returning an already charged, bounded snapshot result does not read
        // its rows/bytes from the source for a second time.
        let mut rows = self.limits.rows;
        // Ordered-prefix supply enforces its own packet ceiling while the
        // caller's aggregate allowance must remain distinct. Passing the
        // packet ceiling as the aggregate would turn resumable packet end
        // into an aggregate failure. No native packet bound is increased.
        let mut bytes = if ordered_prefix { h.limits.source_bytes.saturating_sub(h.work.source_bytes) } else { self.limits.result_bytes };
        let mut deadline = h.deadline;
        if let Some(cap) = caller {
            rows = rows.min(cap.rows);
            bytes = bytes.min(cap.source_bytes);
            deadline = deadline.min(cap.deadline);
        }
        if Instant::now() >= deadline {
            h.poisoned = true;
            return Err(ImportError::Deadline("shared current record operation deadline exhausted", crate::cause!()));
        }
        if rows == 0 || bytes == 0 {
            h.poisoned = true;
            return Err(ImportError::Budget(
                "shared current record allowance exhausted",
             crate::cause!()));
        }
        if reusable {
            if let Some(check) = h.snapshot_check {
                if let Some(mut answer) = h.memo.find(sql, params, rows, bytes) {
                    let started = Instant::now();
                    if let Err(error) = check(&mut h.source) {
                        h.poisoned = true;
                        wipe_rows(&mut answer);
                        return Err(error);
                    }
                    if Instant::now() >= deadline {
                        h.poisoned = true;
                        wipe_rows(&mut answer);
                        return Err(ImportError::Deadline("shared current record operation deadline exhausted", crate::cause!()));
                    }
                    self.timing = Some(QueryTiming {
                        precheck_us: started.elapsed().as_micros().min(u64::MAX as u128) as u64,
                        ..Default::default()
                    });
                    h.work.reused_queries += 1;
                    return Ok(answer);
                }
            }
        }
        rows = rows.min(h.limits.rows.saturating_sub(h.work.rows_returned));
        bytes = bytes.min(h.limits.source_bytes.saturating_sub(h.work.source_bytes));
        if rows == 0 || bytes == 0 {
            h.poisoned = true;
            return Err(ImportError::Budget(
                "shared current record allowance exhausted",
             crate::cause!()));
        }
        if h.work.sql_statements >= h.limits.statements {
            h.poisoned = true;
            return Err(ImportError::Budget(
                "shared current record statement limit exhausted",
             crate::cause!()));
        }
        h.work.sql_statements += 1;
        let budget = QueryBudget {
            rows,
            source_bytes: bytes,
            deadline,
        };
        let answer = if ordered_prefix {
            h.source.query_ordered_prefix_with_budget(sql, params, budget)
        } else if checkpoint {
            h.source.query_checkpoint_with_budget(sql, params, budget)
        } else if reusable {
            // Reuse belongs to the supplied physical owner. Forward the
            // existing contract even when this wrapper owns no snapshot memo.
            h.source.query_reusable_with_budget(sql, params, budget)
        } else {
            h.source.query_with_budget(sql, params, budget)
        };
        self.timing = h.source.last_query_timing();
        let mut answer = match answer {
            Ok(rows) => rows,
            Err(error) => {
                h.poisoned = true;
                return Err(error);
            }
        };
        let header = answer
            .columns
            .iter()
            .try_fold(0_usize, |n, name| n.checked_add(name.len()));
        let actual = header.and_then(|header| {
            answer
                .rows
                .iter()
                .flat_map(|r| r.iter())
                .try_fold(header, |n, v| {
                    n.checked_add(match v {
                        SqlValue::Text(v) | SqlValue::Blob(v) => v.len(),
                        _ => 8,
                    })
                })
        });
        let Some(actual) = actual else {
            h.poisoned = true;
            wipe_rows(&mut answer);
            return Err(ImportError::Budget(
                "shared current record byte count overflow",
             crate::cause!()));
        };
        h.work.rows_returned = h.work.rows_returned.saturating_add(answer.rows.len());
        h.work.source_bytes = h.work.source_bytes.saturating_add(actual);
        h.work.progress_callbacks = h
            .work
            .progress_callbacks
            .saturating_add(answer.progress_callbacks);
        if answer.rows.len() > rows || actual > bytes {
            h.poisoned = true;
            wipe_rows(&mut answer);
            return Err(ImportError::Budget(
                "shared current record supplier exceeded allowance",
             crate::cause!()));
        }
        if Instant::now() >= deadline {
            h.poisoned = true;
            wipe_rows(&mut answer);
            return Err(ImportError::Deadline("shared current record operation deadline exhausted", crate::cause!()));
        }
        if reusable && h.snapshot_check.is_some() {
            h.memo.retain(sql, params, &answer, actual);
        }
        Ok(answer)
    }
}
impl<S: BoundedRecordSql> BoundedRecordSql for SharedRecordSql<S> {
    fn read_source_state(&mut self) -> ImportResult<crate::record_source::ReadSourceState> {
        let mut held = self.inner.try_borrow_mut().map_err(|_| ImportError::Refused("current record source already borrowed", crate::cause!()))?;
        // Observation changes no shared allowance and conveys no authority.
        // Actual operations still pass through execute's poison/deadline checks.
        if held.poisoned { return Err(ImportError::Budget("shared current record source poisoned", crate::cause!())); }
        if Instant::now() >= held.deadline { return Err(ImportError::Deadline("shared current record operation deadline exhausted", crate::cause!())); }
        held.source.read_source_state()
    }

    fn read_limits(&self) -> Option<&ReadLimits> {
        Some(&self.limits)
    }
    fn query(&mut self, sql: &str, params: &[Value]) -> ImportResult<QueryRows> {
        self.execute(sql, params, None, false, false, false)
    }
    fn query_with_budget(
        &mut self,
        sql: &str,
        params: &[Value],
        budget: QueryBudget,
    ) -> ImportResult<QueryRows> {
        self.execute(sql, params, Some(budget), false, false, false)
    }
    fn query_reusable_with_budget(
        &mut self,
        sql: &str,
        params: &[Value],
        budget: QueryBudget,
    ) -> ImportResult<QueryRows> {
        self.execute(sql, params, Some(budget), true, false, false)
    }
    fn query_checkpoint_with_budget(
        &mut self,
        sql: &str,
        params: &[Value],
        budget: QueryBudget,
    ) -> ImportResult<QueryRows> {
        self.execute(sql, params, Some(budget), true, true, false)
    }
    fn supports_ordered_prefix(&self) -> bool {
        self.inner.try_borrow().is_ok_and(|held| held.source.supports_ordered_prefix())
    }
    fn query_ordered_prefix_with_budget(&mut self, sql: &str, params: &[Value], budget: QueryBudget) -> ImportResult<QueryRows> {
        self.execute(sql, params, Some(budget), false, false, true)
    }
    fn main_table_exists(
        &mut self,
        name: &str,
        mut cap: QueryBudget,
    ) -> crate::record_source::catalogue_point::Probe {
        use crate::record_source::catalogue_point::Probe;
        self.timing = None;
        let mut held = match self.inner.try_borrow_mut() {
            Ok(held) => held,
            Err(_) => {
                return Probe::refused(ImportError::Refused(
                    "current record source already borrowed",
                 crate::cause!()))
            }
        };
        cap.deadline = cap.deadline.min(held.deadline);
        if !held.poisoned && cap.rows > 0 && cap.source_bytes > 0 && Instant::now() < cap.deadline {
            if let Some(check) = held.snapshot_check {
                if let Some(exists) = held.memo.table(name) {
                    if let Err(error) = check(&mut held.source) {
                        held.poisoned = true;
                        return Probe::refused(error);
                    }
                    if Instant::now() >= cap.deadline {
                        held.poisoned = true;
                        return Probe::refused(ImportError::Deadline("shared metadata operation deadline exhausted", crate::cause!()));
                    }
                    held.work.native_metadata.reused_probes += 1;
                    return Probe {
                        exists: Ok(exists),
                        work: crate::record_source::catalogue_point::Work {
                            reused_probes: 1,
                            ..Default::default()
                        },
                    };
                }
            }
        }
        cap.rows = cap
            .rows
            .min(held.limits.rows.saturating_sub(held.work.rows_returned));
        cap.source_bytes = cap.source_bytes.min(
            held.limits
                .source_bytes
                .saturating_sub(held.work.source_bytes),
        );
        if held.poisoned
            || cap.rows == 0
            || cap.source_bytes == 0
            || held.work.sql_statements >= held.limits.statements
            || held.work.native_metadata.metadata_calls >= held.limits.statements as u64
            || held.work.native_metadata.origin_prepares >= held.limits.statements as u64
        {
            held.poisoned = true;
            return Probe::refused(ImportError::Budget(
                "shared native metadata allowance exhausted",
             crate::cause!()));
        }
        if Instant::now() >= cap.deadline {
            held.poisoned = true;
            return Probe::refused(ImportError::Deadline("shared metadata operation deadline exhausted", crate::cause!()));
        }
        let mut probe = held.source.main_table_exists(name, cap);
        held.work.sql_statements = held
            .work
            .sql_statements
            .saturating_add(probe.work.pin_sql_statements as usize);
        held.work.rows_returned = held
            .work
            .rows_returned
            .saturating_add(probe.work.pin_rows_returned as usize);
        held.work.source_bytes = held
            .work
            .source_bytes
            .saturating_add(probe.work.pin_source_bytes as usize);
        held.work.progress_callbacks = held
            .work
            .progress_callbacks
            .saturating_add(probe.work.pin_progress_callbacks);
        if let Err(error) = held.work.native_metadata.merge(probe.work) {
            probe.exists = Err(error);
        }
        if held.work.sql_statements > held.limits.statements
            || held.work.rows_returned > held.limits.rows
            || held.work.source_bytes > held.limits.source_bytes
        {
            probe.exists = Err(ImportError::Budget(
                "shared native metadata pin exceeded source allowance",
             crate::cause!()));
        }
        if probe.exists.is_err() || Instant::now() >= cap.deadline {
            held.poisoned = true;
            if probe.exists.is_ok() {
                probe.exists = Err(ImportError::Deadline("shared current record operation deadline exhausted", crate::cause!()));
            }
        }
        if !held.poisoned && held.snapshot_check.is_some() {
            if let Ok(exists) = &probe.exists {
                held.memo.retain_table(name, *exists);
            }
        }
        probe
    }
    fn last_query_timing(&self) -> Option<QueryTiming> {
        self.timing
    }
}

impl<W: RecordSourceWitness> SharedRecordSql<SnapshotRecordSql<W>> {
    /// Reuse is available only with the actual retained readonly snapshot.
    /// Generic suppliers stay uncached, and ordinary queries are never reused.
    pub fn new_reusing_snapshot(
        source: SnapshotRecordSql<W>,
        limits: SharedLimits,
    ) -> ImportResult<Self> {
        let shared = Self::new(source, limits)?;
        shared.inner.borrow_mut().snapshot_check = Some(SnapshotRecordSql::check);
        Ok(shared)
    }
    /// Exclusive retirement also bounds the final real witness check. Prefer
    /// this over extracting the source and forgetting the post-finish deadline.
    pub fn finish(self) -> ImportResult<()> {
        let held = self.exclusive()?;
        held.source.finish()?;
        if Instant::now() >= held.deadline {
            return Err(ImportError::Deadline("shared current record operation deadline exhausted", crate::cause!()));
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
pub struct KeyLimits {
    pub tail_rows: usize,
    pub key_json_bytes: usize,
}
impl Default for KeyLimits {
    fn default() -> Self {
        Self {
            tail_rows: 4096,
            key_json_bytes: 1024 * 1024,
        }
    }
}

/// Concrete CURRENT source type: an immutable original adapter cannot satisfy
/// this constructor. The snapshot owns the real native witness/cancellation.
pub type CurrentKeyReader<'a, W> = SourceKeyReader<'a, SnapshotRecordSql<W>>;

/// Canonical key replay over one retained current source. The selected write
/// producer uses the same decoder while it owns the IMMEDIATE transaction.
pub struct SourceKeyReader<'a, S: BoundedRecordSql> {
    source: SharedRecordSql<S>,
    kept: &'a LegacyKept,
    limits: KeyLimits,
}
impl<S: BoundedRecordSql> fmt::Debug for SourceKeyReader<'_, S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CurrentRecordKeys([redacted])")
    }
}
fn imported(e: ImportError) -> Error {
    match e {
        ImportError::Budget(_, cause) => Error::Bounds(cause),
        _ => Error::Source(e.cause()),
    }
}
struct SensitiveRows(QueryRows);
impl Drop for SensitiveRows {
    fn drop(&mut self) {
        wipe_rows(&mut self.0);
    }
}
enum Candidate {
    Absent,
    Present(Zeroizing<[u8; 32]>),
}
fn text(value: &SqlValue) -> Result<&str> {
    match value {
        SqlValue::Text(bytes) => std::str::from_utf8(bytes).map_err(|error| crate::carry_cause!(Error::Source, error)),
        _ => Err(crate::cause!(Error::Source)),
    }
}
fn integer(value: &SqlValue) -> Result<i64> {
    match value {
        SqlValue::Integer(n) => Ok(*n),
        _ => Err(crate::cause!(Error::Source)),
    }
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 4096 && !id.contains('\0')
}
fn decode_key(raw: &RawValue) -> Result<Zeroizing<[u8; 32]>> {
    let encoded =
        Zeroizing::new(serde_json::from_str::<String>(raw.get()).map_err(|error| crate::carry_cause!(Error::Source, error))?);
    if encoded.len() > 128 {
        return Err(crate::cause!(Error::Bounds));
    }
    let mut clean = Zeroizing::new(Vec::with_capacity(encoded.len()));
    for byte in encoded.bytes() {
        if !matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | 12) {
            clean.push(byte);
        }
    }
    let engine = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let decoded = Zeroizing::new(engine.decode(clean.as_slice()).map_err(|error| crate::carry_cause!(Error::Source, error))?);
    if decoded.len() != 32 {
        return Err(crate::cause!(Error::Source));
    }
    let mut key = Zeroizing::new([0_u8; 32]);
    key.copy_from_slice(&decoded);
    Ok(key)
}
fn holder(raw: &RawValue) -> Result<Option<Zeroizing<[u8; 32]>>> {
    if raw.get() == "null" {
        return Ok(None);
    }
    let object: BTreeMap<String, &RawValue> =
        serde_json::from_str(raw.get()).map_err(|error| crate::carry_cause!(Error::Source, error))?;
    object.get("key").map(|raw| decode_key(raw)).transpose()
}
impl<'a, W: RecordSourceWitness> SourceKeyReader<'a, SnapshotRecordSql<W>> {
    pub fn new(
        source: SharedRecordSql<SnapshotRecordSql<W>>,
        kept: &'a LegacyKept,
        limits: KeyLimits,
    ) -> Result<Self> {
        Self::new_in_transaction(source, kept, limits)
    }
}
impl<'a, S: BoundedRecordSql> SourceKeyReader<'a, S> {
    // Crate-private: selected native writer supplies its same transaction and
    // independently rechecks actual account/source rights before and after use.
    pub(crate) fn new_in_transaction(
        source: SharedRecordSql<S>,
        kept: &'a LegacyKept,
        limits: KeyLimits,
    ) -> Result<Self> {
        if limits.tail_rows == 0
            || limits.tail_rows > 30_000
            || limits.key_json_bytes == 0
            || limits.key_json_bytes > 8 * 1024 * 1024
        {
            return Err(crate::cause!(Error::Invalid));
        }
        Ok(Self {
            source,
            kept,
            limits,
        })
    }
    pub fn into_source(self) -> SharedRecordSql<S> {
        self.source
    }
    fn query(&mut self, sql: &str, params: &[Value]) -> Result<SensitiveRows> {
        let cap = self.source.remaining().map_err(imported)?;
        self.source
            .query_reusable_with_budget(
                sql,
                params,
                QueryBudget {
                    rows: cap.rows,
                    source_bytes: cap.source_bytes,
                    deadline: cap.deadline,
                },
            )
            .map(SensitiveRows)
            .map_err(imported)
    }
    fn checkpoint_query(&mut self, sql: &str, params: &[Value]) -> Result<SensitiveRows> {
        let cap = self.source.remaining().map_err(imported)?;
        self.source
            .query_checkpoint_with_budget(
                sql,
                params,
                QueryBudget {
                    rows: cap.rows,
                    source_bytes: cap.source_bytes,
                    deadline: cap.deadline,
                },
            )
            .map(SensitiveRows)
            .map_err(imported)
    }
    fn schema(&mut self, table: &str, required: &[&str]) -> Result<()> {
        // Identifiers here are exclusively fixed owner literals.
        let result = self.query(&format!("PRAGMA table_info({table})"), &[])?;
        let mut names = BTreeSet::new();
        for row in &result.0.rows {
            if row.len() < 2 {
                return Err(crate::cause!(Error::Source));
            }
            names.insert(text(&row[1])?.to_owned());
        }
        if required.iter().any(|n| !names.contains(*n)) {
            return Err(crate::cause!(Error::Source));
        }
        Ok(())
    }
    fn point(&mut self, key: &str) -> Result<Entry> {
        let mut budget = self.source.remaining().map_err(imported)?;
        {
            let held = self.source.inner.try_borrow().map_err(|error| crate::carry_cause!(Error::Source, error))?;
            if held.snapshot_check.is_some() {
                // Point work counts logical supplier calls, including reused
                // rows. It retains the SAME per-operation statement ceiling;
                // SharedRecordSql independently enforces the remaining actual
                // SQL allowance across all points and both value/key readers.
                // A repeated point must not spend that physical remainder a
                // second time just because its loop revisits retained pages.
                budget.statements = held.limits.statements;
            }
        }
        self.kept
            .point_with_budget(&mut self.source, key, budget)
            .map(|p| p.entry)
            .map_err(|e| {
                if e.budget_exhausted {
                    crate::cause!(Error::Bounds)
                } else {
                    crate::cause!(Error::Source)
                }
            })
    }
    fn checkpoint(&mut self, id: &str) -> Result<Candidate> {
        match self.point(&format!("e\0{id}"))? {
            Entry::Tombstone => {}
            Entry::Json(raw) => {
                let raw = Zeroizing::new(raw);
                let value: &RawValue = serde_json::from_str(&raw).map_err(|error| crate::carry_cause!(Error::Source, error))?;
                if let Some(key) = holder(value)? {
                    return Ok(Candidate::Present(key));
                }
            }
            Entry::Absent => {}
        }
        match self.point(&format!("i\0{id}"))? {
            Entry::Absent => Ok(Candidate::Absent),
            Entry::Tombstone => Ok(Candidate::Absent),
            Entry::Json(raw) => {
                let raw = Zeroizing::new(raw);
                let slots: Vec<&RawValue> =
                    serde_json::from_str(&raw).map_err(|error| crate::carry_cause!(Error::Source, error))?;
                if !(2..=5).contains(&slots.len()) {
                    return Err(crate::cause!(Error::Source));
                }
                Ok(
                    match slots
                        .get(4)
                        .map(|value| holder(value))
                        .transpose()?
                        .flatten()
                    {
                        Some(key) => Candidate::Present(key),
                        None => Candidate::Absent,
                    },
                )
            }
        }
    }
    fn frontier(&mut self) -> Result<(i64, i64)> {
        self.schema("record_keys_meta", &["key", "value"])?;
        self.schema(
            "record_log",
            &["id", "transaction_id", "part", "parts", "envelopes", "keys"],
        )?;
        let meta = self.checkpoint_query(
            "SELECT value FROM record_keys_meta WHERE key=? LIMIT 1",
            &[Value::Text("engine".into())],
        )?;
        if let Some(row) = meta.0.rows.first() {
            if row.len() != 1
                || serde_json::from_str::<String>(text(&row[0])?).map_err(|error| crate::carry_cause!(Error::Source, error))?
                    != "record-log"
            {
                return Err(crate::cause!(Error::Source));
            }
        } else {
            // Match the canonical reader's older engine selection. A missing
            // engine fact does not authorize interpreting an EEAF snapshot as
            // record-log key entries merely because some table names overlap.
            let entity_types = self.query(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='entity_types' LIMIT 1",
                &[],
            )?;
            if !entity_types.0.rows.is_empty() {
                let own = self.query(
                    "SELECT 1 FROM entity_types WHERE type_id NOT IN ('type:type','type:property','type:role') LIMIT 1", &[],
                )?;
                if !own.0.rows.is_empty() {
                    return Err(crate::cause!(Error::Source));
                }
            }
        }
        let covered = self.checkpoint_query(
            "SELECT value FROM record_keys_meta WHERE key=? LIMIT 1",
            &[Value::Text("covered".into())],
        )?;
        let covered = match covered.0.rows.first() {
            None => 0,
            Some(row) => {
                if row.len() != 1 {
                    return Err(crate::cause!(Error::Source));
                }
                let value: serde_json::Value =
                    serde_json::from_str(text(&row[0])?).map_err(|error| crate::carry_cause!(Error::Source, error))?;
                let at = if value.is_object() {
                    value.get("at").ok_or(crate::cause!(Error::Source))?
                } else {
                    &value
                };
                if at.is_null() {
                    0
                } else {
                    at.as_i64().filter(|n| *n >= 0).ok_or(crate::cause!(Error::Source))?
                }
            }
        };
        let last = self.query(
            "SELECT rowid FROM record_log ORDER BY rowid DESC LIMIT 1",
            &[],
        )?;
        let last = match last.0.rows.first() {
            None => 0,
            Some(row) if row.len() == 1 => integer(&row[0])?,
            _ => return Err(crate::cause!(Error::Source)),
        };
        if covered > last || last < 0 {
            return Err(crate::cause!(Error::Source));
        }
        Ok((covered, last))
    }
    fn replay(
        &mut self,
        id: &str,
        mut candidate: Candidate,
        mut after: i64,
        last: i64,
    ) -> Result<Candidate> {
        struct Pending {
            id: String,
            transaction: String,
            parts: i64,
            seen: i64,
            key: Option<Zeroizing<[u8; 32]>>,
        }
        let mut pending: Option<Pending> = None;
        let mut count = 0_usize;
        let page = self.source.read_limits().ok_or(crate::cause!(Error::Source))?.rows.min(64);
        if page == 0 {
            return Err(crate::cause!(Error::Source));
        }
        while after < last {
            let rows=self.query("SELECT rowid,id,transaction_id,part,parts,CASE WHEN length(CAST(keys AS BLOB))<=?1 THEN keys END,length(CAST(keys AS BLOB)) FROM record_log WHERE rowid>?2 AND rowid<=?3 ORDER BY rowid LIMIT ?4",
                &[Value::Integer(self.limits.key_json_bytes as i64),Value::Integer(after),Value::Integer(last),Value::Integer(page as i64)])?;
            if rows.0.rows.is_empty() {
                return Err(crate::cause!(Error::Source));
            }
            for row in &rows.0.rows {
                count += 1;
                if count > self.limits.tail_rows || row.len() != 7 {
                    return Err(crate::cause!(Error::Bounds));
                }
                let at = integer(&row[0])?;
                if at <= after || at > last {
                    return Err(crate::cause!(Error::Source));
                }
                after = at;
                let row_id = text(&row[1])?;
                let transaction = text(&row[2])?;
                let part = integer(&row[3])?;
                let parts = integer(&row[4])?;
                if !valid_id(row_id)
                    || !valid_id(transaction)
                    || parts <= 0
                    || parts > 4096
                    || part < 0
                    || part >= parts
                {
                    return Err(crate::cause!(Error::Source));
                }
                if part == 0 {
                    if pending.is_some() {
                        return Err(crate::cause!(Error::Source));
                    }
                    let key = match &row[6] {
                        SqlValue::Null => {
                            if !matches!(&row[5], SqlValue::Null) {
                                return Err(crate::cause!(Error::Source));
                            }
                            None
                        }
                        SqlValue::Integer(n)
                            if *n >= 0 && *n as usize <= self.limits.key_json_bytes =>
                        {
                            let raw = text(&row[5])?;
                            if raw.len() != *n as usize {
                                return Err(crate::cause!(Error::Source));
                            }
                            let keys: BTreeMap<String, &RawValue> =
                                serde_json::from_str(raw).map_err(|error| crate::carry_cause!(Error::Source, error))?;
                            keys.get(id).map(|raw| decode_key(raw)).transpose()?
                        }
                        _ => return Err(crate::cause!(Error::Bounds)),
                    };
                    pending = Some(Pending {
                        id: row_id.into(),
                        transaction: transaction.into(),
                        parts,
                        seen: 0,
                        key,
                    });
                } else if !matches!(&row[5], SqlValue::Null) || !matches!(&row[6], SqlValue::Null) {
                    return Err(crate::cause!(Error::Source));
                }
                let held = pending.as_mut().ok_or(crate::cause!(Error::Source))?;
                let expected = if part == 0 {
                    held.id.clone()
                } else {
                    format!("{}.{part}", held.id)
                };
                if part != held.seen
                    || parts != held.parts
                    || transaction != held.transaction
                    || row_id != expected
                {
                    return Err(crate::cause!(Error::Source));
                }
                held.seen += 1;
                if held.seen == held.parts {
                    if let Some(key) = pending.take().ok_or(crate::cause!(Error::Source))?.key {
                        candidate = Candidate::Present(key);
                    }
                }
            }
        }
        if pending.is_some() {
            return Err(crate::cause!(Error::Source));
        }
        Ok(candidate)
    }
    fn lookup(&mut self, id: &str) -> Result<KeyState> {
        self.schema(
            "record_erasable_keys",
            &["record_id", "key", "erased_at", "erased_fields"],
        )?;
        // The original erase transaction removes the producer-row key and
        // scrubs every e/i key root. A subsequent write makes a NEW current
        // key without deleting the retained table tombstone. Resolve that
        // current owner first, including after sealing clears raw log keys.
        // The source has no erasure generation with which to distinguish an
        // arbitrarily forged stale positive root from valid recreation.
        let (covered, last) = self.frontier()?;
        let candidate = self.checkpoint(id)?;
        let candidate = self.replay(id, candidate, covered, last)?;
        if let Candidate::Present(key) = candidate {
            return Ok(KeyState::Present(SecretFieldKey::from_bytes(key)));
        }
        let erased = self.query(
            "SELECT erased_at FROM record_erasable_keys WHERE record_id=? LIMIT 1",
            &[Value::Text(id.into())],
        )?;
        if let Some(row) = erased.0.rows.first() {
            if row.len() != 1 {
                return Err(crate::cause!(Error::Source));
            }
            match &row[0] {
                SqlValue::Null => {}
                SqlValue::Text(v) if !v.is_empty() => return Ok(KeyState::Erased),
                _ => return Err(crate::cause!(Error::Source)),
            }
        }
        let fallback=self.query("SELECT length(key),CASE WHEN length(key)=32 THEN key END FROM record_erasable_keys WHERE record_id=? LIMIT 1",&[Value::Text(id.into())])?;
        let row = match fallback.0.rows.first() {
            None => return Ok(KeyState::Missing),
            Some(row) if row.len() == 2 => row,
            _ => return Err(crate::cause!(Error::Source)),
        };
        if matches!((&row[0], &row[1]), (SqlValue::Null, SqlValue::Null)) {
            return Ok(KeyState::Missing);
        }
        match (&row[0], &row[1]) {
            (SqlValue::Integer(32), SqlValue::Blob(value)) if value.len() == 32 => {
                let mut key = Zeroizing::new([0_u8; 32]);
                key.copy_from_slice(value);
                Ok(KeyState::Present(SecretFieldKey::from_bytes(key)))
            }
            _ => Err(crate::cause!(Error::Source)),
        }
    }
}
impl<S: BoundedRecordSql> CurrentKeys for SourceKeyReader<'_, S> {
    fn assert_current(&mut self) -> Result<()> {
        let check = self.query("SELECT 1", &[])?;
        if check.0.rows.len() != 1
            || check.0.rows[0].len() != 1
            || integer(&check.0.rows[0][0])? != 1
        {
            return Err(crate::cause!(Error::Source));
        }
        Ok(())
    }
    fn key(&mut self, id: &str) -> Result<KeyState> {
        if !valid_id(id) {
            return Err(crate::cause!(Error::Invalid));
        }
        self.assert_current()?;
        let answer = self.lookup(id);
        self.assert_current()?;
        answer
    }
}
