// crates/workflow-core/src/stores/remote_event_store.rs
//
// Purpose:
//   EventStore implementation via payload-blind Envelope dispatch.
//   ZERO database knowledge. ZERO target-slot hardcoding.
//
// Non-Negotiable Invariants:
//   1. NO data-store crate imports, NO SqlQueryable — only serde_json + workflow domain types.
//   2. All operations dispatch via EnvelopeDispatchFn.

use std::sync::Arc;

use super::EnvelopeDispatchFn;
use crate::domain::errors::{WorkflowError, WorkflowResult};
use crate::domain::{EventStore, TriggerEvent};

/// EventStore that sends requests to a configured remote address.
pub struct RemoteEventStore {
    dispatch: Arc<EnvelopeDispatchFn>,
    target_address: Arc<str>,
}

impl RemoteEventStore {
    pub fn new(dispatch: Arc<EnvelopeDispatchFn>, target_address: impl Into<Arc<str>>) -> Self {
        Self {
            dispatch,
            target_address: target_address.into(),
        }
    }

    fn dispatch_request(&self, request: serde_json::Value) -> WorkflowResult<Arc<[u8]>> {
        let request_bytes =
            serde_json::to_vec(&request).map_err(|e| WorkflowError::ExecutionFailed {
                reason: format!("Failed to serialize Envelope request: {}", e),
                hint: "Internal serialization error".to_string(),
            })?;
        let partition_key = request
            .get("partition_key")
            .and_then(|v| v.as_str())
            .ok_or_else(|| WorkflowError::ExecutionFailed {
                reason: "Remote event-store request missing partition_key".to_string(),
                hint: "Build event-store requests through the EventStore API so the envelope partition is explicit."
                    .to_string(),
            })?;
        let dispatch_partition = slot_protocol::PartitionKey::hash_from(partition_key);

        (self.dispatch)(
            &self.target_address,
            &dispatch_partition,
            Some(&request_bytes),
            None,
        )
        .map_err(|e| WorkflowError::ExecutionFailed {
            reason: format!("Envelope dispatch failed: {}", e),
            hint: "Check the configured event-store target address is registered and reachable"
                .to_string(),
        })
    }
}

impl EventStore for RemoteEventStore {
    fn poll_new_events(
        &self,
        partition_key: &str,
        batch_size: u32,
    ) -> WorkflowResult<Vec<TriggerEvent>> {
        let response_bytes = self.dispatch_request(serde_json::json!({
            "operation": "poll_new_events",
            "partition_key": partition_key,
            "batch_size": batch_size,
        }))?;
        serde_json::from_slice(&response_bytes).map_err(|e| WorkflowError::ExecutionFailed {
            reason: format!("Failed to deserialize events: {}", e),
            hint: "Unexpected response format from data slot".to_string(),
        })
    }

    fn mark_event_processed(&self, event_id: &str, partition_key: &str) -> WorkflowResult<()> {
        let response_bytes = self.dispatch_request(serde_json::json!({
            "operation": "mark_event_processed",
            "event_id": event_id,
            "partition_key": partition_key,
        }))?;
        // Response is either null/empty (success) or an error (caught in dispatch_request)
        let _ = response_bytes;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mock_event_dispatch(
        target_address: &str,
        _partition_key: &slot_protocol::PartitionKey,
        payload: Option<&[u8]>,
        context: Option<&[u8]>,
    ) -> Result<Arc<[u8]>, String> {
        assert_eq!(target_address, "slot::event-store");
        assert!(context.is_none());
        let request_bytes = payload.ok_or_else(|| "missing request payload".to_string())?;
        let req: serde_json::Value =
            serde_json::from_slice(request_bytes).map_err(|e| e.to_string())?;
        let op = req["operation"].as_str().unwrap_or("");
        match op {
            "poll_new_events" => {
                let events = vec![TriggerEvent {
                    id: "ev-1".to_string(),
                    scope: "ws-1".to_string(),
                    kind: "test.event".to_string(),
                    payload: serde_json::to_vec(&json!({"key": "val"})).unwrap(),
                    timestamp: "2026-01-01T00:00:00Z".to_string(),
                    idempotency_key: None,
                    metadata: serde_json::to_vec(&json!({
                        "actor_id": "user-1",
                        "organization_id": "org-1"
                    }))
                    .unwrap(),
                }];
                Ok(Arc::from(
                    serde_json::to_vec(&events).unwrap().into_boxed_slice(),
                ))
            }
            "mark_event_processed" => Ok(Arc::from(b"null".to_vec().into_boxed_slice())),
            _ => Ok(Arc::from(b"[]".to_vec().into_boxed_slice())),
        }
    }

    #[test]
    fn poll_new_events_via_envelope() {
        let store = RemoteEventStore::new(Arc::new(mock_event_dispatch), "slot::event-store");
        let events = store.poll_new_events("ws-1", 10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "ev-1");
        assert_eq!(events[0].kind, "test.event");
    }

    #[test]
    fn mark_event_processed_via_envelope() {
        let store = RemoteEventStore::new(Arc::new(mock_event_dispatch), "slot::event-store");
        let result = store.mark_event_processed("ev-1", "ws-1");
        assert!(result.is_ok());
    }

    #[test]
    fn dispatch_failure_returns_error() {
        let failing = |_: &str,
                       _: &slot_protocol::PartitionKey,
                       _: Option<&[u8]>,
                       _: Option<&[u8]>|
         -> Result<Arc<[u8]>, String> { Err("Slot down".to_string()) };
        let store = RemoteEventStore::new(Arc::new(failing), "slot::event-store");
        let result = store.poll_new_events("ws-1", 10);
        assert!(result.is_err());
    }
}
