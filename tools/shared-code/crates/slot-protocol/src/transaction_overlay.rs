//! Content-addressed read-your-writes transaction overlays.
//!
//! Reader Envelopes carry only [`TransactionOverlayRef`]: a fixed-width
//! versioned reference to an immutable manifest. Final payload bytes live in
//! CAS and the manifest carries their content hashes. The complete write set
//! never crosses the reader request boundary.

use crate::{
    EnvelopeError, FactAddress, Hash, ImmutableContentRef, PartitionKey, PathSegment, WriteEntry,
};

const REF_MAGIC: &[u8] = b"slot-protocol.transaction-overlay-ref";
const REF_VERSION: u32 = 1;
const MANIFEST_MAGIC: &[u8] = b"slot-protocol.transaction-overlay-manifest";
const MANIFEST_VERSION: u32 = 1;
/// Fixed-size reader transport for one immutable transaction snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransactionOverlayRef {
    /// Blake3-256 of the canonical partition multihash wire bytes.
    pub partition_binding: ImmutableContentRef,
    /// Content hash of [`TransactionOverlayManifest`] bytes.
    pub manifest: ImmutableContentRef,
}

impl TransactionOverlayRef {
    pub fn new(
        partition: &PartitionKey,
        manifest: ImmutableContentRef,
    ) -> Result<Self, EnvelopeError> {
        let partition_wire = partition.as_multihash().encode();
        let partition_binding = ImmutableContentRef::from_hash(Hash::blake3_hash(&partition_wire))?;
        Ok(Self {
            partition_binding,
            manifest,
        })
    }

    pub fn verify_partition(&self, partition: &PartitionKey) -> Result<(), EnvelopeError> {
        let expected =
            ImmutableContentRef::from_hash(Hash::blake3_hash(&partition.as_multihash().encode()))?;
        if self.partition_binding != expected {
            return Err(EnvelopeError::CodecError(
                "transaction overlay partition binding mismatch".to_string(),
            ));
        }
        Ok(())
    }
}

/// One final last-write-wins value inside an immutable overlay manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransactionOverlayManifestEntry {
    pub partition: PartitionKey,
    pub address: FactAddress,
    pub payload: Option<ImmutableContentRef>,
    pub path: Vec<PathSegment>,
}

/// Canonical final transaction view. Superseded values never appear here.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TransactionOverlayManifest {
    pub entries: Vec<TransactionOverlayManifestEntry>,
}

impl TransactionOverlayManifest {
    /// Build a manifest after every asserted payload has been externalized.
    ///
    /// `payload_refs` is position-aligned with `writes`; a retraction requires
    /// `None`, while an assertion requires `Some(ref)`.
    pub fn from_writes(
        writes: &[WriteEntry],
        payload_refs: &[Option<ImmutableContentRef>],
    ) -> Result<Self, EnvelopeError> {
        if writes.len() != payload_refs.len() {
            return Err(EnvelopeError::CodecError(
                "transaction overlay payload-ref cardinality mismatch".to_string(),
            ));
        }
        let mut entries = Vec::with_capacity(writes.len());
        for (write, payload_ref) in writes.iter().zip(payload_refs) {
            if write.payload.is_some() != payload_ref.is_some() {
                return Err(EnvelopeError::CodecError(
                    "transaction overlay assertion/retraction payload-ref mismatch".to_string(),
                ));
            }
            entries.push(TransactionOverlayManifestEntry {
                partition: write.partition.clone(),
                address: write.address.clone(),
                payload: payload_ref.clone(),
                path: write.path.clone(),
            });
        }
        Ok(Self { entries })
    }
}

fn append_multihash(
    bytes: &mut Vec<u8>,
    multihash: &content_crypto::Multihash,
    label: &str,
) -> Result<(), EnvelopeError> {
    let encoded_len = u32::try_from(multihash.encoded_len())
        .map_err(|_| EnvelopeError::CodecError(format!("transaction overlay {label} too large")))?;
    bytes.extend_from_slice(&encoded_len.to_le_bytes());
    let start = bytes.len();
    bytes.resize(start + encoded_len as usize, 0);
    multihash.encode_into(&mut bytes[start..]);
    Ok(())
}

fn read_u32(bytes: &[u8], cursor: &mut usize, label: &str) -> Result<u32, EnvelopeError> {
    let end = cursor.checked_add(4).ok_or_else(|| {
        EnvelopeError::CodecError(format!("transaction overlay overflow in {label}"))
    })?;
    let raw = bytes.get(*cursor..end).ok_or_else(|| {
        EnvelopeError::CodecError(format!("transaction overlay truncated in {label}"))
    })?;
    *cursor = end;
    Ok(u32::from_le_bytes(
        raw.try_into().expect("four-byte transaction-overlay field"),
    ))
}

fn read_slice<'a>(
    bytes: &'a [u8],
    cursor: &mut usize,
    len: usize,
    label: &str,
) -> Result<&'a [u8], EnvelopeError> {
    let end = cursor.checked_add(len).ok_or_else(|| {
        EnvelopeError::CodecError(format!("transaction overlay overflow in {label}"))
    })?;
    let raw = bytes.get(*cursor..end).ok_or_else(|| {
        EnvelopeError::CodecError(format!("transaction overlay truncated in {label}"))
    })?;
    *cursor = end;
    Ok(raw)
}

/// Canonically encode only final entry metadata and immutable payload refs.
pub fn encode_transaction_overlay_manifest(
    manifest: &TransactionOverlayManifest,
) -> Result<Vec<u8>, EnvelopeError> {
    let entry_count = u32::try_from(manifest.entries.len()).map_err(|_| {
        EnvelopeError::CodecError("transaction overlay manifest too many entries".to_string())
    })?;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(MANIFEST_MAGIC);
    bytes.extend_from_slice(&MANIFEST_VERSION.to_le_bytes());
    bytes.extend_from_slice(&entry_count.to_le_bytes());
    for entry in &manifest.entries {
        append_multihash(
            &mut bytes,
            entry.partition.as_multihash(),
            "manifest partition",
        )?;
        append_multihash(&mut bytes, entry.address.as_multihash(), "manifest address")?;
        match &entry.payload {
            Some(payload) => {
                bytes.push(1);
                payload.encode_fixed(&mut bytes);
            }
            None => bytes.push(0),
        }
        let path_count = u32::try_from(entry.path.len()).map_err(|_| {
            EnvelopeError::CodecError("transaction overlay manifest path too large".to_string())
        })?;
        bytes.extend_from_slice(&path_count.to_le_bytes());
        for segment in &entry.path {
            append_multihash(&mut bytes, segment.as_multihash(), "manifest path segment")?;
        }
    }
    Ok(bytes)
}

pub fn decode_transaction_overlay_manifest(
    bytes: &[u8],
) -> Result<TransactionOverlayManifest, EnvelopeError> {
    if !bytes.starts_with(MANIFEST_MAGIC) {
        return Err(EnvelopeError::CodecError(
            "transaction overlay manifest magic mismatch".to_string(),
        ));
    }
    let mut cursor = MANIFEST_MAGIC.len();
    let version = read_u32(bytes, &mut cursor, "manifest version")?;
    if version != MANIFEST_VERSION {
        return Err(EnvelopeError::CodecError(format!(
            "unsupported transaction overlay manifest version {version}"
        )));
    }
    let entry_count = read_u32(bytes, &mut cursor, "manifest entry count")? as usize;
    let mut entries = Vec::with_capacity(entry_count);
    for _ in 0..entry_count {
        let partition_len = read_u32(bytes, &mut cursor, "manifest partition length")? as usize;
        let partition = content_crypto::Multihash::decode(read_slice(
            bytes,
            &mut cursor,
            partition_len,
            "manifest partition",
        )?)
        .map_err(|error| {
            EnvelopeError::CodecError(format!(
                "transaction overlay manifest partition decode failed: {error}"
            ))
        })?;
        let address_len = read_u32(bytes, &mut cursor, "manifest address length")? as usize;
        let address = content_crypto::Multihash::decode(read_slice(
            bytes,
            &mut cursor,
            address_len,
            "manifest address",
        )?)
        .map_err(|error| {
            EnvelopeError::CodecError(format!(
                "transaction overlay manifest address decode failed: {error}"
            ))
        })?;
        let payload_present = *read_slice(bytes, &mut cursor, 1, "manifest payload-ref marker")?
            .first()
            .expect("one-byte marker");
        let payload = match payload_present {
            0 => None,
            1 => Some(ImmutableContentRef::decode_fixed(read_slice(
                bytes,
                &mut cursor,
                ImmutableContentRef::WIRE_LEN,
                "manifest payload ref",
            )?)?),
            _ => {
                return Err(EnvelopeError::CodecError(
                    "transaction overlay manifest payload-ref marker must be 0 or 1".to_string(),
                ))
            }
        };
        let path_count = read_u32(bytes, &mut cursor, "manifest path count")? as usize;
        let mut path = Vec::with_capacity(path_count);
        for _ in 0..path_count {
            let segment_len =
                read_u32(bytes, &mut cursor, "manifest path segment length")? as usize;
            let segment = content_crypto::Multihash::decode(read_slice(
                bytes,
                &mut cursor,
                segment_len,
                "manifest path segment",
            )?)
            .map_err(|error| {
                EnvelopeError::CodecError(format!(
                    "transaction overlay manifest path decode failed: {error}"
                ))
            })?;
            path.push(PathSegment::from_multihash(segment));
        }
        entries.push(TransactionOverlayManifestEntry {
            partition: PartitionKey::from_multihash(partition),
            address: FactAddress::from_multihash(address),
            payload,
            path,
        });
    }
    if cursor != bytes.len() {
        return Err(EnvelopeError::CodecError(
            "transaction overlay manifest had trailing bytes".to_string(),
        ));
    }
    Ok(TransactionOverlayManifest { entries })
}

/// Wrap caller-owned context with one fixed-width transaction snapshot ref.
pub fn encode_transaction_overlay_ref(
    caller_context: Option<&[u8]>,
    overlay_ref: &TransactionOverlayRef,
) -> Result<Vec<u8>, EnvelopeError> {
    let context_len = u32::try_from(caller_context.map_or(0, <[u8]>::len)).map_err(|_| {
        EnvelopeError::CodecError("transaction overlay caller context too large".to_string())
    })?;
    let mut bytes = Vec::with_capacity(
        REF_MAGIC.len() + 4 + 1 + 4 + context_len as usize + ImmutableContentRef::WIRE_LEN * 2,
    );
    bytes.extend_from_slice(REF_MAGIC);
    bytes.extend_from_slice(&REF_VERSION.to_le_bytes());
    bytes.push(u8::from(caller_context.is_some()));
    bytes.extend_from_slice(&context_len.to_le_bytes());
    if let Some(context) = caller_context {
        bytes.extend_from_slice(context);
    }
    overlay_ref.partition_binding.encode_fixed(&mut bytes);
    overlay_ref.manifest.encode_fixed(&mut bytes);
    Ok(bytes)
}

/// Decode only an exact overlay-ref frame.
///
/// Unrelated opaque caller context returns `Ok(None)`. Once the magic matches,
/// malformed versions, widths, hashes, or trailing bytes fail closed.
pub type DecodedTransactionOverlayRef = (Option<Vec<u8>>, TransactionOverlayRef);

pub fn decode_transaction_overlay_ref(
    bytes: &[u8],
) -> Result<Option<DecodedTransactionOverlayRef>, EnvelopeError> {
    if !bytes.starts_with(REF_MAGIC) {
        return Ok(None);
    }
    let mut cursor = REF_MAGIC.len();
    let version = read_u32(bytes, &mut cursor, "ref version")?;
    if version != REF_VERSION {
        return Err(EnvelopeError::CodecError(format!(
            "unsupported transaction overlay ref version {version}"
        )));
    }
    let context_present = *read_slice(bytes, &mut cursor, 1, "caller-context marker")?
        .first()
        .expect("one-byte marker");
    if context_present > 1 {
        return Err(EnvelopeError::CodecError(
            "transaction overlay caller-context marker must be 0 or 1".to_string(),
        ));
    }
    let context_len = read_u32(bytes, &mut cursor, "caller-context length")? as usize;
    if context_present == 0 && context_len != 0 {
        return Err(EnvelopeError::CodecError(
            "transaction overlay absent caller context has non-zero length".to_string(),
        ));
    }
    let caller_context = read_slice(bytes, &mut cursor, context_len, "caller context")?.to_vec();
    let partition_binding = ImmutableContentRef::decode_fixed(read_slice(
        bytes,
        &mut cursor,
        ImmutableContentRef::WIRE_LEN,
        "partition binding",
    )?)?;
    let manifest = ImmutableContentRef::decode_fixed(read_slice(
        bytes,
        &mut cursor,
        ImmutableContentRef::WIRE_LEN,
        "manifest ref",
    )?)?;
    if cursor != bytes.len() {
        return Err(EnvelopeError::CodecError(
            "transaction overlay ref had trailing bytes".to_string(),
        ));
    }
    Ok(Some((
        (context_present == 1).then_some(caller_context),
        TransactionOverlayRef {
            partition_binding,
            manifest,
        },
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(label: &str, payload: Option<Vec<u8>>) -> WriteEntry {
        WriteEntry {
            partition: PartitionKey::hash_from("partition"),
            address: FactAddress::hash_from(label),
            payload,
            path: vec![PathSegment::hash_from("current-item")],
            expected_current: None,
        }
    }

    #[test]
    fn ref_transport_width_is_independent_of_manifest_cardinality() {
        let partition = PartitionKey::hash_from("partition");
        let manifest = ImmutableContentRef::from_hash(Hash::blake3_hash(b"manifest")).unwrap();
        let reference = TransactionOverlayRef::new(&partition, manifest).unwrap();
        let without_context = encode_transaction_overlay_ref(None, &reference).unwrap();
        let with_context =
            encode_transaction_overlay_ref(Some(b"caller-owned"), &reference).unwrap();
        assert_eq!(
            with_context.len() - without_context.len(),
            b"caller-owned".len()
        );
        let (caller_context, decoded) = decode_transaction_overlay_ref(&with_context)
            .unwrap()
            .unwrap();
        assert_eq!(caller_context.as_deref(), Some(b"caller-owned".as_slice()));
        assert_eq!(decoded, reference);
        decoded.verify_partition(&partition).unwrap();
    }

    #[test]
    fn manifest_contains_refs_not_payload_bytes_and_round_trips_retractions() {
        let writes = vec![write("a", Some(vec![0, 255, 7])), write("b", None)];
        let payload_ref =
            ImmutableContentRef::from_hash(Hash::blake3_hash(&writes[0].payload.clone().unwrap()))
                .unwrap();
        let manifest =
            TransactionOverlayManifest::from_writes(&writes, &[Some(payload_ref.clone()), None])
                .unwrap();
        let encoded = encode_transaction_overlay_manifest(&manifest).unwrap();
        assert!(!encoded.windows(3).any(|window| window == [0, 255, 7]));
        let decoded = decode_transaction_overlay_manifest(&encoded).unwrap();
        assert_eq!(decoded, manifest);
        assert_eq!(decoded.entries[0].payload.as_ref(), Some(&payload_ref));
        assert!(decoded.entries[1].payload.is_none());
    }

    #[test]
    fn malformed_or_foreign_refs_fail_closed() {
        assert!(decode_transaction_overlay_ref(b"{\"ordinary\":true}")
            .unwrap()
            .is_none());
        assert!(decode_transaction_overlay_ref(REF_MAGIC).is_err());
        assert!(ImmutableContentRef::from_hash(Hash::sha256([7; 32])).is_err());
    }

    #[test]
    fn partition_binding_rejects_foreign_partition() {
        let partition = PartitionKey::hash_from("partition-a");
        let manifest = ImmutableContentRef::from_hash(Hash::blake3_hash(b"manifest")).unwrap();
        let reference = TransactionOverlayRef::new(&partition, manifest).unwrap();
        assert!(reference
            .verify_partition(&PartitionKey::hash_from("partition-b"))
            .is_err());
    }
}
