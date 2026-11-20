// crates/workflow-core/src/executor/mod.rs
//
// Purpose:
//   Definition dispatch infrastructure — the EXECUTE phase of the
//   SENSE → DECIDE → EXECUTE → PAINT runtime loop: `AsyncWorkflowExecutor`,
//   which carries dependencies for workflow-owned outside access via the slot
//   boundary adapter. (The sync dispatch path for the retired interaction
//   engine had no caller and was deleted on Nov 20 2026 with trigger-ast.)
//
// Non-Negotiable Invariants:
//   1. ALL outside work and direct reads route through ExecutorDeps.outside_access.
//   2. `ExecutorDeps` is built from AsyncWorkflowExecutor fields via
//      `build_executor_deps()` — one function, one wiring point (L063).
//   3. No `.unwrap()` in production code — all errors flow through
//      `WorkflowError` with structured fields.
//
// Key Concepts:
//   - AsyncWorkflowExecutor: Production executor carrying workflow_ctx + outside-access adapter
//   - ExecutorDeps: Dependency struct for step execution (built by build_executor_deps)
//
// Architecture:
//   ```text
//   Runtime Loop (host layer)
//       │
//       │  owns: workflow_ctx, outside_access
//       │
//       ▼
//   AsyncWorkflowExecutor
//       │
//       │  build_executor_deps()
//       │
//       ▼
//   ExecutorDeps { outside_access, partition_key, circuit_state, registries, definition_store }
//       │
//       │  step_executor asks outside work through the boundary adapter
//       │
//       ▼
//   workflow core → boundary adapter → target runtime owner → result bytes
//   ```
//
// Security Considerations:
//   - Guards: When a `GuardsFactory` is configured (via `.with_guards_factory()`),
//     DataGuards are created per dispatch for permission, constraint, and audit
//     enforcement. Without a factory, `DataGuards::none()` is used — test only.
//   - Actor identity: Passed through from the caller — the executor does NOT
//     fabricate or modify the ActorContext.
//   - Secret values: Never touch this module.

pub mod automation;
pub mod budget;
pub mod context;
pub mod interactive;
pub mod polling;
pub mod step_executor;
mod value_to_bytes;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

// ============================================================================
// Async Workflow Executor
// ============================================================================

/// Production async executor carrying dependencies for workflow execution.
///
/// Outside work and direct reads route through `ExecutorDeps.outside_access`.
/// Stone writes stay in workflow-owned plain form until the handler edge
/// translates them into substrate `WriteEntry` values.
///
/// # Type Parameter
///
/// # Execution Count
///
/// Tracks the number of dispatches for observability and diagnostics.
/// Uses `AtomicU64` for `&self` access. Monotonically increasing.
///
/// # Constructor
///
/// `new(partition_key, slot_dispatcher, definition_store, product_word_ids)` — the ONLY constructor.
/// Required capabilities are parameters, not Options. If the host can't provide
/// them, the code doesn't compile. No runtime "was it configured?" checks.
///
/// Optional enhancements (circuit_state) are set after
/// construction — they genuinely CAN be absent (local fallback exists).
///
/// # Example
///
/// ```rust,ignore
/// use workflow::AsyncWorkflowExecutor;
///
/// let executor = AsyncWorkflowExecutor::new(
///     "partition:example",
///     slot_protocol::PartitionKey::hash_from("partition:example"),
///     Arc::new(my_dispatcher),
///     Arc::new(my_definition_store),
///     execution_types::ProductWordIds::new(host_word)?,
/// );
/// ```
pub struct AsyncWorkflowExecutor {
    /// Partition/tenant scoping key for Envelope dispatch.
    /// Arc<str> for O(1) clone — partition_key is threaded through every dispatch.
    partition_key: Arc<str>,
    /// Real Envelope routing partition used for cross-slot dispatch.
    dispatch_partition: slot_protocol::PartitionKey,
    /// Monotonically increasing count of dispatches (atomic for &self access)
    executed_count: AtomicU64,
    /// Generic Envelope dispatcher for step execution. REQUIRED — no execution without it.
    outside_access: Arc<dyn context::OutsideAccess>,
    /// Definition store for loading definitions and sub-definitions. REQUIRED — action
    /// steps load sub-definitions, the engine cannot function without a store.
    definition_store: Arc<dyn crate::domain::DefinitionStore>,
    /// Shared compiled definition cache keyed by (definition_id, version).
    compiled_definition_cache: Arc<std::sync::RwLock<crate::domain::types::DefinitionCache>>,
    /// Circuit breaker state for resilience gating during step execution.
    /// Optional — when absent, retry executes unconditionally (no circuit breaker).
    circuit_state: Option<Arc<resilience::StateLock<resilience::CircuitState>>>,
    /// Effective package-owned JSON conversion policy supplied by the slot.
    json_conversion_policy: crate::domain::types::JsonConversionPolicy,
    /// Set only when the native carrier marked the incoming Envelope with its
    /// current local command-list capability. Authored workflow DATA cannot set it.
    trusted_local_invocation: bool,
    /// The host's product word for process wire identities. REQUIRED — the host owns it.
    product_word_ids: Arc<execution_types::ProductWordIds>,
}

impl AsyncWorkflowExecutor {
    /// Create a workflow executor with all required capabilities.
    ///
    /// Required capabilities are constructor parameters — if you don't have them,
    /// you can't construct the executor. No Options, no runtime panics.
    pub fn new(
        partition_key: impl Into<String>,
        dispatch_partition: slot_protocol::PartitionKey,
        outside_access: Arc<dyn context::OutsideAccess>,
        definition_store: Arc<dyn crate::domain::DefinitionStore>,
        product_word_ids: execution_types::ProductWordIds,
    ) -> Self {
        Self {
            partition_key: Arc::<str>::from(partition_key.into()),
            dispatch_partition,
            executed_count: AtomicU64::new(0),
            outside_access,
            definition_store,
            compiled_definition_cache: Arc::new(std::sync::RwLock::new(Default::default())),
            circuit_state: None,
            json_conversion_policy: Default::default(),
            trusted_local_invocation: false,
            product_word_ids: Arc::new(product_word_ids),
        }
    }

    /// Install the live-resolved package policy for this executor instance.
    pub fn with_json_conversion_policy(
        mut self,
        policy: crate::domain::types::JsonConversionPolicy,
    ) -> Self {
        self.json_conversion_policy = policy;
        self
    }

    pub fn with_trusted_local_invocation(mut self, trusted: bool) -> Self {
        self.trusted_local_invocation = trusted;
        self
    }

    /// Set the circuit breaker state for resilience gating.
    /// Optional enhancement — the engine runs without it (no circuit breaker gating).
    pub fn with_circuit_state(
        mut self,
        state: Arc<resilience::StateLock<resilience::CircuitState>>,
    ) -> Self {
        self.circuit_state = Some(state);
        self
    }

    /// Build ExecutorDeps from this executor's configured dependencies.
    ///
    /// ONE function, called by all execution paths (automation, interactive).
    /// Required capabilities are already guaranteed present (constructor enforced).
    /// Registries get default built-in handlers.
    pub(crate) fn build_executor_deps(&self) -> context::ExecutorDeps {
        context::ExecutorDeps {
            outside_access: self.outside_access.clone(),
            partition_key: self.partition_key.clone(),
            dispatch_partition: self.dispatch_partition.clone(),
            circuit_state: self.circuit_state.clone(),
            step_registry: Arc::new(automation::default_step_registry()),
            edge_registry: Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: self.definition_store.clone(),
            compiled_definition_cache: self.compiled_definition_cache.clone(),
            product_word_ids: self.product_word_ids.clone(),
        }
    }

    /// Get the number of dispatches executed so far.
    pub fn executed_count(&self) -> u64 {
        self.executed_count.load(Ordering::Relaxed)
    }

    /// Get the partition key.
    pub fn partition_key(&self) -> &str {
        &self.partition_key
    }

    /// Increment the execution counter and return the new value.
    pub fn increment_count(&mut self) -> u64 {
        let prev = self.executed_count.fetch_add(1, Ordering::Relaxed);
        prev + 1
    }
}

/// Custom `Debug` impl because `Arc<dyn ResourceRegistry>` does not implement `Debug`.
impl std::fmt::Debug for AsyncWorkflowExecutor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AsyncWorkflowExecutor")
            .field("partition_key", &self.partition_key)
            .field(
                "executed_count",
                &self.executed_count.load(Ordering::Relaxed),
            )
            .finish()
    }
}

// WASM is single-threaded — Send + Sync are vacuously true.
// Arc<RefCell<CircuitState>> is !Sync on native (requires RwLock), but safe on wasm32
// because there are no concurrent threads. These impls satisfy async_trait's Send bound.
#[cfg(target_arch = "wasm32")]
unsafe impl Send for AsyncWorkflowExecutor {}
#[cfg(target_arch = "wasm32")]
unsafe impl Sync for AsyncWorkflowExecutor {}

// ============================================================================
// Async definition-dispatch executor implementation DELETED in E.16 — typed
// primitive dispatch helpers were replaced by the workflow boundary adapter.
// The step executor now talks through ExecutorDeps.outside_access.

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // Test mocks for required constructor params
    struct MockOutsideAccess;
    #[async_trait::async_trait]
    impl context::OutsideAccess for MockOutsideAccess {
        async fn ask(
            &self,
            _: &str,
            _: &slot_protocol::PartitionKey,
            _: bytes::Bytes,
            _: Option<bytes::Bytes>,
        ) -> Result<std::sync::Arc<[u8]>, String> {
            Ok(std::sync::Arc::from(b"ok" as &[u8]))
        }

        async fn read(
            &self,
            _: &str,
            _: &slot_protocol::PartitionKey,
        ) -> Result<context::DirectReadResult, String> {
            Ok(context::DirectReadResult {
                bytes: std::sync::Arc::from(b"ok" as &[u8]),
                content_hash: "test-content-hash".to_string(),
            })
        }
    }

    struct MockDefinitionStore;
    impl crate::domain::DefinitionStore for MockDefinitionStore {
        fn get_by_id(
            &self,
            _: &str,
            _: &str,
        ) -> crate::domain::errors::WorkflowResult<Option<crate::domain::types::Definition>>
        {
            Ok(None)
        }
        fn get_by_slug(
            &self,
            _: &str,
            _: &str,
        ) -> crate::domain::errors::WorkflowResult<Option<crate::domain::types::Definition>>
        {
            Ok(None)
        }
        fn get_active(
            &self,
            _: &str,
            _: Option<&str>,
        ) -> crate::domain::errors::WorkflowResult<Vec<crate::domain::types::Definition>> {
            Ok(vec![])
        }
        fn get_by_trigger(
            &self,
            _: &str,
            _: &str,
        ) -> crate::domain::errors::WorkflowResult<Vec<crate::domain::types::Definition>> {
            Ok(vec![])
        }
    }

    fn test_executor(partition_key: &str) -> AsyncWorkflowExecutor {
        AsyncWorkflowExecutor::new(
            partition_key,
            slot_protocol::PartitionKey::hash_from(partition_key),
            Arc::new(MockOutsideAccess),
            Arc::new(MockDefinitionStore),
            crate::executor::context::test_product_word_ids(),
        )
    }

    // -- Test: AsyncWorkflowExecutor partition_key --
    #[test]
    fn test_executor_default_partition_key() {
        let executor = test_executor("partition:default");
        assert_eq!(executor.partition_key(), "partition:default");
        assert_eq!(executor.executed_count(), 0);
    }

    #[test]
    fn test_executor_custom_partition_key() {
        let executor = test_executor("ws:production");
        assert_eq!(executor.partition_key(), "ws:production");
        assert_eq!(executor.executed_count(), 0);
    }

    #[test]
    fn test_executor_partition_key_into_string() {
        let executor = test_executor("ws:dynamic");
        assert_eq!(executor.partition_key(), "ws:dynamic");
    }

    #[test]
    fn test_executor_debug_format() {
        let executor = test_executor("ws:debug");
        let debug_str = format!("{:?}", executor);
        assert!(debug_str.contains("ws:debug"));
        assert!(debug_str.contains("executed_count: 0"));
    }

    #[test]
    fn test_executor_increment_count() {
        let mut executor = test_executor("partition:default");
        assert_eq!(executor.executed_count(), 0);
        let count = executor.increment_count();
        assert_eq!(count, 1);
        assert_eq!(executor.executed_count(), 1);
    }
}
