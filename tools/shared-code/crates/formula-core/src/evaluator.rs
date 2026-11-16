//! Core Evaluation Engine for the Formula Engine
//!
//! This module implements the tree-walking interpreter that evaluates AST nodes
//! and produces typed results. It handles all behavioral logic including:
//! - Binary and unary operations with strict typing
//! - SQL-style null propagation
//! - Semantic reference resolution
//! - Function call evaluation
//! - ReadSet tracking for dependency analysis
//!
//! ## Architecture
//!
//! The evaluator follows a clean separation of concerns:
//! - `types.rs` defines WHAT a Value is (structure + basic predicates)  
//! - `evaluator.rs` defines HOW Values behave (operations + logic)
//! - `context.rs` manages evaluation context and variable resolution
//!
//! ## Error Handling
//!
//! All evaluation operations return `EvaluationResult<T>` which can contain:
//! - Successful results with automatic ReadSet tracking
//! - Type mismatch errors (E_TYPE_MISMATCH = 1001)
//! - Runtime errors with context information
//! - Security violations from permission checks

use crate::ast::{
    flatten_member_chain, AstNode, BinaryOp, Expression, FunctionCallExpr, IndexAccessExpr,
    Literal, MemberAccessExpr, UnaryOp,
};
use crate::context::EvaluationContext;
use crate::functions::{CallStyle, FunctionRegistry, LazyValue};
use crate::types::{type_coercion, TypeError, Value};

enum IndexDescriptor {
    Key(String),
    Index(i64),
    Dynamic,
}

fn describe_index_for_tracking(v: &Value) -> IndexDescriptor {
    if let Some(s) = v.inner().as_str() {
        return IndexDescriptor::Key(s.to_string());
    }
    if let Some(i) = v.inner().as_i64() {
        return IndexDescriptor::Index(i);
    }
    if let Some(f) = v.inner().as_f64() {
        // integer-valued float (e.g., 0.0, 12.0) → index
        if f.is_finite() && f.fract() == 0.0 {
            // guard against overflow when casting
            if f >= i64::MIN as f64 && f <= i64::MAX as f64 {
                return IndexDescriptor::Index(f as i64);
            }
        }
    }
    IndexDescriptor::Dynamic
}

/// Try to flatten ONLY special-base chains like @.owner.name or $scope.settings.theme.
/// - Supports MemberAccess and IndexAccess (string index only) so we can track precise paths.
/// - Falls back to ".<dynamic>" when index isn't a string literal.
fn try_special_chain_for_tracking(e: &Expression) -> Option<String> {
    fn recur(e: &Expression, props: &mut Vec<String>) -> Option<String> {
        match e {
            Expression::MemberAccess(ma) => {
                props.push(format!(".{}", ma.property));
                recur(&ma.object, props)
            }
            Expression::IndexAccess(ix) => {
                if let Expression::Literal(Literal::String(s)) = &ix.index {
                    props.push(format!(".{}", s));
                } else {
                    props.push(".<dynamic>".to_string());
                }
                recur(&ix.array, props)
            }
            Expression::Identifier(s) if s == "@" || s == "@@" || s == "$scope" => Some(s.clone()),
            _ => None,
        }
    }

    let mut props = Vec::new();
    let base = recur(e, &mut props)?;
    props.reverse();
    let mut out = base;
    for p in props {
        out.push_str(&p);
    }
    Some(out)
}

/// Result type for all evaluation operations
pub type EvaluationResult<T> = Result<T, EvaluationError>;

/// Errors that can occur during formula evaluation
#[derive(Debug, Clone, PartialEq)]
pub enum EvaluationError {
    /// Type mismatch error (maps to E_TYPE_MISMATCH = 1001)
    TypeMismatch {
        operation: String,
        expected: String,
        found: String,
        position: Option<(usize, usize)>,
    },
    /// Runtime error during evaluation
    Runtime {
        message: String,
        position: Option<(usize, usize)>,
    },
    /// Security violation (permission denied, etc.)
    Security {
        message: String,
        position: Option<(usize, usize)>,
    },
    /// Context error (undefined variable, etc.)
    Context {
        message: String,
        identifier: String,
        position: Option<(usize, usize)>,
    },
    /// Wraps multiple validation errors from the context pre-flight check.
    ContextValidation(Vec<crate::context::ContextValidationError>),
    /// Division by zero error (E_DOMAIN_DIV_BY_ZERO)
    DomainErrorDivByZero {
        function: String,
        position: Option<(usize, usize)>,
    },
    /// Invalid domain for a function, e.g., SQRT(-1) (E_DOMAIN_*)
    DomainError {
        function: String,
        message: String,
        position: Option<(usize, usize)>,
    },
    /// Numeric result was non-finite (NaN/Infinity) (E_NUM_NONFINITE)
    NumericErrorNonFinite {
        function: String,
        position: Option<(usize, usize)>,
    },
    /// Numeric overflow during calculation (E_NUM_OVERFLOW)
    NumericErrorOverflow {
        function: String,
        position: Option<(usize, usize)>,
    },
}

impl std::fmt::Display for EvaluationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EvaluationError::TypeMismatch {
                operation,
                expected,
                found,
                position,
            } => {
                if let Some((line, col)) = position {
                    write!(f, "Type mismatch at line {}, column {}: operation '{}' expected {} but found {}", 
                           line, col, operation, expected, found)
                } else {
                    write!(
                        f,
                        "Type mismatch: operation '{}' expected {} but found {}",
                        operation, expected, found
                    )
                }
            }
            EvaluationError::Runtime { message, position } => {
                if let Some((line, col)) = position {
                    write!(
                        f,
                        "Runtime error at line {}, column {}: {}",
                        line, col, message
                    )
                } else {
                    write!(f, "Runtime error: {}", message)
                }
            }
            EvaluationError::Security { message, position } => {
                if let Some((line, col)) = position {
                    write!(
                        f,
                        "Security violation at line {}, column {}: {}",
                        line, col, message
                    )
                } else {
                    write!(f, "Security violation: {}", message)
                }
            }
            EvaluationError::Context {
                message,
                identifier,
                position,
            } => {
                if let Some((line, col)) = position {
                    write!(
                        f,
                        "Context error at line {}, column {}: {} (identifier: '{}')",
                        line, col, message, identifier
                    )
                } else {
                    write!(
                        f,
                        "Context error: {} (identifier: '{}')",
                        message, identifier
                    )
                }
            }
            EvaluationError::ContextValidation(errors) => {
                write!(
                    f,
                    "Context validation failed with {} error(s): ",
                    errors.len()
                )?;
                for (i, error) in errors.iter().enumerate() {
                    if i > 0 {
                        write!(f, "; ")?;
                    }
                    write!(f, "{}", error)?;
                }
                Ok(())
            }
            EvaluationError::DomainErrorDivByZero { function, position } => {
                if let Some((line, col)) = position {
                    write!(
                        f,
                        "Division by zero error at line {}, column {}: {} function",
                        line, col, function
                    )
                } else {
                    write!(f, "Division by zero error: {} function", function)
                }
            }
            EvaluationError::DomainError {
                function,
                message,
                position,
            } => {
                if let Some((line, col)) = position {
                    write!(
                        f,
                        "Domain error at line {}, column {}: {} function - {}",
                        line, col, function, message
                    )
                } else {
                    write!(f, "Domain error: {} function - {}", function, message)
                }
            }
            EvaluationError::NumericErrorNonFinite { function, position } => {
                if let Some((line, col)) = position {
                    write!(f, "Non-finite result at line {}, column {}: {} function produced NaN or Infinity", line, col, function)
                } else {
                    write!(
                        f,
                        "Non-finite result: {} function produced NaN or Infinity",
                        function
                    )
                }
            }
            EvaluationError::NumericErrorOverflow { function, position } => {
                if let Some((line, col)) = position {
                    write!(f, "Numeric overflow at line {}, column {}: {} function calculation overflowed", line, col, function)
                } else {
                    write!(
                        f,
                        "Numeric overflow: {} function calculation overflowed",
                        function
                    )
                }
            }
        }
    }
}

impl std::error::Error for EvaluationError {}

/// The core evaluator that processes AST nodes and produces typed results
pub struct Evaluator {
    /// Current evaluation context (variables, scope, etc.)
    context: EvaluationContext,
    /// Function registry for dynamic function dispatch
    registry: FunctionRegistry,
    /// Maximum recursion depth to prevent stack overflow
    max_depth: usize,
    /// Current recursion depth
    current_depth: usize,
    /// Current relationship traversal depth (for preventing infinite entity loops)
    traversal_depth: usize,
    /// Stack of entity IDs being traversed (for cycle detection)
    traversal_stack: Vec<String>,
    /// Flag to track if special references have been injected
    specials_injected: bool,
}

impl Evaluator {
    /// Create a new evaluator with the given context
    pub fn new(context: EvaluationContext) -> Self {
        Self {
            context,
            registry: FunctionRegistry::new(),
            max_depth: 100, // Configurable recursion limit
            current_depth: 0,
            traversal_depth: 0,
            traversal_stack: Vec::new(),
            specials_injected: false,
        }
    }

    fn ensure_specials(&mut self) {
        if !self.specials_injected {
            self.context.inject_specials_if_missing();
            self.specials_injected = true;
        }
    }

    /// Main entry point: evaluate an AST node to a typed Value
    pub fn evaluate_ast(&mut self, ast: &AstNode) -> EvaluationResult<Value> {
        // Reset per-evaluation traversal counter so hops accumulate only within this evaluation.
        self.traversal_depth = 0;
        self.traversal_stack.clear();

        // Ensure special refs (currently only `$scope`) are available.
        self.ensure_specials();

        // --- DEFINITIVE VALIDATION STEP ---
        // Perform pre-flight checks on the context before evaluation.
        if let Err(validation_errors) = self.context.validate_context() {
            // If validation fails, return a dedicated error containing ALL the issues.
            return Err(EvaluationError::ContextValidation(validation_errors));
        }
        // --- END OF VALIDATION STEP ---

        // Check recursion depth
        if self.current_depth >= self.max_depth {
            return Err(EvaluationError::Runtime {
                message: format!("Maximum recursion depth {} exceeded", self.max_depth),
                position: None,
            });
        }

        self.current_depth += 1;
        let result = match ast {
            AstNode::Expression(expr) => self.evaluate_expression(expr),
        };
        self.current_depth -= 1;

        result
    }

    /// Evaluate an AST node and return both the result Value and the ReadSet
    /// captured during evaluation.
    ///
    /// This is the reactive-aware entry point: callers that need to persist
    /// dependency information (e.g., FormulaRegistry) use this method to
    /// obtain the ReadSet alongside the computed value in a single call.
    ///
    /// The ReadSet is snapshotted from the EvaluationContext after evaluation
    /// completes (or after an error — partial ReadSets from failed evaluations
    /// are still valid dependency information).
    pub fn evaluate_ast_with_readset(
        &mut self,
        ast: &AstNode,
    ) -> (EvaluationResult<Value>, crate::context::ReadSet) {
        // Clear the ReadSet before evaluation so we capture only this evaluation's dependencies.
        self.context.clear_readset();

        let result = self.evaluate_ast(ast);

        // Snapshot the ReadSet regardless of success or failure.
        // A failed evaluation may still have accessed dependencies before the error.
        let readset = self.context.get_readset_snapshot();

        (result, readset)
    }

    /// Evaluate an Expression node
    fn evaluate_expression(&mut self, expr: &Expression) -> EvaluationResult<Value> {
        self.ensure_specials();
        match expr {
            Expression::Literal(literal) => self.evaluate_literal(literal),
            Expression::Identifier(name) => self.evaluate_identifier(name),
            Expression::VersionedIdentifier { name, version: _ } => {
                // For now, treat versioned identifiers like regular identifiers
                // TODO: Implement version resolution
                self.evaluate_identifier(name)
            }
            Expression::Binary(binary_expr) => self.evaluate_binary_operation(
                &binary_expr.left,
                &binary_expr.op,
                &binary_expr.right,
            ),
            Expression::Unary(unary_expr) => {
                self.evaluate_unary_operation(&unary_expr.op, &unary_expr.expr)
            }
            Expression::FunctionCall(func_call) => self.evaluate_function_call(func_call),
            Expression::MemberAccess(member_access) => self.evaluate_member_access(member_access),
            Expression::IndexAccess(index_access) => self.evaluate_index_access(index_access),
            Expression::Lambda(_lambda_expr) => {
                // TODO: Implement lambda evaluation
                Err(EvaluationError::Runtime {
                    message: "Lambda expressions not yet implemented".to_string(),
                    position: None,
                })
            }
        }
    }

    /// Evaluate a literal value
    fn evaluate_literal(&mut self, literal: &Literal) -> EvaluationResult<Value> {
        let value = match literal {
            Literal::Number(n) => Value::number(*n),
            Literal::String(s) => Value::string(s.clone()),
            Literal::Boolean(b) => Value::bool(*b),
            Literal::Null => Value::null(),
            Literal::Array(elements) => {
                // Evaluate each element
                let mut evaluated_elements = Vec::new();
                for element in elements {
                    let evaluated = self.evaluate_expression(element)?;
                    evaluated_elements.push(evaluated.into_inner());
                }
                Value::array(evaluated_elements)
            }
            Literal::Object(pairs) => {
                // Evaluate each value in the object
                let mut evaluated_object = serde_json::Map::new();
                for (key, value_expr) in pairs {
                    let evaluated_value = self.evaluate_expression(value_expr)?;
                    evaluated_object.insert(key.clone(), evaluated_value.into_inner());
                }
                Value::object(evaluated_object)
            }
        };
        Ok(value)
    }

    /// If the given Value is an entity reference shape, this function resolves it
    /// using the data resolver, while respecting traversal depth limits.
    /// Otherwise, it returns the value as-is.
    fn resolve_value_if_entity_ref(&mut self, value: Value) -> EvaluationResult<Value> {
        if let Some(entity_id) = value.get_entity_ref_id() {
            // 1) Permission check: do NOT remove or comment this out.
            if !self.context.has_permission("entity:read") {
                return Err(EvaluationError::Security {
                    message: format!("Permission denied: cannot read entity '{}'", entity_id),
                    position: None,
                });
            }

            // 2) Depth limit (cumulative hop count across this evaluation).
            let max_depth = self.context.get_max_traversal_depth();
            if self.traversal_depth >= max_depth {
                return Err(EvaluationError::Security {
                    message: format!(
                        "Maximum traversal depth ({}) exceeded while resolving '{}'",
                        max_depth, entity_id
                    ),
                    position: None,
                });
            }

            // 3) Cycle guard with a traversal stack.
            if self.traversal_stack.iter().any(|e| e == entity_id) {
                return Err(EvaluationError::Security {
                    message: format!(
                        "Cycle detected while traversing entities: {:?} -> {}",
                        self.traversal_stack, entity_id
                    ),
                    position: None,
                });
            }

            // 4) Enter traversal. We use cumulative hop count (do not decrement).
            self.traversal_depth += 1;
            self.traversal_stack.push(entity_id.to_string());

            // 5) Resolve, ensuring we ALWAYS pop the stack (even on error).
            let result = (|| -> EvaluationResult<Value> {
                let resolved = self.context.resolve_entity_data(entity_id).ok_or_else(|| {
                    EvaluationError::Context {
                        message: "Entity reference not found".to_string(),
                        identifier: entity_id.to_string(),
                        position: None,
                    }
                })?;

                // If the resolved value is itself an entity ref, resolve again.
                self.resolve_value_if_entity_ref(resolved)
            })();

            // Always pop before returning, regardless of success or error.
            self.traversal_stack.pop();
            result
        } else {
            Ok(value)
        }
    }

    /// Evaluate an identifier by looking it up in the context.
    /// This includes special handling for the @, @@, and $scope references.
    fn evaluate_identifier(&mut self, name: &str) -> EvaluationResult<Value> {
        let initial_value = match name {
            // --- Special Reference Resolution ---
            "@" => {
                self.context.track_special_reference("@".to_string());
                // '@' resolves to the "current_entity" variable from the context.
                self.context
                    .get_variable("current_entity")
                    .cloned()
                    .ok_or_else(|| EvaluationError::Context {
                        message: "No current entity (@) in context".to_string(),
                        identifier: name.to_string(),
                        position: None,
                    })
            }
            "@@" => {
                self.context.track_special_reference("@@".to_string());
                // '@@' resolves to the "current_user" variable from the context.
                self.context
                    .get_variable("current_user")
                    .cloned()
                    .ok_or_else(|| EvaluationError::Context {
                        message: "No current user (@@) in context".to_string(),
                        identifier: name.to_string(),
                        position: None,
                    })
            }
            "$scope" => {
                self.context.track_special_reference("$scope".to_string());
                // $scope is now injected as a variable, so look it up there
                self.context.get_variable("$scope").cloned().ok_or_else(|| {
                    EvaluationError::Context {
                        message: "No scope ($scope) in context".to_string(),
                        identifier: name.to_string(),
                        position: None,
                    }
                })
            }

            // --- Regular Variable Lookup ---
            _ => self
                .context
                .lookup_variable(name)
                .ok_or_else(|| EvaluationError::Context {
                    message: "Undefined variable".to_string(),
                    identifier: name.to_string(),
                    position: None,
                }),
        }?;

        // CRITICAL FIX: After getting the initial value, immediately resolve it if it's an entity reference.
        self.resolve_value_if_entity_ref(initial_value)
    }

    /// Evaluate a binary operation with proper type checking and null propagation
    ///
    /// This is the CRITICAL function that implements:
    /// 1. SQL-style null propagation (5 + null → null)
    /// 2. Strict typing with E_TYPE_MISMATCH errors
    /// 3. Special + operator string concatenation logic
    fn evaluate_binary_operation(
        &mut self,
        left: &Expression,
        op: &BinaryOp,
        right: &Expression,
    ) -> EvaluationResult<Value> {
        // Evaluate operands
        let left_val = self.evaluate_expression(left)?;
        let right_val = self.evaluate_expression(right)?;

        // Convert BinaryOp to string for error reporting and logic
        let op_str = match op {
            BinaryOp::Add => "+",
            BinaryOp::Subtract => "-",
            BinaryOp::Multiply => "*",
            BinaryOp::Divide => "/",
            BinaryOp::Modulo => "%",
            BinaryOp::Eq => "==",
            BinaryOp::NotEq => "!=",
            BinaryOp::Lt => "<",
            BinaryOp::Lte => "<=",
            BinaryOp::Gt => ">",
            BinaryOp::Gte => ">=",
            BinaryOp::And => "&&",
            BinaryOp::Or => "||",
        };

        // STEP 1: SQL-STYLE NULL PROPAGATION (CRITICAL)
        // Must handle null propagation BEFORE any other logic
        if let Some(null_result) = self.handle_null_propagation(&left_val, &right_val, op_str)? {
            return Ok(null_result);
        }

        // STEP 2: STRICT TYPING AND OPERATIONS
        // Now we know neither operand is null, so we can safely do type checking
        match op {
            BinaryOp::Add => {
                // SPECIAL CASE: + operator allows string concatenation
                if type_coercion::are_addition_compatible(&left_val, &right_val) {
                    self.evaluate_addition(&left_val, &right_val)
                } else {
                    Err(self.type_mismatch_error("addition", "compatible types", &left_val))
                }
            }
            BinaryOp::Subtract | BinaryOp::Multiply | BinaryOp::Divide | BinaryOp::Modulo => {
                // STRICT TYPING: Only numbers allowed for arithmetic
                if type_coercion::are_arithmetic_compatible(&left_val, &right_val) {
                    self.evaluate_arithmetic(&left_val, &right_val, op_str)
                } else {
                    Err(self.type_mismatch_error(op_str, "number", &left_val))
                }
            }
            BinaryOp::Eq | BinaryOp::NotEq => {
                // EQUALITY: Same types can be compared
                if type_coercion::are_comparison_compatible(&left_val, &right_val) {
                    self.evaluate_equality(&left_val, &right_val, op == &BinaryOp::Eq)
                } else {
                    Err(self.type_mismatch_error("equality comparison", "same type", &left_val))
                }
            }
            BinaryOp::Lt | BinaryOp::Lte | BinaryOp::Gt | BinaryOp::Gte => {
                // ORDERING: Only numbers and strings support ordering
                if type_coercion::are_comparison_compatible(&left_val, &right_val) {
                    self.evaluate_comparison(&left_val, &right_val, op_str)
                } else {
                    Err(self.type_mismatch_error(
                        "ordering comparison",
                        "number or string",
                        &left_val,
                    ))
                }
            }
            BinaryOp::And | BinaryOp::Or => {
                // LOGICAL: Use truthiness rules with three-valued logic
                self.evaluate_logical(&left_val, &right_val, op_str)
            }
        }
    }

    /// Evaluate a unary operation with null propagation
    fn evaluate_unary_operation(
        &mut self,
        op: &UnaryOp,
        operand: &Expression,
    ) -> EvaluationResult<Value> {
        let operand_val = self.evaluate_expression(operand)?;

        let op_str = match op {
            UnaryOp::Negate => "-",
            UnaryOp::Not => "!",
        };

        // Handle null propagation for unary operations
        if operand_val.is_null() {
            return Ok(Value::null());
        }

        match op {
            UnaryOp::Negate => {
                if operand_val.is_number() {
                    if let Some(n) = operand_val.inner().as_f64() {
                        Ok(Value::number(-n))
                    } else {
                        Err(self.type_mismatch_error(op_str, "number", &operand_val))
                    }
                } else {
                    Err(self.type_mismatch_error(op_str, "number", &operand_val))
                }
            }
            UnaryOp::Not => {
                // Logical NOT uses truthiness rules - works on any type
                let is_truthy = operand_val.is_truthy();
                Ok(Value::bool(!is_truthy))
            }
        }
    }

    /// Handle SQL-style null propagation for binary operations
    fn handle_null_propagation(
        &self,
        left: &Value,
        right: &Value,
        op: &str,
    ) -> EvaluationResult<Option<Value>> {
        match (left.is_null(), right.is_null()) {
            (true, true) => {
                // Both null
                match op {
                    "==" => Ok(Some(Value::bool(true))),
                    "!=" => Ok(Some(Value::bool(false))),
                    "<" | "<=" | ">" | ">=" => Ok(Some(Value::null())),
                    "&&" => Ok(Some(Value::null())),
                    "||" => Ok(Some(Value::null())),
                    "+" => {
                        // Special case: null + null with string coercion
                        if type_coercion::are_addition_compatible(left, right) {
                            Ok(Some(Value::string("nullnull")))
                        } else {
                            Ok(Some(Value::null()))
                        }
                    }
                    _ => Ok(Some(Value::null())), // Arithmetic operations
                }
            }
            (true, false) | (false, true) => {
                // One operand is null
                match op {
                    "==" => Ok(Some(Value::bool(false))),
                    "!=" => Ok(Some(Value::bool(true))),
                    "<" | "<=" | ">" | ">=" => Ok(Some(Value::null())),
                    "&&" => {
                        // null && false = false, null && true = null
                        if (!left.is_null() && !left.is_truthy())
                            || (!right.is_null() && !right.is_truthy())
                        {
                            Ok(Some(Value::bool(false)))
                        } else {
                            Ok(Some(Value::null()))
                        }
                    }
                    "||" => {
                        // null || true = true, null || false = null
                        if (!left.is_null() && left.is_truthy())
                            || (!right.is_null() && right.is_truthy())
                        {
                            Ok(Some(Value::bool(true)))
                        } else {
                            Ok(Some(Value::null()))
                        }
                    }
                    "+" => {
                        // Special case: string concatenation with null
                        if type_coercion::are_addition_compatible(left, right) {
                            let (coerced_left, coerced_right) =
                                type_coercion::coerce_for_addition(left, right)
                                    .map_err(|e| self.type_error_to_evaluation_error(e))?;
                            if let (Some(l), Some(r)) = (
                                coerced_left.inner().as_str(),
                                coerced_right.inner().as_str(),
                            ) {
                                Ok(Some(Value::string(format!("{}{}", l, r))))
                            } else {
                                Ok(Some(Value::null()))
                            }
                        } else {
                            Ok(Some(Value::null()))
                        }
                    }
                    _ => Ok(Some(Value::null())), // Arithmetic operations
                }
            }
            (false, false) => {
                // Neither is null - no propagation needed
                Ok(None)
            }
        }
    }

    // Helper methods for specific operations

    fn evaluate_addition(&mut self, left: &Value, right: &Value) -> EvaluationResult<Value> {
        if type_coercion::are_addition_compatible(left, right) {
            // Handle string concatenation case
            if left.is_string() || right.is_string() {
                let (coerced_left, coerced_right) = type_coercion::coerce_for_addition(left, right)
                    .map_err(|e| self.type_error_to_evaluation_error(e))?;
                if let (Some(l), Some(r)) = (
                    coerced_left.inner().as_str(),
                    coerced_right.inner().as_str(),
                ) {
                    Ok(Value::string(format!("{}{}", l, r)))
                } else {
                    Err(self.type_mismatch_error("addition", "string", left))
                }
            } else {
                // Handle numeric addition
                if let (Some(l), Some(r)) = (left.inner().as_f64(), right.inner().as_f64()) {
                    Ok(Value::number(l + r))
                } else {
                    Err(self.type_mismatch_error("addition", "number", left))
                }
            }
        } else {
            Err(self.type_mismatch_error("addition", "compatible types", left))
        }
    }

    fn evaluate_arithmetic(
        &mut self,
        left: &Value,
        right: &Value,
        op: &str,
    ) -> EvaluationResult<Value> {
        if type_coercion::are_arithmetic_compatible(left, right) {
            if let (Some(l), Some(r)) = (left.inner().as_f64(), right.inner().as_f64()) {
                let result = match op {
                    "-" => l - r,
                    "*" => l * r,
                    "/" => {
                        if r == 0.0 {
                            return Err(EvaluationError::Runtime {
                                message: "Division by zero".to_string(),
                                position: None,
                            });
                        }
                        l / r
                    }
                    "%" => {
                        if r == 0.0 {
                            return Err(EvaluationError::Runtime {
                                message: "Modulo by zero".to_string(),
                                position: None,
                            });
                        }
                        l % r
                    }
                    _ => unreachable!("Invalid arithmetic operator: {}", op),
                };
                Ok(Value::number(result))
            } else {
                Err(self.type_mismatch_error(op, "number", left))
            }
        } else {
            Err(self.type_mismatch_error(op, "number", left))
        }
    }

    fn evaluate_equality(
        &mut self,
        left: &Value,
        right: &Value,
        is_eq: bool,
    ) -> EvaluationResult<Value> {
        if type_coercion::are_comparison_compatible(left, right) {
            let is_equal = Value::are_equal(left, right);
            Ok(Value::bool(if is_eq { is_equal } else { !is_equal }))
        } else {
            Err(self.type_mismatch_error("equality comparison", "compatible types", left))
        }
    }

    fn evaluate_comparison(
        &mut self,
        left: &Value,
        right: &Value,
        op: &str,
    ) -> EvaluationResult<Value> {
        if type_coercion::are_comparison_compatible(left, right) {
            // Only numbers and strings support ordering comparisons
            let result = match (left.inner(), right.inner()) {
                (serde_json::Value::Number(l), serde_json::Value::Number(r)) => {
                    let (l_val, r_val) = (l.as_f64().unwrap(), r.as_f64().unwrap());
                    match op {
                        "<" => l_val < r_val,
                        "<=" => l_val <= r_val,
                        ">" => l_val > r_val,
                        ">=" => l_val >= r_val,
                        _ => unreachable!("Invalid comparison operator: {}", op),
                    }
                }
                (serde_json::Value::String(l), serde_json::Value::String(r)) => match op {
                    "<" => l < r,
                    "<=" => l <= r,
                    ">" => l > r,
                    ">=" => l >= r,
                    _ => unreachable!("Invalid comparison operator: {}", op),
                },
                _ => {
                    return Err(self.type_mismatch_error(
                        "ordering comparison",
                        "number or string",
                        left,
                    ));
                }
            };
            Ok(Value::bool(result))
        } else {
            Err(self.type_mismatch_error("comparison", "compatible types", left))
        }
    }

    fn evaluate_logical(
        &mut self,
        left: &Value,
        right: &Value,
        op: &str,
    ) -> EvaluationResult<Value> {
        let left_truthy = left.is_truthy();
        let right_truthy = right.is_truthy();

        let result = match op {
            "&&" => left_truthy && right_truthy,
            "||" => left_truthy || right_truthy,
            _ => unreachable!("Invalid logical operator: {}", op),
        };

        Ok(Value::bool(result))
    }

    /// Evaluate a function call using the generic Function Registry
    fn evaluate_function_call(&mut self, func_call: &FunctionCallExpr) -> EvaluationResult<Value> {
        // Track the function call in the ReadSet
        let func_name_for_tracking = if let Some(version) = func_call.version {
            format!("{}@v{}", func_call.function_name, version)
        } else {
            func_call.function_name.clone()
        };
        self.context.track_function_call(func_name_for_tracking);

        // --- DYNAMIC FUNCTION DISPATCH ---
        let call_style = match self.registry.lookup(&func_call.function_name) {
            Some(f) => f.call_style(),
            None => {
                return Err(EvaluationError::Runtime {
                    message: format!("Unknown function: {}", func_call.function_name),
                    position: None, // TODO: wire a span if/when FunctionCallExpr carries one
                });
            }
        };

        if call_style == CallStyle::Lazy {
            // Build true lazy thunks that evaluate args only if needed.
            // Safety: consumed synchronously in this call; never stored.
            let this: *mut Self = self;
            let lazy_args: Vec<LazyValue> = func_call
                .args
                .iter()
                .map(|expr| {
                    let expr = expr.clone();
                    LazyValue::new(move |_ctx| unsafe {
                        // Re-enter the same evaluator to compute the arg on demand.
                        (&mut *this).evaluate_expression(&expr)
                    })
                })
                .collect();

            let function = self.registry.lookup(&func_call.function_name).unwrap();
            function.execute_lazy(&lazy_args, &mut self.context)
        } else {
            // Eager path
            let mut evaluated_args = Vec::with_capacity(func_call.args.len());
            for arg in &func_call.args {
                evaluated_args.push(self.evaluate_expression(arg)?);
            }
            let function = self.registry.lookup(&func_call.function_name).unwrap();
            function.execute(&evaluated_args, &mut self.context)
        }
    }

    /// Evaluate member access (e.g., `object.property`) with support for relationship traversal.
    fn evaluate_member_access(
        &mut self,
        member_access: &MemberAccessExpr,
    ) -> EvaluationResult<Value> {
        // 1) Evaluate and resolve the base if it's an entity ref
        let base_value = self.evaluate_expression(&member_access.object)?;
        let base_value = self.resolve_value_if_entity_ref(base_value)?;

        // Null propagation: null.anything -> null
        if base_value.is_null() {
            return Ok(Value::null());
        }

        // 2) Track dependency path (special chains like @.owner.name)
        if let Some(path) = try_special_chain_for_tracking(&Expression::MemberAccess(Box::new(
            member_access.clone(),
        ))) {
            // Per your current ReadSet semantics, full chains (even with '@' base) are tracked as entity_references
            self.context.track_entity_reference(path);
        } else if let Some((base, chain)) =
            flatten_member_chain(&Expression::MemberAccess(Box::new(member_access.clone())))
        {
            // Fallback: a plain flattenable chain (e.g., user.profile.name)
            let mut parts = vec![base];
            parts.extend(chain);
            self.context.track_entity_reference(parts.join("."));
        }

        // 3) Perform property lookup on the resolved base
        if let Some(obj) = base_value.inner().as_object() {
            let property_value = obj
                .get(&member_access.property)
                .cloned()
                .map(Value::from)
                .unwrap_or_else(Value::null);

            // If the property itself is another entity ref, resolve it (relationship hop).
            self.resolve_value_if_entity_ref(property_value)
        } else {
            Err(EvaluationError::TypeMismatch {
                operation: "member access".to_string(),
                expected: "object".to_string(),
                found: base_value.type_name().to_string(),
                position: None,
            })
        }
    }

    /// Evaluate index access (array[index])
    fn evaluate_index_access(&mut self, index_access: &IndexAccessExpr) -> EvaluationResult<Value> {
        // 1) Evaluate array/base and index
        let array_value_raw = self.evaluate_expression(&index_access.array)?;
        let index_value = self.evaluate_expression(&index_access.index)?;

        // Null propagation
        if array_value_raw.is_null() || index_value.is_null() {
            return Ok(Value::null());
        }

        // 2) Resolve base if it's an entity ref (so entity.items[...] works)
        let array_value = self.resolve_value_if_entity_ref(array_value_raw)?;

        // 3) Track dependency path for special chains (e.g., @.items[0] / @.items.<dynamic>)
        if let Some(mut path) = try_special_chain_for_tracking(&index_access.array) {
            match describe_index_for_tracking(&index_value) {
                IndexDescriptor::Key(k) => path.push_str(&format!(".{}", k)),
                IndexDescriptor::Index(i) => path.push_str(&format!(".<index:{}>", i)),
                IndexDescriptor::Dynamic => path.push_str(".<dynamic>"),
            }
            self.context.track_entity_reference(path);
        }

        // 4) Indexing logic
        // If the base is an array
        if let Some(arr) = array_value.inner().as_array() {
            // Index must be an integer
            let n = match index_value.inner().as_f64() {
                Some(v) if v.fract() == 0.0 => v as i64,
                Some(_) => {
                    return Err(EvaluationError::TypeMismatch {
                        operation: "array indexing".to_string(),
                        expected: "integer".to_string(),
                        found: "float".to_string(),
                        position: None,
                    });
                }
                None => {
                    return Err(EvaluationError::TypeMismatch {
                        operation: "array indexing".to_string(),
                        expected: "number".to_string(),
                        found: index_value.type_name().to_string(),
                        position: None,
                    });
                }
            };

            if n < 0 {
                return Err(EvaluationError::Runtime {
                    message: format!("Array index {} is negative", n),
                    position: None,
                });
            }
            let idx = n as usize;
            let v = arr
                .get(idx)
                .cloned()
                .map(Value::from)
                .unwrap_or_else(Value::null);
            // If element is an entity ref, resolve to enable chained access
            return self.resolve_value_if_entity_ref(v);
        }

        // If the base is an object and index is a string -> property lookup
        if let (Some(obj), Some(key)) = (
            array_value.inner().as_object(),
            index_value.inner().as_str(),
        ) {
            let v = obj
                .get(key)
                .cloned()
                .map(Value::from)
                .unwrap_or_else(Value::null);
            return self.resolve_value_if_entity_ref(v);
        }

        // Otherwise: invalid base for indexing
        Err(EvaluationError::TypeMismatch {
            operation: "indexing".to_string(),
            expected: "array or object".to_string(),
            found: array_value.type_name().to_string(),
            position: None,
        })
    }

    // Error handling helpers

    fn type_mismatch_error(
        &self,
        operation: &str,
        expected: &str,
        found: &Value,
    ) -> EvaluationError {
        EvaluationError::TypeMismatch {
            operation: operation.to_string(),
            expected: expected.to_string(),
            found: found.type_name().to_string(),
            position: None,
        }
    }

    fn type_error_to_evaluation_error(&self, error: TypeError) -> EvaluationError {
        match error {
            TypeError::TypeMismatch {
                expected,
                found,
                value: _,
            } => EvaluationError::TypeMismatch {
                operation: "type coercion".to_string(),
                expected,
                found,
                position: None,
            },
            _ => EvaluationError::Runtime {
                message: format!("Type error: {}", error),
                position: None,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{BinaryExpr, FunctionCallExpr, IndexAccessExpr, MemberAccessExpr, UnaryExpr};

    fn create_test_context() -> EvaluationContext {
        EvaluationContext::new()
    }

    #[test]
    fn test_literal_evaluation() {
        let mut evaluator = Evaluator::new(create_test_context());

        // Number literal
        let number_expr = Expression::Literal(Literal::Number(42.0));
        let result = evaluator.evaluate_expression(&number_expr).unwrap();
        assert_eq!(result, Value::number(42.0));

        // String literal
        let string_expr = Expression::Literal(Literal::String("hello".to_string()));
        let result = evaluator.evaluate_expression(&string_expr).unwrap();
        assert_eq!(result, Value::string("hello"));

        // Boolean literal
        let bool_expr = Expression::Literal(Literal::Boolean(true));
        let result = evaluator.evaluate_expression(&bool_expr).unwrap();
        assert_eq!(result, Value::bool(true));

        // Null literal
        let null_expr = Expression::Literal(Literal::Null);
        let result = evaluator.evaluate_expression(&null_expr).unwrap();
        assert_eq!(result, Value::null());
    }

    #[test]
    fn test_arithmetic_operations() {
        let mut evaluator = Evaluator::new(create_test_context());

        // Addition
        let add_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::Number(5.0)),
            op: BinaryOp::Add,
            right: Expression::Literal(Literal::Number(3.0)),
        }));
        let result = evaluator.evaluate_expression(&add_expr).unwrap();
        assert_eq!(result, Value::number(8.0));

        // Subtraction
        let sub_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::Number(10.0)),
            op: BinaryOp::Subtract,
            right: Expression::Literal(Literal::Number(4.0)),
        }));
        let result = evaluator.evaluate_expression(&sub_expr).unwrap();
        assert_eq!(result, Value::number(6.0));

        // Multiplication
        let mul_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::Number(6.0)),
            op: BinaryOp::Multiply,
            right: Expression::Literal(Literal::Number(7.0)),
        }));
        let result = evaluator.evaluate_expression(&mul_expr).unwrap();
        assert_eq!(result, Value::number(42.0));

        // Division
        let div_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::Number(15.0)),
            op: BinaryOp::Divide,
            right: Expression::Literal(Literal::Number(3.0)),
        }));
        let result = evaluator.evaluate_expression(&div_expr).unwrap();
        assert_eq!(result, Value::number(5.0));
    }

    #[test]
    fn test_string_concatenation() {
        let mut evaluator = Evaluator::new(create_test_context());

        // String + String
        let concat_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::String("Hello".to_string())),
            op: BinaryOp::Add,
            right: Expression::Literal(Literal::String(" World".to_string())),
        }));
        let result = evaluator.evaluate_expression(&concat_expr).unwrap();
        assert_eq!(result, Value::string("Hello World"));

        // String + Number (coercion)
        let concat_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::String("Answer: ".to_string())),
            op: BinaryOp::Add,
            right: Expression::Literal(Literal::Number(42.0)),
        }));
        let result = evaluator.evaluate_expression(&concat_expr).unwrap();
        assert_eq!(result, Value::string("Answer: 42"));
    }

    #[test]
    fn test_null_propagation() {
        let mut evaluator = Evaluator::new(create_test_context());

        // null + number → null
        let null_add_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::Null),
            op: BinaryOp::Add,
            right: Expression::Literal(Literal::Number(5.0)),
        }));
        let result = evaluator.evaluate_expression(&null_add_expr).unwrap();
        assert_eq!(result, Value::null());

        // null == null → true
        let null_eq_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::Null),
            op: BinaryOp::Eq,
            right: Expression::Literal(Literal::Null),
        }));
        let result = evaluator.evaluate_expression(&null_eq_expr).unwrap();
        assert_eq!(result, Value::bool(true));

        // null != null → false
        let null_neq_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::Null),
            op: BinaryOp::NotEq,
            right: Expression::Literal(Literal::Null),
        }));
        let result = evaluator.evaluate_expression(&null_neq_expr).unwrap();
        assert_eq!(result, Value::bool(false));
    }

    #[test]
    fn test_unary_operations() {
        let mut evaluator = Evaluator::new(create_test_context());

        // Negation
        let neg_expr = Expression::Unary(Box::new(UnaryExpr {
            op: UnaryOp::Negate,
            expr: Expression::Literal(Literal::Number(5.0)),
        }));
        let result = evaluator.evaluate_expression(&neg_expr).unwrap();
        assert_eq!(result, Value::number(-5.0));

        // Logical NOT
        let not_expr = Expression::Unary(Box::new(UnaryExpr {
            op: UnaryOp::Not,
            expr: Expression::Literal(Literal::Boolean(true)),
        }));
        let result = evaluator.evaluate_expression(&not_expr).unwrap();
        assert_eq!(result, Value::bool(false));

        // NOT with null → null
        let not_null_expr = Expression::Unary(Box::new(UnaryExpr {
            op: UnaryOp::Not,
            expr: Expression::Literal(Literal::Null),
        }));
        let result = evaluator.evaluate_expression(&not_null_expr).unwrap();
        assert_eq!(result, Value::null());
    }

    #[test]
    fn test_type_mismatch_errors() {
        let mut evaluator = Evaluator::new(create_test_context());

        // String - Number (not compatible)
        let invalid_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::String("hello".to_string())),
            op: BinaryOp::Subtract,
            right: Expression::Literal(Literal::Number(5.0)),
        }));
        let result = evaluator.evaluate_expression(&invalid_expr);
        assert!(result.is_err());

        if let Err(EvaluationError::TypeMismatch { operation, .. }) = result {
            assert_eq!(operation, "-");
        } else {
            panic!("Expected TypeMismatch error");
        }
    }

    #[test]
    fn test_ordering_comparisons() {
        let mut evaluator = Evaluator::new(create_test_context());

        // Number comparisons
        let num_lt_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::Number(5.0)),
            op: BinaryOp::Lt,
            right: Expression::Literal(Literal::Number(10.0)),
        }));
        let result = evaluator.evaluate_expression(&num_lt_expr).unwrap();
        assert_eq!(result, Value::bool(true));

        let num_lte_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::Number(10.0)),
            op: BinaryOp::Lte,
            right: Expression::Literal(Literal::Number(10.0)),
        }));
        let result = evaluator.evaluate_expression(&num_lte_expr).unwrap();
        assert_eq!(result, Value::bool(true));

        let num_gt_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::Number(15.0)),
            op: BinaryOp::Gt,
            right: Expression::Literal(Literal::Number(10.0)),
        }));
        let result = evaluator.evaluate_expression(&num_gt_expr).unwrap();
        assert_eq!(result, Value::bool(true));

        let num_gte_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::Number(10.0)),
            op: BinaryOp::Gte,
            right: Expression::Literal(Literal::Number(10.0)),
        }));
        let result = evaluator.evaluate_expression(&num_gte_expr).unwrap();
        assert_eq!(result, Value::bool(true));

        // String comparisons (lexicographic)
        let str_lt_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::String("apple".to_string())),
            op: BinaryOp::Lt,
            right: Expression::Literal(Literal::String("banana".to_string())),
        }));
        let result = evaluator.evaluate_expression(&str_lt_expr).unwrap();
        assert_eq!(result, Value::bool(true));

        let str_gt_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::String("zebra".to_string())),
            op: BinaryOp::Gt,
            right: Expression::Literal(Literal::String("apple".to_string())),
        }));
        let result = evaluator.evaluate_expression(&str_gt_expr).unwrap();
        assert_eq!(result, Value::bool(true));
    }

    #[test]
    fn test_ordering_comparison_type_errors() {
        let mut evaluator = Evaluator::new(create_test_context());

        // Number vs String comparison (should fail with strict typing)
        let mixed_type_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::Number(5.0)),
            op: BinaryOp::Lt,
            right: Expression::Literal(Literal::String("10".to_string())),
        }));
        let result = evaluator.evaluate_expression(&mixed_type_expr);
        assert!(result.is_err());

        // Boolean ordering comparison (should fail)
        let bool_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::Boolean(true)),
            op: BinaryOp::Lt,
            right: Expression::Literal(Literal::Boolean(false)),
        }));
        let result = evaluator.evaluate_expression(&bool_expr);
        assert!(result.is_err());
    }

    #[test]
    fn test_ordering_with_null_propagation() {
        let mut evaluator = Evaluator::new(create_test_context());

        // null < number → null
        let null_lt_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::Null),
            op: BinaryOp::Lt,
            right: Expression::Literal(Literal::Number(5.0)),
        }));
        let result = evaluator.evaluate_expression(&null_lt_expr).unwrap();
        assert_eq!(result, Value::null());

        // number >= null → null
        let num_gte_null_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::Number(10.0)),
            op: BinaryOp::Gte,
            right: Expression::Literal(Literal::Null),
        }));
        let result = evaluator.evaluate_expression(&num_gte_null_expr).unwrap();
        assert_eq!(result, Value::null());

        // null <= null → null (orderings with null always return null, even null vs null)
        let null_lte_null_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::Null),
            op: BinaryOp::Lte,
            right: Expression::Literal(Literal::Null),
        }));
        let result = evaluator.evaluate_expression(&null_lte_null_expr).unwrap();
        assert_eq!(result, Value::null());
    }

    #[test]
    fn test_division_by_zero() {
        let mut evaluator = Evaluator::new(create_test_context());

        let div_zero_expr = Expression::Binary(Box::new(BinaryExpr {
            left: Expression::Literal(Literal::Number(10.0)),
            op: BinaryOp::Divide,
            right: Expression::Literal(Literal::Number(0.0)),
        }));
        let result = evaluator.evaluate_expression(&div_zero_expr);
        assert!(result.is_err());

        if let Err(EvaluationError::Runtime { message, .. }) = result {
            assert!(message.contains("Division by zero"));
        } else {
            panic!("Expected Runtime error for division by zero");
        }
    }

    #[test]
    fn test_function_call_evaluation() {
        let mut evaluator = Evaluator::new(create_test_context());

        // VALUE() function
        let value_call = Expression::FunctionCall(Box::new(FunctionCallExpr {
            function_name: "VALUE".to_string(),
            version: None,
            args: vec![Expression::Literal(Literal::String("42".to_string()))],
        }));
        let result = evaluator.evaluate_expression(&value_call).unwrap();
        assert_eq!(result, Value::number(42.0));

        // TEXT() function
        let text_call = Expression::FunctionCall(Box::new(FunctionCallExpr {
            function_name: "TEXT".to_string(),
            version: None,
            args: vec![Expression::Literal(Literal::Number(42.0))],
        }));
        let result = evaluator.evaluate_expression(&text_call).unwrap();
        assert_eq!(result, Value::string("42"));

        // Unknown function should error
        let unknown_call = Expression::FunctionCall(Box::new(FunctionCallExpr {
            function_name: "UNKNOWN".to_string(),
            version: None,
            args: vec![],
        }));
        let result = evaluator.evaluate_expression(&unknown_call);
        assert!(result.is_err());
    }

    #[test]
    fn test_member_access_evaluation() {
        let mut evaluator = Evaluator::new(create_test_context());

        // Create object literal: #{name: "John", age: 30}
        let object_literal = Expression::Literal(Literal::Object(vec![
            (
                "name".to_string(),
                Expression::Literal(Literal::String("John".to_string())),
            ),
            (
                "age".to_string(),
                Expression::Literal(Literal::Number(30.0)),
            ),
        ]));

        // Access existing property: object.name
        let member_access = Expression::MemberAccess(Box::new(MemberAccessExpr {
            object: object_literal.clone(),
            property: "name".to_string(),
        }));
        let result = evaluator.evaluate_expression(&member_access).unwrap();
        assert_eq!(result, Value::string("John"));

        // Access non-existing property: object.missing -> null
        let missing_access = Expression::MemberAccess(Box::new(MemberAccessExpr {
            object: object_literal,
            property: "missing".to_string(),
        }));
        let result = evaluator.evaluate_expression(&missing_access).unwrap();
        assert_eq!(result, Value::null());

        // Member access on null: null.name -> null
        let null_access = Expression::MemberAccess(Box::new(MemberAccessExpr {
            object: Expression::Literal(Literal::Null),
            property: "name".to_string(),
        }));
        let result = evaluator.evaluate_expression(&null_access).unwrap();
        assert_eq!(result, Value::null());
    }

    #[test]
    fn test_index_access_evaluation() {
        let mut evaluator = Evaluator::new(create_test_context());

        // Create array literal: [1, 2, 3]
        let array_literal = Expression::Literal(Literal::Array(vec![
            Expression::Literal(Literal::Number(1.0)),
            Expression::Literal(Literal::Number(2.0)),
            Expression::Literal(Literal::Number(3.0)),
        ]));

        // Access valid index: array[1] -> 2
        let index_access = Expression::IndexAccess(Box::new(IndexAccessExpr {
            array: array_literal.clone(),
            index: Expression::Literal(Literal::Number(1.0)),
        }));
        let result = evaluator.evaluate_expression(&index_access).unwrap();
        assert_eq!(result, Value::number(2.0));

        // Access out of bounds: array[10] -> null
        let out_of_bounds = Expression::IndexAccess(Box::new(IndexAccessExpr {
            array: array_literal,
            index: Expression::Literal(Literal::Number(10.0)),
        }));
        let result = evaluator.evaluate_expression(&out_of_bounds).unwrap();
        assert_eq!(result, Value::null());

        // Index access on null: null[0] -> null
        let null_access = Expression::IndexAccess(Box::new(IndexAccessExpr {
            array: Expression::Literal(Literal::Null),
            index: Expression::Literal(Literal::Number(0.0)),
        }));
        let result = evaluator.evaluate_expression(&null_access).unwrap();
        assert_eq!(result, Value::null());
    }

    #[test]
    fn test_complex_expression_evaluation() {
        let mut evaluator = Evaluator::new(create_test_context());

        // Complex expression: TEXT(VALUE("42") + 8)
        let inner_value_call = Expression::FunctionCall(Box::new(FunctionCallExpr {
            function_name: "VALUE".to_string(),
            version: None,
            args: vec![Expression::Literal(Literal::String("42".to_string()))],
        }));

        let addition = Expression::Binary(Box::new(BinaryExpr {
            left: inner_value_call,
            op: BinaryOp::Add,
            right: Expression::Literal(Literal::Number(8.0)),
        }));

        let text_call = Expression::FunctionCall(Box::new(FunctionCallExpr {
            function_name: "TEXT".to_string(),
            version: None,
            args: vec![addition],
        }));

        let result = evaluator.evaluate_expression(&text_call).unwrap();
        assert_eq!(result, Value::string("50"));
    }

    #[test]
    fn test_readset_tracking() {
        let mut evaluator = Evaluator::new(create_test_context());

        // Set up some variables
        evaluator.context.set_variable("x", Value::number(42.0));

        // Create expression: TEXT(x)
        let func_call = Expression::FunctionCall(Box::new(FunctionCallExpr {
            function_name: "TEXT".to_string(),
            version: None,
            args: vec![Expression::Identifier("x".to_string())],
        }));

        let _result = evaluator.evaluate_expression(&func_call).unwrap();

        // Check ReadSet tracking
        let readset = evaluator.context.get_readset();
        assert!(readset.get_variables().contains("x"));
        assert!(readset.get_function_calls().contains("TEXT"));
    }

    #[test]
    fn test_enhanced_readset_tracking() {
        let mut evaluator = Evaluator::new(create_test_context());

        // Set up test data
        let mut user_obj = serde_json::Map::new();
        user_obj.insert(
            "profile".to_string(),
            serde_json::json!({
                "name": "Alice",
                "settings": ["theme1", "theme2", "theme3"]
            }),
        );
        evaluator
            .context
            .set_variable("user", Value::object(user_obj));

        // Set up special references
        let mut current_entity = serde_json::Map::new();
        current_entity.insert(
            "items".to_string(),
            serde_json::json!(["item1", "item2", "item3"]),
        );
        current_entity.insert("owner".to_string(), serde_json::json!({"name": "Bob"}));
        evaluator
            .context
            .set_variable("current_entity", Value::object(current_entity));

        // Test 1: Regular member access chain - user.profile.name
        let member_chain = Expression::MemberAccess(Box::new(MemberAccessExpr {
            object: Expression::MemberAccess(Box::new(MemberAccessExpr {
                object: Expression::Identifier("user".to_string()),
                property: "profile".to_string(),
            })),
            property: "name".to_string(),
        }));

        let result = evaluator.evaluate_expression(&member_chain).unwrap();
        assert_eq!(result, Value::string("Alice"));

        let readset = evaluator.context.get_readset();
        // Should track the variable and the entity reference chain
        assert!(readset.get_variables().contains("user"));
        assert!(readset
            .get_entity_references()
            .contains("user.profile.name"));

        // Test 2: Special reference chain - @.owner.name
        let special_chain = Expression::MemberAccess(Box::new(MemberAccessExpr {
            object: Expression::MemberAccess(Box::new(MemberAccessExpr {
                object: Expression::Identifier("@".to_string()),
                property: "owner".to_string(),
            })),
            property: "name".to_string(),
        }));

        let result = evaluator.evaluate_expression(&special_chain).unwrap();
        assert_eq!(result, Value::string("Bob"));

        let readset = evaluator.context.get_readset();
        // Should track special reference and full chain
        assert!(readset.get_special_references().contains("@"));
        assert!(readset.get_entity_references().contains("@.owner.name"));

        // Test 3: Index access - @.items[0]
        let index_access = Expression::IndexAccess(Box::new(IndexAccessExpr {
            array: Expression::MemberAccess(Box::new(MemberAccessExpr {
                object: Expression::Identifier("@".to_string()),
                property: "items".to_string(),
            })),
            index: Expression::Literal(Literal::Number(0.0)),
        }));

        let result = evaluator.evaluate_expression(&index_access).unwrap();
        assert_eq!(result, Value::string("item1"));

        let readset = evaluator.context.get_readset();
        // Should track the indexed access with the exact format
        assert!(readset
            .get_entity_references()
            .contains("@.items.<index:0>"));

        // Test 4: Dynamic index access - user.profile.settings[variable]
        evaluator
            .context
            .set_variable("index_var", Value::number(1.0));
        let dynamic_index = Expression::IndexAccess(Box::new(IndexAccessExpr {
            array: Expression::MemberAccess(Box::new(MemberAccessExpr {
                object: Expression::MemberAccess(Box::new(MemberAccessExpr {
                    object: Expression::Identifier("user".to_string()),
                    property: "profile".to_string(),
                })),
                property: "settings".to_string(),
            })),
            index: Expression::Identifier("index_var".to_string()),
        }));

        let result = evaluator.evaluate_expression(&dynamic_index).unwrap();
        assert_eq!(result, Value::string("theme2"));

        let readset = evaluator.context.get_readset();
        // Should track both the index variable and the base access
        assert!(readset.get_variables().contains("index_var"));
        assert!(readset
            .get_entity_references()
            .contains("user.profile.settings"));
    }

    #[test]
    fn test_special_reference_resolution() {
        let mut evaluator = Evaluator::new(create_test_context());

        // Set up special reference context variables
        let mut current_entity = serde_json::Map::new();
        current_entity.insert(
            "id".to_string(),
            serde_json::Value::String("entity_123".to_string()),
        );
        current_entity.insert(
            "name".to_string(),
            serde_json::Value::String("Test Entity".to_string()),
        );
        evaluator
            .context
            .set_variable("current_entity", Value::object(current_entity));

        let mut current_user = serde_json::Map::new();
        current_user.insert(
            "id".to_string(),
            serde_json::Value::String("user_456".to_string()),
        );
        current_user.insert(
            "name".to_string(),
            serde_json::Value::String("John Doe".to_string()),
        );
        evaluator
            .context
            .set_variable("current_user", Value::object(current_user));

        // Set up scope context that will be auto-injected
        evaluator.context.set_partition_key("partition_789");
        evaluator
            .context
            .set_scope_metadata("name", Value::string("My Scope"));

        // Test @ (current entity)
        let current_entity_expr = Expression::Identifier("@".to_string());
        let result = evaluator.evaluate_expression(&current_entity_expr).unwrap();
        if let serde_json::Value::Object(obj) = result.inner() {
            assert_eq!(obj.get("id").unwrap().as_str().unwrap(), "entity_123");
        } else {
            panic!("@ should return an object");
        }

        // Test @@ (current user)
        let current_user_expr = Expression::Identifier("@@".to_string());
        let result = evaluator.evaluate_expression(&current_user_expr).unwrap();
        if let serde_json::Value::Object(obj) = result.inner() {
            assert_eq!(obj.get("id").unwrap().as_str().unwrap(), "user_456");
        } else {
            panic!("@@ should return an object");
        }

        // Test $scope
        let scope_expr = Expression::Identifier("$scope".to_string());
        let result = evaluator.evaluate_expression(&scope_expr).unwrap();
        if let serde_json::Value::Object(obj) = result.inner() {
            assert_eq!(obj.get("id").unwrap().as_str().unwrap(), "partition_789");
        } else {
            panic!("$scope should return an object");
        }

        // Verify ReadSet tracking for special references
        let readset = evaluator.context.get_readset();
        assert!(readset.get_special_references().contains("@"));
        assert!(readset.get_special_references().contains("@@"));
        assert!(readset.get_special_references().contains("$scope"));
    }

    #[test]
    fn test_special_reference_member_access() {
        let mut evaluator = Evaluator::new(create_test_context());

        // Set up context
        let mut current_user = serde_json::Map::new();
        current_user.insert(
            "name".to_string(),
            serde_json::Value::String("Alice".to_string()),
        );
        current_user.insert(
            "role".to_string(),
            serde_json::Value::String("admin".to_string()),
        );
        evaluator
            .context
            .set_variable("current_user", Value::object(current_user));

        // Test @@.name (current user's name)
        let user_name_expr = Expression::MemberAccess(Box::new(MemberAccessExpr {
            object: Expression::Identifier("@@".to_string()),
            property: "name".to_string(),
        }));

        let result = evaluator.evaluate_expression(&user_name_expr).unwrap();
        assert_eq!(result, Value::string("Alice"));

        // Test @@.missing (should return null)
        let missing_prop_expr = Expression::MemberAccess(Box::new(MemberAccessExpr {
            object: Expression::Identifier("@@".to_string()),
            property: "missing".to_string(),
        }));

        let result = evaluator.evaluate_expression(&missing_prop_expr).unwrap();
        assert_eq!(result, Value::null());
    }

    #[test]
    fn test_special_reference_missing_context() {
        let mut evaluator = Evaluator::new(create_test_context());

        // Don't set up any special reference variables

        // Test @ without current_entity -> should error
        let current_entity_expr = Expression::Identifier("@".to_string());
        let result = evaluator.evaluate_expression(&current_entity_expr);
        assert!(result.is_err());
        if let Err(EvaluationError::Context { message, .. }) = result {
            assert!(message.contains("No current entity"));
        }

        // Test @@ without current_user -> should error
        let current_user_expr = Expression::Identifier("@@".to_string());
        let result = evaluator.evaluate_expression(&current_user_expr);
        assert!(result.is_err());
        if let Err(EvaluationError::Context { message, .. }) = result {
            assert!(message.contains("No current user"));
        }

        // Test $scope without scope data -> should error
        let scope_expr = Expression::Identifier("$scope".to_string());
        let result = evaluator.evaluate_expression(&scope_expr);
        assert!(result.is_err());
        if let Err(EvaluationError::Context { message, .. }) = result {
            assert!(message.contains("No scope") || message.contains("$scope"));
        }
    }

    #[test]
    fn test_context_validation_integration() {
        use crate::context::ContextValidationError;

        // Create a context with validation errors
        let mut context = create_test_context();
        context.add_permission("entity:read"); // Permission without user ID
        context.set_max_traversal_depth(0); // Invalid depth

        let mut evaluator = Evaluator::new(context);

        // Try to evaluate a simple expression - should fail with validation errors
        let ast = AstNode::Expression(Expression::Literal(Literal::Number(42.0)));
        let result = evaluator.evaluate_ast(&ast);

        assert!(result.is_err());
        if let Err(EvaluationError::ContextValidation(errors)) = result {
            assert!(errors.len() >= 2); // At least security violation and invalid depth

            // Check we have both expected error types
            let has_security_violation = errors
                .iter()
                .any(|e| matches!(e, ContextValidationError::SecurityViolation { .. }));
            let has_invalid_config = errors
                .iter()
                .any(|e| matches!(e, ContextValidationError::InvalidConfiguration { .. }));

            assert!(has_security_violation, "Should have security violation");
            assert!(
                has_invalid_config,
                "Should have invalid configuration error"
            );
        } else {
            panic!("Expected ContextValidation error, got: {:?}", result);
        }
    }

    #[test]
    fn test_context_validation_success() {
        // Create a valid context
        let mut context = create_test_context();
        context.set_user_id("user_123");
        context.add_permission("entity:read");
        context.set_max_traversal_depth(50);

        let mut evaluator = Evaluator::new(context);

        // Should succeed with valid context
        let ast = AstNode::Expression(Expression::Literal(Literal::Number(42.0)));
        let result = evaluator.evaluate_ast(&ast);

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), Value::number(42.0));
    }

    #[test]
    fn test_scope_context_integration() {
        // 1. Create a context with scope data
        let mut context = create_test_context();
        context.set_partition_key("partition_123");
        context.set_scope_metadata("name", Value::string("Strategy Pottery App"));
        context.set_scope_metadata(
            "config_ai_settings",
            Value::object(
                serde_json::json!({
                    "primary_agent_id": "agent_pottery_coach"
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
        );

        let mut evaluator = Evaluator::new(context);

        // 3. Test direct access to the scope object
        let ast = AstNode::Expression(Expression::Identifier("$scope".to_string()));
        let result = evaluator.evaluate_ast(&ast).unwrap();
        assert!(result.is_object());

        // 4. Test member access on the scope object (access metadata.name)
        let ast = AstNode::Expression(Expression::MemberAccess(Box::new(MemberAccessExpr {
            object: Expression::MemberAccess(Box::new(MemberAccessExpr {
                object: Expression::Identifier("$scope".to_string()),
                property: "metadata".to_string(),
            })),
            property: "name".to_string(),
        })));
        let result = evaluator.evaluate_ast(&ast).unwrap();
        assert_eq!(result, Value::string("Strategy Pottery App"));

        // 5. Test nested member access (access metadata.config_ai_settings.primary_agent_id)
        let ast = AstNode::Expression(Expression::MemberAccess(Box::new(MemberAccessExpr {
            object: Expression::MemberAccess(Box::new(MemberAccessExpr {
                object: Expression::MemberAccess(Box::new(MemberAccessExpr {
                    object: Expression::Identifier("$scope".to_string()),
                    property: "metadata".to_string(),
                })),
                property: "config_ai_settings".to_string(),
            })),
            property: "primary_agent_id".to_string(),
        })));
        let result = evaluator.evaluate_ast(&ast).unwrap();
        assert_eq!(result, Value::string("agent_pottery_coach"));
    }

    #[test]
    fn test_entity_relationship_traversal() {
        use crate::context::DataBindingResolver;

        // 1. Define a Mock Data Resolver for this test.
        // This simulates the platform fetching real data from a database.
        #[derive(Clone, Debug)]
        struct MockResolver;
        impl DataBindingResolver for MockResolver {
            fn resolve_entity(&self, entity_id: &str) -> Option<Value> {
                println!("🔍 MockResolver: resolving entity '{}'", entity_id);
                match entity_id {
                    "proj_123" => {
                        println!("📦 Returning project data");
                        Some(Value::object(
                            serde_json::json!({
                                "name": "Formula Engine Launch",
                                // This property is an ENTITY REFERENCE, pointing to the user.
                                "owner": { "$ent_ref": "user_456" }
                            })
                            .as_object()
                            .unwrap()
                            .clone(),
                        ))
                    }
                    "user_456" => {
                        println!("👤 Returning user data");
                        Some(Value::object(
                            serde_json::json!({
                                "name": "Alice",
                                "email": "alice@example.com"
                            })
                            .as_object()
                            .unwrap()
                            .clone(),
                        ))
                    }
                    _ => {
                        println!("❌ Entity '{}' not found", entity_id);
                        None
                    }
                }
            }

            fn can_access_entity(&self, _path: &str, _user: Option<&str>) -> bool {
                true // Allow all access for this test.
            }

            fn clone_box(&self) -> Box<dyn DataBindingResolver> {
                Box::new(self.clone())
            }
        }

        // 2. Setup the context and evaluator with our mock resolver.
        let mut context = create_test_context();
        context.set_user_id("test_user"); // Need user ID when setting permissions
        context.add_permission("entity:read"); // Need permission to read entities
        context.set_data_resolver(Box::new(MockResolver));
        // Set the starting point for our formula. The '@' reference will point to this.
        context.set_variable(
            "current_entity",
            Value(serde_json::json!({ "$ent_ref": "proj_123" })),
        );

        let mut evaluator = Evaluator::new(context);

        // 3. Define the formula's AST: `@.owner.name`
        // This represents a two-step traversal:
        // First, from the current entity (`@`) to its `owner`.
        // Second, from the `owner` entity to its `name`.
        let ast = AstNode::Expression(Expression::MemberAccess(Box::new(MemberAccessExpr {
            object: Expression::MemberAccess(Box::new(MemberAccessExpr {
                object: Expression::Identifier("@".to_string()),
                property: "owner".to_string(),
            })),
            property: "name".to_string(),
        })));

        // 4. Evaluate the AST and verify the result.
        println!("▶️ Evaluating traversal: @.owner.name");
        let result = evaluator.evaluate_ast(&ast).unwrap();
        println!("✅ Final Result: {:?}", result.inner());

        assert_eq!(result, Value::string("Alice"));

        // 5. Verify that the dependency tracking (ReadSet) is correct.
        let read_set = evaluator.context.get_readset();
        let expected_dep = "@.owner.name".to_string();
        println!(
            "🔬 Dependencies Tracked: {:?}",
            read_set.get_entity_references()
        );
        assert!(
            read_set.get_entity_references().contains(&expected_dep),
            "ReadSet should have tracked the full traversal path"
        );
        println!("✅ Dependency tracking is correct.");
    }

    #[test]
    fn test_traversal_depth_limit() {
        use crate::context::DataBindingResolver;

        // Create a mock resolver that creates circular references
        #[derive(Clone, Debug)]
        struct CircularResolver;
        impl DataBindingResolver for CircularResolver {
            fn resolve_entity(&self, entity_id: &str) -> Option<Value> {
                match entity_id {
                    "entity_a" => Some(Value::object(
                        serde_json::json!({
                            "name": "Entity A",
                            "next": { "$ent_ref": "entity_b" }
                        })
                        .as_object()
                        .unwrap()
                        .clone(),
                    )),
                    "entity_b" => Some(Value::object(
                        serde_json::json!({
                            "name": "Entity B",
                            "next": { "$ent_ref": "entity_a" }  // Creates a cycle!
                        })
                        .as_object()
                        .unwrap()
                        .clone(),
                    )),
                    _ => None,
                }
            }

            fn can_access_entity(&self, _path: &str, _user: Option<&str>) -> bool {
                true
            }

            fn clone_box(&self) -> Box<dyn DataBindingResolver> {
                Box::new(self.clone())
            }
        }

        let mut context = create_test_context();
        context.set_user_id("test_user"); // Need user ID when setting permissions
        context.add_permission("entity:read"); // <- add this exact line
        context.set_data_resolver(Box::new(CircularResolver));
        context.set_max_traversal_depth(3); // Set a low limit for testing
        context.set_variable(
            "current_entity",
            Value(serde_json::json!({ "$ent_ref": "entity_a" })),
        );

        let mut evaluator = Evaluator::new(context);

        // Create a deep traversal that will exceed the limit: @.next.next.next.next
        let ast = AstNode::Expression(Expression::MemberAccess(Box::new(MemberAccessExpr {
            object: Expression::MemberAccess(Box::new(MemberAccessExpr {
                object: Expression::MemberAccess(Box::new(MemberAccessExpr {
                    object: Expression::MemberAccess(Box::new(MemberAccessExpr {
                        object: Expression::Identifier("@".to_string()),
                        property: "next".to_string(),
                    })),
                    property: "next".to_string(),
                })),
                property: "next".to_string(),
            })),
            property: "next".to_string(),
        })));

        println!("▶️ Testing traversal depth limit with circular references");
        let result = evaluator.evaluate_ast(&ast);
        println!("🚫 Result: {:?}", result);

        // Should fail with a Security error about max depth exceeded
        assert!(result.is_err());
        if let Err(EvaluationError::Security { message, .. }) = result {
            assert!(message.contains("Maximum traversal depth"));
            println!("✅ Depth limit correctly enforced: {}", message);
        } else {
            panic!("Expected Security error about traversal depth");
        }
    }

    #[test]
    fn test_scope_special_auto_injection() {
        use crate::ast::{AstNode, Expression, MemberAccessExpr};

        let mut ctx = create_test_context();

        // Populate scope context (but DO NOT set `$scope` var)
        ctx.set_partition_key("partition_123");
        ctx.set_owner_id("owner_42");
        ctx.set_scope_metadata("theme", crate::types::Value::string("dark"));

        // Evaluate: `$scope.metadata.theme`
        let expr = Expression::MemberAccess(Box::new(MemberAccessExpr {
            object: Expression::MemberAccess(Box::new(MemberAccessExpr {
                object: Expression::Identifier("$scope".to_string()),
                property: "metadata".to_string(),
            })),
            property: "theme".to_string(),
        }));
        let ast = AstNode::Expression(expr);

        let mut ev = Evaluator::new(ctx);
        let out = ev.evaluate_ast(&ast).expect("evaluation should succeed");

        assert_eq!(out, crate::types::Value::string("dark"));
    }

    #[test]
    fn test_special_current_entity_not_auto_injected() {
        use crate::ast::{AstNode, Expression};

        // No `@` provided
        let ctx = create_test_context();
        let mut ev = Evaluator::new(ctx);

        let ast = AstNode::Expression(Expression::Identifier("@".to_string()));
        let err = ev.evaluate_ast(&ast).unwrap_err();

        // We still expect a validation/context error for missing `@`
        // (exact match may vary; check it's a context-ish failure).
        let msg = format!("{:?}", err);
        assert!(
            msg.contains("@") || msg.to_lowercase().contains("current entity"),
            "expected an error mentioning missing current entity, got: {}",
            msg
        );
    }

    #[test]
    fn test_scope_special_refresh_with_clear() {
        use crate::ast::{AstNode, Expression};

        let mut ctx = create_test_context();
        ctx.set_partition_key("partition_001");
        ctx.set_scope_metadata("version", crate::types::Value::string("v1"));

        let mut ev = Evaluator::new(ctx);

        // First evaluation - gets scope with v1
        let ast = AstNode::Expression(Expression::MemberAccess(Box::new(MemberAccessExpr {
            object: Expression::MemberAccess(Box::new(MemberAccessExpr {
                object: Expression::Identifier("$scope".to_string()),
                property: "metadata".to_string(),
            })),
            property: "version".to_string(),
        })));
        let result = ev.evaluate_ast(&ast).expect("should succeed");
        assert_eq!(result, crate::types::Value::string("v1"));

        // Update scope context
        ev.context
            .set_scope_metadata("version", crate::types::Value::string("v2"));

        // Without clear, still gets v1 (snapshot behavior)
        let result = ev.evaluate_ast(&ast).expect("should succeed");
        assert_eq!(result, crate::types::Value::string("v1"));

        // Clear and re-evaluate - now gets v2
        ev.context.clear_scope_special();
        ev.specials_injected = false; // Also reset the flag since we cleared
        let result = ev.evaluate_ast(&ast).expect("should succeed");
        assert_eq!(result, crate::types::Value::string("v2"));
    }
}
