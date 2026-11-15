//! Bounded reads of adjacent pages from one already selected kept run.
//!
//! This helper only transports the original page cells. The caller retains
//! ownership of boundary key checks, packed-page decoding, winner selection, and all
//! held/output accounting.

use super::{order, BoundedRecordSql, Meter, SqlValue};
use rusqlite::types::Value;
use std::collections::BTreeMap;
use std::mem::size_of;
use zeroize::Zeroize;

/// Beyond this size, one retained boundary key scan is no longer a useful substitute
/// for indexed halving. The caller also compares the actual row allowance and
/// expected halving rows before choosing this path; the source enforces bytes.
pub(super) const SMALL_RUN_BOUNDARY_KEY_PAGES: i64 = 512;

/// Read a small run's complete boundary key set once, then locate every selected
/// key in memory. This shares a page boundary key across all selected keys and
/// preserves the exact UTF-16 order used by the point reader.
pub(super) fn seek_small_run<S: BoundedRecordSql + ?Sized>(
    source: &mut S,
    run: i64,
    pages: i64,
    keys: &[String],
    meter: &mut Meter<'_>,
) -> super::Result<Vec<Option<i64>>> {
    if run < 0 || pages <= 0 || pages > SMALL_RUN_BOUNDARY_KEY_PAGES || keys.is_empty() {
        return Err(meter.error("original kept small-run input refused"));
    }
    let count = usize::try_from(pages).map_err(|_| meter.error("original kept small-run pages invalid"))?;
    let remaining = meter.limits.rows.saturating_sub(meter.work.rows_returned as usize);
    if count > remaining {
        return Err(meter.budget_error("original kept small-run row budget exhausted"));
    }
    let sql = format!("SELECT page,CASE WHEN length(CAST(first AS BLOB))<=?1 THEN first END FROM record_keys_run_{run} WHERE page>=0 ORDER BY page LIMIT ?2");
    let max_key = meter.limits.key_bytes.saturating_mul(6).saturating_add(2);
    let params = [
        Value::Integer(i64::try_from(max_key).map_err(|_| meter.error("original kept small-run key bound invalid"))?),
        Value::Integer(pages),
    ];
    let mut result = meter.query(source, &sql, &params)?;
    let rows = RawRows(std::mem::take(&mut result.rows));
    if rows.0.len() != count {
        return Err(meter.error("original kept small-run boundary key count changed"));
    }
    let mut boundary_keys: Vec<String> = Vec::with_capacity(count);
    for (at, row) in rows.0.iter().enumerate() {
        if row.len() != 2 || meter.integer(&row[0])? != at as i64 {
            return Err(meter.error("original kept small-run page order invalid"));
        }
        let boundary_key = meter.key(&row[1])?;
        if boundary_keys.last().is_some_and(|prior| order(prior, &boundary_key) != std::cmp::Ordering::Less) {
            return Err(meter.error("original kept small-run boundary keys not ordered"));
        }
        boundary_keys.push(boundary_key);
    }
    let mut answers = Vec::with_capacity(keys.len());
    for key in keys {
        let insertion = boundary_keys.partition_point(|boundary_key| order(boundary_key, key) != std::cmp::Ordering::Greater);
        answers.push(insertion.checked_sub(1).map(|at| at as i64));
    }
    meter.check()?;
    Ok(answers)
}

struct RawCells(Vec<SqlValue>);
impl Drop for RawCells {
    fn drop(&mut self) {
        for cell in &mut self.0 {
            if let SqlValue::Text(bytes) | SqlValue::Blob(bytes) = cell {
                bytes.zeroize();
            }
        }
    }
}
struct RawRows(Vec<Vec<SqlValue>>);
impl Drop for RawRows {
    fn drop(&mut self) {
        for cells in &mut self.0 {
            for cell in cells {
                if let SqlValue::Text(bytes) | SqlValue::Blob(bytes) = cell {
                    bytes.zeroize();
                }
            }
        }
    }
}

/// A raw page row in the same shape used by `range_load`.
pub(super) struct RawPage {
    pub page: i64,
    pub cells: Vec<SqlValue>,
    /// A bounded estimate of retained row/cell storage, including payloads.
    pub held_bytes: usize,
    /// True when the fetch requested the complete body or the stored body is
    /// the legacy JSON-array representation, which is already complete.
    pub full_body: bool,
}
impl Drop for RawPage {
    fn drop(&mut self) {
        for cell in &mut self.cells {
            if let SqlValue::Text(bytes) | SqlValue::Blob(bytes) = cell {
                bytes.zeroize();
            }
        }
    }
}

/// Fetch a bounded window of pages from one validated nonnegative run.
///
/// `start` is inclusive in either direction. `page_count` is the validated
/// number of pages in the run. The only dynamic SQL identifier is derived from
/// the nonnegative run number; all values remain parameters. The query goes
/// through `Meter::query`, preserving the source witness and physical work
/// accounting.
pub(super) fn fetch_pages<S: BoundedRecordSql + ?Sized>(
    source: &mut S,
    run: i64,
    start: i64,
    page_count: i64,
    reverse: bool,
    count: usize,
    full_body: bool,
    page_bytes: usize,
    meter: &mut Meter<'_>,
) -> super::Result<Vec<RawPage>> {
    if run < 0
        || page_count <= 0
        || start < 0
        || start >= page_count
        || count == 0
        || page_bytes == 0
        || page_bytes > meter.limits.page_bytes
    {
        return Err(meter.error("original kept page batch input refused"));
    }
    meter.check()?;
    let remaining_rows = meter
        .limits
        .rows
        .saturating_sub(meter.work.rows_returned as usize);
    let in_run = if reverse {
        usize::try_from(start.saturating_add(1)).unwrap_or(usize::MAX)
    } else {
        usize::try_from(page_count.saturating_sub(start)).unwrap_or(usize::MAX)
    };
    let count = count.min(remaining_rows).min(in_run);
    if count == 0 {
        return Err(meter.budget_error("original kept page batch row budget exhausted"));
    }

    let projection = if full_body {
        "body"
    } else {
        "CASE WHEN substr(body,1,1)='[' THEN body ELSE substr(body,1,instr(body,?2)) END"
    };
    let (predicate, order) = if reverse {
        ("<=", "DESC")
    } else {
        (">=", "ASC")
    };
    let sql = format!(
        "SELECT page,first,length(CAST(body AS BLOB)) AS bytes,CASE WHEN length(CAST(body AS BLOB))<=?1 THEN {projection} END AS body,CASE WHEN substr(body,1,1)='[' THEN 1 ELSE 0 END AS legacy FROM record_keys_run_{run} WHERE page{predicate}?3 ORDER BY page {order} LIMIT ?4"
    );
    let mut params = vec![Value::Integer(i64::try_from(page_bytes).map_err(|_| {
        meter.budget_error("original kept page batch body bound overflow")
    })?)];
    if !full_body {
        params.push(Value::Text("\n".into()));
    }
    params.extend([
        Value::Integer(start),
        Value::Integer(
            i64::try_from(count)
                .map_err(|_| meter.budget_error("original kept page batch count overflow"))?,
        ),
    ]);

    // Use positional parameters matching the selected body projection.
    let sql = if full_body {
        sql.replace("?3", "?2").replace("?4", "?3")
    } else {
        sql
    };
    let mut rows = RawRows(meter.query(source, &sql, &params)?.rows);
    if rows.0.len() != count {
        return Err(meter.error("original kept page batch is incomplete"));
    }

    let mut output = Vec::with_capacity(count);
    for at in 0..rows.0.len() {
        let mut guarded = RawCells(std::mem::take(&mut rows.0[at]));
        let cells = &guarded.0;
        if cells.len() != 5 {
            return Err(meter.error("original kept page batch row invalid"));
        }
        let page = match cells.first() {
            Some(SqlValue::Integer(page)) => *page,
            _ => return Err(meter.error("original kept page batch number invalid")),
        };
        let offset = i64::try_from(at)
            .map_err(|_| meter.budget_error("original kept page batch offset overflow"))?;
        let expected = if reverse {
            start.checked_sub(offset)
        } else {
            start.checked_add(offset)
        }
        .ok_or_else(|| meter.error("original kept page batch number overflow"))?;
        if page != expected {
            return Err(meter.error("original kept page batch order invalid"));
        }
        let legacy = matches!(cells.get(4), Some(SqlValue::Integer(1)));
        let held_bytes = cells.iter().try_fold(
            size_of::<Vec<SqlValue>>().saturating_add(cells.len() * size_of::<SqlValue>()),
            |total, cell| {
                total.checked_add(match cell {
                    SqlValue::Text(bytes) | SqlValue::Blob(bytes) => bytes.len(),
                    _ => size_of::<SqlValue>(),
                })
            },
        );
        let Some(held_bytes) = held_bytes else {
            return Err(meter.budget_error("original kept page batch held size overflow"));
        };
        let cells = std::mem::take(&mut guarded.0);
        output.push(RawPage {
            page,
            cells,
            held_bytes,
            full_body: full_body || legacy,
        });
    }
    meter.check()?;
    Ok(output)
}

/// Find the last page boundary key not greater than each key. At each halving depth,
/// fetch each missing page boundary key once through its indexed page number. Compare
/// decoded boundary keys in Rust with the exact UTF-16 order; SQLite never re-parses
/// the same JSON boundary key for every candidate and recursive step.
pub(super) fn seek_pages<S: BoundedRecordSql + ?Sized>(
    source: &mut S,
    run: i64,
    pages: i64,
    keys: &[String],
    meter: &mut Meter<'_>,
) -> super::Result<Vec<Option<i64>>> {
    if run < 0
        || pages <= 0
        || usize::try_from(pages).unwrap_or(usize::MAX) > meter.limits.pages_per_run
        || keys.is_empty()
        || keys.len() > 255
        || keys.iter().any(|key| key.len() > meter.limits.key_bytes)
    {
        return Err(meter.error("original kept batched boundary key input refused"));
    }
    meter.check()?;
    let supplier = source
        .read_limits()
        .ok_or_else(|| meter.error("original kept batched boundary key supplier ceilings unavailable"))?
        .clone();
    supplier
        .validate()
        .map_err(|_| meter.error("original kept batched boundary key supplier ceilings refused"))?;
    let rows_per_key = usize::try_from(pages.ilog2().saturating_add(1)).unwrap_or(usize::MAX);
    let row_bytes = meter.limits.key_bytes.saturating_mul(6).saturating_add(256);
    let table = format!("record_keys_run_{run}");
    let mut lo = vec![0_i64; keys.len()];
    let mut hi = vec![pages; keys.len()];
    let mut boundary_keys = BTreeMap::<i64, String>::new();
    for _ in 0..rows_per_key {
        meter.check()?;
        let mut missing = Vec::new();
        for at in 0..keys.len() {
            if lo[at] < hi[at] {
                let mid = lo[at] + (hi[at] - lo[at]) / 2;
                if !boundary_keys.contains_key(&mid) {
                    missing.push(mid);
                }
            }
        }
        missing.sort_unstable();
        missing.dedup();
        let mut consumed = 0;
        while consumed < missing.len() {
            let remaining_rows = meter.limits.rows.saturating_sub(meter.work.rows_returned as usize);
            let remaining_bytes = meter.limits.source_bytes.saturating_sub(meter.work.source_bytes as usize);
            let query_pages = remaining_rows.min(supplier.rows).min(255)
                .min(remaining_bytes.min(supplier.result_bytes) / row_bytes.max(1));
            if query_pages == 0 {
                return Err(meter.budget_error("original kept batched boundary key result budget exhausted"));
            }
            let end = missing.len().min(consumed.saturating_add(query_pages));
            let selected = &missing[consumed..end];
            let max_key = meter.limits.key_bytes.saturating_mul(6).saturating_add(2);
            let mut params = Vec::with_capacity(selected.len() + 1);
            params.push(Value::Integer(i64::try_from(max_key).map_err(|_| meter.error("original kept batched boundary key bound invalid"))?));
            for page in selected {
                params.push(Value::Integer(*page));
            }
            let placeholders = (2..=params.len()).map(|at| format!("?{at}")).collect::<Vec<_>>().join(",");
            let sql = format!("SELECT page,CASE WHEN length(CAST(first AS BLOB))<=?1 THEN first END FROM {table} WHERE page IN ({placeholders}) ORDER BY page");
            let rows = RawRows(meter.query(source, &sql, &params)?.rows);
            if rows.0.len() != selected.len() {
                return Err(meter.error("original kept batched boundary key page missing"));
            }
            for (expected, row) in selected.iter().zip(&rows.0) {
                if row.len() != 2 || meter.integer(&row[0])? != *expected {
                    return Err(meter.error("original kept batched boundary key page order invalid"));
                }
                boundary_keys.insert(*expected, meter.key(&row[1])?);
            }
            consumed = end;
        }
        let mut active = false;
        for at in 0..keys.len() {
            if lo[at] >= hi[at] {
                continue;
            }
            active = true;
            let mid = lo[at] + (hi[at] - lo[at]) / 2;
            let boundary_key = boundary_keys.get(&mid).ok_or_else(|| meter.error("original kept batched boundary key missing after read"))?;
            if order(boundary_key, &keys[at]) != std::cmp::Ordering::Greater {
                lo[at] = mid + 1;
            } else {
                hi[at] = mid;
            }
        }
        if !active {
            break;
        }
    }
    let mut results = Vec::with_capacity(keys.len());
    for (at, key) in keys.iter().enumerate() {
        if lo[at] != hi[at] {
            return Err(meter.error("original kept batched boundary key search did not finish"));
        }
        let found = lo[at] - 1;
        let here = (found >= 0).then(|| boundary_keys.get(&found)).flatten();
        let next = (found + 1 < pages).then(|| boundary_keys.get(&(found + 1))).flatten();
        if (found >= 0 && here.is_none()) || (found + 1 < pages && next.is_none())
            || here.is_some_and(|boundary_key| order(boundary_key, key) == std::cmp::Ordering::Greater)
            || next.is_some_and(|boundary_key| order(boundary_key, key) != std::cmp::Ordering::Greater)
        {
            return Err(meter.error("original kept batched boundary key bracket invalid"));
        }
        results.push((found >= 0).then_some(found));
    }
    meter.check()?;
    Ok(results)
}
