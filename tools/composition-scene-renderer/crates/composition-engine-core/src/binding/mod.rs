//! crates/composition-engine-core/src/binding/mod.rs
//!
//! Universal Binding Engine - Expression evaluation system for the Composition Engine.
//!
//! This module provides the complete expression binding system:
//! - `ast`: Core AST types for bindings, selections, and transforms
//! - `path`: Data path resolution with prototype pollution protection
//! - `hash`: Stable hashing for cache keys using FNV-1a
//! - `cache`: LRU cache for memoization of expensive evaluations
//! - `operators`: Operator registry and core standard library
//! - `evaluator`: Main evaluation engine for binding expressions
//! - `validator`: Structural and semantic validation for bindings
//!
//! Non-Negotiable Invariants:
//! - Pure composition only. No side effects. No I/O. No global mutation.
//! - tick(state, input) → nextState functional model.
//! - All operators are versioned for deterministic resolution.
//! - Forbidden keys (__proto__, prototype, constructor) are blocked.
//!
//! Key Concepts:
//! - Binding: A declarative data transformation pipeline
//! - Select: Data source selection (self, ambient, vars, dataSource, literal)
//! - Transform: Pipeline of operator applications with arguments
//! - Operator: Pure function (Input, Args?) → Output with validation
//!
//! Ported from: frontends/web/composition-engine/binding/

pub mod ast;
pub mod cache;
pub mod evaluator;
pub mod hash;
pub mod operators;
pub mod validator;

// L088: path utilities re-exported from composition-ast (SSOT)
pub use composition_ast::binding::path;

// Re-export key types from ast (includes composition-ast re-exports + local BindingEvaluationContext)
pub use ast::{
    Binding, BindingEvaluationContext, BindingSelect, Diagnostic, DiagnosticCode, DiagnosticLevel,
    Path, PathSegment, SelectSource, TransformStep,
};

// Re-export key functions
pub use cache::{LRUCache, Memoized};
pub use evaluator::evaluate_binding;
pub use hash::{binding_cache_key, fnv1a64_hex, stable_stringify};
pub use path::{get_at_path, parse_path, stringify_path};
pub use validator::{validate_binding_deep, validate_binding_operators, validate_binding_shape};

// Re-export operator types
pub use operators::{
    create_core_registry, register_core_operators, FnOperator, Operator, OperatorContext,
    OperatorRegistry, RegistryError, CORE_OPERATORS_VERSION,
};
