// src/storage/supplies/layout.rs
//
// Purpose: For every declared family, decide how each field is held as bytes: in the ordered form when any key or
// order compares it, in the plain form otherwise. Every supply that stores bytes reads this one answer.
//
// Non-Negotiable Invariants:
// - A field is ordered exactly when it is a key field or a cursor field of a declared order. Nothing else is
//   compared by order, so nothing else pays for the escaping the ordered form needs.
// - The condition values of a partial order are encoded with the field's own form, so a stored value equals its
//   condition byte for byte.
//
// Key Concepts:
// - `FamilyLayout`: one family's fields in declared order, each with its form.
//
// Security Considerations:
// - Pure functions over DATA declarations.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::codec;
use local_engine::storage::{Error, Family, Only, Result, Schema, Value};

/// One family's byte forms.
pub struct FamilyLayout {
    pub family: &'static Family,
    ordered: Vec<bool>,
}

impl FamilyLayout {
    pub fn new(family: &'static Family) -> Self {
        let ordered = family
            .fields
            .iter()
            .map(|field| {
                family.key.contains(field) || family.orders.values().any(|order| order.fields.contains(field))
            })
            .collect();
        Self { family, ordered }
    }

    /// The position of a declared field.
    pub fn index(&self, field: &str) -> Result<usize> {
        self.family.fields.iter().position(|known| known == field).ok_or(local_engine::cause!(Error::Undeclared))
    }

    pub fn is_ordered(&self, at: usize) -> bool {
        self.ordered[at]
    }

    /// The stored bytes of one field's value.
    pub fn encode(&self, at: usize, value: &Value) -> Result<Vec<u8>> {
        if self.ordered[at] {
            codec::ordered_one(value)
        } else {
            codec::plain_one(value)
        }
    }

    /// The value held in stored bytes.
    pub fn decode(&self, at: usize, bytes: &[u8]) -> Result<Value> {
        if self.ordered[at] {
            let (value, used) = codec::read_ordered(bytes)?;
            if used == bytes.len() {
                Ok(value)
            } else {
                Err(local_engine::cause!(Error::Invalid))
            }
        } else {
            codec::read_plain_whole(bytes)
        }
    }

    /// The value a partial-order condition compares with.
    pub fn condition(&self, condition: &Only) -> Result<(usize, Vec<u8>)> {
        let at = self.index(&condition.field)?;
        let value = match &condition.equals {
            serde_json::Value::Null => Value::Null,
            serde_json::Value::String(text) => Value::Text(text.clone()),
            other => Value::Integer(other.as_i64().ok_or(local_engine::cause!(Error::Undeclared))?),
        };
        Ok((at, self.encode(at, &value)?))
    }

    /// Whether a row holds the rows of a partial order: every condition `field = value` (or `field <> value`).
    pub fn holds(&self, values: &[Value], only: &[Only]) -> Result<bool> {
        for condition in only {
            let (at, bytes) = self.condition(condition)?;
            let stored = self.encode(at, &values[at])?;
            if (stored == bytes) == condition.not {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

/// The layouts of a whole schema, in declared family order.
pub fn layouts(schema: &'static Schema) -> Vec<FamilyLayout> {
    schema.families.iter().map(FamilyLayout::new).collect()
}
