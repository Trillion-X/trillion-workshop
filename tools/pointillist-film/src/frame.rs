//! crates/pointillist-film-core/src/frame.rs
//!
//! Packed render-agnostic frame output.

use serde::{Deserialize, Serialize};

use crate::config::FilmConfig;
use crate::palette::Rgba8;
use crate::validation::{ensure_finite, FilmError, FilmResult};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct PackedCell {
    pub cell_id: u32,
    pub color: Rgba8,
    pub opacity: f32,
    pub scale: f32,
}

impl PackedCell {
    pub fn validate(&self, config: &FilmConfig) -> FilmResult<()> {
        ensure_finite("packed_cell.opacity", self.opacity)?;
        ensure_finite("packed_cell.scale", self.scale)?;
        if !(config.style.min_opacity..=config.style.max_opacity).contains(&self.opacity) {
            return Err(FilmError::ScalarOutOfRange {
                field: "packed_cell.opacity",
                value: self.opacity,
                min: config.style.min_opacity,
                max: config.style.max_opacity,
            });
        }
        if !(config.style.min_scale..=config.style.max_scale).contains(&self.scale) {
            return Err(FilmError::ScalarOutOfRange {
                field: "packed_cell.scale",
                value: self.scale,
                min: config.style.min_scale,
                max: config.style.max_scale,
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PackedCellFrame {
    pub columns: u32,
    pub rows: u32,
    pub time_seconds: f32,
    pub cells: Vec<PackedCell>,
}

impl PackedCellFrame {
    pub fn validate(&self, config: &FilmConfig) -> FilmResult<()> {
        ensure_finite("frame.time_seconds", self.time_seconds)?;
        if self.columns != config.grid.columns || self.rows != config.grid.rows {
            return Err(FilmError::FrameGridMismatch {
                expected_columns: config.grid.columns,
                expected_rows: config.grid.rows,
                actual_columns: self.columns,
                actual_rows: self.rows,
            });
        }
        let expected = config.cell_count()?;
        if self.cells.len() != expected {
            return Err(FilmError::FrameCellCountMismatch {
                expected,
                actual: self.cells.len(),
            });
        }
        for (expected_id, cell) in self.cells.iter().enumerate() {
            if cell.cell_id != expected_id as u32 {
                return Err(FilmError::CellIdOutOfOrder {
                    expected: expected_id as u32,
                    actual: cell.cell_id,
                });
            }
            cell.validate(config)?;
        }
        Ok(())
    }
}
