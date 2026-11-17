//! The checked copy: a span answer is handed on only when it is exactly the bytes asked for (f1's DriveRangeCopy, the
//! strongest piece of the old client: partial answer, its range, its version, its length).
//!
//! Invariants
//!   - The answer is raw bytes (contract.json `raw.content_type`) of the version asked: it names the content identity
//!     it was read from (`raw.identity`), and a file changed meanwhile never mixes bytes.
//!   - It starts at the offset asked (`raw.offset`), for a file of the size known (`raw.total`), and carries exactly
//!     the length asked.
//!   - A failed check hands nothing over and changes nothing else: one bad answer never poisons the item (f1 bug 16).

use std::collections::BTreeMap;

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
    NotRaw,
    OtherVersion,
    OtherOffset,
    OtherSize,
    OtherLength,
}

/// Whether an answer, by its headers, is raw bytes at all (else it is the door's JSON: a refusal, or nothing the read
/// asked).
pub fn is_raw(contract: &Contract, headers: &BTreeMap<String, String>) -> bool {
    headers.get("content-type").is_some_and(|kind| kind.split(';').next().is_some_and(|kind| kind.trim() == contract.raw.content_type))
}

/// The bytes of a raw span answer that passed every check.
pub fn checked_span(contract: &Contract, asked: &Asked, headers: &BTreeMap<String, String>, body: &[u8]) -> Result<Vec<u8>, Refusal> {
    if !is_raw(contract, headers) {
        return Err(Refusal::NotRaw);
    }
    if headers.get(&contract.raw.identity).map(|identity| identity.trim()) != Some(asked.identity.as_str()) {
        return Err(Refusal::OtherVersion);
    }
    let number = |name: &str| headers.get(name).and_then(|value| value.trim().parse::<u64>().ok());
    if number(&contract.raw.offset) != Some(asked.span.start) {
        return Err(Refusal::OtherOffset);
    }
    if number(&contract.raw.total) != Some(asked.size) {
        return Err(Refusal::OtherSize);
    }
    if body.len() as u64 != asked.span.len() {
        return Err(Refusal::OtherLength);
    }
    Ok(body.to_vec())
}
