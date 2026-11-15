// crates/slot-protocol/src/handler.rs
//
// Purpose:
//   Handler registration infrastructure for the native handler lookup table.
//   Each handler crate exports a `register(ctx: &EngineContext)` function.
//   The EngineContext provides the dispatch handle, slot registry, and handler table.
//
// Architecture (§40 — Zero Custom Slot Types):
//   Layer 1: Handler code — compiled Rust functions (Physics).
//   Layer 2: Handler registration — each handler crate's register_handlers(ctx) populates HandlerTable.
//   Layer 3: Slot types — ALL DispatchSlot. Zero custom.
//   Layer 4: Slot config — Envelope state at slot::*. Society data. Runtime.
//
// The Slot is the named door (ingress). The handler is the room.
// Custom logic (query handling, process execution, etc.) is registered as
// handlers via EngineContext, NOT as custom Slot implementations.
//
// Non-Negotiable Invariants:
//   - Zero custom Slot types (L069: DispatchSlot is the generative primitive)
//   - Handler code is compiled Rust — Rust Physics prerequisite
//   - Handler registration is data-driven (handler crates register during boot, not hardcoded in host)
//   - QueryHandler is the only extension point for slot-specific query logic

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::cas_blob_writer::CasBlobWriter;
use crate::cas_reader::CasReader;
use crate::dispatch_handle::DispatchHandle;
use crate::registry::SlotRegistry;
use crate::{
    EngineOperationDescriptor, Envelope, EnvelopeError, FactAddress, Hash, PartitionKey,
    PathSegment,
};

// ============================================================================
// WriteEntry + QueryResult — mutation-aware query return types (L063/L069)
// ============================================================================

/// A write entry produced by a query handler's mutation.
///
/// When a QueryHandler processes a request that mutates state, it returns
/// WriteEntry items alongside the response.
/// DispatchSlot automatically dispatches these through `dispatch_rewrite` — the handler
/// never needs to hold or call a DispatchHandle directly.
///
/// # Why This Exists (L055 deepest root)
///
/// `QueryHandler::query()` originally returned only `Result<Arc<[u8]>, EnvelopeError>` —
/// a pure read signature with no channel for writes. 12 of 20 QueryHandler implementations
/// mutate through `query()` (because `Slot::dispatch()` is fire-and-forget with no response).
/// Without WriteEntry, each mutating handler must independently wire `dispatch_rewrite` —
/// an instance fix (L043). WriteEntry + QueryResult make writes a first-class part of the
/// query contract so DispatchSlot dispatches them generically (L063).
#[derive(Debug, Clone)]
pub struct WriteEntry {
    /// Target partition for the write.
    pub partition: PartitionKey,
    /// Target address.
    pub address: FactAddress,
    /// Opaque payload bytes. None = retraction.
    pub payload: Option<Vec<u8>>,
    /// Routing path. Empty for address-only writes.
    pub path: Vec<PathSegment>,
    /// Optional current-value guard. When present, the write is accepted only if
    /// the live address still has this payload hash, or is absent when the hash
    /// is None.
    pub expected_current: Option<ExpectedCurrentValue>,
}

/// The exact current value a write was based on.
///
/// `payload_hash = Some(hash)` means the live address must currently exist with
/// that content hash. `payload_hash = None` means the live address must be absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedCurrentValue {
    pub payload_hash: Option<Hash>,
}

/// A current-value assertion that participates in an atomic write batch
/// without publishing a record of its own.
///
/// This is the read basis for another write, not a synthetic rewrite of the
/// guarded address. The engine validates every precondition and every
/// write-entry guard against one actor-local snapshot before publishing any
/// batch effect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WritePrecondition {
    pub partition: PartitionKey,
    pub address: FactAddress,
    pub expected_current: ExpectedCurrentValue,
}

/// One requested all-or-nothing mutation: ordinary writes plus assertions
/// over current values that must remain unchanged.
#[derive(Debug, Clone)]
pub struct AtomicWriteBatch {
    pub writes: Vec<WriteEntry>,
    pub preconditions: Vec<WritePrecondition>,
}

pub async fn dispatch_write_entry(
    handle: &dyn DispatchHandle,
    entry: WriteEntry,
) -> Result<Hash, EnvelopeError> {
    handle
        .dispatch_rewrite_with_expected_current(
            entry.partition,
            entry.address,
            entry.payload,
            entry.path,
            entry.expected_current.map(|expected| expected.payload_hash),
        )
        .await
}

/// Result of a single query — response bytes + optional writes.
///
/// Pure-read handlers return `QueryResult::read_only(bytes)` (zero-cost — empty Vec).
/// Mutating handlers return `QueryResult::with_writes(bytes, writes)`.
/// DispatchSlot dispatches the writes automatically.
#[derive(Debug, Clone)]
pub struct QueryResult {
    /// Response bytes returned to the caller (opaque — caller deserializes in its domain).
    pub response: Arc<[u8]>,
    /// Writes to dispatch through the Envelope engine. Empty for pure-read queries.
    pub writes: Vec<WriteEntry>,
}

impl QueryResult {
    /// Create a read-only result with no writes. Zero allocation for the writes vec.
    pub fn read_only(response: Arc<[u8]>) -> Self {
        Self {
            response,
            writes: Vec::new(),
        }
    }

    /// Create a result with both response data and writes to dispatch.
    pub fn with_writes(response: Arc<[u8]>, writes: Vec<WriteEntry>) -> Self {
        Self { response, writes }
    }
}

/// Encode a write batch into one compact binary blob for ABI transport.
///
/// Wire shape:
/// - `entry_count: u32 LE`
/// - repeated entry frames:
///   - `partition_len: u32 LE`
///   - `partition_bytes`
///   - `address_len: u32 LE`
///   - `address_bytes`
///   - `payload_present: u8`
///   - if present:
///     - `payload_len: u32 LE`
///     - `payload_bytes`
///   - `path_count: u32 LE`
///   - repeated path frames:
///     - `segment_len: u32 LE`
///     - `segment_bytes`
pub fn encode_write_batch(entries: &[WriteEntry]) -> Result<Vec<u8>, EnvelopeError> {
    encode_write_batch_with_preconditions(entries, &[])
}

/// Encode ordinary writes and precondition-only assertions into one atomic
/// batch frame.
///
/// The precondition extension is additive:
/// - the existing optional expected-current list remains unchanged;
/// - when preconditions are present, an expected-current count (possibly zero)
///   is followed by a precondition count and repeated
///   `(partition, address, expected-current)` frames.
pub fn encode_write_batch_with_preconditions(
    entries: &[WriteEntry],
    preconditions: &[WritePrecondition],
) -> Result<Vec<u8>, EnvelopeError> {
    fn append_multihash(
        bytes: &mut Vec<u8>,
        mh: &content_crypto::Multihash,
        len_error: &str,
    ) -> Result<(), EnvelopeError> {
        let encoded_len = mh.encoded_len();
        let frame_len = u32::try_from(encoded_len)
            .map_err(|_| EnvelopeError::CodecError(len_error.to_string()))?;
        bytes.extend_from_slice(&frame_len.to_le_bytes());
        let start = bytes.len();
        bytes.resize(start + encoded_len, 0);
        mh.encode_into(&mut bytes[start..start + encoded_len]);
        Ok(())
    }

    let entry_count = u32::try_from(entries.len())
        .map_err(|_| EnvelopeError::CodecError("write batch too many entries".to_string()))?;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&entry_count.to_le_bytes());
    for entry in entries {
        append_multihash(
            &mut bytes,
            entry.partition.as_multihash(),
            "write batch partition too large",
        )?;
        append_multihash(
            &mut bytes,
            entry.address.as_multihash(),
            "write batch address too large",
        )?;
        match &entry.payload {
            Some(payload) => {
                let payload_len = u32::try_from(payload.len()).map_err(|_| {
                    EnvelopeError::CodecError("write batch payload too large".to_string())
                })?;
                bytes.push(1);
                bytes.extend_from_slice(&payload_len.to_le_bytes());
                bytes.extend_from_slice(payload);
            }
            None => bytes.push(0),
        }
        let path_count = u32::try_from(entry.path.len())
            .map_err(|_| EnvelopeError::CodecError("write batch path too large".to_string()))?;
        bytes.extend_from_slice(&path_count.to_le_bytes());
        for segment in &entry.path {
            append_multihash(
                &mut bytes,
                segment.as_multihash(),
                "write batch path segment too large",
            )?;
        }
    }
    let expected_current_entries = entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| entry.expected_current.as_ref().map(|value| (index, value)))
        .collect::<Vec<_>>();
    let has_expected_current_entries = !expected_current_entries.is_empty();
    if has_expected_current_entries {
        let expected_current_count =
            u32::try_from(expected_current_entries.len()).map_err(|_| {
                EnvelopeError::CodecError(
                    "write batch expected current value list too large".to_string(),
                )
            })?;
        bytes.extend_from_slice(&expected_current_count.to_le_bytes());
        for (index, expected_current) in expected_current_entries {
            let index = u32::try_from(index).map_err(|_| {
                EnvelopeError::CodecError(
                    "write batch expected current value index too large".to_string(),
                )
            })?;
            bytes.extend_from_slice(&index.to_le_bytes());
            match &expected_current.payload_hash {
                Some(hash) => {
                    bytes.push(1);
                    append_multihash(
                        &mut bytes,
                        hash.as_multihash(),
                        "write batch expected current value hash too large",
                    )?;
                }
                None => bytes.push(0),
            }
        }
    }
    if !preconditions.is_empty() {
        if !has_expected_current_entries {
            bytes.extend_from_slice(&0u32.to_le_bytes());
        }
        let precondition_count = u32::try_from(preconditions.len()).map_err(|_| {
            EnvelopeError::CodecError("write batch precondition list too large".to_string())
        })?;
        bytes.extend_from_slice(&precondition_count.to_le_bytes());
        for precondition in preconditions {
            append_multihash(
                &mut bytes,
                precondition.partition.as_multihash(),
                "write batch precondition partition too large",
            )?;
            append_multihash(
                &mut bytes,
                precondition.address.as_multihash(),
                "write batch precondition address too large",
            )?;
            match &precondition.expected_current.payload_hash {
                Some(hash) => {
                    bytes.push(1);
                    append_multihash(
                        &mut bytes,
                        hash.as_multihash(),
                        "write batch precondition current value hash too large",
                    )?;
                }
                None => bytes.push(0),
            }
        }
    }
    Ok(bytes)
}

/// Decode a write batch encoded by [`encode_write_batch`].
pub fn decode_write_batch(bytes: &[u8]) -> Result<Vec<WriteEntry>, EnvelopeError> {
    let batch = decode_atomic_write_batch(bytes)?;
    if !batch.preconditions.is_empty() {
        return Err(EnvelopeError::CodecError(
            "write batch contains preconditions; decode it as an atomic write batch".to_string(),
        ));
    }
    Ok(batch.writes)
}

/// Decode a batch encoded by [`encode_write_batch_with_preconditions`].
pub fn decode_atomic_write_batch(bytes: &[u8]) -> Result<AtomicWriteBatch, EnvelopeError> {
    fn read_u32(bytes: &[u8], cursor: &mut usize, label: &str) -> Result<u32, EnvelopeError> {
        if bytes.len() < *cursor + 4 {
            return Err(EnvelopeError::CodecError(format!(
                "write batch truncated in {label}"
            )));
        }
        let value = u32::from_le_bytes(bytes[*cursor..*cursor + 4].try_into().unwrap());
        *cursor += 4;
        Ok(value)
    }

    fn read_slice<'a>(
        bytes: &'a [u8],
        cursor: &mut usize,
        len: usize,
        label: &str,
    ) -> Result<&'a [u8], EnvelopeError> {
        if bytes.len() < *cursor + len {
            return Err(EnvelopeError::CodecError(format!(
                "write batch truncated in {label}"
            )));
        }
        let slice = &bytes[*cursor..*cursor + len];
        *cursor += len;
        Ok(slice)
    }

    let mut cursor = 0usize;
    let entry_count = read_u32(bytes, &mut cursor, "entry count")? as usize;
    let mut entries = Vec::with_capacity(entry_count);
    for _ in 0..entry_count {
        let partition_len = read_u32(bytes, &mut cursor, "partition_len")? as usize;
        let partition_bytes = read_slice(bytes, &mut cursor, partition_len, "partition")?;
        let partition_mh = content_crypto::Multihash::decode(partition_bytes).map_err(|e| {
            EnvelopeError::CodecError(format!("write batch partition decode failed: {e}"))
        })?;
        let address_len = read_u32(bytes, &mut cursor, "address_len")? as usize;
        let address_bytes = read_slice(bytes, &mut cursor, address_len, "address")?;
        let address_mh = content_crypto::Multihash::decode(address_bytes).map_err(|e| {
            EnvelopeError::CodecError(format!("write batch address decode failed: {e}"))
        })?;
        let payload_present = *read_slice(bytes, &mut cursor, 1, "payload_present")?
            .first()
            .unwrap();
        let payload = if payload_present == 0 {
            None
        } else {
            let payload_len = read_u32(bytes, &mut cursor, "payload_len")? as usize;
            Some(read_slice(bytes, &mut cursor, payload_len, "payload")?.to_vec())
        };
        let path_count = read_u32(bytes, &mut cursor, "path_count")? as usize;
        let mut path = Vec::with_capacity(path_count);
        for _ in 0..path_count {
            let segment_len = read_u32(bytes, &mut cursor, "segment_len")? as usize;
            let segment_bytes = read_slice(bytes, &mut cursor, segment_len, "segment")?;
            let segment_mh = content_crypto::Multihash::decode(segment_bytes).map_err(|e| {
                EnvelopeError::CodecError(format!("write batch segment decode failed: {e}"))
            })?;
            path.push(PathSegment::from_multihash(segment_mh));
        }
        entries.push(WriteEntry {
            partition: PartitionKey::from_multihash(partition_mh),
            address: FactAddress::from_multihash(address_mh),
            payload,
            path,
            expected_current: None,
        });
    }
    if cursor < bytes.len() {
        let expected_current_count =
            read_u32(bytes, &mut cursor, "expected_current_count")? as usize;
        for _ in 0..expected_current_count {
            let entry_index =
                read_u32(bytes, &mut cursor, "expected_current_entry_index")? as usize;
            let entry = entries.get_mut(entry_index).ok_or_else(|| {
                EnvelopeError::CodecError(
                    "write batch expected current value index out of range".to_string(),
                )
            })?;
            if entry.expected_current.is_some() {
                return Err(EnvelopeError::CodecError(
                    "write batch duplicate expected current value index".to_string(),
                ));
            }
            let hash_present = *read_slice(
                bytes,
                &mut cursor,
                1,
                "expected_current_payload_hash_present",
            )?
            .first()
            .unwrap();
            let payload_hash = match hash_present {
                0 => None,
                1 => {
                    let hash_len =
                        read_u32(bytes, &mut cursor, "expected_current_payload_hash_len")? as usize;
                    let hash_bytes = read_slice(
                        bytes,
                        &mut cursor,
                        hash_len,
                        "expected_current_payload_hash",
                    )?;
                    let hash_mh = content_crypto::Multihash::decode(hash_bytes).map_err(|e| {
                        EnvelopeError::CodecError(format!(
                            "write batch expected current value hash decode failed: {e}"
                        ))
                    })?;
                    Some(Hash::from_multihash(hash_mh))
                }
                _ => {
                    return Err(EnvelopeError::CodecError(
                        "write batch expected current value hash marker must be 0 or 1".to_string(),
                    ));
                }
            };
            entry.expected_current = Some(ExpectedCurrentValue { payload_hash });
        }
    }
    let mut preconditions = Vec::new();
    if cursor < bytes.len() {
        let precondition_count = read_u32(bytes, &mut cursor, "precondition_count")? as usize;
        preconditions.reserve(precondition_count);
        for _ in 0..precondition_count {
            let partition_len =
                read_u32(bytes, &mut cursor, "precondition_partition_len")? as usize;
            let partition_bytes =
                read_slice(bytes, &mut cursor, partition_len, "precondition_partition")?;
            let partition =
                content_crypto::Multihash::decode(partition_bytes).map_err(|error| {
                    EnvelopeError::CodecError(format!(
                        "write batch precondition partition decode failed: {error}"
                    ))
                })?;
            let address_len = read_u32(bytes, &mut cursor, "precondition_address_len")? as usize;
            let address_bytes =
                read_slice(bytes, &mut cursor, address_len, "precondition_address")?;
            let address = content_crypto::Multihash::decode(address_bytes).map_err(|error| {
                EnvelopeError::CodecError(format!(
                    "write batch precondition address decode failed: {error}"
                ))
            })?;
            let hash_present = *read_slice(
                bytes,
                &mut cursor,
                1,
                "precondition_current_value_hash_present",
            )?
            .first()
            .unwrap();
            let payload_hash = match hash_present {
                0 => None,
                1 => {
                    let hash_len =
                        read_u32(bytes, &mut cursor, "precondition_current_value_hash_len")?
                            as usize;
                    let hash_bytes = read_slice(
                        bytes,
                        &mut cursor,
                        hash_len,
                        "precondition_current_value_hash",
                    )?;
                    let hash = content_crypto::Multihash::decode(hash_bytes).map_err(|error| {
                        EnvelopeError::CodecError(format!(
                            "write batch precondition current value hash decode failed: {error}"
                        ))
                    })?;
                    Some(Hash::from_multihash(hash))
                }
                _ => {
                    return Err(EnvelopeError::CodecError(
                        "write batch precondition current value hash marker must be 0 or 1"
                            .to_string(),
                    ));
                }
            };
            preconditions.push(WritePrecondition {
                partition: PartitionKey::from_multihash(partition),
                address: FactAddress::from_multihash(address),
                expected_current: ExpectedCurrentValue { payload_hash },
            });
        }
    }
    if cursor != bytes.len() {
        return Err(EnvelopeError::CodecError(
            "write batch had trailing bytes".to_string(),
        ));
    }
    Ok(AtomicWriteBatch {
        writes: entries,
        preconditions,
    })
}

/// Result of a batch query — one response per envelope + accumulated writes.
///
/// DispatchSlot dispatches all accumulated writes after the batch completes.
#[derive(Debug, Clone)]
pub struct QueryBatchResult {
    /// One response per input envelope, in order.
    pub responses: Vec<Arc<[u8]>>,
    /// Accumulated writes from all queries in the batch.
    pub writes: Vec<WriteEntry>,
}

impl QueryBatchResult {
    /// Create a read-only batch result with no writes.
    pub fn read_only(responses: Vec<Arc<[u8]>>) -> Self {
        Self {
            responses,
            writes: Vec::new(),
        }
    }
}

// ============================================================================
// QueryHandler — the extension point for slot-specific query logic
// ============================================================================

/// Trait for native handler query implementations.
///
/// When a DispatchSlot receives a `query()` call, it delegates to its
/// QueryHandler if one was provided at construction. This separates the
/// generic dispatch mechanism (DispatchSlot) from domain-specific query
/// logic (the handler).
///
/// # Mutation-Aware Returns (L063)
///
/// `query()` returns `QueryResult` which carries both response bytes and
/// optional `WriteEntry` items. DispatchSlot automatically dispatches the
/// writes through `dispatch_rewrite` — making it structurally impossible
/// for a handler to mutate without the Envelope engine broadcasting the change.
///
/// # Invariants
///
/// 1. QueryHandler is Send + Sync — shared across threads via Arc
/// 2. Query results are opaque bytes — no type coupling across slot boundaries
/// 3. The handler does ALL translation (L098) — callers receive finished results
/// 4. Writes returned in QueryResult are dispatched by DispatchSlot, not the handler
pub trait QueryHandler: Send + Sync {
    /// Operation descriptors this handler exposes behind its carrier target.
    ///
    /// Empty means the target is directly invokable but has no nested engine
    /// operation catalog.
    fn engine_operation_descriptors(&self) -> Vec<EngineOperationDescriptor> {
        Vec::new()
    }

    /// Execute a query against this handler's domain.
    ///
    /// The Envelope's address routes to the correct query type.
    /// The payload contains self-describing query parameters (L090).
    /// Response bytes are opaque — the caller deserializes in its own domain.
    ///
    /// Mutating handlers include `WriteEntry` items in the result. DispatchSlot
    /// dispatches these automatically — the handler never calls dispatch_rewrite.
    #[allow(clippy::type_complexity)]
    fn query(
        &self,
        envelope: Envelope,
    ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>>;

    /// Execute multiple queries against this handler's domain.
    ///
    /// The default implementation processes queries sequentially, calling `query()`
    /// for each envelope in order. Writes are accumulated across all queries.
    /// Handlers can override this for batch optimization.
    #[allow(clippy::type_complexity)]
    fn query_batch(
        &self,
        envelopes: Vec<Envelope>,
    ) -> Pin<Box<dyn Future<Output = Result<QueryBatchResult, EnvelopeError>> + Send + '_>> {
        Box::pin(async move {
            tracing::debug!(
                "[slot-protocol] handler query_batch fallback: processing {} queries sequentially",
                envelopes.len()
            );
            let mut responses = Vec::with_capacity(envelopes.len());
            let mut writes = Vec::new();
            for envelope in envelopes {
                let result = self.query(envelope).await?;
                responses.push(result.response);
                writes.extend(result.writes);
            }
            Ok(QueryBatchResult { responses, writes })
        })
    }
}

// ============================================================================
// Envelope plumbing primitives — eliminates boilerplate from every handler
// ============================================================================

/// Deserialize a typed request from an Envelope's payload bytes.
///
/// Every QueryHandler does: extract payload → deserialize → domain logic → serialize.
/// This eliminates the first two steps. The slot name is used for error messages.
pub fn deserialize_payload<T: serde::de::DeserializeOwned>(
    envelope: &Envelope,
    slot_name: &str,
) -> Result<T, EnvelopeError> {
    let payload = envelope.payload.as_ref().ok_or_else(|| {
        EnvelopeError::CodecError(format!("{} query requires a payload", slot_name))
    })?;
    serde_json::from_slice(payload).map_err(|e| {
        let excerpt = payload_error_excerpt(payload, e.column());
        EnvelopeError::CodecError(format!(
            "Failed to deserialize {} query: {}{}",
            slot_name, e, excerpt
        ))
    })
}

fn payload_error_excerpt(payload: &[u8], column: usize) -> String {
    if payload.is_empty() {
        return String::new();
    }

    // serde_json reports a 1-based column within the current line. Our query
    // payloads are emitted as single-line JSON, so this gives a useful local
    // byte window around the failure without dumping the full payload.
    let center = column
        .saturating_sub(1)
        .min(payload.len().saturating_sub(1));
    let start = center.saturating_sub(120);
    let end = (center + 120).min(payload.len());
    let snippet = String::from_utf8_lossy(&payload[start..end]).replace('\n', "\\n");
    format!(" | excerpt[{}..{}]={:?}", start, end, snippet)
}

/// Serialize a typed response to opaque bytes for Envelope return.
///
/// Eliminates the serialize → Arc<[u8]> boilerplate from every QueryHandler.
pub fn serialize_response<T: serde::Serialize>(
    response: &T,
    slot_name: &str,
) -> Result<Arc<[u8]>, EnvelopeError> {
    let bytes = serde_json::to_vec(response).map_err(|e| {
        EnvelopeError::CodecError(format!("Failed to serialize {} response: {}", slot_name, e))
    })?;
    Ok(Arc::from(bytes))
}

// ============================================================================
// HandlerTable — native handler lookup table (name → compiled handler)
// ============================================================================

/// Maps handler names to their compiled QueryHandler implementations.
///
/// This is the "native handler lookup table" from §40. At boot, each handler crate's
/// `register_handlers(ctx)` populates this table. When `subscribe_slot_state()`
/// creates a DispatchSlot from Envelope data, it looks up the handler name in this
/// table to wire the correct QueryHandler into the slot.
///
/// # Invariants
///
/// 1. Handler names are Society data (strings) — Physics code never matches on them
/// 2. The table is populated once at boot by handler crate register() calls
/// 3. Missing handler = slot works but query() returns NotSupported (graceful degradation)
/// 4. WASM handlers are NOT in this table — they're loaded dynamically at runtime
///
/// Resolves data-owned routes from current state, never a boot-time cache.
pub trait LiveHandlerResolver: Send + Sync {
    fn resolve(
        &self,
        partition: &PartitionKey,
        address: &FactAddress,
    ) -> Result<Option<Arc<dyn QueryHandler>>, EnvelopeError>;
}

pub struct HandlerTable {
    handlers: HashMap<String, Arc<dyn QueryHandler>>,
    live_resolver: Option<Arc<dyn LiveHandlerResolver>>,
    live_handler_names: Vec<String>,
}

impl Clone for HandlerTable {
    fn clone(&self) -> Self {
        Self {
            handlers: self.handlers.clone(),
            live_resolver: self.live_resolver.clone(),
            live_handler_names: self.live_handler_names.clone(),
        }
    }
}

#[cfg(test)]
mod live_handler_resolution_tests {
    use super::*;
    use std::sync::Mutex;

    struct EmptyHandler;
    impl QueryHandler for EmptyHandler {
        fn query(
            &self,
            _: Envelope,
        ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>> {
            Box::pin(async { Err(EnvelopeError::NotSupported) })
        }
    }
    #[derive(Default)]
    struct CurrentRoutes(Mutex<HashMap<FactAddress, Arc<dyn QueryHandler>>>);
    impl LiveHandlerResolver for CurrentRoutes {
        fn resolve(
            &self,
            _: &PartitionKey,
            address: &FactAddress,
        ) -> Result<Option<Arc<dyn QueryHandler>>, EnvelopeError> {
            Ok(self.0.lock().unwrap().get(address).cloned())
        }
    }
    #[test]
    fn cloned_table_observes_live_create_update_and_retract() {
        let routes = Arc::new(CurrentRoutes::default());
        let mut table = HandlerTable::new();
        table.set_live_resolver(routes.clone());
        let resident = table.clone();
        let partition = PartitionKey::hash_from("test");
        let address = FactAddress::hash_from("package.target");
        assert!(resident
            .resolve_current(&partition, &address)
            .unwrap()
            .is_none());
        let first: Arc<dyn QueryHandler> = Arc::new(EmptyHandler);
        routes
            .0
            .lock()
            .unwrap()
            .insert(address.clone(), first.clone());
        assert!(Arc::ptr_eq(
            &resident
                .resolve_current(&partition, &address)
                .unwrap()
                .unwrap(),
            &first
        ));
        let updated: Arc<dyn QueryHandler> = Arc::new(EmptyHandler);
        routes
            .0
            .lock()
            .unwrap()
            .insert(address.clone(), updated.clone());
        assert!(Arc::ptr_eq(
            &resident
                .resolve_current(&partition, &address)
                .unwrap()
                .unwrap(),
            &updated
        ));
        routes.0.lock().unwrap().remove(&address);
        assert!(resident
            .resolve_current(&partition, &address)
            .unwrap()
            .is_none());
    }
    #[test]
    fn native_handler_precedes_live_route_under_both_address_spellings() {
        let routes = Arc::new(CurrentRoutes::default());
        let native: Arc<dyn QueryHandler> = Arc::new(EmptyHandler);
        let mut table = HandlerTable::new();
        table.register("native.target", native.clone());
        table.set_live_resolver(routes.clone());
        for address in [
            FactAddress::hash_from("native.target"),
            crate::address_for_routable_name("native.target"),
        ] {
            routes
                .0
                .lock()
                .unwrap()
                .insert(address.clone(), Arc::new(EmptyHandler));
            assert!(Arc::ptr_eq(
                &table
                    .resolve_current(&PartitionKey::hash_from("test"), &address)
                    .unwrap()
                    .unwrap(),
                &native
            ));
        }
    }

    #[test]
    fn live_route_catalog_is_unique_visible_and_does_not_invoke_handlers() {
        let routes = Arc::new(CurrentRoutes::default());
        let mut table = HandlerTable::new();
        table
            .set_live_resolver_with_names(
                routes.clone(),
                vec!["package.b".into(), "package.a".into()],
            )
            .unwrap();
        assert!(table.handler_names().is_empty());
        let mut names = table.catalog_names();
        names.sort();
        assert_eq!(names, vec!["package.a", "package.b"]);
        assert!(routes.0.lock().unwrap().is_empty());

        let mut duplicate = HandlerTable::new();
        assert!(duplicate
            .set_live_resolver_with_names(
                Arc::new(CurrentRoutes::default()),
                vec!["same".into(), "same".into()],
            )
            .is_err());
        let mut conflict = HandlerTable::new();
        conflict.register("native", Arc::new(EmptyHandler));
        assert!(
            conflict
                .set_live_resolver_with_names(
                    Arc::new(CurrentRoutes::default()),
                    vec!["native".into()],
                )
                .is_err()
        );

        let mut reverse_conflict = HandlerTable::new();
        reverse_conflict
            .set_live_resolver_with_names(Arc::new(CurrentRoutes::default()), vec!["native".into()])
            .unwrap();
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            reverse_conflict.register("native", Arc::new(EmptyHandler));
        }))
        .is_err());
    }
}

/// Inventory entry for a native handler crate registrar.
///
/// Each native handler crate contributes one of these so the composition root
/// can bootstrap the HandlerTable without naming concrete handlers.
pub struct NativeHandlerRegistrar {
    pub register: fn(&mut EngineContext),
}

inventory::collect!(NativeHandlerRegistrar);

impl HandlerTable {
    /// Create an empty handler table.
    pub fn new() -> Self {
        Self {
            handlers: HashMap::new(),
            live_resolver: None,
            live_handler_names: Vec::new(),
        }
    }

    /// Register a native handler by name.
    ///
    /// Called by each handler crate's `register_handlers(ctx)` during boot.
    /// Each handler registers its name and QueryHandler implementation.
    pub fn register(&mut self, name: impl Into<String>, handler: Arc<dyn QueryHandler>) {
        let name = name.into();
        assert!(
            !self.live_handler_names.iter().any(|live| live == &name),
            "native handler route '{name}' conflicts with the live route catalog"
        );
        tracing::debug!(handler_name = %name, "registered native handler");
        let replaced = self.handlers.insert(name.clone(), handler);
        assert!(
            replaced.is_none(),
            "native handler route '{name}' is already registered"
        );
    }

    /// Look up a handler by name.
    ///
    /// Returns None if no native handler is registered for this name.
    /// This is not an error — WASM-loaded capabilities don't have native handlers.
    pub fn get(&self, name: &str) -> Option<Arc<dyn QueryHandler>> {
        self.handlers.get(name).cloned()
    }

    pub fn set_live_resolver(&mut self, resolver: Arc<dyn LiveHandlerResolver>) {
        self.set_live_resolver_with_names(resolver, Vec::new())
            .expect("empty live route catalog cannot conflict");
    }

    pub fn set_live_resolver_with_names(
        &mut self,
        resolver: Arc<dyn LiveHandlerResolver>,
        mut names: Vec<String>,
    ) -> Result<(), EnvelopeError> {
        assert!(
            self.live_resolver.is_none(),
            "live route resolver already registered"
        );
        names.sort();
        if names.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(EnvelopeError::Internal(
                "live route catalog has duplicate names".into(),
            ));
        }
        if let Some(name) = names.iter().find(|name| self.handlers.contains_key(*name)) {
            return Err(EnvelopeError::Internal(format!(
                "live route catalog conflicts with native handler {name}"
            )));
        }
        self.live_handler_names = names;
        self.live_resolver = Some(resolver);
        Ok(())
    }

    /// Native routes always win. Resolve data routes anew for every invocation.
    pub fn resolve_current(
        &self,
        partition: &PartitionKey,
        address: &FactAddress,
    ) -> Result<Option<Arc<dyn QueryHandler>>, EnvelopeError> {
        for (name, handler) in &self.handlers {
            if &FactAddress::hash_from(name) == address
                || &crate::address_for_routable_name(name) == address
            {
                return Ok(Some(Arc::clone(handler)));
            }
        }
        match &self.live_resolver {
            Some(resolver) => resolver.resolve(partition, address),
            None => Ok(None),
        }
    }

    /// Returns true when a native handler already owns this route name.
    pub fn contains(&self, name: &str) -> bool {
        self.handlers.contains_key(name)
    }

    /// List statically registered native handler names.
    ///
    /// This list defines static dispatch membership. Data-owned live routes must
    /// not appear here: callers use this list to decide whether to call `get`
    /// instead of the live resolver.
    pub fn handler_names(&self) -> Vec<&str> {
        self.handlers.keys().map(|s| s.as_str()).collect()
    }

    /// List every route advertised by the current runner without resolving or
    /// instantiating a live handler.
    pub fn catalog_names(&self) -> Vec<&str> {
        self.handlers
            .keys()
            .map(String::as_str)
            .chain(self.live_handler_names.iter().map(String::as_str))
            .collect()
    }

    /// List registered handler names with any nested engine-operation descriptors.
    pub fn handler_operation_descriptors(&self) -> Vec<(String, Vec<EngineOperationDescriptor>)> {
        let mut descriptors: Vec<_> = self
            .handlers
            .iter()
            .map(|(name, handler)| (name.clone(), handler.engine_operation_descriptors()))
            .collect();
        descriptors.sort_by(|a, b| a.0.cmp(&b.0));
        descriptors
    }

    /// Number of registered handlers.
    pub fn len(&self) -> usize {
        self.handlers.len()
    }

    /// Whether the table is empty.
    pub fn is_empty(&self) -> bool {
        self.handlers.is_empty()
    }
}

impl Default for HandlerTable {
    fn default() -> Self {
        Self::new()
    }
}

/// Run every native handler registrar linked into the binary.
///
/// The composition root stays blind: it constructs an EngineContext and calls
/// this one function. Each independent handler crate owns its own registration.
pub fn register_all_handlers(ctx: &mut EngineContext) {
    for registrar in inventory::iter::<NativeHandlerRegistrar> {
        (registrar.register)(ctx);
    }
}

impl std::fmt::Debug for HandlerTable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HandlerTable")
            .field("handler_count", &self.handlers.len())
            .field("handler_names", &self.handler_names())
            .finish()
    }
}

// ============================================================================
// EngineContext — what handler registration functions receive
// ============================================================================

/// Context provided to handler crate `register()` functions during boot.
///
/// This is the "engine" object from §40's pseudocode:
/// ```ignore
/// let mut ctx = EngineContext::new(handle, registry);
/// alpha::register_handlers(&mut ctx);      // handler crate self-registers
/// beta::register_handlers(&mut ctx);       // handler crate self-registers
/// let (handle, registry, table) = ctx.into_parts();
/// subscribe_slot_state(handle, registry, table); // reactive boot + runtime
/// ```
///
/// # Invariants
///
/// 1. The handle provides read/write access to Envelope state
/// 2. The registry manages slot name → Arc<dyn Slot> resolution
/// 3. The handler table maps handler names → native QueryHandler implementations
/// 4. EngineContext is NOT cloneable — passed by reference to register() functions
pub struct EngineContext {
    /// Dispatch handle for reading/writing Envelope state.
    handle: Arc<dyn DispatchHandle>,

    /// Content-addressed blob reader for native handlers that need immutable bytes.
    cas_reader: Arc<dyn CasReader>,

    /// Immutable content writer for native handlers that need durable blobs
    /// without mutating Envelope state.
    cas_blob_writer: Arc<dyn CasBlobWriter>,

    /// Slot registry for registering/resolving slots.
    registry: Arc<SlotRegistry>,

    /// Native handler lookup table — populated by handler crate register() calls.
    handler_table: HandlerTable,
}

/// Engine-owned parts after native handler registration is sealed.
pub type EngineContextParts = (
    Arc<dyn DispatchHandle>,
    Arc<dyn CasReader>,
    Arc<dyn CasBlobWriter>,
    Arc<SlotRegistry>,
    HandlerTable,
);

impl EngineContext {
    /// Create a new engine context.
    pub fn new(
        handle: Arc<dyn DispatchHandle>,
        cas_reader: Arc<dyn CasReader>,
        cas_blob_writer: Arc<dyn CasBlobWriter>,
        registry: Arc<SlotRegistry>,
    ) -> Self {
        Self {
            handle,
            cas_reader,
            cas_blob_writer,
            registry,
            handler_table: HandlerTable::new(),
        }
    }

    /// Get the dispatch handle.
    pub fn handle(&self) -> &Arc<dyn DispatchHandle> {
        &self.handle
    }

    /// Get the slot registry.
    pub fn registry(&self) -> &Arc<SlotRegistry> {
        &self.registry
    }

    /// Get the content-addressed blob reader.
    pub fn cas_reader(&self) -> &Arc<dyn CasReader> {
        &self.cas_reader
    }

    /// Get the durable immutable content writer.
    pub fn cas_blob_writer(&self) -> &Arc<dyn CasBlobWriter> {
        &self.cas_blob_writer
    }

    /// Get a mutable reference to the handler table.
    ///
    /// Used by handler crate `register()` functions to add their handlers.
    pub fn handler_table_mut(&mut self) -> &mut HandlerTable {
        &mut self.handler_table
    }

    /// Get an immutable reference to the handler table.
    pub fn handler_table(&self) -> &HandlerTable {
        &self.handler_table
    }

    /// Consume the context and return its parts.
    ///
    /// Called after all handlers are registered, before starting the reactive
    /// slot subscription. The handler table is consumed because it becomes
    /// immutable after boot (native handlers don't change at runtime).
    pub fn into_parts(self) -> EngineContextParts {
        (
            self.handle,
            self.cas_reader,
            self.cas_blob_writer,
            self.registry,
            self.handler_table,
        )
    }
}

impl std::fmt::Debug for EngineContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EngineContext")
            .field("handler_table", &self.handler_table)
            .finish()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cas_blob_writer::CasBlobWriter;
    use crate::cas_reader::CasReader;
    use crate::{EngineOperationDescriptor, FactAddress, Hash, PartitionKey, PathSegment};
    use content_crypto::Multihash;
    use bytes::Bytes;

    /// Mock QueryHandler for testing.
    struct MockQueryHandler {
        response: Vec<u8>,
    }

    impl MockQueryHandler {
        fn new(response: &[u8]) -> Self {
            Self {
                response: response.to_vec(),
            }
        }
    }

    impl QueryHandler for MockQueryHandler {
        fn query(
            &self,
            _envelope: Envelope,
        ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>> {
            let data: Arc<[u8]> = self.response.clone().into();
            Box::pin(async move { Ok(QueryResult::read_only(data)) })
        }
    }

    struct DescriptorQueryHandler {
        descriptors: Vec<EngineOperationDescriptor>,
    }

    impl QueryHandler for DescriptorQueryHandler {
        fn engine_operation_descriptors(&self) -> Vec<EngineOperationDescriptor> {
            self.descriptors.clone()
        }

        fn query(
            &self,
            _envelope: Envelope,
        ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>> {
            Box::pin(async {
                Ok(QueryResult::read_only(Arc::from(
                    Vec::<u8>::new().into_boxed_slice(),
                )))
            })
        }
    }

    /// Mock DispatchHandle for testing.
    struct MockHandle;

    struct MockCasReader;

    struct MockCasBlobWriter;

    impl DispatchHandle for MockHandle {
        fn dispatch_rewrite(
            &self,
            _partition: PartitionKey,
            target: FactAddress,
            _payload: Option<Vec<u8>>,
            _path: Vec<PathSegment>,
        ) -> Pin<Box<dyn Future<Output = Result<Hash, EnvelopeError>> + Send + '_>> {
            let receipt = Hash::from_multihash(target.as_multihash().clone());
            Box::pin(async move { Ok(receipt) })
        }

        fn read_envelope(
            &self,
            _partition: PartitionKey,
            _address: FactAddress,
        ) -> Pin<Box<dyn Future<Output = Result<Option<Envelope>, EnvelopeError>> + Send + '_>>
        {
            Box::pin(async move { Ok(None) })
        }

        fn visit_direct_read(
            &self,
            _partition: &PartitionKey,
            _address: &FactAddress,
            _visitor: &mut dyn crate::dispatch_handle::DirectReadVisitor,
        ) -> Result<bool, EnvelopeError> {
            Ok(false)
        }

        fn list_live_state(
            &self,
            _partition: PartitionKey,
        ) -> Pin<
            Box<dyn Future<Output = Result<Vec<crate::LiveStateEntry>, EnvelopeError>> + Send + '_>,
        > {
            Box::pin(async move { Ok(vec![]) })
        }

        fn visit_live_state(
            &self,
            _partition: &PartitionKey,
            _selector: &crate::EnvelopeSelector,
            _visitor: &mut dyn crate::dispatch_handle::DirectReadVisitor,
        ) -> Result<(), EnvelopeError> {
            Ok(())
        }

        fn scan_live_state(
            &self,
            _partition: &PartitionKey,
            _selector: &crate::EnvelopeSelector,
            _cursor: u64,
            _content: crate::SubscriptionContentMode,
            _visitor: &mut dyn crate::LiveStateScanVisitor,
        ) -> Result<Option<u64>, EnvelopeError> {
            Ok(None)
        }

        fn subscribe_cursor(
            &self,
            _p: PartitionKey,
            _cb: Arc<dyn Fn(crate::dispatch_handle::LogCursor) + Send + Sync>,
        ) -> Pin<Box<dyn Future<Output = Result<(), EnvelopeError>> + Send + '_>> {
            Box::pin(async { Ok(()) })
        }
        fn current_root(
            &self,
            _p: PartitionKey,
        ) -> Pin<Box<dyn Future<Output = Result<Multihash, EnvelopeError>> + Send + '_>> {
            Box::pin(async { Ok(Multihash::blake3(b"stub-root")) })
        }
        fn root_diff(
            &self,
            _p: PartitionKey,
            have_root: Option<Multihash>,
        ) -> Pin<Box<dyn Future<Output = Result<crate::RootDiff, EnvelopeError>> + Send + '_>>
        {
            Box::pin(async move {
                Ok(crate::RootDiff {
                    have_root,
                    root: Multihash::blake3(b"stub-root"),
                    nodes: Vec::new(),
                    payloads: Vec::new(),
                    kept_roots: Vec::new(),
                })
            })
        }
        fn sync_mesh(
            &self,
            _p: PartitionKey,
            _from_peer: Option<Vec<u8>>,
            diff: crate::RootDiff,
        ) -> Pin<Box<dyn Future<Output = Result<Multihash, EnvelopeError>> + Send + '_>> {
            Box::pin(async move { Ok(diff.root) })
        }
        fn current_cursor(
            &self,
            _p: PartitionKey,
        ) -> Pin<
            Box<
                dyn Future<Output = Result<crate::dispatch_handle::LogCursor, EnvelopeError>>
                    + Send
                    + '_,
            >,
        > {
            Box::pin(async { Ok(crate::dispatch_handle::LogCursor::ZERO) })
        }

        fn clone_handle(&self) -> Arc<dyn DispatchHandle> {
            Arc::new(MockHandle)
        }
    }

    impl CasReader for MockCasReader {
        fn read_cas<'a>(
            &'a self,
            _hash: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, EnvelopeError>> + Send + 'a>> {
            Box::pin(async { Err(EnvelopeError::AddressNotFound) })
        }
    }

    impl CasBlobWriter for MockCasBlobWriter {
        fn put_cas<'a>(
            &'a self,
            content: Vec<u8>,
        ) -> Pin<Box<dyn Future<Output = Result<Hash, EnvelopeError>> + Send + 'a>> {
            Box::pin(async move { Ok(Hash::blake3_hash(&content)) })
        }
    }

    #[test]
    fn handler_table_register_and_lookup() {
        let mut table = HandlerTable::new();
        assert!(table.is_empty());

        let handler = Arc::new(MockQueryHandler::new(b"test")) as Arc<dyn QueryHandler>;
        table.register("alpha-handler", handler);

        assert_eq!(table.len(), 1);
        assert!(!table.is_empty());
        assert!(table.get("alpha-handler").is_some());
        assert!(table.get("nonexistent").is_none());
    }

    #[test]
    fn handler_table_multiple_handlers() {
        let mut table = HandlerTable::new();
        table.register("alpha-handler", Arc::new(MockQueryHandler::new(b"alpha")));
        table.register("beta-handler", Arc::new(MockQueryHandler::new(b"beta")));
        table.register("gamma-handler", Arc::new(MockQueryHandler::new(b"gamma")));

        assert_eq!(table.len(), 3);
        let names = table.handler_names();
        assert!(names.contains(&"alpha-handler"));
        assert!(names.contains(&"beta-handler"));
        assert!(names.contains(&"gamma-handler"));
    }

    #[test]
    fn handler_table_exposes_nested_operation_descriptors() {
        let operation = FactAddress::hash_from("engine.operation.echo");
        let mut table = HandlerTable::new();
        table.register(
            "engine.operation",
            Arc::new(DescriptorQueryHandler {
                descriptors: vec![EngineOperationDescriptor {
                    operation: operation.clone(),
                }],
            }),
        );

        let descriptors = table.handler_operation_descriptors();

        assert_eq!(descriptors.len(), 1);
        assert_eq!(descriptors[0].0, "engine.operation");
        assert_eq!(
            descriptors[0].1,
            vec![EngineOperationDescriptor { operation }]
        );
    }

    #[test]
    #[should_panic(expected = "native handler route 'test' is already registered")]
    fn handler_table_rejects_duplicate_route_names() {
        let mut table = HandlerTable::new();
        table.register("test", Arc::new(MockQueryHandler::new(b"v1")));
        table.register("test", Arc::new(MockQueryHandler::new(b"v2")));
    }

    #[tokio::test]
    async fn query_handler_returns_data() {
        let handler = MockQueryHandler::new(b"response_data");
        let env = Envelope::minimal(
            PartitionKey::from_digest(0x1F, vec![1u8; 32]),
            FactAddress::from_digest(0x1F, vec![2u8; 32]),
            None,
        );
        let result = handler.query(env).await;
        assert!(result.is_ok());
        let qr = result.unwrap();
        assert_eq!(qr.response.as_ref(), b"response_data");
        assert!(qr.writes.is_empty());
    }

    #[test]
    fn write_batch_round_trips_expected_current_values() {
        let current_hash = Hash::blake3_hash(b"old value");
        let entries = vec![
            WriteEntry {
                partition: PartitionKey::hash_from("neutral-partition"),
                address: FactAddress::hash_from("neutral-address-one"),
                payload: Some(b"new value".to_vec()),
                path: vec![PathSegment::hash_from("changed")],
                expected_current: Some(ExpectedCurrentValue {
                    payload_hash: Some(current_hash.clone()),
                }),
            },
            WriteEntry {
                partition: PartitionKey::hash_from("neutral-partition"),
                address: FactAddress::hash_from("neutral-address-two"),
                payload: Some(b"created value".to_vec()),
                path: Vec::new(),
                expected_current: Some(ExpectedCurrentValue { payload_hash: None }),
            },
        ];

        let encoded = encode_write_batch(&entries).unwrap();
        let decoded = decode_write_batch(&encoded).unwrap();

        assert_eq!(decoded.len(), 2);
        assert_eq!(
            decoded[0]
                .expected_current
                .as_ref()
                .and_then(|value| value.payload_hash.as_ref()),
            Some(&current_hash)
        );
        assert_eq!(
            decoded[1]
                .expected_current
                .as_ref()
                .map(|value| value.payload_hash.as_ref()),
            Some(None)
        );
    }

    #[test]
    fn atomic_write_batch_round_trips_precondition_only_assertions() {
        let partition = PartitionKey::hash_from("neutral-partition");
        let guarded_address = FactAddress::hash_from("neutral-source");
        let guarded_hash = Hash::blake3_hash(b"source revision one");
        let writes = vec![WriteEntry {
            partition: partition.clone(),
            address: FactAddress::hash_from("neutral-projection"),
            payload: Some(b"projection".to_vec()),
            path: Vec::new(),
            expected_current: None,
        }];
        let preconditions = vec![WritePrecondition {
            partition: partition.clone(),
            address: guarded_address.clone(),
            expected_current: ExpectedCurrentValue {
                payload_hash: Some(guarded_hash.clone()),
            },
        }];

        let encoded = encode_write_batch_with_preconditions(&writes, &preconditions).unwrap();
        let decoded = decode_atomic_write_batch(&encoded).unwrap();

        assert_eq!(decoded.writes.len(), 1);
        assert_eq!(decoded.preconditions.len(), 1);
        assert_eq!(decoded.preconditions[0].partition, partition);
        assert_eq!(decoded.preconditions[0].address, guarded_address);
        assert_eq!(
            decoded.preconditions[0].expected_current.payload_hash,
            Some(guarded_hash)
        );
        assert!(matches!(
            decode_write_batch(&encoded),
            Err(EnvelopeError::CodecError(message))
                if message.contains("contains preconditions")
        ));
    }

    #[test]
    fn engine_context_creation() {
        let handle = Arc::new(MockHandle) as Arc<dyn DispatchHandle>;
        let cas_reader = Arc::new(MockCasReader) as Arc<dyn CasReader>;
        let cas_blob_writer = Arc::new(MockCasBlobWriter) as Arc<dyn CasBlobWriter>;
        let registry = Arc::new(SlotRegistry::new());
        let ctx = EngineContext::new(handle, cas_reader, cas_blob_writer, registry);

        assert!(ctx.handler_table().is_empty());
    }

    #[test]
    fn engine_context_register_handlers() {
        let handle = Arc::new(MockHandle) as Arc<dyn DispatchHandle>;
        let cas_reader = Arc::new(MockCasReader) as Arc<dyn CasReader>;
        let cas_blob_writer = Arc::new(MockCasBlobWriter) as Arc<dyn CasBlobWriter>;
        let registry = Arc::new(SlotRegistry::new());
        let mut ctx = EngineContext::new(handle, cas_reader, cas_blob_writer, registry);

        ctx.handler_table_mut()
            .register("alpha-handler", Arc::new(MockQueryHandler::new(b"alpha")));

        assert_eq!(ctx.handler_table().len(), 1);
    }

    #[test]
    fn engine_context_into_parts() {
        let handle = Arc::new(MockHandle) as Arc<dyn DispatchHandle>;
        let cas_reader = Arc::new(MockCasReader) as Arc<dyn CasReader>;
        let cas_blob_writer = Arc::new(MockCasBlobWriter) as Arc<dyn CasBlobWriter>;
        let registry = Arc::new(SlotRegistry::new());
        let mut ctx =
            EngineContext::new(handle, cas_reader, cas_blob_writer, Arc::clone(&registry));

        ctx.handler_table_mut()
            .register("test", Arc::new(MockQueryHandler::new(b"data")));

        let (_, _, _, reg, table) = ctx.into_parts();
        assert_eq!(Arc::strong_count(&reg), 2); // our ref + the one from into_parts
        assert_eq!(table.len(), 1);
    }

    #[test]
    fn handler_table_debug() {
        let mut table = HandlerTable::new();
        table.register("alpha-handler", Arc::new(MockQueryHandler::new(b"test")));
        let debug = format!("{:?}", table);
        assert!(debug.contains("handler_count"));
        assert!(debug.contains("alpha-handler"));
    }

    #[tokio::test]
    async fn query_handler_batch_empty_returns_empty_vec() {
        let handler = MockQueryHandler::new(b"response_data");
        let result = handler.query_batch(vec![]).await;
        assert!(result.is_ok());
        let qbr = result.unwrap();
        assert_eq!(qbr.responses.len(), 0);
        assert!(qbr.writes.is_empty());
    }

    #[tokio::test]
    async fn query_handler_batch_processes_multiple_queries() {
        let handler = MockQueryHandler::new(b"batch_response");
        let env1 = Envelope::minimal(
            PartitionKey::from_digest(0x1F, vec![1u8; 32]),
            FactAddress::from_digest(0x1F, vec![2u8; 32]),
            Some(Bytes::from("query1")),
        );
        let env2 = Envelope::minimal(
            PartitionKey::from_digest(0x1F, vec![1u8; 32]),
            FactAddress::from_digest(0x1F, vec![3u8; 32]),
            Some(Bytes::from("query2")),
        );
        let result = handler.query_batch(vec![env1, env2]).await;
        assert!(result.is_ok());
        let qbr = result.unwrap();
        assert_eq!(qbr.responses.len(), 2);
        assert_eq!(qbr.responses[0].as_ref(), b"batch_response");
        assert_eq!(qbr.responses[1].as_ref(), b"batch_response");
        assert!(qbr.writes.is_empty());
    }
}
