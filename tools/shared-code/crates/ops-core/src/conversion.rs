//! Type conversion operators for the Architect Platform
//!
//! This module provides pure functions for type conversion operations,
//! extracted from the formula-engine's RewriteRule implementations.
//!
//! # Conversion Philosophy
//!
//! - **No implicit coercion**: Conversions are always explicit.
//! - **Null propagation**: `to_number(null) = null`
//! - **Strict typing**: Type mismatches return errors, not silent conversions.

use crate::value::OpNode;
use crate::{EvalContext, FloatMode, OpError, OpValue};
use rust_decimal::prelude::*;
use std::str::FromStr;

// ============================================================================
// Type Conversion Functions
// ============================================================================

/// Convert a value to a number.
///
/// - String: Parses as Decimal (Strict mode) or f64 (Fast mode)
/// - Number: Returns as-is
/// - Boolean: true -> 1, false -> 0
/// - Null: Returns null
/// - Other: Returns error
pub fn to_number(a: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() {
        return Ok(OpValue::null());
    }

    match a.node() {
        OpNode::Number(_) => {
            // Already a number, return as-is
            Ok(a.clone())
        }
        OpNode::String(s) => {
            let trimmed = s.trim();

            // Handle "true" and "false" strings
            if trimmed.eq_ignore_ascii_case("true") {
                return Ok(OpValue::from_i64(1));
            }
            if trimmed.eq_ignore_ascii_case("false") {
                return Ok(OpValue::from_i64(0));
            }

            match ctx.float_mode {
                FloatMode::Strict => {
                    // Try to parse as Decimal first (for financial precision)
                    if let Ok(d) = Decimal::from_str(trimmed) {
                        return Ok(OpValue::from_decimal(d));
                    }
                    // Fallback to f64
                    if let Ok(n) = trimmed.parse::<f64>() {
                        if !n.is_finite() {
                            return Err(OpError::InvalidOperation {
                                operation: "to_number".to_string(),
                                reason: "result is not finite".to_string(),
                            });
                        }
                        return Ok(OpValue::number(n));
                    }
                    Err(OpError::ConversionError {
                        operation: "to_number".to_string(),
                        from: "string".to_string(),
                        to: "number".to_string(),
                    })
                }
                FloatMode::Fast => {
                    if let Ok(n) = trimmed.parse::<f64>() {
                        if !n.is_finite() {
                            return Err(OpError::InvalidOperation {
                                operation: "to_number".to_string(),
                                reason: "result is not finite".to_string(),
                            });
                        }
                        return Ok(OpValue::number(n));
                    }
                    Err(OpError::ConversionError {
                        operation: "to_number".to_string(),
                        from: "string".to_string(),
                        to: "number".to_string(),
                    })
                }
            }
        }
        OpNode::Bool(b) => {
            let val = if *b { 1 } else { 0 };
            Ok(OpValue::from_i64(val))
        }
        _ => Err(OpError::TypeMismatch {
            operation: "to_number".to_string(),
            expected: "string, number, or boolean".to_string(),
            actual: a.type_name().to_string(),
        }),
    }
}

/// Convert a value to a string.
///
/// - Null: Returns "null"
/// - Boolean: "true" or "false"
/// - Number: String representation (integer-like floats omit decimal: 42.0 -> "42")
/// - String: Returns as-is
/// - Array: Returns "[Array]"
/// - Object: Returns "[Object]"
pub fn to_string(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let result = value_to_string(a);
    Ok(OpValue::string(result))
}

/// Convert a value to a boolean.
///
/// Uses truthiness semantics:
/// - Null: false
/// - Boolean: as-is
/// - Number: 0 is false, everything else is true
/// - String: empty string is false, everything else is true
/// - Array: empty array is false, everything else is true
/// - Object: empty object is false, everything else is true
pub fn to_bool(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    Ok(OpValue::bool(a.is_truthy()))
}

/// Convert a number to a decimal string with specified precision.
///
/// - Null: Returns null
/// - Number: Formats with specified decimal places
/// - String: Parses and reformats
pub fn to_decimal(a: &OpValue, digits: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() {
        return Ok(OpValue::null());
    }

    let dp = if digits.is_null() {
        2 // Default to 2 decimal places
    } else {
        digits.as_decimal("to_decimal")?.to_i32().unwrap_or(2)
    };

    let decimal_val = a.as_decimal("to_decimal")?;
    let rounded = decimal_val.round_dp_with_strategy(
        dp.clamp(0, 28) as u32,
        RoundingStrategy::MidpointNearestEven,
    );

    Ok(OpValue::string(rounded.to_string()))
}

/// Explicit conversion to f64.
///
/// Always converts to f64, regardless of float mode.
/// Useful when you need IEEE 754 behavior explicitly.
pub fn to_float(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() {
        return Ok(OpValue::null());
    }

    let val = a.as_f64("to_float")?;
    Ok(OpValue::number(val))
}

// ============================================================================
// Type Checking Functions
// ============================================================================

/// Get the type of a value as a string.
///
/// Returns one of: "null", "bool", "number", "string", "array", "object"
///
/// Example: `type_of(42)` returns `"number"`, `type_of(null)` returns `"null"`
pub fn type_of(value: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let type_str = match value.node() {
        OpNode::Null => "null",
        OpNode::Bool(_) => "bool",
        OpNode::Number(_) => "number",
        OpNode::String(_) => "string",
        OpNode::Array(_) => "array",
        OpNode::Object(_) => "object",
    };
    Ok(OpValue::string(type_str))
}

/// Check if a value is NaN.
pub fn is_nan(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let result = match a.node() {
        OpNode::Number(n) => n.is_nan(),
        _ => false,
    };
    Ok(OpValue::bool(result))
}

/// Check if a value is finite (not NaN, not Infinity).
pub fn is_finite(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let result = match a.node() {
        OpNode::Number(n) => n.is_finite(),
        _ => false,
    };
    Ok(OpValue::bool(result))
}

// OLD FUNCTIONS DELETED: is_number, is_null, is_bool, is_string, is_array, is_object
// Use type_of(value) instead and compare the result string

// ============================================================================
// Helper Functions
// ============================================================================

/// Convert a value to its string representation following Formula Engine semantics.
fn value_to_string(value: &OpValue) -> String {
    match value.node() {
        OpNode::Null => "null".to_string(),
        OpNode::Bool(b) => b.to_string(),
        OpNode::Number(n) => {
            // Handle integer-like floats (42.0 -> "42")
            if n.fract() == 0.0 && n.is_finite() && n.abs() < (i64::MAX as f64) {
                format!("{}", *n as i64)
            } else {
                n.to_string()
            }
        }
        OpNode::String(s) => s.to_string(),
        OpNode::Array(_) => "[Array]".to_string(),
        OpNode::Object(_) => "[Object]".to_string(),
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn strict() -> EvalContext {
        EvalContext::strict()
    }

    #[allow(dead_code)]
    fn fast() -> EvalContext {
        EvalContext::fast()
    }

    // --- to_number tests ---

    #[test]
    fn test_to_number_string() {
        let s = OpValue::from(json!("42"));
        let result = to_number(&s, &strict()).unwrap();
        assert_eq!(result.as_decimal("test").unwrap().to_string(), "42");
    }

    #[test]
    fn test_to_number_decimal_string() {
        let s = OpValue::from(json!("3.14"));
        let result = to_number(&s, &strict()).unwrap();
        assert_eq!(result.as_decimal("test").unwrap().to_string(), "3.14");
    }

    #[test]
    fn test_to_number_bool_true() {
        let b = OpValue::from(json!(true));
        let result = to_number(&b, &strict()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 1.0);
    }

    #[test]
    fn test_to_number_bool_false() {
        let b = OpValue::from(json!(false));
        let result = to_number(&b, &strict()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 0.0);
    }

    #[test]
    fn test_to_number_string_true() {
        let s = OpValue::from(json!("true"));
        let result = to_number(&s, &strict()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 1.0);
    }

    #[test]
    fn test_to_number_string_false() {
        let s = OpValue::from(json!("false"));
        let result = to_number(&s, &strict()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 0.0);
    }

    #[test]
    fn test_to_number_null() {
        let n = OpValue::null();
        let result = to_number(&n, &strict()).unwrap();
        assert!(result.is_null());
    }

    #[test]
    fn test_to_number_invalid_string() {
        let s = OpValue::from(json!("not a number"));
        let result = to_number(&s, &strict());
        assert!(matches!(result, Err(OpError::ConversionError { .. })));
    }

    #[test]
    fn test_to_number_array_error() {
        let arr = OpValue::from(json!([1, 2, 3]));
        let result = to_number(&arr, &strict());
        assert!(matches!(result, Err(OpError::TypeMismatch { .. })));
    }

    // --- to_string tests ---

    #[test]
    fn test_to_string_number() {
        let n = OpValue::from(json!(42));
        let result = to_string(&n, &strict()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "42");
    }

    #[test]
    fn test_to_string_float() {
        let n = OpValue::from(json!(42.0));
        let result = to_string(&n, &strict()).unwrap();
        // Integer-like floats should be formatted without decimal
        assert_eq!(result.as_str("test").unwrap(), "42");
    }

    #[test]
    fn test_to_string_float_with_decimal() {
        let n = OpValue::from(json!(3.14));
        let result = to_string(&n, &strict()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "3.14");
    }

    #[test]
    fn test_to_string_bool() {
        let t = OpValue::from(json!(true));
        let f = OpValue::from(json!(false));
        assert_eq!(
            to_string(&t, &strict()).unwrap().as_str("test").unwrap(),
            "true"
        );
        assert_eq!(
            to_string(&f, &strict()).unwrap().as_str("test").unwrap(),
            "false"
        );
    }

    #[test]
    fn test_to_string_null() {
        let n = OpValue::null();
        let result = to_string(&n, &strict()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "null");
    }

    #[test]
    fn test_to_string_array() {
        let arr = OpValue::from(json!([1, 2, 3]));
        let result = to_string(&arr, &strict()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "[Array]");
    }

    #[test]
    fn test_to_string_object() {
        let obj = OpValue::from(json!({"key": "value"}));
        let result = to_string(&obj, &strict()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "[Object]");
    }

    // --- to_bool tests ---

    #[test]
    fn test_to_bool_truthy() {
        assert!(to_bool(&OpValue::from(json!(1)), &strict())
            .unwrap()
            .is_truthy());
        assert!(to_bool(&OpValue::from(json!("hello")), &strict())
            .unwrap()
            .is_truthy());
        assert!(to_bool(&OpValue::from(json!(true)), &strict())
            .unwrap()
            .is_truthy());
        assert!(to_bool(&OpValue::from(json!([1])), &strict())
            .unwrap()
            .is_truthy());
    }

    #[test]
    fn test_to_bool_falsy() {
        assert!(!to_bool(&OpValue::from(json!(0)), &strict())
            .unwrap()
            .is_truthy());
        assert!(!to_bool(&OpValue::from(json!("")), &strict())
            .unwrap()
            .is_truthy());
        assert!(!to_bool(&OpValue::from(json!(false)), &strict())
            .unwrap()
            .is_truthy());
        assert!(!to_bool(&OpValue::null(), &strict()).unwrap().is_truthy());
        assert!(!to_bool(&OpValue::from(json!([])), &strict())
            .unwrap()
            .is_truthy());
    }

    // --- to_decimal tests ---

    #[test]
    fn test_to_decimal_format() {
        let n = OpValue::from(json!(3.14159));
        let digits = OpValue::from(json!(2));
        let result = to_decimal(&n, &digits, &strict()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "3.14");
    }

    #[test]
    fn test_to_decimal_null() {
        let n = OpValue::null();
        let digits = OpValue::from(json!(2));
        let result = to_decimal(&n, &digits, &strict()).unwrap();
        assert!(result.is_null());
    }

    // --- Type checking tests ---

    #[test]
    fn test_type_of() {
        let result = type_of(&OpValue::from(json!(42)), &strict()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "number");

        let result = type_of(&OpValue::from(json!("hello")), &strict()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "string");

        let result = type_of(&OpValue::from(json!(true)), &strict()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "bool");

        let result = type_of(&OpValue::null(), &strict()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "null");

        let result = type_of(&OpValue::from(json!([1, 2, 3])), &strict()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "array");

        let result = type_of(&OpValue::from(json!({"key": "value"})), &strict()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "object");
    }

    // --- to_float tests ---

    #[test]
    fn test_to_float() {
        let n = OpValue::from(json!(42));
        let result = to_float(&n, &strict()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 42.0);
    }

    #[test]
    fn test_to_float_null() {
        let n = OpValue::null();
        let result = to_float(&n, &strict()).unwrap();
        assert!(result.is_null());
    }
}
