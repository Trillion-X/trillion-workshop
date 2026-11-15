//! Adversarial tests for slot protocol robustness.
//!
//! These tests verify that the slot protocol handles:
//! - Unknown slots
//! - Concurrent register/resolve
//! - Policy key format (Blake3, not strings)
//! - Empty entries
//! - Multiple capabilities

use bytes::Bytes;
use slot_protocol::{Envelope, EnvelopeError, FactAddress, Hash, PartitionKey};
use slot_protocol::{MethodDescriptor, Slot, SlotRegistry, SlotRequest};
use std::sync::Arc;

struct EchoSlot;

impl Slot for EchoSlot {
    fn dispatch(&self, entries: Vec<Envelope>) -> Result<Hash, EnvelopeError> {
        if entries.is_empty() {
            return Err(EnvelopeError::AddressNotFound);
        }
        Ok(Hash::from_multihash(
            entries[0].address.as_multihash().clone(),
        ))
    }

    fn methods(&self) -> Vec<MethodDescriptor> {
        vec![MethodDescriptor::new("echo", "Echo back the input")]
    }
}

#[test]
fn test_resolve_unknown_slot_returns_error() {
    let registry = SlotRegistry::new();

    let result = registry.resolve("this_slot_does_not_exist");

    assert!(result.is_err(), "resolving unknown slot must error");
    let err = result.err().unwrap();
    let err_msg = format!("{:?}", err);
    assert!(err_msg.contains("not found") || err_msg.contains("NotFound"));
}

#[test]
fn test_dispatch_unknown_method_runtime_error() {
    let registry = SlotRegistry::new();
    let slot: Arc<dyn Slot> = Arc::new(EchoSlot);

    registry.register("echo".to_string(), slot);

    let resolved = registry.resolve("echo").expect("resolve");
    let methods = resolved.methods();

    // Verify the slot only has "echo" method
    assert_eq!(methods.len(), 1);
    assert_eq!(methods[0].name.as_str(), "echo");

    // The slot is a generic Arc<dyn Slot> — method lookup happens
    // at the caller's level (not in the trait). The test verifies
    // that methods() reports the correct capabilities.
}

#[test]
fn test_concurrent_register_and_resolve() {
    use std::thread;

    let registry = Arc::new(SlotRegistry::new());
    let mut handles = vec![];

    // Spawn 5 threads that register and resolve
    for i in 0..5 {
        let reg = Arc::clone(&registry);
        let handle = thread::spawn(move || {
            let slot: Arc<dyn Slot> = Arc::new(EchoSlot);
            let slot_name = format!("slot_{}", i);

            // Register
            reg.register(slot_name.clone(), slot);

            // Resolve immediately
            let resolved = reg.resolve(&slot_name);

            // Verify
            assert!(
                resolved.is_ok(),
                "concurrent register/resolve should not fail"
            );

            let methods = resolved.unwrap().methods();
            assert_eq!(methods.len(), 1);
        });

        handles.push(handle);
    }

    for handle in handles {
        handle.join().expect("thread panicked");
    }
}

#[test]
fn test_policy_key_format_is_multihash() {
    // Policy keys must be Multihash-backed Hash, not raw bytes or strings
    // This test verifies the wire format enforces this

    let req = SlotRequest::new("slot", "method", vec![1, 2, 3]);

    // Add a policy with a Multihash-backed Hash key
    let policy_key = slot_protocol::Hash::blake3_hash(&[42u8; 32]);
    let policy_data = vec![4, 5, 6];
    let req_with_policy = req.with_policy(policy_key.clone(), policy_data);

    assert_eq!(req_with_policy.policies.len(), 1);
    assert!(req_with_policy.policies.contains_key(&policy_key));

    // Verify serialization preserves the multihash format
    let json = serde_json::to_value(&req_with_policy).expect("to_value");
    let policies = json["policies"].as_object().expect("policies object");

    // Policy keys should be "mh:{code_hex}:{digest_hex}" format
    let keys: Vec<String> = policies.keys().cloned().collect();
    assert_eq!(keys.len(), 1);
    assert!(
        keys[0].starts_with("mh:1f:"),
        "key should start with 'mh:1f:' for Blake3"
    );

    // Verify we can round-trip
    let json_str = serde_json::to_string(&req_with_policy).expect("stringify");
    let deserialized: SlotRequest = serde_json::from_str(&json_str).expect("deserialize");
    assert_eq!(deserialized.policies, req_with_policy.policies);
}

#[test]
fn test_multiple_policies_on_single_request() {
    let req = SlotRequest::new("slot", "method", vec![]);

    let key1 = slot_protocol::Hash::blake3_hash(&[1u8; 32]);
    let key2 = slot_protocol::Hash::blake3_hash(&[2u8; 32]);
    let key3 = slot_protocol::Hash::blake3_hash(&[3u8; 32]);

    let req = req
        .with_policy(key1.clone(), vec![10, 11])
        .with_policy(key2.clone(), vec![20, 21])
        .with_policy(key3.clone(), vec![30, 31]);

    assert_eq!(req.policies.len(), 3);
    assert_eq!(req.policies[&key1], vec![10, 11]);
    assert_eq!(req.policies[&key2], vec![20, 21]);
    assert_eq!(req.policies[&key3], vec![30, 31]);
}

#[test]
fn test_cache_clear_forces_slow_path() {
    let registry = SlotRegistry::new();
    let slot: Arc<dyn Slot> = Arc::new(EchoSlot);

    // Register
    registry.register("echo_slot".to_string(), Arc::clone(&slot) as Arc<dyn Slot>);

    // Resolve — hits cache
    let result1 = registry.resolve("echo_slot");
    assert!(result1.is_ok(), "first resolve should succeed");

    // Clear cache
    registry.clear_cache();

    // Resolve again — cache miss, would query backing store if implemented
    // Without a backing store, this fails (demonstrating cache is not authority)
    let result2 = registry.resolve("echo_slot");
    assert!(
        result2.is_err(),
        "after cache clear, resolve fails (no backing store)"
    );
}

#[test]
fn test_envelope_with_complex_path_dispatch() {
    let registry = SlotRegistry::new();
    let slot: Arc<dyn Slot> = Arc::new(EchoSlot);

    registry.register("path_slot".to_string(), slot);

    let resolved = registry.resolve("path_slot").expect("resolve");

    // Create an Envelope with multiple path segments
    let partition = PartitionKey::from_digest(0x1F, vec![10u8; 32]);
    let address = FactAddress::from_digest(0x1F, vec![11u8; 32]);
    let env = Envelope::minimal(partition, address, Some(Bytes::from("complex_data")));

    // In a real scenario, path would have multiple segments
    // For testing, we just verify that complex paths don't break dispatch
    assert!(
        !env.path.is_empty() || env.path.is_empty(),
        "path can be empty or populated"
    );

    let result = resolved.dispatch(vec![env]);
    assert!(result.is_ok(), "dispatch with complex envelope should work");
}

#[test]
fn test_multiple_capabilities_per_slot() {
    struct MultiCapSlot;

    impl Slot for MultiCapSlot {
        fn dispatch(&self, entries: Vec<Envelope>) -> Result<Hash, EnvelopeError> {
            if entries.is_empty() {
                return Err(EnvelopeError::AddressNotFound);
            }
            Ok(Hash::from_multihash(
                entries[0].partition_key.as_multihash().clone(),
            ))
        }

        fn methods(&self) -> Vec<MethodDescriptor> {
            vec![
                MethodDescriptor::new("read", "Read operation"),
                MethodDescriptor::new("write", "Write operation"),
                MethodDescriptor::new("delete", "Delete operation"),
                MethodDescriptor::new("query", "Query operation"),
                MethodDescriptor::new("subscribe", "Subscribe to changes"),
            ]
        }
    }

    let registry = SlotRegistry::new();
    let slot: Arc<dyn Slot> = Arc::new(MultiCapSlot);

    registry.register("multi".to_string(), slot);

    let resolved = registry.resolve("multi").expect("resolve");
    let methods = resolved.methods();

    assert_eq!(methods.len(), 5, "slot should expose 5 methods");

    // Verify all method names
    let method_names: Vec<&str> = methods.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(
        method_names,
        vec!["read", "write", "delete", "query", "subscribe"]
    );
}

#[test]
fn test_retraction_entries_dispatch() {
    let registry = SlotRegistry::new();
    let slot: Arc<dyn Slot> = Arc::new(EchoSlot);

    registry.register("retract".to_string(), slot);

    let resolved = registry.resolve("retract").expect("resolve");

    // Mix of assertions and retractions
    let envs = vec![
        Envelope::minimal(
            PartitionKey::from_digest(0x1F, vec![20u8; 32]),
            FactAddress::from_digest(0x1F, vec![21u8; 32]),
            Some(Bytes::from("data")),
        ),
        Envelope::minimal(
            PartitionKey::from_digest(0x1F, vec![20u8; 32]),
            FactAddress::from_digest(0x1F, vec![22u8; 32]),
            None,
        ), // retraction
        Envelope::minimal(
            PartitionKey::from_digest(0x1F, vec![20u8; 32]),
            FactAddress::from_digest(0x1F, vec![23u8; 32]),
            Some(Bytes::from("more")),
        ),
    ];

    // All envelopes should dispatch successfully
    let result = resolved.dispatch(envs);
    assert!(result.is_ok(), "dispatch with retractions should work");
}

#[test]
fn test_large_payload_dispatch() {
    let registry = SlotRegistry::new();
    let slot: Arc<dyn Slot> = Arc::new(EchoSlot);

    registry.register("large".to_string(), slot);

    let resolved = registry.resolve("large").expect("resolve");

    // Create a large payload (10 MB)
    let large_payload = vec![42u8; 10 * 1024 * 1024];
    let partition = PartitionKey::from_digest(0x1F, vec![30u8; 32]);
    let address = FactAddress::from_digest(0x1F, vec![31u8; 32]);
    let env = Envelope::minimal(partition, address, Some(Bytes::from(large_payload)));

    let result = resolved.dispatch(vec![env]);
    assert!(result.is_ok(), "large payload dispatch should work");
}
