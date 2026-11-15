// crates/slot-protocol/src/request_reply.rs
//
//! # Request/Reply Protocol — Envelope Construction for Slot-to-Slot Communication
//!
//! Protocol-level types and construction functions for the Request/Reply pattern.
//! Slots use these to build correlated Request and Reply Envelopes without
//! depending on the envelope-engine runtime.
//!
//! The runtime tracking (EphemeralRegistry, timeouts, sweep) stays in envelope-engine.
//! This module is pure types + construction — zero runtime state.

use crate::envelope_type::Envelope;
use crate::newtypes::{FactAddress, Hash, PartitionKey, PathSegment};
use bytes::Bytes;
use smallvec::SmallVec;

// ---------------------------------------------------------------------------
// Correlation ID — unique request identity
// ---------------------------------------------------------------------------

/// Unique correlation identifier for request/reply matching.
/// 16 bytes (UUID-sized) — sufficient for uniqueness within a partition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CorrelationId(pub [u8; 16]);

impl CorrelationId {
    /// Generate a new random correlation ID.
    pub fn new() -> Self {
        let mut bytes = [0u8; 16];
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let count = COUNTER.fetch_add(1, Ordering::Relaxed);
        let hash = Hash::blake3_hash(&count.to_le_bytes());
        bytes.copy_from_slice(&hash.digest()[..16]);
        Self(bytes)
    }

    /// Create from raw bytes.
    pub fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    /// Format as hex string for address construction.
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }
}

impl Default for CorrelationId {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Request/Reply Envelope construction
// ---------------------------------------------------------------------------

/// Metadata attached to a Request Envelope for correlation and timeout.
#[derive(Debug, Clone)]
pub struct RequestMetadata {
    /// Unique ID linking request to reply.
    pub correlation_id: CorrelationId,
    /// Address where the reply should be written.
    pub reply_to: FactAddress,
    /// Execution budget in milliseconds — the responder's local deadline.
    pub execution_budget_ms: u64,
}

/// Build a Request Envelope with proper correlation metadata.
pub fn build_request_envelope(
    target_address: FactAddress,
    payload: Bytes,
    partition: PartitionKey,
    requester_domain: &str,
    execution_budget_ms: u64,
) -> (Envelope, RequestMetadata) {
    let correlation_id = CorrelationId::new();
    let reply_address_str = format!("{}:reply:{}", requester_domain, correlation_id.to_hex());
    let reply_to = FactAddress::hash_from(&reply_address_str);

    let mut path = SmallVec::new();
    path.push(PathSegment::from_digest(
        0x1F,
        Hash::blake3_hash(&correlation_id.0).digest().to_vec(),
    ));

    let envelope = Envelope {
        partition_key: partition,
        address: target_address,
        path,
        read_capabilities: SmallVec::new(),
        wasm_reducer_hash: None,
        payload: Some(payload),
        payload_hash: None,
        context: None,
    };

    let metadata = RequestMetadata {
        correlation_id,
        reply_to,
        execution_budget_ms,
    };

    (envelope, metadata)
}

/// Build a Reply Envelope using the request's correlation metadata.
pub fn build_reply_envelope(
    request_metadata: &RequestMetadata,
    payload: Bytes,
    partition: PartitionKey,
) -> Envelope {
    Envelope {
        partition_key: partition,
        address: request_metadata.reply_to.clone(),
        path: SmallVec::new(),
        read_capabilities: SmallVec::new(),
        wasm_reducer_hash: None,
        payload: Some(payload),
        payload_hash: None,
        context: None,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn correlation_id_uniqueness() {
        let id1 = CorrelationId::new();
        let id2 = CorrelationId::new();
        assert_ne!(id1, id2);
    }

    #[test]
    fn correlation_id_hex_length() {
        let id = CorrelationId::new();
        assert_eq!(id.to_hex().len(), 32);
    }

    #[test]
    fn build_request_reply_round_trip() {
        let target = FactAddress::from_digest(0x1F, vec![1u8; 32]);
        let partition = PartitionKey::from_digest(0x1F, vec![2u8; 32]);
        let payload = Bytes::from_static(b"test request");

        let (envelope, metadata) = build_request_envelope(
            target.clone(),
            payload,
            partition.clone(),
            "target-alpha",
            5000,
        );
        assert_eq!(envelope.address, target);
        assert_eq!(envelope.partition_key, partition);
        assert!(envelope.payload.is_some());
        assert_eq!(metadata.execution_budget_ms, 5000);

        let reply = build_reply_envelope(&metadata, Bytes::from_static(b"test reply"), partition);
        assert_eq!(reply.address, metadata.reply_to);
    }
}
