//! Wire format for slot requests and responses.
//!
//! SlotRequest carries:
//! - The slot to invoke
//! - The method to call
//! - Policy keys as content-addressed Multihash-backed Hash values
//!
//! Policy keys are Multihash-backed Hash (e.g., Hash::blake3_hash(b"policy::lifetime::ephemeral")).
//! This eliminates string convention hints and collision risk at quintillion scale.
//!
//! Policies are Envelope-backed: each policy key resolves to an Envelope in state
//! that defines the policy's semantics.

use crate::newtypes::Hash;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A request to invoke a slot method.
///
/// # Invariants
///
/// - `slot_name` identifies the slot
/// - `method_name` identifies the method
/// - `policies` maps content-addressed Multihash-backed Hash keys to policy data
/// - Policy keys are deterministic: Hash of the policy definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotRequest {
    /// Name of the slot to invoke.
    pub slot_name: String,

    /// Name of the method to call.
    pub method_name: String,

    /// Request payload (CBOR or other binary format).
    pub payload: Vec<u8>,

    /// Policy keys mapped to policy data.
    /// Keys are Multihash-backed Hash values (content-addressed).
    /// Values are the policy data (opaque bytes).
    #[serde(with = "policies_serde")]
    pub policies: HashMap<Hash, Vec<u8>>,
}

/// Serde helpers for HashMap<Hash, Vec<u8>>.
/// Serializes Hash keys as "mh:{algo_code_hex}:{digest_hex}" strings.
/// Algorithm-agile: preserves the hash algorithm in the wire format.
mod policies_serde {
    use crate::newtypes::Hash;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::collections::HashMap;

    pub fn serialize<S: Serializer>(
        policies: &HashMap<Hash, Vec<u8>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        use base64::Engine as _;
        let engine = base64::engine::general_purpose::STANDARD;

        let string_map: HashMap<String, String> = policies
            .iter()
            .map(|(k, v)| {
                let key_str = format!("mh:{:x}:{}", k.algo_code(), hex::encode(k.digest()));
                (key_str, engine.encode(v))
            })
            .collect();
        string_map.serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<HashMap<Hash, Vec<u8>>, D::Error> {
        use base64::Engine as _;
        let engine = base64::engine::general_purpose::STANDARD;

        let map = serde_json::Map::deserialize(deserializer)?;
        let mut result = HashMap::new();

        for (key_str, value) in map {
            let hash = parse_multihash_key(&key_str).map_err(serde::de::Error::custom)?;

            let value_str = value
                .as_str()
                .ok_or_else(|| serde::de::Error::custom("policy value must be base64 string"))?;
            let value_bytes = engine.decode(value_str).map_err(serde::de::Error::custom)?;

            result.insert(hash, value_bytes);
        }

        Ok(result)
    }

    /// Parse a multihash key string in format "mh:{algo_code_hex}:{digest_hex}".
    fn parse_multihash_key(key: &str) -> Result<Hash, String> {
        use content_crypto::Multihash as CryptoMultihash;

        let parts: Vec<&str> = key.splitn(3, ':').collect();
        if parts.len() != 3 || parts[0] != "mh" {
            return Err(format!(
                "invalid multihash key format: expected 'mh:{{code}}:{{digest}}', got '{}'",
                key
            ));
        }

        let algo_code = u64::from_str_radix(parts[1], 16)
            .map_err(|e| format!("invalid algo code hex '{}': {}", parts[1], e))?;

        let digest = hex::decode(parts[2])
            .map_err(|e| format!("invalid digest hex '{}': {}", parts[2], e))?;

        Ok(Hash::from_multihash(
            CryptoMultihash::from_digest(algo_code, digest)
                .map_err(|e| format!("invalid digest length: {}", e))?,
        ))
    }
}

impl SlotRequest {
    /// Create a new SlotRequest.
    pub fn new(
        slot_name: impl Into<String>,
        method_name: impl Into<String>,
        payload: Vec<u8>,
    ) -> Self {
        SlotRequest {
            slot_name: slot_name.into(),
            method_name: method_name.into(),
            payload,
            policies: HashMap::new(),
        }
    }

    /// Add a policy with a content-addressed Multihash-backed Hash key.
    pub fn with_policy(mut self, key: Hash, value: Vec<u8>) -> Self {
        self.policies.insert(key, value);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slot_request_creation() {
        let req = SlotRequest::new("my-slot", "get", vec![1, 2, 3]);
        assert_eq!(req.slot_name, "my-slot");
        assert_eq!(req.method_name, "get");
        assert_eq!(req.payload, vec![1, 2, 3]);
        assert!(req.policies.is_empty());
    }

    #[test]
    fn test_slot_request_with_policy() {
        let policy_key = Hash::blake3_hash(&[42u8; 32]);
        let policy_value = vec![1, 2, 3];
        let req = SlotRequest::new("slot", "method", vec![])
            .with_policy(policy_key.clone(), policy_value.clone());

        assert_eq!(req.policies.len(), 1);
        assert_eq!(req.policies[&policy_key], policy_value);
    }

    #[test]
    fn test_slot_request_serde() {
        let policy_key = Hash::blake3_hash(&[42u8; 32]);
        let req = SlotRequest::new("slot", "method", vec![1, 2, 3])
            .with_policy(policy_key.clone(), vec![4, 5, 6]);

        let json = serde_json::to_string(&req).expect("serialize");
        let deserialized: SlotRequest = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(req.slot_name, deserialized.slot_name);
        assert_eq!(req.method_name, deserialized.method_name);
        assert_eq!(req.payload, deserialized.payload);
        assert_eq!(req.policies, deserialized.policies);
    }

    #[test]
    fn test_policy_key_is_multihash() {
        let key = Hash::blake3_hash(&[1u8; 32]);
        let req = SlotRequest::new("s", "m", vec![]).with_policy(key.clone(), vec![]);

        let json = serde_json::to_value(&req).expect("to_value");
        let policies = json["policies"].as_object().expect("policies is object");

        // Verify key is "mh:{code_hex}:{digest_hex}" format
        let keys: Vec<String> = policies.keys().cloned().collect();
        assert_eq!(keys.len(), 1);
        assert!(
            keys[0].starts_with("mh:1f:"),
            "key should start with 'mh:1f:' for Blake3, got: {}",
            keys[0]
        );
        // "mh:" + 2 hex chars for code + ":" + 64 hex chars for digest = 70 chars
        assert_eq!(
            keys[0].len(),
            70,
            "key should be 70 chars: 'mh:1f:' + 64 hex digest"
        );
    }
}
