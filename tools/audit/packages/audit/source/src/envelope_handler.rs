// crates/audit/src/envelope_handler.rs
//
//! # Audit QueryHandler — DispatchSlot Universal Write Observer
//!
//! Implements `slot_protocol::handler::QueryHandler` for the audit slot.
//!
//! Operations:
//! - `write_observed` — receives generic write notifications from ANY slot,
//!   signs them, and appends to the immutable audit log. This is the L063
//!   structural replacement for the old DataBackend decorator pattern.
//!   Audit SUBSCRIBES to writes instead of WRAPPING the write path.
//! - `append` — manually append a pre-built audit event
//! - `query` — query audit events by criteria
//! - `verify` — verify an event's cryptographic signature

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use ed25519_dalek::SigningKey;
use slot_protocol::handler::{deserialize_payload, serialize_response, QueryHandler, QueryResult};
use slot_protocol::{Envelope, EnvelopeError};

use crate::signing;
use crate::sink::{AuditEvent, AuditSink, QueryCriteria};

// ---------------------------------------------------------------------------
// Request/Response wire types (self-describing payload — L090)
// ---------------------------------------------------------------------------

/// Inbound query payload — self-describing via `operation` field.
#[derive(serde::Deserialize)]
struct AuditPayload {
    /// Operation: "write_observed", "append", "query", "verify"
    operation: String,
    /// Audit event (for "append" and "verify")
    #[serde(default)]
    event: Option<AuditEvent>,
    /// Query criteria (for "query")
    #[serde(default)]
    criteria: Option<QueryCriteria>,
    /// Write observation (for "write_observed") — generic, slot-agnostic
    #[serde(default)]
    write: Option<WriteObservation>,
}

/// A generic write observation from any slot.
///
/// The composition root (or ExternalWriter pipeline) sends this to audit
/// after every committed write. Audit has ZERO knowledge of which slot
/// produced it — it just sees partition, address, action, and optional payload.
///
/// This is the L063 structural replacement for the DataBackend decorator:
/// - Old: audit wraps eeaf DataBackend, intercepts every method, imports eeaf types
/// - New: audit receives this generic struct, signs it, appends. Zero eeaf knowledge.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WriteObservation {
    /// Which slot produced the write (e.g., "eeaf", "credentials-vault", "trigger-engine")
    pub slot_name: String,
    /// Partition identity (hex-encoded)
    pub partition_key: String,
    /// What happened: "create", "update", "delete", "patch", "append"
    pub action: String,
    /// Resource type or address (slot-defined, opaque to audit)
    pub resource_type: String,
    /// Resource identity (slot-defined, opaque to audit)
    pub resource_id: String,
    /// Actor who performed the write (if known)
    #[serde(default)]
    pub actor_id: Option<String>,
    /// Optional payload snapshot (after-state), opaque JSON
    #[serde(default)]
    pub after_value: Option<serde_json::Value>,
}

/// Outbound response.
#[derive(serde::Serialize)]
struct AuditResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    events: Option<Vec<AuditEvent>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ---------------------------------------------------------------------------
// AuditQueryHandler
// ---------------------------------------------------------------------------

/// QueryHandler for the audit slot — universal write observer.
///
/// Receives write notifications from ANY slot via `write_observed` operation.
/// Signs each observation with ed25519 and appends to the immutable audit log.
/// Has ZERO knowledge of eeaf, DataBackend, or any slot internals.
pub struct AuditQueryHandler {
    sink: Arc<dyn AuditSink>,
    signing_key: Arc<SigningKey>,
}

impl AuditQueryHandler {
    pub fn new(sink: Arc<dyn AuditSink>, signing_key: Arc<SigningKey>) -> Self {
        Self { sink, signing_key }
    }
}

impl QueryHandler for AuditQueryHandler {
    fn query(
        &self,
        envelope: Envelope,
    ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>> {
        Box::pin(async move {
            let req: AuditPayload = deserialize_payload(&envelope, "audit")?;

            let response = match req.operation.as_str() {
                // -------------------------------------------------------
                // write_observed — universal write subscription (L063)
                //
                // ANY slot's writes arrive here as a WriteObservation.
                // Audit signs and appends. Zero slot-specific knowledge.
                // This is the REPLACEMENT for the deleted DataBackend
                // decorator (backend.rs). Capability INCREASE: logs ALL
                // slots, not just eeaf. O(1) — new slots auto-observed.
                // -------------------------------------------------------
                "write_observed" => {
                    let obs = req.write.ok_or_else(|| {
                        EnvelopeError::CodecError(
                            "audit write_observed requires 'write' field".to_string(),
                        )
                    })?;

                    // Convert WriteObservation → AuditEvent
                    let mut event = AuditEvent::new(
                        obs.partition_key,
                        obs.actor_id,
                        obs.action,
                        obs.resource_type,
                        obs.resource_id,
                    )
                    .with_metadata(serde_json::json!({ "slot": obs.slot_name }));

                    if let Some(after) = obs.after_value {
                        event = event.with_after(after);
                    }

                    // Sign the event
                    match signing::sign_event(&event, &self.signing_key) {
                        Ok(sig) => {
                            event.signature = sig;
                            match self.sink.append_event(event).await {
                                Ok(()) => serialize_response(
                                    &AuditResponse {
                                        success: true,
                                        events: None,
                                        verified: None,
                                        error: None,
                                    },
                                    "audit",
                                ),
                                Err(e) => serialize_response(
                                    &AuditResponse {
                                        success: false,
                                        events: None,
                                        verified: None,
                                        error: Some(e.to_string()),
                                    },
                                    "audit",
                                ),
                            }
                        }
                        Err(e) => serialize_response(
                            &AuditResponse {
                                success: false,
                                events: None,
                                verified: None,
                                error: Some(e.to_string()),
                            },
                            "audit",
                        ),
                    }
                }

                "append" => {
                    let event = req.event.ok_or_else(|| {
                        EnvelopeError::CodecError("audit append requires 'event' field".to_string())
                    })?;
                    match self.sink.append_event(event).await {
                        Ok(()) => serialize_response(
                            &AuditResponse {
                                success: true,
                                events: None,
                                verified: None,
                                error: None,
                            },
                            "audit",
                        ),
                        Err(e) => serialize_response(
                            &AuditResponse {
                                success: false,
                                events: None,
                                verified: None,
                                error: Some(e.to_string()),
                            },
                            "audit",
                        ),
                    }
                }

                "query" => {
                    let criteria = req.criteria.unwrap_or_else(QueryCriteria::all);
                    match self.sink.query_events(criteria).await {
                        Ok(events) => serialize_response(
                            &AuditResponse {
                                success: true,
                                events: Some(events),
                                verified: None,
                                error: None,
                            },
                            "audit",
                        ),
                        Err(e) => serialize_response(
                            &AuditResponse {
                                success: false,
                                events: None,
                                verified: None,
                                error: Some(e.to_string()),
                            },
                            "audit",
                        ),
                    }
                }

                "verify" => {
                    let event = req.event.ok_or_else(|| {
                        EnvelopeError::CodecError("audit verify requires 'event' field".to_string())
                    })?;
                    match self.sink.verify_event(&event).await {
                        Ok(valid) => serialize_response(
                            &AuditResponse {
                                success: true,
                                events: None,
                                verified: Some(valid),
                                error: None,
                            },
                            "audit",
                        ),
                        Err(e) => serialize_response(
                            &AuditResponse {
                                success: false,
                                events: None,
                                verified: None,
                                error: Some(e.to_string()),
                            },
                            "audit",
                        ),
                    }
                }

                unknown => Err(EnvelopeError::CodecError(format!(
                    "Unknown audit operation '{}'. Valid: write_observed, append, query, verify.",
                    unknown
                ))),
            }?;
            Ok(QueryResult::read_only(response))
        })
    }
}

/// Create an `AuditQueryHandler` wrapping the given sink and signing key.
///
/// The signing key is used to cryptographically sign every write observation
/// before appending to the audit log. This provides tamper-evidence:
/// a modified log entry has an invalid signature.
pub fn create_query_handler(
    sink: Arc<dyn AuditSink>,
    signing_key: Arc<SigningKey>,
) -> Arc<dyn QueryHandler> {
    Arc::new(AuditQueryHandler::new(sink, signing_key))
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_deserialization_write_observed() {
        let json = r#"{"operation":"write_observed","write":{"slot_name":"eeaf","partition_key":"abc123","action":"create","resource_type":"entity","resource_id":"e1"}}"#;
        let payload: AuditPayload = serde_json::from_str(json).unwrap();
        assert_eq!(payload.operation, "write_observed");
        assert!(payload.write.is_some());
        let obs = payload.write.unwrap();
        assert_eq!(obs.slot_name, "eeaf");
        assert_eq!(obs.action, "create");
        assert!(obs.actor_id.is_none());
        assert!(obs.after_value.is_none());
    }

    #[test]
    fn write_observation_with_after_value() {
        let json = r#"{"operation":"write_observed","write":{"slot_name":"credentials-vault","partition_key":"ws:1","action":"update","resource_type":"secret","resource_id":"s1","actor_id":"user:42","after_value":{"key":"redacted"}}}"#;
        let payload: AuditPayload = serde_json::from_str(json).unwrap();
        let obs = payload.write.unwrap();
        assert_eq!(obs.slot_name, "credentials-vault");
        assert_eq!(obs.actor_id, Some("user:42".to_string()));
        assert!(obs.after_value.is_some());
    }

    #[test]
    fn write_observation_serializes_round_trip() {
        let obs = WriteObservation {
            slot_name: "trigger-engine".to_string(),
            partition_key: "partition:default".to_string(),
            action: "delete".to_string(),
            resource_type: "trigger".to_string(),
            resource_id: "t1".to_string(),
            actor_id: None,
            after_value: None,
        };
        let json = serde_json::to_string(&obs).unwrap();
        let back: WriteObservation = serde_json::from_str(&json).unwrap();
        assert_eq!(back.slot_name, "trigger-engine");
        assert_eq!(back.action, "delete");
    }

    #[test]
    fn payload_deserialization_append() {
        let json = r#"{"operation":"append","event":{"event_id":"01","partition_key":"ws:1","timestamp":0,"actor_id":null,"action":"create","resource_type":"entity","resource_id":"e1","before_value":null,"after_value":null,"metadata":{},"signature":""}}"#;
        let payload: AuditPayload = serde_json::from_str(json).unwrap();
        assert_eq!(payload.operation, "append");
        assert!(payload.event.is_some());
    }

    #[test]
    fn payload_deserialization_query() {
        let json = r#"{"operation":"query","criteria":{"action":"create"}}"#;
        let payload: AuditPayload = serde_json::from_str(json).unwrap();
        assert_eq!(payload.operation, "query");
        assert!(payload.criteria.is_some());
    }

    #[test]
    fn response_serialization() {
        let resp = AuditResponse {
            success: true,
            events: None,
            verified: None,
            error: None,
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"success\":true"));
        assert!(!json.contains("events"));
    }

    #[test]
    fn handler_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<AuditQueryHandler>();
    }
}
