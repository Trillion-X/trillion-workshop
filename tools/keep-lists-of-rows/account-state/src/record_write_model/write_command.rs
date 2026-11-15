//! The one write of an account's own records, admitted from product DATA
//! (`own-record-writes.json`): the command's operation name, its input check
//! and result schema, and the kinds of kept command result no ordinary write
//! may replace.
//! Source: trillion/src/own-record-resource.mjs (`records:*`),
//! src/customer-database-records.mjs (`write`) and
//! parts/record-log/do-work/record-log-store.mjs (`write(records)`).
//!
//! Every item writes one whole root record of any kind: a list, the rows a
//! list declares, a pursuit, or any kind declared in the record model or by
//! another record. No kind has its own handler. This module only admits the
//! input; the live record model (`Model`), erasable-field sealing and the
//! ordered envelope owner belong to the native command transaction that runs
//! the writes, and the authority to the resource that admitted the command.
use crate::ecma_json::{JsString, Value};
use std::sync::OnceLock;

/// The declared product DATA file this command is read from.
const DATA: &[u8] = include_bytes!("own-record-writes.json");
/// The most records one command writes: one record-log batch
/// (`record_log::MAX_BATCH_RECORDS`), which its count result
/// (`{changed, write_count}`) also bounds. DATA (`maxItems`) is trillion-local's
/// write limit and may be lower, never higher; a tool row may declare less.
pub const MOST_RECORDS: usize = crate::record_log::MAX_BATCH_RECORDS;

#[derive(Clone, Debug)]
pub enum Error {
    /// The product DATA is missing or malformed.
    Data(crate::refusal_cause::Cause),
    /// The input does not have the declared shape.
    Invalid(crate::refusal_cause::Cause),
    /// An ordinary record write named a kind of kept command result.
    Receipt(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Data(cause) => cause.clone(),
            Self::Invalid(cause) => cause.clone(),
            Self::Receipt(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Error);

// Equality keeps the domain classification; source identity is compared explicitly via cause().
impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) }
}
impl Eq for Error {}


/// The logical root a write expects before the atomic command starts. Every
/// condition in a batch compares with the same batch-start snapshot.
#[derive(Clone, PartialEq)]
pub enum Expected {
    /// Preserve the existing unconditional whole-root write behavior.
    Unconditional,
    /// The id has no live record of any kind.
    Absent,
    /// The id has this exact logical kind and value.
    Present { kind: JsString, value: Value },
    /// Existing opaque current root field stamp, not its creation sequence or a hash of computed dependencies.
    Identity { kind: JsString, identity: JsString },
    /// A readRecord snapshot may carry both its original value and the new metadata; neither condition is ignored.
    PresentIdentity {
        kind: JsString,
        value: Value,
        identity: JsString,
    },
}
impl std::fmt::Debug for Expected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unconditional => "Unconditional",
            Self::Absent => "Absent",
            Self::Present { .. } => "Present([redacted])",
            Self::Identity { .. } => "Identity([redacted])",
            Self::PresentIdentity { .. } => "PresentIdentity([redacted])",
        })
    }
}

/// One whole-root write. `kind` is absent only for a removal, which removes
/// whatever kind the record has.
#[derive(Clone, PartialEq)]
pub struct Write {
    pub id: JsString,
    pub kind: Option<JsString>,
    pub value: Option<Value>,
    pub expected: Expected,
}
impl std::fmt::Debug for Write {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RecordWrite([redacted])")
    }
}

pub struct Command {
    operation: String,
    input_schema: Value,
    most_records: usize,
    receipt_kinds: Vec<JsString>,
    result_record: ResultRecord,
    resource_selection: Option<ResourceSelectionDeclaration>,
}

/// Trusted DATA locating a kept command answer after the canonical record read
/// has opened its fields. These names never come from the caller's input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResultRecord {
    pub kind: String,
    pub field: String,
    pub result_field: String,
}

#[derive(Clone, Debug)]
struct ResourceSelectionDeclaration {
    identities: Vec<String>,
    group: Option<Vec<String>>,
}

/// The identities an operation contract says change together. A caller uses
/// this complete set to resolve one existing affinity or one growth target;
/// the extractor never hashes ids or partitions by record kind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResourceSelection {
    pub identities: Vec<String>,
    pub group: Option<String>,
}
impl std::fmt::Debug for Command {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RecordWriteCommand")
            .field("operation", &self.operation)
            .finish_non_exhaustive()
    }
}

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(object) => object.get(&JsString::from(name)),
        _ => None,
    }
}
fn text(value: Option<&Value>) -> Option<&JsString> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Some(text),
        _ => None,
    }
}
/// A record id is text without "/" (record-log-store.mjs); NUL is the
/// original key separator.
fn record_id(value: Option<&Value>) -> Result<JsString, Error> {
    match text(value) {
        Some(id) if !id.units().contains(&(b'/' as u16)) && !id.units().contains(&0) => {
            Ok(id.clone())
        }
        _ => Err(crate::cause!(Error::Invalid)),
    }
}

impl Command {
    /// The shipped command, read and checked once per process.
    pub fn shipped() -> Result<&'static Command, Error> {
        static SHIPPED: OnceLock<Result<Command, Error>> = OnceLock::new();
        SHIPPED
            .get_or_init(|| {
                let data =
                    crate::ecma_json::parse(DATA, Default::default()).map_err(|error| Error::Data(error.cause()))?;
                Command::from_data(&data)
            })
            .as_ref()
            .map_err(Clone::clone)
    }

    pub fn from_data(data: &Value) -> Result<Command, Error> {
        let operation = text(field(data, "operation"))
            .ok_or(crate::cause!(Error::Data))?
            .to_rust_string()
            .map_err(|error| Error::Data(error.cause()))?;
        let input_schema = field(data, "input_schema").ok_or(crate::cause!(Error::Data))?.clone();
        let records = field(&input_schema, "properties")
            .and_then(|properties| field(properties, "records"))
            .ok_or(crate::cause!(Error::Data))?;
        // The kept result holds no record word only while `records` is writeOnly.
        if field(records, "writeOnly") != Some(&Value::Bool(true)) {
            return Err(crate::cause!(Error::Data));
        }
        let most_records = match field(records, "maxItems") {
            Some(Value::Number(most))
                if most.fract() == 0.0 && *most >= 1.0 && *most <= MOST_RECORDS as f64 =>
            {
                *most as usize
            }
            _ => return Err(crate::cause!(Error::Data)),
        };
        let Some(Value::Array(kinds)) = field(data, "receipt_kinds") else {
            return Err(crate::cause!(Error::Data));
        };
        let receipt_kinds = kinds
            .iter()
            .map(|kind| text(Some(kind)).cloned().ok_or(crate::cause!(Error::Data)))
            .collect::<Result<Vec<_>, _>>()?;
        if receipt_kinds.is_empty() {
            return Err(crate::cause!(Error::Data));
        }
        let declaration = field(data, "result_record").ok_or(crate::cause!(Error::Data))?;
        let Value::Object(fields) = declaration else {
            return Err(crate::cause!(Error::Data));
        };
        if fields.len() != 3 {
            return Err(crate::cause!(Error::Data));
        }
        let kind = text(field(declaration, "kind")).ok_or(crate::cause!(Error::Data))?;
        if !receipt_kinds.contains(kind) {
            return Err(crate::cause!(Error::Data));
        }
        let name = |key| {
            text(field(declaration, key))
                .ok_or(crate::cause!(Error::Data))?
                .to_rust_string()
                .map_err(|error| Error::Data(error.cause()))
        };
        let result_record = ResultRecord {
            kind: kind.to_rust_string().map_err(|error| Error::Data(error.cause()))?,
            field: name("field")?,
            result_field: name("result_field")?,
        };
        let resource_selection = match field(data, "resource_selection") {
            None | Some(Value::Null) => None,
            Some(Value::Object(_)) => {
                let identities =
                    path(field(data, "resource_selection").and_then(|v| field(v, "identities")))?;
                let group = match field(data, "resource_selection").and_then(|v| field(v, "group"))
                {
                    None | Some(Value::Null) => None,
                    given => Some(path(given)?),
                };
                if identities.is_empty()
                    || identities.iter().filter(|step| *step == "*").count() > 1
                {
                    return Err(crate::cause!(Error::Data));
                }
                Some(ResourceSelectionDeclaration { identities, group })
            }
            _ => return Err(crate::cause!(Error::Data)),
        };
        Ok(Command {
            operation,
            input_schema,
            most_records,
            receipt_kinds,
            result_record,
            resource_selection,
        })
    }

    pub fn operation(&self) -> &str {
        &self.operation
    }

    /// Whether `operation` names the shipped command. Every door (the browser's
    /// POST /records, an agent's run_resource_operation) asks this, never a
    /// spelled operation name.
    pub fn is_shipped(operation: &str) -> bool {
        Command::shipped().is_ok_and(|command| command.operation == operation)
    }

    /// The engine's write limit: the most records one command may carry.
    pub fn most_records(&self) -> usize {
        self.most_records
    }

    pub fn input_schema(&self) -> &Value {
        &self.input_schema
    }

    /// The protected result record and opened fields named by trusted DATA.
    pub fn result_record(&self) -> &ResultRecord {
        &self.result_record
    }

    /// Resolve the operation's DATA-declared identity fields. Repeated
    /// identities collapse to one binding. An absent/malformed identity is a
    /// refusal; no id or kind is inferred from arbitrary value content.
    pub fn resource_selection(&self, input: &Value) -> Result<ResourceSelection, Error> {
        let declaration = self.resource_selection.as_ref().ok_or(crate::cause!(Error::Data))?;
        let mut identities = std::collections::BTreeSet::new();
        let mut found = Vec::new();
        collect_path(input, &declaration.identities, &mut found)?;
        for value in found {
            match value {
                Value::String(identity) if !identity.is_empty() => {
                    identities.insert(identity.to_rust_string().map_err(|error| Error::Invalid(error.cause()))?);
                }
                _ => return Err(crate::cause!(Error::Invalid)),
            }
        }
        if identities.is_empty() {
            return Err(crate::cause!(Error::Invalid));
        }
        let group = declaration
            .group
            .as_ref()
            .map(|path| {
                let mut found = Vec::new();
                collect_path(input, path, &mut found)?;
                if found.len() != 1 {
                    return Err(crate::cause!(Error::Invalid));
                }
                match &found[0] {
                    Value::String(group) if !group.is_empty() => {
                        group.to_rust_string().map_err(|error| Error::Invalid(error.cause()))
                    }
                    _ => Err(crate::cause!(Error::Invalid)),
                }
            })
            .transpose()?;
        Ok(ResourceSelection {
            identities: identities.into_iter().collect(),
            group,
        })
    }

    /// Kept command results have their own owner, the command journal: an ordinary
    /// write never names one of their kinds, by type or by an id `<kind>:...`.
    fn receipt(&self, id: &JsString, kind: Option<&JsString>) -> bool {
        self.receipt_kinds.iter().any(|receipt| {
            kind == Some(receipt)
                || id
                    .units()
                    .strip_prefix(receipt.units())
                    .is_some_and(|rest| rest.first() == Some(&(b':' as u16)))
        })
    }

    /// Whether the input asks only to be checked (`check_only: true` beside `records`): the write runs every check and refusal
    /// of the real one, then rolls back and commits nothing. Absent is false; any other value than a boolean is invalid.
    pub fn check_only(input: &serde_json::Value) -> Result<bool, Error> {
        match input.get("check_only") {
            None => Ok(false),
            Some(serde_json::Value::Bool(asked)) => Ok(*asked),
            Some(_) => Err(crate::cause!(Error::Invalid)),
        }
    }

    /// Admit a door's JSON input (the browser body or an agent's `input`).
    pub fn parse_json(&self, input: &serde_json::Value) -> Result<Vec<Write>, Error> {
        let bytes = serde_json::to_vec(input).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        let input =
            crate::ecma_json::parse(&bytes, Default::default()).map_err(|error| Error::Invalid(error.cause()))?;
        self.parse(&input)
    }

    pub fn parse(&self, input: &Value) -> Result<Vec<Write>, Error> {
        let Some(Value::Array(items)) = field(input, "records") else {
            return Err(crate::cause!(Error::Invalid));
        };
        if items.is_empty() || items.len() > self.most_records {
            return Err(crate::cause!(Error::Invalid));
        }
        let mut writes = Vec::with_capacity(items.len());
        for item in items {
            if !matches!(item, Value::Object(_)) {
                return Err(crate::cause!(Error::Invalid));
            }
            let id = record_id(field(item, "id"))?;
            let value = match field(item, "value").ok_or(crate::cause!(Error::Invalid))? {
                Value::Null => None,
                object @ Value::Object(_) => Some(object.clone()),
                _ => return Err(crate::cause!(Error::Invalid)),
            };
            let kind = match field(item, "type") {
                None if value.is_none() => None,
                given => Some(text(given).ok_or(crate::cause!(Error::Invalid))?.clone()),
            };
            let expected = match field(item, "expected") {
                None => Expected::Unconditional,
                Some(Value::Null) => Expected::Absent,
                Some(Value::Object(expected)) => {
                    if expected.len() != 2 && expected.len() != 3 {
                        return Err(crate::cause!(Error::Invalid));
                    }
                    let kind = text(expected.get(&JsString::from("type")))
                        .ok_or(crate::cause!(Error::Invalid))?
                        .clone();
                    match (
                        expected.get(&JsString::from("value")),
                        expected.get(&JsString::from("identity")),
                    ) {
                        (Some(value @ Value::Object(_)), None) if expected.len() == 2 => {
                            Expected::Present {
                                kind,
                                value: value.clone(),
                            }
                        }
                        (None, Some(identity)) if expected.len() == 2 => Expected::Identity {
                            kind,
                            identity: text(Some(identity)).ok_or(crate::cause!(Error::Invalid))?.clone(),
                        },
                        (Some(value @ Value::Object(_)), Some(identity)) if expected.len() == 3 => {
                            Expected::PresentIdentity {
                                kind,
                                value: value.clone(),
                                identity: text(Some(identity)).ok_or(crate::cause!(Error::Invalid))?.clone(),
                            }
                        }
                        _ => return Err(crate::cause!(Error::Invalid)),
                    }
                }
                Some(_) => return Err(crate::cause!(Error::Invalid)),
            };
            if self.receipt(&id, kind.as_ref()) {
                return Err(crate::cause!(Error::Receipt));
            }
            writes.push(Write {
                id,
                kind,
                value,
                expected,
            });
        }
        Ok(writes)
    }
}

fn path(value: Option<&Value>) -> Result<Vec<String>, Error> {
    let Some(Value::Array(steps)) = value else {
        return Err(crate::cause!(Error::Data));
    };
    let mut path = Vec::with_capacity(steps.len());
    for step in steps {
        match step {
            Value::String(step) if !step.is_empty() => {
                path.push(step.to_rust_string().map_err(|error| Error::Data(error.cause()))?)
            }
            _ => return Err(crate::cause!(Error::Data)),
        }
    }
    if path.is_empty() {
        Err(crate::cause!(Error::Data))
    } else {
        Ok(path)
    }
}

fn collect_path<'a>(
    value: &'a Value,
    path: &[String],
    found: &mut Vec<&'a Value>,
) -> Result<(), Error> {
    let Some((step, rest)) = path.split_first() else {
        found.push(value);
        return Ok(());
    };
    if step == "*" {
        let Value::Array(values) = value else {
            return Err(crate::cause!(Error::Invalid));
        };
        for value in values {
            collect_path(value, rest, found)?;
        }
        return Ok(());
    }
    let Value::Object(object) = value else {
        return Err(crate::cause!(Error::Invalid));
    };
    let next = object
        .get(&JsString::from(step.as_str()))
        .ok_or(crate::cause!(Error::Invalid))?;
    collect_path(next, rest, found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(value: serde_json::Value) -> Value {
        crate::ecma_json::parse(&serde_json::to_vec(&value).unwrap(), Default::default()).unwrap()
    }

    #[test]
    fn shipped_contract_extracts_whole_batch_ids_without_partitioning_by_kind() {
        let command = Command::shipped().unwrap();
        let selected = command
            .resource_selection(&json(serde_json::json!({
                "records": [
                    {"id": "z", "type": "note", "value": {}},
                    {"id": "a", "type": "task", "value": {}},
                    {"id": "z", "type": "other-kind", "value": {}}
                ]
            })))
            .unwrap();
        assert_eq!(selected.identities, vec!["a", "z"]);
        assert_eq!(selected.group, None);
    }

    #[test]
    fn resource_identity_path_is_data_driven_and_explicit_group_is_preserved() {
        let data = json(serde_json::json!({
            "operation": "records:write",
            "input_schema": {"properties": {"records": {"writeOnly": true, "maxItems": 8}}},
            "receipt_kinds": ["execution"],
            "result_record": {"kind": "execution", "field": "body", "result_field": "answer"},
            "resource_selection": {"identities": ["records", "*", "id"], "group": ["relationship_id"]}
        }));
        let command = Command::from_data(&data).unwrap();
        let selected = command
            .resource_selection(&json(serde_json::json!({
                "records": [{"id": "second"}, {"id": "first"}],
                "relationship_id": "relationship:one"
            })))
            .unwrap();
        assert_eq!(selected.identities, vec!["first", "second"]);
        assert_eq!(selected.group.as_deref(), Some("relationship:one"));
    }

    #[test]
    fn result_record_is_declared_independently_of_receipt_order() {
        let mut data: serde_json::Value = serde_json::from_slice(DATA).unwrap();
        data["receipt_kinds"] = serde_json::json!(["kept-metadata", "kept-answer"]);
        data["result_record"] = serde_json::json!({
            "kind": "kept-answer", "field": "body", "result_field": "answer"
        });
        let expected = ResultRecord {
            kind: "kept-answer".into(),
            field: "body".into(),
            result_field: "answer".into(),
        };
        assert_eq!(
            Command::from_data(&json(data.clone()))
                .unwrap()
                .result_record(),
            &expected
        );
        data["receipt_kinds"].as_array_mut().unwrap().reverse();
        let command = Command::from_data(&json(data)).unwrap();
        assert_eq!(command.result_record(), &expected);
        command.parse_json(&serde_json::json!({
            "records": [{"id": "note:one", "type": "note", "value": {},
                "result_record": {"kind": "caller-choice", "field": "caller-field", "result_field": "caller-answer"}}],
            "result_record": {"kind": "caller-choice", "field": "caller-field", "result_field": "caller-answer"}
        })).unwrap();
        assert_eq!(command.result_record(), &expected);
    }

    #[test]
    fn malformed_or_unprotected_result_record_declarations_are_refused() {
        let mut data: serde_json::Value = serde_json::from_slice(DATA).unwrap();
        data["receipt_kinds"] = serde_json::json!(["kept-answer"]);
        for declaration in [
            serde_json::Value::Null,
            serde_json::json!([]),
            serde_json::json!({}),
            serde_json::json!({"kind": "unprotected", "field": "body", "result_field": "answer"}),
            serde_json::json!({"kind": "kept-answer", "field": "", "result_field": "answer"}),
            serde_json::json!({"kind": "kept-answer", "field": "body", "result_field": ""}),
            serde_json::json!({"kind": "kept-answer", "field": "body"}),
            serde_json::json!({"kind": "kept-answer", "field": "body", "result_field": 1}),
            serde_json::json!({"kind": "kept-answer", "field": "body", "result_field": "answer", "extra": true}),
        ] {
            data["result_record"] = declaration;
            assert!(matches!(
                Command::from_data(&json(data.clone())),
                Err(Error::Data(_))
            ));
        }
        data.as_object_mut().unwrap().remove("result_record");
        assert!(matches!(Command::from_data(&json(data)), Err(Error::Data(_))));
    }

    #[test]
    fn missing_declared_identity_refuses_selection() {
        let command = Command::shipped().unwrap();
        assert_eq!(
            command.resource_selection(&json(serde_json::json!({"records": [{"type": "note"}]}))),
            Err(crate::cause!(Error::Invalid))
        );
    }

    #[test]
    fn expected_admits_absence_and_exact_present_root_only() {
        let command = Command::shipped().unwrap();
        let writes = command
            .parse_json(&serde_json::json!({
                "records": [
                    {"id":"new","type":"note","value":{},"expected":null},
                    {"id":"old","type":"note","value":{},"expected":{"type":"note","value":{"text":"before"}}}
                ]
            }))
            .unwrap();
        assert_eq!(writes[0].expected, Expected::Absent);
        assert_eq!(
            writes[1].expected,
            Expected::Present {
                kind: JsString::from("note"),
                value: json(serde_json::json!({"text":"before"})),
            }
        );
    }

    #[test]
    fn malformed_expected_conditions_are_refused() {
        let command = Command::shipped().unwrap();
        for expected in [
            serde_json::json!(false),
            serde_json::json!({"type":"note"}),
            serde_json::json!({"value":{}}),
            serde_json::json!({"type":"","value":{}}),
            serde_json::json!({"type":"note","value":null}),
            serde_json::json!({"type":"note","value":{},"extra":true}),
        ] {
            assert_eq!(
                command.parse_json(&serde_json::json!({
                    "records": [{"id":"note:one","type":"note","value":{},"expected":expected}]
                })),
                Err(crate::cause!(Error::Invalid)),
                "expected {} to be refused",
                expected
            );
        }
    }

    #[test]
    fn expected_conditions_parse_while_unconditional_writes_remain_admitted() {
        let command = Command::shipped().unwrap();
        let unconditional = serde_json::json!({"records": [{"id": "note:one", "type": "note", "value": {"text": "synthetic"}}]});
        assert!(command.parse_json(&unconditional).is_ok());
        let mut absent = unconditional.clone();
        absent["records"][0]["expected"] = serde_json::Value::Null;
        assert_eq!(
            command.parse_json(&absent).unwrap()[0].expected,
            Expected::Absent
        );
    }

    #[test]
    fn compact_expected_is_opaque_text_for_any_kind() {
        let identity = "900719925474099312345678901234567890";
        for kind in ["sample-a", "sample-b"] {
            let input = |given: serde_json::Value| {
                serde_json::json!({"records":[{
                    "id":"synthetic-root","type":kind,"value":{},"expected":given
                }]})
            };
            let writes = Command::shipped()
                .unwrap()
                .parse_json(&input(serde_json::json!({"type":kind,"identity":identity})))
                .unwrap();
            assert_eq!(
                writes[0].expected,
                Expected::Identity {
                    kind: kind.into(),
                    identity: identity.into()
                }
            );
            assert!(matches!(
                Command::shipped()
                    .unwrap()
                    .parse_json(&input(
                        serde_json::json!({"type":kind,"identity":identity,"value":{}})
                    ))
                    .unwrap()[0]
                    .expected,
                Expected::PresentIdentity { .. }
            ));
            for given in [
                serde_json::json!({"type":kind,"identity":""}),
                serde_json::json!({"type":kind,"identity":9007199254740993u64}),
                serde_json::json!({"type":kind,"identity":identity,"value":{},"extra":true}),
            ] {
                assert_eq!(
                    Command::shipped().unwrap().parse_json(&input(given)),
                    Err(crate::cause!(Error::Invalid))
                );
            }
        }
    }
}
