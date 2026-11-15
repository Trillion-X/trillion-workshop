//! crates/composition-engine-core/src/binding/evaluator.rs
//!
//! # Pure Binding Evaluator for the Universal UI Kernel
//!
//! Given a Binding AST, an input value, an evaluation context, and an operator resolver,
//! this module deterministically computes a final value. **No I/O, no async, no global state.**
//!
//! ## Purpose
//!
//! The evaluator is the **heart of the binding system**. It takes pure declarative bindings
//! and produces concrete values by:
//! 1. **Selecting** initial data from context (self, ambient, dataSource, vars, fsm, routing)
//! 2. **Transforming** via a pipeline of pure operators
//! 3. **Defaulting** when the result is null
//!
//! ## Non-Negotiable Invariants
//!
//! 1. **Deterministic**: `equal(binding, input, context) → equal(output)`. Always.
//! 2. **Total**: Never panics for user mistakes; returns structured diagnostics.
//! 3. **Pure**: Does not mutate inputs; returns fresh values.
//! 4. **Select discipline**: Selection stage establishes the pipeline seed value.
//! 5. **Routing is Physics**: `SelectSource::Routing` queries routing state directly.
//! 6. **Dynamic refs are resolved lazily**: Only when the key is actually needed.
//!
//! ## Key Concepts
//!
//! | Concept | Description |
//! |---------|-------------|
//! | Selection | `binding.select` chooses from self, ambient, vars, dataSource, fsm, routing |
//! | Dynamic Key | Nested binding evaluated via recursive `evaluate_binding()` |
//! | Transform Pipeline | Each step is a pure Operator application |
//! | Defaulting | `binding.default` applied only for `null` values |
//!
//! ## Evaluation Flow
//!
//! ```text
//! Binding + Input + Context
//!           │
//!           ▼
//! ┌─────────────────────────────────────────┐
//! │  1. Validate binding shape              │
//! │  2. resolve_selection() → seed value    │
//! │     - Static path/key: direct lookup    │
//! │     - Dynamic key: recursive binding eval│
//! │  3. Apply transform pipeline            │
//! │  4. Apply default if null               │
//! └─────────────────────────────────────────┘
//!           │
//!           ▼
//!    EvaluationResult { value, diagnostics }
//! ```
//!
//! ## Security Considerations
//!
//! - **No dynamic eval or code generation**: Operator set is explicit and closed.
//! - **Bounded evaluation**: Dynamic keys use full binding evaluation with all safeguards.
//! - **Fail-safe defaults**: Missing data returns null, not errors.
//! - **Operator isolation**: Each operator is sandboxed with its own context.
//!
//! ## AI Assistant Directive
//!
//! **CRITICAL: The extensive, granular documentation in this codebase is a critical design feature.**
//! **You are FORBIDDEN from simplifying or removing it.**
//! **Your mandate is to MAINTAIN and EXTEND this level of meticulous detail.**
//!
//! Ported from: frontends/web/composition-engine/binding/evaluator.ts

use super::ast::{
    Binding, BindingEvaluationContext, BindingSelect, Diagnostic, DiagnosticCode, DiagnosticLevel,
    Path, PathInput, PathSegment, SelectKey, SelectSource, BINDING_KIND,
};
use super::operators::registry::{OperatorContext, OperatorRegistry, OperatorResolver};
use super::path::{get_at_path, parse_path, GetOptions};
use super::validator::validate_binding_shape;
use ops_core::OpValue;
use std::sync::Arc;

// ============================================================================
// Types
// ============================================================================

/// Options for evaluation
#[derive(Debug, Clone, Default)]
pub struct EvaluationOptions {
    /// If true, perform validation only and skip execution. Default false.
    pub dry_run: bool,
}

/// Result of binding evaluation
#[derive(Debug, Clone)]
pub struct EvaluationResult {
    pub value: serde_json::Value,
    pub diagnostics: Vec<Diagnostic>,
}

impl Default for EvaluationResult {
    fn default() -> Self {
        Self {
            value: serde_json::Value::Null,
            diagnostics: Vec::new(),
        }
    }
}

// ============================================================================
// Nested Binding Evaluation (Canonical Solution)
// ============================================================================

/// Recursively evaluate nested bindings in a JSON value.
///
/// # Purpose
///
/// Transform operator args may contain nested binding ASTs that need to be
/// evaluated before the operator can use them. This is the CANONICAL location
/// for this logic - it happens ONCE, in the evaluator, not scattered across callers.
///
/// # Pattern Handled
///
/// ```json
/// {"op": "op:math.add", "args": {"value": {"$kind": "binding", "select": {...}}}}
/// ```
///
/// The inner `{"$kind": "binding", ...}` is evaluated first, producing a concrete
/// value that the math operator can use.
///
/// # Non-Negotiable Invariants
///
/// 1. **Recursive**: Nested bindings at any depth are evaluated.
/// 2. **Deterministic**: Same input → same output.
/// 3. **Total**: Returns original value on any error (fail-safe).
fn evaluate_nested_bindings(
    value: &serde_json::Value,
    input: &serde_json::Value,
    ctx: &BindingEvaluationContext,
    registry: &OperatorRegistry,
) -> serde_json::Value {
    match value {
        // Check if this object is a binding AST
        serde_json::Value::Object(obj) => {
            if obj.get("$kind").and_then(|v| v.as_str()) == Some(BINDING_KIND) {
                // This is a binding - evaluate it
                if let Ok(binding) = serde_json::from_value::<Binding>(value.clone()) {
                    let result = evaluate_binding(&binding, input, ctx, registry, None);
                    return result.value;
                }
            }
            // Not a binding - recursively process object fields
            let mut new_obj = serde_json::Map::new();
            for (k, v) in obj {
                new_obj.insert(k.clone(), evaluate_nested_bindings(v, input, ctx, registry));
            }
            serde_json::Value::Object(new_obj)
        }
        // Recursively process arrays
        serde_json::Value::Array(arr) => {
            let new_arr: Vec<serde_json::Value> = arr
                .iter()
                .map(|v| evaluate_nested_bindings(v, input, ctx, registry))
                .collect();
            serde_json::Value::Array(new_arr)
        }
        // Primitives pass through unchanged
        other => other.clone(),
    }
}

/// Recursively evaluate nested bindings using a resolver function.
///
/// Same as `evaluate_nested_bindings` but uses a resolver closure instead of registry.
fn evaluate_nested_bindings_with_resolver(
    value: &serde_json::Value,
    input: &serde_json::Value,
    ctx: &BindingEvaluationContext,
    resolver: &OperatorResolver,
) -> serde_json::Value {
    match value {
        serde_json::Value::Object(obj) => {
            if obj.get("$kind").and_then(|v| v.as_str()) == Some(BINDING_KIND) {
                if let Ok(binding) = serde_json::from_value::<Binding>(value.clone()) {
                    #[cfg(feature = "verbose-logging")]
                    {
                        let source = binding.select.as_ref().and_then(|s| s.from.as_ref());
                        let key = binding.select.as_ref().and_then(|s| s.key.as_ref());
                        let vars_keys: Vec<_> = ctx.vars.keys().collect();
                        eprintln!(
                            "[NESTED_EVAL] Binding from={:?} key={:?} | ctx.vars keys={:?}",
                            source, key, vars_keys
                        );
                    }
                    let result =
                        evaluate_binding_with_resolver(&binding, input, ctx, resolver, None);
                    #[cfg(feature = "verbose-logging")]
                    eprintln!(
                        "[NESTED_EVAL] Result: {}",
                        serde_json::to_string(&result.value).unwrap_or_default()
                    );
                    return result.value;
                }
            }
            let mut new_obj = serde_json::Map::new();
            for (k, v) in obj {
                new_obj.insert(
                    k.clone(),
                    evaluate_nested_bindings_with_resolver(v, input, ctx, resolver),
                );
            }
            serde_json::Value::Object(new_obj)
        }
        serde_json::Value::Array(arr) => {
            let new_arr: Vec<serde_json::Value> = arr
                .iter()
                .map(|v| evaluate_nested_bindings_with_resolver(v, input, ctx, resolver))
                .collect();
            serde_json::Value::Array(new_arr)
        }
        other => other.clone(),
    }
}

// ============================================================================
// Partial Evaluation (1000x Canonical Solution)
// ============================================================================

/// Partially evaluate a runtime-only binding to normalize nested static bindings.
///
/// # 1000x Pedigree: CANONICAL PARTIAL EVALUATION (Single Source of Truth)
///
/// This is THE CANONICAL and ONLY implementation of partial evaluation.
/// When a binding has a runtime-only source (scene, routing, fsm, state, context),
/// we preserve it as AST but FIRST resolve all nested static bindings.
///
/// ## What Gets Resolved
///
/// | Field | Nested Binding Type | Action |
/// |-------|---------------------|--------|
/// | `select.key` | Static source (vars, ambient) | Evaluate to string, use as Static key |
/// | `select.key` | Runtime source (routing, scene) | Keep as Dynamic binding |
/// | `default` | Any binding | Recursively evaluate (may contain more bindings) |
/// | `transform[].args` | Any binding | Recursively evaluate args |
///
/// ## Why This Matters
///
/// Iteration variables (`$item`, `$index`) only exist during projection. If we
/// preserve bindings wholesale, the kernel receives `$item` references that don't
/// exist at runtime. Partial evaluation "bakes in" these ephemeral values.
///
/// ## Non-Negotiable Invariants
///
/// 1. **Single Implementation**: This is THE ONLY place partial evaluation happens.
/// 2. **Callback-Based**: Uses generic callback for nested evaluation (DRY).
/// 3. **Recursive**: Handles arbitrarily nested bindings.
/// 4. **Preserves Runtime**: Runtime-only nested bindings stay as AST.
fn partially_evaluate_binding_core<EvalBinding, EvalNested>(
    binding: &Binding,
    eval_binding: &EvalBinding,
    eval_nested: &EvalNested,
) -> EvaluationResult
where
    EvalBinding: Fn(&Binding) -> EvaluationResult,
    EvalNested: Fn(&serde_json::Value) -> serde_json::Value,
{
    use super::ast::TransformStep;

    // Clone the binding to create a normalized version
    let mut normalized = binding.clone();

    // A. Partially evaluate select.key (if dynamic)
    if let Some(ref mut select) = normalized.select {
        if let Some(SelectKey::Dynamic(ref inner_binding)) = select.key {
            // Recursively evaluate the nested key binding
            let result = eval_binding(inner_binding);

            if is_binding_value(&result.value) {
                // Still a binding (runtime-only nested inside) - keep as Dynamic
                if let Ok(inner_ast) = serde_json::from_value::<Binding>(result.value) {
                    select.key = Some(SelectKey::Dynamic(Box::new(inner_ast)));
                }
            } else {
                // Resolved to a concrete value - promote to Static key
                match &result.value {
                    serde_json::Value::String(s) => {
                        select.key = Some(SelectKey::Static(s.clone()));
                    }
                    serde_json::Value::Null => {
                        // Null key - leave as is
                    }
                    other => {
                        // Non-string value - convert to string for key
                        select.key = Some(SelectKey::Static(
                            other.to_string().trim_matches('"').to_string(),
                        ));
                    }
                }
            }
        }
    }

    // B. Partially evaluate default value
    if let Some(ref default_val) = binding.default {
        let evaluated_default = eval_nested(default_val);
        normalized.default = Some(evaluated_default);
    }

    // C. Partially evaluate transform args
    if let Some(ref transforms) = binding.transform {
        let mut normalized_transforms: Vec<TransformStep> = Vec::new();
        for step in transforms {
            let mut normalized_step = step.clone();
            if let Some(ref args) = step.args {
                // Convert to JSON and evaluate nested bindings
                let args_json = serde_json::to_value(args).unwrap_or(serde_json::Value::Null);
                #[cfg(feature = "verbose-logging")]
                eprintln!(
                    "[PARTIAL_EVAL] Op {} args BEFORE: {}",
                    step.op,
                    serde_json::to_string(&args_json).unwrap_or_default()
                );
                let evaluated_args = eval_nested(&args_json);
                #[cfg(feature = "verbose-logging")]
                eprintln!(
                    "[PARTIAL_EVAL] Op {} args AFTER: {}",
                    step.op,
                    serde_json::to_string(&evaluated_args).unwrap_or_default()
                );
                // Convert back to HashMap
                if let serde_json::Value::Object(map) = evaluated_args {
                    let mut new_args = std::collections::HashMap::new();
                    for (k, v) in map {
                        new_args.insert(k, v);
                    }
                    normalized_step.args = Some(new_args);
                }
            }
            normalized_transforms.push(normalized_step);
        }
        normalized.transform = Some(normalized_transforms);
    }

    // Return the normalized binding as AST
    let binding_json = serde_json::to_value(&normalized).unwrap_or(serde_json::Value::Null);
    EvaluationResult {
        value: binding_json,
        diagnostics: Vec::new(),
    }
}

/// Check if a JSON value is a binding AST
fn is_binding_value(value: &serde_json::Value) -> bool {
    value
        .get("$kind")
        .and_then(|k| k.as_str())
        .map(|k| k == BINDING_KIND)
        .unwrap_or(false)
}

/// Partial evaluation wrapper for registry-based evaluation.
/// Delegates to `partially_evaluate_binding_core` with registry callbacks.
fn partially_evaluate_binding(
    binding: &Binding,
    input: &serde_json::Value,
    ctx: &BindingEvaluationContext,
    registry: &OperatorRegistry,
) -> EvaluationResult {
    let eval_binding = |b: &Binding| evaluate_binding(b, input, ctx, registry, None);
    let eval_nested = |v: &serde_json::Value| evaluate_nested_bindings(v, input, ctx, registry);
    partially_evaluate_binding_core(binding, &eval_binding, &eval_nested)
}

/// Partial evaluation wrapper for resolver-based evaluation.
/// Delegates to `partially_evaluate_binding_core` with resolver callbacks.
fn partially_evaluate_binding_with_resolver(
    binding: &Binding,
    input: &serde_json::Value,
    ctx: &BindingEvaluationContext,
    resolver: &OperatorResolver,
) -> EvaluationResult {
    let eval_binding = |b: &Binding| evaluate_binding_with_resolver(b, input, ctx, resolver, None);
    let eval_nested =
        |v: &serde_json::Value| evaluate_nested_bindings_with_resolver(v, input, ctx, resolver);
    partially_evaluate_binding_core(binding, &eval_binding, &eval_nested)
}

// ============================================================================
// Defaulting (Canonical Single Source of Truth)
// ============================================================================

/// Apply default value with nested binding evaluation.
///
/// # Purpose
///
/// This is THE CANONICAL location for default value resolution. When a binding
/// evaluates to null, the default is applied. The default itself may contain
/// nested bindings (e.g., `{"$kind": "binding", "select": {...}}`) which must
/// be evaluated before returning.
///
/// # Non-Negotiable Invariants
///
/// 1. **Single Source of Truth**: ALL default resolution goes through this function.
/// 2. **Nested Binding Support**: Defaults like `{"$kind": "binding", ...}` are evaluated.
/// 3. **Null-Only**: Defaults only apply when the value is null (not missing/undefined).
/// 4. **Pure**: No side effects; deterministic output for same inputs.
///
/// # Arguments
///
/// * `value` - The current value (mutated in place if null and default exists)
/// * `default` - Optional default value (may be a binding or static value)
/// * `eval_nested` - Closure that evaluates nested bindings in the default
///
/// # Example
///
/// ```ignore
/// apply_default_with_eval(&mut value, binding.default.as_ref(), |v| {
///     evaluate_nested_bindings(v, input, ctx, registry)
/// });
/// ```
fn apply_default_with_eval<F>(
    value: &mut serde_json::Value,
    default: Option<&serde_json::Value>,
    eval_nested: F,
) where
    F: FnOnce(&serde_json::Value) -> serde_json::Value,
{
    if value.is_null() {
        if let Some(default_val) = default {
            *value = eval_nested(default_val);
        }
    }
}

// ============================================================================
// Selection
// ============================================================================

/// Convert path input to canonical Path
fn to_path(input: &PathInput) -> Result<Path, String> {
    match input {
        PathInput::Array(p) => Ok(p.clone()),
        PathInput::String(s) => parse_path(s),
    }
}

/// Resolve a SelectKey to get the actual key string (static keys only).
///
/// For static keys, returns the key directly.
/// For dynamic keys (nested bindings), returns None - use `resolve_select_key_full` instead.
///
/// # Arguments
/// * `key` - The SelectKey (static or dynamic)
///
/// # Returns
/// The resolved key string, or None if:
/// - Key is dynamic (requires registry to evaluate)
fn resolve_select_key_static(key: &SelectKey) -> Option<String> {
    match key {
        SelectKey::Static(s) => Some(s.clone()),
        SelectKey::Dynamic(_) => None, // Requires registry to evaluate
    }
}

/// Resolve a SelectKey to get the actual key string, with full binding evaluation support.
///
/// For static keys, returns the key directly.
/// For dynamic keys (nested bindings), recursively evaluates the nested binding.
///
/// # Arguments
/// * `key` - The SelectKey (static or dynamic)
/// * `input` - The input value for nested binding evaluation
/// * `ctx` - The evaluation context
/// * `registry` - The operator registry for nested binding evaluation
///
/// # Returns
/// The resolved key string, or None if:
/// - Nested binding evaluation failed
/// - Nested binding resolved to null
/// - Nested binding result is not a string
fn resolve_select_key_full(
    key: &SelectKey,
    input: &serde_json::Value,
    ctx: &BindingEvaluationContext,
    registry: &OperatorRegistry,
) -> Option<String> {
    match key {
        SelectKey::Static(s) => Some(s.clone()),
        SelectKey::Dynamic(binding) => {
            // Recursively evaluate the nested binding
            let result = evaluate_binding(binding, input, ctx, registry, None);

            // Coerce to string for use as lookup key
            match result.value {
                serde_json::Value::String(s) => Some(s),
                serde_json::Value::Null => None,
                // For non-string values, serialize to string for lookup
                other => Some(other.to_string()),
            }
        }
    }
}

/// Resolve a SelectKey using a resolver function for dynamic keys.
///
/// For static keys, returns the key directly.
/// For dynamic keys (nested bindings), recursively evaluates using the resolver.
fn resolve_select_key_with_resolver(
    key: &SelectKey,
    input: &serde_json::Value,
    ctx: &BindingEvaluationContext,
    resolver: &OperatorResolver,
) -> Option<String> {
    match key {
        SelectKey::Static(s) => Some(s.clone()),
        SelectKey::Dynamic(binding) => {
            // Recursively evaluate the nested binding
            let result = evaluate_binding_with_resolver(binding, input, ctx, resolver, None);

            // Coerce to string for use as lookup key
            match result.value {
                serde_json::Value::String(s) => Some(s),
                serde_json::Value::Null => None,
                other => Some(other.to_string()),
            }
        }
    }
}

/// Resolve the initial pipeline value.
///
/// Supported sources:
/// - self: the `input` argument
/// - ambient: from `ctx.ambient` by path (optional)
/// - literal: `select.value` verbatim
/// - vars: from `ctx.vars` by path (optional)
/// - dataSource: from `ctx.data_sources` by key/path (optional)
///
/// If `select` is omitted, the seed is `input`.
pub fn resolve_selection(
    select: Option<&BindingSelect>,
    input: &serde_json::Value,
    ctx: &BindingEvaluationContext,
) -> serde_json::Value {
    let select = match select {
        Some(s) => s,
        None => return input.clone(),
    };

    let source = select.from.unwrap_or(SelectSource::SelfSource);
    let path = select.path.as_ref().and_then(|p| to_path(p).ok());

    match source {
        SelectSource::SelfSource => {
            if let Some(ref path) = path {
                let result = get_at_path(input, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                input.clone()
            }
        }
        SelectSource::Ambient => {
            let ambient = serde_json::to_value(&ctx.ambient).unwrap_or(serde_json::Value::Null);
            if let Some(ref path) = path {
                let result = get_at_path(&ambient, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                ambient
            }
        }
        SelectSource::Vars => {
            // Vars supports key to select which var, then path to navigate within it
            // Example: {"from": "vars", "key": "$item", "path": "id"}
            //   -> vars["$item"]["id"]
            let vars = serde_json::to_value(&ctx.vars).unwrap_or(serde_json::Value::Null);

            // First, resolve the key if present (static only in this function)
            let base_value = if let Some(ref key) = select.key {
                match resolve_select_key_static(key) {
                    Some(resolved_key) => {
                        // Get the specific var by key
                        vars.get(&resolved_key)
                            .cloned()
                            .unwrap_or(serde_json::Value::Null)
                    }
                    None => serde_json::Value::Null, // Dynamic key - needs registry
                }
            } else {
                // No key - use entire vars object
                vars
            };

            // Then navigate by path if present
            if let Some(ref path) = path {
                let result = get_at_path(&base_value, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                base_value
            }
        }
        SelectSource::DataSource => {
            // Resolve the key (static only - dynamic keys require resolve_selection_full)
            let key = match &select.key {
                Some(k) => match resolve_select_key_static(k) {
                    Some(resolved) => resolved,
                    None => return serde_json::Value::Null, // Dynamic key - needs registry
                },
                None => return serde_json::Value::Null,
            };

            let payload = ctx
                .data_sources
                .get(&key)
                .cloned()
                .unwrap_or(serde_json::Value::Null);

            if let Some(ref path) = path {
                let result = get_at_path(&payload, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                payload
            }
        }
        SelectSource::Literal => select.value.clone().unwrap_or(serde_json::Value::Null),
        SelectSource::Fsm => {
            let fsm = serde_json::to_value(&ctx.fsm).unwrap_or(serde_json::Value::Null);
            if let Some(ref path) = path {
                let result = get_at_path(&fsm, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                fsm
            }
        }
        SelectSource::Routing => {
            // Routing source: look up routes by origin ID
            //
            // The key can be:
            // 1. A static path: { "from": "routing", "path": "keyboard:0" }
            // 2. A dynamic key (nested binding): requires resolve_selection_full
            //
            // This function only handles static keys. For dynamic keys, use resolve_selection_full.

            // Determine the lookup key
            let lookup_key: Option<String> = if let Some(ref key) = select.key {
                // Static or dynamic key provided (dynamic returns None here)
                resolve_select_key_static(key)
            } else if let Some(ref path_input) = select.path {
                // Static path provided (treated as the origin ID directly)
                match path_input {
                    PathInput::String(s) => Some(s.clone()),
                    PathInput::Array(segments) => {
                        // Join path segments as the key
                        let key: String = segments
                            .iter()
                            .filter_map(|seg| match seg {
                                PathSegment::Key(k) => Some(k.as_str()),
                                PathSegment::Index(_) => None,
                            })
                            .collect::<Vec<_>>()
                            .join(".");
                        if key.is_empty() {
                            None
                        } else {
                            Some(key)
                        }
                    }
                }
            } else {
                // No key or path - return null (need a key to lookup)
                None
            };

            // Look up the route
            let result = match &lookup_key {
                Some(origin_id) => match ctx.routing.get(origin_id) {
                    Some(target_id) => serde_json::json!(target_id),
                    None => serde_json::Value::Null,
                },
                None => serde_json::Value::Null,
            };

            result
        }
        SelectSource::State => {
            // State source: look up kernel state by path
            //
            // Example 1: { "from": "state", "path": "selected_node" }
            //   Returns the value stored in ctx.state["selected_node"]
            //
            // Example 2: { "from": "state", "path": "popover_position.x" }
            //   Gets ctx.state["popover_position"], then navigates to ".x"
            //   This supports nested state values like {x: 100, y: 200}

            let path = select.path.as_ref();
            if let Some(path_input) = path {
                // Parse the path string into segments
                let path_segments: Path = match path_input {
                    PathInput::String(s) => {
                        // Parse dotted string like "popover_position.x" into ["popover_position", "x"]
                        match parse_path(s) {
                            Ok(segments) => segments,
                            Err(_) => {
                                // Parse error - return null
                                return serde_json::Value::Null;
                            }
                        }
                    }
                    PathInput::Array(segments) => segments.clone(),
                };

                if path_segments.is_empty() {
                    // Empty path - return entire state object
                    return serde_json::json!(ctx.state);
                }

                // First segment is the state key
                let root_key = match &path_segments[0] {
                    PathSegment::Key(k) => k.clone(),
                    PathSegment::Index(i) => i.to_string(),
                };

                // Get the root value from state
                match ctx.state.get(&root_key) {
                    Some(root_value) => {
                        if path_segments.len() == 1 {
                            // Single key - return the value directly
                            root_value.clone()
                        } else {
                            // Multiple segments - navigate into the nested value
                            // Use get_at_path for safe traversal of remaining segments
                            let remaining_path: Path = path_segments[1..].to_vec();
                            let opts = GetOptions {
                                tolerant: true,
                                at: "state".to_string(),
                            };
                            let result = get_at_path(root_value, &remaining_path, &opts);
                            result.value.unwrap_or(serde_json::Value::Null)
                        }
                    }
                    None => serde_json::Value::Null,
                }
            } else {
                // No path provided - return the entire state object
                serde_json::json!(ctx.state)
            }
        }
        SelectSource::Scene => {
            // Scene source: pull-based lookup of nodes directly from scene tree.
            //
            // The scene tree IS the canonical source of truth. Bindings read directly
            // from it via this source - no copying to `state.selected_node`.
            //
            // Key types:
            // - String key: returns single node
            // - Array key: returns array of nodes (static keys only here)
            //
            // For dynamic keys (nested bindings), use resolve_selection_full.

            // Check if scene_index is available
            let scene_index = match &ctx.scene_index {
                Some(index) => index,
                None => return serde_json::Value::Null, // Graceful degradation
            };

            // Resolve the key (static only - dynamic keys require resolve_selection_full)
            let key_value = match &select.key {
                Some(k) => match k {
                    SelectKey::Static(s) => serde_json::Value::String(s.clone()),
                    SelectKey::Dynamic(_) => return serde_json::Value::Null, // Needs registry
                },
                None => return serde_json::Value::Null, // Key required for scene lookup
            };

            // Lookup node(s) by ID — lazy conversion from TypedNodeEntry to JSON.
            // Task 202: Only looked-up entries are converted, not the entire index.
            let base_value = match &key_value {
                serde_json::Value::String(id) => {
                    // Single ID → single node (on-demand JSON conversion)
                    scene_index
                        .get(id)
                        .cloned()
                        .unwrap_or(serde_json::Value::Null)
                }
                serde_json::Value::Array(ids) => {
                    // Array of IDs → array of nodes (on-demand JSON conversion)
                    let nodes: Vec<serde_json::Value> = ids
                        .iter()
                        .map(|v| {
                            v.as_str()
                                .and_then(|s| scene_index.get(s))
                                .cloned()
                                .unwrap_or(serde_json::Value::Null)
                        })
                        .collect();
                    serde_json::Value::Array(nodes)
                }
                _ => serde_json::Value::Null,
            };

            // Apply path traversal if specified
            if let Some(ref path) = path {
                let result = get_at_path(&base_value, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                base_value
            }
        }
        SelectSource::Context => {
            // Context source: action execution context (target_id, input, position, payload).
            //
            // This source is populated by the kernel during execute_action() and provides
            // access to action workflow parameters. Path traversal is supported.
            //
            // Example paths:
            // - "target_id" → node ID being acted upon
            // - "input.target_id" → nested within input object
            // - "position.x" → pointer X coordinate
            // - "payload.tab" → trigger payload field

            if let Some(ref path) = path {
                let result = get_at_path(&ctx.context, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                ctx.context.clone()
            }
        }
    }
}

/// Resolve the initial pipeline value with full binding evaluation support.
///
/// This is the internal version that supports dynamic keys (nested bindings).
/// For static keys only, use `resolve_selection`.
///
/// # Arguments
/// * `select` - The binding select configuration
/// * `input` - The input value for self source and nested binding evaluation
/// * `ctx` - The evaluation context
/// * `registry` - The operator registry for nested binding evaluation
fn resolve_selection_full(
    select: Option<&BindingSelect>,
    input: &serde_json::Value,
    ctx: &BindingEvaluationContext,
    registry: &OperatorRegistry,
) -> serde_json::Value {
    let select = match select {
        Some(s) => s,
        None => return input.clone(),
    };

    let source = select.from.unwrap_or(SelectSource::SelfSource);
    let path = select.path.as_ref().and_then(|p| to_path(p).ok());

    match source {
        SelectSource::SelfSource => {
            if let Some(ref path) = path {
                let result = get_at_path(input, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                input.clone()
            }
        }
        SelectSource::Ambient => {
            let ambient = serde_json::to_value(&ctx.ambient).unwrap_or(serde_json::Value::Null);
            if let Some(ref path) = path {
                let result = get_at_path(&ambient, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                ambient
            }
        }
        SelectSource::Vars => {
            // Vars supports key to select which var, then path to navigate within it
            // Example: {"from": "vars", "key": "$item", "path": "id"}
            //   -> vars["$item"]["id"]
            let vars = serde_json::to_value(&ctx.vars).unwrap_or(serde_json::Value::Null);

            // First, resolve the key if present (static or dynamic)
            let base_value = if let Some(ref key) = select.key {
                match resolve_select_key_full(key, input, ctx, registry) {
                    Some(resolved_key) => {
                        // Get the specific var by key
                        vars.get(&resolved_key)
                            .cloned()
                            .unwrap_or(serde_json::Value::Null)
                    }
                    None => serde_json::Value::Null,
                }
            } else {
                // No key - use entire vars object
                vars
            };

            // Then navigate by path if present
            if let Some(ref path) = path {
                let result = get_at_path(&base_value, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                base_value
            }
        }
        SelectSource::DataSource => {
            // Resolve the key (static or dynamic)
            let key = match &select.key {
                Some(k) => match resolve_select_key_full(k, input, ctx, registry) {
                    Some(resolved) => resolved,
                    None => return serde_json::Value::Null,
                },
                None => return serde_json::Value::Null,
            };

            let payload = ctx
                .data_sources
                .get(&key)
                .cloned()
                .unwrap_or(serde_json::Value::Null);

            if let Some(ref path) = path {
                let result = get_at_path(&payload, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                payload
            }
        }
        SelectSource::Literal => select.value.clone().unwrap_or(serde_json::Value::Null),
        SelectSource::Fsm => {
            let fsm = serde_json::to_value(&ctx.fsm).unwrap_or(serde_json::Value::Null);
            if let Some(ref path) = path {
                let result = get_at_path(&fsm, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                fsm
            }
        }
        SelectSource::Routing => {
            // Routing source: look up routes by origin ID
            //
            // The key can be:
            // 1. A static path: { "from": "routing", "path": "keyboard:0" }
            // 2. A dynamic key (nested binding): resolved via recursive evaluation
            //
            // Dynamic keys are resolved first to get the origin ID, then used for lookup.

            // Determine the lookup key
            let lookup_key: Option<String> = if let Some(ref key) = select.key {
                // Static or dynamic key provided - full evaluation
                resolve_select_key_full(key, input, ctx, registry)
            } else if let Some(ref path_input) = select.path {
                // Static path provided (treated as the origin ID directly)
                match path_input {
                    PathInput::String(s) => Some(s.clone()),
                    PathInput::Array(segments) => {
                        let key: String = segments
                            .iter()
                            .filter_map(|seg| match seg {
                                PathSegment::Key(k) => Some(k.as_str()),
                                PathSegment::Index(_) => None,
                            })
                            .collect::<Vec<_>>()
                            .join(".");
                        if key.is_empty() {
                            None
                        } else {
                            Some(key)
                        }
                    }
                }
            } else {
                None
            };

            // Look up the route
            match &lookup_key {
                Some(origin_id) => match ctx.routing.get(origin_id) {
                    Some(target_id) => serde_json::json!(target_id),
                    None => serde_json::Value::Null,
                },
                None => serde_json::Value::Null,
            }
        }
        SelectSource::State => {
            let path = select.path.as_ref();
            if let Some(path_input) = path {
                let path_segments: Path = match path_input {
                    PathInput::String(s) => match parse_path(s) {
                        Ok(segments) => segments,
                        Err(_) => return serde_json::Value::Null,
                    },
                    PathInput::Array(segments) => segments.clone(),
                };

                if path_segments.is_empty() {
                    return serde_json::json!(ctx.state);
                }

                let root_key = match &path_segments[0] {
                    PathSegment::Key(k) => k.clone(),
                    PathSegment::Index(i) => i.to_string(),
                };

                match ctx.state.get(&root_key) {
                    Some(root_value) => {
                        if path_segments.len() == 1 {
                            root_value.clone()
                        } else {
                            let remaining_path: Path = path_segments[1..].to_vec();
                            let opts = GetOptions {
                                tolerant: true,
                                at: "state".to_string(),
                            };
                            let result = get_at_path(root_value, &remaining_path, &opts);
                            result.value.unwrap_or(serde_json::Value::Null)
                        }
                    }
                    None => serde_json::Value::Null,
                }
            } else {
                serde_json::json!(ctx.state)
            }
        }
        SelectSource::Scene => {
            // Scene source: pull-based lookup of nodes directly from scene tree.
            //
            // Supports both static and dynamic keys (nested bindings).
            // The scene tree IS the canonical source of truth.

            // Check if scene_index is available
            let scene_index = match &ctx.scene_index {
                Some(index) => index,
                None => return serde_json::Value::Null, // Graceful degradation
            };

            // Resolve the key (static or dynamic via nested binding evaluation)
            let key_value: serde_json::Value = match &select.key {
                Some(k) => match k {
                    SelectKey::Static(s) => serde_json::Value::String(s.clone()),
                    SelectKey::Dynamic(binding) => {
                        // Recursively evaluate the nested binding to get the key
                        let result = evaluate_binding(binding, input, ctx, registry, None);
                        result.value
                    }
                },
                None => return serde_json::Value::Null, // Key required for scene lookup
            };

            // Lookup node(s) by ID — lazy conversion from TypedNodeEntry to JSON.
            // Task 202: Only looked-up entries are converted, not the entire index.
            let base_value = match &key_value {
                serde_json::Value::String(id) => {
                    // Single ID → single node (on-demand JSON conversion)
                    scene_index
                        .get(id)
                        .cloned()
                        .unwrap_or(serde_json::Value::Null)
                }
                serde_json::Value::Array(ids) => {
                    // Array of IDs → array of nodes (on-demand JSON conversion)
                    let nodes: Vec<serde_json::Value> = ids
                        .iter()
                        .map(|v| {
                            v.as_str()
                                .and_then(|s| scene_index.get(s))
                                .cloned()
                                .unwrap_or(serde_json::Value::Null)
                        })
                        .collect();
                    serde_json::Value::Array(nodes)
                }
                serde_json::Value::Null => serde_json::Value::Null,
                _ => serde_json::Value::Null,
            };

            // Apply path traversal if specified
            if let Some(ref path) = path {
                let result = get_at_path(&base_value, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                base_value
            }
        }
        SelectSource::Context => {
            // Context source: action execution context (target_id, input, position, payload).
            //
            // Supports path traversal into the context object.

            if let Some(ref path) = path {
                let result = get_at_path(&ctx.context, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                ctx.context.clone()
            }
        }
    }
}

/// Resolve selection using a resolver function for nested binding evaluation.
fn resolve_selection_with_resolver(
    select: Option<&BindingSelect>,
    input: &serde_json::Value,
    ctx: &BindingEvaluationContext,
    resolver: &OperatorResolver,
) -> serde_json::Value {
    let select = match select {
        Some(s) => s,
        None => return input.clone(),
    };

    let source = select.from.unwrap_or(SelectSource::SelfSource);
    let path = select.path.as_ref().and_then(|p| to_path(p).ok());

    match source {
        SelectSource::SelfSource => {
            if let Some(ref path) = path {
                let result = get_at_path(input, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                input.clone()
            }
        }
        SelectSource::Ambient => {
            let ambient = serde_json::to_value(&ctx.ambient).unwrap_or(serde_json::Value::Null);
            if let Some(ref path) = path {
                let result = get_at_path(&ambient, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                ambient
            }
        }
        SelectSource::Vars => {
            // Vars supports key to select which var, then path to navigate within it
            // Example: {"from": "vars", "key": "$item", "path": "id"}
            //   -> vars["$item"]["id"]
            let vars = serde_json::to_value(&ctx.vars).unwrap_or(serde_json::Value::Null);

            // First, resolve the key if present (static or dynamic)
            let base_value = if let Some(ref key) = select.key {
                match resolve_select_key_with_resolver(key, input, ctx, resolver) {
                    Some(resolved_key) => {
                        // Get the specific var by key
                        vars.get(&resolved_key)
                            .cloned()
                            .unwrap_or(serde_json::Value::Null)
                    }
                    None => serde_json::Value::Null,
                }
            } else {
                // No key - use entire vars object
                vars
            };

            // Then navigate by path if present
            if let Some(ref path) = path {
                let result = get_at_path(&base_value, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                base_value
            }
        }
        SelectSource::DataSource => {
            let key = match &select.key {
                Some(k) => match resolve_select_key_with_resolver(k, input, ctx, resolver) {
                    Some(resolved) => resolved,
                    None => return serde_json::Value::Null,
                },
                None => return serde_json::Value::Null,
            };

            let payload = ctx
                .data_sources
                .get(&key)
                .cloned()
                .unwrap_or(serde_json::Value::Null);

            if let Some(ref path) = path {
                let result = get_at_path(&payload, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                payload
            }
        }
        SelectSource::Literal => select.value.clone().unwrap_or(serde_json::Value::Null),
        SelectSource::Fsm => {
            let fsm = serde_json::to_value(&ctx.fsm).unwrap_or(serde_json::Value::Null);
            if let Some(ref path) = path {
                let result = get_at_path(&fsm, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                fsm
            }
        }
        SelectSource::Routing => {
            let lookup_key: Option<String> = if let Some(ref key) = select.key {
                resolve_select_key_with_resolver(key, input, ctx, resolver)
            } else if let Some(ref path_input) = select.path {
                match path_input {
                    PathInput::String(s) => Some(s.clone()),
                    PathInput::Array(segments) => {
                        let key: String = segments
                            .iter()
                            .filter_map(|seg| match seg {
                                PathSegment::Key(k) => Some(k.as_str()),
                                PathSegment::Index(_) => None,
                            })
                            .collect::<Vec<_>>()
                            .join(".");
                        if key.is_empty() {
                            None
                        } else {
                            Some(key)
                        }
                    }
                }
            } else {
                None
            };

            match &lookup_key {
                Some(origin_id) => match ctx.routing.get(origin_id) {
                    Some(target_id) => serde_json::json!(target_id),
                    None => serde_json::Value::Null,
                },
                None => serde_json::Value::Null,
            }
        }
        SelectSource::State => {
            let path = select.path.as_ref();
            if let Some(path_input) = path {
                let path_segments: Path = match path_input {
                    PathInput::String(s) => match parse_path(s) {
                        Ok(segments) => segments,
                        Err(_) => return serde_json::Value::Null,
                    },
                    PathInput::Array(segments) => segments.clone(),
                };

                if path_segments.is_empty() {
                    return serde_json::json!(ctx.state);
                }

                let root_key = match &path_segments[0] {
                    PathSegment::Key(k) => k.clone(),
                    PathSegment::Index(i) => i.to_string(),
                };

                match ctx.state.get(&root_key) {
                    Some(root_value) => {
                        if path_segments.len() == 1 {
                            root_value.clone()
                        } else {
                            let remaining_path: Path = path_segments[1..].to_vec();
                            let opts = GetOptions {
                                tolerant: true,
                                at: "state".to_string(),
                            };
                            let result = get_at_path(root_value, &remaining_path, &opts);
                            result.value.unwrap_or(serde_json::Value::Null)
                        }
                    }
                    None => serde_json::Value::Null,
                }
            } else {
                serde_json::json!(ctx.state)
            }
        }
        SelectSource::Scene => {
            // Scene source: pull-based lookup of nodes directly from scene tree.
            //
            // Supports both static and dynamic keys (nested bindings via resolver).
            // The scene tree IS the canonical source of truth.

            // Check if scene_index is available
            let scene_index = match &ctx.scene_index {
                Some(index) => index,
                None => return serde_json::Value::Null, // Graceful degradation
            };

            // Resolve the key (static or dynamic via resolver)
            let key_value: serde_json::Value = match &select.key {
                Some(k) => match k {
                    SelectKey::Static(s) => serde_json::Value::String(s.clone()),
                    SelectKey::Dynamic(binding) => {
                        // Recursively evaluate the nested binding to get the key
                        let result =
                            evaluate_binding_with_resolver(binding, input, ctx, resolver, None);
                        result.value
                    }
                },
                None => return serde_json::Value::Null, // Key required for scene lookup
            };

            // Lookup node(s) by ID — lazy conversion from TypedNodeEntry to JSON.
            // Task 202: Only looked-up entries are converted, not the entire index.
            let base_value = match &key_value {
                serde_json::Value::String(id) => {
                    // Single ID → single node (on-demand JSON conversion)
                    scene_index
                        .get(id)
                        .cloned()
                        .unwrap_or(serde_json::Value::Null)
                }
                serde_json::Value::Array(ids) => {
                    // Array of IDs → array of nodes (on-demand JSON conversion)
                    let nodes: Vec<serde_json::Value> = ids
                        .iter()
                        .map(|v| {
                            v.as_str()
                                .and_then(|s| scene_index.get(s))
                                .cloned()
                                .unwrap_or(serde_json::Value::Null)
                        })
                        .collect();
                    serde_json::Value::Array(nodes)
                }
                serde_json::Value::Null => serde_json::Value::Null,
                _ => serde_json::Value::Null,
            };

            // Apply path traversal if specified
            if let Some(ref path) = path {
                let result = get_at_path(&base_value, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                base_value
            }
        }
        SelectSource::Context => {
            // Context source: action execution context (target_id, input, position, payload).
            //
            // Supports path traversal into the context object.

            if let Some(ref path) = path {
                let result = get_at_path(&ctx.context, path, &GetOptions::default());
                result.value.unwrap_or(serde_json::Value::Null)
            } else {
                ctx.context.clone()
            }
        }
    }
}

// ============================================================================
// Evaluation
// ============================================================================

/// Evaluate a Binding with full validation.
///
/// Returns the final value and all diagnostics. Never panics for user-caused errors.
///
/// # Runtime Binding Preservation with Partial Evaluation
///
/// If `ctx.preserve_runtime_bindings` is true and the binding selects from a
/// runtime-only source (FSM, Routing, State, Scene, Context), the binding is
/// PARTIALLY EVALUATED before being returned as AST:
///
/// - Nested static bindings (vars, ambient, dataSource, literal) are resolved
/// - Runtime-only nested bindings are preserved as AST
/// - The result is a "normalized" binding ready for kernel evaluation
///
/// ## Why Partial Evaluation?
///
/// Iteration variables like `$item` only exist during projection. If we preserve
/// the entire binding wholesale, the kernel will receive bindings that reference
/// `$item` - which doesn't exist at runtime. Partial evaluation "bakes in" these
/// values while preserving the runtime-dynamic parts.
///
/// ## Example
///
/// Input binding (during projection with $item = {target_property: "style.width"}):
/// ```json
/// {
///   "from": "scene",
///   "key": {"$kind": "binding", "select": {"from": "routing", "key": {"$kind": "binding", "select": {"from": "ambient", "path": "session_text_origin"}}}},
///   "transform": [{"op": "op:core.get_path", "args": {"path": {"$kind": "binding", "select": {"from": "vars", "key": "$item", "path": "target_property"}}}}]
/// }
/// ```
///
/// Output binding (normalized for kernel):
/// ```json
/// {
///   "from": "scene",
///   "key": {"$kind": "binding", "select": {"from": "routing", "key": "seat1:text_edit"}},
///   "transform": [{"op": "op:core.get_path", "args": {"path": "style.width"}}]
/// }
/// ```
pub fn evaluate_binding(
    binding: &Binding,
    input: &serde_json::Value,
    ctx: &BindingEvaluationContext,
    registry: &OperatorRegistry,
    options: Option<EvaluationOptions>,
) -> EvaluationResult {
    // 1000x CANONICAL: PARTIAL EVALUATION for runtime-only sources
    //
    // When preserve_runtime_bindings is set and this binding's top-level source
    // is runtime-only, we must PARTIALLY EVALUATE the binding:
    // - Resolve nested static bindings (vars, ambient, dataSource, literal)
    // - Preserve nested runtime-only bindings as AST
    // - Return the normalized binding ready for kernel evaluation
    if ctx.preserve_runtime_bindings {
        if let Some(ref select) = binding.select {
            if let Some(source) = &select.from {
                if source.is_runtime_only() {
                    return partially_evaluate_binding(binding, input, ctx, registry);
                }
            }
        }
    }

    let options = options.unwrap_or_default();
    let mut diagnostics = Vec::new();

    // Validate binding shape
    let binding_json = serde_json::to_value(binding).unwrap_or(serde_json::Value::Null);
    let validation = validate_binding_shape(&binding_json);
    diagnostics.extend(validation.diagnostics);

    if !validation.ok {
        return EvaluationResult {
            value: binding.default.clone().unwrap_or(serde_json::Value::Null),
            diagnostics,
        };
    }

    // Validate operators exist
    if let Some(ref steps) = binding.transform {
        for (i, step) in steps.iter().enumerate() {
            if registry.get(&step.op).is_none() {
                diagnostics.push(Diagnostic {
                    code: DiagnosticCode::BindingOperatorNotFound,
                    level: DiagnosticLevel::Error,
                    message: format!("operator not registered: {}", step.op),
                    at: String::new(),
                    data: Some({
                        let mut map = std::collections::HashMap::new();
                        map.insert("index".to_string(), serde_json::json!(i));
                        map.insert("op".to_string(), serde_json::json!(&step.op));
                        map
                    }),
                });
            }
        }
    }

    // If we have errors at this point, return default
    if diagnostics
        .iter()
        .any(|d| d.level == DiagnosticLevel::Error)
    {
        return EvaluationResult {
            value: binding.default.clone().unwrap_or(serde_json::Value::Null),
            diagnostics,
        };
    }

    // Dry run - just validate, don't execute
    if options.dry_run {
        // Still resolve selection to catch path errors
        let _ = resolve_selection_full(binding.select.as_ref(), input, ctx, registry);
        return EvaluationResult {
            value: serde_json::Value::Null,
            diagnostics,
        };
    }

    // Selection (with full nested binding evaluation support)
    let mut value = resolve_selection_full(binding.select.as_ref(), input, ctx, registry);

    // Transform pipeline
    if let Some(ref steps) = binding.transform {
        for (i, step) in steps.iter().enumerate() {
            let op = match registry.get(&step.op) {
                Some(op) => op,
                None => {
                    // This shouldn't happen since we validated above, but be safe
                    diagnostics.push(Diagnostic {
                        code: DiagnosticCode::BindingOperatorNotFound,
                        level: DiagnosticLevel::Error,
                        message: format!("operator not registered: {}", step.op),
                        at: String::new(),
                        data: None,
                    });
                    return EvaluationResult {
                        value: binding.default.clone().unwrap_or(serde_json::Value::Null),
                        diagnostics,
                    };
                }
            };

            // Convert args to JSON value and evaluate any nested bindings
            let args_value = step.args.as_ref().map(|a| {
                let raw = serde_json::to_value(a).unwrap_or(serde_json::Value::Null);
                // Recursively evaluate nested bindings in args
                evaluate_nested_bindings(&raw, input, ctx, registry)
            });

            // Create operator context with resolver
            let registry_for_resolver = registry.clone();
            let resolver: OperatorResolver =
                Arc::new(move |key: &str| registry_for_resolver.get(key));
            let op_ctx = OperatorContext::new(ctx.clone(), &step.op, i).with_resolver(resolver);

            // Apply operator (convert at boundary: serde_json::Value <-> OpValue)
            let input_op = OpValue::from(value.clone());
            let args_op = args_value.as_ref().map(|a| OpValue::from(a.clone()));
            match op.apply(&input_op, args_op.as_ref(), &op_ctx) {
                Ok(result) => {
                    value = result.into_inner();
                }
                Err(diag) => {
                    diagnostics.push(Diagnostic {
                        code: DiagnosticCode::BindingOperatorError,
                        level: DiagnosticLevel::Error,
                        message: format!("operator failed: {}", step.op),
                        at: String::new(),
                        data: Some({
                            let mut map = std::collections::HashMap::new();
                            map.insert("index".to_string(), serde_json::json!(i));
                            map.insert("op".to_string(), serde_json::json!(&step.op));
                            map.insert("error".to_string(), serde_json::json!(diag.message));
                            map
                        }),
                    });
                    return EvaluationResult {
                        value: binding.default.clone().unwrap_or(serde_json::Value::Null),
                        diagnostics,
                    };
                }
            }
        }
    }

    // Defaulting: use canonical helper (Single Source of Truth)
    apply_default_with_eval(&mut value, binding.default.as_ref(), |v| {
        evaluate_nested_bindings(v, input, ctx, registry)
    });

    EvaluationResult { value, diagnostics }
}

/// Evaluate a binding using a resolver function instead of registry
///
/// # Runtime Binding Preservation
///
/// If `ctx.preserve_runtime_bindings` is true and the binding selects from a
/// runtime-only source (FSM, Routing, State, Scene, Context), the binding AST
/// is returned instead of being evaluated. This enables two-phase evaluation.
///
/// # 1000x Pedigree: Concrete OperatorResolver Type
///
/// This function accepts `&OperatorResolver` (not a generic `F`) so that:
/// 1. The resolver can be passed through to `OperatorContext::with_resolver()`
/// 2. Operators like `map_to_nodes` can do recursive/eager evaluation
/// 3. ONE canonical type for resolvers throughout the codebase
pub fn evaluate_binding_with_resolver(
    binding: &Binding,
    input: &serde_json::Value,
    ctx: &BindingEvaluationContext,
    resolver: &OperatorResolver,
    options: Option<EvaluationOptions>,
) -> EvaluationResult {
    #[cfg(feature = "verbose-logging")]
    {
        let source = binding.select.as_ref().and_then(|s| s.from.as_ref());
        let key = binding.select.as_ref().and_then(|s| s.key.as_ref());
        let vars_keys: Vec<_> = ctx.vars.keys().collect();
        eprintln!(
            "[EVAL_WITH_RESOLVER] from={:?} key={:?} preserve={} vars={:?}",
            source, key, ctx.preserve_runtime_bindings, vars_keys
        );
    }

    // 1000x CANONICAL: PARTIAL EVALUATION for runtime-only sources
    //
    // When preserve_runtime_bindings is set and this binding's top-level source
    // is runtime-only, we must PARTIALLY EVALUATE the binding:
    // - Resolve nested static bindings (vars, ambient, dataSource, literal)
    // - Preserve nested runtime-only bindings as AST
    // - Return the normalized binding ready for kernel evaluation
    if ctx.preserve_runtime_bindings {
        if let Some(ref select) = binding.select {
            if let Some(source) = &select.from {
                if source.is_runtime_only() {
                    #[cfg(feature = "verbose-logging")]
                    eprintln!(
                        "[EVAL_WITH_RESOLVER] Taking PARTIAL EVAL path for {:?}",
                        source
                    );
                    return partially_evaluate_binding_with_resolver(binding, input, ctx, resolver);
                }
            }
        }
    }

    let options = options.unwrap_or_default();
    let mut diagnostics = Vec::new();

    // Validate binding shape
    let binding_json = serde_json::to_value(binding).unwrap_or(serde_json::Value::Null);
    let validation = validate_binding_shape(&binding_json);
    diagnostics.extend(validation.diagnostics);

    if !validation.ok {
        return EvaluationResult {
            value: binding.default.clone().unwrap_or(serde_json::Value::Null),
            diagnostics,
        };
    }

    // Dry run - just validate, don't execute
    if options.dry_run {
        let _ = resolve_selection_with_resolver(binding.select.as_ref(), input, ctx, resolver);
        return EvaluationResult {
            value: serde_json::Value::Null,
            diagnostics,
        };
    }

    // Selection (with full nested binding evaluation support)
    let mut value = resolve_selection_with_resolver(binding.select.as_ref(), input, ctx, resolver);

    // Transform pipeline
    if let Some(ref steps) = binding.transform {
        for (i, step) in steps.iter().enumerate() {
            let op = match resolver(&step.op) {
                Some(op) => op,
                None => {
                    diagnostics.push(Diagnostic {
                        code: DiagnosticCode::BindingOperatorNotFound,
                        level: DiagnosticLevel::Error,
                        message: format!("operator not registered: {}", step.op),
                        at: String::new(),
                        data: Some({
                            let mut map = std::collections::HashMap::new();
                            map.insert("index".to_string(), serde_json::json!(i));
                            map.insert("op".to_string(), serde_json::json!(&step.op));
                            map
                        }),
                    });
                    return EvaluationResult {
                        value: binding.default.clone().unwrap_or(serde_json::Value::Null),
                        diagnostics,
                    };
                }
            };

            // Convert args to JSON value and evaluate any nested bindings
            let args_value = step.args.as_ref().map(|a| {
                let raw = serde_json::to_value(a).unwrap_or(serde_json::Value::Null);
                evaluate_nested_bindings_with_resolver(&raw, input, ctx, resolver)
            });

            // 1000x CRITICAL: Pass resolver to OperatorContext so operators like
            // map_to_nodes can do recursive evaluation with full resolver support
            let op_ctx =
                OperatorContext::new(ctx.clone(), &step.op, i).with_resolver(resolver.clone());

            // Apply operator (convert at boundary: serde_json::Value <-> OpValue)
            let input_op = OpValue::from(value.clone());
            let args_op = args_value.as_ref().map(|a| OpValue::from(a.clone()));
            match op.apply(&input_op, args_op.as_ref(), &op_ctx) {
                Ok(result) => {
                    value = result.into_inner();
                }
                Err(diag) => {
                    diagnostics.push(Diagnostic {
                        code: DiagnosticCode::BindingOperatorError,
                        level: DiagnosticLevel::Error,
                        message: format!("operator failed: {}", step.op),
                        at: String::new(),
                        data: Some({
                            let mut map = std::collections::HashMap::new();
                            map.insert("index".to_string(), serde_json::json!(i));
                            map.insert("error".to_string(), serde_json::json!(diag.message));
                            map
                        }),
                    });
                    return EvaluationResult {
                        value: binding.default.clone().unwrap_or(serde_json::Value::Null),
                        diagnostics,
                    };
                }
            }
        }
    }

    // Defaulting: use canonical helper (Single Source of Truth)
    apply_default_with_eval(&mut value, binding.default.as_ref(), |v| {
        evaluate_nested_bindings_with_resolver(v, input, ctx, resolver)
    });

    EvaluationResult { value, diagnostics }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::super::ast::{Binding, BindingEvalContextExt, BindingSelect, TransformStep};
    use super::super::operators::registry::{FnOperator, OperatorRegistry};
    use super::*;

    fn setup_registry() -> OperatorRegistry {
        let mut registry = OperatorRegistry::new();

        // Identity operator
        registry
            .register(FnOperator::new("op:core.identity", |input, _, _| {
                Ok(input.clone())
            }))
            .unwrap();

        // Uppercase operator
        registry
            .register(FnOperator::new("op:text.uppercase", |input, _, _| {
                let input_json = input.as_inner();
                match input_json {
                    serde_json::Value::String(s) => {
                        Ok(OpValue::from(serde_json::json!(s.to_uppercase())))
                    }
                    _ => Ok(input.clone()),
                }
            }))
            .unwrap();

        // Add operator
        registry
            .register(FnOperator::new("op:math.add", |input, args, _| {
                let input_json = input.as_inner();
                let input_num = input_json.as_f64().unwrap_or(0.0);
                let add_num = args
                    .and_then(|a| {
                        let inner = a.as_inner();
                        inner.get("value").and_then(|v| v.as_f64())
                    })
                    .unwrap_or(0.0);
                Ok(OpValue::from(serde_json::json!(input_num + add_num)))
            }))
            .unwrap();

        registry
    }

    #[test]
    fn test_resolve_selection_self() {
        let input = serde_json::json!({"name": "Alice"});
        let ctx = BindingEvaluationContext::default();

        let select = BindingSelect {
            from: Some(SelectSource::SelfSource),
            path: Some(PathInput::String("name".to_string())),
            ..Default::default()
        };

        let result = resolve_selection(Some(&select), &input, &ctx);
        assert_eq!(result, serde_json::json!("Alice"));
    }

    #[test]
    fn test_resolve_selection_ambient() {
        let input = serde_json::json!({});
        let ctx = BindingEvaluationContext::new().with_ambient("theme", serde_json::json!("dark"));

        let select = BindingSelect {
            from: Some(SelectSource::Ambient),
            path: Some(PathInput::String("theme".to_string())),
            ..Default::default()
        };

        let result = resolve_selection(Some(&select), &input, &ctx);
        assert_eq!(result, serde_json::json!("dark"));
    }

    #[test]
    fn test_resolve_selection_data_source() {
        let input = serde_json::json!({});
        let ctx = BindingEvaluationContext::new()
            .with_data_source("user", serde_json::json!({"name": "Bob", "age": 30}));

        let select = BindingSelect {
            from: Some(SelectSource::DataSource),
            key: Some(SelectKey::static_key("user")),
            path: Some(PathInput::String("name".to_string())),
            ..Default::default()
        };

        let result = resolve_selection(Some(&select), &input, &ctx);
        assert_eq!(result, serde_json::json!("Bob"));
    }

    #[test]
    fn test_resolve_selection_literal() {
        let input = serde_json::json!({});
        let ctx = BindingEvaluationContext::default();

        let select = BindingSelect {
            from: Some(SelectSource::Literal),
            value: Some(serde_json::json!("Hello, World!")),
            ..Default::default()
        };

        let result = resolve_selection(Some(&select), &input, &ctx);
        assert_eq!(result, serde_json::json!("Hello, World!"));
    }

    #[test]
    fn test_evaluate_binding_simple() {
        let registry = setup_registry();

        let binding = Binding::new()
            .with_select(BindingSelect {
                from: Some(SelectSource::SelfSource),
                path: Some(PathInput::String("name".to_string())),
                ..Default::default()
            })
            .with_transform(vec![TransformStep::new("op:text.uppercase")]);

        let input = serde_json::json!({"name": "alice"});
        let ctx = BindingEvaluationContext::default();

        let result = evaluate_binding(&binding, &input, &ctx, &registry, None);
        assert_eq!(result.value, serde_json::json!("ALICE"));
        assert!(result.diagnostics.is_empty());
    }

    #[test]
    fn test_evaluate_binding_with_default() {
        let registry = setup_registry();

        let binding = Binding::new()
            .with_select(BindingSelect {
                from: Some(SelectSource::SelfSource),
                path: Some(PathInput::String("missing".to_string())),
                ..Default::default()
            })
            .with_default(serde_json::json!("default_value"));

        let input = serde_json::json!({"name": "alice"});
        let ctx = BindingEvaluationContext::default();

        let result = evaluate_binding(&binding, &input, &ctx, &registry, None);
        assert_eq!(result.value, serde_json::json!("default_value"));
    }

    #[test]
    fn test_evaluate_binding_pipeline() {
        let registry = setup_registry();

        let binding = Binding::new()
            .with_select(BindingSelect {
                from: Some(SelectSource::Literal),
                value: Some(serde_json::json!(10)),
                ..Default::default()
            })
            .with_transform(vec![
                TransformStep::new("op:math.add").with_arg("value", serde_json::json!(5)),
                TransformStep::new("op:math.add").with_arg("value", serde_json::json!(3)),
            ]);

        let input = serde_json::json!({});
        let ctx = BindingEvaluationContext::default();

        let result = evaluate_binding(&binding, &input, &ctx, &registry, None);
        assert_eq!(result.value, serde_json::json!(18));
    }

    #[test]
    fn test_evaluate_binding_missing_operator() {
        let registry = setup_registry();

        let binding = Binding::new()
            .with_transform(vec![TransformStep::new("op:unknown.operator")])
            .with_default(serde_json::json!("fallback"));

        let input = serde_json::json!("input");
        let ctx = BindingEvaluationContext::default();

        let result = evaluate_binding(&binding, &input, &ctx, &registry, None);
        assert_eq!(result.value, serde_json::json!("fallback"));
        assert!(result
            .diagnostics
            .iter()
            .any(|d| { d.code == DiagnosticCode::BindingOperatorNotFound }));
    }

    #[test]
    fn test_evaluate_binding_dry_run() {
        let registry = setup_registry();

        let binding = Binding::new()
            .with_select(BindingSelect {
                from: Some(SelectSource::Literal),
                value: Some(serde_json::json!("test")),
                ..Default::default()
            })
            .with_transform(vec![TransformStep::new("op:text.uppercase")]);

        let input = serde_json::json!({});
        let ctx = BindingEvaluationContext::default();

        let result = evaluate_binding(
            &binding,
            &input,
            &ctx,
            &registry,
            Some(EvaluationOptions { dry_run: true }),
        );

        assert_eq!(result.value, serde_json::Value::Null);
        assert!(result.diagnostics.is_empty());
    }

    // ========================================================================
    // Routing Source Tests
    // These tests validate SelectSource::Routing with static and dynamic keys
    // ========================================================================

    #[test]
    fn test_resolve_selection_routing_static_path() {
        // Test: Routing source with static path
        let input = serde_json::json!({});
        let ctx = BindingEvaluationContext::new().with_route("keyboard:0", "node:text-input-1");

        let select = BindingSelect {
            from: Some(SelectSource::Routing),
            path: Some(PathInput::String("keyboard:0".to_string())),
            ..Default::default()
        };

        let result = resolve_selection(Some(&select), &input, &ctx);
        assert_eq!(result, serde_json::json!("node:text-input-1"));
    }

    #[test]
    fn test_resolve_selection_routing_static_key() {
        // Test: Routing source with static key (SelectKey::Static)
        let input = serde_json::json!({});
        let ctx = BindingEvaluationContext::new().with_route("pointer:1", "node:button-a");

        let select = BindingSelect {
            from: Some(SelectSource::Routing),
            key: Some(SelectKey::static_key("pointer:1")),
            ..Default::default()
        };

        let result = resolve_selection(Some(&select), &input, &ctx);
        assert_eq!(result, serde_json::json!("node:button-a"));
    }

    #[test]
    fn test_resolve_selection_routing_dynamic_key() {
        // Test: Routing source with dynamic key (SelectKey::Dynamic with nested binding)
        // The dynamic key is a binding that reads from ambient.sys_primary_origin
        let registry = setup_full_registry();
        let input = serde_json::json!({});
        let ctx = BindingEvaluationContext::new()
            .with_ambient(
                "sys_primary_origin",
                serde_json::json!("origin:host:text:0"),
            )
            .with_route("origin:host:text:0", "node:editor-main");

        let select = BindingSelect {
            from: Some(SelectSource::Routing),
            key: Some(SelectKey::from_ambient("sys_primary_origin")),
            ..Default::default()
        };

        // Use resolve_selection_full which supports dynamic keys
        let result = resolve_selection_full(Some(&select), &input, &ctx, &registry);
        assert_eq!(result, serde_json::json!("node:editor-main"));
    }

    #[test]
    fn test_resolve_selection_routing_missing_route() {
        // Test: Routing source returns null when route doesn't exist
        let input = serde_json::json!({});
        let ctx = BindingEvaluationContext::new();

        let select = BindingSelect {
            from: Some(SelectSource::Routing),
            path: Some(PathInput::String("nonexistent:origin".to_string())),
            ..Default::default()
        };

        let result = resolve_selection(Some(&select), &input, &ctx);
        assert_eq!(result, serde_json::Value::Null);
    }

    #[test]
    fn test_resolve_selection_routing_no_key_or_path() {
        // Test: Routing source returns null when neither key nor path provided
        let input = serde_json::json!({});
        let ctx = BindingEvaluationContext::new().with_route("keyboard:0", "node:test");

        let select = BindingSelect {
            from: Some(SelectSource::Routing),
            ..Default::default()
        };

        let result = resolve_selection(Some(&select), &input, &ctx);
        assert_eq!(result, serde_json::Value::Null);
    }

    #[test]
    fn test_nested_binding_ambient_key() {
        // Test: Nested binding that reads from ambient source
        let registry = setup_full_registry();
        let input = serde_json::json!({});
        let ctx = BindingEvaluationContext::new().with_ambient("theme", serde_json::json!("dark"));

        // Create a nested binding that reads ambient.theme
        let nested_binding = Binding::new().with_select(BindingSelect {
            from: Some(SelectSource::Ambient),
            path: Some(PathInput::String("theme".to_string())),
            ..Default::default()
        });

        // Evaluate it directly
        let result = evaluate_binding(&nested_binding, &input, &ctx, &registry, None);
        assert_eq!(result.value, serde_json::json!("dark"));
    }

    #[test]
    fn test_nested_binding_vars_key() {
        // Test: Nested binding that reads from vars source
        let registry = setup_full_registry();
        let input = serde_json::json!({});
        let ctx = BindingEvaluationContext::new()
            .with_var("current_origin", serde_json::json!("keyboard:0"));

        // Create a nested binding that reads vars.current_origin
        let nested_binding = Binding::new().with_select(BindingSelect {
            from: Some(SelectSource::Vars),
            path: Some(PathInput::String("current_origin".to_string())),
            ..Default::default()
        });

        let result = evaluate_binding(&nested_binding, &input, &ctx, &registry, None);
        assert_eq!(result.value, serde_json::json!("keyboard:0"));
    }

    #[test]
    fn test_nested_binding_nested_path() {
        // Test: Nested binding with nested path
        let registry = setup_full_registry();
        let input = serde_json::json!({});
        let ctx = BindingEvaluationContext::new().with_ambient(
            "config",
            serde_json::json!({"input": {"primary": "keyboard:0"}}),
        );

        // Create a nested binding that reads ambient.config.input.primary
        let nested_binding = Binding::new().with_select(BindingSelect {
            from: Some(SelectSource::Ambient),
            path: Some(PathInput::String("config.input.primary".to_string())),
            ..Default::default()
        });

        let result = evaluate_binding(&nested_binding, &input, &ctx, &registry, None);
        assert_eq!(result.value, serde_json::json!("keyboard:0"));
    }

    #[test]
    fn test_nested_binding_missing_value() {
        // Test: Nested binding returns null for missing values
        let registry = setup_full_registry();
        let input = serde_json::json!({});
        let ctx = BindingEvaluationContext::new();

        let nested_binding = Binding::new().with_select(BindingSelect {
            from: Some(SelectSource::Ambient),
            path: Some(PathInput::String("nonexistent".to_string())),
            ..Default::default()
        });

        let result = evaluate_binding(&nested_binding, &input, &ctx, &registry, None);
        assert_eq!(result.value, serde_json::Value::Null);
    }

    #[test]
    fn test_select_key_static_helpers() {
        // Test: SelectKey::static_key helper
        let key = SelectKey::static_key("test:origin");
        assert!(key.is_static());
        assert!(!key.is_dynamic());
        assert_eq!(key.as_static(), Some("test:origin"));
        assert!(key.as_dynamic().is_none());
    }

    #[test]
    fn test_select_key_dynamic_helpers() {
        // Test: SelectKey::from_ambient helper creates a dynamic key with nested binding
        let key = SelectKey::from_ambient("sys_primary_origin");
        assert!(!key.is_static());
        assert!(key.is_dynamic());
        assert!(key.as_static().is_none());
        assert!(key.as_dynamic().is_some());
        // The dynamic key is a nested binding that reads from ambient
        let binding = key.as_dynamic().unwrap();
        assert_eq!(binding.kind, "binding");
    }

    #[test]
    fn test_routing_with_dynamic_key_from_ambient_null() {
        // Test: Dynamic key that resolves to null returns null route
        let registry = setup_full_registry();
        let input = serde_json::json!({});
        let ctx = BindingEvaluationContext::new().with_route("keyboard:0", "node:test");
        // ambient.sys_primary_origin is NOT set, so nested binding resolves to null

        let select = BindingSelect {
            from: Some(SelectSource::Routing),
            key: Some(SelectKey::from_ambient("sys_primary_origin")),
            ..Default::default()
        };

        let result = resolve_selection_full(Some(&select), &input, &ctx, &registry);
        assert_eq!(result, serde_json::Value::Null);
    }

    #[test]
    fn test_select_source_routing_in_all_names() {
        // Test: SelectSource::all_names() includes "routing"
        let names = SelectSource::all_names();
        assert!(names.contains(&"routing"));
    }

    #[test]
    fn test_context_with_routes() {
        // Test: BindingEvaluationContext::with_routes helper
        let mut routes = std::collections::HashMap::new();
        routes.insert("keyboard:0".to_string(), "node:a".to_string());
        routes.insert("pointer:1".to_string(), "node:b".to_string());

        let ctx = BindingEvaluationContext::new().with_routes(routes);

        assert_eq!(ctx.routing.get("keyboard:0"), Some(&"node:a".to_string()));
        assert_eq!(ctx.routing.get("pointer:1"), Some(&"node:b".to_string()));
    }

    // ========================================================================
    // Routing + Transform Pipeline Tests
    // ========================================================================

    fn setup_full_registry() -> OperatorRegistry {
        super::super::operators::create_core_registry().expect("core registry")
    }

    #[test]
    fn test_dynamic_key_with_transform_chain() {
        let registry = setup_full_registry();
        let binding = Binding::new()
            .with_select(BindingSelect {
                from: Some(SelectSource::Routing),
                key: Some(SelectKey::from_ambient("sys_primary_origin")),
                ..Default::default()
            })
            .with_transform(vec![TransformStep::new("op:text.uppercase")])
            .with_default(serde_json::json!(""));

        let ctx = BindingEvaluationContext::new()
            .with_ambient(
                "sys_primary_origin",
                serde_json::json!("origin:host:text:0"),
            )
            .with_route("origin:host:text:0", "node:editor-main");

        let result = evaluate_binding(&binding, &serde_json::json!({}), &ctx, &registry, None);
        assert_eq!(result.value, serde_json::json!("NODE:EDITOR-MAIN"));
        assert!(result.diagnostics.is_empty());
    }

    #[test]
    fn test_is_not_null_transform_after_routing_lookup() {
        // Popover visibility pattern: routing[nested binding] → is_not_null
        let registry = setup_full_registry();
        let binding = Binding::new()
            .with_select(BindingSelect {
                from: Some(SelectSource::Routing),
                key: Some(SelectKey::from_ambient("session_text_origin")),
                ..Default::default()
            })
            .with_transform(vec![TransformStep::new("op:core.is_not_null")])
            .with_default(serde_json::json!(false));

        let input = serde_json::json!({});

        // Route exists → true
        let ctx_with_route = BindingEvaluationContext::new()
            .with_ambient("session_text_origin", serde_json::json!("seat1:text_edit"))
            .with_route("seat1:text_edit", "node:text-field-1");
        let result = evaluate_binding(&binding, &input, &ctx_with_route, &registry, None);
        assert_eq!(result.value, serde_json::json!(true));
        assert!(result.diagnostics.is_empty());

        // Route missing → false
        let ctx_without_route = BindingEvaluationContext::new()
            .with_ambient("session_text_origin", serde_json::json!("seat1:text_edit"));
        let result = evaluate_binding(&binding, &input, &ctx_without_route, &registry, None);
        assert_eq!(result.value, serde_json::json!(false));
        assert!(result.diagnostics.is_empty());
    }

    #[test]
    fn test_routing_binding_with_multiple_transforms() {
        let registry = setup_full_registry();
        let binding = Binding::new()
            .with_select(BindingSelect {
                from: Some(SelectSource::Routing),
                key: Some(SelectKey::from_ambient("origin")),
                ..Default::default()
            })
            .with_transform(vec![
                TransformStep::new("op:core.is_not_null"),
                TransformStep::new("op:core.not"),
            ])
            .with_default(serde_json::json!(true));

        let ctx = BindingEvaluationContext::new()
            .with_ambient("origin", serde_json::json!("test:origin"))
            .with_route("test:origin", "target:node");

        // Route exists → is_not_null(true) → not(false)
        let result = evaluate_binding(&binding, &serde_json::json!({}), &ctx, &registry, None);
        assert_eq!(result.value, serde_json::json!(false));
        assert!(result.diagnostics.is_empty());
    }

    #[test]
    fn test_nested_binding_from_vars() {
        // Test: Nested binding that reads from vars source
        let registry = setup_full_registry();
        let ctx = BindingEvaluationContext::new()
            .with_var("selected_origin", serde_json::json!("pointer:0"))
            .with_route("pointer:0", "node:clicked-element");

        // Create a dynamic key that reads from vars
        let nested_binding = Binding::new().with_select(BindingSelect {
            from: Some(SelectSource::Vars),
            path: Some(PathInput::String("selected_origin".to_string())),
            ..Default::default()
        });

        let select = BindingSelect {
            from: Some(SelectSource::Routing),
            key: Some(SelectKey::dynamic_binding(nested_binding)),
            ..Default::default()
        };

        let result = resolve_selection_full(Some(&select), &serde_json::json!({}), &ctx, &registry);
        assert_eq!(result, serde_json::json!("node:clicked-element"));
    }

    #[test]
    fn test_nested_binding_from_fsm() {
        // Test: Nested binding that reads from fsm source
        let registry = setup_full_registry();
        let mut ctx = BindingEvaluationContext::new().with_route("keyboard:0", "node:input-field");
        ctx.fsm
            .insert("active_origin".to_string(), serde_json::json!("keyboard:0"));

        // Create a dynamic key that reads from fsm
        let nested_binding = Binding::new().with_select(BindingSelect {
            from: Some(SelectSource::Fsm),
            path: Some(PathInput::String("active_origin".to_string())),
            ..Default::default()
        });

        let select = BindingSelect {
            from: Some(SelectSource::Routing),
            key: Some(SelectKey::dynamic_binding(nested_binding)),
            ..Default::default()
        };

        let result = resolve_selection_full(Some(&select), &serde_json::json!({}), &ctx, &registry);
        assert_eq!(result, serde_json::json!("node:input-field"));
    }

    // ========================================================================
    // Scene Source Tests (SelectSource::Scene)
    //
    // These tests validate the pull-based scene tree access via SelectSource::Scene.
    // Scene tree IS the canonical source of truth - bindings read directly from it.
    // ========================================================================

    /// Helper: Create a typed scene index with test nodes.
    /// Task 202: Uses TypedNodeEntry (typed Rust structs) instead of raw JSON.
    /// Entries are converted to JSON on-demand by to_json_value() during lookups.
    fn create_test_scene_index(
    ) -> std::sync::Arc<std::collections::HashMap<String, crate::kernel::typed_index::TypedNodeEntry>>
    {
        use crate::kernel::typed_index::TypedNodeEntry;
        use crate::kernel::types::*;

        let mut index = std::collections::HashMap::new();

        // Text block node with style and custom props
        index.insert(
            "node:text-block-1".to_string(),
            TypedNodeEntry {
                id: "node:text-block-1".to_string(),
                kind: NodeKind::Text,
                props: NodeProps {
                    style: None,
                    text: Some("Hello World".to_string()),
                    custom: Some(serde_json::json!({"content": "Hello World", "fontSize": 14})),
                    ..Default::default()
                },
                visible: Visibility::Resolved(true),
                value: None,
                z_index: None,
                style: Some(ResolvedStyle {
                    padding: Some(Padding::uniform(16.0)),
                    background: Some("#ffffff".to_string()),
                    color: Some("#000000".to_string()),
                    ..Default::default()
                }),
                triggers: vec![],
                child_ids: vec![],
                synthetic: false,
                portal_owner: None,
                parent_id: None,
            },
        );

        // Box container node
        index.insert(
            "node:box-container".to_string(),
            TypedNodeEntry {
                id: "node:box-container".to_string(),
                kind: NodeKind::Container,
                props: NodeProps::default(),
                visible: Visibility::Resolved(true),
                value: None,
                z_index: None,
                style: Some({
                    let mut s = ResolvedStyle::default();
                    s.extra.insert("gap".to_string(), serde_json::json!("8px"));
                    s
                }),
                triggers: vec![],
                child_ids: vec!["node:text-block-1".to_string()],
                synthetic: false,
                portal_owner: None,
                parent_id: None,
            },
        );

        // Simple button node
        index.insert(
            "node:button-a".to_string(),
            TypedNodeEntry {
                id: "node:button-a".to_string(),
                kind: NodeKind::Custom,
                props: NodeProps {
                    custom: Some(serde_json::json!({"label": "Click me"})),
                    ..Default::default()
                },
                visible: Visibility::Resolved(true),
                value: None,
                z_index: None,
                style: None,
                triggers: vec![],
                child_ids: vec![],
                synthetic: false,
                portal_owner: None,
                parent_id: None,
            },
        );

        std::sync::Arc::new(index)
    }

    #[test]
    fn test_scene_source_static_string_key_returns_node() {
        // Test: Scene source with static string key returns the node
        let input = serde_json::json!({});
        let scene_index = create_test_scene_index();
        let ctx = BindingEvaluationContext::new().with_typed_scene_index(scene_index);

        let select = BindingSelect {
            from: Some(SelectSource::Scene),
            key: Some(SelectKey::static_key("node:text-block-1")),
            ..Default::default()
        };

        let result = resolve_selection(Some(&select), &input, &ctx);
        assert_eq!(
            result.get("id"),
            Some(&serde_json::json!("node:text-block-1"))
        );
        assert_eq!(result.get("kind"), Some(&serde_json::json!("Text")));
    }

    #[test]
    fn test_scene_source_dynamic_binding_key_returns_node() {
        // Test: Scene source with dynamic binding key (nested binding) returns node
        let registry = setup_full_registry();
        let input = serde_json::json!({});
        let scene_index = create_test_scene_index();
        let ctx = BindingEvaluationContext::new()
            .with_typed_scene_index(scene_index)
            .with_ambient("focused_node_id", serde_json::json!("node:button-a"));

        // Dynamic key reads from ambient.focused_node_id
        let select = BindingSelect {
            from: Some(SelectSource::Scene),
            key: Some(SelectKey::from_ambient("focused_node_id")),
            ..Default::default()
        };

        let result = resolve_selection_full(Some(&select), &input, &ctx, &registry);
        assert_eq!(result.get("id"), Some(&serde_json::json!("node:button-a")));
        assert_eq!(result.get("kind"), Some(&serde_json::json!("Custom")));
    }

    #[test]
    fn test_scene_source_array_of_ids_returns_array_of_nodes() {
        // Test: Scene source with array of IDs returns array of nodes
        let registry = setup_full_registry();
        let input = serde_json::json!({});
        let scene_index = create_test_scene_index();
        let ctx = BindingEvaluationContext::new()
            .with_typed_scene_index(scene_index)
            .with_var(
                "selected_ids",
                serde_json::json!(["node:text-block-1", "node:button-a"]),
            );

        // Dynamic key that resolves to an array of IDs
        let nested_binding = Binding::new().with_select(BindingSelect {
            from: Some(SelectSource::Vars),
            path: Some(PathInput::String("selected_ids".to_string())),
            ..Default::default()
        });

        let select = BindingSelect {
            from: Some(SelectSource::Scene),
            key: Some(SelectKey::dynamic_binding(nested_binding)),
            ..Default::default()
        };

        let result = resolve_selection_full(Some(&select), &input, &ctx, &registry);
        assert!(result.is_array());
        let arr = result.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(
            arr[0].get("id"),
            Some(&serde_json::json!("node:text-block-1"))
        );
        assert_eq!(arr[1].get("id"), Some(&serde_json::json!("node:button-a")));
    }

    #[test]
    fn test_scene_source_missing_id_returns_null() {
        // Test: Scene source with missing ID returns Null
        let input = serde_json::json!({});
        let scene_index = create_test_scene_index();
        let ctx = BindingEvaluationContext::new().with_typed_scene_index(scene_index);

        let select = BindingSelect {
            from: Some(SelectSource::Scene),
            key: Some(SelectKey::static_key("node:nonexistent")),
            ..Default::default()
        };

        let result = resolve_selection(Some(&select), &input, &ctx);
        assert_eq!(result, serde_json::Value::Null);
    }

    #[test]
    fn test_scene_source_no_scene_index_returns_null() {
        // Test: Scene source with no scene_index returns Null (graceful degradation)
        let input = serde_json::json!({});
        let ctx = BindingEvaluationContext::new(); // No scene_index set

        let select = BindingSelect {
            from: Some(SelectSource::Scene),
            key: Some(SelectKey::static_key("node:text-block-1")),
            ..Default::default()
        };

        let result = resolve_selection(Some(&select), &input, &ctx);
        assert_eq!(result, serde_json::Value::Null);
    }

    #[test]
    fn test_scene_source_with_path_traverses_into_node() {
        // Test: Scene source with path traverses into node structure
        let input = serde_json::json!({});
        let scene_index = create_test_scene_index();
        let ctx = BindingEvaluationContext::new().with_typed_scene_index(scene_index);

        // Get style.padding from the node
        let select = BindingSelect {
            from: Some(SelectSource::Scene),
            key: Some(SelectKey::static_key("node:text-block-1")),
            path: Some(PathInput::String("style.padding".to_string())),
            ..Default::default()
        };

        let result = resolve_selection(Some(&select), &input, &ctx);
        assert_eq!(
            result,
            serde_json::json!({"top": 16.0, "right": 16.0, "bottom": 16.0, "left": 16.0})
        );
    }

    #[test]
    fn test_scene_source_nested_binding_in_key() {
        // Test: Scene source with nested binding in key (via routing chain)
        let registry = setup_full_registry();
        let input = serde_json::json!({});
        let scene_index = create_test_scene_index();

        // Chain: ambient.session_text_origin → routing lookup → scene lookup
        let ctx = BindingEvaluationContext::new()
            .with_typed_scene_index(scene_index)
            .with_ambient("session_text_origin", serde_json::json!("origin:text:0"))
            .with_route("origin:text:0", "node:text-block-1");

        // First resolve the route, then use that as scene key
        let routing_binding = Binding::new().with_select(BindingSelect {
            from: Some(SelectSource::Routing),
            key: Some(SelectKey::from_ambient("session_text_origin")),
            ..Default::default()
        });

        let select = BindingSelect {
            from: Some(SelectSource::Scene),
            key: Some(SelectKey::dynamic_binding(routing_binding)),
            ..Default::default()
        };

        let result = resolve_selection_full(Some(&select), &input, &ctx, &registry);
        assert_eq!(
            result.get("id"),
            Some(&serde_json::json!("node:text-block-1"))
        );
    }

    #[test]
    fn test_scene_source_preserves_node_structure() {
        // Test: Scene source preserves full node structure (id, kind, style, props, children)
        let input = serde_json::json!({});
        let scene_index = create_test_scene_index();
        let ctx = BindingEvaluationContext::new().with_typed_scene_index(scene_index);

        let select = BindingSelect {
            from: Some(SelectSource::Scene),
            key: Some(SelectKey::static_key("node:box-container")),
            ..Default::default()
        };

        let result = resolve_selection(Some(&select), &input, &ctx);

        // Verify all expected fields are present
        assert_eq!(
            result.get("id"),
            Some(&serde_json::json!("node:box-container"))
        );
        assert_eq!(result.get("kind"), Some(&serde_json::json!("Container")));
        assert!(result.get("style").is_some());
        assert!(result.get("props").is_some());
        assert!(result.get("children").is_some());

        // Verify nested structure
        let style = result.get("style").unwrap();
        assert!(style.get("layout").is_some());
        assert_eq!(style.get("gap"), Some(&serde_json::json!("8px")));
    }

    #[test]
    fn test_scene_source_mixed_valid_invalid_ids_in_array() {
        // Test: Scene source with mixed valid/invalid IDs returns nulls for missing
        let registry = setup_full_registry();
        let input = serde_json::json!({});
        let scene_index = create_test_scene_index();
        let ctx = BindingEvaluationContext::new()
            .with_typed_scene_index(scene_index)
            .with_var(
                "mixed_ids",
                serde_json::json!(["node:text-block-1", "node:missing", "node:button-a"]),
            );

        let nested_binding = Binding::new().with_select(BindingSelect {
            from: Some(SelectSource::Vars),
            path: Some(PathInput::String("mixed_ids".to_string())),
            ..Default::default()
        });

        let select = BindingSelect {
            from: Some(SelectSource::Scene),
            key: Some(SelectKey::dynamic_binding(nested_binding)),
            ..Default::default()
        };

        let result = resolve_selection_full(Some(&select), &input, &ctx, &registry);
        assert!(result.is_array());
        let arr = result.as_array().unwrap();
        assert_eq!(arr.len(), 3);
        assert_eq!(
            arr[0].get("id"),
            Some(&serde_json::json!("node:text-block-1"))
        ); // Valid
        assert_eq!(arr[1], serde_json::Value::Null); // Missing → Null
        assert_eq!(arr[2].get("id"), Some(&serde_json::json!("node:button-a")));
        // Valid
    }

    #[test]
    fn test_scene_source_empty_array_returns_empty_array() {
        // Test: Scene source with empty array returns empty array
        let registry = setup_full_registry();
        let input = serde_json::json!({});
        let scene_index = create_test_scene_index();
        let ctx = BindingEvaluationContext::new()
            .with_typed_scene_index(scene_index)
            .with_var("empty_ids", serde_json::json!([]));

        let nested_binding = Binding::new().with_select(BindingSelect {
            from: Some(SelectSource::Vars),
            path: Some(PathInput::String("empty_ids".to_string())),
            ..Default::default()
        });

        let select = BindingSelect {
            from: Some(SelectSource::Scene),
            key: Some(SelectKey::dynamic_binding(nested_binding)),
            ..Default::default()
        };

        let result = resolve_selection_full(Some(&select), &input, &ctx, &registry);
        assert!(result.is_array());
        assert_eq!(result.as_array().unwrap().len(), 0);
    }

    #[test]
    fn test_scene_source_in_all_names() {
        // Test: SelectSource::all_names() includes "scene"
        let names = SelectSource::all_names();
        assert!(names.contains(&"scene"));
    }

    #[test]
    fn test_scene_source_with_transform_pipeline() {
        // Test: Full binding with scene source and transform pipeline
        let registry = setup_full_registry();
        let input = serde_json::json!({});
        let scene_index = create_test_scene_index();
        let ctx = BindingEvaluationContext::new()
            .with_typed_scene_index(scene_index)
            .with_ambient("focused_id", serde_json::json!("node:text-block-1"));

        // Get node's content and uppercase it
        let binding = Binding::new()
            .with_select(BindingSelect {
                from: Some(SelectSource::Scene),
                key: Some(SelectKey::from_ambient("focused_id")),
                path: Some(PathInput::String("props.text".to_string())),
                ..Default::default()
            })
            .with_transform(vec![TransformStep::new("op:text.uppercase")])
            .with_default(serde_json::json!(""));

        let result = evaluate_binding(&binding, &input, &ctx, &registry, None);
        assert_eq!(result.value, serde_json::json!("HELLO WORLD"));
        assert!(result.diagnostics.is_empty());
    }

    #[test]
    fn test_scene_source_no_key_returns_null() {
        // Test: Scene source without key returns Null (key is required)
        let input = serde_json::json!({});
        let scene_index = create_test_scene_index();
        let ctx = BindingEvaluationContext::new().with_typed_scene_index(scene_index);

        let select = BindingSelect {
            from: Some(SelectSource::Scene),
            // No key provided
            ..Default::default()
        };

        let result = resolve_selection(Some(&select), &input, &ctx);
        assert_eq!(result, serde_json::Value::Null);
    }

    // ========================================================================
    // Migration 028: Scene Source Bindings Integration Tests (Task 067)
    //
    // These tests verify the exact binding JSON structures used in migration 028.
    // The patterns test the property inspector field template and action workflows.
    //
    // NON-NEGOTIABLE: These patterns are the CANONICAL way to access scene data.
    // NO `state.selected_node` - creates stale cache (Single Source violation)
    // NO mustache `{{...}}` - use binding AST for machine-readability
    // ========================================================================

    #[test]
    fn test_migration_028_field_template_value_binding() {
        // Test: The exact binding structure from migration 028 field template
        // Chain: scene[routing[ambient.session_text_origin]].style.padding
        let registry = setup_full_registry();
        let input = serde_json::json!({});
        let scene_index = create_test_scene_index();

        // Set up the full context chain
        let ctx = BindingEvaluationContext::new()
            .with_typed_scene_index(scene_index)
            .with_ambient("session_text_origin", serde_json::json!("seat1:text_edit"))
            .with_route("seat1:text_edit", "node:text-block-1")
            .with_var(
                "$item",
                serde_json::json!({"target_property": "style.padding", "default_value": "0px"}),
            );

        // The EXACT binding structure from migration 028
        let value_binding_json = serde_json::json!({
            "$kind": "binding",
            "select": {
                "from": "scene",
                "key": {
                    "$kind": "binding",
                    "select": {
                        "from": "routing",
                        "key": {
                            "$kind": "binding",
                            "select": {"from": "ambient", "path": "session_text_origin"}
                        }
                    }
                }
            },
            "transform": [
                {
                    "op": "op:core.get_path",
                    "args": {
                        "path": {"$kind": "binding", "select": {"from": "vars", "key": "$item", "path": "target_property"}}
                    }
                }
            ],
            "default": {"$kind": "binding", "select": {"from": "vars", "key": "$item", "path": "default_value"}}
        });

        let binding: Binding = serde_json::from_value(value_binding_json).unwrap();
        let result = evaluate_binding(&binding, &input, &ctx, &registry, None);

        // Should resolve to the padding value from the scene node (typed Padding struct)
        assert_eq!(
            result.value,
            serde_json::json!({"top": 16, "right": 16, "bottom": 16, "left": 16})
        );
    }

    #[test]
    fn test_migration_028_field_template_default_when_no_selection() {
        // Test: Default value is used when no node is selected (routing returns null)
        let registry = setup_full_registry();
        let input = serde_json::json!({});
        let scene_index = create_test_scene_index();

        // Context with no route for the origin
        let ctx = BindingEvaluationContext::new()
            .with_typed_scene_index(scene_index)
            .with_ambient("session_text_origin", serde_json::json!("seat1:no_route"))
            // No route for "seat1:no_route"
            .with_var(
                "$item",
                serde_json::json!({"target_property": "style.padding", "default_value": "8px"}),
            );

        let value_binding_json = serde_json::json!({
            "$kind": "binding",
            "select": {
                "from": "scene",
                "key": {
                    "$kind": "binding",
                    "select": {
                        "from": "routing",
                        "key": {
                            "$kind": "binding",
                            "select": {"from": "ambient", "path": "session_text_origin"}
                        }
                    }
                }
            },
            "transform": [
                {
                    "op": "op:core.get_path",
                    "args": {
                        "path": {"$kind": "binding", "select": {"from": "vars", "key": "$item", "path": "target_property"}}
                    }
                }
            ],
            "default": {"$kind": "binding", "select": {"from": "vars", "key": "$item", "path": "default_value"}}
        });

        let binding: Binding = serde_json::from_value(value_binding_json).unwrap();
        let result = evaluate_binding(&binding, &input, &ctx, &registry, None);

        // Should use default value since routing returns null
        assert_eq!(result.value, serde_json::json!("8px"));
    }

    #[test]
    fn test_migration_028_property_inspector_background_color() {
        // Test: Property inspector shows background color from focused node
        let registry = setup_full_registry();
        let input = serde_json::json!({});
        let scene_index = create_test_scene_index();

        let ctx = BindingEvaluationContext::new()
            .with_typed_scene_index(scene_index)
            .with_ambient("session_text_origin", serde_json::json!("origin:pointer"))
            .with_route("origin:pointer", "node:text-block-1")
            .with_var("$item", serde_json::json!({"target_property": "style.background", "default_value": "#f0f0f0"}));

        // Same binding structure, different target_property
        let value_binding_json = serde_json::json!({
            "$kind": "binding",
            "select": {
                "from": "scene",
                "key": {
                    "$kind": "binding",
                    "select": {
                        "from": "routing",
                        "key": {
                            "$kind": "binding",
                            "select": {"from": "ambient", "path": "session_text_origin"}
                        }
                    }
                }
            },
            "transform": [
                {
                    "op": "op:core.get_path",
                    "args": {
                        "path": {"$kind": "binding", "select": {"from": "vars", "key": "$item", "path": "target_property"}}
                    }
                }
            ],
            "default": {"$kind": "binding", "select": {"from": "vars", "key": "$item", "path": "default_value"}}
        });

        let binding: Binding = serde_json::from_value(value_binding_json).unwrap();
        let result = evaluate_binding(&binding, &input, &ctx, &registry, None);

        assert_eq!(result.value, serde_json::json!("#ffffff"));
    }

    #[test]
    fn test_migration_028_property_inspector_updates_on_focus_change() {
        // Test: Property inspector updates when focus changes to different node
        let registry = setup_full_registry();
        let input = serde_json::json!({});
        let scene_index = create_test_scene_index();

        // First focus: text block
        let ctx1 = BindingEvaluationContext::new()
            .with_typed_scene_index(scene_index.clone())
            .with_ambient("session_text_origin", serde_json::json!("origin:text"))
            .with_route("origin:text", "node:text-block-1")
            .with_var(
                "$item",
                serde_json::json!({"target_property": "style.padding", "default_value": "0px"}),
            );

        let value_binding_json = serde_json::json!({
            "$kind": "binding",
            "select": {
                "from": "scene",
                "key": {
                    "$kind": "binding",
                    "select": {
                        "from": "routing",
                        "key": {
                            "$kind": "binding",
                            "select": {"from": "ambient", "path": "session_text_origin"}
                        }
                    }
                }
            },
            "transform": [
                {
                    "op": "op:core.get_path",
                    "args": {
                        "path": {"$kind": "binding", "select": {"from": "vars", "key": "$item", "path": "target_property"}}
                    }
                }
            ],
            "default": {"$kind": "binding", "select": {"from": "vars", "key": "$item", "path": "default_value"}}
        });

        let binding: Binding = serde_json::from_value(value_binding_json.clone()).unwrap();
        let result1 = evaluate_binding(&binding, &input, &ctx1, &registry, None);
        assert_eq!(
            result1.value,
            serde_json::json!({"top": 16, "right": 16, "bottom": 16, "left": 16})
        ); // text-block-1 has Padding::uniform(16.0)

        // Second focus: box container (different node with different values)
        let ctx2 = BindingEvaluationContext::new()
            .with_typed_scene_index(scene_index)
            .with_ambient("session_text_origin", serde_json::json!("origin:text"))
            .with_route("origin:text", "node:box-container")
            .with_var(
                "$item",
                serde_json::json!({"target_property": "style.gap", "default_value": "0px"}),
            );

        let binding2: Binding = serde_json::from_value(value_binding_json).unwrap();
        let result2 = evaluate_binding(&binding2, &input, &ctx2, &registry, None);
        assert_eq!(result2.value, serde_json::json!("8px")); // box-container has gap: "8px"
    }

    #[test]
    fn test_migration_028_action_params_use_binding_syntax() {
        // Test: Action params use binding syntax instead of mustache {{...}}
        // This verifies the migration correctly converts mustache to binding AST
        let registry = setup_full_registry();
        let input = serde_json::json!({});

        let ctx = BindingEvaluationContext::new().with_var(
            "input",
            serde_json::json!({"target_id": "node:clicked-button"}),
        );

        // The CORRECT binding syntax (migration 028)
        // NOT: {"target_id": "{{input.target_id}}"}  <-- BANNED mustache
        let action_param_json = serde_json::json!({
            "$kind": "binding",
            "select": {"from": "vars", "path": "input.target_id"}
        });

        let binding: Binding = serde_json::from_value(action_param_json).unwrap();
        let result = evaluate_binding(&binding, &input, &ctx, &registry, None);

        assert_eq!(result.value, serde_json::json!("node:clicked-button"));
    }

    #[test]
    fn test_migration_028_action_focus_node_binding() {
        // Test: focusNode action correctly uses binding for target_id
        let registry = setup_full_registry();
        let input = serde_json::json!({});

        // Simulate action context with input.target_id
        let ctx = BindingEvaluationContext::new().with_var(
            "context",
            serde_json::json!({
                "input": {"target_id": "node:text-block-1"}
            }),
        );

        // The EXACT binding from migration 028 for focusNode action
        let target_id_binding = serde_json::json!({
            "$kind": "binding",
            "select": {"from": "vars", "key": "context", "path": "input.target_id"}
        });

        let binding: Binding = serde_json::from_value(target_id_binding).unwrap();
        let result = evaluate_binding(&binding, &input, &ctx, &registry, None);

        assert_eq!(result.value, serde_json::json!("node:text-block-1"));
    }

    #[test]
    fn test_migration_028_multiple_field_types_display() {
        // Test: Multiple field types (spacing, color, number) display correctly
        let registry = setup_full_registry();
        let input = serde_json::json!({});

        // Extended scene with more properties (Task 202: TypedNodeEntry)
        use crate::kernel::typed_index::TypedNodeEntry;
        use crate::kernel::types::*;
        let mut extended_index = std::collections::HashMap::new();
        extended_index.insert(
            "node:styled".to_string(),
            TypedNodeEntry {
                id: "node:styled".to_string(),
                kind: NodeKind::Container,
                props: NodeProps::default(),
                visible: Visibility::Resolved(true),
                value: None,
                z_index: None,
                style: Some({
                    let mut s = ResolvedStyle {
                        background: Some("#3b82f6".to_string()),
                        border_radius: Some(8.0),
                        ..Default::default()
                    };
                    s.padding = Some(Padding::uniform(24.0));
                    s.extra
                        .insert("opacity".to_string(), serde_json::json!(0.9));
                    s
                }),
                triggers: vec![],
                child_ids: vec![],
                synthetic: false,
                portal_owner: None,
                parent_id: None,
            },
        );
        let scene_index = std::sync::Arc::new(extended_index);

        let ctx = BindingEvaluationContext::new()
            .with_typed_scene_index(scene_index)
            .with_ambient("session_text_origin", serde_json::json!("origin:click"))
            .with_route("origin:click", "node:styled");

        // Test spacing field (padding)
        let padding_ctx = ctx.clone().with_var(
            "$item",
            serde_json::json!({"target_property": "style.padding", "default_value": "0px"}),
        );
        let binding_json = serde_json::json!({
            "$kind": "binding",
            "select": {
                "from": "scene",
                "key": {"$kind": "binding", "select": {"from": "routing", "key": {"$kind": "binding", "select": {"from": "ambient", "path": "session_text_origin"}}}}
            },
            "transform": [{"op": "op:core.get_path", "args": {"path": {"$kind": "binding", "select": {"from": "vars", "key": "$item", "path": "target_property"}}}}],
            "default": {"$kind": "binding", "select": {"from": "vars", "key": "$item", "path": "default_value"}}
        });
        let binding: Binding = serde_json::from_value(binding_json.clone()).unwrap();
        assert_eq!(
            evaluate_binding(&binding, &input, &padding_ctx, &registry, None).value,
            serde_json::json!({"top": 24, "right": 24, "bottom": 24, "left": 24})
        );

        // Test color field (background)
        let color_ctx = ctx.clone().with_var(
            "$item",
            serde_json::json!({"target_property": "style.background", "default_value": "#ffffff"}),
        );
        let binding: Binding = serde_json::from_value(binding_json.clone()).unwrap();
        assert_eq!(
            evaluate_binding(&binding, &input, &color_ctx, &registry, None).value,
            serde_json::json!("#3b82f6")
        );

        // Test number field (border_radius)
        let number_ctx = ctx.clone().with_var(
            "$item",
            serde_json::json!({"target_property": "style.border_radius", "default_value": 0}),
        );
        let binding: Binding = serde_json::from_value(binding_json.clone()).unwrap();
        assert_eq!(
            evaluate_binding(&binding, &input, &number_ctx, &registry, None).value,
            serde_json::json!(8)
        );

        // Test float field (opacity)
        let float_ctx = ctx.clone().with_var(
            "$item",
            serde_json::json!({"target_property": "style.opacity", "default_value": 1.0}),
        );
        let binding: Binding = serde_json::from_value(binding_json).unwrap();
        assert_eq!(
            evaluate_binding(&binding, &input, &float_ctx, &registry, None).value,
            serde_json::json!(0.9)
        );
    }

    #[test]
    fn test_migration_028_end_to_end_click_node_shows_values() {
        // Test: End-to-end flow - click node → popover shows that node's values
        // This simulates the full property inspector flow
        let registry = setup_full_registry();
        let input = serde_json::json!({});
        let scene_index = create_test_scene_index();

        // Step 1: User clicks on node (host sets routing)
        let ctx = BindingEvaluationContext::new()
            .with_typed_scene_index(scene_index)
            .with_ambient(
                "session_text_origin",
                serde_json::json!("origin:mouse:click"),
            )
            .with_route("origin:mouse:click", "node:text-block-1"); // Click routes to text block

        // Step 2: Property inspector fields evaluate their bindings
        let fields = vec![
            ("style.padding", "0px"),
            ("style.background", "#000000"),
            ("style.color", "#ffffff"),
            ("props.text", ""),
        ];

        for (property_path, default) in fields {
            let field_ctx = ctx.clone().with_var(
                "$item",
                serde_json::json!({
                    "target_property": property_path,
                    "default_value": default
                }),
            );

            let binding_json = serde_json::json!({
                "$kind": "binding",
                "select": {
                    "from": "scene",
                    "key": {"$kind": "binding", "select": {"from": "routing", "key": {"$kind": "binding", "select": {"from": "ambient", "path": "session_text_origin"}}}}
                },
                "transform": [{"op": "op:core.get_path", "args": {"path": {"$kind": "binding", "select": {"from": "vars", "key": "$item", "path": "target_property"}}}}],
                "default": {"$kind": "binding", "select": {"from": "vars", "key": "$item", "path": "default_value"}}
            });

            let binding: Binding = serde_json::from_value(binding_json).unwrap();
            let result = evaluate_binding(&binding, &input, &field_ctx, &registry, None);

            // Verify each field gets the correct value from the clicked node
            match property_path {
                "style.padding" => assert_eq!(
                    result.value,
                    serde_json::json!({"top": 16, "right": 16, "bottom": 16, "left": 16})
                ),
                "style.background" => assert_eq!(result.value, serde_json::json!("#ffffff")),
                "style.color" => assert_eq!(result.value, serde_json::json!("#000000")),
                "props.text" => assert_eq!(result.value, serde_json::json!("Hello World")),
                _ => panic!("Unexpected property path"),
            }
        }
    }

    #[test]
    fn test_migration_028_json_deserialization_matches_migration() {
        // Test: Verify the exact JSON from migration 028 deserializes correctly
        // This catches any typos or structural issues in the migration SQL

        // The exact value binding JSON from migration 028
        let migration_json = r#"{
            "$kind": "binding",
            "select": {
                "from": "scene",
                "key": {
                    "$kind": "binding",
                    "select": {
                        "from": "routing",
                        "key": {
                            "$kind": "binding",
                            "select": {"from": "ambient", "path": "session_text_origin"}
                        }
                    }
                }
            },
            "transform": [
                {
                    "op": "op:core.get_path",
                    "args": {
                        "path": {"$kind": "binding", "select": {"from": "vars", "key": "$item", "path": "target_property"}}
                    }
                }
            ],
            "default": {"$kind": "binding", "select": {"from": "vars", "key": "$item", "path": "default_value"}}
        }"#;

        // Deserialization should succeed without errors
        let binding: Result<Binding, _> = serde_json::from_str(migration_json);
        assert!(
            binding.is_ok(),
            "Migration JSON should deserialize: {:?}",
            binding.err()
        );

        let binding = binding.unwrap();
        assert_eq!(binding.kind, "binding");
        assert!(binding.select.is_some());
        assert!(binding.transform.is_some());
        assert!(binding.default.is_some());

        // Verify nested structure
        let select = binding.select.as_ref().unwrap();
        assert_eq!(select.from, Some(SelectSource::Scene));
        assert!(select.key.is_some());

        // Verify dynamic key is a binding
        if let Some(SelectKey::Dynamic(inner)) = &select.key {
            let inner_select = inner.select.as_ref().unwrap();
            assert_eq!(inner_select.from, Some(SelectSource::Routing));
        } else {
            panic!("Expected dynamic key binding");
        }
    }

    // ========================================================================
    // Task 068: SelectSource::Context Tests
    // ========================================================================

    #[test]
    fn test_select_source_context_parses() {
        // Test: JSON with from: "context" deserializes to SelectSource::Context
        let json = r#"{"from": "context", "path": "target_id"}"#;
        let select: BindingSelect = serde_json::from_str(json).unwrap();
        assert_eq!(select.from, Some(SelectSource::Context));
        assert_eq!(
            select.path,
            Some(PathInput::String("target_id".to_string()))
        );
    }

    #[test]
    fn test_context_target_id_resolution() {
        // Test: context.target_id resolves to the target node ID
        let registry = setup_full_registry();
        let ctx = BindingEvaluationContext::new().with_context(serde_json::json!({
            "target_id": "node:text-block-1",
            "input": {"target_id": "node:text-block-1"},
            "position": {"x": 100.0, "y": 200.0}
        }));

        let binding_json = serde_json::json!({
            "$kind": "binding",
            "select": {"from": "context", "path": "target_id"}
        });

        let binding: Binding = serde_json::from_value(binding_json).unwrap();
        let result = evaluate_binding(&binding, &serde_json::json!({}), &ctx, &registry, None);
        assert_eq!(result.value, serde_json::json!("node:text-block-1"));
    }

    #[test]
    fn test_context_input_nested_path() {
        // Test: context.input.target_id resolves nested paths
        let registry = setup_full_registry();
        let ctx = BindingEvaluationContext::new().with_context(serde_json::json!({
            "target_id": "node:text-block-1",
            "input": {"target_id": "node:from-input", "extra": "data"},
            "position": {"x": 100.0, "y": 200.0}
        }));

        let binding_json = serde_json::json!({
            "$kind": "binding",
            "select": {"from": "context", "path": "input.target_id"}
        });

        let binding: Binding = serde_json::from_value(binding_json).unwrap();
        let result = evaluate_binding(&binding, &serde_json::json!({}), &ctx, &registry, None);
        assert_eq!(result.value, serde_json::json!("node:from-input"));
    }

    #[test]
    fn test_context_position_resolution() {
        // Test: context.position.x and context.position.y resolve
        let registry = setup_full_registry();
        let ctx = BindingEvaluationContext::new().with_context(serde_json::json!({
            "target_id": "node:text-block-1",
            "position": {"x": 150.5, "y": 250.75}
        }));

        // Test X coordinate
        let binding_x = serde_json::json!({
            "$kind": "binding",
            "select": {"from": "context", "path": "position.x"}
        });
        let binding: Binding = serde_json::from_value(binding_x).unwrap();
        let result = evaluate_binding(&binding, &serde_json::json!({}), &ctx, &registry, None);
        assert_eq!(result.value, serde_json::json!(150.5));

        // Test Y coordinate
        let binding_y = serde_json::json!({
            "$kind": "binding",
            "select": {"from": "context", "path": "position.y"}
        });
        let binding: Binding = serde_json::from_value(binding_y).unwrap();
        let result = evaluate_binding(&binding, &serde_json::json!({}), &ctx, &registry, None);
        assert_eq!(result.value, serde_json::json!(250.75));
    }

    #[test]
    fn test_context_payload_resolution() {
        // Test: context.payload.tab resolves trigger payloads
        let registry = setup_full_registry();
        let ctx = BindingEvaluationContext::new().with_context(serde_json::json!({
            "target_id": "layout:editor:tab_btn_container",
            "payload": {"tab": "container", "extra": 123}
        }));

        let binding_json = serde_json::json!({
            "$kind": "binding",
            "select": {"from": "context", "path": "payload.tab"}
        });

        let binding: Binding = serde_json::from_value(binding_json).unwrap();
        let result = evaluate_binding(&binding, &serde_json::json!({}), &ctx, &registry, None);
        assert_eq!(result.value, serde_json::json!("container"));
    }

    #[test]
    fn test_context_missing_path_returns_null() {
        // Test: Missing paths return null gracefully
        let registry = setup_full_registry();
        let ctx = BindingEvaluationContext::new().with_context(serde_json::json!({
            "target_id": "node:text-block-1"
        }));

        let binding_json = serde_json::json!({
            "$kind": "binding",
            "select": {"from": "context", "path": "nonexistent.path"}
        });

        let binding: Binding = serde_json::from_value(binding_json).unwrap();
        let result = evaluate_binding(&binding, &serde_json::json!({}), &ctx, &registry, None);
        assert_eq!(result.value, serde_json::Value::Null);
    }

    #[test]
    fn test_context_no_path_returns_full_context() {
        // Test: No path returns the full context object
        let registry = setup_full_registry();
        let context_data = serde_json::json!({
            "target_id": "node:text-block-1",
            "input": {"target_id": "node:text-block-1"},
            "position": {"x": 100.0, "y": 200.0}
        });
        let ctx = BindingEvaluationContext::new().with_context(context_data.clone());

        let binding_json = serde_json::json!({
            "$kind": "binding",
            "select": {"from": "context"}
        });

        let binding: Binding = serde_json::from_value(binding_json).unwrap();
        let result = evaluate_binding(&binding, &serde_json::json!({}), &ctx, &registry, None);
        assert_eq!(result.value, context_data);
    }
}
