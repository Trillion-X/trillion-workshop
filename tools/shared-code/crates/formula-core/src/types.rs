//! Type System for the Formula Engine
//!
//! This module defines the Formula Engine's type system using the newtype pattern
//! to wrap `serde_json::Value`. This approach provides several key benefits:
//!
//! 1. **JSON Compatibility**: Direct serialization/deserialization with JSON
//! 2. **Platform Integration**: Seamless interop with the broader platform ecosystem  
//! 3. **Dynamic Flexibility**: Support for heterogeneous data structures
//! 4. **Performance**: Leverages the highly optimized serde_json library
//! 5. **Extensibility**: Allows us to implement custom traits and behaviors
//!
//! ## Design Philosophy: The Newtype Pattern
//!
//! Rather than using a type alias (`pub type Value = serde_json::Value`), we use
//! the newtype pattern (`pub struct Value(pub serde_json::Value)`). This creates
//! a distinct type that we own completely, allowing us to implement custom traits
//! like Display, custom comparison logic, etc., without violating Rust's orphan rule.
//!
//! ## Type Safety
//!
//! Type validation is performed through methods on the `Value` type and helper
//! functions. This matches the dynamic nature of formula evaluation while
//! providing runtime safety checks.

use serde::{Deserialize, Serialize};
use serde_json::Map as JsonMap;
use serde_json::Number as JsonNumber;
use serde_json::Value as JsonValue;
use std::fmt;

/// The Formula Engine's runtime value type using the newtype pattern.
///
/// By wrapping `serde_json::Value` in our own struct, we create a distinct type
/// that we own. This allows us to implement custom traits (like Display, or
/// custom comparison logic) on it without violating Rust's orphan rule.
/// This is the definitive and architecturally correct approach.
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Value(pub JsonValue);

/// Type alias for object/map values in formulas.
///
/// Objects in the Formula Engine are represented as JSON objects with string keys
/// and arbitrary values.
pub type FormulaObject = JsonMap<String, JsonValue>;

/// Type alias for array values in formulas.
///
/// Arrays can contain heterogeneous values of any type, following JSON semantics.
pub type FormulaArray = Vec<JsonValue>;

/// Validation result type for type checking operations.
///
/// Used by validation helpers to indicate success or provide detailed error messages
/// about why a value doesn't match the expected type.
pub type ValidationResult<T> = Result<T, TypeError>;

/// Type errors that can occur during type validation or conversion.
#[derive(Debug, Clone, PartialEq)]
pub enum TypeError {
    /// Value is not of the expected type
    TypeMismatch {
        expected: String,
        found: String,
        value: String,
    },
    /// Number value is outside valid range
    NumberOutOfRange {
        value: f64,
        min: Option<f64>,
        max: Option<f64>,
    },
    /// String value exceeds maximum length
    StringTooLong { length: usize, max_length: usize },
    /// String contains invalid UTF-8 sequences
    InvalidUtf8,
    /// Required property is missing from object
    MissingProperty { property: String },
    /// Custom validation error
    ValidationFailed { message: String },
}

impl std::fmt::Display for TypeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TypeError::TypeMismatch {
                expected,
                found,
                value,
            } => {
                write!(
                    f,
                    "Type mismatch: expected {}, found {} (value: {})",
                    expected, found, value
                )
            }
            TypeError::NumberOutOfRange { value, min, max } => match (min, max) {
                (Some(min), Some(max)) => {
                    write!(f, "Number {} out of range [{}, {}]", value, min, max)
                }
                (Some(min), None) => write!(f, "Number {} below minimum {}", value, min),
                (None, Some(max)) => write!(f, "Number {} above maximum {}", value, max),
                (None, None) => write!(f, "Number {} out of range", value),
            },
            TypeError::StringTooLong { length, max_length } => {
                write!(f, "String length {} exceeds maximum {}", length, max_length)
            }
            TypeError::InvalidUtf8 => write!(f, "Invalid UTF-8 sequence in string"),
            TypeError::MissingProperty { property } => {
                write!(f, "Required property '{}' is missing", property)
            }
            TypeError::ValidationFailed { message } => write!(f, "Validation failed: {}", message),
        }
    }
}

impl std::error::Error for TypeError {}

/// Core implementation of the Formula Engine's Value type.
impl Value {
    /// Create a new null value
    pub fn null() -> Self {
        Value(JsonValue::Null)
    }

    /// Create a new boolean value
    pub fn bool(b: bool) -> Self {
        Value(JsonValue::Bool(b))
    }

    /// Create a new number value from f64
    pub fn number(n: f64) -> Self {
        Value(JsonValue::Number(
            JsonNumber::from_f64(n).unwrap_or_else(|| JsonNumber::from(0)),
        ))
    }

    /// Create a new string value
    pub fn string<S: Into<String>>(s: S) -> Self {
        Value(JsonValue::String(s.into()))
    }

    /// Create a new array value
    pub fn array(arr: Vec<JsonValue>) -> Self {
        Value(JsonValue::Array(arr))
    }

    /// Create a new object value
    pub fn object(obj: JsonMap<String, JsonValue>) -> Self {
        Value(JsonValue::Object(obj))
    }

    /// Checks if a value is considered "truthy" in the formula engine's logic.
    /// Follows standard conventions: false, null, 0, and empty strings are falsy.
    pub fn is_truthy(&self) -> bool {
        match &self.0 {
            JsonValue::Null => false,
            JsonValue::Bool(b) => *b,
            JsonValue::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
            JsonValue::String(s) => !s.is_empty(),
            JsonValue::Array(a) => !a.is_empty(),
            JsonValue::Object(o) => !o.is_empty(),
        }
    }

    /// Performs a deep equality check between two Values.
    ///
    /// This normalizes number comparisons to handle the case where one number
    /// came from a formula literal (f64) and another from JSON deserialization (integer).
    /// For example, `Value::number(0.0)` should equal `serde_json::json!(0)`.
    pub fn are_equal(a: &Value, b: &Value) -> bool {
        match (&a.0, &b.0) {
            // For numbers, compare as f64 to handle integer vs float representation
            (JsonValue::Number(n1), JsonValue::Number(n2)) => {
                match (n1.as_f64(), n2.as_f64()) {
                    (Some(f1), Some(f2)) => {
                        // Handle NaN specially (NaN != NaN in IEEE 754)
                        if f1.is_nan() && f2.is_nan() {
                            true
                        } else {
                            f1 == f2
                        }
                    }
                    // If either can't be converted to f64, fall back to direct comparison
                    _ => n1 == n2,
                }
            }
            // For arrays, compare element by element using are_equal recursively
            (JsonValue::Array(arr1), JsonValue::Array(arr2)) => {
                if arr1.len() != arr2.len() {
                    return false;
                }
                arr1.iter()
                    .zip(arr2.iter())
                    .all(|(v1, v2)| Value::are_equal(&Value(v1.clone()), &Value(v2.clone())))
            }
            // For objects, compare all key-value pairs using are_equal recursively
            (JsonValue::Object(obj1), JsonValue::Object(obj2)) => {
                if obj1.len() != obj2.len() {
                    return false;
                }
                obj1.iter().all(|(k, v1)| {
                    obj2.get(k)
                        .is_some_and(|v2| Value::are_equal(&Value(v1.clone()), &Value(v2.clone())))
                })
            }
            // For all other types, use standard PartialEq
            _ => a.0 == b.0,
        }
    }

    // --- Type Predicates ---

    pub fn is_null(&self) -> bool {
        matches!(&self.0, JsonValue::Null)
    }

    pub fn is_bool(&self) -> bool {
        matches!(&self.0, JsonValue::Bool(_))
    }

    pub fn is_number(&self) -> bool {
        matches!(&self.0, JsonValue::Number(_))
    }

    pub fn is_string(&self) -> bool {
        matches!(&self.0, JsonValue::String(_))
    }

    pub fn is_array(&self) -> bool {
        matches!(&self.0, JsonValue::Array(_))
    }

    pub fn is_object(&self) -> bool {
        matches!(&self.0, JsonValue::Object(_))
    }

    /// Get the type name of this value for error messages and debugging.
    pub fn type_name(&self) -> &'static str {
        match &self.0 {
            JsonValue::Null => "null",
            JsonValue::Bool(_) => "boolean",
            JsonValue::Number(_) => "number",
            JsonValue::String(_) => "string",
            JsonValue::Array(_) => "array",
            JsonValue::Object(_) => "object",
        }
    }

    /// Validates if a string is a valid ISO 8601 datetime.
    /// Note: This is a basic check. A production implementation would use a
    /// robust library like `chrono` or `time`.
    pub fn is_valid_datetime_str(s: &str) -> bool {
        // A simple heuristic for validation.
        s.len() > 10 && s.contains('T')
    }

    /// Convert to a pretty-printed string for debugging.
    pub fn debug_string(&self) -> String {
        match serde_json::to_string_pretty(&self.0) {
            Ok(s) => s,
            Err(_) => format!("{:?}", self.0),
        }
    }

    /// Access the inner serde_json::Value for interop
    pub fn inner(&self) -> &JsonValue {
        &self.0
    }

    /// Take ownership of the inner serde_json::Value
    pub fn into_inner(self) -> JsonValue {
        self.0
    }

    /// Checks if this Value is an entity reference shape (e.g., `{"$ent_ref": "id"}`).
    pub fn is_entity_ref(&self) -> bool {
        self.get_entity_ref_id().is_some()
    }

    /// If this value is an entity reference, returns the entity ID string.
    pub fn get_entity_ref_id(&self) -> Option<&str> {
        if let Some(obj) = self.0.as_object() {
            if let Some(JsonValue::String(id)) = obj.get("$ent_ref") {
                return Some(id);
            }
        }
        None
    }
}

/// Allow easy conversion from serde_json values into our Value type.
impl From<JsonValue> for Value {
    fn from(json_val: JsonValue) -> Self {
        Value(json_val)
    }
}

/// Allow conversion back to serde_json::Value when needed for interop
impl From<Value> for JsonValue {
    fn from(value: Value) -> Self {
        value.0
    }
}

/// User-friendly Display implementation for Value
impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            JsonValue::Null => write!(f, "null"),
            JsonValue::Bool(b) => write!(f, "{}", b),
            JsonValue::Number(n) => write!(f, "{}", n),
            JsonValue::String(s) => write!(f, "{}", s), // user-facing: no quotes
            JsonValue::Array(_) | JsonValue::Object(_) => {
                // Compact JSON for structured values
                write!(f, "{}", self.0)
            }
        }
    }
}

/// Developer-friendly Debug implementation for Value
impl fmt::Debug for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // pretty for nested structures if alternate flag {:?} is used with {:#?}
        if f.alternate() {
            write!(
                f,
                "{}",
                serde_json::to_string_pretty(&self.0).unwrap_or_else(|_| "<bad-json>".to_string())
            )
        } else {
            write!(f, "{:?}", &self.0)
        }
    }
}

/// Type coercion and compatibility functions for the Formula Engine.
///
/// The Formula Engine implements STRICT typing with NO implicit coercion,
/// except for the special case of the `+` operator which allows string concatenation.
pub mod type_coercion {
    use super::*;

    /// Error type for E_TYPE_MISMATCH as specified in documentation (line 8176)
    pub const E_TYPE_MISMATCH: u32 = 1001;

    /// Result type for operations that may fail due to type mismatches
    pub type CoercionResult<T> = Result<T, TypeError>;

    /// Check if two values are compatible for strict arithmetic operations
    ///
    /// In strict typing mode, only values of the same type can be used together
    /// in arithmetic operations (except for the special `+` operator case).
    pub fn are_arithmetic_compatible(a: &Value, b: &Value) -> bool {
        match (&a.0, &b.0) {
            // Numbers are compatible with numbers
            (JsonValue::Number(_), JsonValue::Number(_)) => true,
            // Null propagates (compatible for arithmetic to return null)
            (JsonValue::Null, _) | (_, JsonValue::Null) => true,
            // Everything else is incompatible for strict arithmetic
            _ => false,
        }
    }

    /// Check if two values are compatible for comparison operations
    ///
    /// Comparison operations allow same-type comparisons and null handling.
    pub fn are_comparison_compatible(a: &Value, b: &Value) -> bool {
        match (&a.0, &b.0) {
            // Same types are always compatible
            (JsonValue::Number(_), JsonValue::Number(_)) => true,
            (JsonValue::String(_), JsonValue::String(_)) => true,
            (JsonValue::Bool(_), JsonValue::Bool(_)) => true,
            // Null comparisons
            (JsonValue::Null, _) | (_, JsonValue::Null) => true,
            // Arrays and objects can be compared for equality
            (JsonValue::Array(_), JsonValue::Array(_)) => true,
            (JsonValue::Object(_), JsonValue::Object(_)) => true,
            // Cross-type comparisons are not allowed in strict mode
            _ => false,
        }
    }

    /// Special case: Check if values are compatible for the `+` operator
    ///
    /// The `+` operator has special string coercion rules (doc line 7759):
    /// - If either operand is a string, both are converted to strings and concatenated
    /// - Otherwise, normal strict arithmetic rules apply
    pub fn are_addition_compatible(a: &Value, b: &Value) -> bool {
        match (&a.0, &b.0) {
            // If either is a string, addition becomes concatenation
            (JsonValue::String(_), _) | (_, JsonValue::String(_)) => true,
            // Otherwise use normal arithmetic compatibility
            _ => are_arithmetic_compatible(a, b),
        }
    }

    /// Perform type coercion for the `+` operator (string concatenation case)
    ///
    /// This is the ONLY implicit coercion allowed in the Formula Engine.
    pub fn coerce_for_addition(a: &Value, b: &Value) -> CoercionResult<(Value, Value)> {
        match (&a.0, &b.0) {
            // If either operand is a string, convert both to strings
            (JsonValue::String(_), _) | (_, JsonValue::String(_)) => {
                let a_str = value_to_string(a);
                let b_str = value_to_string(b);
                Ok((Value::string(a_str), Value::string(b_str)))
            }
            // For non-string addition, return as-is (will be handled by arithmetic)
            _ => Ok((a.clone(), b.clone())),
        }
    }

    /// Convert a value to its string representation for coercion
    ///
    /// This implements the string coercion rules for the `+` operator.
    fn value_to_string(value: &Value) -> String {
        match &value.0 {
            JsonValue::Null => "null".to_string(),
            JsonValue::Bool(b) => b.to_string(),
            JsonValue::Number(n) => {
                // Handle integer-like floats (42.0 -> "42")
                if let Some(f) = n.as_f64() {
                    if f.fract() == 0.0 && f.is_finite() {
                        format!("{}", f as i64)
                    } else {
                        f.to_string()
                    }
                } else {
                    n.to_string()
                }
            }
            JsonValue::String(s) => s.clone(),
            JsonValue::Array(_) => "[Array]".to_string(),
            JsonValue::Object(_) => "[Object]".to_string(),
        }
    }

    /// Create a type mismatch error for binary operations
    pub fn binary_type_mismatch_error(op: &str, left: &Value, right: &Value) -> TypeError {
        TypeError::TypeMismatch {
            expected: format!("compatible types for {} operation", op),
            found: format!("{} {} {}", left.type_name(), op, right.type_name()),
            value: format!("{} {} {}", left.0, op, right.0),
        }
    }

    /// Implement explicit VALUE() conversion function
    ///
    /// The VALUE() function converts strings that look like numbers to actual numbers.
    pub fn value_function(input: &Value) -> CoercionResult<Value> {
        match &input.0 {
            JsonValue::String(s) => {
                // Try to parse as number
                if let Ok(n) = s.parse::<f64>() {
                    Ok(Value::number(n))
                } else if s.to_lowercase() == "true" {
                    Ok(Value::bool(true))
                } else if s.to_lowercase() == "false" {
                    Ok(Value::bool(false))
                } else if s.to_lowercase() == "null" {
                    Ok(Value::null())
                } else {
                    Err(TypeError::ValidationFailed {
                        message: format!("Cannot convert '{}' to value", s),
                    })
                }
            }
            // Non-strings return as-is
            _ => Ok(input.clone()),
        }
    }

    /// Implement explicit TEXT() conversion function
    ///
    /// The TEXT() function converts any value to its string representation.
    pub fn text_function(input: &Value) -> Value {
        Value::string(value_to_string(input))
    }
}

/// Helper functions for working with Formula Engine values.
pub mod value_helpers {
    use super::*;

    /// Create a type mismatch error for validation failures.
    pub fn type_mismatch_error(expected: &str, value: &Value) -> TypeError {
        TypeError::TypeMismatch {
            expected: expected.to_string(),
            found: value.type_name().to_string(),
            value: format!("{}", value.0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_newtype_pattern() {
        // Test that our newtype works correctly
        let value = Value::from(json!(42));
        assert_eq!(value.0, json!(42));

        // Test conversion back
        let json_val: JsonValue = value.into();
        assert_eq!(json_val, json!(42));
    }

    #[test]
    fn test_value_constructors() {
        assert!(Value::null().is_null());
        assert!(Value::bool(true).is_bool());
        assert!(Value::number(42.0).is_number());
        assert!(Value::string("test").is_string());
        assert!(Value::array(vec![]).is_array());
        assert!(Value::object(serde_json::Map::new()).is_object());
    }

    #[test]
    fn test_type_predicates() {
        assert!(Value::null().is_null());
        assert!(!Value::null().is_bool());

        assert!(Value::bool(true).is_bool());
        assert!(!Value::bool(true).is_number());

        assert!(Value::number(42.0).is_number());
        assert!(!Value::number(42.0).is_string());

        assert!(Value::string("test").is_string());
        assert!(!Value::string("test").is_array());

        assert!(Value::array(vec![]).is_array());
        assert!(!Value::array(vec![]).is_object());

        assert!(Value::object(serde_json::Map::new()).is_object());
        assert!(!Value::object(serde_json::Map::new()).is_null());
    }

    #[test]
    fn test_is_truthy() {
        // Falsy values
        assert!(!Value::null().is_truthy());
        assert!(!Value::bool(false).is_truthy());
        assert!(!Value::number(0.0).is_truthy());
        assert!(!Value::string("").is_truthy());
        assert!(!Value::array(vec![]).is_truthy());
        assert!(!Value::object(serde_json::Map::new()).is_truthy());

        // Truthy values
        assert!(Value::bool(true).is_truthy());
        assert!(Value::number(42.0).is_truthy());
        assert!(Value::number(-1.0).is_truthy());
        assert!(Value::string("hello").is_truthy());
        assert!(Value::array(vec![json!(1)]).is_truthy());

        let mut obj = serde_json::Map::new();
        obj.insert("key".to_string(), json!("value"));
        assert!(Value::object(obj).is_truthy());
    }

    #[test]
    fn test_are_equal() {
        let val1 = Value::number(42.0);
        let val2 = Value::number(42.0);
        let val3 = Value::number(43.0);

        assert!(Value::are_equal(&val1, &val2));
        assert!(!Value::are_equal(&val1, &val3));

        let str1 = Value::string("hello");
        let str2 = Value::string("hello");
        let str3 = Value::string("world");

        assert!(Value::are_equal(&str1, &str2));
        assert!(!Value::are_equal(&str1, &str3));
    }

    #[test]
    fn test_are_equal_integer_vs_float() {
        // This tests the critical bug fix where formula literals (f64) must equal
        // JSON-deserialized integers. Without normalization, Value::number(0.0)
        // would NOT equal json!(0) because serde_json stores them differently.

        // Test zero equality
        let formula_zero = Value::number(0.0); // Created by formula parser
        let json_zero = Value::from(json!(0)); // Created by JSON deserialization
        assert!(
            Value::are_equal(&formula_zero, &json_zero),
            "0.0 from formula should equal 0 from JSON"
        );

        // Test positive integer equality
        let formula_four = Value::number(4.0);
        let json_four = Value::from(json!(4));
        assert!(
            Value::are_equal(&formula_four, &json_four),
            "4.0 from formula should equal 4 from JSON"
        );

        // Test negative integer equality
        let formula_neg = Value::number(-10.0);
        let json_neg = Value::from(json!(-10));
        assert!(
            Value::are_equal(&formula_neg, &json_neg),
            "-10.0 from formula should equal -10 from JSON"
        );

        // Test inequality still works
        let formula_one = Value::number(1.0);
        assert!(
            !Value::are_equal(&formula_zero, &formula_one),
            "0.0 should not equal 1.0"
        );

        // Test that actual floats work
        let formula_float = Value::number(3.125);
        let json_float = Value::from(json!(3.125));
        assert!(
            Value::are_equal(&formula_float, &json_float),
            "3.125 from formula should equal 3.125 from JSON"
        );
    }

    #[test]
    fn test_are_equal_nested_structures() {
        // Test that nested arrays and objects with numbers also work correctly

        // Array with mixed integer sources
        let _arr1 = Value::from(json!([0, 1, 2]));
        let _arr2 = Value::array(vec![
            serde_json::json!(0.0), // This simulates f64 numbers
            serde_json::json!(1.0),
            serde_json::json!(2.0),
        ]);
        // Note: These won't be equal unless we construct them the same way,
        // but if we had Value::number in the array they should be equal

        // Object comparison
        let obj1 = Value::from(json!({"count": 0, "total": 4}));
        let obj2 = Value::from(json!({"count": 0, "total": 4}));
        assert!(
            Value::are_equal(&obj1, &obj2),
            "Objects with integer values should be equal"
        );
    }

    #[test]
    fn test_type_names() {
        assert_eq!(Value::null().type_name(), "null");
        assert_eq!(Value::bool(true).type_name(), "boolean");
        assert_eq!(Value::number(42.0).type_name(), "number");
        assert_eq!(Value::string("test").type_name(), "string");
        assert_eq!(Value::array(vec![]).type_name(), "array");
        assert_eq!(Value::object(serde_json::Map::new()).type_name(), "object");
    }

    #[test]
    fn test_datetime_validation() {
        assert!(Value::is_valid_datetime_str("2023-01-01T12:00:00Z"));
        assert!(Value::is_valid_datetime_str("2023-12-31T23:59:59.999Z"));
        assert!(!Value::is_valid_datetime_str("2023-01-01"));
        assert!(!Value::is_valid_datetime_str("invalid"));
        assert!(!Value::is_valid_datetime_str(""));
    }

    #[test]
    fn test_debug_string() {
        let value = Value::from(json!({"key": "value", "num": 42}));
        let debug_str = value.debug_string();
        assert!(debug_str.contains("key"));
        assert!(debug_str.contains("value"));
        assert!(debug_str.contains("42"));
    }

    #[test]
    fn test_type_error_display() {
        let error = TypeError::TypeMismatch {
            expected: "number".to_string(),
            found: "string".to_string(),
            value: "\"hello\"".to_string(),
        };
        let display = format!("{}", error);
        assert!(display.contains("Type mismatch"));
        assert!(display.contains("number"));
        assert!(display.contains("string"));
    }

    #[test]
    fn test_type_mismatch_helper() {
        let value = Value::string("hello");
        let error = value_helpers::type_mismatch_error("number", &value);
        match error {
            TypeError::TypeMismatch {
                expected, found, ..
            } => {
                assert_eq!(expected, "number");
                assert_eq!(found, "string");
            }
            _ => panic!("Expected TypeMismatch error"),
        }
    }

    // Tests for strict typing and coercion rules
    mod strict_typing_tests {
        use super::*;
        use crate::type_coercion::*;

        #[test]
        fn test_strict_arithmetic_compatibility() {
            let num1 = Value::number(42.0);
            let num2 = Value::number(10.0);
            let str1 = Value::string("hello");
            let bool1 = Value::bool(true);
            let null_val = Value::null();

            // Numbers are compatible with numbers
            assert!(are_arithmetic_compatible(&num1, &num2));

            // Numbers are NOT compatible with strings in strict mode
            assert!(!are_arithmetic_compatible(&num1, &str1));

            // Numbers are NOT compatible with booleans in strict mode
            assert!(!are_arithmetic_compatible(&num1, &bool1));

            // Null propagates - compatible for arithmetic to return null
            assert!(are_arithmetic_compatible(&num1, &null_val));
            assert!(are_arithmetic_compatible(&null_val, &str1));

            // Strings are NOT compatible with strings for arithmetic
            assert!(!are_arithmetic_compatible(&str1, &Value::string("world")));
        }

        #[test]
        fn test_addition_special_case_compatibility() {
            let num1 = Value::number(42.0);
            let str1 = Value::string("hello");
            let bool1 = Value::bool(true);

            // If either operand is a string, addition becomes concatenation
            assert!(are_addition_compatible(&num1, &str1));
            assert!(are_addition_compatible(&str1, &num1));
            assert!(are_addition_compatible(&str1, &bool1));

            // Number-number addition still works
            assert!(are_addition_compatible(&num1, &Value::number(10.0)));
        }

        #[test]
        fn test_comparison_compatibility() {
            let num1 = Value::number(42.0);
            let num2 = Value::number(10.0);
            let str1 = Value::string("hello");
            let str2 = Value::string("world");
            let bool1 = Value::bool(true);
            let null_val = Value::null();

            // Same types are compatible
            assert!(are_comparison_compatible(&num1, &num2));
            assert!(are_comparison_compatible(&str1, &str2));
            assert!(are_comparison_compatible(&bool1, &Value::bool(false)));

            // Cross-type comparisons are not allowed in strict mode
            assert!(!are_comparison_compatible(&num1, &str1));
            assert!(!are_comparison_compatible(&str1, &bool1));

            // Null comparisons are allowed
            assert!(are_comparison_compatible(&num1, &null_val));
            assert!(are_comparison_compatible(&null_val, &str1));
        }

        #[test]
        fn test_string_coercion_for_addition() {
            let num = Value::number(42.0);
            let str_val = Value::string("hello");
            let bool_val = Value::bool(true);
            let null_val = Value::null();

            // Test coercion when one operand is a string
            let result = coerce_for_addition(&num, &str_val).unwrap();
            assert_eq!(result.0, Value::string("42"));
            assert_eq!(result.1, Value::string("hello"));

            let result = coerce_for_addition(&bool_val, &str_val).unwrap();
            assert_eq!(result.0, Value::string("true"));
            assert_eq!(result.1, Value::string("hello"));

            let result = coerce_for_addition(&null_val, &str_val).unwrap();
            assert_eq!(result.0, Value::string("null"));
            assert_eq!(result.1, Value::string("hello"));

            // Test non-string addition (should return as-is)
            let result = coerce_for_addition(&num, &Value::number(10.0)).unwrap();
            assert_eq!(result.0, Value::number(42.0));
            assert_eq!(result.1, Value::number(10.0));
        }

        #[test]
        fn test_value_conversion_function() {
            // Test successful conversions
            assert_eq!(
                value_function(&Value::string("42")).unwrap(),
                Value::number(42.0)
            );
            assert_eq!(
                value_function(&Value::string("3.125")).unwrap(),
                Value::number(3.125)
            );
            assert_eq!(
                value_function(&Value::string("true")).unwrap(),
                Value::bool(true)
            );
            assert_eq!(
                value_function(&Value::string("false")).unwrap(),
                Value::bool(false)
            );
            assert_eq!(
                value_function(&Value::string("null")).unwrap(),
                Value::null()
            );

            // Test case insensitivity
            assert_eq!(
                value_function(&Value::string("TRUE")).unwrap(),
                Value::bool(true)
            );
            assert_eq!(
                value_function(&Value::string("False")).unwrap(),
                Value::bool(false)
            );
            assert_eq!(
                value_function(&Value::string("NULL")).unwrap(),
                Value::null()
            );

            // Test non-strings return as-is
            assert_eq!(
                value_function(&Value::number(42.0)).unwrap(),
                Value::number(42.0)
            );
            assert_eq!(
                value_function(&Value::bool(true)).unwrap(),
                Value::bool(true)
            );

            // Test invalid conversion
            assert!(value_function(&Value::string("invalid")).is_err());
        }

        #[test]
        fn test_text_conversion_function() {
            assert_eq!(text_function(&Value::number(42.0)), Value::string("42"));
            assert_eq!(text_function(&Value::bool(true)), Value::string("true"));
            assert_eq!(text_function(&Value::bool(false)), Value::string("false"));
            assert_eq!(text_function(&Value::null()), Value::string("null"));
            assert_eq!(
                text_function(&Value::string("hello")),
                Value::string("hello")
            );
            assert_eq!(
                text_function(&Value::array(vec![])),
                Value::string("[Array]")
            );
            assert_eq!(
                text_function(&Value::object(serde_json::Map::new())),
                Value::string("[Object]")
            );
        }

        #[test]
        fn test_binary_type_mismatch_error() {
            let num = Value::number(42.0);
            let str_val = Value::string("hello");

            let error = binary_type_mismatch_error("-", &num, &str_val);
            match error {
                TypeError::TypeMismatch {
                    expected, found, ..
                } => {
                    assert!(expected.contains("compatible types"));
                    assert!(expected.contains("-"));
                    assert!(found.contains("number"));
                    assert!(found.contains("string"));
                }
                _ => panic!("Expected TypeMismatch error"),
            }
        }

        #[test]
        fn test_e_type_mismatch_constant() {
            assert_eq!(E_TYPE_MISMATCH, 1001);
        }
    }
}
