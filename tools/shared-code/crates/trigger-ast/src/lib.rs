//! crates/trigger-ast/src/lib.rs
//!
//! Pre-compiled trigger types, evaluator, and dependency analysis.
//!
//! This is a leaf crate shared between interaction-engine (producer) and
//! composition-engine (consumer). It contains the types and evaluation
//! logic that both crates need WITHOUT creating a compile-time dependency
//! between them.
//!
//! # Architecture (L088 leaf extraction)
//!
//! ```text
//! interaction-engine ──→ trigger-ast (leaf)
//!                          ↑
//! composition-engine ──────┘
//! ```
//!
//! interaction-engine produces PreCompiledTriggers via compile_triggers().
//! composition-engine stores and evaluates them via evaluate_compiled().
//! Both import types from this leaf crate.
//!
//! # Modules
//!
//! - `precompiled` — PreCompiledTrigger struct + evaluate_compiled() + AST helpers
//! - `trigger_deps` — TriggerDeps struct + analyze_trigger_deps() for selective dispatch

pub mod action;
pub mod precompiled;
pub mod trigger_deps;

pub use action::DefinitionDispatch;
pub use precompiled::{
    analyze_event_type_deps, evaluate_compiled, PreCompiledTrigger, PreCompiledTriggerInput,
};
pub use trigger_deps::{analyze_trigger_deps, TriggerDeps};
