//! Benchmark: SlotRegistry lookup and method invocation.
//!
//! **Target (Amendment §26):** <100ns per lookup
//!
//! This benchmark measures the performance of the slot registry's lookup operations,
//! including method resolution and dispatch. The test creates a registry with multiple
//! registered slots and performs 10,000 lookups to establish a solid baseline.
//!
//! The SlotRegistry is a critical path component that must resolve slots efficiently
//! at the beginning of every dispatch operation.

use bytes::Bytes;
use criterion::{black_box, criterion_group, criterion_main, Criterion};
use slot_protocol::{
    Envelope, EnvelopeError, FactAddress, Hash, MethodDescriptor, PartitionKey, Slot, SlotRegistry,
};
use std::sync::Arc;

/// Minimal test implementation of the Slot trait for benchmarking
struct TestSlot {
    #[allow(dead_code)]
    name: String,
}

impl Slot for TestSlot {
    fn dispatch(&self, _entries: Vec<Envelope>) -> Result<Hash, EnvelopeError> {
        // Minimal dispatch that returns stable results
        Ok(Hash::blake3([1; 32]))
    }

    fn methods(&self) -> Vec<MethodDescriptor> {
        vec![
            MethodDescriptor::new("method_a", "Test method A"),
            MethodDescriptor::new("method_b", "Test method B"),
        ]
    }

    fn subscribe(&self) -> Option<tokio::sync::broadcast::Receiver<Arc<Envelope>>> {
        None
    }
}

/// Benchmark: SlotRegistry lookup operations
fn bench_slot_registry_lookup(c: &mut Criterion) {
    c.bench_function("slot_registry_lookup_10000", |b| {
        b.iter_batched(
            || {
                // Setup: Create registry and register multiple slots
                let registry = black_box(SlotRegistry::new());

                for i in 0..10 {
                    let slot_name = format!("slot_{}", i);
                    let slot: Arc<dyn Slot> = Arc::new(TestSlot {
                        name: slot_name.clone(),
                    });
                    registry.register(slot_name, slot);
                }

                registry
            },
            |registry| {
                // Benchmark: Perform 10000 lookups
                let mut lookup_count = 0;

                for i in 0..10000 {
                    let slot_name = black_box(format!("slot_{}", i % 10));
                    if let Ok(_slot) = registry.resolve(&slot_name) {
                        lookup_count += 1;
                    }
                }

                lookup_count
            },
            criterion::BatchSize::SmallInput,
        );
    });
}

/// Benchmark: Method resolution from slot
fn bench_slot_methods_resolution(c: &mut Criterion) {
    c.bench_function("slot_methods_resolution_100", |b| {
        b.iter_batched(
            || {
                let slot: Arc<dyn Slot> = Arc::new(TestSlot {
                    name: "test_slot".to_string(),
                });
                slot
            },
            |slot| {
                let mut method_count = 0;

                for _ in 0..100 {
                    let methods = black_box(slot.methods());
                    method_count += methods.len();
                }

                method_count
            },
            criterion::BatchSize::SmallInput,
        );
    });
}

/// Benchmark: Slot dispatch with envelope payload
fn bench_slot_dispatch_with_payload(c: &mut Criterion) {
    c.bench_function("slot_dispatch_envelope_1000", |b| {
        b.iter_batched(
            || {
                // Create test envelopes
                let mut envelopes = Vec::new();
                for i in 0..100 {
                    let partition = PartitionKey::from_digest(0x1F, vec![1; 32]);
                    let envelope = Envelope::minimal(
                        partition,
                        FactAddress::from_digest(0x1F, vec![(i % 256) as u8; 32]),
                        Some(Bytes::from(format!("payload_{}", i))),
                    );
                    envelopes.push(envelope);
                }

                (envelopes, {
                    let slot: Arc<dyn Slot> = Arc::new(TestSlot {
                        name: "test".to_string(),
                    });
                    slot
                })
            },
            |(envelopes, slot)| {
                let mut dispatch_count = 0;

                for _ in 0..10 {
                    if let Ok(_receipt) = slot.dispatch(envelopes.clone()) {
                        dispatch_count += 1;
                    }
                }

                dispatch_count
            },
            criterion::BatchSize::SmallInput,
        );
    });
}

/// Benchmark: Registry concurrent lookups (arc-swap read performance)
fn bench_slot_registry_concurrent_reads(c: &mut Criterion) {
    c.bench_function("slot_registry_concurrent_reads_5000", |b| {
        b.iter_batched(
            || {
                let registry = SlotRegistry::new();

                // Register 5 slots
                for i in 0..5 {
                    let slot_name = format!("concurrent_slot_{}", i);
                    let slot: Arc<dyn Slot> = Arc::new(TestSlot {
                        name: slot_name.clone(),
                    });
                    registry.register(slot_name, slot);
                }

                registry
            },
            |registry| {
                let mut successful_reads = 0;

                // Simulate 5000 concurrent read patterns
                for i in 0..5000 {
                    let slot_name = black_box(format!("concurrent_slot_{}", i % 5));
                    if registry.resolve(&slot_name).is_ok() {
                        successful_reads += 1;
                    }
                }

                successful_reads
            },
            criterion::BatchSize::SmallInput,
        );
    });
}

criterion_group!(
    benches,
    bench_slot_registry_lookup,
    bench_slot_methods_resolution,
    bench_slot_dispatch_with_payload,
    bench_slot_registry_concurrent_reads
);
criterion_main!(benches);
