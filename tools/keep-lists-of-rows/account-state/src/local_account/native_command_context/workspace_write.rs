//! Proposed `workspace:write` request/result boundary. This child is deliberately
//! unmounted while native owns the release epoch and the shared command parent.
//! Source: trillion/src/native-workspace-records.mjs and workspace/conflicts.mjs.
//! The existing command journal must own begin, effect, protected result and
//! recovery; this child never treats a repeated permit as a new write.

use crate::ecma_json::{self, JsString, Object, Value};
use content_crypto::advanced::blake3;

pub const OPERATION: &str = "workspace:write";
pub const MAX_WRITES: usize = 64;
pub const MAX_LABELS: usize = 256;
pub const MAX_LABEL_UNITS: usize = 300;
pub const MAX_VALUE_UNITS: usize = 1_000_000;

/// Mirrors the installed inputSchema oneOf. Extra properties remain legal in
/// the original schema, so this parser never silently makes them invalid.
pub const INPUT_SCHEMA: &str = r#"{"type":"object","properties":{"writes":{"type":"array","minItems":1,"maxItems":64,"items":{"type":"object","required":["address_label","payload"],"properties":{"address_label":{"type":"string","minLength":1,"maxLength":300},"payload":{},"expected_identity":{"type":["string","null"]},"scope_id":{"type":"string","minLength":1,"maxLength":300}}}},"conflict_policy":{"type":"string","enum":["preserve","retry"]},"resolve_conflict":{"type":"object","required":["id","branch_identity"],"properties":{"id":{"type":"string","minLength":1},"branch_identity":{"type":"string","minLength":1}}}},"oneOf":[{"required":["writes"],"not":{"required":["resolve_conflict"]}},{"required":["resolve_conflict"],"not":{"required":["writes"]}}]}"#;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Policy {
    Preserve,
    Retry,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Write {
    pub address_label: JsString,
    pub payload: Value,
    /// None = no condition; Some(None) = condition that address is absent.
    pub expected_identity: Option<Option<JsString>>,
    pub scope_id: Option<JsString>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Writes {
        writes: Vec<Write>,
        policy: Policy,
    },
    Resolve {
        id: JsString,
        branch_identity: JsString,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidInput(crate::refusal_cause::Cause),
    TooLarge(crate::refusal_cause::Cause),
    InvalidResult(crate::refusal_cause::Cause),
    IdentityUnavailable(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::InvalidInput(cause) => cause.clone(),
            Self::TooLarge(cause) => cause.clone(),
            Self::InvalidResult(cause) => cause.clone(),
            Self::IdentityUnavailable(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Error);


/// Only the ordinary successful count contains no workspace words. Every
/// conflict or resolution reply names (and sometimes includes) current saved
/// state. The final result owner must qualify that source before retention or
/// disclosure; this classification alone grants no authority to seal it.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ResultDependence {
    CountOnly,
    WorkspaceSource,
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    if let Value::Object(object) = value {
        object.get(&JsString::from(key))
    } else {
        None
    }
}
fn string(value: &Value) -> Result<JsString, Error> {
    let Value::String(value) = value else {
        return Err(crate::cause!(Error::InvalidInput));
    };
    Ok(value.clone())
}
fn nonempty(value: &Value) -> Result<JsString, Error> {
    let text = string(value)?;
    if text.is_empty() {
        Err(crate::cause!(Error::InvalidInput))
    } else {
        Ok(text)
    }
}
fn count(value: &Value) -> Option<usize> {
    let Value::Number(value) = value else {
        return None;
    };
    if value.is_finite() && *value >= 0.0 && value.fract() == 0.0 && *value <= 64.0 {
        Some(*value as usize)
    } else {
        None
    }
}

pub fn parse_input(input: &Value) -> Result<Action, Error> {
    if !matches!(input, Value::Object(_)) {
        return Err(crate::cause!(Error::InvalidInput));
    }
    let policy = match field(input, "conflict_policy") {
        None => Policy::Preserve,
        Some(Value::String(s)) if s == &JsString::from("preserve") => Policy::Preserve,
        Some(Value::String(s)) if s == &JsString::from("retry") => Policy::Retry,
        _ => return Err(crate::cause!(Error::InvalidInput)),
    };
    let writes = field(input, "writes");
    let resolve = field(input, "resolve_conflict");
    match (writes, resolve) {
        (Some(Value::Array(items)), None) => {
            if items.is_empty() || items.len() > MAX_WRITES {
                return Err(crate::cause!(Error::InvalidInput));
            }
            let mut parsed = Vec::with_capacity(items.len());
            for item in items {
                let address = nonempty(field(item, "address_label").ok_or(crate::cause!(Error::InvalidInput))?)?;
                if address.len() > MAX_LABEL_UNITS
                    || address
                        .units()
                        .starts_with(JsString::from("workspace-conflict:").units())
                {
                    return Err(crate::cause!(Error::InvalidInput));
                }
                let payload = field(item, "payload").ok_or(crate::cause!(Error::InvalidInput))?.clone();
                let encoded = ecma_json::stringify(&payload, Default::default())
                    .map_err(|error| Error::TooLarge(error.cause()))?;
                if encoded.encode_utf16().count() > MAX_VALUE_UNITS {
                    return Err(crate::cause!(Error::TooLarge));
                }
                let expected_identity = match field(item, "expected_identity") {
                    None => None,
                    Some(Value::Null) => Some(None),
                    Some(Value::String(s)) => Some(Some(s.clone())),
                    _ => return Err(crate::cause!(Error::InvalidInput)),
                };
                let scope_id = match field(item, "scope_id") {
                    None => None,
                    Some(Value::String(value))
                        if !value.is_empty()
                            && value.len() <= MAX_LABEL_UNITS
                            && !String::from_utf16_lossy(value.units()).trim().is_empty() =>
                    {
                        Some(value.clone())
                    }
                    _ => return Err(crate::cause!(Error::InvalidInput)),
                };
                parsed.push(Write {
                    address_label: address,
                    payload,
                    expected_identity,
                    scope_id,
                });
            }
            Ok(Action::Writes {
                writes: parsed,
                policy,
            })
        }
        (None, Some(Value::Object(_))) => {
            let id = nonempty(field(resolve.unwrap(), "id").ok_or(crate::cause!(Error::InvalidInput))?)?;
            let branch_identity =
                nonempty(field(resolve.unwrap(), "branch_identity").ok_or(crate::cause!(Error::InvalidInput))?)?;
            Ok(Action::Resolve {
                id,
                branch_identity,
            })
        }
        _ => Err(crate::cause!(Error::InvalidInput)),
    }
}

/// The installed schema has no writeOnly annotation on `payload`. The native
/// command must not persist it as plaintext merely because the old schema
/// omitted that hint. Its independent full-input digest still binds exact
/// retries; this value is only the journal's durable input copy.
pub fn private_persistence_value(input: &Value) -> Result<Value, Error> {
    parse_input(input)?;
    let mut marker = Object::new();
    marker.insert(
        "workspace_write".into(),
        Value::String("[write-only]".into()),
    );
    Ok(Value::Object(marker))
}

/// The source identity is BLAKE3 of JSON.stringify(value), without the
/// decision-store canonical key sort. It is used for expected_identity and
/// conflict branches. Result identities have a different canonical owner.
pub fn workspace_value_identity(value: &Value) -> Result<String, Error> {
    let json =
        ecma_json::stringify(value, Default::default()).map_err(|error| Error::IdentityUnavailable(error.cause()))?;
    Ok(format!("1f:{}", blake3::hash(json.as_bytes()).to_hex()))
}

/// Source conflict ID: BLAKE3 of JSON.stringify([address, ordered branches]).
/// The sort keys are ASCII identity words, so their Rust byte order is the
/// source's lexical order. This returns only the ID; the SQL effect still owns
/// row creation, first-seen clocks, branches, and reopening a resolved fork.
pub fn conflict_id(
    address: &JsString,
    current: Option<&Value>,
    incoming: Option<&Value>,
) -> Result<String, Error> {
    let mut branches = Vec::with_capacity(2);
    for value in [current, incoming] {
        let found = value.is_some();
        let identity = match value {
            Some(value) => workspace_value_identity(value)?,
            None => "missing".to_owned(),
        };
        let key = format!("{}:{identity}", if found { '1' } else { '0' });
        branches.push((
            key,
            Value::Array(vec![
                Value::Bool(found),
                Value::String(identity.as_str().into()),
            ]),
        ));
    }
    branches.sort_by(|a, b| a.0.cmp(&b.0));
    branches.dedup_by(|a, b| a.0 == b.0);
    let source = Value::Array(vec![
        Value::String(address.clone()),
        Value::Array(branches.into_iter().map(|(_, branch)| branch).collect()),
    ]);
    workspace_value_identity(&source)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HybridClock {
    pub wall_ms: i64,
    pub logical: i64,
    pub device_id: String,
}

/// Same three-way max rule as workspace/conflicts.mjs tickHybridClock.
pub fn tick_hybrid_clock(
    previous: Option<&HybridClock>,
    received: Option<&HybridClock>,
    now_ms: i64,
    device_id: &str,
) -> HybridClock {
    let (p_wall, p_logical) = previous.map_or((0, 0), |clock| (clock.wall_ms, clock.logical));
    let (r_wall, r_logical) = received.map_or((0, 0), |clock| (clock.wall_ms, clock.logical));
    let wall = now_ms.max(p_wall).max(r_wall);
    let logical = if wall == p_wall && wall == r_wall {
        p_logical.max(r_logical) + 1
    } else if wall == p_wall {
        p_logical + 1
    } else if wall == r_wall {
        r_logical + 1
    } else {
        0
    };
    HybridClock {
        wall_ms: wall,
        logical,
        device_id: device_id.to_owned(),
    }
}

/// Exact public variants from putWorkspaceRecords/resolveWorkspaceConflict.
/// This checks shape only; the selected SQL effect must produce the values.
/// Preserve-current summaries can contain the record value, so the enclosing
/// protected result and erasure owner must be qualified before this is mounted.
pub fn result_matches(action: &Action, result: &Value) -> bool {
    match action {
        Action::Writes { writes, .. } => {
            let Some(written) = field(result, "written").and_then(count) else {
                return false;
            };
            match field(result, "conflicts") {
                None => written == writes.len(),
                Some(Value::Array(conflicts)) if written == 0 => conflicts.iter().all(|conflict| {
                    let current = field(conflict, "current");
                    matches!(field(conflict, "address"), Some(Value::String(_)))
                        && matches!(
                            current.and_then(|v| field(v, "found")),
                            Some(Value::Bool(_))
                        )
                        && matches!(
                            current.and_then(|v| field(v, "identity")),
                            Some(Value::String(_))
                        )
                }),
                _ => false,
            }
        }
        Action::Resolve { .. } => match field(result, "resolved") {
            Some(Value::Bool(true)) => {
                matches!(field(result, "address"), Some(Value::String(_)))
                    && matches!(field(result, "kept"), Some(Value::String(_)))
            }
            Some(Value::Bool(false)) => {
                matches!(field(result, "conflict_id"), Some(Value::String(_)))
            }
            _ => false,
        },
    }
}

pub fn result_dependence(action: &Action, result: &Value) -> Result<ResultDependence, Error> {
    if !result_matches(action, result) {
        return Err(crate::cause!(Error::InvalidResult));
    }
    Ok(match action {
        Action::Writes { .. } if field(result, "conflicts").is_none() => {
            ResultDependence::CountOnly
        }
        _ => ResultDependence::WorkspaceSource,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn json(text: &str) -> Value {
        ecma_json::parse(text.as_bytes(), Default::default()).unwrap()
    }

    #[test]
    fn input_keeps_null_cas_and_all_original_branches() {
        let write = parse_input(&json(r#"{"writes":[{"address_label":"board","payload":{"a":1},"expected_identity":null}],"conflict_policy":"retry"}"#)).unwrap();
        assert!(matches!(
            &write,
            Action::Writes {
                policy: Policy::Retry,
                ..
            }
        ));
        if let Action::Writes { writes, .. } = write {
            assert_eq!(writes[0].expected_identity, Some(None));
        }
        assert!(matches!(
            parse_input(&json(
                r#"{"resolve_conflict":{"id":"x","branch_identity":"y"}}"#
            )),
            Ok(Action::Resolve { .. })
        ));
        assert!(parse_input(&json(
            r#"{"writes":[],"resolve_conflict":{"id":"x","branch_identity":"y"}}"#
        ))
        .is_err());
        let input = json(
            r#"{"writes":[{"address_label":"private-label","payload":{"secret":"PRIVATE_CANARY"}}]}"#,
        );
        let persisted = private_persistence_value(&input).unwrap();
        let encoded = ecma_json::stringify(&persisted, Default::default()).unwrap();
        assert!(!encoded.contains("PRIVATE_CANARY"));
        assert!(!encoded.contains("private-label"));
        assert!(parse_input(&json(
            r#"{"resolve_conflict":{"id":"x","branch_identity":"y"},"conflict_policy":"unknown"}"#
        ))
        .is_err());
    }

    #[test]
    fn the_persons_show_rules_are_an_ordinary_write() {
        // The person's show rules are their own record: no label has an owner of its own here.
        assert!(parse_input(&json(
            r#"{"writes":[{"address_label":"show-rules","payload":{"rules":[]},"expected_identity":null}],"conflict_policy":"retry"}"#
        ))
        .is_ok());
    }

    #[test]
    fn output_does_not_collapse_conflicts_to_a_count() {
        let action = parse_input(&json(
            r#"{"writes":[{"address_label":"board","payload":1}]}"#,
        ))
        .unwrap();
        assert!(result_matches(&action, &json(r#"{"written":1}"#)));
        assert!(result_matches(
            &action,
            &json(
                r#"{"written":0,"conflicts":[{"address":"board","current":{"found":true,"identity":"1f:old","value":2}}]}"#
            )
        ));
        assert!(!result_matches(
            &action,
            &json(r#"{"changed":false,"write_count":0}"#)
        ));
        assert_eq!(
            result_dependence(&action, &json(r#"{"written":1}"#)),
            Ok(ResultDependence::CountOnly)
        );
        assert_eq!(
            result_dependence(
                &action,
                &json(
                    r#"{"written":0,"conflicts":[{"address":"board","current":{"found":false,"identity":"missing"}}]}"#
                )
            ),
            Ok(ResultDependence::WorkspaceSource)
        );
        let resolve = parse_input(&json(
            r#"{"resolve_conflict":{"id":"x","branch_identity":"y"}}"#,
        ))
        .unwrap();
        assert_eq!(
            result_dependence(
                &resolve,
                &json(r#"{"resolved":true,"address":"board","kept":"y"}"#)
            ),
            Ok(ResultDependence::WorkspaceSource)
        );
    }

    #[test]
    fn value_identity_respects_original_property_order() {
        let first = workspace_value_identity(&json(r#"{"a":1,"b":2}"#)).unwrap();
        let second = workspace_value_identity(&json(r#"{"b":2,"a":1}"#)).unwrap();
        assert_ne!(first, second);
        assert_eq!(
            first,
            "1f:8e80439b77ac62d4194499edd46684c479da3aa1ac80dd5511468efae049166e"
        );
        assert_eq!(
            second,
            "1f:fa45b495544b5200f89faa37e536ee6f7f53bf3bb24b1b172304ef9d1b2a7c03"
        );
    }

    #[test]
    fn conflict_id_and_clock_match_original_source_vector() {
        let current = json(r#"{"a":1}"#);
        let incoming = json(r#"{"a":2}"#);
        assert_eq!(
            conflict_id(&JsString::from("board"), Some(&current), Some(&incoming)).unwrap(),
            "1f:4afda7be02d707f78072a9ca4aa5a2ec9bbcdf8bbb03440a73448f4afdb28343"
        );
        let p = HybridClock {
            wall_ms: 100,
            logical: 2,
            device_id: "previous".into(),
        };
        let r = HybridClock {
            wall_ms: 100,
            logical: 4,
            device_id: "received".into(),
        };
        assert_eq!(
            tick_hybrid_clock(Some(&p), Some(&r), 99, "person-store"),
            HybridClock {
                wall_ms: 100,
                logical: 5,
                device_id: "person-store".into()
            }
        );
    }
}
