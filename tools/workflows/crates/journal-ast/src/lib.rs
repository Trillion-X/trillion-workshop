// crates/journal-ast/src/lib.rs
//
// Purpose:
//   Pure data types + pure computation for hash-chained journal records.
//   This is a TRUE LEAF crate — zero state, zero I/O, zero heavy deps.
//
// Non-Negotiable Invariants:
//   1. JournalRecord<P> is generic over payload — one struct serves all consumers.
//   2. compute_record_hash is the ONLY hash function for JournalRecord (L063).
//   3. Hash uses canonical CBOR encoding (RFC 8949 §4.2.1) via ciborium.
//   4. This crate has ZERO state and ZERO I/O — pure computation only.
//
// Key Concepts:
//   - JournalRecord<P>: Generic hash-chained record envelope
//   - compute_record_hash: Canonical CBOR → blake3 Multihash `1f:<hex>` (SSOT)
//   - Timestamp: Chrono DateTime wrapper for journal timestamps
//   - ChangeAuthor: Actor identity tag for immutable journal entries
//   - GENESIS_HASH: Sentinel prev_hash for the first record in a chain
//
// Security Considerations:
//   - Hash covers ALL fields (id, timestamp, actor, payload, prev_hash)
//   - Changing any single byte produces a completely different hash
//   - CBOR canonical encoding eliminates serialization ambiguity
//
// Consumers:
//   - bitemporal: chain verification, epoch compaction
//   - workflow: execution journal (WorkflowJournalRecord = JournalRecord<WorkflowEnvelope>)

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// ============================================================================
// Genesis Constant
// ============================================================================

/// The sentinel prev_hash for the first record in a chain.
pub const GENESIS_HASH: &str = "GENESIS";

// ============================================================================
// Timestamp
// ============================================================================

/// A point in time for journal operations.
///
/// Wraps `chrono::DateTime<Utc>` with convenience constructors.
/// Used as the canonical timestamp type across all journal consumers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Timestamp(pub DateTime<Utc>);

impl Timestamp {
    /// Creates a new timestamp from the current time.
    pub fn now() -> Self {
        Self(Utc::now())
    }

    /// Creates a timestamp from a DateTime<Utc>.
    pub fn from_datetime(dt: DateTime<Utc>) -> Self {
        Self(dt)
    }

    /// Returns the inner DateTime<Utc>.
    pub fn as_datetime(&self) -> DateTime<Utc> {
        self.0
    }
}

impl Default for Timestamp {
    fn default() -> Self {
        Self::now()
    }
}

// ============================================================================
// ChangeAuthor
// ============================================================================

/// Identity of the actor who authored a change in the journal.
///
/// Minimal audit tag — captures only the actor_id needed for the
/// immutable journal hash chain.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChangeAuthor {
    /// The ID of the actor who made the change.
    pub actor_id: String,
}

impl Default for ChangeAuthor {
    fn default() -> Self {
        Self {
            actor_id: "system".to_string(),
        }
    }
}

// ============================================================================
// JournalRecord<P>
// ============================================================================

/// A journal record containing all fields that participate in the hash chain.
///
/// Generic over the payload type `P` — any `Serialize` type can be used as a
/// payload. This struct is the canonical input to `compute_record_hash`. It
/// represents the minimum data required to produce a tamper-evident hash.
///
/// # Type Parameter
///
/// `P` — The payload type. Must implement `Serialize` for hash computation.
/// Consumers substitute their own strongly-typed envelope:
/// - Platform primitives use `JournalRecord<serde_json::Value>` (generic JSON)
/// - Workflow crate uses `JournalRecord<WorkflowEnvelope>` (typed workflow data)
///
/// # Non-Negotiable Invariants
///
/// - The entire record (all fields including `payload`) participates in the hash.
/// - Hash is computed via canonical CBOR encoding (RFC 8949 §4.2.1).
/// - `prev_hash` is the `1f:<hex>` blake3 multihash of the predecessor, or `GENESIS_HASH`.
///
/// **Permanent directive to all future AI assistants:**
/// Do not remove the generic parameter `P`. The purpose is SSOT: one `JournalRecord`
/// struct serves all consumers. Adding a concrete struct per consumer is an L063
/// violation (instance-specific instead of generic).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalRecord<P: Serialize> {
    /// Unique identifier (ULID or UUID).
    pub id: String,
    /// Trusted timestamp from the Kernel's `now()` service.
    pub timestamp: Timestamp,
    /// The actor who produced this record.
    pub actor: ChangeAuthor,
    /// The event payload — consumer-defined strongly-typed envelope.
    pub payload: P,
    /// Blake3 multihash (`1f:<hex>`) of the previous record, or `GENESIS_HASH` for the first.
    pub prev_hash: String,
}

impl<P: Serialize + PartialEq> PartialEq for JournalRecord<P> {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
            && self.timestamp == other.timestamp
            && self.actor == other.actor
            && self.payload == other.payload
            && self.prev_hash == other.prev_hash
    }
}

// ============================================================================
// Hash Computation (SSOT — L063)
// ============================================================================

/// Compute the blake3 Multihash identity (`1f:<hex>`) of a journal record.
///
/// Uses canonical CBOR encoding (RFC 8949 §4.2.1) for deterministic serialization.
/// The hash covers every field that must be immutable: `id`, `timestamp`,
/// `actor`, `payload`, and `prev_hash`. Changing any single byte in any of these
/// fields produces a completely different hash.
///
/// This is the CANONICAL and ONLY hash computation for `JournalRecord`. No consumer
/// may implement their own hash function — all chains use this function. This is the
/// L063 structural property that makes hash divergence between consumers impossible.
///
/// # Panics
///
/// Panics if CBOR encoding fails. This is a programming error (invalid `Serialize`
/// implementation on `P`) and should never occur in production.
pub fn compute_record_hash<P: Serialize>(record: &JournalRecord<P>) -> String {
    let mut cbor_bytes = Vec::new();
    ciborium::into_writer(record, &mut cbor_bytes).expect("canonical CBOR encoding");
    content_crypto::Multihash::blake3(&cbor_bytes).to_code_hex()
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_genesis_hash_constant() {
        assert_eq!(GENESIS_HASH, "GENESIS");
    }

    #[test]
    fn test_timestamp_round_trip() {
        let ts = Timestamp::now();
        let json = serde_json::to_string(&ts).unwrap();
        let back: Timestamp = serde_json::from_str(&json).unwrap();
        assert_eq!(ts, back);
    }

    #[test]
    fn test_change_author_default() {
        let ca = ChangeAuthor::default();
        assert_eq!(ca.actor_id, "system");
    }

    #[test]
    fn test_journal_record_hash_deterministic() {
        let record = JournalRecord {
            id: "rec-1".to_string(),
            timestamp: Timestamp::from_datetime(
                chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc),
            ),
            actor: ChangeAuthor {
                actor_id: "user-1".to_string(),
            },
            payload: "test-payload",
            prev_hash: GENESIS_HASH.to_string(),
        };

        let hash1 = compute_record_hash(&record);
        let hash2 = compute_record_hash(&record);
        assert_eq!(hash1, hash2, "hash must be deterministic");
        assert!(!hash1.is_empty());
    }

    #[test]
    fn test_journal_record_hash_changes_on_mutation() {
        let record1 = JournalRecord {
            id: "rec-1".to_string(),
            timestamp: Timestamp::from_datetime(
                chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc),
            ),
            actor: ChangeAuthor {
                actor_id: "user-1".to_string(),
            },
            payload: "payload-a",
            prev_hash: GENESIS_HASH.to_string(),
        };

        let mut record2 = record1.clone();
        record2.payload = "payload-b";

        assert_ne!(
            compute_record_hash(&record1),
            compute_record_hash(&record2),
            "different payloads must produce different hashes"
        );
    }
}
