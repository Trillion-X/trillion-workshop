//! crates/pointillist-film-core/src/field.rs
//!
//! Generic serializable scalar-expression composition primitives.

use serde::{Deserialize, Serialize};

use crate::validation::{ensure_finite, FilmError, FilmResult};

const MAX_SCALAR_EXPRESSION_DEPTH: u8 = 64;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScalarContext {
    pub channels: Vec<f32>,
}

impl ScalarContext {
    pub fn single(input: f32) -> Self {
        Self {
            channels: vec![input],
        }
    }

    pub fn channel(&self, index: u8) -> FilmResult<f32> {
        let value =
            self.channels
                .get(index as usize)
                .copied()
                .ok_or(FilmError::ScalarInputOutOfRange {
                    index,
                    channel_count: self.channels.len(),
                })?;
        ensure_finite("field.context.channel", value)?;
        Ok(value)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScalarFieldCombiner {
    Max,
    Sum,
    SumClamped,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScalarUnaryOp {
    Abs,
    Negate,
    Sine,
    Cosine,
    Exponential,
    Floor,
    Ceil,
    Round,
    Fract,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScalarBinaryOp {
    Add,
    Subtract,
    Multiply,
    Divide,
    Power,
    Minimum,
    Maximum,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScalarExpression {
    Input,
    Channel {
        index: u8,
    },
    Constant {
        value: f32,
    },
    Unary {
        op: ScalarUnaryOp,
        value: Box<ScalarExpression>,
    },
    Binary {
        op: ScalarBinaryOp,
        left: Box<ScalarExpression>,
        right: Box<ScalarExpression>,
    },
    Clamp {
        value: Box<ScalarExpression>,
        min: Box<ScalarExpression>,
        max: Box<ScalarExpression>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScalarField {
    pub terms: Vec<ScalarExpression>,
    pub combiner: ScalarFieldCombiner,
}

pub fn scalar_field_value(field: &ScalarField, input: f32) -> FilmResult<f32> {
    scalar_field_value_with_context(field, &ScalarContext::single(input))
}

pub fn scalar_field_value_with_context(
    field: &ScalarField,
    context: &ScalarContext,
) -> FilmResult<f32> {
    for channel in &context.channels {
        ensure_finite("field.context.channel", *channel)?;
    }
    if field.terms.is_empty() {
        return Ok(0.0);
    }

    let mut output: f32 = 0.0;

    for term in &field.terms {
        let value = expression_value(term, context, 0)?;
        output = match field.combiner {
            ScalarFieldCombiner::Max => output.max(value),
            ScalarFieldCombiner::Sum | ScalarFieldCombiner::SumClamped => output + value,
        };
    }

    let output = match field.combiner {
        ScalarFieldCombiner::Max | ScalarFieldCombiner::Sum => output,
        ScalarFieldCombiner::SumClamped => clamp(output, 0.0, 1.0),
    };
    ensure_finite("field.output", output)?;
    Ok(output)
}

fn expression_value(
    expression: &ScalarExpression,
    context: &ScalarContext,
    depth: u8,
) -> FilmResult<f32> {
    if depth > MAX_SCALAR_EXPRESSION_DEPTH {
        return Err(FilmError::InvalidLimit("scalar expression depth"));
    }

    let value = match expression {
        ScalarExpression::Input => context.channel(0)?,
        ScalarExpression::Channel { index } => context.channel(*index)?,
        ScalarExpression::Constant { value } => {
            ensure_finite("field.expression.constant", *value)?;
            *value
        }
        ScalarExpression::Unary { op, value } => {
            let value = expression_value(value, context, depth + 1)?;
            match op {
                ScalarUnaryOp::Abs => value.abs(),
                ScalarUnaryOp::Negate => -value,
                ScalarUnaryOp::Sine => value.sin(),
                ScalarUnaryOp::Cosine => value.cos(),
                ScalarUnaryOp::Exponential => value.exp(),
                ScalarUnaryOp::Floor => value.floor(),
                ScalarUnaryOp::Ceil => value.ceil(),
                ScalarUnaryOp::Round => value.round(),
                ScalarUnaryOp::Fract => value.fract(),
            }
        }
        ScalarExpression::Binary { op, left, right } => {
            let left = expression_value(left, context, depth + 1)?;
            let right = expression_value(right, context, depth + 1)?;
            match op {
                ScalarBinaryOp::Add => left + right,
                ScalarBinaryOp::Subtract => left - right,
                ScalarBinaryOp::Multiply => left * right,
                ScalarBinaryOp::Divide => {
                    ensure_not_zero("field.expression.divisor", right)?;
                    left / right
                }
                ScalarBinaryOp::Power => left.powf(right),
                ScalarBinaryOp::Minimum => left.min(right),
                ScalarBinaryOp::Maximum => left.max(right),
            }
        }
        ScalarExpression::Clamp { value, min, max } => {
            let value = expression_value(value, context, depth + 1)?;
            let min = expression_value(min, context, depth + 1)?;
            let max = expression_value(max, context, depth + 1)?;
            if min > max {
                return Err(FilmError::ScalarOutOfRange {
                    field: "field.expression.clamp_min",
                    value: min,
                    min: f32::NEG_INFINITY,
                    max,
                });
            }
            clamp(value, min, max)
        }
    };

    ensure_finite("field.expression.output", value)?;
    Ok(value)
}

fn ensure_not_zero(field: &'static str, value: f32) -> FilmResult<()> {
    ensure_finite(field, value)?;
    if value.abs() <= f32::MIN_POSITIVE {
        return Err(FilmError::ScalarOutOfRange {
            field,
            value,
            min: f32::MIN_POSITIVE,
            max: f32::INFINITY,
        });
    }
    Ok(())
}

fn clamp(value: f32, min: f32, max: f32) -> f32 {
    value.min(max).max(min)
}
