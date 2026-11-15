//! Policy resolution module for slot requests.
//!
//! Policies are Envelope-backed data, not Rust enums (L090).
//! Policy keys are content-addressed Multihash-backed Hash values.
//! The resolver is completely generic — it knows nothing about "lifetime", "scope",
//! or any other Society concepts. It simply maps hash → Envelope definition.
//!
//! # Architecture
//!
//! - **Physics only**: Policy resolution is pure data lookup. No enumeration.
//! - **L090 compliance**: Handler never enumerates what it handles.
//!   The system dispatches based on policy presence, not policy identity.
//! - **Content-addressed**: Policy keys are deterministic Multihash-backed hashes,
//!   enabling deterministic policy resolution at any scale.
//! - **Opaque definitions**: Policy Envelope payloads are never interpreted by this module.
//!
//! # Invariants
//!
//! 1. Policy keys are Multihash-backed Hash (algorithm-agile, currently Blake3-256).
//! 2. Each policy key maps to exactly one Envelope definition.
//! 3. Policy resolution is deterministic: same key always resolves to same definition.
//! 4. Validation checks presence only, not semantics (L090).

use crate::error::EnvelopeError;
use crate::newtypes::Hash;
use crate::Envelope;
use std::collections::HashMap;
use std::sync::Arc;

/// A policy that has been resolved from a SlotRequest.
///
/// Contains the policy key, its Envelope definition, and the request data associated with it.
#[derive(Debug, Clone)]
pub struct ResolvedPolicy {
    /// The Multihash-backed policy key (content address).
    pub key: Hash,

    /// The Envelope definition of the policy.
    pub definition: Arc<Envelope>,

    /// Opaque policy data from the SlotRequest.
    /// This is never interpreted by the resolver.
    pub request_data: Vec<u8>,
}

/// Resolves policy keys from SlotRequest to their Envelope definitions.
///
/// The resolver maintains a registry of policy definitions keyed by Multihash-backed Hash.
/// It performs no interpretation of policy semantics — it is purely a data store.
#[derive(Debug, Clone)]
pub struct PolicyResolver {
    /// Maps policy Hash → Envelope definition.
    policies: HashMap<Hash, Arc<Envelope>>,
}

impl PolicyResolver {
    /// Create a new, empty policy resolver.
    pub fn new() -> Self {
        PolicyResolver {
            policies: HashMap::new(),
        }
    }

    /// Register a policy definition.
    ///
    /// # Arguments
    ///
    /// * `key` - A Multihash-backed Hash serving as the policy's content address.
    /// * `definition` - The Envelope that defines the policy.
    ///
    /// # Invariants
    ///
    /// - The key should be a deterministic hash of the policy definition
    ///   (though this module does not enforce it).
    /// - Registering the same key twice overwrites the previous definition.
    pub fn register(&mut self, key: Hash, definition: Arc<Envelope>) {
        self.policies.insert(key, definition);
    }

    /// Resolve a set of policy keys from a SlotRequest.
    ///
    /// # Arguments
    ///
    /// * `request_policies` - HashMap from policy Hash to request data
    ///
    /// # Returns
    ///
    /// A Vec of ResolvedPolicy containing only policies that are registered.
    /// Unregistered policies are silently omitted (not errors).
    ///
    /// # Semantics
    ///
    /// This function is completely generic. It does not care what the policies mean —
    /// it only resolves registered keys to their definitions.
    pub fn resolve(&self, request_policies: &HashMap<Hash, Vec<u8>>) -> Vec<ResolvedPolicy> {
        request_policies
            .iter()
            .filter_map(|(key, request_data)| {
                self.policies.get(key).map(|definition| ResolvedPolicy {
                    key: key.clone(),
                    definition: Arc::clone(definition),
                    request_data: request_data.clone(),
                })
            })
            .collect()
    }

    /// Validate that all required policies are present in the request.
    ///
    /// # Arguments
    ///
    /// * `required` - Slice of required policy keys.
    /// * `provided` - HashMap of provided policies from the request.
    ///
    /// # Returns
    ///
    /// `Ok(())` if all required keys are present in provided.
    /// `Err(EnvelopeError::AddressNotFound)` if any required key is missing.
    ///
    /// # Semantics
    ///
    /// This validates the request shape — not the policy semantics.
    /// AddressNotFound is used to indicate a policy key resolution failure.
    pub fn validate(
        &self,
        required: &[Hash],
        provided: &HashMap<Hash, Vec<u8>>,
    ) -> Result<(), EnvelopeError> {
        for key in required {
            if !provided.contains_key(key) {
                return Err(EnvelopeError::AddressNotFound);
            }
        }
        Ok(())
    }

    /// Return the number of registered policies.
    #[cfg(test)]
    fn policy_count(&self) -> usize {
        self.policies.len()
    }
}

impl Default for PolicyResolver {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FactAddress, PartitionKey};
    use bytes::Bytes;

    /// Helper: create a Multihash-backed Hash from a byte string.
    fn policy_hash(data: &[u8]) -> Hash {
        Hash::blake3_hash(data)
    }

    /// Helper: create a minimal Envelope for testing.
    fn test_envelope(data: &[u8]) -> Arc<Envelope> {
        let partition = PartitionKey::from_digest(0x1F, vec![1u8; 32]);
        let address = FactAddress::from_digest(0x1F, vec![2u8; 32]);
        let payload = Some(Bytes::from(data.to_vec()));
        Arc::new(Envelope::minimal(partition, address, payload))
    }

    #[test]
    fn test_register_and_resolve_policy() {
        let mut resolver = PolicyResolver::new();
        let key = policy_hash(b"policy::lifetime::ephemeral");
        let definition = test_envelope(b"lifetime data");

        // Register
        resolver.register(key.clone(), definition.clone());
        assert_eq!(resolver.policy_count(), 1);

        // Resolve
        let mut request_policies = HashMap::new();
        request_policies.insert(key.clone(), vec![1, 2, 3]);

        let resolved = resolver.resolve(&request_policies);
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].key, key);
        assert_eq!(resolved[0].request_data, vec![1, 2, 3]);
        assert_eq!(resolved[0].definition.address, definition.address);
    }

    #[test]
    fn test_resolve_unknown_policy() {
        let resolver = PolicyResolver::new();
        let unknown_key = policy_hash(b"policy::unknown");

        let mut request_policies = HashMap::new();
        request_policies.insert(unknown_key, vec![1, 2, 3]);

        let resolved = resolver.resolve(&request_policies);
        assert!(resolved.is_empty(), "unknown policy should be omitted");
    }

    #[test]
    fn test_validate_required_policies_present() {
        let mut resolver = PolicyResolver::new();
        let key1 = policy_hash(b"policy::one");
        let key2 = policy_hash(b"policy::two");

        resolver.register(key1.clone(), test_envelope(b"one"));
        resolver.register(key2.clone(), test_envelope(b"two"));

        let mut request_policies = HashMap::new();
        request_policies.insert(key1.clone(), vec![1, 2]);
        request_policies.insert(key2.clone(), vec![3, 4]);

        let result = resolver.validate(&[key1, key2], &request_policies);
        assert!(result.is_ok(), "all required policies present");
    }

    #[test]
    fn test_validate_required_policies_missing() {
        let mut resolver = PolicyResolver::new();
        let key1 = policy_hash(b"policy::one");
        let key2 = policy_hash(b"policy::two");

        resolver.register(key1.clone(), test_envelope(b"one"));

        let mut request_policies = HashMap::new();
        request_policies.insert(key1.clone(), vec![1, 2]);

        let result = resolver.validate(&[key1, key2], &request_policies);
        assert!(result.is_err(), "missing required policy should fail");
    }

    #[test]
    fn test_policy_keys_are_multihash() {
        let key1 = policy_hash(b"policy::lifetime::ephemeral");
        let key2 = policy_hash(b"policy::lifetime::ephemeral");

        assert_eq!(key1, key2, "same input should produce same hash");
        assert_eq!(key1.digest().len(), 32, "digest must be exactly 32 bytes");
        assert!(key1.is_blake3(), "key must be Blake3");

        // Different inputs produce different hashes
        let key3 = policy_hash(b"policy::lifetime::long");
        assert_ne!(
            key1, key3,
            "different inputs should produce different hashes"
        );
    }

    #[test]
    fn test_custom_user_defined_policy() {
        let mut resolver = PolicyResolver::new();

        // Register a completely custom policy (no "lifetime" or "scope" enum)
        let custom_key = policy_hash(b"custom::policy::my_thing");
        let custom_def = test_envelope(b"custom policy definition");
        resolver.register(custom_key.clone(), custom_def.clone());

        // Resolve it
        let mut request_policies = HashMap::new();
        request_policies.insert(custom_key.clone(), vec![99, 88, 77]);

        let resolved = resolver.resolve(&request_policies);
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].key, custom_key);
        assert_eq!(resolved[0].request_data, vec![99, 88, 77]);
    }

    #[test]
    fn test_12_axis_combinations() {
        let mut resolver = PolicyResolver::new();

        // Create 3 lifetime variants × 4 scope variants = 12 combinations
        let lifetimes = ["ephemeral", "session", "persistent"];
        let scopes = ["local", "workspace", "shared", "global"];

        let mut all_keys = Vec::new();

        for lifetime in &lifetimes {
            for scope in &scopes {
                let policy_name = format!("policy::lifetime::{}::scope::{}", lifetime, scope);
                let key = policy_hash(policy_name.as_bytes());
                let definition = test_envelope(format!("{} {}", lifetime, scope).as_bytes());

                resolver.register(key.clone(), definition);
                all_keys.push(key);
            }
        }

        // Verify all 12 are registered
        assert_eq!(resolver.policy_count(), 12);

        // Build request with all 12
        let mut request_policies = HashMap::new();
        for (i, key) in all_keys.iter().enumerate() {
            request_policies.insert(key.clone(), vec![i as u8]);
        }

        // Resolve all
        let resolved = resolver.resolve(&request_policies);
        assert_eq!(resolved.len(), 12, "all 12 combinations should resolve");
    }

    #[test]
    fn test_no_lifetime_or_scope_enum() {
        let resolver = PolicyResolver::new();
        assert_eq!(resolver.policy_count(), 0);
    }

    #[test]
    fn test_multiple_policies_same_request() {
        let mut resolver = PolicyResolver::new();

        let key1 = policy_hash(b"policy::one");
        let key2 = policy_hash(b"policy::two");
        let key3 = policy_hash(b"policy::three");

        resolver.register(key1.clone(), test_envelope(b"definition 1"));
        resolver.register(key2.clone(), test_envelope(b"definition 2"));
        resolver.register(key3.clone(), test_envelope(b"definition 3"));

        let mut request_policies = HashMap::new();
        request_policies.insert(key1.clone(), vec![10]);
        request_policies.insert(key2.clone(), vec![20]);
        request_policies.insert(key3.clone(), vec![30]);

        let resolved = resolver.resolve(&request_policies);
        assert_eq!(resolved.len(), 3);

        // Verify each resolved policy
        for resolved_policy in &resolved {
            if resolved_policy.key == key1 {
                assert_eq!(resolved_policy.request_data, vec![10]);
            } else if resolved_policy.key == key2 {
                assert_eq!(resolved_policy.request_data, vec![20]);
            } else if resolved_policy.key == key3 {
                assert_eq!(resolved_policy.request_data, vec![30]);
            }
        }
    }

    #[test]
    fn test_empty_request_policies() {
        let mut resolver = PolicyResolver::new();
        let key = policy_hash(b"policy::test");
        resolver.register(key, test_envelope(b"test"));

        let request_policies = HashMap::new();
        let resolved = resolver.resolve(&request_policies);
        assert!(resolved.is_empty());
    }

    #[test]
    fn test_overwrite_policy_definition() {
        let mut resolver = PolicyResolver::new();
        let key = policy_hash(b"policy::mutable");

        let def1 = test_envelope(b"first definition");
        resolver.register(key.clone(), def1);
        assert_eq!(resolver.policy_count(), 1);

        // Overwrite with new definition
        let def2 = test_envelope(b"second definition");
        resolver.register(key.clone(), def2.clone());
        assert_eq!(resolver.policy_count(), 1);

        // Resolve should return the new definition
        let mut request_policies = HashMap::new();
        request_policies.insert(key, vec![]);

        let resolved = resolver.resolve(&request_policies);
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].definition.address, def2.address);
    }
}
