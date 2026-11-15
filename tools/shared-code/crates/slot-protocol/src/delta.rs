//! # Delta envelope protocol — CSSOT for subscribed slot firehose delivery
//!
//! Canonical payload shape for the composition root's subscribed-slot delta
//! forwarder. Any slot with a `subscription` contract receives this payload
//! through `slot.query(delta_envelope)`.
//!
//! The payload shape is self-describing (L090):
//! - `{"type":"delta","asserts":[...],"retracts":[...]}` → delta batch
//!
//! ## L088 placement rationale
//!
//! This shape originally lived in one subscribed slot. Once a second subscriber
//! needed the same firehose shape, the payload stopped being slot-local and
//! became a cross-slot wire contract. The nearest shared ancestor is
//! `slot-protocol`, because producers and consumers already depend on it for
//! `Envelope`, `FactAddress`, and subscription primitives.
//!
//! ## Wire encoding
//!
//! - `asserts[].address` is hex-encoded canonical Multihash wire bytes
//! - `asserts[].content_hash` is hex-encoded canonical Multihash wire bytes
//! - `asserts[].path` is the durable path metadata as hex-encoded canonical
//!   Multihash wire bytes per segment
//! - `asserts[].content` is optional base64-encoded content bytes
//!   - present when the slot declared `subscription.content = "inline"`
//!   - absent when the slot declared `subscription.content = "hash_only"`
//! - `retracts[]` is a hex-encoded canonical Multihash wire address

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};

/// Delta payload delivered to subscribed slots.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeltaPayload {
    /// Must equal `"delta"`.
    #[serde(rename = "type")]
    pub kind: String,

    #[serde(default)]
    pub asserts: Vec<WireAssert>,

    #[serde(default)]
    pub retracts: Vec<String>,

    /// Delivery-gap notification (delta-delivery-integrity contract).
    /// Present when the engine detected that this subscriber missed deltas —
    /// the payload's asserts/retracts do NOT cover the gap interval. Consumers
    /// that understand gaps run selector-scoped current-state reconciliation
    /// or record the loss durably; consumers that don't must fail closed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gap: Option<WireDeltaGap>,
}

/// Wire form of a delivery gap: the half-open hot-history cursor interval
/// `[from_cursor, to_cursor)` this subscriber did not receive.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct WireDeltaGap {
    pub from_cursor: u64,
    pub to_cursor: u64,
}

/// One assert in a delta payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireAssert {
    pub address: String,
    pub content_hash: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub path: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

impl WireAssert {
    pub fn content_bytes(&self) -> Result<Option<Vec<u8>>, base64::DecodeError> {
        self.content
            .as_deref()
            .map(|encoded| STANDARD.decode(encoded))
            .transpose()
    }
}

impl DeltaPayload {
    pub fn is_delta(&self) -> bool {
        self.kind == "delta"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discriminate_delta() {
        let bytes = br#"{"type":"delta","asserts":[],"retracts":[]}"#;
        let d: DeltaPayload = serde_json::from_slice(bytes).unwrap();
        assert!(d.is_delta());
    }

    #[test]
    fn non_delta_kind_is_not_delta() {
        let bytes = br#"{"type":"query","asserts":[],"retracts":[]}"#;
        let d: DeltaPayload = serde_json::from_slice(bytes).unwrap();
        assert!(!d.is_delta());
    }

    #[test]
    fn delta_with_asserts_and_retracts_roundtrips() {
        let d = DeltaPayload {
            kind: "delta".into(),
            asserts: vec![WireAssert {
                address: "deadbeef".into(),
                content_hash: "cafef00d".into(),
                path: vec!["facefeed".into()],
                content: Some(STANDARD.encode(b"hello")),
            }],
            retracts: vec!["b1ee".into()],
            gap: None,
        };
        let bytes = serde_json::to_vec(&d).unwrap();
        let back: DeltaPayload = serde_json::from_slice(&bytes).unwrap();
        assert!(back.is_delta());
        assert_eq!(back.asserts.len(), 1);
        assert_eq!(back.asserts[0].address, "deadbeef");
        assert_eq!(back.asserts[0].path, vec!["facefeed"]);
        assert_eq!(
            back.asserts[0].content_bytes().unwrap(),
            Some(b"hello".to_vec())
        );
        assert_eq!(back.retracts, vec!["b1ee"]);
    }
}
