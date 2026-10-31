//! crates/pointillist-film-core/src/grid.rs
//!
//! Stable square-grid generation. Cells stay on grid; renderers draw them.

use serde::{Deserialize, Serialize};

use crate::config::FilmConfig;
use crate::validation::FilmResult;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct GridCell {
    pub id: u32,
    pub column: u32,
    pub row: u32,
    pub center_x: f32,
    pub center_y: f32,
    pub side: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SquareGrid {
    pub columns: u32,
    pub rows: u32,
    pub cells: Vec<GridCell>,
}

pub fn make_grid(config: &FilmConfig) -> FilmResult<SquareGrid> {
    config.validate()?;
    let columns = config.grid.columns;
    let rows = config.grid.rows;
    let cell_count = config.cell_count()?;
    let column_step = 1.0 / columns as f32;
    let row_step = 1.0 / rows as f32;
    let side = column_step.min(row_step) * (1.0 - config.grid.cell_gap_fraction);
    let mut cells = Vec::with_capacity(cell_count);

    for row in 0..rows {
        for column in 0..columns {
            let id = row * columns + column;
            cells.push(GridCell {
                id,
                column,
                row,
                center_x: (column as f32 + 0.5) * column_step,
                center_y: (row as f32 + 0.5) * row_step,
                side,
            });
        }
    }

    Ok(SquareGrid {
        columns,
        rows,
        cells,
    })
}
