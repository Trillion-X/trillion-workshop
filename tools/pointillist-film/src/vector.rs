//! crates/pointillist-film-core/src/vector.rs
//!
//! Generic vector-field composition over scalar contexts.

use serde::{Deserialize, Serialize};

use crate::field::{scalar_field_value_with_context, ScalarContext, ScalarField};
use crate::validation::{ensure_finite, FilmResult};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Vector2 {
    pub x: f32,
    pub y: f32,
}

impl Vector2 {
    pub fn validate(&self) -> FilmResult<()> {
        ensure_finite("vector.x", self.x)?;
        ensure_finite("vector.y", self.y)?;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VectorField {
    pub x: ScalarField,
    pub y: ScalarField,
}

pub fn vector_field_value(field: &VectorField, context: &ScalarContext) -> FilmResult<Vector2> {
    let vector = Vector2 {
        x: scalar_field_value_with_context(&field.x, context)?,
        y: scalar_field_value_with_context(&field.y, context)?,
    };
    vector.validate()?;
    Ok(vector)
}
