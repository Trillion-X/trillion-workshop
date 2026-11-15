// crates/composition-engine/src/slot_entry/write_reply_bytes.rs
//
// Writes reply bytes to the SharedBufferProtocol output buffer.

use crate::slot_entry::{BUF_CAP, OUTPUT_BUFFER};

pub(crate) fn write_reply_bytes(reply_bytes: &[u8]) -> i32 {
    let write_len = reply_bytes.len().min(BUF_CAP);
    unsafe {
        core::ptr::copy_nonoverlapping(
            reply_bytes.as_ptr(),
            core::ptr::addr_of_mut!(OUTPUT_BUFFER) as *mut u8,
            write_len,
        );
        super::__notify_ready(0, write_len as i32);
    }
    write_len as i32
}
