// crates/shared-slot-batches/src/slot_lifecycle.rs
//
// PURPOSE: Lifecycle shapes for clearing stale slot plugs and requesting re-plug.
// CLEAR_SLOTS invalidates stale plugs after environment change or teardown.

use crate::SlotId;

/// Request to clear specific slots from the plug table.
/// After clearing, INVOKE_BATCH against these slot ids will produce
/// deterministic SLOT_NOT_PLUGGED failure records.
pub struct ClearSlotsRequest {
    pub slot_ids: Vec<SlotId>,
}

/// Result of a CLEAR_SLOTS operation.
pub struct ClearSlotsResult {
    /// Number of slots that were actually cleared (were present in the table).
    pub cleared: u32,
}

/// Request to re-plug slots after a CLEAR_SLOTS. This is semantically
/// identical to a fresh PLUG_SLOTS — the stone does not distinguish
/// initial plug from re-plug. Included for API clarity only.
pub struct ReplugSlotsRequest {
    pub plugs: crate::slot_plugs::SlotPlugBatch,
}
