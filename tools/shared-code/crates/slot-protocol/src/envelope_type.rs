//! The irreducible structural envelope for all data flowing through the platform.
//!
//! The Envelope is Physics: the engine reads ONLY exterior fields.
//! The payload remains NEVER deserialized by engine code.
//!
//! Structure:
//! - `partition_key`: routing isolation boundary
//! - `address`: entity identity (stable, content-addressed Blake3-256)
//! - `path`: optional structural sub-address (opaque routing hint)
//! - `read_capabilities`: authorization labels
//! - `wasm_reducer_hash`: optional merge reducer reference
//! - `payload`: opaque bytes (None = retraction)

use crate::newtypes::{CapabilityHash, FactAddress, Hash, PartitionKey, PathSegment};
use crate::EnvelopeError;
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use smallvec::SmallVec;

/// The irreducible structural envelope for all data in the platform.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope {
    /// Partition-isolated causal boundary (routing identity).
    pub partition_key: PartitionKey,

    /// Stable entity identity (content-addressed Blake3-256).
    pub address: FactAddress,

    /// Optional structural sub-address (opaque routing hint).
    /// Empty for whole-object granularity.
    pub path: SmallVec<[PathSegment; 8]>,

    /// Authorization labels. Empty means no capability restriction.
    pub read_capabilities: SmallVec<[CapabilityHash; 8]>,

    /// Optional merge reducer reference (WASM hash).
    /// None = no automatic merge; conflicts become ConflictSet.
    pub wasm_reducer_hash: Option<Hash>,

    /// Opaque payload. None = retraction (entity deleted).
    /// The engine NEVER deserializes this.
    #[serde(with = "envelope_payload_serde")]
    pub payload: Option<Bytes>,

    /// Multihash-backed hash of the payload bytes. None when payload is None (retraction).
    /// Computed at Layer 1 Ingress — the engine treats this as identity metadata,
    /// not an interpretation of the payload contents.
    /// Enables: content-addressed dedup, mesh sync integrity, portable artifact verification.
    pub payload_hash: Option<Hash>,

    /// Opaque auxiliary context for the receiving slot. None for most envelopes.
    /// Set by the edge driver (from ReactiveEdge.context) or any dispatcher that
    /// needs to pass configuration alongside the payload. The engine NEVER inspects
    /// this field — it is carried blindly from sender to receiver.
    /// (MACP Rounds 36-41: L99 collapse — transforms receive context from caller
    /// instead of fetching via I/O, making the hot path a pure function.)
    #[serde(default, with = "envelope_payload_serde")]
    pub context: Option<Bytes>,
}

/// Serde helpers for Bytes serialization through FFI boundaries.
mod envelope_payload_serde {
    use bytes::Bytes;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(
        bytes: &Option<Bytes>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match bytes {
            None => serializer.serialize_none(),
            Some(b) => serializer.serialize_bytes(b),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Bytes>, D::Error> {
        match <Option<Vec<u8>>>::deserialize(deserializer)? {
            None => Ok(None),
            Some(vec) => Ok(Some(Bytes::from(vec))),
        }
    }
}

impl Envelope {
    /// Create a new Envelope with all fields.
    pub fn new(
        partition_key: PartitionKey,
        address: FactAddress,
        path: SmallVec<[PathSegment; 8]>,
        read_capabilities: SmallVec<[CapabilityHash; 8]>,
        wasm_reducer_hash: Option<Hash>,
        payload: Option<Bytes>,
    ) -> Self {
        let payload_hash = payload.as_ref().map(|b| Hash::blake3_hash(b));
        Envelope {
            partition_key,
            address,
            path,
            read_capabilities,
            wasm_reducer_hash,
            payload,
            payload_hash,
            context: None,
        }
    }

    /// Create an Envelope with minimal fields (no path, no capabilities, no reducer).
    pub fn minimal(
        partition_key: PartitionKey,
        address: FactAddress,
        payload: Option<Bytes>,
    ) -> Self {
        let payload_hash = payload.as_ref().map(|b| Hash::blake3_hash(b));
        Envelope {
            partition_key,
            address,
            path: SmallVec::new(),
            read_capabilities: SmallVec::new(),
            wasm_reducer_hash: None,
            payload,
            payload_hash,
            context: None,
        }
    }

    /// Create an Envelope when the caller already owns the authoritative
    /// payload-hash metadata and must not recompute it from payload bytes.
    ///
    /// This is the canonical constructor for read/replay/materialization paths
    /// that already hold the engine-authoritative content hash. The caller is
    /// responsible for supplying the correct hash for the payload bytes.
    pub fn from_known_payload_hash(
        partition_key: PartitionKey,
        address: FactAddress,
        path: SmallVec<[PathSegment; 8]>,
        read_capabilities: SmallVec<[CapabilityHash; 8]>,
        wasm_reducer_hash: Option<Hash>,
        payload: Option<Bytes>,
        payload_hash: Option<Hash>,
    ) -> Self {
        Envelope {
            partition_key,
            address,
            path,
            read_capabilities,
            wasm_reducer_hash,
            payload,
            payload_hash,
            context: None,
        }
    }

    /// Create an inter-slot dispatch envelope without deriving durable content metadata.
    ///
    /// This is the canonical constructor for slot-to-slot query/command transport:
    /// - the payload is an opaque request body, not newly-authored persisted state
    /// - routing still needs the canonical partition/address exterior
    /// - payload hashing is intentionally skipped so large transport payloads do not
    ///   pay durable-state costs just to cross the talk-to-other-slots boundary
    pub fn dispatch(
        partition_key: PartitionKey,
        address: FactAddress,
        payload: Option<Bytes>,
    ) -> Self {
        Envelope {
            partition_key,
            address,
            path: SmallVec::new(),
            read_capabilities: SmallVec::new(),
            wasm_reducer_hash: None,
            payload,
            payload_hash: None,
            context: None,
        }
    }

    /// Create an Envelope from already-arrived query/dispatch bytes without
    /// recomputing a payload hash in the receiving slot.
    ///
    /// This is the canonical constructor for WASM guest entry adapters:
    /// - routing fields already arrived over the host boundary
    /// - payload bytes are opaque request bytes, not newly-authored content
    /// - the receiving slot must not spend time hashing large inbound query
    ///   payloads just to reconstruct the local Envelope shape
    pub fn received(
        partition_key: PartitionKey,
        address: FactAddress,
        payload: Option<Bytes>,
        context: Option<Bytes>,
    ) -> Self {
        Envelope {
            partition_key,
            address,
            path: SmallVec::new(),
            read_capabilities: SmallVec::new(),
            wasm_reducer_hash: None,
            payload,
            payload_hash: None,
            context,
        }
    }

    /// Check if this is a retraction (no payload).
    pub fn is_retraction(&self) -> bool {
        self.payload.is_none()
    }

    /// Check if this is an assertion (has payload).
    pub fn is_assertion(&self) -> bool {
        self.payload.is_some()
    }

    /// Get payload size or 0 for retraction.
    pub fn payload_size(&self) -> usize {
        self.payload.as_ref().map(|b| b.len()).unwrap_or(0)
    }
}

/// Build request bytes for asking another slot through a compact binary Envelope.
///
/// Inter-slot dispatch must preserve opaque payload bytes without JSON byte-array
/// bloat. CBOR carries byte strings natively, so large mounted tool payloads stay
/// compact across one slot -> talk-to-other-slots -> another slot dispatch.
pub fn make_request_bytes_for_other_slots(envelope: &Envelope) -> Result<Vec<u8>, EnvelopeError> {
    make_request_bytes_for_other_slots_with_reply_delivery(envelope, crate::ReplyDelivery::Inline)
}

/// Build an inter-slot request with an explicit native reply-delivery policy.
pub fn make_request_bytes_for_other_slots_with_reply_delivery(
    envelope: &Envelope,
    reply_delivery: crate::ReplyDelivery,
) -> Result<Vec<u8>, EnvelopeError> {
    crate::encode_other_slot_request(&crate::OtherSlotRequest::new(
        envelope.clone(),
        reply_delivery,
    ))
}

/// Read a request Envelope from compact request bytes sent by another slot.
pub fn read_request_bytes_from_other_slots(bytes: &[u8]) -> Result<Envelope, EnvelopeError> {
    Ok(crate::decode_other_slot_request(bytes)?.envelope)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_envelope_creation() {
        let partition = PartitionKey::from_digest(0x1F, vec![1; 32]);
        let address = FactAddress::from_digest(0x1F, vec![2; 32]);
        let envelope = Envelope::minimal(
            partition.clone(),
            address.clone(),
            Some(Bytes::from("test")),
        );

        assert_eq!(envelope.partition_key, partition);
        assert_eq!(envelope.address, address);
        assert!(!envelope.is_retraction());
        assert!(envelope.is_assertion());
        assert_eq!(envelope.payload_size(), 4);
    }

    #[test]
    fn test_envelope_retraction() {
        let partition = PartitionKey::from_digest(0x1F, vec![1; 32]);
        let address = FactAddress::from_digest(0x1F, vec![2; 32]);
        let envelope = Envelope::minimal(partition, address, None);

        assert!(envelope.is_retraction());
        assert!(!envelope.is_assertion());
        assert_eq!(envelope.payload_size(), 0);
    }

    #[test]
    fn test_dispatch_skips_payload_hash() {
        let partition = PartitionKey::from_digest(0x1F, vec![1; 32]);
        let address = FactAddress::from_digest(0x1F, vec![2; 32]);
        let envelope = Envelope::dispatch(
            partition,
            address,
            Some(Bytes::from_static(b"opaque-query-payload")),
        );

        assert!(envelope.payload.is_some());
        assert!(envelope.payload_hash.is_none());
    }

    #[test]
    fn test_envelope_with_path() {
        let partition = PartitionKey::from_digest(0x1F, vec![1; 32]);
        let address = FactAddress::from_digest(0x1F, vec![2; 32]);
        let path_seg = PathSegment::from_digest(0x1F, vec![3; 32]);
        let mut path = SmallVec::new();
        path.push(path_seg);

        let envelope = Envelope::new(
            partition,
            address,
            path.clone(),
            SmallVec::new(),
            None,
            Some(Bytes::from("data")),
        );

        assert_eq!(envelope.path, path);
        assert_eq!(envelope.path.len(), 1);
    }

    #[test]
    fn test_payload_hash_computed_for_assertions() {
        let partition = PartitionKey::from_digest(0x1F, vec![1; 32]);
        let address = FactAddress::from_digest(0x1F, vec![2; 32]);
        let payload = Bytes::from("hello world");
        let envelope = Envelope::minimal(partition, address, Some(payload.clone()));

        assert!(envelope.payload_hash.is_some());
        assert_eq!(envelope.payload_hash.unwrap(), Hash::blake3_hash(&payload));
    }

    #[test]
    fn test_payload_hash_none_for_retractions() {
        let partition = PartitionKey::from_digest(0x1F, vec![1; 32]);
        let address = FactAddress::from_digest(0x1F, vec![2; 32]);
        let envelope = Envelope::minimal(partition, address, None);

        assert!(envelope.payload_hash.is_none());
    }

    #[test]
    fn test_known_payload_hash_constructor_preserves_authority_without_rehashing() {
        let partition = PartitionKey::from_digest(0x1F, vec![1; 32]);
        let address = FactAddress::from_digest(0x1F, vec![2; 32]);
        let payload = Bytes::from_static(b"hello world");
        let payload_hash = Hash::blake3_hash(&payload);

        let envelope = Envelope::from_known_payload_hash(
            partition.clone(),
            address.clone(),
            SmallVec::new(),
            SmallVec::new(),
            None,
            Some(payload.clone()),
            Some(payload_hash.clone()),
        );

        assert_eq!(envelope.partition_key, partition);
        assert_eq!(envelope.address, address);
        assert_eq!(envelope.payload, Some(payload));
        assert_eq!(envelope.payload_hash, Some(payload_hash));
    }

    #[test]
    fn test_received_envelope_preserves_payload_without_hashing() {
        let partition = PartitionKey::from_digest(0x1F, vec![1; 32]);
        let address = FactAddress::from_digest(0x1F, vec![2; 32]);
        let payload = Bytes::from_static(b"opaque-query-bytes");
        let context = Bytes::from_static(b"context-bytes");

        let envelope = Envelope::received(
            partition.clone(),
            address.clone(),
            Some(payload.clone()),
            Some(context.clone()),
        );

        assert_eq!(envelope.partition_key, partition);
        assert_eq!(envelope.address, address);
        assert_eq!(envelope.payload, Some(payload));
        assert_eq!(envelope.context, Some(context));
        assert!(
            envelope.payload_hash.is_none(),
            "received envelopes must not rehash already-arrived opaque bytes",
        );
    }

    #[test]
    fn test_envelope_serialization() {
        let partition = PartitionKey::from_digest(0x1F, vec![1; 32]);
        let address = FactAddress::from_digest(0x1F, vec![2; 32]);
        let envelope = Envelope::minimal(partition, address, Some(Bytes::from("test")));

        let json = serde_json::to_string(&envelope).expect("serialization failed");
        let deserialized: Envelope = serde_json::from_str(&json).expect("deserialization failed");

        assert_eq!(envelope, deserialized);
    }
}
