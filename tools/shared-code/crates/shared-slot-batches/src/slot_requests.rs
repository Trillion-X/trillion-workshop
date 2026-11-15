// crates/shared-slot-batches/src/slot_requests.rs
//
// PURPOSE: Guest-side slot declaration shapes. The guest declares what it needs;
// the local realizer maps local reality to those needs before PLUG_SLOTS.

use crate::SlotId;

/// A single guest slot request — "I need a slot with this id and this shape."
/// `shape_id` is a 16-byte identifier (e.g. UUID) that the guest and realizer
/// agree on. The stone never interprets it.
pub struct GuestSlotRequest {
    pub slot_id: SlotId,
    pub shape_id: [u8; 16],
    pub flags: u32,
}

/// A batch of guest slot requests submitted together.
pub struct GuestSlotBatch {
    pub requests: Vec<GuestSlotRequest>,
}
