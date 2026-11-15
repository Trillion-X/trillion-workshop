// <checkout>/crates/shared-slot-batches/src/lib.rs
//
// PURPOSE: Blind slot/batch boundary — the canonical four-operation primitive.
//
// NON-NEGOTIABLE INVARIANTS:
// - Zero dependencies on background-runner, between-program-batches, or any transport crate.
// - Zero strings on the hot path. Slot ids, generations, and correlation ids are u32/u64.
// - The stone performs no contract-owned binding. No semantic interpretation of payloads.
// - Adding a new slot = data. Zero code changes to this crate.
//
// OPERATIONS:
// - PLUG_SLOTS: local realizer plugs resolved callable ids into the stone's slot table.
// - INVOKE_BATCH: hot-path batch invocation using pre-plugged slot ids.
// - COMPLETE_BATCH: hot-path result batch for previously invoked entries.
// - CLEAR_SLOTS: invalidate stale slot plugs after environment change or teardown.

pub mod same_program_slots;
pub mod slot_lifecycle;
pub mod slot_plugs;
pub mod slot_requests;

pub type SlotId = u32;
pub type SlotGeneration = u32;
pub type PlugCallId = u64;
pub type CorrelationId = u32;
pub type PolicyWord = u64;
pub type ResourceWord = u64;
pub type AuditLaneId = u32;
pub type PrivateCallableId = u32;
pub type PrivateContextId = u32;

/// Cold-side permission row for a plugged callable thing.
///
/// Plain English: before the hot invoke lane starts, a resolved plug writes
/// exactly what it is allowed to call and which policy/resource/audit words
/// apply. The hot lane then carries only `plug_call_id` plus byte spans.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PlugCallPermissionRow {
    pub plug_call_id: PlugCallId,
    pub generation: SlotGeneration,
    pub policy_word: PolicyWord,
    pub resource_word: ResourceWord,
    pub audit_lane_id: AuditLaneId,
    pub revocation_epoch: u32,
    pub private_callable_id: PrivateCallableId,
    pub private_context_id: PrivateContextId,
    pub flags: u32,
}

/// Hot-path invocation record — fixed-width, no strings, no semantic fields.
/// The caller provides opaque payload bytes at `payload_offset..payload_offset+payload_len`
/// in a separate byte arena. The stone routes by `slot_id` only.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvokeBatchRecord {
    pub slot_id: SlotId,
    pub generation: SlotGeneration,
    pub payload_offset: u32,
    pub payload_len: u32,
    pub correlation_id: CorrelationId,
    pub flags: u32,
}

/// Hot-path completion record — returned for each invocation in the batch.
/// `status_code` 0 = success. Non-zero = error (see `error_code` for detail).
/// Result bytes live at `result_offset..result_offset+result_len` in the output arena.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompleteBatchRecord {
    pub correlation_id: CorrelationId,
    pub status_code: u32,
    pub result_offset: u32,
    pub result_len: u32,
    pub error_code: u32,
}

/// Status codes for completion records.
pub mod status {
    pub const OK: u32 = 0;
    pub const SLOT_NOT_PLUGGED: u32 = 1;
    pub const GENERATION_MISMATCH: u32 = 2;
    pub const INVOCATION_FAILED: u32 = 3;
}

/// Flags for invocation records.
pub mod invoke_record_flags {
    /// The caller intentionally does not expect a completion record.
    pub const NO_REPLY: u32 = 1 << 0;
    /// The native HTTP carrier admitted this invocation against the current
    /// local command-list basis. Only the carrier writes this flag; the runner
    /// translates it into non-payload Envelope context for the selected route.
    pub const LOCAL_COMMAND_LIST_ADMITTED: u32 = 1 << 1;
}

/// The stone's execution interface. Implementors provide the actual slot table
/// and dispatch logic. `shared-slot-batches` owns the shapes; the implementor
/// owns the execution.
pub trait EngineHandle: Send + Sync {
    fn install_slot_plugs(&self, plugs: &slot_plugs::SlotPlugBatch) -> Result<()>;
    fn enqueue_invocations(&self, batch: &[InvokeBatchRecord], payload_bytes: &[u8]) -> Result<()>;
    fn drain_completions(&self) -> Result<Vec<CompleteBatchRecord>>;
    fn clear_slot_plugs(&self, request: &slot_lifecycle::ClearSlotsRequest) -> Result<()>;
}

/// Crate-level error type.
#[derive(Debug)]
pub enum Error {
    SlotNotPlugged(SlotId),
    GenerationMismatch {
        slot_id: SlotId,
        expected: SlotGeneration,
        actual: SlotGeneration,
    },
    InvocationFailed {
        correlation_id: CorrelationId,
        detail: String,
    },
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::SlotNotPlugged(id) => write!(f, "slot {} is not plugged", id),
            Error::GenerationMismatch {
                slot_id,
                expected,
                actual,
            } => write!(
                f,
                "slot {} generation mismatch: expected {}, got {}",
                slot_id, expected, actual
            ),
            Error::InvocationFailed {
                correlation_id,
                detail,
            } => write!(f, "invocation {} failed: {}", correlation_id, detail),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

/// In-memory slot table — the stone's entire mutable state.
///
/// Slot ids are already numeric and resolved before this hot lane, so the table
/// is direct-indexed instead of hash-indexed.
pub struct SlotTable {
    slots: Vec<Option<SlotEntry>>,
}

#[derive(Clone, Copy)]
struct SlotEntry {
    generation: SlotGeneration,
    plug_call_id: PlugCallId,
    #[allow(dead_code)]
    flags: u32,
}

impl SlotTable {
    pub fn new() -> Self {
        Self { slots: Vec::new() }
    }

    pub fn plug(&mut self, plug: &slot_plugs::SlotPlug) {
        let index = plug.slot_id as usize;
        if self.slots.len() <= index {
            self.slots.resize_with(index + 1, || None);
        }
        self.slots[index] = Some(SlotEntry {
            generation: plug.generation,
            plug_call_id: plug.plug_call_id,
            flags: plug.flags,
        });
    }

    pub fn lookup(
        &self,
        slot_id: SlotId,
        generation: SlotGeneration,
    ) -> std::result::Result<PlugCallId, Error> {
        match self.slots.get(slot_id as usize).and_then(|entry| *entry) {
            None => Err(Error::SlotNotPlugged(slot_id)),
            Some(entry) if entry.generation != generation => Err(Error::GenerationMismatch {
                slot_id,
                expected: entry.generation,
                actual: generation,
            }),
            Some(entry) => Ok(entry.plug_call_id),
        }
    }

    pub fn clear(&mut self, slot_id: SlotId) -> bool {
        match self.slots.get_mut(slot_id as usize) {
            Some(entry) => entry.take().is_some(),
            None => false,
        }
    }

    pub fn clear_all(&mut self) -> u32 {
        let count = self.slots.iter().filter(|entry| entry.is_some()).count() as u32;
        self.slots.fill(None);
        count
    }
}

impl Default for SlotTable {
    fn default() -> Self {
        Self::new()
    }
}
