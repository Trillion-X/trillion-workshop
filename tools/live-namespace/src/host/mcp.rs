// src/host/mcp.rs
//
// Purpose: The bounds and shapes this tool takes from the engine's MCP surface (src/mcp.rs of Trillion-X/trillion-rust at
// 5fbc2ff4b1): one MCP message is at most `MAX_MESSAGE_BYTES`, a tool answer leaves room for its envelope
// (`tool_answer_fits`), the refusal an
// operation answers with (`OperationFailure`) and the field-and-shape fault of a call's input (`InputFault`).
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde_json::{json, Value};

pub const MAX_MESSAGE_BYTES: usize = 65_536;
/// The room a tool result leaves for its JSON-RPC envelope and the request's ID.
const TOOL_ENVELOPE_RESERVE: usize = 1_024;

/// Whether `answer`, one resource operation's answer, fits one MCP message as the tool result that carries it twice
/// (its JSON text and its structured content), with room left for the envelope and the request's ID. A read that
/// pages fills each page by this, so its answer never turns into an unknown outcome by its size.
pub fn tool_answer_fits(answer: &Value) -> bool {
    let limit = MAX_MESSAGE_BYTES - TOOL_ENVELOPE_RESERVE;
    let Some(text) = encode_with_limit(answer, limit) else {
        return false;
    };
    let result = json!({"content":[{"type":"text","text":String::from_utf8_lossy(&text)}],
        "structuredContent":answer,"isError":false,"resultType":"complete"});
    encode_with_limit(&result, limit).is_some()
}

/// One encoding owner for both message classes. Callers supply only the
/// source-owned protocol limits, never a limit from a request or app input.
pub(crate) fn encode_with_limit(value: &Value, limit: usize) -> Option<Vec<u8>> {
    enum Part<'a> {
        Value(&'a Value),
        Array(std::slice::Iter<'a, Value>, bool),
        Object(serde_json::map::Iter<'a>, bool),
    }
    fn append(out: &mut Vec<u8>, bytes: &[u8], limit: usize) -> Option<()> {
        if bytes.len() > limit - out.len() {
            return None;
        }
        out.extend_from_slice(bytes);
        Some(())
    }
    fn string(out: &mut Vec<u8>, value: &str, limit: usize) -> Option<()> {
        append(out, b"\"", limit)?;
        const HEX: &[u8; 16] = b"0123456789abcdef";
        for byte in value.bytes() {
            match byte {
                b'"' => append(out, b"\\\"", limit)?,
                b'\\' => append(out, b"\\\\", limit)?,
                b'\x08' => append(out, b"\\b", limit)?,
                b'\t' => append(out, b"\\t", limit)?,
                b'\n' => append(out, b"\\n", limit)?,
                b'\x0c' => append(out, b"\\f", limit)?,
                b'\r' => append(out, b"\\r", limit)?,
                0..=31 => append(
                    out,
                    &[
                        b'\\',
                        b'u',
                        b'0',
                        b'0',
                        HEX[(byte >> 4) as usize],
                        HEX[(byte & 15) as usize],
                    ],
                    limit,
                )?,
                _ => append(out, &[byte], limit)?,
            }
        }
        append(out, b"\"", limit)
    }
    let mut out = Vec::with_capacity(limit.min(MAX_MESSAGE_BYTES));
    let mut stack = vec![Part::Value(value)];
    while let Some(part) = stack.pop() {
        match part {
            Part::Value(Value::Null) => append(&mut out, b"null", limit)?,
            Part::Value(Value::Bool(value)) => {
                append(&mut out, if *value { b"true" } else { b"false" }, limit)?
            }
            Part::Value(Value::Number(value)) => {
                append(&mut out, value.to_string().as_bytes(), limit)?
            }
            Part::Value(Value::String(value)) => string(&mut out, value, limit)?,
            Part::Value(Value::Array(values)) => {
                append(&mut out, b"[", limit)?;
                stack.push(Part::Array(values.iter(), true));
            }
            Part::Value(Value::Object(values)) => {
                append(&mut out, b"{", limit)?;
                stack.push(Part::Object(values.iter(), true));
            }
            Part::Array(mut values, first) => match values.next() {
                Some(value) => {
                    if !first {
                        append(&mut out, b",", limit)?;
                    }
                    stack.push(Part::Array(values, false));
                    stack.push(Part::Value(value));
                }
                None => append(&mut out, b"]", limit)?,
            },
            Part::Object(mut values, first) => match values.next() {
                Some((key, value)) => {
                    if !first {
                        append(&mut out, b",", limit)?;
                    }
                    string(&mut out, key, limit)?;
                    append(&mut out, b":", limit)?;
                    stack.push(Part::Object(values, false));
                    stack.push(Part::Value(value));
                }
                None => append(&mut out, b"}", limit)?,
            },
        }
    }
    Some(out)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Operation {
    pub resource: String,
    pub operation: String,
    pub request_key: String,
    pub input: Value,
    /// A confirmation by the person present, carried beside `request_key` (never in `input`, so a retry of a refused
    /// write with the same request key and input is the same command): {nonce, assertion}
    /// (`account::person_present::REQUEST_FIELD`). Only the records-write authority reads it.
    pub person_present: Option<Value>,
}

/// What was wrong with a call's input, said by field name and expected shape only (never a value): the field the
/// parse stopped at (`(input)` for the input as a whole) and what that field must be. Answered in the refusal's
/// `structuredContent.detail` as `{field, expected}`, so a caller fixes the call from the answer.
#[derive(Debug, Clone)]
pub struct InputFault {
    pub field: String,
    pub expected: String,
    cause: crate::refusal_cause::Cause,
}
impl PartialEq for InputFault {
    fn eq(&self, other: &Self) -> bool { self.field == other.field && self.expected == other.expected }
}
impl Eq for InputFault {}

impl InputFault {
    #[track_caller]
    pub fn new(field: impl Into<String>, expected: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            expected: expected.into(),
            cause: crate::refusal_cause::Cause::from_caller(),
        }
    }

    /// The refusal that carries this fault: `original_input_refused`, a known no-effect refusal.
    pub fn into_failure(self) -> OperationFailure {
        OperationFailure { cause: self.cause,
            code: "original_input_refused".into(),
            outcome_unknown: false,
            detail: Some(serde_json::json!({"field": self.field, "expected": self.expected})),
        }
    }
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause.clone() }
}
crate::impl_caused!(InputFault);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationFailure {
    pub code: String,
    pub cause: crate::refusal_cause::ReportedCause,
    pub outcome_unknown: bool,
    /// What the refusal names to its caller (the person's own field and value for a write outside its choices):
    /// answered in the result's `structuredContent.detail`, never logged. `_effect_outcome` is reserved for this
    /// engine's effect declaration and consumed by the encoder; caller data belongs under its named field.
    pub detail: Option<Value>,
}

