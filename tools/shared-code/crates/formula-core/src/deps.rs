// src/deps.rs
//! Dependency Analysis and Graph Management for Formula Engine
//!
//! This module implements Tasks 3.6.9-3.6.15 from the implementation plan:
//! - 3.6.9: Automatic dependency detection beyond simple identifiers
//! - 3.6.10: Dependency graph building with formula-to-formula relationships
//! - 3.6.11: Cycle detection using strongly connected components (existing)
//! - 3.6.12: Dependency invalidation tracking and closure computation
//! - 3.6.13: Graph visualization in DOT and Mermaid formats
//! - 3.6.14: Reactive hooks interface for V2.0 features
//! - 3.6.15: Dependency optimization with topological ordering

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::fmt::{self, Display};

use crate::ast::{AstNode, Expression, Literal, ValidationError, ValidationErrorKind};
use crate::context::ReadSet;
use graph::DirectedGraph;

/// Default expansion cap to protect against adversarial graphs.
/// Tune as needed; it's just a guardrail.
pub const DEFAULT_CYCLE_TRAVERSAL_LIMIT: usize = 100_000;

/// Your app implements this: for each identifier, return its direct deps.
/// e.g., deps_of("A") -> ["B", "C"] means A references B and C.
pub trait DependencyProvider {
    fn deps_of(&self, name: &str) -> Vec<String>;
}

/// Config for cycle detection to guard against adversarial graphs.
#[derive(Debug, Clone, Copy)]
pub struct CycleConfig {
    /// Hard cap on number of edge expansions during traversal.
    pub max_visits: usize,
}

impl Default for CycleConfig {
    fn default() -> Self {
        Self { max_visits: 10_000 }
    }
}

/// Errors local to the dependency graph (kept separate from AST errors).
#[derive(Debug, Clone, PartialEq)]
pub enum DepGraphErrorKind {
    /// Found a back-edge to a node currently on the stack.
    Cycle { identifier: String },
    /// Gave up because traversal exceeded guardrail.
    TraversalLimit { limit: usize },
}

#[derive(Debug, Clone, PartialEq)]
pub struct DepGraphError {
    pub kind: DepGraphErrorKind,
    /// Free-form path/context if you want to enrich later.
    pub path: Vec<String>,
}

impl DepGraphError {
    fn cycle(id: String) -> Self {
        Self {
            kind: DepGraphErrorKind::Cycle { identifier: id },
            path: vec!["Deps".into()],
        }
    }
    fn limit(limit: usize) -> Self {
        Self {
            kind: DepGraphErrorKind::TraversalLimit { limit },
            path: vec!["Deps".into()],
        }
    }
}

/// Public API (configurable): returns dep-graph errors (decoupled from AST).
pub fn detect_cycles_with_config(
    expr: &Expression,
    provider: &dyn DependencyProvider,
    cfg: CycleConfig,
) -> Result<(), Vec<DepGraphError>> {
    // Get base identifiers from the expression.
    let (bases, _dotted) = expr.dependencies();

    // 0 = unvisited, 1 = visiting (on stack), 2 = visited
    let mut state: HashMap<String, u8> = HashMap::new();
    let mut errors: Vec<DepGraphError> = Vec::new();
    let mut visits: usize = 0;

    // To keep traversal iterative, we use our own stack.
    // Each stack item holds (node, next_child_index, children_vec).
    for base in bases {
        if state.get(&base).copied().unwrap_or(0) != 0 {
            continue;
        }
        state.insert(base.clone(), 1);
        let mut stack: Vec<(String, usize, Vec<String>)> =
            vec![(base.clone(), 0, provider.deps_of(&base))];

        while let Some((node, mut idx, children)) = stack.pop() {
            // Guardrail
            if visits >= cfg.max_visits {
                errors.push(DepGraphError::limit(cfg.max_visits));
                // Stop entirely; we've already exceeded our global budget.
                return Err(errors);
            }

            if idx < children.len() {
                // Process the next child
                let next = children[idx].clone();
                // Resume this node later at the next index
                idx += 1;
                stack.push((node.clone(), idx, children));
                // Expand the child
                let st = state.get(&next).copied().unwrap_or(0);
                match st {
                    0 => {
                        state.insert(next.clone(), 1);
                        let deps = provider.deps_of(&next);
                        visits += 1;
                        stack.push((next, 0, deps));
                    }
                    1 => {
                        // Back-edge: cycle
                        errors.push(DepGraphError::cycle(next.clone()));
                        // Keep exploring other branches, but do not recurse here.
                        visits += 1;
                    }
                    2 => {
                        // Already done; skip
                        visits += 1;
                    }
                    _ => {}
                }
            } else {
                // Finished this node
                state.insert(node, 2);
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// Public: detect cycles with a caller-provided traversal cap.
/// Returns `Ok(())` if no cycles; otherwise a Vec of `ValidationError`.
pub fn detect_cycles_with_limit(
    expr: &Expression,
    provider: &dyn DependencyProvider,
    max_expansions: usize,
) -> Result<(), Vec<ValidationError>> {
    let config = CycleConfig {
        max_visits: max_expansions,
    };
    match detect_cycles_with_config(expr, provider, config) {
        Ok(()) => Ok(()),
        Err(dep_errs) => {
            let mapped = dep_errs
                .into_iter()
                .map(|e| match e.kind {
                    DepGraphErrorKind::Cycle { identifier } => ValidationError {
                        kind: ValidationErrorKind::CyclicReference { identifier },
                        path: e.path,
                    },
                    DepGraphErrorKind::TraversalLimit { limit } => ValidationError {
                        kind: ValidationErrorKind::Other(format!(
                            "cycle traversal aborted after {limit} expansions"
                        )),
                        path: e.path,
                    },
                })
                .collect();
            Err(mapped)
        }
    }
}

/// Public: detect cycles using a sensible default traversal cap.
pub fn detect_cycles(
    expr: &Expression,
    provider: &dyn DependencyProvider,
) -> Result<(), Vec<ValidationError>> {
    detect_cycles_with_limit(expr, provider, DEFAULT_CYCLE_TRAVERSAL_LIMIT)
}

// ================================================================================
// NEW DEPENDENCY SYSTEM - Keys and ReadSet conversion
// ================================================================================

/// Keys that formulas can depend on - normalized for stable ordering and comparison
#[derive(Debug, Clone, Ord, PartialOrd, Eq, PartialEq)]
pub enum DependencyKey {
    /// Plain variable identifier like `user_name`
    Var(String),
    /// Entity reference discovered at runtime (from {"$ent_ref": "..."})
    Entity(String),
    /// Special context references like "@", "@@", "$scope"
    Special(String),
    /// Function name dependency (for function implementation changes)
    Func(String),
}

impl Display for DependencyKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DependencyKey::Var(s) => write!(f, "var:{}", s),
            DependencyKey::Entity(s) => write!(f, "ent:{}", s),
            DependencyKey::Special(s) => write!(f, "spec:{}", s),
            DependencyKey::Func(s) => write!(f, "fn:{}", s),
        }
    }
}

/// Convert runtime ReadSet to normalized dependency keys with stable ordering
pub fn keys_from_readset(rs: &ReadSet) -> BTreeSet<DependencyKey> {
    let mut out = BTreeSet::new();

    for v in rs.get_variables() {
        out.insert(DependencyKey::Var(v.clone()));
    }
    for e in rs.get_entity_references() {
        out.insert(DependencyKey::Entity(e.clone()));
    }
    for s in rs.get_special_references() {
        out.insert(DependencyKey::Special(s.clone()));
    }
    for f in rs.get_function_calls() {
        out.insert(DependencyKey::Func(f.clone()));
    }

    out
}

// ================================================================================
// STATIC DEPENDENCY COLLECTOR (Task 3.6.9)
// ================================================================================

/// 3.6.9: Static dependency collector that analyzes AST structure
///
/// This goes beyond the simple identifier tracking and handles:
/// - Member access chains like `user.profile.name`
/// - Special reference chains like `@.owner.name` or `$scope.settings.theme`
/// - Function call dependencies
/// - Lambda parameter scoping
/// - Index access patterns
pub fn collect_dependencies_static(ast: &AstNode) -> BTreeSet<DependencyKey> {
    let mut out = BTreeSet::new();
    let mut locals: Vec<BTreeSet<String>> = vec![BTreeSet::new()]; // Lambda parameter scopes

    match ast {
        AstNode::Expression(expr) => {
            collect_expr_dependencies(expr, &mut out, &mut locals);
        }
    }

    out
}

/// Recursively collect dependencies from an Expression with lexical scoping
fn collect_expr_dependencies(
    expr: &Expression,
    out: &mut BTreeSet<DependencyKey>,
    locals: &mut Vec<BTreeSet<String>>,
) {
    // Check if identifier is locally bound (lambda parameter)
    let is_local = |name: &str| locals.iter().rev().any(|scope| scope.contains(name));

    // Try to detect and flatten special reference chains first
    if let Some(chain) = try_flatten_special_chain(expr) {
        out.insert(DependencyKey::Special(chain));
        return;
    }

    match expr {
        Expression::Literal(lit) => {
            collect_literal_dependencies(lit, out, locals);
        }

        Expression::Identifier(name) => {
            if name == "@" || name == "@@" || name == "$scope" {
                out.insert(DependencyKey::Special(name.clone()));
            } else if !is_local(name) {
                out.insert(DependencyKey::Var(name.clone()));
            }
        }

        Expression::VersionedIdentifier { name, .. } => {
            // Versioned identifiers are treated as regular variables for dependency purposes
            if !is_local(name) {
                out.insert(DependencyKey::Var(name.clone()));
            }
        }

        Expression::Binary(binary) => {
            collect_expr_dependencies(&binary.left, out, locals);
            collect_expr_dependencies(&binary.right, out, locals);
        }

        Expression::Unary(unary) => {
            collect_expr_dependencies(&unary.expr, out, locals);
        }

        Expression::FunctionCall(func_call) => {
            // Track function name as dependency
            if !func_call.function_name.is_empty() {
                out.insert(DependencyKey::Func(func_call.function_name.clone()));
            }

            // Collect dependencies from arguments
            for arg in &func_call.args {
                collect_expr_dependencies(arg, out, locals);
            }
        }

        Expression::MemberAccess(member) => {
            // If not a special chain (handled above), recurse into object
            collect_expr_dependencies(&member.object, out, locals);
        }

        Expression::IndexAccess(index) => {
            collect_expr_dependencies(&index.array, out, locals);
            collect_expr_dependencies(&index.index, out, locals);
        }

        Expression::Lambda(lambda) => {
            // Create new lexical scope for lambda parameters
            let param_scope: BTreeSet<String> = lambda.parameters.iter().cloned().collect();
            locals.push(param_scope);

            // Collect dependencies from lambda body
            collect_expr_dependencies(&lambda.body, out, locals);

            // Remove lambda parameter scope
            locals.pop();
        }
    }
}

/// Collect dependencies from literal expressions (arrays and objects)
fn collect_literal_dependencies(
    lit: &Literal,
    out: &mut BTreeSet<DependencyKey>,
    locals: &mut Vec<BTreeSet<String>>,
) {
    match lit {
        Literal::Array(elements) => {
            for elem in elements {
                collect_expr_dependencies(elem, out, locals);
            }
        }

        Literal::Object(properties) => {
            for (_key, value) in properties {
                collect_expr_dependencies(value, out, locals);
            }
        }

        // Primitive literals have no dependencies
        Literal::Null | Literal::Boolean(_) | Literal::Number(_) | Literal::String(_) => {}
    }
}

/// Detect and flatten special reference chains like `@.owner.name` or `$scope.settings.theme`
/// Returns the flattened chain string if the base is a special reference
fn try_flatten_special_chain(expr: &Expression) -> Option<String> {
    let mut chain_parts = Vec::new();

    // Walk the chain from leaf to root, collecting property/index accesses
    fn walk_chain(expr: &Expression, parts: &mut Vec<String>) -> Option<String> {
        match expr {
            Expression::MemberAccess(member) => {
                parts.push(format!(".{}", member.property));
                walk_chain(&member.object, parts)
            }

            Expression::IndexAccess(index) => {
                // For string literal indices, treat as property access
                let index_part = if let Expression::Literal(Literal::String(s)) = &index.index {
                    format!(".{}", s)
                } else {
                    // Dynamic index access
                    ".<dynamic>".to_string()
                };
                parts.push(index_part);
                walk_chain(&index.array, parts)
            }

            Expression::Identifier(name) if name == "@" || name == "@@" || name == "$scope" => {
                Some(name.clone())
            }

            // Not a special reference chain
            _ => None,
        }
    }

    let base = walk_chain(expr, &mut chain_parts)?;

    // Reverse parts since we collected from leaf to root
    chain_parts.reverse();

    // Build flattened chain string
    let mut result = base;
    for part in chain_parts {
        result.push_str(&part);
    }

    Some(result)
}

// ================================================================================
// DEPENDENCY GRAPH (Tasks 3.6.10, 3.6.12, 3.6.15)
// ================================================================================

/// 3.6.10+: Dependency graph with formula-to-formula relationships and analysis capabilities
///
/// Uses DirectedGraph<String> internally to track formula producer→consumer edges.
/// Additional metadata (dependency keys, reverse edges, etc.) are maintained for
/// efficient querying during invalidation and recomputation.
///
/// Note: DependencyGraph does not implement Clone or Debug because DirectedGraph<String>
/// is not easily cloneable. Users should construct new instances as needed.
pub struct DependencyGraph {
    /// Producer -> consumers (formula -> formulas that depend on it)
    /// Stored in DirectedGraph<String> for O(1) edge lookups and cycle detection
    pub formula_edges: DirectedGraph<String>,

    /// Maps formula ID to the set of dependency keys it reads
    pub deps_by_formula: BTreeMap<String, BTreeSet<DependencyKey>>,

    /// Key -> formulas that read from it (for invalidation)
    pub dependents_by_key: BTreeMap<DependencyKey, BTreeSet<String>>,

    /// Key -> formula that produces/writes to it (optional mapping)
    pub producers_by_key: BTreeMap<DependencyKey, String>,
}

impl Default for DependencyGraph {
    fn default() -> Self {
        Self {
            formula_edges: DirectedGraph::new(),
            deps_by_formula: BTreeMap::new(),
            dependents_by_key: BTreeMap::new(),
            producers_by_key: BTreeMap::new(),
        }
    }
}

impl DependencyGraph {
    /// Build dependency graph from runtime ReadSets and optional producer mappings
    pub fn build(
        per_formula_readsets: &[(String, ReadSet)],
        producers_by_key: Option<BTreeMap<DependencyKey, String>>,
    ) -> Self {
        let mut graph = DependencyGraph::default();

        if let Some(producers) = producers_by_key {
            graph.producers_by_key = producers;
        }

        for (formula_id, readset) in per_formula_readsets {
            graph.formula_edges.add_node(formula_id.clone());

            let keys = keys_from_readset(readset);
            graph
                .deps_by_formula
                .insert(formula_id.clone(), keys.clone());

            for key in keys {
                graph
                    .dependents_by_key
                    .entry(key)
                    .or_default()
                    .insert(formula_id.clone());
            }
        }

        for (consumer_id, dependencies) in &graph.deps_by_formula {
            for dependency_key in dependencies {
                if let Some(producer_id) = graph.producers_by_key.get(dependency_key) {
                    if producer_id != consumer_id {
                        // Add nodes to the graph if not already present
                        graph.formula_edges.add_node(producer_id.clone());
                        graph.formula_edges.add_node(consumer_id.clone());

                        // Add edge: producer -> consumer
                        // Ignore cycle errors during build — formula graphs are expected to be acyclic
                        // but we're building from existing data, not validating user input
                        let _ = graph.formula_edges.add_edge(producer_id, consumer_id);
                    }
                }
            }
        }

        graph
    }

    /// 3.6.12: Compute transitive closure of affected formulas when given keys change
    pub fn affected_formulas_from_keys(
        &self,
        changed_keys: impl IntoIterator<Item = DependencyKey>,
    ) -> BTreeSet<String> {
        let mut queue: VecDeque<String> = VecDeque::new();
        let mut affected: BTreeSet<String> = BTreeSet::new();

        for key in changed_keys {
            if let Some(direct_dependents) = self.dependents_by_key.get(&key) {
                for formula in direct_dependents {
                    if affected.insert(formula.clone()) {
                        queue.push_back(formula.clone());
                    }
                }
            }
        }

        while let Some(current_formula) = queue.pop_front() {
            // Use DirectedGraph's children method to get consumers
            for consumer in self.formula_edges.children(&current_formula) {
                if affected.insert(consumer.clone()) {
                    queue.push_back(consumer.clone());
                }
            }
        }

        affected
    }

    /// 3.6.15: Compute topological ordering of formulas (ignoring cycles)
    pub fn topological_order(&self) -> Vec<String> {
        // Use DirectedGraph's built-in topo_sort algorithm
        graph::algorithms::topo_sort(&self.formula_edges).collect()
    }

    /// 3.6.15: Generate optimal recomputation plan for changed keys
    pub fn recomputation_plan(
        &self,
        changed_keys: impl IntoIterator<Item = DependencyKey>,
    ) -> Vec<String> {
        let affected = self.affected_formulas_from_keys(changed_keys);

        self.topological_order()
            .into_iter()
            .filter(|formula| affected.contains(formula))
            .collect()
    }
}

// ================================================================================
// VISUALIZATION AND REACTIVE HOOKS (Tasks 3.6.13, 3.6.14)
// ================================================================================

impl DependencyGraph {
    /// Return all formula nodes in the graph
    pub fn all_formula_nodes(&self) -> Vec<String> {
        self.formula_edges.all_nodes()
    }

    /// 3.6.13: Generate DOT (Graphviz) representation for visualization
    pub fn to_dot(&self) -> String {
        let mut dot = String::from("digraph FormulaDependencies {\n");
        dot.push_str("  rankdir=LR;\n");
        dot.push_str("  node [shape=box, style=rounded];\n");
        dot.push_str("  edge [color=blue];\n\n");

        for formula in self.all_formula_nodes() {
            dot.push_str(&format!("  \"{}\";\n", formula));
        }

        dot.push('\n');

        for producer in self.all_formula_nodes() {
            for consumer in self.formula_edges.children(&producer) {
                dot.push_str(&format!("  \"{}\" -> \"{}\";\n", producer, consumer));
            }
        }

        dot.push_str("}\n");
        dot
    }

    /// Generate Mermaid flowchart representation for visualization
    pub fn to_mermaid(&self) -> String {
        let mut mermaid = String::from("flowchart LR\n");

        for producer in self.all_formula_nodes() {
            for consumer in self.formula_edges.children(&producer) {
                let safe_producer = sanitize_id(&producer);
                let safe_consumer = sanitize_id(consumer);
                mermaid.push_str(&format!("  {} --> {}\n", safe_producer, safe_consumer));
            }
        }

        mermaid
    }
}

fn sanitize_id(id: &str) -> String {
    id.replace(['-', '.', ' ', ':'], "_")
}

/// 3.6.14: Reactive hooks interface for V2.0 features
pub trait ReactiveHooks {
    fn on_keys_invalidated(&self, _keys: &BTreeSet<DependencyKey>) {}
    fn on_recomputation_scheduled(&self, _plan: &[String]) {}
    fn on_formula_recompute_start(&self, _formula_id: &str) {}
    fn on_formula_recompute_end(&self, _formula_id: &str, _success: bool) {}
}

/// Drives a full invalidation→plan→recompute cycle and calls ReactiveHooks at each stage.
/// This is framework-agnostic: you provide the graph + changed keys + a closure that evaluates a formula.
pub fn run_recompute_with_hooks<H, EvalFn>(
    graph: &DependencyGraph,
    changed: impl IntoIterator<Item = DependencyKey>,
    hooks: &H,
    mut eval: EvalFn,
) where
    H: ReactiveHooks,
    EvalFn: FnMut(&str) -> bool,
{
    // 1) Gather changed keys and notify
    let changed_set: BTreeSet<DependencyKey> = changed.into_iter().collect();
    hooks.on_keys_invalidated(&changed_set);

    // 2) Compute recomputation plan (topologically ordered, affected only)
    let plan: Vec<String> = graph.recomputation_plan(changed_set.iter().cloned());
    hooks.on_recomputation_scheduled(&plan);

    // 3) Execute the plan and notify around each evaluation
    for fid in &plan {
        hooks.on_formula_recompute_start(fid);
        let ok = eval(fid);
        hooks.on_formula_recompute_end(fid, ok);
    }
}

#[cfg(test)]
mod deps_tests {
    use super::*;
    use std::collections::HashMap;

    struct MapProvider {
        map: HashMap<String, Vec<String>>,
    }
    impl MapProvider {
        fn new(pairs: &[(&str, &[&str])]) -> Self {
            let mut map = HashMap::new();
            for (k, v) in pairs {
                map.insert(
                    (*k).to_string(),
                    v.iter().map(|s| (*s).to_string()).collect(),
                );
            }
            Self { map }
        }
    }
    impl DependencyProvider for MapProvider {
        fn deps_of(&self, name: &str) -> Vec<String> {
            self.map.get(name).cloned().unwrap_or_default()
        }
    }

    use crate::ast::{BinaryExpr, BinaryOp, Expression};

    #[test]
    fn self_cycle_detected() {
        // A -> A (self cycle)
        let expr = Expression::Identifier("A".into());
        let provider = MapProvider::new(&[("A", &["A"])]);
        let errs = detect_cycles(&expr, &provider).unwrap_err();
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidationErrorKind::CyclicReference { .. })));
    }

    #[test]
    fn traversal_limit_trips_in_big_acyclic_chain() {
        // A -> B -> C -> ... -> Z (length 50)
        let names: Vec<String> = (0..50).map(|i| format!("N{i}")).collect();
        let mut pairs: Vec<(&str, Vec<String>)> = Vec::new();
        for i in 0..names.len() - 1 {
            pairs.push((&names[i], vec![names[i + 1].clone()]));
        }
        pairs.push((&names[names.len() - 1], vec![]));

        let provider = MapProvider {
            map: pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
        };

        let expr = Expression::Identifier(names[0].clone());

        // Tiny limit to force an abort.
        let cfg = CycleConfig { max_visits: 5 };
        let res = detect_cycles_with_config(&expr, &provider, cfg);
        assert!(res.is_err());
        let errs = res.unwrap_err();
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, DepGraphErrorKind::TraversalLimit { .. })));
    }

    #[test]
    fn duplicate_edges_do_not_false_positive() {
        // A -> [B, B], B -> []
        let expr = Expression::Identifier("A".into());
        let provider = MapProvider::new(&[("A", &["B", "B"]), ("B", &[])]);
        // Should be fine (no cycle)
        assert!(detect_cycles(&expr, &provider).is_ok());
    }

    #[test]
    fn mixed_cycle_and_non_cycle_in_same_expr() {
        // expr: LEFT + RIGHT
        // LEFT chain: L0 -> L1 -> [] (no cycle)
        // RIGHT chain: R0 -> R1 -> R0 (cycle)
        let expr = Expression::Binary(Box::new(BinaryExpr {
            op: crate::ast::BinaryOp::Add,
            left: Expression::Identifier("L0".into()),
            right: Expression::Identifier("R0".into()),
        }));

        let provider = MapProvider::new(&[
            ("L0", &["L1"]),
            ("L1", &[]),
            ("R0", &["R1"]),
            ("R1", &["R0"]),
        ]);

        let errs = detect_cycles(&expr, &provider).unwrap_err();
        // Ensure the cycle is reported on the R chain.
        assert!(errs.iter().any(|e| matches!(e.kind, ValidationErrorKind::CyclicReference { ref identifier } if identifier == "R0" || identifier == "R1")));
    }

    #[test]
    fn with_limit_api_surfaces_limit_error() {
        struct Map;
        impl DependencyProvider for Map {
            fn deps_of(&self, _name: &str) -> Vec<String> {
                vec!["A".into()]
            } // self-loop when starting at "A"
        }
        let expr = Expression::Identifier("A".into());
        // absurdly tiny limit to force the error
        let err = detect_cycles_with_limit(&expr, &Map, 1).unwrap_err();
        assert!(err.iter().any(|e| matches!(e.kind, ValidationErrorKind::Other(ref s) if s.contains("cycle traversal aborted"))));
    }

    // ================================================================================
    // COMPREHENSIVE TESTS FOR 3.6.9-3.6.15
    // ================================================================================

    use crate::context::test_support::readset;

    #[test]
    fn test_3_6_9_static_dependency_collection() {
        use crate::ast::{AstNode, FunctionCallExpr, IndexAccessExpr, Literal, MemberAccessExpr};

        // Test simple identifier
        let ast = AstNode::Expression(Expression::Identifier("user_name".to_string()));
        let deps = collect_dependencies_static(&ast);
        assert!(deps.contains(&DependencyKey::Var("user_name".to_string())));

        // Test special reference
        let ast = AstNode::Expression(Expression::Identifier("@".to_string()));
        let deps = collect_dependencies_static(&ast);
        assert!(deps.contains(&DependencyKey::Special("@".to_string())));

        // Test member access chain
        let ast = AstNode::Expression(Expression::MemberAccess(Box::new(MemberAccessExpr {
            object: Expression::Identifier("user".to_string()),
            property: "name".to_string(),
        })));
        let deps = collect_dependencies_static(&ast);
        assert!(deps.contains(&DependencyKey::Var("user".to_string())));

        // Test special member access chain
        let ast = AstNode::Expression(Expression::MemberAccess(Box::new(MemberAccessExpr {
            object: Expression::Identifier("@".to_string()),
            property: "owner".to_string(),
        })));
        let deps = collect_dependencies_static(&ast);
        assert!(deps.contains(&DependencyKey::Special("@.owner".to_string())));

        // Test function call
        let ast = AstNode::Expression(Expression::FunctionCall(Box::new(FunctionCallExpr {
            function_name: "TEXT".to_string(),
            version: None,
            args: vec![Expression::Identifier("value".to_string())],
        })));
        let deps = collect_dependencies_static(&ast);
        assert!(deps.contains(&DependencyKey::Func("TEXT".to_string())));
        assert!(deps.contains(&DependencyKey::Var("value".to_string())));

        // Test index access
        let ast = AstNode::Expression(Expression::IndexAccess(Box::new(IndexAccessExpr {
            array: Expression::Identifier("@".to_string()),
            index: Expression::Literal(Literal::String("items".to_string())),
        })));
        let deps = collect_dependencies_static(&ast);
        assert!(deps.contains(&DependencyKey::Special("@.items".to_string())));
    }

    #[test]
    fn test_3_6_10_dependency_graph_building() {
        // Build small set of formula readsets
        let readsets = vec![
            (
                "formula1".to_string(),
                readset(&["user_name"], &[], &[], &["TEXT"]),
            ),
            (
                "formula2".to_string(),
                readset(&["user_email"], &["@.profile.name"], &[], &[]),
            ),
            // FIX: formula3 reads the variable user_name (not an entity ref)
            (
                "formula3".to_string(),
                readset(&["user_name"], &[], &[], &[]),
            ),
        ];

        // Producer map: which formula produces which key
        let mut producers = BTreeMap::new();
        producers.insert(
            DependencyKey::Var("user_name".to_string()),
            "formula1".to_string(),
        );

        let graph = DependencyGraph::build(&readsets, Some(producers));

        // formula1 -> formula3 edge (because formula3 depends on user_name)
        // Use children() to check if formula1 produces for formula3
        let formula1_children: Vec<&String> = graph
            .formula_edges
            .children(&"formula1".to_string())
            .collect();
        assert!(formula1_children.contains(&&"formula3".to_string()));

        // Use parents() to check if formula3 depends on formula1
        let formula3_parents: Vec<&String> = graph
            .formula_edges
            .parents(&"formula3".to_string())
            .collect();
        assert!(formula3_parents.contains(&&"formula1".to_string()));
    }

    #[test]
    fn test_3_6_12_dependency_invalidation_tracking() {
        let readsets = vec![
            ("A".to_string(), readset(&["input_a"], &[], &[], &[])),
            ("B".to_string(), readset(&["derived_from_a"], &[], &[], &[])),
            (
                "C".to_string(),
                readset(&["derived_from_a", "input_b"], &[], &[], &[]),
            ),
        ];

        let mut producers = BTreeMap::new();
        producers.insert(
            DependencyKey::Var("derived_from_a".to_string()),
            "A".to_string(),
        );

        let graph = DependencyGraph::build(&readsets, Some(producers));

        // Change in input_a affects A directly, and B/C via A
        let affected =
            graph.affected_formulas_from_keys(vec![DependencyKey::Var("input_a".into())]);
        assert!(affected.contains("A"));
        assert!(affected.contains("B"));
        assert!(affected.contains("C"));

        // Change in input_b only affects C
        let affected =
            graph.affected_formulas_from_keys(vec![DependencyKey::Var("input_b".into())]);
        assert!(!affected.contains("A"));
        assert!(!affected.contains("B"));
        assert!(affected.contains("C"));
    }

    #[test]
    fn test_3_6_13_dependency_visualization() {
        let readsets = vec![
            ("formula_A".to_string(), readset(&["input"], &[], &[], &[])),
            (
                "formula_B".to_string(),
                readset(&["intermediate"], &[], &[], &[]),
            ),
        ];
        let mut producers = BTreeMap::new();
        producers.insert(
            DependencyKey::Var("intermediate".to_string()),
            "formula_A".to_string(),
        );

        let graph = DependencyGraph::build(&readsets, Some(producers));

        let dot = graph.to_dot();
        assert!(dot.contains("digraph"));
        assert!(dot.contains("\"formula_A\" -> \"formula_B\""));

        let mermaid = graph.to_mermaid();
        assert!(mermaid.contains("flowchart"));
        assert!(mermaid.contains("formula_A --> formula_B"));
    }

    #[test]
    fn test_3_6_14_reactive_hooks_driver() {
        #[derive(Default)]
        struct MockHooks {
            calls: std::cell::RefCell<Vec<String>>,
        }
        impl ReactiveHooks for MockHooks {
            fn on_keys_invalidated(&self, keys: &BTreeSet<DependencyKey>) {
                self.calls
                    .borrow_mut()
                    .push(format!("keys_invalidated: {}", keys.len()));
            }
            fn on_recomputation_scheduled(&self, plan: &[String]) {
                self.calls.borrow_mut().push(format!("plan: {:?}", plan));
            }
            fn on_formula_recompute_start(&self, id: &str) {
                self.calls.borrow_mut().push(format!("start: {id}"));
            }
            fn on_formula_recompute_end(&self, id: &str, ok: bool) {
                self.calls.borrow_mut().push(format!("end: {id} ({ok})"));
            }
        }

        // Small graph: F1 -> F2
        let readsets = vec![
            ("F1".to_string(), readset(&["x"], &[], &[], &[])),
            ("F2".to_string(), readset(&["y"], &[], &[], &[])),
        ];
        let mut producers = BTreeMap::new();
        producers.insert(DependencyKey::Var("y".to_string()), "F1".to_string());

        let graph = DependencyGraph::build(&readsets, Some(producers));

        let hooks = MockHooks::default();
        run_recompute_with_hooks(
            &graph,
            [DependencyKey::Var("x".into())],
            &hooks,
            |_fid| true, // pretend eval succeeded
        );

        let calls = hooks.calls.borrow();
        assert!(calls.iter().any(|c| c.starts_with("keys_invalidated")));
        assert!(calls.iter().any(|c| c.starts_with("plan:")));
        assert!(calls.iter().any(|c| c == "start: F1"));
        assert!(calls.iter().any(|c| c == "end: F1 (true)"));
    }

    #[test]
    fn test_3_6_15_topological_and_plan() {
        // A -> B, A -> C, (B,C) -> D
        let readsets = vec![
            ("A".to_string(), readset(&["input"], &[], &[], &[])),
            ("B".to_string(), readset(&["level1"], &[], &[], &[])),
            ("C".to_string(), readset(&["level1"], &[], &[], &[])),
            (
                "D".to_string(),
                readset(&["level2a", "level2b"], &[], &[], &[]),
            ),
        ];
        let mut producers = BTreeMap::new();
        producers.insert(DependencyKey::Var("level1".into()), "A".into());
        producers.insert(DependencyKey::Var("level2a".into()), "B".into());
        producers.insert(DependencyKey::Var("level2b".into()), "C".into());

        let graph = DependencyGraph::build(&readsets, Some(producers));

        // Topological order
        let order = graph.topological_order();
        let pos = |id: &str| order.iter().position(|f| f == id).unwrap();
        assert!(pos("A") < pos("B"));
        assert!(pos("A") < pos("C"));
        assert!(pos("B") < pos("D"));
        assert!(pos("C") < pos("D"));

        // Plan after change in "input"
        let plan = graph.recomputation_plan([DependencyKey::Var("input".into())]);
        assert_eq!(plan.len(), 4);
        let p = |id: &str| plan.iter().position(|f| f == id).unwrap();
        assert!(p("A") < p("B"));
        assert!(p("A") < p("C"));
        assert!(p("B") < p("D"));
        assert!(p("C") < p("D"));
    }

    #[test]
    fn test_keys_from_readset() {
        let test_readset = readset(&["user_name"], &["@.profile"], &["$scope"], &["TEXT"]);
        let keys = keys_from_readset(&test_readset);

        assert!(keys.contains(&DependencyKey::Var("user_name".to_string())));
        assert!(keys.contains(&DependencyKey::Entity("@.profile".to_string())));
        assert!(keys.contains(&DependencyKey::Special("$scope".to_string())));
        assert!(keys.contains(&DependencyKey::Func("TEXT".to_string())));
        assert_eq!(keys.len(), 4);
    }

    // ---- Cycle detection tests (moved from formula-ast where they were misplaced during CI-12) ----

    #[test]
    fn cycle_detection_finds_simple_cycle() {
        let expr = Expression::Identifier("A".into());
        let provider = MapProvider::new(&[("A", &["B"]), ("B", &["A"])]);
        let errs = detect_cycles(&expr, &provider).unwrap_err();
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidationErrorKind::CyclicReference { .. })));
    }

    #[test]
    fn cycle_detection_ok_when_acyclic() {
        let expr = Expression::Identifier("A".into());
        let provider = MapProvider::new(&[("A", &["B"]), ("B", &["C"]), ("C", &[])]);
        assert!(detect_cycles(&expr, &provider).is_ok());
    }

    #[test]
    fn cycle_detection_handles_multiple_bases() {
        let expr = Expression::Binary(Box::new(BinaryExpr {
            op: BinaryOp::Add,
            left: Expression::Identifier("A".into()),
            right: Expression::Identifier("X".into()),
        }));
        let provider = MapProvider::new(&[("A", &["B"]), ("B", &[]), ("X", &["Y"]), ("Y", &["X"])]);
        let errs = detect_cycles(&expr, &provider).unwrap_err();
        assert!(errs.iter().any(|e| matches!(&e.kind, ValidationErrorKind::CyclicReference { identifier } if identifier == "X")));
    }
}
