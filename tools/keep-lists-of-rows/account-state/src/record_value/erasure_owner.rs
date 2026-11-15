//! Resolve the canonical physical key owner for one model-declared erasable
//! record. This ports the selected-owner logic over the existing stored/key
//! supply; it opens no SQL connection and creates no authority.

use super::{KeyState, Supply};
use crate::{
    ecma_json::{self, JsString, Value},
    record_sealed,
};
use std::{collections::HashMap, fmt};

const MAX_CHAIN: usize = 64;
const MAX_PATH_PARTS: usize = 128;
const MAX_KINDS: usize = 100_000;
const MAX_PATHS: usize = 4096;
const MAX_MODEL_UNITS: usize = 1_048_576;

/// Source-free result preserving the full current inheritance walk.
/// physical_owner is derived from sealed fields on the initial row, or from
/// its model fallback. owner is available only after the current chain/key
/// checks pass. Visited order is retained even when the endpoint is identical.
pub struct OwnerResolution {
    pub physical_owner: Option<String>,
    pub owner: Option<String>,
    pub visited: Vec<String>,
}
impl fmt::Debug for OwnerResolution {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("OwnerResolution([redacted])")
    }
}

#[derive(Clone, Debug)]
pub enum OwnerError {
    Invalid(crate::refusal_cause::Cause),
    Bounds(crate::refusal_cause::Cause),
    Source(crate::refusal_cause::Cause),
    InvalidModel(crate::refusal_cause::Cause),
    DistinctPhysicalOwners(crate::refusal_cause::Cause),
    Cycle(crate::refusal_cause::Cause),
    Depth(crate::refusal_cause::Cause),
}
impl OwnerError {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { match self {
        Self::Invalid(cause) => cause,
        Self::Bounds(cause) => cause,
        Self::Source(cause) => cause,
        Self::InvalidModel(cause) => cause,
        Self::DistinctPhysicalOwners(cause) => cause,
        Self::Cycle(cause) => cause,
        Self::Depth(cause) => cause,
    } }
}
crate::impl_caused!(OwnerError);

impl PartialEq for OwnerError { fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) } }
impl Eq for OwnerError {}

impl fmt::Display for OwnerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid(_) => "record erasure owner input refused",
            Self::Bounds(_) => "record erasure owner walk exceeded its bound",
            Self::Source(_) => "current record erasure owner source unavailable",
            Self::InvalidModel(_) => "record erasure owner model refused",
            Self::DistinctPhysicalOwners(_) => "sealed fields have distinct physical owners",
            Self::Cycle(_) => "record erasure owner chain is cyclic",
            Self::Depth(_) => "record erasure owner chain exceeds its bound",
        })
    }
}
impl std::error::Error for OwnerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

#[derive(Default, Clone)]
struct Kind {
    erasable: Vec<Vec<JsString>>,
    key_path: Option<Vec<JsString>>,
}
type Kinds = HashMap<String, Kind>;

/// Parsed immutable erasure rules for one supplied model value.
///
/// Construct this once per model boundary, then reuse it for every resolution
/// in that operation. The parsed paths are private and exposed only through
/// read-only queries.
pub struct ErasureModel {
    kinds: Kinds,
}
impl ErasureModel {
    /// Parse the model's `kinds`, `erasable`, and `erasable_key` DATA.
    pub fn from_model(model: &Value) -> Result<Self, OwnerError> {
        Ok(Self {
            kinds: kinds(model)?,
        })
    }

    /// Return the declared erasable paths for a kind without reading a source.
    pub fn erasable_fields(&self, kind: &str) -> &[Vec<JsString>] {
        self.kinds
            .get(kind)
            .map(|kind| kind.erasable.as_slice())
            .unwrap_or(&[])
    }
}

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(object) => object.get(&JsString::from(name)),
        _ => None,
    }
}
fn string(value: &Value) -> Option<&JsString> {
    match value {
        Value::String(value) => Some(value),
        _ => None,
    }
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(number) => *number != 0.0 && !number.is_nan(),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) | Value::Bool(true) => true,
    }
}
fn parse_path(value: &Value, allow_empty: bool) -> Result<Vec<JsString>, OwnerError> {
    let parts: Vec<JsString> = match value {
        Value::String(name) => vec![name.clone()],
        Value::Array(parts) => parts
            .iter()
            .map(|part| string(part).cloned().ok_or(crate::cause!(OwnerError::InvalidModel)))
            .collect::<Result<_, _>>()?,
        _ => return Err(crate::cause!(OwnerError::InvalidModel)),
    };
    if (!allow_empty && parts.is_empty()) || parts.len() > MAX_PATH_PARTS {
        return Err(crate::cause!(OwnerError::InvalidModel));
    }
    Ok(parts)
}
fn kinds(model: &Value) -> Result<Kinds, OwnerError> {
    let rows = match field(&model, "kinds") {
        None | Some(Value::Null) => return Ok(HashMap::new()),
        Some(Value::Array(rows)) if rows.len() <= MAX_KINDS => rows,
        Some(_) => return Err(crate::cause!(OwnerError::InvalidModel)),
    };
    let mut output = HashMap::<String, Kind>::new();
    let mut paths = 0usize;
    let mut units = 0usize;
    for row in rows {
        let Some(name) = field(row, "type").and_then(string) else {
            return Err(crate::cause!(OwnerError::InvalidModel));
        };
        let name = name
            .to_rust_string()
            .map_err(|error| OwnerError::InvalidModel(error.cause()))?;
        if name.is_empty() {
            return Err(crate::cause!(OwnerError::InvalidModel));
        }
        units = units
            .checked_add(name.len())
            .filter(|n| *n <= MAX_MODEL_UNITS)
            .ok_or(crate::cause!(OwnerError::Bounds))?;
        let mut kind = output.remove(&name).unwrap_or_default();
        if let Some(Value::Array(fields)) = field(row, "erasable") {
            if !fields.is_empty() {
                kind.erasable.clear();
                for value in fields {
                    let path = parse_path(value, false)?;
                    paths = paths.checked_add(1).ok_or(crate::cause!(OwnerError::Bounds))?;
                    if paths > MAX_PATHS {
                        return Err(crate::cause!(OwnerError::Bounds));
                    }
                    for part in &path {
                        units = units
                            .checked_add(part.len())
                            .filter(|n| *n <= MAX_MODEL_UNITS)
                            .ok_or(crate::cause!(OwnerError::Bounds))?;
                    }
                    kind.erasable.push(path);
                }
            }
        }
        if let Some(key_path) = field(row, "erasable_key").filter(|path| truthy(path)) {
            let path = parse_path(key_path, true)?;
            for part in &path {
                units = units
                    .checked_add(part.len())
                    .filter(|n| *n <= MAX_MODEL_UNITS)
                    .ok_or(crate::cause!(OwnerError::Bounds))?;
            }
            kind.key_path = Some(path);
        }
        output.insert(name, kind);
    }
    Ok(output)
}
fn at_path<'a>(value: &'a Value, path: &[JsString]) -> Option<&'a Value> {
    let mut current = value;
    for part in path {
        current = match current {
            Value::Object(object) => object.get(part)?,
            _ => return None,
        };
    }
    Some(current)
}
fn js_text(value: &JsString) -> Result<String, OwnerError> {
    value.to_rust_string().map_err(|error| OwnerError::Invalid(error.cause()))
}
fn key_id_for(kind: &str, id: &str, value: &Value, kinds: &Kinds) -> Result<String, OwnerError> {
    let Some(path) = kinds.get(kind).and_then(|kind| kind.key_path.as_deref()) else {
        return Ok(id.to_owned());
    };
    if let Some(Value::String(named)) = at_path(value, path).filter(|value| truthy(value)) {
        return js_text(named);
    }
    Ok(id.to_owned())
}
fn parsed_row(supply: &mut impl Supply, id: &str) -> Result<Option<(String, Value)>, OwnerError> {
    supply.assert_current().map_err(|error| OwnerError::Source(error.cause()))?;
    let stored = supply.stored(id).map_err(|error| OwnerError::Source(error.cause()))?;
    supply.assert_current().map_err(|error| OwnerError::Source(error.cause()))?;
    let Some(stored) = stored else {
        return Ok(None);
    };
    if stored.id != id || stored.record_type.is_empty() {
        return Err(crate::cause!(OwnerError::Source));
    }
    let value = ecma_json::parse(stored.value_json.as_bytes(), ecma_json::Limits::default())
        .map_err(|error| OwnerError::Source(error.cause()))?;
    Ok(Some((stored.record_type, value)))
}
fn key_state(supply: &mut impl Supply, id: &str) -> Result<KeyStatus, OwnerError> {
    supply.assert_current().map_err(|error| OwnerError::Source(error.cause()))?;
    let state = supply.key(id).map_err(|error| OwnerError::Source(error.cause()))?;
    supply.assert_current().map_err(|error| OwnerError::Source(error.cause()))?;
    Ok(match state {
        KeyState::Present(key) => {
            drop(key);
            KeyStatus::Present
        }
        KeyState::Missing => KeyStatus::Missing,
        KeyState::Erased => KeyStatus::Erased,
    })
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum KeyStatus {
    Present,
    Missing,
    Erased,
}
fn falsey_record(kind: &str, value: &Value) -> bool {
    kind.is_empty() || !truthy(value)
}
fn resolution(
    physical_owner: Option<String>,
    owner: Option<String>,
    visited: Vec<String>,
) -> OwnerResolution {
    OwnerResolution {
        physical_owner,
        owner,
        visited,
    }
}

/// Resolve with a previously parsed model and the caller's actual current Supply.
pub fn erasure_owner_of_with_model(
    id: &str,
    supply: &mut impl Supply,
    model: &ErasureModel,
) -> Result<OwnerResolution, OwnerError> {
    if id.is_empty() || id.len() > 4096 || id.chars().any(char::is_control) {
        return Err(crate::cause!(OwnerError::Invalid));
    }
    supply.assert_current().map_err(|error| OwnerError::Source(error.cause()))?;
    let Some((original_type, original_value)) = parsed_row(supply, id)? else {
        supply.assert_current().map_err(|error| OwnerError::Source(error.cause()))?;
        return Ok(resolution(None, None, Vec::new()));
    };
    if falsey_record(&original_type, &original_value) {
        supply.assert_current().map_err(|error| OwnerError::Source(error.cause()))?;
        return Ok(resolution(None, None, Vec::new()));
    }

    let original_kind = model.kinds.get(&original_type).cloned().unwrap_or_default();
    let mut sealed_owners = Vec::new();
    for path in &original_kind.erasable {
        if let Some(Value::Object(object)) = at_path(&original_value, path) {
            if record_sealed::is_sealed(object) {
                let owner =
                    record_sealed::key_owner(id, object).map_err(|error| OwnerError::Invalid(error.cause()))?;
                if !sealed_owners.iter().any(|existing| existing == &owner) {
                    sealed_owners.push(owner);
                    if sealed_owners.len() > 1 {
                        return Err(crate::cause!(OwnerError::DistinctPhysicalOwners));
                    }
                }
            }
        }
    }
    let physical_owner = match sealed_owners.first() {
        Some(owner) => owner.clone(),
        None => key_id_for(&original_type, id, &original_value, &model.kinds)?,
    };

    let mut owner = id.to_owned();
    let mut seen = Vec::with_capacity(MAX_CHAIN);
    let mut visited = Vec::with_capacity(MAX_CHAIN);
    for _ in 0..MAX_CHAIN {
        if seen.iter().any(|existing| existing == &owner) {
            return Err(crate::cause!(OwnerError::Cycle));
        }
        seen.push(owner.clone());
        visited.push(owner.clone());

        let Some((owner_type, owner_value)) = parsed_row(supply, &owner)? else {
            supply.assert_current().map_err(|error| OwnerError::Source(error.cause()))?;
            return Ok(resolution(Some(physical_owner), None, visited));
        };
        if falsey_record(&owner_type, &owner_value) {
            supply.assert_current().map_err(|error| OwnerError::Source(error.cause()))?;
            return Ok(resolution(Some(physical_owner), None, visited));
        }
        if key_state(supply, &owner)? == KeyStatus::Erased {
            supply.assert_current().map_err(|error| OwnerError::Source(error.cause()))?;
            return Ok(resolution(Some(physical_owner), None, visited));
        }
        let parent = key_id_for(&owner_type, &owner, &owner_value, &model.kinds)?;
        if parent == owner {
            let owner_kind = model.kinds.get(&owner_type).cloned().unwrap_or_default();
            let final_key = if !owner_kind.erasable.is_empty() {
                key_state(supply, &physical_owner)? == KeyStatus::Present
            } else {
                false
            };
            supply.assert_current().map_err(|error| OwnerError::Source(error.cause()))?;
            return Ok(resolution(
                Some(physical_owner.clone()),
                final_key.then_some(physical_owner),
                visited,
            ));
        }
        owner = parent;
    }
    Err(crate::cause!(OwnerError::Depth))
}
