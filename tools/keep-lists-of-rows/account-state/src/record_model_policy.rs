//! Supplies the canonical nested erasable-field policy to logical record reads, from the record model the tools
//! installed for an account declare (`installed`).
//! Model interpretation follows record-log-store.mjs; it does not infer paths
//! from stored ciphertext or create a second model.
use crate::ecma_json::{self, JsString, Value};
use std::{collections::HashSet, fmt};

const MAX_NODES: usize = 100_000;
const MAX_DEPTH: usize = 128;
const MAX_UNITS: usize = 1_048_576;
const MAX_PATHS: usize = 4096;

#[derive(Clone, Debug)]
pub enum Error {
    Invalid(crate::refusal_cause::Cause),
    Bounds(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Invalid(cause) => cause,
            Self::Bounds(cause) => cause,
        }
    }
}
crate::impl_caused!(Error);

// Equality keeps the domain classification; source identity is compared explicitly via cause().
impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) }
}
impl Eq for Error {}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid(_) => "record model policy input refused",
            Self::Bounds(_) => "record model policy exceeds bounds",
        })
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
pub type Result<T> = std::result::Result<T, Error>;

mod installed;
pub use installed::{own_model, installed, model_data, open_policy, stays_on_this_device, Installed, duplicates, Duplicate};
#[cfg(test)]
pub(crate) use installed::{install_test_tools, list_rule_model, state_with_tool_model, test_state};

fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(object) => object.get(&JsString::from(key)),
        _ => None,
    }
}
fn string(value: &Value) -> Option<&JsString> {
    if let Value::String(value) = value {
        Some(value)
    } else {
        None
    }
}
fn rows(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(rows)) => rows,
        _ => &[],
    }
}

fn measure(value: &Value, depth: usize, nodes: &mut usize, units: &mut usize) -> Result<()> {
    *nodes = nodes.checked_add(1).ok_or(crate::cause!(Error::Bounds))?;
    if *nodes > MAX_NODES || depth > MAX_DEPTH {
        return Err(crate::cause!(Error::Bounds));
    }
    match value {
        Value::String(value) => *units = units.checked_add(value.len()).ok_or(crate::cause!(Error::Bounds))?,
        Value::Array(items) => {
            if items.len() > MAX_NODES {
                return Err(crate::cause!(Error::Bounds));
            }
            for item in items {
                measure(item, depth + 1, nodes, units)?;
            }
        }
        Value::Object(object) => {
            if object.len() > MAX_NODES {
                return Err(crate::cause!(Error::Bounds));
            }
            for (key, value) in object.insertion_entries() {
                *units = units.checked_add(key.len()).ok_or(crate::cause!(Error::Bounds))?;
                measure(value, depth + 1, nodes, units)?;
            }
        }
        _ => {}
    }
    if *units > MAX_UNITS {
        return Err(crate::cause!(Error::Bounds));
    }
    Ok(())
}

fn bounded(model: &Value, erasable: &Value) -> Result<()> {
    let mut nodes = 0;
    let mut units = 0;
    measure(model, 0, &mut nodes, &mut units)?;
    measure(erasable, 0, &mut nodes, &mut units)?;
    // Encoded byte bound also covers number/output expansion in the value model.
    let limits = ecma_json::Limits {
        input_bytes: MAX_UNITS * 4,
        output_bytes: MAX_UNITS * 4,
        depth: MAX_DEPTH,
        nodes: MAX_NODES,
        string_units: MAX_UNITS,
        total_string_units: MAX_UNITS,
        container_entries: MAX_NODES,
        number_bytes: ecma_json::HARD_NUMBER_BYTES,
    };
    for value in [model, erasable] {
        ecma_json::stringify(value, limits).map_err(|error| Error::Bounds(error.cause()))?;
    }
    Ok(())
}

fn path_of(value: &Value) -> Result<Vec<JsString>> {
    match value {
        Value::String(value) => Ok(vec![value.clone()]),
        Value::Array(parts) => {
            if parts.is_empty() || parts.len() > MAX_DEPTH {
                return Err(crate::cause!(Error::Invalid));
            }
            parts
                .iter()
                .map(|part| string(part).cloned().ok_or(crate::cause!(Error::Invalid)))
                .collect()
        }
        _ => Err(crate::cause!(Error::Invalid)),
    }
}

/// Mirrors record-log-store's `erasableByType` merge and nestedErasable union:
/// legacy erasable DATA is inserted first, then non-empty per-kind `erasable`
/// declarations replace that type's legacy value. `erase_fields` is purposely
/// excluded because those fields are scrubbed on erasure, not sealed for opening.
fn nested_erasable_paths(model: &Value, erasable: &Value) -> Result<Vec<Vec<JsString>>> {
    bounded(model, erasable)?;
    if !matches!(model, Value::Object(_)) {
        return Err(crate::cause!(Error::Invalid));
    }
    if !matches!(erasable, Value::Object(_)) {
        return Err(crate::cause!(Error::Invalid));
    }
    let kinds_value = get(model, "kinds");
    if kinds_value.is_some() && !matches!(kinds_value, Some(Value::Array(_))) {
        return Err(crate::cause!(Error::Invalid));
    }

    let mut by_type: Vec<(JsString, Vec<Value>)> = Vec::new();
    if let Value::Object(entries) = erasable {
        for (kind, fields) in entries.property_entries() {
            if let Value::Array(fields) = fields {
                if !fields.is_empty() {
                    by_type.push((kind.clone(), fields.clone()));
                }
            }
        }
    }
    for kind in rows(kinds_value) {
        let kind_name = get(kind, "type")
            .and_then(string)
            .filter(|name| !name.is_empty())
            .ok_or(crate::cause!(Error::Invalid))?
            .clone();
        if let Some(Value::Array(fields)) = get(kind, "erasable") {
            if !fields.is_empty() {
                if let Some((_, prior)) = by_type.iter_mut().find(|(name, _)| name == &kind_name) {
                    *prior = fields.clone();
                } else {
                    by_type.push((kind_name, fields.clone()));
                }
            }
        } else if get(kind, "erasable").is_some() {
            return Err(crate::cause!(Error::Invalid));
        }
    }

    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    for (_, fields) in by_type {
        for field in fields {
            let path = path_of(&field)?;
            if path.len() > 1 && seen.insert(path.clone()) {
                if paths.len() >= MAX_PATHS {
                    return Err(crate::cause!(Error::Bounds));
                }
                paths.push(path);
            }
        }
    }
    Ok(paths)
}

#[cfg(test)]
mod compiled_policy_controls {
    use super::{nested_erasable_paths, Error, JsString, Value};

    fn json(raw: &str) -> Value {
        crate::ecma_json::parse(raw.as_bytes(), crate::ecma_json::Limits::default()).unwrap()
    }

    fn path(parts: &[&str]) -> Vec<JsString> {
        parts.iter().map(|part| JsString::from(*part)).collect()
    }

    #[test]
    fn legacy_only_paths_and_nonempty_per_kind_override_match_store_merge() {
        let model = json(r#"{"kinds":[{"type":"message","erasable":[["body","text"]]}]}"#);
        let legacy = json(r#"{"message":[["legacy","text"]],"legacy-kind":[["payload","words"]]}"#);
        let paths = nested_erasable_paths(&model, &legacy).unwrap();
        assert!(paths.contains(&path(&["body", "text"])));
        assert!(paths.contains(&path(&["payload", "words"])));
        assert!(!paths.contains(&path(&["legacy", "text"])));
    }

    #[test]
    fn dotted_string_is_flat_but_array_declaration_is_nested() {
        let model = json("{}");
        let dotted = json(r#"{"kind":["payload.words"]}"#);
        let array = json(r#"{"kind":[["payload","words"]]}"#);
        assert!(nested_erasable_paths(&model, &dotted).unwrap().is_empty());
        assert_eq!(
            nested_erasable_paths(&model, &array).unwrap(),
            vec![path(&["payload", "words"])],
        );
    }

    #[test]
    fn malformed_model_and_path_refuse() {
        for model in [Value::Null, Value::Bool(false), Value::Number(4.0)] {
            assert_eq!(
                nested_erasable_paths(&model, &json("{}")).unwrap_err(),
                crate::cause!(Error::Invalid)
            );
        }
        let missing_kind_type = json(r#"{"kinds":[{"erasable":[["body","text"]]}]}"#);
        assert_eq!(
            nested_erasable_paths(&missing_kind_type, &json("{}")).unwrap_err(),
            crate::cause!(Error::Invalid),
        );
        let malformed_path = json(r#"{"kinds":[{"type":"message","erasable":[["body",1]]}]}"#);
        assert_eq!(
            nested_erasable_paths(&malformed_path, &json("{}")).unwrap_err(),
            crate::cause!(Error::Invalid),
        );
    }

    #[test]
    fn aggregate_model_and_erasable_budget_is_enforced() {
        let model = Value::Array(vec![Value::Null; 50_000]);
        let erasable = Value::Array(vec![Value::Null; 50_000]);
        assert_eq!(
            nested_erasable_paths(&model, &erasable).unwrap_err(),
            crate::cause!(Error::Bounds),
        );
    }
}
