//! crates/composition-engine/src/binding/operators/registry.rs
//!
//! Deterministic, immutable registry for pure binding operators.
//! This is the only authority for resolving OperatorKey -> Operator implementation.
//!
//! Non-Negotiable Invariants:
//! - Operators are pure. No I/O or time access. All effects are data-in/data-out.
//! - Operator keys are validated by regex and unique within a registry instance.
//! - Registry can be frozen; after freeze, mutation is impossible.
//!
//! Key Concepts:
//! - Operator: `(input, args, ctx) -> output` with optional argument validator.
//! - OperatorContext: execution envelope containing strictly pure, deterministic facts.
//! - OperatorRegistry: register, resolve, enumerate. No global singletons.
//!
//! Security Considerations:
//! - No dynamic `eval`. Implementations are provided as functions only.
//! - Unknown operators are blocked; resolver returns a structured error.
//! - Argument validation emits Diagnostics; evaluation must refuse on 'error'.
//!
//! Ported from: frontends/web/composition-engine/binding/operators/registry.ts

use crate::binding::ast::{
    BindingEvaluationContext, Diagnostic, DiagnosticCode, DiagnosticLevel, OperatorKey,
};
use ops_core::OpValue;
use std::collections::HashMap;
use std::sync::Arc;

// ============================================================================
// Operator Context
// ============================================================================

/// Resolver function type for looking up operators by key.
/// Used by operators that need to call back into the evaluator (e.g., map_to_nodes).
pub type OperatorResolver = Arc<dyn Fn(&str) -> Option<Arc<dyn Operator>> + Send + Sync>;

/// Context visible to operators.
///
/// Provides access to evaluation context and optionally a resolver for operators
/// that need to perform recursive evaluation (like map_to_nodes).
#[derive(Clone)]
pub struct OperatorContext {
    /// Read-only evaluation context from the kernel.
    pub eval_ctx: BindingEvaluationContext,
    /// Operator metadata for observability and error reporting.
    pub op_key: OperatorKey,
    /// Index of this operator in the transform pipeline.
    pub op_index: usize,
    /// Optional resolver for recursive evaluation.
    /// This enables operators like map_to_nodes to call the canonical evaluator.
    resolver: Option<OperatorResolver>,
    nested_diagnostics: std::sync::Arc<std::sync::Mutex<Vec<crate::binding::ast::Diagnostic>>>,
}

impl std::fmt::Debug for OperatorContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OperatorContext")
            .field("eval_ctx", &self.eval_ctx)
            .field("op_key", &self.op_key)
            .field("op_index", &self.op_index)
            .field("resolver", &self.resolver.as_ref().map(|_| "<resolver>"))
            .finish()
    }
}

impl OperatorContext {
    /// Create a new operator context
    pub fn new(
        eval_ctx: BindingEvaluationContext,
        op_key: impl Into<String>,
        op_index: usize,
    ) -> Self {
        Self {
            eval_ctx,
            op_key: op_key.into(),
            op_index,
            resolver: None,
            nested_diagnostics: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }

    /// Create a context with a resolver for recursive evaluation.
    ///
    /// The resolver allows operators to call back into the canonical evaluator.
    /// This is the 1000x-compliant way to handle operators like map_to_nodes
    /// that need to evaluate nested bindings.
    pub fn with_resolver(mut self, resolver: OperatorResolver) -> Self {
        self.resolver = Some(resolver);
        self
    }

    /// Check if this context has a resolver for recursive evaluation.
    pub fn has_resolver(&self) -> bool {
        self.resolver.is_some()
    }

    /// Get the resolver if available.
    pub fn resolver(&self) -> Option<&OperatorResolver> {
        self.resolver.as_ref()
    }

    /// Create a child context with modified eval_ctx (for iteration).
    ///
    /// Used by operators like map_to_nodes to create per-item contexts
    /// with $item and $index in vars.
    pub fn with_iteration_vars(
        &self,
        item: serde_json::Value,
        index: usize,
        item_var: &str,
        index_var: &str,
    ) -> Self {
        let mut new_eval_ctx = self.eval_ctx.clone();
        new_eval_ctx.vars.insert(item_var.to_string(), item);
        new_eval_ctx
            .vars
            .insert(index_var.to_string(), serde_json::json!(index));

        Self {
            eval_ctx: new_eval_ctx,
            op_key: self.op_key.clone(),
            op_index: self.op_index,
            resolver: self.resolver.clone(),
            nested_diagnostics: self.nested_diagnostics.clone(),
        }
    }

    /// Evaluate nested bindings in a JSON value using the canonical evaluator.
    ///
    /// This is the 1000x-compliant way for operators to evaluate templates.
    /// Recursively finds all `{"$kind": "binding", ...}` objects and evaluates them.
    ///
    /// Returns None if no resolver is available (operator should fall back to
    /// returning templates with $vars attached for legacy compatibility).
    pub fn evaluate_nested_bindings(&self, value: &serde_json::Value) -> Option<serde_json::Value> {
        let resolver = self.resolver.as_ref()?;
        Some(evaluate_nested_bindings_impl(
            value,
            &self.eval_ctx,
            resolver,
            &self.nested_diagnostics,
        ))
    }

    pub(crate) fn take_nested_diagnostics(&self) -> Vec<crate::binding::ast::Diagnostic> {
        std::mem::take(&mut *self.nested_diagnostics.lock().expect("nested diagnostics lock"))
    }
}

/// The binding kind constant for detecting binding objects.
const BINDING_KIND: &str = "binding";

/// Recursively evaluate nested bindings in a JSON value.
///
/// This is the canonical implementation used by operators that need to
/// evaluate templates (like map_to_nodes with eager evaluation).
fn evaluate_nested_bindings_impl(
    value: &serde_json::Value,
    ctx: &BindingEvaluationContext,
    resolver: &OperatorResolver,
    diagnostics: &std::sync::Arc<std::sync::Mutex<Vec<crate::binding::ast::Diagnostic>>>,
) -> serde_json::Value {
    use crate::binding::ast::Binding;
    use crate::binding::evaluator::evaluate_binding_with_resolver;

    match value {
        serde_json::Value::Object(obj) => {
            // Check if this is a binding AST
            if obj.get("$kind").and_then(|v| v.as_str()) == Some(BINDING_KIND) {
                // Parse and evaluate the binding
                if let Ok(binding) = serde_json::from_value::<Binding>(value.clone()) {
                    #[cfg(all(target_arch = "wasm32", feature = "verbose-logging"))]
                    {
                        let source = binding.select.as_ref().and_then(|s| s.from.as_ref());
                        let vars_keys: Vec<_> = ctx.vars.keys().collect();
                        let preserve = ctx.preserve_runtime_bindings;
                        web_sys::console::log_1(
                            &format!(
                                "[EVAL_NESTED_IMPL] from={:?} preserve={} vars={:?}",
                                source, preserve, vars_keys
                            )
                            .into(),
                        );
                    }
                    let result = evaluate_binding_with_resolver(
                        &binding,
                        &serde_json::Value::Null,
                        ctx,
                        resolver,
                        None,
                    );
                    diagnostics.lock().expect("nested diagnostics lock").extend(result.diagnostics);
                    #[cfg(all(target_arch = "wasm32", feature = "verbose-logging"))]
                    {
                        let is_binding = result.value.get("$kind").is_some();
                        web_sys::console::log_1(
                            &format!(
                                "[EVAL_NESTED_IMPL] result is_binding={} value_preview={}",
                                is_binding,
                                serde_json::to_string(&result.value)
                                    .unwrap_or_default()
                                    .chars()
                                    .take(100)
                                    .collect::<String>()
                            )
                            .into(),
                        );
                    }
                    return result.value;
                }
            }
            // Not a binding - recursively process object fields
            let mut new_obj = serde_json::Map::new();
            for (k, v) in obj {
                new_obj.insert(k.clone(), evaluate_nested_bindings_impl(v, ctx, resolver, diagnostics));
            }
            serde_json::Value::Object(new_obj)
        }
        serde_json::Value::Array(arr) => {
            let new_arr: Vec<serde_json::Value> = arr
                .iter()
                .map(|v| evaluate_nested_bindings_impl(v, ctx, resolver, diagnostics))
                .collect();
            serde_json::Value::Array(new_arr)
        }
        // Primitives pass through unchanged
        other => other.clone(),
    }
}

// ============================================================================
// Operator Trait
// ============================================================================

/// Result type for operator validation
pub type ValidationResult = Vec<Diagnostic>;

/// Result type for operator application
pub type OperatorResult = Result<OpValue, Diagnostic>;

/// Signature for pure operator implementations.
pub trait Operator: Send + Sync {
    /// Stable key like "op:core.get" or "op:array.map".
    fn key(&self) -> &str;

    /// Optional human-friendly description for tooling.
    fn description(&self) -> Option<&str> {
        None
    }

    /// Optional static version for operator; bump only on breaking semantics.
    fn version(&self) -> Option<u32> {
        None
    }

    /// True when the operator consumes nested bindings as deferred templates.
    fn owns_nested_arguments(&self) -> bool { false }

    /// Optional argument validator. Return diagnostics. No panicking.
    /// The evaluator should block execution if any "error" diagnostics are returned.
    fn validate(&self, _args: Option<&OpValue>) -> ValidationResult {
        Vec::new()
    }

    /// Pure application. No side effects, no I/O.
    /// Must treat inputs as immutable and never mutate "args".
    fn apply(
        &self,
        input: &OpValue,
        args: Option<&OpValue>,
        ctx: &OperatorContext,
    ) -> OperatorResult;
}

// ============================================================================
// Function Operator Wrapper
// ============================================================================

type OperatorApplyFn =
    dyn Fn(&OpValue, Option<&OpValue>, &OperatorContext) -> OperatorResult + Send + Sync;
type OperatorValidateFn = dyn Fn(Option<&OpValue>) -> ValidationResult + Send + Sync;

/// A simple function-based operator for common cases
pub struct FnOperator {
    key: String,
    description: Option<String>,
    version: Option<u32>,
    apply_fn: Box<OperatorApplyFn>,
    validate_fn: Option<Box<OperatorValidateFn>>,
    owns_nested_arguments: bool,
}

impl FnOperator {
    /// Create a new function operator
    pub fn new<F>(key: impl Into<String>, apply_fn: F) -> Self
    where
        F: Fn(&OpValue, Option<&OpValue>, &OperatorContext) -> OperatorResult
            + Send
            + Sync
            + 'static,
    {
        Self {
            key: key.into(),
            description: None,
            version: None,
            apply_fn: Box::new(apply_fn),
            validate_fn: None,
            owns_nested_arguments: false,
        }
    }

    /// Set the description
    pub fn with_description(mut self, desc: impl Into<String>) -> Self {
        self.description = Some(desc.into());
        self
    }

    /// Set the version
    pub fn with_version(mut self, version: u32) -> Self {
        self.version = Some(version);
        self
    }

    pub fn with_nested_arguments(mut self) -> Self {
        self.owns_nested_arguments = true;
        self
    }

    /// Set the validator
    pub fn with_validator<F>(mut self, validate_fn: F) -> Self
    where
        F: Fn(Option<&OpValue>) -> ValidationResult + Send + Sync + 'static,
    {
        self.validate_fn = Some(Box::new(validate_fn));
        self
    }
}

impl Operator for FnOperator {
    fn key(&self) -> &str {
        &self.key
    }

    fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    fn version(&self) -> Option<u32> {
        self.version
    }

    fn owns_nested_arguments(&self) -> bool { self.owns_nested_arguments }

    fn validate(&self, args: Option<&OpValue>) -> ValidationResult {
        if let Some(ref validate_fn) = self.validate_fn {
            validate_fn(args)
        } else {
            Vec::new()
        }
    }

    fn apply(
        &self,
        input: &OpValue,
        args: Option<&OpValue>,
        ctx: &OperatorContext,
    ) -> OperatorResult {
        (self.apply_fn)(input, args, ctx)
    }
}

// ============================================================================
// Operator Registry
// ============================================================================

/// Key validation regex pattern
const KEY_PATTERN: &str = r"^op:[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$";

/// Check if an operator key is valid
fn is_valid_key(key: &str) -> bool {
    lazy_static::lazy_static! {
        static ref KEY_RE: regex::Regex = regex::Regex::new(KEY_PATTERN).unwrap();
    }
    KEY_RE.is_match(key)
}

/// OperatorRegistry
/// - Maintains an internal HashMap for O(1) lookup.
/// - Supports freezing to lock configurations per environment.
/// - Does not expose raw map to prevent accidental mutations.
#[derive(Clone)]
pub struct OperatorRegistry {
    operators: HashMap<String, Arc<dyn Operator>>,
    frozen: bool,
}

impl std::fmt::Debug for OperatorRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OperatorRegistry")
            .field("operators", &self.operators.keys().collect::<Vec<_>>())
            .field("frozen", &self.frozen)
            .finish()
    }
}

impl Default for OperatorRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl OperatorRegistry {
    /// Create a new empty registry
    pub fn new() -> Self {
        // #[cfg(target_arch = "wasm32")]
        // web_sys::console::log_1(&"[OperatorRegistry] Creating new empty registry".into());
        Self {
            operators: HashMap::new(),
            frozen: false,
        }
    }

    /// Register a new operator. Validates key and uniqueness.
    ///
    /// # Errors
    /// Returns an error if:
    /// - Registry is frozen
    /// - Key is invalid
    /// - Key is already registered
    pub fn register<O: Operator + 'static>(&mut self, op: O) -> Result<&mut Self, RegistryError> {
        if self.frozen {
            // #[cfg(target_arch = "wasm32")]
            // web_sys::console::log_1(&format!("[OperatorRegistry] FAILED to register (frozen): {}", op.key()).into());
            return Err(RegistryError::Frozen);
        }

        let key = op.key().to_string();

        if !is_valid_key(&key) {
            // #[cfg(target_arch = "wasm32")]
            // web_sys::console::log_1(&format!("[OperatorRegistry] FAILED to register (invalid key): {}", key).into());
            return Err(RegistryError::InvalidKey(key));
        }

        if self.operators.contains_key(&key) {
            // #[cfg(target_arch = "wasm32")]
            // web_sys::console::log_1(&format!("[OperatorRegistry] FAILED to register (duplicate): {}", key).into());
            return Err(RegistryError::Duplicate(key));
        }

        // #[cfg(target_arch = "wasm32")]
        // web_sys::console::log_1(&format!("[OperatorRegistry] Registered operator: {}", key).into());

        self.operators.insert(key, Arc::new(op));
        Ok(self)
    }

    /// Register a function operator (convenience method)
    pub fn register_fn<F>(
        &mut self,
        key: impl Into<String>,
        apply_fn: F,
    ) -> Result<&mut Self, RegistryError>
    where
        F: Fn(&OpValue, Option<&OpValue>, &OperatorContext) -> OperatorResult
            + Send
            + Sync
            + 'static,
    {
        self.register(FnOperator::new(key, apply_fn))
    }

    /// Resolve an operator by key.
    pub fn resolve(&self, key: &str) -> ResolveResult {
        // #[cfg(target_arch = "wasm32")]
        // web_sys::console::log_1(&format!("[OperatorRegistry] Resolving operator: {} (registry has {} operators)", key, self.operators.len()).into());

        if !is_valid_key(key) {
            // #[cfg(target_arch = "wasm32")]
            // web_sys::console::log_1(&format!("[OperatorRegistry] FAILED resolve (invalid key): {}", key).into());
            return ResolveResult::Err(Diagnostic {
                code: DiagnosticCode::OpKeyInvalid,
                level: DiagnosticLevel::Error,
                message: format!("Operator key \"{}\" does not match policy", key),
                at: String::new(),
                data: Some({
                    let mut map = HashMap::new();
                    map.insert("key".to_string(), serde_json::json!(key));
                    map
                }),
            });
        }

        match self.operators.get(key) {
            Some(op) => {
                // #[cfg(target_arch = "wasm32")]
                // web_sys::console::log_1(&format!("[OperatorRegistry] SUCCESS resolved operator: {}", key).into());
                ResolveResult::Ok(Arc::clone(op))
            }
            None => {
                // #[cfg(target_arch = "wasm32")]
                {
                    // web_sys::console::log_1(&format!("[OperatorRegistry] FAILED resolve (not found): {}", key).into());
                    // web_sys::console::log_1(&format!("[OperatorRegistry] Available operators ({}):", self.operators.len()).into());
                    for _available_key in self.operators.keys() {
                        // web_sys::console::log_1(&format!("[OperatorRegistry]   - {}", available_key).into());
                    }
                }
                ResolveResult::Err(Diagnostic {
                    code: DiagnosticCode::OpNotFound,
                    level: DiagnosticLevel::Error,
                    message: format!("Operator \"{}\" not found", key),
                    at: String::new(),
                    data: Some({
                        let mut map = HashMap::new();
                        map.insert("key".to_string(), serde_json::json!(key));
                        map.insert("available".to_string(), serde_json::json!(self.keys()));
                        map
                    }),
                })
            }
        }
    }

    /// Get an operator directly (returns None if not found)
    pub fn get(&self, key: &str) -> Option<Arc<dyn Operator>> {
        let result = self.operators.get(key).cloned();
        // #[cfg(target_arch = "wasm32")]
        {
            if result.is_some() {
                // web_sys::console::log_1(&format!("[OperatorRegistry] get('{}') -> FOUND", key).into());
            } else {
                // web_sys::console::log_1(&format!("[OperatorRegistry] get('{}') -> NOT FOUND (registry has {} operators)", key, self.operators.len()).into());
            }
        }
        result
    }

    /// List all registered keys
    pub fn keys(&self) -> Vec<String> {
        self.operators.keys().cloned().collect()
    }

    /// Get the number of registered operators
    pub fn len(&self) -> usize {
        self.operators.len()
    }

    /// Check if the registry is empty
    pub fn is_empty(&self) -> bool {
        self.operators.is_empty()
    }

    /// Freeze the registry to prevent further mutations
    pub fn freeze(&mut self) -> &mut Self {
        self.frozen = true;
        self
    }

    /// Check if the registry is frozen
    pub fn is_frozen(&self) -> bool {
        self.frozen
    }
}

/// Result of operator resolution
pub enum ResolveResult {
    Ok(Arc<dyn Operator>),
    Err(Diagnostic),
}

impl ResolveResult {
    pub fn is_ok(&self) -> bool {
        matches!(self, ResolveResult::Ok(_))
    }

    pub fn is_err(&self) -> bool {
        matches!(self, ResolveResult::Err(_))
    }

    pub fn ok(self) -> Option<Arc<dyn Operator>> {
        match self {
            ResolveResult::Ok(op) => Some(op),
            ResolveResult::Err(_) => None,
        }
    }

    pub fn err(self) -> Option<Diagnostic> {
        match self {
            ResolveResult::Ok(_) => None,
            ResolveResult::Err(d) => Some(d),
        }
    }
}

/// Errors that can occur during registry operations
#[derive(Debug, Clone, PartialEq)]
pub enum RegistryError {
    /// Registry is frozen and cannot be modified
    Frozen,
    /// Invalid operator key format
    InvalidKey(String),
    /// Duplicate operator key
    Duplicate(String),
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RegistryError::Frozen => write!(f, "OperatorRegistry is frozen"),
            RegistryError::InvalidKey(key) => write!(f, "Invalid operator key: {}", key),
            RegistryError::Duplicate(key) => {
                write!(f, "Operator with key '{}' is already registered", key)
            }
        }
    }
}

impl std::error::Error for RegistryError {}

/// Helper to create a hardened registry in one call.
pub fn create_registry() -> OperatorRegistry {
    OperatorRegistry::new()
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // Simple identity operator for testing
    fn identity_op() -> FnOperator {
        FnOperator::new("op:core.identity", |input, _, _| Ok(input.clone()))
    }

    /// Helper to convert serde_json::Value to OpValue for test assertions
    fn to_op(v: serde_json::Value) -> OpValue {
        OpValue::from(v)
    }

    #[test]
    fn test_register_and_resolve() {
        let mut registry = OperatorRegistry::new();
        registry.register(identity_op()).unwrap();

        let result = registry.resolve("op:core.identity");
        assert!(result.is_ok());
    }

    #[test]
    fn test_resolve_not_found() {
        let registry = OperatorRegistry::new();
        let result = registry.resolve("op:unknown");
        assert!(result.is_err());

        if let ResolveResult::Err(diag) = result {
            assert_eq!(diag.code, DiagnosticCode::OpNotFound);
        }
    }

    #[test]
    fn test_invalid_key() {
        let mut registry = OperatorRegistry::new();
        let op = FnOperator::new("invalid-key", |input, _, _| Ok(input.clone()));
        let result = registry.register(op);

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), RegistryError::InvalidKey(_)));
    }

    #[test]
    fn test_duplicate_key() {
        let mut registry = OperatorRegistry::new();
        registry.register(identity_op()).unwrap();

        let result = registry.register(identity_op());
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), RegistryError::Duplicate(_)));
    }

    #[test]
    fn test_freeze() {
        let mut registry = OperatorRegistry::new();
        registry.register(identity_op()).unwrap();
        registry.freeze();

        assert!(registry.is_frozen());

        let op2 = FnOperator::new("op:core.other", |input, _, _| Ok(input.clone()));
        let result = registry.register(op2);
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), RegistryError::Frozen));
    }

    #[test]
    fn test_keys() {
        let mut registry = OperatorRegistry::new();
        registry.register(identity_op()).unwrap();

        let add_op = FnOperator::new("op:math.add", |input, _, _| Ok(input.clone()));
        registry.register(add_op).unwrap();

        let keys = registry.keys();
        assert_eq!(keys.len(), 2);
        assert!(keys.contains(&"op:core.identity".to_string()));
        assert!(keys.contains(&"op:math.add".to_string()));
    }

    #[test]
    fn test_operator_apply() {
        let mut registry = OperatorRegistry::new();
        registry.register(identity_op()).unwrap();

        let op = registry.get("op:core.identity").unwrap();
        let ctx = OperatorContext::new(BindingEvaluationContext::default(), "op:core.identity", 0);

        let input_json = serde_json::json!({"key": "value"});
        let input = to_op(input_json.clone());
        let result = op.apply(&input, None, &ctx);

        assert!(result.is_ok());
        assert_eq!(result.unwrap().into_inner(), input_json);
    }

    #[test]
    fn test_fn_operator_with_description() {
        let op = FnOperator::new("op:test.example", |input, _, _| Ok(input.clone()))
            .with_description("A test operator")
            .with_version(1);

        assert_eq!(op.key(), "op:test.example");
        assert_eq!(op.description(), Some("A test operator"));
        assert_eq!(op.version(), Some(1));
    }

    #[test]
    fn test_valid_keys() {
        assert!(is_valid_key("op:core.identity"));
        assert!(is_valid_key("op:math.add"));
        assert!(is_valid_key("op:text.uppercase"));
        assert!(is_valid_key("op:a1"));
        assert!(is_valid_key("op:my-ns.my-op"));
        assert!(is_valid_key("op:ns:sub.op"));

        assert!(!is_valid_key("core.identity")); // Missing "op:"
        assert!(!is_valid_key("op:")); // Empty after prefix
        assert!(!is_valid_key("op:UPPER")); // Uppercase
        assert!(!is_valid_key("op:-invalid")); // Starts with hyphen
    }
}
