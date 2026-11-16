//! Formula Core - universal declarative logic evaluation leaf
//!
//! Pure compute only: parsing, evaluation, dependency analysis, reactive
//! planning, and hypergraph solving. Zero slot entrypoints, zero envelope
//! routing, zero WIT exports.

pub use formula_ast as ast;
pub use formula_ast::lexer;
pub use formula_ast::parser;

pub mod compat;
pub mod compiler;
pub mod context;
pub mod deps;
pub mod evaluator;
pub mod functions;
pub mod hypergraph;
pub mod query;
pub mod reactive;
pub mod registry;
pub mod rules;
pub mod solver;
pub mod types;

pub use ast::*;
pub use compiler::*;
pub use context::*;
pub use deps::{
    collect_dependencies_static, detect_cycles, detect_cycles_with_config, keys_from_readset,
    run_recompute_with_hooks, CycleConfig, DepGraphError, DepGraphErrorKind, DependencyGraph,
    DependencyKey, DependencyProvider, ReactiveHooks,
};
pub use evaluator::*;
pub use functions::*;
pub use hypergraph::*;
pub use lexer::*;
pub use parser::*;
pub use query::{
    analyze_formula_query, collect_bound_formula_reads, evaluate_formula_query,
    evaluate_formula_query_with_readset, formula_capabilities, project_formula_source,
    validate_formula_traversal_depth, FormulaTraversalDepthError,
};
pub use reactive::{
    changeset_to_dependency_keys, react_to_changes, react_to_keys, ChangeOperation, ChangeSet,
    DependencyChange, ReactError, ReactResult,
};
pub use registry::FormulaRegistry;
pub use rules::*;
pub use solver::*;
pub use types::*;
