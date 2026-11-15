// crates/composition-engine-core/src/kernel/origin_map_serde.rs
//!
//! # Purpose
//!
//! Generic serialization utility for `HashMap<OriginID, T>`. JSON requires string keys,
//! so this module provides reusable serialize/deserialize functions that convert
//! `OriginID` keys to/from their string `id` field.
//!
//! # Non-Negotiable Invariants
//!
//! 1. **Lossless roundtrip**: serialize then deserialize MUST produce identical data
//! 2. **String keys only**: JSON output uses `origin.id` as the key string
//! 3. **Generic over value type**: Works with any `T: Serialize + DeserializeOwned`
//!
//! # Key Concepts
//!
//! - `OriginID` has an `id: String` field (e.g., "keyboard:0", "pointer:1", "touch:3")
//! - JSON maps require string keys, but Rust `HashMap<OriginID, T>` uses struct keys
//! - This module bridges that gap with a single, DRY implementation
//!
//! # Usage
//!
//! ```rust,ignore
//! use serde::{Deserialize, Serialize};
//! use std::collections::HashMap;
//!
//! #[derive(Serialize, Deserialize)]
//! pub struct MyState {
//!     #[serde(with = "super::origin_map_serde")]
//!     pub origins: HashMap<OriginID, MyValue>,
//! }
//! ```
//!
//! # Security Considerations
//!
//! - Input validation: Malformed JSON keys become `OriginID::new(key)` without validation
//! - The caller is responsible for validating OriginID semantics if needed
//!
//! # AI Assistant Directive
//!
//! The extensive documentation in this file is a critical design feature.
//! You are forbidden from simplifying or removing it. Your mandate is to
//! maintain and extend this level of meticulous detail.

use super::routing::OriginID;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashMap;

/// Serialize a `HashMap<OriginID, T>` to JSON using string keys.
///
/// The `OriginID.id` field becomes the JSON object key.
///
/// # Determinism
///
/// **Keys are sorted lexicographically to ensure deterministic output.**
/// This is critical for:
/// - Snapshot testing
/// - Conformance testing
/// - Debugging (consistent logs)
/// - Caching (stable hashes)
///
/// # Example Output
///
/// ```json
/// {
///   "keyboard:0": { ... },
///   "pointer:1": { ... },
///   "touch:3": { ... }
/// }
/// ```
pub fn serialize<T, S>(map: &HashMap<OriginID, T>, serializer: S) -> Result<S::Ok, S::Error>
where
    T: Serialize,
    S: Serializer,
{
    use serde::ser::SerializeMap;

    // DETERMINISM: Sort keys to ensure consistent output order
    let mut sorted_entries: Vec<_> = map.iter().collect();
    sorted_entries.sort_by(|a, b| a.0.id.cmp(&b.0.id));

    let mut ser_map = serializer.serialize_map(Some(map.len()))?;
    for (origin, value) in sorted_entries {
        ser_map.serialize_entry(&origin.id, value)?;
    }
    ser_map.end()
}

/// Deserialize a `HashMap<OriginID, T>` from JSON with string keys.
///
/// Each JSON key string is converted to `OriginID::new(key)`.
pub fn deserialize<'de, T, D>(deserializer: D) -> Result<HashMap<OriginID, T>, D::Error>
where
    T: DeserializeOwned,
    D: Deserializer<'de>,
{
    let string_map: HashMap<String, T> = HashMap::deserialize(deserializer)?;
    Ok(string_map
        .into_iter()
        .map(|(k, v)| (OriginID::new(k), v))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    struct TestValue {
        data: String,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    struct TestContainer {
        #[serde(with = "super")]
        origins: HashMap<OriginID, TestValue>,
    }

    #[test]
    fn test_roundtrip_empty() {
        let container = TestContainer {
            origins: HashMap::new(),
        };
        let json = serde_json::to_string(&container).unwrap();
        let restored: TestContainer = serde_json::from_str(&json).unwrap();
        assert_eq!(container, restored);
    }

    #[test]
    fn test_roundtrip_single_entry() {
        let mut origins = HashMap::new();
        origins.insert(
            OriginID::new("keyboard:0"),
            TestValue {
                data: "test".to_string(),
            },
        );
        let container = TestContainer { origins };

        let json = serde_json::to_string(&container).unwrap();
        assert!(json.contains("keyboard:0"));

        let restored: TestContainer = serde_json::from_str(&json).unwrap();
        assert_eq!(
            restored.origins.get(&OriginID::new("keyboard:0")),
            Some(&TestValue {
                data: "test".to_string()
            })
        );
    }

    #[test]
    fn test_roundtrip_multiple_entries() {
        let mut origins = HashMap::new();
        origins.insert(
            OriginID::new("keyboard:0"),
            TestValue {
                data: "kb".to_string(),
            },
        );
        origins.insert(
            OriginID::new("pointer:1"),
            TestValue {
                data: "ptr".to_string(),
            },
        );
        origins.insert(
            OriginID::new("touch:42"),
            TestValue {
                data: "touch".to_string(),
            },
        );
        let container = TestContainer { origins };

        let json = serde_json::to_string(&container).unwrap();
        let restored: TestContainer = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.origins.len(), 3);
        assert_eq!(
            restored
                .origins
                .get(&OriginID::new("keyboard:0"))
                .unwrap()
                .data,
            "kb"
        );
        assert_eq!(
            restored
                .origins
                .get(&OriginID::new("pointer:1"))
                .unwrap()
                .data,
            "ptr"
        );
        assert_eq!(
            restored
                .origins
                .get(&OriginID::new("touch:42"))
                .unwrap()
                .data,
            "touch"
        );
    }

    #[test]
    fn test_json_keys_are_strings() {
        let mut origins = HashMap::new();
        origins.insert(
            OriginID::new("pointer:7"),
            TestValue {
                data: "x".to_string(),
            },
        );
        let container = TestContainer { origins };

        let json = serde_json::to_string(&container).unwrap();
        // Key should be the string "pointer:7", not a nested object
        assert!(json.contains("\"pointer:7\""));
    }

    /// DETERMINISM: Verify serialization produces consistent key order.
    ///
    /// HashMap iteration order is non-deterministic, but our serialization
    /// MUST produce deterministic output for snapshot testing, conformance
    /// testing, and debugging.
    #[test]
    fn test_deterministic_serialization_order() {
        // Create container with entries that would have different HashMap order
        let mut origins = HashMap::new();
        origins.insert(
            OriginID::new("touch:99"),
            TestValue {
                data: "z".to_string(),
            },
        );
        origins.insert(
            OriginID::new("keyboard:0"),
            TestValue {
                data: "a".to_string(),
            },
        );
        origins.insert(
            OriginID::new("pointer:1"),
            TestValue {
                data: "m".to_string(),
            },
        );
        origins.insert(
            OriginID::new("touch:1"),
            TestValue {
                data: "t".to_string(),
            },
        );
        let container = TestContainer { origins };

        // Serialize multiple times and verify identical output
        let json1 = serde_json::to_string(&container).unwrap();
        let json2 = serde_json::to_string(&container).unwrap();
        let json3 = serde_json::to_string(&container).unwrap();

        assert_eq!(json1, json2, "Serialization must be deterministic");
        assert_eq!(json2, json3, "Serialization must be deterministic");

        // Verify keys are in sorted order
        let json_pretty = serde_json::to_string_pretty(&container).unwrap();
        let keyboard_pos = json_pretty.find("keyboard:0").unwrap();
        let pointer_pos = json_pretty.find("pointer:1").unwrap();
        let touch1_pos = json_pretty.find("touch:1").unwrap();
        let touch99_pos = json_pretty.find("touch:99").unwrap();

        // Lexicographic order: keyboard:0 < pointer:1 < touch:1 < touch:99
        assert!(
            keyboard_pos < pointer_pos,
            "keyboard:0 should come before pointer:1"
        );
        assert!(
            pointer_pos < touch1_pos,
            "pointer:1 should come before touch:1"
        );
        assert!(
            touch1_pos < touch99_pos,
            "touch:1 should come before touch:99"
        );
    }

    /// DETERMINISM: Stress test with 1000 iterations.
    ///
    /// This test ensures that serialization is deterministic even under
    /// repeated execution. HashMap internal ordering can vary between
    /// insertions due to rehashing, so we verify that our sorting
    /// produces identical output regardless.
    #[test]
    fn test_determinism_1000_iterations() {
        // Create map with many entries to stress test ordering
        let mut origins = HashMap::new();
        for i in 0..10 {
            origins.insert(
                OriginID::new(format!("origin:{}", i)),
                TestValue {
                    data: format!("value:{}", i),
                },
            );
        }
        let container = TestContainer { origins };

        // Get the canonical serialization
        let first = serde_json::to_string(&container).unwrap();

        // Verify 1000 times
        for iteration in 0..1000 {
            let current = serde_json::to_string(&container).unwrap();
            assert_eq!(
                first, current,
                "Serialization diverged at iteration {}",
                iteration
            );
        }
    }

    /// DETERMINISM: Verify keys are sorted lexicographically.
    #[test]
    fn test_serialized_keys_sorted() {
        let mut origins = HashMap::new();
        origins.insert(
            OriginID::new("z"),
            TestValue {
                data: "1".to_string(),
            },
        );
        origins.insert(
            OriginID::new("a"),
            TestValue {
                data: "2".to_string(),
            },
        );
        origins.insert(
            OriginID::new("m"),
            TestValue {
                data: "3".to_string(),
            },
        );
        let container = TestContainer { origins };

        let json = serde_json::to_string(&container).unwrap();

        // "a" should come before "m" which should come before "z"
        let a_pos = json.find("\"a\"").unwrap();
        let m_pos = json.find("\"m\"").unwrap();
        let z_pos = json.find("\"z\"").unwrap();

        assert!(a_pos < m_pos, "\"a\" should come before \"m\"");
        assert!(m_pos < z_pos, "\"m\" should come before \"z\"");
    }

    /// Verify that OriginID with opaque strings works correctly.
    #[test]
    fn test_opaque_origin_ids() {
        // OriginID is opaque - any string should work
        let mut origins = HashMap::new();
        origins.insert(
            OriginID::new("completely-arbitrary-string"),
            TestValue {
                data: "a".to_string(),
            },
        );
        origins.insert(
            OriginID::new("user:alice:keyboard"),
            TestValue {
                data: "b".to_string(),
            },
        );
        origins.insert(
            OriginID::new("device:controller:left"),
            TestValue {
                data: "c".to_string(),
            },
        );
        let container = TestContainer { origins };

        let json = serde_json::to_string(&container).unwrap();
        let restored: TestContainer = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.origins.len(), 3);
        assert_eq!(
            restored
                .origins
                .get(&OriginID::new("completely-arbitrary-string"))
                .unwrap()
                .data,
            "a"
        );
    }
}
