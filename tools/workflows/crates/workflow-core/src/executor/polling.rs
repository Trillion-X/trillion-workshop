// crates/workflow-core/src/executor/polling.rs
//
// Purpose:
//   Event polling engine for automation mode. Watches for new trigger events
//   via EventStore, matches them to registered Definitions via
//   DefinitionStore, and triggers execution with configurable retry logic.
//   This is the "heartbeat" that drives automated workflow execution.
//
// Non-Negotiable Invariants:
//   1. The poll interval is a configurable parameter — no hardcoded timing
//      constants. Timing is Society, not Physics.
//   2. Event matching uses DefinitionStore::get_by_trigger() — no
//      direct database access or SQL in this module.
//   3. TriggerEvent is the Physics wire type: id, scope, kind,
//      payload (opaque bytes), timestamp, idempotency_key,
//      metadata (opaque bytes). No source-specific fields.
//   4. Retry logic uses RetryPolicy from automation.rs — no duplicated
//      retry mechanism.
//   5. EventPoller is generic over DataBackend — same pattern as
//      AsyncWorkflowExecutor.
//   6. No `.unwrap()` in production code. All errors are structured with
//      remediation hints.
//   7. Processed event tracking uses EventStore trait — host layers decide
//      how to mark events as consumed (cursor, flag, etc.).
//
// Key Concepts:
//   - TriggerEvent: Generic event that drives workflow trigger matching
//   - EventStore: Trait for polling new events and marking them processed
//   - EventPoller: Configurable polling engine that runs the automation loop
//   - PollConfig: Configuration for poll interval, batch size, partition scope
//   - process_event(): Single event → match workflows → execute each
//
// Polling Loop Flow:
//
//   ```text
//   EventPoller::start_polling(config)
//       |
//       | loop {
//       |   1. Poll: EventStore::poll_new_events(partition_key, batch_size)
//       |   2. For each event:
//       |      a. Match: DefinitionStore::get_by_trigger(event_type)
//       |      b. Execute: AsyncWorkflowExecutor::execute_workflow(wf, trigger, actor)
//       |      c. Mark:   EventStore::mark_event_processed(event_id)
//       |   3. Sleep: tokio::time::sleep(poll_interval)
//       | }
//       v
//   Runs indefinitely until cancelled via CancellationToken
//   ```
//
// Security Considerations:
//   - Events are scoped by partition_key — no cross-tenant event leakage.
//   - Actor context for automated executions uses the event's actor_id.
//   - Poll interval is bounded to prevent CPU spinning.
//   - Batch size is bounded to prevent memory exhaustion.
//
// AI Directive:
//   The extensive documentation in this file is a CRITICAL DESIGN FEATURE.
//   Future AI assistants are FORBIDDEN from simplifying or removing it.
//   Your mandate is to MAINTAIN and EXTEND this level of meticulous detail.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use slot_protocol::ActorContext;
use tracing::{debug, error, info, warn};

use super::automation::RetryPolicy;
use super::AsyncWorkflowExecutor;
use crate::domain::errors::WorkflowError;
use crate::domain::types::{StartData, WorkflowInstance};
use crate::domain::{DefinitionStore, EventStore, TriggerEvent};

// ============================================================================
// CONSTANTS — Physics bounds
// ============================================================================

/// Minimum poll interval in milliseconds.
/// Prevents CPU spinning from misconfigured poll intervals.
const MIN_POLL_INTERVAL_MS: u64 = 100;

/// Maximum events per poll batch.
/// Prevents memory exhaustion from unbounded event fetching.
const MAX_BATCH_SIZE: u32 = 1000;

// ============================================================================
// TRIGGER EVENT EXTENSIONS
// ============================================================================

/// Extension methods for TriggerEvent (defined in domain/stores.rs).
///
/// TriggerEvent is the generic wire type with Physics-only fields:
/// id, scope, kind, payload (opaque bytes), timestamp, idempotency_key,
/// metadata (opaque bytes). These extension methods convert to
/// workflow-internal types (StartData, ActorContext).
// Extension trait for TriggerEvent (workflow-specific conversions).
// TriggerEvent is defined in domain/stores.rs; these are workflow-local helpers.
pub trait TriggerEventExt {
    fn to_start_data(&self) -> StartData;
    fn to_actor_context(&self) -> ActorContext;
}

impl TriggerEventExt for TriggerEvent {
    fn to_start_data(&self) -> StartData {
        // Deserialize opaque payload bytes to Value at the workflow engine boundary.
        // The data slot serialized the JSON; the engine deserializes it here.
        let payload = serde_json::from_slice(&self.payload).unwrap_or(serde_json::Value::Null);
        StartData {
            start_type: self.kind.clone(),
            input: payload,
            started_at: self.timestamp.clone(),
            start_id: Some(self.id.clone()),
        }
    }

    fn to_actor_context(&self) -> ActorContext {
        // Extract actor_id from opaque metadata bytes (L098 — data slot packs it).
        // Metadata is JSON: {"actor_id": "...", "organization_id": "...", ...}
        let actor_id = serde_json::from_slice::<serde_json::Value>(&self.metadata)
            .ok()
            .and_then(|v| v.get("actor_id").and_then(|a| a.as_str()).map(String::from))
            .unwrap_or_default();
        ActorContext {
            user_id: actor_id,
            ..ActorContext::default()
        }
    }
}

// ============================================================================
// EVENT STORE TRAIT — host layers implement for database access
// ============================================================================

// EventStore trait is defined in domain/stores.rs.
// It is re-exported from the crate root (lib.rs) for consumers.
// Use `crate::EventStore` to reference the trait.

// ============================================================================
// POLL CONFIGURATION — all timing and sizing is configurable
// ============================================================================

/// Configuration for the event polling loop.
///
/// All values are configurable — no hardcoded timing or sizing constants.
/// The poll interval and batch size are Society decisions, not Physics.
#[derive(Debug, Clone)]
pub struct PollConfig {
    /// Interval between poll cycles in milliseconds.
    /// Bounded below by MIN_POLL_INTERVAL_MS to prevent CPU spinning.
    pub poll_interval_ms: u64,
    /// Maximum events to fetch per poll cycle.
    /// Bounded above by MAX_BATCH_SIZE to prevent memory exhaustion.
    pub batch_size: u32,
    /// Partition to poll events for.
    pub partition_key: String,
    /// Retry policy for workflow execution failures.
    pub retry_policy: RetryPolicy,
}

impl PollConfig {
    /// Get the effective poll interval (bounded below by MIN_POLL_INTERVAL_MS).
    pub fn effective_poll_interval(&self) -> Duration {
        Duration::from_millis(self.poll_interval_ms.max(MIN_POLL_INTERVAL_MS))
    }

    /// Get the effective batch size (bounded above by MAX_BATCH_SIZE).
    pub fn effective_batch_size(&self) -> u32 {
        self.batch_size.min(MAX_BATCH_SIZE)
    }
}

// ============================================================================
// EVENT POLL RESULT — outcome of processing a single event
// ============================================================================

/// Result of processing a single trigger event.
///
/// Contains the event ID and the outcomes for each workflow that was
/// triggered by the event.
#[derive(Debug, Clone)]
pub struct EventPollResult {
    /// The event that was processed.
    pub event_id: String,
    /// Outcomes for each workflow triggered by this event.
    pub workflow_results: Vec<WorkflowExecutionOutcome>,
}

/// Outcome of executing a single workflow for a trigger event.
#[derive(Debug, Clone)]
pub struct WorkflowExecutionOutcome {
    /// The workflow definition ID.
    pub workflow_id: String,
    /// The resulting instance (contains status, outputs, etc.).
    pub instance: WorkflowInstance,
}

// ============================================================================
// EVENT POLLER — the automation heartbeat
// ============================================================================

/// Event polling engine that drives automated workflow execution.
///
/// The poller runs a loop that:
/// 1. Polls for new events from the EventStore
/// 2. Matches events to registered workflows by trigger_source
/// 3. Executes matching workflows via AsyncWorkflowExecutor
/// 4. Marks processed events so they are not re-processed
///
/// The loop runs until the cancellation flag is set.
///
/// # Type Parameter
///
/// * `B` — The backend type, same as AsyncWorkflowExecutor
pub struct EventPoller {
    /// The workflow executor for dispatching primitives.
    executor: AsyncWorkflowExecutor,
    /// Cancellation flag — set to true to stop the polling loop.
    cancelled: Arc<AtomicBool>,
}

impl EventPoller {
    /// Create a new event poller with the given executor.
    pub fn new(executor: AsyncWorkflowExecutor) -> Self {
        Self {
            executor,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Get a handle to the cancellation flag.
    ///
    /// Set this to `true` to stop the polling loop gracefully.
    pub fn cancellation_handle(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancelled)
    }

    /// Run the polling loop.
    ///
    /// Polls for new events, matches them to workflows, executes matching
    /// workflows, and marks events as processed. Runs until the cancellation
    /// flag is set.
    ///
    /// # Arguments
    ///
    /// * `config` — Polling configuration (interval, batch size, partition)
    /// * `event_store` — EventStore implementation for polling events
    /// * `definition_store` — DefinitionStore for loading definitions
    /// * `definition_store` — DefinitionStore for loading definitions
    ///
    /// # Returns
    ///
    /// * `Ok(Vec<EventPollResult>)` — Results from all processed events
    ///   (returned when cancelled or after one cycle if running in test mode)
    /// * `Err(WorkflowError)` — Fatal error in the polling infrastructure
    pub async fn start_polling(
        &self,
        config: &PollConfig,
        event_store: &dyn EventStore,
        definition_store: &dyn DefinitionStore,
    ) -> Result<Vec<EventPollResult>, WorkflowError> {
        let mut all_results: Vec<EventPollResult> = Vec::new();
        let poll_interval = config.effective_poll_interval();
        let batch_size = config.effective_batch_size();

        loop {
            if self.cancelled.load(Ordering::Relaxed) {
                break;
            }

            // Poll for new events
            let events = event_store
                .poll_new_events(&config.partition_key, batch_size)
                .map_err(|e| WorkflowError::ExecutionFailed {
                    reason: format!(
                        "Event polling failed for partition '{}' (batch_size={}): {}",
                        config.partition_key, batch_size, e
                    ),
                    hint: "Verify EventStore implementation returns well-formed events \
                           and the underlying data source is accessible. Check database \
                           connectivity and poll_new_events query correctness."
                        .to_string(),
                })?;

            if !events.is_empty() {
                info!(count = events.len(), partition = %config.partition_key, "Polled new events");
            }

            // Process each event
            for event in &events {
                let result = self
                    .process_event(event, definition_store, &config.retry_policy)
                    .await?;

                // Mark event as processed
                event_store
                    .mark_event_processed(&event.id, &config.partition_key)
                    .map_err(|e| WorkflowError::ExecutionFailed {
                        reason: format!(
                            "Failed to mark event '{}' as processed in partition '{}': {}",
                            event.id, config.partition_key, e
                        ),
                        hint: "The workflow(s) for this event already executed successfully. \
                               Verify EventStore::mark_event_processed implementation and \
                               ensure idempotency — re-processing the same event must be safe."
                            .to_string(),
                    })?;

                info!(
                    event_id = %event.id,
                    workflows_triggered = result.workflow_results.len(),
                    "Event processed"
                );

                all_results.push(result);
            }

            // If no events found and we're in a single-cycle test, break
            if events.is_empty() && self.cancelled.load(Ordering::Relaxed) {
                break;
            }

            if events.is_empty() {
                debug!(
                    interval_ms = poll_interval.as_millis() as u64,
                    "No new events, sleeping"
                );
            }

            // Sleep before next poll cycle (native only — WASM has no tokio timer support)
            #[cfg(feature = "native")]
            tokio::time::sleep(poll_interval).await;

            // Check cancellation after sleep
            if self.cancelled.load(Ordering::Relaxed) {
                break;
            }
        }

        Ok(all_results)
    }

    /// Run a single poll cycle (for testing).
    ///
    /// Polls once, processes all events, and returns results without looping.
    pub async fn poll_once(
        &self,
        config: &PollConfig,
        event_store: &dyn EventStore,
        definition_store: &dyn DefinitionStore,
    ) -> Result<Vec<EventPollResult>, WorkflowError> {
        let batch_size = config.effective_batch_size();
        let events = event_store
            .poll_new_events(&config.partition_key, batch_size)
            .map_err(|e| WorkflowError::ExecutionFailed {
                reason: format!(
                    "Event polling failed for partition '{}' (batch_size={}): {}",
                    config.partition_key, batch_size, e
                ),
                hint: "Verify EventStore implementation returns well-formed events \
                       and the underlying data source is accessible. If running \
                       poll_once for tests, ensure the TestEventStore is properly seeded."
                    .to_string(),
            })?;

        let mut results = Vec::with_capacity(events.len());

        for event in &events {
            let result = self
                .process_event(event, definition_store, &config.retry_policy)
                .await?;
            event_store
                .mark_event_processed(&event.id, &config.partition_key)
                .map_err(|e| WorkflowError::ExecutionFailed {
                    reason: format!(
                        "Failed to mark event '{}' as processed in partition '{}': {}",
                        event.id, config.partition_key, e
                    ),
                    hint: "The workflow(s) already executed for this event. Check \
                           EventStore::mark_event_processed for database write errors. \
                           Without marking, this event will be re-polled next cycle — \
                           ensure downstream workflows handle duplicate execution safely."
                        .to_string(),
                })?;
            results.push(result);
        }

        Ok(results)
    }

    /// Process a single trigger event.
    ///
    /// Matches the event to registered workflows by event_type, then executes
    /// each matching workflow via AsyncWorkflowExecutor::execute_workflow().
    ///
    /// # Arguments
    ///
    /// * `event` — The trigger event from the EventStore
    /// * `definition_store` — For loading matching workflow definitions
    /// * `action_store` — For loading action definitions during execution
    /// * `retry_policy` — Retry behavior for failed workflow steps
    ///
    /// # Returns
    ///
    /// EventPollResult containing the outcomes for all triggered workflows.
    pub async fn process_event(
        &self,
        event: &TriggerEvent,
        definition_store: &dyn DefinitionStore,
        retry_policy: &RetryPolicy,
    ) -> Result<EventPollResult, WorkflowError> {
        info!(event_id = %event.id, event_type = %event.kind, "Processing event");

        // 1. Find workflows matching this event type
        let matching_workflows = definition_store
            .get_by_trigger(&event.kind, &event.scope)
            .map_err(|e| WorkflowError::ExecutionFailed {
                reason: format!(
                    "Failed to match workflows for event_type '{}' in partition '{}': {}",
                    event.kind, event.scope, e
                ),
                hint: "Verify DefinitionStore::get_by_trigger implementation. \
                       Ensure workflow trigger_source values match the event kind \
                       exactly (case-sensitive)."
                    .to_string(),
            })?;

        if matching_workflows.is_empty() {
            warn!(
                event_id = %event.id,
                event_type = %event.kind,
                "Event matched 0 workflows"
            );
        } else {
            info!(
                event_id = %event.id,
                matched = matching_workflows.len(),
                "Matched workflows"
            );
        }

        // 2. Execute each matching workflow
        let start_data = event.to_start_data();
        let actor = event.to_actor_context();
        let mut outcomes: Vec<WorkflowExecutionOutcome> = Vec::new();

        for workflow in &matching_workflows {
            let instance = self
                .executor
                .execute_workflow(
                    &workflow.id,
                    start_data.clone(),
                    actor.clone(),
                    retry_policy,
                )
                .await?;

            // Log instance outcome — critical for diagnosing silent step failures
            match instance.status {
                crate::domain::types::ExecutionStatus::Failed => {
                    error!(
                        workflow_id = %workflow.id,
                        event_id = %event.id,
                        error = ?instance.error_message,
                        "Workflow execution FAILED"
                    );
                }
                _ => {
                    debug!(
                        workflow_id = %workflow.id,
                        event_id = %event.id,
                        status = ?instance.status,
                        "Workflow execution complete"
                    );
                }
            }

            outcomes.push(WorkflowExecutionOutcome {
                workflow_id: workflow.id.clone(),
                instance,
            });
        }

        Ok(EventPollResult {
            event_id: event.id.clone(),
            workflow_results: outcomes,
        })
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::errors::WorkflowResult;
    use crate::domain::types::{Definition, ExecutionStatus, Step, TriggerType};
    use crate::domain::DefinitionStore;
    use serde_json::json;

    // ========================================================================
    // TestDefinitionStore — unified store for testing (implements DefinitionStore)
    // ========================================================================

    struct TestDefinitionStore {
        definitions: std::collections::HashMap<String, Definition>,
    }

    impl TestDefinitionStore {
        fn new() -> Self {
            Self {
                definitions: std::collections::HashMap::new(),
            }
        }

        fn register(&mut self, def: Definition) {
            self.definitions.insert(def.id.clone(), def);
        }
    }

    impl DefinitionStore for TestDefinitionStore {
        fn get_by_id(&self, id: &str, _partition_key: &str) -> WorkflowResult<Option<Definition>> {
            Ok(self.definitions.get(id).cloned())
        }

        fn get_by_slug(
            &self,
            slug: &str,
            _partition_key: &str,
        ) -> WorkflowResult<Option<Definition>> {
            Ok(self.definitions.values().find(|d| d.name == slug).cloned())
        }

        fn get_active(
            &self,
            _partition_key: &str,
            kind: Option<&str>,
        ) -> WorkflowResult<Vec<Definition>> {
            Ok(self
                .definitions
                .values()
                .filter(|d| d.is_active)
                .filter(|d| kind.is_none_or(|k| d.kind == k))
                .cloned()
                .collect())
        }

        fn get_by_trigger(
            &self,
            trigger_source: &str,
            _partition_key: &str,
        ) -> WorkflowResult<Vec<Definition>> {
            Ok(self
                .definitions
                .values()
                .filter(|d| d.trigger_source == trigger_source && d.is_active)
                .cloned()
                .collect())
        }
    }
    use std::sync::Mutex;

    // ========================================================================

    // ========================================================================
    // Test EventStore — in-memory event store
    // ========================================================================

    struct TestEventStore {
        events: Vec<TriggerEvent>,
        processed: Mutex<Vec<String>>,
    }

    impl TestEventStore {
        fn new(events: Vec<TriggerEvent>) -> Self {
            Self {
                events,
                processed: Mutex::new(Vec::new()),
            }
        }

        fn processed_ids(&self) -> Vec<String> {
            self.processed.lock().expect("lock poisoned").clone()
        }
    }

    impl EventStore for TestEventStore {
        fn poll_new_events(
            &self,
            partition_key: &str,
            batch_size: u32,
        ) -> WorkflowResult<Vec<TriggerEvent>> {
            let processed = self.processed.lock().expect("lock poisoned");
            Ok(self
                .events
                .iter()
                .filter(|e| e.scope == partition_key && !processed.contains(&e.id))
                .take(batch_size as usize)
                .cloned()
                .collect())
        }

        fn mark_event_processed(&self, event_id: &str, _partition_key: &str) -> WorkflowResult<()> {
            self.processed
                .lock()
                .expect("lock poisoned")
                .push(event_id.to_string());
            Ok(())
        }
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    fn make_executor() -> AsyncWorkflowExecutor {
        AsyncWorkflowExecutor::new(
            "partition:test",
            slot_protocol::PartitionKey::hash_from("partition:test"),
            Arc::new(NoOpOutsideAccess),
            Arc::new(TestDefinitionStore::new()),
            crate::executor::context::test_product_word_ids(),
        )
    }

    fn make_executor_with_store(store: TestDefinitionStore) -> AsyncWorkflowExecutor {
        AsyncWorkflowExecutor::new(
            "partition:test",
            slot_protocol::PartitionKey::hash_from("partition:test"),
            Arc::new(NoOpOutsideAccess),
            Arc::new(store),
            crate::executor::context::test_product_word_ids(),
        )
    }

    struct NoOpOutsideAccess;

    #[async_trait::async_trait]
    impl crate::executor::context::OutsideAccess for NoOpOutsideAccess {
        async fn ask(
            &self,
            _name: &str,
            _partition_key: &slot_protocol::PartitionKey,
            _payload: bytes::Bytes,
            _context: Option<bytes::Bytes>,
        ) -> Result<std::sync::Arc<[u8]>, String> {
            Ok(std::sync::Arc::from(
                b"{\"status\":\"ok\"}".to_vec().into_boxed_slice(),
            ))
        }

        async fn read(
            &self,
            _from: &str,
            _partition_key: &slot_protocol::PartitionKey,
        ) -> Result<crate::executor::context::DirectReadResult, String> {
            Ok(crate::executor::context::DirectReadResult {
                bytes: std::sync::Arc::from(b"{\"status\":\"ok\"}".to_vec().into_boxed_slice()),
                content_hash: "test-content-hash".to_string(),
            })
        }
    }

    fn make_event(id: &str, event_type: &str) -> TriggerEvent {
        TriggerEvent {
            id: id.to_string(),
            scope: "partition:test".to_string(),
            kind: event_type.to_string(),
            payload: serde_json::to_vec(&json!({"key": "value"})).unwrap(),
            timestamp: "2025-01-01T00:00:00Z".to_string(),
            idempotency_key: None,
            metadata: serde_json::to_vec(&json!({
                "actor_id": "user:test",
                "organization_id": "org:test"
            }))
            .unwrap(),
        }
    }

    fn make_workflow(id: &str, trigger_source: &str) -> Definition {
        Definition {
            id: id.to_string(),
            partition_key: "partition:test".to_string(),
            name: id.to_string(),
            description: format!("Test workflow {}", id),
            trigger_type: TriggerType::Event,
            trigger_source: trigger_source.to_string(),
            is_active: true,
            steps: vec![],
            version: 1,
            ..Default::default()
        }
    }

    fn make_poll_config() -> PollConfig {
        PollConfig {
            poll_interval_ms: 100,
            batch_size: 10,
            partition_key: "partition:test".to_string(),
            retry_policy: RetryPolicy::default(),
        }
    }

    // ========================================================================
    // Test 1: TriggerEvent serialization roundtrip
    // ========================================================================

    #[test]
    fn test_trigger_event_serialization_roundtrip() {
        let event = make_event("evt-001", "ContractCreated");
        let json = serde_json::to_string(&event).expect("serialize");
        let parsed: TriggerEvent = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(parsed.id, "evt-001");
        assert_eq!(parsed.kind, "ContractCreated");
        assert_eq!(parsed.scope, "partition:test");
    }

    // ========================================================================
    // Test 2: TriggerEvent to StartData conversion
    // ========================================================================

    #[test]
    fn test_trigger_event_to_start_data() {
        let event = make_event("evt-002", "PaymentProcessed");
        let start_data = event.to_start_data();

        assert_eq!(start_data.start_type, "PaymentProcessed");
        assert_eq!(start_data.start_id, Some("evt-002".to_string()));
        assert_eq!(start_data.input, json!({"key": "value"}));
    }

    // ========================================================================
    // Test 3: TriggerEvent to ActorContext conversion
    // ========================================================================

    #[test]
    fn test_trigger_event_to_actor_context() {
        let event = make_event("evt-003", "AccessGranted");
        let actor = event.to_actor_context();
        assert_eq!(actor.user_id, "user:test");
    }

    // ========================================================================
    // Test 4: PollConfig effective values respect bounds
    // ========================================================================

    #[test]
    fn test_poll_config_bounds() {
        // Below minimum poll interval
        let config = PollConfig {
            poll_interval_ms: 10,
            batch_size: 2000,
            partition_key: "partition:test".to_string(),
            retry_policy: RetryPolicy::default(),
        };

        assert_eq!(
            config.effective_poll_interval(),
            Duration::from_millis(MIN_POLL_INTERVAL_MS)
        );
        assert_eq!(config.effective_batch_size(), MAX_BATCH_SIZE);

        // Normal values
        let config2 = PollConfig {
            poll_interval_ms: 5000,
            batch_size: 50,
            partition_key: "partition:test".to_string(),
            retry_policy: RetryPolicy::default(),
        };

        assert_eq!(
            config2.effective_poll_interval(),
            Duration::from_millis(5000)
        );
        assert_eq!(config2.effective_batch_size(), 50);
    }

    // ========================================================================
    // Test 5: EventStore polls and marks events processed
    // ========================================================================

    #[test]
    fn test_event_store_poll_and_mark() {
        let events = vec![make_event("evt-a", "TypeA"), make_event("evt-b", "TypeB")];
        let store = TestEventStore::new(events);

        // Poll — should get both events
        let polled = store
            .poll_new_events("partition:test", 10)
            .expect("poll should succeed");
        assert_eq!(polled.len(), 2);

        // Mark first as processed
        store
            .mark_event_processed("evt-a", "partition:test")
            .expect("mark should succeed");

        // Poll again — should only get second event
        let polled2 = store
            .poll_new_events("partition:test", 10)
            .expect("poll should succeed");
        assert_eq!(polled2.len(), 1);
        assert_eq!(polled2[0].id, "evt-b");

        assert_eq!(store.processed_ids(), vec!["evt-a".to_string()]);
    }

    // ========================================================================
    // Test 6: poll_once processes events and matches workflows
    // ========================================================================

    #[tokio::test]
    async fn test_poll_once_processes_events() {
        let mut store = TestDefinitionStore::new();
        store.register(make_workflow("wf-contract", "ContractCreated"));
        let executor = make_executor_with_store(store);
        let poller = EventPoller::new(executor);

        let events = vec![make_event("evt-poll-1", "ContractCreated")];
        let event_store = TestEventStore::new(events);

        // Re-create matching store for poll_once trigger matching
        let mut trigger_store = TestDefinitionStore::new();
        trigger_store.register(make_workflow("wf-contract", "ContractCreated"));

        let config = make_poll_config();

        let results = poller
            .poll_once(&config, &event_store, &trigger_store)
            .await
            .expect("poll_once should succeed");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].event_id, "evt-poll-1");
        assert_eq!(results[0].workflow_results.len(), 1);
        assert_eq!(results[0].workflow_results[0].workflow_id, "wf-contract");
        assert_eq!(
            results[0].workflow_results[0].instance.status,
            ExecutionStatus::Completed
        );

        // Event should be marked as processed
        assert_eq!(event_store.processed_ids(), vec!["evt-poll-1".to_string()]);
    }

    // ========================================================================
    // Test 7: No matching workflows for event
    // ========================================================================

    #[tokio::test]
    async fn test_no_matching_workflows() {
        let executor = make_executor();
        let poller = EventPoller::new(executor);

        let events = vec![make_event("evt-no-match", "UnknownEventType")];
        let event_store = TestEventStore::new(events);

        let store = TestDefinitionStore::new(); // No workflows registered

        let config = make_poll_config();

        let results = poller
            .poll_once(&config, &event_store, &store)
            .await
            .expect("should succeed with no matches");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].workflow_results.len(), 0); // No workflows matched
                                                          // Event should still be marked as processed
        assert_eq!(
            event_store.processed_ids(),
            vec!["evt-no-match".to_string()]
        );
    }

    // ========================================================================
    // Test 8: Multiple workflows match same event
    // ========================================================================

    #[tokio::test]
    async fn test_multiple_workflows_match_event() {
        let mut store = TestDefinitionStore::new();
        store.register(make_workflow("wf-notify", "PaymentProcessed"));
        store.register(make_workflow("wf-audit", "PaymentProcessed"));
        let executor = make_executor_with_store(store);
        let poller = EventPoller::new(executor);

        let events = vec![make_event("evt-multi", "PaymentProcessed")];
        let event_store = TestEventStore::new(events);

        let mut trigger_store = TestDefinitionStore::new();
        trigger_store.register(make_workflow("wf-notify", "PaymentProcessed"));
        trigger_store.register(make_workflow("wf-audit", "PaymentProcessed"));

        let config = make_poll_config();

        let results = poller
            .poll_once(&config, &event_store, &trigger_store)
            .await
            .expect("should succeed");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].workflow_results.len(), 2);

        let wf_ids: Vec<&str> = results[0]
            .workflow_results
            .iter()
            .map(|r| r.workflow_id.as_str())
            .collect();
        assert!(wf_ids.contains(&"wf-notify"));
        assert!(wf_ids.contains(&"wf-audit"));
    }

    // ========================================================================
    // Test 9: Cancellation stops polling loop
    // ========================================================================

    #[tokio::test]
    async fn test_cancellation_stops_polling() {
        let executor = make_executor();
        let poller = EventPoller::new(executor);

        // Set cancellation flag immediately
        poller.cancelled.store(true, Ordering::Relaxed);

        let event_store = TestEventStore::new(vec![]);
        let store = TestDefinitionStore::new();

        let config = make_poll_config();

        let results = poller
            .start_polling(&config, &event_store, &store)
            .await
            .expect("should complete without error");

        // Should return immediately with no results
        assert!(results.is_empty());
    }

    // ========================================================================
    // Test 10: Integration — trigger → workflow → kernel codex → database
    // ========================================================================

    #[tokio::test]
    async fn test_integration_trigger_to_workflow_execution() {
        // Create an action that the workflow will execute
        let action = Definition {
            id: "action:billing:process".to_string(),
            partition_key: "partition:test".to_string(),
            name: "process_payment".to_string(),
            description: "Process a billing payment".to_string(),
            input_schema: json!({}),
            steps: vec![Step::ask("test.owner", json!({"op": "process_payment"}))],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        };
        // Create a workflow with an action step
        let mut store = TestDefinitionStore::new();
        store.register(action.clone());
        let workflow = Definition {
            id: "wf-billing".to_string(),
            partition_key: "partition:test".to_string(),
            name: "billing_workflow".to_string(),
            description: "Process billing events".to_string(),
            trigger_type: TriggerType::Event,
            trigger_source: "PaymentReceived".to_string(),
            is_active: true,
            steps: vec![Step::action("action:billing:process", json!({})).with_id("ws-0")],
            version: 1,
            ..Default::default()
        };
        store.register(workflow);

        // Build executor with pre-populated store, then create poller
        let mut trigger_store = TestDefinitionStore::new();
        trigger_store.register(action);
        trigger_store.register(Definition {
            id: "wf-billing".to_string(),
            partition_key: "partition:test".to_string(),
            name: "billing_workflow".to_string(),
            description: "Process billing events".to_string(),
            trigger_type: TriggerType::Event,
            trigger_source: "PaymentReceived".to_string(),
            is_active: true,
            steps: vec![Step::action("action:billing:process", json!({})).with_id("ws-0")],
            version: 1,
            ..Default::default()
        });

        let executor = make_executor_with_store(store);
        let poller = EventPoller::new(executor);

        // Create a trigger event
        let events = vec![TriggerEvent {
            id: "evt-billing-001".to_string(),
            scope: "partition:test".to_string(),
            kind: "PaymentReceived".to_string(),
            payload: serde_json::to_vec(&json!({"amount": 100, "currency": "USD"})).unwrap(),
            timestamp: "2025-01-15T10:00:00Z".to_string(),
            idempotency_key: Some("pay-001".to_string()),
            metadata: serde_json::to_vec(&json!({
                "actor_id": "user:billing-system",
                "organization_id": "org:acme",
                "contract_id": "contract:001"
            }))
            .unwrap(),
        }];
        let event_store = TestEventStore::new(events);

        let config = make_poll_config();

        let results = poller
            .poll_once(&config, &event_store, &trigger_store)
            .await
            .expect("integration test should succeed");

        // Verify the full path: event → workflow → action → kernel primitive
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].event_id, "evt-billing-001");
        assert_eq!(results[0].workflow_results.len(), 1);

        let outcome = &results[0].workflow_results[0];
        assert_eq!(outcome.workflow_id, "wf-billing");
        assert_eq!(outcome.instance.status, ExecutionStatus::Completed);
        assert!(outcome
            .instance
            .execution_context
            .steps
            .contains_key("ws-0"));

        // Verify start data was passed through
        assert_eq!(
            outcome.instance.execution_context.start.start_type,
            "PaymentReceived"
        );
        assert_eq!(
            outcome.instance.execution_context.start.start_id,
            Some("evt-billing-001".to_string())
        );
    }

    // ========================================================================
    // Test 11: Empty event store returns empty results
    // ========================================================================

    #[tokio::test]
    async fn test_empty_event_store() {
        let executor = make_executor();
        let poller = EventPoller::new(executor);

        let event_store = TestEventStore::new(vec![]);
        let store = TestDefinitionStore::new();

        let config = make_poll_config();

        let results = poller
            .poll_once(&config, &event_store, &store)
            .await
            .expect("should succeed");

        assert!(results.is_empty());
    }

    // ========================================================================
    // Test 12: Partition scoping — only events for target partition
    // ========================================================================

    #[test]
    fn test_partition_scoping() {
        let mut event1 = make_event("evt-ws1", "TypeA");
        event1.scope = "ws:alpha".to_string();

        let mut event2 = make_event("evt-ws2", "TypeA");
        event2.scope = "ws:beta".to_string();

        let store = TestEventStore::new(vec![event1, event2]);

        let polled = store
            .poll_new_events("ws:alpha", 10)
            .expect("poll should succeed");
        assert_eq!(polled.len(), 1);
        assert_eq!(polled[0].id, "evt-ws1");
    }

    // ========================================================================
    // Test 13: Batch size respected
    // ========================================================================

    #[test]
    fn test_batch_size_respected() {
        let events: Vec<TriggerEvent> = (0..5)
            .map(|i| make_event(&format!("evt-batch-{}", i), "TypeA"))
            .collect();
        let store = TestEventStore::new(events);

        let polled = store
            .poll_new_events("partition:test", 2)
            .expect("poll should succeed");
        assert_eq!(polled.len(), 2);
    }
}
