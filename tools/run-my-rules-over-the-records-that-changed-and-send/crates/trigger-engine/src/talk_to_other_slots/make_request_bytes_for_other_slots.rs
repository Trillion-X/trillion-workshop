use slot_protocol::Envelope;

pub fn make_request_bytes_for_other_slots(
    envelope: &Envelope,
    delivery: slot_protocol::ReplyDelivery,
) -> Result<Vec<u8>, String> {
    slot_protocol::make_request_bytes_for_other_slots_with_reply_delivery(envelope, delivery)
        .map_err(|e| format!("trigger-engine: encode envelope: {e}"))
}
