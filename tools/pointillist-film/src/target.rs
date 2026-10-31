//! crates/pointillist-film-core/src/target.rs
//!
//! Dense target frames: one style per square-grid cell in stable cell order.

use serde::{Deserialize, Serialize};

use crate::config::FilmConfig;
use crate::palette::Rgba8;
use crate::validation::{ensure_finite, FilmError, FilmResult};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct CellStyle {
    pub color: Rgba8,
    pub opacity: f32,
    pub scale: f32,
}

impl CellStyle {
    pub fn transparent() -> Self {
        Self {
            color: Rgba8::new(0, 0, 0, 0),
            opacity: 0.0,
            scale: 1.0,
        }
    }

    pub fn validate(&self, config: &FilmConfig) -> FilmResult<()> {
        ensure_finite("cell.opacity", self.opacity)?;
        ensure_finite("cell.scale", self.scale)?;
        if !(config.style.min_opacity..=config.style.max_opacity).contains(&self.opacity) {
            return Err(FilmError::ScalarOutOfRange {
                field: "cell.opacity",
                value: self.opacity,
                min: config.style.min_opacity,
                max: config.style.max_opacity,
            });
        }
        if !(config.style.min_scale..=config.style.max_scale).contains(&self.scale) {
            return Err(FilmError::ScalarOutOfRange {
                field: "cell.scale",
                value: self.scale,
                min: config.style.min_scale,
                max: config.style.max_scale,
            });
        }
        Ok(())
    }
}

impl Default for CellStyle {
    fn default() -> Self {
        Self::transparent()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TargetFrame {
    pub cells: Vec<CellStyle>,
}

impl TargetFrame {
    pub fn dense(cells: Vec<CellStyle>) -> Self {
        Self { cells }
    }

    pub fn solid(config: &FilmConfig, style: CellStyle) -> FilmResult<Self> {
        let count = config.cell_count()?;
        style.validate(config)?;
        Ok(Self {
            cells: vec![style; count],
        })
    }

    pub fn validate(&self, config: &FilmConfig) -> FilmResult<()> {
        let expected = config.cell_count()?;
        if self.cells.len() != expected {
            return Err(FilmError::TargetCellCountMismatch {
                expected,
                actual: self.cells.len(),
            });
        }
        for cell in &self.cells {
            cell.validate(config)?;
        }
        Ok(())
    }
}
