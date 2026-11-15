use std::sync::Arc;

pub fn read_reply_bytes_from_other_slots(bytes: Vec<u8>) -> Arc<[u8]> {
    Arc::from(bytes.into_boxed_slice())
}
