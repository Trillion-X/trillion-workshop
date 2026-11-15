//! crates/composition-engine-core/src/kernel/snapshot.rs
//!
//! SnapshotBus - Pub/Sub for kernel snapshot distribution.
//!
//! This module implements a "god level" pub/sub bus for distributing kernel snapshots
//! to any subscriber. It follows the same patterns as InputBus for consistency.
//!
//! # Architecture
//!
//! The SnapshotBus is a global singleton (via lazy_static) that:
//! - Accepts subscribers via indexed handler pattern (same as InputBus)
//! - Publishes snapshots to all active subscribers
//! - Provides latest snapshot to new subscribers immediately
//!
//! # Usage
//!
//! ```ignore
//! use composition_engine_core::kernel::{SNAPSHOT_BUS, SnapshotBus};
//!
//! // Subscribe
//! let id = SNAPSHOT_BUS.write().unwrap().subscribe(Arc::new(|snapshot| {
//!     println!("Got snapshot: {:?}", snapshot.tree.id);
//! }));
//!
//! // Later: unsubscribe
//! SNAPSHOT_BUS.write().unwrap().unsubscribe(id);
//! ```
//!
//! # Thread Safety
//!
//! The global SNAPSHOT_BUS uses RwLock for thread-safe access. In WASM context
//! (single-threaded), this is effectively zero-cost.

use std::sync::{Arc, RwLock};

use super::types::SceneSnapshot;

// These are only used in tests
#[cfg(test)]
use super::types::{Camera, NodeKind, SceneNode};
#[cfg(test)]
use std::collections::HashMap;

// ============================================================================
// Types
// ============================================================================

/// Subscription handle for unsubscribing
pub type SubscriptionId = usize;

/// Subscriber callback type - receives immutable reference to snapshot
pub type SnapshotSubscriber = Arc<dyn Fn(&SceneSnapshot) + Send + Sync>;

// ============================================================================
// SnapshotBus
// ============================================================================

/// SnapshotBus - Manages snapshot pub/sub distribution
///
/// Follows the same indexed handler pattern as InputBus:
/// - Subscribers are stored in a Vec with Option<T>
/// - Subscription ID is the index in the Vec
/// - Unsubscribe sets the slot to None (no vec reallocation)
///
/// # Invariants
///
/// - New subscribers immediately receive the latest snapshot (if available)
/// - Publish notifies all active subscribers synchronously
/// - Subscriber callbacks must not panic (undefined behavior)
pub struct SnapshotBus {
    /// Subscriber storage (indexed by subscription ID)
    subscribers: Vec<Option<SnapshotSubscriber>>,
    /// Next subscription ID to assign
    next_id: SubscriptionId,
    /// Latest snapshot for new subscribers (immediate notification).
    /// Arc-wrapped for O(1) clone instead of full struct copy (Finding 23 — Task 1141).
    latest_snapshot: Option<Arc<SceneSnapshot>>,
}

impl Default for SnapshotBus {
    fn default() -> Self {
        Self::new()
    }
}

impl SnapshotBus {
    /// Create a new empty SnapshotBus
    pub fn new() -> Self {
        Self {
            subscribers: Vec::new(),
            next_id: 0,
            latest_snapshot: None,
        }
    }

    /// Subscribe to snapshot updates
    ///
    /// Returns a subscription ID that can be used to unsubscribe later.
    /// If a snapshot has already been published, the new subscriber is
    /// immediately notified with the latest snapshot.
    ///
    /// # Arguments
    ///
    /// * `subscriber` - Arc-wrapped callback function
    ///
    /// # Returns
    ///
    /// Subscription ID (usize) for use with `unsubscribe()`
    pub fn subscribe(&mut self, subscriber: SnapshotSubscriber) -> SubscriptionId {
        let id = self.next_id;
        self.next_id += 1;

        // Ensure vec is large enough (indexed handler pattern from InputBus)
        if id >= self.subscribers.len() {
            self.subscribers.resize_with(id + 1, || None);
        }
        self.subscribers[id] = Some(subscriber.clone());

        // Immediately notify with latest snapshot if available
        if let Some(ref snapshot) = self.latest_snapshot {
            subscriber(snapshot);
        }

        id
    }

    /// Unsubscribe by ID
    ///
    /// Sets the subscriber slot to None. The slot may be reused in the future
    /// but currently we use monotonically increasing IDs for simplicity.
    ///
    /// # Arguments
    ///
    /// * `id` - Subscription ID returned from `subscribe()`
    pub fn unsubscribe(&mut self, id: SubscriptionId) {
        if id < self.subscribers.len() {
            self.subscribers[id] = None;
        }
    }

    /// Publish a new snapshot to all subscribers
    ///
    /// This is called by `Kernel::frame()` after computing the new snapshot.
    /// All active subscribers are notified synchronously.
    ///
    /// # Arguments
    ///
    /// * `snapshot` - The new scene snapshot to publish
    pub fn publish(&mut self, snapshot: SceneSnapshot) {
        let snapshot = Arc::new(snapshot);
        self.latest_snapshot = Some(Arc::clone(&snapshot));

        for subscriber in self.subscribers.iter().flatten() {
            subscriber(&snapshot);
        }
    }

    /// Get the latest snapshot (for late subscribers)
    ///
    /// Returns None if no snapshot has been published yet.
    pub fn get_latest(&self) -> Option<&SceneSnapshot> {
        self.latest_snapshot.as_deref()
    }

    /// Get active subscriber count (for debugging/monitoring)
    pub fn subscriber_count(&self) -> usize {
        self.subscribers.iter().filter(|s| s.is_some()).count()
    }

    /// Clear all subscribers and reset state (for testing)
    #[cfg(test)]
    pub fn reset(&mut self) {
        self.subscribers.clear();
        self.next_id = 0;
        self.latest_snapshot = None;
    }
}

// ============================================================================
// Global Singleton
// ============================================================================

lazy_static::lazy_static! {
    /// Global SnapshotBus instance
    ///
    /// Thread-safe via RwLock. In WASM context (single-threaded),
    /// this is effectively zero-cost.
    ///
    /// # Usage
    ///
    /// ```ignore
    /// // Write access (subscribe/unsubscribe/publish)
    /// SNAPSHOT_BUS.write().unwrap().subscribe(...);
    ///
    /// // Read access (get_latest/subscriber_count)
    /// SNAPSHOT_BUS.read().unwrap().get_latest();
    /// ```
    pub static ref SNAPSHOT_BUS: RwLock<SnapshotBus> = RwLock::new(SnapshotBus::new());
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Create a minimal test snapshot
    fn create_test_snapshot(root_id: &str) -> SceneSnapshot {
        SceneSnapshot {
            tree: Arc::new(SceneNode::new(root_id, NodeKind::Container)),
            frames: Arc::new(HashMap::new()),
            routing: crate::kernel::RoutingState::default(),
            semantics: HashMap::new(),
            text_inputs: HashMap::new(),
            camera: Camera::default(),
            visible_edge_routes: Vec::new(),
        }
    }

    #[test]
    fn test_new_bus_is_empty() {
        let bus = SnapshotBus::new();
        assert_eq!(bus.subscriber_count(), 0);
        assert!(bus.get_latest().is_none());
    }

    #[test]
    fn test_subscribe_increments_count() {
        let mut bus = SnapshotBus::new();
        let _id = bus.subscribe(Arc::new(move |_| {
            // no-op subscriber
        }));

        assert_eq!(bus.subscriber_count(), 1);
    }

    #[test]
    fn test_subscribe_returns_sequential_ids() {
        let mut bus = SnapshotBus::new();

        let id1 = bus.subscribe(Arc::new(|_| {}));
        let id2 = bus.subscribe(Arc::new(|_| {}));
        let id3 = bus.subscribe(Arc::new(|_| {}));

        assert_eq!(id1, 0);
        assert_eq!(id2, 1);
        assert_eq!(id3, 2);
    }

    #[test]
    fn test_unsubscribe_decrements_count() {
        let mut bus = SnapshotBus::new();

        let id = bus.subscribe(Arc::new(|_| {}));
        assert_eq!(bus.subscriber_count(), 1);

        bus.unsubscribe(id);
        assert_eq!(bus.subscriber_count(), 0);
    }

    #[test]
    fn test_unsubscribe_invalid_id_is_safe() {
        let mut bus = SnapshotBus::new();
        // Should not panic
        bus.unsubscribe(9999);
        assert_eq!(bus.subscriber_count(), 0);
    }

    #[test]
    fn test_publish_stores_latest_snapshot() {
        let mut bus = SnapshotBus::new();
        assert!(bus.get_latest().is_none());

        let snapshot = create_test_snapshot("test-root");
        bus.publish(snapshot.clone());

        let latest = bus.get_latest().unwrap();
        assert_eq!(latest.tree.id, "test-root");
    }

    #[test]
    fn test_publish_notifies_all_subscribers() {
        let mut bus = SnapshotBus::new();

        let count1 = Arc::new(AtomicUsize::new(0));
        let count2 = Arc::new(AtomicUsize::new(0));
        let count3 = Arc::new(AtomicUsize::new(0));

        let c1 = count1.clone();
        let c2 = count2.clone();
        let c3 = count3.clone();

        bus.subscribe(Arc::new(move |_| {
            c1.fetch_add(1, Ordering::SeqCst);
        }));
        bus.subscribe(Arc::new(move |_| {
            c2.fetch_add(1, Ordering::SeqCst);
        }));
        bus.subscribe(Arc::new(move |_| {
            c3.fetch_add(1, Ordering::SeqCst);
        }));

        let snapshot = create_test_snapshot("test-root");
        bus.publish(snapshot);

        assert_eq!(count1.load(Ordering::SeqCst), 1);
        assert_eq!(count2.load(Ordering::SeqCst), 1);
        assert_eq!(count3.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_publish_skips_unsubscribed() {
        let mut bus = SnapshotBus::new();

        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();

        let id = bus.subscribe(Arc::new(move |_| {
            c.fetch_add(1, Ordering::SeqCst);
        }));

        // Unsubscribe before publishing
        bus.unsubscribe(id);

        let snapshot = create_test_snapshot("test-root");
        bus.publish(snapshot);

        // Should not have been called
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn test_new_subscriber_gets_latest_immediately() {
        let mut bus = SnapshotBus::new();

        // Publish first
        let snapshot = create_test_snapshot("initial-root");
        bus.publish(snapshot);

        // Then subscribe - should get immediate notification
        let received = Arc::new(AtomicUsize::new(0));
        let r = received.clone();

        bus.subscribe(Arc::new(move |_| {
            r.fetch_add(1, Ordering::SeqCst);
        }));

        // Should have been called immediately with latest
        assert_eq!(received.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_subscriber_receives_correct_snapshot_data() {
        let mut bus = SnapshotBus::new();

        let received_id = Arc::new(std::sync::Mutex::new(String::new()));
        let r = received_id.clone();

        bus.subscribe(Arc::new(move |snapshot| {
            *r.lock().unwrap() = snapshot.tree.id.clone();
        }));

        let snapshot = create_test_snapshot("my-specific-id");
        bus.publish(snapshot);

        assert_eq!(*received_id.lock().unwrap(), "my-specific-id");
    }

    #[test]
    fn test_multiple_publishes_update_latest() {
        let mut bus = SnapshotBus::new();

        bus.publish(create_test_snapshot("first"));
        assert_eq!(bus.get_latest().unwrap().tree.id, "first");

        bus.publish(create_test_snapshot("second"));
        assert_eq!(bus.get_latest().unwrap().tree.id, "second");

        bus.publish(create_test_snapshot("third"));
        assert_eq!(bus.get_latest().unwrap().tree.id, "third");
    }

    #[test]
    fn test_multiple_publishes_notify_subscribers_each_time() {
        let mut bus = SnapshotBus::new();

        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();

        bus.subscribe(Arc::new(move |_| {
            c.fetch_add(1, Ordering::SeqCst);
        }));

        bus.publish(create_test_snapshot("1"));
        bus.publish(create_test_snapshot("2"));
        bus.publish(create_test_snapshot("3"));

        assert_eq!(count.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn test_global_bus_accessible() {
        // Reset global bus state for test isolation
        {
            let mut bus = SNAPSHOT_BUS.write().unwrap();
            bus.reset();
        }

        // Verify clean state
        {
            let bus = SNAPSHOT_BUS.read().unwrap();
            assert_eq!(bus.subscriber_count(), 0);
            assert!(bus.get_latest().is_none());
        }

        // Subscribe via global
        let id = {
            let mut bus = SNAPSHOT_BUS.write().unwrap();
            bus.subscribe(Arc::new(|_| {}))
        };

        // Verify subscription
        {
            let bus = SNAPSHOT_BUS.read().unwrap();
            assert_eq!(bus.subscriber_count(), 1);
        }

        // Cleanup
        {
            let mut bus = SNAPSHOT_BUS.write().unwrap();
            bus.unsubscribe(id);
            bus.reset();
        }
    }
}
