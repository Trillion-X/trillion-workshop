//! crates/pointillist-film-core/src/config.rs
//!
//! Config-owned tunables and validation for square-grid film generation.

use serde::{Deserialize, Serialize};

use crate::validation::{ensure_finite, FilmError, FilmResult};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct FilmConfig {
    pub grid: GridConfig,
    pub limits: FilmLimits,
    pub style: StyleBounds,
}

impl FilmConfig {
    pub fn validate(&self) -> FilmResult<()> {
        self.limits.validate()?;
        self.style.validate()?;
        self.grid.validate(&self.limits)
    }

    pub fn cell_count(&self) -> FilmResult<usize> {
        self.grid.cell_count(&self.limits)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GridConfig {
    pub columns: u32,
    pub rows: u32,
    pub cell_gap_fraction: f32,
}

impl GridConfig {
    pub fn cell_count(&self, limits: &FilmLimits) -> FilmResult<usize> {
        let columns = self.columns as usize;
        let rows = self.rows as usize;
        columns
            .checked_mul(rows)
            .filter(|count| *count <= limits.max_cells)
            .ok_or(FilmError::CellCountExceedsLimit {
                columns: self.columns,
                rows: self.rows,
                max_cells: limits.max_cells,
            })
    }

    pub fn validate(&self, limits: &FilmLimits) -> FilmResult<()> {
        if self.columns == 0 || self.rows == 0 {
            return Err(FilmError::EmptyGrid);
        }
        if self.columns > limits.max_columns {
            return Err(FilmError::GridAxisExceedsLimit {
                axis: "columns",
                value: self.columns,
                max: limits.max_columns,
            });
        }
        if self.rows > limits.max_rows {
            return Err(FilmError::GridAxisExceedsLimit {
                axis: "rows",
                value: self.rows,
                max: limits.max_rows,
            });
        }
        ensure_finite("grid.cell_gap_fraction", self.cell_gap_fraction)?;
        if !(0.0..=limits.max_cell_gap_fraction).contains(&self.cell_gap_fraction) {
            return Err(FilmError::ScalarOutOfRange {
                field: "grid.cell_gap_fraction",
                value: self.cell_gap_fraction,
                min: 0.0,
                max: limits.max_cell_gap_fraction,
            });
        }
        self.cell_count(limits)?;
        Ok(())
    }
}

impl Default for GridConfig {
    fn default() -> Self {
        Self {
            columns: 32,
            rows: 18,
            cell_gap_fraction: 0.08,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FilmLimits {
    pub max_columns: u32,
    pub max_rows: u32,
    pub max_cells: usize,
    pub max_targets: usize,
    pub max_frame_bytes: usize,
    pub max_cell_gap_fraction: f32,
}

impl FilmLimits {
    pub fn validate(&self) -> FilmResult<()> {
        if self.max_columns == 0 || self.max_rows == 0 || self.max_cells == 0 {
            return Err(FilmError::InvalidLimit("grid limits must be non-zero"));
        }
        if self.max_targets == 0 {
            return Err(FilmError::InvalidLimit("max_targets must be non-zero"));
        }
        if self.max_frame_bytes == 0 {
            return Err(FilmError::InvalidLimit("max_frame_bytes must be non-zero"));
        }
        ensure_finite("limits.max_cell_gap_fraction", self.max_cell_gap_fraction)?;
        if !(0.0..1.0).contains(&self.max_cell_gap_fraction) {
            return Err(FilmError::ScalarOutOfRange {
                field: "limits.max_cell_gap_fraction",
                value: self.max_cell_gap_fraction,
                min: 0.0,
                max: 1.0,
            });
        }
        Ok(())
    }
}

impl Default for FilmLimits {
    fn default() -> Self {
        Self {
            max_columns: 512,
            max_rows: 512,
            max_cells: 262_144,
            max_targets: 256,
            max_frame_bytes: 32 * 1024 * 1024,
            max_cell_gap_fraction: 0.48,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StyleBounds {
    pub min_opacity: f32,
    pub max_opacity: f32,
    pub min_scale: f32,
    pub max_scale: f32,
}

impl StyleBounds {
    pub fn validate(&self) -> FilmResult<()> {
        ensure_finite("style.min_opacity", self.min_opacity)?;
        ensure_finite("style.max_opacity", self.max_opacity)?;
        ensure_finite("style.min_scale", self.min_scale)?;
        ensure_finite("style.max_scale", self.max_scale)?;
        if self.min_opacity < 0.0 || self.max_opacity > 1.0 || self.min_opacity > self.max_opacity {
            return Err(FilmError::InvalidStyleBounds(
                "opacity bounds must fit 0..=1",
            ));
        }
        if self.min_scale < 0.0 || self.min_scale > self.max_scale {
            return Err(FilmError::InvalidStyleBounds(
                "scale bounds must be ordered and non-negative",
            ));
        }
        Ok(())
    }
}

impl Default for StyleBounds {
    fn default() -> Self {
        Self {
            min_opacity: 0.0,
            max_opacity: 1.0,
            min_scale: 0.0,
            max_scale: 16.0,
        }
    }
}
