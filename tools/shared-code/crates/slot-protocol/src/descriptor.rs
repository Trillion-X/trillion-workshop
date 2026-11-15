//! SlotDescriptor — static declaration of a slot's Envelope topology.
//!
//! Each slot declares which Envelope address patterns it publishes
//! and which it subscribes to, with routing intent (Internal vs Exported).
//!
//! Boot-time verification cross-references all descriptors:
//! - Internal published addresses MUST have ≥1 subscriber
//! - Exported addresses are exempt (external hosts subscribe at runtime)
//!
//! Dynamic reply edges (DelegatedWriteCapability) bypass static validation —
//! the crypto token IS the runtime proof of the topology edge.

use std::sync::Arc;

/// Routing intent for a published address pattern.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoutingIntent {
    /// Internal: another slot in this Engine subscribes.
    /// Boot-time: MUST have ≥1 registered subscriber or Engine panics.
    Internal,

    /// Exported: intended for external consumers (WebSocket hosts, WASM plugins, JS UI).
    /// Exempt from boot-time subscriber check — external hosts subscribe at runtime.
    Exported,
}

/// A single address pattern declaration (publish or subscribe).
#[derive(Debug, Clone)]
pub struct AddressPattern {
    /// The Envelope address pattern (for example, "target-alpha:*").
    pub pattern: Arc<str>,

    /// Human-readable description of what flows through this pattern.
    pub description: &'static str,
}

/// Static topology declaration for a slot.
///
/// Implemented by each slot to declare its Envelope address patterns.
/// The Engine collects all descriptors at boot time for topology verification.
pub trait SlotDescriptor: Send + Sync {
    /// Unique slot name.
    fn name(&self) -> &str;

    /// Address patterns this slot PUBLISHES (writes Envelopes to).
    fn publishes(&self) -> Vec<(AddressPattern, RoutingIntent)>;

    /// Address patterns this slot SUBSCRIBES to (reads Envelopes from).
    fn subscribes_to(&self) -> Vec<AddressPattern>;
}

/// Topology verification result.
#[derive(Debug)]
pub struct TopologyError {
    /// The orphaned Internal address that has zero subscribers.
    pub orphaned_address: String,
    /// The slot that publishes to this address.
    pub publisher: String,
}

impl std::fmt::Display for TopologyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Orphaned Internal address '{}' published by slot '{}' has zero subscribers",
            self.orphaned_address, self.publisher
        )
    }
}

/// Verify topology: every Internal published address has ≥1 subscriber.
///
/// Returns `Ok(())` if all Internal addresses have subscribers.
/// Returns `Err(vec![TopologyError])` listing all orphaned addresses.
pub fn verify_topology(descriptors: &[&dyn SlotDescriptor]) -> Result<(), Vec<TopologyError>> {
    let mut errors = Vec::new();

    // Collect all subscribed patterns
    let mut all_subscriptions: Vec<String> = Vec::new();
    for desc in descriptors {
        for pattern in desc.subscribes_to() {
            all_subscriptions.push(pattern.pattern.to_string());
        }
    }

    // Check each Internal published address has a subscriber
    for desc in descriptors {
        for (pattern, intent) in desc.publishes() {
            if intent == RoutingIntent::Exported {
                continue; // Exported addresses don't need static subscribers
            }

            // Check if any subscription matches this published address
            let has_subscriber = all_subscriptions.iter().any(|sub| {
                // Simple prefix match: "target-alpha:*" matches "target-alpha:op"
                if sub.ends_with('*') {
                    pattern.pattern.starts_with(&sub[..sub.len() - 1])
                } else {
                    *sub == *pattern.pattern
                }
            });

            if !has_subscriber {
                errors.push(TopologyError {
                    orphaned_address: pattern.pattern.to_string(),
                    publisher: desc.name().to_string(),
                });
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockSlotA;
    impl SlotDescriptor for MockSlotA {
        fn name(&self) -> &str {
            "slot-a"
        }
        fn publishes(&self) -> Vec<(AddressPattern, RoutingIntent)> {
            vec![(
                AddressPattern {
                    pattern: Arc::from("slot-b:process"),
                    description: "request",
                },
                RoutingIntent::Internal,
            )]
        }
        fn subscribes_to(&self) -> Vec<AddressPattern> {
            vec![AddressPattern {
                pattern: Arc::from("slot-a:*"),
                description: "replies",
            }]
        }
    }

    struct MockSlotB;
    impl SlotDescriptor for MockSlotB {
        fn name(&self) -> &str {
            "slot-b"
        }
        fn publishes(&self) -> Vec<(AddressPattern, RoutingIntent)> {
            vec![(
                AddressPattern {
                    pattern: Arc::from("ui:state"),
                    description: "state push",
                },
                RoutingIntent::Exported,
            )]
        }
        fn subscribes_to(&self) -> Vec<AddressPattern> {
            vec![AddressPattern {
                pattern: Arc::from("slot-b:*"),
                description: "requests",
            }]
        }
    }

    #[test]
    fn test_valid_topology() {
        let a = MockSlotA;
        let b = MockSlotB;
        let result = verify_topology(&[&a, &b]);
        assert!(result.is_ok());
    }

    #[test]
    fn test_orphaned_internal_address() {
        // Slot A publishes to "slot-c:process" but no slot subscribes to slot-c
        struct Orphaner;
        impl SlotDescriptor for Orphaner {
            fn name(&self) -> &str {
                "orphaner"
            }
            fn publishes(&self) -> Vec<(AddressPattern, RoutingIntent)> {
                vec![(
                    AddressPattern {
                        pattern: Arc::from("slot-c:process"),
                        description: "test",
                    },
                    RoutingIntent::Internal,
                )]
            }
            fn subscribes_to(&self) -> Vec<AddressPattern> {
                vec![]
            }
        }

        let orphaner = Orphaner;
        let result = verify_topology(&[&orphaner]);
        assert!(result.is_err());
        let errors = result.unwrap_err();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].orphaned_address, "slot-c:process");
    }

    #[test]
    fn test_exported_address_no_subscriber_ok() {
        struct Exporter;
        impl SlotDescriptor for Exporter {
            fn name(&self) -> &str {
                "exporter"
            }
            fn publishes(&self) -> Vec<(AddressPattern, RoutingIntent)> {
                vec![(
                    AddressPattern {
                        pattern: Arc::from("ui:data"),
                        description: "for WebSocket",
                    },
                    RoutingIntent::Exported,
                )]
            }
            fn subscribes_to(&self) -> Vec<AddressPattern> {
                vec![]
            }
        }

        let exporter = Exporter;
        let result = verify_topology(&[&exporter]);
        assert!(result.is_ok()); // Exported = no subscriber needed
    }

    // ── Adversarial: edge case topologies (Category 5) ───────────────

    #[test]
    fn test_empty_topology_is_valid() {
        let result = verify_topology(&[]);
        assert!(result.is_ok()); // No slots = no orphans
    }

    #[test]
    fn test_circular_topology_valid() {
        // A publishes to B's domain, B subscribes; B publishes to A's domain, A subscribes
        struct CircA;
        impl SlotDescriptor for CircA {
            fn name(&self) -> &str {
                "circ-a"
            }
            fn publishes(&self) -> Vec<(AddressPattern, RoutingIntent)> {
                vec![(
                    AddressPattern {
                        pattern: Arc::from("circ-b:work"),
                        description: "request to B",
                    },
                    RoutingIntent::Internal,
                )]
            }
            fn subscribes_to(&self) -> Vec<AddressPattern> {
                vec![AddressPattern {
                    pattern: Arc::from("circ-a:*"),
                    description: "replies",
                }]
            }
        }

        struct CircB;
        impl SlotDescriptor for CircB {
            fn name(&self) -> &str {
                "circ-b"
            }
            fn publishes(&self) -> Vec<(AddressPattern, RoutingIntent)> {
                vec![(
                    AddressPattern {
                        pattern: Arc::from("circ-a:reply"),
                        description: "reply to A",
                    },
                    RoutingIntent::Internal,
                )]
            }
            fn subscribes_to(&self) -> Vec<AddressPattern> {
                vec![AddressPattern {
                    pattern: Arc::from("circ-b:*"),
                    description: "requests",
                }]
            }
        }

        let a = CircA;
        let b = CircB;
        let result = verify_topology(&[&a, &b]);
        assert!(result.is_ok());
    }

    #[test]
    fn test_self_subscription_valid() {
        // A slot publishes Internal and subscribes to its own domain
        struct SelfSub;
        impl SlotDescriptor for SelfSub {
            fn name(&self) -> &str {
                "self-sub"
            }
            fn publishes(&self) -> Vec<(AddressPattern, RoutingIntent)> {
                vec![(
                    AddressPattern {
                        pattern: Arc::from("self-sub:event"),
                        description: "internal event",
                    },
                    RoutingIntent::Internal,
                )]
            }
            fn subscribes_to(&self) -> Vec<AddressPattern> {
                vec![AddressPattern {
                    pattern: Arc::from("self-sub:*"),
                    description: "own events",
                }]
            }
        }

        let s = SelfSub;
        let result = verify_topology(&[&s]);
        assert!(result.is_ok()); // Self-subscription is valid
    }

    #[test]
    fn test_multiple_orphaned_addresses() {
        struct MultiOrphan;
        impl SlotDescriptor for MultiOrphan {
            fn name(&self) -> &str {
                "multi-orphan"
            }
            fn publishes(&self) -> Vec<(AddressPattern, RoutingIntent)> {
                vec![
                    (
                        AddressPattern {
                            pattern: Arc::from("ghost-a:x"),
                            description: "a",
                        },
                        RoutingIntent::Internal,
                    ),
                    (
                        AddressPattern {
                            pattern: Arc::from("ghost-b:y"),
                            description: "b",
                        },
                        RoutingIntent::Internal,
                    ),
                    (
                        AddressPattern {
                            pattern: Arc::from("ghost-c:z"),
                            description: "c",
                        },
                        RoutingIntent::Internal,
                    ),
                ]
            }
            fn subscribes_to(&self) -> Vec<AddressPattern> {
                vec![]
            }
        }

        let m = MultiOrphan;
        let result = verify_topology(&[&m]);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().len(), 3);
    }

    #[test]
    fn test_mixed_internal_exported_same_slot() {
        struct Mixed;
        impl SlotDescriptor for Mixed {
            fn name(&self) -> &str {
                "mixed"
            }
            fn publishes(&self) -> Vec<(AddressPattern, RoutingIntent)> {
                vec![
                    (
                        AddressPattern {
                            pattern: Arc::from("other:process"),
                            description: "",
                        },
                        RoutingIntent::Internal,
                    ),
                    (
                        AddressPattern {
                            pattern: Arc::from("ui:render"),
                            description: "",
                        },
                        RoutingIntent::Exported,
                    ),
                ]
            }
            fn subscribes_to(&self) -> Vec<AddressPattern> {
                vec![]
            }
        }

        let m = Mixed;
        let result = verify_topology(&[&m]);
        assert!(result.is_err());
        let errors = result.unwrap_err();
        assert_eq!(errors.len(), 1); // Only Internal orphan, Exported is fine
        assert_eq!(errors[0].orphaned_address, "other:process");
    }

    // ── Edge cases (Category 1) ──────────────────────────────────────

    #[test]
    fn test_slot_with_no_publications_or_subscriptions() {
        struct Passive;
        impl SlotDescriptor for Passive {
            fn name(&self) -> &str {
                "passive"
            }
            fn publishes(&self) -> Vec<(AddressPattern, RoutingIntent)> {
                vec![]
            }
            fn subscribes_to(&self) -> Vec<AddressPattern> {
                vec![]
            }
        }

        let p = Passive;
        let result = verify_topology(&[&p]);
        assert!(result.is_ok());
    }
}
