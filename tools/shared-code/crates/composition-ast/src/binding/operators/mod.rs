//! crates/composition-ast/src/binding/operators/mod.rs
//!
//! Operator trait, registry, and core operator registration.
//!
//! D.4.6 (L088 leaf extraction): Extracted from composition-engine because
//! the operator system is PURE COMPUTATION wrapping ops-core functions.
//! Zero state, zero I/O. Leaf extraction is the correct decoupling pattern.

pub mod core;
pub mod formula_adapter;
pub mod registry;

// Re-export commonly used types
pub use registry::{FnOperator, Operator, OperatorContext, OperatorRegistry, RegistryError};

// Re-export core operator factory
pub use core::{create_core_registry, register_core_operators, CORE_OPERATORS_VERSION};
