//! crates/pointillist-film-core/src/timeline.rs
//!
//! Film script and deterministic frame evaluation.

use serde::{Deserialize, Serialize};

use crate::config::FilmConfig;
use crate::field::{scalar_field_value_with_context, ScalarContext, ScalarField};
use crate::frame::{PackedCell, PackedCellFrame};
use crate::morph::mix_styles;
use crate::target::TargetFrame;
use crate::validation::{ensure_finite, FilmError, FilmResult};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FilmScript {
    pub targets: Vec<TargetFrame>,
    pub segments: Vec<TimelineSegment>,
}

impl FilmScript {
    pub fn validate(&self, config: &FilmConfig) -> FilmResult<()> {
        if self.targets.is_empty() {
            return Err(FilmError::NoTargets);
        }
        if self.targets.len() > config.limits.max_targets {
            return Err(FilmError::TargetCountExceedsLimit {
                actual: self.targets.len(),
                max: config.limits.max_targets,
            });
        }
        for target in &self.targets {
            target.validate(config)?;
        }
        for segment in &self.segments {
            segment.validate(self.targets.len())?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TimelineSegment {
    pub start_seconds: f32,
    pub duration_seconds: f32,
    pub samples: Vec<TargetSample>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TargetSample {
    pub target: usize,
    pub weight: ScalarField,
}

impl TimelineSegment {
    pub fn validate(&self, target_count: usize) -> FilmResult<()> {
        ensure_finite("segment.start_seconds", self.start_seconds)?;
        ensure_finite("segment.duration_seconds", self.duration_seconds)?;
        if self.duration_seconds <= 0.0 {
            return Err(FilmError::InvalidDuration(self.duration_seconds));
        }
        if self.samples.is_empty() {
            return Err(FilmError::InvalidLimit(
                "timeline segment must contain at least one target sample",
            ));
        }
        for sample in &self.samples {
            if sample.target >= target_count {
                return Err(FilmError::TargetIndexOutOfRange {
                    index: sample.target,
                    target_count,
                });
            }
        }
        Ok(())
    }

    pub fn end_seconds(&self) -> f32 {
        self.start_seconds + self.duration_seconds
    }
}

pub fn frame_at(
    script: &FilmScript,
    config: &FilmConfig,
    time_seconds: f32,
) -> FilmResult<PackedCellFrame> {
    let mut cells = Vec::new();
    frame_at_into(script, config, time_seconds, &mut cells)?;
    let frame = PackedCellFrame {
        columns: config.grid.columns,
        rows: config.grid.rows,
        time_seconds,
        cells,
    };
    frame.validate(config)?;
    Ok(frame)
}

pub fn frame_at_into(
    script: &FilmScript,
    config: &FilmConfig,
    time_seconds: f32,
    output: &mut Vec<PackedCell>,
) -> FilmResult<()> {
    config.validate()?;
    script.validate(config)?;
    ensure_finite("time_seconds", time_seconds)?;
    let cell_count = config.cell_count()?;
    output.clear();
    output.reserve(cell_count);

    let weights = resolve_weights(script, time_seconds)?;

    for cell_id in 0..cell_count {
        let style = if weights.is_empty() {
            script.targets[0].cells[cell_id]
        } else {
            mix_styles(
                weights
                    .iter()
                    .map(|(target, weight)| (script.targets[*target].cells[cell_id], *weight)),
                &config.style,
            )?
        };
        output.push(PackedCell {
            cell_id: cell_id as u32,
            color: style.color,
            opacity: style.opacity,
            scale: style.scale,
        });
    }
    Ok(())
}

fn resolve_weights(script: &FilmScript, time_seconds: f32) -> FilmResult<Vec<(usize, f32)>> {
    if script.segments.is_empty() {
        return Ok(Vec::new());
    }

    let mut last_segment = &script.segments[0];
    for segment in &script.segments {
        if time_seconds >= segment.start_seconds && time_seconds <= segment.end_seconds() {
            return sample_weights(segment, time_seconds);
        }
        if segment.start_seconds <= time_seconds {
            last_segment = segment;
        }
    }

    if time_seconds < script.segments[0].start_seconds {
        sample_weights(&script.segments[0], script.segments[0].start_seconds)
    } else {
        sample_weights(last_segment, last_segment.end_seconds())
    }
}

fn sample_weights(segment: &TimelineSegment, time_seconds: f32) -> FilmResult<Vec<(usize, f32)>> {
    let elapsed = (time_seconds - segment.start_seconds).clamp(0.0, segment.duration_seconds);
    let phase = (elapsed / segment.duration_seconds).clamp(0.0, 1.0);
    let context = ScalarContext {
        channels: vec![phase, time_seconds, elapsed, segment.duration_seconds],
    };
    let mut weights = Vec::with_capacity(segment.samples.len());
    for sample in &segment.samples {
        let weight = scalar_field_value_with_context(&sample.weight, &context)?;
        ensure_finite("timeline.sample.weight", weight)?;
        weights.push((sample.target, weight));
    }
    Ok(weights)
}
