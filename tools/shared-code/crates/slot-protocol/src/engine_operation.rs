use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use bytes::Bytes;

use crate::{Envelope, EnvelopeError, FactAddress, QueryResult};

/// One engine-operation request carried through an already-selected slot target.
///
/// The target is the door. The operation id is data inside the request frame.
/// This keeps transport routes blind while allowing native handlers to grow by
/// registry composition instead of by adding more carrier endpoints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineOperationFrame {
    pub operation: FactAddress,
    pub payload: Bytes,
}

/// Catalog-visible operation identity.
///
/// Descriptor metadata is intentionally minimal at this layer. Request and
/// response schemas belong to the operation owner; the carrier only needs the
/// stable operation address to advertise and resolve the callable.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct EngineOperationDescriptor {
    pub operation: FactAddress,
}

pub fn encode_engine_operation_frame(
    operation: &FactAddress,
    payload: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    let operation_hash = operation.as_multihash();
    let operation_len = operation_hash.encoded_len();
    let frame_len = u32::try_from(operation_len)
        .map_err(|_| EnvelopeError::CodecError("engine operation id too large".to_string()))?;
    let mut frame = Vec::with_capacity(4 + operation_len + payload.len());
    frame.extend_from_slice(&frame_len.to_le_bytes());
    let start = frame.len();
    frame.resize(start + operation_len, 0);
    operation_hash.encode_into(&mut frame[start..start + operation_len]);
    frame.extend_from_slice(payload);
    Ok(frame)
}

pub fn decode_engine_operation_frame(bytes: Bytes) -> Result<EngineOperationFrame, EnvelopeError> {
    if bytes.len() < 4 {
        return Err(EnvelopeError::CodecError(
            "engine operation frame truncated in operation length".to_string(),
        ));
    }
    let operation_len = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    let operation_end = 4usize.checked_add(operation_len).ok_or_else(|| {
        EnvelopeError::CodecError("engine operation frame length overflow".into())
    })?;
    if bytes.len() < operation_end {
        return Err(EnvelopeError::CodecError(
            "engine operation frame truncated in operation id".to_string(),
        ));
    }
    let operation_hash =
        content_crypto::Multihash::decode(&bytes[4..operation_end]).map_err(|error| {
            EnvelopeError::CodecError(format!("engine operation id decode failed: {error}"))
        })?;
    Ok(EngineOperationFrame {
        operation: FactAddress::from_multihash(operation_hash),
        payload: bytes.slice(operation_end..),
    })
}

pub trait EngineOperation: Send + Sync {
    fn invoke(
        &self,
        envelope: Envelope,
        payload: Bytes,
    ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>>;
}

#[derive(Default)]
pub struct EngineOperationRegistry {
    operations: HashMap<FactAddress, Arc<dyn EngineOperation>>,
}

impl EngineOperationRegistry {
    pub fn new() -> Self {
        Self {
            operations: HashMap::new(),
        }
    }

    pub fn register(&mut self, operation: FactAddress, handler: Arc<dyn EngineOperation>) {
        self.operations.insert(operation, handler);
    }

    pub fn get(&self, operation: &FactAddress) -> Option<Arc<dyn EngineOperation>> {
        self.operations.get(operation).cloned()
    }

    pub fn descriptors(&self) -> Vec<EngineOperationDescriptor> {
        let mut descriptors: Vec<_> = self
            .operations
            .keys()
            .cloned()
            .map(|operation| EngineOperationDescriptor { operation })
            .collect();
        descriptors.sort();
        descriptors
    }

    pub fn len(&self) -> usize {
        self.operations.len()
    }

    pub fn is_empty(&self) -> bool {
        self.operations.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::{Envelope, PartitionKey};

    struct EchoOperation;

    impl EngineOperation for EchoOperation {
        fn invoke(
            &self,
            _envelope: Envelope,
            payload: Bytes,
        ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>> {
            Box::pin(async move { Ok(QueryResult::read_only(Arc::from(payload.to_vec()))) })
        }
    }

    #[test]
    fn operation_frame_round_trips_exact_operation_and_payload() {
        let operation = FactAddress::hash_from("engine.operation.echo");
        let encoded = Bytes::from(encode_engine_operation_frame(&operation, b"payload").unwrap());
        let decoded = decode_engine_operation_frame(encoded).unwrap();

        assert_eq!(decoded.operation, operation);
        assert_eq!(decoded.payload.as_ref(), b"payload");
    }

    #[tokio::test]
    async fn registry_resolves_operation_without_endpoint_branching() {
        let operation = FactAddress::hash_from("engine.operation.echo");
        let mut registry = EngineOperationRegistry::new();
        registry.register(operation.clone(), Arc::new(EchoOperation));

        let handler = registry.get(&operation).unwrap();
        let result = handler
            .invoke(
                Envelope::minimal(PartitionKey::hash_from("partition"), operation, None),
                Bytes::from_static(b"opaque"),
            )
            .await
            .unwrap();

        assert_eq!(result.response.as_ref(), b"opaque");
        assert!(registry.get(&FactAddress::hash_from("missing")).is_none());
    }

    #[test]
    fn registry_exposes_sorted_operation_descriptors() {
        let operation_b = FactAddress::hash_from("engine.operation.b");
        let operation_a = FactAddress::hash_from("engine.operation.a");
        let mut registry = EngineOperationRegistry::new();
        registry.register(operation_b.clone(), Arc::new(EchoOperation));
        registry.register(operation_a.clone(), Arc::new(EchoOperation));

        assert_eq!(
            registry.descriptors(),
            vec![
                EngineOperationDescriptor {
                    operation: operation_a
                },
                EngineOperationDescriptor {
                    operation: operation_b
                }
            ]
        );
    }
}
