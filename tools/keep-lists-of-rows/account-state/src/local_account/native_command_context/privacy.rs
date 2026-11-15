//! Bounded schema-based private-value projection for native command inputs.
//!
//! This mirrors typed-operation-contract.mjs composition and writeOnly walking.
//! Built-in type/enum/required/additionalProperties and numeric/string/array
//! bounds select branches. Pattern, URL and time-zone matching remain unknown;
//! an unknown branch is conservatively included, redacting or rejecting its
//! private leaves. Diagnostics never contain input, schema, keys or credentials.

use crate::ecma_json::{JsString, Object, Value};
use std::fmt;

const MAX_DEPTH: usize = 128;
const MAX_STEPS: usize = 100_000;
const REDACTION: &str = "[write-only]";

#[derive(Clone, PartialEq, Eq)]
pub enum PrivacyError {
    Complexity(crate::refusal_cause::Cause),
    WriteOnly(crate::refusal_cause::Cause),
}
impl PrivacyError {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Complexity(cause) => cause,
            Self::WriteOnly(cause) => cause,
        }
    }
}
crate::impl_caused!(PrivacyError);

impl fmt::Debug for PrivacyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} cause={}", match self {
            Self::Complexity(_) => "PrivacyError(Complexity)",
            Self::WriteOnly(_) => "PrivacyError(WriteOnly)",
        }, self.cause())
    }
}
impl fmt::Display for PrivacyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} cause={}", match self {
            Self::Complexity(_) => "private-value inspection exceeded its bound",
            Self::WriteOnly(_) => "raw write-only input cannot be replayed",
        }, self.cause())
    }
}
impl std::error::Error for PrivacyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

#[derive(Copy, Clone, PartialEq, Eq)]
enum Match {
    Yes,
    No,
    Unknown,
}
impl Match {
    fn and(self, other: Self) -> Self {
        match (self, other) {
            (Self::No, _) | (_, Self::No) => Self::No,
            (Self::Unknown, _) | (_, Self::Unknown) => Self::Unknown,
            _ => Self::Yes,
        }
    }
}
#[derive(Default)]
struct Budget {
    steps: usize,
}
impl Budget {
    fn tick(&mut self, depth: usize) -> Result<(), PrivacyError> {
        self.steps = self.steps.checked_add(1).ok_or(crate::cause!(PrivacyError::Complexity))?;
        if self.steps > MAX_STEPS || depth > MAX_DEPTH {
            return Err(crate::cause!(PrivacyError::Complexity));
        }
        Ok(())
    }
}

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(object) => object.get(&JsString::from(name)),
        _ => None,
    }
}
fn as_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => value.to_rust_string().ok(),
        _ => None,
    }
}
fn array(value: Option<&Value>) -> Option<&[Value]> {
    match value {
        Some(Value::Array(values)) => Some(values),
        _ => None,
    }
}
fn is_object(value: &Value) -> bool {
    matches!(value, Value::Object(_))
}
fn as_object(value: &Value) -> Option<&Object> {
    match value {
        Value::Object(object) => Some(object),
        _ => None,
    }
}
fn json_equal(
    left: &Value,
    right: &Value,
    budget: &mut Budget,
    depth: usize,
) -> Result<bool, PrivacyError> {
    budget.tick(depth)?;
    Ok(match (left, right) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => a == b || (!a.is_finite() && !b.is_finite()),
        (Value::Number(number), Value::Null) | (Value::Null, Value::Number(number)) => {
            !number.is_finite()
        }
        (Value::String(a), Value::String(b)) => a == b,
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len()
                && a.iter().zip(b).try_fold(true, |same, (a, b)| {
                    if same {
                        json_equal(a, b, budget, depth + 1)
                    } else {
                        Ok(false)
                    }
                })?
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.insertion_entries().try_fold(true, |same, (key, value)| {
                    if !same {
                        return Ok(false);
                    }
                    match b.get(key) {
                        Some(other) => json_equal(value, other, budget, depth + 1),
                        None => Ok(false),
                    }
                })?
        }
        _ => false,
    })
}
fn type_matches(value: &Value, name: &str) -> bool {
    match name {
        "null" => matches!(value, Value::Null),
        "boolean" => matches!(value, Value::Bool(_)),
        "string" => matches!(value, Value::String(_)),
        "number" => matches!(value, Value::Number(_)),
        "integer" => matches!(value, Value::Number(n) if n.is_finite() && n.fract() == 0.0),
        "array" => matches!(value, Value::Array(_)),
        "object" => matches!(value, Value::Object(_)),
        _ => false,
    }
}
fn check_type(value: &Value, schema_type: &Value) -> Match {
    let matches = match schema_type {
        Value::String(name) => name
            .to_rust_string()
            .ok()
            .is_some_and(|name| type_matches(value, &name)),
        Value::Array(types) => types
            .iter()
            .any(|kind| as_string(kind).is_some_and(|name| type_matches(value, &name))),
        _ => return Match::No,
    };
    if matches {
        Match::Yes
    } else {
        Match::No
    }
}
fn number_constraint(value: &Value, schema: &Value, name: &str, lower: bool) -> Match {
    let Some(bound) = field(schema, name) else {
        return Match::Yes;
    };
    match (value, bound) {
        (Value::Number(actual), Value::Number(bound)) => {
            if (lower && actual < bound) || (!lower && actual > bound) {
                Match::No
            } else {
                Match::Yes
            }
        }
        (Value::Number(_), _) => Match::Unknown,
        _ => Match::Yes,
    }
}
fn length_constraint(length: usize, schema: &Value, name: &str, lower: bool) -> Match {
    let Some(bound) = field(schema, name) else {
        return Match::Yes;
    };
    match bound {
        Value::Number(bound) if bound.is_finite() => {
            let failed = if lower {
                (length as f64) < *bound
            } else {
                (length as f64) > *bound
            };
            if failed {
                Match::No
            } else {
                Match::Yes
            }
        }
        _ => Match::Unknown,
    }
}
fn required(value: &Value, schema: &Value) -> Match {
    let names = match field(schema, "required") {
        None | Some(Value::Null) => return Match::Yes,
        Some(Value::Array(names)) => names,
        Some(_) => return Match::Unknown,
    };
    let Value::Object(object) = value else {
        return Match::Yes;
    };
    for name in names {
        let Some(name) = as_string(name) else {
            // JS coerces non-string entries to property keys. Keep them possible.
            return Match::Unknown;
        };
        if object.get(&JsString::from(name)).is_none() {
            return Match::No;
        }
    }
    Match::Yes
}

fn match_schema(
    value: &Value,
    schema: &Value,
    budget: &mut Budget,
    depth: usize,
) -> Result<Match, PrivacyError> {
    budget.tick(depth)?;
    let Value::Object(_) = schema else {
        // The JS helper treats non-object schemas as empty schemas.
        return Ok(Match::Yes);
    };
    let mut result = Match::Yes;
    if let Some(all) = array(field(schema, "allOf")) {
        for branch in all {
            result = result.and(match_schema(value, branch, budget, depth + 1)?);
            if result == Match::No {
                return Ok(Match::No);
            }
        }
    }
    for union_name in ["anyOf", "oneOf"] {
        let Some(branches) = array(field(schema, union_name)) else {
            continue;
        };
        let mut yes = 0;
        let mut unknown = 0;
        for branch in branches {
            match match_schema(value, branch, budget, depth + 1)? {
                Match::Yes => yes += 1,
                Match::Unknown => unknown += 1,
                Match::No => {}
            }
        }
        let union = if union_name == "anyOf" {
            if yes > 0 {
                Match::Yes
            } else if unknown > 0 {
                Match::Unknown
            } else {
                Match::No
            }
        } else if yes > 1 {
            Match::No
        } else if yes == 1 && unknown == 0 {
            Match::Yes
        } else if yes == 0 && unknown == 0 {
            Match::No
        } else {
            Match::Unknown
        };
        result = result.and(union);
        if result == Match::No {
            return Ok(Match::No);
        }
    }
    if let Some(not) = field(schema, "not") {
        if is_object(not) {
            match match_schema(value, not, budget, depth + 1)? {
                Match::Yes => return Ok(Match::No),
                Match::No => {}
                Match::Unknown => result = result.and(Match::Unknown),
            }
        }
    }
    if let Some(schema_type) = field(schema, "type") {
        result = result.and(check_type(value, schema_type));
        if result == Match::No {
            return Ok(Match::No);
        }
    }
    if let Some(enums) = array(field(schema, "enum")) {
        let mut found = false;
        for item in enums {
            if json_equal(value, item, budget, depth + 1)? {
                found = true;
                break;
            }
        }
        if !found {
            result = result.and(Match::No);
        }
    } else if field(schema, "enum").is_some() {
        result = result.and(Match::Unknown);
    }
    if result == Match::No {
        return Ok(Match::No);
    }

    match value {
        Value::String(text) => {
            result = result
                .and(length_constraint(text.len(), schema, "minLength", true))
                .and(length_constraint(text.len(), schema, "maxLength", false));
            if field(schema, "pattern").is_some() {
                // Do not substitute Rust regex semantics for ECMAScript RegExp.
                result = result.and(Match::Unknown);
            }
            if let Some(format) = field(schema, "format").and_then(as_string) {
                if matches!(
                    format.as_str(),
                    "uri" | "namespace-file" | "date" | "date-time" | "time-zone"
                ) {
                    // URL.canParse, the imported namespace regex, Date and Intl
                    // are not reimplemented here; keep this branch possible.
                    result = result.and(Match::Unknown);
                }
            } else if field(schema, "format").is_some() {
                result = result.and(Match::Unknown);
            }
        }
        Value::Number(_) => {
            result = result
                .and(number_constraint(value, schema, "minimum", true))
                .and(number_constraint(value, schema, "maximum", false));
        }
        Value::Array(items) => {
            result = result
                .and(length_constraint(items.len(), schema, "minItems", true))
                .and(length_constraint(items.len(), schema, "maxItems", false));
            if let Some(item_schema) = field(schema, "items").filter(|s| is_object(s)) {
                for item in items {
                    result = result.and(match_schema(item, item_schema, budget, depth + 1)?);
                    if result == Match::No {
                        return Ok(Match::No);
                    }
                }
            }
        }
        Value::Object(object) => {
            result = result.and(required(value, schema));
            if result == Match::No {
                return Ok(Match::No);
            }
            let properties = field(schema, "properties").filter(|v| is_object(v));
            let additional_false = matches!(
                field(schema, "additionalProperties"),
                Some(Value::Bool(false))
            );
            for (key, item) in object.insertion_entries() {
                if let Some(property_schema) =
                    properties.and_then(|props| as_object(props).and_then(|p| p.get(key)))
                {
                    result = result.and(match_schema(item, property_schema, budget, depth + 1)?);
                } else if additional_false {
                    return Ok(Match::No);
                } else if let Some(additional) =
                    field(schema, "additionalProperties").filter(|v| is_object(v))
                {
                    result = result.and(match_schema(item, additional, budget, depth + 1)?);
                }
                if result == Match::No {
                    return Ok(Match::No);
                }
            }
        }
        _ => {}
    }
    Ok(result)
}

fn privacy_schemas<'a>(
    value: &Value,
    schemas: &[&'a Value],
    active: &mut Vec<&'a Value>,
    budget: &mut Budget,
    depth: usize,
) -> Result<(), PrivacyError> {
    for schema in schemas {
        budget.tick(depth)?;
        let Value::Object(_) = schema else {
            continue;
        };
        active.push(schema);
        let mut selected = Vec::new();
        if let Some(all) = array(field(schema, "allOf")) {
            selected.extend(all.iter());
        }
        for union_name in ["anyOf", "oneOf"] {
            let Some(branches) = array(field(schema, union_name)) else {
                continue;
            };
            let mut possible = Vec::new();
            for branch in branches {
                if match_schema(value, branch, budget, depth + 1)? != Match::No {
                    possible.push(branch);
                }
            }
            if possible.is_empty() {
                // Canonical code falls back to every branch if none match.
                selected.extend(branches.iter());
            } else {
                selected.extend(possible);
            }
        }
        privacy_schemas(value, &selected, active, budget, depth + 1)?;
    }
    Ok(())
}

fn visit(
    value: &Value,
    schemas: &[&Value],
    reject: bool,
    budget: &mut Budget,
    depth: usize,
) -> Result<Value, PrivacyError> {
    budget.tick(depth)?;
    let mut active = Vec::new();
    privacy_schemas(value, schemas, &mut active, budget, depth + 1)?;
    if active
        .iter()
        .any(|schema| matches!(field(schema, "writeOnly"), Some(Value::Bool(true))))
    {
        return if reject {
            Err(crate::cause!(PrivacyError::WriteOnly))
        } else {
            Ok(Value::String(JsString::from(REDACTION)))
        };
    }
    match value {
        Value::Array(items) => {
            let mut projected = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                let mut child_schemas = Vec::new();
                for schema in &active {
                    let Some(items) = field(schema, "items") else {
                        continue;
                    };
                    let shape = match items {
                        Value::Array(tuple) => tuple.get(index),
                        other => Some(other),
                    };
                    if let Some(shape) = shape.filter(|shape| is_object(shape)) {
                        child_schemas.push(shape);
                    }
                }
                projected.push(visit(item, &child_schemas, reject, budget, depth + 1)?);
            }
            Ok(Value::Array(projected))
        }
        Value::Object(object) => {
            let mut projected = Object::new();
            for (key, item) in object.insertion_entries() {
                let mut child_schemas = Vec::new();
                for schema in &active {
                    let properties = field(schema, "properties");
                    let property_schema = properties
                        .and_then(as_object)
                        .and_then(|properties| properties.get(key));
                    let shape = property_schema
                        .filter(|shape| !matches!(shape, Value::Null))
                        .or_else(|| {
                            field(schema, "additionalProperties").filter(|value| is_object(value))
                        });
                    if let Some(shape) = shape.filter(|shape| is_object(shape)) {
                        child_schemas.push(shape);
                    }
                }
                projected.insert(
                    key.clone(),
                    visit(item, &child_schemas, reject, budget, depth + 1)?,
                );
            }
            Ok(Value::Object(projected))
        }
        scalar => Ok(scalar.clone()),
    }
}

/// Return the operationPrivateValue projection, replacing each writeOnly value.
pub fn operation_private_value(value: &Value, schema: &Value) -> Result<Value, PrivacyError> {
    visit(value, &[schema], false, &mut Budget::default(), 0)
}

/// Reject replay of any value reached through a writeOnly schema.
pub fn assert_replayable_input(value: &Value, schema: &Value) -> Result<(), PrivacyError> {
    visit(value, &[schema], true, &mut Budget::default(), 0).map(|_| ())
}
