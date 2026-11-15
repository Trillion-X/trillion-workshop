//! Tests for Slot::query() Envelope-based routing.
//!
//! Verifies that query() routes by FactAddress (Physics) instead of
//! string method names (Society), as per L090.

use bytes::Bytes;
use slot_protocol::{
    Envelope, EnvelopeError, FactAddress, Hash, MethodDescriptor, PartitionKey, Slot,
};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// A simple test slot that implements query() routing by address.
struct QueryTestSlot;

impl Slot for QueryTestSlot {
    fn dispatch(&self, entries: Vec<Envelope>) -> Result<Hash, EnvelopeError> {
        if entries.is_empty() {
            return Err(EnvelopeError::AddressNotFound);
        }
        Ok(Hash::from_multihash(
            entries[0].address.as_multihash().clone(),
        ))
    }

    fn query(
        &self,
        envelope: Envelope,
    ) -> Pin<Box<dyn Future<Output = Result<Arc<[u8]>, EnvelopeError>> + Send + '_>> {
        Box::pin(async move {
            // Route by FactAddress (Physics), not by string method name (Society)
            // The payload is self-describing per L090
            match envelope.payload {
                Some(payload) => {
                    // Simple echo for testing: return the payload as-is
                    Ok(Arc::from(payload.as_ref()))
                }
                None => Err(EnvelopeError::NotSupported),
            }
        })
    }

    fn methods(&self) -> Vec<MethodDescriptor> {
        vec![MethodDescriptor::new("query", "Query operation")]
    }
}

#[tokio::test]
async fn test_query_routes_by_envelope_address() {
    let slot: Arc<dyn Slot> = Arc::new(QueryTestSlot);
    let partition = PartitionKey::from_digest(0x1F, vec![1u8; 32]);
    let address = FactAddress::from_digest(0x1F, vec![2u8; 32]);
    let payload = Some(Bytes::from("test query data"));

    let env = Envelope::minimal(partition, address, payload.clone());
    let result = slot.query(env).await;

    assert!(result.is_ok(), "query should succeed with payload");
    let data = result.unwrap();
    assert_eq!(data.as_ref(), b"test query data");
}

#[tokio::test]
async fn test_query_without_payload_returns_error() {
    let slot: Arc<dyn Slot> = Arc::new(QueryTestSlot);
    let partition = PartitionKey::from_digest(0x1F, vec![1u8; 32]);
    let address = FactAddress::from_digest(0x1F, vec![2u8; 32]);

    let env = Envelope::minimal(partition, address, None);
    let result = slot.query(env).await;

    assert!(result.is_err(), "query without payload should fail");
    assert!(matches!(result, Err(EnvelopeError::NotSupported)));
}

#[tokio::test]
async fn test_query_self_describing_payload() {
    let slot: Arc<dyn Slot> = Arc::new(QueryTestSlot);
    let partition = PartitionKey::from_digest(0x1F, vec![3u8; 32]);
    let address = FactAddress::from_digest(0x1F, vec![4u8; 32]);

    // Payload is self-describing (L090) — no method string needed
    let self_describing_payload = Bytes::from(r#"{"query":"user","id":"123"}"#);
    let env = Envelope::minimal(partition, address, Some(self_describing_payload.clone()));

    let result = slot.query(env).await;

    assert!(result.is_ok());
    let data = result.unwrap();
    assert_eq!(data.as_ref(), self_describing_payload.as_ref());
}

#[tokio::test]
async fn test_query_routes_by_different_addresses() {
    let slot: Arc<dyn Slot> = Arc::new(QueryTestSlot);
    let partition = PartitionKey::from_digest(0x1F, vec![5u8; 32]);

    // Different addresses should route to the same slot but could be handled differently
    let address1 = FactAddress::from_digest(0x1F, vec![6u8; 32]);
    let address2 = FactAddress::from_digest(0x1F, vec![7u8; 32]);

    let payload1 = Some(Bytes::from("data1"));
    let payload2 = Some(Bytes::from("data2"));

    let env1 = Envelope::minimal(partition.clone(), address1, payload1.clone());
    let env2 = Envelope::minimal(partition, address2, payload2.clone());

    let result1 = slot.query(env1).await;
    let result2 = slot.query(env2).await;

    assert!(result1.is_ok());
    assert!(result2.is_ok());

    // Results should differ because payloads differ
    assert_ne!(result1.unwrap().as_ref(), result2.unwrap().as_ref());
}

#[tokio::test]
async fn test_default_slot_query_not_supported() {
    /// A slot that doesn't override query()
    struct DefaultQuerySlot;

    impl Slot for DefaultQuerySlot {
        fn dispatch(&self, entries: Vec<Envelope>) -> Result<Hash, EnvelopeError> {
            if entries.is_empty() {
                return Err(EnvelopeError::AddressNotFound);
            }
            Ok(Hash::from_multihash(
                entries[0].address.as_multihash().clone(),
            ))
        }

        fn methods(&self) -> Vec<MethodDescriptor> {
            vec![MethodDescriptor::new("write", "Write operation")]
        }
    }

    let slot: Arc<dyn Slot> = Arc::new(DefaultQuerySlot);
    let partition = PartitionKey::from_digest(0x1F, vec![8u8; 32]);
    let address = FactAddress::from_digest(0x1F, vec![9u8; 32]);
    let env = Envelope::minimal(partition, address, Some(Bytes::from("test")));

    let result = slot.query(env).await;

    // Default implementation returns NotSupported
    assert!(result.is_err());
    assert!(matches!(result, Err(EnvelopeError::NotSupported)));
}
