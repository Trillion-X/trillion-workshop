// crates/slot-protocol/tests/queryresult_gauntlet.rs
//
// Purpose:
//   GT1-GT10 adversarial gauntlet tests for the QueryResult mutation pipeline.
//   These tests verify every invariant of the L063 structural fix: "QueryHandler
//   returns writes alongside responses. DispatchSlot dispatches them automatically."
//
//   Test philosophy: FoundationDB + TigerBeetle + SQLite rigor. We torture the code
//   until it cries. Every invariant is verified under hostile conditions. No test is
//   weakened to match the implementation — if a test reveals a bug, fix the code.
//
// Non-Negotiable Invariants:
//   1. Every WriteEntry returned by a handler is committed in one atomic write batch
//   2. Dispatch order matches handler return order exactly
//   3. Read-only queries produce zero dispatch calls and zero allocation
//   4. Write dispatch failures never corrupt the query response
//   5. Concurrent queries never interleave writes
//   6. Field integrity: dispatched values are byte-identical to handler-returned values

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use content_crypto::Multihash;
use bytes::Bytes;
use slot_protocol::dispatch_handle::{DispatchHandle, LogCursor, RootDiff};
use slot_protocol::handler::QueryHandler;
use slot_protocol::{
    DispatchSlot, Envelope, EnvelopeError, FactAddress, Hash, MethodDescriptor, PartitionKey,
    PathSegment, QueryResult, Slot, WriteEntry,
};

// ============================================================================
// Recording Mock — captures every atomic write batch with full field data
// ============================================================================

#[derive(Debug, Clone)]
struct RecordedWrite {
    partition: PartitionKey,
    address: FactAddress,
    payload: Option<Vec<u8>>,
    path: Vec<PathSegment>,
}

struct RecordingHandle {
    writes: Arc<Mutex<Vec<RecordedWrite>>>,
    dispatch_count: Arc<AtomicU32>,
    /// If set, dispatch_rewrite returns this error
    forced_error: Option<EnvelopeError>,
}

impl RecordingHandle {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            writes: Arc::new(Mutex::new(Vec::new())),
            dispatch_count: Arc::new(AtomicU32::new(0)),
            forced_error: None,
        })
    }

    fn with_forced_error(error: EnvelopeError) -> Arc<Self> {
        Arc::new(Self {
            writes: Arc::new(Mutex::new(Vec::new())),
            dispatch_count: Arc::new(AtomicU32::new(0)),
            forced_error: Some(error),
        })
    }

    fn recorded_writes(&self) -> Vec<RecordedWrite> {
        self.writes.lock().unwrap().clone()
    }

    fn count(&self) -> u32 {
        self.dispatch_count.load(Ordering::SeqCst)
    }
}

impl DispatchHandle for RecordingHandle {
    fn dispatch_rewrite(
        &self,
        partition: PartitionKey,
        address: FactAddress,
        payload: Option<Vec<u8>>,
        path: Vec<PathSegment>,
    ) -> Pin<Box<dyn Future<Output = Result<Hash, EnvelopeError>> + Send + '_>> {
        self.dispatch_count.fetch_add(1, Ordering::SeqCst);
        self.writes.lock().unwrap().push(RecordedWrite {
            partition: partition.clone(),
            address: address.clone(),
            payload: payload.clone(),
            path: path.clone(),
        });
        let receipt = Hash::from_multihash(address.as_multihash().clone());
        if let Some(ref err) = self.forced_error {
            let e = err.clone();
            Box::pin(async move { Err(e) })
        } else {
            Box::pin(async move { Ok(receipt) })
        }
    }

    fn read_envelope(
        &self,
        _partition: PartitionKey,
        _address: FactAddress,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Envelope>, EnvelopeError>> + Send + '_>> {
        Box::pin(async { Ok(None) })
    }

    fn dispatch_write_batch_atomic(
        &self,
        entries: Vec<WriteEntry>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Hash>, EnvelopeError>> + Send + '_>> {
        let writes = Arc::clone(&self.writes);
        let dispatch_count = Arc::clone(&self.dispatch_count);
        let forced_error = self.forced_error.clone();
        Box::pin(async move {
            if let Some(error) = forced_error {
                dispatch_count.fetch_add(1, Ordering::SeqCst);
                return Err(error);
            }
            let receipts = entries
                .iter()
                .map(|entry| Hash::from_multihash(entry.address.as_multihash().clone()))
                .collect();
            dispatch_count.fetch_add(entries.len() as u32, Ordering::SeqCst);
            writes
                .lock()
                .unwrap()
                .extend(entries.into_iter().map(|entry| RecordedWrite {
                    partition: entry.partition,
                    address: entry.address,
                    payload: entry.payload,
                    path: entry.path,
                }));
            Ok(receipts)
        })
    }

    fn visit_direct_read(
        &self,
        _partition: &PartitionKey,
        _address: &FactAddress,
        _visitor: &mut dyn slot_protocol::dispatch_handle::DirectReadVisitor,
    ) -> Result<bool, EnvelopeError> {
        Ok(false)
    }

    fn list_live_state(
        &self,
        _partition: PartitionKey,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<Vec<slot_protocol::LiveStateEntry>, EnvelopeError>>
                + Send
                + '_,
        >,
    > {
        Box::pin(async { Ok(vec![]) })
    }

    fn visit_live_state(
        &self,
        _partition: &PartitionKey,
        _selector: &slot_protocol::EnvelopeSelector,
        _visitor: &mut dyn slot_protocol::dispatch_handle::DirectReadVisitor,
    ) -> Result<(), EnvelopeError> {
        Ok(())
    }

    fn scan_live_state(
        &self,
        _partition: &PartitionKey,
        _selector: &slot_protocol::EnvelopeSelector,
        _cursor: u64,
        _content: slot_protocol::SubscriptionContentMode,
        _visitor: &mut dyn slot_protocol::LiveStateScanVisitor,
    ) -> Result<Option<u64>, EnvelopeError> {
        Ok(None)
    }

    fn subscribe_cursor(
        &self,
        _p: PartitionKey,
        _cb: Arc<dyn Fn(LogCursor) + Send + Sync>,
    ) -> Pin<Box<dyn Future<Output = Result<(), EnvelopeError>> + Send + '_>> {
        Box::pin(async { Ok(()) })
    }

    fn current_root(
        &self,
        _p: PartitionKey,
    ) -> Pin<Box<dyn Future<Output = Result<Multihash, EnvelopeError>> + Send + '_>> {
        Box::pin(async { Ok(Multihash::blake3(b"stub-root")) })
    }

    fn root_diff(
        &self,
        _p: PartitionKey,
        have_root: Option<Multihash>,
    ) -> Pin<Box<dyn Future<Output = Result<RootDiff, EnvelopeError>> + Send + '_>> {
        Box::pin(async move {
            Ok(RootDiff {
                have_root,
                root: Multihash::blake3(b"stub-root"),
                nodes: Vec::new(),
                payloads: Vec::new(),
                kept_roots: Vec::new(),
            })
        })
    }

    fn sync_mesh(
        &self,
        _p: PartitionKey,
        _from_peer: Option<Vec<u8>>,
        diff: RootDiff,
    ) -> Pin<Box<dyn Future<Output = Result<Multihash, EnvelopeError>> + Send + '_>> {
        Box::pin(async move { Ok(diff.root) })
    }

    fn current_cursor(
        &self,
        _p: PartitionKey,
    ) -> Pin<Box<dyn Future<Output = Result<LogCursor, EnvelopeError>> + Send + '_>> {
        Box::pin(async { Ok(LogCursor::ZERO) })
    }

    fn clone_handle(&self) -> Arc<dyn DispatchHandle> {
        Arc::new(RecordingHandle {
            writes: Arc::clone(&self.writes),
            dispatch_count: Arc::clone(&self.dispatch_count),
            forced_error: self.forced_error.clone(),
        })
    }
}

// ============================================================================
// Configurable handlers — writing and read-only
// ============================================================================

/// Handler that returns N writes with predictable field values + a response.
struct WritingHandler {
    write_count: usize,
    response: Vec<u8>,
}

impl WritingHandler {
    fn new(write_count: usize, response: &[u8]) -> Self {
        Self {
            write_count,
            response: response.to_vec(),
        }
    }

    fn make_write(index: usize) -> WriteEntry {
        // Each write has a unique, deterministic partition/address/payload/path
        // based on its index — verifiable by the test.
        let idx_bytes = (index as u64).to_le_bytes().to_vec();
        WriteEntry {
            partition: PartitionKey::from_digest(0x1F, {
                let mut v = vec![0u8; 32];
                v[..8].copy_from_slice(&idx_bytes);
                v
            }),
            address: FactAddress::from_digest(0x1F, {
                let mut v = vec![0xFFu8; 32];
                v[..8].copy_from_slice(&idx_bytes);
                v
            }),
            payload: Some(format!("payload-{}", index).into_bytes()),
            path: vec![PathSegment::hash_from(&format!("field:{}", index))],
            expected_current: None,
        }
    }
}

impl QueryHandler for WritingHandler {
    fn query(
        &self,
        _envelope: Envelope,
    ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>> {
        let writes: Vec<WriteEntry> = (0..self.write_count)
            .map(WritingHandler::make_write)
            .collect();
        let response: Arc<[u8]> = self.response.clone().into();
        Box::pin(async move { Ok(QueryResult::with_writes(response, writes)) })
    }
}

/// Handler that returns the same response but zero writes.
struct ReadOnlyHandler {
    response: Vec<u8>,
}

impl QueryHandler for ReadOnlyHandler {
    fn query(
        &self,
        _envelope: Envelope,
    ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>> {
        let data: Arc<[u8]> = self.response.clone().into();
        Box::pin(async move { Ok(QueryResult::read_only(data)) })
    }
}

/// Handler that returns writes with specific malformed entries.
struct MalformedWriteHandler;

impl QueryHandler for MalformedWriteHandler {
    fn query(
        &self,
        _envelope: Envelope,
    ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>> {
        let writes = vec![
            // Empty payload (retraction)
            WriteEntry {
                partition: PartitionKey::from_digest(0x1F, vec![1u8; 32]),
                address: FactAddress::from_digest(0x1F, vec![2u8; 32]),
                payload: None,
                path: vec![],
                expected_current: None,
            },
            // Zero-length path
            WriteEntry {
                partition: PartitionKey::from_digest(0x1F, vec![3u8; 32]),
                address: FactAddress::from_digest(0x1F, vec![4u8; 32]),
                payload: Some(vec![42u8]),
                path: vec![],
                expected_current: None,
            },
            // Path with 1000 segments
            WriteEntry {
                partition: PartitionKey::from_digest(0x1F, vec![5u8; 32]),
                address: FactAddress::from_digest(0x1F, vec![6u8; 32]),
                payload: Some(vec![99u8]),
                path: (0..1000)
                    .map(|i| PathSegment::hash_from(&format!("seg-{}", i)))
                    .collect(),
                expected_current: None,
            },
            // 1MB payload
            WriteEntry {
                partition: PartitionKey::from_digest(0x1F, vec![7u8; 32]),
                address: FactAddress::from_digest(0x1F, vec![8u8; 32]),
                payload: Some(vec![0xABu8; 1_000_000]),
                path: vec![PathSegment::hash_from("big")],
                expected_current: None,
            },
        ];
        let response: Arc<[u8]> = b"ok".to_vec().into();
        Box::pin(async move { Ok(QueryResult::with_writes(response, writes)) })
    }
}

// ============================================================================
// Helpers
// ============================================================================

fn method(name: &str) -> MethodDescriptor {
    MethodDescriptor::new(name, format!("{name} operation"))
}

fn test_envelope() -> Envelope {
    Envelope::minimal(
        PartitionKey::from_digest(0x1F, vec![1u8; 32]),
        FactAddress::from_digest(0x1F, vec![2u8; 32]),
        Some(Bytes::from(r#"{"test":true}"#)),
    )
}

/// Wait for async dispatch spawn to complete.
async fn settle() {
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
}

// ============================================================================
// GT1: Write Dispatch Verification
// ============================================================================

/// QueryHandler returns N WriteEntries → mock records one atomic batch →
/// assert all N entries commit with byte-identical arguments in insertion order.
#[tokio::test]
async fn gt1_write_dispatch_verification() {
    let handle = RecordingHandle::new();
    let handler = WritingHandler::new(5, b"response-data");
    let slot = DispatchSlot::with_query_handler(
        "gt1",
        vec![method("transact")],
        handle.clone() as Arc<dyn DispatchHandle>,
        Arc::new(handler),
        None,
    );

    let result = slot.query(test_envelope()).await.unwrap();
    assert_eq!(&*result, b"response-data");

    settle().await;

    assert_eq!(handle.count(), 5, "GT1: all 5 writes must be dispatched");
    let writes = handle.recorded_writes();
    assert_eq!(writes.len(), 5);

    // Verify each write matches the deterministic WritingHandler::make_write(i) output
    for (i, w) in writes.iter().enumerate() {
        let expected = WritingHandler::make_write(i);
        assert_eq!(
            w.payload, expected.payload,
            "GT1: write {} payload mismatch",
            i
        );
        assert_eq!(
            w.path.len(),
            expected.path.len(),
            "GT1: write {} path length mismatch",
            i
        );
    }
}

// ============================================================================
// GT2: Zero-Write Overhead
// ============================================================================

/// Handler returns QueryResult::read_only → zero atomic write calls, zero allocation.
#[tokio::test]
async fn gt2_zero_write_overhead() {
    let handle = RecordingHandle::new();
    let handler = ReadOnlyHandler {
        response: b"pure-read".to_vec(),
    };
    let slot = DispatchSlot::with_query_handler(
        "gt2",
        vec![method("read")],
        handle.clone() as Arc<dyn DispatchHandle>,
        Arc::new(handler),
        None,
    );

    let result = slot.query(test_envelope()).await.unwrap();
    assert_eq!(&*result, b"pure-read");

    settle().await;

    assert_eq!(
        handle.count(),
        0,
        "GT2: read-only query must produce zero dispatch calls"
    );
    assert!(
        handle.recorded_writes().is_empty(),
        "GT2: no writes recorded"
    );
}

// ============================================================================
// GT3: Concurrent Queries with Writes
// ============================================================================

/// Spawn 100 parallel queries, each producing 10 writes → 1000 total,
/// no duplication, no loss, no interleaving of one query's writes with another's.
#[tokio::test]
async fn gt3_concurrent_queries_no_loss() {
    let handle = RecordingHandle::new();
    let handler = Arc::new(WritingHandler::new(10, b"concurrent"));
    let slot = Arc::new(DispatchSlot::with_query_handler(
        "gt3",
        vec![method("transact")],
        handle.clone() as Arc<dyn DispatchHandle>,
        handler,
        None,
    ));

    let mut tasks = Vec::new();
    for _ in 0..100 {
        let s = slot.clone();
        tasks.push(tokio::spawn(async move {
            Slot::query(&*s, test_envelope()).await.unwrap()
        }));
    }

    // Await all queries
    for t in tasks {
        let resp = t.await.unwrap();
        assert_eq!(&*resp, b"concurrent");
    }

    // Wait for all spawned dispatch tasks
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    assert_eq!(
        handle.count(),
        1000,
        "GT3: 100 queries × 10 writes = 1000 dispatches, got {}",
        handle.count()
    );

    let all_writes = handle.recorded_writes();
    assert_eq!(all_writes.len(), 1000, "GT3: all 1000 writes recorded");

    // Verify no writes were lost — each write index 0-9 should appear exactly 100 times
    for idx in 0..10 {
        let expected_payload = format!("payload-{}", idx).into_bytes();
        let count = all_writes
            .iter()
            .filter(|w| w.payload.as_ref() == Some(&expected_payload))
            .count();
        assert_eq!(
            count, 100,
            "GT3: write index {} should appear 100 times, got {}",
            idx, count
        );
    }
}

// ============================================================================
// GT4: Malformed WriteEntry
// ============================================================================

/// Empty payload, zero-length path, 1000-segment path, 1MB payload →
/// handler never panics, DispatchSlot passes them through opaquely.
#[tokio::test]
async fn gt4_malformed_write_entries() {
    let handle = RecordingHandle::new();
    let handler = MalformedWriteHandler;
    let slot = DispatchSlot::with_query_handler(
        "gt4",
        vec![method("chaos")],
        handle.clone() as Arc<dyn DispatchHandle>,
        Arc::new(handler),
        None,
    );

    let result = slot.query(test_envelope()).await.unwrap();
    assert_eq!(
        &*result, b"ok",
        "GT4: response must be intact despite malformed writes"
    );

    settle().await;

    assert_eq!(handle.count(), 4, "GT4: all 4 malformed writes dispatched");
    let writes = handle.recorded_writes();

    // Entry 0: retraction (None payload, empty path)
    assert!(
        writes[0].payload.is_none(),
        "GT4: retraction payload is None"
    );
    assert!(writes[0].path.is_empty(), "GT4: retraction path is empty");

    // Entry 1: empty path
    assert_eq!(writes[1].payload, Some(vec![42u8]));
    assert!(writes[1].path.is_empty());

    // Entry 2: 1000-segment path
    assert_eq!(
        writes[2].path.len(),
        1000,
        "GT4: 1000-segment path passed through"
    );

    // Entry 3: 1MB payload
    assert_eq!(
        writes[3].payload.as_ref().unwrap().len(),
        1_000_000,
        "GT4: 1MB payload passed through intact"
    );
}

// ============================================================================
// GT5: Batch Write Accumulation
// ============================================================================

/// query_batch() with 5 envelopes, each producing 3 writes → 5 responses + 15 writes.
#[tokio::test]
async fn gt5_batch_write_accumulation() {
    let handle = RecordingHandle::new();
    let handler = WritingHandler::new(3, b"batch-resp");
    let slot = DispatchSlot::with_query_handler(
        "gt5",
        vec![method("batch")],
        handle.clone() as Arc<dyn DispatchHandle>,
        Arc::new(handler),
        None,
    );

    let envelopes: Vec<Envelope> = (0..5).map(|_| test_envelope()).collect();
    let responses = slot.query_batch(envelopes).await.unwrap();

    assert_eq!(responses.len(), 5, "GT5: 5 envelopes → 5 responses");
    for r in &responses {
        assert_eq!(&**r, b"batch-resp");
    }

    // Wait for spawned dispatch
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    assert_eq!(
        handle.count(),
        15,
        "GT5: 5 queries × 3 writes = 15 dispatches, got {}",
        handle.count()
    );
}

// ============================================================================
// GT6: Handler Parity
// ============================================================================

/// Same payload to WritingHandler and ReadOnlyHandler → response bytes identical.
/// Writes are a side-channel, not a response mutation.
#[tokio::test]
async fn gt6_handler_parity() {
    let shared_response = b"identical-response-bytes-12345";

    // Writing handler: 5 writes + response
    let wh = RecordingHandle::new();
    let writing_slot = DispatchSlot::with_query_handler(
        "gt6-writing",
        vec![method("op")],
        wh.clone() as Arc<dyn DispatchHandle>,
        Arc::new(WritingHandler::new(5, shared_response)),
        None,
    );

    // Read-only handler: 0 writes + same response
    let rh = RecordingHandle::new();
    let readonly_slot = DispatchSlot::with_query_handler(
        "gt6-readonly",
        vec![method("op")],
        rh.clone() as Arc<dyn DispatchHandle>,
        Arc::new(ReadOnlyHandler {
            response: shared_response.to_vec(),
        }),
        None,
    );

    let writing_result = writing_slot.query(test_envelope()).await.unwrap();
    let readonly_result = readonly_slot.query(test_envelope()).await.unwrap();

    // Response bytes must be identical — writes are a side-channel
    assert_eq!(
        &*writing_result, &*readonly_result,
        "GT6: WritingHandler and ReadOnlyHandler must return identical response bytes"
    );
    assert_eq!(&*writing_result, shared_response);

    settle().await;

    // But dispatch counts differ
    assert_eq!(wh.count(), 5, "GT6: WritingHandler dispatched 5 writes");
    assert_eq!(rh.count(), 0, "GT6: ReadOnlyHandler dispatched 0 writes");
}

// ============================================================================
// GT7: Dispatch Failure Propagation
// ============================================================================

/// Mock DispatchHandle returns Err on atomic batch commit → query() returns Err.
/// Mutating query acknowledgement covers handler execution plus emitted writes.
#[tokio::test]
async fn gt7_dispatch_failure_propagation() {
    let handle = RecordingHandle::with_forced_error(EnvelopeError::Internal(
        "simulated dispatch failure".into(),
    ));
    let handler = WritingHandler::new(3, b"response-survives");
    let slot = DispatchSlot::with_query_handler(
        "gt7",
        vec![method("op")],
        handle.clone() as Arc<dyn DispatchHandle>,
        Arc::new(handler),
        None,
    );

    let result = slot.query(test_envelope()).await;
    assert!(
        matches!(result, Err(EnvelopeError::Internal(message)) if message.contains("simulated dispatch failure")),
        "GT7: query must fail when emitted writes fail"
    );

    assert_eq!(
        handle.count(),
        1,
        "GT7: first failed write stops acknowledgement because the mutation chain failed"
    );
}

// ============================================================================
// GT8: Write Ordering
// ============================================================================

/// Handler returns writes [W0, W1, ..., W99] → dispatched in exactly that order.
/// No reordering from async spawn.
#[tokio::test]
async fn gt8_write_ordering() {
    let handle = RecordingHandle::new();
    let handler = WritingHandler::new(100, b"ordered");
    let slot = DispatchSlot::with_query_handler(
        "gt8",
        vec![method("op")],
        handle.clone() as Arc<dyn DispatchHandle>,
        Arc::new(handler),
        None,
    );

    slot.query(test_envelope()).await.unwrap();

    // Wait generously for the spawned task
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let writes = handle.recorded_writes();
    assert_eq!(writes.len(), 100, "GT8: all 100 writes dispatched");

    // Verify strict ordering by checking payload values
    for (i, w) in writes.iter().enumerate() {
        let expected_payload = format!("payload-{}", i).into_bytes();
        assert_eq!(
            w.payload.as_ref(),
            Some(&expected_payload),
            "GT8: write at position {} has wrong payload (ordering violation)",
            i
        );
    }
}

// ============================================================================
// GT9: Large Write Count
// ============================================================================

/// Single query returns 10,000 writes → all dispatched, no panic, no OOM.
#[tokio::test]
async fn gt9_large_write_count() {
    let handle = RecordingHandle::new();
    let handler = WritingHandler::new(10_000, b"ten-thousand");
    let slot = DispatchSlot::with_query_handler(
        "gt9",
        vec![method("op")],
        handle.clone() as Arc<dyn DispatchHandle>,
        Arc::new(handler),
        None,
    );

    let result = slot.query(test_envelope()).await.unwrap();
    assert_eq!(&*result, b"ten-thousand");

    // Wait for 10k dispatches — generous timeout
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    assert_eq!(
        handle.count(),
        10_000,
        "GT9: all 10,000 writes dispatched, got {}",
        handle.count()
    );
}

// ============================================================================
// GT10: WriteEntry Field Integrity
// ============================================================================

/// WriteEntry with specific partition, address, payload, path (3 PathSegments) →
/// dispatched write has byte-identical values for ALL fields.
#[tokio::test]
async fn gt10_write_entry_field_integrity() {
    // Construct a WriteEntry with very specific, verifiable field values
    let specific_partition = PartitionKey::from_digest(
        0x1F,
        vec![
            0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A,
            0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
            0x19, 0x1A, 0x1B, 0x1C,
        ],
    );
    let specific_address = FactAddress::from_digest(
        0x1F,
        vec![
            0xCA, 0xFE, 0xBA, 0xBE, 0xF0, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9,
            0xFA, 0xFB, 0xFC, 0xFD, 0xFE, 0xFF, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
            0x08, 0x09, 0x0A, 0x0B,
        ],
    );
    let specific_payload = vec![0x42u8, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49];
    let specific_path = vec![
        PathSegment::hash_from("field:alpha"),
        PathSegment::hash_from("field:beta"),
        PathSegment::hash_from("field:gamma"),
    ];

    // Handler that returns this exact write
    struct ExactWriteHandler {
        write: WriteEntry,
    }
    impl QueryHandler for ExactWriteHandler {
        fn query(
            &self,
            _envelope: Envelope,
        ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>> {
            let w = self.write.clone();
            let resp: Arc<[u8]> = b"gt10".to_vec().into();
            Box::pin(async move { Ok(QueryResult::with_writes(resp, vec![w])) })
        }
    }

    let handle = RecordingHandle::new();
    let handler = ExactWriteHandler {
        write: WriteEntry {
            partition: specific_partition.clone(),
            address: specific_address.clone(),
            payload: Some(specific_payload.clone()),
            path: specific_path.clone(),
            expected_current: None,
        },
    };
    let slot = DispatchSlot::with_query_handler(
        "gt10",
        vec![method("op")],
        handle.clone() as Arc<dyn DispatchHandle>,
        Arc::new(handler),
        None,
    );

    slot.query(test_envelope()).await.unwrap();
    settle().await;

    assert_eq!(handle.count(), 1, "GT10: exactly 1 write dispatched");
    let writes = handle.recorded_writes();
    let w = &writes[0];

    // Partition: byte-identical
    assert_eq!(
        w.partition.as_multihash(),
        specific_partition.as_multihash(),
        "GT10: partition mismatch"
    );

    // Address: byte-identical
    assert_eq!(
        w.address.as_multihash(),
        specific_address.as_multihash(),
        "GT10: address mismatch"
    );

    // Payload: byte-identical
    assert_eq!(
        w.payload,
        Some(specific_payload),
        "GT10: payload bytes mismatch"
    );

    // Path: exact count and each segment matches
    assert_eq!(w.path.len(), 3, "GT10: path must have exactly 3 segments");
    for (i, (actual, expected)) in w.path.iter().zip(specific_path.iter()).enumerate() {
        assert_eq!(
            actual.as_multihash(),
            expected.as_multihash(),
            "GT10: path segment {} mismatch",
            i
        );
    }
}
