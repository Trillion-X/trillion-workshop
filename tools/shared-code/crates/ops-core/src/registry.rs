//! Type-erased capability registry for extensible operator dispatch.
//!
//! This module implements Pattern 73: a generic capability store using `HashMap<TypeId, Arc<dyn Any>>`.
//! Capabilities (FormatCapability, HashCapability, EncodingCapability, etc.) are registered once
//! at context creation and retrieved by type. This architecture allows operators to dispatch to
//! registered handlers generically, without hardcoding per-variant function names.
//!
//! # Design
//!
//! The registry is stored in `EvalContext` so different contexts can have different registered
//! capabilities. Default construction registers all built-in capabilities (JSON, YAML, TOML, CBOR
//! for formats; SHA256, MD5, etc. for hashing; base64, hex for encoding).
//!
//! Adding a future capability (e.g., CompressionCapability) requires:
//! 1. Define the capability struct with parse/stringify methods
//! 2. Register in EvalContext::default() or context construction
//! 3. Dispatch via `ctx.capabilities.get::<CapabilityType>()`
//!
//! No changes needed to the registry itself — it's completely generic.

use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::sync::Arc;

/// Type-erased capability store using `HashMap<TypeId, Arc<dyn Any + Send + Sync>>`.
///
/// The registry allows multiple capabilities (Format, Hash, Encoding, etc.) to coexist
/// without name collisions or type interference. Each capability is stored under its type,
/// and retrieved by requesting the same type.
///
/// # Example
///
/// ```ignore
/// let mut registry = CapabilityRegistry::new();
/// registry.register(FormatCapability::default());
/// registry.register(HashCapability::default());
///
/// let fmt_cap = registry.get::<FormatCapability>();
/// let hash_cap = registry.get::<HashCapability>();
/// ```
#[derive(Debug, Clone)]
pub struct CapabilityRegistry {
    capabilities: HashMap<TypeId, Arc<dyn Any + Send + Sync>>,
}

impl CapabilityRegistry {
    /// Create a new empty capability registry.
    pub fn new() -> Self {
        Self {
            capabilities: HashMap::new(),
        }
    }

    /// Register a capability of type T in the registry.
    ///
    /// If a capability of the same type already exists, it is replaced.
    pub fn register<T: Any + Send + Sync + 'static>(&mut self, capability: T) {
        self.capabilities
            .insert(TypeId::of::<T>(), Arc::new(capability));
    }

    /// Retrieve a capability of type T from the registry.
    ///
    /// Returns `Some(Arc<T>)` if the capability is registered, `None` otherwise.
    pub fn get<T: Any + Send + Sync + 'static>(&self) -> Option<Arc<T>> {
        self.capabilities
            .get(&TypeId::of::<T>())
            .and_then(|arc| arc.clone().downcast::<T>().ok())
    }
}

impl Default for CapabilityRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone)]
    struct MockCapability {
        name: String,
    }

    #[test]
    fn test_registry_register_and_get() {
        let mut registry = CapabilityRegistry::new();
        let cap = MockCapability {
            name: "test".to_string(),
        };
        registry.register(cap);

        let retrieved = registry.get::<MockCapability>();
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().name, "test");
    }

    #[test]
    fn test_registry_get_missing() {
        let registry = CapabilityRegistry::new();
        let retrieved = registry.get::<MockCapability>();
        assert!(retrieved.is_none());
    }

    #[test]
    fn test_registry_multiple_capabilities() {
        #[derive(Debug, Clone)]
        struct CapA {
            value: i32,
        }

        #[derive(Debug, Clone)]
        struct CapB {
            value: String,
        }

        let mut registry = CapabilityRegistry::new();
        registry.register(CapA { value: 42 });
        registry.register(CapB {
            value: "hello".to_string(),
        });

        let a = registry.get::<CapA>();
        let b = registry.get::<CapB>();

        assert!(a.is_some());
        assert!(b.is_some());
        assert_eq!(a.unwrap().value, 42);
        assert_eq!(b.unwrap().value, "hello");
    }

    #[test]
    fn test_registry_replace() {
        let mut registry = CapabilityRegistry::new();
        registry.register(MockCapability {
            name: "first".to_string(),
        });
        registry.register(MockCapability {
            name: "second".to_string(),
        });

        let retrieved = registry.get::<MockCapability>();
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().name, "second");
    }

    #[test]
    fn test_registry_clone() {
        let mut registry = CapabilityRegistry::new();
        registry.register(MockCapability {
            name: "original".to_string(),
        });

        let cloned = registry.clone();
        let retrieved = cloned.get::<MockCapability>();
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().name, "original");
    }
}
