//! # Execution Contract — Pure Physics backend trait + error types
//!
//! This crate defines the execution contract: a generic `JobRunner` trait
//! and structured `ExecutionError` types. Each backend (process, runtime, container)
//! defines its OWN descriptor type — there is no unified descriptor. The routed
//! target name (for example, `compute.process`) identifies the executor.
//!
//! **Key Invariants:**
//! - JobRunner trait is the Physics contract for any executor implementation
//! - Payload is opaque bytes — each backend deserializes its own descriptor type (L090)
//! - Zero heavy dependencies (no tokio, hyper, reqwest, wasmtime, v8)
//!
//! **Dependencies:**
//! - thiserror (for structured error types)
//! - async-trait (for trait async methods)
//! - slot-protocol (for Envelope type used in execute inputs/outputs)

use async_trait::async_trait;

pub use slot_protocol::{Envelope, FactAddress, PartitionKey};

pub mod config;
pub use config::CompilationConfig;

pub mod product_word_ids;
pub use product_word_ids::ProductWordIds;

pub mod process_types;
pub use process_types::{
    decode_admitted_process_descriptor, decode_process_descriptor, decode_process_result,
    decode_process_source_archive, encode_admitted_process_descriptor, encode_process_descriptor,
    encode_process_result, encode_process_source_archive, issue_external_provider_admission,
    normalize_process_path_segments, normalize_process_relative_path,
    seal_process_containment_receipt, verify_process_containment_receipt,
    AdmittedExternalProcessDescriptor, AdmittedNativeProcessDescriptor, AdmittedProcessDescriptor,
    ExternalProviderProcessContainmentReceipt, NativeProcessContainmentReceipt, ProcessCapturedFd,
    ProcessCapturedFdIdentity, ProcessCodeIdentity, ProcessCollectedFile, ProcessCollectedFileSpec,
    ProcessComputerAccess, ProcessContainmentPolicy, ProcessContainmentReceipt,
    ProcessContainmentRequest, ProcessDescriptor, ProcessExecutableBinding,
    ProcessExecutionCapabilitySet, ProcessExternalProviderAdmission,
    ProcessExternalProviderAttestation, ProcessExternalProviderExecutionIdentity,
    ProcessExternalProviderLifecycleEvidence, ProcessFileGeneration, ProcessFileIdentity,
    ProcessImageObservation, ProcessImmutablePublicationReceipt,
    ProcessImmutablePublicationRequest, ProcessImmutablePublicationSpec, ProcessInputMount,
    ProcessInputSource, ProcessInputTreeMount, ProcessInputTreeSource, ProcessLimits,
    ProcessNetworkAccess, ProcessOutputAddressMode, ProcessOutputArtifact, ProcessOutputChunk,
    ProcessOutputChunkManifest, ProcessOutputMount, ProcessOutputStorage, ProcessOutputWriteSet,
    ProcessOutputWriteSetEntry, ProcessPrivateVolumeRef, ProcessResult, ProcessSourceArchive,
    ProcessSourceArchiveFile, ProcessTermination, DEFAULT_PROCESS_DESCENDANT_PIPE_EOF_TIMEOUT_MS,
    DEFAULT_PROCESS_TERMINATION_GRACE_MS, PROCESS_CONTAINMENT_RECEIPT_CHECKSUM_CANONICALIZATION,
};

pub mod process_workspace_types;
pub use process_workspace_types::{
    ProcessRuntimeEnvironmentValue, ProcessWorkspaceArgumentBinding,
    ProcessWorkspaceArgumentValuePart, ProcessWorkspaceEnvironmentBinding,
    ProcessWorkspaceEnvironmentValuePart, ProcessWorkspaceExecutionBindings,
};

pub mod process_sequence_types;
pub use process_sequence_types::{
    decode_process_sequence_descriptor, decode_process_sequence_result,
    decode_process_sequence_result_for_descriptor, encode_process_sequence_descriptor,
    encode_process_sequence_output_evidence, encode_process_sequence_result,
    process_sequence_descriptor_golden_bytes, process_sequence_output_artifact,
    ProcessSequenceDescriptor, ProcessSequenceOutputEvidence, ProcessSequenceOutputReference,
    ProcessSequenceResult, ProcessSequenceStep, ProcessSequenceStepResult,
    PROCESS_SEQUENCE_DESCRIPTOR_GOLDEN_CONTENT_HASH,
};

pub mod process_session_types;
pub use process_session_types::{
    decode_process_session_event_delta, decode_process_session_event_head,
    decode_process_session_events_feed, decode_process_session_surface_isolation_bindings,
    encode_process_session_event_delta, encode_process_session_event_head,
    encode_process_session_events_feed, encode_process_sessions_feed,
    validate_process_session_idempotency_key, ProcessSessionCommand, ProcessSessionDescriptor,
    ProcessSessionEvent, ProcessSessionEventDelta, ProcessSessionEventHead,
    ProcessSessionEventKind, ProcessSessionEventsFeed, ProcessSessionEventsFeedCodecError,
    ProcessSessionOutputStream, ProcessSessionRequest, ProcessSessionResponse,
    ProcessSessionSettings, ProcessSessionSignal, ProcessSessionSnapshot, ProcessSessionState,
    ProcessSessionSurfaceIsolationBinding, ProcessSessionSurfaceIsolationObservation,
    ProcessSessionSurfaceIsolationPublication, ProcessSessionTextGrid, ProcessSessionsFeed,
    ProcessSessionsFeedCodecError, PROCESS_SESSIONS_FEED_CELL_TABLE_COLUMN_COUNT,
    PROCESS_SESSIONS_FEED_LABEL, PROCESS_SESSION_EVENTS_FEED_BINARY_VERSION,
    PROCESS_SESSION_EVENTS_FEED_HEAD_BINARY_VERSION, PROCESS_SESSION_EVENTS_FEED_LABEL,
    PROCESS_SESSION_EVENT_DELTA_BINARY_VERSION, PROCESS_SESSION_EVENT_STREAM_LABEL,
    PROCESS_SESSION_IDEMPOTENCY_KEY_MAX_BYTES, PROCESS_SESSION_START_IDEMPOTENCY_LABEL,
    PROCESS_SESSION_SURFACE_OBSERVATION_LABEL, PROCESS_SESSION_TERMINAL_OUTPUT_LABEL,
};

/// Execution errors — structured, machine-readable error types.
#[derive(Debug, thiserror::Error)]
pub enum ExecutionError {
    /// Executor (compiler/runtime) unavailable or not found.
    #[error("executor unavailable: {binary_path} — {reason}")]
    ExecutorUnavailable { binary_path: String, reason: String },

    /// Compilation or execution failed with stderr output.
    #[error("compilation failed: {stderr}")]
    CompilationFailed { stderr: String },

    /// Invalid execution descriptor — field and reason specified.
    #[error("invalid descriptor: field={field}, reason={reason}")]
    InvalidDescriptor { field: String, reason: String },

    /// Execution timed out after the specified duration.
    #[error("execution timed out after {timeout_ms}ms")]
    Timeout { timeout_ms: u64 },

    /// Execution cancelled via external cancellation signal.
    #[error("execution cancelled")]
    Cancelled,

    /// Process output exceeded the configured inline-result byte ceiling.
    #[error("process output exceeded {max_output_bytes} byte limit")]
    OutputLimit { max_output_bytes: u64 },

    /// The current platform cannot provide every mandatory containment proof.
    #[error("mandatory process containment unavailable on {platform}: {reason}")]
    ContainmentUnavailable { platform: String, reason: String },

    /// A native admission, containment, identity, EOF, or publication
    /// invariant failed. No successful containment receipt is emitted.
    #[error("process containment violation at {stage}: {reason}")]
    ContainmentViolation { stage: String, reason: String },

    /// The kernel reported an exact terminal state different from the request.
    ///
    /// `captured` carries a bounded tail of what the process actually printed. A
    /// non-zero exit with no diagnosis is unactionable: the caller learns THAT a
    /// build or step failed and nothing about WHY, while the child's stderr was
    /// captured and then discarded. Callers that have no capture pass an empty
    /// string, and the message then reads exactly as it did before.
    #[error(
        "unexpected native process termination: expected {expected}, observed {observed}{captured}"
    )]
    UnexpectedTermination {
        expected: String,
        observed: String,
        captured: String,
    },

    /// I/O error (file operations, process spawning, etc.).
    #[error("I/O error: {0}")]
    IoError(#[from] std::io::Error),
}

/// Format a bounded tail of captured descriptors for an error message.
///
/// Bounded because an error is a message, not a log: a build that printed ten
/// megabytes must not produce a ten-megabyte error. The tail is kept rather than the
/// head because the failure is at the end. Empty input yields an empty string, so a
/// caller with no capture reads exactly as it did before this existed.
pub fn format_captured_tail(captures: &[(u16, &[u8])]) -> String {
    const TAIL_BYTES: usize = 2000;
    let mut out = String::new();
    for (fd, bytes) in captures {
        if bytes.is_empty() {
            continue;
        }
        let start = bytes.len().saturating_sub(TAIL_BYTES);
        let text = String::from_utf8_lossy(&bytes[start..]);
        let trimmed = text.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        let elided = if start > 0 { " (tail)" } else { "" };
        out.push_str(&format!("\n  fd {fd}{elided}: {trimmed}"));
    }
    out
}

/// Platform execution contract — lives BELOW both workflow and compilation.
///
/// Any executor (process-engine, code-execution-runtime, container-engine, etc.)
/// implements this trait. The payload is opaque bytes — each backend deserializes
/// its own descriptor type from the payload (L090: self-describing data).
///
/// The Envelope address routes to the correct backend. No `substrate` field needed.
#[async_trait]
pub trait JobRunner: Send + Sync {
    /// Run with the given opaque payload and input envelopes.
    ///
    /// **Parameters:**
    /// - `payload`: Opaque bytes — each backend deserializes its own descriptor type
    /// - `inputs`: Vec<Envelope> containing input data for the execution
    ///
    /// **Returns:**
    /// - Ok(Vec<Envelope>): Output envelopes from successful execution
    /// - Err(ExecutionError): Structured error describing what failed
    async fn run(
        &self,
        payload: &[u8],
        inputs: Vec<Envelope>,
    ) -> Result<Vec<Envelope>, ExecutionError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_execution_error_display() {
        let err = ExecutionError::ExecutorUnavailable {
            binary_path: "/usr/bin/rustc".into(),
            reason: "not found".into(),
        };
        assert!(err.to_string().contains("rustc"));

        let err = ExecutionError::Timeout { timeout_ms: 5000 };
        assert!(err.to_string().contains("5000"));

        let err = ExecutionError::InvalidDescriptor {
            field: "binary_path".into(),
            reason: "required".into(),
        };
        assert!(err.to_string().contains("binary_path"));

        let err = ExecutionError::OutputLimit {
            max_output_bytes: 1024,
        };
        assert!(err.to_string().contains("1024"));
    }

    #[test]
    fn test_execution_error_from_io() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file not found");
        let err: ExecutionError = io_err.into();
        assert!(matches!(err, ExecutionError::IoError(_)));
    }
}
