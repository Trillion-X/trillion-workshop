// crates/composition-engine/src/slot_entry/do_work_when_asked.rs
//
// Handles a request sent to the composition-engine slot: the decision is
// slot_work::answer_request (shared with the page entry); this file only moves
// the bytes across the SharedBufferProtocol boundary.

use crate::slot_entry::{read_incoming_bytes, write_reply_bytes};
use crate::slot_work::answer_request::answer_request;

pub(crate) fn do_work_when_asked(input_len: i32) -> i32 {
    let payload = read_incoming_bytes::read_incoming_bytes(input_len);

    match answer_request(payload) {
        Ok(Some(bytes)) => write_reply_bytes::write_reply_bytes(&bytes),
        Ok(None) => 0,
        Err(reason) => {
            eprintln!("[composition-engine] handle_query: {}", reason);
            -1
        }
    }
}
