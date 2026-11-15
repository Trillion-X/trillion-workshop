// crates/workflow-core/src/kernel_bridge.rs
//
// Purpose:
//   Convenience layer for configuring workflow execution context.
//   Workflow core stays blind; outside work routes through the boundary adapter.
//   KernelBridge carries partition_key — the minimum configuration needed
//   by the blind DAG runner.
//
//   Governance (permission, constraint, audit) is enforced by the RECEIVING
//   slot, NOT the workflow engine. The engine fires Envelopes.
//   The receiving slot checks permissions on the Envelope it receives.
//
// Non-Negotiable Invariants:
//   1. Builder pattern is the canonical configuration path.
//   2. No `.unwrap()` in production code. All errors are structured WorkflowError.
//   3. Thread-safe: KernelBridge is Send + Sync.
//   4. ZERO governance traits — security is slot-side, not engine-side.

use std::sync::atomic::{AtomicU64, Ordering};

// ============================================================================
// KERNEL BRIDGE
// ============================================================================

/// Configuration carrier for workflow execution.
///
/// After E.28, the workflow engine is a blind DAG runner that sends Envelopes
/// to named slots. Security enforcement (permission checks, constraint
/// validation, audit logging) is the receiving slot's responsibility — not
/// the engine's. KernelBridge carries only what the engine itself needs:
///
/// | Field | Type | Purpose |
/// |-------|------|---------|
/// | `partition_key` | `String` | Partition/tenant scoping for Envelope dispatch |
/// | `executed_count` | `AtomicU64` | Monotonic dispatch counter for observability |
///
/// # Example
///
/// ```rust,ignore
/// use workflow::kernel_bridge::KernelBridge;
///
/// let bridge = KernelBridge::builder("partition:example").build();
/// ```
pub struct KernelBridge {
    /// Partition/tenant scoping key for Envelope dispatch
    partition_key: String,

    /// Monotonically increasing count of dispatches (atomic for &self)
    executed_count: AtomicU64,
}

impl KernelBridge {
    /// Create a builder for incremental configuration.
    ///
    /// # Arguments
    ///
    /// * `partition_key` — Partition/tenant ID for Envelope dispatch scoping
    pub fn builder(partition_key: impl Into<String>) -> KernelBridgeBuilder {
        KernelBridgeBuilder {
            partition_key: partition_key.into(),
        }
    }

    /// Get the number of dispatches executed so far.
    ///
    /// Reads the atomic counter with `Relaxed` ordering — suitable for
    /// diagnostics and observability. Monotonically increasing.
    pub fn executed_count(&self) -> u64 {
        self.executed_count.load(Ordering::Relaxed)
    }

    /// Get the partition key.
    pub fn partition_key(&self) -> &str {
        &self.partition_key
    }
}

impl std::fmt::Debug for KernelBridge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KernelBridge")
            .field("partition_key", &self.partition_key)
            .field(
                "executed_count",
                &self.executed_count.load(Ordering::Relaxed),
            )
            .finish()
    }
}

// ============================================================================
// BUILDER
// ============================================================================

/// Builder for `KernelBridge`.
///
/// # Example
///
/// ```rust,ignore
/// let bridge = KernelBridge::builder("partition:test")
///     .with_transport_policy(policy)
///     .build();
/// ```
pub struct KernelBridgeBuilder {
    partition_key: String,
}

impl KernelBridgeBuilder {
    /// Build the `KernelBridge` with all configured dependencies.
    pub fn build(self) -> KernelBridge {
        KernelBridge {
            partition_key: self.partition_key,
            executed_count: AtomicU64::new(0),
        }
    }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/// Create a `KernelBridge` with a partition key only.
pub fn create_bridge(partition_key: impl Into<String>) -> KernelBridge {
    KernelBridge::builder(partition_key).build()
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_bridge_basic() {
        let bridge = create_bridge("partition:test");
        assert_eq!(bridge.executed_count(), 0);
        assert_eq!(bridge.partition_key(), "partition:test");
    }

    #[test]
    fn test_bridge_builder() {
        let bridge = KernelBridge::builder("partition:test").build();
        assert_eq!(bridge.partition_key(), "partition:test");
        assert_eq!(bridge.executed_count(), 0);
    }

    #[test]
    fn test_bridge_debug_format() {
        let bridge = create_bridge("ws:debug-test");
        let debug_str = format!("{:?}", bridge);
        assert!(debug_str.contains("ws:debug-test"));
        assert!(debug_str.contains("executed_count: 0"));
    }
}
