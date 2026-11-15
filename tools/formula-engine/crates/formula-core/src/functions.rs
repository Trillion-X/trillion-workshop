//! Function Registry and Built-in Function Implementations for the Formula Engine
//!
//! This module provides the generic function dispatch system that allows the evaluator
//! to dynamically look up and execute functions without hardcoding them. The architecture
//! consists of:
//!
//! - `Function` trait: Interface that all built-in functions must implement
//! - `FunctionRegistry`: Central registry that holds all available functions
//! - Built-in function implementations: VALUE(), TEXT(), and future functions
//!
//! ## Architecture Benefits
//!
//! This design eliminates hardcoded function matching and makes adding new functions
//! in Phase 4 trivial - just implement the Function trait and register it.

use crate::{EvaluationContext, EvaluationError, EvaluationResult, Value};
use std::collections::HashMap;
use std::sync::Arc;

/// Call style determines whether arguments are evaluated before or during function execution
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum CallStyle {
    /// Arguments are evaluated before function is called (default)
    Eager,
    /// Arguments are passed as thunks and evaluated on-demand
    Lazy,
}

/// A lazy value is a thunk that can be evaluated on demand.
///
/// LazyValue closures are **not** Send/Sync on purpose.
/// They must be evaluated synchronously on the same thread by the evaluator.
/// Do not capture or move them across threads.
pub type LazyEvaluator = dyn Fn(&mut EvaluationContext) -> EvaluationResult<Value>;

pub struct LazyValue(pub Arc<LazyEvaluator>);

impl LazyValue {
    /// Create a new lazy value from a closure
    pub fn new<F>(f: F) -> Self
    where
        F: Fn(&mut EvaluationContext) -> EvaluationResult<Value> + 'static,
    {
        Self(Arc::new(f))
    }

    /// Evaluate the lazy value to get the actual value
    pub fn evaluate(&self, ctx: &mut EvaluationContext) -> EvaluationResult<Value> {
        (self.0)(ctx)
    }
}

/// The trait that all built-in functions must implement.
pub trait Function: Send + Sync {
    /// The name of the function (e.g., "SUM").
    fn name(&self) -> &'static str;

    /// Whether this function uses eager or lazy evaluation (default: eager)
    fn call_style(&self) -> CallStyle {
        CallStyle::Eager
    }

    /// The core logic of the function (for eager evaluation).
    fn execute(&self, args: &[Value], context: &mut EvaluationContext) -> EvaluationResult<Value>;

    /// The core logic for lazy evaluation (default delegates to eager after evaluating all args)
    fn execute_lazy(
        &self,
        args: &[LazyValue],
        ctx: &mut EvaluationContext,
    ) -> EvaluationResult<Value> {
        // Default implementation: evaluate all args then call execute
        let mut vals = Vec::with_capacity(args.len());
        for a in args {
            vals.push(a.evaluate(ctx)?);
        }
        self.execute(&vals, ctx)
    }
}

/// The Function Registry holds all the available built-in functions.
pub struct FunctionRegistry {
    functions: HashMap<String, Box<dyn Function>>,
}

impl FunctionRegistry {
    /// Creates a new registry and populates it with all the core functions.
    pub fn new() -> Self {
        let mut registry = Self {
            functions: HashMap::new(),
        };

        // Core conversion functions
        registry.register(Box::new(ValueFunction));
        registry.register(Box::new(TextFunction));

        // Note: Most functions (HASH, HMAC, CONCAT, etc.) are now RewriteRules
        // registered in rules/registry.rs and executed by the Solver, not the Evaluator.
        // Only VALUE() and TEXT() remain as direct Function implementations.

        registry
    }

    /// Registers a new function.
    pub(crate) fn register(&mut self, func: Box<dyn Function>) {
        self.functions.insert(func.name().to_uppercase(), func);
    }

    /// Looks up a function by name (case-insensitive).
    pub fn lookup(&self, name: &str) -> Option<&dyn Function> {
        self.functions.get(&name.to_uppercase()).map(|f| f.as_ref())
    }

    /// Get all registered function names
    pub fn get_function_names(&self) -> Vec<String> {
        self.functions.keys().cloned().collect()
    }

    /// Check if a function is registered
    pub fn has_function(&self, name: &str) -> bool {
        self.functions.contains_key(&name.to_uppercase())
    }
}

impl Default for FunctionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// --- Initial Built-in Function Implementations ---

struct ValueFunction;
impl Function for ValueFunction {
    fn name(&self) -> &'static str {
        "VALUE"
    }

    fn execute(&self, args: &[Value], _context: &mut EvaluationContext) -> EvaluationResult<Value> {
        if args.len() != 1 {
            return Err(EvaluationError::Runtime {
                message: "VALUE() expects exactly 1 argument".to_string(),
                position: None,
            });
        }
        // The conversion logic is already in types.rs, we just call it.
        crate::types::type_coercion::value_function(&args[0]).map_err(|e| {
            EvaluationError::Runtime {
                message: e.to_string(),
                position: None,
            }
        })
    }
}

struct TextFunction;
impl Function for TextFunction {
    fn name(&self) -> &'static str {
        "TEXT"
    }

    fn execute(&self, args: &[Value], _context: &mut EvaluationContext) -> EvaluationResult<Value> {
        if args.len() != 1 {
            return Err(EvaluationError::Runtime {
                message: "TEXT() expects exactly 1 argument".to_string(),
                position: None,
            });
        }
        // The conversion logic is already in types.rs.
        Ok(crate::types::type_coercion::text_function(&args[0]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::EvaluationContext;

    #[test]
    fn test_function_registry_creation() {
        let registry = FunctionRegistry::new();
        // Only VALUE and TEXT are registered as Functions
        // All other functions (HASH, CONCAT, etc.) are now RewriteRules
        assert!(registry.has_function("VALUE"));
        assert!(registry.has_function("TEXT"));
        assert!(!registry.has_function("UNKNOWN"));
    }

    #[test]
    fn test_function_lookup() {
        let registry = FunctionRegistry::new();

        // Test case-insensitive lookup
        assert!(registry.lookup("value").is_some());
        assert!(registry.lookup("VALUE").is_some());
        assert!(registry.lookup("Value").is_some());
        assert!(registry.lookup("text").is_some());
        assert!(registry.lookup("UNKNOWN").is_none());
    }

    #[test]
    fn test_value_function_execution() {
        let registry = FunctionRegistry::new();
        let mut context = EvaluationContext::new();

        let value_func = registry.lookup("VALUE").unwrap();

        // Test successful conversion
        let args = vec![Value::string("42")];
        let result = value_func.execute(&args, &mut context).unwrap();
        assert_eq!(result, Value::number(42.0));

        // Test wrong argument count
        let args = vec![Value::string("42"), Value::string("extra")];
        let result = value_func.execute(&args, &mut context);
        assert!(result.is_err());
    }

    #[test]
    fn test_text_function_execution() {
        let registry = FunctionRegistry::new();
        let mut context = EvaluationContext::new();

        let text_func = registry.lookup("TEXT").unwrap();

        // Test successful conversion
        let args = vec![Value::number(42.0)];
        let result = text_func.execute(&args, &mut context).unwrap();
        assert_eq!(result, Value::string("42"));

        // Test wrong argument count
        let args = vec![];
        let result = text_func.execute(&args, &mut context);
        assert!(result.is_err());
    }
}
