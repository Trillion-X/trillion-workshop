// crates/composition-engine/src/slot_entry/read_incoming_bytes.rs
//
// Reads request bytes from the SharedBufferProtocol input buffer.

use crate::slot_entry::{BUF_CAP, INPUT_BUFFER};

pub(crate) fn read_incoming_bytes(input_len: i32) -> &'static [u8] {
    let read_len = (input_len as usize).min(BUF_CAP);
    unsafe { core::slice::from_raw_parts(core::ptr::addr_of!(INPUT_BUFFER) as *const u8, read_len) }
}
