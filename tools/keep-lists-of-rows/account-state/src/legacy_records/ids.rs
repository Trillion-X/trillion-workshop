//! Current type IDs from one admitted snapshot: indexed checkpoint keys plus
//! canonical dirty-log replay. No new authority, connection, writes or decoder.
//! Source: record-log-store.mjs idsOfType/setRecord/removeRecord; stamps and
//! multipart transaction validation stay in their existing canonical owners.
use super::*;
use crate::legacy_kept::range::{self, RangeLimits, Request};
use std::collections::{BTreeMap, VecDeque};

pub struct IdsRequest<'a> {
    pub record_type: &'a str,
    pub prefix: &'a ecma_json::JsString,
    pub before: Option<&'a ecma_json::JsString>,
    pub limit: usize,
}
#[derive(Clone, Copy, Debug)]
pub struct IdsLimits {
    pub dirty_ids: usize,
    pub held_bytes: usize,
    pub checkpoint_entries: usize,
    pub checkpoint_pages: usize,
    pub output_bytes: usize,
}
impl Default for IdsLimits {
    fn default() -> Self {
        Self {
            dirty_ids: 256,
            held_bytes: 16 * 1024 * 1024,
            checkpoint_entries: 4096,
            checkpoint_pages: 256,
            output_bytes: 8 * 1024 * 1024,
        }
    }
}
#[derive(Default, Debug)]
pub struct IdsWork {
    pub source_sql_statements: usize,
    pub source_rows: usize,
    pub source_bytes: usize,
    pub dirty_records: usize,
    pub checkpoint_entries: usize,
    pub held_peak_bytes: usize,
    pub output_bytes: usize,
}
pub struct IdsPage {
    pub ids: Vec<String>,
    /// Strict `before` for the next call. Retain the same snapshot and scope.
    pub next: Option<String>,
    pub complete: bool,
    pub work: IdsWork,
}
impl fmt::Debug for IdsPage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CurrentRecordIds([redacted])")
    }
}
struct Changed {
    id: String,
    projection: Projection,
}
fn joined(base: &ecma_json::JsString, suffix: &ecma_json::JsString) -> ecma_json::JsString {
    let mut units = base.units().to_vec();
    units.extend_from_slice(suffix.units());
    ecma_json::JsString::from_units(units)
}
fn in_interval(
    id: &str,
    base: &ecma_json::JsString,
    lo: &ecma_json::JsString,
    hi: &ecma_json::JsString,
) -> bool {
    let key = joined(base, &ecma_json::JsString::from(id));
    key >= *lo && key < *hi
}
fn projection_bytes(id: &str, projection: &Projection) -> usize {
    let mut bytes = id.len().saturating_mul(3).saturating_add(256);
    if let Some(sequence) = &projection.sequence {
        bytes = bytes.saturating_add(sequence.len());
    }
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
            bytes = bytes
                .saturating_add(meta.at.len())
                .saturating_add(meta.f.as_ref().map_or(0, String::len));
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
fn charge_range(meter: &mut Meter, work: &crate::legacy_kept::Work) -> Result<()> {
    meter.last_kept_work = Some(work.clone());
    meter.timing.point(work);
    meter.rows = meter.rows.saturating_add(work.rows_returned as usize);
    meter.bytes = meter.bytes.saturating_add(work.source_bytes as usize);
    meter.statements = meter
        .statements
        .saturating_add(work.sql_statements as usize);
    meter.check_at("ids-checkpoint-range-budget")
}
impl<S: BoundedRecordSql> LegacyRecords<S> {
    /// Current stored type membership, not decrypted/resolved record values.
    /// The supplier and its final caller-owned snapshot/rights finish remain
    /// authoritative. No checkpoint answer escapes a failed dirty-tail replay.
    pub fn ids_of_type(
        &mut self,
        request: IdsRequest<'_>,
        limits: IdsLimits,
        kept: &LegacyKept,
    ) -> Result<IdsPage> {
        self.ids_checked(request, limits, kept, None)
    }

    /// Complete one bounded canonical traversal and move provisional IDs to
    /// the caller in chunks of at most 32. The callback must discard every
    /// chunk if this call or the caller's final source/rights finish fails.
    /// No position or source authority survives this call. Output already
    /// moved to the callback remains charged to the same held/output budget.
    pub fn visit_ids_of_type<F>(
        &mut self,
        request: IdsRequest<'_>,
        limits: IdsLimits,
        kept: &LegacyKept,
        max_ids: usize,
        mut visit: F,
    ) -> Result<IdsWork>
    where
        F: FnMut(Vec<String>) -> Result<()>,
    {
        if request.limit == 0 || request.limit > 32 || max_ids == 0 || max_ids > 4096 {
            return Err(crate::cause!(Error::Invalid));
        }
        let chunk_ids = request.limit;
        let request = IdsRequest { limit: max_ids, ..request };
        self.ids_checked(request, limits, kept, Some((chunk_ids, &mut visit)))
            .map(|page| page.work)
    }

    fn ids_checked(
        &mut self,
        request: IdsRequest<'_>,
        limits: IdsLimits,
        kept: &LegacyKept,
        mut visit: Option<(usize, &mut dyn FnMut(Vec<String>) -> Result<()>)>,
    ) -> Result<IdsPage> {
        self.last_diagnostic = None;
        self.last_timing = ReadTiming::default();
        if !valid_id(request.record_type)
            || request.prefix.len() > 4096
            || request.before.is_some_and(|v| v.len() > 4096)
            || request.limit == 0
            || request.limit > 4096
            || limits.dirty_ids == 0
            || limits.dirty_ids > 4096
            || limits.held_bytes == 0
            || limits.held_bytes > 32 * 1024 * 1024
            || limits.checkpoint_entries == 0
            || limits.checkpoint_entries > 1_000_000
            || limits.checkpoint_pages == 0
            || limits.checkpoint_pages > 65536
            || limits.output_bytes == 0
            || limits.output_bytes > 32 * 1024 * 1024
        {
            return Err(crate::cause!(Error::Invalid));
        }
        let mut meter = Meter::new(&self.bounds);
        let result = (|| {
            // A complete traversal reuses one kept merge and one canonical
            // dirty replay. Its private checkpoint window uses the existing
            // aggregate entry ceiling; public chunks remain <=32 IDs.
            let checkpoint_window = if visit.is_some() {
                limits.checkpoint_entries.min(4096)
            } else {
                64.min(request.limit.saturating_add(1))
            };
            let mut page = self.ids_attempt(&request, limits, kept, &mut meter, checkpoint_window, visit.is_some())?;
            if let Some((chunk_ids, callback)) = visit.as_mut() {
                if !page.complete {
                    return Err(meter.bounds_failure("ids-output-budget", "current type complete ID bound exhausted"));
                }
                let mut ids = std::mem::take(&mut page.ids).into_iter();
                loop {
                    meter.check_at("ids-visitor-budget")?;
                    let state = self.original.read_source_state().map_err(|error| if matches!(error, crate::import::ImportError::Deadline(_, _)) { crate::cause!(Error::Deadline) } else { crate::cause!(Error::Source) })?;
                    if !state.usable || !state.scoped || !state.custody {
                        return Err(crate::cause!(Error::Source));
                    }
                    let chunk = ids.by_ref().take(*chunk_ids).collect::<Vec<_>>();
                    if chunk.is_empty() { break; }
                    callback(chunk)?;
                }
                // Supplier observation above checks the live handle and cancel
                // state. This actual query also rechecks its current witness;
                // buffered chunks remain provisional until it succeeds.
                meter.query(&mut self.original, "SELECT 1", &[])?;
                meter.check_at("ids-visitor-complete-budget")?;
                page.work.source_sql_statements = meter.statements;
                page.work.source_rows = meter.rows;
                page.work.source_bytes = meter.bytes;
            }
            Ok(page)
        })();
        meter.timing.elapsed_us = meter.started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        self.last_timing = meter.timing;
        self.last_diagnostic = meter.diagnostic;
        result
    }
    fn ids_attempt(
        &mut self,
        request: &IdsRequest<'_>,
        limits: IdsLimits,
        kept: &LegacyKept,
        meter: &mut Meter,
        checkpoint_window: usize,
        complete_capture: bool,
    ) -> Result<IdsPage> {
        if detect(&mut self.original, meter)? != Engine::RecordLog {
            return Err(crate::cause!(Error::WrongEngine));
        }
        let (covered, last, has_keys) = projection_frontier(&mut self.original, meter)?;
        let base = ecma_json::JsString::from(format!("t\0{}\0", request.record_type));
        let lo = joined(&base, request.prefix);
        let mut hi = range::prefix_end(&lo).ok_or(crate::cause!(Error::Invalid))?;
        if let Some(before) = request.before {
            hi = hi.min(joined(&base, before));
        }
        let output_cap = limits.output_bytes.min(self.bounds.bytes);
        let mut work = IdsWork::default();
        let mut changed = BTreeMap::<ecma_json::JsString, Changed>::new();
        let mut held = 0usize;
        if lo < hi && last > covered {
            let mut dirty = BTreeMap::<String, current_indexes::Dirty>::new();
            let mut held_peak = 0usize;
            current_indexes::replay_dirty(
                &mut self.original,
                &self.source_limits,
                meter,
                covered,
                last,
                has_keys,
                kept,
                request.record_type,
                &mut dirty,
                &mut held,
                &mut held_peak,
                limits.dirty_ids,
                limits.held_bytes,
                |id| in_interval(id, &base, &lo, &hi),
                projection_bytes,
                "ids-dirty-state-budget",
                "current type dirty record count exhausted",
                "current type dirty state exceeds held bound",
            )?;
            work.held_peak_bytes = work.held_peak_bytes.max(held_peak);
            changed = dirty
                .into_values()
                .map(|state| {
                    let key = ecma_json::JsString::from(state.id.as_str());
                    (key, Changed { id: state.id, projection: state.projection })
                })
                .collect();
        }
        work.dirty_records = changed.len();
        let mut dirty = changed
            .values()
            .rev()
            .filter(|state| {
                state
                    .projection
                    .held
                    .as_ref()
                    .and_then(|h| h.record_type.as_deref())
                    == Some(request.record_type)
            })
            .map(|state| state.id.clone())
            .collect::<VecDeque<_>>();
        let dirty_bytes = dirty.iter().map(String::len).sum::<usize>();
        held = held.saturating_add(dirty_bytes);
        work.held_peak_bytes = work.held_peak_bytes.max(held);
        if held > limits.held_bytes {
            return Err(meter.bounds_failure(
                "ids-dirty-state-budget",
                "current type merge workspace exceeds held bound",
            ));
        }
        let base_text = base.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        let mut checkpoint = VecDeque::<String>::new();
        let mut checkpoint_bytes = 0usize;
        let mut cursor = None;
        let mut checkpoint_done = lo >= hi;
        let mut pages_used = 0usize;
        let mut ids = Vec::new();
        let mut output_bytes = 0usize;
        loop {
            meter.check_at("ids-merge-budget")?;
            // Changed IDs shadow checkpoint membership even if their current
            // type is removed or changed to a different type.
            loop {
                while checkpoint
                    .front()
                    .is_some_and(|id| changed.contains_key(&ecma_json::JsString::from(id.as_str())))
                {
                    checkpoint_bytes = checkpoint_bytes
                        .saturating_sub(checkpoint.pop_front().ok_or(crate::cause!(Error::Corrupt))?.len());
                }
                if !checkpoint.is_empty() || checkpoint_done {
                    break;
                }
                let entries = limits
                    .checkpoint_entries
                    .saturating_sub(work.checkpoint_entries);
                let pages = limits.checkpoint_pages.saturating_sub(pages_used);
                let room = limits
                    .held_bytes
                    .saturating_sub(held)
                    .saturating_sub(output_bytes);
                if entries == 0 || pages == 0 || room == 0 {
                    return Err(meter.bounds_failure(
                        "ids-checkpoint-range-budget",
                        "current type checkpoint work exhausted",
                    ));
                }
                let capture = if complete_capture {
                    LegacyKept::complete_range_with_budget
                } else {
                    LegacyKept::range_with_budget
                };
                let page = capture(
                        kept,
                        &mut self.original,
                        Request {
                            lo: &lo,
                            hi: &hi,
                            reverse: true,
                            keys_only: true,
                            limit: checkpoint_window,
                            cursor: cursor.as_ref(),
                        },
                        RangeLimits {
                            entries,
                            pages,
                            held_bytes: room,
                            output_bytes: room.min(8 * 1024 * 1024),
                        },
                        meter.remaining_point_budget(),
                    )
                    .map_err(|error| {
                        let result = meter.kept_failure(&error);
                        if let Some(d) = &mut meter.diagnostic {
                            d.stage = "ids-checkpoint-range";
                        }
                        result
                    })?;
                charge_range(meter, &page.work)?;
                pages_used = pages_used.saturating_add(page.work.page_bodies as usize);
                work.checkpoint_entries = work
                    .checkpoint_entries
                    .saturating_add(page.entries_examined);
                work.held_peak_bytes = work.held_peak_bytes.max(
                    held.saturating_add(output_bytes)
                        .saturating_add(page.held_peak_bytes),
                );
                checkpoint_done = page.complete;
                cursor = page.next;
                if !checkpoint_done && cursor.is_none() {
                    return Err(crate::cause!(Error::Corrupt));
                }
                for item in page.items {
                    let id = item.key.strip_prefix(&base_text).ok_or(crate::cause!(Error::Corrupt))?;
                    if !valid_id(id) || item.value.is_some() {
                        return Err(crate::cause!(Error::Corrupt));
                    }
                    checkpoint_bytes = checkpoint_bytes.saturating_add(id.len());
                    checkpoint.push_back(id.into());
                }
                if complete_capture {
                    let capture_peak = held.saturating_add(output_bytes)
                        .saturating_add(page.held_peak_bytes).saturating_add(checkpoint_bytes);
                    work.held_peak_bytes = work.held_peak_bytes.max(capture_peak);
                    if capture_peak > limits.held_bytes {
                        return Err(meter.bounds_failure("ids-merge-budget", "current type complete capture exceeds held bound"));
                    }
                }
                let bytes = held
                    .saturating_add(output_bytes)
                    .saturating_add(checkpoint_bytes);
                work.held_peak_bytes = work.held_peak_bytes.max(bytes);
                if bytes > limits.held_bytes {
                    return Err(meter.bounds_failure(
                        "ids-merge-budget",
                        "current type merge workspace exceeds held bound",
                    ));
                }
            }
            let take_dirty = match (dirty.front(), checkpoint.front()) {
                (Some(a), Some(b)) => stamps::compare_text(a, b).is_gt(),
                (Some(_), None) => true,
                (None, Some(_)) => false,
                (None, None) => break,
            };
            let id = if take_dirty {
                dirty.pop_front().ok_or(crate::cause!(Error::Corrupt))?
            } else {
                let id = checkpoint.pop_front().ok_or(crate::cause!(Error::Corrupt))?;
                checkpoint_bytes = checkpoint_bytes.saturating_sub(id.len());
                id
            };
            if ids.len() < request.limit {
                output_bytes = output_bytes.saturating_add(id.len());
                if output_bytes > output_cap {
                    return Err(meter.bounds_failure(
                        "ids-output-budget",
                        "current type output byte bound exhausted",
                    ));
                }
            }
            let bytes = held
                .saturating_add(checkpoint_bytes)
                .saturating_add(output_bytes)
                .saturating_add(if ids.len() == request.limit {
                    id.len()
                } else {
                    0
                });
            work.held_peak_bytes = work.held_peak_bytes.max(bytes);
            if bytes > limits.held_bytes {
                return Err(meter.bounds_failure(
                    "ids-merge-budget",
                    "current type merge workspace exceeds held bound",
                ));
            }
            ids.push(id);
            if ids.len() > request.limit {
                break;
            }
        }
        let complete = ids.len() <= request.limit;
        if !complete {
            ids.pop();
        }
        work.output_bytes = ids.iter().map(String::len).sum();
        let next = if complete { None } else { ids.last().cloned() };
        // No provisional IDs leave a stale source, failed cancellation or
        // exhausted outer budget. The caller still owes snapshot.finish().
        meter.query(&mut self.original, "SELECT 1", &[])?;
        meter.check_at("ids-complete-budget")?;
        work.source_sql_statements = meter.statements;
        work.source_rows = meter.rows;
        work.source_bytes = meter.bytes;
        Ok(IdsPage {
            ids,
            next,
            complete,
            work,
        })
    }
}

/// Shared canonical pending-transaction reader. Both selected-record replay and
/// type enumeration use this exact SQL/part/order/complete-array path.
pub(super) fn replay_transactions<S, F>(
    original: &mut S,
    source_limits: &ReadLimits,
    meter: &mut Meter,
    selected_id: Option<&str>,
    covered: i64,
    last: i64,
    has_keys: bool,
    mut apply: F,
) -> Result<()>
where
    S: BoundedRecordSql + ?Sized,
    F: FnMut(&mut S, &mut Meter, &str, &[&RawValue], bool) -> Result<()>,
{
    let selected_ids = selected_id.map(|id| [id]);
    replay_transactions_for_ids(
        original,
        source_limits,
        meter,
        selected_ids.as_ref().map(|ids| ids.as_slice()),
        covered,
        last,
        has_keys,
        |original, meter, row_id, envelopes, key_present| {
            apply(
                original,
                meter,
                row_id,
                envelopes,
                selected_id.is_some_and(|id| key_present.iter().any(|present| present.as_str() == id)),
            )
        },
    )
}

/// Replay one complete canonical tail once for a bounded set of selected IDs.
/// The transaction/part/order/body decoder is shared with the single-ID path;
/// only matching projections and key-existence bits are returned to the caller.
pub(super) fn replay_transactions_for_ids<S, F>(
    original: &mut S,
    source_limits: &ReadLimits,
    meter: &mut Meter,
    selected_ids: Option<&[&str]>,
    covered: i64,
    last: i64,
    has_keys: bool,
    mut apply: F,
) -> Result<()>
where
    S: BoundedRecordSql + ?Sized,
    F: FnMut(&mut S, &mut Meter, &str, &[&RawValue], &[String]) -> Result<()>,
{
    // Only the selected stored-record consumer needs key-slot existence. IDs
    // never copy the log's erasable-key column across the source boundary.
    let has_keys = has_keys && selected_ids.is_some();
    let sql=format!("SELECT rowid,id,transaction_id,part,parts,envelopes,{} FROM record_log WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?",if has_keys{"keys"}else{"NULL"});
    // A caller-smaller supplier packet must not make a formerly valid tail
    // unreadable. Admit an ordered byte prefix before copying payloads, rather
    // than retrying/discarding a materialized oversized packet. The fast path
    // needs no sizing pass when the aggregate remainder is already the tighter
    // byte cap: exceeding that cap could never produce a complete answer.
    let width = |column: &str| {
        format!("CASE WHEN typeof({column}) IN ('text','blob') THEN length(CAST({column} AS BLOB)) ELSE 8 END")
    };
    let key_width = if has_keys { width("keys") } else { "8".into() };
    let sized_sql = format!("WITH prefix AS (SELECT rowid,SUM(8+{}+{}+{}+{}+{}+{key_width}) OVER (ORDER BY rowid ROWS UNBOUNDED PRECEDING) AS used FROM record_log WHERE rowid>?1 AND rowid<=?2 ORDER BY rowid LIMIT ?3) SELECT source.rowid AS rowid,source.id AS id,source.transaction_id AS transaction_id,source.part AS part,source.parts AS parts,source.envelopes AS envelopes,{} AS keys FROM prefix JOIN record_log AS source ON source.rowid=prefix.rowid WHERE prefix.used<=?4 ORDER BY source.rowid",width("id"),width("transaction_id"),width("part"),width("parts"),width("envelopes"),if has_keys { "source.keys" } else { "NULL" });
    let column_bytes = [
        "rowid",
        "id",
        "transaction_id",
        "part",
        "parts",
        "envelopes",
        "keys",
    ]
    .iter()
    .map(|name| name.len())
    .sum::<usize>();
    let mut after = covered;
    let mut pending: Option<PendingTail> = None;
    while after < last {
        // Keep one returned row/statement for the final continuity probe. All
        // other ceilings remain the outer remainder and original supplier's.
        let window = meter
            .bounds
            .rows
            .saturating_sub(meter.rows)
            .saturating_sub(1)
            .min(source_limits.rows);
        if window == 0 {
            return Err(
                meter.bounds_failure("log-replay-budget", "original record row budget exhausted")
            );
        }
        if meter.bounds.statements.saturating_sub(meter.statements) <= 1 {
            return Err(meter.bounds_failure(
                "log-replay-budget",
                "original record statement budget exhausted",
            ));
        }
        let remaining_bytes = meter.bounds.bytes.saturating_sub(meter.bytes);
        let supplier_byte_window = source_limits.result_bytes < remaining_bytes;
        let mut params = vec![
            Value::Integer(after),
            Value::Integer(last),
            Value::Integer(window as i64),
        ];
        let ordered_prefix = supplier_byte_window && original.supports_ordered_prefix();
        if supplier_byte_window && !ordered_prefix {
            params.push(Value::Integer(
                source_limits.result_bytes.saturating_sub(column_bytes) as i64,
            ));
        }
        let rows = if ordered_prefix {
            meter.ordered_prefix_query(original, &sql, &params)?
        } else { meter.query(
            original,
            if supplier_byte_window {
                &sized_sql
            } else {
                &sql
            },
            &params,
        )? };
        if rows.rows.is_empty() {
            if supplier_byte_window {
                let mut diagnostic = meter.observation(
                    "log-replay-query",
                    "original record row exceeds supplier packet bound",
                );
                diagnostic.source = Some(crate::legacy_kept::SourceFailure::Refused(
                    "original query result byte bound exceeded",
                 crate::cause!()));
                meter.diagnostic = Some(diagnostic);
                return Err(crate::cause!(Error::Source));
            }
            break;
        }
        for mut row in rows.rows {
            if row.len() != 7 {
                return Err(crate::cause!(Error::Corrupt));
            }
            let n = integer(&row[0])?;
            if n <= after {
                return Err(crate::cause!(Error::Corrupt));
            }
            after = n;
            let row_id = text(&row[1])?.to_owned();
            let transaction = text(&row[2])?.to_owned();
            let part = integer(&row[3])?;
            let parts = integer(&row[4])?;
            if parts < 1 || parts > 32 || part < 0 || part >= parts {
                return Err(crate::cause!(Error::ReplayRequired));
            }
            let key_present = if let Some(SqlValue::Text(mut bytes)) = row.pop() {
                let result = (|| {
                    let raw = std::str::from_utf8(&bytes).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
                    if raw.is_empty() {
                        return Ok(Vec::new());
                    }
                    if let Some(ids) = selected_ids {
                        let keys = raw_object(raw)?;
                        Ok(ids
                            .iter()
                            .filter(|id| keys.get(**id).is_some_and(|value| value.get() != "null"))
                            .map(|id| (*id).to_owned())
                            .collect::<Vec<_>>())
                    } else {
                        // Type membership never needs an erasable key value.
                        Ok(Vec::new())
                    }
                })();
                bytes.zeroize();
                result?
            } else {
                Vec::new()
            };
            if part == 0 {
                if pending.is_some() {
                    return Err(crate::cause!(Error::ReplayRequired));
                }
                pending = Some(PendingTail {
                    id: row_id.clone(),
                    transaction: transaction.clone(),
                    parts,
                    seen: 0,
                    body: String::new(),
                    key_present,
                });
            }
            let held = pending.as_mut().ok_or(crate::cause!(Error::ReplayRequired))?;
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
                return Err(crate::cause!(Error::ReplayRequired));
            }
            let chunk = text(&row[5])?;
            if held.body.len().saturating_add(chunk.len()) > meter.bounds.bytes {
                return Err(meter.bounds_failure(
                    "log-transaction-budget",
                    "original record multipart byte budget exhausted",
                ));
            }
            held.body.push_str(chunk);
            held.seen += 1;
            if held.seen == held.parts {
                let done = pending.take().ok_or(crate::cause!(Error::Corrupt))?;
                let body = Zeroizing::new(done.body);
                let envelopes: Vec<&RawValue> =
                    serde_json::from_str(&body).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
                if envelopes.len() > 100_000 {
                    return Err(meter.bounds_failure(
                        "log-transaction-budget",
                        "original record transaction envelope count exceeds 100000",
                    ));
                }
                // The entire transaction array is valid before either consumer
                // changes provisional state. The callback shares this Meter.
                apply(original, meter, &done.id, &envelopes, &done.key_present)?;
            }
        }
    }
    if pending.is_some() || after < last {
        return Err(crate::cause!(Error::ReplayRequired));
    }
    meter.check()
}
