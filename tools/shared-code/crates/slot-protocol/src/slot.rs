//! The universal Slot trait — the single dispatch mechanism for all capabilities.
//!
//! A Slot:
//! - Receives Envelope entries
//! - Returns a receipt Hash (admission confirmation, not result)
//! - Advertises its methods
//! - Optionally provides a subscription stream for change notifications
//!
//! # Physics Principles
//!
//! - `dispatch()` is fire-and-forget with receipt — not request/reply
//! - All slots dispatch to `Arc<dyn Slot>` — no enumeration in code (L090)
//! - `methods()` advertises capabilities generically
//! - `subscribe()` is optional (default: None)
//! - Zero Society vocabulary (no CrudSlot, WorkflowSlot, WasmSlot type names)
//! - Zero serde_json::Value in signatures

use crate::method::MethodDescriptor;
use crate::{Envelope, EnvelopeError, Hash};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::broadcast;

/// The universal Slot trait — the irreducible dispatch mechanism.
///
/// # Invariants
///
/// 1. `dispatch()` receives Envelope entries and returns a receipt Hash.
///    The receipt proves admission but does NOT prove completion.
/// 2. `methods()` returns a Vec of supported methods.
/// 3. `subscribe()` returns an optional broadcast receiver for change notifications.
///    Each invocation of `subscribe()` returns a fresh receiver on the same channel.
/// 4. All error handling uses `EnvelopeError` (Physics-level errors).
/// 5. Zero enumeration: core never pattern-matches on slot type.
pub trait Slot: Send + Sync {
    /// Dispatch Envelope entries to this slot.
    ///
    /// # Arguments
    ///
    /// * `entries` - A vector of Envelope entries to process.
    ///
    /// # Returns
    ///
    /// `Result<Hash, EnvelopeError>`:
    /// - `Ok(Hash)` - Receipt of admission. The slot has accepted the entries.
    ///   Completion is asynchronous; the receipt is NOT a guarantee of success.
    /// - `Err(EnvelopeError)` - Admission rejected (e.g., invalid capability).
    ///
    /// # Semantics
    ///
    /// The dispatch is one-way with acknowledgment:
    /// - Entry is routed to the slot
    /// - Slot validates authorization and routing
    /// - Slot returns a receipt Hash (proof of admission)
    /// - Slot processes asynchronously (may fail later)
    /// - Failures are tracked in ConflictSet or externally
    fn dispatch(&self, entries: Vec<Envelope>) -> Result<Hash, EnvelopeError>;

    /// Query the slot's read-side projection (CQRS read path).
    ///
    /// # Arguments
    ///
    /// * `envelope` - The query request envelope.
    ///   - `address` (FactAddress) routes to the correct query handler
    ///   - `payload` contains self-describing query parameters
    ///
    /// # Returns
    ///
    /// `Result<Arc<[u8]>, EnvelopeError>`:
    /// - `Ok(data)` - The query result as opaque bytes.
    /// - `Err(EnvelopeError)` - Query failed.
    ///
    /// # Semantics
    ///
    /// Queries route by FactAddress (same Physics as `dispatch()`), not by
    /// string method names. The Envelope payload is self-describing per L090.
    /// The target slot inspects the payload structure to determine what query
    /// to execute, completely independent of any "method" string.
    ///
    /// Queries read from the ExternalWriter's projected data, completely
    /// bypassing `dispatch_rewrite()`. No journal append, no latest accepted hybrid logical clock time advance,
    /// no DAG merge. Commands mutate state and return receipts.
    /// Queries read state and return data.
    ///
    /// Default implementation returns `Err(EnvelopeError::NotSupported)`.
    #[allow(clippy::type_complexity)]
    fn query(
        &self,
        _envelope: Envelope,
    ) -> Pin<Box<dyn Future<Output = Result<Arc<[u8]>, EnvelopeError>> + Send + '_>> {
        Box::pin(async { Err(EnvelopeError::NotSupported) })
    }

    /// Query multiple envelopes and return a vector of results.
    ///
    /// # Arguments
    ///
    /// * `envelopes` - A vector of query request envelopes.
    ///
    /// # Returns
    ///
    /// `Result<Vec<Arc<[u8]>>, EnvelopeError>`:
    /// - `Ok(results)` - A vector of query results as opaque bytes, one per input envelope.
    /// - `Err(EnvelopeError)` - If any query fails, the entire batch fails.
    ///
    /// # Semantics
    ///
    /// The default implementation processes queries sequentially, calling `query()`
    /// for each envelope in order. Slots can override this for batch optimization.
    #[allow(clippy::type_complexity)]
    fn query_batch(
        &self,
        envelopes: Vec<Envelope>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Arc<[u8]>>, EnvelopeError>> + Send + '_>> {
        Box::pin(async move {
            tracing::debug!(
                "[slot-protocol] query_batch fallback: processing {} queries sequentially",
                envelopes.len()
            );
            let mut results = Vec::with_capacity(envelopes.len());
            for envelope in envelopes {
                results.push(self.query(envelope).await?);
            }
            Ok(results)
        })
    }

    /// List the methods this slot exposes.
    ///
    /// # Returns
    ///
    /// A Vec of MethodDescriptor, each declaring a method name and description.
    /// Schema validation information (if needed) is self-describing in Envelope data (L090).
    fn methods(&self) -> Vec<MethodDescriptor>;

    /// Subscribe to change notifications from this slot.
    ///
    /// # Returns
    ///
    /// `Option<broadcast::Receiver<Arc<Envelope>>>`:
    /// - `Some(receiver)` - A receiver for change notifications from this slot.
    ///   Multiple callers receive independent receivers on the same channel.
    /// - `None` - This slot does not produce notifications (default).
    ///
    /// # Semantics
    ///
    /// When a slot has changes to broadcast:
    /// 1. Slot sends Arc<Envelope> to all receivers
    /// 2. Receivers async-await the change
    /// 3. Structural sharing (Arc) prevents clones of the Envelope
    ///
    /// Default implementation returns None (no notifications).
    fn subscribe(&self) -> Option<broadcast::Receiver<Arc<Envelope>>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FactAddress, PartitionKey};
    use bytes::Bytes;

    /// A mock slot for testing.
    struct TestSlotA {
        tx: broadcast::Sender<Arc<Envelope>>,
    }

    impl TestSlotA {
        fn new() -> Self {
            let (tx, _) = broadcast::channel(10);
            TestSlotA { tx }
        }
    }

    impl Slot for TestSlotA {
        fn dispatch(&self, entries: Vec<Envelope>) -> Result<Hash, EnvelopeError> {
            // Generate a receipt hash from the first entry's address
            if entries.is_empty() {
                return Err(EnvelopeError::AddressNotFound);
            }

            // For testing: use first entry's address as receipt
            let receipt = Hash::from_multihash(entries[0].address.as_multihash().clone());
            Ok(receipt)
        }

        fn methods(&self) -> Vec<MethodDescriptor> {
            vec![
                MethodDescriptor::new("test_method_a", "A test method"),
                MethodDescriptor::new("test_method_b", "Another test method"),
            ]
        }

        fn subscribe(&self) -> Option<broadcast::Receiver<Arc<Envelope>>> {
            Some(self.tx.subscribe())
        }
    }

    /// Another mock slot for testing.
    struct TestSlotB;

    impl Slot for TestSlotB {
        fn dispatch(&self, entries: Vec<Envelope>) -> Result<Hash, EnvelopeError> {
            if entries.is_empty() {
                return Err(EnvelopeError::AddressNotFound);
            }
            let receipt = Hash::from_multihash(entries[0].partition_key.as_multihash().clone());
            Ok(receipt)
        }

        fn methods(&self) -> Vec<MethodDescriptor> {
            vec![MethodDescriptor::new("test_c", "Test C")]
        }
    }

    #[test]
    fn test_slot_dispatch_with_valid_entries() {
        let slot = TestSlotA::new();
        let partition = PartitionKey::from_digest(0x1F, vec![1u8; 32]);
        let address = FactAddress::from_digest(0x1F, vec![2u8; 32]);
        let payload = Some(Bytes::from("test"));

        let env = Envelope::minimal(partition, address, payload);
        let result = slot.dispatch(vec![env]);

        assert!(result.is_ok(), "dispatch should succeed");
    }

    #[test]
    fn test_slot_dispatch_with_empty_entries() {
        let slot = TestSlotA::new();
        let result = slot.dispatch(vec![]);

        assert!(result.is_err(), "dispatch should fail with empty entries");
    }

    #[test]
    fn test_slot_methods() {
        let slot = TestSlotA::new();
        let methods = slot.methods();

        assert_eq!(methods.len(), 2);
        assert_eq!(methods[0].name, "test_method_a");
        assert_eq!(methods[1].name, "test_method_b");
    }

    #[test]
    fn test_slot_subscribe_returns_receiver() {
        let slot = TestSlotA::new();
        let receiver = slot.subscribe();

        assert!(receiver.is_some(), "TestSlotA should provide a receiver");
    }

    #[test]
    fn test_slot_no_subscribe_default() {
        let slot = TestSlotB;
        let receiver = slot.subscribe();

        assert!(
            receiver.is_none(),
            "TestSlotB should not provide a receiver"
        );
    }

    #[test]
    fn test_multiple_slots_dispatch() {
        let slot_a = TestSlotA::new();
        let slot_b = TestSlotB;

        let partition = PartitionKey::from_digest(0x1F, vec![1u8; 32]);
        let address = FactAddress::from_digest(0x1F, vec![2u8; 32]);
        let env = Envelope::minimal(partition, address, Some(Bytes::from("data")));

        let result_a = slot_a.dispatch(vec![env.clone()]);
        let result_b = slot_b.dispatch(vec![env]);

        assert!(result_a.is_ok());
        assert!(result_b.is_ok());
        // Receipts should be different because TestSlotA uses address, TestSlotB uses partition_key
        assert_ne!(result_a.unwrap(), result_b.unwrap());
    }

    #[test]
    fn test_slot_trait_object() {
        let slots: Vec<Arc<dyn Slot>> = vec![Arc::new(TestSlotA::new()), Arc::new(TestSlotB)];

        let partition = PartitionKey::from_digest(0x1F, vec![3u8; 32]);
        let address = FactAddress::from_digest(0x1F, vec![4u8; 32]);
        let env = Envelope::minimal(partition, address, Some(Bytes::from("test")));

        for slot in slots {
            let result = slot.dispatch(vec![env.clone()]);
            assert!(result.is_ok(), "all slots should dispatch successfully");

            let methods = slot.methods();
            assert!(
                !methods.is_empty(),
                "all slots should have at least one method"
            );
        }
    }

    #[tokio::test]
    async fn test_query_routes_by_fact_address() {
        let slot = TestSlotA::new();
        let partition = PartitionKey::from_digest(0x1F, vec![1u8; 32]);
        let address = FactAddress::from_digest(0x1F, vec![2u8; 32]);
        let payload = Some(Bytes::from("query_params"));

        let env = Envelope::minimal(partition, address, payload);
        let result = slot.query(env).await;

        // Default implementation returns NotSupported, which is correct
        assert!(result.is_err(), "default query should return NotSupported");
        assert!(matches!(result, Err(EnvelopeError::NotSupported)));
    }

    #[tokio::test]
    async fn test_query_batch_empty_returns_empty_vec() {
        let slot = TestSlotA::new();
        let result = slot.query_batch(vec![]).await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn test_query_batch_default_returns_error() {
        let slot = TestSlotA::new();
        let partition = PartitionKey::from_digest(0x1F, vec![1u8; 32]);
        let address = FactAddress::from_digest(0x1F, vec![2u8; 32]);
        let env = Envelope::minimal(partition, address, Some(Bytes::from("query")));

        let result = slot.query_batch(vec![env]).await;

        // Default implementation returns NotSupported for each query
        assert!(result.is_err());
        assert!(matches!(result, Err(EnvelopeError::NotSupported)));
    }
}
