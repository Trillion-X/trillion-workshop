//! crates/composition-engine-core/src/binding/mod.rs
//!
//! Bindings for the Composition Engine. The binding types, the evaluator,
//! the validator and the operators have one home: composition-ast. This module
//! re-exports them and adds only `ast::scene_index_from_typed`, which turns the
//! kernel's typed node index into the scene index a binding reads.
//!
//! Non-Negotiable Invariants:
//! - Pure composition only. No side effects. No I/O. No global mutation.
//! - All operators are versioned for deterministic resolution.
//! - Forbidden keys (__proto__, prototype, constructor) are blocked.

pub mod ast;
pub mod operators;

pub use composition_ast::binding::path;

pub use ast::{
    Binding, BindingEvaluationContext, BindingSelect, Diagnostic, DiagnosticCode, DiagnosticLevel,
    Path, PathSegment, SelectSource, TransformStep,
};

pub use composition_ast::binding::evaluator::evaluate_binding;
pub use path::{get_at_path, parse_path, stringify_path};

pub use operators::{
    create_core_registry, register_core_operators, FnOperator, Operator, OperatorContext,
    OperatorRegistry, RegistryError, CORE_OPERATORS_VERSION,
};
