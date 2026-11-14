// /crates/audit/src/sink.rs
//
// AuditEvent struct and AuditSink trait.
// Pure data structures for tamper-proof audit logging.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Audit event record with cryptographic signature
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEvent {
    pub event_id: String, // ulid::Ulid::new().to_string()
    pub partition_key: String,
    pub timestamp: i64,              // chrono::Utc::now().timestamp_millis()
    pub actor_id: Option<String>,    // user/service that performed action
    pub action: String,              // "create", "update", "delete", "read"
    pub resource_type: String,       // populated by whatever the producing slot sends
    pub resource_id: String,         // the resource ID affected
    pub before_value: Option<Value>, // JSON snapshot before change
    pub after_value: Option<Value>,  // JSON snapshot after change
    pub metadata: Value,             // { ip_address, user_agent, ... }
    pub signature: String,           // hex-encoded ed25519 signature
}

impl AuditEvent {
    /// Create a new audit event with required fields
    pub fn new(
        partition_key: String,
        actor_id: Option<String>,
        action: String,
        resource_type: String,
        resource_id: String,
    ) -> Self {
        Self {
            event_id: ulid::Ulid::new().to_string(),
            partition_key,
            timestamp: chrono::Utc::now().timestamp_millis(),
            actor_id,
            action,
            resource_type,
            resource_id,
            before_value: None,
            after_value: None,
            metadata: serde_json::json!({}),
            signature: String::new(), // Filled by signing module
        }
    }

    /// Add before value (state before change)
    pub fn with_before(mut self, value: Value) -> Self {
        self.before_value = Some(value);
        self
    }

    /// Add after value (state after change)
    pub fn with_after(mut self, value: Value) -> Self {
        self.after_value = Some(value);
        self
    }

    /// Add metadata (IP address, user agent, etc.)
    pub fn with_metadata(mut self, metadata: Value) -> Self {
        self.metadata = metadata;
        self
    }
}

/// Audit error types
#[derive(Debug, Clone)]
pub enum AuditError {
    SigningFailed(String),
    VerificationFailed(String),
    StorageFailed(String),
    QueryFailed(String),
}

impl std::fmt::Display for AuditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuditError::SigningFailed(msg) => write!(f, "Signing failed: {}", msg),
            AuditError::VerificationFailed(msg) => write!(f, "Verification failed: {}", msg),
            AuditError::StorageFailed(msg) => write!(f, "Storage failed: {}", msg),
            AuditError::QueryFailed(msg) => write!(f, "Query failed: {}", msg),
        }
    }
}

impl std::error::Error for AuditError {}

/// Query criteria for filtering audit events
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryCriteria {
    pub partition_key: Option<String>,
    pub action: Option<String>,
    pub resource_type: Option<String>,
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
}

impl QueryCriteria {
    /// Create criteria that matches all events
    pub fn all() -> Self {
        Self {
            partition_key: None,
            action: None,
            resource_type: None,
            start_time: None,
            end_time: None,
        }
    }
}

/// Audit sink trait - the interface for appending and querying audit events
#[async_trait::async_trait]
pub trait AuditSink: Send + Sync {
    /// Append an audit event to the immutable log
    async fn append_event(&self, event: AuditEvent) -> Result<(), AuditError>;

    /// Query audit events by criteria
    async fn query_events(&self, criteria: QueryCriteria) -> Result<Vec<AuditEvent>, AuditError>;

    /// Verify an event's cryptographic signature
    async fn verify_event(&self, event: &AuditEvent) -> Result<bool, AuditError>;

    /// Get the signing keypair for an opaque partition
    async fn get_keypair(
        &self,
        partition_key: &str,
    ) -> Result<ed25519_dalek::SigningKey, AuditError>;
}
