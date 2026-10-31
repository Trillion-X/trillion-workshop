//! crates/pointillist-film-core/src/program.rs
//!
//! Generic multi-output field programs for geometry and material consumers.

use serde::{Deserialize, Serialize};

use crate::field::{scalar_field_value_with_context, ScalarContext, ScalarField};
use crate::validation::{ensure_finite, FilmError, FilmResult};

const MATRIX4_COMPONENT_COUNT: usize = 16;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ComponentField {
    pub components: Vec<ScalarField>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Matrix4Field {
    pub components: Vec<ScalarField>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FieldProgram {
    pub matrix: Option<Matrix4Field>,
    pub components: ComponentField,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Matrix4 {
    pub components: [f32; MATRIX4_COMPONENT_COUNT],
}

#[derive(Clone, Debug, PartialEq)]
pub struct FieldProgramSample {
    pub matrix: Option<Matrix4>,
    pub components: Vec<f32>,
}

pub fn component_field_values(
    field: &ComponentField,
    context: &ScalarContext,
) -> FilmResult<Vec<f32>> {
    let mut values = Vec::with_capacity(field.components.len());

    for component in &field.components {
        let value = scalar_field_value_with_context(component, context)?;
        ensure_finite("program.component", value)?;
        values.push(value);
    }

    Ok(values)
}

pub fn matrix4_field_value(field: &Matrix4Field, context: &ScalarContext) -> FilmResult<Matrix4> {
    if field.components.len() != MATRIX4_COMPONENT_COUNT {
        return Err(FilmError::InvalidLimit("matrix4 component count"));
    }

    let mut components = [0.0; MATRIX4_COMPONENT_COUNT];
    for (index, component) in field.components.iter().enumerate() {
        components[index] = scalar_field_value_with_context(component, context)?;
        ensure_finite("program.matrix4.component", components[index])?;
    }

    Ok(Matrix4 { components })
}

pub fn field_program_sample(
    program: &FieldProgram,
    context: &ScalarContext,
) -> FilmResult<FieldProgramSample> {
    Ok(FieldProgramSample {
        matrix: program
            .matrix
            .as_ref()
            .map(|matrix| matrix4_field_value(matrix, context))
            .transpose()?,
        components: component_field_values(&program.components, context)?,
    })
}
