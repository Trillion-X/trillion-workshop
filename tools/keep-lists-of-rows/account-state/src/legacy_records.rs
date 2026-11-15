// Purpose: decode the existing record engine through a caller-owned bounded SQL supplier.
// Invariants: database engine metadata wins; no initialization, migration, new
// binding, original writes, fabricated sequence or current-account authority.
// Security: bounded point/range reads; raw kept representations are not decrypted
// records. Root erasure material in an original pointer is never exposed.
//! Physical original-record bridge. EEAF assembly and active private-field
//! resolution stay with their canonical value/key owners. Stored records retain
//! shared links and ciphertext; they must not be presented as resolved plaintext.
mod batch;
pub mod current_head;
pub mod current_indexes;
pub mod ids;
use crate::{ecma_json, record_stamps as stamps};
use crate::{
    import::{QueryRows, ReadLimits, ReadonlyOriginal, SqlValue},
    legacy_kept::{Entry, LegacyKept},
    record_source::BoundedRecordSql,
};
use rusqlite::types::Value;
use serde_json::value::RawValue;
use std::{
    collections::BTreeSet,
    fmt,
    time::{Duration, Instant},
};
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    Eeaf,
    RecordLog,
}
#[derive(Clone, Debug)]
pub struct Bounds {
    pub statements: usize,
    pub rows: usize,
    pub bytes: usize,
    pub elapsed: Duration,
}
impl Default for Bounds {
    fn default() -> Self {
        Self {
            statements: 128,
            rows: 4096,
            bytes: 8 * 1024 * 1024,
            elapsed: Duration::from_secs(5),
        }
    }
}
#[derive(Clone, Debug)]
pub enum Error {
    Invalid(crate::refusal_cause::Cause),
    Bounds(crate::refusal_cause::Cause),
    Deadline(crate::refusal_cause::Cause),
    Source(crate::refusal_cause::Cause),
    Schema(crate::refusal_cause::Cause),
    UnsupportedEngine(crate::refusal_cause::Cause),
    WrongEngine(crate::refusal_cause::Cause),
    Corrupt(crate::refusal_cause::Cause),
    ReplayRequired(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { match self {
        Self::Invalid(cause) => cause,
        Self::Bounds(cause) => cause,
        Self::Deadline(cause) => cause,
        Self::Source(cause) => cause,
        Self::Schema(cause) => cause,
        Self::UnsupportedEngine(cause) => cause,
        Self::WrongEngine(cause) => cause,
        Self::Corrupt(cause) => cause,
        Self::ReplayRequired(cause) => cause,
    } }
}
crate::impl_caused!(Error);

impl PartialEq for Error { fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) } }
impl Eq for Error {}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid(_) => "original record input refused",
            Self::Bounds(_) => "original record read exceeds bounds",
            Self::Deadline(_) => "original record operation deadline exhausted",
            Self::Source(_) => "original record source unavailable or changed",
            Self::Schema(_) => "original record schema differs",
            Self::UnsupportedEngine(_) => "original record engine unsupported",
            Self::WrongEngine(_) => "original record read belongs to another engine",
            Self::Corrupt(_) => "original record data is inconsistent",
            Self::ReplayRequired(_) => "original record projection requires bounded log replay",
        })
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
pub type Result<T> = std::result::Result<T, Error>;

/// Exact physical row order/type associations. Untyped entities remain None;
/// several types are retained rather than silently narrowed to a Rust map entry.
pub struct OwnRows {
    pub root_id: String,
    pub entities: Vec<(String, Option<String>)>,
    pub facts: Vec<Fact>,
    pub participations: Vec<Participation>,
    pub members: Vec<Member>,
}
pub struct Fact {
    pub subject_id: String,
    pub property_id: String,
    pub type_id: String,
    pub value_json: Option<String>,
}
pub struct Participation {
    pub id: String,
    pub interaction_id: String,
    pub participant_id: String,
    pub role_id: String,
    pub counterpart_id: Option<String>,
}
pub struct Member {
    pub set_id: String,
    pub member_id: String,
    pub ordinal: Option<i64>,
}
/// Original storedForm, not resolved()/read(). JSON text retains lexical bytes,
/// sequence and private merge metadata; root key material is not returned.
#[derive(Clone)]
pub struct StoredRecord {
    pub id: String,
    pub record_type: String,
    pub sequence: String,
    pub value_json: String,
    pub meta_json: Option<String>,
    pub protected_key_present: bool,
}
impl fmt::Debug for StoredRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StoredRecord([redacted original representation])")
    }
}
pub struct HistoryRow {
    pub rowid: i64,
    pub id: String,
    pub record_id: String,
    pub table_name: String,
    pub patch: String,
    pub transaction_id: String,
    pub actor_context: String,
    pub application_time: String,
    pub system_time: String,
}
pub struct HistoryPage {
    pub table: String,
    pub rows: Vec<HistoryRow>,
    pub next: Option<i64>,
}

/// Redacted observations from the most recent read_stored failure. Counts are
/// actual completed/attempted supplier work, not values or billing units.
#[derive(Debug, Clone)]
pub struct ReadDiagnostic {
    pub stage: &'static str,
    pub reason: &'static str,
    pub source: Option<crate::legacy_kept::SourceFailure>,
    pub outer_sql_statements: usize,
    pub outer_rows_returned: usize,
    pub outer_source_bytes: usize,
    pub outer_elapsed_us: u64,
    pub limits: Bounds,
    /// Immediate completed/failed point associated with this refusal. Outer
    /// counts aggregate all completed points plus direct record queries.
    pub kept_work: Option<crate::legacy_kept::Work>,
}
impl fmt::Display for ReadDiagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "stage={} reason={} outer_sql={} outer_rows={} outer_bytes={}",
            self.stage,
            self.reason,
            self.outer_sql_statements,
            self.outer_rows_returned,
            self.outer_source_bytes
        )?;
        write!(
            f,
            " outer_elapsed_us={} limit_sql={} limit_rows={} limit_bytes={} limit_elapsed_us={}",
            self.outer_elapsed_us,
            self.limits.statements,
            self.limits.rows,
            self.limits.bytes,
            self.limits.elapsed.as_micros().min(u64::MAX as u128) as u64
        )?;
        if let Some(source) = &self.source {
            write!(f, " {source}")?;
        }
        if let Some(work) = &self.kept_work {
            write!(f," kept_sql={} kept_rows={} kept_bytes={} kept_runs={} kept_pages={} kept_progress={}",work.sql_statements,work.rows_returned,work.source_bytes,work.runs_examined,work.page_bodies,work.progress_callbacks)?;
            write!(f," kept_precheck_us={} kept_sql_us={} kept_postcheck_us={} kept_head_decode_us={} kept_page_decode_us={} kept_elapsed_us={}",work.source_precheck_us,work.source_sql_us,work.source_postcheck_us,work.head_decode_us,work.page_decode_us,work.elapsed_us)?;
            write!(
                f,
                " kept_source_timing_complete={}",
                work.source_timing_complete
            )?;
        }
        Ok(())
    }
}

/// Fixed wall-time aggregates for the preceding stored-record attempt, including
/// a successful answer or an outer refusal after a completed kept lookup.
#[derive(Debug, Default, Clone)]
pub struct ReadTiming {
    /// Native work is distinct; internal schema initialization is unmeasured.
    pub native_metadata: crate::record_source::catalogue_point::Work,
    pub source_precheck_us: u64,
    pub source_sql_us: u64,
    pub source_postcheck_us: u64,
    pub head_decode_us: u64,
    pub page_decode_us: u64,
    pub elapsed_us: u64,
    pub source_timing_complete: bool,
}
impl ReadTiming {
    fn query(&mut self, timing: crate::import::QueryTiming) {
        self.source_precheck_us = self.source_precheck_us.saturating_add(timing.precheck_us);
        self.source_sql_us = self.source_sql_us.saturating_add(timing.sql_us);
        self.source_postcheck_us = self.source_postcheck_us.saturating_add(timing.postcheck_us);
    }
    fn point(&mut self, work: &crate::legacy_kept::Work) {
        self.source_timing_complete &= work.source_timing_complete;
        self.query(crate::import::QueryTiming {
            precheck_us: work.source_precheck_us,
            sql_us: work.source_sql_us,
            postcheck_us: work.source_postcheck_us,
        });
        self.head_decode_us = self.head_decode_us.saturating_add(work.head_decode_us);
        self.page_decode_us = self.page_decode_us.saturating_add(work.page_decode_us);
    }
}
impl fmt::Display for ReadTiming {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f,"source_precheck_us={} source_sql_us={} source_postcheck_us={} head_decode_us={} page_decode_us={} elapsed_us={} source_timing_complete={}",self.source_precheck_us,self.source_sql_us,self.source_postcheck_us,self.head_decode_us,self.page_decode_us,self.elapsed_us,self.source_timing_complete)
    }
}

pub struct LegacyRecords<S: BoundedRecordSql = ReadonlyOriginal> {
    original: S,
    source_limits: ReadLimits,
    bounds: Bounds,
    last_diagnostic: Option<ReadDiagnostic>,
    last_timing: ReadTiming,
}
struct Meter {
    statements: usize,
    rows: usize,
    bytes: usize,
    started: Instant,
    bounds: Bounds,
    diagnostic: Option<ReadDiagnostic>,
    timing: ReadTiming,
    last_kept_work: Option<crate::legacy_kept::Work>,
}
impl Meter {
    fn new(bounds: &Bounds) -> Self {
        Self {
            statements: 0,
            rows: 0,
            bytes: 0,
            started: Instant::now(),
            bounds: bounds.clone(),
            diagnostic: None,
            timing: ReadTiming {
                source_timing_complete: true,
                ..ReadTiming::default()
            },
            last_kept_work: None,
        }
    }
    fn observation(&self, stage: &'static str, reason: &'static str) -> ReadDiagnostic {
        ReadDiagnostic {
            stage,
            reason,
            source: None,
            outer_sql_statements: self.statements,
            outer_rows_returned: self.rows,
            outer_source_bytes: self.bytes,
            outer_elapsed_us: self.started.elapsed().as_micros().min(u64::MAX as u128) as u64,
            limits: self.bounds.clone(),
            kept_work: self.last_kept_work.clone(),
        }
    }
    #[track_caller]
    fn bounds_failure(&mut self, stage: &'static str, reason: &'static str) -> Error {
        self.diagnostic = Some(self.observation(stage, reason));
        Error::Bounds(crate::refusal_cause::Cause::from_caller())
    }
    fn check(&mut self) -> Result<()> {
        self.check_at("aggregate-budget")
    }
    fn check_at(&mut self, stage: &'static str) -> Result<()> {
        let refused = if self.statements > self.bounds.statements {
            Some(("original record statement budget exhausted", crate::cause!()))
        } else if self.rows > self.bounds.rows {
            Some(("original record row budget exhausted", crate::cause!()))
        } else if self.bytes > self.bounds.bytes {
            Some(("original record source byte budget exhausted", crate::cause!()))
        } else { None };
        if let Some((reason, cause)) = refused {
            self.bounds_failure(stage, reason);
            return Err(Error::Bounds(cause));
        }
        if self.started.elapsed() > self.bounds.elapsed {
            self.diagnostic = Some(self.observation(stage, "original record elapsed budget exhausted"));
            return Err(crate::cause!(Error::Deadline));
        }
        Ok(())
    }
    fn query<S: BoundedRecordSql + ?Sized>(
        &mut self,
        original: &mut S,
        sql: &str,
        params: &[Value],
    ) -> Result<QueryRows> {
        self.query_kind(original, sql, params, false, false)
    }
    fn checkpoint_query<S: BoundedRecordSql + ?Sized>(
        &mut self,
        original: &mut S,
        sql: &str,
        params: &[Value],
    ) -> Result<QueryRows> {
        self.query_kind(original, sql, params, true, false)
    }
    fn ordered_prefix_query<S: BoundedRecordSql + ?Sized>(
        &mut self, original: &mut S, sql: &str, params: &[Value],
    ) -> Result<QueryRows> {
        self.query_kind(original, sql, params, false, true)
    }
    fn query_kind<S: BoundedRecordSql + ?Sized>(
        &mut self,
        original: &mut S,
        sql: &str,
        params: &[Value],
        checkpoint: bool,
        ordered_prefix: bool,
    ) -> Result<QueryRows> {
        if self.statements >= self.bounds.statements {
            return Err(self.bounds_failure(
                "original-query-budget",
                "original record statement budget exhausted",
            ));
        }
        if self.rows >= self.bounds.rows {
            return Err(self.bounds_failure(
                "original-query-budget",
                "original record row budget exhausted",
            ));
        }
        if self.bytes >= self.bounds.bytes {
            return Err(self.bounds_failure(
                "original-query-budget",
                "original record source byte budget exhausted",
            ));
        }
        self.check_at("original-query-budget")?;
        let budget = crate::record_source::QueryBudget {
            rows: self.bounds.rows.saturating_sub(self.rows),
            source_bytes: self.bounds.bytes.saturating_sub(self.bytes),
            deadline: self.started + self.bounds.elapsed,
        };
        self.statements += 1;
        let rows = if ordered_prefix {
            original.query_ordered_prefix_with_budget(sql, params, budget)
        } else if checkpoint {
            original.query_checkpoint_with_budget(sql, params, budget)
        } else {
            original.query_reusable_with_budget(sql, params, budget)
        };
        if let Some(timing) = original.last_query_timing() {
            self.timing.query(timing);
        } else {
            self.timing.source_timing_complete = false;
        }
        let rows = rows.map_err(|error| {
            if matches!(error, crate::import::ImportError::Deadline(_, _)) {
                let mut diagnostic = self.observation("original-query", "original source deadline exhausted");
                diagnostic.source = Some(crate::legacy_kept::SourceFailure::Deadline(error.cause()));
                self.diagnostic = Some(diagnostic);
                return Error::Deadline(error.cause());
            }
            if let crate::import::ImportError::Budget(reason, _) = &error {
                self.bounds_failure("original-query-budget", reason);
                return Error::Bounds(error.cause());
            }
            let mut diagnostic = self.observation(
                "original-query",
                "original record source query refused or failed",
            );
            diagnostic.source = Some(crate::legacy_kept::SourceFailure::capture(&error));
            self.diagnostic = Some(diagnostic);
            Error::Source(error.cause())
        })?;
        self.rows = self.rows.saturating_add(rows.rows.len());
        self.bytes = self
            .bytes
            .saturating_add(rows.columns.iter().map(String::len).sum::<usize>());
        for cell in rows.rows.iter().flatten() {
            self.bytes = self.bytes.saturating_add(match cell {
                SqlValue::Text(b) | SqlValue::Blob(b) => b.len(),
                _ => 8,
            });
        }
        self.check_at("original-query-budget")?;
        Ok(rows)
    }
    fn kept_failure(&mut self, error: &crate::legacy_kept::Error) -> Error {
        self.timing.point(&error.work);
        self.last_kept_work = Some(error.work.clone());
        // Charge failed nested work too. The nested supplier received only the
        // remaining cap; it may not finish an oversize point before charging it.
        self.rows = self.rows.saturating_add(error.work.rows_returned as usize);
        self.bytes = self.bytes.saturating_add(error.work.source_bytes as usize);
        self.statements = self
            .statements
            .saturating_add(error.work.sql_statements as usize);
        let stage = if error.budget_exhausted {
            "kept-point-budget"
        } else {
            "kept-point"
        };
        let mut diagnostic = self.observation(stage, error.reason);
        diagnostic.source = error.source.clone();
        self.diagnostic = Some(diagnostic);
        if error.source == Some(crate::cause!(crate::legacy_kept::SourceFailure::Deadline)) {
            Error::Deadline(error.cause())
        } else if error.budget_exhausted {
            Error::Bounds(error.cause())
        } else {
            Error::Source(error.cause())
        }
    }
    fn remaining_point_budget(&self) -> crate::legacy_kept::PointBudget {
        crate::legacy_kept::PointBudget {
            statements: self.bounds.statements.saturating_sub(self.statements),
            rows: self.bounds.rows.saturating_sub(self.rows),
            source_bytes: self.bounds.bytes.saturating_sub(self.bytes),
            deadline: self.started + self.bounds.elapsed,
        }
    }
}
fn text(value: &SqlValue) -> Result<&str> {
    match value {
        SqlValue::Text(bytes) => std::str::from_utf8(bytes).map_err(|error| crate::carry_cause!(Error::Corrupt, error)),
        _ => Err(crate::cause!(Error::Corrupt)),
    }
}
fn nullable_text(value: &SqlValue) -> Result<Option<String>> {
    if matches!(value, SqlValue::Null) {
        Ok(None)
    } else {
        Ok(Some(text(value)?.to_owned()))
    }
}
fn integer(value: &SqlValue) -> Result<i64> {
    if let SqlValue::Integer(n) = value {
        Ok(*n)
    } else {
        Err(crate::cause!(Error::Corrupt))
    }
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 4096 && !id.chars().any(char::is_control)
}
fn has_table<S: BoundedRecordSql + ?Sized>(
    original: &mut S,
    meter: &mut Meter,
    name: &str,
) -> Result<bool> {
    meter.check_at("table-metadata-budget")?;
    let probe = original.main_table_exists(
        name,
        crate::record_source::QueryBudget {
            rows: meter.bounds.rows.saturating_sub(meter.rows),
            source_bytes: meter.bounds.bytes.saturating_sub(meter.bytes),
            deadline: meter.started + meter.bounds.elapsed,
        },
    );
    meter
        .timing
        .native_metadata
        .merge(probe.work)
        .map_err(|error| crate::carry_cause!(Error::Bounds, error))?;
    meter.statements = meter
        .statements
        .saturating_add(probe.work.pin_sql_statements as usize);
    meter.rows = meter
        .rows
        .saturating_add(probe.work.pin_rows_returned as usize);
    meter.bytes = meter
        .bytes
        .saturating_add(probe.work.pin_source_bytes as usize);
    let exists = probe.exists.map_err(|error| match error {
        crate::import::ImportError::Deadline(_, cause) => Error::Deadline(cause),
        crate::import::ImportError::Budget(_, cause) => Error::Bounds(cause),
        _ => Error::Source(error.cause()),
    })?;
    meter.check_at("table-metadata-pin-budget")?;
    if meter.timing.native_metadata.metadata_calls > meter.bounds.statements as u64
        || meter.timing.native_metadata.origin_prepares > meter.bounds.statements as u64
    {
        return Err(crate::cause!(Error::Bounds));
    }
    match exists {
        Some(present) => return Ok(present),
        None => {}
    }
    // Unsupported/ambiguous native metadata retains the ORIGINAL observed SQL.
    let rows = meter.query(
        original,
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name=? LIMIT 1",
        &[Value::Text(name.into())],
    )?;
    Ok(!rows.rows.is_empty())
}
fn schema<S: BoundedRecordSql + ?Sized>(
    original: &mut S,
    meter: &mut Meter,
    table: &str,
    required: &[&str],
) -> Result<()> {
    schema_columns(original, meter, table, required).map(|_| ())
}
fn schema_columns<S: BoundedRecordSql + ?Sized>(
    original: &mut S,
    meter: &mut Meter,
    table: &str,
    required: &[&str],
) -> Result<BTreeSet<String>> {
    // Every identifier originates from a literal or the checked sealed-log name.
    if !table
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err(crate::cause!(Error::Schema));
    }
    let rows = meter.query(original, &format!("PRAGMA table_info({table})"), &[])?;
    let columns = rows
        .rows
        .iter()
        .map(|r| r.get(1).ok_or(crate::cause!(Error::Schema)).and_then(text))
        .collect::<Result<BTreeSet<_>>>()?;
    if required.iter().all(|name| columns.contains(name)) {
        Ok(columns.into_iter().map(str::to_owned).collect())
    } else {
        Err(crate::cause!(Error::Schema))
    }
}
fn detect<S: BoundedRecordSql + ?Sized>(original: &mut S, meter: &mut Meter) -> Result<Engine> {
    if has_table(original, meter, "record_keys_meta")? {
        schema(original, meter, "record_keys_meta", &["key", "value"])?;
        let row = meter.checkpoint_query(
            original,
            "SELECT value FROM record_keys_meta WHERE key=? LIMIT 1",
            &[Value::Text("engine".into())],
        )?;
        if let Some(row) = row.rows.first() {
            return match serde_json::from_str::<String>(text(&row[0])?)
                .map_err(|error| crate::carry_cause!(Error::Corrupt, error))?
                .as_str()
            {
                "record-log" => Ok(Engine::RecordLog),
                "eeaf" => Ok(Engine::Eeaf),
                _ => Err(crate::cause!(Error::UnsupportedEngine)),
            };
        }
    }
    if !has_table(original, meter, "entity")? {
        return Ok(Engine::RecordLog);
    }
    schema(original, meter, "entity", &["id"])?;
    schema(original, meter, "entity_types", &["entity_id", "type_id"])?;
    let rows=meter.query(original,"SELECT 1 FROM entity_types WHERE type_id NOT IN ('type:type','type:property','type:role') LIMIT 1",&[])?;
    Ok(if rows.rows.is_empty() {
        Engine::RecordLog
    } else {
        Engine::Eeaf
    })
}
fn projection_frontier<S: BoundedRecordSql + ?Sized>(
    original: &mut S,
    meter: &mut Meter,
) -> Result<(i64, i64, bool)> {
    let columns = schema_columns(
        original,
        meter,
        "record_log",
        &[
            "id",
            "transaction_id",
            "actor_context",
            "application_time",
            "system_time",
            "part",
            "parts",
            "envelopes",
        ],
    )?;
    let saved = meter.checkpoint_query(
        original,
        "SELECT value FROM record_keys_meta WHERE key=? LIMIT 1",
        &[Value::Text("covered".into())],
    )?;
    let covered = if let Some(row) = saved.rows.first() {
        let value: serde_json::Value =
            serde_json::from_str(text(&row[0])?).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
        let at = if value.is_object() {
            value.get("at").unwrap_or(&serde_json::Value::Null)
        } else {
            &value
        };
        if at.is_null() {
            0
        } else {
            at.as_i64().filter(|n| *n >= 0).ok_or(crate::cause!(Error::Corrupt))?
        }
    } else {
        0
    };
    let last = meter.query(
        original,
        "SELECT rowid FROM record_log ORDER BY rowid DESC LIMIT 1",
        &[],
    )?;
    let last = last
        .rows
        .first()
        .map(|row| integer(&row[0]))
        .transpose()?
        .unwrap_or(0);
    Ok((covered, last, columns.contains("keys")))
}
#[derive(Default)]
struct Projection {
    held: Option<stamps::Kept>,
    sequence: Option<String>,
    original: Option<StoredRecord>,
    dirty: bool,
    protected: bool,
}
type RawObject<'a> = stamps::OrderedMap<&'a RawValue>;
fn raw_object(text: &str) -> Result<RawObject<'_>> {
    serde_json::from_str(text).map_err(|error| crate::carry_cause!(Error::Corrupt, error))
}
fn raw_fields(text: &str) -> Result<stamps::Fields> {
    let object = raw_object(text)?;
    let mut fields = stamps::Fields::new();
    for (key, value) in object.object_entries() {
        fields.insert(key, serde_json::Value::String(value.get().to_owned()));
    }
    Ok(fields)
}
fn raw_text(object: &RawObject<'_>, key: &str) -> Result<Option<String>> {
    object
        .get(key)
        .filter(|v| v.get() != "null")
        .map(|raw| serde_json::from_str::<String>(raw.get()).map_err(|error| crate::carry_cause!(Error::Corrupt, error)))
        .transpose()
}
fn raw_bool(object: &RawObject<'_>, key: &str) -> Result<bool> {
    object
        .get(key)
        .map(|raw| serde_json::from_str(raw.get()).map_err(|error| crate::carry_cause!(Error::Corrupt, error)))
        .transpose()
        .map(|v| v.unwrap_or(false))
}
fn stamp_map(object: &RawObject<'_>, key: &str) -> Result<stamps::StampMap> {
    object
        .get(key)
        .filter(|v| v.get() != "null")
        .map(|raw| serde_json::from_str(raw.get()).map_err(|error| crate::carry_cause!(Error::Corrupt, error)))
        .transpose()
        .map(Option::unwrap_or_default)
}
fn canonical_cell(value: &serde_json::Value) -> Result<String> {
    let raw = value.as_str().ok_or(crate::cause!(Error::Corrupt))?;
    let parsed = ecma_json::parse(raw.as_bytes(), ecma_json::Limits::default())
        .map_err(|error| crate::carry_cause!(Error::ReplayRequired, error))?;
    ecma_json::stringify(&parsed, ecma_json::Limits::default()).map_err(|error| crate::carry_cause!(Error::ReplayRequired, error))
}
fn charge_point(meter: &mut Meter, point: &crate::legacy_kept::PointRead) -> Result<()> {
    meter.last_kept_work = Some(point.work.clone());
    meter.timing.point(&point.work);
    meter.rows = meter.rows.saturating_add(point.work.rows_returned as usize);
    meter.bytes = meter.bytes.saturating_add(point.work.source_bytes as usize);
    meter.statements = meter
        .statements
        .saturating_add(point.work.sql_statements as usize);
    meter.check_at("kept-point-budget")
}
fn checkpoint<S: BoundedRecordSql + ?Sized>(
    original: &mut S,
    meter: &mut Meter,
    id: &str,
    kept: &LegacyKept,
) -> Result<Projection> {
    let point = kept
        .point_with_budget(
            original,
            &format!("i\0{id}"),
            meter.remaining_point_budget(),
        )
        .map_err(|error| meter.kept_failure(&error))?;
    charge_point(meter, &point)?;
    checkpoint_entry(original, meter, id, kept, point.entry)
}

/// Exact value-key lookup for a compact live root pointer. Batch consumers use
/// this before decoding so the selected values can be fetched together; the
/// canonical decoder below repeats the parse and verifies the supplied key.
fn checkpoint_external_value_key(id: &str, entry: &Entry) -> Result<Option<String>> {
    let Entry::Json(raw) = entry else {
        return Ok(None);
    };
    let pointer: Vec<&RawValue> = serde_json::from_str(raw).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
    if !(2..=5).contains(&pointer.len()) {
        return Err(crate::cause!(Error::Corrupt));
    }
    if pointer[0].get() == "null" || pointer.len() >= 3 {
        return Ok(None);
    }
    let kind: String = serde_json::from_str(pointer[0].get()).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
    let sequence: String = serde_json::from_str(pointer[1].get()).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
    if !valid_id(&kind) || !valid_id(&sequence) || !valid_id(id) {
        return Err(crate::cause!(Error::Corrupt));
    }
    Ok(Some(format!("r\0{kind}\0{sequence}\0{id}")))
}

// The range owner already verified/merged checkpoint entries in this same
// source snapshot. Reuse their canonical decoder rather than locating the
// identical checkpoint key again. This helper grants no source authority.
fn checkpoint_entry<S: BoundedRecordSql + ?Sized>(
    original: &mut S,
    meter: &mut Meter,
    id: &str,
    kept: &LegacyKept,
    entry: Entry,
) -> Result<Projection> {
    checkpoint_entry_with_prefetched_value(original, meter, id, kept, entry, None)
}

fn checkpoint_entry_with_prefetched_value<S: BoundedRecordSql + ?Sized>(
    original: &mut S,
    meter: &mut Meter,
    id: &str,
    kept: &LegacyKept,
    entry: Entry,
    prefetched_value: Option<(String, Entry)>,
) -> Result<Projection> {
    let raw = match entry {
        Entry::Absent | Entry::Tombstone => return Ok(Projection::default()),
        Entry::Json(text) => Zeroizing::new(text),
    };
    let pointer: Vec<&RawValue> = serde_json::from_str(&raw).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
    if !(2..=5).contains(&pointer.len()) {
        return Err(crate::cause!(Error::Corrupt));
    }
    let meta_json = pointer
        .get(3)
        .filter(|raw| raw.get() != "null")
        .map(|raw| raw.get().to_owned());
    let meta: Option<stamps::Meta> = meta_json
        .as_deref()
        .map(|text| serde_json::from_str(text).map_err(|error| crate::carry_cause!(Error::Corrupt, error)))
        .transpose()?;
    let protected = pointer.get(4).is_some_and(|raw| raw.get() != "null");
    if pointer[0].get() == "null" {
        return Ok(Projection {
            held: Some(stamps::Kept {
                record_type: None,
                value: None,
                meta,
            }),
            protected,
            ..Projection::default()
        });
    }
    let kind: String = serde_json::from_str(pointer[0].get()).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
    let seq: String = serde_json::from_str(pointer[1].get()).map_err(|error| crate::carry_cause!(Error::Corrupt, error))?;
    if !valid_id(&kind) || !valid_id(&seq) {
        return Err(crate::cause!(Error::Corrupt));
    }
    let mut value = if pointer.len() >= 3 {
        if prefetched_value.is_some() {
            return Err(crate::cause!(Error::Corrupt));
        }
        Zeroizing::new(pointer[2].get().to_owned())
    } else {
        let expected_key = format!("r\0{kind}\0{seq}\0{id}");
        let value_entry = match prefetched_value {
            Some((key, entry)) if key == expected_key => entry,
            Some(_) => return Err(crate::cause!(Error::Corrupt)),
            None => {
                let point = kept
                    .point_with_budget(
                        original,
                        &expected_key,
                        meter.remaining_point_budget(),
                    )
                    .map_err(|error| meter.kept_failure(&error))?;
                charge_point(meter, &point)?;
                point.entry
            }
        };
        match value_entry {
            Entry::Json(text) => Zeroizing::new(text),
            Entry::Absent | Entry::Tombstone => return Ok(Projection::default()),
        }
    };
    let fields = raw_fields(&value)?;
    let record = StoredRecord {
        id: id.into(),
        record_type: kind.clone(),
        sequence: seq.clone(),
        value_json: std::mem::take(&mut *value),
        meta_json,
        protected_key_present: protected,
    };
    Ok(Projection {
        held: Some(stamps::Kept {
            record_type: Some(kind),
            value: Some(fields),
            meta,
        }),
        sequence: Some(seq),
        original: Some(record),
        protected,
        dirty: false,
    })
}
impl Projection {
    fn answer(self, id: &str, bounds: &Bounds) -> Result<Option<StoredRecord>> {
        if !self.dirty {
            return Ok(self.original);
        }
        let Some(held) = self.held else {
            return Ok(None);
        };
        let Some(kind) = held.record_type else {
            return Ok(None);
        };
        let fields = held.value.ok_or(crate::cause!(Error::Corrupt))?;
        let mut object = ecma_json::Object::new();
        for (key, raw) in fields.object_entries() {
            let value = ecma_json::parse(
                raw.as_str().ok_or(crate::cause!(Error::Corrupt))?.as_bytes(),
                ecma_json::Limits::default(),
            )
            .map_err(|error| crate::carry_cause!(Error::ReplayRequired, error))?;
            object.insert(ecma_json::JsString::from(key), value);
        }
        let value_json = ecma_json::stringify(
            &ecma_json::Value::Object(object),
            ecma_json::Limits::default(),
        )
        .map_err(|error| crate::carry_cause!(Error::Bounds, error))?;
        if value_json.len() > bounds.bytes {
            return Err(crate::cause!(Error::Bounds));
        }
        Ok(Some(StoredRecord {
            id: id.into(),
            record_type: kind,
            sequence: self.sequence.ok_or(crate::cause!(Error::Corrupt))?,
            value_json,
            meta_json: held
                .meta
                .map(|meta| serde_json::to_string(&meta).map_err(|error| crate::carry_cause!(Error::Corrupt, error)))
                .transpose()?,
            protected_key_present: self.protected,
        }))
    }
    fn apply(&mut self, id: &str, raw: &RawValue, row_id: &str, index: usize) -> Result<()> {
        let object = raw_object(raw.get())?;
        let envelope_id = raw_text(&object, "id")?.ok_or(crate::cause!(Error::Corrupt))?;
        if !valid_id(&envelope_id) {
            return Err(crate::cause!(Error::Corrupt));
        }
        if envelope_id != id {
            return Ok(());
        }
        self.apply_selected(id, row_id, index, &object)
    }
    fn apply_selected(
        &mut self,
        id: &str,
        row_id: &str,
        index: usize,
        object: &RawObject<'_>,
    ) -> Result<()> {
        self.dirty = true;
        if raw_bool(&object, "purge")? {
            self.held = None;
            self.sequence = None;
            self.protected = false;
            return Ok(());
        }
        let seq = if let Some(seq) = raw_text(&object, "seq")? {
            seq
        } else {
            sequence_from(row_id, index)?
        };
        let at = raw_text(&object, "at")?;
        let stamp = if let Some(at) = &at {
            at.clone()
        } else {
            stamps::stamp_after(
                &seq,
                self.held
                    .as_ref()
                    .and_then(|k| k.meta.as_ref())
                    .map(|m| m.at.as_str())
                    .unwrap_or(""),
            )
            .map_err(|error| crate::carry_cause!(Error::ReplayRequired, error))?
        };
        let body = if raw_bool(&object, "remove")? {
            stamps::EnvelopeBody::Remove
        } else if let Some(value) = object.get("value") {
            stamps::EnvelopeBody::Whole(raw_fields(value.get())?)
        } else {
            let set = object
                .get("set")
                .map(|value| raw_fields(value.get()))
                .transpose()?
                .unwrap_or_default();
            let unset = object
                .get("unset")
                .map(|value| {
                    serde_json::from_str::<Vec<String>>(value.get()).map_err(|error| crate::carry_cause!(Error::Corrupt, error))
                })
                .transpose()?
                .unwrap_or_default();
            stamps::EnvelopeBody::Patch { set, unset }
        };
        let envelope = stamps::Envelope {
            id: id.into(),
            record_type: raw_text(&object, "type")?,
            body,
            at,
            floor: raw_text(&object, "floor")?,
            floor_kind: object
                .get("floor_kind")
                .map(|v| serde_json::from_str(v.get()).map_err(|error| crate::carry_cause!(Error::Corrupt, error)))
                .transpose()?,
            stamps: stamp_map(&object, "stamps")?,
            removed: stamp_map(&object, "removed")?,
        };
        let before_type = self.held.as_ref().and_then(|held| held.record_type.clone());
        let incoming = stamps::state_from(&envelope, &stamp);
        let state = if raw_bool(&object, "exact")? {
            incoming
        } else {
            stamps::merge(
                &stamps::state_of(self.held.as_ref()),
                &incoming,
                &canonical_cell,
            )?
        };
        let after = stamps::kept_from(&state);
        if let Some(after) = &after {
            if after.record_type.is_some()
                && (before_type.is_none() || before_type != after.record_type)
            {
                self.sequence = Some(seq);
            }
        }
        if after.is_some() {
            self.held = after;
        }
        Ok(())
    }
}
fn sequence_from(row: &str, index: usize) -> Result<String> {
    let bytes = row.as_bytes();
    if bytes.len() != 36
        || !bytes.iter().enumerate().all(|(at, b)| {
            if [8, 13, 18, 23].contains(&at) {
                *b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
        || index > 65535
    {
        return Err(crate::cause!(Error::ReplayRequired));
    }
    Ok(format!(
        "{}{}{}{:04x}",
        &row[..8],
        &row[9..13],
        &row[15..18],
        index
    ))
}
struct PendingTail {
    id: String,
    transaction: String,
    parts: i64,
    seen: i64,
    body: String,
    key_present: Vec<String>,
}
fn replay_selected<S: BoundedRecordSql + ?Sized>(
    original: &mut S,
    source_limits: &ReadLimits,
    meter: &mut Meter,
    id: &str,
    covered: i64,
    last: i64,
    has_keys: bool,
    projection: &mut Projection,
) -> Result<()> {
    ids::replay_transactions(
        original,
        source_limits,
        meter,
        Some(id),
        covered,
        last,
        has_keys,
        |_, _, row_id, envelopes, key_present| {
            for (index, envelope) in envelopes.iter().enumerate() {
                projection.apply(id, envelope, row_id, index)?;
            }
            if key_present {
                projection.protected = true;
            }
            Ok(())
        },
    )
}

impl LegacyRecords<ReadonlyOriginal> {
    /// Preserve the existing immutable-original constructor and default type.
    pub fn open(original: ReadonlyOriginal, bounds: Bounds) -> Result<Self> {
        let limits = original.read_limits().clone();
        Self::open_with_limits(original, bounds, limits)
    }
}
impl<S: BoundedRecordSql> LegacyRecords<S> {
    /// The caller owns source selection, current rights and snapshot custody.
    /// A schema match or readable file grants no authority.
    pub fn open_source(original: S, bounds: Bounds) -> Result<Self> {
        let limits = original.read_limits().ok_or(crate::cause!(Error::Source))?.clone();
        Self::open_with_limits(original, bounds, limits)
    }
    fn open_with_limits(original: S, bounds: Bounds, source_limits: ReadLimits) -> Result<Self> {
        Self::open_with_detection(original, bounds, source_limits, true)
    }
    fn open_with_detection(
        mut original: S,
        bounds: Bounds,
        source_limits: ReadLimits,
        detect_initial: bool,
    ) -> Result<Self> {
        source_limits.validate().map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        if bounds.statements == 0
            || bounds.statements > 4096
            || bounds.rows == 0
            || bounds.rows > 30_000
            || bounds.bytes == 0
            || bounds.bytes > 32 * 1024 * 1024
            || bounds.elapsed.is_zero()
            || bounds.elapsed > Duration::from_secs(30)
        {
            return Err(crate::cause!(Error::Invalid));
        }
        if detect_initial {
            detect(&mut original, &mut Meter::new(&bounds))?;
        }
        Ok(Self {
            original,
            source_limits,
            bounds,
            last_diagnostic: None,
            last_timing: ReadTiming::default(),
        })
    }
    /// Return the held supplier so the caller can finish its own snapshot and
    /// final current-rights witness. No connection or original keys are exposed.
    pub fn into_source(self) -> S {
        self.original
    }
    pub fn engine(&mut self) -> Result<Engine> {
        detect(&mut self.original, &mut Meter::new(&self.bounds))
    }
    pub fn own_rows(&mut self, id: &str) -> Result<OwnRows> {
        if !valid_id(id) {
            return Err(crate::cause!(Error::Invalid));
        }
        let mut meter = Meter::new(&self.bounds);
        if detect(&mut self.original, &mut meter)? != Engine::Eeaf {
            return Err(crate::cause!(Error::WrongEngine));
        }
        for (table, cols) in [
            ("entity", &["id"][..]),
            ("entity_types", &["entity_id", "type_id"][..]),
            (
                "attribute_fact",
                &["subject_id", "property_id", "type_id", "value_json"][..],
            ),
            (
                "participation",
                &[
                    "id",
                    "interaction_id",
                    "participant_id",
                    "role_id",
                    "counterpart_id",
                ][..],
            ),
            (
                "interaction_set_members",
                &["set_id", "member_id", "ordinal"][..],
            ),
        ] {
            schema(&mut self.original, &mut meter, table, cols)?;
        }
        let params = [
            Value::Text(id.into()),
            Value::Text(format!("{id}/")),
            Value::Text(format!("{id}0")),
            Value::Integer(self.bounds.rows as i64 + 1),
        ];
        let entity=meter.query(&mut self.original,"SELECT e.id,t.type_id FROM entity e LEFT JOIN entity_types t ON t.entity_id=e.id WHERE e.id=? OR (e.id>=? AND e.id<?) ORDER BY e.id,t.type_id LIMIT ?",&params)?;
        let mut entities = Vec::new();
        for row in entity.rows {
            entities.push((text(&row[0])?.to_owned(), nullable_text(&row[1])?));
        }
        let fact=meter.query(&mut self.original,"SELECT subject_id,property_id,type_id,value_json FROM attribute_fact WHERE subject_id=? OR (subject_id>=? AND subject_id<?) ORDER BY subject_id,property_id,type_id LIMIT ?",&params)?;
        let mut facts = Vec::new();
        for row in fact.rows {
            facts.push(Fact {
                subject_id: text(&row[0])?.into(),
                property_id: text(&row[1])?.into(),
                type_id: text(&row[2])?.into(),
                value_json: nullable_text(&row[3])?,
            });
        }
        let part=meter.query(&mut self.original,"SELECT id,interaction_id,participant_id,role_id,counterpart_id FROM participation WHERE interaction_id=? OR (interaction_id>=? AND interaction_id<?) ORDER BY id LIMIT ?",&params)?;
        let mut participations = Vec::new();
        for row in part.rows {
            participations.push(Participation {
                id: text(&row[0])?.into(),
                interaction_id: text(&row[1])?.into(),
                participant_id: text(&row[2])?.into(),
                role_id: text(&row[3])?.into(),
                counterpart_id: nullable_text(&row[4])?,
            });
        }
        let set=meter.query(&mut self.original,"SELECT set_id,member_id,ordinal FROM interaction_set_members WHERE set_id=? OR (set_id>=? AND set_id<?) ORDER BY ordinal,set_id,member_id LIMIT ?",&params)?;
        let mut members = Vec::new();
        for row in set.rows {
            members.push(Member {
                set_id: text(&row[0])?.into(),
                member_id: text(&row[1])?.into(),
                ordinal: if matches!(row[2], SqlValue::Null) {
                    None
                } else {
                    Some(integer(&row[2])?)
                },
            });
        }
        meter.check()?;
        Ok(OwnRows {
            root_id: id.into(),
            entities,
            facts,
            participations,
            members,
        })
    }
    /// Only the immediately preceding read_stored call owns these observations.
    pub fn last_read_diagnostic(&self) -> Option<&ReadDiagnostic> {
        self.last_diagnostic.as_ref()
    }
    pub fn last_read_timing(&self) -> &ReadTiming {
        &self.last_timing
    }
    pub fn read_stored(&mut self, id: &str, kept: &LegacyKept) -> Result<Option<StoredRecord>> {
        self.read_selected(id, kept, |projection, bounds| {
            projection.answer(id, bounds)
        })
    }
    /// Current raw stamp state, including a removed record's retained floor.
    /// The same checkpoint/tail decoder is used as read_stored. Field values
    /// remain lexical JSON wrappers, not serialized user string values; key
    /// material is never returned. Actual source/rights finish stays with caller.
    pub fn read_current_projection(
        &mut self,
        id: &str,
        kept: &LegacyKept,
    ) -> Result<(Option<crate::record_log::Projected>, bool)> {
        self.read_selected(id, kept, |projection, _| {
            let protected = projection.protected;
            let current = projection.held.map(|kept| crate::record_log::Projected {
                sequence: projection.sequence,
                kept,
            });
            Ok((current, protected))
        })
    }
    fn read_selected<T>(
        &mut self,
        id: &str,
        kept: &LegacyKept,
        answer: impl FnOnce(Projection, &Bounds) -> Result<T>,
    ) -> Result<T> {
        self.last_diagnostic = None;
        self.last_timing = ReadTiming::default();
        if !valid_id(id) {
            return Err(crate::cause!(Error::Invalid));
        }
        let mut meter = Meter::new(&self.bounds);
        let result = (|| {
            if detect(&mut self.original, &mut meter)? != Engine::RecordLog {
                return Err(crate::cause!(Error::WrongEngine));
            }
            let (covered, last, has_keys) = projection_frontier(&mut self.original, &mut meter)?;
            let mut projection = checkpoint(&mut self.original, &mut meter, id, kept)?;
            if last > covered {
                replay_selected(
                    &mut self.original,
                    &self.source_limits,
                    &mut meter,
                    id,
                    covered,
                    last,
                    has_keys,
                    &mut projection,
                )?;
            }
            meter.query(&mut self.original, "SELECT 1", &[])?;
            let answer = answer(projection, &self.bounds).map_err(|error| {
                if matches!(error, Error::Bounds(_)) {
                    meter.bounds_failure(
                        "record-answer-budget",
                        "original record answer materialization exceeded bounds",
                    )
                } else {
                    error
                }
            })?;
            meter.check_at("record-complete-budget")?;
            Ok(answer)
        })();
        meter.timing.elapsed_us = meter.started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        self.last_timing = meter.timing;
        self.last_diagnostic = meter.diagnostic;
        result
    }
    /// Original decomposed row history, exact physical record identity. This
    /// does not assemble historical private fields or bypass destroyed-key rules.
    pub fn history(
        &mut self,
        table: &str,
        record_id: &str,
        after: i64,
        limit: usize,
    ) -> Result<HistoryPage> {
        if !valid_id(record_id) || after < 0 || limit == 0 || limit > 512 {
            return Err(crate::cause!(Error::Invalid));
        }
        let mut meter = Meter::new(&self.bounds);
        if table != "bitemporal_facts" {
            let suffix = table
                .strip_prefix("bitemporal_facts_sealed_")
                .ok_or(crate::cause!(Error::Invalid))?;
            if suffix.is_empty()
                || !suffix
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            {
                return Err(crate::cause!(Error::Invalid));
            }
        }
        schema(
            &mut self.original,
            &mut meter,
            table,
            &[
                "id",
                "record_id",
                "table_name",
                "patch",
                "transaction_id",
                "actor_context",
                "application_time",
                "system_time",
            ],
        )?;
        let query=format!("SELECT rowid,id,record_id,table_name,patch,transaction_id,actor_context,application_time,system_time FROM {table} WHERE record_id=? AND rowid>? ORDER BY rowid LIMIT ?");
        let result = meter.query(
            &mut self.original,
            &query,
            &[
                Value::Text(record_id.into()),
                Value::Integer(after),
                Value::Integer(limit as i64 + 1),
            ],
        )?;
        let more = result.rows.len() > limit;
        let mut rows = Vec::new();
        for row in result.rows.into_iter().take(limit) {
            rows.push(HistoryRow {
                rowid: integer(&row[0])?,
                id: text(&row[1])?.into(),
                record_id: text(&row[2])?.into(),
                table_name: text(&row[3])?.into(),
                patch: text(&row[4])?.into(),
                transaction_id: text(&row[5])?.into(),
                actor_context: text(&row[6])?.into(),
                application_time: text(&row[7])?.into(),
                system_time: text(&row[8])?.into(),
            });
        }
        let next = if more {
            rows.last().map(|r| r.rowid)
        } else {
            None
        };
        Ok(HistoryPage {
            table: table.into(),
            rows,
            next,
        })
    }
}
