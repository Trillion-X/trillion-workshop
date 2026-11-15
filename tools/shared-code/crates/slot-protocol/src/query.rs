// crates/slot-protocol/src/query.rs
//
//! # Opaque read helpers
//!
//! Slot protocol owns the universal read doorway: envelope request bytes,
//! response bytes, write batches, and current live-state frames. It does not
//! define a resolved-record query language.
//!
//! ## Boundary rule
//!
//! Data owners own their request/reply schemas inside their package or slot.
//! Readers either understand that owner-owned schema or use data-defined
//! extraction over opaque reply bytes. Adding a new data owner must not require
//! adding structs or match arms to this crate.
//!
use serde::{Deserialize, Serialize};

use crate::{EnvelopeError, FactAddress, PathSegment, SubscriptionContentMode};

// ---------------------------------------------------------------------------
// Direct state reads
// ---------------------------------------------------------------------------

/// Canonical protocol address for asking the runtime for current live-state bytes.
pub const LIVE_STATE_ADDRESS: &str = "runtime::live_state";

/// Reply shape for a direct engine-state read over the talk-to-other-slots boundary.
///
/// This is the generic Physics reply for "give me the current bytes at this
/// live address." The engine is the SSOT for `content_hash`, so callers must
/// consume the engine-supplied hash instead of recomputing or importing one
/// from outside the live-state boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DirectReadReply {
    /// Canonical multihash identity of the currently live payload bytes.
    pub content_hash: String,
    /// Raw payload bytes currently live at the address.
    pub payload: Vec<u8>,
}

/// One live-state entry returned by a generic current-state scan.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiveStateEntryReply {
    /// Canonical multihash wire bytes for the address.
    pub address: Vec<u8>,
    /// Canonical multihash identity of the currently live payload bytes.
    pub content_hash: String,
    /// Durable path metadata carried with the live entry.
    pub path: Vec<Vec<u8>>,
    /// Raw payload bytes currently live at the address, when requested.
    ///
    /// `None` is the payload-free current-state pointer shape: address +
    /// content hash + path. The omitted bytes remain available through the
    /// direct-read boundary by address.
    pub payload: Option<Vec<u8>>,
}

/// Reply shape for a full live-state snapshot over the talk-to-other-slots boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ListLiveStateReply {
    /// Every currently-live `(address, content_hash, payload)` entry.
    pub entries: Vec<LiveStateEntryReply>,
    /// Opaque cursor for continuing a bounded current-state scan.
    ///
    /// `Some(cursor)` means more engine scan space may remain. `None` means the
    /// scan reached the end for this request's selector.
    #[serde(default)]
    pub next_cursor: Option<u64>,
}

/// One extracted-field equality hint for a live-state scan.
///
/// `field_path` names a nested field inside the entry's payload bytes (opaque
/// segments — the protocol carries no vocabulary). `value_json` is the
/// JSON-canonical encoding of the value to match (e.g. `"draft"` including
/// quotes for a string). The engine treats both as opaque bytes: extraction
/// and comparison are generic byte operations, never named concepts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiveStateFieldEq {
    pub field_path: Vec<String>,
    pub value_json: Vec<u8>,
}

/// Request shape for a filtered current-state read over the talk-to-other-slots boundary.
///
/// Empty `addresses` and empty `path_prefix` mean "match all". Non-empty fields
/// combine by intersection: the reply contains entries whose address is listed
/// and whose durable path starts with the requested prefix. `cursor`, `offset`,
/// and `limit` page the matched stream so consumers can keep memory bounded
/// without inventing a second live-state transport. `content` chooses whether
/// matching entries inline payload bytes or return payload-free pointers.
///
/// `field_eq` is a SELECTIVITY HINT, not a correctness contract: the reply is
/// guaranteed to contain every entry matching all hints, but an implementation
/// without a covering index MAY return non-matching entries too. Consumers
/// must keep evaluating their own predicates over the reply (they already do —
/// the hint only shrinks the stream, never widens semantics).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ListLiveStateRequest {
    #[serde(default)]
    pub addresses: Vec<FactAddress>,
    #[serde(default)]
    pub path_prefix: Vec<PathSegment>,
    /// Opaque engine scan cursor returned by the previous reply.
    #[serde(default)]
    pub cursor: u64,
    /// Number of selector-matching entries to skip before collecting reply rows.
    #[serde(default)]
    pub offset: u64,
    /// Maximum number of selector-matching entries to return.
    #[serde(default)]
    pub limit: Option<u32>,
    /// Whether matching entries should include raw payload bytes.
    #[serde(default)]
    pub content: SubscriptionContentMode,
    /// Extracted-field equality hints (see type docs — hint, not contract).
    #[serde(default)]
    pub field_eq: Vec<LiveStateFieldEq>,
}

/// Encode a filtered live-state request as compact CBOR.
pub fn encode_list_live_state_request(
    request: &ListLiveStateRequest,
) -> Result<Vec<u8>, EnvelopeError> {
    let mut bytes = Vec::new();
    ciborium::into_writer(request, &mut bytes)
        .map_err(|e| EnvelopeError::CodecError(format!("live state request encode failed: {e}")))?;
    Ok(bytes)
}

/// Decode a filtered live-state request from compact CBOR.
pub fn decode_list_live_state_request(bytes: &[u8]) -> Result<ListLiveStateRequest, EnvelopeError> {
    ciborium::from_reader(bytes)
        .map_err(|e| EnvelopeError::CodecError(format!("live state request decode failed: {e}")))
}

fn encode_direct_read_reply_bytes(
    content_hash_code_hex: &str,
    payload: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    let hash_bytes = content_hash_code_hex.as_bytes();
    let hash_len = u32::try_from(hash_bytes.len()).map_err(|_| {
        EnvelopeError::CodecError("direct read reply content_hash too large".to_string())
    })?;
    let payload_len = u32::try_from(payload.len()).map_err(|_| {
        EnvelopeError::CodecError("direct read reply payload too large".to_string())
    })?;
    let mut bytes = Vec::with_capacity(8 + hash_bytes.len() + payload.len());
    bytes.extend_from_slice(&hash_len.to_le_bytes());
    bytes.extend_from_slice(hash_bytes);
    bytes.extend_from_slice(&payload_len.to_le_bytes());
    bytes.extend_from_slice(payload);
    Ok(bytes)
}

/// Encode a direct-read reply using the canonical compact binary reply format.
///
/// Wire shape:
/// - `content_hash_len: u32 LE`
/// - `content_hash_utf8: [u8; content_hash_len]`
/// - `payload_len: u32 LE`
/// - `payload_bytes: [u8; payload_len]`
///
/// Direct reads can carry large opaque payload bytes (source files, blobs,
/// component entities). This fixed-width header preserves raw bytes directly
/// instead of serializing them as integer sequences.
pub fn encode_direct_read_reply(reply: &DirectReadReply) -> Result<Vec<u8>, EnvelopeError> {
    encode_direct_read_reply_bytes(&reply.content_hash, &reply.payload)
}

/// Encode a direct-read reply directly from borrowed engine-owned hash and payload.
///
/// This preserves the canonical wire format while deleting the intermediate
/// `DirectReadReply { String, Vec<u8> }` allocation on hot direct-read branches.
pub fn encode_direct_read_reply_parts(
    content_hash: &crate::Hash,
    payload: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    let content_hash_code_hex = content_hash.0.to_code_hex();
    encode_direct_read_reply_bytes(&content_hash_code_hex, payload)
}

/// Decode a direct-read reply from the canonical compact binary reply format.
pub fn decode_direct_read_reply(bytes: &[u8]) -> Result<DirectReadReply, EnvelopeError> {
    if bytes.len() < 8 {
        return Err(EnvelopeError::CodecError(
            "direct read reply too short for header".to_string(),
        ));
    }
    let hash_len = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
    let hash_end = 4 + hash_len;
    if bytes.len() < hash_end + 4 {
        return Err(EnvelopeError::CodecError(
            "direct read reply truncated in content_hash".to_string(),
        ));
    }
    let content_hash = std::str::from_utf8(&bytes[4..hash_end])
        .map_err(|e| {
            EnvelopeError::CodecError(format!("direct read reply content_hash utf8 failed: {e}"))
        })?
        .to_string();
    let payload_len =
        u32::from_le_bytes(bytes[hash_end..hash_end + 4].try_into().unwrap()) as usize;
    let payload_start = hash_end + 4;
    let payload_end = payload_start + payload_len;
    if bytes.len() < payload_end {
        return Err(EnvelopeError::CodecError(
            "direct read reply truncated in payload".to_string(),
        ));
    }
    Ok(DirectReadReply {
        content_hash,
        payload: bytes[payload_start..payload_end].to_vec(),
    })
}

/// Encode a full live-state reply using the canonical compact binary format.
///
/// Wire shape:
/// - `entry_count: u32 LE`
/// - `next_cursor_present: u8`
/// - `next_cursor: u64 LE` when present
/// - repeated entry frames:
///   - `address_len: u32 LE`
///   - `address_bytes`
///   - `content_hash_len: u32 LE`
///   - `content_hash_utf8`
///   - `path_segment_count: u32 LE`
///   - repeated path segment frames:
///     - `segment_len: u32 LE`
///     - `segment_bytes`
///   - `payload_present: u8`
///   - `payload_len: u32 LE` when present
///   - `payload_bytes` when present
pub fn encode_list_live_state_reply(reply: &ListLiveStateReply) -> Result<Vec<u8>, EnvelopeError> {
    let entry_count = u32::try_from(reply.entries.len())
        .map_err(|_| EnvelopeError::CodecError("live state reply too many entries".to_string()))?;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&entry_count.to_le_bytes());
    match reply.next_cursor {
        Some(cursor) => {
            bytes.push(1);
            bytes.extend_from_slice(&cursor.to_le_bytes());
        }
        None => bytes.push(0),
    }
    for entry in &reply.entries {
        let address_len = u32::try_from(entry.address.len()).map_err(|_| {
            EnvelopeError::CodecError("live state reply address too large".to_string())
        })?;
        let hash_bytes = entry.content_hash.as_bytes();
        let hash_len = u32::try_from(hash_bytes.len()).map_err(|_| {
            EnvelopeError::CodecError("live state reply content_hash too large".to_string())
        })?;
        let path_segment_count = u32::try_from(entry.path.len()).map_err(|_| {
            EnvelopeError::CodecError("live state reply too many path segments".to_string())
        })?;
        bytes.extend_from_slice(&address_len.to_le_bytes());
        bytes.extend_from_slice(&entry.address);
        bytes.extend_from_slice(&hash_len.to_le_bytes());
        bytes.extend_from_slice(hash_bytes);
        bytes.extend_from_slice(&path_segment_count.to_le_bytes());
        for segment in &entry.path {
            let segment_len = u32::try_from(segment.len()).map_err(|_| {
                EnvelopeError::CodecError("live state reply path segment too large".to_string())
            })?;
            bytes.extend_from_slice(&segment_len.to_le_bytes());
            bytes.extend_from_slice(segment);
        }
        match &entry.payload {
            Some(payload) => {
                let payload_len = u32::try_from(payload.len()).map_err(|_| {
                    EnvelopeError::CodecError("live state reply payload too large".to_string())
                })?;
                bytes.push(1);
                bytes.extend_from_slice(&payload_len.to_le_bytes());
                bytes.extend_from_slice(payload);
            }
            None => bytes.push(0),
        }
    }
    Ok(bytes)
}

/// Decode a full live-state reply from the canonical compact binary format.
pub fn decode_list_live_state_reply(bytes: &[u8]) -> Result<ListLiveStateReply, EnvelopeError> {
    if bytes.len() < 4 {
        return Err(EnvelopeError::CodecError(
            "live state reply too short for header".to_string(),
        ));
    }
    let entry_count = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
    let mut offset = 4;
    if bytes.len() < offset + 1 {
        return Err(EnvelopeError::CodecError(
            "live state reply truncated in next cursor flag".to_string(),
        ));
    }
    let next_cursor = match bytes[offset] {
        0 => {
            offset += 1;
            None
        }
        1 => {
            offset += 1;
            if bytes.len() < offset + 8 {
                return Err(EnvelopeError::CodecError(
                    "live state reply truncated in next cursor".to_string(),
                ));
            }
            let cursor = u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
            offset += 8;
            Some(cursor)
        }
        other => {
            return Err(EnvelopeError::CodecError(format!(
                "live state reply invalid next cursor flag {other}"
            )));
        }
    };
    let mut entries = Vec::with_capacity(entry_count);
    for _ in 0..entry_count {
        if bytes.len() < offset + 4 {
            return Err(EnvelopeError::CodecError(
                "live state reply truncated in address length".to_string(),
            ));
        }
        let address_len =
            u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;
        if bytes.len() < offset + address_len + 4 {
            return Err(EnvelopeError::CodecError(
                "live state reply truncated in address bytes".to_string(),
            ));
        }
        let address = bytes[offset..offset + address_len].to_vec();
        offset += address_len;

        let hash_len = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;
        if bytes.len() < offset + hash_len + 4 {
            return Err(EnvelopeError::CodecError(
                "live state reply truncated in content_hash bytes".to_string(),
            ));
        }
        let content_hash = std::str::from_utf8(&bytes[offset..offset + hash_len])
            .map_err(|e| {
                EnvelopeError::CodecError(format!("live state reply content_hash utf8 failed: {e}"))
            })?
            .to_string();
        offset += hash_len;

        if bytes.len() < offset + 4 {
            return Err(EnvelopeError::CodecError(
                "live state reply truncated in path segment count".to_string(),
            ));
        }
        let path_segment_count =
            u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;
        let mut path = Vec::with_capacity(path_segment_count);
        for _ in 0..path_segment_count {
            if bytes.len() < offset + 4 {
                return Err(EnvelopeError::CodecError(
                    "live state reply truncated in path segment length".to_string(),
                ));
            }
            let segment_len =
                u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
            offset += 4;
            if bytes.len() < offset + segment_len {
                return Err(EnvelopeError::CodecError(
                    "live state reply truncated in path segment bytes".to_string(),
                ));
            }
            path.push(bytes[offset..offset + segment_len].to_vec());
            offset += segment_len;
        }

        if bytes.len() < offset + 1 {
            return Err(EnvelopeError::CodecError(
                "live state reply truncated in payload flag".to_string(),
            ));
        }
        let payload = match bytes[offset] {
            0 => {
                offset += 1;
                None
            }
            1 => {
                offset += 1;
                if bytes.len() < offset + 4 {
                    return Err(EnvelopeError::CodecError(
                        "live state reply truncated in payload length".to_string(),
                    ));
                }
                let payload_len =
                    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
                offset += 4;
                if bytes.len() < offset + payload_len {
                    return Err(EnvelopeError::CodecError(
                        "live state reply truncated in payload bytes".to_string(),
                    ));
                }
                let payload = bytes[offset..offset + payload_len].to_vec();
                offset += payload_len;
                Some(payload)
            }
            other => {
                return Err(EnvelopeError::CodecError(format!(
                    "live state reply invalid payload flag {other}"
                )));
            }
        };

        entries.push(LiveStateEntryReply {
            address,
            content_hash,
            path,
            payload,
        });
    }
    Ok(ListLiveStateReply {
        entries,
        next_cursor,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;

    #[test]
    fn direct_read_reply_round_trips_large_raw_bytes_without_sequence_encoding() {
        let reply = DirectReadReply {
            content_hash: "test-content-hash-tool".into(),
            payload: (0..=255).cycle().take(16 * 1024).collect(),
        };
        let bytes = encode_direct_read_reply(&reply).expect("encode direct read reply");
        let back = decode_direct_read_reply(&bytes).expect("decode direct read reply");
        assert_eq!(back, reply);
    }

    #[test]
    fn direct_read_reply_parts_matches_struct_encoder() {
        let payload = Bytes::from_static(b"direct-bytes");
        let content_hash = crate::Hash::blake3_hash(&payload);
        let reply = DirectReadReply {
            content_hash: content_hash.0.to_code_hex(),
            payload: payload.to_vec(),
        };

        let via_struct = encode_direct_read_reply(&reply).expect("encode via struct");
        let via_parts =
            encode_direct_read_reply_parts(&content_hash, &payload).expect("encode via parts");

        assert_eq!(via_struct, via_parts);
        assert_eq!(
            decode_direct_read_reply(&via_parts).expect("decode via parts"),
            reply
        );
    }

    #[test]
    fn live_state_request_round_trips_generic_filters() {
        let request = ListLiveStateRequest {
            addresses: vec![FactAddress::hash_from("sample-address")],
            path_prefix: vec![
                PathSegment::hash_from("sample-prefix"),
                PathSegment::hash_from("sample-kind"),
            ],
            cursor: 3,
            offset: 7,
            limit: Some(31),
            content: SubscriptionContentMode::HashOnly,
            field_eq: vec![],
        };

        let bytes = encode_list_live_state_request(&request).expect("encode request");
        let decoded = decode_list_live_state_request(&bytes).expect("decode request");

        assert_eq!(decoded, request);
    }

    #[test]
    fn live_state_reply_round_trips_inline_and_hash_only_entries() {
        let reply = ListLiveStateReply {
            entries: vec![
                LiveStateEntryReply {
                    address: vec![1, 2, 3],
                    content_hash: "1f:aa".to_string(),
                    path: vec![vec![4], vec![5]],
                    payload: Some(b"payload".to_vec()),
                },
                LiveStateEntryReply {
                    address: vec![9],
                    content_hash: "1f:bb".to_string(),
                    path: vec![vec![8]],
                    payload: None,
                },
            ],
            next_cursor: Some(42),
        };

        let bytes = encode_list_live_state_reply(&reply).expect("encode reply");
        let decoded = decode_list_live_state_reply(&bytes).expect("decode reply");

        assert_eq!(decoded, reply);
    }
}
