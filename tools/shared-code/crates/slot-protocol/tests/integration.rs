//! Integration tests for slot protocol end-to-end functionality.

use bytes::Bytes;
use slot_protocol::{Envelope, EnvelopeError, FactAddress, Hash, PartitionKey};
use slot_protocol::{MethodDescriptor, Slot, SlotRegistry};
use std::sync::Arc;

/// A test slot implementation that simulates a database write slot.
struct DatabaseSlot {
    #[allow(dead_code)]
    name: String,
}

impl Slot for DatabaseSlot {
    fn dispatch(&self, entries: Vec<Envelope>) -> Result<Hash, EnvelopeError> {
        if entries.is_empty() {
            return Err(EnvelopeError::AddressNotFound);
        }

        // Generate receipt from first entry's partition key
        Ok(Hash::from_multihash(
            entries[0].partition_key.as_multihash().clone(),
        ))
    }

    fn methods(&self) -> Vec<MethodDescriptor> {
        vec![
            MethodDescriptor::new("write", "Write data to the database"),
            MethodDescriptor::new("read", "Read data from the database"),
            MethodDescriptor::new("delete", "Delete data from the database"),
        ]
    }
}

/// A test slot implementation that simulates a query slot.
struct QuerySlot;

impl Slot for QuerySlot {
    fn dispatch(&self, entries: Vec<Envelope>) -> Result<Hash, EnvelopeError> {
        if entries.is_empty() {
            return Err(EnvelopeError::AddressNotFound);
        }
        Ok(Hash::from_multihash(
            entries[0].address.as_multihash().clone(),
        ))
    }

    fn methods(&self) -> Vec<MethodDescriptor> {
        vec![MethodDescriptor::new("query", "Execute a query")]
    }
}

#[test]
fn test_register_resolve_dispatch_flow() {
    // Create a registry
    let registry = SlotRegistry::new();

    // Register slots
    let db_slot: Arc<dyn Slot> = Arc::new(DatabaseSlot {
        name: "sqlite".to_string(),
    });
    let query_slot: Arc<dyn Slot> = Arc::new(QuerySlot);

    registry.register("database".to_string(), db_slot);
    registry.register("query".to_string(), query_slot);

    // Verify both are registered
    let list = registry.list();
    assert_eq!(list.len(), 2);
    assert!(list.contains(&"database".to_string()));
    assert!(list.contains(&"query".to_string()));

    // Resolve and dispatch to database slot
    let db = registry.resolve("database").expect("database slot");
    let methods = db.methods();
    assert_eq!(methods.len(), 3);

    let partition = PartitionKey::from_digest(0x1F, vec![1u8; 32]);
    let address = FactAddress::from_digest(0x1F, vec![2u8; 32]);
    let env = Envelope::minimal(partition.clone(), address, Some(Bytes::from("data")));

    let receipt = db.dispatch(vec![env]).expect("dispatch");
    assert_eq!(
        receipt,
        Hash::from_multihash(partition.as_multihash().clone())
    );

    // Resolve and dispatch to query slot
    let query = registry.resolve("query").expect("query slot");
    let query_methods = query.methods();
    assert_eq!(query_methods.len(), 1);
    assert_eq!(query_methods[0].name, "query");

    let query_address = FactAddress::from_digest(0x1F, vec![3u8; 32]);
    let query_env = Envelope::minimal(
        partition,
        query_address.clone(),
        Some(Bytes::from("query_payload")),
    );

    let query_receipt = query.dispatch(vec![query_env]).expect("query dispatch");
    assert_eq!(
        query_receipt,
        Hash::from_multihash(query_address.as_multihash().clone())
    );
}

#[test]
fn test_multiple_envelopes_dispatch() {
    let registry = SlotRegistry::new();
    let slot: Arc<dyn Slot> = Arc::new(DatabaseSlot {
        name: "multi".to_string(),
    });

    registry.register("multi_slot".to_string(), slot);

    let resolved = registry.resolve("multi_slot").expect("resolve");

    // Create multiple envelopes
    let partition = PartitionKey::from_digest(0x1F, vec![1u8; 32]);
    let expected = Hash::from_multihash(partition.as_multihash().clone());
    let envs = vec![
        Envelope::minimal(
            partition.clone(),
            FactAddress::from_digest(0x1F, vec![2u8; 32]),
            Some(Bytes::from("1")),
        ),
        Envelope::minimal(
            partition.clone(),
            FactAddress::from_digest(0x1F, vec![3u8; 32]),
            Some(Bytes::from("2")),
        ),
        Envelope::minimal(
            partition,
            FactAddress::from_digest(0x1F, vec![4u8; 32]),
            Some(Bytes::from("3")),
        ),
    ];

    let receipt = resolved.dispatch(envs).expect("dispatch multiple");

    // Receipt should be derived from first entry
    assert_eq!(receipt, expected);
}

#[test]
fn test_cache_persistence_across_resolves() {
    let registry = SlotRegistry::new();
    let slot: Arc<dyn Slot> = Arc::new(DatabaseSlot {
        name: "cached".to_string(),
    });

    registry.register(
        "cached_slot".to_string(),
        Arc::clone(&slot) as Arc<dyn Slot>,
    );

    // First resolve
    let resolved1 = registry.resolve("cached_slot").expect("first resolve");

    // Second resolve — should hit cache and return same Arc
    let resolved2 = registry.resolve("cached_slot").expect("second resolve");

    // Both should point to the same allocation
    assert!(Arc::ptr_eq(&resolved1, &resolved2));
}

#[test]
fn test_dispatch_empty_entries_error() {
    let registry = SlotRegistry::new();
    let slot: Arc<dyn Slot> = Arc::new(DatabaseSlot {
        name: "empty_test".to_string(),
    });

    registry.register("error_slot".to_string(), slot);

    let resolved = registry.resolve("error_slot").expect("resolve");
    let result = resolved.dispatch(vec![]);

    assert!(result.is_err(), "dispatch with empty entries should fail");
}

#[test]
fn test_unknown_slot_resolution() {
    let registry = SlotRegistry::new();

    // Try to resolve a slot that doesn't exist
    let result = registry.resolve("nonexistent_slot");

    assert!(result.is_err(), "resolving unknown slot should fail");
}

#[test]
fn test_multiple_slots_different_types() {
    // Demonstrates L090: registry dispatches to Arc<dyn Slot> without enumerating types
    let registry = SlotRegistry::new();

    let db: Arc<dyn Slot> = Arc::new(DatabaseSlot {
        name: "db".to_string(),
    });
    let query: Arc<dyn Slot> = Arc::new(QuerySlot);

    registry.register("db".to_string(), db);
    registry.register("query".to_string(), query);

    // Dispatch through generic Arc<dyn Slot> — no type matching
    for slot_name in &["db", "query"] {
        let slot = registry.resolve(slot_name).expect("resolve");
        let methods = slot.methods();
        assert!(!methods.is_empty(), "slot should have at least one method");

        let partition = PartitionKey::from_digest(0x1F, vec![5u8; 32]);
        let address = FactAddress::from_digest(0x1F, vec![6u8; 32]);
        let env = Envelope::minimal(partition, address, Some(Bytes::from("data")));

        let result = slot.dispatch(vec![env]);
        assert!(result.is_ok(), "generic dispatch should work");
    }
}

#[test]
fn test_envelope_retraction_dispatch() {
    let registry = SlotRegistry::new();
    let slot: Arc<dyn Slot> = Arc::new(DatabaseSlot {
        name: "retract".to_string(),
    });

    registry.register("retract_slot".to_string(), slot);

    let resolved = registry.resolve("retract_slot").expect("resolve");

    // Create a retraction (payload is None)
    let partition = PartitionKey::from_digest(0x1F, vec![7u8; 32]);
    let address = FactAddress::from_digest(0x1F, vec![8u8; 32]);
    let expected = Hash::from_multihash(partition.as_multihash().clone());
    let retraction = Envelope::minimal(partition, address, None); // No payload = retraction

    assert!(retraction.is_retraction(), "should be a retraction");

    let receipt = resolved
        .dispatch(vec![retraction])
        .expect("dispatch retraction");
    assert_eq!(receipt, expected);
}
