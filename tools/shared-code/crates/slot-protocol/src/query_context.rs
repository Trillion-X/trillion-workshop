//! Generic query-context framing for slot query dispatch.
//!
//! `Envelope.context` carries opaque bytes to the receiving slot. The dispatch
//! path has two independent byte owners:
//!
//! - slot-owned query config, attached by the configured `DispatchSlot`
//! - caller-owned context, attached by the caller/edge/request path
//!
//! When both exist, this module frames them without interpreting either payload.

use bytes::Bytes;
use serde::{Deserialize, Serialize};

const QUERY_CONTEXT_FRAME_KIND: &str = "slot-protocol.query-context-frame";
const QUERY_CONTEXT_FRAME_VERSION: u32 = 1;

/// Opaque directive marking a fired transform as a source RETRACT rather than
/// an assert. Assert vs retract is Physics (the `Delta` type has `asserts` and
/// `retracts`; `Envelope` payload `None` is a retraction) — this carries that
/// existing distinction across the edge-driver → transform boundary so a
/// stateful transform can maintain its derived value incrementally (remove the
/// retracted row) instead of full-rescanning. It names no package and no kind.
pub const SOURCE_DELTA_OP_RETRACT_DIRECTIVE: &[u8] = b"slot-protocol.source-delta-op:retract";

/// Opaque directive marking delivery-stream invalidation. A consumer that
/// receives this directive must discard incremental assumptions and rebuild
/// from authoritative current state. This is the transform-side counterpart
/// of `DeltaGap`; delivery loss is therefore recoverable instead of silent.
pub const SOURCE_DELTA_OP_RECONCILE_DIRECTIVE: &[u8] = b"slot-protocol.source-delta-op:reconcile";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct QueryContextFrame {
    kind: String,
    version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    slot_context: Option<Vec<u8>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    caller_context: Option<Vec<u8>>,
    /// Opaque, caller-owned out-of-band directive (e.g. retract marker). Rides
    /// alongside `caller_context` in the same byte lane without colliding with
    /// it. `None` for every legacy/assert path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    caller_directive: Option<Vec<u8>>,
}

impl QueryContextFrame {
    fn encode(&self) -> Bytes {
        let mut bytes = Vec::new();
        ciborium::into_writer(self, &mut bytes)
            .expect("query context frame serialization should not fail");
        Bytes::from(bytes)
    }

    /// Decode `bytes` as a query-context frame ONLY if it is one (right kind +
    /// version). Raw slot/caller bytes (JSON, opaque request bodies) never match.
    fn try_decode(bytes: &[u8]) -> Option<Self> {
        let frame = ciborium::from_reader::<QueryContextFrame, _>(bytes).ok()?;
        if frame.kind == QUERY_CONTEXT_FRAME_KIND && frame.version == QUERY_CONTEXT_FRAME_VERSION {
            Some(frame)
        } else {
            None
        }
    }
}

/// Split query context into slot-owned config bytes and caller-owned context
/// bytes. Unframed bytes are treated as slot-owned context to preserve the
/// existing DispatchSlot query-config contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryContextParts {
    pub slot_context: Option<Bytes>,
    pub caller_context: Option<Bytes>,
    /// Opaque out-of-band caller directive (e.g. a source-retract marker).
    /// `None` for every legacy/assert path.
    pub caller_directive: Option<Bytes>,
}

/// Frame a caller-owned context together with an opaque out-of-band directive
/// into the single `Envelope.context` byte lane, BEFORE any slot-config combine.
///
/// The edge driver uses this to signal a source retract to a stateful transform:
/// the transform still receives its full `caller_context`, plus a directive it
/// can act on (remove the retracted row). A later `combine_query_context` call
/// (performed by the DispatchSlot with the slot's own config) merges the slot
/// config INTO this frame rather than nesting it, so the directive survives to
/// the handler. See `combine_query_context`.
pub fn frame_caller_directive(caller_context: Bytes, directive: Bytes) -> Bytes {
    QueryContextFrame {
        kind: QUERY_CONTEXT_FRAME_KIND.to_string(),
        version: QUERY_CONTEXT_FRAME_VERSION,
        slot_context: None,
        caller_context: Some(caller_context.to_vec()),
        caller_directive: Some(directive.to_vec()),
    }
    .encode()
}

/// Combine slot-owned query config and caller-owned context into the single
/// `Envelope.context` byte lane.
///
/// Slot-only config is passed through unchanged to preserve the existing query
/// config contract. Any caller context is framed, even when no slot config is
/// present, because otherwise the receiver could not distinguish caller bytes
/// from legacy slot config bytes.
pub fn combine_query_context(
    slot_context: Option<Bytes>,
    caller_context: Option<Bytes>,
) -> Option<Bytes> {
    match (slot_context, caller_context) {
        (None, None) => None,
        (Some(bytes), None) => Some(bytes),
        (slot_context, Some(caller_context)) => {
            // If the caller bytes are already a query-context frame (the edge
            // driver pre-framed a caller_directive — e.g. a retract marker),
            // thread the slot config INTO that frame instead of nesting a frame
            // inside a frame. Nesting would make the handler's single split
            // surface the inner frame bytes as caller_context and drop the
            // directive. This branch is dormant for every legacy path: raw
            // JSON / opaque request bodies never decode as a valid frame.
            if let Some(mut existing) = QueryContextFrame::try_decode(&caller_context) {
                if let Some(slot_context) = slot_context {
                    existing.slot_context = Some(slot_context.to_vec());
                }
                return Some(existing.encode());
            }
            Some(
                QueryContextFrame {
                    kind: QUERY_CONTEXT_FRAME_KIND.to_string(),
                    version: QUERY_CONTEXT_FRAME_VERSION,
                    slot_context: slot_context.map(|bytes| bytes.to_vec()),
                    caller_context: Some(caller_context.to_vec()),
                    caller_directive: None,
                }
                .encode(),
            )
        }
    }
}

/// Decode a query-context frame produced by `combine_query_context`.
///
/// Unframed bytes are slot-owned query context for backwards-compatible Physics:
/// callers cannot accidentally masquerade as slot config; caller context is
/// always framed by `combine_query_context`.
pub fn split_query_context(context: Option<&[u8]>) -> QueryContextParts {
    let Some(context) = context else {
        return QueryContextParts {
            slot_context: None,
            caller_context: None,
            caller_directive: None,
        };
    };

    if let Some(frame) = QueryContextFrame::try_decode(context) {
        return QueryContextParts {
            slot_context: frame.slot_context.map(Bytes::from),
            caller_context: frame.caller_context.map(Bytes::from),
            caller_directive: frame.caller_directive.map(Bytes::from),
        };
    }

    QueryContextParts {
        slot_context: Some(Bytes::copy_from_slice(context)),
        caller_context: None,
        caller_directive: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_absent_context() {
        let combined = combine_query_context(None, None);
        assert!(combined.is_none());
        assert_eq!(
            split_query_context(None),
            QueryContextParts {
                slot_context: None,
                caller_context: None,
                caller_directive: None,
            }
        );
    }

    #[test]
    fn leaves_slot_only_context_unframed() {
        let slot = Bytes::from_static(b"slot-config");
        let combined = combine_query_context(Some(slot.clone()), None).unwrap();
        assert_eq!(combined, slot);
        assert_eq!(
            split_query_context(Some(&combined)),
            QueryContextParts {
                slot_context: Some(slot),
                caller_context: None,
                caller_directive: None,
            }
        );
    }

    #[test]
    fn frames_caller_only_context() {
        let caller = Bytes::from_static(br#"{"grant":"opaque"}"#);
        let combined = combine_query_context(None, Some(caller.clone())).unwrap();
        assert_ne!(combined, caller);
        assert_eq!(
            split_query_context(Some(&combined)),
            QueryContextParts {
                slot_context: None,
                caller_context: Some(caller),
                caller_directive: None,
            }
        );
    }

    #[test]
    fn frames_slot_and_caller_context_without_interpreting_either() {
        let slot = Bytes::from_static(br#"{"config":true}"#);
        let caller = Bytes::from_static(br#"{"grant":"opaque"}"#);
        let combined = combine_query_context(Some(slot.clone()), Some(caller.clone())).unwrap();
        assert_ne!(combined, slot);
        assert_ne!(combined, caller);
        assert_eq!(
            split_query_context(Some(&combined)),
            QueryContextParts {
                slot_context: Some(slot),
                caller_context: Some(caller),
                caller_directive: None,
            }
        );
    }

    #[test]
    fn caller_directive_survives_the_dispatch_slot_combine() {
        // The edge driver pre-frames the caller context with a retract
        // directive; the DispatchSlot later combines its (absent) slot config.
        // The merge-aware combine must NOT nest, so the handler's single split
        // still recovers both caller_context and the directive.
        let caller = Bytes::from_static(br#"{"schema":"matching_records_transform_context"}"#);
        let directive = Bytes::from_static(SOURCE_DELTA_OP_RETRACT_DIRECTIVE);
        let pre_framed = frame_caller_directive(caller.clone(), directive.clone());

        // DispatchSlot with no query_context (matching-records case).
        let combined = combine_query_context(None, Some(pre_framed.clone())).unwrap();
        assert_eq!(
            split_query_context(Some(&combined)),
            QueryContextParts {
                slot_context: None,
                caller_context: Some(caller.clone()),
                caller_directive: Some(directive.clone()),
            }
        );

        // DispatchSlot WITH a query_context threads slot config in without
        // clobbering the pre-framed caller_context or directive.
        let slot = Bytes::from_static(br#"{"config":true}"#);
        let combined_with_slot =
            combine_query_context(Some(slot.clone()), Some(pre_framed)).unwrap();
        assert_eq!(
            split_query_context(Some(&combined_with_slot)),
            QueryContextParts {
                slot_context: Some(slot),
                caller_context: Some(caller),
                caller_directive: Some(directive),
            }
        );
    }
}
