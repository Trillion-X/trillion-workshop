//! Bounded current-index reads from the admitted record-log snapshot.
//!
//! `LegacyKept::range` is checkpoint-only. This reader replays the canonical
//! dirty tail, removes those IDs from checkpoint results, and plans their
//! current index entries with the declared-index owner before merging pages.
//! The caller still owns the final rights/delivery witness for this snapshot.

use super::*;
use crate::{
    kept_runs::ReadBudget,
    legacy_kept::{
        self,
        range::{self, RangeLimits, Request},
    },
    record_indexes::{self, FieldAccess, Indexes, Query, Readiness},
};
use serde_json::Value as Json;
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
    time::Instant,
};

#[derive(Clone, Copy, Debug)]
pub struct CurrentIndexLimits {
    pub dirty_ids: usize,
    pub held_bytes: usize,
    pub checkpoint_entries: usize,
    pub checkpoint_pages: usize,
    pub output_bytes: usize,
}
impl Default for CurrentIndexLimits {
    fn default() -> Self {
        Self {
            dirty_ids: 256,
            held_bytes: 16 * 1024 * 1024,
            checkpoint_entries: 4096,
            checkpoint_pages: 256,
            output_bytes: 1024 * 1024,
        }
    }
}

/// Closed causes for a refused current-index read. Numeric observations are
/// logical supplier calls/returned cells, never scan visits or billing units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IndexBoundReason {
    Request,
    DirtyRecords,
    DirtyBytes,
    RecordCalls,
    RecordRows,
    RecordBytes,
    RecordElapsed,
    DirtyTailRefused,
    CheckpointBudget,
    SourceAllowance,
    Elapsed,
    CheckpointHeld,
    CandidatesHeld,
    FieldsHeld,
    DirtyCandidatesHeld,
    FirstOutputBytes,
    CursorMissing,
}
impl IndexBoundReason {
    pub fn header(self) -> &'static str {
        match self {
            Self::Request => "request",
            Self::DirtyRecords => "dirty-records",
            Self::DirtyBytes => "dirty-bytes",
            Self::RecordCalls => "record-calls",
            Self::RecordRows => "record-rows",
            Self::RecordBytes => "record-bytes",
            Self::RecordElapsed => "record-elapsed",
            Self::DirtyTailRefused => "dirty-tail-refused",
            Self::CheckpointBudget => "checkpoint-budget",
            Self::SourceAllowance => "source-allowance",
            Self::Elapsed => "elapsed",
            Self::CheckpointHeld => "checkpoint-held",
            Self::CandidatesHeld => "candidates-held",
            Self::FieldsHeld => "fields-held",
            Self::DirtyCandidatesHeld => "dirty-candidates-held",
            Self::FirstOutputBytes => "first-output-bytes",
            Self::CursorMissing => "cursor-missing",
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct IndexBoundDiagnostic {
    pub reason: IndexBoundReason,
    pub source_calls: usize,
    pub returned_rows: usize,
    pub source_bytes: usize,
    pub dirty_records: usize,
    pub held_peak_bytes: usize,
    pub uncovered_log_rows: u64,
    pub elapsed_us: u64,
}
impl IndexBoundDiagnostic {
    pub fn numeric_header(self) -> String {
        format!(
            "calls={},returned={},bytes={},dirty={},held={},uncovered={},us={}",
            self.source_calls,
            self.returned_rows,
            self.source_bytes,
            self.dirty_records,
            self.held_peak_bytes,
            self.uncovered_log_rows,
            self.elapsed_us
        )
    }
}
#[track_caller]
fn bound(
    reason: IndexBoundReason,
    meter: Option<&Meter>,
    dirty: usize,
    held: usize,
    uncovered: u64,
) -> record_indexes::Error {
    #[cfg(test)]
    if let Some(m) = meter {
        crate::quiet_eprintln!("INDEX_INTERNAL_BOUND outer={:?} diagnostic={:?}", reason, m.diagnostic);
    }
    record_indexes::Error::CurrentIndexBound(IndexBoundDiagnostic {
        reason,
        source_calls: meter.map_or(0, |m| m.statements),
        returned_rows: meter.map_or(0, |m| m.rows),
        source_bytes: meter.map_or(0, |m| m.bytes),
        dirty_records: dirty,
        held_peak_bytes: held,
        uncovered_log_rows: uncovered,
        elapsed_us: meter.map_or(0, |m| {
            m.started.elapsed().as_micros().min(u64::MAX as u128) as u64
        }),
    }, crate::refusal_cause::Cause::from_caller())
}
fn meter_reason(meter: &Meter, fallback: IndexBoundReason) -> IndexBoundReason {
    match meter.diagnostic.as_ref().map(|d| d.reason) {
        Some("dirty record bound exhausted") => IndexBoundReason::DirtyRecords,
        Some("dirty projection bytes exhausted") => IndexBoundReason::DirtyBytes,
        Some(
            "original record statement budget exhausted" | "original kept SQL budget exhausted",
        ) => IndexBoundReason::RecordCalls,
        Some(
            "original record row budget exhausted"
            | "original kept row budget exhausted"
            | "original kept batch row budget exhausted"
            | "original kept batched boundary key row budget exhausted"
            | "original kept page batch row budget exhausted",
        ) => IndexBoundReason::RecordRows,
        Some(
            "original record source byte budget exhausted"
            | "original record multipart byte budget exhausted"
            | "original kept source byte budget exhausted",
        ) => IndexBoundReason::RecordBytes,
        Some(
            "original record elapsed budget exhausted" | "original kept point deadline exhausted",
        ) => IndexBoundReason::RecordElapsed,
        Some(
            "shared current record budget exhausted"
            | "shared current record allowance exhausted"
            | "shared native metadata allowance exhausted",
        ) => IndexBoundReason::SourceAllowance,
        _ if meter
            .diagnostic
            .as_ref()
            .is_some_and(|d| d.stage == "kept-point-budget") =>
        {
            IndexBoundReason::CheckpointBudget
        }
        _ => fallback,
    }
}

#[derive(Debug, Default)]
pub struct CurrentIndexWork {
    /// Kept-run range work remains in its own native accounting unit.
    pub checkpoint: legacy_kept::Work,
    /// Aggregate bounded SQL/replay work charged by the record-log reader.
    pub record_log_statements: usize,
    pub record_log_rows: usize,
    pub record_log_source_bytes: usize,
    pub elapsed_us: u64,
    pub dirty_records: usize,
    pub dirty_index_entries: usize,
    pub held_peak_bytes: usize,
    pub serialized_bytes: usize,
    /// The ordered fast path validates current-head coverage in its existing
    /// owner. Its physical SQL is included in the connection observer, while
    /// the record-log aggregate above does not include those owner calls.
    pub ordered_coverage_outside_record_meter: bool,
}
pub struct CurrentIndexPage {
    pub entries: Vec<record_indexes::Entry>,
    pub next: Option<record_indexes::Cursor>,
    pub complete: bool,
    pub serialized_bytes: usize,
    pub work: CurrentIndexWork,
}
/// Complete exact-equality groups read from one declaration and one dirty-tail
/// replay. Group positions match the caller's value positions, including repeats.
pub struct CurrentIndexGroups {
    pub groups: Vec<Vec<record_indexes::Entry>>,
    pub serialized_bytes: usize,
    pub work: CurrentIndexWork,
}
impl fmt::Debug for CurrentIndexPage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CurrentRecordIndexPage([redacted])")
    }
}

pub(super) struct Dirty {
    pub(super) id: String,
    pub(super) projection: Projection,
    pub(super) bytes: usize,
}

pub(super) fn held_bytes(id: &str, projection: &Projection) -> usize {
    let mut bytes = id.len().saturating_mul(3).saturating_add(256);
    if let Some(held) = &projection.held {
        bytes = bytes.saturating_add(held.record_type.as_ref().map_or(0, String::len));
        if let Some(fields) = &held.value {
            for (name, value) in fields.iter() {
                bytes = bytes
                    .saturating_add(name.len().saturating_mul(2))
                    .saturating_add(96);
                bytes = bytes.saturating_add(value.as_str().map_or(0, str::len));
            }
        }
        if let Some(meta) = &held.meta {
            bytes = bytes.saturating_add(meta.at.len());
            for (name, stamp) in meta.s.iter().chain(meta.d.iter()) {
                bytes = bytes
                    .saturating_add(name.len().saturating_mul(2))
                    .saturating_add(stamp.len())
                    .saturating_add(96);
            }
        }
    }
    bytes
}

/// Decode only top-level fields the current declarations can inspect. Raw
/// values for unrelated fields remain in the canonical projection and do not
/// need to fit serde_json's scalar-string model merely to rebuild another key.
/// Every declared index/where/carry path remains strict: malformed relevant
/// values still refuse the projection instead of silently losing an entry.
fn indexed_fields(
    declaration: &record_indexes::Declaration,
    include_carried: bool,
    raw_fields: &crate::record_stamps::Fields,
) -> record_indexes::Result<(crate::record_stamps::Fields, usize)> {
    let mut needed = BTreeSet::new();
    let paths = declaration
        .paths
        .iter()
        .chain(declaration.r#where.iter().map(|rule| &rule.path))
        .chain(
            include_carried
                .then_some(&declaration.carry)
                .into_iter()
                .flatten(),
        )
        .chain(
            include_carried
                .then_some(&declaration.carry_exists)
                .into_iter()
                .flatten()
                .flatten(),
        );
    for path in paths {
        let Some(first) = path.first() else {
            return Err(crate::cause!(record_indexes::Error::Corrupt));
        };
        needed.insert(first.clone());
    }

    let mut fields = crate::record_stamps::Fields::new();
    let mut bytes = 0usize;
    for (field, raw) in raw_fields.iter() {
        let raw = raw.as_str().ok_or(crate::cause!(record_indexes::Error::Corrupt))?;
        bytes = bytes.saturating_add(field.len()).saturating_add(raw.len());
        if needed.contains(field) {
            let value =
                serde_json::from_str::<Json>(raw).map_err(|error| crate::carry_cause!(record_indexes::Error::Corrupt, error))?;
            fields.insert(field.to_owned(), value);
        }
    }
    Ok((fields, bytes))
}

fn sum_work(into: &mut legacy_kept::Work, add: &legacy_kept::Work) {
    into.sql_statements = into.sql_statements.saturating_add(add.sql_statements);
    into.rows_returned = into.rows_returned.saturating_add(add.rows_returned);
    into.source_bytes = into.source_bytes.saturating_add(add.source_bytes);
    into.progress_callbacks = into
        .progress_callbacks
        .saturating_add(add.progress_callbacks);
    into.runs_examined = into.runs_examined.saturating_add(add.runs_examined);
    into.page_bodies = into.page_bodies.saturating_add(add.page_bodies);
    into.multipart_chunks = into.multipart_chunks.saturating_add(add.multipart_chunks);
    into.source_precheck_us = into
        .source_precheck_us
        .saturating_add(add.source_precheck_us);
    into.source_sql_us = into.source_sql_us.saturating_add(add.source_sql_us);
    into.source_postcheck_us = into
        .source_postcheck_us
        .saturating_add(add.source_postcheck_us);
    into.head_decode_us = into.head_decode_us.saturating_add(add.head_decode_us);
    into.page_decode_us = into.page_decode_us.saturating_add(add.page_decode_us);
    into.elapsed_us = into.elapsed_us.saturating_add(add.elapsed_us);
    into.source_timing_complete &= add.source_timing_complete;
}

fn merge_key_cmp(a: &str, b: &str, reverse: bool) -> Ordering {
    let order = record_indexes::cmp(a, b);
    if reverse {
        order.reverse()
    } else {
        order
    }
}

fn compare_bound(key: &str, bound: &crate::ecma_json::JsString) -> Ordering {
    key.encode_utf16().cmp(bound.units().iter().copied())
}

fn page_complete(
    checkpoint_complete: bool,
    emitted: usize,
    available: usize,
    truncated: bool,
) -> bool {
    checkpoint_complete && !truncated && emitted == available
}

fn checkpoint_id_is_dirty<T>(id: &str, dirty: &BTreeMap<String, T>) -> bool {
    dirty.contains_key(id)
}

/// A complete derived ordered index can answer a key-only page without
/// replaying every saved run. It is a projection of the same original source,
/// admitted only when its declaration and current-head coverage still match.
fn strictly_after_cursor(key: &str, cursor: &str, reverse: bool) -> bool {
    let order = record_indexes::cmp(key, cursor);
    if reverse {
        order.is_lt()
    } else {
        order.is_gt()
    }
}

fn valid_frontier(covered: i64, last: i64) -> bool {
    covered >= 0 && last >= 0 && covered <= last
}

/// An implicit typed event wins type selection over every held type: its
/// canonical stamp is strictly after held.meta.at. Start only at a whole write
/// and retain that prefix until the tail finishes. A later event outside this
/// rule restores the original checkpoint and replays the prefix, so explicit
/// timestamps, a change back to this type, erasure and patches keep their owner.
fn excludes_type(raw: &RawValue, kind: &str, first: bool) -> Result<bool> {
    let object = raw_object(raw.get())?;
    if raw_bool(&object, "purge")? || raw_bool(&object, "remove")? || raw_bool(&object, "exact")?
        || raw_text(&object, "at")?.is_some() || raw_text(&object, "seq")?.is_some()
        || ["floor", "floor_kind", "stamps", "removed"].iter().any(|name| object.get(name).is_some_and(|value| value.get() != "null"))
        || first && object.get("value").is_none()
    { return Ok(false) }
    Ok(raw_text(&object, "type")?.is_some_and(|record_type| record_type != kind))
}

struct DeferredIndexEvent { row: String, part: usize, raw: Zeroizing<String> }
struct DeferredIndexRoot { events: Vec<DeferredIndexEvent>, bytes: usize }

fn original_dirty_root<S: BoundedRecordSql>(
    original: &mut S, meter: &mut Meter, id: &str, kept: &LegacyKept,
) -> Result<Projection> {
    let mut projection = checkpoint(original, meter, id, kept)?;
    if let Some(mut old) = projection.original.take() {
        old.value_json.zeroize();
        if let Some(meta) = &mut old.meta_json { meta.zeroize(); }
    }
    Ok(projection)
}

pub(super) fn replay_dirty<S, Relevant, ByteSize>(
    original: &mut S, source_limits: &ReadLimits, meter: &mut Meter,
    covered: i64, last: i64, has_keys: bool, kept: &LegacyKept, kind: &str,
    dirty: &mut BTreeMap<String, Dirty>, held: &mut usize,
    held_peak: &mut usize, dirty_limit: usize, held_limit: usize,
    relevant: Relevant, byte_size: ByteSize,
    bound_stage: &'static str, dirty_reason: &'static str, bytes_reason: &'static str,
) -> Result<()>
where
    S: BoundedRecordSql,
    Relevant: Fn(&str) -> bool,
    ByteSize: Fn(&str, &Projection) -> usize,
{
    let mut deferred = BTreeMap::<String, DeferredIndexRoot>::new();
    ids::replay_transactions(original, source_limits, meter, None, covered, last, has_keys,
        |original, meter, row_id, envelopes, _| {
            for (part, envelope) in envelopes.iter().enumerate() {
                meter.check_at("current-index-dirty-replay")?;
                let object = raw_object(envelope.get())?;
                let id = raw_text(&object, "id")?.ok_or(crate::cause!(Error::Corrupt))?;
                if !valid_id(&id) { return Err(crate::cause!(Error::Corrupt)) }
                if !relevant(&id) { continue; }
                let first = !dirty.contains_key(&id);
                if first && dirty.len() >= dirty_limit {
                    return Err(meter.bounds_failure(bound_stage, dirty_reason));
                }
                let event_bytes = row_id.len().saturating_add(envelope.get().len()).saturating_add(96);
                let root_bytes = byte_size(&id, &Projection::default());
                let excluded = (first || deferred.contains_key(&id)) && excludes_type(envelope, kind, first)?;
                if excluded && held.saturating_add(event_bytes).saturating_add(if first {root_bytes} else {0}) <= held_limit {
                    // Validate the original envelope/sequence with its canonical
                    // decoder even though no old value contributes to this index.
                    let mut validation = Projection::default();
                    validation.apply(&id, envelope, row_id, part)?;
                    let validation_peak = held.saturating_add(byte_size(&id, &validation));
                    *held_peak = (*held_peak).max(validation_peak);
                    if validation_peak > held_limit {
                        return Err(meter.bounds_failure(bound_stage, bytes_reason));
                    }
                    drop(validation);
                    if first {
                        dirty.insert(id.clone(), Dirty { id: id.clone(), projection: Projection::default(), bytes: root_bytes });
                        deferred.insert(id.clone(), DeferredIndexRoot { events: Vec::new(), bytes: root_bytes });
                        *held = held.saturating_add(root_bytes);
                    }
                    let pending = deferred.get_mut(&id).ok_or(crate::cause!(Error::Corrupt))?;
                    pending.events.push(DeferredIndexEvent { row: row_id.to_owned(), part, raw: Zeroizing::new(envelope.get().to_owned()) });
                    pending.bytes = pending.bytes.saturating_add(event_bytes);
                    *held = held.saturating_add(event_bytes); *held_peak = (*held_peak).max(*held);
                    if *held > held_limit { return Err(meter.bounds_failure(bound_stage, bytes_reason)); }
                    continue;
                }
                if first {
                    let projection = original_dirty_root(original, meter, &id, kept)?;
                    let bytes = byte_size(&id, &projection);
                    *held = held.saturating_add(bytes);
                    *held_peak = (*held_peak).max(*held);
                    if *held > held_limit { return Err(meter.bounds_failure(bound_stage, bytes_reason)); }
                    dirty.insert(id.clone(), Dirty { id: id.clone(), projection, bytes });
                } else if let Some(pending) = deferred.remove(&id) {
                    let mut projection = original_dirty_root(original, meter, &id, kept)?;
                    // Pending bytes are still live while the old root is
                    // restored. Check that peak before a whole/purge can shrink
                    // it, then retire each consumed event as replay advances.
                    let mut pending_bytes = pending.bytes;
                    let without_pending = held.saturating_sub(pending.bytes);
                    for event in pending.events {
                        let peak = without_pending.saturating_add(pending_bytes).saturating_add(byte_size(&id, &projection));
                        *held_peak = (*held_peak).max(peak);
                        if peak > held_limit { return Err(meter.bounds_failure(bound_stage, bytes_reason)); }
                        let raw: &RawValue = serde_json::from_str(&event.raw).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
                        projection.apply(&id, raw, &event.row, event.part)?;
                        let peak = without_pending.saturating_add(pending_bytes).saturating_add(byte_size(&id, &projection));
                        *held_peak = (*held_peak).max(peak);
                        if peak > held_limit { return Err(meter.bounds_failure(bound_stage, bytes_reason)); }
                        pending_bytes = pending_bytes.saturating_sub(event.row.len().saturating_add(event.raw.len()).saturating_add(96));
                    }
                    let bytes = byte_size(&id, &projection);
                    *held = held.saturating_sub(pending.bytes).saturating_add(bytes);
                    *held_peak = (*held_peak).max(*held);
                    if *held > held_limit { return Err(meter.bounds_failure(bound_stage, bytes_reason)); }
                    let state = dirty.get_mut(&id).ok_or(crate::cause!(Error::Corrupt))?;
                    state.projection = projection; state.bytes = bytes;
                }
                let state = dirty.get_mut(&id).ok_or(crate::cause!(Error::Corrupt))?;
                // Preserve the original checkpoint-before-effect held bound.
                *held_peak = (*held_peak).max(*held);
                if *held > held_limit { return Err(meter.bounds_failure(bound_stage, bytes_reason)); }
                state.projection.apply(&state.id, envelope, row_id, part)?;
                let bytes = byte_size(&state.id, &state.projection);
                *held = held.saturating_sub(state.bytes).saturating_add(bytes); state.bytes = bytes;
                *held_peak = (*held_peak).max(*held);
                if *held > held_limit { return Err(meter.bounds_failure(bound_stage, bytes_reason)); }
            }
            Ok(())
        })?;
    for (id, pending) in deferred {
        // All observed events still prove exclusion. Keep the dirty ID to
        // suppress its old index entries; retain no checkpoint/value value model.
        let state = dirty.get_mut(&id).ok_or(crate::cause!(Error::Corrupt))?;
        *held = held.saturating_sub(pending.bytes).saturating_add(state.bytes);
    }
    Ok(())
}

impl<S: BoundedRecordSql> LegacyRecords<S> {
    /// Read one declared index from the same pinned source used by this
    /// `LegacyRecords`. The outer owner must retain that snapshot and finish
    /// its fresh-rights and response-disclosure checks before returning entries.
    pub fn scan_index_with_tail(
        &mut self,
        kept: &LegacyKept,
        indexes: &Indexes,
        kind: &str,
        name: &str,
        query: &Query,
        epoch: Option<&str>,
        ready: &dyn Readiness,
        text: &impl Fn(&Json) -> record_indexes::Result<String>,
        fields: &mut dyn FieldAccess,
        budget: ReadBudget,
        limits: CurrentIndexLimits,
    ) -> record_indexes::Result<CurrentIndexPage> {
        let declaration = indexes
            .declared(kind, name)
            .map_err(|error| crate::carry_cause!(record_indexes::Error::Undeclared, error))?;
        let signature = indexes
            .signature(kind, name)
            .map_err(|error| crate::carry_cause!(record_indexes::Error::Undeclared, error))?;
        if !ready.assert_ready(declaration, &signature) {
            return Err(crate::cause!(record_indexes::Error::NotReady));
        }
        let (lo_text, hi_text) = indexes
            .bounds(declaration, query, text)
            .map_err(|_| bound(IndexBoundReason::Request, None, 0, 0, 0))?;
        let identity =
            record_indexes::query_identity(declaration, query, &lo_text, &hi_text, epoch)
                .map_err(|_| bound(IndexBoundReason::Request, None, 0, 0, 0))?;
        if let Some(cursor) = &query.cursor {
            if cursor.query_identity != identity
                || record_indexes::cmp(&cursor.key, &lo_text).is_lt()
                || !record_indexes::cmp(&cursor.key, &hi_text).is_lt()
            {
                return Err(crate::cause!(record_indexes::Error::WrongCursor));
            }
        }
        if query.limit == 0
            || query.limit > record_indexes::MAX_PAGE_ITEMS
            || budget.output_bytes < 2
            || limits.output_bytes < 2
            || limits.dirty_ids == 0
            || limits.dirty_ids > 4096
            || limits.held_bytes == 0
            || limits.held_bytes > 32 * 1024 * 1024
            || limits.checkpoint_entries < query.limit.saturating_add(limits.dirty_ids)
            || limits.checkpoint_entries > 1_000_000
            || limits.checkpoint_pages == 0
            || limits.checkpoint_pages > 65536
        {
            return Err(bound(IndexBoundReason::Request, None, 0, 0, 0));
        }
        let output_cap = budget.output_bytes.min(limits.output_bytes);
        let deadline = Instant::now().checked_add(budget.elapsed).ok_or(bound(
            IndexBoundReason::Request,
            None,
            0,
            0,
            0,
        ))?;
        if budget.rows == 0
            || budget.source_bytes == 0
            || budget.entries == 0
            || budget.elapsed.is_zero()
            || query.limit > budget.entries
        {
            return Err(bound(IndexBoundReason::Request, None, 0, 0, 0));
        }

        let mut bounded = self.bounds.clone();
        bounded.statements = bounded.statements.min(budget.rows.max(1));
        bounded.rows = bounded.rows.min(budget.rows);
        bounded.bytes = bounded.bytes.min(budget.source_bytes);
        bounded.elapsed = bounded.elapsed.min(budget.elapsed);
        let mut meter = Meter::new(&bounded);
        if detect(&mut self.original, &mut meter)
            .map_err(|_| record_indexes::Error::Invalid("record-log source unavailable", crate::cause!()))?
            != Engine::RecordLog
        {
            return Err(record_indexes::Error::Invalid(
                "record-log source unavailable",
             crate::cause!()));
        }
        let (covered, last, has_keys) = projection_frontier(&mut self.original, &mut meter)
            .map_err(|_| record_indexes::Error::Invalid("record-log source unavailable", crate::cause!()))?;
        // `covered` is only the log replay frontier. It is not evidence that
        // this declaration's f-keys were built; readiness above owns that proof.
        if !valid_frontier(covered, last) {
            return Err(crate::cause!(record_indexes::Error::Corrupt));
        }
        #[cfg(test)]
        crate::quiet_eprintln!("INDEX_STAGE frontier calls={} rows={} bytes={} uncovered={}", meter.statements, meter.rows, meter.bytes, last-covered);
        let mut dirty = BTreeMap::<String, Dirty>::new();
        let mut held = 0usize;
        let mut held_peak = 0usize;
        let source_deadline = (meter.started + meter.bounds.elapsed).min(deadline);
        if last > covered {
            replay_dirty(
                &mut self.original, &self.source_limits, &mut meter,
                covered, last, has_keys, kept, kind, &mut dirty,
                &mut held, &mut held_peak, limits.dirty_ids, limits.held_bytes,
                |_| true, held_bytes,
                "current-index-dirty-replay",
                "dirty record bound exhausted",
                "dirty projection bytes exhausted",
            )
            .map_err(|_| {
                bound(
                    meter_reason(&meter, IndexBoundReason::DirtyTailRefused),
                    Some(&meter),
                    dirty.len(),
                    held_peak,
                    (last - covered) as u64,
                )
            })?;
        }
        if Instant::now() >= source_deadline {
            return Err(bound(
                IndexBoundReason::Elapsed,
                Some(&meter),
                dirty.len(),
                held_peak,
                (last - covered) as u64,
            ));
        }

        #[cfg(test)]
        crate::quiet_eprintln!("INDEX_STAGE replay_done calls={} rows={} bytes={} dirty={} held={}", meter.statements, meter.rows, meter.bytes, dirty.len(), held_peak);
        let (lo, hi) = (
            ecma_json::JsString::from(lo_text.as_str()),
            ecma_json::JsString::from(hi_text.as_str()),
        );
        let cursor = query.cursor.as_ref().map(|cursor| {
            range::cursor_after(&lo, &hi, query.reverse, !query.carried, cursor.key.clone())
        });
        let checkpoint_limit = limits
            .checkpoint_entries
            .min(query.limit.saturating_add(dirty.len()).saturating_add(1));
        let mut range_page = kept
            .range_with_budget(
                &mut self.original,
                Request {
                    lo: &lo,
                    hi: &hi,
                    reverse: query.reverse,
                    keys_only: !query.carried,
                    limit: checkpoint_limit,
                    cursor: cursor.as_ref(),
                },
                RangeLimits {
                    entries: limits.checkpoint_entries,
                    pages: limits.checkpoint_pages,
                    held_bytes: limits.held_bytes.saturating_sub(held),
                    output_bytes: output_cap,
                },
                meter.remaining_point_budget(),
            )
            .map_err(|error| record_indexes::Error::CheckpointRange { cause: error.cause(),
                reason: error.reason,
                budget_exhausted: error.budget_exhausted,
                checkpoint_work: error.work,
                record_log_statements: meter.statements,
                record_log_rows: meter.rows,
                record_log_source_bytes: meter.bytes,
            })?;
        meter.timing.point(&range_page.work);
        meter.rows = meter
            .rows
            .saturating_add(range_page.work.rows_returned as usize);
        meter.bytes = meter
            .bytes
            .saturating_add(range_page.work.source_bytes as usize);
        meter.statements = meter
            .statements
            .saturating_add(range_page.work.sql_statements as usize);
        meter
            .check_at("current-index-checkpoint-range")
            .map_err(|_| {
                bound(
                    meter_reason(&meter, IndexBoundReason::DirtyTailRefused),
                    Some(&meter),
                    dirty.len(),
                    held_peak,
                    (last - covered) as u64,
                )
            })?;
        let mut work = CurrentIndexWork::default();
        sum_work(&mut work.checkpoint, &range_page.work);
        work.dirty_records = dirty.len();
        held_peak = held_peak.max(held.saturating_add(range_page.held_peak_bytes));
        if held_peak > limits.held_bytes {
            return Err(bound(
                IndexBoundReason::CheckpointHeld,
                Some(&meter),
                dirty.len(),
                held_peak,
                (last - covered) as u64,
            ));
        }

        let mut candidates = BTreeMap::<String, record_indexes::Entry>::new();
        let mut candidate_bytes = 0usize;
        let mut pending_range_bytes = range_page.items.iter().fold(0usize, |bytes, item| {
            bytes
                .saturating_add(item.key.len())
                .saturating_add(item.value.as_ref().map_or(0, String::len))
        });
        for item in range_page.items.drain(..) {
            pending_range_bytes = pending_range_bytes
                .saturating_sub(item.key.len())
                .saturating_sub(item.value.as_ref().map_or(0, String::len));
            let id = item
                .key
                .rsplit('\0')
                .next()
                .ok_or(crate::cause!(record_indexes::Error::Corrupt))?;
            if checkpoint_id_is_dirty(id, &dirty) {
                continue;
            }
            let stored = match item.value {
                Some(value) => {
                    serde_json::from_str(&value).map_err(|error| crate::carry_cause!(record_indexes::Error::Corrupt, error))?
                }
                None if !query.carried => Json::Null,
                None => return Err(crate::cause!(record_indexes::Error::Corrupt)),
            };
            let entry = record_indexes::decode_entry(
                declaration,
                &item.key,
                &stored,
                query.carried,
                epoch,
                fields,
            )
            .map_err(|error| crate::carry_cause!(record_indexes::Error::Corrupt, error))?;
            candidate_bytes = candidate_bytes
                .saturating_add(item.key.len())
                .saturating_add(
                    serde_json::to_vec(&stored)
                        .map_err(|error| crate::carry_cause!(record_indexes::Error::Corrupt, error))?
                        .len(),
                )
                .saturating_add(
                    serde_json::to_vec(&entry)
                        .map_err(|error| crate::carry_cause!(record_indexes::Error::Corrupt, error))?
                        .len(),
                );
            held_peak = held_peak.max(
                held.saturating_add(pending_range_bytes)
                    .saturating_add(candidate_bytes),
            );
            if held_peak > limits.held_bytes {
                return Err(bound(
                    IndexBoundReason::CandidatesHeld,
                    Some(&meter),
                    dirty.len(),
                    held_peak,
                    (last - covered) as u64,
                ));
            }
            candidates.insert(item.key, entry);
        }
        for state in dirty.values() {
            let Some(held_record) = state.projection.held.as_ref() else {
                continue;
            };
            if held_record.record_type.as_deref() != Some(kind) {
                continue;
            }
            let Some(raw_fields) = held_record.value.as_ref() else {
                continue;
            };
            let (fields_map, record_bytes) =
                indexed_fields(declaration, query.carried, raw_fields)?;
            held_peak = held_peak.max(
                held.saturating_add(candidate_bytes)
                    .saturating_add(pending_range_bytes)
                    .saturating_add(record_bytes),
            );
            if held_peak > limits.held_bytes {
                return Err(bound(
                    IndexBoundReason::FieldsHeld,
                    Some(&meter),
                    dirty.len(),
                    held_peak,
                    (last - covered) as u64,
                ));
            }
            let record = record_indexes::Record {
                id: &state.id,
                record_type: kind,
                fields: &fields_map,
            };
            let plan = indexes
                .plan_selected_index(
                    kind,
                    name,
                    &state.id,
                    None,
                    Some(record),
                    epoch,
                    query.carried,
                    text,
                    fields,
                )
                .map_err(|error| crate::carry_cause!(record_indexes::Error::FieldAccess, error))?;
            for change in plan.changes {
                let Some(value) = change.value else {
                    continue;
                };
                if record_indexes::cmp(&change.key, &lo_text).is_lt()
                    || !record_indexes::cmp(&change.key, &hi_text).is_lt()
                {
                    continue;
                }
                if query.cursor.as_ref().is_some_and(|cursor| {
                    !strictly_after_cursor(&change.key, &cursor.key, query.reverse)
                }) {
                    continue;
                }
                let entry = record_indexes::decode_entry(
                    declaration,
                    &change.key,
                    &value,
                    query.carried,
                    epoch,
                    fields,
                )
                .map_err(|error| crate::carry_cause!(record_indexes::Error::Corrupt, error))?;
                candidate_bytes = candidate_bytes
                    .saturating_add(change.key.len())
                    .saturating_add(
                        serde_json::to_vec(&value)
                            .map_err(|error| crate::carry_cause!(record_indexes::Error::Corrupt, error))?
                            .len(),
                    )
                    .saturating_add(
                        serde_json::to_vec(&entry)
                            .map_err(|error| crate::carry_cause!(record_indexes::Error::Corrupt, error))?
                            .len(),
                    );
                held_peak = held_peak.max(
                    held.saturating_add(pending_range_bytes)
                        .saturating_add(candidate_bytes)
                        .saturating_add(record_bytes),
                );
                if held_peak > limits.held_bytes {
                    return Err(bound(
                        IndexBoundReason::DirtyCandidatesHeld,
                        Some(&meter),
                        dirty.len(),
                        held_peak,
                        (last - covered) as u64,
                    ));
                }
                candidates.insert(change.key, entry);
                work.dirty_index_entries = work.dirty_index_entries.saturating_add(1);
            }
        }
        let mut sorted = candidates.into_iter().collect::<Vec<_>>();
        sorted.sort_by(|(a, _), (b, _)| merge_key_cmp(a, b, query.reverse));
        let available = sorted.len();
        let mut entries = Vec::new();
        let mut bytes = 2usize;
        let mut last_key = None;
        let mut truncated = false;
        for (key, entry) in sorted {
            if Instant::now() >= deadline || Instant::now() >= source_deadline {
                return Err(bound(
                    IndexBoundReason::Elapsed,
                    Some(&meter),
                    dirty.len(),
                    held_peak,
                    (last - covered) as u64,
                ));
            }
            let size = serde_json::to_vec(&entry)
                .map_err(|error| crate::carry_cause!(record_indexes::Error::Corrupt, error))?
                .len()
                + usize::from(!entries.is_empty());
            if size > output_cap.saturating_sub(bytes) {
                if entries.is_empty() {
                    return Err(bound(
                        IndexBoundReason::FirstOutputBytes,
                        Some(&meter),
                        dirty.len(),
                        held_peak,
                        (last - covered) as u64,
                    ));
                }
                truncated = true;
                break;
            }
            bytes += size;
            entries.push(entry);
            last_key = Some(key);
            if entries.len() == query.limit {
                break;
            }
        }
        let complete = page_complete(range_page.complete, entries.len(), available, truncated);
        let next = if complete {
            None
        } else {
            Some(record_indexes::Cursor {
                key: last_key.ok_or_else(|| {
                    bound(
                        IndexBoundReason::CursorMissing,
                        Some(&meter),
                        dirty.len(),
                        held_peak,
                        (last - covered) as u64,
                    )
                })?,
                query_identity: identity,
            })
        };
        work.serialized_bytes = bytes;
        work.held_peak_bytes = held_peak;
        work.record_log_statements = meter.statements;
        work.record_log_rows = meter.rows;
        work.record_log_source_bytes = meter.bytes;
        work.elapsed_us = meter.started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        Ok(CurrentIndexPage {
            entries,
            next,
            complete,
            serialized_bytes: bytes,
            work,
        })
    }

    /// Read exact equality values for one scalar index with a single source
    /// readiness check, checkpoint run scan and dirty-tail replay. Every group
    /// is complete or the operation refuses. Duplicate inputs retain separate
    /// aligned output groups.
    #[allow(clippy::too_many_arguments)]
    pub fn scan_exact_values_with_tail(
        &mut self,
        kept: &LegacyKept,
        indexes: &Indexes,
        kind: &str,
        name: &str,
        values: &[Json],
        epoch: Option<&str>,
        ready: &dyn Readiness,
        text: &impl Fn(&Json) -> record_indexes::Result<String>,
        fields: &mut dyn FieldAccess,
        limit_per_value: usize,
        total_limit: usize,
        budget: ReadBudget,
        limits: CurrentIndexLimits,
    ) -> record_indexes::Result<CurrentIndexGroups> {
        let declaration = indexes
            .declared(kind, name)
            .map_err(|error| crate::carry_cause!(record_indexes::Error::Undeclared, error))?;
        let signature = indexes
            .signature(kind, name)
            .map_err(|error| crate::carry_cause!(record_indexes::Error::Undeclared, error))?;
        if !ready.assert_ready(declaration, &signature) {
            return Err(crate::cause!(record_indexes::Error::NotReady));
        }
        if declaration.paths.len() != 1
            || values.is_empty()
            || values.len() > 100
            || limit_per_value == 0
            || limit_per_value > 1000
            || total_limit == 0
            || total_limit > 1000
            || budget.output_bytes < 2
            || limits.output_bytes < 2
            || limits.dirty_ids == 0
            || limits.dirty_ids > 4096
            || limits.held_bytes == 0
            || limits.held_bytes > 32 * 1024 * 1024
            || limits.checkpoint_entries < total_limit.saturating_add(limits.dirty_ids)
            || limits.checkpoint_entries > 1_000_000
            || limits.checkpoint_pages == 0
            || limits.checkpoint_pages > 65536
            || budget.rows == 0
            || budget.source_bytes == 0
            || budget.entries == 0
            || budget.elapsed.is_zero()
            || total_limit > budget.entries
        {
            return Err(crate::cause!(record_indexes::Error::Bounds));
        }
        let output_cap = budget.output_bytes.min(limits.output_bytes);
        let deadline = Instant::now()
            .checked_add(budget.elapsed)
            .ok_or(crate::cause!(record_indexes::Error::Bounds))?;
        let mut bounds = Vec::with_capacity(values.len());
        for value in values {
            let query = Query {
                equal: vec![value.clone()],
                // Bound construction only; the batched prefix reader owns the
                // actual (Home's larger than a canonical page) result cap.
                limit: 1,
                ..Query::default()
            };
            let (lo, hi) = indexes
                .bounds(declaration, &query, text)
                .map_err(|error| crate::carry_cause!(record_indexes::Error::Bounds, error))?;
            bounds.push((
                ecma_json::JsString::from(lo.as_str()),
                ecma_json::JsString::from(hi.as_str()),
            ));
        }

        let mut bounded = self.bounds.clone();
        bounded.statements = bounded.statements.min(budget.rows.max(1));
        bounded.rows = bounded.rows.min(budget.rows);
        bounded.bytes = bounded.bytes.min(budget.source_bytes);
        bounded.elapsed = bounded.elapsed.min(budget.elapsed);
        let mut meter = Meter::new(&bounded);
        if detect(&mut self.original, &mut meter)
            .map_err(|_| record_indexes::Error::Invalid("record-log source unavailable", crate::cause!()))?
            != Engine::RecordLog
        {
            return Err(record_indexes::Error::Invalid(
                "record-log source unavailable",
             crate::cause!()));
        }
        let (covered, last, has_keys) = projection_frontier(&mut self.original, &mut meter)
            .map_err(|_| record_indexes::Error::Invalid("record-log source unavailable", crate::cause!()))?;
        if !valid_frontier(covered, last) {
            return Err(crate::cause!(record_indexes::Error::Corrupt));
        }
        let mut dirty = BTreeMap::<String, Dirty>::new();
        let mut held = 0usize;
        let mut held_peak = 0usize;
        let source_deadline = (meter.started + meter.bounds.elapsed).min(deadline);
        if last > covered {
            replay_dirty(
                &mut self.original, &self.source_limits, &mut meter,
                covered, last, has_keys, kept, kind, &mut dirty,
                &mut held, &mut held_peak, limits.dirty_ids, limits.held_bytes,
                |_| true, held_bytes,
                "current-index-dirty-replay",
                "dirty record bound exhausted",
                "dirty projection bytes exhausted",
            )
            .map_err(|error| crate::carry_cause!(record_indexes::Error::Bounds, error))?;
        }
        if Instant::now() >= source_deadline {
            return Err(crate::cause!(record_indexes::Error::Bounds));
        }

        let checkpoint = kept
            .prefixes_with_budget(
                &mut self.original,
                &bounds,
                limit_per_value,
                RangeLimits {
                    entries: limits.checkpoint_entries,
                    pages: limits.checkpoint_pages,
                    held_bytes: limits.held_bytes.saturating_sub(held),
                    output_bytes: output_cap,
                },
                meter.remaining_point_budget(),
            )
            .map_err(|error| record_indexes::Error::CheckpointRange { cause: error.cause(),
                reason: error.reason,
                budget_exhausted: error.budget_exhausted,
                checkpoint_work: error.work,
                record_log_statements: meter.statements,
                record_log_rows: meter.rows,
                record_log_source_bytes: meter.bytes,
            })?;
        meter.timing.point(&checkpoint.work);
        meter.rows = meter
            .rows
            .saturating_add(checkpoint.work.rows_returned as usize);
        meter.bytes = meter
            .bytes
            .saturating_add(checkpoint.work.source_bytes as usize);
        meter.statements = meter
            .statements
            .saturating_add(checkpoint.work.sql_statements as usize);
        meter
            .check_at("current-index-exact-groups")
            .map_err(|error| crate::carry_cause!(record_indexes::Error::Bounds, error))?;

        let mut work = CurrentIndexWork::default();
        sum_work(&mut work.checkpoint, &checkpoint.work);
        work.dirty_records = dirty.len();
        held_peak = held_peak.max(held.saturating_add(checkpoint.held_peak_bytes));
        if held_peak > limits.held_bytes {
            return Err(crate::cause!(record_indexes::Error::Bounds));
        }

        let mut grouped = (0..values.len())
            .map(|_| BTreeMap::<String, record_indexes::Entry>::new())
            .collect::<Vec<_>>();
        let mut candidate_bytes = 0usize;
        for (group, items) in checkpoint.groups.into_iter().enumerate() {
            for item in items {
                let id = item
                    .key
                    .rsplit('\0')
                    .next()
                    .ok_or(crate::cause!(record_indexes::Error::Corrupt))?;
                if !valid_id(id) {
                    return Err(crate::cause!(record_indexes::Error::Corrupt));
                }
                if checkpoint_id_is_dirty(id, &dirty) {
                    continue;
                }
                let entry = record_indexes::decode_entry(
                    declaration,
                    &item.key,
                    &Json::Null,
                    false,
                    epoch,
                    fields,
                )
                .map_err(|error| crate::carry_cause!(record_indexes::Error::Corrupt, error))?;
                candidate_bytes = candidate_bytes
                    .saturating_add(item.key.len())
                    .saturating_add(
                        serde_json::to_vec(&entry)
                            .map_err(|error| crate::carry_cause!(record_indexes::Error::Corrupt, error))?
                            .len(),
                    );
                held_peak = held_peak.max(held.saturating_add(candidate_bytes));
                if held_peak > limits.held_bytes {
                    return Err(crate::cause!(record_indexes::Error::Bounds));
                }
                grouped[group].insert(item.key, entry);
            }
        }
        for state in dirty.values() {
            let Some(held_record) = state.projection.held.as_ref() else {
                continue;
            };
            if held_record.record_type.as_deref() != Some(kind) {
                continue;
            }
            let Some(raw_fields) = held_record.value.as_ref() else {
                continue;
            };
            let (fields_map, record_bytes) = indexed_fields(declaration, false, raw_fields)?;
            held_peak = held_peak.max(
                held.saturating_add(candidate_bytes)
                    .saturating_add(record_bytes),
            );
            if held_peak > limits.held_bytes {
                return Err(crate::cause!(record_indexes::Error::Bounds));
            }
            let record = record_indexes::Record {
                id: &state.id,
                record_type: kind,
                fields: &fields_map,
            };
            let plan = indexes
                .plan_selected_index(
                    kind,
                    name,
                    &state.id,
                    None,
                    Some(record),
                    epoch,
                    false,
                    text,
                    fields,
                )
                .map_err(|error| crate::carry_cause!(record_indexes::Error::FieldAccess, error))?;
            for change in plan.changes {
                let Some(value) = change.value else {
                    continue;
                };
                for (group, (lo, hi)) in bounds.iter().enumerate() {
                    if compare_bound(&change.key, lo).is_lt()
                        || !compare_bound(&change.key, hi).is_lt()
                    {
                        continue;
                    }
                    let entry = record_indexes::decode_entry(
                        declaration,
                        &change.key,
                        &value,
                        false,
                        epoch,
                        fields,
                    )
                    .map_err(|error| crate::carry_cause!(record_indexes::Error::Corrupt, error))?;
                    let entry_bytes = serde_json::to_vec(&entry)
                        .map_err(|error| crate::carry_cause!(record_indexes::Error::Corrupt, error))?
                        .len();
                    if grouped[group].insert(change.key.clone(), entry).is_none() {
                        work.dirty_index_entries = work.dirty_index_entries.saturating_add(1);
                        candidate_bytes = candidate_bytes
                            .saturating_add(change.key.len())
                            .saturating_add(entry_bytes);
                        held_peak = held_peak.max(held.saturating_add(candidate_bytes));
                        if held_peak > limits.held_bytes {
                            return Err(crate::cause!(record_indexes::Error::Bounds));
                        }
                    }
                }
            }
        }

        let mut groups = Vec::with_capacity(grouped.len());
        // Exact JSON size of the outer array and each aligned group array.
        let mut bytes = 2usize
            .saturating_add(values.len().saturating_mul(2))
            .saturating_add(values.len().saturating_sub(1));
        let mut emitted = 0usize;
        for candidates in grouped {
            let mut candidates = candidates.into_iter().collect::<Vec<_>>();
            candidates.sort_by(|(left, _), (right, _)| record_indexes::cmp(left, right));
            if !candidates.is_empty() {
                bytes = bytes.saturating_add(candidates.len().saturating_sub(1));
            }
            let mut entries = Vec::with_capacity(candidates.len());
            for (_, entry) in candidates {
                if entries.len() >= limit_per_value || emitted >= total_limit {
                    return Err(crate::cause!(record_indexes::Error::Bounds));
                }
                let size = serde_json::to_vec(&entry)
                    .map_err(|error| crate::carry_cause!(record_indexes::Error::Corrupt, error))?
                    .len();
                bytes = bytes
                    .checked_add(size)
                    .ok_or(crate::cause!(record_indexes::Error::Bounds))?;
                if bytes > output_cap {
                    return Err(crate::cause!(record_indexes::Error::Bounds));
                }
                entries.push(entry);
                emitted += 1;
            }
            groups.push(entries);
        }
        if Instant::now() >= deadline || Instant::now() >= source_deadline {
            return Err(crate::cause!(record_indexes::Error::Bounds));
        }
        work.serialized_bytes = bytes;
        work.held_peak_bytes = held_peak;
        work.record_log_statements = meter.statements;
        work.record_log_rows = meter.rows;
        work.record_log_source_bytes = meter.bytes;
        work.elapsed_us = meter.started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        Ok(CurrentIndexGroups {
            groups,
            serialized_bytes: bytes,
            work,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirty_insertion_has_no_checkpoint_candidate() {
        let mut dirty = BTreeMap::new();
        dirty.insert("new-id".to_owned(), ());
        assert!(checkpoint_id_is_dirty("new-id", &dirty));
        assert!(!checkpoint_id_is_dirty("other-id", &dirty));
    }

    #[test]
    fn update_suppresses_old_key_and_uses_rebuilt_key() {
        let mut dirty = BTreeMap::new();
        dirty.insert("same-id".to_owned(), ());
        let checkpoint = "f\0plan\0by-date\0\"old\"\0same-id";
        let rebuilt = "f\0plan\0by-date\0\"new\"\0same-id";
        assert!(checkpoint_id_is_dirty(
            checkpoint.rsplit('\0').next().unwrap(),
            &dirty
        ));
        assert!(record_indexes::cmp(rebuilt, checkpoint).is_lt());
    }

    #[test]
    fn deletion_or_erasure_suppresses_checkpoint_entry_without_rebuild() {
        let mut dirty = BTreeMap::new();
        dirty.insert("removed-id".to_owned(), ());
        let checkpoint = "f\0plan\0by-date\0\"old\"\0removed-id";
        assert!(checkpoint_id_is_dirty(
            checkpoint.rsplit('\0').next().unwrap(),
            &dirty
        ));
        // The tombstone contributes no replacement candidate.
    }

    #[test]
    fn cursor_and_reverse_order_use_utf16_strictness() {
        assert!(strictly_after_cursor("b", "a", false));
        assert!(!strictly_after_cursor("a", "a", false));
        assert!(strictly_after_cursor("a", "b", true));
        assert!(!strictly_after_cursor("b", "b", true));

        // JavaScript/RecordIndex order differs from Unicode scalar-value order
        // here: U+10000 begins with surrogate D800, before BMP U+E000.
        let supplementary = "\u{10000}";
        let private_use = "\u{e000}";
        assert!(record_indexes::cmp(supplementary, private_use).is_lt());
        assert!(supplementary.chars().cmp(private_use.chars()).is_gt());
    }

    #[test]
    fn checkpoint_completeness_also_requires_all_merged_candidates_emitted() {
        assert!(!page_complete(true, 1, 2, false));
        assert!(!page_complete(false, 1, 1, false));
        assert!(!page_complete(true, 1, 1, true));
        assert!(page_complete(true, 1, 1, false));
    }

    #[test]
    fn currentness_depends_on_readiness_not_covered_frontier_alone() {
        let covered = 100;
        let last = 100;
        assert_eq!(covered, last);
        assert!(!valid_frontier(101, 100));
        assert!(valid_frontier(100, 100));
        // No dirty tail says nothing about whether this declaration was
        // backfilled. The caller's readiness owner remains the authority.
        struct Ready(bool);
        impl Readiness for Ready {
            fn assert_ready(&self, _: &record_indexes::Declaration, _: &str) -> bool {
                self.0
            }
        }
        assert!(!Ready(false).assert_ready(
            &record_indexes::Declaration {
                record_type: "plan".into(),
                name: "by-date".into(),
                paths: vec![vec!["updated_at".into()]],
                r#where: vec![],
                carry: vec![],
                carry_exists: None,
                backfill: Some("plan-updated-at-v1".into()),
                retired: false,
            },
            "signature"
        ));
    }

    #[test]
    fn unrelated_lone_surrogate_does_not_block_a_valid_scalar_index_rebuild() {
        let indexes = Indexes::new(record_indexes::Data {
            indexes: vec![
                record_indexes::Declaration {
                    record_type: "decision".into(),
                    name: "created_at".into(),
                    paths: vec![vec![String::from("created_at")]],
                    r#where: Vec::new(),
                    carry: vec![vec![String::from("title")]],
                    carry_exists: Some(vec![vec![String::from("title")]]),
                    backfill: None,
                    retired: false,
                },
                record_indexes::Declaration {
                    record_type: "decision".into(),
                    name: "by_job".into(),
                    paths: vec![vec![String::from("job")]],
                    r#where: Vec::new(),
                    carry: Vec::new(),
                    carry_exists: None,
                    backfill: None,
                    retired: false,
                },
            ],
        })
        .unwrap();
        let mut raw_fields = crate::record_stamps::Fields::new();
        raw_fields.insert(
            "created_at",
            Json::String(r#""2026-10-25T20:00:00.000Z""#.into()),
        );
        raw_fields.insert("job", Json::String(r#""\ud800""#.into()));

        let declaration = indexes.declared("decision", "created_at").unwrap();
        let (fields, _) = indexed_fields(declaration, false, &raw_fields).unwrap();
        assert!(fields.get("title").is_none());
        assert!(fields.get("job").is_none());
        let record = record_indexes::Record {
            id: "decision:fixture",
            record_type: "decision",
            fields: &fields,
        };
        let encode =
            |value: &Json| serde_json::to_string(value).map_err(record_indexes::Error::from);
        let plan = indexes
            .plan_selected_index(
                "decision",
                "created_at",
                "decision:fixture",
                None,
                Some(record),
                None,
                false,
                &encode,
                &mut record_indexes::PlainFields,
            )
            .unwrap();
        assert_eq!(plan.changes.len(), 1);

        // If the same lone surrogate is on a declared scalar path, refusing is
        // correct; an invalid relevant key must never be silently dropped.
        raw_fields.insert("created_at", Json::String(r#""\ud800""#.into()));
        assert!(indexed_fields(declaration, false, &raw_fields).is_err());

        // Carried content is strict for the requested carry path, while an
        // unrelated sibling-index field remains raw and cannot poison this
        // declaration's projection.
        raw_fields.insert(
            "created_at",
            Json::String(r#""2026-10-25T20:00:00.000Z""#.into()),
        );
        raw_fields.insert("title", Json::String(r#""useful title""#.into()));
        let (carried_fields, _) = indexed_fields(declaration, true, &raw_fields).unwrap();
        assert_eq!(
            carried_fields.get("title"),
            Some(&Json::String("useful title".into()))
        );
        assert!(carried_fields.get("job").is_none());
        assert_eq!(
            raw_fields.get("job").and_then(Json::as_str),
            Some(r#""\ud800""#)
        );

        // But malformed data on the requested carry path still refuses; it
        // cannot silently disappear from carried results.
        raw_fields.insert("title", Json::String(r#""\ud800""#.into()));
        assert!(indexed_fields(declaration, true, &raw_fields).is_err());
    }
}

#[cfg(test)]
#[path = "../../tests/drafts/current_index_diagnostic.rs"]
mod diagnostic_controls;

#[cfg(test)]
#[path = "../../tests/drafts/current_index_lookahead_pair.rs"]
mod lookahead_pair;
#[cfg(test)]
mod type_shadow_controls {
    use super::*;
    use super::lookahead_pair::{Fixture, query};
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/drafts/current_index_type_shadow.rs"));
}
