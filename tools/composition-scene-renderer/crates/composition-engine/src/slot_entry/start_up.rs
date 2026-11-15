// crates/composition-engine/src/slot_entry/start_up.rs
//
// Initializes the SharedBufferProtocol buffers and the default scene state.

use composition_engine_core::kernel::types::{NodeKind, SceneNode, Size};

use crate::slot_entry::{write_reply_bytes, BUF_CAP, CMD_BUFFER, INPUT_BUFFER, OUTPUT_BUFFER};
use crate::slot_work::scene_state;

pub(crate) fn start_up() {
    unsafe {
        let _ = super::__init_buffers(
            core::ptr::addr_of_mut!(INPUT_BUFFER) as *mut u8 as i32,
            BUF_CAP as i32,
            core::ptr::addr_of_mut!(OUTPUT_BUFFER) as *mut u8 as i32,
            BUF_CAP as i32,
            core::ptr::addr_of_mut!(CMD_BUFFER) as *mut u8 as i32,
            BUF_CAP as i32,
        );
    }

    let root = SceneNode::new("root", NodeKind::Container);
    let viewport = Size {
        w: 1920.0,
        h: 1080.0,
    };
    scene_state::initialize_if_needed(root, viewport);

    // Boot reply renders the anonymous session's (empty) scene.
    if let Some(bytes) = scene_state::render_snapshot_bytes(scene_state::ANONYMOUS_SESSION) {
        let _ = write_reply_bytes::write_reply_bytes(&bytes);
    }
}
