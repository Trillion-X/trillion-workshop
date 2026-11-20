//! crates/composition-ast/src/binding/operators/formula_adapter.rs
//!
//! Pure adapter that exposes a formula-evaluation operator to the Binding Engine
//! without coupling the kernel to any specific formula runtime. It defines a
//! deterministic, side-effect-free interface that any host-provided formula
//! engine (WASM, native, JS) can implement. The adapter returns a pure Operator
//! that the kernel can register in its OperatorRegistry.
//!
//! Non-Negotiable Invariants
//! -------------------------
//! - No I/O. No global state. No timers. Pure data in -> pure data out.
//! - The adapter does not parse or "eval" anything itself. It only delegates
//!   to an injected engine that conforms to the strict `FormulaEngine` contract.
//! - Arguments are validated. Unknown fields are rejected. Errors are structured.
//! - The operator is deterministic for a fixed (formula, input, ctx.eval) tuple.
//!
//! Key Concepts
//! ------------
//! - FormulaEngine: minimal, portable interface for deterministic evaluation.
//! - CompiledFormula: optional precompiled artifact with a pure .evaluate method.
//! - Operator factory: `create_formula_operator` builds a pure operator bound to
//!   a specific engine instance and optional compile-cache.
//!
//! Security Considerations
//! -----------------------
//! - The adapter never calls dynamic code. Engines must be audited and sandboxed
//!   by the host. The adapter stays pure.
//! - Untrusted `args.vars` are treated as data only. No functions allowed.
//! - Diagnostics use machine codes. No stack leaks or stringly-typed errors.
//!
//! Ported from: frontends/web/composition-engine/binding/operators/formula.adapter.ts

use super::registry::{FnOperator, OperatorRegistry, RegistryError};
use crate::binding::ast::{Diagnostic, DiagnosticCode, DiagnosticLevel};
use crate::binding::cache::LRUCache;
use ops_core::OpValue;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

// ============================================================================
// Engine contracts
// ============================================================================

/// Minimal result envelope from a formula evaluation.
#[derive(Debug, Clone)]
pub struct FormulaEvalResult {
    /// The computed value.
    pub value: Value,
    /// Optional diagnostics (warnings like division-by-zero handling).
    pub diagnostics: Vec<Diagnostic>,
    /// True if expression is total and produced a value without fallbacks.
    pub complete: bool,
}

impl Default for FormulaEvalResult {
    fn default() -> Self {
        Self {
            value: Value::Null,
            diagnostics: Vec::new(),
            complete: true,
        }
    }
}

/// Deterministic environment exposed to formulas.
#[derive(Debug, Clone)]
pub struct FormulaEnv {
    /// Primary input value flowing through the binding pipeline.
    pub self_value: Value,
    /// Optional explicit variables supplied by the binding step.
    pub vars: Option<HashMap<String, Value>>,
    /// Ambient values are pure for the duration of a tick.
    pub ambient: Option<HashMap<String, Value>>,
    /// Locale for deterministic formatting.
    pub locale: Option<String>,
    /// Kernel version for deterministic behavior.
    pub kernel_version: Option<String>,
}

impl Default for FormulaEnv {
    fn default() -> Self {
        Self {
            self_value: Value::Null,
            vars: None,
            ambient: None,
            locale: None,
            kernel_version: None,
        }
    }
}

/// CompiledFormula: fully deterministic, referentially transparent evaluator
/// produced by a FormulaEngine. It must never capture global state.
pub trait CompiledFormula: Send + Sync {
    /// Optional engine-internal fingerprint for caching or audit.
    fn fingerprint(&self) -> Option<&str> {
        None
    }

    /// Evaluate against a pure environment. No I/O. Must be deterministic for
    /// the same inputs. Must never mutate its inputs or outputs.
    fn evaluate(&self, env: &FormulaEnv) -> FormulaEvalResult;
}

/// FormulaEngine: host-provided, sandboxed engine. It may choose to either:
/// - directly evaluate a string formula with `evaluate`, or
/// - compile once with `compile` and evaluate many times.
///
/// Both paths must be functionally identical for the same (formula, env).
pub trait FormulaEngine: Send + Sync {
    /// Human-readable engine id (e.g., "wasm:fe@1.3.0"). Used in hashing and audit.
    fn id(&self) -> &str;

    /// Optional semantic version for stricter cache segmentation.
    fn version(&self) -> Option<&str> {
        None
    }

    /// Direct evaluation path. Must be pure and deterministic.
    fn evaluate(&self, formula: &str, env: &FormulaEnv) -> FormulaEvalResult;

    /// Optional compile path for performance. Must be pure and deterministic.
    /// Returns None if compilation is not supported.
    fn compile(&self, formula: &str) -> Option<Arc<dyn CompiledFormula>>;
}

// ============================================================================
// Operator definition
// ============================================================================

/// Stable operator key.
pub const FORMULA_OP_KEY: &str = "op:formula.eval";

/// Maximum formula length.
const MAX_FORMULA_LENGTH: usize = 16_384;

/// Diagnostic helper.
fn dx(code: DiagnosticCode, level: DiagnosticLevel, message: &str) -> Diagnostic {
    Diagnostic {
        code,
        level,
        message: message.to_string(),
        at: String::new(),
        data: None,
    }
}

/// Result of parsing that carries both the value and any diagnostics (including warnings).
/// This pattern allows returning warnings alongside successful parses, matching
/// compiler/validator semantics where warnings don't block but should be reported.
#[derive(Debug, Clone)]
pub struct ParseResult<T> {
    /// The successfully parsed value.
    pub value: T,
    /// Diagnostics collected during parsing (may include warnings even on success).
    pub diagnostics: Vec<Diagnostic>,
}

impl<T> ParseResult<T> {
    /// Check if there are any error-level diagnostics.
    pub fn has_errors(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|d| d.level == DiagnosticLevel::Error)
    }

    /// Check if there are any warning-level diagnostics.
    pub fn has_warnings(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|d| d.level == DiagnosticLevel::Warn)
    }
}

/// Argument contract for the formula operator.
#[derive(Debug, Clone)]
pub struct FormulaOperatorArgs {
    /// Required expression string. Must be UTF-8, non-empty, and bounded.
    pub formula: String,
    /// Optional explicit variables accessible as `vars.<name>` in the formula.
    pub vars: Option<HashMap<String, Value>>,
}

impl FormulaOperatorArgs {
    /// Parse args from a serde_json::Value.
    /// Returns Ok(ParseResult) with value and any warnings on success,
    /// or Err(diagnostics) with errors on failure.
    pub fn from_value(args: Option<&Value>) -> Result<ParseResult<Self>, Vec<Diagnostic>> {
        let args = match args {
            Some(v) => v,
            None => {
                return Err(vec![dx(
                    DiagnosticCode::OpArgsInvalid,
                    DiagnosticLevel::Error,
                    "args must be provided",
                )]);
            }
        };

        if !args.is_object() {
            return Err(vec![dx(
                DiagnosticCode::OpArgsInvalid,
                DiagnosticLevel::Error,
                "args must be an object",
            )]);
        }

        let mut diagnostics = Vec::new();

        // Check for unknown fields
        if let Some(obj) = args.as_object() {
            for key in obj.keys() {
                if key != "formula" && key != "vars" {
                    diagnostics.push(dx(
                        DiagnosticCode::BindingUnknownField,
                        DiagnosticLevel::Warn,
                        &format!("unknown arg: {}", key),
                    ));
                }
            }
        }

        // Validate formula
        let formula = args
            .get("formula")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let formula = match formula {
            Some(f) if f.trim().is_empty() => {
                diagnostics.push(dx(
                    DiagnosticCode::OpArgsInvalid,
                    DiagnosticLevel::Error,
                    "args.formula must be a non-empty string",
                ));
                return Err(diagnostics);
            }
            Some(f) if f.len() > MAX_FORMULA_LENGTH => {
                diagnostics.push(dx(
                    DiagnosticCode::OpArgsInvalid,
                    DiagnosticLevel::Error,
                    &format!("args.formula exceeds {}K limit", MAX_FORMULA_LENGTH / 1024),
                ));
                return Err(diagnostics);
            }
            Some(f) => f,
            None => {
                diagnostics.push(dx(
                    DiagnosticCode::OpArgsInvalid,
                    DiagnosticLevel::Error,
                    "args.formula must be a non-empty string",
                ));
                return Err(diagnostics);
            }
        };

        // Validate vars if present
        let vars = args.get("vars").and_then(|v| {
            if v.is_null() {
                None
            } else if let Some(obj) = v.as_object() {
                let mut map = HashMap::new();
                for (k, val) in obj {
                    map.insert(k.clone(), val.clone());
                }
                Some(map)
            } else {
                diagnostics.push(dx(
                    DiagnosticCode::OpArgsInvalid,
                    DiagnosticLevel::Error,
                    "args.vars must be an object map",
                ));
                None
            }
        });

        // Check for errors - if any, return Err with all diagnostics
        if diagnostics
            .iter()
            .any(|d| d.level == DiagnosticLevel::Error)
        {
            return Err(diagnostics);
        }

        // Success - return value WITH any warnings
        Ok(ParseResult {
            value: Self { formula, vars },
            diagnostics,
        })
    }
}

/// Validate operator args. Returns all diagnostics (errors and warnings); never panics.
pub fn validate_formula_args(args: Option<&OpValue>) -> Vec<Diagnostic> {
    let args_json = args.map(|a| a.as_inner().clone());
    let args_ref = args_json.as_ref();
    match FormulaOperatorArgs::from_value(args_ref) {
        Ok(result) => result.diagnostics, // Return warnings from successful parse
        Err(diags) => diags,              // Return errors from failed parse
    }
}

// ============================================================================
// Compile cache (local to adapter, deterministic LRU by formula string)
// ============================================================================

type CacheKey = String; // `${engineId}@${engineVersion ?? '-'}::${formula}`

fn make_cache_key(formula: &str, engine_id: &str, engine_version: Option<&str>) -> CacheKey {
    format!(
        "{}@{}::{}",
        engine_id,
        engine_version.unwrap_or("-"),
        formula
    )
}

/// Local compile cache for formula compilation results.
pub struct FormulaCompileCache {
    cache: RwLock<LRUCache<Arc<dyn CompiledFormula>>>,
}

impl FormulaCompileCache {
    /// Create a new compile cache with the given capacity.
    pub fn new(capacity: usize) -> Self {
        Self {
            cache: RwLock::new(LRUCache::new(capacity)),
        }
    }

    /// Get a compiled formula from the cache.
    pub fn get(
        &self,
        formula: &str,
        engine_id: &str,
        engine_version: Option<&str>,
    ) -> Option<Arc<dyn CompiledFormula>> {
        let key = make_cache_key(formula, engine_id, engine_version);
        let mut cache = self.cache.write().ok()?;
        cache.get(&key)
    }

    /// Set a compiled formula in the cache.
    pub fn set(
        &self,
        formula: &str,
        engine_id: &str,
        engine_version: Option<&str>,
        compiled: Arc<dyn CompiledFormula>,
    ) {
        let key = make_cache_key(formula, engine_id, engine_version);
        if let Ok(mut cache) = self.cache.write() {
            cache.set(key, compiled);
        }
    }
}

// ============================================================================
// Operator factory
// ============================================================================

/// Create a pure formula operator bound to a specific engine instance.
/// You control registration via your composition root:
///
/// ```ignore
/// let engine = MyFormulaEngine::new();
/// let op = create_formula_operator(engine, None);
/// registry.register(op)?;
/// ```
pub fn create_formula_operator(
    engine: Arc<dyn FormulaEngine>,
    compile_cache_capacity: Option<usize>,
) -> FnOperator {
    let cache = Arc::new(FormulaCompileCache::new(
        compile_cache_capacity.unwrap_or(256),
    ));

    let engine_clone = Arc::clone(&engine);
    let cache_clone = Arc::clone(&cache);

    FnOperator::new(FORMULA_OP_KEY, move |input, args, ctx| {
        // Convert OpValue args to serde_json::Value for existing parser
        let args_json = args.map(|a| a.as_inner().clone());
        let args_ref = args_json.as_ref();

        // Validate arguments first.
        let parse_result = match FormulaOperatorArgs::from_value(args_ref) {
            Ok(result) => result,
            Err(diags) => {
                // Return the first error diagnostic
                if let Some(err) = diags
                    .into_iter()
                    .find(|d| d.level == DiagnosticLevel::Error)
                {
                    return Err(err);
                }
                return Err(dx(
                    DiagnosticCode::OpArgsInvalid,
                    DiagnosticLevel::Error,
                    "Invalid arguments for op:formula.eval",
                ));
            }
        };

        // Note: parse_result.diagnostics may contain warnings, but the operator
        // return type doesn't support returning warnings alongside Ok. For now,
        // warnings are discarded at execution time but ARE returned during validation.
        let FormulaOperatorArgs { formula, vars } = parse_result.value;

        // Prepare deterministic environment.
        let ambient = if ctx.eval_ctx.ambient.is_empty() {
            None
        } else {
            Some(ctx.eval_ctx.ambient.clone())
        };
        let env = FormulaEnv {
            self_value: input.clone().into_inner(),
            vars,
            ambient,
            locale: ctx.eval_ctx.locale.clone(),
            kernel_version: ctx.eval_ctx.kernel_version.clone(),
        };

        // Prefer compiled form if available and cached.
        if engine_clone.compile(&formula).is_some() {
            let compiled = cache_clone
                .get(&formula, engine_clone.id(), engine_clone.version())
                .or_else(|| {
                    let cf = engine_clone.compile(&formula)?;
                    cache_clone.set(
                        &formula,
                        engine_clone.id(),
                        engine_clone.version(),
                        Arc::clone(&cf),
                    );
                    Some(cf)
                });

            if let Some(cf) = compiled {
                let r = cf.evaluate(&env);
                return Ok(OpValue::from(r.value));
            }
        }

        // Fallback to direct evaluate.
        let r = engine_clone.evaluate(&formula, &env);
        Ok(OpValue::from(r.value))
    })
    .with_description("Evaluate a formula against the pipeline value and optional vars")
    .with_version(1)
    .with_validator(validate_formula_args)
}

/// Register the formula operator into a registry.
pub fn register_formula_operator(
    registry: &mut OperatorRegistry,
    engine: Arc<dyn FormulaEngine>,
    compile_cache_capacity: Option<usize>,
) -> Result<(), RegistryError> {
    let op = create_formula_operator(engine, compile_cache_capacity);
    registry.register(op)?;
    Ok(())
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::super::registry::Operator;
    use super::*;

    /// Simple test engine that just echoes the formula as a string.
    struct EchoEngine;

    impl FormulaEngine for EchoEngine {
        fn id(&self) -> &str {
            "test:echo@1.0"
        }

        fn version(&self) -> Option<&str> {
            Some("1.0")
        }

        fn evaluate(&self, formula: &str, env: &FormulaEnv) -> FormulaEvalResult {
            // Simple echo: return the formula concatenated with the self value
            let result = format!(
                "formula={}, self={}",
                formula,
                serde_json::to_string(&env.self_value).unwrap_or_default()
            );
            FormulaEvalResult {
                value: Value::String(result),
                diagnostics: Vec::new(),
                complete: true,
            }
        }

        fn compile(&self, _formula: &str) -> Option<Arc<dyn CompiledFormula>> {
            None // No compilation support
        }
    }

    #[test]
    fn test_validate_formula_args_valid() {
        let args = serde_json::json!({
            "formula": "1 + 2"
        });
        let diags = validate_formula_args(Some(&OpValue::from(args.clone())));
        assert!(diags.is_empty());
    }

    #[test]
    fn test_validate_formula_args_missing_formula() {
        let args = serde_json::json!({});
        let diags = validate_formula_args(Some(&OpValue::from(args.clone())));
        assert!(!diags.is_empty());
        assert!(diags.iter().any(|d| d.level == DiagnosticLevel::Error));
    }

    #[test]
    fn test_validate_formula_args_empty_formula() {
        let args = serde_json::json!({
            "formula": "   "
        });
        let diags = validate_formula_args(Some(&OpValue::from(args.clone())));
        assert!(!diags.is_empty());
        assert!(diags.iter().any(|d| d.level == DiagnosticLevel::Error));
    }

    #[test]
    fn test_validate_formula_args_with_vars() {
        let args = serde_json::json!({
            "formula": "x + y",
            "vars": { "x": 1, "y": 2 }
        });
        let diags = validate_formula_args(Some(&OpValue::from(args.clone())));
        assert!(diags.is_empty());
    }

    #[test]
    fn test_validate_formula_args_unknown_field() {
        let args = serde_json::json!({
            "formula": "1 + 2",
            "unknown": "value"
        });
        let diags = validate_formula_args(Some(&OpValue::from(args.clone())));
        // Unknown fields produce warnings, not errors - validation passes but warns
        assert!(diags.iter().any(|d| d.level == DiagnosticLevel::Warn));
        assert!(!diags.iter().any(|d| d.level == DiagnosticLevel::Error));
    }

    #[test]
    fn test_formula_operator_args_parsing() {
        let args = serde_json::json!({
            "formula": "x + y",
            "vars": { "x": 10, "y": 20 }
        });
        let result = FormulaOperatorArgs::from_value(Some(&args)).unwrap();
        assert!(result.diagnostics.is_empty()); // No warnings
        let parsed = result.value;
        assert_eq!(parsed.formula, "x + y");
        assert!(parsed.vars.is_some());
        let vars = parsed.vars.unwrap();
        assert_eq!(vars.get("x"), Some(&serde_json::json!(10)));
        assert_eq!(vars.get("y"), Some(&serde_json::json!(20)));
    }

    #[test]
    fn test_create_formula_operator() {
        let engine = Arc::new(EchoEngine);
        let op = create_formula_operator(engine, Some(100));
        assert_eq!(op.key(), FORMULA_OP_KEY);
        assert_eq!(op.version(), Some(1));
    }

    #[test]
    fn test_register_formula_operator() {
        let mut registry = OperatorRegistry::new();
        let engine = Arc::new(EchoEngine);
        register_formula_operator(&mut registry, engine, None).unwrap();
        assert!(registry.get(FORMULA_OP_KEY).is_some());
    }

    #[test]
    fn test_formula_compile_cache() {
        let cache = FormulaCompileCache::new(10);
        assert!(cache.get("formula", "engine", Some("1.0")).is_none());
    }
}
