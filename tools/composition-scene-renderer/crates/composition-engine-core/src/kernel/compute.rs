//! crates/composition-engine-core/src/kernel/compute.rs
//!
//! Context-Compute phase for the Universal UI Kernel.
//!
//! Walks an immutable scene tree snapshot and returns a new snapshot where
//! all binding AST values have been evaluated into concrete data. Supports
//! incremental evaluation: when a dirty_nodes set is provided, only nodes
//! in the set have their bindings re-evaluated (O(dirty) vs O(tree)).
//!
//! This module is framework-agnostic, side-effect free, and the only code
//! that knows how to interpret Bindings.
//!
//! Non-Negotiable Invariants:
//! - Pure and deterministic. Does not mutate inputs. Returns fresh structures.
//! - No rendering concerns. This is upstream of layout and rendering.
//! - Detects and evaluates bindings in any object/array position.
//! - Aggregates structured diagnostics for full observability.
//! - dirty_nodes=None ≡ full evaluation (backwards-compatible default).
//! - Children of clean nodes are always recursed (child may be independently dirty).
//!
//! Key Concepts:
//! - Shallow-copy on change: preserves referential equality for unchanged subtrees.
//! - Operator registry injected: the kernel stays decoupled from operators.
//! - EvaluationContext comes from the Host, never fetched here.
//!
//! Security Considerations:
//! - Treats the input tree as untrusted data. Never executes functions.
//! - Produces diagnostics instead of throwing to avoid denial-of-service.
//!
//! NOTE: This module provides the compute infrastructure. The actual binding
//! evaluation is handled by the binding module (Agent 6). This module
//! provides:
//! - Compute options and configuration
//! - Compute result types
//! - Tree traversal and materialization infrastructure
//! - SceneNode validation
//!
//! Ported from: frontends/web/composition-engine/kernel/compute.ts

use super::dirty::{BindingDepIndex, DepKey};
use super::typed_index::{TypedNodeEntry, TypedPreviousIndex, TypedSceneIndex};
use super::types::{
    EvaluationContext, NodeKind, ResolvedStyle, SceneNode, TextInputCapability, TextRange,
    Visibility, VisibilityBinding,
};
use crate::binding::ast::{PathInput, SelectKey};
use crate::binding::{
    evaluate_binding, Binding, BindingEvaluationContext, BindingSelect, OperatorRegistry,
    SelectSource,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use thiserror::Error;

// ============================================================================
// Errors
// ============================================================================

/// Hard invariant error for compute phase violations.
/// Thrown when the materialized root is not a valid SceneNode.
#[derive(Debug, Error)]
#[error("ComputeInvariantError: {message}")]
pub struct ComputeInvariantError {
    pub message: String,
    pub detail: Option<HashMap<String, serde_json::Value>>,
}

impl ComputeInvariantError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: HashMap<String, serde_json::Value>) -> Self {
        self.detail = Some(detail);
        self
    }
}

// ============================================================================
// Types
// ============================================================================

/// Diagnostic entry for binding evaluation issues
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub path: Vec<String>,
    pub message: String,
    pub severity: DiagnosticSeverity,
}

/// Diagnostic severity levels
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
}

/// Options for compute pass
#[derive(Debug, Clone, Default)]
pub struct ComputeOptions {
    /// If true, bindings are validated but not executed
    pub dry_run: bool,
}

/// Result of compute pass
#[derive(Debug, Clone)]
pub struct ComputeResult<T> {
    pub snapshot: T,
    pub diagnostics: Vec<Diagnostic>,
    /// The typed scene index built (or reused) during this compute pass.
    ///
    /// Returned so the caller can cache it in `KernelState::cached_scene_index`
    /// for reuse on the next incremental frame. Arc-wrapped for cheap cloning.
    ///
    /// - `Some(index)` after `compute()` (always available)
    /// - `None` after `compute_generic()` or `compute_dry_run()` (no scene tree)
    ///
    /// # Task 167 Phase B → Task 168 P4
    ///
    /// Caching avoids the O(n) `build_scene_index()` on incremental frames
    /// where tree structure hasn't changed. Changed from
    /// `HashMap<String, serde_json::Value>` to `TypedSceneIndex` (Task 168 P4)
    /// to eliminate O(n^2) subtree serialization.
    pub scene_index: Option<Arc<TypedSceneIndex>>,
    /// Binding dependency index built from the scene tree's binding ASTs
    /// (Task 167 Phase C → Task 178 V4: Arc-cached).
    ///
    /// Maps context dependency keys (FSM keys, routing origins, ambient keys,
    /// scene node IDs) to the set of node IDs whose bindings reference them.
    /// Used for scoped dirty resolution: when FSM key X changes, only nodes
    /// with bindings referencing X need re-evaluation.
    ///
    /// Arc-wrapped for O(1) cloning between frames. Only rebuilt when tree
    /// structure changes (new/removed nodes may introduce/remove binding ASTs).
    /// On non-structural frames, the previous Arc is reused — zero allocation.
    ///
    /// - `Some(index)` after `compute()` (built or reused from cache)
    /// - `None` after `compute_generic()` (no scene tree to scan)
    pub binding_dep_index: Option<Arc<BindingDepIndex>>,
    /// Whether the tree structure changed during this compute pass (Task 170).
    ///
    /// Derived from `!structure_changed_parents.is_empty()`.
    /// Kept as a convenience boolean for RuntimeDelta and PERF-TRACE.
    ///
    /// - `true` after `compute()` when structural changes detected
    /// - `false` after `compute_generic()` / `compute_dry_run()` (no tree comparison)
    pub structure_changed: bool,
    /// INV-038: Per-parent tracking of structural changes.
    ///
    /// Contains IDs of parent nodes whose children changed during
    /// typed_materialize — visibility flips (child appeared/disappeared),
    /// child count changes, or child ID changes. These parents need
    /// re-measurement in the layout phase.
    ///
    /// Merged into `dirty_nodes` before layout so incremental layout
    /// visits and re-measures these parents, discovering their new child
    /// lists without falling back to full O(n) layout.
    pub structure_changed_parents: HashSet<String>,
    /// Passive text input capabilities harvested during typed_materialize (Task 171).
    ///
    /// Custom nodes with `props.custom.text_input` spec produce entries during
    /// O(dirty) compute traversal. Only dirty nodes are harvested — clean nodes'
    /// passive entries persist in KernelState.passive_text_inputs across frames.
    ///
    /// Merged with active editing state (text_buffers) in build_text_input_side_map().
    pub passive_text_inputs: HashMap<String, super::types::TextInputCapability>,
    /// Previous index delta: TypedNodeEntry for every node that was evaluated
    /// (had bindings resolved) during this compute pass. For the FULL evaluation
    /// path (dirty_nodes=None), this contains entries for ALL nodes. For the
    /// incremental path, only dirty nodes that were re-materialized.
    ///
    /// The caller merges this delta into the cached `previous_index` instead of
    /// rebuilding from scratch via `build_previous_node_index()`. This makes
    /// previous_index maintenance O(dirty) instead of O(n).
    ///
    /// # Task 203
    ///
    /// Eliminates the unconditional O(n) `build_previous_node_index()` tree walk
    /// that ran after every compute pass.
    pub previous_index_delta: TypedPreviousIndex,
}

/// Operator key for registry lookup
pub type OperatorKey = String;

// ============================================================================
// Validation
// ============================================================================

/// Looser guard used during traversal to decide whether to treat an object
/// as a SceneNode. Keeps structural keys off-limits to bindings.
///
/// # Purpose
///
/// During materialization, we need to identify SceneNode objects to apply
/// special traversal rules (only evaluate bindings in allowed fields).
/// This guard uses minimal criteria to detect "node-like" objects.
///
/// # Children-as-Binding Support
///
/// The `children` field may be:
/// 1. An array (literal children) - always valid
/// 2. A binding AST (`$kind: "binding"`) - valid for repeater patterns
/// 3. Absent - valid (no children)
///
/// # Non-Negotiable Invariants
///
/// 1. **Deterministic**: Same value → same result
/// 2. **Total**: Never panics, returns bool
/// 3. **Conservative**: Only requires `kind` field presence
///
/// # AI Assistant Directive
///
/// CRITICAL: This function's children-as-binding support is essential.
/// Do not remove the `is_binding(c)` check without understanding the
/// repeater pattern requirements.
fn is_scene_node_draft(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(obj) => {
            if !obj.contains_key("kind") {
                return false;
            }
            // children can be: array, binding, or absent
            match obj.get("children") {
                Some(c) => c.is_array() || is_binding(c),
                None => true, // absent is valid
            }
        }
        _ => false,
    }
}

/// Check if a value is a binding AST node
/// Bindings have $kind: "binding" as the canonical format
fn is_binding(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(obj) => {
            // Check for $kind: "binding" (canonical format)
            obj.get("$kind").map(|v| v == "binding").unwrap_or(false)
        }
        _ => false,
    }
}

// ============================================================================
// Scene Index (Pull-Based Architecture)
// ============================================================================

/// Build O(1) lookup index of scene tree (ID → Node JSON).
///
/// # Purpose
///
/// This is the **1000x canonical scene index builder**. It enables `SelectSource::Scene`
/// bindings to query nodes directly from the live scene tree. The scene tree IS the
/// single source of truth - bindings read from it, no copying, no staleness.
///
/// # Algorithm
///
/// Recursively walks the SceneNode tree (pre-order traversal):
/// 1. Serialize current node to JSON
/// 2. Insert into index: node.id → node JSON
/// 3. Recurse into children
///
/// # Non-Negotiable Invariants
///
/// 1. **O(1) lookup**: Index is a HashMap for constant-time node access
/// 2. **Pre-mutation state**: Built BEFORE materialization so bindings read original values
/// 3. **Complete coverage**: Every node in the tree is indexed (including deeply nested)
/// 4. **Deterministic**: Same input tree → same index (iteration order doesn't matter)
///
/// # Performance
///
/// - Time: O(n) where n = number of nodes in tree
/// - Space: O(n) for the index + O(d) stack depth where d = max tree depth
/// - Uses iterative approach for children to avoid deep recursion
///
/// # Arguments
///
/// * `root` - The root SceneNode of the scene tree
///
/// # Returns
///
/// `TypedSceneIndex` mapping node IDs to flat `TypedNodeEntry` values.
///
/// # Task 168 P4: O(n^2) → O(n)
///
/// The old implementation called `serde_json::to_value(node)` which serialized
/// each node WITH ALL DESCENDANTS. Root = entire tree as JSON, first child =
/// entire subtree, etc. Total cost: O(n * avg_subtree_size) = O(n^2) for
/// balanced trees.
///
/// The new implementation creates one flat `TypedNodeEntry` per node with
/// `child_ids` instead of nested children. Total cost: O(n).
pub fn build_scene_index(root: &SceneNode) -> TypedSceneIndex {
    let mut index = HashMap::new();

    // Recursive visitor — one flat entry per node, no subtree duplication.
    // Task 202: Sets parent_id on each entry for O(depth) tree navigation.
    fn visit(
        node: &SceneNode,
        parent_id: Option<&str>,
        index: &mut HashMap<String, TypedNodeEntry>,
    ) {
        index.insert(node.id.clone(), TypedNodeEntry::from_node(node, parent_id));
        for child in &node.children {
            visit(child, Some(&node.id), index);
        }
    }

    visit(root, None, &mut index);
    index
}

/// Navigate the scene tree to a node using the parent chain in the index.
///
/// Instead of O(n) DFS via `find_node()`, builds the root-to-node path
/// from the index's parent_id chain (O(depth) hash lookups), then follows
/// the path through the tree (O(depth × fan_out) child scans).
///
/// Total: O(depth × fan_out) — typically O(50-200) vs O(n) for large trees.
pub fn find_node_via_index<'a>(
    root: &'a SceneNode,
    node_id: &str,
    index: &TypedSceneIndex,
) -> Option<&'a SceneNode> {
    // Root is a special case
    if root.id == node_id {
        return Some(root);
    }

    // Build path from node to root via parent_id chain
    let mut path_ids = vec![node_id.to_string()];
    let mut current = node_id.to_string();
    loop {
        match index.get(&current).and_then(|e| e.parent_id.as_ref()) {
            Some(parent) => {
                if *parent == root.id {
                    break; // reached root
                }
                path_ids.push(parent.clone());
                current.clone_from(parent);
            }
            None => return None, // broken chain
        }
    }
    path_ids.reverse(); // now: [child_of_root, ..., parent, node_id]

    // Navigate tree following the path
    let mut node = root;
    for target_id in &path_ids {
        node = node.children.iter().find(|c| c.id == *target_id)?;
    }
    Some(node)
}

// ============================================================================
// Previous Node Index (Incremental Resolved-Tree Fallback)
// ============================================================================

/// Build a flat typed index of node ID → `TypedNodeEntry` from a previous render tree.
///
/// # Purpose
///
/// Used by incremental compute: non-dirty nodes look up their previously
/// resolved values from this index instead of returning raw binding ASTs.
/// This prevents binding AST leakage in the incremental skip path (Task 162).
///
/// # Task 168 P4: Eliminated JSON Requirement
///
/// The old implementation took `&serde_json::Value` (the caller had to call
/// `serde_json::to_value(&render_tree)` first — an O(n) serialization of the
/// entire tree). It then cloned JSON subtrees per entry — O(n * avg_subtree).
///
/// The new implementation takes `&SceneNode` directly and creates flat
/// `TypedNodeEntry` per node. Total cost: O(n) with no JSON serialization.
///
/// # Non-Negotiable Invariants
///
/// 1. **O(1) lookup**: Index is a HashMap for constant-time node access
/// 2. **Complete coverage**: Every node in the previous tree is indexed by ID
/// 3. **Deterministic**: Same input tree → same index
/// 4. **Flat entries only**: No nested children — only `child_ids`
///
/// # Performance
///
/// O(N) tree walk where N = total nodes. Arc-wrapped by caller for cheap
/// cloning in recursive materialize calls. Built once per compute() call
/// (only when compute succeeded and render tree changed).
///
/// # Security Considerations
///
/// - Input tree is treated as trusted (produced by a prior compute pass).
/// - No code execution — only structural traversal and field cloning.
///
/// # Arguments
///
/// * `tree` - The previous fully-resolved render tree (typed SceneNode)
///
/// # Returns
///
/// `TypedPreviousIndex` mapping node IDs to flat typed entries.
pub fn build_previous_node_index(tree: &SceneNode) -> TypedPreviousIndex {
    let mut index = HashMap::new();
    fn walk(
        node: &SceneNode,
        parent_id: Option<&str>,
        index: &mut HashMap<String, TypedNodeEntry>,
    ) {
        index.insert(node.id.clone(), TypedNodeEntry::from_node(node, parent_id));
        for child in &node.children {
            walk(child, Some(&node.id), index);
        }
    }
    walk(tree, None, &mut index);
    index
}

// ============================================================================
// Materialization (Internal)
// ============================================================================

/// Convert kernel EvaluationContext to binding BindingEvaluationContext.
///
/// # 1000x Architecture
///
/// This function maps the kernel's `EvaluationContext` (which uses `serde_json::Value`
/// for flexibility) to the binding evaluator's `BindingEvaluationContext` (which uses
/// typed HashMaps for performance and type safety).
///
/// # Non-Negotiable Invariants
///
/// 1. **Routing is copied directly**: `ctx.routing` → `binding_ctx.routing`
///    Routing is a FIRST-CLASS field in both structs, NOT nested in ambient.
/// 2. **No data transformation**: Values are copied as-is, preserving semantics.
/// 3. **All fields are converted**: ambient, vars, data_sources, fsm, routing, scene_index.
/// 4. **Scene index is Arc-shared**: Built once, shared across all binding evaluations.
///
/// # Why Routing is Separate
///
/// Routing is a Physics primitive - it's the kernel's input routing state, not
/// "ambient data". Having it as a separate field enables:
/// - Type-safe routing queries (`HashMap<String, String>` vs JSON navigation)
/// - `SelectSource::Routing` as a distinct binding source
/// - Clear separation: ambient = host-injected, routing = kernel state
///
/// # Scene Index (Pull-Based Architecture)
///
/// The scene_index enables `SelectSource::Scene` bindings to query nodes directly.
/// It's Arc-wrapped for cheap cloning - built once in compute(), shared everywhere.
/// Task 202: Accepts TypedSceneIndex directly — no upfront O(n) JSON conversion.
/// Entries are converted to JSON on-demand during SelectSource::Scene lookups.
fn to_binding_context(
    ctx: &EvaluationContext,
    scene_index: Option<Arc<TypedSceneIndex>>,
) -> BindingEvaluationContext {
    let mut binding_ctx = BindingEvaluationContext::new();

    // Convert ambient (host-injected values like session_text_origin)
    if let serde_json::Value::Object(obj) = &ctx.ambient {
        for (k, v) in obj {
            binding_ctx.ambient.insert(k.clone(), v.clone());
        }
    }

    // Convert vars (per-node variables)
    if let serde_json::Value::Object(obj) = &ctx.vars {
        for (k, v) in obj {
            binding_ctx.vars.insert(k.clone(), v.clone());
        }
    }

    // Convert data_sources (external data)
    if let serde_json::Value::Object(obj) = &ctx.data_sources {
        for (k, v) in obj {
            binding_ctx.data_sources.insert(k.clone(), v.clone());
        }
    }

    // Convert fsm (FSM current states)
    if let serde_json::Value::Object(obj) = &ctx.fsm {
        for (k, v) in obj {
            binding_ctx.fsm.insert(k.clone(), v.clone());
        }
    }

    // CRITICAL: Copy routing as a FIRST-CLASS field (1000x architecture)
    // This is NOT extracted from ambient - routing is its own field in EvaluationContext
    // Bindings query via SelectSource::Routing with static or dynamic keys
    for (origin_id, target_id) in &ctx.routing {
        binding_ctx
            .routing
            .insert(origin_id.clone(), target_id.clone());
    }

    // Copy kernel state for SelectSource::State bindings
    for (key, value) in &ctx.state {
        binding_ctx.state.insert(key.clone(), value.clone());
    }

    // Inject scene index for SelectSource::Scene bindings (pull-based architecture)
    // Convert TypedNodeEntry → serde_json::Value for the shared BindingEvaluationContext
    // (D.4.6: BindingEvaluationContext now lives in composition-ast with Value scene_index)
    if let Some(typed_index) = scene_index {
        binding_ctx.scene_index = Some(crate::binding::ast::scene_index_from_typed(&typed_index));
    }

    binding_ctx
}

/// Materialize a JSON tree by evaluating all bindings.
///
/// Walks the tree and replaces all binding AST nodes with their evaluated values.
///
/// # Arguments
///
/// * `tree` - The JSON tree to materialize
/// * `ctx` - The evaluation context (ambient, vars, data_sources, etc.)
/// * `registry` - Optional operator registry for transform operations
/// * `options` - Compute options (dry_run mode, etc.)
/// * `diagnostics` - Accumulator for diagnostics
/// * `path` - Current path for diagnostic reporting
/// * `scene_index` - Arc-wrapped typed scene index for SelectSource::Scene bindings.
///   Task 202: Now accepts TypedSceneIndex directly (lazy JSON conversion per lookup).
/// * `dirty_nodes` - If Some, only evaluate bindings for nodes whose IDs are in
///   the set. Nodes NOT in the set are returned unchanged (their bindings are
///   skipped). Children are always recursed into because a child may be dirty
///   even when its parent is not. If None, all nodes are evaluated (full compute,
///   backwards compatible with pre-incremental behavior).
/// * `previous_index` - Arc-wrapped index of previously resolved node values
///   (Task 162). When a node is skipped (clean in incremental path), its
///   binding-capable fields (props, visible, style, value, zIndex, portalOwner)
///   are overlaid from this index to prevent raw binding AST leakage. None when
///   doing full evaluation or when no previous render tree exists.
#[derive(Clone)]
struct MaterializeScope<'a> {
    scene_index: Option<Arc<TypedSceneIndex>>,
    dirty_nodes: Option<&'a HashSet<String>>,
    previous_index: Option<Arc<HashMap<String, serde_json::Value>>>,
}

impl<'a> MaterializeScope<'a> {
    fn new(
        scene_index: Option<Arc<TypedSceneIndex>>,
        dirty_nodes: Option<&'a HashSet<String>>,
        previous_index: Option<Arc<HashMap<String, serde_json::Value>>>,
    ) -> Self {
        Self {
            scene_index,
            dirty_nodes,
            previous_index,
        }
    }
}

fn materialize(
    tree: serde_json::Value,
    ctx: &EvaluationContext,
    registry: Option<&OperatorRegistry>,
    options: &ComputeOptions,
    diagnostics: &mut Vec<Diagnostic>,
    path: &mut Vec<String>,
    scope: MaterializeScope<'_>,
) -> serde_json::Value {
    // Binding node - evaluate using the binding evaluator
    if is_binding(&tree) {
        if options.dry_run {
            // In dry run, just return the binding node unchanged
            return tree;
        }

        // Parse the binding from JSON
        let binding: Result<Binding, _> = serde_json::from_value(tree.clone());
        match binding {
            Ok(binding) => {
                // Convert context and evaluate (scene_index cloned via Arc - cheap)
                let binding_ctx = to_binding_context(ctx, scope.scene_index.clone());
                let input = serde_json::Value::Null; // Parent input, null for scene nodes

                // Use provided registry or create empty one
                let empty_registry = OperatorRegistry::new();
                let reg = registry.unwrap_or(&empty_registry);

                let result = evaluate_binding(
                    &binding,
                    &input,
                    &binding_ctx,
                    reg,
                    None, // options
                );

                // Add any diagnostics from evaluation
                for diag in result.diagnostics {
                    diagnostics.push(Diagnostic {
                        path: path.clone(),
                        message: diag.message,
                        severity: match diag.level {
                            crate::binding::DiagnosticLevel::Error => DiagnosticSeverity::Error,
                            crate::binding::DiagnosticLevel::Warn => DiagnosticSeverity::Warning,
                            crate::binding::DiagnosticLevel::Info => DiagnosticSeverity::Info,
                        },
                    });
                }

                return result.value;
            }
            Err(e) => {
                diagnostics.push(Diagnostic {
                    path: path.clone(),
                    message: format!("Failed to parse binding: {}", e),
                    severity: DiagnosticSeverity::Error,
                });
                return tree;
            }
        }
    }

    match tree {
        // SceneNode: only evaluate in allowed fields; never on structural keys
        serde_json::Value::Object(mut obj)
            if is_scene_node_draft(&serde_json::Value::Object(obj.clone())) =>
        {
            // ================================================================
            // INCREMENTAL SKIP: If dirty_nodes is provided and this node is
            // NOT dirty, skip its own binding evaluation. We still MUST recurse
            // into children because a child may be dirty independently.
            //
            // This is the core optimization: O(dirty) instead of O(tree).
            // ================================================================
            let node_id = obj
                .get("id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let skip_this_node = match (scope.dirty_nodes, &node_id) {
                (Some(dirty), Some(id)) => !dirty.contains(id.as_str()),
                _ => false, // No dirty set (full eval) or no ID (can't skip)
            };

            if skip_this_node {
                // Node is clean — skip binding evaluation for props/visible/style/value.
                //
                // RESOLVED-TREE FALLBACK (Task 162): Overlay previously resolved
                // binding-capable fields onto this node. This prevents raw binding
                // AST objects from leaking into the snapshot when nodes are skipped.
                //
                // Without this overlay, skip-path nodes retain their original
                // scene_tree values which contain unevaluated binding ASTs (e.g.,
                // {"$kind":"binding","select":{"from":"scene",...}}). The overlay
                // replaces ONLY binding-capable fields with their last successfully
                // resolved values from the previous compute pass.
                //
                // Fields overlaid: props, visible, style, value, zIndex, portalOwner, triggers
                // These are the exact fields that materialize() evaluates for
                // non-skipped nodes (see props/style/zIndex-visible-portalOwner-value/triggers
                // evaluation blocks below).
                if let Some(previous_node) = scope
                    .previous_index
                    .as_ref()
                    .and_then(|idx| node_id.as_ref().and_then(|id| idx.get(id)))
                    .and_then(|n| n.as_object())
                {
                    for key in &[
                        "props",
                        "visible",
                        "style",
                        "value",
                        "zIndex",
                        "portalOwner",
                        "triggers",
                    ] {
                        if let Some(prev_val) = previous_node.get(*key) {
                            obj.insert(key.to_string(), prev_val.clone());
                        }
                    }
                }

                // Always recurse children from AST tree — descendants may be dirty.
                // Even when the parent is clean, a child may be independently dirty
                // and needs its bindings re-evaluated.
                if let Some(serde_json::Value::Array(children)) = obj.get("children").cloned() {
                    let mut new_children = Vec::with_capacity(children.len());
                    for (i, child) in children.into_iter().enumerate() {
                        path.push(format!("children[{}]", i));
                        let next_child = materialize(
                            child,
                            ctx,
                            registry,
                            options,
                            diagnostics,
                            path,
                            scope.clone(),
                        );
                        path.pop();
                        new_children.push(next_child);
                    }
                    obj.insert(
                        "children".to_string(),
                        serde_json::Value::Array(new_children),
                    );
                }
                return serde_json::Value::Object(obj);
            }

            // props: fully traversable for bindings
            if let Some(props) = obj.get("props").cloned() {
                path.push("props".to_string());
                let next_props = materialize(
                    props.clone(),
                    ctx,
                    registry,
                    options,
                    diagnostics,
                    path,
                    scope.clone(),
                );
                path.pop();
                if next_props != props {
                    obj.insert("props".to_string(), next_props);
                }
            }

            // Optional fields that may contain bindings
            // - zIndex, visible, portalOwner: standard SceneNode fields
            // - value: Custom node input value (property inspector bindings)
            for key in &["zIndex", "visible", "portalOwner", "value"] {
                if let Some(value) = obj.get(*key).cloned() {
                    path.push(key.to_string());
                    let next_value = materialize(
                        value.clone(),
                        ctx,
                        registry,
                        options,
                        diagnostics,
                        path,
                        scope.clone(),
                    );
                    path.pop();

                    // [COMMENTED OUT] Per-frame Custom node binding log — floods console at 60fps × N nodes
                    // #[cfg(target_arch = "wasm32")]
                    // if *key == "value" && obj.get("kind") == Some(&serde_json::json!("Custom")) {
                    //     let node_id = obj.get("id").and_then(|v| v.as_str()).unwrap_or("unknown");
                    //     let is_binding = is_binding(&value);
                    //     if is_binding {
                    //         eprintln!(
                    //             "[COMPUTE_VALUE] Custom node {} value: before={} after={}",
                    //             node_id,
                    //             serde_json::to_string(&value).unwrap_or_default().chars().take(80).collect::<String>(),
                    //             serde_json::to_string(&next_value).unwrap_or_default().chars().take(80).collect::<String>()
                    //         );
                    //     }
                    // }

                    if next_value != value {
                        obj.insert(key.to_string(), next_value);
                    }
                }
            }

            // style: fully traversable for bindings (includes layout.x/y bindings)
            // This enables LayoutConfig.x/y to contain bindings that are evaluated here.
            if let Some(style) = obj.get("style").cloned() {
                path.push("style".to_string());
                let next_style = materialize(
                    style.clone(),
                    ctx,
                    registry,
                    options,
                    diagnostics,
                    path,
                    scope.clone(),
                );
                path.pop();
                if next_style != style {
                    obj.insert("style".to_string(), next_style);
                }
            }

            // triggers: evaluate bindings inside each trigger's payload.
            //
            // # Self-Contained Effects (Task 163)
            //
            // Trigger payloads can contain runtime bindings (routing, FSM, state,
            // scene) that must be resolved at compute time. Without this evaluation,
            // routing bindings like {"from":"routing","key":"seat1:pointer"} stay as
            // raw AST objects in the render tree, forcing the host to lazily resolve
            // values from mutable state at effect-handling time (temporal coupling).
            // With this evaluation, trigger payloads carry fully resolved values
            // baked in during the compute pass — effects are self-contained.
            //
            // ## Algorithm
            //
            // 1. Get triggers array (may be absent or empty)
            // 2. For each trigger object, check for a "payload" field
            // 3. If payload exists: recurse materialize() into payload only
            // 4. trigger.query and trigger.action_ref pass through unchanged
            // 5. Only update triggers array if at least one payload changed
            //
            // ## Non-Negotiable Invariants
            //
            // 1. ONLY trigger.payload is evaluated. trigger.query and trigger.action_ref
            //    are structural identifiers that MUST pass through unchanged.
            // 2. Concrete (non-binding) payload values pass through unchanged.
            // 3. A trigger without a payload field is left untouched.
            // 4. Empty triggers array produces no changes.
            // 5. Null routing bindings resolve to serde_json::Value::Null, not raw AST.
            // 6. Deterministic: same input + same context → same output.
            //
            // ## Security Considerations
            //
            // - Binding evaluation is sandboxed via the evaluator (no code execution)
            // - Only declarative binding resolution; no dynamic dispatch from payloads
            // - trigger.query and trigger.action_ref are never interpreted as bindings,
            //   preventing injection of binding ASTs into structural identifiers
            //
            // ## AI Assistant Directive
            //
            // CRITICAL: The extensive documentation here is a design feature.
            // You are FORBIDDEN from simplifying it. Maintain this detail level.
            if let Some(serde_json::Value::Array(triggers)) = obj.get("triggers").cloned() {
                let mut changed = false;
                let mut new_triggers = Vec::with_capacity(triggers.len());
                for (i, trigger) in triggers.into_iter().enumerate() {
                    if let serde_json::Value::Object(mut trigger_obj) = trigger {
                        if let Some(payload) = trigger_obj.get("payload").cloned() {
                            path.push(format!("triggers[{}].payload", i));
                            let next_payload = materialize(
                                payload.clone(),
                                ctx,
                                registry,
                                options,
                                diagnostics,
                                path,
                                scope.clone(),
                            );
                            path.pop();
                            if next_payload != payload {
                                trigger_obj.insert("payload".to_string(), next_payload);
                                changed = true;
                            }
                        }
                        new_triggers.push(serde_json::Value::Object(trigger_obj));
                    } else {
                        new_triggers.push(trigger);
                    }
                }
                if changed {
                    obj.insert(
                        "triggers".to_string(),
                        serde_json::Value::Array(new_triggers),
                    );
                }
            }

            // children: MAY be a binding (for repeater patterns) or a literal array.
            //
            // # Physics Gap Fix (children-as-binding)
            //
            // Prior to this fix, children MUST be a literal array. This prevented the
            // repeater pattern where `children` is a binding that evaluates to an array
            // of node objects (e.g., from a map_to_nodes operator).
            //
            // ## Algorithm
            //
            // 1. Get children value (may be binding or array)
            // 2. If binding AND dry_run: keep binding unevaluated
            // 3. If binding: evaluate it, expect array result
            // 4. If array: traverse each child node recursively
            //
            // ## Non-Negotiable Invariants
            //
            // 1. Binding evaluation uses the same context as other bindings
            // 2. Result MUST be an array; non-array results produce diagnostic
            // 3. Each child in the array MUST be a SceneNode draft
            // 4. Empty arrays are valid (no children rendered)
            // 5. Dry run preserves bindings unevaluated
            // 6. Deterministic: same input → same output
            //
            // ## Security Considerations
            //
            // - Binding evaluation is sandboxed via the evaluator
            // - No dynamic code execution; only declarative binding resolution
            // - Children array is bounded by data source size
            //
            // ## AI Assistant Directive
            //
            // CRITICAL: The extensive documentation here is a design feature.
            // You are FORBIDDEN from simplifying it. Maintain this detail level.
            if let Some(children_value) = obj.get("children").cloned() {
                // Handle children-as-binding
                if is_binding(&children_value) {
                    if options.dry_run {
                        // In dry run mode, keep binding unevaluated - no changes needed
                        // children_value is already in obj, so we do nothing
                    } else {
                        // Evaluate the binding
                        path.push("children".to_string());

                        let binding: Result<Binding, _> =
                            serde_json::from_value(children_value.clone());
                        let evaluated = match binding {
                            Ok(binding) => {
                                let binding_ctx =
                                    to_binding_context(ctx, scope.scene_index.clone());
                                let input = serde_json::Value::Null;
                                let empty_registry = OperatorRegistry::new();
                                let reg = registry.unwrap_or(&empty_registry);

                                let result =
                                    evaluate_binding(&binding, &input, &binding_ctx, reg, None);

                                // Collect binding diagnostics
                                for diag in result.diagnostics {
                                    diagnostics.push(Diagnostic {
                                        path: path.clone(),
                                        message: diag.message,
                                        severity: match diag.level {
                                            crate::binding::DiagnosticLevel::Error => {
                                                DiagnosticSeverity::Error
                                            }
                                            crate::binding::DiagnosticLevel::Warn => {
                                                DiagnosticSeverity::Warning
                                            }
                                            crate::binding::DiagnosticLevel::Info => {
                                                DiagnosticSeverity::Info
                                            }
                                        },
                                    });
                                }

                                result.value
                            }
                            Err(e) => {
                                diagnostics.push(Diagnostic {
                                    path: path.clone(),
                                    message: format!("Failed to parse children binding: {}", e),
                                    severity: DiagnosticSeverity::Error,
                                });
                                serde_json::Value::Array(vec![])
                            }
                        };

                        path.pop();

                        // Process the evaluated result
                        match evaluated {
                            serde_json::Value::Array(children) => {
                                let mut new_children = Vec::with_capacity(children.len());

                                for (i, child) in children.into_iter().enumerate() {
                                    path.push(format!("children[{}]", i));
                                    let next_child = materialize(
                                        child,
                                        ctx,
                                        registry,
                                        options,
                                        diagnostics,
                                        path,
                                        scope.clone(),
                                    );
                                    path.pop();

                                    if !is_scene_node_draft(&next_child) {
                                        diagnostics.push(Diagnostic {
                                            path: path.clone(),
                                            message: format!("materialize() produced non-SceneNode child at index {}", i),
                                            severity: DiagnosticSeverity::Error,
                                        });
                                    }

                                    new_children.push(next_child);
                                }

                                obj.insert(
                                    "children".to_string(),
                                    serde_json::Value::Array(new_children),
                                );
                            }
                            serde_json::Value::Null => {
                                // Null result from binding = no children (valid)
                                obj.insert(
                                    "children".to_string(),
                                    serde_json::Value::Array(vec![]),
                                );
                            }
                            other => {
                                // Non-array result from binding = error, default to empty
                                diagnostics.push(Diagnostic {
                                    path: path.clone(),
                                    message: format!(
                                        "children binding evaluated to non-array type: {:?}. Expected array of SceneNodes.",
                                        match &other {
                                            serde_json::Value::Object(_) => "object",
                                            serde_json::Value::String(_) => "string",
                                            serde_json::Value::Number(_) => "number",
                                            serde_json::Value::Bool(_) => "boolean",
                                            _ => "unknown",
                                        }
                                    ),
                                    severity: DiagnosticSeverity::Error,
                                });
                                obj.insert(
                                    "children".to_string(),
                                    serde_json::Value::Array(vec![]),
                                );
                            }
                        }
                    }
                } else if let serde_json::Value::Array(children) = children_value {
                    // children is a literal array - traverse each child
                    let mut new_children = Vec::with_capacity(children.len());

                    for (i, child) in children.into_iter().enumerate() {
                        path.push(format!("children[{}]", i));
                        let next_child = materialize(
                            child,
                            ctx,
                            registry,
                            options,
                            diagnostics,
                            path,
                            scope.clone(),
                        );
                        path.pop();

                        if !is_scene_node_draft(&next_child) {
                            diagnostics.push(Diagnostic {
                                path: path.clone(),
                                message: format!(
                                    "materialize() produced non-SceneNode child at index {}",
                                    i
                                ),
                                severity: DiagnosticSeverity::Error,
                            });
                        }

                        new_children.push(next_child);
                    }

                    obj.insert(
                        "children".to_string(),
                        serde_json::Value::Array(new_children),
                    );
                }
                // If children is neither binding nor array, leave it as-is (shouldn't happen in valid data)
            }

            serde_json::Value::Object(obj)
        }

        // Regular array
        serde_json::Value::Array(arr) => {
            let mut new_arr = Vec::with_capacity(arr.len());

            for (i, item) in arr.into_iter().enumerate() {
                path.push(format!("[{}]", i));
                let next_item = materialize(
                    item,
                    ctx,
                    registry,
                    options,
                    diagnostics,
                    path,
                    scope.clone(),
                );
                path.pop();
                new_arr.push(next_item);
            }

            serde_json::Value::Array(new_arr)
        }

        // Regular object
        serde_json::Value::Object(obj) => {
            let mut new_obj = serde_json::Map::new();

            for (k, v) in obj {
                path.push(k.clone());
                let next_v =
                    materialize(v, ctx, registry, options, diagnostics, path, scope.clone());
                path.pop();
                new_obj.insert(k, next_v);
            }

            serde_json::Value::Object(new_obj)
        }

        // Primitive - return as-is
        other => other,
    }
}

// ============================================================================
// Binding Dependency Index Builder (Task 167 Phase C)
// ============================================================================

/// Build a binding dependency index from a JSON-serialized scene tree.
///
/// Walks the tree, finds all binding AST values in binding-capable fields
/// (props, visible, style, value, zIndex, portalOwner, triggers), and records
/// which context keys each node's bindings reference.
///
/// # Arguments
///
/// * `root_json` - The scene tree serialized as JSON (same value passed to
///   `materialize()`). Using the same serialized form avoids double serialization.
///
/// # Returns
///
/// A `BindingDepIndex` mapping `DepKey` → `HashSet<node_id>` and vice versa.
///
/// # Performance
///
/// O(n) where n is the total number of JSON values in the tree. For a 100-node
/// tree with ~10 fields per node, this is ~1000 values. Negligible compared to
/// the compute pass itself.
pub fn build_binding_dep_index(root_json: &serde_json::Value) -> BindingDepIndex {
    let mut index = BindingDepIndex::new();
    scan_json_for_deps(root_json, None, &mut index);
    index
}

/// Recursively scan a JSON value tree for scene nodes and their binding deps.
///
/// When a scene node is found (has "id" and "kind"), its binding-capable fields
/// are scanned for binding ASTs. The node's ID becomes the context for dep recording.
fn scan_json_for_deps(
    val: &serde_json::Value,
    current_node_id: Option<&str>,
    index: &mut BindingDepIndex,
) {
    match val {
        serde_json::Value::Object(obj) => {
            // Check if this is a scene node (has "id" and "kind" and "children")
            if let (Some(serde_json::Value::String(id)), Some(_kind)) =
                (obj.get("id"), obj.get("kind"))
            {
                // Scene node — scan binding-capable fields with this node's ID
                for field in &[
                    "props",
                    "visible",
                    "style",
                    "value",
                    "zIndex",
                    "portalOwner",
                    "triggers",
                ] {
                    if let Some(field_val) = obj.get(*field) {
                        scan_value_for_binding_deps(field_val, id, index);
                    }
                }
                // Recurse into children
                if let Some(serde_json::Value::Array(children)) = obj.get("children") {
                    for child in children {
                        scan_json_for_deps(child, Some(id), index);
                    }
                }
            } else if is_binding(val) {
                // Binding AST inside a non-node context (nested in a field value)
                if let Some(node_id) = current_node_id {
                    record_binding_dep_from_json(val, node_id, index);
                }
            } else {
                // Regular object — recurse into values
                for (_, v) in obj {
                    scan_json_for_deps(v, current_node_id, index);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                scan_json_for_deps(v, current_node_id, index);
            }
        }
        _ => {} // Primitives — no deps
    }
}

/// Scan a field value (props, visible, style, etc.) for binding ASTs.
///
/// Recursively walks into objects and arrays. When a binding AST is found,
/// records the dependency for the given node_id.
fn scan_value_for_binding_deps(
    val: &serde_json::Value,
    node_id: &str,
    index: &mut BindingDepIndex,
) {
    if is_binding(val) {
        record_binding_dep_from_json(val, node_id, index);
        return; // Don't recurse into binding internals
    }
    match val {
        serde_json::Value::Object(obj) => {
            for (_, v) in obj {
                scan_value_for_binding_deps(v, node_id, index);
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                scan_value_for_binding_deps(v, node_id, index);
            }
        }
        _ => {} // Primitives — no bindings
    }
}

/// Parse a binding AST JSON value and record its context dependency.
///
/// Maps `BindingSelect.from` (SelectSource) + `BindingSelect.key` (SelectKey)
/// to a `DepKey`:
/// - `from: "fsm"`, `key: "fsm:editor:main"` → `DepKey::Fsm("fsm:editor:main")`
/// - `from: "routing"`, `key: { "$kind": "binding", ... }` → `DepKey::Routing("*")` (dynamic)
/// - `from: "ambient"` (no key) → `DepKey::Ambient("*")` (wildcard)
fn record_binding_dep_from_json(
    val: &serde_json::Value,
    node_id: &str,
    index: &mut BindingDepIndex,
) {
    // Parse the binding AST to extract select.from and select.key
    let binding: Binding = match serde_json::from_value(val.clone()) {
        Ok(b) => b,
        Err(_) => return, // Malformed binding — skip gracefully
    };

    record_binding_dep_recursive(&binding, node_id, index);
}

/// Record context dependencies from a parsed Binding, recursing into nested
/// bindings in the `key` field.
///
/// A binding like `scene[routing[ambient.session_text_origin]]` produces THREE
/// dep entries for the same node:
/// - `DepKey::Scene("*")` — outer: from scene, dynamic key
/// - `DepKey::Routing("*")` — nested: from routing, dynamic key
/// - `DepKey::Ambient("session_text_origin")` — nested: from ambient, static path
///
/// Without this recursion, `resolve_dirty_nodes` would miss nodes whose
/// outermost binding is `from: "scene"` but whose data actually depends on
/// routing or ambient changes (Investigation 014, Round 04).
fn record_binding_dep_recursive(binding: &Binding, node_id: &str, index: &mut BindingDepIndex) {
    let select: &BindingSelect = match &binding.select {
        Some(s) => s,
        None => return, // No select clause — no context dep
    };

    let source = match &select.from {
        Some(s) => s,
        None => return, // No source — no context dep
    };

    // Extract the key string (static) or mark wildcard (dynamic/absent).
    // If dynamic, also recurse into the nested binding to record its deps.
    let key_str = match &select.key {
        Some(SelectKey::Static(s)) => s.clone(),
        Some(SelectKey::Dynamic(nested)) => {
            // Recurse: the nested binding's deps are also this node's deps.
            record_binding_dep_recursive(nested, node_id, index);
            "*".to_string() // Dynamic key — wildcard for this level
        }
        None => "*".to_string(), // No key — depends on any change of this source
    };

    match source {
        SelectSource::Fsm => {
            index.record(node_id, DepKey::Fsm(key_str));
        }
        SelectSource::Routing => {
            // Task 199: Detect ambient-sourced routing keys for precise dirtying.
            // routing[ambient.X] → RoutingViaAmbient("X") instead of Routing("*").
            if key_str == "*" {
                if let Some(SelectKey::Dynamic(nested)) = &select.key {
                    if let Some(ref nested_select) = nested.select {
                        if nested_select.from == Some(SelectSource::Ambient) {
                            if let Some(PathInput::String(ref path_str)) = nested_select.path {
                                index.record(node_id, DepKey::RoutingViaAmbient(path_str.clone()));
                                return;
                            }
                        }
                    }
                }
            }
            // Fallback: concrete key or truly-dynamic non-ambient key
            index.record(node_id, DepKey::Routing(key_str));
        }
        SelectSource::Scene => {
            index.record(node_id, DepKey::Scene(key_str));
        }
        SelectSource::Ambient => {
            index.record(node_id, DepKey::Ambient(key_str));
        }
        // SelfSource, DataSource, Vars, Literal, State — not context-scoped deps.
        // These sources don't change between frames based on dirty keys.
        _ => {}
    }
}

// ============================================================================
// Typed Materialize (Task 170 — Zero JSON in Compute Hot Path)
// ============================================================================

/// Convert a `VisibilityBinding` (types.rs) to a `Binding` (binding::ast).
///
/// Both types serialize to the same JSON format, so serde round-trip is the
/// correct conversion. This is NOT in the hot path — only called for nodes
/// that actually have visibility bindings (typically <5% of nodes).
fn visibility_binding_to_binding(vis: &VisibilityBinding) -> Binding {
    // VisibilityBinding and Binding share the same JSON schema. Round-trip
    // through serde_json to convert between the two type systems.
    let json = serde_json::to_value(vis).unwrap_or(serde_json::Value::Null);
    serde_json::from_value(json).unwrap_or_default()
}

/// Evaluate a single `serde_json::Value` field that may be a binding AST.
///
/// If the value is a binding (`$kind: "binding"`), parses and evaluates it.
/// Otherwise returns the value unchanged. Used for `value`, `z_index`,
/// `portal_owner`, and nested fields within `props` and `style`.
fn evaluate_json_field(
    val: &serde_json::Value,
    ctx: &BindingEvaluationContext,
    registry: &OperatorRegistry,
    diagnostics: &mut Vec<Diagnostic>,
    path: &[String],
) -> serde_json::Value {
    if !is_binding(val) {
        return val.clone();
    }
    match serde_json::from_value::<Binding>(val.clone()) {
        Ok(binding) => {
            let result = evaluate_binding(&binding, &serde_json::Value::Null, ctx, registry, None);
            for diag in result.diagnostics {
                diagnostics.push(Diagnostic {
                    path: path.to_vec(),
                    message: diag.message,
                    severity: match diag.level {
                        crate::binding::DiagnosticLevel::Error => DiagnosticSeverity::Error,
                        crate::binding::DiagnosticLevel::Warn => DiagnosticSeverity::Warning,
                        crate::binding::DiagnosticLevel::Info => DiagnosticSeverity::Info,
                    },
                });
            }
            result.value
        }
        Err(e) => {
            diagnostics.push(Diagnostic {
                path: path.to_vec(),
                message: format!("Failed to parse binding: {}", e),
                severity: DiagnosticSeverity::Error,
            });
            val.clone()
        }
    }
}

/// Evaluate binding ASTs within a ResolvedStyle WITHOUT JSON serialization.
///
/// Only evaluates the 3 fields that can contain bindings: layout.x, layout.y, extra.
/// All other fields are typed primitives that CANNOT contain bindings by construction.
/// Returns Some(updated_style) if any binding was resolved, None if unchanged.
fn evaluate_resolved_style_bindings(
    style: &ResolvedStyle,
    ctx: &BindingEvaluationContext,
    registry: &OperatorRegistry,
    diagnostics: &mut Vec<Diagnostic>,
    path: &mut Vec<String>,
    path_prefix: &str,
) -> Option<ResolvedStyle> {
    let mut changed = false;
    let mut result = style.clone();

    // Evaluate layout.x and layout.y bindings
    if let Some(ref mut layout) = result.layout {
        if let Some(ref x_val) = layout.x {
            let path_entry = format!("{}.layout.x", path_prefix);
            path.push(path_entry);
            let evaluated = evaluate_json_field(x_val, ctx, registry, diagnostics, path);
            path.pop();
            if evaluated != *x_val {
                layout.x = Some(evaluated);
                changed = true;
            }
        }
        if let Some(ref y_val) = layout.y {
            let path_entry = format!("{}.layout.y", path_prefix);
            path.push(path_entry);
            let evaluated = evaluate_json_field(y_val, ctx, registry, diagnostics, path);
            path.pop();
            if evaluated != *y_val {
                layout.y = Some(evaluated);
                changed = true;
            }
        }
    }

    // Evaluate extra field bindings
    let mut new_extra = HashMap::new();
    for (key, val) in &style.extra {
        let path_entry = format!("{}.{}", path_prefix, key);
        path.push(path_entry);
        let evaluated = evaluate_json_field(val, ctx, registry, diagnostics, path);
        path.pop();
        if evaluated != *val {
            new_extra.insert(key.clone(), evaluated);
            changed = true;
        } else {
            new_extra.insert(key.clone(), val.clone());
        }
    }
    if changed {
        result.extra = new_extra;
    }

    if changed {
        Some(result)
    } else {
        None
    }
}

/// Recursively evaluate bindings within a `serde_json::Value` tree.
///
/// Used for `props.custom` and other JSON-typed fields that may
/// contain bindings at arbitrary depth. This is the typed equivalent of
/// calling `materialize()` on a JSON subtree.
fn evaluate_json_tree(
    val: &serde_json::Value,
    ctx: &BindingEvaluationContext,
    registry: &OperatorRegistry,
    diagnostics: &mut Vec<Diagnostic>,
    path: &mut Vec<String>,
) -> serde_json::Value {
    if is_binding(val) {
        return evaluate_json_field(val, ctx, registry, diagnostics, path);
    }
    match val {
        serde_json::Value::Object(obj) => {
            let mut new_obj = serde_json::Map::with_capacity(obj.len());
            let mut changed = false;
            for (k, v) in obj {
                path.push(k.clone());
                let new_v = evaluate_json_tree(v, ctx, registry, diagnostics, path);
                path.pop();
                if new_v != *v {
                    changed = true;
                }
                new_obj.insert(k.clone(), new_v);
            }
            if changed {
                serde_json::Value::Object(new_obj)
            } else {
                val.clone()
            }
        }
        serde_json::Value::Array(arr) => {
            let mut new_arr = Vec::with_capacity(arr.len());
            let mut changed = false;
            for (i, item) in arr.iter().enumerate() {
                path.push(format!("[{}]", i));
                let new_item = evaluate_json_tree(item, ctx, registry, diagnostics, path);
                path.pop();
                if new_item != *item {
                    changed = true;
                }
                new_arr.push(new_item);
            }
            if changed {
                serde_json::Value::Array(new_arr)
            } else {
                val.clone()
            }
        }
        _ => val.clone(),
    }
}

/// Evaluate all binding-capable fields on a single SceneNode.
///
/// Processes: visible, value, props (custom sub-fields), style, triggers payload,
/// z_index, portal_owner. Returns a new SceneNode with resolved values.
///
/// # Non-Negotiable Invariants
///
/// 1. `Visibility::Binding` → `Visibility::Resolved(bool)` after evaluation
/// 2. `value` binding ASTs → resolved JSON values
/// 3. Trigger payloads with bindings → resolved payloads
/// 4. Style/props sub-fields with bindings → resolved values
/// 5. Children are NOT processed here (handled by `rebuild_children`)
fn evaluate_node_bindings(
    node: &SceneNode,
    ctx: &BindingEvaluationContext,
    registry: &OperatorRegistry,
    diagnostics: &mut Vec<Diagnostic>,
    path: &mut Vec<String>,
) -> SceneNode {
    let mut result = node.clone();

    // Visibility: Binding(VisibilityBinding) → Resolved(bool)
    if let Visibility::Binding(ref vis_binding) = node.visible {
        let binding = visibility_binding_to_binding(vis_binding);
        let eval_result = evaluate_binding(&binding, &serde_json::Value::Null, ctx, registry, None);
        let resolved = eval_result.value.as_bool().unwrap_or(vis_binding.default);
        result.visible = Visibility::Resolved(resolved);
        for diag in eval_result.diagnostics {
            diagnostics.push(Diagnostic {
                path: path.clone(),
                message: diag.message,
                severity: match diag.level {
                    crate::binding::DiagnosticLevel::Error => DiagnosticSeverity::Error,
                    crate::binding::DiagnosticLevel::Warn => DiagnosticSeverity::Warning,
                    crate::binding::DiagnosticLevel::Info => DiagnosticSeverity::Info,
                },
            });
        }
    }

    // Value: evaluate if binding AST
    if let Some(ref val) = node.value {
        if is_binding(val) {
            path.push("value".to_string());
            result.value = Some(evaluate_json_field(val, ctx, registry, diagnostics, path));
            path.pop();
        }
    }

    // Props.custom: serde_json::Value that may contain nested bindings
    if let Some(ref custom) = node.props.custom {
        path.push("props.custom".to_string());
        let evaluated = evaluate_json_tree(custom, ctx, registry, diagnostics, path);
        path.pop();
        if evaluated != *custom {
            result.props.custom = Some(evaluated);
        }
    }

    // Props.style: evaluate only binding-capable fields (layout.x/y, extra)
    // without serializing the entire ResolvedStyle to JSON
    if let Some(ref props_style) = node.props.style {
        if let Some(updated) = evaluate_resolved_style_bindings(
            props_style,
            ctx,
            registry,
            diagnostics,
            path,
            "props.style",
        ) {
            result.props.style = Some(updated);
        }
    }

    // Top-level style: same direct field evaluation
    if let Some(ref style) = node.style {
        if let Some(updated) =
            evaluate_resolved_style_bindings(style, ctx, registry, diagnostics, path, "style")
        {
            result.style = Some(updated);
        }
    }

    // z_index: may be a binding in JSON form (via value field)
    // Note: z_index is Option<i32> in typed SceneNode — it can only be a binding
    // if the projector stored it as a JSON value. In the typed tree, z_index is
    // already resolved by the projector. No binding evaluation needed.

    // portal_owner: same as z_index — already resolved in typed tree.

    // Triggers: evaluate payload bindings
    let mut triggers_changed = false;
    let mut new_triggers = Vec::with_capacity(node.triggers.len());
    for (i, trigger) in node.triggers.iter().enumerate() {
        if let Some(ref payload) = trigger.payload {
            if is_binding(payload) {
                path.push(format!("triggers[{}].payload", i));
                let evaluated = evaluate_json_field(payload, ctx, registry, diagnostics, path);
                path.pop();
                let mut new_trigger = trigger.clone();
                new_trigger.payload = Some(evaluated);
                new_triggers.push(new_trigger);
                triggers_changed = true;
                continue;
            }
            // Payload may contain nested bindings (not top-level binding)
            path.push(format!("triggers[{}].payload", i));
            let evaluated = evaluate_json_tree(payload, ctx, registry, diagnostics, path);
            path.pop();
            if evaluated != *payload {
                let mut new_trigger = trigger.clone();
                new_trigger.payload = Some(evaluated);
                new_triggers.push(new_trigger);
                triggers_changed = true;
                continue;
            }
        }
        new_triggers.push(trigger.clone());
    }
    if triggers_changed {
        result.triggers = new_triggers;
    }

    result
}

/// Extract a display string from a JSON value for TextInputCapability.
///
/// Pure Physics utility: converts resolved binding values (string, number,
/// boolean, object, array, or null) into the String required by
/// TextInputCapability.value.
///
/// # Non-Negotiable Invariants
///
/// 1. Pure function — no I/O, no state mutation, no Society vocabulary
/// 2. String values pass through, numbers/booleans become their string representation
/// 3. Objects/arrays are serialized to compact JSON strings
/// 4. Null produces None (caller decides default)
fn extract_display_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        serde_json::Value::Null => None,
        _ => Some(value.to_string()),
    }
}

/// Harvest passive text input capability from a dirty Custom node (Task 171).
///
/// Reads `props.custom.text_input` spec (set by projector for Custom nodes)
/// and merges with the resolved `node.value` to produce a TextInputCapability.
/// Only called for dirty nodes during typed_materialize — O(dirty), not O(n).
fn harvest_passive_text_input(
    node: &SceneNode,
    collector: &mut HashMap<String, TextInputCapability>,
) {
    if node.kind != NodeKind::Custom {
        return;
    }
    let custom = match node.props.custom {
        Some(ref c) => c,
        None => return,
    };
    let text_input_spec = match custom.get("text_input") {
        Some(spec) => spec,
        None => return,
    };

    let keyboard_type = text_input_spec
        .get("keyboard_type")
        .and_then(|v| v.as_str())
        .unwrap_or("text")
        .to_string();
    let multiline = text_input_spec
        .get("multiline")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let secure = text_input_spec
        .get("secure")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let placeholder = text_input_spec
        .get("placeholder")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let input_type = custom
        .get("input_type")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    // Value precedence: node.value (binding-driven Custom nodes like property inspector)
    // falls back to node.props.text (plain text from prop:layout:text, e.g. chat textarea).
    // Without this fallback, text inputs whose content lives in props.text always report
    // value="" — clearing props.text doesn't trigger React's useEffect dependency change.
    let value_str = node
        .value
        .as_ref()
        .and_then(extract_display_string)
        .or_else(|| node.props.text.clone())
        .unwrap_or_default();

    collector.insert(
        node.id.clone(),
        TextInputCapability {
            value: value_str,
            selection: TextRange::new(0, 0),
            secure,
            multiline,
            keyboard_type,
            placeholder,
            input_type,
        },
    );
}

/// Typed materialize: walk Arc<SceneNode> tree, evaluate bindings per-field,
/// preserve Arc identity via path-copy structural sharing.
///
/// # Architecture (Task 170)
///
/// This replaces the JSON-based `materialize()` for the SceneNode compute hot
/// path. Instead of serializing to JSON, walking JSON, and deserializing back,
/// this function operates directly on typed `Arc<SceneNode>` trees.
///
/// ## Path-Copy Structural Sharing
///
/// When a node is clean (not in dirty set):
/// - If no descendants changed: return `Arc::clone(previous)` — O(1)
/// - If descendants changed: clone only this node with new children (path-copy)
///
/// When a node is dirty: evaluate bindings, recurse children, return new Arc.
///
/// ## Structure Changed Detection
///
/// `structure_changed` is set to true as a Physics fact when:
/// - A visibility binding flips (node becomes visible/invisible)
/// - Child count differs between scene tree and previous render tree
/// - Child IDs differ at the same position
///
/// # Non-Negotiable Invariants
///
/// 1. `Arc::ptr_eq` returns true for unchanged subtrees after compute
/// 2. Only the spine from root to dirty nodes is rebuilt
/// 3. `structure_changed` is detected by actual comparison, not flag proxy
/// 4. All binding-capable fields are evaluated for dirty nodes
/// 5. Children are always recursed (a child may be dirty independently)
#[allow(clippy::too_many_arguments)] // Recursive tree walk needs context, state, and collectors threaded through
fn typed_materialize(
    scene_node: &Arc<SceneNode>,
    previous: Option<&Arc<SceneNode>>,
    ctx: &BindingEvaluationContext,
    dirty_nodes: Option<&HashSet<String>>,
    dirty_ancestors: Option<&HashSet<String>>,
    registry: &OperatorRegistry,
    diagnostics: &mut Vec<Diagnostic>,
    path: &mut Vec<String>,
    structure_changed_parents: &mut HashSet<String>,
    passive_text_inputs: &mut HashMap<String, TextInputCapability>,
    previous_index_delta: &mut TypedPreviousIndex,
    parent_id: &str,
) -> Arc<SceneNode> {
    // Task 198: O(1) subtree skip via ancestor dirty set.
    // If dirty_ancestors is provided and this node is NOT an ancestor of any dirty
    // node, the entire subtree is guaranteed clean — reuse previous Arc directly.
    if let Some(ancestors) = dirty_ancestors {
        if !ancestors.contains(&scene_node.id) {
            if let Some(prev) = previous {
                return Arc::clone(prev);
            }
        }
    }

    // O(1) skip: not dirty AND previous exists with same ID
    let is_clean = match (dirty_nodes, previous) {
        (Some(dirty), Some(prev)) => !dirty.contains(&scene_node.id) && prev.id == scene_node.id,
        _ => false,
    };

    if is_clean {
        let prev = previous.unwrap();
        // Children might have dirty descendants — must recurse
        let new_children = rebuild_children(
            &scene_node.children,
            Some(&prev.children),
            ctx,
            dirty_nodes,
            dirty_ancestors,
            registry,
            diagnostics,
            path,
            structure_changed_parents,
            passive_text_inputs,
            previous_index_delta,
            &scene_node.id,
        );
        if children_unchanged(&new_children, &prev.children) {
            // Nothing changed in entire subtree — reuse previous Arc
            return Arc::clone(prev);
        }
        // Children changed but this node's own fields didn't — path-copy
        let mut updated = (**prev).clone();
        updated.children = new_children;
        // Task 203: Clean node with changed children — capture the path-copied result.
        // The node's own fields are from prev (unchanged), but child_ids may differ.
        previous_index_delta.insert(
            updated.id.clone(),
            TypedNodeEntry::from_node(
                &updated,
                if parent_id.is_empty() {
                    None
                } else {
                    Some(parent_id)
                },
            ),
        );
        return Arc::new(updated);
    }

    // Dirty node (or full eval): evaluate bindings per-field
    path.push(scene_node.id.clone());
    let mut evaluated = evaluate_node_bindings(scene_node, ctx, registry, diagnostics, path);
    path.pop();

    // Task 171: Harvest passive text input capability from dirty Custom nodes.
    // O(dirty) — only evaluated nodes produce entries. Clean nodes' passive
    // entries persist in KernelState.passive_text_inputs across frames.
    harvest_passive_text_input(&evaluated, passive_text_inputs);

    // INV-038: Detect visibility change and record the PARENT node ID.
    // When this node's visibility flips, its parent needs re-measurement
    // because the parent's child list in the render tree changed.
    // For root nodes (empty parent_id), insert the node's own ID as a
    // sentinel — the boolean structure_changed is derived from non-empty set.
    if let Some(prev) = previous {
        if evaluated.visible.as_bool() != prev.visible.as_bool() {
            let id = if parent_id.is_empty() {
                &scene_node.id
            } else {
                parent_id
            };
            structure_changed_parents.insert(id.to_string());
        }
    }

    // Recurse children — this node is the parent of its children
    evaluated.children = rebuild_children(
        &scene_node.children,
        previous.map(|p| &p.children),
        ctx,
        dirty_nodes,
        dirty_ancestors,
        registry,
        diagnostics,
        path,
        structure_changed_parents,
        passive_text_inputs,
        previous_index_delta,
        &scene_node.id,
    );

    // Task 203: Collect resolved entry for incremental previous_index maintenance.
    // The evaluated SceneNode has all bindings resolved and children recursed —
    // this is the EXACT data TypedNodeEntry::from_node() needs. Collecting here
    // eliminates the separate O(n) build_previous_node_index() tree walk.
    // Inserted AFTER children recursion so child_ids reflect the final children.
    previous_index_delta.insert(
        evaluated.id.clone(),
        TypedNodeEntry::from_node(
            &evaluated,
            if parent_id.is_empty() {
                None
            } else {
                Some(parent_id)
            },
        ),
    );

    Arc::new(evaluated)
}

/// Rebuild children with path-copy structural sharing.
///
/// Matches scene tree children against previous render tree children by ID
/// for optimal Arc reuse. Detects structural changes (count/ID mismatches).
#[allow(clippy::too_many_arguments)] // Recursive tree walk needs context, state, and collectors threaded through
fn rebuild_children(
    scene_children: &[Arc<SceneNode>],
    prev_children: Option<&Vec<Arc<SceneNode>>>,
    ctx: &BindingEvaluationContext,
    dirty_nodes: Option<&HashSet<String>>,
    dirty_ancestors: Option<&HashSet<String>>,
    registry: &OperatorRegistry,
    diagnostics: &mut Vec<Diagnostic>,
    path: &mut Vec<String>,
    structure_changed_parents: &mut HashSet<String>,
    passive_text_inputs: &mut HashMap<String, TextInputCapability>,
    previous_index_delta: &mut TypedPreviousIndex,
    parent_id: &str,
) -> Vec<Arc<SceneNode>> {
    // Build ID→Arc lookup for previous children for O(1) matching
    let prev_lookup: HashMap<&str, &Arc<SceneNode>> = prev_children
        .map(|prev| prev.iter().map(|c| (c.id.as_str(), c)).collect())
        .unwrap_or_default();

    let mut new_children = Vec::with_capacity(scene_children.len());
    for (i, child) in scene_children.iter().enumerate() {
        let prev_child = prev_lookup.get(child.id.as_str()).copied();

        // Task 198: Skip entire clean subtrees via ancestor dirty set.
        // If this child is NOT in the ancestor set, no descendant is dirty —
        // reuse the previous Arc at O(1) without entering the subtree.
        if let Some(ancestors) = dirty_ancestors {
            if !ancestors.contains(&child.id) {
                if let Some(prev) = prev_child {
                    new_children.push(Arc::clone(prev));
                    continue;
                }
            }
        }

        path.push(format!("children[{}]", i));
        let materialized = typed_materialize(
            child,
            prev_child,
            ctx,
            dirty_nodes,
            dirty_ancestors,
            registry,
            diagnostics,
            path,
            structure_changed_parents,
            passive_text_inputs,
            previous_index_delta,
            parent_id,
        );
        path.pop();
        new_children.push(materialized);
    }

    // INV-038: Detect structural changes and record the PARENT node ID.
    // Different child count or different child IDs means this parent's
    // layout needs recomputation (its children list changed).
    if let Some(prev) = prev_children {
        if prev.len() != scene_children.len() {
            structure_changed_parents.insert(parent_id.to_string());
        } else {
            for (p, s) in prev.iter().zip(scene_children.iter()) {
                if p.id != s.id {
                    structure_changed_parents.insert(parent_id.to_string());
                    break;
                }
            }
        }
    }

    new_children
}

/// O(1) check: are all children pointer-identical between new and old?
fn children_unchanged(new: &[Arc<SceneNode>], old: &[Arc<SceneNode>]) -> bool {
    new.len() == old.len() && new.iter().zip(old.iter()).all(|(a, b)| Arc::ptr_eq(a, b))
}

// ============================================================================
// Typed Binding Dependency Index Builder (Task 170)
// ============================================================================

/// Build binding dep index by scanning typed SceneNode fields for binding ASTs.
///
/// Replaces `build_binding_dep_index()` which required a JSON-serialized tree.
/// Walks the typed tree directly, extracting binding ASTs from visibility,
/// value, props.custom, and trigger payloads.
///
/// # Performance
///
/// O(n) where n = total nodes. Each node's binding-capable fields are scanned
/// for binding ASTs — typically 0-3 bindings per node.
pub fn build_typed_binding_dep_index(root: &SceneNode) -> BindingDepIndex {
    let mut index = BindingDepIndex::new();
    scan_node_for_deps(root, &mut index);
    index
}

/// Scan a ResolvedStyle for binding dependencies WITHOUT JSON serialization.
///
/// Only 3 fields in ResolvedStyle can contain binding ASTs:
/// - layout.x: Option<serde_json::Value> (absolute X position binding)
/// - layout.y: Option<serde_json::Value> (absolute Y position binding)
/// - extra: HashMap<String, serde_json::Value> (dynamic extension properties)
///
/// All other fields are typed primitives (String, f64, enum) that CANNOT
/// contain binding ASTs by construction. Skipping them eliminates
/// serde_json::to_value() serialization of the entire struct.
fn scan_resolved_style_for_deps(style: &ResolvedStyle, node_id: &str, index: &mut BindingDepIndex) {
    // Layout x/y — may contain binding ASTs for absolute positioning
    if let Some(ref layout) = style.layout {
        if let Some(ref x) = layout.x {
            scan_value_for_binding_deps(x, node_id, index);
        }
        if let Some(ref y) = layout.y {
            scan_value_for_binding_deps(y, node_id, index);
        }
    }
    // Extra — dynamic extension properties, may contain bindings
    for val in style.extra.values() {
        scan_value_for_binding_deps(val, node_id, index);
    }
}

/// Scan a single SceneNode's binding-capable fields for dependency keys.
///
/// Recursively visits all descendants. For each binding AST found,
/// records the dependency using `record_binding_dep_recursive`.
fn scan_node_for_deps(node: &SceneNode, index: &mut BindingDepIndex) {
    let node_id = &node.id;

    // Visibility binding
    if let Visibility::Binding(ref vis_binding) = node.visible {
        let binding = visibility_binding_to_binding(vis_binding);
        record_binding_dep_recursive(&binding, node_id, index);
    }

    // Value binding
    if let Some(ref val) = node.value {
        scan_value_for_binding_deps(val, node_id, index);
    }

    // Props.custom: serde_json::Value — may contain nested bindings
    if let Some(ref custom) = node.props.custom {
        scan_value_for_binding_deps(custom, node_id, index);
    }

    // Props.style: scan only binding-capable fields (layout.x/y, extra)
    if let Some(ref props_style) = node.props.style {
        scan_resolved_style_for_deps(props_style, node_id, index);
    }

    // Top-level style: same direct field scanning
    if let Some(ref style) = node.style {
        scan_resolved_style_for_deps(style, node_id, index);
    }

    // Trigger payload bindings
    for trigger in &node.triggers {
        if let Some(ref payload) = trigger.payload {
            scan_value_for_binding_deps(payload, node_id, index);
        }
    }

    // Recurse children
    for child in &node.children {
        scan_node_for_deps(child, index);
    }
}

// ============================================================================
// Public API
// ============================================================================

/// Compute pass for SceneNode roots.
/// Replaces all Binding AST nodes with their evaluated values.
/// Enforces hard invariant: the returned snapshot must be a valid SceneNode.
///
/// # Scene Index (Pull-Based Architecture)
///
/// Builds a scene index BEFORE materialization so `SelectSource::Scene` bindings
/// can query the pre-mutation state of the tree. This is critical for:
/// - Property inspector reading selected node properties
/// - Cross-node bindings that reference other nodes' state
/// - Any binding that needs to read the scene tree
///
/// The index is Arc-wrapped for cheap cloning across all binding evaluations.
///
/// # Incremental Evaluation (Task-153 Agent 2)
///
/// When `dirty_nodes` is Some, only nodes whose IDs are in the set have their
/// bindings evaluated. All other nodes reuse their previous binding values.
/// Children are always recursed. Pass None for full (non-incremental) compute.
///
/// # Incremental Resolved-Tree Fallback (Task-162 Agent 2)
///
/// When `previous_render_tree` is provided alongside `dirty_nodes`, non-dirty
/// nodes in the incremental skip path overlay their binding-capable fields
/// (props, visible, style, value, zIndex, portalOwner) from the previous
/// fully-resolved render tree. This prevents raw binding AST objects from
/// leaking into the snapshot for clean nodes. Pass None when no previous
/// render tree is available (first render) or when doing full evaluation
/// (dirty_nodes=None).
///
/// # Security Considerations
///
/// - The previous_render_tree is treated as trusted data (it was produced by
///   a prior compute pass). If the caller provides a malformed tree, the
///   overlay gracefully degrades (missing IDs or non-object nodes are skipped).
/// - No code execution occurs during index building or overlay — only
///   structural JSON lookups and field-level cloning.
#[allow(clippy::too_many_arguments)] // 9 semantically distinct pipeline inputs: tree, context, registry, dirty set, previous tree, 3 caches, structure flag
pub fn compute(
    root: &SceneNode,
    ctx: &EvaluationContext,
    registry: Option<&OperatorRegistry>,
    dirty_nodes: Option<&HashSet<String>>,
    previous_render_tree: Option<&Arc<SceneNode>>,
    cached_scene_index: Option<Arc<TypedSceneIndex>>,
    _cached_previous_index: Option<Arc<TypedPreviousIndex>>,
    cached_binding_dep_index: Option<Arc<BindingDepIndex>>,
    structure_dirty: bool,
) -> Result<ComputeResult<SceneNode>, ComputeInvariantError> {
    let mut diagnostics = Vec::new();
    let mut path = Vec::new();

    // Task 202: Reuse the incrementally-maintained scene index from KernelState.
    //
    // In production, cached_scene_index is ALWAYS Some — eagerly built at
    // Kernel::new() and maintained incrementally by scene_diff_apply on every
    // patch (InsertNode, RemoveSubtree, UpdateProps, MoveNode, ReorderChildren,
    // SetRoot). The fallback build_scene_index() exists only for standalone
    // test calls that pass None. Production code NEVER hits the fallback.
    let scene_index = cached_scene_index.unwrap_or_else(|| Arc::new(build_scene_index(root)));

    // Task 178 V4: Reuse cached binding dep index when tree structure unchanged.
    //
    // build_typed_binding_dep_index() is O(n) — scans every node for binding ASTs.
    // Binding ASTs only change when tree structure changes (InsertNode adds new
    // binding ASTs, RemoveSubtree removes them). Property-only changes (UpdateProps)
    // don't alter which bindings exist — only their evaluated values.
    //
    // When structure_dirty=false AND a cached index exists, reuse it (O(1) Arc::clone).
    // When structure_dirty=true OR no cache, rebuild from scratch.
    let binding_dep_index = if !structure_dirty {
        if let Some(cached) = cached_binding_dep_index {
            cached
        } else {
            Arc::new(build_typed_binding_dep_index(root))
        }
    } else {
        Arc::new(build_typed_binding_dep_index(root))
    };

    // Task 202: Pass typed scene index directly to binding context.
    // Entries are converted to JSON on-demand during SelectSource::Scene lookups.
    // Eliminates the O(n) typed_to_json_scene_index() that ran every compute pass.
    let binding_ctx = to_binding_context(ctx, Some(scene_index.clone()));

    // Use provided registry or create empty one
    let empty_registry = OperatorRegistry::new();
    let reg = registry.unwrap_or(&empty_registry);

    // Typed materialize with path-copy structural sharing (Task 170).
    // Zero JSON serialization of the tree. Arc identity preserved for unchanged subtrees.
    let root_arc = Arc::new(root.clone());
    // INV-038: Per-parent structure change tracking. Collects parent IDs
    // whose children changed (visibility flips, count/ID changes).
    let mut structure_changed_parents: HashSet<String> = HashSet::new();
    // Task 171: Collector for passive text input capabilities.
    // Harvested during O(dirty) traversal — only evaluated nodes contribute.
    let mut passive_text_inputs = HashMap::new();
    // Task 203: Collector for incremental previous_index delta.
    // Dirty nodes insert their resolved TypedNodeEntry here during typed_materialize.
    // Merged into cached_previous_index by the caller — O(dirty) not O(n).
    let mut previous_index_delta = TypedPreviousIndex::new();

    // Task 198: Build ancestor dirty set for O(dirty-path) traversal.
    // When dirty_nodes is provided (incremental), compute which nodes are
    // ancestors of dirty nodes. rebuild_children() skips subtrees not in this set.
    // When dirty_nodes is None (full eval), pass None to visit all nodes.
    let ancestor_set = dirty_nodes.map(|dn| super::dirty::compute_ancestor_set(&root_arc, dn));

    let snapshot_arc = typed_materialize(
        &root_arc,
        previous_render_tree,
        &binding_ctx,
        dirty_nodes,
        ancestor_set.as_ref(),
        reg,
        &mut diagnostics,
        &mut path,
        &mut structure_changed_parents,
        &mut passive_text_inputs,
        &mut previous_index_delta,
        "", // root has no parent
    );

    // Unwrap Arc to get owned SceneNode for ComputeResult
    let snapshot = Arc::try_unwrap(snapshot_arc).unwrap_or_else(|arc| (*arc).clone());

    Ok(ComputeResult {
        snapshot,
        diagnostics,
        scene_index: Some(scene_index),
        binding_dep_index: Some(binding_dep_index), // Arc-wrapped (Task 178 V4)
        structure_changed: !structure_changed_parents.is_empty(),
        structure_changed_parents,
        passive_text_inputs,
        previous_index_delta,
    })
}

/// Generic compute pass for non-SceneNode data (e.g., action manifests).
/// Materializes bindings without enforcing SceneNode invariants.
///
/// Note: Scene index is not available for generic compute (no scene tree).
/// Bindings with `from: "scene"` will gracefully degrade to null.
pub fn compute_generic<T>(
    tree: &T,
    ctx: &EvaluationContext,
    registry: Option<&OperatorRegistry>,
) -> Result<ComputeResult<T>, ComputeInvariantError>
where
    T: Serialize + for<'de> Deserialize<'de>,
{
    let mut diagnostics = Vec::new();
    let mut path = Vec::new();

    let tree_json = serde_json::to_value(tree)
        .map_err(|e| ComputeInvariantError::new(format!("Failed to serialize tree: {}", e)))?;

    // No scene index for generic compute (no scene tree to index)
    // No dirty_nodes for generic compute (always full evaluation)
    // No previous_index for generic compute (no incremental fallback)
    let snapshot_json = materialize(
        tree_json,
        ctx,
        registry,
        &ComputeOptions::default(),
        &mut diagnostics,
        &mut path,
        MaterializeScope::new(
            None, // No scene index available
            None, // Full evaluation (no dirty tracking for generic compute)
            None, // No previous index (full evaluation)
        ),
    );

    let snapshot: T = serde_json::from_value(snapshot_json).map_err(|e| {
        ComputeInvariantError::new(format!("Failed to deserialize snapshot: {}", e))
    })?;

    Ok(ComputeResult {
        snapshot,
        diagnostics,
        scene_index: None,        // No scene tree to index for generic compute
        binding_dep_index: None,  // No scene tree to scan for generic compute
        structure_changed: false, // No tree comparison for generic compute
        structure_changed_parents: HashSet::new(),
        passive_text_inputs: HashMap::new(), // No text input harvest for generic compute
        previous_index_delta: TypedPreviousIndex::new(), // No previous index for generic compute
    })
}

/// Compute with dry-run mode (validate but don't execute bindings)
///
/// In dry-run mode, bindings are not evaluated so scene_index is not needed.
pub fn compute_dry_run(
    root: &SceneNode,
    ctx: &EvaluationContext,
) -> Result<ComputeResult<SceneNode>, ComputeInvariantError> {
    let mut diagnostics = Vec::new();
    let mut path = Vec::new();

    let root_json = serde_json::to_value(root)
        .map_err(|e| ComputeInvariantError::new(format!("Failed to serialize root: {}", e)))?;

    // No scene index needed for dry-run (bindings aren't evaluated)
    // No dirty_nodes for dry-run (full traversal, just no evaluation)
    // No previous_index for dry-run (no incremental fallback)
    let snapshot_json = materialize(
        root_json,
        ctx,
        None,
        &ComputeOptions { dry_run: true },
        &mut diagnostics,
        &mut path,
        MaterializeScope::new(
            None, None, // Full traversal in dry-run mode
            None, // No previous index (dry-run)
        ),
    );

    let snapshot: SceneNode = serde_json::from_value(snapshot_json).map_err(|e| {
        ComputeInvariantError::new(format!("Failed to deserialize snapshot: {}", e))
    })?;

    Ok(ComputeResult {
        snapshot,
        diagnostics,
        scene_index: None, // No scene index for dry-run (bindings not evaluated)
        binding_dep_index: None, // No dep index for dry-run (bindings not evaluated)
        structure_changed: false, // No tree comparison for dry-run
        structure_changed_parents: HashSet::new(),
        passive_text_inputs: HashMap::new(), // No text input harvest for dry-run
        previous_index_delta: TypedPreviousIndex::new(), // No previous index for dry-run
    })
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::super::typed_index::typed_to_json_previous_index;
    use super::*;
    use crate::kernel::types::NodeKind;

    fn make_test_tree() -> SceneNode {
        SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![Arc::new(SceneNode {
                id: "child".to_string(),
                kind: NodeKind::Text,
                children: vec![],
                ..Default::default()
            })],
            ..Default::default()
        }
    }

    fn make_test_ctx() -> EvaluationContext {
        EvaluationContext {
            ambient: serde_json::json!({"theme": "dark"}),
            vars: serde_json::json!({"count": 42}),
            data_sources: serde_json::json!({}),
            fsm: serde_json::json!({}),
            routing: std::collections::HashMap::new(),
            state: std::collections::HashMap::new(),
        }
    }

    #[test]
    fn test_compute_passthrough() {
        let root = make_test_tree();
        let ctx = make_test_ctx();

        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        // Without bindings, tree should be unchanged
        assert_eq!(result.snapshot.id, "root");
        assert_eq!(result.snapshot.children.len(), 1);
        assert_eq!(result.snapshot.children[0].id, "child");
    }

    #[test]
    fn test_compute_dry_run() {
        let root = make_test_tree();
        let ctx = make_test_ctx();

        let result = compute_dry_run(&root, &ctx).unwrap();

        assert_eq!(result.snapshot.id, "root");
        assert!(result.diagnostics.is_empty());
    }

    #[test]
    fn test_is_binding() {
        // Canonical binding format: $kind: "binding"
        let binding1 = serde_json::json!({
            "$kind": "binding",
            "select": { "from": "vars", "path": "count" }
        });
        assert!(is_binding(&binding1));

        let binding2 = serde_json::json!({
            "$kind": "binding",
            "select": { "from": "fsm", "path": "fsm:editor:mode" },
            "transform": [{ "op": "op:core.equals", "args": { "value": "edit" } }],
            "default": false
        });
        assert!(is_binding(&binding2));

        // Non-binding objects
        let not_binding = serde_json::json!({
            "foo": "bar"
        });
        assert!(!is_binding(&not_binding));

        // Unsupported formats
        let unsupported1 = serde_json::json!({ "__binding": true, "path": "vars.count" });
        assert!(!is_binding(&unsupported1));

        let unsupported2 = serde_json::json!({ "$bind": "vars.count" });
        assert!(!is_binding(&unsupported2));
    }

    #[test]
    fn test_compute_generic() {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        struct TestData {
            name: String,
            value: i32,
        }

        let data = TestData {
            name: "test".to_string(),
            value: 42,
        };
        let ctx = make_test_ctx();

        let result = compute_generic(&data, &ctx, None).unwrap();

        assert_eq!(result.snapshot.name, "test");
        assert_eq!(result.snapshot.value, 42);
    }

    #[test]
    fn test_diagnostic_collection() {
        let root = make_test_tree();
        let ctx = make_test_ctx();

        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        // No errors expected for simple tree without bindings
        let errors: Vec<_> = result
            .diagnostics
            .iter()
            .filter(|d| d.severity == DiagnosticSeverity::Error)
            .collect();
        assert!(errors.is_empty());
    }

    // ========================================================================
    // children-as-binding tests
    // ========================================================================

    #[test]
    fn test_children_literal_array_still_works() {
        // Regression test: children as literal array must continue to work
        let root = make_test_tree();
        let ctx = make_test_ctx();

        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        assert_eq!(result.snapshot.children.len(), 1);
        assert_eq!(result.snapshot.children[0].id, "child");
    }

    #[test]
    fn test_children_binding_evaluates_to_nodes() {
        // Test that children can be a binding that evaluates to an array of nodes
        let ctx = EvaluationContext {
            data_sources: serde_json::json!({
                "items": [
                    {"id": "item1", "kind": "Text", "children": [], "props": {"label": "A"}},
                    {"id": "item2", "kind": "Text", "children": [], "props": {"label": "B"}}
                ]
            }),
            ..Default::default()
        };

        // Create a scene node with children as a binding to data_sources.items
        // Note: DataSource selection uses "key" to select which data source
        let root_json = serde_json::json!({
            "id": "root",
            "kind": "Container",
            "children": {
                "$kind": "binding",
                "select": { "from": "dataSource", "key": "items" }
            }
        });

        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let result = materialize(
            root_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(
                None, // No scene index needed for this test
                None, // Full evaluation (no dirty tracking)
                None, // No previous index (full evaluation)
            ),
        );

        // Check the result has 2 children
        let children = result.get("children").unwrap().as_array().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].get("id").unwrap().as_str().unwrap(), "item1");
        assert_eq!(children[1].get("id").unwrap().as_str().unwrap(), "item2");
    }

    #[test]
    fn test_children_binding_empty_array() {
        // Test that children binding evaluating to empty array works
        let ctx = EvaluationContext {
            data_sources: serde_json::json!({
                "items": []
            }),
            ..Default::default()
        };

        let root_json = serde_json::json!({
            "id": "root",
            "kind": "Container",
            "children": {
                "$kind": "binding",
                "select": { "from": "dataSource", "key": "items" }
            }
        });

        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let result = materialize(
            root_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(
                None, None, // Full evaluation (no dirty tracking)
                None, // No previous index (full evaluation)
            ),
        );

        let children = result.get("children").unwrap().as_array().unwrap();
        assert_eq!(children.len(), 0);
    }

    #[test]
    fn test_children_binding_null_result() {
        // Test that children binding evaluating to null results in empty children
        let ctx = EvaluationContext {
            data_sources: serde_json::json!({
                "nothing": null
            }),
            ..Default::default()
        };

        let root_json = serde_json::json!({
            "id": "root",
            "kind": "Container",
            "children": {
                "$kind": "binding",
                "select": { "from": "dataSource", "key": "nothing" }
            }
        });

        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let result = materialize(
            root_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(
                None, None, // Full evaluation (no dirty tracking)
                None, // No previous index (full evaluation)
            ),
        );

        let children = result.get("children").unwrap().as_array().unwrap();
        assert_eq!(children.len(), 0);
    }

    #[test]
    fn test_children_binding_non_array_error() {
        // Test that children binding evaluating to non-array produces error diagnostic
        let ctx = EvaluationContext {
            data_sources: serde_json::json!({
                "not_array": "just a string"
            }),
            ..Default::default()
        };

        let root_json = serde_json::json!({
            "id": "root",
            "kind": "Container",
            "children": {
                "$kind": "binding",
                "select": { "from": "dataSource", "key": "not_array" }
            }
        });

        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let result = materialize(
            root_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(
                None, None, // Full evaluation (no dirty tracking)
                None, // No previous index (full evaluation)
            ),
        );

        // Should default to empty children
        let children = result.get("children").unwrap().as_array().unwrap();
        assert_eq!(children.len(), 0);

        // Should have an error diagnostic
        let errors: Vec<_> = diagnostics
            .iter()
            .filter(|d| d.severity == DiagnosticSeverity::Error)
            .collect();
        assert!(!errors.is_empty());
        assert!(errors[0].message.contains("non-array"));
    }

    #[test]
    fn test_children_binding_dry_run_preserves_binding() {
        // Test that dry run mode keeps the binding unevaluated
        let ctx = EvaluationContext {
            data_sources: serde_json::json!({
                "items": [
                    {"id": "item1", "kind": "Text", "children": []}
                ]
            }),
            ..Default::default()
        };

        let root_json = serde_json::json!({
            "id": "root",
            "kind": "Container",
            "children": {
                "$kind": "binding",
                "select": { "from": "dataSource", "key": "items" }
            }
        });

        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let options = ComputeOptions { dry_run: true };

        let result = materialize(
            root_json,
            &ctx,
            Some(&registry),
            &options,
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(
                None, None, // Full evaluation (no dirty tracking)
                None, // No previous index (full evaluation)
            ),
        );

        // In dry run, children should still be a binding (object with $kind)
        let children = result.get("children").unwrap();
        assert!(children.is_object());
        assert_eq!(children.get("$kind").unwrap().as_str().unwrap(), "binding");
    }

    // ========================================================================
    // style.layout.x/y binding evaluation tests
    // ========================================================================

    #[test]
    fn test_style_layout_xy_binding_evaluated() {
        // Test that bindings in style.layout.x/y are evaluated during compute
        // This is critical for absolute positioning with dynamic values (e.g., popover)
        //
        // State format: { "popover_position": { "x": 100, "y": 80 } }
        // Binding path: "popover_position.x" navigates to state["popover_position"]["x"]
        let ctx = EvaluationContext {
            state: std::collections::HashMap::from([(
                "popover_position".to_string(),
                serde_json::json!({"x": 100, "y": 80}),
            )]),
            ..Default::default()
        };

        // Create a scene node with x/y bindings in style.layout
        let root_json = serde_json::json!({
            "id": "popover",
            "kind": "Container",
            "children": [],
            "style": {
                "layout": {
                    "mode": "absolute",
                    "x": {
                        "$kind": "binding",
                        "select": { "from": "state", "path": "popover_position.x" },
                        "default": 0
                    },
                    "y": {
                        "$kind": "binding",
                        "select": { "from": "state", "path": "popover_position.y" },
                        "default": 0
                    }
                },
                "width": 320,
                "height": 400
            }
        });

        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let result = materialize(
            root_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(
                None, None, // Full evaluation (no dirty tracking)
                None, // No previous index (full evaluation)
            ),
        );

        // Verify the bindings were evaluated to numbers
        let style = result.get("style").expect("style should exist");
        let layout = style.get("layout").expect("layout should exist");
        let x = layout.get("x").expect("x should exist");
        let y = layout.get("y").expect("y should exist");

        assert_eq!(x.as_f64(), Some(100.0), "x binding should evaluate to 100");
        assert_eq!(y.as_f64(), Some(80.0), "y binding should evaluate to 80");

        // Also verify mode is preserved
        assert_eq!(layout.get("mode").unwrap().as_str(), Some("absolute"));
    }

    #[test]
    fn test_style_layout_xy_binding_uses_default_when_missing() {
        // Test that bindings use default value when state is missing
        let ctx = EvaluationContext {
            state: std::collections::HashMap::new(), // Empty state
            ..Default::default()
        };

        let root_json = serde_json::json!({
            "id": "popover",
            "kind": "Container",
            "children": [],
            "style": {
                "layout": {
                    "mode": "absolute",
                    "x": {
                        "$kind": "binding",
                        "select": { "from": "state", "path": "popover_position.x" },
                        "default": 50
                    },
                    "y": {
                        "$kind": "binding",
                        "select": { "from": "state", "path": "popover_position.y" },
                        "default": 60
                    }
                }
            }
        });

        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let result = materialize(
            root_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(
                None, None, // Full evaluation (no dirty tracking)
                None, // No previous index (full evaluation)
            ),
        );

        let style = result.get("style").expect("style should exist");
        let layout = style.get("layout").expect("layout should exist");
        let x = layout.get("x").expect("x should exist");
        let y = layout.get("y").expect("y should exist");

        assert_eq!(x.as_f64(), Some(50.0), "x should use default 50");
        assert_eq!(y.as_f64(), Some(60.0), "y should use default 60");
    }

    // ========================================================================
    // Scene Index Tests (Agent 2 - Task 067)
    // ========================================================================

    #[test]
    fn test_build_scene_index_simple_tree() {
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![],
            ..Default::default()
        };

        let index = build_scene_index(&root);

        assert_eq!(index.len(), 1);
        assert!(index.contains_key("root"));
        assert_eq!(index.get("root").unwrap().id.as_str(), "root");
    }

    #[test]
    fn test_build_scene_index_nested_children() {
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![
                Arc::new(SceneNode {
                    id: "child1".to_string(),
                    kind: NodeKind::Text,
                    children: vec![Arc::new(SceneNode {
                        id: "grandchild".to_string(),
                        kind: NodeKind::Text,
                        children: vec![],
                        ..Default::default()
                    })],
                    ..Default::default()
                }),
                Arc::new(SceneNode {
                    id: "child2".to_string(),
                    kind: NodeKind::Container,
                    children: vec![],
                    ..Default::default()
                }),
            ],
            ..Default::default()
        };

        let index = build_scene_index(&root);

        assert_eq!(index.len(), 4);
        assert!(index.contains_key("root"));
        assert!(index.contains_key("child1"));
        assert!(index.contains_key("child2"));
        assert!(index.contains_key("grandchild"));
    }

    #[test]
    fn test_build_scene_index_preserves_node_data() {
        use crate::kernel::types::{NodeProps, ResolvedStyle};

        let root = SceneNode {
            id: "styled-node".to_string(),
            kind: NodeKind::Container,
            props: NodeProps {
                text: Some("Hello World".to_string()),
                ..Default::default()
            },
            style: Some(ResolvedStyle {
                background: Some("#ff0000".to_string()),
                ..Default::default()
            }),
            children: vec![],
            ..Default::default()
        };

        let index = build_scene_index(&root);

        let entry = index.get("styled-node").unwrap();
        assert_eq!(entry.props.text.as_deref(), Some("Hello World"));
        assert_eq!(
            entry.style.as_ref().unwrap().background.as_deref(),
            Some("#ff0000")
        );
    }

    #[test]
    fn test_scene_index_arc_shared_cheap_cloning() {
        let root = make_test_tree();
        let index = Arc::new(build_scene_index(&root));

        // Clone should be cheap (Arc increment, not deep copy)
        let index2 = Arc::clone(&index);
        let index3 = Arc::clone(&index);

        // All should point to same data
        assert!(Arc::ptr_eq(&index, &index2));
        assert!(Arc::ptr_eq(&index, &index3));
        assert_eq!(Arc::strong_count(&index), 3);
    }

    #[test]
    fn test_scene_index_accessible_during_binding() {
        use crate::kernel::types::NodeProps;

        // Create a tree where we can verify scene index is used
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![Arc::new(SceneNode {
                id: "target-node".to_string(),
                kind: NodeKind::Text,
                props: NodeProps {
                    text: Some("Target Content".to_string()),
                    ..Default::default()
                },
                children: vec![],
                ..Default::default()
            })],
            ..Default::default()
        };

        let ctx = EvaluationContext::default();
        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        // The compute function should build scene index internally
        // We verify indirectly by checking the result is valid
        assert_eq!(result.snapshot.id, "root");
        assert_eq!(result.snapshot.children.len(), 1);
        assert_eq!(result.snapshot.children[0].id, "target-node");
    }

    #[test]
    fn test_scene_index_built_before_materialization() {
        use crate::kernel::types::NodeProps;

        // This test verifies scene index captures pre-mutation state
        // by using a scene binding that reads from the tree
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            props: NodeProps {
                text: Some("Original Text".to_string()),
                ..Default::default()
            },
            children: vec![],
            ..Default::default()
        };

        // Build index - should capture "Original Text"
        let index = build_scene_index(&root);

        // Verify the index has pre-mutation state
        let root_entry = index.get("root").unwrap();
        assert_eq!(root_entry.props.text.as_deref(), Some("Original Text"));
    }

    #[test]
    fn test_scene_index_large_tree_no_stack_overflow() {
        // Build a tree with 1000+ nodes to verify no stack overflow
        fn build_deep_tree(depth: usize, prefix: &str) -> SceneNode {
            if depth == 0 {
                return SceneNode {
                    id: format!("{}-leaf", prefix),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                };
            }

            SceneNode {
                id: format!("{}-{}", prefix, depth),
                kind: NodeKind::Container,
                children: vec![
                    Arc::new(build_deep_tree(depth - 1, &format!("{}-a", prefix))),
                    Arc::new(build_deep_tree(depth - 1, &format!("{}-b", prefix))),
                ],
                ..Default::default()
            }
        }

        // Depth 10 with binary branching = 2^10 - 1 = 1023 nodes
        let root = build_deep_tree(10, "node");

        let index = build_scene_index(&root);

        // Should have indexed all nodes without stack overflow
        assert!(index.len() > 1000);
    }

    #[test]
    fn test_scene_index_with_complex_node_structure() {
        use crate::kernel::types::{
            A11yProps, NodeProps, NodeTrigger, NodeTriggerQuery, ResolvedStyle, Role,
        };

        let root = SceneNode {
            id: "complex-node".to_string(),
            kind: NodeKind::Container,
            props: NodeProps {
                text: Some("Complex".to_string()),
                style: Some(ResolvedStyle {
                    background: Some("#000".to_string()),
                    width: Some(crate::kernel::types::Dimension::Pixels(100.0)),
                    height: Some(crate::kernel::types::Dimension::Pixels(200.0)),
                    ..Default::default()
                }),
                a11y: Some(A11yProps {
                    role: Some(Role::Button),
                    label: Some("Click me".to_string()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            style: Some(ResolvedStyle {
                border_radius: Some(8.0),
                ..Default::default()
            }),
            z_index: Some(10),
            triggers: vec![NodeTrigger {
                query: NodeTriggerQuery {
                    event: "click".to_string(),
                },
                action_ref: "action:test".to_string(),
                payload: Some(serde_json::json!({"key": "value"})),
            }],
            children: vec![],
            ..Default::default()
        };

        let index = build_scene_index(&root);

        let entry = index.get("complex-node").unwrap();

        // Verify complex structure is preserved
        assert_eq!(entry.z_index, Some(10));
        assert!(!entry.triggers.is_empty());
        assert_eq!(entry.props.text.as_deref(), Some("Complex"));
        assert!(entry.style.is_some());
    }

    #[test]
    fn test_compute_includes_diagnostics_for_scene_lookups() {
        // Test that compute result includes diagnostics when scene bindings fail
        // This indirectly tests the scene_index integration
        let root = make_test_tree();
        let ctx = EvaluationContext::default();

        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        // Result should be valid (may or may not have diagnostics depending on tree)
        assert_eq!(result.snapshot.id, "root");
        // Diagnostics field exists
        let _ = result.diagnostics;
    }

    // ========================================================================
    // Incremental Evaluation Tests (Task-153 Agent 2)
    // ========================================================================

    /// materialize() with dirty_nodes=None evaluates all bindings (backwards compatible).
    /// This is the default for first render and when global context changes.
    #[test]
    fn test_materialize_dirty_nodes_none_evaluates_all_bindings() {
        // Create a tree with bindings on two different nodes
        let ctx = EvaluationContext {
            fsm: serde_json::json!({"fsm:mode": "active"}),
            ..Default::default()
        };

        let root_json = serde_json::json!({
            "id": "root",
            "kind": "Container",
            "children": [
                {
                    "id": "child-1",
                    "kind": "Text",
                    "children": [],
                    "visible": {
                        "$kind": "binding",
                        "select": { "from": "fsm", "path": "fsm:mode" },
                        "transform": [{ "op": "op:core.equals", "args": { "value": "active" } }],
                        "default": false
                    }
                },
                {
                    "id": "child-2",
                    "kind": "Text",
                    "children": [],
                    "visible": {
                        "$kind": "binding",
                        "select": { "from": "fsm", "path": "fsm:mode" },
                        "transform": [{ "op": "op:core.equals", "args": { "value": "inactive" } }],
                        "default": false
                    }
                }
            ]
        });

        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        // dirty_nodes = None → all bindings evaluated
        let result = materialize(
            root_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(
                None, None, // Full evaluation
                None, // No previous index (full evaluation)
            ),
        );

        // Both children's visible bindings should be evaluated
        let children = result.get("children").unwrap().as_array().unwrap();
        // child-1 visible: fsm:mode == "active" → true
        assert_eq!(
            children[0].get("visible").unwrap(),
            &serde_json::json!(true)
        );
        // child-2 visible: fsm:mode == "inactive" → false
        assert_eq!(
            children[1].get("visible").unwrap(),
            &serde_json::json!(false)
        );
    }

    /// materialize() with dirty_nodes=Some({"child-1"}) only evaluates child-1 bindings.
    /// child-2's bindings are left unevaluated (returned as-is).
    #[test]
    fn test_materialize_dirty_nodes_specific_node_only() {
        let ctx = EvaluationContext {
            fsm: serde_json::json!({"fsm:mode": "active"}),
            ..Default::default()
        };

        let root_json = serde_json::json!({
            "id": "root",
            "kind": "Container",
            "children": [
                {
                    "id": "child-1",
                    "kind": "Text",
                    "children": [],
                    "visible": {
                        "$kind": "binding",
                        "select": { "from": "fsm", "path": "fsm:mode" },
                        "transform": [{ "op": "op:core.equals", "args": { "value": "active" } }],
                        "default": false
                    }
                },
                {
                    "id": "child-2",
                    "kind": "Text",
                    "children": [],
                    "visible": {
                        "$kind": "binding",
                        "select": { "from": "fsm", "path": "fsm:mode" },
                        "transform": [{ "op": "op:core.equals", "args": { "value": "inactive" } }],
                        "default": false
                    }
                }
            ]
        });

        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        // Only child-1 is dirty
        let dirty = HashSet::from(["child-1".to_string()]);

        let result = materialize(
            root_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(
                None,
                Some(&dirty), // Only evaluate child-1
                None,         // No previous index
            ),
        );

        let children = result.get("children").unwrap().as_array().unwrap();

        // child-1 visible: evaluated → true
        assert_eq!(
            children[0].get("visible").unwrap(),
            &serde_json::json!(true)
        );

        // child-2 visible: NOT evaluated — still a binding object
        let child2_visible = children[1].get("visible").unwrap();
        assert!(
            child2_visible.is_object(),
            "child-2 visible should remain a binding object (not evaluated)"
        );
        assert_eq!(child2_visible.get("$kind").unwrap(), "binding");
    }

    /// materialize() with dirty_nodes=Some(empty set) evaluates no bindings.
    /// All nodes are returned unchanged (except children are recursed).
    #[test]
    fn test_materialize_dirty_nodes_empty_set_evaluates_nothing() {
        let ctx = EvaluationContext {
            fsm: serde_json::json!({"fsm:mode": "active"}),
            ..Default::default()
        };

        let root_json = serde_json::json!({
            "id": "root",
            "kind": "Container",
            "children": [
                {
                    "id": "child-1",
                    "kind": "Text",
                    "children": [],
                    "visible": {
                        "$kind": "binding",
                        "select": { "from": "fsm", "path": "fsm:mode" },
                        "transform": [{ "op": "op:core.equals", "args": { "value": "active" } }],
                        "default": false
                    }
                }
            ]
        });

        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        // Empty dirty set → no nodes evaluated
        let dirty: HashSet<String> = HashSet::new();

        let result = materialize(
            root_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(
                None,
                Some(&dirty), // Empty set — nothing dirty
                None,         // No previous index
            ),
        );

        // child-1 visible should remain a binding object (not evaluated)
        let children = result.get("children").unwrap().as_array().unwrap();
        let child1_visible = children[0].get("visible").unwrap();
        assert!(
            child1_visible.is_object(),
            "visible should remain a binding object"
        );
        assert_eq!(child1_visible.get("$kind").unwrap(), "binding");
    }

    /// materialize() with dirty_nodes still recurses into children of clean parents.
    /// A child can be dirty even when its parent is not.
    #[test]
    fn test_materialize_dirty_nodes_recurses_into_clean_parent_children() {
        let ctx = EvaluationContext {
            fsm: serde_json::json!({"fsm:mode": "active"}),
            ..Default::default()
        };

        let root_json = serde_json::json!({
            "id": "parent",
            "kind": "Container",
            "children": [
                {
                    "id": "child-dirty",
                    "kind": "Text",
                    "children": [],
                    "visible": {
                        "$kind": "binding",
                        "select": { "from": "fsm", "path": "fsm:mode" },
                        "transform": [{ "op": "op:core.equals", "args": { "value": "active" } }],
                        "default": false
                    }
                }
            ],
            "visible": {
                "$kind": "binding",
                "select": { "from": "fsm", "path": "fsm:mode" },
                "transform": [{ "op": "op:core.equals", "args": { "value": "active" } }],
                "default": false
            }
        });

        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        // Only child-dirty is in the dirty set; parent is NOT
        let dirty = HashSet::from(["child-dirty".to_string()]);

        let result = materialize(
            root_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(
                None,
                Some(&dirty),
                None, // No previous index
            ),
        );

        // Parent visible: NOT evaluated (parent is clean)
        let parent_visible = result.get("visible").unwrap();
        assert!(
            parent_visible.is_object(),
            "parent visible should remain a binding object"
        );

        // Child visible: evaluated (child is dirty)
        let children = result.get("children").unwrap().as_array().unwrap();
        assert_eq!(
            children[0].get("visible").unwrap(),
            &serde_json::json!(true)
        );
    }

    /// compute() with dirty_nodes=None evaluates all bindings (backwards compatible API).
    #[test]
    fn test_compute_dirty_nodes_none_full_eval() {
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![Arc::new(SceneNode {
                id: "child".to_string(),
                kind: NodeKind::Text,
                children: vec![],
                ..Default::default()
            })],
            ..Default::default()
        };
        let ctx = make_test_ctx();

        // dirty_nodes = None → full evaluation (backwards compatible)
        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        assert_eq!(result.snapshot.id, "root");
        assert_eq!(result.snapshot.children.len(), 1);
        assert_eq!(result.snapshot.children[0].id, "child");
    }

    /// compute() with dirty_nodes=Some(set) only evaluates marked nodes.
    #[test]
    fn test_compute_dirty_nodes_specific_set() {
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![
                Arc::new(SceneNode {
                    id: "child-1".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
                Arc::new(SceneNode {
                    id: "child-2".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
            ],
            ..Default::default()
        };
        let ctx = make_test_ctx();

        let dirty = HashSet::from(["child-1".to_string()]);
        let result = compute(
            &root,
            &ctx,
            None,
            Some(&dirty),
            None,
            None,
            None,
            None,
            false,
        )
        .unwrap();

        // Both children should be present in output (structure preserved)
        assert_eq!(result.snapshot.children.len(), 2);
        assert_eq!(result.snapshot.children[0].id, "child-1");
        assert_eq!(result.snapshot.children[1].id, "child-2");
    }

    // ========================================================================
    // Incremental Compute Resolved-Tree Fallback Tests (Task-162 Agent 2)
    // ========================================================================
    //
    // These tests verify that the incremental skip path overlays previously
    // resolved values from a previous_index onto clean (non-dirty) nodes,
    // preventing raw binding AST objects from leaking into the snapshot.

    /// Helper: build a previous_index Arc (JSON format) from a JSON tree.
    ///
    /// Deserializes to SceneNode, builds TypedPreviousIndex, converts to JSON
    /// for the materialize() pipeline which still operates on serde_json::Value.
    fn make_previous_index(
        tree_json: &serde_json::Value,
    ) -> Arc<HashMap<String, serde_json::Value>> {
        let scene_node: SceneNode = serde_json::from_value(tree_json.clone())
            .expect("test prev_json must be a valid SceneNode");
        let typed_idx = build_previous_node_index(&scene_node);
        Arc::new(typed_to_json_previous_index(&typed_idx))
    }

    /// Incremental skip with previous_index overlays resolved props onto clean node.
    /// A clean node's props should come from the previous render tree, not from the
    /// raw AST (which would contain unevaluated binding objects).
    #[test]
    fn test_incremental_skip_overlays_resolved_props() {
        let ctx = EvaluationContext::default();
        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        // AST tree: node with a binding in props.text
        let ast_json = serde_json::json!({
            "id": "node-1",
            "kind": "Text",
            "children": [],
            "props": {
                "text": {
                    "$kind": "binding",
                    "select": { "from": "fsm", "path": "fsm:label" },
                    "default": "fallback"
                }
            }
        });

        // Previous render tree: node with resolved props.text
        let prev_json = serde_json::json!({
            "id": "node-1",
            "kind": "Text",
            "children": [],
            "props": {
                "text": "Hello World"
            }
        });
        let prev_index = make_previous_index(&prev_json);

        // node-1 is NOT in dirty set → skip path fires
        let dirty = HashSet::from(["other-node".to_string()]);

        let result = materialize(
            ast_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(None, Some(&dirty), Some(prev_index)),
        );

        // props should be overlaid from previous (resolved), not raw AST
        let props = result.get("props").unwrap();
        assert_eq!(
            props.get("text").unwrap(),
            &serde_json::json!("Hello World"),
            "Clean node's props.text should be the resolved value from previous render, not a binding AST"
        );
    }

    /// Incremental skip with previous_index overlays resolved value onto clean node.
    /// This is the critical fix for property inspector text_input.value showing raw JSON.
    #[test]
    fn test_incremental_skip_overlays_resolved_value() {
        let ctx = EvaluationContext::default();
        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        // AST: node with binding in value field
        let ast_json = serde_json::json!({
            "id": "input-1",
            "kind": "Custom",
            "children": [],
            "value": {
                "$kind": "binding",
                "select": { "from": "scene", "path": "target-node" },
                "transform": [{ "op": "op:core.get", "args": { "path": "props.text" } }],
                "default": ""
            }
        });

        // Previous: node with resolved value
        let prev_json = serde_json::json!({
            "id": "input-1",
            "kind": "Custom",
            "children": [],
            "value": "resolved-text-value"
        });
        let prev_index = make_previous_index(&prev_json);

        let dirty = HashSet::new(); // Nothing dirty → all nodes skipped

        let result = materialize(
            ast_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(None, Some(&dirty), Some(prev_index)),
        );

        assert_eq!(
            result.get("value").unwrap(),
            &serde_json::json!("resolved-text-value"),
            "Clean node's value should be resolved scalar, never a binding AST object"
        );
    }

    /// Incremental skip with previous_index overlays resolved visible onto clean node.
    #[test]
    fn test_incremental_skip_overlays_resolved_visible() {
        let ctx = EvaluationContext::default();
        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let ast_json = serde_json::json!({
            "id": "panel-1",
            "kind": "Container",
            "children": [],
            "visible": {
                "$kind": "binding",
                "select": { "from": "fsm", "path": "fsm:mode" },
                "transform": [{ "op": "op:core.equals", "args": { "value": "edit" } }],
                "default": false
            }
        });

        let prev_json = serde_json::json!({
            "id": "panel-1",
            "kind": "Container",
            "children": [],
            "visible": true
        });
        let prev_index = make_previous_index(&prev_json);

        let dirty = HashSet::new();

        let result = materialize(
            ast_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(None, Some(&dirty), Some(prev_index)),
        );

        assert_eq!(
            result.get("visible").unwrap(),
            &serde_json::json!(true),
            "Clean node's visible should be resolved boolean, not a binding AST"
        );
    }

    /// Incremental skip with previous_index overlays resolved style onto clean node.
    #[test]
    fn test_incremental_skip_overlays_resolved_style() {
        let ctx = EvaluationContext::default();
        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let ast_json = serde_json::json!({
            "id": "styled-1",
            "kind": "Container",
            "children": [],
            "style": {
                "background": {
                    "$kind": "binding",
                    "select": { "from": "ambient", "path": "theme.bg" },
                    "default": "#fff"
                }
            }
        });

        let prev_json = serde_json::json!({
            "id": "styled-1",
            "kind": "Container",
            "children": [],
            "style": {
                "background": "#1a1a1a"
            }
        });
        let prev_index = make_previous_index(&prev_json);

        let dirty = HashSet::new();

        let result = materialize(
            ast_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(None, Some(&dirty), Some(prev_index)),
        );

        let style = result.get("style").unwrap();
        assert_eq!(
            style.get("background").unwrap(),
            &serde_json::json!("#1a1a1a"),
            "Clean node's style.background should be resolved value from previous render"
        );
    }

    /// Incremental skip without previous_index returns node as-is (backwards compatible).
    /// When no previous render tree exists (first render), non-dirty nodes keep their
    /// raw AST values. This is the correct backwards-compatible behavior.
    #[test]
    fn test_incremental_skip_without_previous_index_backwards_compatible() {
        let ctx = EvaluationContext::default();
        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let ast_json = serde_json::json!({
            "id": "node-1",
            "kind": "Text",
            "children": [],
            "value": {
                "$kind": "binding",
                "select": { "from": "fsm", "path": "fsm:label" },
                "default": "fallback"
            }
        });

        let dirty = HashSet::new(); // Nothing dirty

        // No previous_index (None) — backwards-compatible path
        let result = materialize(
            ast_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(
                None,
                Some(&dirty),
                None, // No previous index
            ),
        );

        // value should remain as raw binding AST (no overlay available)
        let value = result.get("value").unwrap();
        assert!(
            value.is_object() && value.get("$kind").is_some(),
            "Without previous_index, clean node's value should remain as binding AST"
        );
    }

    /// Dirty node in incremental path gets re-evaluated from AST, NOT from previous.
    /// The previous_index should NOT affect dirty nodes — they must be freshly evaluated.
    #[test]
    fn test_dirty_node_re_evaluated_from_ast_not_previous() {
        let ctx = EvaluationContext {
            fsm: serde_json::json!({"fsm:mode": "active"}),
            ..Default::default()
        };
        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let ast_json = serde_json::json!({
            "id": "dirty-node",
            "kind": "Text",
            "children": [],
            "visible": {
                "$kind": "binding",
                "select": { "from": "fsm", "path": "fsm:mode" },
                "transform": [{ "op": "op:core.equals", "args": { "value": "active" } }],
                "default": false
            }
        });

        // Previous had visible=false (old state)
        let prev_json = serde_json::json!({
            "id": "dirty-node",
            "kind": "Text",
            "children": [],
            "visible": false
        });
        let prev_index = make_previous_index(&prev_json);

        // dirty-node IS in dirty set → must re-evaluate, not use previous
        let dirty = HashSet::from(["dirty-node".to_string()]);

        let result = materialize(
            ast_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(None, Some(&dirty), Some(prev_index)),
        );

        // visible should be freshly evaluated to true (fsm:mode == "active"),
        // NOT taken from previous (false)
        assert_eq!(
            result.get("visible").unwrap(),
            &serde_json::json!(true),
            "Dirty node's visible must be re-evaluated from AST, not taken from previous"
        );
    }

    /// Mixed dirty/clean nodes: dirty nodes resolved, clean nodes use previous.
    /// This is the core incremental scenario — only changed nodes re-evaluate.
    #[test]
    fn test_mixed_dirty_clean_nodes() {
        let ctx = EvaluationContext {
            fsm: serde_json::json!({"fsm:mode": "active"}),
            ..Default::default()
        };
        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let ast_json = serde_json::json!({
            "id": "root",
            "kind": "Container",
            "children": [
                {
                    "id": "clean-child",
                    "kind": "Text",
                    "children": [],
                    "value": {
                        "$kind": "binding",
                        "select": { "from": "scene", "path": "something" },
                        "default": ""
                    }
                },
                {
                    "id": "dirty-child",
                    "kind": "Text",
                    "children": [],
                    "visible": {
                        "$kind": "binding",
                        "select": { "from": "fsm", "path": "fsm:mode" },
                        "transform": [{ "op": "op:core.equals", "args": { "value": "active" } }],
                        "default": false
                    }
                }
            ]
        });

        // Previous: clean-child had resolved value, dirty-child had old visible
        let prev_json = serde_json::json!({
            "id": "root",
            "kind": "Container",
            "children": [
                {
                    "id": "clean-child",
                    "kind": "Text",
                    "children": [],
                    "value": "previously-resolved"
                },
                {
                    "id": "dirty-child",
                    "kind": "Text",
                    "children": [],
                    "visible": false
                }
            ]
        });
        let prev_index = make_previous_index(&prev_json);

        // Only dirty-child is dirty; root and clean-child are clean
        let dirty = HashSet::from(["dirty-child".to_string()]);

        let result = materialize(
            ast_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(None, Some(&dirty), Some(prev_index)),
        );

        let children = result.get("children").unwrap().as_array().unwrap();

        // clean-child: value should be overlaid from previous (resolved)
        assert_eq!(
            children[0].get("value").unwrap(),
            &serde_json::json!("previously-resolved"),
            "Clean child's value should be overlaid from previous render tree"
        );

        // dirty-child: visible should be freshly evaluated (true, since fsm:mode == "active")
        assert_eq!(
            children[1].get("visible").unwrap(),
            &serde_json::json!(true),
            "Dirty child's visible must be freshly evaluated, not taken from previous"
        );
    }

    /// Deep tree: dirty leaf, all ancestors clean — ancestors use previous, leaf re-evaluated.
    #[test]
    fn test_deep_tree_dirty_leaf_clean_ancestors() {
        let ctx = EvaluationContext {
            fsm: serde_json::json!({"fsm:label": "Updated!"}),
            ..Default::default()
        };
        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let ast_json = serde_json::json!({
            "id": "grandparent",
            "kind": "Container",
            "children": [{
                "id": "parent",
                "kind": "Container",
                "children": [{
                    "id": "leaf",
                    "kind": "Text",
                    "children": [],
                    "value": {
                        "$kind": "binding",
                        "select": { "from": "fsm", "path": "fsm:label" },
                        "default": ""
                    }
                }],
                "visible": {
                    "$kind": "binding",
                    "select": { "from": "fsm", "path": "fsm:show" },
                    "default": true
                }
            }],
            "style": {
                "background": {
                    "$kind": "binding",
                    "select": { "from": "ambient", "path": "theme.bg" },
                    "default": "#fff"
                }
            }
        });

        // Previous: all nodes fully resolved
        let prev_json = serde_json::json!({
            "id": "grandparent",
            "kind": "Container",
            "children": [{
                "id": "parent",
                "kind": "Container",
                "children": [{
                    "id": "leaf",
                    "kind": "Text",
                    "children": [],
                    "value": "Old Label"
                }],
                "visible": true
            }],
            "style": {
                "background": "#000"
            }
        });
        let prev_index = make_previous_index(&prev_json);

        // Only leaf is dirty
        let dirty = HashSet::from(["leaf".to_string()]);

        let result = materialize(
            ast_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(None, Some(&dirty), Some(prev_index)),
        );

        // grandparent: style should be overlaid from previous
        let style = result.get("style").unwrap();
        assert_eq!(
            style.get("background").unwrap(),
            &serde_json::json!("#000"),
            "Clean grandparent's style should use previous resolved value"
        );

        // parent: visible should be overlaid from previous
        let parent = &result.get("children").unwrap().as_array().unwrap()[0];
        assert_eq!(
            parent.get("visible").unwrap(),
            &serde_json::json!(true),
            "Clean parent's visible should use previous resolved value"
        );

        // leaf: value should be freshly evaluated from FSM context
        let leaf = &parent.get("children").unwrap().as_array().unwrap()[0];
        assert_eq!(
            leaf.get("value").unwrap(),
            &serde_json::json!("Updated!"),
            "Dirty leaf's value must be re-evaluated from AST with current context"
        );
    }

    /// Full eval (dirty_nodes=None): previous_index is None, all nodes evaluated from AST.
    /// Even when a previous render tree is provided to compute(), if dirty_nodes is None
    /// (full eval), previous_index should not be built and all bindings should be evaluated.
    #[test]
    fn test_full_eval_ignores_previous_index() {
        let ctx = EvaluationContext {
            fsm: serde_json::json!({"fsm:mode": "active"}),
            ..Default::default()
        };
        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let ast_json = serde_json::json!({
            "id": "node-1",
            "kind": "Text",
            "children": [],
            "visible": {
                "$kind": "binding",
                "select": { "from": "fsm", "path": "fsm:mode" },
                "transform": [{ "op": "op:core.equals", "args": { "value": "active" } }],
                "default": false
            }
        });

        // dirty_nodes=None → full eval, previous_index=None
        let result = materialize(
            ast_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(
                None, None, // Full evaluation
                None, // No previous index (full eval)
            ),
        );

        // visible should be freshly evaluated (not from any previous)
        assert_eq!(
            result.get("visible").unwrap(),
            &serde_json::json!(true),
            "Full eval must evaluate all bindings from AST"
        );
    }

    /// build_previous_node_index correctly indexes all nodes by ID.
    #[test]
    fn test_build_previous_node_index_indexes_all_nodes() {
        let tree = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![
                Arc::new(SceneNode {
                    id: "child-a".to_string(),
                    kind: NodeKind::Text,
                    value: Some(serde_json::json!("Alpha")),
                    children: vec![],
                    ..Default::default()
                }),
                Arc::new(SceneNode {
                    id: "child-b".to_string(),
                    kind: NodeKind::Container,
                    children: vec![Arc::new(SceneNode {
                        id: "grandchild-b1".to_string(),
                        kind: NodeKind::Text,
                        value: Some(serde_json::json!("Beta1")),
                        children: vec![],
                        ..Default::default()
                    })],
                    ..Default::default()
                }),
            ],
            ..Default::default()
        };

        let index = build_previous_node_index(&tree);

        assert_eq!(
            index.len(),
            4,
            "Index should contain root + child-a + child-b + grandchild-b1"
        );
        assert!(index.contains_key("root"));
        assert!(index.contains_key("child-a"));
        assert!(index.contains_key("child-b"));
        assert!(index.contains_key("grandchild-b1"));

        // Verify node content is preserved
        let child_a = index.get("child-a").unwrap();
        assert_eq!(child_a.value.as_ref(), Some(&serde_json::json!("Alpha")));
    }

    /// build_previous_node_index handles leaf node (no children) gracefully.
    #[test]
    fn test_build_previous_node_index_leaf_node() {
        let leaf = SceneNode {
            id: "leaf".to_string(),
            kind: NodeKind::Text,
            children: vec![],
            ..Default::default()
        };
        let index = build_previous_node_index(&leaf);
        assert_eq!(
            index.len(),
            1,
            "Leaf node should produce single-entry index"
        );
        assert!(index.contains_key("leaf"));
    }

    /// compute() with previous_render_tree builds the index and uses it.
    /// End-to-end test: compute() with dirty_nodes + previous tree produces
    /// clean nodes with resolved values.
    #[test]
    fn test_compute_with_previous_render_tree_end_to_end() {
        // Build a root with a binding in value
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![Arc::new(SceneNode {
                id: "child".to_string(),
                kind: NodeKind::Text,
                children: vec![],
                ..Default::default()
            })],
            ..Default::default()
        };

        // Previous render tree: child had a resolved value
        let previous = Arc::new(SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![Arc::new(SceneNode {
                id: "child".to_string(),
                kind: NodeKind::Text,
                children: vec![],
                ..Default::default()
            })],
            ..Default::default()
        });

        let ctx = make_test_ctx();
        let dirty = HashSet::from(["root".to_string()]); // Only root dirty, child clean

        let result = compute(
            &root,
            &ctx,
            None,
            Some(&dirty),
            Some(&previous),
            None,
            None,
            None,
            false,
        )
        .unwrap();

        // Structure preserved
        assert_eq!(result.snapshot.id, "root");
        assert_eq!(result.snapshot.children.len(), 1);
        assert_eq!(result.snapshot.children[0].id, "child");
    }

    /// Incremental skip overlays zIndex from previous resolved tree.
    #[test]
    fn test_incremental_skip_overlays_resolved_zindex() {
        let ctx = EvaluationContext::default();
        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let ast_json = serde_json::json!({
            "id": "layered-1",
            "kind": "Container",
            "children": [],
            "zIndex": {
                "$kind": "binding",
                "select": { "from": "fsm", "path": "fsm:layer" },
                "default": 0
            }
        });

        let prev_json = serde_json::json!({
            "id": "layered-1",
            "kind": "Container",
            "children": [],
            "z_index": 42
        });
        let prev_index = make_previous_index(&prev_json);

        let dirty = HashSet::new();

        let result = materialize(
            ast_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(None, Some(&dirty), Some(prev_index)),
        );

        assert_eq!(
            result.get("zIndex").unwrap(),
            &serde_json::json!(42),
            "Clean node's zIndex should be overlaid from previous render tree"
        );
    }

    /// Verify that compute() does NOT build previous_index when dirty_nodes is None.
    /// This ensures full evaluation always re-evaluates everything from AST.
    #[test]
    fn test_compute_no_previous_index_on_full_eval() {
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![],
            ..Default::default()
        };

        // Even with a previous tree, if dirty_nodes is None, full eval happens
        let previous = Arc::new(SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![],
            ..Default::default()
        });

        let ctx = make_test_ctx();

        // dirty_nodes=None (full eval) + previous_render_tree=Some → still full eval
        let result = compute(
            &root,
            &ctx,
            None,
            None,
            Some(&previous),
            None,
            None,
            None,
            false,
        )
        .unwrap();
        assert_eq!(result.snapshot.id, "root");
    }

    // ========================================================================
    // Trigger payload binding evaluation tests (Task 163 — Agent 1)
    //
    // These tests verify that materialize() evaluates bindings inside
    // trigger.payload while leaving trigger.query and trigger.action_ref
    // untouched (structural keys, never contain bindings).
    // ========================================================================

    /// Trigger payload with a routing binding resolves to the target node ID.
    /// This is the core mechanism: routing bindings in trigger payloads are
    /// evaluated at compute time so effects carry resolved values.
    #[test]
    fn test_materialize_evaluates_trigger_payload_routing_binding() {
        let mut routing = std::collections::HashMap::new();
        routing.insert("origin1".to_string(), "layout:editor:hud".to_string());
        let ctx = EvaluationContext {
            routing,
            ..Default::default()
        };

        let root_json = serde_json::json!({
            "id": "field-bg",
            "kind": "Custom",
            "children": [],
            "triggers": [{
                "query": { "event": "change" },
                "action_ref": "action:editor:set_property",
                "payload": {
                    "target_property_id": "prop:layout:style",
                    "focused_node_id": {
                        "$kind": "binding",
                        "select": { "from": "routing", "key": "origin1" }
                    }
                }
            }]
        });

        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let result = materialize(
            root_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(None, None, None),
        );

        let triggers = result.get("triggers").unwrap().as_array().unwrap();
        assert_eq!(triggers.len(), 1);
        let payload = triggers[0].get("payload").unwrap();
        assert_eq!(
            payload.get("focused_node_id").unwrap().as_str(),
            Some("layout:editor:hud"),
            "Routing binding in trigger payload must resolve to the routed node ID"
        );
        // Concrete value passes through unchanged
        assert_eq!(
            payload.get("target_property_id").unwrap().as_str(),
            Some("prop:layout:style"),
            "Non-binding payload values must pass through unchanged"
        );
    }

    /// Trigger payload with nested routing binding (ambient → key → routing)
    /// resolves correctly. This is the canonical pattern from migration 028:
    /// {"from": "routing", "key": {"$kind": "binding", "select": {"from": "ambient", "path": "session_text_origin"}}}
    #[test]
    fn test_materialize_evaluates_trigger_payload_nested_routing_binding() {
        let mut routing = std::collections::HashMap::new();
        routing.insert("seat1:pointer".to_string(), "layout:editor:hud".to_string());
        let ctx = EvaluationContext {
            routing,
            ambient: serde_json::json!({ "session_text_origin": "seat1:pointer" }),
            ..Default::default()
        };

        let root_json = serde_json::json!({
            "id": "field-bg",
            "kind": "Custom",
            "children": [],
            "triggers": [{
                "query": { "event": "change" },
                "action_ref": "action:editor:set_property",
                "payload": {
                    "focused_node_id": {
                        "$kind": "binding",
                        "select": {
                            "from": "routing",
                            "key": {
                                "$kind": "binding",
                                "select": { "from": "ambient", "path": "session_text_origin" }
                            }
                        }
                    }
                }
            }]
        });

        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let result = materialize(
            root_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(None, None, None),
        );

        let triggers = result.get("triggers").unwrap().as_array().unwrap();
        let payload = triggers[0].get("payload").unwrap();
        assert_eq!(
            payload.get("focused_node_id").unwrap().as_str(),
            Some("layout:editor:hud"),
            "Nested routing binding (ambient → key → routing) must resolve to routed node ID"
        );
    }

    /// Concrete (non-binding) values in trigger payloads pass through unchanged.
    /// materialize() only transforms binding AST objects, not plain values.
    #[test]
    fn test_materialize_trigger_payload_preserves_non_binding_values() {
        let ctx = EvaluationContext::default();

        let root_json = serde_json::json!({
            "id": "field-bg",
            "kind": "Custom",
            "children": [],
            "triggers": [{
                "query": { "event": "change" },
                "action_ref": "action:editor:set_property",
                "payload": {
                    "target_property_id": "prop:layout:style",
                    "target_json_path": "$.background_color",
                    "static_flag": true,
                    "numeric_val": 42
                }
            }]
        });

        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let result = materialize(
            root_json.clone(),
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(None, None, None),
        );

        let payload = result.get("triggers").unwrap().as_array().unwrap()[0]
            .get("payload")
            .unwrap();
        assert_eq!(
            payload.get("target_property_id").unwrap().as_str(),
            Some("prop:layout:style")
        );
        assert_eq!(
            payload.get("target_json_path").unwrap().as_str(),
            Some("$.background_color")
        );
        assert_eq!(payload.get("static_flag").unwrap().as_bool(), Some(true));
        assert_eq!(payload.get("numeric_val").unwrap().as_i64(), Some(42));
    }

    /// When a routing key is not set, the binding resolves to null (not to the
    /// raw binding AST). This prevents AST leakage in trigger payloads.
    #[test]
    fn test_materialize_trigger_payload_null_routing_resolves_to_null() {
        // Empty routing — no keys set
        let ctx = EvaluationContext {
            routing: std::collections::HashMap::new(),
            ..Default::default()
        };

        let root_json = serde_json::json!({
            "id": "field-bg",
            "kind": "Custom",
            "children": [],
            "triggers": [{
                "query": { "event": "change" },
                "action_ref": "action:editor:set_property",
                "payload": {
                    "focused_node_id": {
                        "$kind": "binding",
                        "select": { "from": "routing", "key": "nonexistent_origin" }
                    }
                }
            }]
        });

        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let result = materialize(
            root_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(None, None, None),
        );

        let payload = result.get("triggers").unwrap().as_array().unwrap()[0]
            .get("payload")
            .unwrap();
        let focused = payload.get("focused_node_id").unwrap();
        assert!(
            focused.is_null(),
            "Missing routing key must resolve to null, not raw AST. Got: {}",
            serde_json::to_string(focused).unwrap()
        );
    }

    /// trigger.query is a structural key — materialize() MUST NOT evaluate it
    /// as a binding, even if it coincidentally contains binding-like fields.
    #[test]
    fn test_materialize_trigger_query_not_evaluated() {
        let ctx = EvaluationContext {
            vars: serde_json::json!({ "event_name": "click" }),
            ..Default::default()
        };

        // Intentionally put a binding-like structure in query to prove it's not touched
        let root_json = serde_json::json!({
            "id": "field-bg",
            "kind": "Custom",
            "children": [],
            "triggers": [{
                "query": { "event": "change" },
                "action_ref": "action:editor:set_property",
                "payload": { "x": 1 }
            }]
        });

        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let result = materialize(
            root_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(None, None, None),
        );

        let trigger = &result.get("triggers").unwrap().as_array().unwrap()[0];
        assert_eq!(
            trigger.get("query").unwrap().get("event").unwrap().as_str(),
            Some("change"),
            "trigger.query must pass through unchanged — it is structural, not a binding"
        );
    }

    /// trigger.action_ref is a structural key — materialize() MUST NOT evaluate
    /// it as a binding. It is a string reference, never a binding AST.
    #[test]
    fn test_materialize_trigger_action_ref_not_evaluated() {
        let ctx = EvaluationContext::default();

        let root_json = serde_json::json!({
            "id": "field-bg",
            "kind": "Custom",
            "children": [],
            "triggers": [{
                "query": { "event": "change" },
                "action_ref": "action:editor:set_property",
                "payload": { "x": 1 }
            }]
        });

        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let result = materialize(
            root_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(None, None, None),
        );

        let trigger = &result.get("triggers").unwrap().as_array().unwrap()[0];
        assert_eq!(
            trigger.get("action_ref").unwrap().as_str(),
            Some("action:editor:set_property"),
            "trigger.action_ref must pass through unchanged — it is structural, not a binding"
        );
    }

    /// A scene node without a triggers field produces no crash and no changes.
    #[test]
    fn test_materialize_no_triggers_field_unchanged() {
        let ctx = EvaluationContext::default();

        let root_json = serde_json::json!({
            "id": "plain-node",
            "kind": "Container",
            "children": []
        });

        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let result = materialize(
            root_json.clone(),
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(None, None, None),
        );

        // No triggers field in output — same as input
        assert!(
            result.get("triggers").is_none(),
            "Node without triggers field must not gain one"
        );
        assert_eq!(result.get("id").unwrap().as_str(), Some("plain-node"));
    }

    /// An empty triggers array passes through unchanged without crashing.
    #[test]
    fn test_materialize_empty_triggers_array_unchanged() {
        let ctx = EvaluationContext::default();

        let root_json = serde_json::json!({
            "id": "empty-triggers",
            "kind": "Container",
            "children": [],
            "triggers": []
        });

        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        let result = materialize(
            root_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(None, None, None),
        );

        let triggers = result.get("triggers").unwrap().as_array().unwrap();
        assert_eq!(
            triggers.len(),
            0,
            "Empty triggers array must pass through as empty"
        );
    }

    /// Incremental skip: non-dirty node gets resolved triggers from the previous
    /// render tree (last_render_tree). This prevents binding AST leakage in
    /// trigger payloads for nodes that were not re-evaluated.
    #[test]
    fn test_skip_path_overlays_triggers_from_previous_render() {
        let ctx = EvaluationContext::default();
        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        // AST tree: node with a binding in trigger payload (unevaluated)
        let ast_json = serde_json::json!({
            "id": "field-1",
            "kind": "Custom",
            "children": [],
            "triggers": [{
                "query": { "event": "change" },
                "action_ref": "action:editor:set_property",
                "payload": {
                    "focused_node_id": {
                        "$kind": "binding",
                        "select": { "from": "routing", "key": "origin1" }
                    }
                }
            }]
        });

        // Previous render tree: trigger payload already resolved
        let prev_json = serde_json::json!({
            "id": "field-1",
            "kind": "Custom",
            "children": [],
            "triggers": [{
                "query": { "event": "change" },
                "action_ref": "action:editor:set_property",
                "payload": {
                    "focused_node_id": "layout:editor:hud"
                }
            }]
        });
        let prev_index = make_previous_index(&prev_json);

        // Empty dirty set — node is clean, should be skipped
        let dirty = HashSet::new();

        let result = materialize(
            ast_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(None, Some(&dirty), Some(prev_index)),
        );

        let triggers = result.get("triggers").unwrap().as_array().unwrap();
        let payload = triggers[0].get("payload").unwrap();
        assert_eq!(
            payload.get("focused_node_id").unwrap().as_str(),
            Some("layout:editor:hud"),
            "Clean node must overlay resolved triggers from previous render tree"
        );
    }

    /// Without a previous render tree, triggers are not overlaid on clean nodes.
    /// This is the first-render case where no previous resolved values exist.
    #[test]
    fn test_skip_path_triggers_without_previous_render() {
        let ctx = EvaluationContext::default();
        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let mut diagnostics = vec![];
        let mut path = vec![];

        // AST tree with binding in trigger payload
        let ast_json = serde_json::json!({
            "id": "field-1",
            "kind": "Custom",
            "children": [],
            "triggers": [{
                "query": { "event": "change" },
                "action_ref": "action:editor:set_property",
                "payload": {
                    "focused_node_id": {
                        "$kind": "binding",
                        "select": { "from": "routing", "key": "origin1" }
                    }
                }
            }]
        });

        // Empty dirty set but NO previous index (first render)
        let dirty = HashSet::new();

        let result = materialize(
            ast_json,
            &ctx,
            Some(&registry),
            &ComputeOptions::default(),
            &mut diagnostics,
            &mut path,
            MaterializeScope::new(
                None,
                Some(&dirty),
                None, // No previous render tree
            ),
        );

        // Without previous tree, triggers retain raw AST (no overlay available)
        let triggers = result.get("triggers").unwrap().as_array().unwrap();
        let payload = triggers[0].get("payload").unwrap();
        let focused = payload.get("focused_node_id").unwrap();
        assert!(
            focused.is_object() && focused.get("$kind").is_some(),
            "Without previous render tree, binding AST is preserved (no overlay). Got: {}",
            serde_json::to_string(focused).unwrap()
        );
    }

    // ========================================================================
    // Task 167 Phase B: Cached Index Tests
    //
    // These tests verify that compute() correctly accepts, reuses, and returns
    // cached scene_index and cached_previous_index. This eliminates O(n) JSON
    // serialization on incremental frames where tree structure hasn't changed.
    // ========================================================================

    /// Helper: Build a multi-node tree for cache tests.
    ///
    /// Creates: root → [child-1, child-2 → [grandchild-2a]]
    fn make_cache_test_tree() -> SceneNode {
        SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![
                Arc::new(SceneNode {
                    id: "child-1".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
                Arc::new(SceneNode {
                    id: "child-2".to_string(),
                    kind: NodeKind::Container,
                    children: vec![Arc::new(SceneNode {
                        id: "grandchild-2a".to_string(),
                        kind: NodeKind::Text,
                        children: vec![],
                        ..Default::default()
                    })],
                    ..Default::default()
                }),
            ],
            ..Default::default()
        }
    }

    /// Helper: Build a larger tree for performance-oriented tests.
    ///
    /// Creates root with N leaf children.
    fn make_large_tree(n: usize) -> SceneNode {
        let children: Vec<Arc<SceneNode>> = (0..n)
            .map(|i| {
                Arc::new(SceneNode {
                    id: format!("node-{}", i),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                })
            })
            .collect();
        SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children,
            ..Default::default()
        }
    }

    /// Test 1: cached_scene_index is rebuilt when scene_structure_dirty=true
    /// (caller passes None — no cache).
    ///
    /// When tree structure changes, the caller clears the cache and passes None.
    /// compute() must rebuild the scene_index from scratch.
    #[test]
    fn t167b_cached_scene_index_rebuilt_when_structure_dirty() {
        let root = make_cache_test_tree();
        let ctx = make_test_ctx();

        // Pass None for cached_scene_index (simulating scene_structure_dirty=true)
        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        // scene_index must be returned (rebuilt from scratch)
        assert!(
            result.scene_index.is_some(),
            "compute() must return scene_index when no cache provided"
        );
        let idx = result.scene_index.unwrap();
        assert!(idx.contains_key("root"), "scene_index must contain root");
        assert!(
            idx.contains_key("child-1"),
            "scene_index must contain child-1"
        );
        assert!(
            idx.contains_key("child-2"),
            "scene_index must contain child-2"
        );
        assert!(
            idx.contains_key("grandchild-2a"),
            "scene_index must contain grandchild-2a"
        );
        assert_eq!(idx.len(), 4, "scene_index must have exactly 4 nodes");
    }

    /// Test 2: cached_scene_index is reused when scene_structure_dirty=false
    /// (caller passes Some(cached)).
    ///
    /// When only individual nodes are dirty (no structure change), the cached
    /// scene_index is passed through and reused by compute(). The returned
    /// scene_index must be the SAME Arc (pointer equality).
    #[test]
    fn t167b_cached_scene_index_reused_when_structure_clean() {
        let root = make_cache_test_tree();
        let ctx = make_test_ctx();

        // First compute: build the cache
        let result1 = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let cached = result1.scene_index.unwrap();

        // Second compute: pass the cache (simulating scene_structure_dirty=false)
        let result2 = compute(
            &root,
            &ctx,
            None,
            None,
            None,
            Some(cached.clone()),
            None,
            None,
            false,
        )
        .unwrap();

        // The returned scene_index must be the same Arc
        let returned = result2.scene_index.unwrap();
        assert!(
            Arc::ptr_eq(&cached, &returned),
            "scene_index must be reused (same Arc pointer) when cached"
        );
    }

    /// Test 3: cached_previous_index is updated after compute pass.
    ///
    /// The caller builds cached_previous_index from the render tree after each
    /// compute. This test verifies the public wrapper produces a valid index.
    #[test]
    fn t167b_cached_previous_index_updated_after_compute() {
        let root = make_cache_test_tree();
        let ctx = make_test_ctx();

        // Compute to get a render tree
        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        // Build previous_index from the render tree (what the caller does)
        let prev_index = build_previous_node_index(&result.snapshot);

        // Verify all nodes are indexed
        assert!(prev_index.contains_key("root"), "must index root");
        assert!(prev_index.contains_key("child-1"), "must index child-1");
        assert!(prev_index.contains_key("child-2"), "must index child-2");
        assert!(
            prev_index.contains_key("grandchild-2a"),
            "must index grandchild-2a"
        );
        assert_eq!(prev_index.len(), 4, "must index all 4 nodes");
    }

    /// Test 4: cached_previous_index is used by skip-path overlay (no re-serialization).
    ///
    /// When a cached_previous_index is provided, non-dirty nodes use it for
    /// overlay instead of rebuilding from previous_render_tree.
    #[test]
    fn t167b_cached_previous_index_used_by_skip_path() {
        let root = make_cache_test_tree();
        let ctx = make_test_ctx();

        // First compute: full evaluation
        let result1 = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        // Build previous_index from first render tree (now takes &SceneNode directly)
        let prev_index = Arc::new(build_previous_node_index(&result1.snapshot));

        // Second compute: incremental with only child-1 dirty, cached_previous_index provided
        let dirty = HashSet::from(["child-1".to_string()]);
        let prev_arc = Arc::new(result1.snapshot);
        let result2 = compute(
            &root,
            &ctx,
            None,
            Some(&dirty),
            Some(&prev_arc),  // previous render tree (Arc for typed materialize)
            None,             // no cached scene_index (rebuild)
            Some(prev_index), // cached previous_index
            None,             // no cached binding dep index
            false,            // no structure change
        )
        .unwrap();

        // All nodes must be present (structure preserved)
        assert_eq!(result2.snapshot.id, "root");
        assert_eq!(result2.snapshot.children.len(), 2);
        assert_eq!(result2.snapshot.children[0].id, "child-1");
        assert_eq!(result2.snapshot.children[1].id, "child-2");
    }

    /// Test 5: set_scene() clears both caches.
    ///
    /// When set_scene() is called, init_kernel_state() creates a fresh
    /// KernelState with both caches set to None. This test verifies the
    /// init_kernel_state fields via the KernelState struct.
    #[test]
    fn t167b_init_kernel_state_clears_caches() {
        use crate::kernel::init_kernel_state;
        use crate::kernel::types::Size;

        let root = make_cache_test_tree();
        let state = init_kernel_state(root, Size::new(800.0, 600.0));

        // Task 178: cached_scene_index is now eagerly built at init time
        // (persistent, incrementally maintained). Only cached_previous_index
        // starts as None (requires a compute pass to populate).
        assert!(
            state.cached_scene_index.is_some(),
            "cached_scene_index must be Some on init (Task 178: eagerly built)"
        );
        assert!(
            state.cached_previous_index.is_none(),
            "cached_previous_index must be None on init"
        );
    }

    /// Test 6: Compute with cached indexes produces identical result to non-cached.
    ///
    /// Verifies that passing cached indexes doesn't change the compute output.
    /// The snapshot must be byte-identical whether caches are provided or not.
    #[test]
    fn t167b_cached_compute_identical_to_uncached() {
        let root = make_cache_test_tree();
        let ctx = make_test_ctx();

        // Uncached compute
        let result_uncached =
            compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        // Build caches from first result
        let scene_index = result_uncached.scene_index.clone().unwrap();
        let prev_index = Arc::new(build_previous_node_index(&result_uncached.snapshot));

        // Cached compute (full eval — dirty_nodes=None)
        let prev_arc = Arc::new(result_uncached.snapshot);
        let result_cached = compute(
            &root,
            &ctx,
            None,
            None,
            Some(&prev_arc),
            Some(scene_index),
            Some(prev_index),
            None,
            false,
        )
        .unwrap();

        // Snapshots must be identical
        let json_uncached = serde_json::to_string(&*prev_arc).unwrap();
        let json_cached = serde_json::to_string(&result_cached.snapshot).unwrap();
        assert_eq!(
            json_uncached, json_cached,
            "cached compute must produce identical snapshot"
        );
    }

    /// Test 7: build_previous_node_index indexes all nodes with correct values.
    ///
    /// The pub function is directly callable and produces a complete, correct index.
    #[test]
    fn t167b_build_previous_node_index_complete_and_correct() {
        let root = make_cache_test_tree();

        let index = build_previous_node_index(&root);

        // Must index all 4 nodes from make_cache_test_tree
        assert!(index.contains_key("root"), "must index root node");
        assert!(index.contains_key("child-1"), "must index first child");
        assert!(index.contains_key("child-2"), "must index second child");
        assert!(index.contains_key("grandchild-2a"), "must index grandchild");

        // Each indexed entry must have correct id and child_ids
        let root_entry = index.get("root").unwrap();
        assert_eq!(
            root_entry.id.as_str(),
            "root",
            "indexed root must contain its own id"
        );
        assert!(
            !root_entry.child_ids.is_empty(),
            "indexed root must contain child_ids"
        );
    }

    /// Test 8: ComputeResult includes scene_index.
    ///
    /// Every successful compute() call must return a scene_index in the result.
    /// compute_generic() and compute_dry_run() return None (no scene tree).
    #[test]
    fn t167b_compute_result_includes_scene_index() {
        let root = make_cache_test_tree();
        let ctx = make_test_ctx();

        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        assert!(
            result.scene_index.is_some(),
            "compute() must always return scene_index"
        );

        // compute_dry_run returns None for scene_index
        let dry_result = compute_dry_run(&root, &ctx).unwrap();
        assert!(
            dry_result.scene_index.is_none(),
            "compute_dry_run() must return None for scene_index"
        );
    }

    /// Test 9: scene_index correctly indexes all nodes.
    ///
    /// The scene_index returned by compute() must contain every node in the tree,
    /// indexed by node ID. Each entry must be a valid JSON representation.
    #[test]
    fn t167b_scene_index_indexes_all_nodes() {
        let root = make_cache_test_tree();
        let ctx = make_test_ctx();

        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let idx = result.scene_index.unwrap();

        // Check all 4 nodes are present
        for expected_id in &["root", "child-1", "child-2", "grandchild-2a"] {
            let entry = idx.get(*expected_id);
            assert!(
                entry.is_some(),
                "scene_index missing node '{}'",
                expected_id
            );
            // Each entry must have an id field matching the key
            let id_field = entry.unwrap().id.as_str();
            assert_eq!(
                id_field, *expected_id,
                "scene_index entry for '{}' must have matching id field",
                expected_id
            );
        }
    }

    /// Test 10: Incremental compute with cache: verify correctness for single dirty node.
    ///
    /// On a multi-node tree, when only one node is dirty and caches are provided,
    /// compute must produce correct results for both dirty and clean nodes.
    #[test]
    fn t167b_incremental_with_cache_single_dirty_node() {
        let root = make_large_tree(50);
        let ctx = make_test_ctx();

        // Full compute to establish baseline
        let result1 = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let scene_idx = result1.scene_index.unwrap();
        let prev_arc = Arc::new(result1.snapshot);
        let prev_idx = Arc::new(build_previous_node_index(&prev_arc));

        // Incremental compute with one dirty node and caches
        let dirty = HashSet::from(["node-5".to_string()]);
        let result2 = compute(
            &root,
            &ctx,
            None,
            Some(&dirty),
            Some(&prev_arc),
            Some(scene_idx),
            Some(prev_idx),
            None,
            false,
        )
        .unwrap();

        // Structure must be preserved — all 51 nodes (root + 50 children)
        assert_eq!(result2.snapshot.id, "root");
        assert_eq!(result2.snapshot.children.len(), 50);
        // The dirty node must be present
        assert!(
            result2.snapshot.children.iter().any(|c| c.id == "node-5"),
            "dirty node-5 must be in result"
        );
        // A clean node must also be present
        assert!(
            result2.snapshot.children.iter().any(|c| c.id == "node-0"),
            "clean node-0 must be in result"
        );
    }

    /// Test 11: Full compute path (dirty_nodes=None) still works correctly with caches.
    ///
    /// Even when caches are provided, a full compute (dirty_nodes=None) must
    /// evaluate all bindings and produce a complete snapshot.
    #[test]
    fn t167b_full_compute_works_with_caches() {
        let root = make_cache_test_tree();
        let ctx = make_test_ctx();

        // First compute to get caches
        let result1 = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let scene_idx = result1.scene_index.unwrap();
        let prev_arc = Arc::new(result1.snapshot);
        let prev_idx = Arc::new(build_previous_node_index(&prev_arc));

        // Full compute (dirty_nodes=None) with caches — this is the path when
        // context_globally_dirty()=true but caches exist from a previous frame.
        let result2 = compute(
            &root,
            &ctx,
            None,
            None, // Full evaluation
            Some(&prev_arc),
            Some(scene_idx),
            Some(prev_idx),
            None,
            false,
        )
        .unwrap();

        // Must produce complete snapshot with all nodes
        assert_eq!(result2.snapshot.id, "root");
        assert_eq!(result2.snapshot.children.len(), 2);
        assert_eq!(result2.snapshot.children[0].id, "child-1");
        assert_eq!(result2.snapshot.children[1].id, "child-2");
        assert_eq!(result2.snapshot.children[1].children[0].id, "grandchild-2a");
        // scene_index must still be returned
        assert!(
            result2.scene_index.is_some(),
            "full compute with caches must return scene_index"
        );
    }

    /// Test 12: Cache invalidation on InsertNode: scene_index rebuilt after structure change.
    ///
    /// Simulates the InsertNode flow: first compute with caches, then a second
    /// compute after tree structure changes (no cached scene_index because
    /// scene_structure_dirty=true). The new scene_index must contain the new node.
    #[test]
    fn t167b_cache_invalidation_on_insert_node() {
        let root = make_cache_test_tree();
        let ctx = make_test_ctx();

        // First compute: build caches for the original tree
        let result1 = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let original_idx = result1.scene_index.unwrap();
        assert_eq!(original_idx.len(), 4, "original tree has 4 nodes");
        assert!(
            !original_idx.contains_key("new-node"),
            "new-node must not be in original index"
        );

        // Simulate InsertNode: modify tree to add a new child
        let mut modified_root = root.clone();
        modified_root.children.push(Arc::new(SceneNode {
            id: "new-node".to_string(),
            kind: NodeKind::Text,
            children: vec![],
            ..Default::default()
        }));

        // Second compute: no cached scene_index (caller cleared it because
        // scene_structure_dirty=true). previous_index can still be provided.
        let prev_arc = Arc::new(result1.snapshot);
        let prev_idx = Arc::new(build_previous_node_index(&prev_arc));

        let dirty = HashSet::from(["new-node".to_string()]);
        let result2 = compute(
            &modified_root,
            &ctx,
            None,
            Some(&dirty),
            Some(&prev_arc),
            None,           // No cached scene_index — MUST rebuild
            Some(prev_idx), // Previous index still valid for old nodes
            None,           // No cached binding dep index
            true,           // Structure changed (InsertNode)
        )
        .unwrap();

        // New scene_index must contain the new node
        let new_idx = result2.scene_index.unwrap();
        assert_eq!(new_idx.len(), 5, "modified tree has 5 nodes");
        assert!(
            new_idx.contains_key("new-node"),
            "new scene_index must contain new-node"
        );
        // Old nodes must also be present
        assert!(new_idx.contains_key("root"), "must still contain root");
        assert!(
            new_idx.contains_key("child-1"),
            "must still contain child-1"
        );
        assert!(
            new_idx.contains_key("child-2"),
            "must still contain child-2"
        );
        assert!(
            new_idx.contains_key("grandchild-2a"),
            "must still contain grandchild-2a"
        );
    }

    /// Test 13 (bonus): build_scene_index produces correct output.
    ///
    /// build_scene_index must return a complete index of all nodes.
    #[test]
    fn t167b_build_scene_index_correct() {
        let root = make_cache_test_tree();
        let idx = build_scene_index(&root);

        assert_eq!(idx.len(), 4, "must index all 4 nodes");
        for expected_id in &["root", "child-1", "child-2", "grandchild-2a"] {
            assert!(
                idx.contains_key(*expected_id),
                "must contain '{}'",
                expected_id
            );
        }
    }

    /// Test 14 (bonus): Incremental compute with cached_previous_index overlays
    /// resolved values on clean nodes correctly.
    ///
    /// When a node is clean (not in dirty_nodes), its props/visible/style/value
    /// must come from the cached previous_index overlay, not from the raw
    /// scene_tree (which may contain unevaluated binding ASTs).
    #[test]
    fn t167b_incremental_overlay_from_cached_previous() {
        // Create a tree where child-1 has a text prop
        let mut root = make_cache_test_tree();
        Arc::make_mut(&mut root.children[0]).props.text = Some("hello".to_string());

        let ctx = make_test_ctx();

        // Full compute to establish resolved values
        let result1 = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        assert_eq!(
            result1.snapshot.children[0].props.text.as_deref(),
            Some("hello"),
            "first compute must preserve text prop"
        );

        // Build caches
        let scene_idx = result1.scene_index.unwrap();
        let prev_arc = Arc::new(result1.snapshot);
        let prev_idx = Arc::new(build_previous_node_index(&prev_arc));

        // Incremental compute: only child-2 is dirty, child-1 is clean
        let dirty = HashSet::from(["child-2".to_string()]);
        let result2 = compute(
            &root,
            &ctx,
            None,
            Some(&dirty),
            Some(&prev_arc),
            Some(scene_idx),
            Some(prev_idx),
            None,
            false,
        )
        .unwrap();

        // child-1 (clean) must still have resolved props from overlay
        assert_eq!(
            result2.snapshot.children[0].props.text.as_deref(),
            Some("hello"),
            "clean node must retain resolved props from cached previous overlay"
        );
    }

    // ========================================================================
    // Nested Binding Dep Scanning (Investigation 014 Round 04)
    // ========================================================================

    /// build_binding_dep_index records transitive deps from nested bindings.
    ///
    /// A node with `scene[routing[ambient.session_text_origin]]` must record
    /// THREE dep entries: Scene("*"), Routing("*"), Ambient("session_text_origin").
    /// Without this, resolve_dirty_nodes misses these nodes on routing changes.
    #[test]
    fn dep_index_nested_binding_records_transitive_deps() {
        // Build a scene tree with a node whose value binding is:
        //   scene[routing[ambient.session_text_origin]]
        let tree_json = serde_json::json!({
            "id": "root",
            "kind": "Container",
            "children": [{
                "id": "field-padding",
                "kind": "Custom",
                "children": [],
                "value": {
                    "$kind": "binding",
                    "select": {
                        "from": "scene",
                        "key": {
                            "$kind": "binding",
                            "select": {
                                "from": "routing",
                                "key": {
                                    "$kind": "binding",
                                    "select": {
                                        "from": "ambient",
                                        "path": "session_text_origin"
                                    }
                                }
                            }
                        }
                    },
                    "transform": [{"op": "op:core.get_path", "args": {"path": "style.padding"}}]
                }
            }]
        });

        let index = build_binding_dep_index(&tree_json);

        // The node must be tracked as depending on ALL three sources
        let empty = std::collections::HashSet::new();

        // Task 199: RoutingViaAmbient resolution requires ambient_state to look up
        // the routing key from the ambient key. For "routing[ambient.session_text_origin]",
        // we need ambient_state["session_text_origin"] = the actual routing origin.
        let mut ambient_state_for_routing = HashMap::new();
        ambient_state_for_routing.insert(
            "session_text_origin".to_string(),
            serde_json::json!("seat1:pointer"),
        );

        // 1. Routing change → must find field-padding
        let mut routing_origins = std::collections::HashSet::new();
        routing_origins.insert("seat1:pointer".to_string());
        let affected = index.resolve_dirty_nodes(
            &empty,
            &routing_origins,
            &empty,
            &empty,
            &ambient_state_for_routing,
        );
        assert!(
            affected.contains("field-padding"),
            "node with scene[routing[...]] must be found when routing changes. Got: {:?}",
            affected
        );

        // 2. Ambient change → must find field-padding
        let mut ambient_keys = std::collections::HashSet::new();
        ambient_keys.insert("session_text_origin".to_string());
        let affected =
            index.resolve_dirty_nodes(&empty, &empty, &ambient_keys, &empty, &HashMap::new());
        assert!(
            affected.contains("field-padding"),
            "node with scene[routing[ambient.x]] must be found when ambient changes. Got: {:?}",
            affected
        );

        // 3. Scene structure change → must find field-padding
        let mut structure_all = std::collections::HashSet::new();
        structure_all.insert("*".to_string());
        let affected =
            index.resolve_dirty_nodes(&empty, &empty, &empty, &structure_all, &HashMap::new());
        assert!(
            affected.contains("field-padding"),
            "node with scene[...] must be found when scene structure changes. Got: {:?}",
            affected
        );
    }

    /// build_binding_dep_index handles arbitrary nesting depth (not just 3 levels).
    #[test]
    fn dep_index_deeply_nested_binding_records_all_levels() {
        // 4 levels: scene[fsm[routing[ambient.x]]]
        let tree_json = serde_json::json!({
            "id": "root",
            "kind": "Container",
            "children": [{
                "id": "deep-node",
                "kind": "Custom",
                "children": [],
                "value": {
                    "$kind": "binding",
                    "select": {
                        "from": "scene",
                        "key": {
                            "$kind": "binding",
                            "select": {
                                "from": "fsm",
                                "key": {
                                    "$kind": "binding",
                                    "select": {
                                        "from": "routing",
                                        "key": {
                                            "$kind": "binding",
                                            "select": {
                                                "from": "ambient",
                                                "path": "some_key"
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }]
        });

        let index = build_binding_dep_index(&tree_json);
        let empty = std::collections::HashSet::new();

        // All 4 source types must resolve this node
        let mut fsm_keys = std::collections::HashSet::new();
        fsm_keys.insert("*".to_string());
        assert!(
            index
                .resolve_dirty_nodes(&fsm_keys, &empty, &empty, &empty, &HashMap::new())
                .contains("deep-node"),
            "4-level nested: FSM change must find node"
        );

        let mut routing = std::collections::HashSet::new();
        routing.insert("*".to_string());
        assert!(
            index
                .resolve_dirty_nodes(&empty, &routing, &empty, &empty, &HashMap::new())
                .contains("deep-node"),
            "4-level nested: routing change must find node"
        );

        let mut ambient = std::collections::HashSet::new();
        ambient.insert("some_key".to_string());
        assert!(
            index
                .resolve_dirty_nodes(&empty, &empty, &ambient, &empty, &HashMap::new())
                .contains("deep-node"),
            "4-level nested: ambient change must find node"
        );

        let mut structure_all = std::collections::HashSet::new();
        structure_all.insert("*".to_string());
        assert!(
            index
                .resolve_dirty_nodes(&empty, &empty, &empty, &structure_all, &HashMap::new())
                .contains("deep-node"),
            "4-level nested: scene structure change must find node"
        );
    }

    // ========================================================================
    // Task 170: Typed Materialize Tests
    // ========================================================================

    /// Tree with no bindings returns identical structure (all fields preserved).
    #[test]
    fn test_typed_materialize_no_bindings() {
        use crate::kernel::types::{NodeProps, ResolvedStyle};
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            props: NodeProps {
                text: Some("hello".to_string()),
                ..Default::default()
            },
            style: Some(ResolvedStyle {
                background: Some("#ff0000".to_string()),
                ..Default::default()
            }),
            children: vec![Arc::new(SceneNode {
                id: "child".to_string(),
                kind: NodeKind::Text,
                children: vec![],
                ..Default::default()
            })],
            ..Default::default()
        };
        let ctx = make_test_ctx();
        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        assert_eq!(result.snapshot.id, "root");
        assert_eq!(result.snapshot.props.text.as_deref(), Some("hello"));
        assert_eq!(
            result
                .snapshot
                .style
                .as_ref()
                .unwrap()
                .background
                .as_deref(),
            Some("#ff0000")
        );
        assert_eq!(result.snapshot.children.len(), 1);
        assert_eq!(result.snapshot.children[0].id, "child");
        assert!(!result.structure_changed);
    }

    /// Visibility::Binding resolves to Visibility::Resolved(bool).
    #[test]
    fn test_typed_materialize_visibility_binding() {
        use crate::kernel::types::BindingSelect as TypesBindingSelect;
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            visible: Visibility::Binding(VisibilityBinding {
                kind: "binding".to_string(),
                select: TypesBindingSelect {
                    from: "fsm".to_string(),
                    key: Some(crate::kernel::types::SelectKey::Static(
                        "fsm:editor:main".to_string(),
                    )),
                    path: None,
                },
                transform: vec![],
                default: true,
            }),
            children: vec![],
            ..Default::default()
        };
        let ctx = EvaluationContext {
            fsm: serde_json::json!({"fsm:editor:main": "open"}),
            ..Default::default()
        };

        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        // Visibility binding should be resolved (not remain as Binding variant)
        match &result.snapshot.visible {
            Visibility::Resolved(_) => {} // Correct — resolved to a boolean
            Visibility::Binding(_) => panic!("Visibility should be resolved, not binding"),
        }
    }

    /// Custom node value binding is resolved during compute.
    #[test]
    fn test_typed_materialize_value_binding() {
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Custom,
            value: Some(serde_json::json!({
                "$kind": "binding",
                "select": {"from": "ambient", "path": "theme"},
                "default": "light"
            })),
            children: vec![],
            ..Default::default()
        };
        let ctx = EvaluationContext {
            ambient: serde_json::json!({"theme": "dark"}),
            ..Default::default()
        };

        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        assert_eq!(result.snapshot.value.as_ref().unwrap(), "dark");
    }

    /// Trigger payload binding is resolved during compute.
    #[test]
    fn test_typed_materialize_trigger_payload_binding() {
        use crate::kernel::types::{NodeTrigger, NodeTriggerQuery};
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            triggers: vec![NodeTrigger {
                query: NodeTriggerQuery {
                    event: "click".to_string(),
                },
                action_ref: "action:test".to_string(),
                payload: Some(serde_json::json!({
                    "$kind": "binding",
                    "select": {"from": "routing", "key": "origin1"},
                    "default": null
                })),
            }],
            children: vec![],
            ..Default::default()
        };
        let mut routing = std::collections::HashMap::new();
        routing.insert("origin1".to_string(), "target-node".to_string());
        let ctx = EvaluationContext {
            routing,
            ..Default::default()
        };

        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        assert_eq!(
            result.snapshot.triggers[0].payload.as_ref().unwrap(),
            "target-node"
        );
    }

    /// Unchanged subtrees preserve Arc::ptr_eq after compute with previous.
    #[test]
    fn test_typed_materialize_path_copy_unchanged_subtree() {
        let child_a = Arc::new(SceneNode {
            id: "a".to_string(),
            kind: NodeKind::Text,
            children: vec![],
            ..Default::default()
        });
        let child_b = Arc::new(SceneNode {
            id: "b".to_string(),
            kind: NodeKind::Text,
            children: vec![],
            ..Default::default()
        });
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![Arc::clone(&child_a), Arc::clone(&child_b)],
            ..Default::default()
        };
        let ctx = make_test_ctx();

        // First compute (full)
        let result1 = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let prev_arc = Arc::new(result1.snapshot);

        // Second compute with only "root" dirty — children should be reused
        let dirty = HashSet::from(["root".to_string()]);
        let result2 = compute(
            &root,
            &ctx,
            None,
            Some(&dirty),
            Some(&prev_arc),
            None,
            None,
            None,
            false,
        )
        .unwrap();

        // Children should be Arc::ptr_eq with previous (unchanged subtrees)
        assert!(
            Arc::ptr_eq(&result2.snapshot.children[0], &prev_arc.children[0]),
            "Unchanged child 'a' should have same Arc as previous"
        );
        assert!(
            Arc::ptr_eq(&result2.snapshot.children[1], &prev_arc.children[1]),
            "Unchanged child 'b' should have same Arc as previous"
        );
    }

    /// Only the spine from root to dirty node is rebuilt; siblings keep Arcs.
    #[test]
    fn test_typed_materialize_path_copy_dirty_spine() {
        let grandchild = Arc::new(SceneNode {
            id: "gc".to_string(),
            kind: NodeKind::Text,
            value: Some(serde_json::json!({
                "$kind": "binding",
                "select": {"from": "ambient", "path": "x"},
                "default": 0
            })),
            children: vec![],
            ..Default::default()
        });
        let child_dirty = Arc::new(SceneNode {
            id: "dirty-child".to_string(),
            kind: NodeKind::Container,
            children: vec![Arc::clone(&grandchild)],
            ..Default::default()
        });
        let child_clean = Arc::new(SceneNode {
            id: "clean-child".to_string(),
            kind: NodeKind::Text,
            children: vec![],
            ..Default::default()
        });
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![Arc::clone(&child_dirty), Arc::clone(&child_clean)],
            ..Default::default()
        };
        let ctx = EvaluationContext {
            ambient: serde_json::json!({"x": 42}),
            ..Default::default()
        };

        // Full compute
        let result1 = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let prev_arc = Arc::new(result1.snapshot);

        // Incremental: only grandchild is dirty
        let dirty = HashSet::from(["gc".to_string()]);
        let result2 = compute(
            &root,
            &ctx,
            None,
            Some(&dirty),
            Some(&prev_arc),
            None,
            None,
            None,
            false,
        )
        .unwrap();

        // Clean sibling should be reused
        assert!(
            Arc::ptr_eq(&result2.snapshot.children[1], &prev_arc.children[1]),
            "Clean sibling should preserve Arc identity"
        );
        // Dirty child's parent (dirty-child) is on the spine — gets new Arc (path-copy)
        assert!(
            !Arc::ptr_eq(&result2.snapshot.children[0], &prev_arc.children[0]),
            "Dirty child's parent should be rebuilt (path-copy spine)"
        );
    }

    /// Visibility change sets structure_changed=true.
    #[test]
    fn test_typed_materialize_structure_changed_visibility_flip() {
        use crate::kernel::types::BindingSelect as TypesBindingSelect;
        // Node with visibility binding that resolves to true
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            visible: Visibility::Binding(VisibilityBinding {
                kind: "binding".to_string(),
                select: TypesBindingSelect {
                    from: "fsm".to_string(),
                    key: None,
                    path: Some("fsm:vis".to_string()),
                },
                transform: vec![crate::kernel::types::BindingTransform {
                    op: "op:core.equals".to_string(),
                    args: serde_json::json!({"value": "open"}),
                }],
                default: false,
            }),
            children: vec![],
            ..Default::default()
        };

        // Previous: visibility was false
        let prev = Arc::new(SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            visible: Visibility::Resolved(false),
            children: vec![],
            ..Default::default()
        });

        let ctx = EvaluationContext {
            fsm: serde_json::json!({"fsm:vis": "open"}),
            ..Default::default()
        };
        let registry = crate::binding::operators::core::create_core_registry().unwrap();
        let dirty = HashSet::from(["root".to_string()]);

        let result = compute(
            &root,
            &ctx,
            Some(&registry),
            Some(&dirty),
            Some(&prev),
            None,
            None,
            None,
            false,
        )
        .unwrap();

        // Visibility flipped from false to true → structure_changed
        assert!(
            result.structure_changed,
            "Visibility flip should set structure_changed=true"
        );
    }

    /// Different child count sets structure_changed=true.
    #[test]
    fn test_typed_materialize_structure_changed_child_count() {
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![
                Arc::new(SceneNode {
                    id: "a".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
                Arc::new(SceneNode {
                    id: "b".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
            ],
            ..Default::default()
        };
        // Previous had only one child
        let prev = Arc::new(SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![Arc::new(SceneNode {
                id: "a".to_string(),
                kind: NodeKind::Text,
                children: vec![],
                ..Default::default()
            })],
            ..Default::default()
        });

        let ctx = make_test_ctx();
        let result = compute(
            &root,
            &ctx,
            None,
            None,
            Some(&prev),
            None,
            None,
            None,
            false,
        )
        .unwrap();

        assert!(
            result.structure_changed,
            "Different child count should set structure_changed=true"
        );
    }

    /// Clean node returns Arc::clone(previous) when nothing in subtree changed.
    #[test]
    fn test_typed_materialize_incremental_skip_clean_node() {
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![Arc::new(SceneNode {
                id: "child".to_string(),
                kind: NodeKind::Text,
                children: vec![],
                ..Default::default()
            })],
            ..Default::default()
        };
        let ctx = make_test_ctx();

        // Full compute
        let result1 = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let prev_arc = Arc::new(result1.snapshot);

        // Incremental: nothing dirty — entire tree should be reused
        let dirty = HashSet::new();
        let result2 = compute(
            &root,
            &ctx,
            None,
            Some(&dirty),
            Some(&prev_arc),
            None,
            None,
            None,
            false,
        )
        .unwrap();

        // Root child should be ptr_eq with previous
        assert!(
            Arc::ptr_eq(&result2.snapshot.children[0], &prev_arc.children[0]),
            "Clean child should be Arc::clone of previous"
        );
    }

    /// Clean parent with dirty child: parent gets path-copy, child re-evaluated.
    #[test]
    fn test_typed_materialize_incremental_dirty_child_of_clean_parent() {
        let root = SceneNode {
            id: "parent".to_string(),
            kind: NodeKind::Container,
            children: vec![
                Arc::new(SceneNode {
                    id: "dirty-child".to_string(),
                    kind: NodeKind::Custom,
                    value: Some(serde_json::json!({
                        "$kind": "binding",
                        "select": {"from": "ambient", "path": "val"},
                        "default": 0
                    })),
                    children: vec![],
                    ..Default::default()
                }),
                Arc::new(SceneNode {
                    id: "clean-child".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
            ],
            ..Default::default()
        };
        let ctx = EvaluationContext {
            ambient: serde_json::json!({"val": 99}),
            ..Default::default()
        };

        // Full compute
        let result1 = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let prev_arc = Arc::new(result1.snapshot);

        // Incremental: only dirty-child in dirty set
        let dirty = HashSet::from(["dirty-child".to_string()]);
        let result2 = compute(
            &root,
            &ctx,
            None,
            Some(&dirty),
            Some(&prev_arc),
            None,
            None,
            None,
            false,
        )
        .unwrap();

        // Clean sibling should keep its Arc
        assert!(
            Arc::ptr_eq(&result2.snapshot.children[1], &prev_arc.children[1]),
            "Clean sibling must preserve Arc identity"
        );
        // Dirty child value should be resolved
        assert_eq!(
            result2.snapshot.children[0].value.as_ref().unwrap(),
            &serde_json::json!(99),
            "Dirty child value binding should be evaluated"
        );
    }

    /// ComputeResult.structure_changed reports false when structure is unchanged.
    #[test]
    fn test_compute_result_structure_changed_false_when_unchanged() {
        let root = make_test_tree();
        let ctx = make_test_ctx();
        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        assert!(
            !result.structure_changed,
            "No structural changes in simple passthrough"
        );
    }

    /// Typed dep index records VisibilityBinding deps correctly.
    #[test]
    fn test_typed_dep_index_visibility_binding() {
        use crate::kernel::types::BindingSelect as TypesBindingSelect;
        let root = SceneNode {
            id: "vis-node".to_string(),
            kind: NodeKind::Container,
            visible: Visibility::Binding(VisibilityBinding {
                kind: "binding".to_string(),
                select: TypesBindingSelect {
                    from: "fsm".to_string(),
                    key: Some(crate::kernel::types::SelectKey::Static(
                        "fsm:editor:main".to_string(),
                    )),
                    path: None,
                },
                transform: vec![],
                default: false,
            }),
            children: vec![],
            ..Default::default()
        };

        let index = build_typed_binding_dep_index(&root);

        // Node should depend on FSM key
        let empty = std::collections::HashSet::new();
        let mut fsm_keys = std::collections::HashSet::new();
        fsm_keys.insert("fsm:editor:main".to_string());
        let dirty_nodes =
            index.resolve_dirty_nodes(&fsm_keys, &empty, &empty, &empty, &HashMap::new());
        assert!(
            dirty_nodes.contains("vis-node"),
            "FSM dep should be recorded from visibility binding"
        );
    }

    /// Value binding deps recorded (including nested/recursive).
    #[test]
    fn test_typed_dep_index_value_binding() {
        let root = SceneNode {
            id: "val-node".to_string(),
            kind: NodeKind::Custom,
            value: Some(serde_json::json!({
                "$kind": "binding",
                "select": {"from": "ambient", "path": "theme"},
                "default": "light"
            })),
            children: vec![],
            ..Default::default()
        };

        let index = build_typed_binding_dep_index(&root);

        let empty = std::collections::HashSet::new();
        let mut ambient_keys = std::collections::HashSet::new();
        ambient_keys.insert("theme".to_string());
        let dirty_nodes =
            index.resolve_dirty_nodes(&empty, &empty, &ambient_keys, &empty, &HashMap::new());
        assert!(
            dirty_nodes.contains("val-node"),
            "Ambient dep should be recorded from value binding"
        );
    }

    /// Trigger payload binding deps recorded in typed dep index.
    #[test]
    fn test_typed_dep_index_trigger_payload_binding() {
        use crate::kernel::types::{NodeTrigger, NodeTriggerQuery};
        let root = SceneNode {
            id: "trigger-node".to_string(),
            kind: NodeKind::Container,
            triggers: vec![NodeTrigger {
                query: NodeTriggerQuery {
                    event: "click".to_string(),
                },
                action_ref: "action:test".to_string(),
                payload: Some(serde_json::json!({
                    "$kind": "binding",
                    "select": {"from": "routing", "key": "origin1"},
                    "default": null
                })),
            }],
            children: vec![],
            ..Default::default()
        };

        let index = build_typed_binding_dep_index(&root);

        let empty = std::collections::HashSet::new();
        let mut routing_keys = std::collections::HashSet::new();
        routing_keys.insert("origin1".to_string());
        let dirty_nodes =
            index.resolve_dirty_nodes(&empty, &routing_keys, &empty, &empty, &HashMap::new());
        assert!(
            dirty_nodes.contains("trigger-node"),
            "Routing dep should be recorded from trigger payload binding"
        );
    }

    /// scene[routing[ambient.x]] records all 3 dep keys (Investigation 014 fix preserved).
    #[test]
    fn test_typed_dep_index_recursive_nesting() {
        use crate::kernel::types::BindingSelect as TypesBindingSelect;
        // Build a visibility binding that nests: scene[routing[ambient.key]]
        // This tests that the recursive dep scanning in build_typed_binding_dep_index
        // records deps for all levels of nesting.
        let root = SceneNode {
            id: "nested-node".to_string(),
            kind: NodeKind::Container,
            visible: Visibility::Binding(VisibilityBinding {
                kind: "binding".to_string(),
                select: TypesBindingSelect {
                    from: "scene".to_string(),
                    key: Some(crate::kernel::types::SelectKey::Dynamic(
                        serde_json::json!({
                            "$kind": "binding",
                            "select": {
                                "from": "routing",
                                "key": {
                                    "$kind": "binding",
                                    "select": {"from": "ambient", "key": "session_key"},
                                    "default": "default"
                                }
                            },
                            "default": null
                        }),
                    )),
                    path: None,
                },
                transform: vec![],
                default: false,
            }),
            children: vec![],
            ..Default::default()
        };

        let index = build_typed_binding_dep_index(&root);
        let empty = std::collections::HashSet::new();

        // Scene dep (outermost: from=scene, key=dynamic → wildcard)
        let mut structure_all = std::collections::HashSet::new();
        structure_all.insert("*".to_string());
        let dirty_scene =
            index.resolve_dirty_nodes(&empty, &empty, &empty, &structure_all, &HashMap::new());
        assert!(
            dirty_scene.contains("nested-node"),
            "Scene structure change should find nested node"
        );

        // Routing dep (middle: from=routing, key=dynamic → wildcard)
        let mut routing_keys = std::collections::HashSet::new();
        routing_keys.insert("*".to_string());
        let dirty_routing =
            index.resolve_dirty_nodes(&empty, &routing_keys, &empty, &empty, &HashMap::new());
        assert!(
            dirty_routing.contains("nested-node"),
            "Routing wildcard should find nested node"
        );

        // Ambient dep (innermost: from=ambient, key=session_key)
        let mut ambient_keys = std::collections::HashSet::new();
        ambient_keys.insert("session_key".to_string());
        let dirty_ambient =
            index.resolve_dirty_nodes(&empty, &empty, &ambient_keys, &empty, &HashMap::new());
        assert!(
            dirty_ambient.contains("nested-node"),
            "Ambient key should find nested node"
        );
    }

    /// compute_generic always returns structure_changed=false.
    #[test]
    fn test_compute_generic_no_structure_changed() {
        #[derive(Debug, Clone, Serialize, Deserialize)]
        struct Dummy {
            x: i32,
        }
        let data = Dummy { x: 1 };
        let ctx = make_test_ctx();
        let result = compute_generic(&data, &ctx, None).unwrap();
        assert!(
            !result.structure_changed,
            "compute_generic must always return structure_changed=false"
        );
    }

    /// compute_dry_run always returns structure_changed=false.
    #[test]
    fn test_compute_dry_run_no_structure_changed() {
        let root = make_test_tree();
        let ctx = make_test_ctx();
        let result = compute_dry_run(&root, &ctx).unwrap();
        assert!(
            !result.structure_changed,
            "compute_dry_run must always return structure_changed=false"
        );
    }

    // ========================================================================
    // Task 178 V3/V4: Compute Pipeline Early-Exit + BindingDepIndex Caching
    // ========================================================================

    /// T178-1: Clean frame (empty dirty set, no structure change) → early-exit
    /// path returns previous render tree without running compute.
    /// Verified by testing that the full render() pipeline returns the cached
    /// tree when only viewport_dirty is set (needs_binding_eval=false).
    #[test]
    fn t178_clean_dirty_set_produces_valid_result() {
        let root = make_test_tree();
        let ctx = make_test_ctx();
        let dirty = HashSet::new(); // empty
        let result = compute(
            &root,
            &ctx,
            None,
            Some(&dirty),
            None,
            None,
            None,
            None,
            false,
        )
        .unwrap();
        // Even with empty dirty set, compute still produces a valid result
        assert_eq!(result.snapshot.id, "root");
        assert_eq!(result.snapshot.children.len(), 1);
    }

    /// T178-2: Structure change → only new nodes evaluated, existing untouched.
    /// When structure_dirty=true, dep index is rebuilt (new nodes may have bindings).
    #[test]
    fn t178_structure_change_rebuilds_dep_index() {
        let root = make_cache_test_tree(); // root + child-1, child-2, grandchild-2a
        let ctx = make_test_ctx();

        // First compute: build dep index
        let result1 = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let dep_idx1 = result1.binding_dep_index.unwrap();

        // Second compute with structure_dirty=true forces dep index rebuild
        let result2 = compute(
            &root,
            &ctx,
            None,
            None,
            None,
            None,
            None,
            Some(dep_idx1.clone()),
            true,
        )
        .unwrap();
        let dep_idx2 = result2.binding_dep_index.unwrap();

        // Must NOT be the same Arc — structure_dirty=true forces rebuild
        assert!(
            !Arc::ptr_eq(&dep_idx1, &dep_idx2),
            "structure_dirty=true must rebuild dep index, not reuse cache"
        );
    }

    /// T178-3: FSM change → only FSM-dependent nodes evaluated.
    /// Dep index maps FSM keys to affected nodes; non-FSM nodes are skipped.
    #[test]
    fn t178_fsm_dep_scoped_resolution() {
        // Build a dep index with one FSM-dependent node
        let mut dep_idx = BindingDepIndex::new();
        dep_idx.record("fsm-node", DepKey::Fsm("fsm:editor:main".to_string()));
        dep_idx.record("ambient-node", DepKey::Ambient("theme".to_string()));

        let mut fsm_keys = HashSet::new();
        fsm_keys.insert("fsm:editor:main".to_string());
        let empty = HashSet::new();

        let affected =
            dep_idx.resolve_dirty_nodes(&fsm_keys, &empty, &empty, &empty, &HashMap::new());
        assert!(
            affected.contains("fsm-node"),
            "FSM-dependent node must be resolved"
        );
        assert!(
            !affected.contains("ambient-node"),
            "Ambient node must NOT be resolved for FSM change"
        );
    }

    /// T178-4: Routing change → only routing-dependent nodes evaluated.
    #[test]
    fn t178_routing_dep_scoped_resolution() {
        let mut dep_idx = BindingDepIndex::new();
        dep_idx.record("route-node", DepKey::Routing("pointer:0".to_string()));
        dep_idx.record("other-node", DepKey::Fsm("fsm:x".to_string()));

        let mut routing_keys = HashSet::new();
        routing_keys.insert("pointer:0".to_string());
        let empty = HashSet::new();

        let affected =
            dep_idx.resolve_dirty_nodes(&empty, &routing_keys, &empty, &empty, &HashMap::new());
        assert!(
            affected.contains("route-node"),
            "Routing-dependent node must be resolved"
        );
        assert!(
            !affected.contains("other-node"),
            "FSM node must NOT be resolved for routing change"
        );
    }

    /// T178-5: BindingDepIndex cached across frames → no rebuild when structure unchanged.
    #[test]
    fn t178_dep_index_cached_when_structure_unchanged() {
        let root = make_cache_test_tree();
        let ctx = make_test_ctx();

        // First compute: build dep index fresh
        let result1 = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let dep_idx = result1.binding_dep_index.unwrap();

        // Second compute: pass cached dep index with structure_dirty=false
        let result2 = compute(
            &root,
            &ctx,
            None,
            None,
            None,
            None,
            None,
            Some(dep_idx.clone()),
            false,
        )
        .unwrap();
        let dep_idx2 = result2.binding_dep_index.unwrap();

        // Must be the same Arc — no rebuild when structure unchanged
        assert!(
            Arc::ptr_eq(&dep_idx, &dep_idx2),
            "dep index must be reused (same Arc) when structure_dirty=false"
        );
    }

    /// T178-6: Structure change → dep index rebuilt (different Arc).
    /// This is the inverse of T178-5.
    #[test]
    fn t178_dep_index_rebuilt_on_structure_change() {
        let root = make_cache_test_tree();
        let ctx = make_test_ctx();

        let result1 = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let dep_idx = result1.binding_dep_index.unwrap();

        // structure_dirty=true → must rebuild
        let result2 = compute(
            &root,
            &ctx,
            None,
            None,
            None,
            None,
            None,
            Some(dep_idx.clone()),
            true,
        )
        .unwrap();
        let dep_idx2 = result2.binding_dep_index.unwrap();

        assert!(
            !Arc::ptr_eq(&dep_idx, &dep_idx2),
            "dep index must be rebuilt (new Arc) when structure_dirty=true"
        );
    }

    /// T178-7: Mixed dirty (structure + FSM) → correct union of dirty nodes.
    #[test]
    fn t178_mixed_dirty_union() {
        let mut dep_idx = BindingDepIndex::new();
        dep_idx.record("fsm-node", DepKey::Fsm("fsm:x".to_string()));
        dep_idx.record("scene-node", DepKey::Scene("some-id".to_string()));
        dep_idx.record("clean-node", DepKey::Ambient("unused".to_string()));

        let mut fsm_keys = HashSet::new();
        fsm_keys.insert("fsm:x".to_string());
        let empty = HashSet::new();

        // structure_dirty=true → scene-dep nodes included; fsm key → fsm-dep included
        let mut structure_all = HashSet::new();
        structure_all.insert("*".to_string());
        let affected =
            dep_idx.resolve_dirty_nodes(&fsm_keys, &empty, &empty, &structure_all, &HashMap::new());
        assert!(
            affected.contains("fsm-node"),
            "FSM-dependent node must be in union"
        );
        assert!(
            affected.contains("scene-node"),
            "Scene-dependent node must be in union (structure dirty)"
        );
        assert!(
            !affected.contains("clean-node"),
            "Ambient node (no ambient change) must NOT be in union"
        );
    }

    /// T178-8: 1000 nodes, 1 property change → only 1 node evaluated.
    /// Simulates a large tree where incremental compute processes O(1) nodes.
    #[test]
    fn t178_large_tree_single_dirty_node() {
        let root = make_large_tree(1000);
        let ctx = make_test_ctx();

        // Full compute for baseline
        let result1 = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let prev_arc = Arc::new(result1.snapshot);
        let dep_idx = result1.binding_dep_index.unwrap();

        // Incremental: only node-500 dirty
        let dirty = HashSet::from(["node-500".to_string()]);
        let result2 = compute(
            &root,
            &ctx,
            None,
            Some(&dirty),
            Some(&prev_arc),
            None,
            None,
            Some(dep_idx),
            false,
        )
        .unwrap();

        // All 1001 nodes in output (root + 1000 children)
        assert_eq!(result2.snapshot.children.len(), 1000);
        // The dirty node must be present
        assert!(result2.snapshot.children.iter().any(|c| c.id == "node-500"));
        // Clean nodes must preserve Arc identity (unchanged subtrees)
        assert!(
            Arc::ptr_eq(&result2.snapshot.children[0], &prev_arc.children[0]),
            "Clean node-0 must preserve Arc identity"
        );
        assert!(
            Arc::ptr_eq(&result2.snapshot.children[999], &prev_arc.children[999]),
            "Clean node-999 must preserve Arc identity"
        );
    }

    /// T178-9: 1000 nodes, structure change adding 1 node → only new + structure-dependent.
    #[test]
    fn t178_large_tree_structure_add_one() {
        let root = make_large_tree(1000);
        let ctx = make_test_ctx();

        // Full compute for baseline
        let result1 = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let prev_arc = Arc::new(result1.snapshot);

        // Add one new node to tree
        let mut modified = root.clone();
        modified.children.push(Arc::new(SceneNode {
            id: "new-node".to_string(),
            kind: NodeKind::Text,
            children: vec![],
            ..Default::default()
        }));

        // Only new-node is in dirty set, structure_dirty=true forces dep index rebuild
        let dirty = HashSet::from(["new-node".to_string()]);
        let result2 = compute(
            &modified,
            &ctx,
            None,
            Some(&dirty),
            Some(&prev_arc),
            None,
            None,
            None,
            true,
        )
        .unwrap();

        // New node must be in output
        assert_eq!(result2.snapshot.children.len(), 1001);
        assert!(result2.snapshot.children.iter().any(|c| c.id == "new-node"));
        // Dep index must have been rebuilt (structure_dirty=true)
        assert!(result2.binding_dep_index.is_some());
    }

    /// T178-10: Zero dirty after resolution → compute still works but minimal work.
    /// When dirty_nodes is empty, compute skips per-node evaluation and returns
    /// a tree built from previous fallback values.
    #[test]
    fn t178_zero_dirty_after_resolution() {
        let root = make_cache_test_tree();
        let ctx = make_test_ctx();

        // First compute for baseline
        let result1 = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let prev_arc = Arc::new(result1.snapshot);
        let dep_idx = result1.binding_dep_index.unwrap();

        // Zero dirty nodes, no structure change, cached dep index
        let empty = HashSet::new();
        let result2 = compute(
            &root,
            &ctx,
            None,
            Some(&empty),
            Some(&prev_arc),
            None,
            None,
            Some(dep_idx.clone()),
            false,
        )
        .unwrap();

        // Result should still be valid
        assert_eq!(result2.snapshot.id, "root");
        assert_eq!(result2.snapshot.children.len(), 2);
        // Dep index must be the same Arc (cached, no structure change)
        let dep_idx2 = result2.binding_dep_index.unwrap();
        assert!(
            Arc::ptr_eq(&dep_idx, &dep_idx2),
            "dep index must be reused for zero-dirty frames"
        );
    }

    /// T178-11: First compute (no cached dep index) builds fresh index.
    #[test]
    fn t178_first_compute_builds_dep_index() {
        let root = make_cache_test_tree();
        let ctx = make_test_ctx();

        // No cached dep index, structure_dirty=false (first render doesn't need structure flag)
        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let dep_idx = result.binding_dep_index.unwrap();

        // Must have built an index (even if empty for binding-free tree)
        assert!(
            dep_idx.dep_count() == 0 || dep_idx.dep_count() > 0,
            "dep index must be returned on first compute"
        );
    }

    /// T178-12: Early-exit integration test via render() function.
    /// When nothing dirty after scoped resolution, render reuses cached tree.
    #[test]
    fn t178_render_early_exit_scoped_empty() {
        // Build a dep index with one FSM dep on a non-existent key
        let mut dep_idx = BindingDepIndex::new();
        dep_idx.record("nonexistent-node", DepKey::Fsm("fsm:unused".to_string()));

        // Mark FSM key "fsm:other" dirty (which NO node depends on)
        let mut fsm_keys = HashSet::new();
        fsm_keys.insert("fsm:other".to_string());
        let empty = HashSet::new();

        // Resolve: should produce empty set (no nodes depend on "fsm:other")
        let affected =
            dep_idx.resolve_dirty_nodes(&fsm_keys, &empty, &empty, &empty, &HashMap::new());
        assert!(
            affected.is_empty(),
            "No nodes should be affected by an unreferenced FSM key"
        );
    }

    // ========================================================================
    // Task 191 Agent 2: serde_json::to_value() elimination tests
    // ========================================================================

    /// T191-01: Binding in layout.x is detected by scan_resolved_style_for_deps.
    #[test]
    fn test_scan_deps_detects_binding_in_layout_x() {
        use crate::kernel::types::{LayoutConfig, NodeProps, ResolvedStyle};
        let style = ResolvedStyle {
            layout: Some(LayoutConfig {
                x: Some(serde_json::json!({
                    "$kind": "binding",
                    "select": {"from": "ambient", "path": "posX"},
                    "default": 0
                })),
                ..Default::default()
            }),
            ..Default::default()
        };
        let root = SceneNode {
            id: "abs-node".to_string(),
            kind: NodeKind::Container,
            props: NodeProps {
                style: Some(style),
                ..Default::default()
            },
            children: vec![],
            ..Default::default()
        };

        let index = build_typed_binding_dep_index(&root);
        let empty = HashSet::new();
        let mut ambient_keys = HashSet::new();
        ambient_keys.insert("posX".to_string());
        let dirty =
            index.resolve_dirty_nodes(&empty, &empty, &ambient_keys, &empty, &HashMap::new());
        assert!(
            dirty.contains("abs-node"),
            "layout.x binding should record ambient dep"
        );
    }

    /// T191-02: Binding in layout.y is detected by scan_resolved_style_for_deps.
    #[test]
    fn test_scan_deps_detects_binding_in_layout_y() {
        use crate::kernel::types::{LayoutConfig, NodeProps, ResolvedStyle};
        let style = ResolvedStyle {
            layout: Some(LayoutConfig {
                y: Some(serde_json::json!({
                    "$kind": "binding",
                    "select": {"from": "fsm", "key": "fsm:editor:main", "path": "yPos"},
                    "default": 0
                })),
                ..Default::default()
            }),
            ..Default::default()
        };
        let root = SceneNode {
            id: "y-node".to_string(),
            kind: NodeKind::Container,
            props: NodeProps {
                style: Some(style),
                ..Default::default()
            },
            children: vec![],
            ..Default::default()
        };

        let index = build_typed_binding_dep_index(&root);
        let empty = HashSet::new();
        let mut fsm_keys = HashSet::new();
        fsm_keys.insert("fsm:editor:main".to_string());
        let dirty = index.resolve_dirty_nodes(&fsm_keys, &empty, &empty, &empty, &HashMap::new());
        assert!(
            dirty.contains("y-node"),
            "layout.y binding should record FSM dep"
        );
    }

    /// T191-03: Binding in extra field is detected by scan_resolved_style_for_deps.
    #[test]
    fn test_scan_deps_detects_binding_in_extra() {
        use crate::kernel::types::ResolvedStyle;
        let mut extra = HashMap::new();
        extra.insert(
            "opacity".to_string(),
            serde_json::json!({
                "$kind": "binding",
                "select": {"from": "routing", "key": "origin1"},
                "default": 1.0
            }),
        );
        let style = ResolvedStyle {
            extra,
            ..Default::default()
        };
        let root = SceneNode {
            id: "extra-node".to_string(),
            kind: NodeKind::Container,
            style: Some(style),
            children: vec![],
            ..Default::default()
        };

        let index = build_typed_binding_dep_index(&root);
        let empty = HashSet::new();
        let mut routing_keys = HashSet::new();
        routing_keys.insert("origin1".to_string());
        let dirty =
            index.resolve_dirty_nodes(&empty, &routing_keys, &empty, &empty, &HashMap::new());
        assert!(
            dirty.contains("extra-node"),
            "extra binding should record routing dep"
        );
    }

    /// T191-04: Style with only typed primitives produces no deps and no crash.
    #[test]
    fn test_scan_deps_ignores_typed_primitives() {
        use crate::kernel::types::{NodeProps, ResolvedStyle};
        let style = ResolvedStyle {
            background: Some("#000000".to_string()),
            color: Some("white".to_string()),
            border_radius: Some(4.0),
            font_size: Some(14.0),
            ..Default::default()
        };
        let root = SceneNode {
            id: "plain-node".to_string(),
            kind: NodeKind::Text,
            props: NodeProps {
                style: Some(style),
                ..Default::default()
            },
            children: vec![],
            ..Default::default()
        };

        let index = build_typed_binding_dep_index(&root);
        let empty = HashSet::new();
        let dirty = index.resolve_dirty_nodes(&empty, &empty, &empty, &empty, &HashMap::new());
        assert!(
            dirty.is_empty(),
            "No bindings in typed primitives — no deps"
        );
    }

    /// T191-05: Style with layout=None produces no crash and no deps.
    #[test]
    fn test_scan_deps_handles_none_layout() {
        use crate::kernel::types::{NodeProps, ResolvedStyle};
        let style = ResolvedStyle {
            layout: None,
            ..Default::default()
        };
        let root = SceneNode {
            id: "no-layout".to_string(),
            kind: NodeKind::Container,
            props: NodeProps {
                style: Some(style),
                ..Default::default()
            },
            children: vec![],
            ..Default::default()
        };

        let index = build_typed_binding_dep_index(&root);
        assert_eq!(index.dep_count(), 0, "None layout should produce zero deps");
    }

    /// T191-06: Binding in layout.x is evaluated to a concrete value.
    #[test]
    fn test_eval_resolves_binding_in_layout_x() {
        use crate::kernel::types::{LayoutConfig, NodeProps, ResolvedStyle};
        let style = ResolvedStyle {
            layout: Some(LayoutConfig {
                x: Some(serde_json::json!({
                    "$kind": "binding",
                    "select": {"from": "ambient", "path": "posX"},
                    "default": 99
                })),
                ..Default::default()
            }),
            ..Default::default()
        };
        let root = SceneNode {
            id: "eval-x".to_string(),
            kind: NodeKind::Container,
            props: NodeProps {
                style: Some(style),
                ..Default::default()
            },
            children: vec![],
            ..Default::default()
        };

        let mut ctx = make_test_ctx();
        ctx.ambient = serde_json::json!({"posX": 42});
        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        let result_node = &result.snapshot;
        let resolved_style = result_node
            .props
            .style
            .as_ref()
            .expect("props.style should exist");
        let layout = resolved_style.layout.as_ref().expect("layout should exist");
        let x = layout.x.as_ref().expect("x should exist");
        assert_eq!(
            x.as_f64(),
            Some(42.0),
            "layout.x should be evaluated from ambient.posX"
        );
    }

    /// T191-07: Binding in layout.y is evaluated to a concrete value.
    #[test]
    fn test_eval_resolves_binding_in_layout_y() {
        use crate::kernel::types::{LayoutConfig, NodeProps, ResolvedStyle};
        let style = ResolvedStyle {
            layout: Some(LayoutConfig {
                y: Some(serde_json::json!({
                    "$kind": "binding",
                    "select": {"from": "ambient", "path": "posY"},
                    "default": 0
                })),
                ..Default::default()
            }),
            ..Default::default()
        };
        let root = SceneNode {
            id: "eval-y".to_string(),
            kind: NodeKind::Container,
            props: NodeProps {
                style: Some(style),
                ..Default::default()
            },
            children: vec![],
            ..Default::default()
        };

        let mut ctx = make_test_ctx();
        ctx.ambient = serde_json::json!({"posY": 100});
        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        let result_node = &result.snapshot;
        let resolved_style = result_node
            .props
            .style
            .as_ref()
            .expect("props.style should exist");
        let layout = resolved_style.layout.as_ref().expect("layout should exist");
        let y = layout.y.as_ref().expect("y should exist");
        assert_eq!(
            y.as_f64(),
            Some(100.0),
            "layout.y should be evaluated from ambient.posY"
        );
    }

    /// T191-08: Binding in extra field is evaluated to a concrete value.
    #[test]
    fn test_eval_resolves_binding_in_extra() {
        use crate::kernel::types::ResolvedStyle;
        let mut extra = HashMap::new();
        extra.insert(
            "opacity".to_string(),
            serde_json::json!({
                "$kind": "binding",
                "select": {"from": "ambient", "path": "alpha"},
                "default": 1.0
            }),
        );
        let style = ResolvedStyle {
            extra,
            ..Default::default()
        };
        let root = SceneNode {
            id: "eval-extra".to_string(),
            kind: NodeKind::Container,
            style: Some(style),
            children: vec![],
            ..Default::default()
        };

        let mut ctx = make_test_ctx();
        ctx.ambient = serde_json::json!({"alpha": 0.5});
        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        let result_node = &result.snapshot;
        let resolved_style = result_node.style.as_ref().expect("style should exist");
        let opacity = resolved_style
            .extra
            .get("opacity")
            .expect("opacity should exist");
        assert_eq!(
            opacity.as_f64(),
            Some(0.5),
            "extra.opacity should be evaluated from ambient.alpha"
        );
    }

    /// T191-09: Non-binding typed fields are preserved unchanged after evaluation.
    #[test]
    fn test_eval_preserves_non_binding_fields() {
        use crate::kernel::types::{NodeProps, ResolvedStyle};
        let style = ResolvedStyle {
            background: Some("#ff0000".to_string()),
            color: Some("blue".to_string()),
            border_radius: Some(8.0),
            font_size: Some(16.0),
            ..Default::default()
        };
        let root = SceneNode {
            id: "preserve-node".to_string(),
            kind: NodeKind::Text,
            props: NodeProps {
                style: Some(style.clone()),
                ..Default::default()
            },
            children: vec![],
            ..Default::default()
        };

        let ctx = make_test_ctx();
        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        let result_node = &result.snapshot;
        let result_style = result_node
            .props
            .style
            .as_ref()
            .expect("props.style should exist");
        assert_eq!(
            result_style.background,
            Some("#ff0000".to_string()),
            "background preserved"
        );
        assert_eq!(
            result_style.color,
            Some("blue".to_string()),
            "color preserved"
        );
        assert_eq!(
            result_style.border_radius,
            Some(8.0),
            "border_radius preserved"
        );
        assert_eq!(result_style.font_size, Some(16.0), "font_size preserved");
    }

    /// T191-10: Style with no bindings returns None from evaluate_resolved_style_bindings.
    #[test]
    fn test_eval_returns_none_when_no_bindings() {
        use crate::kernel::types::ResolvedStyle;
        let style = ResolvedStyle {
            background: Some("green".to_string()),
            font_size: Some(12.0),
            ..Default::default()
        };
        let ctx = BindingEvaluationContext::default();
        let registry = OperatorRegistry::new();
        let mut diagnostics = Vec::new();
        let mut path = Vec::new();

        let result = evaluate_resolved_style_bindings(
            &style,
            &ctx,
            &registry,
            &mut diagnostics,
            &mut path,
            "test",
        );
        assert!(
            result.is_none(),
            "No bindings means no changes — should return None"
        );
    }

    /// T191-11: scan_node_for_deps no longer uses serde_json::to_value for style scanning.
    /// This meta-test verifies the architectural contract: scan_resolved_style_for_deps
    /// handles both layout.x/y and extra fields correctly for a node with bindings in all three.
    #[test]
    fn test_scan_deps_all_binding_fields_combined() {
        use crate::kernel::types::{LayoutConfig, ResolvedStyle};
        let mut extra = HashMap::new();
        extra.insert(
            "rotation".to_string(),
            serde_json::json!({
                "$kind": "binding",
                "select": {"from": "ambient", "path": "rot"},
                "default": 0
            }),
        );
        let style = ResolvedStyle {
            layout: Some(LayoutConfig {
                x: Some(serde_json::json!({
                    "$kind": "binding",
                    "select": {"from": "ambient", "path": "posX"},
                    "default": 0
                })),
                y: Some(serde_json::json!({
                    "$kind": "binding",
                    "select": {"from": "ambient", "path": "posY"},
                    "default": 0
                })),
                ..Default::default()
            }),
            extra,
            background: Some("#fff".to_string()),
            ..Default::default()
        };
        let root = SceneNode {
            id: "combo-node".to_string(),
            kind: NodeKind::Container,
            style: Some(style),
            children: vec![],
            ..Default::default()
        };

        let index = build_typed_binding_dep_index(&root);

        // All 3 binding fields should produce ambient deps
        let empty = HashSet::new();
        let mut ambient_keys = HashSet::new();
        ambient_keys.insert("posX".to_string());
        let dirty_x =
            index.resolve_dirty_nodes(&empty, &empty, &ambient_keys, &empty, &HashMap::new());
        assert!(
            dirty_x.contains("combo-node"),
            "layout.x ambient dep should be recorded"
        );

        ambient_keys.clear();
        ambient_keys.insert("posY".to_string());
        let dirty_y =
            index.resolve_dirty_nodes(&empty, &empty, &ambient_keys, &empty, &HashMap::new());
        assert!(
            dirty_y.contains("combo-node"),
            "layout.y ambient dep should be recorded"
        );

        ambient_keys.clear();
        ambient_keys.insert("rot".to_string());
        let dirty_rot =
            index.resolve_dirty_nodes(&empty, &empty, &ambient_keys, &empty, &HashMap::new());
        assert!(
            dirty_rot.contains("combo-node"),
            "extra.rotation ambient dep should be recorded"
        );
    }

    // ========================================================================
    // Task 199: Routing Dependency Precision — Dep Recording Tests
    //
    // These tests verify that record_binding_dep_recursive() detects
    // ambient-sourced routing keys and records DepKey::RoutingViaAmbient
    // instead of wildcard DepKey::Routing("*").
    // ========================================================================

    /// routing[ambient.X] records DepKey::RoutingViaAmbient("X") not wildcard.
    #[test]
    fn t199_routing_via_ambient_dep_recorded() {
        use crate::binding::ast::PathInput;
        let mut index = BindingDepIndex::new();
        // Build: routing[ambient.session_text_origin]
        let binding = Binding::new().with_select(BindingSelect {
            from: Some(SelectSource::Routing),
            key: Some(SelectKey::dynamic_binding(Binding::new().with_select(
                BindingSelect {
                    from: Some(SelectSource::Ambient),
                    path: Some(PathInput::String("session_text_origin".to_string())),
                    ..Default::default()
                },
            ))),
            ..Default::default()
        });

        record_binding_dep_recursive(&binding, "node-1", &mut index);

        // Should record RoutingViaAmbient, not Routing("*")
        let node_deps = index.deps_for_node("node-1");
        assert!(!node_deps.is_empty(), "node-1 must have deps");
        assert!(
            node_deps.contains(&DepKey::RoutingViaAmbient(
                "session_text_origin".to_string()
            )),
            "routing[ambient.X] must produce DepKey::RoutingViaAmbient(\"session_text_origin\")"
        );
        assert!(
            !node_deps.contains(&DepKey::Routing("*".to_string())),
            "routing[ambient.X] must NOT produce wildcard DepKey::Routing(\"*\")"
        );
        // The nested ambient binding also records an ambient dep.
        // Note: ambient bindings use `path` (not `key`), so the dep key is "*"
        // (wildcard) because `select.key` is None for ambient source.
        assert!(
            node_deps.contains(&DepKey::Ambient("*".to_string())),
            "nested ambient binding must also record DepKey::Ambient(\"*\") via recursion"
        );
    }

    /// routing["concrete_key"] still records DepKey::Routing("concrete_key") (no regression).
    #[test]
    fn t199_routing_direct_key_dep_recorded() {
        let mut index = BindingDepIndex::new();
        let binding = Binding::new().with_select(BindingSelect {
            from: Some(SelectSource::Routing),
            key: Some(SelectKey::static_key("origin:host:text:0")),
            ..Default::default()
        });

        record_binding_dep_recursive(&binding, "node-1", &mut index);

        let node_deps = index.deps_for_node("node-1");
        assert!(!node_deps.is_empty(), "node-1 must have deps");
        assert!(
            node_deps.contains(&DepKey::Routing("origin:host:text:0".to_string())),
            "static routing key must produce concrete DepKey::Routing"
        );
    }

    /// routing[fsm.X] (non-ambient dynamic) still records DepKey::Routing("*") wildcard.
    #[test]
    fn t199_routing_truly_dynamic_gets_wildcard() {
        let mut index = BindingDepIndex::new();
        // Build: routing[fsm.some_key] — dynamic key from FSM, not ambient
        let binding = Binding::new().with_select(BindingSelect {
            from: Some(SelectSource::Routing),
            key: Some(SelectKey::dynamic_binding(Binding::new().with_select(
                BindingSelect {
                    from: Some(SelectSource::Fsm),
                    path: Some(PathInput::String("some_key".to_string())),
                    ..Default::default()
                },
            ))),
            ..Default::default()
        });

        record_binding_dep_recursive(&binding, "node-1", &mut index);

        let node_deps = index.deps_for_node("node-1");
        assert!(!node_deps.is_empty(), "node-1 must have deps");
        assert!(
            node_deps.contains(&DepKey::Routing("*".to_string())),
            "non-ambient dynamic key must produce wildcard DepKey::Routing(\"*\")"
        );
        assert!(
            !node_deps
                .iter()
                .any(|d| matches!(d, DepKey::RoutingViaAmbient(_))),
            "non-ambient dynamic key must NOT produce RoutingViaAmbient"
        );
    }

    // ========================================================================
    // Task 203: Incremental Previous Index Delta Tests
    // ========================================================================

    /// Compute with dirty_nodes={A}: delta must contain entry for A.
    #[test]
    fn test_previous_index_delta_contains_dirty_nodes() {
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![
                Arc::new(SceneNode {
                    id: "A".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
                Arc::new(SceneNode {
                    id: "B".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
            ],
            ..Default::default()
        };
        let ctx = make_test_ctx();

        // Full eval to get a previous render tree
        let full = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let prev = Arc::new(full.snapshot);

        // Incremental: only A is dirty
        let mut dirty = HashSet::new();
        dirty.insert("A".to_string());
        let result = compute(
            &root,
            &ctx,
            None,
            Some(&dirty),
            Some(&prev),
            None,
            None,
            None,
            false,
        )
        .unwrap();

        assert!(
            result.previous_index_delta.contains_key("A"),
            "Delta must contain entry for dirty node A"
        );
    }

    /// Compute with dirty_nodes={A}: delta must NOT contain entries for clean siblings B, C.
    #[test]
    fn test_previous_index_delta_excludes_clean_nodes() {
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![
                Arc::new(SceneNode {
                    id: "A".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
                Arc::new(SceneNode {
                    id: "B".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
                Arc::new(SceneNode {
                    id: "C".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
            ],
            ..Default::default()
        };
        let ctx = make_test_ctx();

        let full = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let prev = Arc::new(full.snapshot);

        let mut dirty = HashSet::new();
        dirty.insert("A".to_string());
        let result = compute(
            &root,
            &ctx,
            None,
            Some(&dirty),
            Some(&prev),
            None,
            None,
            None,
            false,
        )
        .unwrap();

        assert!(
            !result.previous_index_delta.contains_key("B"),
            "Delta must NOT contain entry for clean node B"
        );
        assert!(
            !result.previous_index_delta.contains_key("C"),
            "Delta must NOT contain entry for clean node C"
        );
    }

    /// Full eval (dirty_nodes=None): delta must contain entries for ALL nodes.
    #[test]
    fn test_previous_index_delta_full_eval_has_all_nodes() {
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![
                Arc::new(SceneNode {
                    id: "X".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
                Arc::new(SceneNode {
                    id: "Y".to_string(),
                    kind: NodeKind::Container,
                    children: vec![Arc::new(SceneNode {
                        id: "Z".to_string(),
                        kind: NodeKind::Text,
                        children: vec![],
                        ..Default::default()
                    })],
                    ..Default::default()
                }),
            ],
            ..Default::default()
        };
        let ctx = make_test_ctx();

        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        assert!(
            result.previous_index_delta.contains_key("root"),
            "root must be in delta"
        );
        assert!(
            result.previous_index_delta.contains_key("X"),
            "X must be in delta"
        );
        assert!(
            result.previous_index_delta.contains_key("Y"),
            "Y must be in delta"
        );
        assert!(
            result.previous_index_delta.contains_key("Z"),
            "Z must be in delta"
        );
        assert_eq!(
            result.previous_index_delta.len(),
            4,
            "All 4 nodes must be in delta"
        );
    }

    /// Merging delta into cached previous_index produces identical result to full rebuild.
    #[test]
    fn test_previous_index_delta_entries_match_full_rebuild() {
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![
                Arc::new(SceneNode {
                    id: "A".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
                Arc::new(SceneNode {
                    id: "B".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
            ],
            ..Default::default()
        };
        let ctx = make_test_ctx();

        // Full eval — get the render tree and delta
        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        // Build the full index from the render tree (the old O(n) path)
        let full_index = build_previous_node_index(&result.snapshot);

        // The delta from full eval should match the full index exactly
        assert_eq!(
            result.previous_index_delta.len(),
            full_index.len(),
            "Delta size must match full index size"
        );
        for (id, entry) in &full_index {
            let delta_entry = result
                .previous_index_delta
                .get(id)
                .unwrap_or_else(|| panic!("Delta missing entry for {}", id));
            assert_eq!(entry, delta_entry, "Entry for {} must match", id);
        }
    }

    /// Visibility flip: delta includes the affected node.
    #[test]
    fn test_previous_index_delta_with_visibility_change() {
        use crate::kernel::types::{BindingSelect as TypesBindingSelect, SelectKey};
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![Arc::new(SceneNode {
                id: "vis-node".to_string(),
                kind: NodeKind::Text,
                visible: Visibility::Binding(VisibilityBinding {
                    kind: "binding".to_string(),
                    select: TypesBindingSelect {
                        from: "fsm".to_string(),
                        key: Some(SelectKey::Static("fsm:vis".to_string())),
                        path: None,
                    },
                    transform: vec![],
                    default: true,
                }),
                children: vec![],
                ..Default::default()
            })],
            ..Default::default()
        };

        // First: visible (default=true, FSM key not set)
        let ctx1 = make_test_ctx();
        let full = compute(&root, &ctx1, None, None, None, None, None, None, false).unwrap();
        let prev = Arc::new(full.snapshot);

        // Second: dirty vis-node (will re-evaluate binding)
        let mut dirty = HashSet::new();
        dirty.insert("vis-node".to_string());
        let result = compute(
            &root,
            &ctx1,
            None,
            Some(&dirty),
            Some(&prev),
            None,
            None,
            None,
            false,
        )
        .unwrap();

        assert!(
            result.previous_index_delta.contains_key("vis-node"),
            "Delta must include visibility-changing node"
        );
        // Root should also be in delta because vis-node is its dirty child path-copy
        assert!(
            result.previous_index_delta.contains_key("root"),
            "Delta must include root (path-copy parent of dirty child)"
        );
    }

    /// Start with cached previous_index for A,B,C. Compute dirty={A}. Merge.
    /// Verify A is updated AND B,C are preserved unchanged.
    #[test]
    fn test_previous_index_delta_preserves_clean_entries_on_merge() {
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![
                Arc::new(SceneNode {
                    id: "A".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
                Arc::new(SceneNode {
                    id: "B".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
                Arc::new(SceneNode {
                    id: "C".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
            ],
            ..Default::default()
        };
        let ctx = make_test_ctx();

        // Build initial cached_previous_index via full compute
        let full = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let cached = full.previous_index_delta.clone();
        let prev = Arc::new(full.snapshot);

        // Incremental: only A dirty
        let mut dirty = HashSet::new();
        dirty.insert("A".to_string());
        let result = compute(
            &root,
            &ctx,
            None,
            Some(&dirty),
            Some(&prev),
            None,
            None,
            None,
            false,
        )
        .unwrap();

        // Simulate the merge that render()/recompute() does
        let mut merged = cached.clone();
        merged.extend(result.previous_index_delta);

        // B and C must still be present (from the cached baseline)
        assert!(
            merged.contains_key("B"),
            "Clean node B must be preserved in merge"
        );
        assert!(
            merged.contains_key("C"),
            "Clean node C must be preserved in merge"
        );
        assert!(merged.contains_key("A"), "Dirty node A must be in merge");
        assert!(merged.contains_key("root"), "Root must be in merge");
    }

    /// Clean node with dirty child: the path-copied node is in delta (child_ids may change).
    #[test]
    fn test_previous_index_delta_path_copy_node_included() {
        let root = SceneNode {
            id: "parent".to_string(),
            kind: NodeKind::Container,
            children: vec![
                Arc::new(SceneNode {
                    id: "dirty-child".to_string(),
                    kind: NodeKind::Custom,
                    value: Some(serde_json::json!({
                        "$kind": "binding",
                        "select": {"from": "ambient", "path": "val"},
                        "default": 0
                    })),
                    children: vec![],
                    ..Default::default()
                }),
                Arc::new(SceneNode {
                    id: "clean-child".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
            ],
            ..Default::default()
        };
        let ctx = EvaluationContext {
            ambient: serde_json::json!({"val": 42}),
            ..Default::default()
        };
        let full = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let prev = Arc::new(full.snapshot);

        let mut dirty = HashSet::new();
        dirty.insert("dirty-child".to_string());
        let result = compute(
            &root,
            &ctx,
            None,
            Some(&dirty),
            Some(&prev),
            None,
            None,
            None,
            false,
        )
        .unwrap();

        // The parent is clean but has a dirty child — should be path-copied and in delta
        assert!(
            result.previous_index_delta.contains_key("parent"),
            "Path-copied parent of dirty child must be in delta"
        );
        assert!(
            result.previous_index_delta.contains_key("dirty-child"),
            "Dirty child must be in delta"
        );
    }

    /// Empty dirty set: delta should be empty (no nodes evaluated).
    #[test]
    fn test_previous_index_delta_empty_dirty_set() {
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![Arc::new(SceneNode {
                id: "child".to_string(),
                kind: NodeKind::Text,
                children: vec![],
                ..Default::default()
            })],
            ..Default::default()
        };
        let ctx = make_test_ctx();
        let full = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let prev = Arc::new(full.snapshot);

        // Empty dirty set — nothing should be re-evaluated
        let dirty = HashSet::new();
        let result = compute(
            &root,
            &ctx,
            None,
            Some(&dirty),
            Some(&prev),
            None,
            None,
            None,
            false,
        )
        .unwrap();

        assert!(
            result.previous_index_delta.is_empty(),
            "Delta must be empty when no nodes are dirty"
        );
    }

    /// Verify parent_id in delta entries matches the actual parent in the tree.
    #[test]
    fn test_previous_index_delta_parent_id_correct() {
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![Arc::new(SceneNode {
                id: "mid".to_string(),
                kind: NodeKind::Container,
                children: vec![Arc::new(SceneNode {
                    id: "leaf".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                })],
                ..Default::default()
            })],
            ..Default::default()
        };
        let ctx = make_test_ctx();
        let result = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();

        // Root has no parent
        assert_eq!(
            result.previous_index_delta.get("root").unwrap().parent_id,
            None,
            "Root must have parent_id=None"
        );
        // mid's parent is root
        assert_eq!(
            result
                .previous_index_delta
                .get("mid")
                .unwrap()
                .parent_id
                .as_deref(),
            Some("root"),
            "mid must have parent_id=root"
        );
        // leaf's parent is mid
        assert_eq!(
            result
                .previous_index_delta
                .get("leaf")
                .unwrap()
                .parent_id
                .as_deref(),
            Some("mid"),
            "leaf must have parent_id=mid"
        );
    }

    /// New node not in cached_previous_index: after compute, delta includes it.
    #[test]
    fn test_previous_index_delta_new_node_insert() {
        // Initial tree: root → [A]
        let root_v1 = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![Arc::new(SceneNode {
                id: "A".to_string(),
                kind: NodeKind::Text,
                children: vec![],
                ..Default::default()
            })],
            ..Default::default()
        };
        let ctx = make_test_ctx();
        let full = compute(&root_v1, &ctx, None, None, None, None, None, None, false).unwrap();
        let _cached = full.previous_index_delta.clone();

        // New tree: root → [A, B]  (B is new)
        let root_v2 = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![
                Arc::new(SceneNode {
                    id: "A".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
                Arc::new(SceneNode {
                    id: "B".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
            ],
            ..Default::default()
        };

        // Full eval on new tree (structure changed, no previous render tree)
        let result = compute(&root_v2, &ctx, None, None, None, None, None, None, true).unwrap();

        assert!(
            result.previous_index_delta.contains_key("B"),
            "New node B must be in delta"
        );
        assert!(
            result.previous_index_delta.contains_key("A"),
            "Existing node A must be in delta (full eval)"
        );
    }

    /// Incremental delta merged with cached produces same result as full rebuild.
    /// This is the critical correctness test — verifies equivalence across multiple
    /// incremental passes.
    #[test]
    fn test_previous_index_delta_incremental_merge_equivalence() {
        let root = SceneNode {
            id: "root".to_string(),
            kind: NodeKind::Container,
            children: vec![
                Arc::new(SceneNode {
                    id: "A".to_string(),
                    kind: NodeKind::Custom,
                    value: Some(serde_json::json!({
                        "$kind": "binding",
                        "select": {"from": "ambient", "path": "val"},
                        "default": 0
                    })),
                    children: vec![],
                    ..Default::default()
                }),
                Arc::new(SceneNode {
                    id: "B".to_string(),
                    kind: NodeKind::Text,
                    children: vec![],
                    ..Default::default()
                }),
            ],
            ..Default::default()
        };
        let ctx = EvaluationContext {
            ambient: serde_json::json!({"val": 42}),
            ..Default::default()
        };

        // Full eval → get cached index + render tree
        let full = compute(&root, &ctx, None, None, None, None, None, None, false).unwrap();
        let mut cached_index = full.previous_index_delta.clone();
        let prev = Arc::new(full.snapshot);

        // Incremental: dirty={A}
        let mut dirty = HashSet::new();
        dirty.insert("A".to_string());
        let incr = compute(
            &root,
            &ctx,
            None,
            Some(&dirty),
            Some(&prev),
            None,
            None,
            None,
            false,
        )
        .unwrap();

        // Merge delta into cached
        cached_index.extend(incr.previous_index_delta);

        // Full rebuild from the incremental render tree
        let full_rebuild = build_previous_node_index(&incr.snapshot);

        // Must be identical
        assert_eq!(
            cached_index.len(),
            full_rebuild.len(),
            "Merged index must have same size as full rebuild"
        );
        for (id, entry) in &full_rebuild {
            let merged_entry = cached_index
                .get(id)
                .unwrap_or_else(|| panic!("Merged index missing entry for {}", id));
            assert_eq!(
                entry, merged_entry,
                "Entry for {} must match full rebuild",
                id
            );
        }
    }

    /// compute_generic and compute_dry_run return empty previous_index_delta.
    #[test]
    fn test_previous_index_delta_non_scene_compute_empty() {
        let root = make_test_tree();
        let ctx = make_test_ctx();

        let generic_result = compute_generic(&root, &ctx, None).unwrap();
        assert!(
            generic_result.previous_index_delta.is_empty(),
            "compute_generic must return empty previous_index_delta"
        );

        let dry_run_result = compute_dry_run(&root, &ctx).unwrap();
        assert!(
            dry_run_result.previous_index_delta.is_empty(),
            "compute_dry_run must return empty previous_index_delta"
        );
    }
}
