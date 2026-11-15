// src/legacy_kept.rs
// Purpose: Read a selected original kept-run key through the admitted import boundary.
// Non-Negotiable Invariants: no source writes, raw connection, provider contact,
// cross-original cache, eager value decode, or fallback past a winning deletion.
// Key Concepts: original schema, UTF-16 order, exact JSON text, bounded point work.
// Security Considerations: pinned source checks stay in ReadonlyOriginal; SQL values
// are parameters and the only dynamic identifier is a validated nonnegative run.
// AI Assistant Directive: preserve explicit refusals and whole-workload uncertainty.

mod batch;
mod filter;
mod points;
pub mod range;
pub use points::PointsRead;

use crate::{
    import::{QueryRows, SqlValue},
    kept_runs::{self, PackedText, Settings},
    record_source::{BoundedRecordSql, QueryBudget},
};
use rusqlite::types::Value;
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    fmt,
    time::{Duration, Instant},
};

#[derive(Debug, Clone)]
pub struct Limits {
    pub statements: usize,
    pub rows: usize,
    pub source_bytes: usize,
    pub runs: usize,
    pub pages_per_run: usize,
    pub page_bytes: usize,
    pub key_bytes: usize,
    pub value_bytes: usize,
    pub multipart_parts: usize,
    pub progress_callbacks: u64,
    pub elapsed: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            statements: 2048,
            rows: 4096,
            source_bytes: 16 * 1024 * 1024,
            runs: 64,
            pages_per_run: 16 * 1024 * 1024,
            page_bytes: 1024 * 1024,
            key_bytes: 16 * 1024,
            value_bytes: 8 * 1024 * 1024,
            multipart_parts: 32,
            progress_callbacks: 20_000,
            elapsed: Duration::from_secs(5),
        }
    }
}
#[derive(Debug, Default, Clone, Serialize)]
pub struct Work {
    pub sql_statements: u64,
    pub rows_returned: u64,
    pub source_bytes: u64,
    pub progress_callbacks: u64,
    pub runs_examined: u64,
    pub page_bodies: u64,
    pub multipart_chunks: u64,
    pub source_precheck_us: u64,
    pub source_sql_us: u64,
    pub source_postcheck_us: u64,
    pub head_decode_us: u64,
    pub page_decode_us: u64,
    pub elapsed_us: u64,
    pub source_timing_complete: bool,
}
#[derive(Debug)]
pub struct Error {
    pub cause: crate::refusal_cause::Cause,
    pub reason: &'static str,
    pub work: Work,
    pub source: Option<SourceFailure>,
    pub budget_exhausted: bool,
    /// What kind of refusal this is, where a caller acts on it.
    pub kind: Refusal,
}
/// The refusals a caller can act on, apart from the reason text.
#[derive(Clone, Debug)]
pub enum Refusal {
    /// Every other refusal.
    Other(crate::refusal_cause::Cause),
    /// One value is larger than the read's value bound.
    ValueBound(crate::refusal_cause::Cause),
    /// A range page's output budget had no room left for its next value after
    /// the values already in the page; a page with fewer values holds it. A
    /// value too large for an empty page's budget is `ValueBound`.
    PageBudget(crate::refusal_cause::Cause),
}
impl Refusal {
    pub fn cause(&self) -> crate::refusal_cause::Cause { match self {
        Self::Other(cause) => cause.clone(),
        Self::ValueBound(cause) => cause.clone(),
        Self::PageBudget(cause) => cause.clone(),
    } }
}
crate::impl_caused!(Refusal);

impl PartialEq for Refusal { fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) } }
impl Eq for Refusal {}

/// Only static refusal text, I/O kind or SQLite numeric codes cross the source
/// diagnostic boundary. SQL text, SQLite messages and input values never do.
#[derive(Clone, Debug)]
pub enum SourceFailure {
    Deadline(crate::refusal_cause::Cause),
    Refused(&'static str, crate::refusal_cause::Cause),
    Io(std::io::ErrorKind, crate::refusal_cause::Cause),
    Sqlite { primary: i32, extended: i32 , cause: crate::refusal_cause::Cause},
    SqliteAdapter(crate::refusal_cause::Cause),
    Json(crate::refusal_cause::Cause),
}
impl SourceFailure {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { match self {
        Self::Deadline(cause) => cause,
        Self::SqliteAdapter(cause) => cause,
        Self::Json(cause) => cause,
        Self::Refused(_, cause) => cause,
        Self::Io(_, cause) => cause,
        Self::Sqlite{ cause, .. } => cause,
    } }
}
crate::impl_caused!(SourceFailure);

impl PartialEq for SourceFailure { fn eq(&self, other: &Self) -> bool { match (self, other) {
    (Self::Deadline(_),Self::Deadline(_)) | (Self::SqliteAdapter(_),Self::SqliteAdapter(_)) | (Self::Json(_),Self::Json(_)) => true,
    (Self::Refused(a,_),Self::Refused(b,_)) => a==b,
    (Self::Io(a,_),Self::Io(b,_)) => a==b,
    (Self::Sqlite{primary:a,extended:b,..},Self::Sqlite{primary:c,extended:d,..}) => a==c && b==d,
    _=>false,
} } }
impl Eq for SourceFailure {}

impl SourceFailure {
    pub fn capture(error: &crate::import::ImportError) -> Self {
        use crate::import::ImportError;
        let cause = error.cause();
        match error {
            ImportError::Deadline(_, _) => Self::Deadline(cause),
            ImportError::Refused(reason, _) | ImportError::Budget(reason, _) => Self::Refused(reason, cause),
            ImportError::Io(error, _) => Self::Io(error.kind(), cause),
            ImportError::Sqlite(rusqlite::Error::SqliteFailure(error, _), _) => Self::Sqlite {
                primary: error.extended_code & 0xff,
                extended: error.extended_code,
                cause,
            },
            ImportError::Sqlite(_, _) => Self::SqliteAdapter(cause),
            ImportError::Json(_, _) => Self::Json(cause),
        }
    }
}
impl fmt::Display for SourceFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Deadline(_) => f.write_str("source-deadline"),
            Self::Refused(reason, _) => write!(f, "source-refused: {reason}"),
            Self::Io(kind, _) => write!(f, "source-io: {kind:?}"),
            Self::Sqlite { primary, extended, .. } => {
                write!(f, "source-sqlite: primary={primary} extended={extended}")
            }
            Self::SqliteAdapter(_) => f.write_str("source-sqlite-adapter"),
            Self::Json(_) => f.write_str("source-json"),
        }
    }
}
impl Error { pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { self.source.as_ref().map(SourceFailure::cause_ref).unwrap_or(&self.cause) } }
crate::impl_caused!(Error);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.reason)
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum Entry {
    Absent,
    Tombstone,
    Json(String),
}
#[derive(Debug, Serialize)]
pub struct PointRead {
    pub entry: Entry,
    pub work: Work,
}
/// Stateless: every call rechecks the pinned original, including after restart.
pub struct LegacyKept {
    limits: Limits,
}
/// An outer operation passes its actual remaining allowance and absolute
/// deadline. These caps can only tighten this reader's independent limits.
pub struct PointBudget {
    pub statements: usize,
    pub rows: usize,
    pub source_bytes: usize,
    pub deadline: Instant,
}
struct Meter<'a> {
    limits: &'a Limits,
    work: Work,
    start: Instant,
    deadline: Instant,
}
impl<'a> Meter<'a> {
    fn snapshot_work(&self) -> Work {
        let mut work = self.work.clone();
        work.elapsed_us = self.start.elapsed().as_micros().min(u64::MAX as u128) as u64;
        work
    }
    #[track_caller]
    fn error(&self, reason: &'static str) -> Error {
        Error {
            cause: crate::refusal_cause::Cause::from_caller(),
            reason,
            work: self.snapshot_work(),
            source: None,
            budget_exhausted: false,
            kind: Refusal::Other(crate::refusal_cause::Cause::from_caller()),
        }
    }
    #[track_caller]
    fn budget_error(&self, reason: &'static str) -> Error {
        let mut error = self.error(reason);
        error.budget_exhausted = true;
        error
    }
    #[track_caller]
    fn refusal(&self, reason: &'static str, kind: Refusal) -> Error {
        let mut error = self.error(reason);
        error.kind = kind;
        error
    }
    fn check(&self) -> Result<()> {
        if Instant::now() >= self.deadline {
            let mut error = self.budget_error("original kept point deadline exhausted");
            error.source = Some(crate::cause!(SourceFailure::Deadline));
            Err(error)
        } else {
            Ok(())
        }
    }
    fn query<S: BoundedRecordSql + ?Sized>(
        &mut self,
        original: &mut S,
        sql: &str,
        params: &[Value],
    ) -> Result<QueryRows> {
        if self.work.sql_statements as usize >= self.limits.statements {
            return Err(self.budget_error("original kept SQL budget exhausted"));
        }
        let remaining_rows = self
            .limits
            .rows
            .saturating_sub(self.work.rows_returned as usize);
        let remaining_bytes = self
            .limits
            .source_bytes
            .saturating_sub(self.work.source_bytes as usize);
        if remaining_rows == 0 {
            return Err(self.budget_error("original kept row budget exhausted"));
        }
        if remaining_bytes == 0 {
            return Err(self.budget_error("original kept source byte budget exhausted"));
        }
        self.check()?;
        self.work.sql_statements += 1;
        let result = original.query_checkpoint_with_budget(
            sql,
            params,
            QueryBudget {
                rows: remaining_rows,
                source_bytes: remaining_bytes,
                deadline: self.deadline,
            },
        );
        if let Some(timing) = original.last_query_timing() {
            self.work.source_precheck_us = self
                .work
                .source_precheck_us
                .saturating_add(timing.precheck_us);
            self.work.source_sql_us = self.work.source_sql_us.saturating_add(timing.sql_us);
            self.work.source_postcheck_us = self
                .work
                .source_postcheck_us
                .saturating_add(timing.postcheck_us);
        } else {
            self.work.source_timing_complete = false;
        }
        let result = result.map_err(|error| {
            if matches!(error, crate::import::ImportError::Deadline(_, _)) {
                let mut failure = self.budget_error("original kept source deadline exhausted");
                failure.source = Some(SourceFailure::Deadline(error.cause()));
                return failure;
            }
            if let crate::import::ImportError::Budget(reason, _) = &error {
                let mut failure = self.budget_error(reason);
                failure.cause = error.cause();
                return failure;
            }
            let mut failure = self.error("original kept source query refused or failed");
            failure.source = Some(SourceFailure::capture(&error));
            failure
        })?;
        self.work.progress_callbacks = self
            .work
            .progress_callbacks
            .saturating_add(result.progress_callbacks);
        self.work.rows_returned = self
            .work
            .rows_returned
            .saturating_add(result.rows.len() as u64);
        let bytes = result.columns.iter().map(String::len).sum::<usize>()
            + result
                .rows
                .iter()
                .flatten()
                .map(|cell| match cell {
                    SqlValue::Text(v) | SqlValue::Blob(v) => v.len(),
                    _ => 8,
                })
                .sum::<usize>();
        self.work.source_bytes = self.work.source_bytes.saturating_add(bytes as u64);
        if self.work.rows_returned > self.limits.rows as u64
            || self.work.source_bytes > self.limits.source_bytes as u64
            || self.work.progress_callbacks > self.limits.progress_callbacks
        {
            return Err(self.budget_error("original kept aggregate source budget exhausted"));
        }
        self.check()?;
        Ok(result)
    }
    fn integer(&self, value: &SqlValue) -> Result<i64> {
        if let SqlValue::Integer(v) = value {
            Ok(*v)
        } else {
            Err(self.error("original kept integer metadata invalid"))
        }
    }
    fn text<'b>(&self, value: &'b SqlValue) -> Result<&'b str> {
        if let SqlValue::Text(v) = value {
            std::str::from_utf8(v).map_err(|_| self.error("original kept TEXT is not valid UTF-8"))
        } else {
            Err(self.error("original kept text metadata invalid or oversized"))
        }
    }
    fn key(&mut self, value: &SqlValue) -> Result<String> {
        let start = Instant::now();
        let mut result = (|| {
            let raw = self.text(value)?;
            if raw.len() > self.limits.key_bytes * 6 + 2 {
                return Err(self.error("original kept key metadata exceeds bound"));
            }
            let key: String = serde_json::from_str(raw)
                .map_err(|_| self.error("original kept key JSON invalid"))?;
            if key.len() > self.limits.key_bytes {
                return Err(self.error("original kept decoded key exceeds bound"));
            }
            Ok(key)
        })();
        self.work.head_decode_us = self
            .work
            .head_decode_us
            .saturating_add(start.elapsed().as_micros().min(u64::MAX as u128) as u64);
        if let Err(error) = &mut result {
            error.work = self.snapshot_work();
        }
        result
    }
}
fn order(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}
impl LegacyKept {
    pub fn new(limits: Limits) -> Result<Self> {
        if limits.statements == 0
            || limits.statements > 65_536
            || limits.rows == 0
            || limits.rows > 131_072
            || limits.source_bytes == 0
            || limits.source_bytes > 128 * 1024 * 1024
            || limits.runs == 0
            || limits.runs > 4096
            || limits.pages_per_run == 0
            || limits.pages_per_run > i32::MAX as usize
            || limits.page_bytes < 1024
            || limits.page_bytes > 1024 * 1024
            || limits.key_bytes == 0
            || limits.key_bytes > limits.page_bytes / 2
            || limits.value_bytes == 0
            || limits.value_bytes > 32 * 1024 * 1024
            || limits.multipart_parts == 0
            || limits.multipart_parts > 1024
            || limits.progress_callbacks == 0
            || limits.elapsed.is_zero()
            || limits.elapsed > Duration::from_secs(30)
        {
            return Err(Error {
                cause: crate::cause!(),
                reason: "invalid original kept limits",
                work: Work::default(),
                source: None,
                budget_exhausted: false,
                kind: Refusal::Other(crate::refusal_cause::Cause::from_caller()),
            });
        }
        Ok(Self { limits })
    }
    pub fn point<S: BoundedRecordSql + ?Sized>(
        &self,
        original: &mut S,
        key: &str,
    ) -> Result<PointRead> {
        self.point_with_budget(
            original,
            key,
            PointBudget {
                statements: self.limits.statements,
                rows: self.limits.rows,
                source_bytes: self.limits.source_bytes,
                deadline: Instant::now() + self.limits.elapsed,
            },
        )
    }
    pub fn point_with_budget<S: BoundedRecordSql + ?Sized>(
        &self,
        original: &mut S,
        key: &str,
        budget: PointBudget,
    ) -> Result<PointRead> {
        let start = Instant::now();
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
            start,
            deadline: budget.deadline.min(start + limits.elapsed),
        };
        if key.len() > self.limits.key_bytes {
            return Err(meter.error("original kept lookup key exceeds bound"));
        }
        // The supplier owns any operation-local snapshot reuse; every lookup
        // still reaches its current source/cancellation validation.
        let columns = meter.query(original, "PRAGMA table_info(record_keys_runs)", &[])?;
        if columns.rows.len() > 64 {
            return Err(meter.error("original kept catalogue column bound exceeded"));
        }
        let mut names = Vec::new();
        for row in &columns.rows {
            if row.len() < 2 {
                return Err(meter.error("original kept catalogue schema invalid"));
            }
            names.push(meter.text(&row[1])?.to_owned());
        }
        for required in ["run", "age", "pages", "last"] {
            if !names.iter().any(|name| name == required) {
                return Err(meter.error("original kept catalogue schema unsupported"));
            }
        }
        let format = if names.iter().any(|name| name == "page_format") {
            "COALESCE(page_format,0)"
        } else {
            "0"
        };
        let layout = if names.iter().any(|name| name == "page_layout") {
            "COALESCE(page_layout,0)"
        } else {
            "0"
        };
        let has_filter = names.iter().any(|name| name == "filter_bits");
        let filter = if has_filter {
            ",CASE WHEN typeof(catalogue.filter_bits)='integer' THEN catalogue.filter_bits ELSE 0 END AS filter_bits"
        } else { "" };
        let mut after = None;
        loop {
            meter.check()?;
            let window = 64usize.min(self.limits.runs.saturating_add(1)).min(
                meter
                    .limits
                    .rows
                    .saturating_sub(meter.work.rows_returned as usize),
            );
            if window == 0 {
                return Err(meter.budget_error("original kept row budget exhausted"));
            }
            let predicate = if after.is_some() {
                " WHERE catalogue.age<? OR (catalogue.age=? AND catalogue.run<?)"
            } else {
                ""
            };
            // Catalogue metadata is bounded and decoded only as its run is
            // reached. No older body is fetched before a newer winner is known.
            let sql = format!("SELECT catalogue.run AS run,CASE WHEN typeof(catalogue.age)='integer' THEN catalogue.age END AS age,CASE WHEN typeof(catalogue.pages)='integer' THEN catalogue.pages END AS pages,CASE WHEN length(CAST(catalogue.last AS BLOB))<=? THEN catalogue.last END AS last,CASE WHEN typeof({format})='integer' THEN {format} END AS page_format,CASE WHEN typeof({layout})='integer' THEN {layout} END AS page_layout{filter} FROM record_keys_runs AS catalogue{predicate} ORDER BY catalogue.age DESC,catalogue.run DESC LIMIT ?");
            let mut params = vec![Value::Integer((self.limits.key_bytes * 6 + 2) as i64)];
            if let Some((age, run)) = after {
                params.extend([
                    Value::Integer(age),
                    Value::Integer(age),
                    Value::Integer(run),
                ]);
            }
            params.push(Value::Integer(window as i64));
            let rows = meter.query(original, &sql, &params)?;
            for row in &rows.rows {
                if meter.work.runs_examined >= self.limits.runs as u64 {
                    return Err(meter.error("original kept candidate-run budget exhausted"));
                }
                meter.work.runs_examined += 1;
                if row.len() != if has_filter { 7 } else { 6 } {
                    return Err(meter.error("original kept catalogue row invalid"));
                }
                let run = meter.integer(&row[0])?;
                let age = meter.integer(&row[1])?;
                let pages = meter.integer(&row[2])?;
                if run < 0 || age < 0 || pages < 0 || pages as usize > self.limits.pages_per_run {
                    return Err(meter.error("original kept run geometry invalid"));
                }
                after = Some((age, run));
                if pages == 0 {
                    continue;
                }
                let last = meter.key(&row[3])?;
                if order(key, &last) == Ordering::Greater {
                    continue;
                }
                let format = meter.integer(&row[4])?;
                let layout = meter.integer(&row[5])?;
                if format != 0 {
                    return Err(meter
                        .error("original sparse or unknown kept page format requires an adapter"));
                }
                if ![0, 1, 2].contains(&layout) {
                    return Err(meter.error("original kept page layout unsupported"));
                }
                let table = format!("record_keys_run_{run}");
                let Some(page) = self.seek_page_filtered(original, &table, pages, key, if has_filter { meter.integer(&row[6])? } else { 0 }, &mut meter)? else {
                    continue;
                };
                let body=meter.query(original,&format!("SELECT length(CAST(body AS BLOB)) AS bytes,CASE WHEN length(CAST(body AS BLOB))<=? THEN body ELSE NULL END AS body FROM {table} WHERE page=?"),&[Value::Integer(self.limits.page_bytes as i64),Value::Integer(page)])?;
                if body.rows.len() != 1 || body.rows[0].len() != 2 {
                    return Err(meter.error("original kept selected page missing"));
                }
                let length = meter.integer(&body.rows[0][0])?;
                if length < 0 || length as usize > self.limits.page_bytes {
                    return Err(meter.error("original kept selected page exceeds bound"));
                }
                let raw = meter.text(&body.rows[0][1])?;
                if raw.len() != length as usize {
                    return Err(meter.error("original kept page length mismatch"));
                }
                meter.work.page_bodies += 1;
                let settings = Settings {
                    page_bytes: self.limits.page_bytes,
                    max_key_bytes: self.limits.key_bytes,
                    max_value_bytes: self.limits.value_bytes,
                    ..Settings::default()
                };
                let start = Instant::now();
                let entry = kept_runs::packed_point_text(raw, key, &settings);
                meter.work.page_decode_us = meter
                    .work
                    .page_decode_us
                    .saturating_add(start.elapsed().as_micros().min(u64::MAX as u128) as u64);
                let entry = entry.map_err(|_| {
                    meter.error("original kept selected page corrupt or unsupported")
                })?;
                meter.check()?;
                let entry = match entry {
                    PackedText::Absent => continue,
                    PackedText::Tombstone => Entry::Tombstone,
                    PackedText::Json(text) => Entry::Json(text),
                    PackedText::Big { reference, parts } => {
                        Entry::Json(self.multipart(original, &reference, parts, &mut meter)?)
                    }
                };
                return Ok(PointRead {
                    entry,
                    work: meter.snapshot_work(),
                });
            }
            if rows.rows.len() < window {
                return Ok(PointRead {
                    entry: Entry::Absent,
                    work: meter.snapshot_work(),
                });
            }
        }
    }
    fn seek_page<S: BoundedRecordSql + ?Sized>(
        &self, original: &mut S, table: &str, pages: i64, key: &str, meter: &mut Meter<'_>,
    ) -> Result<Option<i64>> {
        self.seek_page_filtered(original, table, pages, key, 0, meter)
    }
    fn seek_page_filtered<S: BoundedRecordSql + ?Sized>(
        &self,
        original: &mut S,
        table: &str,
        pages: i64,
        key: &str,
        filter_bits: i64,
        meter: &mut Meter<'_>,
    ) -> Result<Option<i64>> {

        // A one-page run has no binary search to perform. Read its sole
        // indexed boundary key once and compare with the same exact UTF-16 ordering
        // used by the general path's checked Rust fallback.
        if pages == 1 {
            let rows = meter.query(
                original,
                &format!("SELECT first FROM {table} WHERE page=?"),
                &[Value::Integer(0)],
            )?;
            if rows.rows.len() != 1 || rows.rows[0].len() != 1 {
                return Err(meter.error("original kept page boundary key missing"));
            }
            let first = meter.key(&rows.rows[0][0])?;
            return Ok((order(&first, key) != Ordering::Greater).then_some(0));
        }
        let filter = filter::plan(key, filter_bits);
        // Same indexed halving geometry as the existing source owner. SQL's
        // code-point result is checked with exact UTF-16 brackets before any
        // body query. Disagreement uses the bounded Rust halving fallback.
        let valid="CASE WHEN typeof(probe.first)='text' THEN CASE WHEN json_valid(probe.first) THEN CASE WHEN json_type(probe.first)='text' THEN 1 ELSE 0 END ELSE 0 END ELSE 0 END";
        let below=format!("CASE WHEN ({valid})=1 THEN json_extract(probe.first,'$') COLLATE BINARY<=?2 ELSE 0 END");
        let filter_prefix = filter.as_ref().map(|plan| format!("{},", filter::prefix(table, plan))).unwrap_or_default();
        let admit = if filter.is_some() { " WHERE (SELECT holds FROM membership)" } else { "" };
        let filter_row = if filter.is_some() {
            "SELECT NULL AS probe,NULL AS lo,NULL AS hi,-2 AS found,NULL AS here,NULL AS next,holds AS valid,-1 AS step FROM membership WHERE holds=0 UNION ALL "
        } else { "" };
        let search_rows = if filter.is_some() {
            format!("SELECT probe,lo,hi,found,here,next,valid FROM ({filter_row}SELECT seen AS probe,lo,hi,found,CASE WHEN lo>hi THEN here END AS here,CASE WHEN lo>hi THEN next END AS next,valid,step FROM seeking WHERE step>0) ORDER BY step")
        } else {
            "SELECT seen AS probe,lo,hi,found,CASE WHEN lo>hi THEN here END AS here,CASE WHEN lo>hi THEN next END AS next,valid FROM seeking WHERE step>0 ORDER BY step".into()
        };
        let sql=format!("WITH RECURSIVE {filter_prefix}seeking(lo,hi,found,here,next,seen,valid,step) AS (SELECT 0,?1-1,-1,NULL,NULL,NULL,1,0{admit} UNION ALL SELECT CASE WHEN {below} THEN (lo+hi)/2+1 ELSE lo END,CASE WHEN {below} THEN hi ELSE (lo+hi)/2-1 END,CASE WHEN {below} THEN (lo+hi)/2 ELSE found END,CASE WHEN {below} THEN probe.first ELSE here END,CASE WHEN {below} THEN next ELSE probe.first END,probe.first,{valid},step+1 FROM seeking LEFT JOIN {table} AS probe ON probe.page=(lo+hi)/2 WHERE lo<=hi AND valid=1 AND step<32) {search_rows}");
        let mut params = vec![Value::Integer(pages), Value::Text(key.into())];
        if let Some(plan) = filter { params.push(plan.value); }
        let mut rows = meter.query(original, &sql, &params)?;
        if params.len() == 3 {
            let row = rows.rows.first().ok_or_else(|| meter.error("original kept membership missing"))?;
            if row.len() != 7 {
                return Err(meter.error("original kept membership result invalid"));
            }
            if meter.integer(&row[3])? == -2 {
                if rows.rows.len() != 1 || meter.integer(&row[6])? != 0 {
                    return Err(meter.error("original kept membership result invalid"));
                }
                return Ok(None);
            }
        }
        for row in &rows.rows {
            if row.len() != 7 || meter.integer(&row[6])? != 1 {
                return Err(meter.error("original kept page boundary key missing or invalid"));
            }
            meter.key(&row[0])?;
        }
        let row = rows
            .rows
            .last()
            .ok_or_else(|| meter.error("original kept page boundary key missing"))?;
        if meter.integer(&row[1])? <= meter.integer(&row[2])? {
            return Err(meter.error("original kept boundary key search did not finish"));
        }
        let found = meter.integer(&row[3])?;
        if found < -1 || found >= pages {
            return Err(meter.error("original kept boundary key result invalid"));
        }
        let here = if found >= 0 {
            Some(meter.key(&row[4])?)
        } else {
            None
        };
        let next = if found + 1 < pages {
            Some(meter.key(&row[5])?)
        } else {
            None
        };
        if here
            .as_ref()
            .is_none_or(|first| order(first, key) != Ordering::Greater)
            && next
                .as_ref()
                .is_none_or(|first| order(first, key) == Ordering::Greater)
        {
            return Ok((found >= 0).then_some(found));
        }
        let mut lo = 0;
        let mut hi = pages;
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let rows = meter.query(
                original,
                &format!("SELECT first FROM {table} WHERE page=?"),
                &[Value::Integer(mid)],
            )?;
            if rows.rows.len() != 1 || rows.rows[0].len() != 1 {
                return Err(meter.error("original kept page boundary key missing"));
            }
            let first = meter.key(&rows.rows[0][0])?;
            if order(&first, key) != Ordering::Greater {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        Ok((lo > 0).then_some(lo - 1))
    }
    fn multipart<S: BoundedRecordSql + ?Sized>(
        &self,
        original: &mut S,
        reference: &str,
        parts: usize,
        meter: &mut Meter<'_>,
    ) -> Result<String> {
        if parts == 0
            || parts > self.limits.multipart_parts
            || reference.is_empty()
            || reference.len() > 4096
        {
            return Err(meter.error("original kept multipart reference exceeds bound"));
        }
        let extra = meter.query(
            original,
            "SELECT part FROM record_keys_big WHERE ref=? AND (part<0 OR part>=?) LIMIT 1",
            &[Value::Text(reference.into()), Value::Integer(parts as i64)],
        )?;
        if !extra.rows.is_empty() {
            return Err(meter.error("original kept multipart has unexpected parts"));
        }
        // The supplier's actual packet/cell ceilings define transport. Part
        // metadata and its bounded first bytes are one observation; a separate
        // sizing query and fixed 64KiB fragmentation add no source fact.
        let supplier = original.read_limits().ok_or_else(|| {
            meter.error("original kept multipart supplier limits unavailable")
        })?.clone();
        supplier.validate().map_err(|_| meter.error("original kept multipart supplier limits invalid"))?;
        let mut bytes = Vec::new();
        for part in 0..parts {
            // Four fixed aliases (18 bytes), two integers (16), and "text"
            // (4). Reserve every returned metadata byte before copying data.
            let size = supplier.cell_bytes
                .min(supplier.result_bytes.saturating_sub(38))
                .min(meter.limits.source_bytes.saturating_sub(usize::try_from(meter.work.source_bytes).unwrap_or(usize::MAX)).saturating_sub(38));
            if size == 0 {
                return Err(meter.budget_error("original kept source byte budget exhausted"));
            }
            let initial=meter.query(original,"SELECT part AS part,length(CAST(body AS BLOB)) AS bytes,typeof(body) AS kind,CASE WHEN typeof(body)='text' AND length(CAST(body AS BLOB))<=?2 THEN substr(CAST(body AS BLOB),1,?1) END AS chunk FROM record_keys_big WHERE ref=?3 AND part=?4",&[Value::Integer(size as i64),Value::Integer(self.limits.value_bytes.saturating_sub(bytes.len()) as i64),Value::Text(reference.into()),Value::Integer(part as i64)])?;
            if initial.rows.len() != 1 || initial.rows[0].len() != 4 {
                return Err(meter.error("original kept multipart part missing or duplicate"));
            }
            let row = &initial.rows[0];
            let length = meter.integer(&row[1])?;
            if meter.integer(&row[0])? != part as i64
                || meter.text(&row[2])? != "text"
                || length < 0
            {
                return Err(meter.error("original kept multipart metadata invalid"));
            }
            let length = length as usize;
            if length > self.limits.value_bytes.saturating_sub(bytes.len()) {
                return Err(meter.refusal("original kept multipart value exceeds bound", crate::cause!(Refusal::ValueBound)));
            }
            let SqlValue::Blob(data) = &row[3] else {
                return Err(meter.error("original kept multipart chunk type invalid"));
            };
            if data.len() != length.min(size) {
                return Err(meter.error("original kept multipart chunk incomplete"));
            }
            bytes.extend_from_slice(data);
            meter.work.multipart_chunks += 1;
            let mut offset=data.len();
            while offset < length {
                let size = (length-offset).min(supplier.cell_bytes)
                    .min(supplier.result_bytes.saturating_sub(5))
                    .min(meter.limits.source_bytes.saturating_sub(usize::try_from(meter.work.source_bytes).unwrap_or(usize::MAX)).saturating_sub(5));
                if size == 0 {
                    return Err(meter.budget_error("original kept source byte budget exhausted"));
                }
                let chunk=meter.query(original,"SELECT substr(CAST(body AS BLOB),?,?) AS chunk FROM record_keys_big WHERE ref=? AND part=?",&[Value::Integer(offset as i64+1),Value::Integer(size as i64),Value::Text(reference.into()),Value::Integer(part as i64)])?;
                if chunk.rows.len() != 1 || chunk.rows[0].len() != 1 {
                    return Err(meter.error("original kept multipart chunk missing"));
                }
                let SqlValue::Blob(data) = &chunk.rows[0][0] else {
                    return Err(meter.error("original kept multipart chunk type invalid"));
                };
                if data.len() != size {
                    return Err(meter.error("original kept multipart chunk incomplete"));
                }
                bytes.extend_from_slice(data);
                meter.work.multipart_chunks += 1;
                offset += size;
            }
        }
        let text = String::from_utf8(bytes)
            .map_err(|_| meter.error("original kept multipart TEXT is not valid UTF-8"))?;
        let mut decoder = serde_json::Deserializer::from_str(&text);
        <serde::de::IgnoredAny as Deserialize>::deserialize(&mut decoder)
            .map_err(|_| meter.error("original kept multipart JSON invalid"))?;
        decoder
            .end()
            .map_err(|_| meter.error("original kept multipart JSON trailing data"))?;
        meter.check()?;
        Ok(text)
    }
}
