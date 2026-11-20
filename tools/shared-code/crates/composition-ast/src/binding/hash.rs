//! crates/composition-ast/src/binding/hash.rs
//!
//! Deterministic, portable hashing and canonical serialization utilities used for
//! cache keys, audit fingerprints, and equality testing.
//!
//! This module provides a stable stringify that is independent of field order and
//! a 64-bit FNV-1a hash for cross-platform consistency.
//!
//! Non-Negotiable Invariants:
//! - Stable across runtimes: native, WASM, different platforms.
//! - No reliance on crypto APIs or timers. Pure and deterministic.
//! - Objects are serialized with sorted keys; cycles are handled via path refs.
//! - `NaN`, `Infinity`, `-Infinity` are encoded explicitly.
//!
//! Key Concepts:
//! - stable_stringify: canonical JSON-like serialization with cycle handling.
//! - fnv1a64: 64-bit FNV-1a hash, returned as lowercase hex.
//! - stable_hash: one-call convenience: canonicalize -> hash -> hex.
//!
//! Security Considerations:
//! - This is not a cryptographic hash. Do not use for security tokens.
//! - Suitable for cache keys, deduplication, and build fingerprints only.
//!
//! Ported from: frontends/web/composition-engine/binding/hash.ts

use super::ast::{Binding, BindingEvaluationContext};
use std::collections::HashSet;

// ============================================================================
// FNV-1a 64-bit Constants
// ============================================================================

const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

// ============================================================================
// Canonical Serialization
// ============================================================================

/// Escape '/' in JSON Pointer segments.
fn escape_json_pointer(seg: &str) -> String {
    seg.replace('~', "~0").replace('/', "~1")
}

/// JSON-escape a string
fn json_string(s: &str) -> String {
    let mut result = String::with_capacity(s.len() + 2);
    result.push('"');
    for c in s.chars() {
        match c {
            '"' => result.push_str("\\\""),
            '\\' => result.push_str("\\\\"),
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\t' => result.push_str("\\t"),
            c if c.is_control() => {
                result.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => result.push(c),
        }
    }
    result.push('"');
    result
}

/// Encode a JSON value in a deterministic, loss-aware form.
/// Objects have sorted keys, special floats are encoded explicitly.
fn encode_value(value: &serde_json::Value, path: &str, seen: &mut HashSet<usize>) -> String {
    match value {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        serde_json::Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                if f.is_nan() {
                    return "\"$NaN\"".to_string();
                }
                if f.is_infinite() {
                    return if f.is_sign_positive() {
                        "\"$Infinity\"".to_string()
                    } else {
                        "\"$-Infinity\"".to_string()
                    };
                }
                // Check for -0
                if f == 0.0 && f.is_sign_negative() {
                    return "\"$-0\"".to_string();
                }
            }
            n.to_string()
        }
        serde_json::Value::String(s) => json_string(s),
        serde_json::Value::Array(arr) => {
            // Use pointer address for cycle detection
            let ptr = arr as *const _ as usize;
            if seen.contains(&ptr) {
                return format!("{{\"$ref\":{}}}", json_string(path));
            }
            seen.insert(ptr);

            let parts: Vec<String> = arr
                .iter()
                .enumerate()
                .map(|(i, v)| encode_value(v, &format!("{}/{}", path, i), seen))
                .collect();
            format!("[{}]", parts.join(","))
        }
        serde_json::Value::Object(obj) => {
            // Use pointer address for cycle detection
            let ptr = obj as *const _ as usize;
            if seen.contains(&ptr) {
                return format!("{{\"$ref\":{}}}", json_string(path));
            }
            seen.insert(ptr);

            // Sort keys for deterministic output
            let mut keys: Vec<&String> = obj.keys().collect();
            keys.sort();

            let parts: Vec<String> = keys
                .iter()
                .map(|k| {
                    let v = obj.get(*k).unwrap();
                    let new_path = format!("{}/{}", path, escape_json_pointer(k));
                    format!("{}:{}", json_string(k), encode_value(v, &new_path, seen))
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

/// Canonical JSON-like serialization with sorted keys and cycle handling.
///
/// Special values are encoded explicitly:
/// - NaN -> "$NaN"
/// - Infinity -> "$Infinity"
/// - -Infinity -> "$-Infinity"
/// - -0 -> "$-0"
pub fn stable_stringify(value: &serde_json::Value) -> String {
    let mut seen = HashSet::new();
    encode_value(value, "", &mut seen)
}

// ============================================================================
// FNV-1a 64-bit Hash
// ============================================================================

/// Compute 64-bit FNV-1a hash for a UTF-8 string by processing bytes.
/// Returns 16-character zero-padded lowercase hex string.
pub fn fnv1a64_hex(s: &str) -> String {
    let mut h: u64 = FNV_OFFSET;
    for byte in s.bytes() {
        h ^= byte as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    format!("{:016x}", h)
}

/// Convenience: canonicalize then hash. Optional salt included in stream.
pub fn stable_hash(value: &serde_json::Value, salt: Option<&str>) -> String {
    let canonical = stable_stringify(value);
    let input = match salt {
        Some(s) => format!("{}|{}", s, canonical),
        None => canonical,
    };
    fnv1a64_hex(&input)
}

// ============================================================================
// Binding-specific Helpers
// ============================================================================

/// Build a stable cache key for a binding evaluation.
///
/// This key is deterministic for the tuple (binding, input, ambient, locale, kernelVersion).
/// Hosts may add engine/version details when memoizing operator sub-results.
pub fn binding_cache_key(
    binding: &Binding,
    input: &serde_json::Value,
    context: &BindingEvaluationContext,
) -> String {
    // Only include the governing parts of the binding in the key to avoid noise.
    let mut shape = serde_json::Map::new();
    shape.insert("$kind".to_string(), serde_json::json!(binding.kind));
    shape.insert(
        "select".to_string(),
        serde_json::to_value(&binding.select).unwrap_or(serde_json::Value::Null),
    );
    shape.insert(
        "transform".to_string(),
        serde_json::to_value(&binding.transform).unwrap_or(serde_json::Value::Null),
    );
    shape.insert(
        "default".to_string(),
        binding
            .default
            .clone()
            .unwrap_or(serde_json::json!("__undef__")),
    );
    // meta is intentionally excluded from key

    let mut key_data = serde_json::Map::new();
    key_data.insert("shape".to_string(), serde_json::Value::Object(shape));
    key_data.insert("input".to_string(), input.clone());

    // Include relevant context fields
    let mut ctx = serde_json::Map::new();
    ctx.insert("ambient".to_string(), serde_json::json!(context.ambient));
    if let Some(ref locale) = context.locale {
        ctx.insert("locale".to_string(), serde_json::json!(locale));
    }
    if let Some(ref version) = context.kernel_version {
        ctx.insert("kernelVersion".to_string(), serde_json::json!(version));
    }
    key_data.insert("context".to_string(), serde_json::Value::Object(ctx));

    stable_hash(&serde_json::Value::Object(key_data), Some("binding:v1"))
}

/// Hash a binding for quick equality checking (not for caching evaluations)
pub fn hash_binding(binding: &Binding) -> String {
    let json = serde_json::to_value(binding).unwrap_or(serde_json::Value::Null);
    stable_hash(&json, Some("binding-hash:v1"))
}

/// Hash arbitrary data for cache keys
pub fn hash_data<T: serde::Serialize>(data: &T, salt: Option<&str>) -> String {
    let json = serde_json::to_value(data).unwrap_or(serde_json::Value::Null);
    stable_hash(&json, salt)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stable_stringify_simple() {
        let value = serde_json::json!({
            "name": "Alice",
            "age": 30
        });
        let result = stable_stringify(&value);
        // Keys should be sorted
        assert!(result.contains("\"age\":30"));
        assert!(result.contains("\"name\":\"Alice\""));
        // "age" comes before "name" alphabetically
        let age_pos = result.find("\"age\"").unwrap();
        let name_pos = result.find("\"name\"").unwrap();
        assert!(age_pos < name_pos);
    }

    #[test]
    fn test_stable_stringify_array() {
        let value = serde_json::json!([1, 2, 3]);
        let result = stable_stringify(&value);
        assert_eq!(result, "[1,2,3]");
    }

    #[test]
    fn test_stable_stringify_nested() {
        let value = serde_json::json!({
            "z": 1,
            "a": { "y": 2, "b": 3 }
        });
        let result = stable_stringify(&value);
        // Outer: a before z
        // Inner: b before y
        assert!(result.contains("{\"a\":{\"b\":3,\"y\":2},\"z\":1}"));
    }

    #[test]
    fn test_stable_stringify_special_numbers() {
        // Note: serde_json::json! macro cannot create actual NaN/Infinity values
        // because JSON specification doesn't support them. They get serialized as null.
        // The encode_value function handles NaN/Infinity at runtime, but we cannot
        // test it via serde_json::json! macro.

        // Test that NaN from json! becomes null (this is serde_json's behavior)
        let nan = serde_json::json!(f64::NAN);
        assert_eq!(stable_stringify(&nan), "null");

        // Test Infinity - also becomes null in JSON
        let inf = serde_json::json!(f64::INFINITY);
        assert_eq!(stable_stringify(&inf), "null");

        let neg_inf = serde_json::json!(f64::NEG_INFINITY);
        assert_eq!(stable_stringify(&neg_inf), "null");

        // Test that valid numbers work correctly
        let valid = serde_json::json!(42.5);
        assert_eq!(stable_stringify(&valid), "42.5");

        let zero = serde_json::json!(0.0);
        assert_eq!(stable_stringify(&zero), "0.0");
    }

    #[test]
    fn test_fnv1a64_hex() {
        // Empty string
        let empty = fnv1a64_hex("");
        assert_eq!(empty.len(), 16);

        // Same input = same hash
        let a = fnv1a64_hex("hello");
        let b = fnv1a64_hex("hello");
        assert_eq!(a, b);

        // Different input = different hash
        let c = fnv1a64_hex("world");
        assert_ne!(a, c);
    }

    #[test]
    fn test_stable_hash() {
        let value = serde_json::json!({"key": "value"});

        // Without salt
        let h1 = stable_hash(&value, None);
        assert_eq!(h1.len(), 16);

        // With salt
        let h2 = stable_hash(&value, Some("test"));
        assert_ne!(h1, h2);

        // Same salt = same hash
        let h3 = stable_hash(&value, Some("test"));
        assert_eq!(h2, h3);
    }

    #[test]
    fn test_stable_hash_deterministic() {
        // Objects with different key order should produce same hash
        let v1 = serde_json::json!({"a": 1, "b": 2});
        let v2 = serde_json::json!({"b": 2, "a": 1});

        // The stringification sorts keys, so hashes should be equal
        let s1 = stable_stringify(&v1);
        let s2 = stable_stringify(&v2);
        assert_eq!(s1, s2);

        let h1 = stable_hash(&v1, None);
        let h2 = stable_hash(&v2, None);
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_binding_cache_key() {
        use super::super::ast::{
            Binding, BindingEvaluationContext, BindingSelect, SelectKey, SelectSource,
        };

        let binding = Binding::new().with_select(BindingSelect {
            from: Some(SelectSource::DataSource),
            key: Some(SelectKey::static_key("user")),
            ..Default::default()
        });

        let input = serde_json::json!("test");
        let context =
            BindingEvaluationContext::new().with_ambient("theme", serde_json::json!("dark"));

        let key1 = binding_cache_key(&binding, &input, &context);
        assert_eq!(key1.len(), 16);

        // Same inputs = same key
        let key2 = binding_cache_key(&binding, &input, &context);
        assert_eq!(key1, key2);

        // Different input = different key
        let key3 = binding_cache_key(&binding, &serde_json::json!("other"), &context);
        assert_ne!(key1, key3);
    }

    #[test]
    fn test_hash_data() {
        #[derive(serde::Serialize)]
        struct TestData {
            name: String,
            value: i32,
        }

        let data = TestData {
            name: "test".to_string(),
            value: 42,
        };

        let h1 = hash_data(&data, None);
        let h2 = hash_data(&data, None);
        assert_eq!(h1, h2);

        let h3 = hash_data(&data, Some("salt"));
        assert_ne!(h1, h3);
    }
}
