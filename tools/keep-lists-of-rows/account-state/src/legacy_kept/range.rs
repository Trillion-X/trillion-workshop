//! Bounded indexed ranges over the existing original run schema. One decoder
//! owner, no raw SQLite connection, initialization, scan of every table/page,
//! source authority or private/logical-value resolution. This is checkpoint
//! state only: the canonical record owner must merge its captured dirty tail.
//! Run metadata is ordered by age/run; equal keys select newest, including
//! deletion. Only winning returned values are decoded or multipart-opened.
use super::{
    batch::{self, RawPage},
    order, LegacyKept, Meter, PointBudget, Work,
};
use crate::{
    ecma_json::JsString,
    kept_runs::{self, PackedPage, PackedText, Settings},
    record_source::BoundedRecordSql,
};
use rusqlite::types::Value;
use std::{
    cmp::Ordering,
    collections::{BTreeSet, HashSet, VecDeque},
    fmt,
    time::Instant,
};

#[derive(Clone, Copy, Debug)]
pub struct RangeLimits {
    pub entries: usize,
    pub pages: usize,
    pub held_bytes: usize,
    pub output_bytes: usize,
}
impl Default for RangeLimits {
    fn default() -> Self {
        Self {
            entries: 4096,
            pages: 256,
            held_bytes: 16 * 1024 * 1024,
            output_bytes: 8 * 1024 * 1024,
        }
    }
}
#[derive(Clone, PartialEq, Eq)]
struct Scope {
    lo: JsString,
    hi: JsString,
    reverse: bool,
    keys_only: bool,
}
/// A position, never authority. Reuse only under the caller's same retained
/// snapshot if a coherent multi-page read is required. Cross-snapshot change
/// semantics and token transport belong to that caller.
pub struct Cursor {
    scope: Scope,
    last: String,
}
/// Construct the kept-run continuation for an already validated canonical
/// record-index cursor. Bounds and query identity remain the caller's owner.
pub fn cursor_after(
    lo: &JsString,
    hi: &JsString,
    reverse: bool,
    keys_only: bool,
    last: String,
) -> Cursor {
    Cursor {
        scope: Scope {
            lo: lo.clone(),
            hi: hi.clone(),
            reverse,
            keys_only,
        },
        last,
    }
}
impl fmt::Debug for Cursor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("KeptRangeCursor([redacted])")
    }
}
pub struct Request<'a> {
    pub lo: &'a JsString,
    pub hi: &'a JsString,
    pub reverse: bool,
    pub keys_only: bool,
    pub limit: usize,
    pub cursor: Option<&'a Cursor>,
}
pub struct Item {
    pub key: String,
    pub value: Option<String>,
}
impl fmt::Debug for Item {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("KeptRangeItem([redacted])")
    }
}
pub struct Page {
    pub items: Vec<Item>,
    pub next: Option<Cursor>,
    pub complete: bool,
    pub work: Work,
    pub entries_examined: usize,
    pub held_peak_bytes: usize,
    pub output_bytes: usize,
}
/// Several disjoint key-only intervals read under one source witness.
pub struct PrefixesPage {
    pub groups: Vec<Vec<Item>>,
    pub work: Work,
    pub entries_examined: usize,
    pub held_peak_bytes: usize,
    pub output_bytes: usize,
}
impl fmt::Debug for Page {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("KeptRangePage([redacted])")
    }
}
/// Original exclusive prefix end advances one UTF-16 unit, not a Unicode scalar.
/// A bound may contain a lone surrogate even though unsupported stored keys
/// still refuse in the shared original decoder.
pub fn prefix_end(prefix: &JsString) -> Option<JsString> {
    let mut units = prefix.units().to_vec();
    for at in (0..units.len()).rev() {
        if units[at] < u16::MAX {
            units[at] += 1;
            units.truncate(at + 1);
            return Some(JsString::from_units(units));
        }
    }
    None
}
struct Run {
    number: i64,
    age: i64,
    pages: i64,
    last: String,
}
struct Lane {
    run: Run,
    page: i64,
    head: Option<PackedPage>,
    index: Option<usize>,
    full_body: bool,
    pending: VecDeque<RawPage>,
}
struct RangeMeter {
    limits: RangeLimits,
    examined: usize,
    pages: usize,
    held: usize,
    peak: usize,
    output: usize,
}
fn compare(key: &str, bound: &JsString) -> Ordering {
    key.encode_utf16().cmp(bound.units().iter().copied())
}
/// Seek the same key in several independently numbered run tables under one
/// bounded source query per group. The recursive CTEs retain each run's own
/// binary-search state; the caller still checks exact UTF-16 brackets before
/// loading or merging a page.
fn seek_run_group<S: BoundedRecordSql + ?Sized>(
    source: &mut S,
    runs: &[&Run],
    key: &str,
    bound: &JsString,
    meter: &mut Meter<'_>,
) -> super::Result<Vec<Option<i64>>> {
    if runs.is_empty() || runs.len() > 64 {
        return Err(meter.error("original kept cross-run seek input refused"));
    }
    let mut single = Vec::new();
    let mut multi = Vec::new();
    for (ordinal, run) in runs.iter().enumerate() {
        if run.number < 0 || run.pages <= 0 || run.pages as usize > meter.limits.pages_per_run {
            return Err(meter.error("original kept cross-run geometry refused"));
        }
        if run.pages == 1 {
            single.push((ordinal, *run));
        } else {
            multi.push((ordinal, *run));
        }
    }
    let mut answers = vec![None; runs.len()];
    let supplier = source
        .read_limits()
        .ok_or_else(|| meter.error("original kept cross-run supplier ceilings unavailable"))?
        .clone();
    supplier
        .validate()
        .map_err(|_| meter.error("original kept cross-run supplier ceilings refused"))?;
    let row_bytes = meter.limits.key_bytes.saturating_mul(6).saturating_add(256);
    if !single.is_empty() {
        let remaining_rows = meter
            .limits
            .rows
            .saturating_sub(meter.work.rows_returned as usize)
            .min(supplier.rows);
        let remaining_bytes = meter
            .limits
            .source_bytes
            .saturating_sub(meter.work.source_bytes as usize)
            .min(supplier.result_bytes);
        let batch_size = 64usize
            .min(remaining_rows)
            .min(remaining_bytes / row_bytes.max(1));
        if batch_size == 0 {
            return Err(meter.budget_error("original kept cross-run single boundary key allowance exhausted"));
        }
        for batch in single.chunks(batch_size) {
            let terms = batch
                .iter()
                .map(|(ordinal, run)| {
                    format!(
                        "SELECT {ordinal} AS ord,first FROM record_keys_run_{} WHERE page=0",
                        run.number
                    )
                })
                .collect::<Vec<_>>()
                .join(" UNION ALL ");
            let rows = meter.query(
                source,
                &format!("SELECT ord,first FROM ({terms}) ORDER BY ord"),
                &[],
            )?;
            if rows.rows.len() != batch.len() {
                return Err(meter.error("original kept cross-run single boundary key missing"));
            }
            for (row, (ordinal, _)) in rows.rows.iter().zip(batch) {
                if row.len() != 2 || meter.integer(&row[0])? != *ordinal as i64 {
                    return Err(meter.error("original kept cross-run single boundary key invalid"));
                }
                let first = meter.key(&row[1])?;
                answers[*ordinal] = (order(&first, key) != Ordering::Greater).then_some(0);
            }
        }
    }
    let remaining_rows = meter
        .limits
        .rows
        .saturating_sub(meter.work.rows_returned as usize)
        .min(supplier.rows);
    let remaining_bytes = meter
        .limits
        .source_bytes
        .saturating_sub(meter.work.source_bytes as usize)
        .min(supplier.result_bytes);
    let batch_rows = remaining_rows.min(remaining_bytes / row_bytes.max(1));
    let mut offset = 0;
    while offset < multi.len() {
        let mut count = 0usize;
        let mut rows_cap = 0usize;
        while offset + count < multi.len() && count < 64 {
            let pages = multi[offset + count].1.pages as u64;
            let steps = pages.ilog2() as usize + 1;
            if rows_cap.saturating_add(steps) > batch_rows {
                break;
            }
            rows_cap = rows_cap.saturating_add(steps);
            count += 1;
        }
        if count == 0 {
            return Err(meter.budget_error("original kept cross-run boundary key allowance exhausted"));
        }
        let group = &multi[offset..offset + count];
        let mut definitions = Vec::with_capacity(group.len());
        let mut selections = Vec::with_capacity(group.len());
        for (local, (ordinal, run)) in group.iter().enumerate() {
            let cte = format!("seek_{local}");
            let table = format!("record_keys_run_{}", run.number);
            let valid = "CASE WHEN typeof(probe.first)='text' THEN CASE WHEN json_valid(probe.first) THEN CASE WHEN json_type(probe.first)='text' THEN 1 ELSE 0 END ELSE 0 END ELSE 0 END";
            let below = format!("CASE WHEN ({valid})=1 THEN json_extract(probe.first,'$') COLLATE BINARY<=?1 ELSE 0 END");
            definitions.push(format!(
                "{cte}(lo,hi,found,here,next,seen,valid,step) AS (SELECT 0,{},-1,NULL,NULL,NULL,1,0 UNION ALL SELECT CASE WHEN {below} THEN (lo+hi)/2+1 ELSE lo END,CASE WHEN {below} THEN hi ELSE (lo+hi)/2-1 END,CASE WHEN {below} THEN (lo+hi)/2 ELSE found END,CASE WHEN {below} THEN probe.first ELSE here END,CASE WHEN {below} THEN next ELSE probe.first END,probe.first,{valid},step+1 FROM {cte} LEFT JOIN {table} AS probe ON probe.page=(lo+hi)/2 WHERE lo<=hi AND valid=1 AND step<32)",
                run.pages - 1
            ));
            selections.push(format!(
                "SELECT {ordinal} AS ord,step,lo,hi,found,CASE WHEN lo>hi THEN here END AS here,CASE WHEN lo>hi THEN next END AS next,seen,valid FROM {cte} WHERE step>0"
            ));
        }
        let sql = format!(
            "WITH RECURSIVE {} {} ORDER BY ord,step LIMIT ?2",
            definitions.join(","),
            selections.join(" UNION ALL ")
        );
        let row_cap_i64 = i64::try_from(rows_cap)
            .map_err(|_| meter.budget_error("original kept cross-run row allowance overflow"))?;
        let rows = meter.query(source, &sql, &[Value::Text(key.to_owned()), Value::Integer(row_cap_i64)])?;
        if rows.rows.len() > rows_cap {
            return Err(meter.budget_error("original kept cross-run boundary key exceeded row allowance"));
        }
        let mut cursor = 0usize;
        for (ordinal, run) in group {
            let start = cursor;
            while cursor < rows.rows.len() {
                let row = &rows.rows[cursor];
                if row.len() != 9 {
                    return Err(meter.error("original kept cross-run boundary key row invalid"));
                }
                let row_ordinal = meter.integer(&row[0])?;
                if row_ordinal < *ordinal as i64 {
                    return Err(meter.error("original kept cross-run boundary key order invalid"));
                }
                if row_ordinal != *ordinal as i64 {
                    break;
                }
                if meter.integer(&row[1])? != (cursor - start + 1) as i64
                    || meter.integer(&row[8])? != 1
                {
                    return Err(meter.error("original kept cross-run page boundary key invalid"));
                }
                meter.key(&row[7])?;
                cursor += 1;
            }
            let group_rows = &rows.rows[start..cursor];
            let Some(last) = group_rows.last() else {
                return Err(meter.error("original kept cross-run boundary key result missing"));
            };
            if meter.integer(&last[1])? <= 0 || meter.integer(&last[2])? <= meter.integer(&last[3])? {
                return Err(meter.error("original kept cross-run boundary key search incomplete"));
            }
            let found = meter.integer(&last[4])?;
            if found < -1 || found >= run.pages {
                return Err(meter.error("original kept cross-run boundary key result invalid"));
            }
            let here = if found >= 0 { Some(meter.key(&last[5])?) } else { None };
            let next = if found + 1 < run.pages { Some(meter.key(&last[6])?) } else { None };
            let bracketed = here.as_ref().is_none_or(|boundary_key| order(boundary_key, key) != Ordering::Greater)
                && next.as_ref().is_none_or(|boundary_key| order(boundary_key, key) == Ordering::Greater);
            answers[*ordinal] = if bracketed {
                (found >= 0).then_some(found)
            } else {
                self_fallback(source, run, bound, meter)?
            };
        }
        if cursor != rows.rows.len() {
            return Err(meter.error("original kept cross-run boundary key result order invalid"));
        }
        offset += count;
    }
    meter.check()?;
    Ok(answers)
}
fn self_fallback<S: BoundedRecordSql + ?Sized>(
    source: &mut S,
    run: &Run,
    bound: &JsString,
    meter: &mut Meter<'_>,
) -> super::Result<Option<i64>> {
    let (mut lo, mut hi) = (0, run.pages);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        let rows = meter.query(
            source,
            &format!("SELECT first FROM record_keys_run_{} WHERE page=?", run.number),
            &[Value::Integer(mid)],
        )?;
        if rows.rows.len() != 1 || rows.rows[0].len() != 1 {
            return Err(meter.error("original kept cross-run fallback boundary key missing"));
        }
        let first = meter.key(&rows.rows[0][0])?;
        if compare(&first, bound) != Ordering::Greater {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    Ok((lo > 0).then_some(lo - 1))
}
fn settings(kept: &LegacyKept) -> Settings {
    Settings {
        page_bytes: kept.limits.page_bytes,
        max_key_bytes: kept.limits.key_bytes,
        max_value_bytes: kept.limits.value_bytes,
        ..Settings::default()
    }
}
fn release_pending(lane: &mut Lane, range: &mut RangeMeter) {
    for page in lane.pending.drain(..) {
        range.held = range.held.saturating_sub(page.held_bytes);
    }
}
impl LegacyKept {
    pub fn range<S: BoundedRecordSql + ?Sized>(
        &self,
        source: &mut S,
        request: Request<'_>,
        limits: RangeLimits,
    ) -> super::Result<Page> {
        self.range_with_budget(
            source,
            request,
            limits,
            PointBudget {
                statements: self.limits.statements,
                rows: self.limits.rows,
                source_bytes: self.limits.source_bytes,
                deadline: Instant::now() + self.limits.elapsed,
            },
        )
    }
    pub fn range_with_budget<S: BoundedRecordSql + ?Sized>(
        &self,
        source: &mut S,
        request: Request<'_>,
        range_limits: RangeLimits,
        budget: PointBudget,
    ) -> super::Result<Page> {
        self.range_read(source, request, range_limits, budget, false)
    }

    /// Same merge/decoder, but require a complete bounded capture. At the
    /// output ceiling settle every equal-key lane before proving exhaustion;
    /// an additional live key refuses instead of returning a partial proof.
    pub(crate) fn complete_range_with_budget<S: BoundedRecordSql + ?Sized>(
        &self,
        source: &mut S,
        request: Request<'_>,
        range_limits: RangeLimits,
        budget: PointBudget,
    ) -> super::Result<Page> {
        self.range_read(source, request, range_limits, budget, true)
    }

    fn range_read<S: BoundedRecordSql + ?Sized>(
        &self,
        source: &mut S,
        request: Request<'_>,
        range_limits: RangeLimits,
        budget: PointBudget,
        complete_required: bool,
    ) -> super::Result<Page> {
        let started = Instant::now();
        let mut limits = self.limits.clone();
        limits.statements = limits.statements.min(budget.statements);
        limits.rows = limits.rows.min(budget.rows);
        limits.source_bytes = limits.source_bytes.min(budget.source_bytes);
        let mut meter = Meter {
            limits: &limits,
            work: Work {
                source_timing_complete: true,
                ..Work::default()
            },
            start: started,
            deadline: budget.deadline.min(started + limits.elapsed),
        };
        if request.limit == 0
            || request.limit > 4096
            || request.lo.len() > self.limits.key_bytes
            || request.hi.len() > self.limits.key_bytes
            || range_limits.entries == 0
            || range_limits.entries > 1_000_000
            || range_limits.pages == 0
            || range_limits.pages > 65536
            || range_limits.held_bytes == 0
            || range_limits.held_bytes > 64 * 1024 * 1024
            || range_limits.output_bytes == 0
            || range_limits.output_bytes > 32 * 1024 * 1024
        {
            return Err(meter.error("original kept range input or limits refused"));
        }
        let scope = Scope {
            lo: request.lo.clone(),
            hi: request.hi.clone(),
            reverse: request.reverse,
            keys_only: request.keys_only,
        };
        if let Some(cursor) = request.cursor {
            if cursor.scope != scope
                || compare(&cursor.last, &scope.lo) == Ordering::Less
                || compare(&cursor.last, &scope.hi) != Ordering::Less
            {
                return Err(meter.error("original kept range cursor scope refused"));
            }
        }
        if scope.lo >= scope.hi {
            return Err(meter.error("original kept range interval refused"));
        }
        let supplier = source
            .read_limits()
            .ok_or_else(|| meter.error("original kept range supplier ceilings unavailable"))?
            .clone();
        supplier
            .validate()
            .map_err(|_| meter.error("original kept range supplier ceilings refused"))?;
        let row_bytes = self
            .limits
            .key_bytes
            .saturating_mul(6)
            .saturating_add(2 + 5 * 8);
        let window = supplier.rows.min(
            supplier
                .result_bytes
                .saturating_sub(64)
                .checked_div(row_bytes)
                .unwrap_or(0)
                .max(1),
        );
        let runs = self.range_runs(source, window, &mut meter)?;
        let mut range = RangeMeter {
            limits: range_limits,
            examined: 0,
            pages: 0,
            held: 0,
            peak: 0,
            output: 0,
        };
        let mut lanes = Vec::new();
        let bound = if let Some(cursor) = request.cursor {
            JsString::from(cursor.last.as_str())
        } else if scope.reverse {
            scope.hi.clone()
        } else {
            scope.lo.clone()
        };
        let candidates = runs
            .into_iter()
            .filter(|run| run.pages > 0 && compare(&run.last, &scope.lo) != Ordering::Less)
            .collect::<Vec<_>>();
        let pages = if let Ok(bound_text) = bound.to_rust_string() {
            let refs = candidates.iter().collect::<Vec<_>>();
            let mut pages = Vec::with_capacity(refs.len());
            for group in refs.chunks(64) {
                pages.extend(seek_run_group(source, group, &bound_text, &bound, &mut meter)?);
            }
            pages
        } else {
            candidates
                .iter()
                .map(|run| self.range_seek_units(source, run, &bound, &mut meter))
                .collect::<super::Result<Vec<_>>>()?
        };
        if pages.len() != candidates.len() {
            return Err(meter.error("original kept cross-run seek results incomplete"));
        }
        for (run, page) in candidates.into_iter().zip(pages) {
            let page = match page {
                Some(page) => page,
                None if !scope.reverse => 0,
                None => continue,
            };
            let mut lane = Lane {
                run,
                page,
                head: None,
                index: None,
                full_body: false,
                pending: VecDeque::new(),
            };
            self.range_load(
                source,
                &mut lane,
                None,
                &mut range,
                &mut meter,
                scope.reverse,
                false,
                false,
            )?;
            // Seek inside the initial page too. A narrow interval/cursor
            // must not linearly skip all earlier heads of a dense page.
            let head = lane
                .head
                .as_ref()
                .ok_or_else(|| meter.error("original kept range page missing"))?;
            let (mut low, mut high) = (0, head.len());
            while low < high {
                meter.check()?;
                let mid = low + (high - low) / 2;
                let key = head
                    .key(mid)
                    .map_err(|_| meter.error("original kept range head refused"))?;
                let order = compare(&key, &bound);
                if order == Ordering::Less
                    || (!scope.reverse && request.cursor.is_some() && order == Ordering::Equal)
                {
                    low = mid + 1;
                } else {
                    high = mid;
                }
            }
            lane.index = if scope.reverse {
                low.checked_sub(1)
            } else {
                (low < head.len()).then_some(low)
            };
            self.range_settle(
                source,
                &mut lane,
                &scope,
                request.cursor,
                &mut range,
                &mut meter,
            )?;
            lanes.push(lane);
        }
        let mut items = Vec::new();
        loop {
            meter.check()?;
            let mut best: Option<(usize, String)> = None;
            for (at, lane) in lanes.iter().enumerate() {
                if let (Some(head), Some(index)) = (&lane.head, lane.index) {
                    let key = head
                        .key(index)
                        .map_err(|_| meter.error("original kept range head refused"))?;
                    if best.as_ref().is_none_or(|(_, current)| {
                        if scope.reverse {
                            order(&key, current) == Ordering::Greater
                        } else {
                            order(&key, current) == Ordering::Less
                        }
                    }) {
                        best = Some((at, key))
                    }
                }
            }
            let Some((mut winner, key)) = best else {
                return self.range_finish(source, items, None, true, &range, &mut meter);
            };
            if range.examined >= range.limits.entries {
                return Err(meter.budget_error("original kept range entry budget exhausted"));
            }
            range.examined += 1;
            let mut same = Vec::new();
            for (at, lane) in lanes.iter().enumerate() {
                if let (Some(head), Some(index)) = (&lane.head, lane.index) {
                    if head
                        .key(index)
                        .map_err(|_| meter.error("original kept range head refused"))?
                        == key
                    {
                        same.push(at);
                        if (lane.run.age, lane.run.number)
                            > (lanes[winner].run.age, lanes[winner].run.number)
                        {
                            winner = at;
                        }
                    }
                }
            }
            let tombstone = {
                let lane = &lanes[winner];
                lane.head
                    .as_ref()
                    .ok_or_else(|| meter.error("original kept range page missing"))?
                    .is_tombstone(
                        lane.index
                            .ok_or_else(|| meter.error("original kept range head missing"))?,
                    )
                    .map_err(|_| meter.error("original kept range deletion refused"))?
            };
            if !scope.keys_only && !tombstone && !lanes[winner].full_body {
                let index = lanes[winner].index;
                self.range_load(
                    source,
                    &mut lanes[winner],
                    None,
                    &mut range,
                    &mut meter,
                    scope.reverse,
                    true,
                    false,
                )?;
                lanes[winner].index = index;
                let lane = &lanes[winner];
                if lane
                    .head
                    .as_ref()
                    .ok_or_else(|| meter.error("original kept range page missing"))?
                    .key(index.ok_or_else(|| meter.error("original kept range head missing"))?)
                    .map_err(|_| meter.error("original kept range head refused"))?
                    != key
                {
                    return Err(meter.error("original kept range selected page changed"));
                }
            }
            let lane = &lanes[winner];
            let index = lane
                .index
                .ok_or_else(|| meter.error("original kept range head missing"))?;
            let head = lane
                .head
                .as_ref()
                .ok_or_else(|| meter.error("original kept range page missing"))?;
            if !head
                .is_tombstone(index)
                .map_err(|_| meter.error("original kept range deletion refused"))?
            {
                if complete_required && items.len() >= request.limit {
                    return Err(meter.budget_error("original kept complete output count exhausted"));
                }
                let value = if scope.keys_only {
                    None
                } else {
                    let start = Instant::now();
                    let remaining = range
                        .limits
                        .output_bytes
                        .saturating_sub(range.output)
                        .saturating_sub(key.len());
                    // A value refused for its size only because the values
                    // already in this page used the budget fits a page with
                    // fewer of them: that refusal is the page's, not the value's.
                    let page_holds_values = !items.is_empty();
                    if remaining == 0 {
                        let mut error =
                            meter.budget_error("original kept range output budget exhausted");
                        if page_holds_values {
                            error.kind = crate::cause!(super::Refusal::PageBudget);
                        }
                        return Err(error);
                    }
                    let mut selected_settings = settings(self);
                    let page_capped = remaining < selected_settings.max_value_bytes;
                    selected_settings.max_value_bytes =
                        selected_settings.max_value_bytes.min(remaining);
                    let selected = head.selected(index, &selected_settings);
                    meter.work.page_decode_us = meter
                        .work
                        .page_decode_us
                        .saturating_add(start.elapsed().as_micros().min(u64::MAX as u128) as u64);
                    let over_page = |size_refusal: bool| {
                        if size_refusal && page_capped && page_holds_values {
                            crate::cause!(super::Refusal::PageBudget)
                        } else if size_refusal {
                            crate::cause!(super::Refusal::ValueBound)
                        } else {
                            crate::cause!(super::Refusal::Other)
                        }
                    };
                    Some(
                        match selected.map_err(|error| {
                            let mut refusal = meter.refusal(
                                "original kept range winning value refused",
                                over_page(matches!(error, crate::kept_runs::Error::Bounds(_, _))),
                            );
                            refusal.cause = error.cause();
                            refusal
                        })? {
                            PackedText::Json(text) => text,
                            PackedText::Big { reference, parts } => {
                                let mut selected_limits = self.limits.clone();
                                let multipart_capped = remaining < selected_limits.value_bytes;
                                selected_limits.value_bytes =
                                    selected_limits.value_bytes.min(remaining);
                                LegacyKept {
                                    limits: selected_limits,
                                }
                                .multipart(source, &reference, parts, &mut meter)
                                .map_err(|mut error| {
                                    if matches!(error.kind, super::Refusal::ValueBound(_))
                                        && multipart_capped
                                        && page_holds_values
                                    {
                                        error.kind = crate::cause!(super::Refusal::PageBudget);
                                    }
                                    error
                                })?
                            }
                            _ => {
                                return Err(meter.error("original kept range winning entry changed"))
                            }
                        },
                    )
                };
                let bytes = key
                    .len()
                    .checked_add(value.as_ref().map_or(0, String::len))
                    .ok_or_else(|| meter.budget_error("original kept range output overflow"))?;
                range.output = range
                    .output
                    .checked_add(bytes)
                    .ok_or_else(|| meter.budget_error("original kept range output overflow"))?;
                if range.output > range.limits.output_bytes {
                    return Err(meter.budget_error("original kept range output budget exhausted"));
                }
                if complete_required {
                    // Complete captures hold output while remaining run lanes
                    // and batched pages are still resident. Charge both.
                    range.held = range.held.saturating_add(bytes);
                    range.peak = range.peak.max(range.held);
                    if range.held > range.limits.held_bytes {
                        return Err(meter.budget_error("original kept complete held budget exhausted"));
                    }
                }
                items.push(Item {
                    key: key.clone(),
                    value,
                });
                if !complete_required && items.len() == request.limit {
                    return self.range_finish(
                        source,
                        items,
                        Some(Cursor { scope, last: key }),
                        false,
                        &range,
                        &mut meter,
                    );
                }
            }
            for at in same {
                let lane = &mut lanes[at];
                lane.index = match (lane.index, &lane.head) {
                    (Some(index), Some(head)) => {
                        if scope.reverse {
                            index.checked_sub(1)
                        } else {
                            (index + 1 < head.len()).then_some(index + 1)
                        }
                    }
                    _ => None,
                };
                self.range_settle(source, lane, &scope, request.cursor, &mut range, &mut meter)?;
            }
        }
    }
    /// Read several disjoint exact-prefix intervals with one candidate-run
    /// scan and batched indexed boundary key/page reads. Every interval is complete
    /// or the operation refuses; no prefix returns a partial group.
    pub fn prefixes_with_budget<S: BoundedRecordSql + ?Sized>(
        &self,
        source: &mut S,
        bounds: &[(JsString, JsString)],
        limit_per_prefix: usize,
        range_limits: RangeLimits,
        budget: PointBudget,
    ) -> super::Result<PrefixesPage> {
        let started = Instant::now();
        let mut limits = self.limits.clone();
        limits.statements = limits.statements.min(budget.statements);
        limits.rows = limits.rows.min(budget.rows);
        limits.source_bytes = limits.source_bytes.min(budget.source_bytes);
        let mut meter = Meter {
            limits: &limits,
            work: Work {
                source_timing_complete: true,
                ..Work::default()
            },
            start: started,
            deadline: budget.deadline.min(started + limits.elapsed),
        };
        if bounds.is_empty()
            || bounds.len() > 100
            || limit_per_prefix == 0
            || limit_per_prefix > 4096
            || range_limits.entries == 0
            || range_limits.entries > 1_000_000
            || range_limits.pages == 0
            || range_limits.pages > 65536
            || range_limits.held_bytes == 0
            || range_limits.held_bytes > 64 * 1024 * 1024
            || range_limits.output_bytes == 0
            || range_limits.output_bytes > 32 * 1024 * 1024
            || bounds.iter().any(|(lo, hi)| {
                lo >= hi || lo.len() > self.limits.key_bytes || hi.len() > self.limits.key_bytes
            })
        {
            return Err(meter.error("original kept multi-prefix input or limits refused"));
        }
        for at in 0..bounds.len() {
            for other in 0..at {
                if bounds[at].0 == bounds[other].0 && bounds[at].1 == bounds[other].1 {
                    continue;
                }
                if compare(
                    &bounds[at].0.to_rust_string().map_err(|_| {
                        meter.error("original kept multi-prefix bound is not UTF-8")
                    })?,
                    &bounds[other].1,
                )
                .is_lt()
                    && compare(
                        &bounds[other].0.to_rust_string().map_err(|_| {
                            meter.error("original kept multi-prefix bound is not UTF-8")
                        })?,
                        &bounds[at].1,
                    )
                    .is_lt()
                {
                    return Err(meter.error("original kept multi-prefix intervals overlap"));
                }
            }
        }
        let supplier = source
            .read_limits()
            .ok_or_else(|| meter.error("original kept multi-prefix supplier ceilings unavailable"))?
            .clone();
        supplier
            .validate()
            .map_err(|_| meter.error("original kept multi-prefix supplier ceilings refused"))?;
        let mut groups = (0..bounds.len())
            .map(|_| Vec::<Item>::new())
            .collect::<Vec<_>>();
        let mut seen = (0..bounds.len())
            .map(|_| HashSet::<String>::new())
            .collect::<Vec<_>>();
        let mut range = RangeMeter {
            limits: range_limits,
            examined: 0,
            pages: 0,
            held: 0,
            peak: 0,
            output: 0,
        };
        let row_bytes = self.limits.key_bytes.saturating_mul(6).saturating_add(256);
        let supplier_window = supplier.rows.min(
            supplier
                .result_bytes
                .saturating_sub(64)
                .checked_div(row_bytes)
                .unwrap_or(0)
                .max(1),
        );
        let runs = self.range_runs(source, supplier_window, &mut meter)?;
        let page_settings = settings(self);

        for run in runs {
            meter.check()?;
            if run.pages == 0 {
                continue;
            }
            let mut search = Vec::with_capacity(bounds.len().saturating_mul(2));
            for (lo, hi) in bounds {
                search.push(
                    lo.to_rust_string().map_err(|_| {
                        meter.error("original kept multi-prefix bound is not UTF-8")
                    })?,
                );
                search.push(
                    hi.to_rust_string().map_err(|_| {
                        meter.error("original kept multi-prefix bound is not UTF-8")
                    })?,
                );
            }
            let mut found = Vec::with_capacity(search.len());
            for chunk in search.chunks(64) {
                found.extend(batch::seek_pages(
                    source, run.number, run.pages, chunk, &mut meter,
                )?);
            }
            if found.len() != bounds.len().saturating_mul(2) {
                return Err(meter.error("original kept multi-prefix seeks incomplete"));
            }
            let mut selected_pages = BTreeSet::new();
            for at in 0..bounds.len() {
                let lower = found[at * 2].unwrap_or(0);
                let Some(upper) = found[at * 2 + 1] else {
                    continue;
                };
                if lower > upper {
                    continue;
                }
                let count = usize::try_from(upper - lower + 1).unwrap_or(usize::MAX);
                if count > range.limits.pages.saturating_sub(range.pages) {
                    return Err(
                        meter.budget_error("original kept multi-prefix page budget exhausted")
                    );
                }
                for page in lower..=upper {
                    selected_pages.insert(page);
                }
            }
            if selected_pages.len() > range.limits.pages.saturating_sub(range.pages) {
                return Err(meter.budget_error("original kept multi-prefix page budget exhausted"));
            }
            let selected_pages = selected_pages.into_iter().collect::<Vec<_>>();
            let mut offset = 0;
            let mut previous_page = None;
            let mut previous_last: Option<String> = None;
            while offset < selected_pages.len() {
                meter.check()?;
                let start = selected_pages[offset];
                let mut desired = 1;
                while desired < 8
                    && offset + desired < selected_pages.len()
                    && selected_pages[offset + desired] == start + desired as i64
                {
                    desired += 1;
                }
                let remaining_pages = range.limits.pages.saturating_sub(range.pages);
                let remaining_rows = meter
                    .limits
                    .rows
                    .saturating_sub(meter.work.rows_returned as usize);
                let remaining_source = meter
                    .limits
                    .source_bytes
                    .saturating_sub(meter.work.source_bytes as usize);
                let held_room = range.limits.held_bytes.saturating_sub(range.held);
                if remaining_pages == 0 || remaining_rows == 0 || remaining_source == 0 {
                    return Err(
                        meter.budget_error("original kept multi-prefix source allowance exhausted")
                    );
                }
                let held_unit = self
                    .limits
                    .page_bytes
                    .saturating_mul(2)
                    .saturating_add(row_bytes);
                let source_unit = self.limits.page_bytes.saturating_add(row_bytes);
                let count = desired
                    .min(remaining_pages)
                    .min(remaining_rows)
                    .min((held_room / held_unit.max(1)).max(1))
                    .min((remaining_source / source_unit.max(1)).max(1));
                let pages = batch::fetch_pages(
                    source,
                    run.number,
                    start,
                    run.pages,
                    false,
                    count,
                    false,
                    self.limits.page_bytes,
                    &mut meter,
                )?;
                if pages.is_empty() || pages[0].page != start {
                    return Err(meter.error("original kept multi-prefix page missing"));
                }
                range.pages = range.pages.saturating_add(pages.len());
                meter.work.page_bodies = meter.work.page_bodies.saturating_add(pages.len() as u64);
                for raw_page in pages {
                    range.held = range
                        .held
                        .checked_add(raw_page.held_bytes)
                        .ok_or_else(|| meter.budget_error("original kept held bytes overflow"))?;
                    range.peak = range.peak.max(range.held);
                    if range.held > range.limits.held_bytes {
                        return Err(meter.budget_error(
                            "original kept multi-prefix held page budget exhausted",
                        ));
                    }
                    let page_number = raw_page.page;
                    if raw_page.cells.len() != 5 {
                        return Err(meter.error("original kept multi-prefix page row invalid"));
                    }
                    let first = meter.key(&raw_page.cells[1])?;
                    let length = meter.integer(&raw_page.cells[2])?;
                    if length < 0 || length as usize > self.limits.page_bytes {
                        return Err(
                            meter.budget_error("original kept multi-prefix page exceeds bound")
                        );
                    }
                    let raw = meter.text(&raw_page.cells[3])?;
                    if (raw_page.full_body && raw.len() != length as usize)
                        || raw.len() > length as usize
                    {
                        return Err(meter.error("original kept multi-prefix page length differs"));
                    }
                    let page = kept_runs::packed_page_text(raw, &page_settings).map_err(|_| {
                        meter.error("original kept multi-prefix page corrupt or unsupported")
                    })?;
                    if page.is_empty() {
                        return Err(meter.error("original kept multi-prefix page is empty"));
                    }
                    let page_first = page
                        .key(0)
                        .map_err(|_| meter.error("original kept multi-prefix boundary key invalid"))?;
                    let page_last = page
                        .key(page.len() - 1)
                        .map_err(|_| meter.error("original kept multi-prefix boundary key invalid"))?;
                    if page_first != first
                        || order(&page_last, &run.last) == Ordering::Greater
                        || (page_number + 1 == run.pages && page_last != run.last)
                    {
                        return Err(meter.error("original kept multi-prefix page boundary keys disagree"));
                    }
                    if previous_page.is_some_and(|old| old + 1 == page_number)
                        && previous_last
                            .as_ref()
                            .is_some_and(|old| order(&page_first, old) != Ordering::Greater)
                    {
                        return Err(meter
                            .error("original kept multi-prefix adjacent pages are not ordered"));
                    }
                    previous_page = Some(page_number);
                    previous_last = Some(page_last);
                    let head_bytes = page.resident_bytes();
                    range.held = range
                        .held
                        .checked_add(head_bytes)
                        .ok_or_else(|| meter.budget_error("original kept held bytes overflow"))?;
                    range.peak = range.peak.max(range.held);
                    if range.held > range.limits.held_bytes {
                        return Err(meter.budget_error(
                            "original kept multi-prefix held page budget exhausted",
                        ));
                    }
                    for key_index in 0..page.len() {
                        meter.check()?;
                        let key = page
                            .key(key_index)
                            .map_err(|_| meter.error("original kept multi-prefix key invalid"))?;
                        for (prefix, (lo, hi)) in bounds.iter().enumerate() {
                            if compare(&key, lo) == Ordering::Less
                                || compare(&key, hi) != Ordering::Less
                                || !seen[prefix].insert(key.clone())
                            {
                                continue;
                            }
                            range.examined = range.examined.saturating_add(1);
                            if range.examined > range.limits.entries {
                                return Err(meter.budget_error(
                                    "original kept multi-prefix entry budget exhausted",
                                ));
                            }
                            if page.is_tombstone(key_index).map_err(|_| {
                                meter.error("original kept multi-prefix deletion invalid")
                            })? {
                                continue;
                            }
                            if groups[prefix].len() >= limit_per_prefix {
                                return Err(meter.budget_error(
                                    "original kept multi-prefix result limit exhausted",
                                ));
                            }
                            range.output =
                                range.output.checked_add(key.len()).ok_or_else(|| {
                                    meter.budget_error("original kept output overflow")
                                })?;
                            if range.output > range.limits.output_bytes {
                                return Err(meter.budget_error(
                                    "original kept multi-prefix output budget exhausted",
                                ));
                            }
                            groups[prefix].push(Item {
                                key: key.clone(),
                                value: None,
                            });
                        }
                    }
                    range.held = range.held.saturating_sub(head_bytes);
                    range.held = range.held.saturating_sub(raw_page.held_bytes);
                    drop(page);
                }
                offset += count;
            }
        }
        for group in &mut groups {
            group.sort_by(|left, right| order(&left.key, &right.key));
        }
        meter.query(source, "SELECT 1", &[])?;
        meter.check()?;
        Ok(PrefixesPage {
            groups,
            work: meter.snapshot_work(),
            entries_examined: range.examined,
            held_peak_bytes: range.peak,
            output_bytes: range.output,
        })
    }

    fn range_finish<S: BoundedRecordSql + ?Sized>(
        &self,
        source: &mut S,
        items: Vec<Item>,
        next: Option<Cursor>,
        complete: bool,
        range: &RangeMeter,
        meter: &mut Meter<'_>,
    ) -> super::Result<Page> {
        meter.query(source, "SELECT 1", &[])?;
        meter.check()?;
        Ok(Page {
            items,
            next,
            complete,
            work: meter.snapshot_work(),
            entries_examined: range.examined,
            held_peak_bytes: range.peak,
            output_bytes: range.output,
        })
    }
    fn range_runs<S: BoundedRecordSql + ?Sized>(
        &self,
        source: &mut S,
        supplier_rows: usize,
        meter: &mut Meter<'_>,
    ) -> super::Result<Vec<Run>> {
        let schema = meter.query(source, "PRAGMA table_info(record_keys_runs)", &[])?;
        let mut names = HashSet::new();
        for row in &schema.rows {
            let name = row
                .get(1)
                .ok_or_else(|| meter.error("original kept range catalogue schema refused"))?;
            names.insert(meter.text(name)?.to_owned());
        }
        if schema.rows.len() > 64
            || !["run", "age", "pages", "last"]
                .iter()
                .all(|name| names.contains(*name))
        {
            return Err(meter.error("original kept range catalogue schema unsupported"));
        }
        let format = if names.contains("page_format") {
            "COALESCE(page_format,0)"
        } else {
            "0"
        };
        let layout = if names.contains("page_layout") {
            "COALESCE(page_layout,0)"
        } else {
            "0"
        };
        let mut after = None;
        let mut runs = Vec::new();
        let mut seen = HashSet::new();
        loop {
            let window = 64usize.min(supplier_rows).min(
                meter
                    .limits
                    .rows
                    .saturating_sub(meter.work.rows_returned as usize),
            );
            if window == 0 {
                return Err(
                    meter.budget_error("original kept range catalogue row budget exhausted")
                );
            }
            let predicate = if after.is_some() {
                " WHERE age<? OR (age=? AND run<?)"
            } else {
                ""
            };
            let sql=format!("SELECT run,age,pages,CASE WHEN length(CAST(last AS BLOB))<=? THEN last END AS last,{format} AS format,{layout} AS layout FROM record_keys_runs{predicate} ORDER BY age DESC,run DESC LIMIT ?");
            let mut params = vec![Value::Integer((self.limits.key_bytes * 6 + 2) as i64)];
            if let Some((age, run)) = after {
                params.extend([
                    Value::Integer(age),
                    Value::Integer(age),
                    Value::Integer(run),
                ])
            }
            params.push(Value::Integer(window as i64));
            let rows = meter.query(source, &sql, &params)?;
            for row in &rows.rows {
                if runs.len() >= self.limits.runs {
                    return Err(meter.budget_error("original kept range run budget exhausted"));
                }
                if row.len() != 6 {
                    return Err(meter.error("original kept range catalogue row refused"));
                }
                let number = meter.integer(&row[0])?;
                let age = meter.integer(&row[1])?;
                let pages = meter.integer(&row[2])?;
                let format = meter.integer(&row[4])?;
                let layout = meter.integer(&row[5])?;
                if number < 0
                    || age < 0
                    || pages < 0
                    || pages as usize > self.limits.pages_per_run
                    || !seen.insert(number)
                {
                    return Err(meter.error("original kept range run geometry refused"));
                }
                if format != 0 || ![0, 1, 2].contains(&layout) {
                    return Err(meter.error("original kept range format unsupported"));
                }
                after = Some((age, number));
                let last = if pages > 0 {
                    meter.key(&row[3])?
                } else {
                    String::new()
                };
                runs.push(Run {
                    number,
                    age,
                    pages,
                    last,
                });
                meter.work.runs_examined += 1;
            }
            if rows.rows.len() < window {
                break;
            }
        }
        Ok(runs)
    }
    fn range_seek_units<S: BoundedRecordSql + ?Sized>(
        &self,
        source: &mut S,
        run: &Run,
        bound: &JsString,
        meter: &mut Meter<'_>,
    ) -> super::Result<Option<i64>> {
        let (mut lo, mut hi) = (0, run.pages);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let rows = meter.query(
                source,
                &format!(
                    "SELECT first FROM record_keys_run_{} WHERE page=?",
                    run.number
                ),
                &[Value::Integer(mid)],
            )?;
            if rows.rows.len() != 1 || rows.rows[0].len() != 1 {
                return Err(meter.error("original kept range seek boundary key missing"));
            }
            let key = meter.key(&rows.rows[0][0])?;
            if compare(&key, bound) != Ordering::Greater {
                lo = mid + 1
            } else {
                hi = mid
            }
        }
        Ok((lo > 0).then_some(lo - 1))
    }
    fn range_load<S: BoundedRecordSql + ?Sized>(
        &self,
        source: &mut S,
        lane: &mut Lane,
        prior: Option<String>,
        range: &mut RangeMeter,
        meter: &mut Meter<'_>,
        reverse: bool,
        full_body: bool,
        lookahead: bool,
    ) -> super::Result<()> {
        if let Some(old) = lane.head.take() {
            range.held = range.held.saturating_sub(old.resident_bytes());
        }
        let use_queued = lane
            .pending
            .front()
            .is_some_and(|page| page.page == lane.page && (!full_body || page.full_body));
        if !use_queued {
            if !full_body && !lane.pending.is_empty() {
                return Err(meter.error("original kept range batch page order changed"));
            }
            let remaining_pages = range.limits.pages.saturating_sub(range.pages);
            if remaining_pages == 0 {
                return Err(meter.budget_error("original kept range page budget exhausted"));
            }
            let remaining_rows = meter
                .limits
                .rows
                .saturating_sub(meter.work.rows_returned as usize);
            let remaining_source = meter
                .limits
                .source_bytes
                .saturating_sub(meter.work.source_bytes as usize);
            let held_room = range.limits.held_bytes.saturating_sub(range.held);
            if remaining_rows == 0 || remaining_source == 0 || held_room == 0 {
                return Err(meter.budget_error("original kept range batch budget exhausted"));
            }
            let physical_pages = if reverse {
                (lane.page + 1) as usize
            } else {
                (lane.run.pages - lane.page) as usize
            };
            // Reserve room for the raw window and the decoded active page.
            // A small bound may still admit one actual small page.
            let row_overhead = self.limits.key_bytes.saturating_mul(6).saturating_add(256);
            let held_unit = self
                .limits
                .page_bytes
                .saturating_mul(2)
                .saturating_add(row_overhead);
            let source_unit = self.limits.page_bytes.saturating_add(row_overhead);
            // Initialize one page per run; merge demand determines which lanes
            // advance. Once a lane advances, forward reads retain their bounded
            // adjacent-page window. Reverse and full-body reads remain one page.
            let count = if full_body || reverse || !lookahead { 1 } else { 8 }
                .min(remaining_pages)
                .min(remaining_rows)
                .min(physical_pages)
                .min((held_room / held_unit.max(1)).max(1))
                .min((remaining_source / source_unit.max(1)).max(1));
            if count == 0 {
                return Err(meter.budget_error("original kept range batch budget exhausted"));
            }
            let fetched = batch::fetch_pages(
                source,
                lane.run.number,
                lane.page,
                lane.run.pages,
                reverse,
                count,
                full_body,
                self.limits.page_bytes,
                meter,
            )?;
            if fetched.is_empty() || fetched[0].page != lane.page {
                return Err(meter.error("original kept range selected page missing"));
            }
            range.pages = range.pages.saturating_add(fetched.len());
            meter.work.page_bodies = meter.work.page_bodies.saturating_add(fetched.len() as u64);
            for page in fetched {
                range.held = range
                    .held
                    .checked_add(page.held_bytes)
                    .ok_or_else(|| meter.budget_error("original kept range held byte overflow"))?;
                range.peak = range.peak.max(range.held);
                if range.held > range.limits.held_bytes {
                    return Err(
                        meter.budget_error("original kept range held page budget exhausted")
                    );
                }
                if full_body {
                    lane.pending.push_front(page);
                } else {
                    lane.pending.push_back(page);
                }
            }
        }
        let page = lane
            .pending
            .pop_front()
            .ok_or_else(|| meter.error("original kept range selected page missing"))?;
        if page.page != lane.page || page.cells.len() != 5 {
            return Err(meter.error("original kept range selected page changed"));
        }
        let first = meter.key(&page.cells[1])?;
        let length = meter.integer(&page.cells[2])?;
        if length < 0 || length as usize > self.limits.page_bytes {
            return Err(meter.budget_error("original kept range selected page exceeds bound"));
        }
        let raw = meter.text(&page.cells[3])?;
        lane.full_body = page.full_body || meter.integer(&page.cells[4])? == 1;
        if (lane.full_body && raw.len() != length as usize) || raw.len() > length as usize {
            return Err(meter.error("original kept range page length differs"));
        }
        let start = Instant::now();
        let head = kept_runs::packed_page_text(raw, &settings(self));
        meter.work.page_decode_us = meter
            .work
            .page_decode_us
            .saturating_add(start.elapsed().as_micros().min(u64::MAX as u128) as u64);
        let head = head
            .map_err(|_| meter.error("original kept range selected page corrupt or unsupported"))?;
        if head.len() == 0 {
            return Err(meter.error("original kept range page is empty"));
        }
        let got_first = head
            .key(0)
            .map_err(|_| meter.error("original kept range page first refused"))?;
        let got_last = head
            .key(head.len() - 1)
            .map_err(|_| meter.error("original kept range page last refused"))?;
        if got_first != first
            || order(&got_last, &lane.run.last) == Ordering::Greater
            || (lane.page + 1 == lane.run.pages && got_last != lane.run.last)
        {
            return Err(meter.error("original kept range page boundary keys disagree"));
        }
        if let Some(prior) = prior {
            if if reverse {
                order(&got_last, &prior) != Ordering::Less
            } else {
                order(&got_first, &prior) != Ordering::Greater
            } {
                return Err(meter.error("original kept range adjacent pages are not ordered"));
            }
        }
        range.held = range
            .held
            .checked_add(head.resident_bytes())
            .ok_or_else(|| meter.budget_error("original kept range held byte overflow"))?;
        range.peak = range.peak.max(range.held);
        if range.held > range.limits.held_bytes {
            return Err(meter.budget_error("original kept range held page budget exhausted"));
        }
        range.held = range.held.saturating_sub(page.held_bytes);
        lane.index = Some(if reverse { head.len() - 1 } else { 0 });
        lane.head = Some(head);
        meter.check()
    }
    fn range_settle<S: BoundedRecordSql + ?Sized>(
        &self,
        source: &mut S,
        lane: &mut Lane,
        scope: &Scope,
        cursor: Option<&Cursor>,
        range: &mut RangeMeter,
        meter: &mut Meter<'_>,
    ) -> super::Result<()> {
        loop {
            meter.check()?;
            if let (Some(head), Some(index)) = (&lane.head, lane.index) {
                let key = head
                    .key(index)
                    .map_err(|_| meter.error("original kept range head refused"))?;
                let outside = if scope.reverse {
                    compare(&key, &scope.lo) == Ordering::Less
                } else {
                    compare(&key, &scope.hi) != Ordering::Less
                };
                if outside {
                    if let Some(old) = lane.head.take() {
                        range.held = range.held.saturating_sub(old.resident_bytes())
                    }
                    release_pending(lane, range);
                    lane.index = None;
                    return Ok(());
                }
                let in_range = compare(&key, &scope.lo) != Ordering::Less
                    && compare(&key, &scope.hi) == Ordering::Less;
                let past = cursor.is_none_or(|c| {
                    if scope.reverse {
                        order(&key, &c.last) == Ordering::Less
                    } else {
                        order(&key, &c.last) == Ordering::Greater
                    }
                });
                if in_range && past {
                    return Ok(());
                }
                lane.index = if scope.reverse {
                    index.checked_sub(1)
                } else {
                    (index + 1 < head.len()).then_some(index + 1)
                };
                continue;
            }
            let Some(head) = &lane.head else {
                release_pending(lane, range);
                return Ok(());
            };
            let prior = head
                .key(if scope.reverse { 0 } else { head.len() - 1 })
                .map_err(|_| meter.error("original kept range boundary refused"))?;
            if scope.reverse {
                if lane.page == 0 {
                    if let Some(old) = lane.head.take() {
                        range.held = range.held.saturating_sub(old.resident_bytes())
                    }
                    release_pending(lane, range);
                    return Ok(());
                }
                lane.page -= 1;
            } else {
                if lane.page + 1 >= lane.run.pages {
                    if let Some(old) = lane.head.take() {
                        range.held = range.held.saturating_sub(old.resident_bytes())
                    }
                    release_pending(lane, range);
                    return Ok(());
                }
                lane.page += 1;
            }
            self.range_load(
                source,
                lane,
                Some(prior),
                range,
                meter,
                scope.reverse,
                false,
                true,
            )?;
        }
    }
}
