pub mod make_request_bytes_for_other_slots;
pub mod read_reply_bytes_from_other_slots;
pub mod send_request_bytes_to_other_slots;

use std::sync::Arc;

use slot_protocol::PartitionKey;

pub async fn dispatch_to_other_slot(
    target_address: &str,
    partition_key: &PartitionKey,
    payload: Option<&[u8]>,
) -> Result<Arc<[u8]>, String> {
    let request_bytes = make_request_bytes_for_other_slots::make_request_bytes_for_other_slots(
        target_address,
        partition_key,
        payload,
    )?;
    let reply_bytes =
        send_request_bytes_to_other_slots::send_request_bytes_to_other_slots(request_bytes).await?;
    Ok(read_reply_bytes_from_other_slots::read_reply_bytes_from_other_slots(reply_bytes))
}
