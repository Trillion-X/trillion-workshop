//! crates/composition-engine/src/binding/operators/core/mod.rs
//!
//! Core binding operators - FLAT REGISTRATION LIST.
//!
//! This module registers all operators by delegating to ops-core (the single source
//! of truth for operator semantics). No duplicate implementations.
//!
//! Architecture:
//! - ops-core: Contains operator logic (OpValue, EvalContext, functions)
//! - This module: Adapts ops-core to composition-engine's Operator trait
//! - Conversion happens at ONE boundary (wrap functions below)
//!
//! Non-Negotiable Invariants:
//! - NO operator logic in this file - only registration
//! - ONE type system: OpValue throughout the Operator trait
//! - ops-core is the canonical source of truth

mod each_item;
mod map_to_nodes;

#[cfg(test)]
use super::registry::{FnOperator, OperatorContext, OperatorRegistry, RegistryError};
#[cfg(not(test))]
use super::registry::{FnOperator, OperatorRegistry, RegistryError};
use crate::binding::ast::{Diagnostic, DiagnosticCode, DiagnosticLevel};
use ops_core::{EvalContext, OpError, OpValue};
use rust_decimal::prelude::*;
use rust_decimal::RoundingStrategy;

/// Semantic version for the composed operator surface.
pub const CORE_OPERATORS_VERSION: u32 = 7;

// =============================================================================
// ERROR CONVERSION
// =============================================================================

fn op_err(e: OpError) -> Diagnostic {
    Diagnostic {
        code: DiagnosticCode::EvalTypeMismatch,
        level: DiagnosticLevel::Error,
        message: e.to_string(),
        at: String::new(),
        data: None,
    }
}

fn err(msg: &str) -> Diagnostic {
    Diagnostic {
        code: DiagnosticCode::EvalTypeMismatch,
        level: DiagnosticLevel::Error,
        message: msg.to_string(),
        at: String::new(),
        data: None,
    }
}

// =============================================================================
// CONTEXT HELPERS
// =============================================================================

// An EvalContext carries a capability registry that allocates when it is
// built. Operators only read it, so each mode is built once per process and
// shared; building one per operator call cost more than the operator itself.
fn ctx_fast() -> &'static EvalContext {
    static FAST: std::sync::OnceLock<EvalContext> = std::sync::OnceLock::new();
    FAST.get_or_init(EvalContext::fast)
}

fn ctx_strict() -> &'static EvalContext {
    static STRICT: std::sync::OnceLock<EvalContext> = std::sync::OnceLock::new();
    STRICT.get_or_init(EvalContext::strict)
}

// =============================================================================
// ARG EXTRACTION HELPERS
// =============================================================================

fn get_arg(args: Option<&OpValue>, key: &str) -> OpValue {
    use ops_core::value::OpNode;
    use std::sync::Arc;
    args.and_then(|a| {
        if let OpNode::Object(map) = a.node() {
            map.get(&Arc::from(key))
                .map(|v| OpValue::from_arc(Arc::clone(v)))
        } else {
            None
        }
    })
    .unwrap_or_else(OpValue::null)
}

fn get_arg_str(args: Option<&OpValue>, key: &str) -> Option<String> {
    use ops_core::value::OpNode;
    use std::sync::Arc;
    args.and_then(|a| {
        if let OpNode::Object(map) = a.node() {
            map.get(&Arc::from(key)).and_then(|v| {
                if let OpNode::String(s) = v.as_ref() {
                    Some(s.to_string())
                } else {
                    None
                }
            })
        } else {
            None
        }
    })
}

fn get_arg_i64(args: Option<&OpValue>, key: &str) -> Option<i64> {
    use ops_core::value::OpNode;
    use std::sync::Arc;
    args.and_then(|a| {
        if let OpNode::Object(map) = a.node() {
            map.get(&Arc::from(key)).and_then(|v| {
                if let OpNode::Number(n) = v.as_ref() {
                    Some(*n as i64)
                } else {
                    None
                }
            })
        } else {
            None
        }
    })
}

fn get_values_array(args: Option<&OpValue>) -> Vec<OpValue> {
    use ops_core::value::OpNode;
    use std::sync::Arc;
    args.and_then(|a| {
        if let OpNode::Object(map) = a.node() {
            map.get(&Arc::from("values")).and_then(|v| {
                if let OpNode::Array(arr) = v.as_ref() {
                    Some(
                        arr.iter()
                            .map(|elem| OpValue::from_arc(Arc::clone(elem)))
                            .collect(),
                    )
                } else {
                    None
                }
            })
        } else {
            None
        }
    })
    .unwrap_or_default()
}

// =============================================================================
// REGISTRATION
// =============================================================================

/// Register all core operators into a registry.
pub fn register_core_operators(registry: &mut OperatorRegistry) -> Result<(), RegistryError> {
    register_math_operators(registry)?;
    register_logical_operators(registry)?;
    register_conversion_operators(registry)?;
    register_text_operators(registry)?;
    register_array_operators(registry)?;
    register_datetime_operators(registry)?;
    register_crypto_operators(registry)?;
    register_graph_operators(registry)?;
    register_other_names(registry)?;
    Ok(())
}

/// Names a stored binding already uses for an operator registered under another name. Each pair reaches the very
/// same operator (`OperatorRegistry::register_alias`), so the two names cannot drift apart. A new pair is one line.
const OTHER_NAMES: &[(&str, &str)] = &[
    ("op:core.first", "op:core.array_first"),
    ("op:core.last", "op:core.array_last"),
    ("op:core.gte", "op:core.ge"),
    ("op:core.lte", "op:core.le"),
    ("op:core.includes", "op:core.array_contains"),
    ("op:core.left", "op:core.text_left"),
    ("op:core.regex_extract", "op:core.text_regex_extract"),
    ("op:core.json_parse", "op:core.text_json_parse"),
    ("op:core.sort_by", "op:core.array_sort_by"),
    ("op:core.find_by", "op:core.array_find_by"),
];

fn register_other_names(registry: &mut OperatorRegistry) -> Result<(), RegistryError> {
    use ops_core::text;

    // Two objects merged, the argument's keys over the value's (`value`, or `source`)
    registry.register(FnOperator::new("op:core.merge", |input, args, _ctx| {
        let source = get_arg(args, "value");
        let source = if source.is_null() { get_arg(args, "source") } else { source };
        ops_core::structure::merge(input, &source, ctx_fast()).map_err(op_err)
    }))?;

    // A value as text: text as it is, a number without a needless ".0", true/false, null
    registry.register(FnOperator::new("op:core.to_string", |input, _args, _ctx| {
        ops_core::conversion::to_string(input, ctx_fast()).map_err(op_err)
    }))?;

    // Text joined: `values` in order, or `prefix` + the value + `suffix`
    registry.register(FnOperator::new("op:core.concat", |input, args, _ctx| {
        if args.is_some_and(|args| !get_arg(Some(args), "values").is_null()) {
            return text::concat_many(&get_values_array(args), ctx_fast()).map_err(op_err);
        }
        let around = |name: &str| {
            let part = get_arg(args, name);
            if part.is_null() { OpValue::string("") } else { part }
        };
        let with_prefix = text::concat(&around("prefix"), input, ctx_fast()).map_err(op_err)?;
        text::concat(&with_prefix, &around("suffix"), ctx_fast()).map_err(op_err)
    }))?;

    for (name, existing) in OTHER_NAMES {
        registry.register_alias(name, existing)?;
    }
    Ok(())
}

/// Create a registry with all core operators pre-registered.
pub fn create_core_registry() -> Result<OperatorRegistry, RegistryError> {
    let mut registry = OperatorRegistry::new();
    register_core_operators(&mut registry)?;
    Ok(registry)
}

// =============================================================================
// MATH OPERATORS
// =============================================================================

fn register_math_operators(registry: &mut OperatorRegistry) -> Result<(), RegistryError> {
    use ops_core::math;

    // Binary arithmetic
    registry.register(FnOperator::new("op:core.add", |input, args, _ctx| {
        let b = get_arg(args, "value");
        math::add(input, &b, ctx_strict()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.sub", |input, args, _ctx| {
        let b = get_arg(args, "value");
        math::sub(input, &b, ctx_strict()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.mul", |input, args, _ctx| {
        let b = get_arg(args, "value");
        math::mul(input, &b, ctx_strict()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.div", |input, args, _ctx| {
        let b = get_arg(args, "value");
        math::div(input, &b, ctx_strict()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.mod", |input, args, _ctx| {
        let b = get_arg(args, "value");
        math::modulo(input, &b, ctx_strict()).map_err(op_err)
    }))?;

    // Unary
    registry.register(FnOperator::new("op:core.neg", |input, _args, _ctx| {
        math::neg(input, ctx_strict()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.abs", |input, _args, _ctx| {
        math::abs(input, ctx_strict()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.ceil", |input, _args, _ctx| {
        math::ceil(input, ctx_strict()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.floor", |input, _args, _ctx| {
        math::floor(input, ctx_strict()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.round", |input, args, _ctx| {
        let digits = get_arg(args, "digits");
        math::round(input, &digits, ctx_strict()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.sign", |input, _args, _ctx| {
        math::sign(input, ctx_strict()).map_err(op_err)
    }))?;

    // Scientific (always fast mode)
    registry.register(FnOperator::new("op:core.sqrt", |input, _args, _ctx| {
        math::sqrt(input, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.pow", |input, args, _ctx| {
        let exp = get_arg(args, "exponent");
        math::pow(input, &exp, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.exp", |input, _args, _ctx| {
        math::exp(input, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.log", |input, args, _ctx| {
        let base = get_arg(args, "base");
        math::log(input, &base, ctx_fast()).map_err(op_err)
    }))?;

    // Trig
    registry.register(FnOperator::new("op:core.sin", |input, _args, _ctx| {
        math::sin(input, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.cos", |input, _args, _ctx| {
        math::cos(input, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.tan", |input, _args, _ctx| {
        math::tan(input, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.asin", |input, _args, _ctx| {
        math::asin(input, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.acos", |input, _args, _ctx| {
        math::acos(input, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.atan", |input, _args, _ctx| {
        math::atan(input, ctx_fast()).map_err(op_err)
    }))?;

    // Constants
    registry.register(FnOperator::new("op:core.pi", |_input, _args, _ctx| {
        math::pi(ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.e", |_input, _args, _ctx| {
        math::e_const(ctx_fast()).map_err(op_err)
    }))?;

    // Aggregates (input is array)
    registry.register(FnOperator::new("op:core.sum", |input, _args, _ctx| {
        let arr = input.as_array("sum").map_err(op_err)?;
        let values: Vec<OpValue> = arr.iter().map(|v| OpValue::from_arc(v.clone())).collect();
        math::sum(&values, ctx_strict()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.product", |input, _args, _ctx| {
        let arr = input.as_array("product").map_err(op_err)?;
        let values: Vec<OpValue> = arr.iter().map(|v| OpValue::from_arc(v.clone())).collect();
        math::product(&values, ctx_strict()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.average", |input, _args, _ctx| {
        let arr = input.as_array("average").map_err(op_err)?;
        let values: Vec<OpValue> = arr.iter().map(|v| OpValue::from_arc(v.clone())).collect();
        math::average(&values, ctx_strict()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.min", |input, _args, _ctx| {
        let arr = input.as_array("min").map_err(op_err)?;
        let values: Vec<OpValue> = arr.iter().map(|v| OpValue::from_arc(v.clone())).collect();
        math::min(&values, ctx_strict()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.max", |input, _args, _ctx| {
        let arr = input.as_array("max").map_err(op_err)?;
        let values: Vec<OpValue> = arr.iter().map(|v| OpValue::from_arc(v.clone())).collect();
        math::max(&values, ctx_strict()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.median", |input, _args, _ctx| {
        let arr = input.as_array("median").map_err(op_err)?;
        let values: Vec<OpValue> = arr.iter().map(|v| OpValue::from_arc(v.clone())).collect();
        math::median(&values, ctx_strict()).map_err(op_err)
    }))?;

    // Series reductions (ops-core/src/series.rs): what a list of numbers or dated entries says as a whole.
    registry.register(FnOperator::new("op:core.quantile", |input, args, _ctx| {
        ops_core::series::quantile(input, &get_arg(args, "q")).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.weighted_count", |input, args, _ctx| {
        ops_core::series::weighted_count(input, &get_arg(args, "weights"), &get_arg(args, "default")).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.streak", |input, args, _ctx| {
        ops_core::series::streak(input, &get_arg(args, "period"), &get_arg(args, "times"), &get_arg(args, "now")).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.longest_streak", |input, args, _ctx| {
        ops_core::series::longest_streak(input, &get_arg(args, "period"), &get_arg(args, "times")).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.variance", |input, _args, _ctx| {
        ops_core::series::variance(input).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.stdev", |input, _args, _ctx| {
        ops_core::series::standard_deviation(input).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.histogram", |input, args, _ctx| {
        ops_core::series::histogram(input, &get_arg(args, "edges")).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.count", |input, _args, _ctx| {
        math::count(input, ctx_fast()).map_err(op_err)
    }))?;

    // Aliases (use fast mode for float outputs, consistent with test expectations)
    registry.register(FnOperator::new("op:math.add", |input, args, _ctx| {
        let b = get_arg(args, "value");
        math::add(input, &b, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:math.sub", |input, args, _ctx| {
        let b = get_arg(args, "value");
        math::sub(input, &b, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:math.mul", |input, args, _ctx| {
        let b = get_arg(args, "value");
        math::mul(input, &b, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:math.div", |input, args, _ctx| {
        let b = get_arg(args, "value");
        math::div(input, &b, ctx_fast()).map_err(op_err)
    }))?;

    // Decimal string operators (financial-grade precision, string in/out)
    registry.register(FnOperator::new(
        "op:core.math_d_abs",
        |input, _args, _ctx| {
            let d = parse_decimal_input(input)?;
            Ok(OpValue::string(d.abs().to_string()))
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.math_d_floor",
        |input, _args, _ctx| {
            let d = parse_decimal_input(input)?;
            Ok(OpValue::string(d.floor().to_string()))
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.math_d_ceil",
        |input, _args, _ctx| {
            let d = parse_decimal_input(input)?;
            Ok(OpValue::string(d.ceil().to_string()))
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.math_d_round",
        |input, args, _ctx| {
            let d = parse_decimal_input(input)?;
            let dp = get_arg_i64(args, "dp").unwrap_or(0) as u32;
            let result = d.round_dp_with_strategy(dp, RoundingStrategy::MidpointNearestEven);
            Ok(OpValue::string(result.to_string()))
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.math_d_trunc",
        |input, args, _ctx| {
            let d = parse_decimal_input(input)?;
            let dp = get_arg_i64(args, "dp").unwrap_or(0) as u32;
            let result = d.trunc_with_scale(dp);
            Ok(OpValue::string(result.to_string()))
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.math_d_sign",
        |input, _args, _ctx| {
            let d = parse_decimal_input(input)?;
            let sign = if d.is_zero() {
                0
            } else if d.is_sign_negative() {
                -1
            } else {
                1
            };
            Ok(OpValue::from_i64(sign))
        },
    ))?;

    registry.register(FnOperator::new("op:core.cbrt", |input, _args, _ctx| {
        math::cbrt(input, ctx_fast()).map_err(op_err)
    }))?;

    // Float sum and median of a list (f64 throughout), beside the exact `sum` and `median`
    registry.register(FnOperator::new("op:core.fsum", |input, _args, _ctx| {
        let arr = input.as_array("fsum").map_err(op_err)?;
        let values: Vec<OpValue> = arr.iter().map(|v| OpValue::from_arc(v.clone())).collect();
        math::fsum(&values, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.fmedian", |input, _args, _ctx| {
        let arr = input.as_array("fmedian").map_err(op_err)?;
        let values: Vec<OpValue> = arr.iter().map(|v| OpValue::from_arc(v.clone())).collect();
        math::fmedian(&values, ctx_fast()).map_err(op_err)
    }))?;

    Ok(())
}

/// Parse decimal from OpValue (string or number input)
fn parse_decimal_input(input: &OpValue) -> Result<Decimal, Diagnostic> {
    use ops_core::value::OpNode;
    match input.node() {
        OpNode::String(s) => Decimal::from_str(s.as_ref())
            .map_err(|_| err(&format!("invalid decimal string: {}", s))),
        OpNode::Number(n) => {
            let v = *n;
            if v.fract() == 0.0 && v >= i64::MIN as f64 && v <= i64::MAX as f64 {
                Ok(Decimal::from(v as i64))
            } else {
                Decimal::try_from(v).map_err(|_| err("cannot convert float to decimal"))
            }
        }
        OpNode::Null => Err(err("null is not a valid decimal")),
        _ => Err(err("expected string or number for decimal")),
    }
}

// =============================================================================
// LOGICAL OPERATORS
// =============================================================================

fn register_logical_operators(registry: &mut OperatorRegistry) -> Result<(), RegistryError> {
    use ops_core::logical;

    // Identity (passthrough)
    registry.register(FnOperator::new("op:core.identity", |input, _args, _ctx| {
        Ok(input.clone())
    }))?;

    // Boolean coercion
    registry.register(FnOperator::new("op:core.bool", |input, _args, _ctx| {
        Ok(OpValue::bool(input.is_truthy()))
    }))?;

    // Tristate boolean ops
    registry.register(FnOperator::new("op:core.and", |_input, args, _ctx| {
        let values = get_values_array(args);
        if values.is_empty() {
            return Ok(OpValue::bool(true));
        }
        logical::and_many(&values, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.or", |_input, args, _ctx| {
        let values = get_values_array(args);
        if values.is_empty() {
            return Ok(OpValue::bool(false));
        }
        logical::or_many(&values, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.not", |input, _args, _ctx| {
        logical::not(input, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.xor", |_input, args, _ctx| {
        let a = get_arg(args, "a");
        let b = get_arg(args, "b");
        logical::xor(&a, &b, ctx_fast()).map_err(op_err)
    }))?;

    // Null checks
    registry.register(FnOperator::new("op:core.is_null", |input, _args, _ctx| {
        logical::is_null(input, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new(
        "op:core.is_not_null",
        |input, _args, _ctx| logical::is_not_null(input, ctx_fast()).map_err(op_err),
    ))?;

    registry.register(FnOperator::new("op:core.is_empty", |input, _args, _ctx| {
        logical::is_empty(input, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.if_null", |input, args, _ctx| {
        let fallback = get_arg(args, "fallback");
        logical::if_null(input, &fallback, ctx_fast()).map_err(op_err)
    }))?;

    // Coalesce
    registry.register(FnOperator::new("op:core.coalesce", |_input, args, _ctx| {
        let values = get_values_array(args);
        logical::coalesce(&values, ctx_fast()).map_err(op_err)
    }))?;

    // IF
    registry.register(FnOperator::new("op:core.if", |input, args, _ctx| {
        let then_val = get_arg(args, "then");
        let else_val = get_arg(args, "else");
        logical::if_then_else(input, &then_val, &else_val, ctx_fast()).map_err(op_err)
    }))?;

    // Switch
    registry.register(FnOperator::new("op:core.switch", |input, args, _ctx| {
        let cases = get_values_array(args);
        logical::switch(input, &cases, ctx_fast()).map_err(op_err)
    }))?;

    // Error handling
    registry.register(FnOperator::new("op:core.if_error", |input, args, _ctx| {
        let fallback = get_arg(args, "fallback");
        logical::if_error(input, &fallback, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.try", |input, _args, _ctx| {
        logical::try_eval(input, ctx_fast()).map_err(op_err)
    }))?;

    // Comparisons
    registry.register(FnOperator::new("op:core.eq", |input, args, _ctx| {
        let b = get_arg(args, "value");
        logical::eq(input, &b, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.equals", |input, args, _ctx| {
        let b = get_arg(args, "value");
        logical::eq(input, &b, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.in_list", |input, args, _ctx| {
        let values = get_arg(args, "values");
        ops_core::array::includes(&values, input, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.ne", |input, args, _ctx| {
        let b = get_arg(args, "value");
        logical::ne(input, &b, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new(
        "op:core.not_equals",
        |input, args, _ctx| {
            let b = get_arg(args, "value");
            logical::ne(input, &b, ctx_fast()).map_err(op_err)
        },
    ))?;

    registry.register(FnOperator::new("op:core.gt", |input, args, _ctx| {
        let b = get_arg(args, "value");
        logical::gt(input, &b, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.ge", |input, args, _ctx| {
        let b = get_arg(args, "value");
        logical::ge(input, &b, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.lt", |input, args, _ctx| {
        let b = get_arg(args, "value");
        logical::lt(input, &b, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.le", |input, args, _ctx| {
        let b = get_arg(args, "value");
        logical::le(input, &b, ctx_fast()).map_err(op_err)
    }))?;

    // Aliases
    registry.register(FnOperator::new("op:logical.and", |_input, args, _ctx| {
        let values = get_values_array(args);
        if values.is_empty() {
            return Ok(OpValue::bool(true));
        }
        logical::and_many(&values, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:logical.or", |_input, args, _ctx| {
        let values = get_values_array(args);
        if values.is_empty() {
            return Ok(OpValue::bool(false));
        }
        logical::or_many(&values, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:logical.not", |input, _args, _ctx| {
        logical::not(input, ctx_fast()).map_err(op_err)
    }))?;

    Ok(())
}

// =============================================================================
// CONVERSION OPERATORS
// =============================================================================

fn register_conversion_operators(registry: &mut OperatorRegistry) -> Result<(), RegistryError> {
    use ops_core::conversion;

    registry.register(FnOperator::new(
        "op:core.to_number",
        |input, _args, _ctx| conversion::to_number(input, ctx_fast()).map_err(op_err),
    ))?;

    registry.register(FnOperator::new("op:core.type_of", |input, _args, _ctx| {
        conversion::type_of(input, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.stringify", |input, args, _ctx| {
        let format = get_arg(args, "format");
        ops_core::serialization::stringify(input, &format, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.is_nan", |input, _args, _ctx| {
        conversion::is_nan(input, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.is_finite", |input, _args, _ctx| {
        conversion::is_finite(input, ctx_fast()).map_err(op_err)
    }))?;

    Ok(())
}

// =============================================================================
// TEXT OPERATORS
// =============================================================================

fn register_text_operators(registry: &mut OperatorRegistry) -> Result<(), RegistryError> {
    use ops_core::text;

    registry.register(FnOperator::new(
        "op:core.text_concat",
        |_input, args, _ctx| {
            let values = get_values_array(args);
            text::concat_many(&values, ctx_fast()).map_err(op_err)
        },
    ))?;

    registry.register(FnOperator::new("op:core.len", |input, _args, _ctx| {
        text::len(input, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.length", |input, _args, _ctx| {
        text::len(input, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.trim", |input, _args, _ctx| {
        text::trim(input, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new(
        "op:core.text_ltrim",
        |input, _args, _ctx| text::trim_start(input, ctx_fast()).map_err(op_err),
    ))?;

    registry.register(FnOperator::new(
        "op:core.text_rtrim",
        |input, _args, _ctx| text::trim_end(input, ctx_fast()).map_err(op_err),
    ))?;

    registry.register(FnOperator::new("op:core.upper", |input, _args, _ctx| {
        text::upper(input, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.lower", |input, _args, _ctx| {
        text::lower(input, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.text_left", |input, args, _ctx| {
        // Support both "count" and "length" as arg name for backwards compatibility
        let count = get_arg(args, "count");
        let length = get_arg(args, "length");
        let arg = if !count.is_null() { count } else { length };
        text::left(input, &arg, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new(
        "op:core.text_right",
        |input, args, _ctx| {
            // Support both "count" and "length" as arg name for backwards compatibility
            let count = get_arg(args, "count");
            let length = get_arg(args, "length");
            let arg = if !count.is_null() { count } else { length };
            text::right(input, &arg, ctx_fast()).map_err(op_err)
        },
    ))?;

    registry.register(FnOperator::new("op:core.text_mid", |input, args, _ctx| {
        let start = get_arg(args, "start");
        let length = get_arg(args, "length");
        text::substring(input, &start, &length, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.text_find", |input, args, _ctx| {
        let needle = get_arg(args, "needle");
        text::index_of(input, &needle, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new(
        "op:core.text_substitute",
        |input, args, _ctx| {
            let old = get_arg(args, "old");
            // Support both "new" and "replacement" as arg name for backwards compatibility
            let new_arg = get_arg(args, "new");
            let replacement = get_arg(args, "replacement");
            let new_val = if !new_arg.is_null() {
                new_arg
            } else {
                replacement
            };
            text::replace(input, &old, &new_val, ctx_fast()).map_err(op_err)
        },
    ))?;

    registry.register(FnOperator::new("op:core.replace", |input, args, _ctx| {
        let old = get_arg(args, "old");
        let new = get_arg(args, "new");
        text::replace(input, &old, &new, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.split", |input, args, _ctx| {
        let delimiter = get_arg(args, "delimiter");
        text::split(input, &delimiter, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.join", |input, args, _ctx| {
        let delimiter = get_arg(args, "delimiter");
        text::join(input, &delimiter, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.contains", |input, args, _ctx| {
        let value = get_arg(args, "value");
        text::contains(input, &value, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.repeat", |input, args, _ctx| {
        let count = get_arg(args, "count");
        text::repeat(input, &count, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new(
        "op:core.starts_with",
        |input, args, _ctx| {
            let prefix = get_arg(args, "prefix");
            text::starts_with(input, &prefix, ctx_fast()).map_err(op_err)
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.is_prefix_of",
        |input, args, _ctx| {
            let target = get_arg(args, "value");
            text::is_prefix_of(input, &target, ctx_fast()).map_err(op_err)
        },
    ))?;

    registry.register(FnOperator::new("op:core.ends_with", |input, args, _ctx| {
        let suffix = get_arg(args, "suffix");
        text::ends_with(input, &suffix, ctx_fast()).map_err(op_err)
    }))?;

    // -------------------------------------------------------------------------
    // op:core.format — Three modes of text formatting.
    //
    // Mode 1 (prefix/suffix): Concatenates prefix + input + suffix.
    //   Trigger: args contains "prefix" and/or "suffix" keys.
    //   Example: {"op": "op:core.format", "args": {"prefix": "label:"}}
    //   Input "template:text" → Output "label:template:text"
    //
    // Mode 2 (positional substitution): Replaces {0}, {1}, ... in template.
    //   Trigger: args contains "values" array.
    //   Example: {"op": "op:core.format", "args": {"values": ["world"]}}
    //   Input "Hello, {0}!" → Output "Hello, world!"
    //
    // Mode 3 (identity): No recognized args → returns input unchanged.
    //
    // Priority: prefix/suffix checked first. If neither key present, falls
    // through to positional substitution (which handles empty values as no-op).
    //
    // Null propagation: If input is null, returns null in all modes.
    //
    // Used by: itemTemplate child ID generation (migration 044 "label:" prefix),
    //          popover field ID generation (migration 024/036 "field:" prefix).
    // -------------------------------------------------------------------------
    registry.register(FnOperator::new("op:core.format", |input, args, _ctx| {
        // Mode 1: prefix/suffix — prepend and/or append fixed strings.
        // Checked first because migrations already use this pattern extensively.
        let prefix = get_arg_str(args, "prefix");
        let suffix = get_arg_str(args, "suffix");
        if prefix.is_some() || suffix.is_some() {
            let input_str = input.as_str_opt("text_format").map_err(op_err)?;
            return match input_str {
                Some(s) => Ok(OpValue::string(format!(
                    "{}{}{}",
                    prefix.as_deref().unwrap_or(""),
                    s,
                    suffix.as_deref().unwrap_or("")
                ))),
                None => Ok(OpValue::null()),
            };
        }
        // Mode 2: positional substitution — {0}, {1}, etc. replaced by values array.
        let values = get_values_array(args);
        text::format(input, &values, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new(
        "op:core.text_normalize",
        |input, args, _ctx| {
            let form = get_arg(args, "form");
            text::normalize(input, &form, ctx_fast()).map_err(op_err)
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.text_casefold",
        |input, _args, _ctx| text::case_fold(input, ctx_fast()).map_err(op_err),
    ))?;

    // Encoding operators - using crypto module generic encode/decode
    registry.register(FnOperator::new(
        "op:core.text_base64_encode",
        |input, _args, _ctx| {
            let enc = OpValue::string("base64");
            ops_core::crypto::encode(input, &enc, ctx_fast()).map_err(op_err)
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.text_base64_decode",
        |input, _args, _ctx| {
            let enc = OpValue::string("base64");
            ops_core::crypto::decode(input, &enc, ctx_fast()).map_err(op_err)
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.text_hex_encode",
        |input, _args, _ctx| {
            let enc = OpValue::string("hex");
            ops_core::crypto::encode(input, &enc, ctx_fast()).map_err(op_err)
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.text_hex_decode",
        |input, _args, _ctx| {
            let enc = OpValue::string("hex");
            ops_core::crypto::decode(input, &enc, ctx_fast()).map_err(op_err)
        },
    ))?;

    // URL encode/decode - simple implementations
    registry.register(FnOperator::new(
        "op:core.text_url_encode",
        |input, _args, _ctx| {
            let s = input.as_str("url_encode").map_err(op_err)?;
            let encoded = urlencoding::encode(s);
            Ok(OpValue::string(encoded))
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.text_url_decode",
        |input, _args, _ctx| {
            let s = input.as_str("url_decode").map_err(op_err)?;
            match urlencoding::decode(s) {
                Ok(decoded) => Ok(OpValue::string(decoded)),
                Err(_) => Err(err("Invalid URL-encoded string")),
            }
        },
    ))?;

    // Regex operators
    registry.register(FnOperator::new(
        "op:core.text_regex_match",
        |input, args, _ctx| {
            let pattern_str =
                get_arg_str(args, "pattern").ok_or_else(|| err("regex_match requires pattern"))?;
            let s = input.as_str("regex_match").map_err(op_err)?;
            match regex::Regex::new(&pattern_str) {
                Ok(re) => Ok(OpValue::bool(re.is_match(s))),
                Err(e) => Err(err(&format!("Invalid regex: {}", e))),
            }
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.text_regex_replace",
        |input, args, _ctx| {
            let pattern_str = get_arg_str(args, "pattern")
                .ok_or_else(|| err("regex_replace requires pattern"))?;
            let replacement = get_arg_str(args, "replacement").unwrap_or_default();
            let s = input.as_str("regex_replace").map_err(op_err)?;
            match regex::Regex::new(&pattern_str) {
                Ok(re) => Ok(OpValue::string(
                    re.replace_all(s, replacement.as_str()).to_string(),
                )),
                Err(e) => Err(err(&format!("Invalid regex: {}", e))),
            }
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.text_regex_extract",
        |input, args, _ctx| {
            let pattern = get_arg(args, "pattern");
            text::regex_extract(input, &pattern, ctx_fast()).map_err(op_err)
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.text_json_parse",
        |input, _args, _ctx| text::json_parse(input, ctx_fast()).map_err(op_err),
    ))?;

    // Pad operators
    registry.register(FnOperator::new(
        "op:core.text_pad_start",
        |input, args, _ctx| {
            let s = input.as_str("pad_start").map_err(op_err)?;
            let target_len = get_arg_i64(args, "length").unwrap_or(0) as usize;
            let pad_char = get_arg_str(args, "pad").unwrap_or_else(|| " ".to_string());
            let pad = pad_char.chars().next().unwrap_or(' ');
            let current_len = s.chars().count();
            if current_len >= target_len {
                Ok(OpValue::string(s))
            } else {
                let padding: String = std::iter::repeat_n(pad, target_len - current_len).collect();
                Ok(OpValue::string(format!("{}{}", padding, s)))
            }
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.text_pad_end",
        |input, args, _ctx| {
            let s = input.as_str("pad_end").map_err(op_err)?;
            let target_len = get_arg_i64(args, "length").unwrap_or(0) as usize;
            let pad_char = get_arg_str(args, "pad").unwrap_or_else(|| " ".to_string());
            let pad = pad_char.chars().next().unwrap_or(' ');
            let current_len = s.chars().count();
            if current_len >= target_len {
                Ok(OpValue::string(s))
            } else {
                let padding: String = std::iter::repeat_n(pad, target_len - current_len).collect();
                Ok(OpValue::string(format!("{}{}", s, padding)))
            }
        },
    ))?;

    // Aliases
    registry.register(FnOperator::new(
        "op:text.uppercase",
        |input, _args, _ctx| text::upper(input, ctx_fast()).map_err(op_err),
    ))?;

    registry.register(FnOperator::new(
        "op:text.lowercase",
        |input, _args, _ctx| text::lower(input, ctx_fast()).map_err(op_err),
    ))?;

    Ok(())
}

// =============================================================================
// ARRAY OPERATORS
// =============================================================================

fn register_array_operators(registry: &mut OperatorRegistry) -> Result<(), RegistryError> {
    use ops_core::array;

    registry.register(FnOperator::new(
        "op:core.array_length",
        |input, _args, _ctx| array::length(input, ctx_fast()).map_err(op_err),
    ))?;

    registry.register(FnOperator::new("op:core.array_get", |input, args, _ctx| {
        let index = get_arg(args, "index");
        array::nth(input, &index, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new(
        "op:core.array_first",
        |input, _args, _ctx| array::first(input, ctx_fast()).map_err(op_err),
    ))?;

    registry.register(FnOperator::new(
        "op:core.array_last",
        |input, _args, _ctx| array::last(input, ctx_fast()).map_err(op_err),
    ))?;

    registry.register(FnOperator::new(
        "op:core.array_reverse",
        |input, _args, _ctx| array::reverse(input, ctx_fast()).map_err(op_err),
    ))?;

    registry.register(FnOperator::new(
        "op:core.array_unique",
        |input, _args, _ctx| array::unique(input, ctx_fast()).map_err(op_err),
    ))?;

    registry.register(FnOperator::new(
        "op:core.array_flatten",
        |input, _args, _ctx| array::flatten(input, ctx_fast()).map_err(op_err),
    ))?;

    registry.register(FnOperator::new(
        "op:core.array_slice",
        |input, args, _ctx| {
            let start = get_arg(args, "start");
            let end = get_arg(args, "end");
            array::slice(input, &start, &end, ctx_fast()).map_err(op_err)
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.array_contains",
        |input, args, _ctx| {
            let value = get_arg(args, "value");
            array::includes(input, &value, ctx_fast()).map_err(op_err)
        },
    ))?;

    registry.register(FnOperator::new("op:core.index_of", |input, args, _ctx| {
        let value = get_arg(args, "value");
        array::index_of(input, &value, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.lookup", |input, args, _ctx| {
        let key = get_arg(args, "key");
        let fallback = get_arg(args, "fallback");
        let fallback_opt = if fallback.is_null() {
            None
        } else {
            Some(&fallback)
        };
        array::lookup(input, &key, fallback_opt, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.set", |input, args, _ctx| {
        let key = get_arg(args, "key");
        let value = get_arg(args, "value");
        ops_core::structure::set(input, &key, &value, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new(
        "op:core.array_find_by",
        |input, args, _ctx| {
            let field = get_arg(args, "field");
            let value = get_arg(args, "value");
            array::find_by(input, &field, &value, ctx_fast()).map_err(op_err)
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.array_sort_by",
        |input, args, _ctx| {
            let field = get_arg(args, "field");
            let direction = get_arg(args, "direction");
            array::sort_by(input, &field, &direction, ctx_fast()).map_err(op_err)
        },
    ))?;

    // =========================================================================
    // PATH TRAVERSAL - op:core.get_path
    // =========================================================================
    //
    // Dynamic path traversal for objects/arrays. This is the CANONICAL way to
    // access nested properties when the path is determined at runtime (e.g.,
    // from a binding like $item.target_property).
    //
    // Usage:
    //   Input: {"style": {"padding": 8}}
    //   Args:  {"path": "style.padding"}
    //   Output: 8
    //
    // Supports:
    //   - Dotted notation: "style.padding" → obj["style"]["padding"]
    //   - Array indices: "items.0.name" → obj["items"][0]["name"]
    //   - Mixed paths: "children.0.props.text"
    //
    // Returns null if path not found (no errors thrown).
    // =========================================================================
    registry.register(FnOperator::new("op:core.get_path", |input, args, _ctx| {
        let path = get_arg(args, "path");
        let fallback = get_arg(args, "fallback");

        // Path must be a string
        let path_str = match path.as_str_opt("get_path") {
            Ok(Some(s)) => s,
            Ok(None) => return Ok(fallback), // null path → return fallback
            Err(_) => return Ok(fallback),   // non-string path → return fallback
        };

        let result = input.get_path(path_str);

        // If result is null and we have a fallback, use fallback
        if result.is_null() && !fallback.is_null() {
            Ok(fallback)
        } else {
            Ok(result)
        }
    }))?;

    // Size - works on arrays, strings, objects
    registry.register(FnOperator::new(
        "op:core.size",
        |input, _args, _ctx| match input.as_inner() {
            serde_json::Value::Array(arr) => Ok(OpValue::from_usize(arr.len())),
            serde_json::Value::String(s) => Ok(OpValue::from_usize(s.chars().count())),
            serde_json::Value::Object(obj) => Ok(OpValue::from_usize(obj.len())),
            serde_json::Value::Null => Ok(OpValue::from_usize(0)),
            _ => Ok(OpValue::from_usize(1)),
        },
    ))?;

    // Count the items a chain holds for (`where`), or one of the ready-made chains `predicate` names
    registry.register(FnOperator::new("op:core.array_count_if", each_item::count_if).with_nested_arguments())?;

    // A chain run on each item of a list: keep, take the first, splice, or pick a path
    registry.register(FnOperator::new("op:core.filter_where", each_item::filter_where).with_nested_arguments())?;
    registry.register(FnOperator::new("op:core.find_where", each_item::find_where).with_nested_arguments())?;
    registry.register(FnOperator::new("op:core.flat_map", each_item::flat_map).with_nested_arguments())?;
    registry.register(FnOperator::new("op:core.map", each_item::map_path))?;
    registry.register(FnOperator::new("op:core.reduce", each_item::reduce).with_nested_arguments())?;

    registry.register(FnOperator::new("op:core.append", |input, args, _ctx| {
        array::append(input, &get_arg(args, "value"), ctx_fast()).map_err(op_err)
    }))?;
    registry.register(FnOperator::new("op:core.concat_arrays", |input, args, _ctx| {
        array::concat_arrays(input, &get_arg(args, "value"), ctx_fast()).map_err(op_err)
    }))?;
    registry.register(FnOperator::new("op:core.take", |input, args, _ctx| {
        array::take(input, &get_arg(args, "count"), ctx_fast()).map_err(op_err)
    }))?;

    // MAP_TO_NODES - uses separate module with eager evaluation
    registry.register(FnOperator::new(
        "op:core.map_to_nodes",
        map_to_nodes::op_map_to_nodes,
    ).with_nested_arguments())?;

    // Alias - return integer for compatibility with test expectations
    registry.register(FnOperator::new("op:array.length", |input, _args, _ctx| {
        let arr = input.as_array_or_null("length").map_err(op_err)?;
        match arr {
            Some(a) => Ok(OpValue::from_i64(a.len() as i64)),
            None => Ok(OpValue::from_i64(0)),
        }
    }))?;

    Ok(())
}

// =============================================================================
// DATETIME OPERATORS
// =============================================================================

fn register_datetime_operators(registry: &mut OperatorRegistry) -> Result<(), RegistryError> {
    use ops_core::datetime;

    registry.register(FnOperator::new("op:core.dt_now", |_input, args, _ctx| {
        let tz = get_arg(args, "timezone");
        if tz.is_null() {
            datetime::now(ctx_fast()).map_err(op_err)
        } else {
            datetime::now_tz(&tz, ctx_fast()).map_err(op_err)
        }
    }))?;

    registry.register(FnOperator::new("op:core.dt_date", |_input, args, _ctx| {
        let year = get_arg(args, "year");
        let month = get_arg(args, "month");
        let day = get_arg(args, "day");
        datetime::make_date(&year, &month, &day, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.dt_time", |_input, args, _ctx| {
        let hour = get_arg(args, "hour");
        let minute = get_arg(args, "minute");
        let second = get_arg(args, "second");
        datetime::make_time(&hour, &minute, &second, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new(
        "op:core.dt_datetime",
        |_input, args, _ctx| {
            let year = get_arg(args, "year");
            let month = get_arg(args, "month");
            let day = get_arg(args, "day");
            let hour = get_arg(args, "hour");
            let minute = get_arg(args, "minute");
            let second = get_arg(args, "second");
            let tz = get_arg(args, "timezone");
            datetime::make_datetime(
                &year,
                &month,
                &day,
                &hour,
                &minute,
                &second,
                &tz,
                ctx_fast(),
            )
            .map_err(op_err)
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.dt_dateadd",
        |input, args, _ctx| {
            let amount = get_arg(args, "amount");
            let unit = get_arg(args, "unit");
            datetime::date_add(input, &amount, &unit, ctx_fast()).map_err(op_err)
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.dt_datediff",
        |input, args, _ctx| {
            let other = get_arg(args, "other");
            let unit = get_arg(args, "unit");
            datetime::date_diff(input, &other, &unit, ctx_fast()).map_err(op_err)
        },
    ))?;

    registry.register(FnOperator::new("op:core.extract", |input, args, _ctx| {
        let unit = get_arg(args, "unit");
        datetime::extract(input, &unit, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new(
        "op:core.dt_weekday",
        |input, args, _ctx| {
            let tz = get_arg(args, "timezone");
            datetime::weekday(input, &tz, ctx_fast()).map_err(op_err)
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.dt_timestamp",
        |input, _args, _ctx| datetime::timestamp(input, ctx_fast()).map_err(op_err),
    ))?;

    registry.register(FnOperator::new(
        "op:core.dt_from_timestamp",
        |input, args, _ctx| {
            let tz = get_arg(args, "timezone");
            if tz.is_null() {
                datetime::from_timestamp(input, ctx_fast()).map_err(op_err)
            } else {
                datetime::from_timestamp_tz(input, &tz, ctx_fast()).map_err(op_err)
            }
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.dt_convert_tz",
        |input, args, _ctx| {
            let from_tz = get_arg(args, "from_timezone");
            let to_tz = get_arg(args, "to_timezone");
            datetime::convert_tz(input, &from_tz, &to_tz, ctx_fast()).map_err(op_err)
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.dt_user_tz",
        |_input, _args, _ctx| datetime::user_tz(ctx_fast()).map_err(op_err),
    ))?;

    // Additional datetime ops using chrono
    registry.register(FnOperator::new(
        "op:core.dt_iso_week",
        |input, _args, _ctx| {
            let s = input.as_str("iso_week").map_err(op_err)?;
            if s.len() >= 10 {
                if let Ok(date) = chrono::NaiveDate::parse_from_str(&s[..10], "%Y-%m-%d") {
                    use chrono::Datelike;
                    return Ok(OpValue::from_i64(date.iso_week().week() as i64));
                }
            }
            Err(err("Invalid date format for iso_week"))
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.dt_iso_week_year",
        |input, _args, _ctx| {
            let s = input.as_str("iso_week_year").map_err(op_err)?;
            if s.len() >= 10 {
                if let Ok(date) = chrono::NaiveDate::parse_from_str(&s[..10], "%Y-%m-%d") {
                    use chrono::Datelike;
                    return Ok(OpValue::from_i64(date.iso_week().year() as i64));
                }
            }
            Err(err("Invalid date format for iso_week_year"))
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.dt_quarter",
        |input, _args, _ctx| {
            let s = input.as_str("quarter").map_err(op_err)?;
            if s.len() >= 10 {
                if let Ok(date) = chrono::NaiveDate::parse_from_str(&s[..10], "%Y-%m-%d") {
                    use chrono::Datelike;
                    let quarter = (date.month() - 1) / 3 + 1;
                    return Ok(OpValue::from_i64(quarter as i64));
                }
            }
            Err(err("Invalid date format for quarter"))
        },
    ))?;

    registry.register(FnOperator::new(
        "op:core.dt_day_of_year",
        |input, _args, _ctx| {
            let s = input.as_str("day_of_year").map_err(op_err)?;
            if s.len() >= 10 {
                if let Ok(date) = chrono::NaiveDate::parse_from_str(&s[..10], "%Y-%m-%d") {
                    use chrono::Datelike;
                    return Ok(OpValue::from_i64(date.ordinal() as i64));
                }
            }
            Err(err("Invalid date format for day_of_year"))
        },
    ))?;

    // A datetime written with a chrono `format`, on the wall clock of `timezone` when given
    registry.register(FnOperator::new("op:core.dt_format", |input, args, _ctx| {
        let format = get_arg(args, "format");
        let tz = get_arg(args, "timezone");
        datetime::format_date_tz(input, &format, &tz, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.dt_format_time", |input, args, _ctx| {
        let format = get_arg(args, "format");
        let tz = get_arg(args, "timezone");
        datetime::format_time(input, &format, &tz, ctx_fast()).map_err(op_err)
    }))?;

    // The first and the last whole second of the `unit` holding the value, read on the `timezone` wall clock
    registry.register(FnOperator::new("op:core.dt_start_of", |input, args, _ctx| {
        let unit = get_arg(args, "unit");
        let tz = get_arg(args, "timezone");
        datetime::start_of(input, &unit, &tz, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.dt_end_of", |input, args, _ctx| {
        let unit = get_arg(args, "unit");
        let tz = get_arg(args, "timezone");
        datetime::end_of(input, &unit, &tz, ctx_fast()).map_err(op_err)
    }))?;

    // Monday-to-Friday days from the value to `end`, both counted, less the `holidays` (dates) among them
    registry.register(FnOperator::new("op:core.dt_workdays", |input, args, _ctx| {
        let end = get_arg(args, "end");
        let holidays = get_arg(args, "holidays");
        datetime::workdays(input, &end, &holidays, ctx_fast()).map_err(op_err)
    }))?;

    Ok(())
}

// =============================================================================
// CRYPTO OPERATORS
// =============================================================================

fn register_crypto_operators(registry: &mut OperatorRegistry) -> Result<(), RegistryError> {
    use ops_core::crypto;

    // Generic hash operator: hash(input, algorithm) -> string
    registry.register(FnOperator::new("op:core.hash", |input, args, _ctx| {
        let algo = get_arg(args, "algorithm");
        crypto::hash(input, &algo, ctx_fast()).map_err(op_err)
    }))?;

    // Generic encode operator: encode(input, encoding) -> string
    registry.register(FnOperator::new("op:core.encode", |input, args, _ctx| {
        let enc = get_arg(args, "encoding");
        crypto::encode(input, &enc, ctx_fast()).map_err(op_err)
    }))?;

    // Generic decode operator: decode(input, encoding) -> string
    registry.register(FnOperator::new("op:core.decode", |input, args, _ctx| {
        let enc = get_arg(args, "encoding");
        crypto::decode(input, &enc, ctx_fast()).map_err(op_err)
    }))?;

    registry.register(FnOperator::new(
        "op:core.crypto_uuid",
        |_input, _args, _ctx| {
            Err(err(
                "UUID generation not available in pure evaluation context",
            ))
        },
    ))?;

    // Keyed message code of the value with `key` (`algorithm` sha256 or sha512, `encoding` hex or base64)
    registry.register(FnOperator::new("op:core.hmac", |input, args, _ctx| {
        let key = get_arg(args, "key");
        let algo = get_arg(args, "algorithm");
        let enc = get_arg(args, "encoding");
        crypto::hmac(input, &key, &algo, &enc, ctx_fast()).map_err(op_err)
    }))?;

    Ok(())
}

// =============================================================================
// GRAPH OPERATORS
// =============================================================================

/// The evaluation context for one graph call: the fast context with the graph of the `edges` argument (kept to the
/// `relationship` given, when one is).
fn ctx_with_edges(args: Option<&OpValue>, relationship: &OpValue) -> Result<EvalContext, Diagnostic> {
    let graph = ops_core::graph::graph_of_edges(&get_arg(args, "edges"), relationship).map_err(op_err)?;
    let mut ctx = ctx_fast().clone();
    ctx.graph = Some(std::sync::Arc::new(graph));
    Ok(ctx)
}

fn register_graph_operators(registry: &mut OperatorRegistry) -> Result<(), RegistryError> {
    use ops_core::graph;

    // The nodes linked to the value by `edges` (each `{from, to, type?}` or `[from, to]`), one link kind when
    // `relationship` names it: what points at it, what it points at, both, and where a `path` such as
    // "project->task<-person" ends.
    registry.register(FnOperator::new("op:core.graph_parents", |input, args, _ctx| {
        let relationship = get_arg(args, "relationship");
        let ctx = ctx_with_edges(args, &relationship)?;
        let label = if relationship.is_null() { OpValue::string("") } else { relationship };
        graph::parents(input, &label, &ctx).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.graph_children", |input, args, _ctx| {
        let relationship = get_arg(args, "relationship");
        let ctx = ctx_with_edges(args, &relationship)?;
        let label = if relationship.is_null() { OpValue::string("") } else { relationship };
        graph::children(input, &label, &ctx).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.graph_neighbors", |input, args, _ctx| {
        let ctx = ctx_with_edges(args, &get_arg(args, "relationship"))?;
        graph::neighbors(input, &ctx).map_err(op_err)
    }))?;

    registry.register(FnOperator::new("op:core.graph_traverse", |input, args, _ctx| {
        let ctx = ctx_with_edges(args, &OpValue::null())?;
        graph::traverse(input, &get_arg(args, "path"), &ctx).map_err(op_err)
    }))?;

    Ok(())
}

// =============================================================================
// TESTS
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_registry() {
        let registry = create_core_registry().unwrap();
        assert!(registry.len() > 50, "Should have many operators registered");
    }

    #[test]
    fn test_math_add() {
        let registry = create_core_registry().unwrap();
        let op = registry.get("op:core.add").unwrap();
        let ctx = OperatorContext::new(Default::default(), "op:core.add", 0);

        let input = OpValue::number(5.0);
        let args = OpValue::from(serde_json::json!({"value": 3}));
        let result = op.apply(&input, Some(&args), &ctx).unwrap();

        // In strict mode, result may be Decimal (serialized as string) or number
        // Check semantic equality rather than exact JSON representation
        let result_num: f64 = match result.as_inner() {
            serde_json::Value::Number(n) => n.as_f64().unwrap(),
            serde_json::Value::String(s) => s.parse().unwrap(),
            _ => panic!("Expected number or string, got {:?}", result.as_inner()),
        };
        assert!(
            (result_num - 8.0).abs() < 0.001,
            "Expected 8, got {}",
            result_num
        );
    }

    #[test]
    fn test_logical_eq() {
        let registry = create_core_registry().unwrap();
        let op = registry.get("op:core.eq").unwrap();
        let ctx = OperatorContext::new(Default::default(), "op:core.eq", 0);

        let input = OpValue::number(42.0);
        let args = OpValue::from(serde_json::json!({"value": 42}));
        let result = op.apply(&input, Some(&args), &ctx).unwrap();

        assert_eq!(result.as_inner(), serde_json::json!(true));
    }

    #[test]
    fn test_logical_not_equals_alias() {
        let registry = create_core_registry().unwrap();
        let op = registry.get("op:core.not_equals").unwrap();
        let ctx = OperatorContext::new(Default::default(), "op:core.not_equals", 0);

        let input = OpValue::number(42.0);
        let args = OpValue::from(serde_json::json!({"value": 7}));
        let result = op.apply(&input, Some(&args), &ctx).unwrap();

        assert_eq!(result.as_inner(), serde_json::json!(true));
    }

    #[test]
    fn test_stringify_delegates_to_existing_serialization_primitive() {
        let registry = create_core_registry().unwrap();
        let op = registry.get("op:core.stringify").unwrap();
        let ctx = OperatorContext::new(Default::default(), "op:core.stringify", 0);

        let input = OpValue::from(serde_json::json!({"title": "Chat"}));
        let args = OpValue::from(serde_json::json!({"format": "json"}));
        let result = op.apply(&input, Some(&args), &ctx).unwrap();

        assert_eq!(result.as_inner(), serde_json::json!("{\"title\":\"Chat\"}"));
    }

    #[test]
    fn test_set_delegates_to_existing_structure_primitive() {
        let registry = create_core_registry().unwrap();
        let op = registry.get("op:core.set").unwrap();
        let ctx = OperatorContext::new(Default::default(), "op:core.set", 0);

        let input = OpValue::from(serde_json::json!({"title": "Chat"}));
        let args = OpValue::from(serde_json::json!({"key": "score", "value": 8}));
        let result = op.apply(&input, Some(&args), &ctx).unwrap();

        assert_eq!(
            result.as_inner(),
            serde_json::json!({"title": "Chat", "score": 8})
        );
    }

    #[test]
    fn test_logical_in_list() {
        let registry = create_core_registry().unwrap();
        let op = registry.get("op:core.in_list").unwrap();
        let ctx = OperatorContext::new(Default::default(), "op:core.in_list", 0);

        let input = OpValue::from(serde_json::json!("prop:settings:onboarded"));
        let args = OpValue::from(serde_json::json!({
            "values": ["prop:settings:onboarded", "prop:settings:theme"]
        }));
        let result = op.apply(&input, Some(&args), &ctx).unwrap();

        assert_eq!(result.as_inner(), serde_json::json!(true));
    }

    #[test]
    fn test_text_upper() {
        let registry = create_core_registry().unwrap();
        let op = registry.get("op:core.upper").unwrap();
        let ctx = OperatorContext::new(Default::default(), "op:core.upper", 0);

        let input = OpValue::string("hello");
        let result = op.apply(&input, None, &ctx).unwrap();

        assert_eq!(result.as_inner(), serde_json::json!("HELLO"));
    }

    #[test]
    fn series_operators_are_registered_and_read_their_args() {
        let registry = create_core_registry().unwrap();
        let run = |name: &str, input: serde_json::Value, args: serde_json::Value| {
            let op = registry.get(name).unwrap();
            let ctx = OperatorContext::new(Default::default(), name, 0);
            op.apply(&OpValue::from(input), Some(&OpValue::from(args)), &ctx).unwrap().as_inner()
        };
        let p90 = run("op:core.quantile", serde_json::json!([5, 1, 9, 3, 7]), serde_json::json!({"q": 0.9}));
        assert!((p90.as_f64().unwrap() - 8.2).abs() < 1e-9, "{p90}");
        let weighted = run("op:core.weighted_count", serde_json::json!(["goal", "pass", "goal"]), serde_json::json!({"weights": {"goal": 3}}));
        assert_eq!(weighted.as_f64(), Some(7.0));
        let streak = run(
            "op:core.streak",
            serde_json::json!(["2026-11-12", "2026-11-13"]),
            serde_json::json!({"period": "day", "times": 1, "now": "2026-11-13T10:00:00Z"}),
        );
        assert_eq!(streak.as_i64(), Some(2));
        let longest = run(
            "op:core.longest_streak",
            serde_json::json!(["2026-11-01", "2026-11-02", "2026-11-09"]),
            serde_json::json!({"period": "day", "times": 1}),
        );
        assert_eq!(longest.as_i64(), Some(2));
        assert_eq!(run("op:core.variance", serde_json::json!([2, 4, 4, 4, 5, 5, 7, 9]), serde_json::json!({})).as_f64(), Some(4.0));
        assert_eq!(run("op:core.stdev", serde_json::json!([2, 4, 4, 4, 5, 5, 7, 9]), serde_json::json!({})).as_f64(), Some(2.0));
        let bins = run("op:core.histogram", serde_json::json!([1, 6, 7, 12]), serde_json::json!({"edges": [0, 5, 10]}));
        assert_eq!(bins, serde_json::json!([1, 2]));
    }

    #[test]
    fn test_array_length() {
        let registry = create_core_registry().unwrap();
        let op = registry.get("op:core.array_length").unwrap();
        let ctx = OperatorContext::new(Default::default(), "op:core.array_length", 0);

        let input = OpValue::from(serde_json::json!([1, 2, 3, 4, 5]));
        let result = op.apply(&input, None, &ctx).unwrap();

        // array::length returns f64, so compare numerically
        let result_num = result.as_inner().as_f64().unwrap();
        assert!(
            (result_num - 5.0).abs() < 0.001,
            "Expected 5, got {}",
            result_num
        );
    }

    #[test]
    fn test_identity() {
        let registry = create_core_registry().unwrap();
        let op = registry.get("op:core.identity").unwrap();
        let ctx = OperatorContext::new(Default::default(), "op:core.identity", 0);

        let input = OpValue::from(serde_json::json!({"foo": "bar"}));
        let result = op.apply(&input, None, &ctx).unwrap();

        assert_eq!(result.as_inner(), input.as_inner());
    }

    // =========================================================================
    // op:core.format — prefix/suffix/positional conformance tests
    // =========================================================================

    #[test]
    fn test_text_format_prefix() {
        let registry = create_core_registry().unwrap();
        let op = registry.get("op:core.format").unwrap();
        let ctx = OperatorContext::new(Default::default(), "op:core.format", 0);

        let input = OpValue::string("template:text");
        let args = OpValue::from(serde_json::json!({"prefix": "label:"}));
        let result = op.apply(&input, Some(&args), &ctx).unwrap();

        assert_eq!(result.as_inner(), serde_json::json!("label:template:text"));
    }

    #[test]
    fn test_text_format_suffix() {
        let registry = create_core_registry().unwrap();
        let op = registry.get("op:core.format").unwrap();
        let ctx = OperatorContext::new(Default::default(), "op:core.format", 0);

        let input = OpValue::string("template:text");
        let args = OpValue::from(serde_json::json!({"suffix": ":label"}));
        let result = op.apply(&input, Some(&args), &ctx).unwrap();

        assert_eq!(result.as_inner(), serde_json::json!("template:text:label"));
    }

    #[test]
    fn test_text_format_prefix_and_suffix() {
        let registry = create_core_registry().unwrap();
        let op = registry.get("op:core.format").unwrap();
        let ctx = OperatorContext::new(Default::default(), "op:core.format", 0);

        let input = OpValue::string("name");
        let args = OpValue::from(serde_json::json!({"prefix": "field:", "suffix": ":input"}));
        let result = op.apply(&input, Some(&args), &ctx).unwrap();

        assert_eq!(result.as_inner(), serde_json::json!("field:name:input"));
    }

    #[test]
    fn test_text_format_prefix_null_input_returns_null() {
        let registry = create_core_registry().unwrap();
        let op = registry.get("op:core.format").unwrap();
        let ctx = OperatorContext::new(Default::default(), "op:core.format", 0);

        let input = OpValue::null();
        let args = OpValue::from(serde_json::json!({"prefix": "label:"}));
        let result = op.apply(&input, Some(&args), &ctx).unwrap();

        assert_eq!(result.as_inner(), serde_json::json!(null));
    }

    #[test]
    fn test_text_format_positional_substitution() {
        let registry = create_core_registry().unwrap();
        let op = registry.get("op:core.format").unwrap();
        let ctx = OperatorContext::new(Default::default(), "op:core.format", 0);

        let input = OpValue::string("Hello, {0}!");
        let args = OpValue::from(serde_json::json!({"values": ["world"]}));
        let result = op.apply(&input, Some(&args), &ctx).unwrap();

        assert_eq!(result.as_inner(), serde_json::json!("Hello, world!"));
    }

    #[test]
    fn test_text_format_no_args_identity() {
        let registry = create_core_registry().unwrap();
        let op = registry.get("op:core.format").unwrap();
        let ctx = OperatorContext::new(Default::default(), "op:core.format", 0);

        let input = OpValue::string("unchanged");
        let result = op.apply(&input, None, &ctx).unwrap();

        assert_eq!(result.as_inner(), serde_json::json!("unchanged"));
    }

    #[test]
    fn test_text_format_prefix_migration_044_pattern() {
        // Exact pattern from migration 044_template_entities.sql line 1177:
        // {"op": "op:core.format", "args": {"prefix": "label:"}}
        // Applied to each template item's $item.id to generate unique child IDs.
        let registry = create_core_registry().unwrap();
        let op = registry.get("op:core.format").unwrap();
        let ctx = OperatorContext::new(Default::default(), "op:core.format", 0);

        let args = OpValue::from(serde_json::json!({"prefix": "label:"}));

        // All 5 seed template IDs must produce unique prefixed IDs
        for template_id in &[
            "template:container",
            "template:text",
            "template:heading",
            "template:button",
            "template:divider",
        ] {
            let input = OpValue::string(*template_id);
            let result = op.apply(&input, Some(&args), &ctx).unwrap();
            let expected = format!("label:{}", template_id);
            assert_eq!(
                result.as_inner(),
                serde_json::json!(expected),
                "prefix must prepend 'label:' to '{}'",
                template_id
            );
        }
    }

    #[test]
    fn test_text_format_prefix_migration_024_field_pattern() {
        // Exact pattern from migration 024_editor_ui_scene.sql line 766:
        // {"op": "op:core.format", "args": {"prefix": "field:"}}
        // Applied to popover field IDs to generate unique container/label/input IDs.
        let registry = create_core_registry().unwrap();
        let op = registry.get("op:core.format").unwrap();
        let ctx = OperatorContext::new(Default::default(), "op:core.format", 0);

        let input = OpValue::string("prop:layout:background_color");

        // "field:" prefix
        let args = OpValue::from(serde_json::json!({"prefix": "field:"}));
        let result = op.apply(&input, Some(&args), &ctx).unwrap();
        assert_eq!(
            result.as_inner(),
            serde_json::json!("field:prop:layout:background_color")
        );

        // "field:label:" prefix
        let args = OpValue::from(serde_json::json!({"prefix": "field:label:"}));
        let result = op.apply(&input, Some(&args), &ctx).unwrap();
        assert_eq!(
            result.as_inner(),
            serde_json::json!("field:label:prop:layout:background_color")
        );

        // "field:input:" prefix
        let args = OpValue::from(serde_json::json!({"prefix": "field:input:"}));
        let result = op.apply(&input, Some(&args), &ctx).unwrap();
        assert_eq!(
            result.as_inner(),
            serde_json::json!("field:input:prop:layout:background_color")
        );
    }
}
