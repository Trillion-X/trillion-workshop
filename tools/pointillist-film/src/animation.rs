//! crates/pointillist-film-core/src/animation.rs
//!
//! Deterministic target-animation encoding for direct byte-surface consumers.

use serde::{Deserialize, Serialize};

use crate::config::FilmConfig;
use crate::field::{
    ScalarBinaryOp, ScalarExpression, ScalarField, ScalarFieldCombiner, ScalarUnaryOp,
};
use crate::target::CellStyle;
use crate::timeline::{FilmScript, TargetSample, TimelineSegment};
use crate::validation::{ensure_finite, FilmError, FilmResult};

const ANIMATION_MAGIC: &[u8; 4] = b"PFAT";
const ANIMATION_VERSION: u16 = 2;
const HEADER_BYTES: usize = 16;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TargetAnimationRequest {
    pub config: FilmConfig,
    pub script: FilmScript,
    pub frame_rate: u16,
}

impl TargetAnimationRequest {
    pub fn target_animation_bytes(&self) -> FilmResult<Vec<u8>> {
        encode_target_animation(self)
    }
}

pub fn encode_target_animation(request: &TargetAnimationRequest) -> FilmResult<Vec<u8>> {
    request.config.validate()?;
    request.script.validate(&request.config)?;
    validate_frame_rate(request.frame_rate)?;

    let columns = u16::try_from(request.config.grid.columns).map_err(|_| {
        FilmError::GridAxisExceedsLimit {
            axis: "columns",
            value: request.config.grid.columns,
            max: u16::MAX as u32,
        }
    })?;
    let rows =
        u16::try_from(request.config.grid.rows).map_err(|_| FilmError::GridAxisExceedsLimit {
            axis: "rows",
            value: request.config.grid.rows,
            max: u16::MAX as u32,
        })?;
    let target_count = u16::try_from(request.script.targets.len()).map_err(|_| {
        FilmError::TargetCountExceedsLimit {
            actual: request.script.targets.len(),
            max: u16::MAX as usize,
        }
    })?;
    let segment_count = u16::try_from(request.script.segments.len()).map_err(|_| {
        FilmError::SegmentCountExceedsLimit {
            actual: request.script.segments.len(),
            max: u16::MAX as usize,
        }
    })?;

    let cell_count = request.config.cell_count()?;
    let mut out = Vec::with_capacity(HEADER_BYTES + request.script.targets.len() * cell_count * 4);
    out.extend_from_slice(ANIMATION_MAGIC);
    out.extend_from_slice(&ANIMATION_VERSION.to_le_bytes());
    out.extend_from_slice(&columns.to_le_bytes());
    out.extend_from_slice(&rows.to_le_bytes());
    out.extend_from_slice(&target_count.to_le_bytes());
    out.extend_from_slice(&segment_count.to_le_bytes());
    out.extend_from_slice(&request.frame_rate.to_le_bytes());

    for segment in &request.script.segments {
        encode_segment(segment, &mut out)?;
    }
    for target in &request.script.targets {
        for cell in &target.cells {
            encode_cell(cell, &mut out);
        }
    }

    if out.len() > request.config.limits.max_frame_bytes {
        return Err(FilmError::EncodedFrameTooLarge {
            actual: out.len(),
            max: request.config.limits.max_frame_bytes,
        });
    }

    Ok(out)
}

fn validate_frame_rate(frame_rate: u16) -> FilmResult<()> {
    if (1..=240).contains(&frame_rate) {
        Ok(())
    } else {
        Err(FilmError::InvalidAnimationFrameRate(frame_rate))
    }
}

fn encode_segment(segment: &TimelineSegment, out: &mut Vec<u8>) -> FilmResult<()> {
    out.extend_from_slice(&seconds_to_millis(segment.start_seconds)?.to_le_bytes());
    out.extend_from_slice(&seconds_to_millis(segment.duration_seconds)?.to_le_bytes());
    let sample_count = u16::try_from(segment.samples.len())
        .map_err(|_| FilmError::InvalidLimit("timeline segment sample count exceeds u16"))?;
    out.extend_from_slice(&sample_count.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    for sample in &segment.samples {
        encode_sample(sample, out)?;
    }
    Ok(())
}

fn encode_sample(sample: &TargetSample, out: &mut Vec<u8>) -> FilmResult<()> {
    let target = u16::try_from(sample.target).map_err(|_| FilmError::TargetIndexOutOfRange {
        index: sample.target,
        target_count: u16::MAX as usize,
    })?;
    out.extend_from_slice(&target.to_le_bytes());
    encode_scalar_field(&sample.weight, out)
}

fn encode_scalar_field(field: &ScalarField, out: &mut Vec<u8>) -> FilmResult<()> {
    out.push(scalar_combiner_code(field.combiner));
    let term_count = u16::try_from(field.terms.len())
        .map_err(|_| FilmError::InvalidLimit("scalar field term count exceeds u16"))?;
    out.extend_from_slice(&term_count.to_le_bytes());
    for term in &field.terms {
        encode_scalar_expression(term, out)?;
    }
    Ok(())
}

fn encode_scalar_expression(expression: &ScalarExpression, out: &mut Vec<u8>) -> FilmResult<()> {
    match expression {
        ScalarExpression::Input => out.push(0),
        ScalarExpression::Channel { index } => {
            out.push(1);
            out.push(*index);
        }
        ScalarExpression::Constant { value } => {
            ensure_finite("field.expression.constant", *value)?;
            out.push(2);
            out.extend_from_slice(&value.to_le_bytes());
        }
        ScalarExpression::Unary { op, value } => {
            out.push(3);
            out.push(scalar_unary_code(*op));
            encode_scalar_expression(value, out)?;
        }
        ScalarExpression::Binary { op, left, right } => {
            out.push(4);
            out.push(scalar_binary_code(*op));
            encode_scalar_expression(left, out)?;
            encode_scalar_expression(right, out)?;
        }
        ScalarExpression::Clamp { value, min, max } => {
            out.push(5);
            encode_scalar_expression(value, out)?;
            encode_scalar_expression(min, out)?;
            encode_scalar_expression(max, out)?;
        }
    }
    Ok(())
}

fn encode_cell(cell: &CellStyle, out: &mut Vec<u8>) {
    out.push(cell.color.r);
    out.push(cell.color.g);
    out.push(cell.color.b);
    out.push(alpha_byte(cell));
}

fn alpha_byte(cell: &CellStyle) -> u8 {
    ((cell.color.a as f32 * cell.opacity).round()).clamp(0.0, 255.0) as u8
}

fn seconds_to_millis(seconds: f32) -> FilmResult<u32> {
    let millis = seconds * 1000.0;
    if !millis.is_finite() || millis < 0.0 || millis > u32::MAX as f32 {
        return Err(FilmError::InvalidTimelineMillis(seconds));
    }
    Ok(millis.round() as u32)
}

fn scalar_combiner_code(combiner: ScalarFieldCombiner) -> u8 {
    match combiner {
        ScalarFieldCombiner::Max => 0,
        ScalarFieldCombiner::Sum => 1,
        ScalarFieldCombiner::SumClamped => 2,
    }
}

fn scalar_unary_code(op: ScalarUnaryOp) -> u8 {
    match op {
        ScalarUnaryOp::Abs => 0,
        ScalarUnaryOp::Negate => 1,
        ScalarUnaryOp::Sine => 2,
        ScalarUnaryOp::Cosine => 3,
        ScalarUnaryOp::Exponential => 4,
        ScalarUnaryOp::Floor => 5,
        ScalarUnaryOp::Ceil => 6,
        ScalarUnaryOp::Round => 7,
        ScalarUnaryOp::Fract => 8,
    }
}

fn scalar_binary_code(op: ScalarBinaryOp) -> u8 {
    match op {
        ScalarBinaryOp::Add => 0,
        ScalarBinaryOp::Subtract => 1,
        ScalarBinaryOp::Multiply => 2,
        ScalarBinaryOp::Divide => 3,
        ScalarBinaryOp::Power => 4,
        ScalarBinaryOp::Minimum => 5,
        ScalarBinaryOp::Maximum => 6,
    }
}
