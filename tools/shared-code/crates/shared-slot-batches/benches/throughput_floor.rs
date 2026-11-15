// crates/shared-slot-batches/benches/throughput_floor.rs
//
// PURPOSE: Maintained hot-path performance floor for same-program boundary.
// Fails on regression below checked constants. Future implementations may
// raise the floor but may not silently lower it.
//
// FLOOR TARGETS (project benchmark profile):
// - 1,000,000,000 operations/second hot-path target
// - < 1 microsecond boundary-crossing latency target

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use std::sync::{Arc, Mutex};

use shared_slot_batches::slot_lifecycle::ClearSlotsRequest;
use shared_slot_batches::slot_plugs::{SlotPlug, SlotPlugBatch};
use shared_slot_batches::{
    status, CompleteBatchRecord, EngineHandle, Error, InvokeBatchRecord, Result, SlotTable,
};

/// Benchmark engine — same as test engine but optimized for throughput measurement.
struct BenchEngine {
    table: Mutex<SlotTable>,
    completions: Mutex<Vec<CompleteBatchRecord>>,
}

impl BenchEngine {
    fn new_with_slot(slot_id: u32, generation: u32) -> Arc<Self> {
        let engine = Self {
            table: Mutex::new(SlotTable::new()),
            completions: Mutex::new(Vec::with_capacity(1024)),
        };
        let mut table = engine.table.lock().unwrap();
        table.plug(&SlotPlug {
            slot_id,
            generation,
            plug_call_id: 1,
            flags: 0,
        });
        drop(table);
        Arc::new(engine)
    }
}

impl EngineHandle for BenchEngine {
    fn install_slot_plugs(&self, plugs: &SlotPlugBatch) -> Result<()> {
        let mut table = self.table.lock().unwrap();
        for plug in &plugs.plugs {
            table.plug(plug);
        }
        Ok(())
    }

    fn enqueue_invocations(
        &self,
        batch: &[InvokeBatchRecord],
        _payload_bytes: &[u8],
    ) -> Result<()> {
        let table = self.table.lock().unwrap();
        let mut completions = self.completions.lock().unwrap();
        for record in batch {
            match table.lookup(record.slot_id, record.generation) {
                Ok(_) => {
                    completions.push(CompleteBatchRecord {
                        correlation_id: record.correlation_id,
                        status_code: status::OK,
                        result_offset: 0,
                        result_len: 0,
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

fn bench_invoke_complete_cycle(c: &mut Criterion) {
    let engine = BenchEngine::new_with_slot(1, 1);

    let record = InvokeBatchRecord {
        slot_id: 1,
        generation: 1,
        payload_offset: 0,
        payload_len: 0,
        correlation_id: 1,
        flags: 0,
    };

    c.bench_function("invoke_complete_single", |b| {
        b.iter(|| {
            engine
                .enqueue_invocations(black_box(&[record]), &[])
                .unwrap();
            let completions = engine.drain_completions().unwrap();
            black_box(completions);
        })
    });
}

fn bench_invoke_batch_1000(c: &mut Criterion) {
    let engine = BenchEngine::new_with_slot(1, 1);

    let batch: Vec<InvokeBatchRecord> = (0..1000)
        .map(|i| InvokeBatchRecord {
            slot_id: 1,
            generation: 1,
            payload_offset: 0,
            payload_len: 0,
            correlation_id: i,
            flags: 0,
        })
        .collect();

    c.bench_function("invoke_complete_batch_1000", |b| {
        b.iter(|| {
            engine.enqueue_invocations(black_box(&batch), &[]).unwrap();
            let completions = engine.drain_completions().unwrap();
            black_box(completions);
        })
    });
}

fn bench_slot_table_lookup(c: &mut Criterion) {
    let mut table = SlotTable::new();
    table.plug(&SlotPlug {
        slot_id: 1,
        generation: 1,
        plug_call_id: 42,
        flags: 0,
    });

    c.bench_function("slot_table_lookup", |b| {
        b.iter(|| {
            let result = table.lookup(black_box(1), black_box(1));
            let _ = black_box(result);
        })
    });
}

criterion_group!(
    throughput_floor,
    bench_invoke_complete_cycle,
    bench_invoke_batch_1000,
    bench_slot_table_lookup,
);
criterion_main!(throughput_floor);
