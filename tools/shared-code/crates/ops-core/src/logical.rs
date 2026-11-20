//! Logical operators for ops-core
//!
//! This module implements logical operators with **tristate boolean semantics**
//! (true, false, null) that match SQL NULL handling and spreadsheet behavior.
//!
//! # Tristate Logic (CRITICAL)
//!
//! Unlike two-valued boolean logic, tristate logic propagates null:
//!
//! | a     | b     | and(a,b) | or(a,b) |
//! |-------|-------|----------|---------|
//! | true  | true  | true     | true    |
//! | true  | false | false    | true    |
//! | true  | null  | **null** | true    |
//! | false | true  | false    | true    |
//! | false | false | false    | false   |
//! | false | null  | false    | **null**|
//! | null  | true  | **null** | true    |
//! | null  | false | false    | **null**|
//! | null  | null  | **null** | **null**|
//!
//! The key insight: `and(true, null) = null` (NOT false!)
//! This matches Kleene's three-valued logic and SQL's NULL semantics.

use crate::value::OpNode;
use crate::{EvalContext, OpError, OpValue};
use std::sync::Arc;

// =============================================================================
// TRISTATE BOOLEAN OPERATORS
// =============================================================================

/// Logical AND with tristate boolean semantics.
///
/// CRITICAL: This implements tristate logic:
/// - and(true, true) = true
/// - and(false, anything) = false (short-circuit)
/// - and(true, null) = null (NOT false!)
/// - and(null, null) = null
pub fn and(a: &OpValue, b: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let left = a.as_bool_or_null("and")?;
    let right = b.as_bool_or_null("and")?;

    let result = match (left, right) {
        // Both true -> true
        (Some(true), Some(true)) => OpValue::bool(true),
        // Either false -> false (short-circuit)
        (Some(false), _) | (_, Some(false)) => OpValue::bool(false),
        // Otherwise (at least one null, no false) -> null
        _ => OpValue::null(),
    };

    Ok(result)
}

/// Variadic AND - all values must be true, short-circuits on false.
pub fn and_many(values: &[OpValue], _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let mut saw_null = false;

    for val in values {
        let b = val.as_bool_or_null("and")?;
        match b {
            Some(false) => return Ok(OpValue::bool(false)), // Short-circuit
            None => saw_null = true,
            Some(true) => {}
        }
    }

    if saw_null {
        Ok(OpValue::null())
    } else {
        Ok(OpValue::bool(true))
    }
}

/// Logical OR with tristate boolean semantics.
///
/// CRITICAL: This implements tristate logic:
/// - or(true, anything) = true (short-circuit)
/// - or(false, false) = false
/// - or(false, null) = null (NOT false!)
/// - or(null, null) = null
pub fn or(a: &OpValue, b: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let left = a.as_bool_or_null("or")?;
    let right = b.as_bool_or_null("or")?;

    let result = match (left, right) {
        // Either true -> true (short-circuit)
        (Some(true), _) | (_, Some(true)) => OpValue::bool(true),
        // Both false -> false
        (Some(false), Some(false)) => OpValue::bool(false),
        // Otherwise (at least one null, no true) -> null
        _ => OpValue::null(),
    };

    Ok(result)
}

/// Variadic OR - any value true returns true, short-circuits on true.
pub fn or_many(values: &[OpValue], _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let mut saw_null = false;

    for val in values {
        let b = val.as_bool_or_null("or")?;
        match b {
            Some(true) => return Ok(OpValue::bool(true)), // Short-circuit
            None => saw_null = true,
            Some(false) => {}
        }
    }

    if saw_null {
        Ok(OpValue::null())
    } else {
        Ok(OpValue::bool(false))
    }
}

/// Logical NOT with tristate semantics.
///
/// - not(true) = false
/// - not(false) = true
/// - not(null) = null (NOT false!)
pub fn not(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let val = a.as_bool_or_null("not")?;

    let result = match val {
        Some(b) => OpValue::bool(!b),
        None => OpValue::null(), // NOT(null) -> null
    };

    Ok(result)
}

/// Logical XOR (exclusive or) with tristate semantics.
///
/// - xor(true, false) = true
/// - xor(true, true) = false
/// - xor(false, false) = false
/// - xor(anything, null) = null
pub fn xor(a: &OpValue, b: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let left = a.as_bool_or_null("xor")?;
    let right = b.as_bool_or_null("xor")?;

    let result = match (left, right) {
        (Some(l), Some(r)) => OpValue::bool(l != r),
        _ => OpValue::null(), // Either null -> null
    };

    Ok(result)
}

// =============================================================================
// COMPARISON OPERATORS
// =============================================================================

/// Equality comparison with special semantics.
///
/// Special cases:
/// - Integer vs float: eq(0, 0.0) = true
/// - NaN equality: eq(NaN, NaN) = true (unlike IEEE 754)
/// - Null equality: eq(null, null) = true (matches SQL behavior for IS NOT DISTINCT FROM)
/// - String comparison is case-sensitive
pub fn eq(a: &OpValue, b: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    Ok(OpValue::bool(OpValue::are_equal(a, b)))
}

/// Not equal comparison.
///
/// ne(a, b) = not(eq(a, b))
pub fn ne(a: &OpValue, b: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    Ok(OpValue::bool(!OpValue::are_equal(a, b)))
}

/// Less than comparison.
///
/// Returns null if either operand is null.
/// Works for numbers and strings (lexicographic comparison).
pub fn lt(a: &OpValue, b: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    compare_values(a, b, "lt", |ord| ord == std::cmp::Ordering::Less)
}

/// Less than or equal comparison.
pub fn le(a: &OpValue, b: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    compare_values(a, b, "le", |ord| ord != std::cmp::Ordering::Greater)
}

/// Greater than comparison.
pub fn gt(a: &OpValue, b: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    compare_values(a, b, "gt", |ord| ord == std::cmp::Ordering::Greater)
}

/// Greater than or equal comparison.
pub fn ge(a: &OpValue, b: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    compare_values(a, b, "ge", |ord| ord != std::cmp::Ordering::Less)
}

/// Helper function for comparison operators.
fn compare_values<F>(a: &OpValue, b: &OpValue, op: &str, predicate: F) -> Result<OpValue, OpError>
where
    F: Fn(std::cmp::Ordering) -> bool,
{
    // Null handling: null compared to anything is null
    if a.is_null() || b.is_null() {
        return Ok(OpValue::null());
    }

    // Number comparison
    if a.is_number() && b.is_number() {
        let af = a.as_f64(op)?;
        let bf = b.as_f64(op)?;

        // NaN handling: NaN comparisons return false (except for equality)
        if af.is_nan() || bf.is_nan() {
            return Ok(OpValue::bool(false));
        }

        let ord = af.partial_cmp(&bf).unwrap_or(std::cmp::Ordering::Equal);
        return Ok(OpValue::bool(predicate(ord)));
    }

    // A number against text that spells a number (exact decimal text, as a strict answer too long for an f64 is):
    // compared as numbers, exactly.
    if a.is_number() != b.is_number() && (a.is_string() || b.is_string()) {
        if let (Ok(ad), Ok(bd)) = (a.as_decimal(op), b.as_decimal(op)) {
            return Ok(OpValue::bool(predicate(ad.cmp(&bd))));
        }
    }

    // String comparison (lexicographic)
    if a.is_string() && b.is_string() {
        let as_ = a.as_str(op)?;
        let bs = b.as_str(op)?;
        let ord = as_.cmp(bs);
        return Ok(OpValue::bool(predicate(ord)));
    }

    // Boolean comparison (false < true)
    if a.is_bool() && b.is_bool() {
        let ab = a.as_bool(op)?;
        let bb = b.as_bool(op)?;
        let ord = ab.cmp(&bb);
        return Ok(OpValue::bool(predicate(ord)));
    }

    // Type mismatch
    Err(OpError::TypeMismatch {
        operation: op.to_string(),
        expected: "comparable types (number, string, boolean)".to_string(),
        actual: format!("{} and {}", a.type_name(), b.type_name()),
    })
}

// =============================================================================
// CONDITIONAL OPERATORS
// =============================================================================

/// Conditional if-then-else.
///
/// if_then_else(condition, then_value, else_value)
///
/// The condition must be a strict boolean (not null).
/// Returns then_value if condition is true, else_value otherwise.
pub fn if_then_else(
    condition: &OpValue,
    then_val: &OpValue,
    else_val: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    let cond = condition.as_bool("if")?;

    if cond {
        Ok(then_val.clone())
    } else {
        Ok(else_val.clone())
    }
}

/// Coalesce - returns the first non-null value.
///
/// coalesce([null, null, "first", "second"]) = "first"
/// coalesce([null, null]) = null
pub fn coalesce(values: &[OpValue], _ctx: &EvalContext) -> Result<OpValue, OpError> {
    for val in values {
        if !val.is_null() {
            return Ok(val.clone());
        }
    }
    Ok(OpValue::null())
}

// =============================================================================
// NULL CHECKS
// =============================================================================

/// Check if a value is null.
///
/// is_null(null) = true
/// is_null(anything_else) = false
pub fn is_null(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    Ok(OpValue::bool(a.is_null()))
}

/// Check if a value is not null.
///
/// is_not_null(null) = false
/// is_not_null(anything_else) = true
pub fn is_not_null(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    Ok(OpValue::bool(!a.is_null()))
}

/// If null - returns value if not null, otherwise returns fallback.
///
/// if_null(null, fallback) = fallback
/// if_null(value, fallback) = value
///
/// This is essential for transform pipelines where the selection may return null
/// but transforms need a concrete value to operate on.
pub fn if_null(
    value: &OpValue,
    fallback: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    if value.is_null() {
        Ok(fallback.clone())
    } else {
        Ok(value.clone())
    }
}

/// Check if a value is "empty" (falsy).
///
/// is_empty considers these values empty:
/// - null
/// - false
/// - 0 (and 0.0)
/// - "" (empty string)
/// - [] (empty array)
/// - {} (empty object)
pub fn is_empty(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    Ok(OpValue::bool(!a.is_truthy()))
}

// =============================================================================
// SWITCH / ERROR HANDLING
// =============================================================================

/// Switch/case expression - multi-way branch.
///
/// switch(value, case1, result1, case2, result2, ..., [default])
///
/// Compares `value` against each case, returning the corresponding result
/// for the first match. If no match is found, returns the default value
/// (or null if no default provided).
///
/// # Arguments
/// - `switch_value` - The value to match against
/// - `cases` - Pairs of (case, result) values, optionally followed by a default
///
/// # Example
/// ```ignore
/// switch(status, "active", 1, "pending", 2, "unknown", 0)
/// // If status == "active", returns 1
/// // If status == "pending", returns 2
/// // Otherwise, returns 0 (the default)
/// ```
pub fn switch(
    switch_value: &OpValue,
    cases: &[OpValue],
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    if cases.is_empty() {
        return Ok(OpValue::null());
    }

    // If switch value is null, return default or null
    if switch_value.is_null() {
        // Check if we have a default (odd number of cases means default exists)
        if cases.len() % 2 == 1 {
            return Ok(cases[cases.len() - 1].clone());
        }
        return Ok(OpValue::null());
    }

    // Check each case pair
    let mut i = 0;
    while i + 1 < cases.len() {
        let case_val = &cases[i];
        if OpValue::are_equal(switch_value, case_val) {
            // Found matching case, return corresponding result
            return Ok(cases[i + 1].clone());
        }
        i += 2;
    }

    // No match found, check for default
    if i < cases.len() {
        // We have a default value
        Ok(cases[i].clone())
    } else {
        Ok(OpValue::null())
    }
}

/// If-error - returns fallback if the try_result indicates an error.
///
/// In ops-core, values are already computed, so this function checks for
/// error marker objects with shape: `{"$error": "message"}`.
///
/// For regular values, returns the value as-is.
/// For error markers, returns the fallback.
///
/// # Note
/// In formula-engine, this catches evaluation errors. In ops-core,
/// since values are pre-computed, we use error marker convention.
pub fn if_error(
    try_value: &OpValue,
    fallback: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    // Check if try_value is an error marker object
    if let OpNode::Object(obj) = try_value.node() {
        let error_key = Arc::from("$error");
        if obj.contains_key(&error_key) {
            return Ok(fallback.clone());
        }
    }

    // Not an error, return the value
    Ok(try_value.clone())
}

/// Try - returns the value or null if it's an error.
///
/// In ops-core, values are already computed, so this function checks for
/// error marker objects with shape: `{"$error": "message"}`.
///
/// For regular values, returns the value as-is.
/// For error markers, returns null.
///
/// # Note
/// In formula-engine, this catches evaluation errors. In ops-core,
/// since values are pre-computed, we use error marker convention.
pub fn try_eval(value: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    // Check if value is an error marker object
    if let OpNode::Object(obj) = value.node() {
        let error_key = Arc::from("$error");
        if obj.contains_key(&error_key) {
            return Ok(OpValue::null());
        }
    }

    // Not an error, return the value
    Ok(value.clone())
}

// =============================================================================
// TESTS
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strict_answers_are_numbers_and_compare_as_numbers() {
        let strict = EvalContext::strict();
        let six = crate::math::mul(&OpValue::number(2.0), &OpValue::number(3.0), &strict).unwrap();
        assert_eq!(six.as_inner(), json!(6));
        let ten = crate::math::add(&OpValue::number(4.0), &OpValue::number(6.0), &strict).unwrap();
        assert_eq!(gt(&six, &ten, &strict).unwrap().as_inner(), json!(false));
        let tenths = crate::math::add(&OpValue::number(0.1), &OpValue::number(0.2), &strict).unwrap();
        assert_eq!(tenths.as_inner(), json!(0.3));
        let half = crate::math::div(&OpValue::number(7.0), &OpValue::number(2.0), &strict).unwrap();
        assert_eq!(half.as_inner(), json!(3.5));
        // More digits than an f64 keeps stay exact decimal text, and still compare with a number as numbers.
        let long = OpValue::from_decimal(rust_decimal::Decimal::from_str_exact("0.1234567890123456789").unwrap());
        assert_eq!(long.as_inner(), json!("0.1234567890123456789"));
        assert_eq!(gt(&long, &OpValue::number(0.12), &strict).unwrap().as_inner(), json!(true));
        assert_eq!(lt(&OpValue::number(0.2), &long, &strict).unwrap().as_inner(), json!(false));
        // Two texts still compare by spelling, and text that is not a number is still refused against one.
        assert_eq!(gt(&OpValue::string("b"), &OpValue::string("a"), &strict).unwrap().as_inner(), json!(true));
        assert!(gt(&OpValue::string("tennis"), &OpValue::number(1.0), &strict).is_err());
    }

    fn ctx() -> EvalContext {
        EvalContext::default()
    }

    // --- AND Tests ---

    #[test]
    fn test_and_true_true() {
        let result = and(&OpValue::bool(true), &OpValue::bool(true), &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(true));
    }

    #[test]
    fn test_and_true_false() {
        let result = and(&OpValue::bool(true), &OpValue::bool(false), &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(false));
    }

    #[test]
    fn test_and_true_null_is_null() {
        // CRITICAL: This is the tristate test!
        let result = and(&OpValue::bool(true), &OpValue::null(), &ctx()).unwrap();
        assert!(result.is_null(), "and(true, null) must be null, not false!");
    }

    #[test]
    fn test_and_false_null_is_false() {
        let result = and(&OpValue::bool(false), &OpValue::null(), &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(false));
    }

    #[test]
    fn test_and_null_null_is_null() {
        let result = and(&OpValue::null(), &OpValue::null(), &ctx()).unwrap();
        assert!(result.is_null());
    }

    // --- OR Tests ---

    #[test]
    fn test_or_false_false() {
        let result = or(&OpValue::bool(false), &OpValue::bool(false), &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(false));
    }

    #[test]
    fn test_or_true_null_is_true() {
        let result = or(&OpValue::bool(true), &OpValue::null(), &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(true));
    }

    #[test]
    fn test_or_false_null_is_null() {
        // CRITICAL: This is the tristate test!
        let result = or(&OpValue::bool(false), &OpValue::null(), &ctx()).unwrap();
        assert!(result.is_null(), "or(false, null) must be null, not false!");
    }

    #[test]
    fn test_or_null_null_is_null() {
        let result = or(&OpValue::null(), &OpValue::null(), &ctx()).unwrap();
        assert!(result.is_null());
    }

    // --- NOT Tests ---

    #[test]
    fn test_not_true() {
        let result = not(&OpValue::bool(true), &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(false));
    }

    #[test]
    fn test_not_false() {
        let result = not(&OpValue::bool(false), &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(true));
    }

    #[test]
    fn test_not_null_is_null() {
        let result = not(&OpValue::null(), &ctx()).unwrap();
        assert!(result.is_null(), "not(null) must be null!");
    }

    // --- Equality Tests ---

    #[test]
    fn test_eq_integer_vs_float() {
        let int_zero = OpValue::from(json!(0));
        let float_zero = OpValue::number(0.0);
        let result = eq(&int_zero, &float_zero, &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(true));
    }

    #[test]
    fn test_eq_strings() {
        let result = eq(&OpValue::string("a"), &OpValue::string("a"), &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(true));

        let result = eq(&OpValue::string("a"), &OpValue::string("A"), &ctx()).unwrap();
        assert_eq!(
            result,
            OpValue::bool(false),
            "String comparison should be case-sensitive"
        );
    }

    #[test]
    fn test_eq_null_null() {
        let result = eq(&OpValue::null(), &OpValue::null(), &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(true));
    }

    // --- Comparison Tests ---

    #[test]
    fn test_lt_numbers() {
        let result = lt(&OpValue::number(1.0), &OpValue::number(2.0), &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(true));

        let result = lt(&OpValue::number(2.0), &OpValue::number(1.0), &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(false));
    }

    #[test]
    fn test_lt_with_null() {
        let result = lt(&OpValue::number(1.0), &OpValue::null(), &ctx()).unwrap();
        assert!(result.is_null());
    }

    // --- Conditional Tests ---

    #[test]
    fn test_if_then_else_true() {
        let result = if_then_else(
            &OpValue::bool(true),
            &OpValue::string("yes"),
            &OpValue::string("no"),
            &ctx(),
        )
        .unwrap();
        assert_eq!(result, OpValue::string("yes"));
    }

    #[test]
    fn test_if_then_else_false() {
        let result = if_then_else(
            &OpValue::bool(false),
            &OpValue::string("yes"),
            &OpValue::string("no"),
            &ctx(),
        )
        .unwrap();
        assert_eq!(result, OpValue::string("no"));
    }

    // --- Coalesce Tests ---

    #[test]
    fn test_coalesce_first_non_null() {
        let values = vec![
            OpValue::null(),
            OpValue::null(),
            OpValue::string("first"),
            OpValue::string("second"),
        ];
        let result = coalesce(&values, &ctx()).unwrap();
        assert_eq!(result, OpValue::string("first"));
    }

    #[test]
    fn test_coalesce_all_null() {
        let values = vec![OpValue::null(), OpValue::null()];
        let result = coalesce(&values, &ctx()).unwrap();
        assert!(result.is_null());
    }

    // --- Null Check Tests ---

    #[test]
    fn test_is_null() {
        let result = is_null(&OpValue::null(), &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(true));

        let result = is_null(&OpValue::number(0.0), &ctx()).unwrap();
        assert_eq!(result, OpValue::bool(false));
    }

    #[test]
    fn test_is_empty() {
        assert_eq!(
            is_empty(&OpValue::null(), &ctx()).unwrap(),
            OpValue::bool(true)
        );
        assert_eq!(
            is_empty(&OpValue::bool(false), &ctx()).unwrap(),
            OpValue::bool(true)
        );
        assert_eq!(
            is_empty(&OpValue::number(0.0), &ctx()).unwrap(),
            OpValue::bool(true)
        );
        assert_eq!(
            is_empty(&OpValue::string(""), &ctx()).unwrap(),
            OpValue::bool(true)
        );
        assert_eq!(
            is_empty(&OpValue::array(vec![]), &ctx()).unwrap(),
            OpValue::bool(true)
        );

        assert_eq!(
            is_empty(&OpValue::bool(true), &ctx()).unwrap(),
            OpValue::bool(false)
        );
        assert_eq!(
            is_empty(&OpValue::number(1.0), &ctx()).unwrap(),
            OpValue::bool(false)
        );
        assert_eq!(
            is_empty(&OpValue::string("x"), &ctx()).unwrap(),
            OpValue::bool(false)
        );
    }

    // --- XOR Tests ---

    #[test]
    fn test_xor() {
        assert_eq!(
            xor(&OpValue::bool(true), &OpValue::bool(false), &ctx()).unwrap(),
            OpValue::bool(true)
        );
        assert_eq!(
            xor(&OpValue::bool(true), &OpValue::bool(true), &ctx()).unwrap(),
            OpValue::bool(false)
        );
        assert_eq!(
            xor(&OpValue::bool(false), &OpValue::bool(false), &ctx()).unwrap(),
            OpValue::bool(false)
        );
        assert!(xor(&OpValue::bool(true), &OpValue::null(), &ctx())
            .unwrap()
            .is_null());
    }

    // --- Switch Tests ---

    #[test]
    fn test_switch_match_first() {
        let cases = vec![
            OpValue::string("a"),
            OpValue::number(1.0),
            OpValue::string("b"),
            OpValue::number(2.0),
            OpValue::number(0.0), // default
        ];
        let result = switch(&OpValue::string("a"), &cases, &ctx()).unwrap();
        assert_eq!(result, OpValue::number(1.0));
    }

    #[test]
    fn test_switch_match_second() {
        let cases = vec![
            OpValue::string("a"),
            OpValue::number(1.0),
            OpValue::string("b"),
            OpValue::number(2.0),
            OpValue::number(0.0), // default
        ];
        let result = switch(&OpValue::string("b"), &cases, &ctx()).unwrap();
        assert_eq!(result, OpValue::number(2.0));
    }

    #[test]
    fn test_switch_no_match_uses_default() {
        let cases = vec![
            OpValue::string("a"),
            OpValue::number(1.0),
            OpValue::string("b"),
            OpValue::number(2.0),
            OpValue::number(99.0), // default
        ];
        let result = switch(&OpValue::string("c"), &cases, &ctx()).unwrap();
        assert_eq!(result, OpValue::number(99.0));
    }

    #[test]
    fn test_switch_no_match_no_default() {
        let cases = vec![
            OpValue::string("a"),
            OpValue::number(1.0),
            OpValue::string("b"),
            OpValue::number(2.0),
        ];
        let result = switch(&OpValue::string("c"), &cases, &ctx()).unwrap();
        assert!(result.is_null());
    }

    #[test]
    fn test_switch_null_value() {
        let cases = vec![
            OpValue::string("a"),
            OpValue::number(1.0),
            OpValue::number(99.0), // default
        ];
        let result = switch(&OpValue::null(), &cases, &ctx()).unwrap();
        assert_eq!(result, OpValue::number(99.0));
    }

    // --- If Error Tests ---

    #[test]
    fn test_if_error_no_error() {
        let result = if_error(
            &OpValue::string("valid"),
            &OpValue::string("fallback"),
            &ctx(),
        )
        .unwrap();
        assert_eq!(result, OpValue::string("valid"));
    }

    #[test]
    fn test_if_error_with_error_marker() {
        let mut obj = serde_json::Map::new();
        obj.insert("$error".to_string(), json!("something went wrong"));
        let error_val = OpValue::object(obj);

        let result = if_error(&error_val, &OpValue::string("fallback"), &ctx()).unwrap();
        assert_eq!(result, OpValue::string("fallback"));
    }

    // --- Try Eval Tests ---

    #[test]
    fn test_try_eval_no_error() {
        let result = try_eval(&OpValue::number(42.0), &ctx()).unwrap();
        assert_eq!(result, OpValue::number(42.0));
    }

    #[test]
    fn test_try_eval_with_error_marker() {
        let mut obj = serde_json::Map::new();
        obj.insert("$error".to_string(), json!("something went wrong"));
        let error_val = OpValue::object(obj);

        let result = try_eval(&error_val, &ctx()).unwrap();
        assert!(result.is_null());
    }
}
