//! crates/composition-ast/src/binding/mod.rs
//!
//! Binding AST types, path utilities, operator system, and pure evaluator.
//!
//! D.4.6 (L088 leaf extraction): The operator trait, registry, core operator
//! registration, validator, and evaluator were extracted here from composition-engine
//! because they are PURE COMPUTATION (zero state, zero I/O). Both projector and
//! composition-engine import from here. No inter-slot dependency.

pub mod ast;
pub mod cache;
pub mod evaluator;
pub mod hash;
pub mod operators;
pub mod path;
pub mod prepared;
pub mod validator;
