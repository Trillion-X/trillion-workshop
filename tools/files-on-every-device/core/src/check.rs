//! The checked copy: a span answer is handed on only when it is exactly the bytes asked for (f1's DriveRangeCopy, the
//! strongest piece of the old client: partial answer, its range, its version, its length).
//!
//! Invariants
//!   - The answer names the content identity asked for (the version: a file changed meanwhile never mixes bytes).
//!   - It starts at the offset asked, for a file of the size known, and carries exactly the length asked, counted
//!     twice: the length it says it returned and the bytes it holds.
//!   - A failed check hands nothing over and changes nothing else: one bad answer never poisons the item (f1 bug 16).

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::Value;

use crate::data::Contract;
use crate::ranges::Span;

/// What one span read asked for.
#[derive(Clone, Debug, PartialEq)]
pub struct Asked {
    pub identity: String,
    pub span: Span,
    pub size: u64,
}

/// Why an answer was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    OtherVersion,
    OtherOffset,
    OtherSize,
    OtherLength,
    NotBase64,
}

/// The bytes of a span answer that passed every check.
pub fn checked_span(contract: &Contract, asked: &Asked, answer: &Value) -> Result<Vec<u8>, Refusal> {
    let number = |job: &str| answer.get(contract.field(job)).and_then(Value::as_u64);
    if answer.get(contract.field("identity")).and_then(Value::as_str) != Some(asked.identity.as_str()) {
        return Err(Refusal::OtherVersion);
    }
    if number("span_offset") != Some(asked.span.start) {
        return Err(Refusal::OtherOffset);
    }
    if number("byte_length") != Some(asked.size) {
        return Err(Refusal::OtherSize);
    }
    if number("span_returned") != Some(asked.span.len()) {
        return Err(Refusal::OtherLength);
    }
    let content = answer
        .get(contract.field("span_content"))
        .and_then(Value::as_str)
        .ok_or(Refusal::NotBase64)?;
    let bytes = BASE64.decode(content).map_err(|_| Refusal::NotBase64)?;
    if bytes.len() as u64 != asked.span.len() {
        return Err(Refusal::OtherLength);
    }
    Ok(bytes)
}
