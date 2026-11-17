//! Bounded reads of declared current record indexes from the canonical
//! record-log kept-run projection. Query bounds, carried-value decoding,
//! readiness and continuation identity are owned by `record_indexes` itself.

use super::{Cursor, Entry, FieldAccess, Indexes, Query, Readiness};
use crate::{
    import::SqlValue,
    kept_runs::ReadBudget,
    legacy_kept::{self, LegacyKept, PointBudget},
    record_source::{BoundedRecordSql, Parameter as SqlParam, QueryBudget},
};
use serde_json::Value;
use std::{fmt, time::{Duration, Instant}};

#[derive(Debug, Clone)]
pub enum Error { Source(crate::refusal_cause::Cause), Bounds(crate::refusal_cause::Cause), Invalid(crate::refusal_cause::Cause), NotReady(crate::refusal_cause::Cause) }
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { match self {
        Self::Source(cause) => cause,
        Self::Bounds(cause) => cause,
        Self::Invalid(cause) => cause,
        Self::NotReady(cause) => cause,
    } }
}
crate::impl_caused!(Error);

impl PartialEq for Error { fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) } }
impl Eq for Error {}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Source(_) => "current record index source unavailable",
            Self::Bounds(_) => "current record index read exceeded its allowance",
            Self::Invalid(_) => "current record index request refused",
            Self::NotReady(_) => "current record index is not ready",
        })
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub struct Page {
    pub entries: Vec<Entry>,
    pub next: Option<Cursor>,
    pub complete: bool,
    pub serialized_bytes: usize,
    pub work: legacy_kept::Work,
}

/// Build the exact foundation cursor identity for a caller-owned screen token.
/// The token remains the caller's authority and integrity boundary.
pub fn cursor_for_key(
    indexes: &Indexes,
    kind: &str,
    name: &str,
    query: &Query,
    epoch: Option<&str>,
    text: &impl Fn(&Value) -> super::Result<String>,
    key: String,
) -> super::Result<Cursor> {
    let declaration = indexes.declared(kind, name)?;
    let (lo, hi) = indexes.bounds(declaration, query, text)?;
    let identity = super::query_identity(declaration, query, &lo, &hi, epoch)?;
    if super::cmp(&key, &lo).is_lt() || !super::cmp(&key, &hi).is_lt() {
        return Err(crate::cause!(super::Error::WrongCursor));
    }
    Ok(Cursor { key, query_identity: identity })
}

/// Query one declared index using the same `Query`, readiness, field-access,
/// key-text, and cursor rules as `Indexes::scan`. The caller must finish its
/// retained selected-source witness before disclosing the provisional result.
pub fn scan_current<S: BoundedRecordSql + ?Sized>(
    source: &mut S,
    kept: &LegacyKept,
    indexes: &Indexes,
    kind: &str,
    name: &str,
    query: &Query,
    epoch: Option<&str>,
    ready: &dyn Readiness,
    text: &impl Fn(&Value) -> super::Result<String>,
    fields: &mut dyn FieldAccess,
    budget: ReadBudget,
) -> super::Result<Page> {
    let declaration = indexes.declared(kind, name)?;
    let signature = indexes.signature(kind, name)?;
    if !ready.assert_ready(declaration, &signature) { return Err(crate::cause!(super::Error::NotReady)); }
    let (lo_text, hi_text) = indexes.bounds(declaration, query, text)?;
    let identity = super::query_identity(declaration, query, &lo_text, &hi_text, epoch)?;
    if let Some(cursor) = &query.cursor {
        if cursor.query_identity != identity
            || super::cmp(&cursor.key, &lo_text).is_lt()
            || !super::cmp(&cursor.key, &hi_text).is_lt()
        { return Err(crate::cause!(super::Error::WrongCursor)); }
    }
    if budget.output_bytes < 2 || budget.entries == 0 || budget.rows == 0
        || budget.source_bytes == 0 || budget.elapsed.is_zero()
        || query.limit > budget.entries
    {
        return Err(crate::cause!(super::Error::Bounds));
    }
    let deadline = Instant::now().checked_add(budget.elapsed).ok_or(crate::cause!(super::Error::Bounds))?;
    let point_budget = PointBudget {
        statements: budget.rows.max(1),
        rows: budget.rows,
        source_bytes: budget.source_bytes,
        deadline,
    };
    assert_record_log_engine(source, deadline)?;

    let lo = crate::ecma_json::JsString::from(lo_text.as_str());
    let hi = crate::ecma_json::JsString::from(hi_text.as_str());
    let keys_only = !query.carried;
    if !super::cmp(&lo_text, &hi_text).is_lt() {
        return Ok(Page { entries: Vec::new(), next: None, complete: true, serialized_bytes: 2, work: Default::default() });
    }
    let cursor = query.cursor.as_ref().map(|c| {
        legacy_kept::range::cursor_after(&lo, &hi, query.reverse, keys_only, c.key.clone())
    });
    let range = kept.range_with_budget(
        source,
        legacy_kept::range::Request {
            lo: &lo,
            hi: &hi,
            reverse: query.reverse,
            keys_only,
            limit: query.limit,
            cursor: cursor.as_ref(),
        },
        legacy_kept::range::RangeLimits {
            entries: budget.entries,
            pages: 128,
            held_bytes: 4 * 1024 * 1024,
            output_bytes: budget.output_bytes,
        },
        point_budget,
    ).map_err(|e| if e.budget_exhausted { super::Error::Bounds(e.cause()) } else { super::Error::Corrupt(e.cause()) })?;

    let mut entries = Vec::with_capacity(range.items.len());
    let mut serialized_bytes = 2usize;
    let mut truncated = false;
    for item in &range.items {
        let stored = match item.value.as_deref() {
            Some(value) => serde_json::from_str(value).map_err(|error| crate::carry_cause!(super::Error::Corrupt, error))?,
            None if !query.carried => Value::Null,
            None => return Err(crate::cause!(super::Error::Corrupt)),
        };
        let entry = super::decode_entry(declaration, &item.key, &stored, query.carried, epoch, fields)?;
        let size = serde_json::to_vec(&entry).map_err(|error| crate::carry_cause!(super::Error::Corrupt, error))?.len()
            + usize::from(!entries.is_empty());
        if size > budget.output_bytes.saturating_sub(serialized_bytes) {
            if entries.is_empty() { return Err(crate::cause!(super::Error::Bounds)); }
            truncated = true;
            break;
        }
        serialized_bytes += size;
        entries.push(entry);
    }
    let complete = range.complete && !truncated;
    let next = if complete { None } else {
        let key = range.items.iter().take(entries.len()).last().map(|item| item.key.clone()).ok_or(crate::cause!(super::Error::Corrupt))?;
        Some(Cursor { key, query_identity: identity })
    };
    Ok(Page { entries, next, complete, serialized_bytes, work: range.work })
}

fn assert_record_log_engine<S: BoundedRecordSql + ?Sized>(source: &mut S, deadline: Instant) -> super::Result<()> {
    let rows = source.query_reusable_with_budget(
        "SELECT value FROM record_keys_meta WHERE key=? LIMIT 1",
        &[SqlParam::Text("engine".into())],
        QueryBudget { rows: 1, source_bytes: 4096, deadline },
    ).map_err(|error| crate::carry_cause!(super::Error::Corrupt, error))?;
    let [row] = rows.rows.as_slice() else { return Err(crate::cause!(super::Error::NotReady)) };
    let [SqlValue::Text(value)] = row.as_slice() else { return Err(crate::cause!(super::Error::Corrupt)) };
    let value = std::str::from_utf8(value).map_err(|error| crate::carry_cause!(super::Error::Corrupt, error))?;
    if serde_json::from_str::<String>(value).ok().as_deref() != Some("record-log") {
        return Err(crate::cause!(super::Error::NotReady));
    }
    Ok(())
}

/// Source limits for a bounded indexed collection read.
pub fn default_read_budget(elapsed: Duration) -> Result<ReadBudget> {
    if elapsed.is_zero() || elapsed > Duration::from_secs(5) { return Err(crate::cause!(Error::Invalid)); }
    Ok(ReadBudget { rows: 2048, source_bytes: 8 * 1024 * 1024, entries: 4096, output_bytes: 1024 * 1024, elapsed })
}
