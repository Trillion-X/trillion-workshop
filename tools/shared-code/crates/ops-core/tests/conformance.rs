//! Conformance Test Suite for ops-core
//!
//! This test suite verifies that ops-core produces the expected results for all
//! supported operators. Since composition-engine now delegates to ops-core via
//! shims, proving ops-core correctness ensures both engines produce identical results.
//!
//! # Test Categories
//!
//! 1. **Math Conformance** - Arithmetic with FloatMode (Strict/Fast)
//! 2. **Logical Conformance** - Tristate boolean logic
//! 3. **Text Conformance** - String operations
//! 4. **Array Conformance** - Array operations
//! 5. **Edge Cases** - Null propagation, error handling, special values
//!
//! # Float Mode Tests
//!
//! - **Strict Mode**: Uses rust_decimal, `0.1 + 0.2 = 0.3` (exact)
//! - **Fast Mode**: Uses f64, `0.1 + 0.2 = 0.30000000000000004` (IEEE 754)

use ops_core::{EvalContext, FloatMode, OpError, OpValue};
use serde_json::json;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

fn strict_ctx() -> EvalContext {
    EvalContext::new(FloatMode::Strict)
}

fn fast_ctx() -> EvalContext {
    EvalContext::new(FloatMode::Fast)
}

fn val(v: serde_json::Value) -> OpValue {
    OpValue::from(v)
}

// =============================================================================
// MATH CONFORMANCE TESTS
// =============================================================================

mod math_conformance {
    use super::*;
    use ops_core::math;

    #[test]
    fn test_add_integers_strict() {
        let a = val(json!(1));
        let b = val(json!(2));
        let result = math::add(&a, &b, &strict_ctx()).unwrap();
        // In strict mode, result is a Decimal which serializes to string "3"
        let d = result.as_decimal("test").unwrap();
        assert_eq!(d.to_string(), "3", "add(1, 2) should equal 3");
    }

    #[test]
    fn test_add_decimal_precision_strict() {
        // This is THE critical test: 0.1 + 0.2 = 0.3 in Strict mode
        let a = val(json!(0.1));
        let b = val(json!(0.2));
        let result = math::add(&a, &b, &strict_ctx()).unwrap();
        // Decimal is stored as string "0.3" in JSON
        let d = result.as_decimal("test").unwrap();
        assert_eq!(
            d.to_string(),
            "0.3",
            "Strict mode: 0.1 + 0.2 should be exactly 0.3"
        );
    }

    #[test]
    fn test_add_decimal_precision_fast() {
        // In Fast mode, 0.1 + 0.2 = 0.30000000000000004 (IEEE 754)
        let a = val(json!(0.1));
        let b = val(json!(0.2));
        let result = math::add(&a, &b, &fast_ctx()).unwrap();
        let f = result.as_f64("test").unwrap();
        // This is the classic IEEE 754 result
        assert!(
            (f - 0.30000000000000004).abs() < 1e-15,
            "Fast mode: 0.1 + 0.2 should be ~0.30000000000000004, got {}",
            f
        );
    }

    #[test]
    fn test_sub_integers() {
        let a = val(json!(5));
        let b = val(json!(3));
        let result = math::sub(&a, &b, &strict_ctx()).unwrap();
        let d = result.as_decimal("test").unwrap();
        assert_eq!(d.to_string(), "2", "sub(5, 3) should equal 2");
    }

    #[test]
    fn test_mul_integers() {
        let a = val(json!(3));
        let b = val(json!(4));
        let result = math::mul(&a, &b, &strict_ctx()).unwrap();
        let d = result.as_decimal("test").unwrap();
        assert_eq!(d.to_string(), "12", "mul(3, 4) should equal 12");
    }

    #[test]
    fn test_div_integers() {
        let a = val(json!(10));
        let b = val(json!(2));
        let result = math::div(&a, &b, &strict_ctx()).unwrap();
        let d = result.as_decimal("test").unwrap();
        assert_eq!(d.to_string(), "5", "div(10, 2) should equal 5");
    }

    #[test]
    fn test_div_by_zero_error() {
        let a = val(json!(1));
        let b = val(json!(0));
        let result = math::div(&a, &b, &strict_ctx());
        assert!(result.is_err(), "div(1, 0) should return an error");
        match result {
            Err(OpError::DivisionByZero { .. }) => {}
            _ => panic!("Expected DivisionByZero error"),
        }
    }

    #[test]
    fn test_add_null_propagation_left() {
        let a = val(json!(null));
        let b = val(json!(2));
        let result = math::add(&a, &b, &strict_ctx()).unwrap();
        assert!(result.is_null(), "add(null, 2) should be null");
    }

    #[test]
    fn test_add_null_propagation_right() {
        let a = val(json!(1));
        let b = val(json!(null));
        let result = math::add(&a, &b, &strict_ctx()).unwrap();
        assert!(result.is_null(), "add(1, null) should be null");
    }

    #[test]
    fn test_add_negative_numbers() {
        let a = val(json!(-5));
        let b = val(json!(3));
        let result = math::add(&a, &b, &strict_ctx()).unwrap();
        let d = result.as_decimal("test").unwrap();
        assert_eq!(d.to_string(), "-2", "add(-5, 3) should equal -2");
    }
}

// =============================================================================
// LOGICAL CONFORMANCE TESTS - TRISTATE BOOLEAN
// =============================================================================

mod logical_conformance {
    use super::*;
    use ops_core::logical;

    #[test]
    fn test_and_true_true() {
        let a = val(json!(true));
        let b = val(json!(true));
        let result = logical::and(&a, &b, &strict_ctx()).unwrap();
        assert_eq!(
            result.as_inner(),
            json!(true),
            "and(true, true) should be true"
        );
    }

    #[test]
    fn test_and_true_false() {
        let a = val(json!(true));
        let b = val(json!(false));
        let result = logical::and(&a, &b, &strict_ctx()).unwrap();
        assert_eq!(
            result.as_inner(),
            json!(false),
            "and(true, false) should be false"
        );
    }

    #[test]
    fn test_and_false_anything() {
        // Short-circuit: false AND anything = false
        let a = val(json!(false));
        let b = val(json!(true));
        let result = logical::and(&a, &b, &strict_ctx()).unwrap();
        assert_eq!(
            result.as_inner(),
            json!(false),
            "and(false, true) should be false"
        );
    }

    #[test]
    fn test_and_true_null_tristate() {
        // CRITICAL TRISTATE TEST: and(true, null) = null, NOT false!
        let a = val(json!(true));
        let b = val(json!(null));
        let result = logical::and(&a, &b, &strict_ctx()).unwrap();
        assert!(
            result.is_null(),
            "TRISTATE: and(true, null) should be null, not false!"
        );
    }

    #[test]
    fn test_and_null_true_tristate() {
        // CRITICAL TRISTATE TEST: and(null, true) = null
        let a = val(json!(null));
        let b = val(json!(true));
        let result = logical::and(&a, &b, &strict_ctx()).unwrap();
        assert!(result.is_null(), "TRISTATE: and(null, true) should be null");
    }

    #[test]
    fn test_and_false_null() {
        // Short-circuit: false AND null = false
        let a = val(json!(false));
        let b = val(json!(null));
        let result = logical::and(&a, &b, &strict_ctx()).unwrap();
        assert_eq!(
            result.as_inner(),
            json!(false),
            "and(false, null) should be false"
        );
    }

    #[test]
    fn test_or_true_anything() {
        // Short-circuit: true OR anything = true
        let a = val(json!(true));
        let b = val(json!(false));
        let result = logical::or(&a, &b, &strict_ctx()).unwrap();
        assert_eq!(
            result.as_inner(),
            json!(true),
            "or(true, false) should be true"
        );
    }

    #[test]
    fn test_or_false_false() {
        let a = val(json!(false));
        let b = val(json!(false));
        let result = logical::or(&a, &b, &strict_ctx()).unwrap();
        assert_eq!(
            result.as_inner(),
            json!(false),
            "or(false, false) should be false"
        );
    }

    #[test]
    fn test_or_false_null_tristate() {
        // CRITICAL TRISTATE TEST: or(false, null) = null, NOT false!
        let a = val(json!(false));
        let b = val(json!(null));
        let result = logical::or(&a, &b, &strict_ctx()).unwrap();
        assert!(
            result.is_null(),
            "TRISTATE: or(false, null) should be null, not false!"
        );
    }

    #[test]
    fn test_or_null_false_tristate() {
        // CRITICAL TRISTATE TEST: or(null, false) = null
        let a = val(json!(null));
        let b = val(json!(false));
        let result = logical::or(&a, &b, &strict_ctx()).unwrap();
        assert!(result.is_null(), "TRISTATE: or(null, false) should be null");
    }

    #[test]
    fn test_not_true() {
        let a = val(json!(true));
        let result = logical::not(&a, &strict_ctx()).unwrap();
        assert_eq!(result.as_inner(), json!(false), "not(true) should be false");
    }

    #[test]
    fn test_not_false() {
        let a = val(json!(false));
        let result = logical::not(&a, &strict_ctx()).unwrap();
        assert_eq!(result.as_inner(), json!(true), "not(false) should be true");
    }

    #[test]
    fn test_not_null_tristate() {
        // TRISTATE: not(null) = null
        let a = val(json!(null));
        let result = logical::not(&a, &strict_ctx()).unwrap();
        assert!(result.is_null(), "TRISTATE: not(null) should be null");
    }
}

// =============================================================================
// EQUALITY CONFORMANCE TESTS
// =============================================================================

mod equality_conformance {
    use super::*;
    use ops_core::logical;

    #[test]
    fn test_eq_string_string() {
        let a = val(json!("a"));
        let b = val(json!("a"));
        let result = logical::eq(&a, &b, &strict_ctx()).unwrap();
        assert_eq!(
            result.as_inner(),
            json!(true),
            "eq('a', 'a') should be true"
        );
    }

    #[test]
    fn test_eq_string_different() {
        let a = val(json!("a"));
        let b = val(json!("b"));
        let result = logical::eq(&a, &b, &strict_ctx()).unwrap();
        assert_eq!(
            result.as_inner(),
            json!(false),
            "eq('a', 'b') should be false"
        );
    }

    #[test]
    fn test_eq_integer_vs_float() {
        // Integer 0 should equal float 0.0
        let a = val(json!(0));
        let b = val(json!(0.0));
        let result = logical::eq(&a, &b, &strict_ctx()).unwrap();
        assert_eq!(result.as_inner(), json!(true), "eq(0, 0.0) should be true");
    }

    #[test]
    fn test_eq_number_vs_number() {
        let a = val(json!(42));
        let b = val(json!(42));
        let result = logical::eq(&a, &b, &strict_ctx()).unwrap();
        assert_eq!(result.as_inner(), json!(true), "eq(42, 42) should be true");
    }

    #[test]
    fn test_ne_different_values() {
        let a = val(json!(1));
        let b = val(json!(2));
        let result = logical::ne(&a, &b, &strict_ctx()).unwrap();
        assert_eq!(result.as_inner(), json!(true), "ne(1, 2) should be true");
    }
}

// =============================================================================
// TEXT CONFORMANCE TESTS
// =============================================================================

mod text_conformance {
    use super::*;
    use ops_core::text;

    #[test]
    fn test_concat_strings() {
        let a = val(json!("a"));
        let b = val(json!("b"));
        let result = text::concat(&a, &b, &strict_ctx()).unwrap();
        assert_eq!(
            result.as_inner(),
            json!("ab"),
            "concat('a', 'b') should be 'ab'"
        );
    }

    #[test]
    fn test_concat_null_propagation() {
        let a = val(json!("a"));
        let b = val(json!(null));
        let result = text::concat(&a, &b, &strict_ctx()).unwrap();
        assert!(result.is_null(), "concat('a', null) should be null");
    }

    #[test]
    fn test_upper() {
        let a = val(json!("hello"));
        let result = text::upper(&a, &strict_ctx()).unwrap();
        assert_eq!(
            result.as_inner(),
            json!("HELLO"),
            "upper('hello') should be 'HELLO'"
        );
    }

    #[test]
    fn test_upper_null() {
        let a = val(json!(null));
        let result = text::upper(&a, &strict_ctx()).unwrap();
        assert!(result.is_null(), "upper(null) should be null");
    }

    #[test]
    fn test_lower() {
        let a = val(json!("WORLD"));
        let result = text::lower(&a, &strict_ctx()).unwrap();
        assert_eq!(
            result.as_inner(),
            json!("world"),
            "lower('WORLD') should be 'world'"
        );
    }

    #[test]
    fn test_lower_null() {
        let a = val(json!(null));
        let result = text::lower(&a, &strict_ctx()).unwrap();
        assert!(result.is_null(), "lower(null) should be null");
    }

    #[test]
    fn test_trim() {
        let a = val(json!("  hello  "));
        let result = text::trim(&a, &strict_ctx()).unwrap();
        assert_eq!(
            result.as_inner(),
            json!("hello"),
            "trim('  hello  ') should be 'hello'"
        );
    }
}

// =============================================================================
// ARRAY CONFORMANCE TESTS
// =============================================================================

mod array_conformance {
    use super::*;
    use ops_core::array;

    #[test]
    fn test_length_array() {
        let a = val(json!([1, 2, 3]));
        let result = array::length(&a, &strict_ctx()).unwrap();
        assert_eq!(
            result.as_f64("test").unwrap(),
            3.0,
            "length([1,2,3]) should be 3"
        );
    }

    #[test]
    fn test_length_empty_array() {
        let a = val(json!([]));
        let result = array::length(&a, &strict_ctx()).unwrap();
        assert_eq!(
            result.as_f64("test").unwrap(),
            0.0,
            "length([]) should be 0"
        );
    }

    #[test]
    fn test_length_null_returns_zero() {
        // Note: length(null) = 0 (like Excel, NOT null)
        let a = val(json!(null));
        let result = array::length(&a, &strict_ctx()).unwrap();
        assert_eq!(
            result.as_f64("test").unwrap(),
            0.0,
            "length(null) should be 0 (Excel behavior)"
        );
    }

    #[test]
    fn test_first() {
        let a = val(json!([1, 2, 3]));
        let result = array::first(&a, &strict_ctx()).unwrap();
        assert_eq!(
            result.as_inner().as_i64().unwrap(),
            1,
            "first([1,2,3]) should be 1"
        );
    }

    #[test]
    fn test_first_empty_array() {
        let a = val(json!([]));
        let result = array::first(&a, &strict_ctx()).unwrap();
        assert!(result.is_null(), "first([]) should be null");
    }

    #[test]
    fn test_last() {
        let a = val(json!([1, 2, 3]));
        let result = array::last(&a, &strict_ctx()).unwrap();
        assert_eq!(
            result.as_inner().as_i64().unwrap(),
            3,
            "last([1,2,3]) should be 3"
        );
    }
}

// =============================================================================
// EDGE CASE TESTS
// =============================================================================

mod edge_cases {
    use super::*;

    #[test]
    fn test_opvalue_truthiness_null() {
        let v = val(json!(null));
        assert!(!v.is_truthy(), "null should be falsy");
    }

    #[test]
    fn test_opvalue_truthiness_zero() {
        let v = val(json!(0));
        assert!(!v.is_truthy(), "0 should be falsy");
    }

    #[test]
    fn test_opvalue_truthiness_zero_float() {
        let v = val(json!(0.0));
        assert!(!v.is_truthy(), "0.0 should be falsy");
    }

    #[test]
    fn test_opvalue_truthiness_empty_string() {
        let v = val(json!(""));
        assert!(!v.is_truthy(), "empty string should be falsy");
    }

    #[test]
    fn test_opvalue_truthiness_empty_array() {
        let v = val(json!([]));
        assert!(!v.is_truthy(), "empty array should be falsy");
    }

    #[test]
    fn test_opvalue_truthiness_empty_object() {
        let v = val(json!({}));
        assert!(!v.is_truthy(), "empty object should be falsy");
    }

    #[test]
    fn test_opvalue_truthiness_truthy_number() {
        let v = val(json!(1));
        assert!(v.is_truthy(), "1 should be truthy");
    }

    #[test]
    fn test_opvalue_truthiness_truthy_string() {
        let v = val(json!("hello"));
        assert!(v.is_truthy(), "'hello' should be truthy");
    }

    #[test]
    fn test_opvalue_equality_nan() {
        // In ops-core semantics, NaN == NaN (unlike IEEE 754)
        let nan1 = OpValue::number(f64::NAN);
        let nan2 = OpValue::number(f64::NAN);
        assert!(
            OpValue::are_equal(&nan1, &nan2),
            "NaN == NaN should be true in ops-core"
        );
    }

    #[test]
    fn test_eval_context_default_is_strict() {
        let ctx = EvalContext::default();
        assert_eq!(
            ctx.float_mode,
            FloatMode::Strict,
            "Default FloatMode should be Strict"
        );
    }

    #[test]
    fn test_float_mode_strict() {
        let ctx = EvalContext::strict();
        assert_eq!(ctx.float_mode, FloatMode::Strict);
    }

    #[test]
    fn test_float_mode_fast() {
        let ctx = EvalContext::fast();
        assert_eq!(ctx.float_mode, FloatMode::Fast);
    }
}
