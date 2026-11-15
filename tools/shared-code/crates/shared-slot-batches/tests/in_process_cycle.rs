// crates/shared-slot-batches/tests/in_process_cycle.rs
//
// PURPOSE: Prove the full PLUG_SLOTS -> INVOKE_BATCH -> COMPLETE_BATCH cycle
// runs in-process with zero carrier, zero background-runner, zero transport.
// This is the delivery-neutrality proof required by §14.

use std::sync::{Arc, Mutex};

use shared_slot_batches::same_program_slots::SameProgramSlots;
use shared_slot_batches::slot_lifecycle::ClearSlotsRequest;
use shared_slot_batches::slot_plugs::{SlotPlug, SlotPlugBatch};
use shared_slot_batches::{
    status, CompleteBatchRecord, EngineHandle, Error, InvokeBatchRecord, Result, SlotTable,
};

/// Minimal in-process engine handle that uses a SlotTable and a simple
/// plugged-call dispatch (echo payload back as result).
struct InProcessEngine {
    table: Mutex<SlotTable>,
    completions: Mutex<Vec<CompleteBatchRecord>>,
    results: Mutex<Vec<u8>>,
}

impl InProcessEngine {
    fn new() -> Self {
        Self {
            table: Mutex::new(SlotTable::new()),
            completions: Mutex::new(Vec::new()),
            results: Mutex::new(Vec::new()),
        }
    }
}

impl EngineHandle for InProcessEngine {
    fn install_slot_plugs(&self, plugs: &SlotPlugBatch) -> Result<()> {
        let mut table = self.table.lock().unwrap();
        for plug in &plugs.plugs {
            table.plug(plug);
        }
        Ok(())
    }

    fn enqueue_invocations(&self, batch: &[InvokeBatchRecord], payload_bytes: &[u8]) -> Result<()> {
        let table = self.table.lock().unwrap();
        let mut completions = self.completions.lock().unwrap();
        let mut results = self.results.lock().unwrap();

        for record in batch {
            match table.lookup(record.slot_id, record.generation) {
                Ok(_plug_call_id) => {
                    // Echo the payload back as the result (simplest proof of dispatch).
                    let start = record.payload_offset as usize;
                    let end = start + record.payload_len as usize;
                    let payload = &payload_bytes[start..end];

                    let result_offset = results.len() as u32;
                    results.extend_from_slice(payload);

                    completions.push(CompleteBatchRecord {
                        correlation_id: record.correlation_id,
                        status_code: status::OK,
                        result_offset,
                        result_len: record.payload_len,
                        error_code: 0,
                    });
                }
                Err(Error::SlotNotPlugged(_)) => {
                    completions.push(CompleteBatchRecord {
                        correlation_id: record.correlation_id,
                        status_code: status::SLOT_NOT_PLUGGED,
                        result_offset: 0,
                        result_len: 0,
                        error_code: 0,
                    });
                }
                Err(Error::GenerationMismatch { .. }) => {
                    completions.push(CompleteBatchRecord {
                        correlation_id: record.correlation_id,
                        status_code: status::GENERATION_MISMATCH,
                        result_offset: 0,
                        result_len: 0,
                        error_code: 0,
                    });
                }
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    fn drain_completions(&self) -> Result<Vec<CompleteBatchRecord>> {
        let mut completions = self.completions.lock().unwrap();
        Ok(completions.drain(..).collect())
    }

    fn clear_slot_plugs(&self, request: &ClearSlotsRequest) -> Result<()> {
        let mut table = self.table.lock().unwrap();
        for &slot_id in &request.slot_ids {
            table.clear(slot_id);
        }
        Ok(())
    }
}

#[test]
fn in_process_plug_invoke_complete_cycle() {
    let engine = Arc::new(InProcessEngine::new());
    let stone = SameProgramSlots::new(engine);

    // PLUG_SLOTS: install one slot at id=1, generation=1, plug_call_id=42
    stone
        .plug_slots(&SlotPlugBatch {
            plugs: vec![SlotPlug {
                slot_id: 1,
                generation: 1,
                plug_call_id: 42,
                flags: 0,
            }],
        })
        .unwrap();

    // INVOKE_BATCH: invoke slot 1 with payload "hello"
    let payload = b"hello";
    stone
        .invoke_batch(
            &[InvokeBatchRecord {
                slot_id: 1,
                generation: 1,
                payload_offset: 0,
                payload_len: 5,
                correlation_id: 100,
                flags: 0,
            }],
            payload,
        )
        .unwrap();

    // COMPLETE_BATCH: drain completions
    let completions = stone.complete_batch().unwrap();
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0].correlation_id, 100);
    assert_eq!(completions[0].status_code, status::OK);
    assert_eq!(completions[0].result_len, 5);
}

#[test]
fn invoke_before_plug_produces_slot_not_plugged() {
    let engine = Arc::new(InProcessEngine::new());
    let stone = SameProgramSlots::new(engine);

    // INVOKE_BATCH without any PLUG_SLOTS — must produce SLOT_NOT_PLUGGED
    stone
        .invoke_batch(
            &[InvokeBatchRecord {
                slot_id: 99,
                generation: 1,
                payload_offset: 0,
                payload_len: 0,
                correlation_id: 200,
                flags: 0,
            }],
            &[],
        )
        .unwrap();

    let completions = stone.complete_batch().unwrap();
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0].status_code, status::SLOT_NOT_PLUGGED);
}

#[test]
fn stale_generation_produces_generation_mismatch() {
    let engine = Arc::new(InProcessEngine::new());
    let stone = SameProgramSlots::new(engine);

    // Plug at generation 2
    stone
        .plug_slots(&SlotPlugBatch {
            plugs: vec![SlotPlug {
                slot_id: 1,
                generation: 2,
                plug_call_id: 42,
                flags: 0,
            }],
        })
        .unwrap();

    // Invoke with stale generation 1
    stone
        .invoke_batch(
            &[InvokeBatchRecord {
                slot_id: 1,
                generation: 1,
                payload_offset: 0,
                payload_len: 0,
                correlation_id: 300,
                flags: 0,
            }],
            &[],
        )
        .unwrap();

    let completions = stone.complete_batch().unwrap();
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0].status_code, status::GENERATION_MISMATCH);
}

#[test]
fn clear_then_invoke_produces_slot_not_plugged() {
    let engine = Arc::new(InProcessEngine::new());
    let stone = SameProgramSlots::new(engine);

    // Plug, then clear, then invoke — must produce SLOT_NOT_PLUGGED
    stone
        .plug_slots(&SlotPlugBatch {
            plugs: vec![SlotPlug {
                slot_id: 1,
                generation: 1,
                plug_call_id: 42,
                flags: 0,
            }],
        })
        .unwrap();

    stone
        .clear_slots(&ClearSlotsRequest { slot_ids: vec![1] })
        .unwrap();

    stone
        .invoke_batch(
            &[InvokeBatchRecord {
                slot_id: 1,
                generation: 1,
                payload_offset: 0,
                payload_len: 0,
                correlation_id: 400,
                flags: 0,
            }],
            &[],
        )
        .unwrap();

    let completions = stone.complete_batch().unwrap();
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0].status_code, status::SLOT_NOT_PLUGGED);
}

#[test]
fn replug_after_clear_produces_new_live_generation() {
    let engine = Arc::new(InProcessEngine::new());
    let stone = SameProgramSlots::new(engine);

    // Plug -> Clear -> Re-plug at new generation -> Invoke succeeds
    stone
        .plug_slots(&SlotPlugBatch {
            plugs: vec![SlotPlug {
                slot_id: 1,
                generation: 1,
                plug_call_id: 42,
                flags: 0,
            }],
        })
        .unwrap();

    stone
        .clear_slots(&ClearSlotsRequest { slot_ids: vec![1] })
        .unwrap();

    stone
        .plug_slots(&SlotPlugBatch {
            plugs: vec![SlotPlug {
                slot_id: 1,
                generation: 2,
                plug_call_id: 99,
                flags: 0,
            }],
        })
        .unwrap();

    let payload = b"re-plugged";
    stone
        .invoke_batch(
            &[InvokeBatchRecord {
                slot_id: 1,
                generation: 2,
                payload_offset: 0,
                payload_len: 10,
                correlation_id: 500,
                flags: 0,
            }],
            payload,
        )
        .unwrap();

    let completions = stone.complete_batch().unwrap();
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0].status_code, status::OK);
    assert_eq!(completions[0].result_len, 10);
}

#[test]
fn mixed_batch_partial_failure() {
    let engine = Arc::new(InProcessEngine::new());
    let stone = SameProgramSlots::new(engine);

    // Plug slot 1 only
    stone
        .plug_slots(&SlotPlugBatch {
            plugs: vec![SlotPlug {
                slot_id: 1,
                generation: 1,
                plug_call_id: 42,
                flags: 0,
            }],
        })
        .unwrap();

    // Batch: slot 1 (live) + slot 2 (not plugged) — partial failure
    let payload = b"data";
    stone
        .invoke_batch(
            &[
                InvokeBatchRecord {
                    slot_id: 1,
                    generation: 1,
                    payload_offset: 0,
                    payload_len: 4,
                    correlation_id: 600,
                    flags: 0,
                },
                InvokeBatchRecord {
                    slot_id: 2,
                    generation: 1,
                    payload_offset: 0,
                    payload_len: 0,
                    correlation_id: 601,
                    flags: 0,
                },
            ],
            payload,
        )
        .unwrap();

    let completions = stone.complete_batch().unwrap();
    assert_eq!(completions.len(), 2);
    assert_eq!(completions[0].correlation_id, 600);
    assert_eq!(completions[0].status_code, status::OK);
    assert_eq!(completions[1].correlation_id, 601);
    assert_eq!(completions[1].status_code, status::SLOT_NOT_PLUGGED);
}

#[test]
fn idempotent_plug_same_generation() {
    let engine = Arc::new(InProcessEngine::new());
    let stone = SameProgramSlots::new(engine);

    // Plug twice with same slot_id and generation — second is idempotent
    let plug = SlotPlug {
        slot_id: 1,
        generation: 1,
        plug_call_id: 42,
        flags: 0,
    };
    stone
        .plug_slots(&SlotPlugBatch { plugs: vec![plug] })
        .unwrap();
    stone
        .plug_slots(&SlotPlugBatch { plugs: vec![plug] })
        .unwrap();

    stone
        .invoke_batch(
            &[InvokeBatchRecord {
                slot_id: 1,
                generation: 1,
                payload_offset: 0,
                payload_len: 0,
                correlation_id: 700,
                flags: 0,
            }],
            &[],
        )
        .unwrap();

    let completions = stone.complete_batch().unwrap();
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0].status_code, status::OK);
}

#[test]
fn complete_batch_with_zero_pending() {
    let engine = Arc::new(InProcessEngine::new());
    let stone = SameProgramSlots::new(engine);

    // COMPLETE_BATCH with nothing pending — returns empty
    let completions = stone.complete_batch().unwrap();
    assert!(completions.is_empty());
}

#[test]
fn clear_already_cleared_slot_is_idempotent() {
    let engine = Arc::new(InProcessEngine::new());
    let stone = SameProgramSlots::new(engine);

    // Clear a slot that was never plugged — no error
    stone
        .clear_slots(&ClearSlotsRequest {
            slot_ids: vec![999],
        })
        .unwrap();
    // Clear it again — still no error
    stone
        .clear_slots(&ClearSlotsRequest {
            slot_ids: vec![999],
        })
        .unwrap();
}
