/// Decode a direct-read reply into its engine-supplied content hash + payload.
///
/// The engine is the SSOT for `content_hash` (slot-protocol `DirectReadReply`
/// contract) — callers verify it against the delta assert's `content_hash` so a
/// racing subsequent write cannot silently substitute different bytes into rule
/// evaluation (delta-delivery-integrity Task B).
pub fn read_reply_from_other_slots(bytes: &[u8]) -> Result<slot_protocol::DirectReadReply, String> {
    slot_protocol::decode_direct_read_reply(bytes)
        .map_err(|e| format!("trigger-engine: direct-read reply decode failed: {e}"))
}

/// Payload-only accessor kept for callers that have no assert hash to verify
/// against (none on the delta path — every delta-path caller must use
/// `read_reply_from_other_slots` and hash-check).
pub fn read_reply_bytes_from_other_slots(bytes: &[u8]) -> Result<Vec<u8>, String> {
    Ok(read_reply_from_other_slots(bytes)?.payload)
}

#[cfg(test)]
mod tests {
    #[test]
    fn read_reply_bytes_from_other_slots_returns_payload_only() {
        let bytes = slot_protocol::encode_direct_read_reply(&slot_protocol::DirectReadReply {
            content_hash: "test-content-hash".into(),
            payload: br#"{"topic":"runtime_loaded"}"#.to_vec(),
        })
        .expect("encode direct read reply");

        let payload =
            super::read_reply_bytes_from_other_slots(&bytes).expect("decode direct read payload");
        assert_eq!(payload, br#"{"topic":"runtime_loaded"}"#);
    }

    #[test]
    fn read_reply_from_other_slots_returns_hash_and_payload() {
        let bytes = slot_protocol::encode_direct_read_reply(&slot_protocol::DirectReadReply {
            content_hash: "test-content-hash".into(),
            payload: br#"{"topic":"runtime_loaded"}"#.to_vec(),
        })
        .expect("encode direct read reply");

        let reply = super::read_reply_from_other_slots(&bytes).expect("decode direct read reply");
        assert_eq!(reply.content_hash, "test-content-hash");
        assert_eq!(reply.payload, br#"{"topic":"runtime_loaded"}"#);
    }
}
