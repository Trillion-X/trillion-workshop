// Purpose: Supply the provider-neutral versioned-record contract consumed by admitted operations and local transports.
//
// Non-Negotiable Invariants:
// - Keep logical account/resource scope, values, history and retry identity independent of storage and transport.
// - A supplier must recheck fresh admission inside its real commitment boundary and before recovered-receipt disclosure.
// - Return complete bounded pages with explicit continuation; this record contract is not full EEAF parity.
//
// Key Concepts:
// - Compare-and-swap versions and stable request keys.
// - Serialized item-array bounds, supplier-labelled observations and commit context.
//
// Security Considerations:
// - Local methods assume an already trusted fixed-scope host; they do not issue account authority.
// - Unavailable or uncertain outcomes must not become a new effect with a new retry identity.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! Purpose: supply versioned records to admitted resources and local transports.
//! Invariants: logical scope, values, history and continuation are independent
//! of database, vendor, transport and physical placement. No provider branches.
//! Key concepts: CAS, stable retry identity, atomic record/history commitment,
//! bounded complete pages and supplier-specific work observations.
//! Security: a supply must preserve fresh admission checks inside its real
//! transaction and before retry disclosure; a trait implementation alone does
//! not prove eligibility. This record slice is not whole EEAF semantic parity.
pub mod changes;
pub mod shipped_defaults;
#[cfg(not(hosted_records))]
pub(crate) mod process_identity;

use crate::resource_authority::{AdmittedCall, Refusal, Route, Scope};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

pub const MAX_RECORD_BYTES: usize = 1024 * 1024;
/// Serialized item array, including delimiters; continuation/envelope is extra.
pub const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_PAGE_ITEMS: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Record {
    pub id: String,
    pub version: i64,
    pub value: Value,
}

#[derive(Debug, Serialize)]
pub struct Read<W = Value> {
    pub record: Option<Record>,
    /// Supplier-labelled observations, never inferred provider invoice units.
    pub work: W,
}
impl<W> Read<W> {
    pub fn map_work<U>(self, map: impl FnOnce(W) -> U) -> Read<U> {
        Read { record: self.record, work: map(self.work) }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Change {
    pub sequence: i64,
    pub id: String,
    pub version: i64,
    pub deleted: bool,
    pub value: Option<Value>,
}

#[derive(Debug, Serialize)]
pub struct Page<T, C, W = Value> {
    pub items: Vec<T>,
    /// Resume strictly after this item; None means this observed page is final.
    /// Pages do not promise a stable snapshot across concurrent mutations.
    pub next: Option<C>,
    pub serialized_item_bytes: usize,
    pub work: W,
}
impl<T, C, W> Page<T, C, W> {
    pub fn map_work<U>(self, map: impl FnOnce(W) -> U) -> Page<T, C, U> {
        Page { items: self.items, next: self.next,
            serialized_item_bytes: self.serialized_item_bytes, work: map(self.work) }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mutation {
    pub id: String,
    pub expected_version: i64,
    pub request_key: String,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub value: Value,
}

/// Resource authority supplies current route/clock synchronously. A storage
/// implementation must call this context from inside its commitment boundary,
/// before reading a retry receipt, before disclosing it, and before new commit.
pub trait CommitContext {
    fn current_route(&self, scope: &Scope) -> Option<Route>;
    fn now_ms(&self) -> i64;
}

/// The transport receives domain failures, never database or filesystem errors.
#[derive(Debug, Clone)]
pub enum Error {
    Conflict(crate::refusal_cause::Cause),
    Invalid(&'static str, crate::refusal_cause::Cause),
    Refused(Refusal, crate::refusal_cause::Cause),
    Unavailable(crate::refusal_cause::Cause),
    /// An attempted operation may have committed; retry its original key.
    OutcomeUnknown(crate::refusal_cause::Cause),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict(_) => f.write_str("record version or request identity conflicts"),
            Self::Invalid(message, _) => f.write_str(message),
            Self::Refused(_, _) => f.write_str("record operation not admitted"),
            Self::Unavailable(_) => f.write_str("record supply unavailable"),
            Self::OutcomeUnknown(_) => f.write_str("record outcome unknown; retain original request key"),
        }
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
impl Error {
    /// The original condition's site, retained independently of its public classification.
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Conflict(cause) | Self::Unavailable(cause) | Self::OutcomeUnknown(cause)
            | Self::Invalid(_, cause) | Self::Refused(_, cause) => cause,
        }
    }
    /// The safe construction site for an uncertain effect; adapters preserve it beside their public code.
    pub fn outcome_cause(&self) -> Option<crate::refusal_cause::Cause> {
        match self {
            Self::OutcomeUnknown(cause) => Some(cause.clone()),
            _ => None,
        }
    }
}
crate::impl_caused!(Error);

// Preserve the existing semantic comparisons of classifications and payloads. The source identity is compared
// explicitly through cause() by reporting and propagation tests; moving a source line does not change an error's kind.
impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Conflict(_), Self::Conflict(_)) | (Self::Unavailable(_), Self::Unavailable(_))
            | (Self::OutcomeUnknown(_), Self::OutcomeUnknown(_)) => true,
            (Self::Invalid(a, _), Self::Invalid(b, _)) => a == b,
            (Self::Refused(a, _), Self::Refused(b, _)) => a == b,
            _ => false,
        }
    }
}
impl Eq for Error {}

/// Installed supply for a scoped versioned-record resource, not the whole EEAF
/// model. No provider selection or forwarding belongs in consumers of this API.
///
/// `mutate_admitted` must use immutable admitted input and its owned retry key;
/// call.assert_current(current route, current time) belongs inside the SAME
/// atomic transaction as record/history writes, and again before commit or
/// disclosure of a recovered receipt. Refusal must leave no new durable effect.
/// An implementation without this property is ineligible for remote writes.
/// Local methods are for an already trusted OS-user/fixed-scope host; they do
/// not issue account authority. Pages must obey MAX_PAGE_BYTES/MAX_PAGE_ITEMS,
/// preserve complete values and make progress using an explicit continuation.
pub trait Records: Send {
    fn get(&self, account: &str, resource: &str, id: &str) -> Result<Read, Error>;
    fn mutate(&mut self, account: &str, resource: &str, input: Mutation) -> Result<Change, Error>;
    fn list_page(&self, account: &str, resource: &str, after: &str, limit: usize)
        -> Result<Page<Record, String>, Error>;
    fn changes_page(&self, account: &str, resource: &str, after: i64, limit: usize)
        -> Result<Page<Change, i64>, Error>;
    fn mutate_admitted(&mut self, call: &AdmittedCall, context: &dyn CommitContext)
        -> Result<Change, Error>;
}
