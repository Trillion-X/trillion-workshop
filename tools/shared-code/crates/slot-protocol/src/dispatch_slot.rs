//! DispatchSlot — the L069 generative primitive for generic Envelope dispatch.
//!
//! `DispatchSlot` is the single implementation for any slot that routes Envelope
//! entries through `DispatchHandle.dispatch_rewrite()`. Method names are
//! Society data passed at construction — not hardcoded in code.
//!
//! # Invariants
//!
//! - Payload is opaque bytes — no deserialization, no type coupling
//! - Method names are construction-time data, not code
//! - dispatch() spawns async work and returns receipt immediately
//! - query() and query_batch() commit handler-emitted writes before acknowledging
//! - Empty entry list returns error (admission rejected)
//! - Adding a new slot type = one `DispatchSlot::new()` call, zero code changes
//! - Depends on DispatchHandle trait, NOT on EnvelopeEngineHandle concrete type

use crate::dispatch_handle::DispatchHandle;
use crate::handler::{QueryHandler, WriteEntry};
use crate::method::MethodDescriptor;
use crate::slot::Slot;
use crate::{combine_query_context, Envelope, EnvelopeError, Hash};
use bytes::Bytes;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Instant;

/// Generic dispatch slot — routes Envelope entries through a DispatchHandle.
///
/// Method names (create/read/update/delete/query, trigger/cancel/status, or ANY
/// arbitrary names) are Society data passed at construction. The slot itself is
/// pure Physics — it doesn't know what the methods mean.
pub struct DispatchSlot {
    name: Arc<str>,
    descriptors: Vec<MethodDescriptor>,
    handle: Arc<dyn DispatchHandle>,
    /// Optional query handler for domain-specific read-path queries.
    /// When present, `query()` delegates to this handler.
    /// When absent, `query()` returns `Err(NotSupported)` (default).
    query_handler: Option<Arc<dyn QueryHandler>>,
    /// Opaque bytes injected into query envelopes when the caller did not
    /// already provide context. This carries slot-owned config back to the slot
    /// without introducing a slot-specific ABI.
    query_context: Option<Bytes>,
}

impl std::fmt::Debug for DispatchSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DispatchSlot")
            .field("name", &self.name)
            .finish()
    }
}

impl Clone for DispatchSlot {
    fn clone(&self) -> Self {
        Self {
            name: self.name.clone(),
            descriptors: self.descriptors.clone(),
            handle: self.handle.clone_handle(),
            query_handler: self.query_handler.clone(),
            query_context: self.query_context.clone(),
        }
    }
}

impl DispatchSlot {
    /// Create a new DispatchSlot with the given name, methods, and dispatch handle.
    ///
    /// # Arguments
    ///
    /// * `name` - Slot name (Society data; any string)
    /// * `descriptors` - Methods this slot advertises (Society data)
    /// * `handle` - The dispatch handle for routing writes (trait object — zero concrete coupling)
    pub fn new(
        name: &str,
        descriptors: Vec<MethodDescriptor>,
        handle: Arc<dyn DispatchHandle>,
        query_context: Option<Bytes>,
    ) -> Self {
        Self {
            name: name.into(),
            descriptors,
            handle,
            query_handler: None,
            query_context,
        }
    }

    /// Create a new DispatchSlot with a query handler for read-path queries.
    ///
    /// The query handler provides domain-specific query logic. When `query()`
    /// is called on this slot, it delegates to the handler instead of returning
    /// `Err(NotSupported)`.
    pub fn with_query_handler(
        name: &str,
        descriptors: Vec<MethodDescriptor>,
        handle: Arc<dyn DispatchHandle>,
        query_handler: Arc<dyn QueryHandler>,
        query_context: Option<Bytes>,
    ) -> Self {
        Self {
            name: name.into(),
            descriptors,
            handle,
            query_handler: Some(query_handler),
            query_context,
        }
    }

    /// Returns the slot name.
    pub fn name(&self) -> &str {
        &self.name
    }
}

async fn dispatch_query_writes(
    handle: Arc<dyn DispatchHandle>,
    slot_name: Arc<str>,
    writes: Vec<WriteEntry>,
) -> Result<(), EnvelopeError> {
    let write_count = writes.len();
    let started = Instant::now();
    tracing::info!(
        slot = %slot_name,
        write_count,
        "DispatchSlot query write dispatch start"
    );
    handle
        .dispatch_write_batch_atomic(writes)
        .await
        .map_err(|error| {
            EnvelopeError::Internal(format!(
                "DispatchSlot {slot_name} atomic query write batch failed: {error}"
            ))
        })?;
    tracing::info!(
        slot = %slot_name,
        write_count,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "DispatchSlot atomic query write batch committed"
    );
    Ok(())
}

impl Slot for DispatchSlot {
    fn dispatch(&self, entries: Vec<Envelope>) -> Result<Hash, EnvelopeError> {
        if entries.is_empty() {
            return Err(EnvelopeError::AddressNotFound);
        }

        // Receipt: hash of the first entry's address.
        // Multihash is Vec<u8>-backed (no Copy) — clone the identity for the receipt;
        // the original Multihash stays borrowed inside `entries`.
        let receipt = Hash::from_multihash(entries[0].address.as_multihash().clone());

        // Spawn async dispatch through the handle
        let handle = self.handle.clone_handle();
        let name = self.name.clone();
        tokio::spawn(async move {
            for entry in entries {
                let partition = entry.partition_key;
                let address = entry.address;
                let payload = entry.payload.map(|b| b.to_vec());

                if let Err(e) = handle
                    .dispatch_rewrite(partition, address, payload, vec![])
                    .await
                {
                    tracing::error!(slot = %name, error = %e, "DispatchSlot dispatch_rewrite failed");
                }
            }
        });

        Ok(receipt)
    }

    fn query(
        &self,
        envelope: Envelope,
    ) -> Pin<Box<dyn Future<Output = Result<Arc<[u8]>, EnvelopeError>> + Send + '_>> {
        match &self.query_handler {
            Some(handler) => {
                let handle = self.handle.clone_handle();
                let name = self.name.clone();
                let query_context = self.query_context.clone();
                Box::pin(async move {
                    let mut envelope = envelope;
                    envelope.context = combine_query_context(query_context, envelope.context);
                    let result = handler.query(envelope).await?;
                    // Auto-dispatch writes through the Envelope engine (L063).
                    // Query replies acknowledge the whole mutation chain, not
                    // merely handler execution; otherwise workflow/trigger
                    // chains can race their own writes.
                    if !result.writes.is_empty() {
                        dispatch_query_writes(handle, name, result.writes).await?;
                    }
                    Ok(result.response)
                })
            }
            None => Box::pin(async { Err(EnvelopeError::NotSupported) }),
        }
    }

    fn query_batch(
        &self,
        envelopes: Vec<Envelope>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Arc<[u8]>>, EnvelopeError>> + Send + '_>> {
        if envelopes.is_empty() {
            return Box::pin(async { Ok(Vec::new()) });
        }

        match &self.query_handler {
            Some(handler) => {
                let handle = self.handle.clone_handle();
                let name = self.name.clone();
                let query_context = self.query_context.clone();
                Box::pin(async move {
                    tracing::debug!(
                        "[slot-protocol] query_batch: dispatching {} queries to handler \"{}\"",
                        envelopes.len(),
                        name
                    );
                    let envelopes: Vec<Envelope> = envelopes
                        .into_iter()
                        .map(|mut envelope| {
                            envelope.context =
                                combine_query_context(query_context.clone(), envelope.context);
                            envelope
                        })
                        .collect();
                    let batch_result = handler.query_batch(envelopes).await?;
                    // Auto-dispatch accumulated writes (L063) before the batch
                    // response is acknowledged.
                    if !batch_result.writes.is_empty() {
                        dispatch_query_writes(handle, name, batch_result.writes).await?;
                    }
                    Ok(batch_result.responses)
                })
            }
            None => Box::pin(async { Err(EnvelopeError::NotSupported) }),
        }
    }

    fn methods(&self) -> Vec<MethodDescriptor> {
        self.descriptors.clone()
    }

    // subscribe() uses the default (None) — DispatchHandle's subscribe is async
    // with parameters incompatible with the sync Slot trait.
    // Consumers that need subscriptions call the handle directly.
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handler::QueryHandler;
    use crate::{FactAddress, PartitionKey, PathSegment, QueryResult};
    use content_crypto::Multihash;
    use bytes::Bytes;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn method(name: &str) -> MethodDescriptor {
        MethodDescriptor::new(name, format!("{name} operation"))
    }

    /// Mock DispatchHandle for testing — counts dispatches.
    struct MockHandle {
        dispatch_count: Arc<AtomicU32>,
        atomic_batch_count: Arc<AtomicU32>,
        atomically_published: Arc<std::sync::Mutex<Vec<WriteEntry>>>,
        dispatch_started: Option<Arc<tokio::sync::Notify>>,
        dispatch_release: Option<Arc<tokio::sync::Notify>>,
        fail_atomic_batch: bool,
    }

    impl MockHandle {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                dispatch_count: Arc::new(AtomicU32::new(0)),
                atomic_batch_count: Arc::new(AtomicU32::new(0)),
                atomically_published: Arc::new(std::sync::Mutex::new(Vec::new())),
                dispatch_started: None,
                dispatch_release: None,
                fail_atomic_batch: false,
            })
        }

        fn gated(
            dispatch_started: Arc<tokio::sync::Notify>,
            dispatch_release: Arc<tokio::sync::Notify>,
        ) -> Arc<Self> {
            Arc::new(Self {
                dispatch_count: Arc::new(AtomicU32::new(0)),
                atomic_batch_count: Arc::new(AtomicU32::new(0)),
                atomically_published: Arc::new(std::sync::Mutex::new(Vec::new())),
                dispatch_started: Some(dispatch_started),
                dispatch_release: Some(dispatch_release),
                fail_atomic_batch: false,
            })
        }

        fn failing_atomic_batch() -> Arc<Self> {
            Arc::new(Self {
                dispatch_count: Arc::new(AtomicU32::new(0)),
                atomic_batch_count: Arc::new(AtomicU32::new(0)),
                atomically_published: Arc::new(std::sync::Mutex::new(Vec::new())),
                dispatch_started: None,
                dispatch_release: None,
                fail_atomic_batch: true,
            })
        }
    }

    impl DispatchHandle for MockHandle {
        fn dispatch_rewrite(
            &self,
            _partition: PartitionKey,
            target: FactAddress,
            _payload: Option<Vec<u8>>,
            _path: Vec<PathSegment>,
        ) -> Pin<Box<dyn Future<Output = Result<Hash, EnvelopeError>> + Send + '_>> {
            let dispatch_count = Arc::clone(&self.dispatch_count);
            let dispatch_started = self.dispatch_started.clone();
            let dispatch_release = self.dispatch_release.clone();
            let receipt = Hash::from_multihash(target.as_multihash().clone());
            Box::pin(async move {
                if let Some(notify) = dispatch_started {
                    notify.notify_one();
                }
                if let Some(notify) = dispatch_release {
                    notify.notified().await;
                }
                dispatch_count.fetch_add(1, Ordering::Relaxed);
                Ok(receipt)
            })
        }

        fn dispatch_write_batch_atomic(
            &self,
            entries: Vec<WriteEntry>,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<Hash>, EnvelopeError>> + Send + '_>> {
            let atomic_batch_count = Arc::clone(&self.atomic_batch_count);
            let published = Arc::clone(&self.atomically_published);
            let dispatch_started = self.dispatch_started.clone();
            let dispatch_release = self.dispatch_release.clone();
            let fail_atomic_batch = self.fail_atomic_batch;
            Box::pin(async move {
                if let Some(notify) = dispatch_started {
                    notify.notify_one();
                }
                if let Some(notify) = dispatch_release {
                    notify.notified().await;
                }
                atomic_batch_count.fetch_add(1, Ordering::Relaxed);
                if fail_atomic_batch {
                    return Err(EnvelopeError::Internal(
                        "injected atomic batch failure".to_string(),
                    ));
                }
                let receipts = entries
                    .iter()
                    .map(|entry| Hash::from_multihash(entry.address.as_multihash().clone()))
                    .collect();
                published
                    .lock()
                    .expect("published writes lock")
                    .extend(entries);
                Ok(receipts)
            })
        }

        fn read_envelope(
            &self,
            _partition: PartitionKey,
            _address: FactAddress,
        ) -> Pin<Box<dyn Future<Output = Result<Option<Envelope>, EnvelopeError>> + Send + '_>>
        {
            Box::pin(async move { Ok(None) })
        }

        fn visit_direct_read(
            &self,
            _partition: &PartitionKey,
            _address: &FactAddress,
            _visitor: &mut dyn crate::dispatch_handle::DirectReadVisitor,
        ) -> Result<bool, EnvelopeError> {
            Ok(false)
        }

        fn list_live_state(
            &self,
            _partition: PartitionKey,
        ) -> Pin<
            Box<dyn Future<Output = Result<Vec<crate::LiveStateEntry>, EnvelopeError>> + Send + '_>,
        > {
            Box::pin(async move { Ok(vec![]) })
        }

        fn visit_live_state(
            &self,
            _partition: &PartitionKey,
            _selector: &crate::EnvelopeSelector,
            _visitor: &mut dyn crate::dispatch_handle::DirectReadVisitor,
        ) -> Result<(), EnvelopeError> {
            Ok(())
        }

        fn scan_live_state(
            &self,
            _partition: &PartitionKey,
            _selector: &crate::EnvelopeSelector,
            _cursor: u64,
            _content: crate::SubscriptionContentMode,
            _visitor: &mut dyn crate::LiveStateScanVisitor,
        ) -> Result<Option<u64>, EnvelopeError> {
            Ok(None)
        }

        fn subscribe_cursor(
            &self,
            _p: PartitionKey,
            _cb: Arc<dyn Fn(crate::dispatch_handle::LogCursor) + Send + Sync>,
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
        ) -> Pin<Box<dyn Future<Output = Result<crate::RootDiff, EnvelopeError>> + Send + '_>>
        {
            Box::pin(async move {
                Ok(crate::RootDiff {
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
            diff: crate::RootDiff,
        ) -> Pin<Box<dyn Future<Output = Result<Multihash, EnvelopeError>> + Send + '_>> {
            Box::pin(async move { Ok(diff.root) })
        }
        fn current_cursor(
            &self,
            _p: PartitionKey,
        ) -> Pin<
            Box<
                dyn Future<Output = Result<crate::dispatch_handle::LogCursor, EnvelopeError>>
                    + Send
                    + '_,
            >,
        > {
            Box::pin(async { Ok(crate::dispatch_handle::LogCursor::ZERO) })
        }

        fn clone_handle(&self) -> Arc<dyn DispatchHandle> {
            Arc::new(MockHandle {
                dispatch_count: Arc::clone(&self.dispatch_count),
                atomic_batch_count: Arc::clone(&self.atomic_batch_count),
                atomically_published: Arc::clone(&self.atomically_published),
                dispatch_started: self.dispatch_started.clone(),
                dispatch_release: self.dispatch_release.clone(),
                fail_atomic_batch: self.fail_atomic_batch,
            })
        }
    }

    fn test_envelope() -> Envelope {
        Envelope::minimal(
            PartitionKey::from_digest(0x1F, vec![1u8; 32]),
            FactAddress::from_digest(0x1F, vec![2u8; 32]),
            Some(Bytes::from(r#"{"data":"test"}"#)),
        )
    }

    #[tokio::test]
    async fn dispatch_calls_handle() {
        let handle = MockHandle::new();
        let slot = DispatchSlot::new(
            "test",
            vec![method("op")],
            handle.clone() as Arc<dyn DispatchHandle>,
            None,
        );
        let result = slot.dispatch(vec![test_envelope()]);
        assert!(result.is_ok());
        // Give spawned task time to execute
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert_eq!(handle.dispatch_count.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn dispatch_empty_entries_rejected() {
        let handle = MockHandle::new();
        let slot = DispatchSlot::new(
            "test",
            vec![method("op")],
            handle as Arc<dyn DispatchHandle>,
            None,
        );
        let result = slot.dispatch(vec![]);
        assert!(matches!(result, Err(EnvelopeError::AddressNotFound)));
    }

    #[tokio::test]
    async fn dispatch_retraction_accepted() {
        let handle = MockHandle::new();
        let slot = DispatchSlot::new(
            "test",
            vec![method("op")],
            handle as Arc<dyn DispatchHandle>,
            None,
        );
        let env = Envelope::minimal(
            PartitionKey::from_digest(0x1F, vec![1u8; 32]),
            FactAddress::from_digest(0x1F, vec![2u8; 32]),
            None,
        );
        assert!(slot.dispatch(vec![env]).is_ok());
    }

    #[test]
    fn methods_returns_construction_time_methods() {
        let handle = MockHandle::new();
        let slot = DispatchSlot::new(
            "target-alpha",
            vec![
                method("create"),
                method("read"),
                method("update"),
                method("delete"),
                method("query"),
            ],
            handle as Arc<dyn DispatchHandle>,
            None,
        );
        let methods = slot.methods();
        assert_eq!(methods.len(), 5);
        assert_eq!(methods[0].name, "create");
        assert_eq!(methods[4].name, "query");
    }

    #[test]
    fn methods_returns_arbitrary_names() {
        let handle = MockHandle::new();
        let slot = DispatchSlot::new(
            "custom",
            vec![method("foo"), method("bar_baz")],
            handle as Arc<dyn DispatchHandle>,
            None,
        );
        let methods = slot.methods();
        assert_eq!(methods.len(), 2);
    }

    #[tokio::test]
    async fn different_addresses_different_receipts() {
        let handle = MockHandle::new();
        let slot = DispatchSlot::new(
            "test",
            vec![method("op")],
            handle as Arc<dyn DispatchHandle>,
            None,
        );

        let env1 = Envelope::minimal(
            PartitionKey::from_digest(0x1F, vec![1u8; 32]),
            FactAddress::from_digest(0x1F, vec![2u8; 32]),
            Some(Bytes::from("a")),
        );
        let env2 = Envelope::minimal(
            PartitionKey::from_digest(0x1F, vec![1u8; 32]),
            FactAddress::from_digest(0x1F, vec![3u8; 32]),
            Some(Bytes::from("b")),
        );

        let r1 = slot.dispatch(vec![env1]).unwrap();
        let r2 = slot.dispatch(vec![env2]).unwrap();
        assert_ne!(r1, r2);
    }

    #[tokio::test]
    async fn opaque_payload_accepted() {
        let handle = MockHandle::new();
        let slot = DispatchSlot::new(
            "test",
            vec![method("op")],
            handle as Arc<dyn DispatchHandle>,
            None,
        );
        let env = Envelope::minimal(
            PartitionKey::from_digest(0x1F, vec![1u8; 32]),
            FactAddress::from_digest(0x1F, vec![2u8; 32]),
            Some(Bytes::from(vec![0xFF, 0xFE, 0x00, 0xAB])),
        );
        assert!(slot.dispatch(vec![env]).is_ok());
    }

    #[test]
    fn name_accessor() {
        let handle = MockHandle::new();
        let slot = DispatchSlot::new("my_slot", vec![], handle as Arc<dyn DispatchHandle>, None);
        assert_eq!(slot.name(), "my_slot");
    }

    #[test]
    fn debug_includes_name() {
        let handle = MockHandle::new();
        let slot = DispatchSlot::new(
            "target-alpha",
            vec![],
            handle as Arc<dyn DispatchHandle>,
            None,
        );
        let debug = format!("{:?}", slot);
        assert!(debug.contains("target-alpha"));
    }

    #[test]
    fn subscribe_returns_none_by_default() {
        let handle = MockHandle::new();
        let slot = DispatchSlot::new("test", vec![], handle as Arc<dyn DispatchHandle>, None);
        assert!(slot.subscribe().is_none());
    }

    #[test]
    fn cloneable() {
        let handle = MockHandle::new();
        let slot = DispatchSlot::new(
            "test",
            vec![method("op")],
            handle as Arc<dyn DispatchHandle>,
            None,
        );
        let clone = slot.clone();
        assert_eq!(clone.name(), "test");
    }

    /// Mock QueryHandler for testing query_batch.
    struct MockQueryHandler {
        response: Vec<u8>,
    }

    impl MockQueryHandler {
        fn new(response: &[u8]) -> Self {
            Self {
                response: response.to_vec(),
            }
        }
    }

    impl QueryHandler for MockQueryHandler {
        fn query(
            &self,
            _envelope: Envelope,
        ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>> {
            let data: Arc<[u8]> = self.response.clone().into();
            Box::pin(async move { Ok(QueryResult::read_only(data)) })
        }
    }

    struct WritingQueryHandler;

    impl QueryHandler for WritingQueryHandler {
        fn query(
            &self,
            _envelope: Envelope,
        ) -> Pin<Box<dyn Future<Output = Result<QueryResult, EnvelopeError>> + Send + '_>> {
            Box::pin(async move {
                Ok(QueryResult::with_writes(
                    Arc::from(Vec::from(b"written".as_slice()).into_boxed_slice()),
                    vec![
                        crate::handler::WriteEntry {
                            partition: PartitionKey::from_digest(0x1F, vec![9u8; 32]),
                            address: FactAddress::from_digest(0x1F, vec![8u8; 32]),
                            payload: Some(b"payload".to_vec()),
                            path: vec![PathSegment::hash_from("changed")],
                            expected_current: None,
                        },
                        crate::handler::WriteEntry {
                            partition: PartitionKey::from_digest(0x1F, vec![9u8; 32]),
                            address: FactAddress::from_digest(0x1F, vec![7u8; 32]),
                            payload: Some(b"second-payload".to_vec()),
                            path: vec![],
                            expected_current: None,
                        },
                    ],
                ))
            })
        }
    }

    #[tokio::test]
    async fn query_batch_empty_returns_empty_vec() {
        let handle = MockHandle::new();
        let slot = DispatchSlot::new(
            "test",
            vec![method("op")],
            handle as Arc<dyn DispatchHandle>,
            None,
        );
        let result = slot.query_batch(vec![]).await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn query_batch_without_handler_returns_error() {
        let handle = MockHandle::new();
        let slot = DispatchSlot::new(
            "test",
            vec![method("op")],
            handle as Arc<dyn DispatchHandle>,
            None,
        );
        let env = test_envelope();
        let result = slot.query_batch(vec![env]).await;

        assert!(result.is_err());
        assert!(matches!(result, Err(EnvelopeError::NotSupported)));
    }

    #[tokio::test]
    async fn query_batch_with_handler_returns_results() {
        let handle = MockHandle::new();
        let query_handler = Arc::new(MockQueryHandler::new(b"response")) as Arc<dyn QueryHandler>;
        let slot = DispatchSlot::with_query_handler(
            "test",
            vec![method("op")],
            handle as Arc<dyn DispatchHandle>,
            query_handler,
            None,
        );

        let env1 = test_envelope();
        let env2 = test_envelope();
        let result = slot.query_batch(vec![env1, env2]).await;

        assert!(result.is_ok());
        let responses = result.unwrap();
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0].as_ref(), b"response");
        assert_eq!(responses[1].as_ref(), b"response");
    }

    #[tokio::test]
    async fn query_batch_commits_all_handler_writes_in_one_atomic_call() {
        let handle = MockHandle::new();
        let slot = DispatchSlot::with_query_handler(
            "test",
            vec![method("query")],
            handle.clone() as Arc<dyn DispatchHandle>,
            Arc::new(WritingQueryHandler),
            None,
        );

        let responses = slot
            .query_batch(vec![test_envelope(), test_envelope()])
            .await
            .expect("query batch result");

        assert_eq!(responses.len(), 2);
        assert_eq!(handle.atomic_batch_count.load(Ordering::Relaxed), 1);
        assert_eq!(handle.dispatch_count.load(Ordering::Relaxed), 0);
        assert_eq!(
            handle
                .atomically_published
                .lock()
                .expect("published writes lock")
                .len(),
            4
        );
    }

    #[tokio::test]
    async fn query_waits_for_handler_emitted_writes_before_acknowledging() {
        let dispatch_started = Arc::new(tokio::sync::Notify::new());
        let dispatch_release = Arc::new(tokio::sync::Notify::new());
        let handle =
            MockHandle::gated(Arc::clone(&dispatch_started), Arc::clone(&dispatch_release));
        let query_handler = Arc::new(WritingQueryHandler) as Arc<dyn QueryHandler>;
        let slot = Arc::new(DispatchSlot::with_query_handler(
            "test",
            vec![method("query")],
            handle.clone() as Arc<dyn DispatchHandle>,
            query_handler,
            None,
        ));

        let task_slot = Arc::clone(&slot);
        let mut query_task = tokio::spawn(async move { task_slot.query(test_envelope()).await });

        dispatch_started.notified().await;
        let premature =
            tokio::time::timeout(std::time::Duration::from_millis(10), &mut query_task).await;
        assert!(premature.is_err());
        assert_eq!(handle.atomic_batch_count.load(Ordering::Relaxed), 0);
        assert_eq!(handle.dispatch_count.load(Ordering::Relaxed), 0);

        dispatch_release.notify_one();
        let response = query_task.await.expect("query task").expect("query result");
        assert_eq!(response.as_ref(), b"written");
        assert_eq!(handle.atomic_batch_count.load(Ordering::Relaxed), 1);
        assert_eq!(handle.dispatch_count.load(Ordering::Relaxed), 0);
        assert_eq!(
            handle
                .atomically_published
                .lock()
                .expect("published writes lock")
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn query_atomic_batch_failure_publishes_no_partial_writes() {
        let handle = MockHandle::failing_atomic_batch();
        let slot = DispatchSlot::with_query_handler(
            "test",
            vec![method("query")],
            handle.clone() as Arc<dyn DispatchHandle>,
            Arc::new(WritingQueryHandler),
            None,
        );

        let error = slot
            .query(test_envelope())
            .await
            .expect_err("atomic batch must fail");
        assert!(error
            .to_string()
            .contains("atomic query write batch failed"));
        assert_eq!(handle.atomic_batch_count.load(Ordering::Relaxed), 1);
        assert_eq!(handle.dispatch_count.load(Ordering::Relaxed), 0);
        assert!(handle
            .atomically_published
            .lock()
            .expect("published writes lock")
            .is_empty());
    }
}
