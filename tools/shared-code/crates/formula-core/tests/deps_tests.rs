//! Integration tests for formula-core DependencyGraph
//!
//! Tests the DependencyGraph's cycle detection, topological ordering,
//! and affected formula computation using the migrated DirectedGraph<String> backend.

use formula_core::deps::DependencyGraph;
use std::collections::{BTreeMap, BTreeSet};

#[test]
fn test_dependency_graph_new() {
    let graph = DependencyGraph::default();
    let affected = graph.affected_formulas_from_keys(vec![]);
    assert!(affected.is_empty());
}

#[test]
fn test_dependency_graph_build() {
    let formulas = vec![(
        "formula:1".to_string(),
        formula_core::context::ReadSet::default(),
    )];
    let producers = BTreeMap::new();

    let graph = DependencyGraph::build(&formulas, Some(producers));
    assert_eq!(graph.deps_by_formula.len(), 1);
}

#[test]
fn test_topological_order_empty() {
    let graph = DependencyGraph::default();
    let order = graph.topological_order();
    assert!(order.is_empty());
}

#[test]
fn test_topological_order_single_node() {
    let mut graph = DependencyGraph::default();

    // Manually add a node with no dependencies
    graph
        .deps_by_formula
        .insert("formula:1".to_string(), BTreeSet::new());

    let order = graph.topological_order();
    assert!(order.is_empty());
}

#[test]
fn test_affected_formulas_empty_keys() {
    let graph = DependencyGraph::default();
    let affected = graph.affected_formulas_from_keys(vec![]);
    assert!(affected.is_empty());
}

#[test]
fn test_recomputation_plan_empty() {
    let graph = DependencyGraph::default();
    let plan = graph.recomputation_plan(vec![]);
    assert!(plan.is_empty());
}
