//! Subscription selector and delta types for Envelope-based communication.
//!
//! These types define HOW slots declare what they want to receive (EnvelopeSelector)
//! and WHAT changes look like when delivered (Delta).

use crate::newtypes::{FactAddress, Hash, PathSegment};
use serde::{Deserialize, Serialize};

/// A single assertion in a Delta — CAS-native change notification.
///
/// Carries the target address and the content hash (CAS reference).
/// Subscribers that need the actual payload bytes resolve from CAS
/// asynchronously on their own thread. The actor NEVER touches payload bytes.
///
/// **L099 evaporating cloud:** The assumption "subscribers need full payload
/// pushed immediately" is Society. In a CAS system, subscribers need to know
/// THAT data changed and WHERE to find it (the hash). The actor's job is
/// notification, not payload delivery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeltaAssert {
    /// The fact address that was asserted/updated.
    pub address: FactAddress,
    /// Content hash — CAS reference for payload retrieval.
    pub content_hash: Hash,
}

/// A single current-state entry returned from the engine's live snapshot path.
///
/// This is the boot-time equivalent of a delta assert: authoritative address +
/// content hash from engine state, plus the durable path metadata and current
/// payload bytes. Boot hydration must see the same path information that live
/// delta filtering already sees, otherwise path-family subscriptions only work
/// after boot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveStateEntry {
    pub assert: DeltaAssert,
    pub path: Vec<PathSegment>,
    pub payload: Vec<u8>,
}

/// A payload-free current-state pointer.
///
/// This is the current-state sibling of `DeltaAssert`: address + authoritative
/// content hash + durable path metadata. Consumers use it to filter live state
/// without materializing payload bytes for entries they will not use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveStatePointer {
    pub assert: DeltaAssert,
    pub path: Vec<PathSegment>,
}

impl LiveStateEntry {
    pub fn pointer(&self) -> LiveStatePointer {
        LiveStatePointer {
            assert: self.assert.clone(),
            path: self.path.clone(),
        }
    }
}

/// A half-open cursor interval `[from_cursor, to_cursor)` of deltas the
/// subscriber did NOT receive.
///
/// **Delivery-integrity contract (delta-delivery-integrity plan):** delivery
/// loss is never silent. When a subscriber's bounded queue overflows, or the
/// dispatcher's hot-history replay window has already dropped the interval,
/// the subscriber receives a gap sentinel instead of nothing. Consumers that
/// understand gaps treat them as stream invalidation for the interval
/// (selector-scoped current-state reconciliation, or a durable loss record).
/// Consumers that do not understand gaps must fail closed, never no-op.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeltaGap {
    /// First hot-history delta position that was lost (inclusive).
    pub from_cursor: u64,
    /// One past the last lost position (exclusive).
    pub to_cursor: u64,
}

/// A Delta represents a batch of changes (assertions and retractions).
/// This is the unit published to subscribers via broadcast().
///
/// **CAS-native contract (Wave 3):** Assertions carry (address, hash) pairs —
/// zero payload bytes. Subscribers resolve bytes from CAS on demand.
/// This keeps the actor's critical path at ~100ns regardless of payload size.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delta {
    /// Asserted facts — CAS references (address + content hash), never raw bytes.
    /// Subscribers that need payload bytes resolve from CAS on their own thread.
    pub asserts: Vec<DeltaAssert>,

    /// Retracted fact addresses (removals from state)
    pub retracts: Vec<FactAddress>,

    /// Partition ID for filtering subscriptions by logical shard
    pub partition: u32,

    /// Path segments for hierarchical routing filtering
    /// Empty = no path filtering (all paths accepted)
    pub path: Vec<PathSegment>,

    /// Delivery-gap sentinel. `Some` marks this delta as a gap notification:
    /// the subscriber missed the deltas in the interval. Gap deltas carry no
    /// asserts/retracts and are delivered BYPASSING selector matching (an
    /// empty-assert delta would be rejected by address/path filters, and a
    /// loss signal must never be filterable).
    pub gap: Option<DeltaGap>,
}

impl Delta {
    /// Create a new Delta with the given assertions and retractions.
    pub fn new(asserts: Vec<DeltaAssert>, retracts: Vec<FactAddress>) -> Self {
        Self {
            asserts,
            retracts,
            partition: 0,
            path: vec![],
            gap: None,
        }
    }

    /// Create a Delta with explicit partition ID.
    pub fn with_partition(
        asserts: Vec<DeltaAssert>,
        retracts: Vec<FactAddress>,
        partition: u32,
    ) -> Self {
        Self {
            asserts,
            retracts,
            partition,
            path: vec![],
            gap: None,
        }
    }

    /// Create a Delta with explicit partition ID and path segments.
    pub fn with_partition_and_path(
        asserts: Vec<DeltaAssert>,
        retracts: Vec<FactAddress>,
        partition: u32,
        path: Vec<PathSegment>,
    ) -> Self {
        Self {
            asserts,
            retracts,
            partition,
            path,
            gap: None,
        }
    }

    /// Create a gap-sentinel Delta for the half-open interval
    /// `[from_cursor, to_cursor)`. Carries no asserts/retracts.
    pub fn gap(from_cursor: u64, to_cursor: u64) -> Self {
        Self {
            asserts: vec![],
            retracts: vec![],
            partition: 0,
            path: vec![],
            gap: Some(DeltaGap {
                from_cursor,
                to_cursor,
            }),
        }
    }

    /// True when this delta is a delivery-gap sentinel.
    pub fn is_gap(&self) -> bool {
        self.gap.is_some()
    }
}

/// Selector for filtering which Deltas a subscriber receives.
///
/// **Plan P7:** Selectors are compiled at subscribe time into a fast matching
/// structure. At notification time, matching is O(1) per subscriber via
/// partition + address filtering. Selectors support:
/// - Partition filter (logical sharding)
/// - Address set filter (specific entity addresses)
/// - Path prefix filter (hierarchical routing)
/// - Capability set filter (authorization labels)
///
/// Pass-all selectors (partition=None, addresses=empty, path_prefix=None) match everything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvelopeSelector {
    /// Partition filter: if Some, only Deltas with matching partition are accepted.
    partition: Option<u32>,

    /// Address filter: if non-empty, only Deltas touching these addresses are accepted.
    address_filter: Vec<FactAddress>,

    /// Path prefix filter: if Some, only Deltas with paths starting with this prefix are accepted.
    path_prefix: Option<Vec<PathSegment>>,

    /// Path segment filter: if non-empty, only entries/deltas whose path contains
    /// at least one listed segment are accepted.
    path_segment_filter: Vec<PathSegment>,
}

/// Bootstrap policy for subscribed slot hydration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionBootstrapMode {
    None,
    #[default]
    SelectorState,
    AllState,
}

/// Content hydration policy for subscribed slot delta delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionContentMode {
    #[default]
    Inline,
    HashOnly,
}

/// Owner of current-state reconciliation after a live-delivery gap.
///
/// Most read models need the composition root to redeliver their bootstrap
/// slice because they cannot repair a missed interval themselves. Stateful
/// consumers that already reconcile through the generic live-state owner must
/// opt out of that duplicate snapshot; otherwise their recovery work can write
/// new deltas faster than their bounded subscription queue drains and create a
/// self-sustaining gap loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionGapRecovery {
    #[default]
    RunnerRehydratesBootstrap,
    ConsumerReconcilesCurrentState,
}

fn default_wait_until_initial_delivery_finishes() -> bool {
    true
}

/// Exact runtime subscription contract for a subscribed slot.
///
/// `EnvelopeSelector` is the coarse engine-side gate for future delta batches.
/// `SlotSubscription` is the per-slot contract used by the composition-root
/// delta forwarder for both boot hydration and exact per-slot payload filtering.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotSubscription {
    #[serde(default)]
    pub bootstrap: SubscriptionBootstrapMode,
    #[serde(default)]
    pub content: SubscriptionContentMode,
    #[serde(default)]
    pub gap_recovery: SubscriptionGapRecovery,
    #[serde(default = "default_wait_until_initial_delivery_finishes")]
    pub wait_until_initial_delivery_finishes: bool,
    #[serde(default)]
    pub bootstrap_addresses: Vec<FactAddress>,
    #[serde(default)]
    pub bootstrap_path_prefix: Vec<PathSegment>,
    #[serde(default)]
    pub bootstrap_path_segments: Vec<PathSegment>,
    #[serde(default)]
    pub live_addresses: Vec<FactAddress>,
    #[serde(default)]
    pub live_path_prefix: Vec<PathSegment>,
    #[serde(default)]
    pub live_path_segments: Vec<PathSegment>,
}

impl SlotSubscription {
    pub fn live_selector(&self) -> EnvelopeSelector {
        EnvelopeSelector::with_address_path_filters(
            None,
            self.live_addresses.clone(),
            if self.live_path_prefix.is_empty() {
                None
            } else {
                Some(self.live_path_prefix.clone())
            },
            self.live_path_segments.clone(),
        )
    }

    pub fn wants_bootstrap_entry(&self, entry: &LiveStateEntry) -> bool {
        self.wants_bootstrap_pointer(&entry.pointer())
    }

    pub fn wants_bootstrap_pointer(&self, pointer: &LiveStatePointer) -> bool {
        match self.bootstrap {
            SubscriptionBootstrapMode::None => false,
            SubscriptionBootstrapMode::AllState => true,
            SubscriptionBootstrapMode::SelectorState => self.matches_selector(
                &self.bootstrap_addresses,
                &self.bootstrap_path_prefix,
                &self.bootstrap_path_segments,
                &pointer.assert.address,
                &pointer.path,
            ),
        }
    }

    pub fn matches_live_assert(&self, assert: &DeltaAssert, path: &[PathSegment]) -> bool {
        self.matches_selector(
            &self.live_addresses,
            &self.live_path_prefix,
            &self.live_path_segments,
            &assert.address,
            path,
        )
    }

    pub fn matches_retract(&self, address: &FactAddress, path: &[PathSegment]) -> bool {
        self.matches_selector(
            &self.live_addresses,
            &self.live_path_prefix,
            &self.live_path_segments,
            address,
            path,
        )
    }

    pub fn inlines_content(&self) -> bool {
        self.content == SubscriptionContentMode::Inline
    }

    pub fn runner_rehydrates_bootstrap_after_gap(&self) -> bool {
        self.gap_recovery == SubscriptionGapRecovery::RunnerRehydratesBootstrap
    }

    fn matches_selector(
        &self,
        addresses: &[FactAddress],
        path_prefix: &[PathSegment],
        path_segments: &[PathSegment],
        address: &FactAddress,
        path: &[PathSegment],
    ) -> bool {
        self.matches_address(addresses, address)
            && self.matches_path_prefix(path_prefix, path)
            && self.matches_path_segments(path_segments, path)
    }

    fn matches_address(&self, addresses: &[FactAddress], address: &FactAddress) -> bool {
        addresses.is_empty() || addresses.iter().any(|candidate| candidate == address)
    }

    fn matches_path_prefix(&self, prefix: &[PathSegment], path: &[PathSegment]) -> bool {
        if prefix.is_empty() {
            return true;
        }
        path.starts_with(prefix)
    }

    fn matches_path_segments(&self, required: &[PathSegment], path: &[PathSegment]) -> bool {
        required.is_empty()
            || path
                .iter()
                .any(|segment| required.iter().any(|candidate| candidate == segment))
    }
}

impl EnvelopeSelector {
    /// Create a selector that matches all Deltas (pass-all mode).
    pub fn all() -> Self {
        Self {
            partition: None,
            address_filter: vec![],
            path_prefix: None,
            path_segment_filter: vec![],
        }
    }

    /// Create a selector that matches only a specific partition.
    pub fn for_partition(partition: u32) -> Self {
        Self {
            partition: Some(partition),
            address_filter: vec![],
            path_prefix: None,
            path_segment_filter: vec![],
        }
    }

    /// Create a selector for specific addresses within a partition.
    pub fn for_addresses(partition: Option<u32>, addresses: Vec<FactAddress>) -> Self {
        Self {
            partition,
            address_filter: addresses,
            path_prefix: None,
            path_segment_filter: vec![],
        }
    }

    /// Create a selector for a specific path prefix.
    pub fn for_path_prefix(prefix: Vec<PathSegment>) -> Self {
        Self {
            partition: None,
            address_filter: vec![],
            path_prefix: Some(prefix),
            path_segment_filter: vec![],
        }
    }

    /// Create a selector for entries/deltas carrying any of the given path segments.
    pub fn for_path_segments(segments: Vec<PathSegment>) -> Self {
        Self {
            partition: None,
            address_filter: vec![],
            path_prefix: None,
            path_segment_filter: segments,
        }
    }

    /// Create a selector combining partition, address, and path prefix filters.
    pub fn with_all_filters(
        partition: Option<u32>,
        addresses: Vec<FactAddress>,
        path_prefix: Option<Vec<PathSegment>>,
    ) -> Self {
        Self::with_address_path_filters(partition, addresses, path_prefix, vec![])
    }

    /// Create a selector combining partition, address, path-prefix, and
    /// path-segment filters.
    pub fn with_address_path_filters(
        partition: Option<u32>,
        addresses: Vec<FactAddress>,
        path_prefix: Option<Vec<PathSegment>>,
        path_segments: Vec<PathSegment>,
    ) -> Self {
        Self {
            partition,
            address_filter: addresses,
            path_prefix,
            path_segment_filter: path_segments,
        }
    }

    /// Address filter contents (empty = no address filtering). Exposed so
    /// read projections can serve address-filtered scans via their existing
    /// address map instead of a linear slot walk.
    pub fn address_filter(&self) -> &[FactAddress] {
        &self.address_filter
    }

    /// Path prefix filter (None = no prefix filtering). Exposed so read
    /// projections can serve prefix-filtered scans from a maintained
    /// positional path index instead of a linear slot walk.
    pub fn path_prefix(&self) -> Option<&[PathSegment]> {
        self.path_prefix.as_deref()
    }

    pub fn matches_entry(
        &self,
        partition: u32,
        address: &FactAddress,
        path: &[PathSegment],
    ) -> bool {
        if let Some(p) = self.partition {
            if partition != p {
                return false;
            }
        }
        if !self.address_filter.is_empty()
            && !self
                .address_filter
                .iter()
                .any(|candidate| candidate == address)
        {
            return false;
        }
        if let Some(ref prefix) = self.path_prefix {
            if path.len() < prefix.len() {
                return false;
            }
            for (i, prefix_seg) in prefix.iter().enumerate() {
                if path[i] != *prefix_seg {
                    return false;
                }
            }
        }
        if !self.path_segment_filter.is_empty()
            && !path.iter().any(|segment| {
                self.path_segment_filter
                    .iter()
                    .any(|candidate| candidate == segment)
            })
        {
            return false;
        }
        true
    }

    /// Check if this selector matches a given Delta.
    pub fn matches(&self, delta: &Delta) -> bool {
        if let Some(p) = self.partition {
            if delta.partition != p {
                return false;
            }
        }

        if !self.address_filter.is_empty() {
            let assert_match = delta.asserts.iter().any(|assert| {
                self.address_filter
                    .iter()
                    .any(|candidate| candidate == &assert.address)
            });
            let retract_match = delta.retracts.iter().any(|retract| {
                self.address_filter
                    .iter()
                    .any(|candidate| candidate == retract)
            });
            if !assert_match && !retract_match {
                return false;
            }
        }

        if let Some(ref prefix) = self.path_prefix {
            if delta.path.len() < prefix.len() {
                return false;
            }
            for (i, prefix_seg) in prefix.iter().enumerate() {
                if delta.path[i] != *prefix_seg {
                    return false;
                }
            }
        }

        if !self.path_segment_filter.is_empty()
            && !delta.path.iter().any(|segment| {
                self.path_segment_filter
                    .iter()
                    .any(|candidate| candidate == segment)
            })
        {
            return false;
        }

        true
    }
}

/// Subscription intent — differentiates UI hydration from materializer replay.
///
/// **HydrateUI:** If cursor compacted, send Scoped Snapshot (current state for
/// screen painting). UI clients use this.
///
/// **ContinuousReplay:** If cursor compacted, Engine MUST NOT send snapshot.
/// Instead, fetch historical segments from CAS and stream exact chronological
/// Deltas. Read-side projectors (materializers) REQUIRE the unbroken delta log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SubscriptionIntent {
    /// UI client: send current state snapshot if cursor is compacted.
    #[default]
    HydrateUI,
    /// Materializer/projector: stream exact chronological deltas, never snapshot.
    ContinuousReplay,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_selector_matches_asserts() {
        let target = FactAddress::hash_from("scene");
        let delta = Delta::new(
            vec![DeltaAssert {
                address: target.clone(),
                content_hash: Hash::blake3([7; 32]),
            }],
            vec![],
        );

        assert!(EnvelopeSelector::for_addresses(None, vec![target]).matches(&delta));
    }

    #[test]
    fn address_selector_matches_retracts() {
        let target = FactAddress::hash_from("scene");
        let delta = Delta::new(vec![], vec![target.clone()]);

        assert!(EnvelopeSelector::for_addresses(None, vec![target]).matches(&delta));
    }

    #[test]
    fn address_selector_rejects_unrelated_deltas() {
        let target = FactAddress::hash_from("scene");
        let delta = Delta::new(
            vec![DeltaAssert {
                address: FactAddress::hash_from("slot::target-alpha"),
                content_hash: Hash::blake3([9; 32]),
            }],
            vec![],
        );

        assert!(!EnvelopeSelector::for_addresses(None, vec![target]).matches(&delta));
    }

    #[test]
    fn path_segment_selector_matches_any_path_segment() {
        let segment = PathSegment::hash_from("edge-config");
        let selector = EnvelopeSelector::for_path_segments(vec![segment.clone()]);
        let delta = Delta::with_partition_and_path(
            vec![DeltaAssert {
                address: FactAddress::hash_from("edge::a"),
                content_hash: Hash::blake3([1; 32]),
            }],
            vec![],
            0,
            vec![PathSegment::hash_from("other"), segment.clone()],
        );

        assert!(selector.matches(&delta));
        assert!(selector.matches_entry(0, &FactAddress::hash_from("edge::a"), &[segment]));
    }

    #[test]
    fn slot_subscription_filters_bootstrap_by_selector() {
        let sub = SlotSubscription {
            bootstrap: SubscriptionBootstrapMode::SelectorState,
            content: SubscriptionContentMode::Inline,
            gap_recovery: SubscriptionGapRecovery::RunnerRehydratesBootstrap,
            wait_until_initial_delivery_finishes: true,
            bootstrap_addresses: vec![FactAddress::hash_from("scene")],
            bootstrap_path_prefix: vec![],
            bootstrap_path_segments: vec![],
            live_addresses: vec![FactAddress::hash_from("scene")],
            live_path_prefix: vec![],
            live_path_segments: vec![],
        };
        let scene = LiveStateEntry {
            assert: DeltaAssert {
                address: FactAddress::hash_from("scene"),
                content_hash: Hash::blake3([1; 32]),
            },
            path: vec![],
            payload: vec![],
        };
        let other = LiveStateEntry {
            assert: DeltaAssert {
                address: FactAddress::hash_from("slot::target-alpha"),
                content_hash: Hash::blake3([2; 32]),
            },
            path: vec![],
            payload: vec![],
        };

        assert!(sub.wants_bootstrap_entry(&scene));
        assert!(!sub.wants_bootstrap_entry(&other));
    }

    #[test]
    fn slot_subscription_all_state_overrides_selector() {
        let sub = SlotSubscription {
            bootstrap: SubscriptionBootstrapMode::AllState,
            content: SubscriptionContentMode::Inline,
            gap_recovery: SubscriptionGapRecovery::RunnerRehydratesBootstrap,
            wait_until_initial_delivery_finishes: true,
            bootstrap_addresses: vec![FactAddress::hash_from("scene")],
            bootstrap_path_prefix: vec![PathSegment::hash_from("facet-alpha")],
            bootstrap_path_segments: vec![],
            live_addresses: vec![FactAddress::hash_from("scene")],
            live_path_prefix: vec![PathSegment::hash_from("facet-alpha")],
            live_path_segments: vec![],
        };
        let other = LiveStateEntry {
            assert: DeltaAssert {
                address: FactAddress::hash_from("slot::target-alpha"),
                content_hash: Hash::blake3([3; 32]),
            },
            path: vec![],
            payload: vec![],
        };

        assert!(sub.wants_bootstrap_entry(&other));
    }

    #[test]
    fn slot_subscription_hash_only_disables_inline_content() {
        let sub = SlotSubscription {
            bootstrap: SubscriptionBootstrapMode::None,
            content: SubscriptionContentMode::HashOnly,
            gap_recovery: SubscriptionGapRecovery::RunnerRehydratesBootstrap,
            wait_until_initial_delivery_finishes: true,
            bootstrap_addresses: vec![],
            bootstrap_path_prefix: vec![],
            bootstrap_path_segments: vec![],
            live_addresses: vec![],
            live_path_prefix: vec![],
            live_path_segments: vec![],
        };

        assert!(!sub.inlines_content());
    }

    #[test]
    fn slot_subscription_can_bootstrap_narrower_than_live_scope() {
        let sub = SlotSubscription {
            bootstrap: SubscriptionBootstrapMode::SelectorState,
            content: SubscriptionContentMode::Inline,
            gap_recovery: SubscriptionGapRecovery::RunnerRehydratesBootstrap,
            wait_until_initial_delivery_finishes: true,
            bootstrap_addresses: vec![FactAddress::hash_from("address::alpha")],
            bootstrap_path_prefix: vec![],
            bootstrap_path_segments: vec![],
            live_addresses: vec![],
            live_path_prefix: vec![],
            live_path_segments: vec![],
        };
        let alpha = LiveStateEntry {
            assert: DeltaAssert {
                address: FactAddress::hash_from("address::alpha"),
                content_hash: Hash::blake3([4; 32]),
            },
            path: vec![],
            payload: vec![],
        };
        let beta = LiveStateEntry {
            assert: DeltaAssert {
                address: FactAddress::hash_from("address::beta"),
                content_hash: Hash::blake3([5; 32]),
            },
            path: vec![],
            payload: vec![],
        };

        assert!(sub.wants_bootstrap_entry(&alpha));
        assert!(!sub.wants_bootstrap_entry(&beta));
        assert!(sub.matches_live_assert(&alpha.assert, &alpha.path));
        assert!(sub.matches_live_assert(&beta.assert, &beta.path));
    }

    #[test]
    fn slot_subscription_matches_path_prefix_for_boot_and_live() {
        let path_prefix = vec![PathSegment::hash_from("facet-alpha")];
        let sub = SlotSubscription {
            bootstrap: SubscriptionBootstrapMode::SelectorState,
            content: SubscriptionContentMode::HashOnly,
            gap_recovery: SubscriptionGapRecovery::RunnerRehydratesBootstrap,
            wait_until_initial_delivery_finishes: true,
            bootstrap_addresses: vec![],
            bootstrap_path_prefix: path_prefix.clone(),
            bootstrap_path_segments: vec![],
            live_addresses: vec![],
            live_path_prefix: path_prefix.clone(),
            live_path_segments: vec![],
        };
        let matching = LiveStateEntry {
            assert: DeltaAssert {
                address: FactAddress::hash_from("address::matching"),
                content_hash: Hash::blake3([6; 32]),
            },
            path: vec![
                PathSegment::hash_from("facet-alpha"),
                PathSegment::hash_from("facet-beta"),
            ],
            payload: vec![],
        };
        let other = LiveStateEntry {
            assert: DeltaAssert {
                address: FactAddress::hash_from("address::other"),
                content_hash: Hash::blake3([7; 32]),
            },
            path: vec![PathSegment::hash_from("facet-other")],
            payload: vec![],
        };

        assert!(sub.wants_bootstrap_entry(&matching));
        assert!(!sub.wants_bootstrap_entry(&other));
        assert!(sub.matches_live_assert(&matching.assert, &matching.path));
        assert!(!sub.matches_live_assert(&other.assert, &other.path));
        assert!(sub.matches_retract(&matching.assert.address, &matching.path));
        assert!(!sub.matches_retract(&other.assert.address, &other.path));
    }

    #[test]
    fn slot_subscription_matches_any_declared_path_segment_for_boot_and_live() {
        let wanted_segment = PathSegment::hash_from("facet-wanted");
        let sub = SlotSubscription {
            bootstrap: SubscriptionBootstrapMode::SelectorState,
            content: SubscriptionContentMode::Inline,
            gap_recovery: SubscriptionGapRecovery::RunnerRehydratesBootstrap,
            wait_until_initial_delivery_finishes: true,
            bootstrap_addresses: vec![],
            bootstrap_path_prefix: vec![],
            bootstrap_path_segments: vec![wanted_segment.clone()],
            live_addresses: vec![],
            live_path_prefix: vec![],
            live_path_segments: vec![wanted_segment.clone()],
        };
        let matching = LiveStateEntry {
            assert: DeltaAssert {
                address: FactAddress::hash_from("address::matching"),
                content_hash: Hash::blake3([8; 32]),
            },
            path: vec![
                PathSegment::hash_from("facet-other"),
                wanted_segment.clone(),
            ],
            payload: vec![],
        };
        let other = LiveStateEntry {
            assert: DeltaAssert {
                address: FactAddress::hash_from("address::other"),
                content_hash: Hash::blake3([9; 32]),
            },
            path: vec![PathSegment::hash_from("facet-other")],
            payload: vec![],
        };

        assert!(sub.wants_bootstrap_entry(&matching));
        assert!(!sub.wants_bootstrap_entry(&other));
        assert!(sub.matches_live_assert(&matching.assert, &matching.path));
        assert!(!sub.matches_live_assert(&other.assert, &other.path));
        assert!(sub
            .live_selector()
            .matches_entry(0, &matching.assert.address, &matching.path));
        assert!(!sub
            .live_selector()
            .matches_entry(0, &other.assert.address, &other.path));
    }

    #[test]
    fn slot_subscription_waits_for_initial_delivery_by_default() {
        let sub: SlotSubscription = serde_json::from_str(r#"{"bootstrap":"all_state"}"#)
            .expect("subscription with default wait policy");

        assert!(sub.wait_until_initial_delivery_finishes);
        assert!(sub.runner_rehydrates_bootstrap_after_gap());
    }

    #[test]
    fn slot_subscription_can_assign_gap_reconciliation_to_the_consumer() {
        let sub: SlotSubscription =
            serde_json::from_str(r#"{"gap_recovery":"consumer_reconciles_current_state"}"#)
                .expect("subscription with consumer-owned gap recovery");

        assert!(!sub.runner_rehydrates_bootstrap_after_gap());
    }

    #[test]
    fn slot_subscription_can_continue_before_initial_delivery_finishes() {
        let sub: SlotSubscription = serde_json::from_str(
            r#"{"bootstrap":"all_state","wait_until_initial_delivery_finishes":false}"#,
        )
        .expect("subscription with non-blocking initial delivery policy");

        assert!(!sub.wait_until_initial_delivery_finishes);
    }
}
