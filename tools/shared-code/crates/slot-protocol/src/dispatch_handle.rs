//! DispatchHandle — the protocol-level abstraction for Envelope engine operations.
//!
//! This trait defines the PUBLIC API surface for communicating with an Envelope engine.
//! It uses ONLY protocol-level types (PartitionKey, FactAddress, Hash, EnvelopeError)
//! that live in slot-protocol. The concrete implementation (channel serialization,
//! actor commands, oneshot replies) stays in envelope-engine.
//!
//! # Why This Exists
//!
//! DispatchSlot needs to call dispatch_rewrite(). Without this trait, DispatchSlot
//! would depend on EnvelopeEngineHandle directly, which lives in envelope-engine.
//! Since envelope-engine depends on slot-protocol, that creates a cycle.
//!
//! This trait breaks the cycle: slot-protocol defines the contract, envelope-engine
//! implements it. DispatchSlot depends on the trait (in its own crate), not the
//! concrete handle (in a downstream crate).
//!
//! # Invariants
//!
//! 1. Zero imports from envelope-engine — only slot-protocol types
//! 2. All methods return boxed futures (no async-trait dep needed)
//! 3. Send + Sync + Clone — handles are shared across threads
//! 4. Implementors own the async/channel/actor details internally

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::{
    Envelope, EnvelopeError, EnvelopeSelector, FactAddress, Hash, LiveStateEntry, PartitionKey,
    PathSegment, SubscriptionContentMode,
};
use content_crypto::Multihash;

/// Opaque byte position in one Engine causal log.
///
/// The numeric representation is intentionally private: record counts, transfer
/// frame lengths, and CAS payload bytes cannot be compared with or added to a
/// log cursor accidentally. Only the Engine creates authoritative progress;
/// consumers may persist and return the value unchanged.
#[derive(
    Debug,
    Clone,
    Copy,
    Default,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    serde::Serialize,
    serde::Deserialize,
)]
#[serde(transparent)]
pub struct LogCursor(u64);

impl LogCursor {
    pub const ZERO: Self = Self(0);

    #[inline]
    pub const fn from_byte_offset(byte_offset: u64) -> Self {
        Self(byte_offset)
    }

    #[inline]
    pub const fn byte_offset(self) -> u64 {
        self.0
    }
}

impl std::fmt::Display for LogCursor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

impl std::ops::Sub for LogCursor {
    type Output = u64;

    #[inline]
    fn sub(self, rhs: Self) -> Self::Output {
        self.0
            .checked_sub(rhs.0)
            .expect("LogCursor subtraction requires an ordered range")
    }
}

/// Everything a peer holding `have_root` is missing in order to read `root`.
///
/// This is the entire mesh wire shape. A store's state is one content hash, so
/// two machines converge by trading hashes: the asker says what it holds, the
/// answerer says what it lacks. The map shares subtrees by hash, so a store
/// that changed in one place answers with one path of nodes whatever its size,
/// and a peer that was away for a thousand commits pays for what differs rather
/// than for the thousand commits.
///
/// Nothing here is opaque and nothing needs trusting. Each piece is stored at
/// the hash of its own bytes, which the receiver recomputes, so a sender cannot
/// make a receiver store bytes under a name they do not hash to. There is no
/// cursor to keep and no sequence to resume.
///
/// There IS one piece of per-peer state, and the claim that there was none was
/// the bug: ONE hash per peer, on the RECEIVER, naming the newest version of
/// that peer's data this store has read. It costs nothing and it buys the
/// property the rest of this design promises, that a peer can vanish for months
/// and come back with one hash, because it is the only thing that survives the
/// version ring rolling over. It lives on the receiver and is keyed by the
/// identity the receiver's own transport supplies, so no sender ever names
/// itself and no store has to invent an identity nothing granted it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootDiff {
    /// The root the receiver said it holds. `None` is a peer holding nothing,
    /// and the diff against nothing is the whole store: the same operation,
    /// never a separate bootstrap path.
    pub have_root: Option<Multihash>,
    /// The root the receiver can read once every piece below is stored.
    pub root: Multihash,
    /// The index nodes it lacks, each paired with the hash it must store it at.
    ///
    /// Kept apart from `payloads` because they are read differently: a node is
    /// decoded to find its children, a payload is opaque. One mixed list would
    /// force the receiver to identify pieces by trying to decode them, so a
    /// payload that happened to be undecodable would read as a corrupt node.
    pub nodes: Vec<(Multihash, Vec<u8>)>,
    /// The record contents those nodes name at their leaves, same pairing.
    pub payloads: Vec<(Multihash, Vec<u8>)>,
    /// The whole-store versions the SENDER still keeps, newest first.
    ///
    /// This is what makes a merge safe, and leaving it out is a silent
    /// data-loss bug rather than a missing optimisation. To merge, the receiver
    /// must know a root BOTH sides once held: against that ancestor, a record
    /// missing from the sender means the sender deleted it, while without one
    /// it means only that the sender never had it. Reading the second case as
    /// the first deletes the receiver's own records.
    ///
    /// `have_root` cannot serve: it is what the receiver holds NOW, which
    /// already includes the receiver's own newer writes. The receiver picks the
    /// newest entry here that it also still keeps.
    ///
    /// This is the SECOND place a receiver looks, not the first, and it is a
    /// ring, so it answers only for a peer that has been away a few commits.
    /// The first place is what the receiver REMEMBERS about this peer, keyed by
    /// the identity its own transport supplies to `sync_mesh`, which has no
    /// such horizon. No answer from either means no shared history is provable,
    /// and the merge unions both sides without deleting.
    ///
    /// A handful of hashes, so it costs nothing next to the nodes.
    pub kept_roots: Vec<Multihash>,
}

// THERE WAS A `saved_at: u64` HERE and it is worth saying what it was, because
// the name will occur to someone again. It was documented as "the sender's
// clock when it saved `root`", used to settle a record when no shared ancestor
// could be proved, on the reasoning that the causally later root should win.
//
// It was not a clock. Every sender filled it with its own `next_ordinal`, which
// counts how many writes THAT machine has ever done, and the receiver compared
// it against its own. A store that had written a million records beat a store
// that had written ten, on every contested record, forever, however long ago
// either write actually happened. Three of the four places that built a diff
// filled it with a literal `0`, so those diffs lost every contest they entered.
//
// Content settles a contested record now, ancestor or not, and the version that
// does not win is kept beside the winner as a conflict rather than dropped. A
// number that looks like a clock and is not one is worse than no clock, because
// it stops anyone looking for a real one.

impl RootDiff {
    /// Bytes this diff puts on the wire.
    pub fn byte_len(&self) -> usize {
        let piece_bytes = |pieces: &Vec<(Multihash, Vec<u8>)>| -> usize {
            pieces.iter().map(|(_, bytes)| bytes.len()).sum()
        };
        piece_bytes(&self.nodes) + piece_bytes(&self.payloads)
    }
}

/// Object-safe visitor for direct caller-thread read views.
///
/// The engine owns the backing storage and controls the borrow lifetime. The
/// visitor consumes the view synchronously inside the call without forcing the
/// protocol contract to materialize an owned Envelope first.
pub trait DirectReadVisitor {
    fn visit(
        &mut self,
        partition: &PartitionKey,
        address: &FactAddress,
        path: &[PathSegment],
        payload: &[u8],
        payload_hash: &Hash,
    ) -> Result<(), EnvelopeError>;
}

/// Control signal for bounded live-state scans.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveStateScanControl {
    Continue,
    Stop,
}

/// Visitor for bounded current-state scans.
///
/// The engine owns the backing storage. `payload` is `None` for hash-only scans
/// and `Some(&[u8])` only when the request explicitly asks for inline bytes.
pub trait LiveStateScanVisitor {
    fn visit(
        &mut self,
        partition: &PartitionKey,
        address: &FactAddress,
        path: &[PathSegment],
        payload_hash: &Hash,
        payload: Option<&[u8]>,
    ) -> Result<LiveStateScanControl, EnvelopeError>;
}

/// One bounded read from content-addressed storage.
///
/// `total_len` is the full immutable representation length; `bytes` is only the
/// requested window. Returning the denominator alongside the window lets the
/// caller prove clamping without a second metadata read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CasRangeRead {
    pub total_len: u64,
    pub bytes: Vec<u8>,
}

/// Protocol-level handle for dispatching Envelope operations.
///
/// Concrete implementation lives in envelope-engine (EnvelopeEngineHandle).
/// Consumers depend on this trait, never on the concrete handle.
pub trait DispatchHandle: Send + Sync {
    /// Dispatch a rewrite (write path).
    ///
    /// Atomically writes a payload to the target address in the given partition.
    /// Returns a receipt hash proving durability.
    ///
    /// `path` carries transient in-memory mutation-facet routing metadata — it rides
    /// on the Delta broadcast to subscribers but is NOT persisted to disk. Writers
    /// populate this with changed property PathSegments so the edge driver can route
    /// at property-level granularity (O(1) per changed property) instead of
    /// entity-level. Pass `vec![]` for entity-level-only writes.
    fn dispatch_rewrite(
        &self,
        partition: PartitionKey,
        target: FactAddress,
        payload: Option<Vec<u8>>,
        path: Vec<PathSegment>,
    ) -> Pin<Box<dyn Future<Output = Result<Hash, EnvelopeError>> + Send + '_>>;

    /// Dispatch a rewrite with an optional current-value guard.
    ///
    /// `expected_current_payload_hash = None` means unguarded write.
    /// `Some(None)` means the address must currently be absent.
    /// `Some(Some(hash))` means the address must currently exist with that
    /// payload hash. Implementations backed by a single-writer actor should
    /// validate this inside the same ordered write command that applies the
    /// rewrite. The default keeps mock handles and simple adapters correct, but
    /// it is not a substitute for actor-local compare-and-write in production.
    fn dispatch_rewrite_with_expected_current(
        &self,
        partition: PartitionKey,
        target: FactAddress,
        payload: Option<Vec<u8>>,
        path: Vec<PathSegment>,
        expected_current_payload_hash: Option<Option<Hash>>,
    ) -> Pin<Box<dyn Future<Output = Result<Hash, EnvelopeError>> + Send + '_>> {
        Box::pin(async move {
            if let Some(expected_payload_hash) = expected_current_payload_hash {
                let current = self
                    .read_envelope(partition.clone(), target.clone())
                    .await?;
                let current_payload_hash = current.and_then(|envelope| envelope.payload_hash);
                if current_payload_hash != expected_payload_hash {
                    return Err(EnvelopeError::ExpectedCurrentMismatch);
                }
            }
            self.dispatch_rewrite(partition, target, payload, path)
                .await
        })
    }

    /// Apply a set of guarded rewrites as one all-or-nothing engine mutation.
    ///
    /// This is deliberately the same write vocabulary as `WriteEntry`, not a
    /// second mutation protocol.  Implementations that own a single-writer
    /// actor validate every guard against one actor-local overlay and publish
    /// either every entry or none.  The default is fail-closed: silently
    /// degrading a requested atomic mutation into sequential rewrites would
    /// violate the caller's durability contract.
    fn dispatch_write_batch_atomic(
        &self,
        _entries: Vec<crate::handler::WriteEntry>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Hash>, EnvelopeError>> + Send + '_>> {
        Box::pin(async { Err(EnvelopeError::NotSupported) })
    }

    /// Apply guarded rewrites only when every independent current-value
    /// precondition still matches in the same actor-local atomic decision.
    ///
    /// Preconditions publish no record. The default delegates only when the
    /// assertion set is empty; silently emulating assertions with reads before
    /// writes would reopen the compare/apply race this primitive closes.
    fn dispatch_write_batch_atomic_with_preconditions(
        &self,
        entries: Vec<crate::handler::WriteEntry>,
        preconditions: Vec<crate::handler::WritePrecondition>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Hash>, EnvelopeError>> + Send + '_>> {
        if preconditions.is_empty() {
            return self.dispatch_write_batch_atomic(entries);
        }
        Box::pin(async { Err(EnvelopeError::NotSupported) })
    }

    /// Read a single Envelope from active state (read path).
    ///
    /// O(1) lookup by partition + address. Returns None if address not found or retracted.
    fn read_envelope(
        &self,
        partition: PartitionKey,
        address: FactAddress,
    ) -> Pin<Box<dyn Future<Output = Result<Option<Envelope>, EnvelopeError>> + Send + '_>>;

    /// Read one bounded window from the partition-independent CAS content log.
    ///
    /// `Ok(None)` means the exact content hash is absent. A default unsupported
    /// response keeps narrow test/adaptor handles valid without silently
    /// pretending they own CAS bytes.
    fn read_cas_range<'a>(
        &'a self,
        _hash: &'a str,
        _offset: u64,
        _length: Option<u64>,
    ) -> Pin<Box<dyn Future<Output = Result<Option<CasRangeRead>, EnvelopeError>> + Send + 'a>>
    {
        Box::pin(async { Err(EnvelopeError::NotSupported) })
    }

    /// Visit a direct caller-thread read view when the implementation can
    /// expose one without materializing an owned Envelope first.
    ///
    /// Returns:
    /// - `Ok(true)` if the address exists and the visitor ran
    /// - `Ok(false)` if the address is missing/retracted
    /// - `Err(...)` on engine/storage failure
    fn visit_direct_read(
        &self,
        partition: &PartitionKey,
        address: &FactAddress,
        visitor: &mut dyn DirectReadVisitor,
    ) -> Result<bool, EnvelopeError>;

    /// List the entire current live state for a partition.
    ///
    /// Returns current-state entries carrying the authoritative live content
    /// hash, durable path metadata, and current payload bytes.
    fn list_live_state(
        &self,
        partition: PartitionKey,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<LiveStateEntry>, EnvelopeError>> + Send + '_>>;

    /// Visit current live entries matching a selector without materializing a
    /// whole partition snapshot first.
    ///
    /// Implementations should apply address/path filters before touching payload
    /// bytes. The visitor receives borrowed engine-owned bytes synchronously
    /// inside the call, so callers can encode/process the stream without cloning
    /// unrelated state.
    fn visit_live_state(
        &self,
        partition: &PartitionKey,
        selector: &EnvelopeSelector,
        visitor: &mut dyn DirectReadVisitor,
    ) -> Result<(), EnvelopeError>;

    /// Scan current live entries matching a selector from an opaque cursor.
    ///
    /// `content` controls whether payload bytes are hydrated. Hash-only scans
    /// never touch payload bytes; they expose the same pointer shape as live
    /// delta asserts plus durable path metadata. The returned cursor is opaque
    /// to callers and should only be passed back to continue the same selector.
    fn scan_live_state(
        &self,
        partition: &PartitionKey,
        selector: &EnvelopeSelector,
        cursor: u64,
        content: SubscriptionContentMode,
        visitor: &mut dyn LiveStateScanVisitor,
    ) -> Result<Option<u64>, EnvelopeError>;

    /// Scan current live entries with extracted-field equality hints.
    ///
    /// Hints are selectivity-only (see `LiveStateFieldEq`): implementations
    /// with a covering index visit only hint-matching entries; the default
    /// ignores the hints and delegates to `scan_live_state`, which is correct
    /// because consumers must evaluate their own predicates over the reply.
    fn scan_live_state_with_field_eq(
        &self,
        partition: &PartitionKey,
        selector: &EnvelopeSelector,
        _field_eq: &[crate::LiveStateFieldEq],
        cursor: u64,
        content: SubscriptionContentMode,
        visitor: &mut dyn LiveStateScanVisitor,
    ) -> Result<Option<u64>, EnvelopeError> {
        self.scan_live_state(partition, selector, cursor, content, visitor)
    }

    /// Subscribe to cursor advances (mesh sync notification primitive).
    ///
    /// The callback fires synchronously on the engine's actor thread each time
    /// new data is committed. Callers should forward to a channel, never block.
    fn subscribe_cursor(
        &self,
        partition: PartitionKey,
        callback: Arc<dyn Fn(LogCursor) + Send + Sync>,
    ) -> Pin<Box<dyn Future<Output = Result<(), EnvelopeError>> + Send + '_>>;

    /// The current root of this partition: one content hash naming its whole
    /// state. A peer sends this to ask what it is missing.
    fn current_root(
        &self,
        partition: PartitionKey,
    ) -> Pin<Box<dyn Future<Output = Result<Multihash, EnvelopeError>> + Send + '_>>;

    /// Everything a peer holding `have_root` needs in order to read our root.
    ///
    /// Costs what changed between the two roots, never what the store holds.
    fn root_diff(
        &self,
        partition: PartitionKey,
        have_root: Option<Multihash>,
    ) -> Pin<Box<dyn Future<Output = Result<RootDiff, EnvelopeError>> + Send + '_>>;

    /// Take in a peer's diff and converge with it.
    ///
    /// The engine stores every piece at the hash of its own bytes, confirms the
    /// peer's root now reads, and merges it with its own against the newest
    /// root both are known to have held. Both machines running this over the
    /// same roots reach the same answer, so convergence needs no coordinator.
    ///
    /// Returns the root this engine settled on. Applying the same diff twice
    /// returns the same root and writes nothing the second time.
    /// `from_peer` is who this diff came from, as the CALLER'S OWN transport
    /// knows them. Opaque bytes the store never parses. It keys the newest
    /// version of that peer's data the store has read, which is the only thing
    /// that tells "you deleted this" apart from "you never had this" once the
    /// version ring has rolled past whatever the two sides last shared. Pass
    /// `None` only for a one-off import from something that will not be back;
    /// an anonymous sender gets no memory, so its next visit cannot resolve a
    /// deletion and both sides are unioned instead.
    fn sync_mesh(
        &self,
        target_partition: PartitionKey,
        from_peer: Option<Vec<u8>>,
        diff: RootDiff,
    ) -> Pin<Box<dyn Future<Output = Result<Multihash, EnvelopeError>> + Send + '_>>;

    /// Get the current end-of-log cursor for a partition.
    ///
    /// Used by peers to initialize their cursor position on first connect.
    fn current_cursor(
        &self,
        partition: PartitionKey,
    ) -> Pin<Box<dyn Future<Output = Result<LogCursor, EnvelopeError>> + Send + '_>>;

    /// Clone this handle into a type-erased Arc.
    ///
    /// Required because `Clone` is not object-safe. Implementors return
    /// `Arc::new(self.clone())`.
    fn clone_handle(&self) -> Arc<dyn DispatchHandle>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Mock handle for testing — counts dispatches, returns deterministic receipts.
    struct MockHandle {
        dispatch_count: Arc<AtomicU32>,
    }

    impl MockHandle {
        fn new() -> Self {
            Self {
                dispatch_count: Arc::new(AtomicU32::new(0)),
            }
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
            self.dispatch_count.fetch_add(1, Ordering::Relaxed);
            let receipt = Hash::from_multihash(target.as_multihash().clone());
            Box::pin(async move { Ok(receipt) })
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
            _visitor: &mut dyn DirectReadVisitor,
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
            _selector: &EnvelopeSelector,
            _visitor: &mut dyn DirectReadVisitor,
        ) -> Result<(), EnvelopeError> {
            Ok(())
        }

        fn scan_live_state(
            &self,
            _partition: &PartitionKey,
            _selector: &EnvelopeSelector,
            _cursor: u64,
            _content: SubscriptionContentMode,
            _visitor: &mut dyn LiveStateScanVisitor,
        ) -> Result<Option<u64>, EnvelopeError> {
            Ok(None)
        }

        fn subscribe_cursor(
            &self,
            _partition: PartitionKey,
            _callback: Arc<dyn Fn(LogCursor) + Send + Sync>,
        ) -> Pin<Box<dyn Future<Output = Result<(), EnvelopeError>> + Send + '_>> {
            Box::pin(async move { Ok(()) })
        }

        fn current_root(
            &self,
            _partition: PartitionKey,
        ) -> Pin<Box<dyn Future<Output = Result<Multihash, EnvelopeError>> + Send + '_>> {
            Box::pin(async move { Ok(Multihash::blake3(b"stub-root")) })
        }

        fn root_diff(
            &self,
            _partition: PartitionKey,
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
            _target_partition: PartitionKey,
            _from_peer: Option<Vec<u8>>,
            diff: RootDiff,
        ) -> Pin<Box<dyn Future<Output = Result<Multihash, EnvelopeError>> + Send + '_>> {
            Box::pin(async move { Ok(diff.root) })
        }

        fn current_cursor(
            &self,
            _partition: PartitionKey,
        ) -> Pin<Box<dyn Future<Output = Result<LogCursor, EnvelopeError>> + Send + '_>> {
            Box::pin(async move { Ok(LogCursor::ZERO) })
        }

        fn clone_handle(&self) -> Arc<dyn DispatchHandle> {
            Arc::new(MockHandle {
                dispatch_count: Arc::clone(&self.dispatch_count),
            })
        }
    }

    #[test]
    fn mock_handle_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<MockHandle>();
    }

    #[tokio::test]
    async fn dispatch_rewrite_returns_receipt() {
        let handle = MockHandle::new();
        let partition = PartitionKey::from_digest(0x1F, vec![1u8; 32]);
        let target = FactAddress::from_digest(0x1F, vec![2u8; 32]);
        let result = handle
            .dispatch_rewrite(partition, target, None, vec![])
            .await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), Hash::from_bytes([2u8; 32]));
    }

    #[tokio::test]
    async fn dispatch_count_increments() {
        let handle = MockHandle::new();
        let partition = PartitionKey::from_digest(0x1F, vec![1u8; 32]);
        let target = FactAddress::from_digest(0x1F, vec![2u8; 32]);
        handle
            .dispatch_rewrite(partition.clone(), target.clone(), None, vec![])
            .await
            .unwrap();
        handle
            .dispatch_rewrite(partition, target, Some(vec![1]), vec![])
            .await
            .unwrap();
        assert_eq!(handle.dispatch_count.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn read_envelope_returns_none_for_missing() {
        let handle = MockHandle::new();
        let result = handle
            .read_envelope(
                PartitionKey::from_digest(0x1F, vec![1u8; 32]),
                FactAddress::from_digest(0x1F, vec![2u8; 32]),
            )
            .await;
        assert!(matches!(result, Ok(None)));
    }

    #[test]
    fn clone_handle_produces_independent_arc() {
        let handle = MockHandle::new();
        let cloned: Arc<dyn DispatchHandle> = handle.clone_handle();
        // Both exist independently
        drop(handle);
        // cloned still valid
        let _ = cloned;
    }

    #[test]
    fn trait_object_works() {
        let handle: Arc<dyn DispatchHandle> = Arc::new(MockHandle::new());
        let _cloned = handle.clone_handle();
    }
}
