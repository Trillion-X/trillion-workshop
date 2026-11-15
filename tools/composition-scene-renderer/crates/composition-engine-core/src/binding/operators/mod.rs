//! crates/composition-engine-core/src/binding/operators/mod.rs
//!
//! Operator system for the Universal Binding Engine.
//!
//! D.4.6: Pure operator types, registry, and core registration have been
//! extracted to composition-ast (L088 leaf extraction — zero state, zero I/O).
//! This module re-exports from composition-ast and adds the formula adapter
//! used by the reusable composition implementation.

// Re-export everything from composition-ast's operator system
pub use composition_ast::binding::operators::core;
pub use composition_ast::binding::operators::registry;

// Re-export key types (from composition-ast via registry)
pub use registry::{FnOperator, Operator, OperatorContext, OperatorRegistry, RegistryError};

// Re-export core registration (from composition-ast via core)
pub use core::{create_core_registry, register_core_operators, CORE_OPERATORS_VERSION};

// The formula adapter stays with the composition implementation library because
// it adapts the binding operator trait used by this engine.
pub mod formula_adapter;

// Re-export formula adapter types
pub use formula_adapter::{
    create_formula_operator, register_formula_operator, CompiledFormula, FormulaCompileCache,
    FormulaEngine, FormulaEnv, FormulaEvalResult, FormulaOperatorArgs, FORMULA_OP_KEY,
};
