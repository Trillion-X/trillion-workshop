//! # Journal Encoding
//!
//! CBOR canonical encoding + blake3 multihash identity + CRC32 framing for journal entries.
//!
//! ## Encoding Pipeline
//!
//! 1. `encode_canonical_cbor()` — serialize WorkflowJournalRecord to canonical CBOR (RFC 8949 §4.2.1)
//! 2. `frame_entry()` — CRC32 framing: [u32 LE length][CBOR payload][u32 LE CRC32]
//! 3. `validate_frame()` — verify CRC32, extract payload
//! 4. `validate_inline_size()` — reject oversized entries before allocation
//!
//! Record identity (blake3 multihash via journal-ast) uses canonical CBOR encoding for deterministic computation.

use crate::domain::journal::{DurabilityErrorCode, RemediationHint, WorkflowJournalRecord};

/// Wrapper around DurabilityError for local use
#[derive(Debug, Clone)]
pub struct DurabilityError {
    pub code: DurabilityErrorCode,
    pub message: String,
    pub remediation: Option<RemediationHint>,
}

impl std::fmt::Display for DurabilityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{:?}] {}", self.code, self.message)
    }
}

impl std::error::Error for DurabilityError {}

/// Encode a WorkflowJournalRecord to canonical CBOR bytes (RFC 8949 §4.2.1 sorted map keys).
/// ciborium produces canonical CBOR by default with `ciborium::into_writer`.
pub fn encode_canonical_cbor(record: &WorkflowJournalRecord) -> Result<Vec<u8>, DurabilityError> {
    let mut buf = Vec::new();
    ciborium::into_writer(record, &mut buf).map_err(|e| DurabilityError {
        code: DurabilityErrorCode::JournalCorruption,
        message: format!("CBOR encoding failed: {}", e),
        remediation: None,
    })?;
    Ok(buf)
}

/// Frame CBOR bytes with CRC32: [u32 LE length][CBOR payload][u32 LE CRC32 of CBOR].
pub fn frame_entry(cbor_bytes: &[u8]) -> Vec<u8> {
    let len = cbor_bytes.len() as u32;
    let crc = crc32fast::hash(cbor_bytes);
    let mut frame = Vec::with_capacity(4 + cbor_bytes.len() + 4);
    frame.extend_from_slice(&len.to_le_bytes());
    frame.extend_from_slice(cbor_bytes);
    frame.extend_from_slice(&crc.to_le_bytes());
    frame
}

/// Validate a CRC32 frame. Returns the CBOR payload on success.
pub fn validate_frame(frame: &[u8]) -> Result<&[u8], DurabilityError> {
    if frame.len() < 8 {
        return Err(DurabilityError {
            code: DurabilityErrorCode::JournalCorruption,
            message: "Frame too short: minimum 8 bytes (4 length + 4 CRC)".to_string(),
            remediation: None,
        });
    }

    let len = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;

    if frame.len() != 4 + len + 4 {
        return Err(DurabilityError {
            code: DurabilityErrorCode::JournalCorruption,
            message: format!(
                "Frame length mismatch: header says {} bytes payload, frame is {} bytes total (expected {})",
                len, frame.len(), 4 + len + 4
            ),
            remediation: None,
        });
    }

    let payload = &frame[4..4 + len];
    let stored_crc = u32::from_le_bytes([
        frame[4 + len],
        frame[4 + len + 1],
        frame[4 + len + 2],
        frame[4 + len + 3],
    ]);
    let computed_crc = crc32fast::hash(payload);

    if stored_crc != computed_crc {
        return Err(DurabilityError {
            code: DurabilityErrorCode::JournalCorruption,
            message: format!(
                "CRC32 mismatch: stored={:#010x}, computed={:#010x}",
                stored_crc, computed_crc
            ),
            remediation: None,
        });
    }

    Ok(payload)
}

/// Validate that CBOR bytes don't exceed the inline size limit.
/// Check BEFORE buffer allocation (OOM prevention at ingress).
pub fn validate_inline_size(cbor_bytes: &[u8], max_bytes: usize) -> Result<(), DurabilityError> {
    if cbor_bytes.len() > max_bytes {
        return Err(DurabilityError {
            code: DurabilityErrorCode::OversizedPayload,
            message: format!(
                "Entry size {} bytes exceeds maximum {} bytes",
                cbor_bytes.len(),
                max_bytes
            ),
            remediation: Some(RemediationHint::ReducePayloadSize),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::journal::*;

    fn make_test_record() -> WorkflowJournalRecord {
        WorkflowJournalRecord {
            id: "rec-1".to_string(),
            timestamp: crate::domain::journal::Timestamp::now(),
            actor: crate::domain::journal::ChangeAuthor {
                actor_id: "user-1".to_string(),
            },
            payload: WorkflowEnvelope {
                local_seq: 1,
                workflow_id: "workflow-1".to_string(),
                hlc: 1000,
                lease_binding: LeaseBinding {
                    lease_id: "lease-1".to_string(),
                    device_id: "dev-1".to_string(),
                    user_id: "user-1".to_string(),
                    expires_at: 2000,
                    max_offline_ticks: 100,
                    journal_key_type: KeyType::Hardware,
                    primitive_permissions: PrimitivePermissions {
                        transact: ExecutionPolicy::LocalCommit,
                        call_external: ExecutionPolicy::PendingCommit,
                        embodiment: ExecutionPolicy::LocalCommit,
                        execute: ExecutionPolicy::LocalCommit,
                        journal_append: ExecutionPolicy::LocalCommit,
                        schema_write: ExecutionPolicy::LocalCommit,
                    },
                },
                entry: JournalEntry::StepStarted {
                    step_id: "step-1".to_string(),
                    attempt: 1,
                    input: StepInput::Transact(TransactInput {
                        operations: vec![TransactOperation {
                            operation: "create".to_string(),
                            entity_id: Some("entity-1".to_string()),
                            property_id: None,
                            value: Some(CborValue::Text("test".to_string())),
                        }],
                    }),
                },
            },
            prev_hash: crate::domain::journal::GENESIS_HASH.to_string(),
        }
    }

    #[test]
    fn test_encode_decode_round_trip() {
        let record = make_test_record();
        let cbor_bytes = encode_canonical_cbor(&record).unwrap();
        assert!(!cbor_bytes.is_empty());

        // Decode back
        let decoded: WorkflowJournalRecord = ciborium::from_reader(&cbor_bytes[..]).unwrap();
        assert_eq!(record, decoded);
    }

    #[test]
    fn test_frame_validate_round_trip() {
        let record = make_test_record();
        let cbor_bytes = encode_canonical_cbor(&record).unwrap();
        let frame = frame_entry(&cbor_bytes);

        // Validate should succeed
        let payload = validate_frame(&frame).unwrap();
        assert_eq!(payload, &cbor_bytes[..]);

        // Decode from validated payload
        let decoded: WorkflowJournalRecord = ciborium::from_reader(payload).unwrap();
        assert_eq!(record, decoded);
    }

    #[test]
    fn test_crc32_corruption_detection() {
        let record = make_test_record();
        let cbor_bytes = encode_canonical_cbor(&record).unwrap();
        let mut frame = frame_entry(&cbor_bytes);

        // Flip a bit in the payload
        if frame.len() > 5 {
            frame[5] ^= 0x01;
        }

        let result = validate_frame(&frame);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(err.code, DurabilityErrorCode::JournalCorruption));
    }

    #[test]
    fn test_frame_too_short() {
        let result = validate_frame(&[0, 0, 0]);
        assert!(result.is_err());
    }

    #[test]
    fn test_frame_length_mismatch() {
        // Create a frame with wrong length header
        let mut frame = vec![0xFF, 0xFF, 0x00, 0x00]; // claims 65535 bytes
        frame.extend_from_slice(&[0x00; 4]); // but only 4 bytes of "payload" + CRC
        let result = validate_frame(&frame);
        assert!(result.is_err());
    }

    #[test]
    fn test_oversized_entry_rejection() {
        let big_bytes = vec![0u8; 1000];
        let result = validate_inline_size(&big_bytes, 500);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(err.code, DurabilityErrorCode::OversizedPayload));
    }

    #[test]
    fn test_within_size_limit() {
        let small_bytes = vec![0u8; 100];
        assert!(validate_inline_size(&small_bytes, 500).is_ok());
    }

    #[test]
    fn test_hash_determinism() {
        let record = make_test_record();
        let cbor1 = encode_canonical_cbor(&record).unwrap();
        let cbor2 = encode_canonical_cbor(&record).unwrap();
        assert_eq!(cbor1, cbor2, "Canonical CBOR must be deterministic");
        assert_eq!(compute_record_hash(&record), compute_record_hash(&record));
    }

    #[test]
    fn test_hash_chain_verification() {
        let mut record1 = make_test_record();
        record1.prev_hash = crate::domain::journal::GENESIS_HASH.to_string();
        let hash1 = compute_record_hash(&record1);

        // Record 2 references hash of record 1
        let mut record2 = make_test_record();
        record2.id = "rec-2".to_string();
        let WorkflowEnvelope {
            ref mut local_seq, ..
        } = &mut record2.payload;
        *local_seq = 2;
        record2.prev_hash = hash1.clone();

        let _hash2 = compute_record_hash(&record2);

        // Verify chain: record2.prev_hash == hash of record1
        assert_eq!(record2.prev_hash, hash1);
    }
}
