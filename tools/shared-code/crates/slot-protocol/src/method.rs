//! Method descriptor for slot capabilities.
//!
//! MethodDescriptor advertises the methods a slot exposes.
//! NO input_schema or output_schema fields — schema validation
//! belongs in the WASM Rewrite layer (Society), not in Physics.
//!
//! If a slot wants to advertise I/O schema compatibility,
//! it exposes this as metadata in its own Envelope data (self-describing, L090).

use serde::{Deserialize, Serialize};

/// Describes a method that a slot exposes.
///
/// # Invariants
///
/// - `name` is a non-empty String
/// - `description` explains the method's purpose
/// - NO input_schema or output_schema — validation is a Rewrite capability
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MethodDescriptor {
    /// The method name (e.g., "get", "put", "query").
    pub name: String,

    /// Human-readable description of what the method does.
    pub description: String,
}

impl MethodDescriptor {
    /// Create a new MethodDescriptor.
    pub fn new(name: impl Into<String>, description: impl Into<String>) -> Self {
        MethodDescriptor {
            name: name.into(),
            description: description.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_method_descriptor_creation() {
        let method = MethodDescriptor::new("get", "Retrieve data");
        assert_eq!(method.name, "get");
        assert_eq!(method.description, "Retrieve data");
    }

    #[test]
    fn test_method_descriptor_serde() {
        let method = MethodDescriptor::new("put", "Store data");
        let json = serde_json::to_string(&method).expect("serialize");
        let deserialized: MethodDescriptor = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(method, deserialized);
    }

    #[test]
    fn test_method_descriptor_no_schema_fields() {
        // Verify that MethodDescriptor only has name and description
        let method = MethodDescriptor::new("query", "Execute query");
        let serialized = serde_json::to_value(&method).expect("to_value");
        let obj = serialized.as_object().expect("is object");

        assert!(obj.contains_key("name"));
        assert!(obj.contains_key("description"));
        assert!(
            !obj.contains_key("input_schema"),
            "input_schema should NOT exist"
        );
        assert!(
            !obj.contains_key("output_schema"),
            "output_schema should NOT exist"
        );
    }
}
