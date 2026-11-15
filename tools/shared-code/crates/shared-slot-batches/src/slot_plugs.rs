// crates/shared-slot-batches/src/slot_plugs.rs
//
// PURPOSE: Local-realizer-side slot plug shapes. The realizer maps local reality
// to the guest's declared slot needs, producing plug values that the stone
// blindly consumes via PLUG_SLOTS.

use crate::{PlugCallId, SlotGeneration, SlotId};

/// A single resolved slot plug — "slot N is backed by plug call P at generation G."
/// The realizer produces these entirely outside the stone. The stone only consumes them.
#[derive(Debug, Clone, Copy)]
pub struct SlotPlug {
    pub slot_id: SlotId,
    pub generation: SlotGeneration,
    pub plug_call_id: PlugCallId,
    pub flags: u32,
}

/// A batch of resolved slot plugs submitted together via PLUG_SLOTS.
pub struct SlotPlugBatch {
    pub plugs: Vec<SlotPlug>,
}
