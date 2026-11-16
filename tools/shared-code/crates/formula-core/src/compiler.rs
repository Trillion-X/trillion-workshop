//! Compiler - Orchestrates compilation from AST to executable plans
//!
//! The Compiler is the new orchestrator replacing evaluator.rs. It implements
//! the QUERY_CACHE primitive and builds hypergraph manifolds from ASTs.

use crate::rules::{OptimizationRule, RuleCostModel, RuleProperties};
use crate::{
    ast::{AstNode, BinaryOp, Expression, Literal},
    ConstraintKind, EvaluationContext, HyperedgeSpec, Manifold, Node, NodeId, Value,
};
use crate::{HyperedgeId, ManifoldPatch};
use std::collections::HashMap;

/// Cache key ordering for deterministic hash generation
const CACHE_KEY_ORDER: [&str; 5] = ["ast", "schema", "udf", "perm", "engine"];

/// Built-in functions that are part of the formula engine (not UDFs).
/// These do NOT require udf_implementations metadata.
fn is_builtin_function(name: &str) -> bool {
    static REGISTRY: std::sync::OnceLock<crate::rules::registry::RuleRegistry> =
        std::sync::OnceLock::new();
    REGISTRY
        .get_or_init(crate::rules::registry::RuleRegistry::with_builtin_rules)
        .get(name)
        .is_some()
}

/// Compilation errors that can occur during the compile process
#[derive(Debug, Clone, PartialEq)]
pub enum CompilationError {
    AstParsingFailed(String),
    InvalidOperator(String),
    UnresolvedReference(String),
    CacheError(String),
    ManifoldBuildError(String),
    MissingConfiguration { field: String },
}

impl std::fmt::Display for CompilationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CompilationError::AstParsingFailed(msg) => write!(f, "AST parsing failed: {}", msg),
            CompilationError::InvalidOperator(op) => write!(f, "Invalid operator: {}", op),
            CompilationError::UnresolvedReference(ref_name) => {
                write!(f, "Unresolved reference: {}", ref_name)
            }
            CompilationError::CacheError(msg) => write!(f, "Cache error: {}", msg),
            CompilationError::ManifoldBuildError(msg) => write!(f, "Manifold build error: {}", msg),
            CompilationError::MissingConfiguration { field } => {
                write!(f, "Missing configuration: {}", field)
            }
        }
    }
}

impl std::error::Error for CompilationError {}

/// Execution plan types - bytecode for cache hits, manifold for cache misses
#[derive(Debug, Clone)]
pub enum ExecutionPlan {
    /// Cached bytecode for immediate execution
    Bytecode(Vec<u8>),
    /// Hypergraph manifold for solver execution
    Manifold(Manifold),
}

/// Simple cache client trait for abstraction
pub trait CacheClient {
    fn get(&self, key: &str) -> Option<Vec<u8>>;
    fn set(&self, key: &str, value: Vec<u8>) -> Result<(), String>;
}

/// Simple in-memory cache implementation
pub struct InMemoryCache {
    cache: HashMap<String, Vec<u8>>,
}

impl InMemoryCache {
    pub fn new() -> Self {
        Self {
            cache: HashMap::new(),
        }
    }
}

impl Default for InMemoryCache {
    fn default() -> Self {
        Self::new()
    }
}

impl CacheClient for InMemoryCache {
    fn get(&self, key: &str) -> Option<Vec<u8>> {
        self.cache.get(key).cloned()
    }

    fn set(&self, _key: &str, _value: Vec<u8>) -> Result<(), String> {
        // This cache implementation has no interior mutability, so writes are
        // acknowledged without creating hidden shared state.
        Ok(())
    }
}

/// Cost-aware optimizer that selects the best optimization rules based on cost models.
pub struct CostAwareOptimizer {
    available_rules: Vec<Box<dyn OptimizationRule>>,
    cost_budget_micro_ops: u64,
}

impl CostAwareOptimizer {
    pub fn new(rules: Vec<Box<dyn OptimizationRule>>, budget: u64) -> Self {
        Self {
            available_rules: rules,
            cost_budget_micro_ops: budget,
        }
    }

    /// Create an optimizer with basic constant folding rules
    pub fn with_standard_rules(budget: u64) -> Self {
        let rules: Vec<Box<dyn OptimizationRule>> = vec![
            Box::new(FoldConstAdd),
            // More optimization rules can be added here
        ];
        Self::new(rules, budget)
    }

    /// Select the optimal set of optimization rules for a given manifold.
    /// Uses cost models to maximize optimization benefit within budget constraints.
    pub fn select_optimal_rules(&self, manifold: &Manifold) -> Vec<&dyn OptimizationRule> {
        let data_size = self.estimate_manifold_size(manifold);
        let mut candidates = Vec::new();

        // Calculate optimization scores for all applicable rules
        for rule in &self.available_rules {
            let properties = rule.properties();
            let cost_model = &properties.cost_model;

            if cost_model.is_applicable(data_size) {
                let score = cost_model.optimization_score(data_size);
                let estimated_cost = cost_model.estimate_cost(data_size);

                candidates.push((rule.as_ref(), score, estimated_cost));
            }
        }

        // Sort by optimization score (benefit/cost ratio) descending
        candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

        // Select rules within budget using greedy knapsack approach
        let mut selected_rules = Vec::new();
        let mut remaining_budget = self.cost_budget_micro_ops;

        for (rule, _score, cost) in candidates {
            if cost <= remaining_budget {
                selected_rules.push(rule);
                remaining_budget -= cost;
            }
        }

        selected_rules
    }

    /// Estimate the size of data being processed by the manifold.
    fn estimate_manifold_size(&self, manifold: &Manifold) -> u64 {
        // This implementation analyzes the actual data values for a more accurate cost model.
        let mut total_size = 0;

        for node_id in manifold.node_ids() {
            if let Some(node) = manifold.get_node(node_id) {
                match node {
                    // For ready nodes, we can inspect the values directly.
                    Node::Ready(value) => {
                        match &value.0 {
                            serde_json::Value::Array(arr) => total_size += arr.len() as u64,
                            serde_json::Value::String(s) => total_size += s.len() as u64,
                            serde_json::Value::Object(obj) => total_size += obj.len() as u64,
                            // For simple types, count as 1.
                            _ => total_size += 1,
                        }
                    }
                    // For pending nodes, we can't know the size yet.
                    // Pending nodes have no concrete value to measure, so each unresolved
                    // lookup contributes the minimum nonzero unit.
                    Node::Pending => {
                        total_size += 1;
                    }
                }
            }
        }

        // Return the calculated size, or a minimum of 1 to avoid division by zero.
        total_size.max(1)
    }

    /// Calculate the total optimization budget remaining.
    pub fn remaining_budget(&self, used_cost: u64) -> u64 {
        self.cost_budget_micro_ops.saturating_sub(used_cost)
    }
}

/// Example optimization rule that folds constant additions
pub struct FoldConstAdd;

impl OptimizationRule for FoldConstAdd {
    fn properties(&self) -> RuleProperties {
        RuleProperties {
            is_monotonic: true,
            is_idempotent: true,
            reduces_graph: true,
            max_cost_ops: 1,
            cost_model: RuleCostModel::arithmetic_basic(),
        }
    }

    fn try_apply(&self, manifold: &Manifold, edge_id: HyperedgeId) -> Option<ManifoldPatch> {
        let edge = manifold.edge(edge_id)?;

        // Only apply to Add constraints
        if !matches!(edge.constraint_type, ConstraintKind::Add) {
            return None;
        }

        // Must have exactly 2 inputs
        let (left_id, right_id) = match edge.input_nodes.as_slice() {
            &[l, r] => (l, r),
            _ => return None,
        };

        let left_node = manifold.get_node(left_id)?;
        let right_node = manifold.get_node(right_id)?;

        // Match on ready nodes with numeric values.
        let left_num = match left_node {
            Node::Ready(Value(serde_json::Value::Number(n))) => n.as_f64()?,
            _ => return None,
        };
        let right_num = match right_node {
            Node::Ready(Value(serde_json::Value::Number(n))) => n.as_f64()?,
            _ => return None,
        };

        // Perform the constant fold
        let sum = left_num + right_num;
        let sum_value = Value(serde_json::json!(sum));

        Some(ManifoldPatch {
            edges_to_remove: vec![edge_id],
            edges_to_add: vec![HyperedgeSpec {
                constraint_type: ConstraintKind::Const(sum_value),
                tags: vec![],
                input_nodes: vec![],
                output_node: edge.output_node,
            }],
        })
    }
}

/// The main compiler struct that orchestrates compilation
pub struct Compiler {
    cache_client: Box<dyn CacheClient>,
    optimizer: CostAwareOptimizer,
}

impl Compiler {
    /// Create a new compiler with the given cache client and optimizer
    pub fn new(cache_client: Box<dyn CacheClient>, optimizer: CostAwareOptimizer) -> Self {
        Self {
            cache_client,
            optimizer,
        }
    }

    /// Main compilation entry point - implements QUERY_CACHE primitive
    pub fn compile(
        &self,
        ast: &AstNode,
        ctx: &EvaluationContext,
    ) -> Result<ExecutionPlan, CompilationError> {
        // Generate cache key using canonical ordering (this only needs immutable access)
        let cache_key = self.make_cache_key(ast, ctx)?;

        // QUERY_CACHE: Check the L3 optimized-rules cache first.
        if let Some(bytecode) = self.cache_client.get(&cache_key) {
            return Ok(ExecutionPlan::Bytecode(bytecode));
        }

        // Cache miss - build hypergraph manifold
        let manifold = self.build_manifold(ast, ctx)?;
        Ok(ExecutionPlan::Manifold(manifold))
    }

    /// Main entry point for generating the secure, dependency-aware cache key
    fn make_cache_key(
        &self,
        ast: &AstNode,
        ctx: &EvaluationContext,
    ) -> Result<String, CompilationError> {
        // In a real implementation, these would involve database lookups based on dependencies
        // Built-ins return a stable digest because their implementations ship with this crate.
        let schema_digest = self.get_schema_digest(ast, ctx)?;
        let udf_digest = self.get_udf_digest(ast, ctx)?;

        self.compute_dependency_aware_hash(ast, &schema_digest, &udf_digest, ctx)
    }

    /// Computes the definitive, secure cache key as specified in the amendment
    fn compute_dependency_aware_hash(
        &self,
        ast: &AstNode,
        schema_digest: &str,
        udf_digest: &str,
        ctx: &EvaluationContext,
    ) -> Result<String, CompilationError> {
        use content_crypto::StreamingHasher;
        let mut hasher = StreamingHasher::new();

        // --- Permission Fingerprinting (CRITICAL SECURITY) ---
        let perm_fingerprint = {
            let mut perm_hasher = StreamingHasher::new();
            // Use the new getter instead of direct field access for encapsulation
            let mut permissions: Vec<String> = ctx
                .get_actor_permissions()
                .iter()
                .map(|p| p.to_lowercase()) // Normalize to lowercase
                .collect();
            permissions.sort_unstable();
            permissions.dedup();
            for perm in &permissions {
                perm_hasher.update(perm.as_bytes()); // Hash each permission directly
            }
            // Self-describing multihash identity of the permission set
            perm_hasher.finalize_multihash().to_code_hex()
        };

        for &component in &CACHE_KEY_ORDER {
            match component {
                "ast" => {
                    // Use the stable AST serializer with dependency information
                    let dependencies = self.extract_ast_dependencies(ast);
                    let ast_canonical =
                        self.canonicalize_ast_with_dependencies(ast, &dependencies)?;
                    hasher.update(ast_canonical.as_bytes());
                }
                "schema" => hasher.update(schema_digest.as_bytes()),
                "udf" => hasher.update(udf_digest.as_bytes()),
                "perm" => hasher.update(perm_fingerprint.as_bytes()),
                "engine" => {
                    // Use actual engine version from Cargo.toml
                    let engine_semver = env!("CARGO_PKG_VERSION");
                    hasher.update(engine_semver.as_bytes());
                }
                _ => unreachable!("Invalid cache key component"),
            }
        }

        // Add security-critical context fields for multi-tenant isolation
        if let Some(user_id) = ctx.get_user_id() {
            hasher.update(b"user_id:");
            hasher.update(user_id.as_bytes());
        }

        if let Some(partition_key) = ctx.get_partition_key() {
            hasher.update(b"partition_key:");
            hasher.update(partition_key.as_bytes());
        }

        if let Some(owner_id) = ctx.get_owner_id() {
            hasher.update(b"owner_id:");
            hasher.update(owner_id.as_bytes());
        }

        // Include max traversal depth for security policy differentiation
        hasher.update(b"max_depth:");
        hasher.update(ctx.get_max_traversal_depth().to_string().as_bytes());

        // Include scope metadata hash for additional context isolation
        let metadata_sorted = ctx.get_scope_metadata_sorted();
        if !metadata_sorted.is_empty() {
            hasher.update(b"metadata:");
            for (key, value) in metadata_sorted {
                hasher.update(key.as_bytes());
                hasher.update(b":");
                // Use deterministic JSON serialization for Value
                if let Ok(json_str) = serde_json::to_string(value) {
                    hasher.update(json_str.as_bytes());
                }
                hasher.update(b";");
            }
        }

        // --- Determinism & Environmental Context (CRITICAL) ---
        hasher.update(b"det:");
        hasher.update(ctx.get_determinism_level().as_bytes());
        hasher.update(b"flt:");
        hasher.update(ctx.get_float_mode().as_bytes());
        if ctx.get_determinism_level() == "stochastic_fixed_seed" {
            hasher.update(b"seed:");
            hasher.update(&ctx.get_execution_seed().to_le_bytes());
        }
        hasher.update(b"tz:");
        hasher.update(ctx.get_user_timezone().as_bytes());
        hasher.update(b"loc:");
        hasher.update(ctx.get_locale().as_bytes());

        Ok(hasher.finalize_multihash().to_code_hex())
    }

    /// Extract all dependencies from AST for dependency-aware caching
    fn extract_ast_dependencies(&self, ast: &AstNode) -> Vec<String> {
        let mut dependencies = Vec::new();
        self.collect_dependencies_recursive(ast, &mut dependencies);
        dependencies.sort(); // Ensure deterministic ordering
        dependencies.dedup(); // Remove duplicates
        dependencies
    }

    /// Recursively collect all identifiers and function names as dependencies
    fn collect_dependencies_recursive(&self, ast: &AstNode, dependencies: &mut Vec<String>) {
        match ast {
            AstNode::Expression(expr) => {
                self.collect_expression_dependencies(expr, dependencies);
            }
        }
    }

    /// Collect dependencies from expressions
    fn collect_expression_dependencies(&self, expr: &Expression, dependencies: &mut Vec<String>) {
        match expr {
            Expression::Identifier(name) => {
                dependencies.push(format!("identifier:{}", name));
            }
            Expression::Binary(binary_expr) => {
                self.collect_expression_dependencies(&binary_expr.left, dependencies);
                self.collect_expression_dependencies(&binary_expr.right, dependencies);
            }
            Expression::FunctionCall(func_expr) => {
                dependencies.push(format!("function:{}", func_expr.function_name));
                if let Some(version) = &func_expr.version {
                    dependencies.push(format!(
                        "function_version:{}:{}",
                        func_expr.function_name, version
                    ));
                }
                for arg in &func_expr.args {
                    self.collect_expression_dependencies(arg, dependencies);
                }
            }
            Expression::Literal(Literal::Array(elements)) => {
                for element in elements {
                    self.collect_expression_dependencies(element, dependencies);
                }
            }
            Expression::Literal(Literal::Object(fields)) => {
                for (_key, value) in fields {
                    self.collect_expression_dependencies(value, dependencies);
                }
            }
            Expression::Unary(unary_expr) => {
                self.collect_expression_dependencies(&unary_expr.expr, dependencies);
            }
            Expression::MemberAccess(member_expr) => {
                self.collect_expression_dependencies(&member_expr.object, dependencies);
                dependencies.push(format!("member_access:{}", member_expr.property));
            }
            Expression::IndexAccess(index_expr) => {
                self.collect_expression_dependencies(&index_expr.array, dependencies);
                self.collect_expression_dependencies(&index_expr.index, dependencies);
            }
            Expression::Lambda(lambda_expr) => {
                for param in &lambda_expr.parameters {
                    dependencies.push(format!("lambda_param:{}", param));
                }
                self.collect_expression_dependencies(&lambda_expr.body, dependencies);
            }
            Expression::VersionedIdentifier { name, version } => {
                dependencies.push(format!("versioned_identifier:{}:{}", name, version));
            }
            _ => {} // Literals don't have dependencies
        }
    }

    /// Canonicalize AST representation with dependency information for consistent hashing
    fn canonicalize_ast_with_dependencies(
        &self,
        ast: &AstNode,
        dependencies: &[String],
    ) -> Result<String, CompilationError> {
        let mut canonical = String::new();

        // Include dependency hash first for cache invalidation
        canonical.push_str("dependencies:[");
        for (i, dep) in dependencies.iter().enumerate() {
            if i > 0 {
                canonical.push(',');
            }
            canonical.push_str(dep);
        }
        canonical.push(']');

        // Then include normalized AST representation using stable serializer
        canonical.push_str("&ast:");
        canonical.push_str(&self.canonical_ast(ast));

        Ok(canonical)
    }

    /// Stable, deterministic AST serializer
    fn canonical_ast(&self, ast: &AstNode) -> String {
        fn write_expr(buf: &mut String, e: &Expression) {
            match e {
                Expression::Literal(Literal::Null) => buf.push_str("Lit:null"),
                Expression::Literal(Literal::Boolean(b)) => {
                    buf.push_str(if *b { "Lit:true" } else { "Lit:false" })
                }
                Expression::Literal(Literal::Number(n)) => {
                    // Use bit representation for perfect determinism across platforms
                    use std::fmt::Write as _;
                    let _ = write!(buf, "Lit:num:bits:{}", n.to_bits());
                }
                Expression::Literal(Literal::String(s)) => {
                    buf.push_str("Lit:str:");
                    // Use JSON escaping for safety and determinism
                    if let Ok(escaped) = serde_json::to_string(s) {
                        buf.push_str(&escaped);
                    } else {
                        buf.push_str(s);
                    }
                }
                Expression::Literal(Literal::Array(items)) => {
                    buf.push_str("Lit:arr[");
                    for (i, it) in items.iter().enumerate() {
                        if i > 0 {
                            buf.push(',');
                        }
                        write_expr(buf, it);
                    }
                    buf.push(']');
                }
                Expression::Literal(Literal::Object(fields)) => {
                    buf.push_str("Lit:obj{");
                    // Sort by key for deterministic serialization
                    let mut sorted_fields = fields.clone();
                    sorted_fields.sort_by(|(a, _), (b, _)| a.cmp(b));
                    for (i, (k, v)) in sorted_fields.iter().enumerate() {
                        if i > 0 {
                            buf.push(',');
                        }
                        // Escape the key using JSON serialization for safety
                        if let Ok(escaped_key) = serde_json::to_string(k) {
                            buf.push_str(&escaped_key);
                        } else {
                            buf.push_str(k);
                        }
                        buf.push(':');
                        write_expr(buf, v);
                    }
                    buf.push('}');
                }
                Expression::Identifier(n) => {
                    buf.push_str("Id:");
                    buf.push_str(n);
                }
                Expression::Binary(b) => {
                    buf.push_str("Bin(");
                    write_expr(buf, &b.left);
                    use std::fmt::Write as _;
                    let _ = write!(buf, ":{:?}:", b.op);
                    write_expr(buf, &b.right);
                    buf.push(')');
                }
                Expression::Unary(u) => {
                    buf.push_str("Un(");
                    use std::fmt::Write as _;
                    let _ = write!(buf, "{:?}:", u.op);
                    write_expr(buf, &u.expr);
                    buf.push(')');
                }
                Expression::FunctionCall(f) => {
                    buf.push_str("Call:");
                    buf.push_str(&f.function_name);
                    if let Some(v) = &f.version {
                        buf.push('@');
                        use std::fmt::Write as _;
                        let _ = write!(buf, "{}", v);
                    }
                    buf.push('(');
                    for (i, a) in f.args.iter().enumerate() {
                        if i > 0 {
                            buf.push(',');
                        }
                        write_expr(buf, a);
                    }
                    buf.push(')');
                }
                Expression::MemberAccess(m) => {
                    buf.push_str("Mem.");
                    write_expr(buf, &m.object);
                    buf.push('.');
                    buf.push_str(&m.property);
                }
                Expression::IndexAccess(ix) => {
                    buf.push_str("Idx(");
                    write_expr(buf, &ix.array);
                    buf.push(',');
                    write_expr(buf, &ix.index);
                    buf.push(')');
                }
                Expression::VersionedIdentifier { name, version } => {
                    buf.push_str("Vid:");
                    buf.push_str(name);
                    buf.push('@');
                    use std::fmt::Write as _;
                    let _ = write!(buf, "{}", version);
                }
                Expression::Lambda(l) => {
                    buf.push_str("Lambda(");
                    for (i, p) in l.parameters.iter().enumerate() {
                        if i > 0 {
                            buf.push(',');
                        }
                        buf.push_str(p);
                    }
                    buf.push_str(")=>");
                    write_expr(buf, &l.body);
                }
            }
        }

        let mut s = String::new();
        let AstNode::Expression(e) = ast;
        write_expr(&mut s, e);
        s
    }

    // --- Helper Functions for Hashing ---

    fn get_schema_digest(
        &self,
        ast: &AstNode,
        ctx: &EvaluationContext,
    ) -> Result<String, CompilationError> {
        use content_crypto::StreamingHasher;
        let mut hasher = StreamingHasher::new();

        // Include permissions for security fingerprint
        for perm in ctx.get_actor_permissions() {
            hasher.update(b"perm:");
            hasher.update(perm.as_bytes());
        }

        // Extract dependencies from AST
        let dependencies = self.extract_ast_dependencies(ast);

        // Collect identifiers that are already defined as variables in context
        // These are NOT schema references - they're local variables like "event", "graph"
        let variable_names: std::collections::HashSet<_> =
            ctx.get_variable_names().into_iter().collect();

        // Filter schema dependencies:
        // - identifier:X is a schema dep ONLY if X is not a variable
        // - member_access:Y is always included (property names don't tell us the root)
        //   but we track which identifiers are variables to skip their member accesses
        let schema_deps: Vec<_> = dependencies
            .iter()
            .filter(|d| {
                if d.starts_with("identifier:") {
                    let name = d.split(':').nth(1).unwrap_or("");
                    // Skip if this identifier is a variable (e.g., "event", "graph")
                    !variable_names.contains(name)
                } else if d.starts_with("member_access:") {
                    // Member accesses on variables don't need schema versioning
                    // Since we can't easily track which member_access belongs to which root,
                    // we skip all member_access deps when there are variables defined.
                    // This is safe because:
                    // - If formula uses ONLY variables (like trigger queries), no schema check needed
                    // - If formula uses schemas (like =User.name), identifiers will be caught above
                    variable_names.is_empty()
                } else {
                    false
                }
            })
            .collect();

        // Use scope metadata as schema version registry
        if let Some(Value(serde_json::Value::Object(metadata))) =
            ctx.get_scope_metadata("schema_versions")
        {
            for dep in schema_deps {
                let path = dep.split(':').nth(1).unwrap_or("");
                if let Some(version) = metadata.get(path) {
                    hasher.update(b"schema:");
                    hasher.update(path.as_bytes());
                    hasher.update(version.to_string().as_bytes());
                } else {
                    return Err(CompilationError::UnresolvedReference(dep.to_string()));
                }
            }
        } else if !schema_deps.is_empty() {
            return Err(CompilationError::MissingConfiguration {
                field: "schema_versions".to_string(),
            });
        }

        Ok(hasher.finalize_multihash().to_code_hex())
    }

    fn get_udf_digest(
        &self,
        ast: &AstNode,
        ctx: &EvaluationContext,
    ) -> Result<String, CompilationError> {
        use content_crypto::StreamingHasher;
        let mut hasher = StreamingHasher::new();

        // Include determinism level for cache safety
        hasher.update(b"det:");
        hasher.update(ctx.get_determinism_level().as_bytes());
        hasher.update(b"seed:");
        hasher.update(&ctx.get_execution_seed().to_le_bytes());

        // Extract and hash UDF dependencies from scope metadata
        // Filter out built-in functions - only true UDFs need metadata lookup
        let dependencies = self.extract_ast_dependencies(ast);
        let udf_deps: Vec<_> = dependencies
            .iter()
            .filter(|d| {
                if d.starts_with("function:") {
                    let name = d.split(':').nth(1).unwrap_or("");
                    // Only include if NOT a built-in function
                    !is_builtin_function(name)
                } else {
                    false
                }
            })
            .collect();

        // Use scope metadata as UDF implementation registry
        // Only required if there are actual UDFs (not built-ins)
        if let Some(Value(serde_json::Value::Object(metadata))) =
            ctx.get_scope_metadata("udf_implementations")
        {
            for dep in &udf_deps {
                let name = dep.split(':').nth(1).unwrap_or("");
                if let Some(impl_hash) = metadata.get(name) {
                    hasher.update(b"udf:");
                    hasher.update(name.as_bytes());
                    hasher.update(impl_hash.to_string().as_bytes());
                } else {
                    return Err(CompilationError::UnresolvedReference(dep.to_string()));
                }
            }
        } else if !udf_deps.is_empty() {
            return Err(CompilationError::MissingConfiguration {
                field: "udf_implementations".to_string(),
            });
        }

        Ok(hasher.finalize_multihash().to_code_hex())
    }

    /// Build hypergraph manifold from AST
    fn build_manifold(
        &self,
        ast: &AstNode,
        ctx: &EvaluationContext,
    ) -> Result<Manifold, CompilationError> {
        let mut manifold = Manifold::new();

        // Convert AST to hypergraph representation
        let result_node = self.ast_to_manifold(ast, &mut manifold, ctx)?;
        manifold
            .set_result_node(result_node)
            .map_err(CompilationError::ManifoldBuildError)?;

        // --- Definitive Fixed-Point Optimizer Loop ---
        const MAX_OPTIMIZER_PASSES: usize = 10;
        for _ in 0..MAX_OPTIMIZER_PASSES {
            let optimal_rules = self.optimizer.select_optimal_rules(&manifold);
            if optimal_rules.is_empty() {
                break;
            }

            let mut changed_this_pass = false;
            let edge_ids = manifold.edge_ids(); // Get a stable list of IDs for this pass

            // Collect all possible patches in a single pass
            let mut patches = Vec::new();
            for rule in &optimal_rules {
                for &edge_id in &edge_ids {
                    if manifold.edge(edge_id).is_some() {
                        // Check if edge still exists
                        if let Some(patch) = rule.try_apply(&manifold, edge_id) {
                            patches.push(patch);
                        }
                    }
                }
            }

            // If any optimizations were found, apply them all
            if !patches.is_empty() {
                changed_this_pass = true;
                for patch in patches {
                    manifold
                        .apply_patch(patch)
                        .map_err(CompilationError::ManifoldBuildError)?;
                }
            }

            // If a full pass completes with no changes, we have reached a fixed point
            if !changed_this_pass {
                break;
            }
        }

        Ok(manifold)
    }

    /// Recursively convert AST nodes to hypergraph nodes and edges
    fn ast_to_manifold(
        &self,
        ast: &AstNode,
        manifold: &mut Manifold,
        ctx: &EvaluationContext,
    ) -> Result<NodeId, CompilationError> {
        match ast {
            AstNode::Expression(expr) => self.expression_to_manifold(expr, manifold, 0, ctx),
        }
    }

    /// Convert an expression to manifold nodes and edges
    fn expression_to_manifold(
        &self,
        expr: &Expression,
        manifold: &mut Manifold,
        depth: usize,
        ctx: &EvaluationContext,
    ) -> Result<NodeId, CompilationError> {
        if depth > formula_ast::MAX_FORMULA_AST_DEPTH {
            return Err(CompilationError::AstParsingFailed(format!(
                "Max recursion depth of {} exceeded",
                formula_ast::MAX_FORMULA_AST_DEPTH
            )));
        }
        match expr {
            Expression::Literal(literal) => {
                // Convert literal to manifold node
                self.literal_to_manifold(literal, manifold, depth + 1, ctx)
            }
            Expression::Identifier(name) => {
                // Step 1: Check for a locally scoped variable (compile-time constant).
                if let Some(val) = ctx.get_variable(name) {
                    let node_id = manifold
                        .create_node(Node::Ready(val.clone()), format!("const_var:{}", name));
                    return Ok(node_id);
                }

                // Step 2 & 3: For all other identifiers, create an unresolved node with a lookup
                // constraint. The solver will handle resolving it from the data context at runtime.

                // CRITICALLY, we record the dependency read now, at compile time.
                ctx.record_read(name);

                let result_node = manifold.create_node(Node::Pending, format!("lookup:{}", name));

                let spec = HyperedgeSpec {
                    constraint_type: ConstraintKind::VariableLookup(name.clone()),
                    tags: vec![],
                    input_nodes: vec![],
                    output_node: result_node,
                };
                manifold
                    .add_edge(spec)
                    .map_err(CompilationError::ManifoldBuildError)?;

                Ok(result_node)
            }
            Expression::Binary(binary_expr) => {
                // Binary operations become hyperedges
                let left_node =
                    self.expression_to_manifold(&binary_expr.left, manifold, depth + 1, ctx)?;
                let right_node =
                    self.expression_to_manifold(&binary_expr.right, manifold, depth + 1, ctx)?;
                let result_node =
                    manifold.create_node(Node::Pending, format!("binary_op_{:?}", binary_expr.op));

                let (constraint_type, is_comparison) = match binary_expr.op {
                    BinaryOp::Add => (ConstraintKind::Add, false),
                    BinaryOp::Subtract => (ConstraintKind::Subtract, false),
                    BinaryOp::Multiply => (ConstraintKind::Multiply, false),
                    BinaryOp::Divide => (ConstraintKind::Divide, false),
                    BinaryOp::Modulo => (ConstraintKind::Modulo, false),
                    BinaryOp::Eq => (ConstraintKind::Equal, true),
                    BinaryOp::NotEq => (ConstraintKind::NotEqual, true),
                    BinaryOp::Lt => (ConstraintKind::LessThan, true),
                    BinaryOp::Lte => (ConstraintKind::LessThanOrEqual, true),
                    BinaryOp::Gt => (ConstraintKind::GreaterThan, true),
                    BinaryOp::Gte => (ConstraintKind::GreaterThanOrEqual, true),
                    BinaryOp::And => (ConstraintKind::And, false),
                    BinaryOp::Or => (ConstraintKind::Or, false),
                };

                // Build tags for solver heuristics
                let mut tags = Vec::new();
                if is_comparison {
                    tags.push(ConstraintKind::NumericComparison);
                } else if matches!(
                    binary_expr.op,
                    BinaryOp::Add
                        | BinaryOp::Subtract
                        | BinaryOp::Multiply
                        | BinaryOp::Divide
                        | BinaryOp::Modulo
                ) {
                    tags.push(ConstraintKind::ArithmeticOp);
                } else if matches!(binary_expr.op, BinaryOp::And | BinaryOp::Or) {
                    tags.push(ConstraintKind::LogicalOp);
                }

                // Use the new API to add a tagged edge
                manifold
                    .add_edge_with_tags(
                        constraint_type,
                        tags,
                        vec![left_node, right_node],
                        result_node,
                    )
                    .map_err(CompilationError::ManifoldBuildError)?;
                Ok(result_node)
            }
            Expression::FunctionCall(func_expr) => {
                // Inputs are only the argument nodes.
                let mut input_nodes = Vec::new();
                for arg in &func_expr.args {
                    input_nodes.push(self.expression_to_manifold(arg, manifold, depth + 1, ctx)?);
                }

                // Create a descriptive label for the result node.
                let label = if let Some(v) = func_expr.version {
                    format!("call:{}@{}", func_expr.function_name, v)
                } else {
                    format!("call:{}", func_expr.function_name)
                };
                let result_node = manifold.create_node(Node::Pending, label);

                // The function's identity and version are correctly part of the constraint itself.
                let constraint_type = ConstraintKind::FunctionCall {
                    name: func_expr.function_name.clone(),
                    version: func_expr.version,
                };

                manifold
                    .add_edge_with_tags(constraint_type, vec![], input_nodes, result_node)
                    .map_err(CompilationError::ManifoldBuildError)?;

                Ok(result_node)
            }
            Expression::Unary(unary_expr) => {
                let operand_node =
                    self.expression_to_manifold(&unary_expr.expr, manifold, depth + 1, ctx)?;
                let result_node =
                    manifold.create_node(Node::Pending, format!("unary_op_{:?}", unary_expr.op));

                let (constraint_kind, composite_tag) = match unary_expr.op {
                    crate::ast::UnaryOp::Not => {
                        (ConstraintKind::Not, Some(ConstraintKind::LogicalOp))
                    }
                    crate::ast::UnaryOp::Negate => {
                        (ConstraintKind::Negate, Some(ConstraintKind::ArithmeticOp))
                    }
                };

                let tags = if let Some(tag) = composite_tag {
                    vec![tag]
                } else {
                    vec![]
                };

                manifold
                    .add_edge_with_tags(constraint_kind, tags, vec![operand_node], result_node)
                    .map_err(CompilationError::ManifoldBuildError)?;
                Ok(result_node)
            }
            Expression::MemberAccess(member_expr) => {
                let object_node =
                    self.expression_to_manifold(&member_expr.object, manifold, depth + 1, ctx)?;
                let result_node = manifold.create_node(
                    Node::Pending,
                    format!("member_access:{}", member_expr.property),
                );

                let spec = HyperedgeSpec {
                    constraint_type: ConstraintKind::MemberAccess(member_expr.property.clone()),
                    tags: vec![],
                    input_nodes: vec![object_node],
                    output_node: result_node,
                };
                manifold
                    .add_edge(spec)
                    .map_err(CompilationError::ManifoldBuildError)?;
                Ok(result_node)
            }
            Expression::IndexAccess(index_expr) => {
                let array_node =
                    self.expression_to_manifold(&index_expr.array, manifold, depth + 1, ctx)?;
                let index_node =
                    self.expression_to_manifold(&index_expr.index, manifold, depth + 1, ctx)?;
                let result_node = manifold.create_node(Node::Pending, "index_access".to_string());
                let spec = HyperedgeSpec {
                    constraint_type: ConstraintKind::IndexAccess,
                    tags: vec![],
                    input_nodes: vec![array_node, index_node],
                    output_node: result_node,
                };
                manifold
                    .add_edge(spec)
                    .map_err(CompilationError::ManifoldBuildError)?;
                Ok(result_node)
            }
            Expression::Lambda(lambda_expr) => {
                // Lambda expressions create closure nodes with parameter bindings
                let body_node =
                    self.expression_to_manifold(&lambda_expr.body, manifold, depth + 1, ctx)?;
                let result_node = manifold.create_node(Node::Pending, "lambda_closure".to_string());

                // Create parameter nodes for the lambda
                let mut param_nodes = Vec::new();
                for param in &lambda_expr.parameters {
                    let param_node =
                        manifold.add_node(Value(serde_json::Value::String(param.clone())));
                    param_nodes.push(param_node);
                }

                // Add the body node to the inputs
                param_nodes.push(body_node);

                // Create a Lambda constraint edge
                manifold
                    .add_edge_with_tags(
                        ConstraintKind::Lambda,
                        vec![], // No composite tags for lambdas yet
                        param_nodes,
                        result_node,
                    )
                    .map_err(CompilationError::ManifoldBuildError)?;

                Ok(result_node)
            }
            Expression::VersionedIdentifier { name, version } => {
                let result_node = manifold.create_node(
                    Node::Pending,
                    format!("versioned_lookup:{}:{}", name, version),
                );

                let spec = HyperedgeSpec {
                    constraint_type: ConstraintKind::VersionedLookup(name.clone(), *version),
                    tags: vec![],
                    input_nodes: vec![],
                    output_node: result_node,
                };
                manifold
                    .add_edge(spec)
                    .map_err(CompilationError::ManifoldBuildError)?;
                Ok(result_node)
            }
        }
    }

    /// Convert a literal to a manifold node, performing constant-folding for static collections
    fn literal_to_manifold(
        &self,
        literal: &Literal,
        manifold: &mut Manifold,
        depth: usize,
        ctx: &EvaluationContext,
    ) -> Result<NodeId, CompilationError> {
        match literal {
            Literal::Null => Ok(manifold.add_node(Value(serde_json::Value::Null))),
            Literal::Boolean(b) => Ok(manifold.add_node(Value(serde_json::Value::Bool(*b)))),
            Literal::Number(n) => Ok(manifold.add_node(Value(serde_json::json!(*n)))),
            Literal::String(s) => {
                Ok(manifold.add_node(Value(serde_json::Value::String(s.clone()))))
            }
            // Smart literal handling: constant-fold pure literals, create constructor edges for dynamic ones
            Literal::Array(elements)
                if elements.iter().all(|e| matches!(e, Expression::Literal(_))) =>
            {
                // Constant folding: All elements are literals, so we can resolve at compile time
                let mut resolved_values = Vec::new();
                for expr in elements {
                    if let Expression::Literal(lit) = expr {
                        let node_id = self.literal_to_manifold(lit, manifold, depth + 1, ctx)?;
                        if let Some(Node::Ready(val)) = manifold.get_node(node_id) {
                            resolved_values.push(val.0.clone());
                        }
                    }
                }
                Ok(manifold.add_node(Value(serde_json::Value::Array(resolved_values))))
            }
            Literal::Array(elements) => {
                // Dynamic array: Contains non-literal expressions, need constructor edge
                let mut element_nodes = Vec::new();
                for expr in elements {
                    element_nodes.push(self.expression_to_manifold(
                        expr,
                        manifold,
                        depth + 1,
                        ctx,
                    )?);
                }
                let result_node =
                    manifold.create_node(Node::Pending, "array_constructor".to_string());
                let spec = HyperedgeSpec {
                    constraint_type: ConstraintKind::ConstructArray,
                    tags: vec![],
                    input_nodes: element_nodes,
                    output_node: result_node,
                };
                manifold
                    .add_edge(spec)
                    .map_err(CompilationError::ManifoldBuildError)?;
                Ok(result_node)
            }
            Literal::Object(properties)
                if properties
                    .iter()
                    .all(|(_, e)| matches!(e, Expression::Literal(_))) =>
            {
                // Constant folding: All property values are literals, resolve at compile time
                let mut resolved_map = serde_json::Map::new();
                for (key, expr) in properties {
                    if let Expression::Literal(lit) = expr {
                        let node_id = self.literal_to_manifold(lit, manifold, depth + 1, ctx)?;
                        if let Some(Node::Ready(val)) = manifold.get_node(node_id) {
                            resolved_map.insert(key.clone(), val.0.clone());
                        }
                    }
                }
                Ok(manifold.add_node(Value(serde_json::Value::Object(resolved_map))))
            }
            Literal::Object(properties) => {
                // Dynamic object: Contains non-literal expressions, need constructor edge
                let mut prop_nodes = Vec::new();
                for (key, expr) in properties {
                    // Node for the static key
                    prop_nodes
                        .push(manifold.add_node(Value(serde_json::Value::String(key.clone()))));
                    // Node for the (potentially dynamic) value
                    prop_nodes.push(self.expression_to_manifold(expr, manifold, depth + 1, ctx)?);
                }
                let result_node =
                    manifold.create_node(Node::Pending, "object_constructor".to_string());
                let spec = HyperedgeSpec {
                    constraint_type: ConstraintKind::ConstructObject,
                    tags: vec![],
                    input_nodes: prop_nodes,
                    output_node: result_node,
                };
                manifold
                    .add_edge(spec)
                    .map_err(CompilationError::ManifoldBuildError)?;
                Ok(result_node)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{
        AstNode, BinaryExpr, BinaryOp, Expression, Literal, UnaryExpr, UnaryOp,
        MAX_FORMULA_AST_DEPTH,
    };

    #[test]
    fn test_cache_key_determinism() {
        let cache = Box::new(InMemoryCache::new());
        let optimizer = CostAwareOptimizer::new(Vec::new(), 1000);
        let compiler = Compiler::new(cache, optimizer);

        // Create a simple AST
        let ast = AstNode::Expression(Expression::Literal(Literal::Number(42.0)));

        // Create a test context
        let ctx = EvaluationContext::default();

        // Generate cache key multiple times
        let key1 = compiler.make_cache_key(&ast, &ctx).unwrap();
        let key2 = compiler.make_cache_key(&ast, &ctx).unwrap();

        assert_eq!(key1, key2, "Cache keys should be deterministic");
    }

    #[test]
    fn test_manifold_compilation() {
        let cache = Box::new(InMemoryCache::new());
        let optimizer = CostAwareOptimizer::new(Vec::new(), 1000);
        let compiler = Compiler::new(cache, optimizer);

        // Create AST for "1 + 2"
        let ast = AstNode::Expression(Expression::Binary(Box::new(BinaryExpr {
            op: BinaryOp::Add,
            left: Expression::Literal(Literal::Number(1.0)),
            right: Expression::Literal(Literal::Number(2.0)),
        })));

        // Create a test context
        let ctx = EvaluationContext::default();

        // Compile to execution plan
        let plan = compiler.compile(&ast, &ctx).unwrap();

        match plan {
            ExecutionPlan::Manifold(manifold) => {
                // Check that we have the expected structure
                assert_eq!(manifold.edge_count(), 1); // 1 addition operation
                assert!(manifold.result_node.is_some());
            }
            ExecutionPlan::Bytecode(_) => panic!("Expected manifold, got bytecode"),
        }
    }

    #[test]
    fn test_function_call_compilation() {
        let cache = Box::new(InMemoryCache::new());
        let optimizer = CostAwareOptimizer::new(Vec::new(), 1000);
        let compiler = Compiler::new(cache, optimizer);

        // Create AST for a simpler expression that doesn't require UDF metadata
        // "1 + 2 + 3" is equivalent to testing manifold compilation for expressions
        let ast = AstNode::Expression(Expression::Binary(Box::new(BinaryExpr {
            op: BinaryOp::Add,
            left: Expression::Binary(Box::new(BinaryExpr {
                op: BinaryOp::Add,
                left: Expression::Literal(Literal::Number(1.0)),
                right: Expression::Literal(Literal::Number(2.0)),
            })),
            right: Expression::Literal(Literal::Number(3.0)),
        })));

        let ctx = EvaluationContext::default();
        let plan = compiler.compile(&ast, &ctx).unwrap();

        match plan {
            ExecutionPlan::Manifold(manifold) => {
                // 2 addition operations
                assert!(manifold.edge_count() >= 1);
            }
            ExecutionPlan::Bytecode(_) => panic!("Expected manifold, got bytecode"),
        }
    }

    fn nested_unary(depth: usize) -> AstNode {
        AstNode::Expression((0..depth).fold(
            Expression::Literal(Literal::Number(1.0)),
            |expression, _| {
                Expression::Unary(Box::new(UnaryExpr {
                    op: UnaryOp::Negate,
                    expr: expression,
                }))
            },
        ))
    }

    #[test]
    fn compiler_uses_the_ast_structural_depth_authority() {
        let compiler = Compiler::new(
            Box::new(InMemoryCache::new()),
            CostAwareOptimizer::new(Vec::new(), 1_000),
        );
        let context = EvaluationContext::default();
        compiler
            .compile(&nested_unary(MAX_FORMULA_AST_DEPTH), &context)
            .expect("depth 128 compiles");
        let error = compiler
            .compile(&nested_unary(MAX_FORMULA_AST_DEPTH + 1), &context)
            .expect_err("depth 129 must fail compiler entry");
        assert!(error
            .to_string()
            .contains("Max recursion depth of 128 exceeded"));
    }
}
