// crates/shared-slot-batches/src/same_program_slots.rs
//
// PURPOSE: Same-program slot-plugging entry point. Sally calls this directly
// inside one Rust program — zero background-runner, zero transport, zero
// between-program carrier. This proves delivery neutrality: the four-operation
// primitive stands on its own before any delivery skin is added.
//
// If Sally packages this path as a dylib or framework, the packaging skin
// owns zero protocol truth — it is only a local wrapper around this code path.

use std::sync::Arc;

use crate::slot_lifecycle::ClearSlotsRequest;
use crate::slot_plugs::SlotPlugBatch;
use crate::{CompleteBatchRecord, InvokeBatchRecord};

/// Same-program boundary — direct in-process access to the blind slot/batch
/// primitive with zero network, zero serialization, zero carrier overhead.
pub struct SameProgramSlots {
    engine: Arc<dyn crate::EngineHandle>,
}

impl SameProgramSlots {
    pub fn new(engine: Arc<dyn crate::EngineHandle>) -> Self {
        Self { engine }
    }

    /// PLUG_SLOTS — install resolved plug call ids into the stone's slot table.
    pub fn plug_slots(&self, plugs: &SlotPlugBatch) -> crate::Result<()> {
        self.engine.install_slot_plugs(plugs)
    }

    /// INVOKE_BATCH — submit compact slot/batch records for execution.
    /// `payload_bytes` is the opaque byte arena referenced by each record's
    /// `payload_offset` and `payload_len`.
    pub fn invoke_batch(
        &self,
        batch: &[InvokeBatchRecord],
        payload_bytes: &[u8],
    ) -> crate::Result<()> {
        self.engine.enqueue_invocations(batch, payload_bytes)
    }

    /// COMPLETE_BATCH — drain completion records for previously invoked entries.
    pub fn complete_batch(&self) -> crate::Result<Vec<CompleteBatchRecord>> {
        self.engine.drain_completions()
    }

    /// CLEAR_SLOTS — invalidate stale slot plugs.
    pub fn clear_slots(&self, request: &ClearSlotsRequest) -> crate::Result<()> {
        self.engine.clear_slot_plugs(request)
    }
}
