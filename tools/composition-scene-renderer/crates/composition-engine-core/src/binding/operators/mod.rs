//! crates/composition-engine-core/src/binding/operators/mod.rs
//!
//! The binding operators live in composition-ast (L088). This module
//! re-exports them under the kernel's binding path.

pub use composition_ast::binding::operators::core;
pub use composition_ast::binding::operators::registry;

pub use registry::{FnOperator, Operator, OperatorContext, OperatorRegistry, RegistryError};

pub use core::{create_core_registry, register_core_operators, CORE_OPERATORS_VERSION};
