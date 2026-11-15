//! Unpersisted ordinary managed-browser execution metadata.
//! Source: execution-context.mjs and native-managed-source.mjs. Constructing a
//! value here neither authorizes work nor proves that capture was persisted.
//! The original record/command transaction must append it before dispatch.
use crate::ecma_json::{self, JsString, Object, Value};
use chrono::{Datelike, Timelike, Utc};
use std::fmt;

const ID_UNITS: usize = 8192;
const LABEL_UNITS: usize = 512;
const MAX_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    Invalid(crate::refusal_cause::Cause),
    Bounds(crate::refusal_cause::Cause),
    UnsupportedTime(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Invalid(cause) => cause,
            Self::Bounds(cause) => cause,
            Self::UnsupportedTime(cause) => cause,
        }
    }
}
crate::impl_caused!(Error);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} cause={}", match self {
            Self::Invalid(_) => "execution metadata input refused",
            Self::Bounds(_) => "execution metadata exceeds bounds",
            Self::UnsupportedTime(_) => "execution metadata time unavailable",
        }, self.cause())
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy)]
pub enum Origin {
    Real,
    Synthetic,
    Unknown,
}
impl Origin {
    fn text(self) -> &'static str {
        match self {
            Self::Real => "real",
            Self::Synthetic => "synthetic",
            Self::Unknown => "unknown",
        }
    }
}
#[derive(Clone, Copy)]
pub enum AppBasis {
    Authenticated,
    ClientDeclared,
    Unknown,
}
impl AppBasis {
    fn text(self) -> &'static str {
        match self {
            Self::Authenticated => "authenticated",
            Self::ClientDeclared => "client_declared",
            Self::Unknown => "unknown",
        }
    }
}
#[derive(Clone, Copy)]
pub enum Phase {
    Dispatching,
    Returned,
    Failed,
    Unknown,
    Recorded,
}
impl Phase {
    fn text(self) -> &'static str {
        match self {
            Self::Dispatching => "dispatching",
            Self::Returned => "returned",
            Self::Failed => "failed",
            Self::Unknown => "unknown",
            Self::Recorded => "recorded",
        }
    }
}

/// Original identities from the admitted caller. These fields are not a grant;
/// the native context must derive them after fresh selection/browser checks.
/// No input, output, token, header collection or transcript is accepted here.
pub struct ManagedBrowser<'a> {
    pub call_id: &'a JsString,
    pub request_id: &'a JsString,
    pub operation: &'a JsString,
    pub reader: &'a JsString,
    pub app: Option<&'a JsString>,
    pub app_basis: AppBasis,
    pub origin: Origin,
}
pub struct RecordDraft {
    pub id: JsString,
    pub record_type: &'static str,
    pub value: Value,
}
impl fmt::Debug for RecordDraft {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ExecutionRecordDraft([unpersisted, redacted])")
    }
}
pub struct UpdateDraft {
    pub record: RecordDraft,
    /// Matches updateExecution's timestamp-only no-write decision.
    pub changed: bool,
}
impl fmt::Debug for UpdateDraft {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ExecutionUpdateDraft([unpersisted, redacted])")
    }
}

fn text(value: &str) -> Value {
    Value::String(value.into())
}
fn put(object: &mut Object, name: &str, value: Value) {
    object.insert(name.into(), value);
}
fn get<'a>(object: &'a Object, name: &str) -> Option<&'a Value> {
    object.get(&name.into())
}
fn checked(value: &JsString, maximum: usize) -> Result<Value> {
    if value.is_empty() {
        return Err(crate::cause!(Error::Invalid));
    }
    if value.len() > maximum {
        return Err(crate::cause!(Error::Bounds));
    }
    Ok(Value::String(value.clone()))
}
fn limits() -> ecma_json::Limits {
    ecma_json::Limits {
        input_bytes: MAX_BYTES,
        output_bytes: MAX_BYTES,
        depth: 64,
        nodes: 100_000,
        string_units: MAX_BYTES,
        total_string_units: MAX_BYTES,
        container_entries: 100_000,
        number_bytes: ecma_json::HARD_NUMBER_BYTES,
    }
}
fn encoded(value: &Value) -> Result<String> {
    ecma_json::stringify(value, limits()).map_err(|error| Error::Bounds(error.cause()))
}
pub(crate) fn reference(id: &JsString) -> Result<JsString> {
    checked(id, ID_UNITS)?;
    let prefix = JsString::from("execution:");
    let result = if id.units().starts_with(prefix.units()) {
        id.clone()
    } else {
        let mut units = prefix.units().to_vec();
        units.extend_from_slice(id.units());
        JsString::from_units(units)
    };
    checked(&result, ID_UNITS)?;
    Ok(result)
}
fn iso(now_ms: i64) -> Result<String> {
    if i128::from(now_ms).abs() > 8_640_000_000_000_000 {
        return Err(crate::cause!(Error::UnsupportedTime));
    }
    let date =
        chrono::DateTime::<Utc>::from_timestamp_millis(now_ms).ok_or(crate::cause!(Error::UnsupportedTime))?;
    let year = date.year();
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!(
            "{}{:06}",
            if year < 0 { "-" } else { "+" },
            year.unsigned_abs()
        )
    };
    Ok(format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        date.month(),
        date.day(),
        date.hour(),
        date.minute(),
        date.second(),
        date.timestamp_subsec_millis()
    ))
}

/// Port of the ordinary managed source (no registered agent card or requested
/// retention capture). Recorder authentication and actor evidence stay distinct:
/// the caller supplies an authenticated reader; the source actor remains unknown.
pub fn begin(input: &ManagedBrowser<'_>, now_ms: i64) -> Result<RecordDraft> {
    let id = reference(input.call_id)?;
    let now = iso(now_ms)?;
    let mut recorder = Object::new();
    put(&mut recorder, "reader", checked(input.reader, ID_UNITS)?);
    if let Some(app) = input.app.filter(|app| !app.is_empty()) {
        put(&mut recorder, "app", checked(app, LABEL_UNITS)?);
    }
    put(&mut recorder, "basis", text("authenticated"));
    put(&mut recorder, "app_basis", text(input.app_basis.text()));
    let mut actor = Object::new();
    put(&mut actor, "basis", text("unknown"));
    let mut coverage = Object::new();
    put(&mut coverage, "before_dispatch", Value::Bool(true));
    put(&mut coverage, "input_output", text("not_captured"));
    put(&mut coverage, "native_host", text("managed_boundary_only"));
    let mut record = Object::new();
    put(&mut record, "execution_ref", Value::String(id.clone()));
    put(&mut record, "call_id", checked(input.call_id, ID_UNITS)?);
    put(
        &mut record,
        "operation",
        checked(input.operation, LABEL_UNITS)?,
    );
    put(
        &mut record,
        "request_id",
        checked(input.request_id, ID_UNITS)?,
    );
    put(&mut record, "capture_kind", text("managed_dispatch"));
    put(&mut record, "origin", text(input.origin.text()));
    put(&mut record, "captured_at", text(&now));
    put(&mut record, "recorder", Value::Object(recorder));
    put(&mut record, "actor", Value::Object(actor));
    put(&mut record, "phase", text("dispatching"));
    put(&mut record, "links", Value::Object(Object::new()));
    put(&mut record, "created_at", text(&now));
    put(&mut record, "updated_at", text(&now));
    put(&mut record, "coverage", Value::Object(coverage));
    let value = Value::Object(record);
    encoded(&value)?;
    Ok(RecordDraft {
        id,
        record_type: "execution",
        value,
    })
}

fn without_updated_at(object: &Object) -> Value {
    let mut result = Object::new();
    for (key, value) in object.insertion_entries() {
        if key != &JsString::from("updated_at") {
            result.insert(key.clone(), value.clone());
        }
    }
    Value::Object(result)
}
/// Ordinary source terminal update: no output capture, Activity or claimed
/// provider observation is synthesized. Keep the actual prior execution value.
/// The journal/result owner must persist this together with its known outcome.
pub fn finish(
    prior: &Value,
    execution_ref: &JsString,
    phase: Phase,
    error_code: Option<&JsString>,
    now_ms: i64,
) -> Result<UpdateDraft> {
    encoded(prior)?; // bounds BEFORE clones/materialization
    let Value::Object(prior) = prior else {
        return Err(crate::cause!(Error::Invalid));
    };
    let id = reference(execution_ref)?;
    if get(prior, "execution_ref") != Some(&Value::String(id.clone())) {
        return Err(crate::cause!(Error::Invalid));
    }
    let mut next = prior.clone();
    put(&mut next, "phase", text(phase.text()));
    match get(prior, "links") {
        None | Some(Value::Null) => put(&mut next, "links", Value::Object(Object::new())),
        Some(Value::Object(_)) => {}
        _ => return Err(crate::cause!(Error::Invalid)),
    }
    put(&mut next, "updated_at", text(&iso(now_ms)?));
    if let Some(code) = error_code.filter(|code| !code.is_empty()) {
        put(&mut next, "error_code", checked(code, LABEL_UNITS)?);
    }
    let changed = encoded(&without_updated_at(prior))? != encoded(&without_updated_at(&next))?;
    let value = Value::Object(if changed { next } else { prior.clone() });
    encoded(&value)?;
    Ok(UpdateDraft {
        record: RecordDraft {
            id,
            record_type: "execution",
            value,
        },
        changed,
    })
}
