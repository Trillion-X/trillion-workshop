// src/storage/record_store/ring.rs
//
// Purpose: The request receipts of one record: a bounded ring kept inside the record's current row, so a retry is
// answered by the one row the write reads anyway (0 receipt rows written, 1 row read, flat over time).
//
// Non-Negotiable Invariants:
// - A change stores its request key, its input identity, the version it wrote and its commit stamp in the ring of
//   the record it changed. A tombstone (a deleted record's current row) keeps its ring until the record exits.
// - An entry leaves the ring when it is older than the receipt window or when the ring holds more than its bound.
// - A retry whose key is in the ring is answered with the change it made; a different input under that key is a
//   conflict. A key that left the ring is applied as new, so its compare-and-set version refuses a second apply.
//
// Key Concepts:
// - Request identity is scoped to the record the request addresses (the same rule as the record log since 423fb7a).
//
// Security Considerations:
// - The input identity is a BLAKE3 digest of the full input, so a changed input under a reused key is refused.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::settings::Receipts;
use serde::{Deserialize, Serialize};

/// One receipt: the request, its input identity, and the version and commit stamp it wrote.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Receipt {
    pub request: String,
    pub identity: String,
    pub version: i64,
    pub at: i64,
    pub deleted: bool,
}

/// The receipts of one record, oldest first.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct Ring(pub Vec<Receipt>);

impl Ring {
    pub fn parse(text: Option<&str>) -> Option<Self> {
        match text {
            None => Some(Self::default()),
            Some(text) => serde_json::from_str(text).ok(),
        }
    }
    pub fn text(&self) -> Option<String> {
        serde_json::to_string(self).ok()
    }
    /// The receipt of `request`, if it is still kept.
    pub fn find(&self, request: &str) -> Option<&Receipt> {
        self.0.iter().find(|receipt| receipt.request == request)
    }
    /// The ring after `receipt` committed at its stamp: entries older than the window leave, then the oldest leave
    /// until the bound holds.
    pub fn after(&self, receipt: Receipt, settings: &Receipts) -> Self {
        let oldest_kept = super::stamp_ms(receipt.at).saturating_sub(settings.window_ms);
        let mut kept: Vec<Receipt> =
            self.0.iter().filter(|old| super::stamp_ms(old.at) >= oldest_kept).cloned().collect();
        kept.push(receipt);
        let over = kept.len().saturating_sub(settings.max_entries);
        kept.drain(..over);
        Self(kept)
    }
}
