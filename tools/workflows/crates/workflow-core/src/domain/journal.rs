// crates/workflow-core/src/domain/journal.rs
//
// Purpose:
//   Canonical domain types for the workflow durability journal. These types
//   define the append-only execution journal format — the single source of
//   truth for all workflow execution state.
//
// Non-Negotiable Invariants:
//   1. serde_json::Value is BANNED. Every field is strictly typed.
//   2. Canonical encoding is CBOR with deterministic sorted keys (RFC 8949 §4.2.1).
//   3. These types are framework-agnostic — no platform-specific dependencies.
//   4. JournalRecord is the envelope; JournalEntry variants carry step payloads.
//   5. Chain metadata (seq, prev_hash, hlc, lease_binding) is on JournalRecord,
//      NOT on individual JournalEntry variants (Round 7 fix).
//
// Key Concepts:
//   - JournalRecord: Envelope wrapping every journal entry with chain metadata
//   - JournalEntry: Enum of all state transitions (StepStarted, StepCompleted, etc.)
//   - LeaseBinding: SP7 session binding carried on every entry
//   - PrimitivePermissions: Per-primitive execution policy from signed lease
//   - ExternalRef: CAS pointer for large payloads
//
// Security Considerations:
//   - SP4: Signature covers (local_seq, workflow_id, prev_hash, hlc, lease_binding, payload)
//   - SP7: Every entry carries lease_binding (lease_id + device_id + user_id)
//   - SP3: latest accepted time enforced via effective_time = MAX(system_clock, latest_accepted_time, lease.issued_at)

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============================================================================
// Type Aliases
// ============================================================================

/// Workflow instance identifier
pub type WorkflowId = String;

/// Step identifier within a workflow
pub type StepId = String;

/// Lease identifier for session binding
pub type LeaseId = String;

/// Device identifier for session binding
pub type DeviceId = String;

/// User identifier for session binding
pub type UserId = String;

/// Cryptographic hash digest bytes (blake3-256)
pub type Hash = [u8; 32];

/// Digital signature bytes
pub type Signature = Vec<u8>;

/// Hybrid logical clock timestamp
pub type HybridLogicalClock = u64;

/// Cursor for resumption/snapshot recovery
pub type ResumptionCursor = u64;

/// Workflow definition identifier
pub type DefinitionId = String;

/// Correlation identifier for event tracing
pub type CorrelationId = String;

/// Idempotency key for operation deduplication
pub type IdempotencyKey = String;

// ============================================================================
// Canonical Zero Hash
// ============================================================================

/// The zero hash used as the genesis entry in the chain
pub const CANONICAL_ZERO_HASH: Hash = [0u8; 32];

// ============================================================================
// Journal Record Types — re-exported from journal-ast (L088 SSOT leaf extraction)
// ============================================================================
pub use journal_ast::{compute_record_hash, ChangeAuthor, JournalRecord, Timestamp, GENESIS_HASH};

// ============================================================================
// Core Journal Types
// ============================================================================

/// Workflow journal envelope — carries workflow-specific metadata alongside the entry.
/// It wraps the generic state transition (JournalEntry) with workflow-specific
/// chain metadata: sequence number, HLC timestamp, lease binding, and identity info.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEnvelope {
    /// Monotonically increasing sequence number (local to device)
    pub local_seq: u64,

    /// Workflow instance this entry belongs to
    pub workflow_id: WorkflowId,

    /// Hybrid logical clock timestamp
    pub hlc: HybridLogicalClock,

    /// Session binding (lease + device + user) — SP7 context binding
    pub lease_binding: LeaseBinding,

    /// The actual state transition payload
    pub entry: JournalEntry,
}

/// Workflow journal record = hash-chained record with our envelope as payload.
///
/// Uses canonical CBOR encoding + blake3 multihash identity while carrying
/// workflow-specific metadata in the payload.
pub type WorkflowJournalRecord = JournalRecord<WorkflowEnvelope>;

/// Lease binding information — SP7 context binding for every entry.
/// Carried on the JournalRecord envelope, not on individual entry variants.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LeaseBinding {
    /// The lease under which this entry was written
    pub lease_id: LeaseId,

    /// Device that wrote this entry
    pub device_id: DeviceId,

    /// User context
    pub user_id: UserId,

    /// Lease expiration time (HLC)
    pub expires_at: HybridLogicalClock,

    /// Max offline ticks allowed by this lease
    pub max_offline_ticks: u64,

    /// Key type used by the lease (Hardware or Software)
    pub journal_key_type: KeyType,

    /// Per-primitive execution policies granted by this lease
    pub primitive_permissions: PrimitivePermissions,
}

/// Key type for cryptographic binding
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum KeyType {
    /// Hardware-backed key (TEE, secure enclave)
    Hardware,

    /// Software key (encrypted at rest)
    Software,
}

impl Default for LeaseBinding {
    fn default() -> Self {
        Self {
            lease_id: String::new(),
            device_id: String::new(),
            user_id: String::new(),
            expires_at: 0,
            max_offline_ticks: 0,
            journal_key_type: KeyType::Software,
            primitive_permissions: PrimitivePermissions::default(),
        }
    }
}

/// Per-primitive execution policies from the signed lease
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrimitivePermissions {
    /// Policy for _transact primitive
    pub transact: ExecutionPolicy,

    /// Policy for _call_external primitive
    pub call_external: ExecutionPolicy,

    /// Policy for _embodiment primitive
    pub embodiment: ExecutionPolicy,

    /// Policy for _execute primitive
    pub execute: ExecutionPolicy,

    /// Policy for _journal_append primitive
    pub journal_append: ExecutionPolicy,

    /// Policy for _schema_write primitive
    pub schema_write: ExecutionPolicy,
}

/// Execution policy for a primitive
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub enum ExecutionPolicy {
    /// Changes are committed to local state immediately
    LocalCommit,

    /// Changes are pending — awaiting authority confirmation
    #[default]
    PendingCommit,

    /// Only the authority can execute this primitive
    AuthorityOnly,
}

// Default derived — all fields are ExecutionPolicy which defaults to PendingCommit.

// ============================================================================
// Journal Entry Enum
// ============================================================================

/// All possible state transitions in the workflow journal.
/// Each variant represents a discrete event in the execution timeline.
/// The JournalRecord envelope carries chain metadata; entry variants carry step payloads.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "data")]
#[serde(rename_all = "camelCase")]
pub enum JournalEntry {
    /// Step execution started
    StepStarted {
        step_id: StepId,
        attempt: u32,
        input: StepInput,
    },

    /// Step execution completed successfully
    StepCompleted {
        step_id: StepId,
        output: StepOutput,
        duration_ns: u64,
    },

    /// Step execution failed
    StepFailed {
        step_id: StepId,
        error: StepError,
        action: ErrorAction,
    },

    /// Workflow suspended, waiting for a signal/event/timeout
    Suspended {
        step_id: StepId,
        wait_condition_name: String,
        wait_condition: WaitCondition,
        suspend_payload: SuspendPayload,
    },

    /// Workflow resumed from suspension
    Resumed {
        step_id: StepId,
        resolution: SignalResolution,
        resume_payload: ResumePayload,
    },

    /// Pending commit — intent to mutate state, awaiting authority confirmation
    PendingCommit {
        step_id: StepId,
        intent: PrimitiveIntent,
        expected_result: StepOutput,
    },

    /// Authority confirmed the pending commit
    CommitConfirmed { step_id: StepId, authority_seq: u64 },

    /// Authority rejected the pending commit
    CommitRejected {
        step_id: StepId,
        reason: RejectionReason,
        rollback_to: u64,
    },

    /// Snapshot of current execution state
    Snapshot {
        cursor: ResumptionCursor,
        materialized_state: StatePayload,
        trim_before: u64,
        signature: SnapshotSignature,
    },

    /// Workflow definition version changed
    VersionChange {
        old_definition_id: DefinitionId,
        new_definition_id: DefinitionId,
    },
}

// ============================================================================
// Wait Conditions
// ============================================================================

/// Condition that must be met to resume from suspension
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "data")]
pub enum WaitCondition {
    /// Wait for an external event
    Event {
        name: String,
        correlation_field: Option<String>,
    },

    /// Wait until a specific time
    Duration { resume_at: HybridLogicalClock },

    /// Wait for a named signal
    Signal { key: String },
}

// ============================================================================
// Snapshot Types
// ============================================================================

/// Signature attesting to the validity of a snapshot
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum SnapshotSignature {
    /// Signed by the local device
    LocalAttestation(Signature),

    /// Confirmed by the authority
    AuthorityConfirmed(Signature),
}

/// State payload for snapshots — can be inline or external
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum StatePayload {
    /// Full execution state embedded in the journal
    Inline(ExecutionState),

    /// Reference to external CAS blob
    External(ExternalRef),
}

// ============================================================================
// Input Types (Per-Primitive)
// ============================================================================

/// Input to a step — tagged by primitive type
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "primitive", content = "params")]
pub enum StepInput {
    /// _transact primitive input
    Transact(TransactInput),

    /// _call_external primitive input
    CallExternal(CallExternalInput),

    /// _embodiment primitive input
    Embodiment(EmbodimentInput),

    /// _execute primitive input
    Execute(ExecuteInput),

    /// _journal_append primitive input
    JournalAppend(JournalAppendInput),

    /// _schema_write primitive input
    SchemaWrite(SchemaWriteInput),
}

/// Input for _transact primitive
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransactInput {
    /// Operations to apply
    pub operations: Vec<TransactOperation>,
}

/// A single transact operation
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransactOperation {
    /// Operation type (e.g., "create", "update", "delete")
    pub operation: String,

    /// Optional entity ID being operated on
    pub entity_id: Option<String>,

    /// Optional property ID being operated on
    pub property_id: Option<String>,

    /// Operation value (if applicable)
    pub value: Option<CborValue>,
}

/// Strictly typed CBOR-compatible value representation.
/// Replaces serde_json::Value throughout the journal domain.
/// Supports all CBOR types while maintaining deterministic encoding.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum CborValue {
    /// Null value
    Null,

    /// Boolean value
    Bool(bool),

    /// Integer value
    Integer(i64),

    /// Floating-point value
    Float(f64),

    /// Text string
    Text(String),

    /// Binary bytes
    Bytes(Vec<u8>),

    /// Array of values
    Array(Vec<CborValue>),

    /// Map of string keys to values
    Map(Vec<(String, CborValue)>),
}

/// Input for _call_external primitive
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CallExternalInput {
    /// URL to call
    pub url: String,

    /// HTTP method
    pub method: String,

    /// Request headers
    pub headers: Vec<(String, String)>,

    /// Request body (if applicable)
    pub body: Option<Vec<u8>>,

    /// Request timeout in milliseconds
    pub timeout_ms: u64,

    /// Idempotency key for deduplication
    pub idempotency_key: IdempotencyKey,
}

/// Input for _embodiment primitive
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EmbodimentInput {
    /// Command to execute
    pub command: String,

    /// Command-line arguments
    pub args: Vec<String>,

    /// Environment variables
    pub environment: Vec<(String, String)>,

    /// Execution timeout in milliseconds
    pub timeout_ms: u64,

    /// Idempotency key for deduplication
    pub idempotency_key: IdempotencyKey,
}

/// Input for _execute primitive
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteInput {
    /// Hash of the WASM module
    pub module_hash: Hash,

    /// Function to invoke
    pub function_name: String,

    /// Input parameters encoded as CBOR
    pub input_cbor: Vec<u8>,

    /// Fuel limit for execution
    pub fuel_limit: u64,

    /// Memory limit in bytes
    pub memory_limit_bytes: u64,
}

/// Input for _journal_append primitive
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JournalAppendInput {
    /// Event ID
    pub event_id: String,

    /// Event type
    pub event_type: String,

    /// Event payload
    pub payload: CborValue,
}

/// Input for _schema_write primitive
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaWriteInput {
    /// Schema operations to apply
    pub operations: Vec<TransactOperation>,
}

// ============================================================================
// Output and Error Types
// ============================================================================

/// Output from a successfully completed step
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepOutput {
    /// The output value
    pub value: CborValue,
}

/// Error information from a failed step
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepError {
    /// Error code (machine-readable)
    pub code: DurabilityErrorCode,

    /// Error message (human-readable)
    pub message: String,

    /// Optional remediation hint
    pub remediation: Option<RemediationHint>,
}

/// Durability error codes
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum DurabilityErrorCode {
    /// Journal entry is corrupted
    JournalCorruption,

    /// The lease has expired
    LeaseExpired,

    /// Resource exhausted (memory, storage, etc.)
    ResourceExhausted,

    /// Payload exceeds size limits
    OversizedPayload,

    /// Workflow version is incompatible
    VersionIncompatible,

    /// Authority rejected the operation
    AuthorityRejected,

    /// Signature verification failed
    SignatureInvalid,

    /// Chain integrity check failed
    ChainBroken,

    /// WASM execution exhausted fuel
    FuelExhausted,

    /// Journal writer queue full — backpressure signal
    SystemOverload,

    /// Journal writer has shut down
    WriterDead,

    /// Authority-executed _callExternal targets private IP
    SsrfViolation,
}

/// Hints for recovering from errors
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum RemediationHint {
    /// Resynchronize from authority
    ResyncFromAuthority,

    /// Re-authenticate the session
    ReAuthenticate,

    /// Reduce payload size and retry
    ReducePayloadSize,

    /// Upgrade to newer workflow version
    UpgradeWorkflowVersion,

    /// Retry after exponential backoff
    RetryWithBackoff,

    /// Process must be restarted
    RestartProcess,
}

/// Action to take when a step fails
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum ErrorAction {
    /// Retry the step
    Retry,

    /// Skip to next step
    Skip,

    /// Abort the entire workflow
    Abort,

    /// Jump to a specific step
    Goto(StepId),
}

// ============================================================================
// Suspension and Resumption Types
// ============================================================================

/// Payload stored when workflow is suspended
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SuspendPayload {
    /// Workflow context at suspension time
    pub context: CborValue,
}

/// Payload provided when workflow is resumed
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResumePayload {
    /// Workflow context at resumption time
    pub context: CborValue,
}

/// Resolution value from a signal
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignalResolution {
    /// The resolved value
    pub value: CborValue,
}

// ============================================================================
// Commit Types
// ============================================================================

/// Intent to commit a state mutation
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrimitiveIntent {
    /// The primitive being executed
    pub primitive: String,

    /// The input to the primitive
    pub input: StepInput,
}

/// Reason for rejecting a commit
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum RejectionReason {
    /// The causal chain was broken
    CausalChainBroken,

    /// The lease has expired
    LeaseExpired,

    /// Permission denied
    PermissionDenied,

    /// Conflict with concurrent operations
    ConflictDetected,

    /// WASM fuel exhausted
    FuelExhausted,
}

// ============================================================================
// Snapshot Materialization
// ============================================================================

/// Materialized execution state for snapshots
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionState {
    /// Step results indexed by step ID
    pub step_results: HashMap<StepId, StepOutput>,

    /// Idempotency map: idempotency key -> HLC of execution
    pub idempotency_map: HashMap<IdempotencyKey, HybridLogicalClock>,

    /// Current resumption cursor
    pub cursor: ResumptionCursor,

    /// Speculative execution depth
    pub speculative_depth: u32,
}

// ============================================================================
// External References (CAS)
// ============================================================================

/// Reference to a large payload stored externally in CAS
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalRef {
    /// Content hash (SHA-256)
    pub hash: [u8; 32],

    /// Size in bytes
    pub size_bytes: u64,

    /// MIME type
    pub media_type: String,
}

// ============================================================================
// Lifecycle Events
// ============================================================================

/// Envelope for lifecycle events
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    /// The event type
    pub event_type: LifecycleEventType,

    /// Workflow instance identifier
    pub workflow_instance_id: WorkflowId,

    /// Correlation ID for tracing
    pub correlation_id: CorrelationId,

    /// Causation ID (previous event in chain)
    pub causation_id: u64,

    /// Device that generated this event
    pub device_id: DeviceId,

    /// Lease under which event was generated
    pub lease_id: LeaseId,

    /// Event timestamp
    pub timestamp: HybridLogicalClock,

    /// Span name for distributed tracing
    pub span_name: String,
}

/// Lifecycle event types
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum LifecycleEventType {
    /// Step started
    StepStarted,

    /// Step completed
    StepCompleted,

    /// Step failed
    StepFailed,

    /// Workflow suspended
    WorkflowSuspended,

    /// Workflow resumed
    WorkflowResumed,

    /// Commit pending
    CommitPending,

    /// Commit confirmed
    CommitConfirmed,

    /// Commit rejected
    CommitRejected,

    /// Snapshot created
    SnapshotCreated,

    /// Workflow version changed
    VersionChanged,
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    #[test]
    fn test_journal_record_round_trip_json() {
        let record = WorkflowJournalRecord {
            id: "rec-1".to_string(),
            timestamp: Timestamp::from_datetime(Utc::now()),
            actor: ChangeAuthor {
                actor_id: "user-1".to_string(),
            },
            prev_hash: GENESIS_HASH.to_string(),
            payload: WorkflowEnvelope {
                local_seq: 1,
                workflow_id: "workflow-1".to_string(),
                hlc: 1000,
                lease_binding: LeaseBinding {
                    lease_id: "lease-1".to_string(),
                    device_id: "device-1".to_string(),
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
        };

        let json = serde_json::to_string(&record).expect("serialize");
        let deserialized: WorkflowJournalRecord = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(record, deserialized);
    }

    #[test]
    fn test_step_started_entry() {
        let entry = JournalEntry::StepStarted {
            step_id: "step-1".to_string(),
            attempt: 1,
            input: StepInput::Transact(TransactInput { operations: vec![] }),
        };

        let json = serde_json::to_string(&entry).expect("serialize");
        let deserialized: JournalEntry = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(entry, deserialized);
    }

    #[test]
    fn test_camel_case_keys() {
        let record = WorkflowJournalRecord {
            id: "rec-1".to_string(),
            timestamp: Timestamp::from_datetime(Utc::now()),
            actor: ChangeAuthor {
                actor_id: "user-1".to_string(),
            },
            prev_hash: GENESIS_HASH.to_string(),
            payload: WorkflowEnvelope {
                local_seq: 1,
                workflow_id: "wf".to_string(),
                hlc: 1000,
                lease_binding: LeaseBinding {
                    lease_id: "lease-1".to_string(),
                    device_id: "device-1".to_string(),
                    user_id: "user-1".to_string(),
                    expires_at: 2000,
                    max_offline_ticks: 100,
                    journal_key_type: KeyType::Hardware,
                    primitive_permissions: PrimitivePermissions {
                        transact: ExecutionPolicy::LocalCommit,
                        call_external: ExecutionPolicy::LocalCommit,
                        embodiment: ExecutionPolicy::LocalCommit,
                        execute: ExecutionPolicy::LocalCommit,
                        journal_append: ExecutionPolicy::LocalCommit,
                        schema_write: ExecutionPolicy::LocalCommit,
                    },
                },
                entry: JournalEntry::StepCompleted {
                    step_id: "step-1".to_string(),
                    output: StepOutput {
                        value: CborValue::Null,
                    },
                    duration_ns: 100,
                },
            },
        };

        let json = serde_json::to_string(&record).expect("serialize");

        // WorkflowEnvelope uses camelCase (rename_all = "camelCase")
        assert!(json.contains("\"localSeq\""));
        assert!(json.contains("\"workflowId\""));
        assert!(json.contains("\"leaseBinding\""));
        assert!(json.contains("\"leaseId\""));
        assert!(json.contains("\"deviceId\""));
        assert!(json.contains("\"userId\""));
        assert!(json.contains("\"expiresAt\""));
        assert!(json.contains("\"maxOfflineTicks\""));
        assert!(json.contains("\"journalKeyType\""));
        assert!(json.contains("\"primitivePermissions\""));
    }
}
