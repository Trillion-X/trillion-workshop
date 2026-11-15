// Purpose: Read one original tool-fact page through its completed current index.
// Invariants: supplied current snapshot/rights owner; no opening paths, writes, fill, history scan,
// alternate projection, JSON decoder, screen renderer or authorization fallback.
// Security: fixed main-table/index join, bounded queries/values/deadline, cancellation and redacted
// failure/Debug. Caller must finish its original snapshot and recheck fresh rights before disclosure.


use crate::{
    ecma_json::{self, Value as JsonValue},
    import::{ImportError, QueryRows, SqlValue},
    record_source::{BoundedRecordSql, QueryBudget},
};
use rusqlite::types::Value;
use std::{
    fmt,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

pub const MAX_PAGE_ITEMS: usize = 1000;
const PREFIX: &str = "tool:";
const END: &str = "tool;";
const MAX_CURSOR_UNITS: usize = 4096;
// LEFT JOIN retains dangling current pointers so corruption cannot silently
// remove a candidate. On the coherent original schema this is the same c->f
// seq join and page as workshopValuesPage; no historical version is consulted.
const PAGE_SQL: &str = "SELECT c.entity AS entity, c.seq AS current_seq, f.entity AS fact_entity, f.seq AS fact_seq, f.value AS value, EXISTS(SELECT 1 FROM main.workshop_facts newer WHERE newer.entity COLLATE BINARY=c.entity COLLATE BINARY AND newer.seq>c.seq LIMIT 1) AS has_newer FROM main.workshop_current c LEFT JOIN main.workshop_facts f ON f.seq=c.seq WHERE c.entity COLLATE BINARY > ?1 AND c.entity COLLATE BINARY < ?2 ORDER BY c.entity COLLATE BINARY LIMIT ?3";

#[derive(Clone)]
pub struct PageRequest {
    pub after: String,
    pub limit: usize,
}
impl fmt::Debug for PageRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WorkshopPageRequest")
            .field("limit", &self.limit)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Debug)]
pub struct Limits {
    pub statements: usize,
    pub rows: usize,
    pub source_bytes: usize,
    /// Aggregate normalized JSON bytes of returned values, not heap size.
    pub value_bytes: usize,
    pub elapsed: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            statements: 12,
            rows: 2048,
            source_bytes: 4 * 1024 * 1024,
            value_bytes: 16 * 1024 * 1024,
            elapsed: Duration::from_secs(2),
        }
    }
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Work {
    pub sql_statements: usize,
    pub rows_returned: usize,
    pub source_bytes: usize,
    pub value_bytes: usize,
    pub progress_callbacks: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    Invalid(crate::refusal_cause::Cause),
    Bounds(crate::refusal_cause::Cause),
    Pending(crate::refusal_cause::Cause),
    Schema(crate::refusal_cause::Cause),
    Source(crate::refusal_cause::Cause),
    Cancelled(crate::refusal_cause::Cause),
    Corrupt(crate::refusal_cause::Cause),
}
impl Kind {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Invalid(cause) => cause.clone(),
            Self::Bounds(cause) => cause.clone(),
            Self::Pending(cause) => cause.clone(),
            Self::Schema(cause) => cause.clone(),
            Self::Source(cause) => cause.clone(),
            Self::Cancelled(cause) => cause.clone(),
            Self::Corrupt(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Kind);

#[derive(Clone, Debug)]
pub struct Failure {
    pub cause: crate::refusal_cause::Cause,
    pub kind: Kind,
    pub work: Work,
}
impl Failure { pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { &self.cause } }
crate::impl_caused!(Failure);

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} cause={}", match self.kind {
            Kind::Invalid(_) => "Workshop page input is invalid",
            Kind::Bounds(_) => "Workshop page exceeds its bound",
            Kind::Pending(_) => "Original Workshop current index is not complete",
            Kind::Schema(_) => "Original Workshop current schema or indexed plan differs",
            Kind::Source(_) => "Selected Workshop source refused or changed",
            Kind::Cancelled(_) => "Workshop page was cancelled",
            Kind::Corrupt(_) => "Original Workshop current page is inconsistent",
        }, self.cause())
    }
}
impl std::error::Error for Failure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
pub struct Row {
    pub entity: String,
    pub value: JsonValue,
}
impl fmt::Debug for Row {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("WorkshopRow([redacted])")
    }
}
pub struct Page {
    pub rows: Vec<Row>,
    pub next: Option<String>,
    pub work: Work,
}
impl fmt::Debug for Page {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WorkshopPage")
            .field("rows", &self.rows.len())
            .field("has_next", &self.next.is_some())
            .field("work", &self.work)
            .finish()
    }
}
struct Meter<'a> {
    limits: &'a Limits,
    started: Instant,
    cancel: &'a AtomicBool,
    work: Work,
}
impl Meter<'_> {
    fn check(&self) -> Result<(), Kind> {
        if self.cancel.load(Ordering::Acquire) {
            return Err(crate::cause!(Kind::Cancelled));
        }
        if self.started.elapsed() >= self.limits.elapsed
            || self.work.rows_returned > self.limits.rows
            || self.work.source_bytes > self.limits.source_bytes
            || self.work.value_bytes > self.limits.value_bytes
        {
            return Err(crate::cause!(Kind::Bounds));
        }
        Ok(())
    }
    fn query(
        &mut self,
        source: &mut impl BoundedRecordSql,
        sql: &str,
        params: &[Value],
    ) -> Result<QueryRows, Kind> {
        self.check()?;
        if self.work.sql_statements >= self.limits.statements
            || self.work.rows_returned >= self.limits.rows
            || self.work.source_bytes >= self.limits.source_bytes
        {
            return Err(crate::cause!(Kind::Bounds));
        }
        let budget = QueryBudget {
            rows: self.limits.rows - self.work.rows_returned,
            source_bytes: self.limits.source_bytes - self.work.source_bytes,
            deadline: self.started + self.limits.elapsed,
        };
        self.work.sql_statements += 1;
        let answer = source.query_with_budget(sql, params, budget);
        self.check()?;
        let answer = answer.map_err(|error| {
            let cause = error.cause();
            if matches!(error, ImportError::Budget(_, _)) {
                Kind::Bounds(cause)
            } else {
                Kind::Source(cause)
            }
        })?;
        self.work.rows_returned = self
            .work
            .rows_returned
            .checked_add(answer.rows.len())
            .ok_or(crate::cause!(Kind::Bounds))?;
        self.work.progress_callbacks = self
            .work
            .progress_callbacks
            .checked_add(answer.progress_callbacks)
            .ok_or(crate::cause!(Kind::Bounds))?;
        let mut bytes = answer.columns.iter().map(String::len).sum::<usize>();
        for cell in answer.rows.iter().flatten() {
            bytes = bytes
                .checked_add(match cell {
                    SqlValue::Text(v) | SqlValue::Blob(v) => v.len(),
                    _ => 8,
                })
                .ok_or(crate::cause!(Kind::Bounds))?;
        }
        self.work.source_bytes = self
            .work
            .source_bytes
            .checked_add(bytes)
            .ok_or(crate::cause!(Kind::Bounds))?;
        self.check()?;
        Ok(answer)
    }
}
fn text(value: &SqlValue) -> Result<&str, Kind> {
    if let SqlValue::Text(bytes) = value {
        std::str::from_utf8(bytes).map_err(|error| crate::carry_cause!(Kind::Corrupt, error))
    } else {
        Err(crate::cause!(Kind::Corrupt))
    }
}
fn columns(rows: &QueryRows, expected: &[&str]) -> Result<(), Kind> {
    if rows
        .columns
        .iter()
        .map(String::as_str)
        .eq(expected.iter().copied())
        && rows.rows.iter().all(|row| row.len() == expected.len())
    {
        Ok(())
    } else {
        Err(crate::cause!(Kind::Schema))
    }
}
fn codec_error(error: ecma_json::Error) -> Kind {
    let cause = error.cause();
    if matches!(error, ecma_json::Error::InvalidJson(_)) {
        Kind::Corrupt(cause)
    } else {
        Kind::Bounds(cause)
    }
}

/// Consume the actual selected readonly snapshot; this function grants no
/// authority and does not finalize its caller's snapshot. No partial page is
/// returned after failure. Original deleted/shipped filtering belongs to the
/// higher screen producer, so these source values and the raw cursor are intact.
pub fn tool_values_page(
    source: &mut impl BoundedRecordSql,
    request: &PageRequest,
    limits: &Limits,
    cancel: &AtomicBool,
) -> Result<Page, Failure> {
    let mut meter = Meter {
        limits,
        started: Instant::now(),
        cancel,
        work: Work::default(),
    };
    let result = (|| -> Result<(Vec<Row>, Option<String>), Kind> {
        if request.limit == 0
            || request.limit > MAX_PAGE_ITEMS
            || request.after.encode_utf16().count() > MAX_CURSOR_UNITS
        {
            return Err(crate::cause!(Kind::Invalid));
        }
        if limits.statements == 0
            || limits.statements > 64
            || limits.rows == 0
            || limits.rows > 4096
            || limits.source_bytes == 0
            || limits.source_bytes > ecma_json::HARD_BYTES
            || limits.value_bytes == 0
            || limits.value_bytes > ecma_json::HARD_BYTES
            || limits.elapsed.is_zero()
            || limits.elapsed > Duration::from_secs(30)
        {
            return Err(crate::cause!(Kind::Invalid));
        }
        meter.check()?;
        let schema=meter.query(source,"SELECT name,type FROM main.sqlite_schema WHERE name IN ('workshop_current','workshop_facts','workshop_current_filled') ORDER BY name",&[])?;
        columns(&schema, &["name", "type"])?;
        // A records store with none of the three tables never held old Trillion's saved tool facts: an account made by
        // `account create` here, whose tools are its installed Workshop rows. It has no saved tool, so its page is empty.
        // One or two of the three is a torn store and stays refused.
        if schema.rows.is_empty() {
            return Ok((Vec::new(), None));
        }
        if schema.rows.len() != 3
            || schema
                .rows
                .iter()
                .zip([
                    "workshop_current",
                    "workshop_current_filled",
                    "workshop_facts",
                ])
                .any(|(row, name)| text(&row[0]) != Ok(name) || text(&row[1]) != Ok("table"))
        {
            return Err(crate::cause!(Kind::Schema));
        }
        let ready_plan = meter.query(
            source,
            "EXPLAIN QUERY PLAN SELECT done FROM main.workshop_current_filled WHERE id=1 LIMIT 1",
            &[],
        )?;
        columns(&ready_plan, &["id", "parent", "notused", "detail"])?;
        if ready_plan.rows.len() != 1
            || !text(&ready_plan.rows[0][3])?
                .contains("workshop_current_filled USING INTEGER PRIMARY KEY")
        {
            return Err(crate::cause!(Kind::Schema));
        }
        let ready = meter.query(
            source,
            "SELECT done FROM main.workshop_current_filled WHERE id=1 LIMIT 1",
            &[],
        )?;
        columns(&ready, &["done"])?;
        match ready.rows.as_slice() {
            [] => return Err(crate::cause!(Kind::Pending)),
            [row] => match row[0] {
                SqlValue::Integer(1) => {}
                SqlValue::Integer(0) => return Err(crate::cause!(Kind::Pending)),
                _ => return Err(crate::cause!(Kind::Corrupt)),
            },
            _ => return Err(crate::cause!(Kind::Corrupt)),
        }
        // JavaScript compares the caller's cursor to the ASCII prefix by UTF-16
        // code units. SQL still owns original UTF-8/BINARY entity page ordering.
        let from = if !request.after.is_empty()
            && request
                .after
                .encode_utf16()
                .cmp(PREFIX.encode_utf16())
                .is_gt()
        {
            request.after.as_str()
        } else {
            PREFIX
        };
        let params = [
            Value::Text(from.into()),
            Value::Text(END.into()),
            Value::Integer((request.limit + 1) as i64),
        ];
        let plan = meter.query(source, &format!("EXPLAIN QUERY PLAN {PAGE_SQL}"), &params)?;
        columns(&plan, &["id", "parent", "notused", "detail"])?;
        let details = plan
            .rows
            .iter()
            .map(|row| text(&row[3]))
            .collect::<Result<Vec<_>, _>>()?;
        let indexed_current = details.iter().any(|row| {
            row.starts_with("SEARCH c ") && row.contains("entity>?") && row.contains("entity<?")
        });
        let point_fact = details.iter().any(|row| {
            row.starts_with("SEARCH f USING INTEGER PRIMARY KEY ") && row.contains("rowid=?")
        });
        let current_fact = details.iter().any(|row| {
            row.starts_with("SEARCH newer ") && row.contains("entity=?") && row.contains("seq>?")
        });
        if !indexed_current
            || !point_fact
            || !current_fact
            || details
                .iter()
                .any(|row| row.contains("SCAN ") || row.contains("TEMP B-TREE"))
        {
            return Err(crate::cause!(Kind::Schema));
        }
        let page = meter.query(source, PAGE_SQL, &params)?;
        columns(
            &page,
            &[
                "entity",
                "current_seq",
                "fact_entity",
                "fact_seq",
                "value",
                "has_newer",
            ],
        )?;
        if page.rows.len() > request.limit + 1 {
            return Err(crate::cause!(Kind::Corrupt));
        }
        let mut previous = from;
        for row in &page.rows {
            meter.check()?;
            let entity = text(&row[0])?;
            if entity.as_bytes() <= previous.as_bytes()
                || entity.as_bytes() >= END.as_bytes()
                || !entity.starts_with(PREFIX)
                || text(&row[2])? != entity
            {
                return Err(crate::cause!(Kind::Corrupt));
            }
            match (&row[1], &row[3]) {
                (SqlValue::Integer(a), SqlValue::Integer(b)) if a == b && *a > 0 => {}
                _ => return Err(crate::cause!(Kind::Corrupt)),
            }
            if !matches!(row[5], SqlValue::Integer(0)) {
                return Err(crate::cause!(Kind::Corrupt));
            }
            previous = entity;
        }
        let has_more = page.rows.len() > request.limit;
        let mut output = Vec::with_capacity(page.rows.len().min(request.limit));
        for row in page.rows.iter().take(request.limit) {
            meter.check()?;
            let raw = text(&row[4])?;
            let remaining = limits
                .value_bytes
                .checked_sub(meter.work.value_bytes)
                .ok_or(crate::cause!(Kind::Bounds))?;
            let codec = ecma_json::Limits {
                input_bytes: limits.source_bytes,
                output_bytes: remaining,
                depth: ecma_json::HARD_DEPTH,
                nodes: ecma_json::HARD_NODES,
                string_units: ecma_json::HARD_BYTES,
                total_string_units: ecma_json::HARD_BYTES,
                container_entries: ecma_json::HARD_NODES,
                number_bytes: ecma_json::HARD_NUMBER_BYTES,
            };
            let value = ecma_json::parse(raw.as_bytes(), codec).map_err(codec_error)?;
            let encoded = ecma_json::stringify(&value, codec).map_err(codec_error)?;
            meter.work.value_bytes = meter
                .work
                .value_bytes
                .checked_add(encoded.len())
                .ok_or(crate::cause!(Kind::Bounds))?;
            meter.check()?;
            output.push(Row {
                entity: text(&row[0])?.into(),
                value,
            });
        }
        // The excluded lookahead's JSON is deliberately not parsed. Its source
        // bytes/pointer still count, matching the original limit+1 SQL read.
        let next = if has_more {
            output.last().map(|row| row.entity.clone())
        } else {
            None
        };
        meter.check()?;
        Ok((output, next))
    })();
    match result {
        Ok((rows, next)) => Ok(Page {
            rows,
            next,
            work: meter.work,
        }),
        Err(kind) => Err(Failure {
            cause: kind.cause(),
            kind,
            work: meter.work,
        }),
    }
}
