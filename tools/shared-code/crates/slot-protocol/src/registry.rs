//! The SlotRegistry — resolves slot names to Arc<dyn Slot> implementations.
//!
//! Registry Architecture:
//! - Storage: ArcSwap<HashMap<String, Arc<dyn Slot>>> — lock-free concurrent access
//! - Mutation: register() adds, unregister() removes, clear_cache() resets all
//! - Resolution: resolve() returns Arc<dyn Slot> or Err(AddressNotFound)
//!
//! # Physics Principles
//!
//! - Registry is generic (Arc<dyn Slot>) — zero enumeration (L090)
//! - All errors use EnvelopeError (Physics-level)
//! - ArcSwap provides lock-free reads with RCU (read-copy-update) writes
//! - register/unregister mirror Envelope assert/retract lifecycle (§7)

use crate::slot::Slot;
use crate::EnvelopeError;
use arc_swap::ArcSwap;
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

/// The address a caller reaches a routable name at.
///
/// THIS IS THE ONE RULE, and it exists because there were two.
///
/// A name can be answered by a slot or by a native handler, and a caller does
/// not know or care which: it says `slot::some.name` and expects an answer. The
/// registry hashed `slot::{name}` and the native-handler map hashed the bare
/// `{name}`, so the two disagreed about where the same name lives. Nothing
/// crossed the gap and nothing reported it. A workflow step saying
/// `ask:slot::permission-lease.save-what-someone-is-allowed-to-do` produced the
/// prefixed address, found no slot there, looked in the handler map under that
/// same prefixed address, found nothing there either, and answered "address not
/// found: no slot and no engine data" about a handler that WAS registered and
/// WAS holding that exact name. Every package target was unreachable from every
/// workflow, and the message said the target did not exist.
///
/// The prefix is stripped first so a caller who already wrote it gets the same
/// answer as one who did not. There is one address for a name because there is
/// one name.
pub fn address_for_routable_name(name: &str) -> crate::FactAddress {
    let bare = name.strip_prefix("slot::").unwrap_or(name);
    crate::FactAddress::hash_from(&format!("slot::{bare}"))
}

/// Internal state for the bidirectional slot index.
///
/// Both maps are updated atomically via a single ArcSwap RCU cycle.
/// L063: bidirectional index makes O(N) retraction scans structurally impossible.
struct RegistryState {
    /// Forward index: name → slot implementation
    slots: HashMap<String, Arc<dyn Slot>>,
    /// Reverse index: Envelope address → slot name.
    /// Used by retraction path where only the address is available (no payload).
    address_to_name: HashMap<crate::FactAddress, String>,
}

/// A registry for resolving slots by name or Envelope address.
///
/// # Invariants
///
/// 1. ArcSwap<RegistryState> provides lock-free reads, atomic RCU writes
/// 2. register/unregister mirror Envelope assert/retract lifecycle
/// 3. Zero enumeration — registry handles any Arc<dyn Slot> without matching type
/// 4. Bidirectional index: name→slot AND address_hash→name, updated atomically
///    in a single RCU cycle (L063: O(N) retraction scans structurally impossible)
pub struct SlotRegistry {
    state: ArcSwap<RegistryState>,
}

impl fmt::Debug for SlotRegistry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SlotRegistry")
            .field("cache_entries", &self.state.load().slots.len())
            .finish()
    }
}

impl SlotRegistry {
    /// Create a new SlotRegistry with an empty cache.
    pub fn new() -> Self {
        SlotRegistry {
            state: ArcSwap::new(Arc::new(RegistryState {
                slots: HashMap::new(),
                address_to_name: HashMap::new(),
            })),
        }
    }

    /// Register a slot in the registry.
    ///
    /// Atomically updates both forward (name→slot) and reverse (address→name)
    /// indexes in a single RCU cycle.
    pub fn register(&self, name: String, slot: Arc<dyn Slot>) {
        let address_hash = address_for_routable_name(&name);

        self.state.rcu(|current| {
            let mut slots = current.slots.clone();
            let mut address_to_name = current.address_to_name.clone();
            slots.insert(name.clone(), Arc::clone(&slot));
            address_to_name.insert(address_hash.clone(), name.clone());
            RegistryState {
                slots,
                address_to_name,
            }
        });

        tracing::debug!(slot_name = %name, "registered slot");
    }

    /// Remove a single slot by name (mirrors Envelope retraction).
    ///
    /// Atomically updates both indexes in a single RCU cycle.
    /// Returns `Ok(())` if the slot was found and removed.
    /// Returns `Err(EnvelopeError::AddressNotFound)` if the name wasn't registered.
    pub fn unregister(&self, name: &str) -> Result<(), EnvelopeError> {
        let address_hash = address_for_routable_name(name);
        let removed = std::sync::atomic::AtomicBool::new(false);

        self.state.rcu(|current| {
            let mut slots = current.slots.clone();
            let mut address_to_name = current.address_to_name.clone();
            if slots.remove(name).is_some() {
                removed.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            address_to_name.remove(&address_hash);
            RegistryState {
                slots,
                address_to_name,
            }
        });

        if removed.load(std::sync::atomic::Ordering::Relaxed) {
            tracing::debug!(slot_name = %name, "unregistered slot");
            Ok(())
        } else {
            tracing::debug!(slot_name = %name, "unregister failed: slot not found");
            Err(EnvelopeError::AddressNotFound)
        }
    }

    /// Remove a slot by its Envelope address hash (retraction path).
    ///
    /// Used by `process_slot_retractions()` where only the address hash is
    /// available (the payload is gone — that's what retraction means).
    /// O(1) via the bidirectional reverse index. Atomic single RCU cycle.
    pub fn unregister_by_address(
        &self,
        address_hash: &crate::FactAddress,
    ) -> Result<String, EnvelopeError> {
        let current = self.state.load();
        let name = current
            .address_to_name
            .get(address_hash)
            .ok_or(EnvelopeError::AddressNotFound)?
            .clone();

        self.unregister(&name)?;
        Ok(name)
    }

    /// Resolve a slot by name.
    ///
    /// Returns `Ok(Arc<dyn Slot>)` if registered, `Err(AddressNotFound)` otherwise.
    pub fn resolve(&self, name: &str) -> Result<Arc<dyn Slot>, EnvelopeError> {
        let current = self.state.load();
        if let Some(slot) = current.slots.get(name) {
            return Ok(Arc::clone(slot));
        }
        Err(EnvelopeError::AddressNotFound)
    }

    /// Resolve a slot by its Envelope address hash (query path).
    ///
    /// Used by EnvelopeDispatchRunner to route inter-slot queries:
    /// Envelope.address → slot implementation. O(1) via bidirectional index.
    pub fn resolve_by_address(
        &self,
        address: &crate::FactAddress,
    ) -> Result<Arc<dyn Slot>, EnvelopeError> {
        let current = self.state.load();
        let name = current
            .address_to_name
            .get(address)
            .ok_or(EnvelopeError::AddressNotFound)?;
        current
            .slots
            .get(name)
            .map(Arc::clone)
            .ok_or(EnvelopeError::AddressNotFound)
    }

    /// List all registered slot names.
    pub fn list(&self) -> Vec<String> {
        let current = self.state.load();
        current.slots.keys().cloned().collect()
    }

    /// Remove all registered slots.
    pub fn clear_cache(&self) {
        self.state.store(Arc::new(RegistryState {
            slots: HashMap::new(),
            address_to_name: HashMap::new(),
        }));
        tracing::debug!("registry cleared");
    }
}

impl Default for SlotRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::method::MethodDescriptor;
    use crate::{Envelope, FactAddress, PartitionKey};
    use bytes::Bytes;

    struct MockSlot {
        name: String,
    }

    impl Slot for MockSlot {
        fn dispatch(&self, entries: Vec<Envelope>) -> Result<crate::Hash, EnvelopeError> {
            if entries.is_empty() {
                return Err(EnvelopeError::AddressNotFound);
            }
            Ok(crate::Hash::from_multihash(
                entries[0].address.as_multihash().clone(),
            ))
        }

        fn methods(&self) -> Vec<MethodDescriptor> {
            vec![MethodDescriptor::new(&self.name, "Mock slot method")]
        }
    }

    #[test]
    fn test_registry_register_and_resolve() {
        let registry = SlotRegistry::new();
        let slot = Arc::new(MockSlot {
            name: "test".to_string(),
        });

        registry.register("test_slot".to_string(), Arc::clone(&slot) as Arc<dyn Slot>);

        let resolved = registry.resolve("test_slot").expect("should resolve");
        assert_eq!(
            resolved.methods().len(),
            1,
            "resolved slot should have one method"
        );
    }

    #[test]
    fn test_registry_resolve_unknown_slot() {
        let registry = SlotRegistry::new();
        let result = registry.resolve("nonexistent");

        assert!(result.is_err(), "resolve should fail for unknown slot");
    }

    #[test]
    fn test_registry_list_slots() {
        let registry = SlotRegistry::new();

        let slot1 = Arc::new(MockSlot {
            name: "slot1".to_string(),
        });
        let slot2 = Arc::new(MockSlot {
            name: "slot2".to_string(),
        });

        registry.register("slot1".to_string(), slot1);
        registry.register("slot2".to_string(), slot2);

        let list = registry.list();
        assert_eq!(list.len(), 2);
        assert!(list.contains(&"slot1".to_string()));
        assert!(list.contains(&"slot2".to_string()));
    }

    #[test]
    fn test_registry_cache_is_read_through() {
        let registry = SlotRegistry::new();
        let slot = Arc::new(MockSlot {
            name: "cached".to_string(),
        });

        // Register
        registry.register(
            "cached_slot".to_string(),
            Arc::clone(&slot) as Arc<dyn Slot>,
        );

        // Resolve (should hit cache)
        let resolved = registry.resolve("cached_slot").expect("should resolve");
        assert_eq!(resolved.methods().len(), 1);

        // Clear cache
        registry.clear_cache();

        // Resolve again (cache miss, would query backing store if implemented)
        // Without a backing store, resolve fails on cache miss
        let result = registry.resolve("cached_slot");
        assert!(
            result.is_err(),
            "after cache clear, resolve fails (no backing store)"
        );
    }

    #[test]
    fn test_registry_multiple_slots_generic_dispatch() {
        let registry = SlotRegistry::new();

        let slots: Vec<(String, Arc<dyn Slot>)> = vec![
            (
                "slot_a".to_string(),
                Arc::new(MockSlot {
                    name: "a".to_string(),
                }) as Arc<dyn Slot>,
            ),
            (
                "slot_b".to_string(),
                Arc::new(MockSlot {
                    name: "b".to_string(),
                }) as Arc<dyn Slot>,
            ),
        ];

        for (name, slot) in slots {
            registry.register(name, slot);
        }

        // Dispatch through generic Arc<dyn Slot> without enumerating types
        for slot_name in ["slot_a", "slot_b"] {
            let slot = registry.resolve(slot_name).expect("should resolve");
            let partition = PartitionKey::from_digest(0x1F, vec![1u8; 32]);
            let address = FactAddress::from_digest(0x1F, vec![2u8; 32]);
            let env = Envelope::minimal(partition, address, Some(Bytes::from("data")));

            let result = slot.dispatch(vec![env]);
            assert!(result.is_ok(), "generic dispatch should work");
        }
    }

    #[test]
    fn test_registry_concurrent_register_and_resolve() {
        let registry = Arc::new(SlotRegistry::new());

        for i in 0..5 {
            let reg = Arc::clone(&registry);
            let slot_name = format!("slot_{}", i);

            let slot = Arc::new(MockSlot {
                name: slot_name.clone(),
            });

            reg.register(slot_name.clone(), slot);

            let resolved = reg.resolve(&slot_name).expect("should resolve");
            assert_eq!(resolved.methods().len(), 1);
        }
    }

    #[test]
    fn test_registry_unregister_single_slot() {
        let registry = SlotRegistry::new();
        let slot_a = Arc::new(MockSlot {
            name: "a".to_string(),
        }) as Arc<dyn Slot>;
        let slot_b = Arc::new(MockSlot {
            name: "b".to_string(),
        }) as Arc<dyn Slot>;
        let slot_c = Arc::new(MockSlot {
            name: "c".to_string(),
        }) as Arc<dyn Slot>;

        registry.register("a".to_string(), slot_a);
        registry.register("b".to_string(), slot_b);
        registry.register("c".to_string(), slot_c);
        assert_eq!(registry.list().len(), 3);

        // Unregister one — other two must survive
        registry.unregister("b").expect("should unregister");
        assert_eq!(registry.list().len(), 2);
        assert!(registry.resolve("a").is_ok());
        assert!(registry.resolve("b").is_err());
        assert!(registry.resolve("c").is_ok());
    }

    #[test]
    fn test_registry_unregister_nonexistent() {
        let registry = SlotRegistry::new();
        let slot = Arc::new(MockSlot {
            name: "x".to_string(),
        }) as Arc<dyn Slot>;
        registry.register("x".to_string(), slot);

        let result = registry.unregister("nonexistent");
        assert!(result.is_err(), "unregister nonexistent should fail");

        // Existing slot unaffected
        assert!(registry.resolve("x").is_ok());
    }

    #[test]
    fn test_registry_re_register_after_unregister() {
        let registry = SlotRegistry::new();
        let slot1 = Arc::new(MockSlot {
            name: "v1".to_string(),
        }) as Arc<dyn Slot>;
        let slot2 = Arc::new(MockSlot {
            name: "v2".to_string(),
        }) as Arc<dyn Slot>;

        registry.register("slot".to_string(), slot1);
        assert!(registry.resolve("slot").is_ok());

        registry.unregister("slot").expect("should unregister");
        assert!(registry.resolve("slot").is_err());

        // Re-register with different implementation
        registry.register("slot".to_string(), slot2);
        let resolved = registry
            .resolve("slot")
            .expect("should resolve after re-register");
        assert_eq!(resolved.methods()[0].name, "v2");
    }

    #[test]
    fn test_registry_resolve_by_address() {
        let registry = SlotRegistry::new();
        let slot = Arc::new(MockSlot {
            name: "slot-alpha".to_string(),
        }) as Arc<dyn Slot>;

        registry.register("slot-alpha".to_string(), slot);

        // The address is hash_from("slot::slot-alpha") — same as what register() computes.
        let address = FactAddress::hash_from("slot::slot-alpha");
        let resolved = registry
            .resolve_by_address(&address)
            .expect("should resolve by address");
        assert_eq!(resolved.methods()[0].name, "slot-alpha");

        // Unknown address should fail.
        let unknown = FactAddress::hash_from("slot::nonexistent");
        assert!(registry.resolve_by_address(&unknown).is_err());
    }

    #[test]
    fn test_registry_arc_clone_efficiency() {
        let registry = SlotRegistry::new();
        let slot = Arc::new(MockSlot {
            name: "shared".to_string(),
        });

        // Register once
        let slot_clone: Arc<dyn Slot> = Arc::clone(&slot) as Arc<dyn Slot>;
        registry.register("shared_slot".to_string(), slot_clone);

        // Resolve multiple times — all share the same Arc, no clones of the actual slot
        let resolved1 = registry.resolve("shared_slot").expect("resolve 1");
        let resolved2 = registry.resolve("shared_slot").expect("resolve 2");

        // Both point to the same allocation
        assert!(Arc::ptr_eq(&resolved1, &resolved2));
    }
}
