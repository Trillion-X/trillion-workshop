//! Math operators for the Architect Platform
//!
//! This module provides pure functions for mathematical operations,
//! extracted from the formula-engine's RewriteRule implementations.
//!
//! # Float Mode Handling
//!
//! - **Strict mode** (rust_decimal): Used for add, sub, mul, div, sum, average, round
//!   - Financial-grade precision: `0.1 + 0.2 = 0.3` (exact)
//!   - Uses Banker's rounding (MidpointNearestEven)
//!
//! - **Fast mode** (f64): Used for all arithmetic in Fast mode, and always for scientific functions
//!   - IEEE 754 behavior: `0.1 + 0.2 = 0.30000000000000004`
//!
//! # Null Propagation
//!
//! All binary and unary operators propagate null: `add(x, null) = null`
//! Aggregators (sum, average, etc.) skip nulls in arrays.

use crate::{EvalContext, FloatMode, OpError, OpValue};
use rust_decimal::prelude::*;
use std::sync::Arc;

// ============================================================================
// Binary Arithmetic Operators
// ============================================================================

/// Add two values together.
///
/// In Strict mode: Uses rust_decimal for financial-grade precision.
/// In Fast mode: Uses f64 for performance.
///
/// Null propagation: `add(x, null) = null`
pub fn add(a: &OpValue, b: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() || b.is_null() {
        return Ok(OpValue::null());
    }

    match ctx.float_mode {
        FloatMode::Strict => {
            let left = a.as_decimal("add")?;
            let right = b.as_decimal("add")?;
            let result = left
                .checked_add(right)
                .ok_or_else(|| OpError::NumericOverflow {
                    operation: "add".to_string(),
                    details: "decimal addition overflow".to_string(),
                })?;
            Ok(OpValue::from_decimal(result))
        }
        FloatMode::Fast => {
            let left = a.as_f64("add")?;
            let right = b.as_f64("add")?;
            Ok(OpValue::number(left + right))
        }
    }
}

/// Subtract two values.
///
/// In Strict mode: Uses rust_decimal for financial-grade precision.
/// In Fast mode: Uses f64 for performance.
///
/// Null propagation: `sub(x, null) = null`
pub fn sub(a: &OpValue, b: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() || b.is_null() {
        return Ok(OpValue::null());
    }

    match ctx.float_mode {
        FloatMode::Strict => {
            let left = a.as_decimal("sub")?;
            let right = b.as_decimal("sub")?;
            let result = left
                .checked_sub(right)
                .ok_or_else(|| OpError::NumericOverflow {
                    operation: "sub".to_string(),
                    details: "decimal subtraction overflow".to_string(),
                })?;
            Ok(OpValue::from_decimal(result))
        }
        FloatMode::Fast => {
            let left = a.as_f64("sub")?;
            let right = b.as_f64("sub")?;
            Ok(OpValue::number(left - right))
        }
    }
}

/// Multiply two values.
///
/// In Strict mode: Uses rust_decimal for financial-grade precision.
/// In Fast mode: Uses f64 for performance.
///
/// Null propagation: `mul(x, null) = null`
pub fn mul(a: &OpValue, b: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() || b.is_null() {
        return Ok(OpValue::null());
    }

    match ctx.float_mode {
        FloatMode::Strict => {
            let left = a.as_decimal("mul")?;
            let right = b.as_decimal("mul")?;
            let result = left
                .checked_mul(right)
                .ok_or_else(|| OpError::NumericOverflow {
                    operation: "mul".to_string(),
                    details: "decimal multiplication overflow".to_string(),
                })?;
            Ok(OpValue::from_decimal(result))
        }
        FloatMode::Fast => {
            let left = a.as_f64("mul")?;
            let right = b.as_f64("mul")?;
            Ok(OpValue::number(left * right))
        }
    }
}

/// Divide two values.
///
/// In Strict mode: Uses rust_decimal for financial-grade precision.
/// In Fast mode: Uses f64 for performance.
///
/// Returns `OpError::DivisionByZero` if dividing by zero.
/// Null propagation: `div(x, null) = null`
pub fn div(a: &OpValue, b: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() || b.is_null() {
        return Ok(OpValue::null());
    }

    match ctx.float_mode {
        FloatMode::Strict => {
            let left = a.as_decimal("div")?;
            let right = b.as_decimal("div")?;
            if right.is_zero() {
                return Err(OpError::DivisionByZero {
                    operation: "div".to_string(),
                });
            }
            let result = left
                .checked_div(right)
                .ok_or_else(|| OpError::NumericOverflow {
                    operation: "div".to_string(),
                    details: "decimal division overflow".to_string(),
                })?;
            Ok(OpValue::from_decimal(result))
        }
        FloatMode::Fast => {
            let left = a.as_f64("div")?;
            let right = b.as_f64("div")?;
            if right == 0.0 {
                return Err(OpError::DivisionByZero {
                    operation: "div".to_string(),
                });
            }
            Ok(OpValue::number(left / right))
        }
    }
}

/// Euclidean modulo of two values.
///
/// In Strict mode: Uses rust_decimal for financial-grade precision.
/// In Fast mode: Uses f64 for performance.
///
/// Returns `OpError::DivisionByZero` if modulo by zero.
/// Null propagation: `modulo(x, null) = null`
pub fn modulo(a: &OpValue, b: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() || b.is_null() {
        return Ok(OpValue::null());
    }

    match ctx.float_mode {
        FloatMode::Strict => {
            let left = a.as_decimal("mod")?;
            let right = b.as_decimal("mod")?;
            if right.is_zero() {
                return Err(OpError::DivisionByZero {
                    operation: "mod".to_string(),
                });
            }
            // Euclidean modulo
            let bb = right.abs();
            let q = (left / bb).floor();
            let r = left
                .checked_sub(q.checked_mul(bb).ok_or_else(|| OpError::NumericOverflow {
                    operation: "mod".to_string(),
                    details: "modulo overflow".to_string(),
                })?)
                .ok_or_else(|| OpError::NumericOverflow {
                    operation: "mod".to_string(),
                    details: "modulo overflow".to_string(),
                })?;
            Ok(OpValue::from_decimal(r))
        }
        FloatMode::Fast => {
            let left = a.as_f64("mod")?;
            let right = b.as_f64("mod")?;
            if right == 0.0 {
                return Err(OpError::DivisionByZero {
                    operation: "mod".to_string(),
                });
            }
            // Euclidean modulo for f64
            let result = ((left % right) + right) % right;
            Ok(OpValue::number(result))
        }
    }
}

// ============================================================================
// Unary Arithmetic Operators
// ============================================================================

/// Negate a value.
///
/// Null propagation: `neg(null) = null`
pub fn neg(a: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() {
        return Ok(OpValue::null());
    }

    match ctx.float_mode {
        FloatMode::Strict => {
            let val = a.as_decimal("neg")?;
            Ok(OpValue::from_decimal(-val))
        }
        FloatMode::Fast => {
            let val = a.as_f64("neg")?;
            Ok(OpValue::number(-val))
        }
    }
}

/// Absolute value.
///
/// Null propagation: `abs(null) = null`
pub fn abs(a: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() {
        return Ok(OpValue::null());
    }

    match ctx.float_mode {
        FloatMode::Strict => {
            let val = a.as_decimal("abs")?;
            Ok(OpValue::from_decimal(val.abs()))
        }
        FloatMode::Fast => {
            let val = a.as_f64("abs")?;
            Ok(OpValue::number(val.abs()))
        }
    }
}

/// Ceiling (round up).
///
/// Null propagation: `ceil(null) = null`
pub fn ceil(a: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() {
        return Ok(OpValue::null());
    }

    match ctx.float_mode {
        FloatMode::Strict => {
            let val = a.as_decimal("ceil")?;
            Ok(OpValue::from_decimal(val.ceil()))
        }
        FloatMode::Fast => {
            let val = a.as_f64("ceil")?;
            Ok(OpValue::number(val.ceil()))
        }
    }
}

/// Floor (round down).
///
/// Null propagation: `floor(null) = null`
pub fn floor(a: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() {
        return Ok(OpValue::null());
    }

    match ctx.float_mode {
        FloatMode::Strict => {
            let val = a.as_decimal("floor")?;
            Ok(OpValue::from_decimal(val.floor()))
        }
        FloatMode::Fast => {
            let val = a.as_f64("floor")?;
            Ok(OpValue::number(val.floor()))
        }
    }
}

/// Round to specified decimal places.
///
/// In Strict mode: Uses Banker's rounding (MidpointNearestEven).
/// In Fast mode: Uses f64 rounding.
///
/// Null propagation: `round(null, _) = null`
pub fn round(a: &OpValue, digits: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() {
        return Ok(OpValue::null());
    }

    let dp = if digits.is_null() {
        0i32
    } else {
        digits.as_decimal("round")?.to_i32().unwrap_or(0)
    };

    match ctx.float_mode {
        FloatMode::Strict => {
            let val = a.as_decimal("round")?;
            // Use Banker's rounding (MidpointNearestEven)
            let rounded = val.round_dp_with_strategy(
                dp.clamp(0, 28) as u32,
                RoundingStrategy::MidpointNearestEven,
            );
            Ok(OpValue::from_decimal(rounded))
        }
        FloatMode::Fast => {
            let val = a.as_f64("round")?;
            let multiplier = 10f64.powi(dp);
            let rounded = (val * multiplier).round() / multiplier;
            Ok(OpValue::number(rounded))
        }
    }
}

/// Sign of a value (-1, 0, or 1).
///
/// Null propagation: `sign(null) = null`
pub fn sign(a: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() {
        return Ok(OpValue::null());
    }

    match ctx.float_mode {
        FloatMode::Strict => {
            let val = a.as_decimal("sign")?;
            let sign_val = if val > Decimal::ZERO {
                Decimal::ONE
            } else if val < Decimal::ZERO {
                -Decimal::ONE
            } else {
                Decimal::ZERO
            };
            Ok(OpValue::from_decimal(sign_val))
        }
        FloatMode::Fast => {
            let val = a.as_f64("sign")?;
            let sign_val = if val > 0.0 {
                1.0
            } else if val < 0.0 {
                -1.0
            } else {
                0.0
            };
            Ok(OpValue::number(sign_val))
        }
    }
}

// ============================================================================
// Aggregator Functions
// ============================================================================

/// Sum of values. Accepts either multiple OpValues or an array.
///
/// Nulls are skipped. Returns null if all values are null or empty.
pub fn sum(values: &[OpValue], ctx: &EvalContext) -> Result<OpValue, OpError> {
    let nums = collect_numbers(values, ctx, "sum")?;
    if nums.is_empty() {
        return Ok(OpValue::null());
    }

    match ctx.float_mode {
        FloatMode::Strict => {
            let mut acc = Decimal::ZERO;
            for (d, _) in nums {
                acc = acc.checked_add(d).ok_or_else(|| OpError::NumericOverflow {
                    operation: "sum".to_string(),
                    details: "sum overflow".to_string(),
                })?;
            }
            Ok(OpValue::from_decimal(acc))
        }
        FloatMode::Fast => {
            let total: f64 = nums.iter().map(|(_, f)| f).sum();
            Ok(OpValue::number(total))
        }
    }
}

/// Product of values (a spreadsheet's PRODUCT), nulls skipped as `sum` skips them; null for none. Strict mode multiplies
/// exact decimals and refuses a product past the decimal range (about 7.9e28) as an overflow, never a rounded number.
pub fn product(values: &[OpValue], ctx: &EvalContext) -> Result<OpValue, OpError> {
    let nums = collect_numbers(values, ctx, "product")?;
    if nums.is_empty() {
        return Ok(OpValue::null());
    }
    match ctx.float_mode {
        FloatMode::Strict => {
            let mut acc = Decimal::ONE;
            for (d, _) in nums {
                acc = acc.checked_mul(d).ok_or_else(|| OpError::NumericOverflow {
                    operation: "product".to_string(),
                    details: "product overflow".to_string(),
                })?;
            }
            Ok(OpValue::from_decimal(acc))
        }
        FloatMode::Fast => Ok(OpValue::number(nums.iter().map(|(_, f)| f).product())),
    }
}

/// Average of values.
///
/// Nulls are skipped. Returns null if all values are null or empty.
pub fn average(values: &[OpValue], ctx: &EvalContext) -> Result<OpValue, OpError> {
    let nums = collect_numbers(values, ctx, "average")?;
    if nums.is_empty() {
        return Ok(OpValue::null());
    }

    match ctx.float_mode {
        FloatMode::Strict => {
            let mut acc = Decimal::ZERO;
            for (d, _) in &nums {
                acc = acc
                    .checked_add(*d)
                    .ok_or_else(|| OpError::NumericOverflow {
                        operation: "average".to_string(),
                        details: "sum overflow during average".to_string(),
                    })?;
            }
            let count = Decimal::from(nums.len() as u64);
            let mean = acc
                .checked_div(count)
                .ok_or_else(|| OpError::NumericOverflow {
                    operation: "average".to_string(),
                    details: "average division overflow".to_string(),
                })?;
            Ok(OpValue::from_decimal(mean))
        }
        FloatMode::Fast => {
            let total: f64 = nums.iter().map(|(_, f)| f).sum();
            let mean = total / nums.len() as f64;
            Ok(OpValue::number(mean))
        }
    }
}

/// Minimum of values.
///
/// Nulls are skipped. Returns null if all values are null or empty.
pub fn min(values: &[OpValue], ctx: &EvalContext) -> Result<OpValue, OpError> {
    let nums = collect_numbers(values, ctx, "min")?;
    if nums.is_empty() {
        return Ok(OpValue::null());
    }

    match ctx.float_mode {
        FloatMode::Strict => {
            let min_val = nums.iter().map(|(d, _)| d).min().unwrap();
            Ok(OpValue::from_decimal(*min_val))
        }
        FloatMode::Fast => {
            let min_val = nums.iter().map(|(_, f)| *f).fold(f64::INFINITY, f64::min);
            Ok(OpValue::number(min_val))
        }
    }
}

/// Maximum of values.
///
/// Nulls are skipped. Returns null if all values are null or empty.
pub fn max(values: &[OpValue], ctx: &EvalContext) -> Result<OpValue, OpError> {
    let nums = collect_numbers(values, ctx, "max")?;
    if nums.is_empty() {
        return Ok(OpValue::null());
    }

    match ctx.float_mode {
        FloatMode::Strict => {
            let max_val = nums.iter().map(|(d, _)| d).max().unwrap();
            Ok(OpValue::from_decimal(*max_val))
        }
        FloatMode::Fast => {
            let max_val = nums
                .iter()
                .map(|(_, f)| *f)
                .fold(f64::NEG_INFINITY, f64::max);
            Ok(OpValue::number(max_val))
        }
    }
}

/// Median of values.
///
/// Nulls are skipped. Returns null if all values are null or empty.
pub fn median(values: &[OpValue], ctx: &EvalContext) -> Result<OpValue, OpError> {
    let mut nums = collect_numbers(values, ctx, "median")?;
    if nums.is_empty() {
        return Ok(OpValue::null());
    }

    match ctx.float_mode {
        FloatMode::Strict => {
            nums.sort_by(|a, b| a.0.cmp(&b.0));
            let n = nums.len();
            let median_val = if n % 2 == 1 {
                nums[n / 2].0
            } else {
                let sum = nums[n / 2 - 1]
                    .0
                    .checked_add(nums[n / 2].0)
                    .ok_or_else(|| OpError::NumericOverflow {
                        operation: "median".to_string(),
                        details: "median sum overflow".to_string(),
                    })?;
                sum.checked_div(Decimal::from(2u64))
                    .ok_or_else(|| OpError::NumericOverflow {
                        operation: "median".to_string(),
                        details: "median division overflow".to_string(),
                    })?
            };
            Ok(OpValue::from_decimal(median_val))
        }
        FloatMode::Fast => {
            nums.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
            let n = nums.len();
            let median_val = if n % 2 == 1 {
                nums[n / 2].1
            } else {
                (nums[n / 2 - 1].1 + nums[n / 2].1) / 2.0
            };
            Ok(OpValue::number(median_val))
        }
    }
}

/// Count of elements in an array.
///
/// Returns the length of the array (including nulls).
pub fn count(arr: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    if arr.is_null() {
        return Ok(OpValue::null());
    }

    let arr_val = arr.as_array("count")?;
    Ok(OpValue::from_i64(arr_val.len() as i64))
}

// ============================================================================
// Fast-Mode Aggregators (Always f64)
// ============================================================================

/// Fast sum using f64. Always uses IEEE 754 floating-point.
///
/// This is the fast-mode version of sum that ignores FloatMode
/// and always uses f64 for maximum performance.
///
/// Nulls are skipped. Returns null if all values are null or empty.
pub fn fsum(values: &[OpValue], _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let nums = collect_f64_numbers(values, "fsum")?;
    if nums.is_empty() {
        return Ok(OpValue::null());
    }

    let total: f64 = nums.iter().sum();
    Ok(OpValue::number(total))
}

/// Fast median using f64. Always uses IEEE 754 floating-point.
///
/// This is the fast-mode version of median that ignores FloatMode
/// and always uses f64 for maximum performance.
///
/// Nulls are skipped. Returns null if all values are null or empty.
pub fn fmedian(values: &[OpValue], _ctx: &EvalContext) -> Result<OpValue, OpError> {
    let mut nums = collect_f64_numbers(values, "fmedian")?;
    if nums.is_empty() {
        return Ok(OpValue::null());
    }

    nums.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = nums.len();
    let median_val = if n % 2 == 1 {
        nums[n / 2]
    } else {
        (nums[n / 2 - 1] + nums[n / 2]) / 2.0
    };

    Ok(OpValue::number(median_val))
}

// ============================================================================
// Scientific Functions (Always f64)
// ============================================================================

/// Square root. Always uses f64.
///
/// Returns NaN for negative numbers.
/// Null propagation: `sqrt(null) = null`
pub fn sqrt(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() {
        return Ok(OpValue::null());
    }

    let val = a.as_f64("sqrt")?;
    let result = if val < 0.0 { f64::NAN } else { val.sqrt() };

    if result.is_nan() {
        return Err(OpError::InvalidOperation {
            operation: "sqrt".to_string(),
            reason: "square root of negative number".to_string(),
        });
    }

    Ok(OpValue::number(result))
}

/// Power function. Always uses f64.
///
/// Handles negative base with non-integer exponent as an error.
/// Null propagation: `pow(null, _) = null`
pub fn pow(base: &OpValue, exp: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    if base.is_null() || exp.is_null() {
        return Ok(OpValue::null());
    }

    let base_val = base.as_f64("pow")?;
    let exp_val = exp.as_f64("pow")?;

    let result = if base_val < 0.0 {
        let exp_rounded = exp_val.round();
        if (exp_val - exp_rounded).abs() > 1e-12 {
            return Err(OpError::InvalidOperation {
                operation: "pow".to_string(),
                reason: "negative base with non-integer exponent".to_string(),
            });
        }
        base_val.powi(exp_rounded as i32)
    } else {
        base_val.powf(exp_val)
    };

    if !result.is_finite() {
        return Err(OpError::NumericOverflow {
            operation: "pow".to_string(),
            details: "result is not finite".to_string(),
        });
    }

    Ok(OpValue::number(result))
}

/// Exponential function (e^x). Always uses f64.
///
/// Null propagation: `exp(null) = null`
pub fn exp(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() {
        return Ok(OpValue::null());
    }

    let val = a.as_f64("exp")?;
    let result = val.exp();

    if !result.is_finite() {
        return Err(OpError::NumericOverflow {
            operation: "exp".to_string(),
            details: "result is not finite".to_string(),
        });
    }

    Ok(OpValue::number(result))
}

/// Generic logarithm with specified base. Always uses f64.
///
/// - value: The number to take the logarithm of (must be positive)
/// - base: The logarithm base as a number (must be positive and not equal to 1)
///
/// Returns error for non-positive values or invalid bases.
/// Null propagation: `log(null, _) = null`, `log(_, null) = null`
pub fn log(value: &OpValue, base: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    if value.is_null() || base.is_null() {
        return Ok(OpValue::null());
    }

    let val = value.as_f64("log")?;
    if val <= 0.0 {
        return Err(OpError::InvalidOperation {
            operation: "log".to_string(),
            reason: "logarithm of non-positive number".to_string(),
        });
    }

    let base_f = base.as_f64("log")?;
    if base_f <= 0.0 || base_f == 1.0 {
        return Err(OpError::InvalidOperation {
            operation: "log".to_string(),
            reason: "base must be positive and not equal to 1".to_string(),
        });
    }

    let result = val.log(base_f);
    Ok(OpValue::number(result))
}

// OLD FUNCTIONS DELETED: ln, log10, log2 — Use log(value, base) instead

// ============================================================================
// Trigonometric Functions (Always f64)
// ============================================================================

/// Sine function. Always uses f64.
pub fn sin(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() {
        return Ok(OpValue::null());
    }
    let val = a.as_f64("sin")?;
    Ok(OpValue::number(val.sin()))
}

/// Cosine function. Always uses f64.
pub fn cos(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() {
        return Ok(OpValue::null());
    }
    let val = a.as_f64("cos")?;
    Ok(OpValue::number(val.cos()))
}

/// Tangent function. Always uses f64.
pub fn tan(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() {
        return Ok(OpValue::null());
    }
    let val = a.as_f64("tan")?;
    Ok(OpValue::number(val.tan()))
}

/// Arcsine function. Always uses f64.
///
/// Returns error if value is outside [-1, 1].
pub fn asin(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() {
        return Ok(OpValue::null());
    }
    let val = a.as_f64("asin")?;
    if !(-1.0..=1.0).contains(&val) {
        return Err(OpError::InvalidOperation {
            operation: "asin".to_string(),
            reason: "input must be in range [-1, 1]".to_string(),
        });
    }
    Ok(OpValue::number(val.asin()))
}

/// Arccosine function. Always uses f64.
///
/// Returns error if value is outside [-1, 1].
pub fn acos(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() {
        return Ok(OpValue::null());
    }
    let val = a.as_f64("acos")?;
    if !(-1.0..=1.0).contains(&val) {
        return Err(OpError::InvalidOperation {
            operation: "acos".to_string(),
            reason: "input must be in range [-1, 1]".to_string(),
        });
    }
    Ok(OpValue::number(val.acos()))
}

/// Arctangent function. Always uses f64.
pub fn atan(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() {
        return Ok(OpValue::null());
    }
    let val = a.as_f64("atan")?;
    Ok(OpValue::number(val.atan()))
}

/// Cube root function. Always uses f64.
pub fn cbrt(a: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    if a.is_null() {
        return Ok(OpValue::null());
    }
    let val = a.as_f64("cbrt")?;
    Ok(OpValue::number(val.cbrt()))
}

// ============================================================================
// Constants
// ============================================================================

/// Pi constant.
pub fn pi(_ctx: &EvalContext) -> Result<OpValue, OpError> {
    Ok(OpValue::number(std::f64::consts::PI))
}

/// Euler's number (e) constant.
pub fn e_const(_ctx: &EvalContext) -> Result<OpValue, OpError> {
    Ok(OpValue::number(std::f64::consts::E))
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Collects numeric values from a slice of OpValues, handling arrays.
/// Returns both Decimal and f64 representations for dual-mode support.
/// Silently skips nulls and non-numeric values in arrays.
fn collect_numbers(
    values: &[OpValue],
    _ctx: &EvalContext,
    operation: &str,
) -> Result<Vec<(Decimal, f64)>, OpError> {
    let mut out = Vec::new();

    for val in values {
        if val.is_null() {
            continue;
        }

        if val.is_array() {
            let arr = val.as_array(operation)?;
            for item in arr {
                let op_item = OpValue::from_arc(Arc::clone(item));
                if op_item.is_null() {
                    continue;
                }
                if op_item.is_number() {
                    // Try to get both decimal and f64
                    if let Ok(d) = op_item.as_decimal(operation) {
                        if let Ok(f) = op_item.as_f64(operation) {
                            out.push((d, f));
                        }
                    }
                } else if op_item.is_string() {
                    // An exact decimal as text is how the strict arithmetic operators answer (`sub` of two numbers is
                    // "2"), so a list of their answers is a list of numbers; any other text is skipped as before.
                    if let Ok(d) = op_item.as_decimal(operation) {
                        if let Some(f) = d.to_f64() {
                            out.push((d, f));
                        }
                    }
                }
                // Silently skip non-numeric values in arrays
            }
        } else if val.is_number() {
            let d = val.as_decimal(operation)?;
            let f = val.as_f64(operation)?;
            out.push((d, f));
        } else if val.is_string() {
            // An exact decimal as text, as the strict arithmetic operators answer; any other text is skipped as before.
            if let Ok(d) = val.as_decimal(operation) {
                if let Some(f) = d.to_f64() {
                    out.push((d, f));
                }
            }
        }
        // Silently skip non-numeric, non-array values
    }

    Ok(out)
}

/// Collects numeric values as f64 from a slice of OpValues, handling arrays.
/// Used by fast-mode aggregators that always use f64.
/// Silently skips nulls and non-numeric values in arrays.
fn collect_f64_numbers(values: &[OpValue], operation: &str) -> Result<Vec<f64>, OpError> {
    let mut out = Vec::new();

    for val in values {
        if val.is_null() {
            continue;
        }

        if val.is_array() {
            let arr = val.as_array(operation)?;
            for item in arr {
                let op_item = OpValue::from_arc(Arc::clone(item));
                if op_item.is_null() {
                    continue;
                }
                if op_item.is_number() {
                    if let Ok(f) = op_item.as_f64(operation) {
                        out.push(f);
                    }
                }
                // Silently skip non-numeric values in arrays
            }
        } else if val.is_number() {
            let f = val.as_f64(operation)?;
            out.push(f);
        }
        // Silently skip non-numeric, non-array values
    }

    Ok(out)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;
    use serde_json::json;
    use std::str::FromStr;

    fn strict() -> EvalContext {
        EvalContext::strict()
    }

    fn fast() -> EvalContext {
        EvalContext::fast()
    }

    // --- Basic Arithmetic Tests ---

    #[test]
    fn test_add_integers() {
        let a = OpValue::from(json!(1));
        let b = OpValue::from(json!(2));
        let result = add(&a, &b, &strict()).unwrap();
        // In strict mode, result is a Decimal which serializes to string "3"
        let d = result.as_decimal("test").unwrap();
        assert_eq!(d.to_string(), "3");
    }

    #[test]
    fn test_add_decimal_precision_strict() {
        // In Strict mode: 0.1 + 0.2 = 0.3 (exact)
        let a = OpValue::from(json!(0.1));
        let b = OpValue::from(json!(0.2));
        let result = add(&a, &b, &strict()).unwrap();
        // Decimal is stored as string "0.3" in JSON
        let d = result.as_decimal("test").unwrap();
        assert_eq!(d.to_string(), "0.3");
    }

    #[test]
    fn test_add_decimal_precision_fast() {
        // In Fast mode: 0.1 + 0.2 = 0.30000000000000004 (IEEE 754)
        let a = OpValue::from(json!(0.1));
        let b = OpValue::from(json!(0.2));
        let result = add(&a, &b, &fast()).unwrap();
        let f = result.as_f64("test").unwrap();
        // This is the classic IEEE 754 result
        assert!((f - 0.30000000000000004).abs() < 1e-15);
    }

    #[test]
    fn test_div_by_zero() {
        let a = OpValue::from(json!(1));
        let b = OpValue::from(json!(0));
        let result = div(&a, &b, &strict());
        assert!(matches!(result, Err(OpError::DivisionByZero { .. })));
    }

    #[test]
    fn test_null_propagation_add() {
        let a = OpValue::from(json!(1));
        let b = OpValue::null();
        let result = add(&a, &b, &strict()).unwrap();
        assert!(result.is_null());
    }

    #[test]
    fn test_null_propagation_mul() {
        let a = OpValue::null();
        let b = OpValue::from(json!(5));
        let result = mul(&a, &b, &strict()).unwrap();
        assert!(result.is_null());
    }

    // --- Rounding Tests ---

    #[test]
    fn test_round_bankers_rounding_2_5() {
        // Banker's rounding: 2.5 rounds to 2 (round to even)
        let a = OpValue::from(json!(2.5));
        let digits = OpValue::from(json!(0));
        let result = round(&a, &digits, &strict()).unwrap();
        let d = result.as_decimal("test").unwrap();
        assert_eq!(d.to_string(), "2");
    }

    #[test]
    fn test_round_bankers_rounding_3_5() {
        // Banker's rounding: 3.5 rounds to 4 (round to even)
        let a = OpValue::from(json!(3.5));
        let digits = OpValue::from(json!(0));
        let result = round(&a, &digits, &strict()).unwrap();
        let d = result.as_decimal("test").unwrap();
        assert_eq!(d.to_string(), "4");
    }

    // --- Aggregator Tests ---

    #[test]
    fn test_sum_with_nulls() {
        // sum([1, 2, null, 3]) = 6 (skips null)
        let arr = OpValue::from(json!([1, 2, null, 3]));
        let result = sum(&[arr], &strict()).unwrap();
        let d = result.as_decimal("test").unwrap();
        assert_eq!(d.to_string(), "6");
    }

    #[test]
    fn test_product_skips_nulls_and_refuses_overflow() {
        let arr = OpValue::from(json!([12, 6, null, 5]));
        assert_eq!(product(&[arr], &strict()).unwrap().as_decimal("test").unwrap().to_string(), "360");
        assert!(product(&[OpValue::from(json!([]))], &strict()).unwrap().is_null());
        let huge = OpValue::from(json!([1e20, 1e20]));
        assert!(matches!(product(&[huge], &strict()), Err(OpError::NumericOverflow { .. })));
    }

    #[test]
    fn test_sum_empty() {
        let arr = OpValue::from(json!([]));
        let result = sum(&[arr], &strict()).unwrap();
        assert!(result.is_null());
    }

    #[test]
    fn test_average() {
        let arr = OpValue::from(json!([2, 4, 6]));
        let result = average(&[arr], &strict()).unwrap();
        let d = result.as_decimal("test").unwrap();
        assert_eq!(d.to_string(), "4");
    }

    #[test]
    fn test_min_max() {
        let arr = OpValue::from(json!([3, 1, 4, 1, 5, 9]));
        let min_result = min(&[arr.clone()], &strict()).unwrap();
        let max_result = max(&[arr], &strict()).unwrap();
        assert_eq!(min_result.as_decimal("test").unwrap().to_string(), "1");
        assert_eq!(max_result.as_decimal("test").unwrap().to_string(), "9");
    }

    #[test]
    fn test_median_odd() {
        let arr = OpValue::from(json!([1, 3, 2]));
        let result = median(&[arr], &strict()).unwrap();
        let d = result.as_decimal("test").unwrap();
        assert_eq!(d.to_string(), "2");
    }

    #[test]
    fn test_median_even() {
        let arr = OpValue::from(json!([1, 2, 3, 4]));
        let result = median(&[arr], &strict()).unwrap();
        let d = result.as_decimal("test").unwrap();
        // Decimal may preserve trailing zeros, so normalize the comparison
        assert_eq!(d, Decimal::from_str("2.5").unwrap());
    }

    // --- Scientific Function Tests ---

    #[test]
    fn test_sqrt_positive() {
        let a = OpValue::from(json!(4));
        let result = sqrt(&a, &strict()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 2.0);
    }

    #[test]
    fn test_sqrt_negative() {
        let a = OpValue::from(json!(-1));
        let result = sqrt(&a, &strict());
        assert!(matches!(result, Err(OpError::InvalidOperation { .. })));
    }

    #[test]
    fn test_trig_sin_zero() {
        let a = OpValue::from(json!(0));
        let result = sin(&a, &strict()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 0.0);
    }

    #[test]
    fn test_trig_cos_zero() {
        let a = OpValue::from(json!(0));
        let result = cos(&a, &strict()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 1.0);
    }

    // --- Constants ---

    #[test]
    fn test_pi() {
        let result = pi(&strict()).unwrap();
        let val = result.as_f64("test").unwrap();
        assert!((val - std::f64::consts::PI).abs() < 1e-15);
    }

    #[test]
    fn test_e() {
        let result = e_const(&strict()).unwrap();
        let val = result.as_f64("test").unwrap();
        assert!((val - std::f64::consts::E).abs() < 1e-15);
    }

    // --- Additional edge cases ---

    #[test]
    fn test_modulo() {
        let a = OpValue::from(json!(7));
        let b = OpValue::from(json!(3));
        let result = modulo(&a, &b, &strict()).unwrap();
        let d = result.as_decimal("test").unwrap();
        assert_eq!(d.to_string(), "1");
    }

    #[test]
    fn test_modulo_by_zero() {
        let a = OpValue::from(json!(7));
        let b = OpValue::from(json!(0));
        let result = modulo(&a, &b, &strict());
        assert!(matches!(result, Err(OpError::DivisionByZero { .. })));
    }

    #[test]
    fn test_pow() {
        let base = OpValue::from(json!(2));
        let exp = OpValue::from(json!(3));
        let result = pow(&base, &exp, &strict()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 8.0);
    }

    #[test]
    fn test_neg() {
        let a = OpValue::from(json!(5));
        let result = neg(&a, &strict()).unwrap();
        let d = result.as_decimal("test").unwrap();
        assert_eq!(d.to_string(), "-5");
    }

    #[test]
    fn test_abs_negative() {
        let a = OpValue::from(json!(-5));
        let result = abs(&a, &strict()).unwrap();
        let d = result.as_decimal("test").unwrap();
        assert_eq!(d.to_string(), "5");
    }

    #[test]
    fn test_sign() {
        assert_eq!(
            sign(&OpValue::from(json!(5)), &strict())
                .unwrap()
                .as_decimal("test")
                .unwrap()
                .to_string(),
            "1"
        );
        assert_eq!(
            sign(&OpValue::from(json!(-5)), &strict())
                .unwrap()
                .as_decimal("test")
                .unwrap()
                .to_string(),
            "-1"
        );
        assert_eq!(
            sign(&OpValue::from(json!(0)), &strict())
                .unwrap()
                .as_decimal("test")
                .unwrap()
                .to_string(),
            "0"
        );
    }

    #[test]
    fn test_log_natural() {
        // ln(1) = 0: use log(value, e)
        let a = OpValue::from(json!(1));
        let e = OpValue::number(std::f64::consts::E);
        let result = log(&a, &e, &strict()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 0.0);
    }

    #[test]
    fn test_log_negative() {
        // log of negative number should error
        let a = OpValue::from(json!(-1));
        let base = OpValue::number(10.0);
        let result = log(&a, &base, &strict());
        assert!(matches!(result, Err(OpError::InvalidOperation { .. })));
    }

    #[test]
    fn test_asin_out_of_range() {
        let a = OpValue::from(json!(2));
        let result = asin(&a, &strict());
        assert!(matches!(result, Err(OpError::InvalidOperation { .. })));
    }

    #[test]
    fn test_count() {
        let arr = OpValue::from(json!([1, 2, 3, null, 5]));
        let result = count(&arr, &strict()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 5.0);
    }

    // --- Fast-mode aggregator tests ---

    #[test]
    fn test_fsum_basic() {
        let arr = OpValue::from(json!([1, 2, 3, 4]));
        let result = fsum(&[arr], &strict()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 10.0);
    }

    #[test]
    fn test_fsum_with_nulls() {
        let arr = OpValue::from(json!([1, 2, null, 3]));
        let result = fsum(&[arr], &strict()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 6.0);
    }

    #[test]
    fn test_fsum_empty() {
        let arr = OpValue::from(json!([]));
        let result = fsum(&[arr], &strict()).unwrap();
        assert!(result.is_null());
    }

    #[test]
    fn test_fsum_ieee754_behavior() {
        // fsum always uses f64, so 0.1 + 0.2 will exhibit IEEE 754 behavior
        let arr = OpValue::from(json!([0.1, 0.2]));
        let result = fsum(&[arr], &strict()).unwrap(); // Even in strict context, fsum uses f64
        let f = result.as_f64("test").unwrap();
        // This is the classic IEEE 754 result
        assert!((f - 0.30000000000000004).abs() < 1e-15);
    }

    #[test]
    fn test_fmedian_odd() {
        let arr = OpValue::from(json!([1, 3, 2]));
        let result = fmedian(&[arr], &strict()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 2.0);
    }

    #[test]
    fn test_fmedian_even() {
        let arr = OpValue::from(json!([1, 2, 3, 4]));
        let result = fmedian(&[arr], &strict()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 2.5);
    }

    #[test]
    fn test_fmedian_with_nulls() {
        let arr = OpValue::from(json!([1, null, 5, 3]));
        let result = fmedian(&[arr], &strict()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 3.0); // [1, 3, 5] -> median is 3
    }

    #[test]
    fn test_fmedian_empty() {
        let arr = OpValue::from(json!([]));
        let result = fmedian(&[arr], &strict()).unwrap();
        assert!(result.is_null());
    }
}
