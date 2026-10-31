//! crates/pointillist-film-core/src/validation.rs
//!
//! Structured validation errors for pure film generation.

use thiserror::Error;

pub type FilmResult<T> = Result<T, FilmError>;

#[derive(Debug, Error, PartialEq)]
pub enum FilmError {
    #[error("grid must have non-zero rows and columns")]
    EmptyGrid,
    #[error("source image must have non-zero width and height")]
    EmptySource,
    #[error("{field} must be finite, got {value}")]
    NonFinite { field: &'static str, value: f32 },
    #[error("{field}={value} is outside {min}..={max}")]
    ScalarOutOfRange {
        field: &'static str,
        value: f32,
        min: f32,
        max: f32,
    },
    #[error("{axis}={value} exceeds max {max}")]
    GridAxisExceedsLimit {
        axis: &'static str,
        value: u32,
        max: u32,
    },
    #[error("grid {columns}x{rows} exceeds max cell count {max_cells}")]
    CellCountExceedsLimit {
        columns: u32,
        rows: u32,
        max_cells: usize,
    },
    #[error("invalid limit: {0}")]
    InvalidLimit(&'static str),
    #[error("invalid style bounds: {0}")]
    InvalidStyleBounds(&'static str),
    #[error("target cell count mismatch: expected {expected}, actual {actual}")]
    TargetCellCountMismatch { expected: usize, actual: usize },
    #[error("frame cell count mismatch: expected {expected}, actual {actual}")]
    FrameCellCountMismatch { expected: usize, actual: usize },
    #[error("frame grid mismatch: expected {expected_columns}x{expected_rows}, actual {actual_columns}x{actual_rows}")]
    FrameGridMismatch {
        expected_columns: u32,
        expected_rows: u32,
        actual_columns: u32,
        actual_rows: u32,
    },
    #[error("cell id out of order: expected {expected}, actual {actual}")]
    CellIdOutOfOrder { expected: u32, actual: u32 },
    #[error("scalar input channel {index} outside channel count {channel_count}")]
    ScalarInputOutOfRange { index: u8, channel_count: usize },
    #[error("script must contain at least one target")]
    NoTargets,
    #[error("target count {actual} exceeds max {max}")]
    TargetCountExceedsLimit { actual: usize, max: usize },
    #[error("segment count {actual} exceeds max {max}")]
    SegmentCountExceedsLimit { actual: usize, max: usize },
    #[error("target index {index} outside target count {target_count}")]
    TargetIndexOutOfRange { index: usize, target_count: usize },
    #[error("segment duration must be positive, got {0}")]
    InvalidDuration(f32),
    #[error("animation frame rate must be between 1 and 240, got {0}")]
    InvalidAnimationFrameRate(u16),
    #[error("timeline seconds cannot be represented as non-negative milliseconds: {0}")]
    InvalidTimelineMillis(f32),
    #[error("source pixel count mismatch: expected {expected}, actual {actual}")]
    SourcePixelCountMismatch { expected: usize, actual: usize },
    #[error("encoded frame too large: {actual} bytes exceeds max {max}")]
    EncodedFrameTooLarge { actual: usize, max: usize },
    #[error("wire data is too short")]
    WireTooShort,
    #[error("wire magic mismatch")]
    WireMagicMismatch,
    #[error("wire version {0} is unsupported")]
    UnsupportedWireVersion(u16),
    #[error("wire trailing bytes: {0}")]
    WireTrailingBytes(usize),
}

pub fn ensure_finite(field: &'static str, value: f32) -> FilmResult<()> {
    if value.is_finite() {
        Ok(())
    } else {
        Err(FilmError::NonFinite { field, value })
    }
}
