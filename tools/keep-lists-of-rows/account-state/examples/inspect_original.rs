// examples/inspect_original.rs
//
// Purpose: Inspect one explicitly pinned original SQLite object through bounded private stdin and emit only a redacted summary.
//
// Non-Negotiable Invariants:
// - Read the account, receipt and object pins from the private request rather than argv.
// - Preserve exact typed query results for the summary hash without printing original values.
// - Require pinned quiescent-sidecar authority and refuse non-SELECT requests on this narrow CLI.
//
// Key Concepts:
// - Read-only NativeCatalog admission and bound parameters.
// - Typed-result BLAKE3, row/column counts and generic refusal output.
//
// Security Considerations:
// - Never print original paths, SQL, identifiers, tokens or values in errors.
// - Success for one pinned object does not prove whole-account migration or application recovery.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! Private stdin-only inspection of one explicitly pinned original SQLite object.
//! Success stdout contains counts and a typed-result BLAKE3, never original data.
//! Quiescent sidecar authority comes only from the pinned importer receipt.
use rusqlite::types::Value;
use content_crypto::advanced::blake3;
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::time::Duration;
use trillion_local::import::{
    AccountIdentity, FilePin, ImportError, NativeCatalog, QueryRows, ReadLimits, SqlValue,
};

const MAX_REQUEST_BYTES: usize = 128 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PinInput {
    bytes: u64,
    blake3: String,
}
impl From<PinInput> for FilePin {
    fn from(value: PinInput) -> Self {
        Self {
            bytes: value.bytes,
            blake3: value.blake3,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AccountInput {
    user_id: String,
    owner_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ObjectInput {
    binding: String,
    original_id: String,
    sqlite: PinInput,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryInput {
    sql: String,
    params: Vec<SqlValue>,
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct LimitsInput {
    rows: Option<usize>,
    columns: Option<usize>,
    result_bytes: Option<usize>,
    cell_bytes: Option<usize>,
    sql_bytes: Option<usize>,
    vm_steps: Option<u64>,
    elapsed_ms: Option<u64>,
}
impl LimitsInput {
    fn into_limits(self) -> ReadLimits {
        let mut limits = ReadLimits::default();
        if let Some(value) = self.rows {
            limits.rows = value;
        }
        if let Some(value) = self.columns {
            limits.columns = value;
        }
        if let Some(value) = self.result_bytes {
            limits.result_bytes = value;
        }
        if let Some(value) = self.cell_bytes {
            limits.cell_bytes = value;
        }
        if let Some(value) = self.sql_bytes {
            limits.sql_bytes = value;
        }
        if let Some(value) = self.vm_steps {
            limits.vm_steps = value;
        }
        if let Some(value) = self.elapsed_ms {
            limits.elapsed = Duration::from_millis(value);
        }
        limits
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: String,
    state: PathBuf,
    receipt: PinInput,
    account: AccountInput,
    object: ObjectInput,
    query: QueryInput,
    #[serde(default)]
    limits: LimitsInput,
}
#[derive(Serialize)]
struct TypedResult<'a> {
    columns: &'a [String],
    rows: &'a [Vec<SqlValue>],
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Summary {
    rows: usize,
    columns: usize,
    typed_result_blake3: String,
}

// These phases are fixed literals. The ImportError Display contract contains
// only static refusal text, generic I/O kind, or generic SQL/JSON failure; never
// use its Debug implementation or forward request/parser/SQLite detail text.
struct Diagnostic {
    phase: &'static str,
    import: Option<ImportError>,
}
impl Diagnostic {
    fn phase(phase: &'static str) -> Self {
        Self {
            phase,
            import: None,
        }
    }
    fn import(phase: &'static str, error: ImportError) -> Self {
        Self {
            phase,
            import: Some(error),
        }
    }
}
impl std::fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "inspection refused [{}]", self.phase)?;
        if let Some(error) = &self.import {
            write!(f, ": {error}")?;
        }
        Ok(())
    }
}

fn bind(value: SqlValue) -> Result<Value, ()> {
    match value {
        SqlValue::Null => Ok(Value::Null),
        SqlValue::Integer(value) => Ok(Value::Integer(value)),
        SqlValue::RealBits(bits) => {
            let number = f64::from_bits(bits);
            // SQLite binds NaN as NULL; refuse that implicit type change.
            if number.is_nan() {
                Err(())
            } else {
                Ok(Value::Real(number))
            }
        }
        SqlValue::Text(bytes) => String::from_utf8(bytes).map(Value::Text).map_err(|_| ()),
        SqlValue::Blob(bytes) => Ok(Value::Blob(bytes)),
    }
}
fn summarize(result: &QueryRows) -> Result<Summary, ()> {
    // Progress callbacks are an execution observation, not part of original data.
    let bytes = serde_json::to_vec(&TypedResult {
        columns: &result.columns,
        rows: &result.rows,
    })
    .map_err(|_| ())?;
    Ok(Summary {
        rows: result.rows.len(),
        columns: result.columns.len(),
        typed_result_blake3: blake3::hash(&bytes).to_hex().to_string(),
    })
}
fn inspect(input: impl Read) -> Result<Summary, Diagnostic> {
    let mut bytes = Vec::new();
    input
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| Diagnostic::phase("input"))?;
    if bytes.is_empty() || bytes.len() > MAX_REQUEST_BYTES {
        return Err(Diagnostic::phase("input"));
    }
    let request: Request =
        serde_json::from_slice(&bytes).map_err(|_| Diagnostic::phase("input"))?;
    if request.version != "trillion.inspect-original/v1" {
        return Err(Diagnostic::phase("input"));
    }
    let sql = request.query.sql.trim_start();
    // The library can read schema pragmas too; this narrow CLI accepts SELECT.
    // Require a keyword boundary and use bound parameters for arbitrary values.
    if !sql
        .as_bytes()
        .get(..6)
        .is_some_and(|head| head.eq_ignore_ascii_case(b"SELECT"))
        || !sql.as_bytes().get(6).is_some_and(u8::is_ascii_whitespace)
    {
        return Err(Diagnostic::phase("select-input"));
    }
    let params = request
        .query
        .params
        .into_iter()
        .map(bind)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| Diagnostic::phase("parameters"))?;
    let catalog = NativeCatalog::open(
        request.state,
        request.receipt.into(),
        AccountIdentity {
            user_id: request.account.user_id,
            owner_id: request.account.owner_id,
        },
        request.limits.into_limits(),
    )
    .map_err(|error| Diagnostic::import("catalog", error))?;
    let mut original = catalog
        .open_object(
            &request.object.binding,
            &request.object.original_id,
            request.object.sqlite.into(),
        )
        .map_err(|error| Diagnostic::import("object", error))?;
    let result = original
        .query(sql, &params)
        .map_err(|error| Diagnostic::import("query", error))?;
    summarize(&result).map_err(|_| Diagnostic::phase("summary"))
}
fn main() {
    // No request paths, SQL, object IDs, pins or tokens belong in argv or errors.
    let result = if std::env::args_os().count() == 1 {
        inspect(io::stdin().lock())
    } else {
        Err(Diagnostic::phase("arguments"))
    };
    let output = result.and_then(|summary| {
        let mut bytes = serde_json::to_vec(&summary).map_err(|_| Diagnostic::phase("output"))?;
        bytes.push(b'\n');
        io::stdout()
            .lock()
            .write_all(&bytes)
            .map_err(|_| Diagnostic::phase("output"))
    });
    if let Err(error) = output {
        let _ = writeln!(io::stderr().lock(), "{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn summary_discloses_only_counts_and_digest() {
        let result = QueryRows {
            columns: vec!["private-column-sentinel".into()],
            rows: vec![vec![SqlValue::Text(b"private-value-sentinel".to_vec())]],
            progress_callbacks: 3,
        };
        let output = serde_json::to_string(&summarize(&result).unwrap()).unwrap();
        assert!(!output.contains("private-column-sentinel"));
        assert!(!output.contains("private-value-sentinel"));
        let decoded: Summary = serde_json::from_str(&output).unwrap();
        assert_eq!(decoded.rows, 1);
        assert_eq!(decoded.columns, 1);
        assert_eq!(decoded.typed_result_blake3.len(), 64);
        let mut changed_progress = result;
        changed_progress.progress_callbacks = 900;
        assert_eq!(
            decoded.typed_result_blake3,
            summarize(&changed_progress).unwrap().typed_result_blake3
        );
    }
    #[test]
    fn malformed_oversized_and_extra_argument_data_never_become_error_details() {
        assert!(inspect(&b"private-invalid-request"[..]).is_err());
        assert!(inspect(vec![b'x'; MAX_REQUEST_BYTES + 1].as_slice()).is_err());
        assert!(inspect(&b"{}"[..]).is_err());
    }
    #[test]
    fn binding_refuses_implicit_nan_or_invalid_utf8_text_conversion() {
        assert!(bind(SqlValue::RealBits(f64::NAN.to_bits())).is_err());
        assert!(bind(SqlValue::Text(vec![128, 255])).is_err());
        assert!(matches!(
            bind(SqlValue::Integer(i64::MAX)),
            Ok(Value::Integer(i64::MAX))
        ));
    }
    #[test]
    fn diagnostics_expose_fixed_phase_and_sanitized_import_display_only() {
        let input = inspect(&b"private-request-sentinel"[..])
            .err()
            .unwrap()
            .to_string();
        assert_eq!(input, "inspection refused [input]");
        let io = ImportError::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "private-path-sentinel",
        ), trillion_local::cause!());
        let output = Diagnostic::import("catalog", io).to_string();
        assert!(output.contains("[catalog]"));
        assert!(output.contains("PermissionDenied"));
        assert!(!output.contains("private-path-sentinel"));
        let json_error =
            serde_json::from_str::<serde_json::Value>("private-json-sentinel").unwrap_err();
        let json_error = ImportError::Json(json_error, trillion_local::cause!());
        let json_cause = json_error.cause();
        assert_eq!(
            Diagnostic::import("object", json_error).to_string(),
            format!("inspection refused [object]: original metadata is invalid JSON cause={json_cause}")
        );
        let refused = ImportError::Refused("query result exceeds its byte bound", trillion_local::cause!());
        let refusal_cause = refused.cause();
        assert_eq!(
            Diagnostic::import("query", refused).to_string(),
            format!("inspection refused [query]: query result exceeds its byte bound cause={refusal_cause}")
        );
    }
}
