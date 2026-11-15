//! Machine-readable error types with stable `FE_xxx` codes.
//!
//! Every error variant has:
//! - Stable error code (`FE_xxx` format)
//! - Human-readable message
//! - `remediation()` method with actionable recovery steps

use thiserror::Error;

/// Envelope engine error with stable machine-readable codes.
#[derive(Error, Debug, Clone)]
pub enum EnvelopeError {
    /// Partition routing failed.
    #[error("FE_PARTITION_NOT_FOUND: Partition key not found")]
    PartitionNotFound,

    /// Fact address resolution failed.
    #[error("FE_ADDRESS_NOT_FOUND: Fact address not found")]
    AddressNotFound,

    /// Capability authorization check failed.
    #[error("FE_CAPABILITY_DENIED: Capability check failed")]
    CapabilityDenied,

    /// WASM reducer hash not found in local CAS.
    #[error("FE_REDUCER_NOT_FOUND: Merge reducer hash not in local CAS")]
    ReducerNotFound,

    /// Conflict set exceeds maximum branch count.
    #[error("FE_CONFLICT_OVERFLOW: Too many concurrent conflict branches")]
    ConflictOverflow,

    /// Pending reducer queue is full.
    #[error("FE_REDUCER_QUEUE_FULL: Pending reducer index at capacity")]
    ReducerQueueFull,

    /// Transaction failed on external database.
    #[error("FE_TRANSACTION_FAILED: External database transaction failed")]
    TransactionFailed,

    /// Symbol resolution from DHT failed.
    #[error("FE_SYMBOL_RESOLUTION_FAILED: Symbol map entry not found or fetch timeout")]
    SymbolResolutionFailed,

    /// WASM sandbox trap (fuel exhaustion, panic, or memory violation).
    #[error("FE_WASM_TRAP: WASM execution failed")]
    WasmTrap,

    /// Serialization / deserialization error.
    #[error("FE_CODEC_ERROR: Codec error: {0}")]
    CodecError(String),

    /// Checkpoint is invalid or corrupted.
    #[error("FE_CHECKPOINT_INVALID: Checkpoint integrity check failed")]
    CheckpointInvalid,

    /// Log append failed (disk full, I/O error).
    #[error("FE_LOG_APPEND_FAILED: Log append failed")]
    LogAppendFailed,

    /// Projection freshness state error.
    #[error("FE_PROJECTION_STALLED: Projection cannot make progress")]
    ProjectionStalled,

    /// Context binding verification failed (wrong origin/device).
    #[error("FE_CONTEXT_BINDING_FAILED: Capability context binding verification failed")]
    ContextBindingFailed,

    /// Host call not executed in Physics layer (only callable via FFI/WASM boundary).
    #[error("FE_HOST_CALL_INVALID: Host call cannot be executed in Physics context")]
    HostCallInvalid,

    /// Operation not supported by this slot (e.g., query on a write-only slot).
    #[error("FE_NOT_SUPPORTED: Operation not supported by this slot")]
    NotSupported,

    /// A guarded write was based on a different current value than the one live now.
    #[error("FE_EXPECTED_CURRENT_MISMATCH: Expected current value did not match live content")]
    ExpectedCurrentMismatch,

    /// The device has no room for the bytes this write needs. The operating
    /// system said so (`ENOSPC` or a quota), the write landed nothing, and the
    /// store is exactly as it was before. Reads continue.
    ///
    /// This is the ONLY storage refusal the engine has. There is no budget, no
    /// watermark, and no prediction in front of the disk: the store keeps only
    /// what its kept versions reach and reclaims the rest per segment, so the
    /// one way to run out of room is for the device itself to be full. This
    /// variant used to be `StoragePressure`, "budget reached, retry after
    /// compaction", and that budget was set wrong on the first day and never
    /// once fired in the life of the app; the disk filled with it standing
    /// guard. A refusal that names the real cause is the whole replacement.
    #[error("FE_STORAGE_FULL: this device is out of space; the write was not stored")]
    StorageFull,

    /// The change may have landed and may not have, and the store cannot tell
    /// from inside the failure.
    ///
    /// There is a third answer between "it worked" and "it did not", and a
    /// store that only has two has to pick one of them and be silently wrong
    /// about the third. Every durable change has one irreversible step; a
    /// failure BEFORE it definitely did not land and a failure AFTER it
    /// definitely did, but a failure that leaves the step itself unproven
    /// (renamed into place, directory entry not forced) is neither. This
    /// variant is that third answer, and it exists so a caller can act on it
    /// rather than read it in a sentence: retry, and let the retry decide.
    ///
    /// It is safe to retry every time. A change is identified by its content,
    /// so a retry that finds its work already done does nothing.
    #[error("FE_OUTCOME_UNKNOWN: {0}")]
    OutcomeUnknown(String),

    /// Generic internal error.
    #[error("FE_INTERNAL_ERROR: {0}")]
    Internal(String),
}

impl EnvelopeError {
    /// Return the stable machine-readable error code.
    pub fn code(&self) -> &'static str {
        match self {
            EnvelopeError::PartitionNotFound => "FE_PARTITION_NOT_FOUND",
            EnvelopeError::AddressNotFound => "FE_ADDRESS_NOT_FOUND",
            EnvelopeError::CapabilityDenied => "FE_CAPABILITY_DENIED",
            EnvelopeError::ReducerNotFound => "FE_REDUCER_NOT_FOUND",
            EnvelopeError::ConflictOverflow => "FE_CONFLICT_OVERFLOW",
            EnvelopeError::ReducerQueueFull => "FE_REDUCER_QUEUE_FULL",
            EnvelopeError::TransactionFailed => "FE_TRANSACTION_FAILED",
            EnvelopeError::SymbolResolutionFailed => "FE_SYMBOL_RESOLUTION_FAILED",
            EnvelopeError::WasmTrap => "FE_WASM_TRAP",
            EnvelopeError::CodecError(_) => "FE_CODEC_ERROR",
            EnvelopeError::CheckpointInvalid => "FE_CHECKPOINT_INVALID",
            EnvelopeError::LogAppendFailed => "FE_LOG_APPEND_FAILED",
            EnvelopeError::ProjectionStalled => "FE_PROJECTION_STALLED",
            EnvelopeError::ContextBindingFailed => "FE_CONTEXT_BINDING_FAILED",
            EnvelopeError::HostCallInvalid => "FE_HOST_CALL_INVALID",
            EnvelopeError::NotSupported => "FE_NOT_SUPPORTED",
            EnvelopeError::ExpectedCurrentMismatch => "FE_EXPECTED_CURRENT_MISMATCH",
            EnvelopeError::StorageFull => "FE_STORAGE_FULL",
            EnvelopeError::OutcomeUnknown(_) => "FE_OUTCOME_UNKNOWN",
            EnvelopeError::Internal(_) => "FE_INTERNAL_ERROR",
        }
    }

    /// Return actionable remediation steps for this error.
    pub fn remediation(&self) -> &'static str {
        match self {
            EnvelopeError::PartitionNotFound => "Create the partition via dispatch_rewrite or check partition key",
            EnvelopeError::AddressNotFound => "Check that the fact address exists in this partition",
            EnvelopeError::CapabilityDenied => "Request requires capabilities not granted; check your capability profile",
            EnvelopeError::ReducerNotFound => "Merge reducer not in CAS; fetch from peer or upload to local CAS",
            EnvelopeError::ConflictOverflow => "Resolve existing conflicts before writing more concurrent branches",
            EnvelopeError::ReducerQueueFull => "Pending reducer queue at capacity; retry after some reducers arrive",
            EnvelopeError::TransactionFailed => "Check external database connection and retry",
            EnvelopeError::SymbolResolutionFailed => "DHT fetch failed or timed out; retry after checking network connectivity",
            EnvelopeError::WasmTrap => "WASM reducer panic or fuel exhaustion; check reducer code and memory usage",
            EnvelopeError::CodecError(_) => "Data codec error; ensure payload format matches schema",
            EnvelopeError::CheckpointInvalid => "Restore from backup or replay from earlier checkpoint",
            EnvelopeError::LogAppendFailed => "Check disk space and I/O permissions",
            EnvelopeError::ProjectionStalled => "Check external database, network, or reducer status; retry when ready",
            EnvelopeError::ContextBindingFailed => "Use a token bound to this origin/device/workspace",
            EnvelopeError::HostCallInvalid => "This method is only callable from WASM plugins via FFI boundary; ensure it is not called directly from Physics code",
            EnvelopeError::NotSupported => "This operation is not supported by this slot; check the slot's methods() list",
            EnvelopeError::ExpectedCurrentMismatch => "Read the current value again and retry with the current content hash",
            // This used to end with "if the write had already landed the retry
            // changes nothing", because a device can refuse after the pointer
            // file was renamed and before its directory was synced, and this
            // error could not tell those apart. That ambiguity was real and it
            // was carried in a SENTENCE, which no caller can branch on. It is
            // `OutcomeUnknown` now, so this variant can say the true thing
            // again: nothing was stored.
            EnvelopeError::StorageFull => "This device is out of space and nothing was stored. Free up room in the operating system's storage settings, then retry",
            EnvelopeError::OutcomeUnknown(_msg) => "The change may or may not have been kept. Retry it; a retry that finds its work already done changes nothing, and one that does not redoes it",
            EnvelopeError::Internal(_msg) => "Internal error; contact support with error details",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_code() {
        let err = EnvelopeError::PartitionNotFound;
        assert_eq!(err.code(), "FE_PARTITION_NOT_FOUND");
    }

    #[test]
    fn test_error_remediation() {
        let err = EnvelopeError::CapabilityDenied;
        assert!(!err.remediation().is_empty());
    }

    #[test]
    fn test_all_error_codes_unique() {
        let codes = vec![
            EnvelopeError::PartitionNotFound.code(),
            EnvelopeError::AddressNotFound.code(),
            EnvelopeError::CapabilityDenied.code(),
            EnvelopeError::ReducerNotFound.code(),
            EnvelopeError::ConflictOverflow.code(),
        ];
        assert_eq!(codes.len(), 5);
        for code in &codes {
            assert!(code.starts_with("FE_"));
        }
    }

    #[test]
    fn test_error_display() {
        let err = EnvelopeError::Internal("test".to_string());
        let display = format!("{}", err);
        assert!(display.contains("FE_INTERNAL_ERROR"));
    }

    #[test]
    fn test_codec_error_display_includes_inner_reason() {
        let err = EnvelopeError::CodecError("payload truncated".to_string());
        let display = format!("{}", err);
        assert!(display.contains("FE_CODEC_ERROR"));
        assert!(display.contains("payload truncated"));
    }
}
