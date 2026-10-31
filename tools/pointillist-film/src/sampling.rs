//! crates/pointillist-film-core/src/sampling.rs
//!
//! Source image sampling into dense square-grid targets.

use crate::config::FilmConfig;
use crate::palette::Rgba8;
use crate::target::{CellStyle, TargetFrame};
use crate::validation::{FilmError, FilmResult};

pub fn sample_rgba_source(
    source_width: u32,
    source_height: u32,
    pixels: &[Rgba8],
    config: &FilmConfig,
) -> FilmResult<TargetFrame> {
    config.validate()?;
    if source_width == 0 || source_height == 0 {
        return Err(FilmError::EmptySource);
    }
    let expected_pixels = source_width as usize * source_height as usize;
    if pixels.len() != expected_pixels {
        return Err(FilmError::SourcePixelCountMismatch {
            expected: expected_pixels,
            actual: pixels.len(),
        });
    }

    let mut cells = Vec::with_capacity(config.cell_count()?);
    for row in 0..config.grid.rows {
        let source_y = nearest_sample_index(row, config.grid.rows, source_height);
        for column in 0..config.grid.columns {
            let source_x = nearest_sample_index(column, config.grid.columns, source_width);
            let pixel = pixels[(source_y * source_width + source_x) as usize];
            cells.push(CellStyle {
                color: pixel,
                opacity: pixel.a as f32 / 255.0,
                scale: 1.0,
            });
        }
    }

    let target = TargetFrame::dense(cells);
    target.validate(config)?;
    Ok(target)
}

fn nearest_sample_index(grid_index: u32, grid_axis: u32, source_axis: u32) -> u32 {
    let normalized = (grid_index as f32 + 0.5) / grid_axis as f32;
    let source = (normalized * source_axis as f32).floor() as u32;
    source.min(source_axis - 1)
}
