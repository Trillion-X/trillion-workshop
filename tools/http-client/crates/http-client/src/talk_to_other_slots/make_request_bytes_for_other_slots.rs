use bytes::Bytes;
use slot_protocol::{Envelope, FactAddress, PartitionKey};

const IDENTITY_ADDR_CODE: u64 = 0x1F;

fn runtime_fact_address(target: &str) -> FactAddress {
    if target.contains('|') {
        FactAddress::from_digest(IDENTITY_ADDR_CODE, target.as_bytes().to_vec())
    } else {
        FactAddress::hash_from(target)
    }
}

pub fn make_request_bytes_for_other_slots(
    target_address: &str,
    partition_key: &PartitionKey,
    payload: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let envelope = Envelope::dispatch(
        partition_key.clone(),
        runtime_fact_address(target_address),
        payload.map(Bytes::copy_from_slice),
    );
    slot_protocol::make_request_bytes_for_other_slots(&envelope)
        .map_err(|e| format!("http-client talk_to_other_slots envelope encode failed: {e}"))
}
