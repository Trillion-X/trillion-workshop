//! crates/pointillist-film-core/src/lib.rs
//!
//! Pointillist Film Core — pure square-grid film math.
//!
//! This leaf crate owns deterministic grid, target, morph, frame, validation,
//! and wire primitives. It has zero renderer, DOM, React or audio I/O.

pub mod animation;
pub mod config;
pub mod field;
pub mod frame;
pub mod grid;
pub mod morph;
pub mod palette;
pub mod program;
pub mod request;
pub mod sampling;
pub mod target;
pub mod timeline;
pub mod validation;
pub mod vector;
pub mod wire;

pub use animation::{encode_target_animation, TargetAnimationRequest};
pub use config::{FilmConfig, FilmLimits, GridConfig, StyleBounds};
pub use field::{
    scalar_field_value, scalar_field_value_with_context, ScalarBinaryOp, ScalarContext,
    ScalarExpression, ScalarField, ScalarFieldCombiner, ScalarUnaryOp,
};
pub use frame::{PackedCell, PackedCellFrame};
pub use grid::{make_grid, GridCell, SquareGrid};
pub use palette::Rgba8;
pub use program::{
    component_field_values, field_program_sample, matrix4_field_value, ComponentField,
    FieldProgram, FieldProgramSample, Matrix4, Matrix4Field,
};
pub use request::FilmFrameRequest;
pub use sampling::sample_rgba_source;
pub use target::{CellStyle, TargetFrame};
pub use timeline::{frame_at, frame_at_into, FilmScript, TargetSample, TimelineSegment};
pub use validation::{FilmError, FilmResult};
pub use vector::{vector_field_value, Vector2, VectorField};
pub use wire::{decode_frame, encode_frame};
