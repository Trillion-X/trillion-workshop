//! crates/formula-engine/src/rules.rs
//!
//! Purpose
//!   Turn a person's filter (a tree of rules and groups) into ONE composition-ast binding the evaluator runs. The
//!   meaning of each comparison lives in the comparison rows (rules/rule-operators.json, or the rows a request brings)
//!   as a binding template; this file only fills templates and nests groups. It never compares a value itself.
//!
//! Rule tree (plain JSON, the same shape a saved view stores)
//!   group: {kind:"group", combinator:<combinator id>, negate:boolean, rules:[node]}
//!   rule:  {kind:"rule", field:<field id>, operator:<operator id>, params:{...}}
//!   params by operator input: values:{values:[...]}, value:{value}, text:{text}, range:{min?, max?}, none:{}.
//!
//! Non-negotiable invariants
//!   - A rule the person has not finished (unknown field or operator, a comparison the field's kind does not offer,
//!     missing params) is left out and reported in `incomplete`, never guessed.
//!   - An empty tree compiles to no binding, which means "every row".
//!   - Every group binding selects the row itself before combining, so each nested rule reads the row, never an
//!     intermediate value.
//!   - No field, operator or combinator id is named in this file.
//!   - Template markers are objects: {"$field": "path"} is the field's path, {"$param": name} a param,
//!     {"$field_param": name} the path of the field a param names. A marker with nothing to give is left out of an
//!     object and is null in a list, as the rows' JSON has always read.

use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// The comparison rows, looked up once: by id, the combinators in order.
pub struct Vocabulary {
    pub data: Value,
    operators: HashMap<String, Value>,
    combinators: HashMap<String, Value>,
    first_combinator: Option<String>,
}

impl Vocabulary {
    /// `data` is `{combinators: [...], operators: [...]}`, the shape of rules/rule-operators.json. A later row with an
    /// id an earlier row holds replaces it.
    pub fn new(data: Value) -> Self {
        let by_id = |key: &str| -> HashMap<String, Value> {
            data[key]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|row| row["id"].as_str().map(|id| (id.to_owned(), row.clone())))
                .collect()
        };
        let operators = by_id("operators");
        let combinators = by_id("combinators");
        let first_combinator = data["combinators"].get(0).and_then(|row| row["id"].as_str()).map(str::to_owned);
        Vocabulary { operators, combinators, first_combinator, data }
    }

    pub fn operator(&self, id: &str) -> Option<&Value> {
        self.operators.get(id)
    }

    pub fn combinator(&self, id: &str) -> Option<&Value> {
        self.combinators.get(id)
    }
}

/// What compiling a tree gives: the binding (None: every row), the field ids it reads, and the rules left out.
pub struct Compiled {
    pub binding: Option<Value>,
    pub reads: Vec<String>,
    pub incomplete: Vec<Value>,
}

const ROW_FROM: &str = "self";

fn row_binding(transform: Vec<Value>) -> Value {
    json!({"$kind": "binding", "select": {"from": ROW_FROM}, "transform": transform})
}

fn combine(op: &Value, members: Vec<Value>) -> Value {
    row_binding(vec![json!({"op": op, "args": {"values": members}})])
}

fn negated(mut binding: Value) -> Value {
    if let Some(object) = binding.as_object_mut() {
        let transform = object.entry("transform").or_insert_with(|| Value::Array(Vec::new()));
        if !transform.is_array() {
            *transform = Value::Array(Vec::new());
        }
        transform.as_array_mut().expect("a list").push(json!({"op": "op:core.not"}));
    }
    binding
}

/// Present: given, and neither null nor empty text.
fn present(value: Option<&Value>) -> bool {
    !matches!(value, None | Some(Value::Null)) && value != Some(&Value::String(String::new()))
}

/// A field's path into a record: its own `path`, else its id.
fn path_of(field: &Value) -> Value {
    match field.get("path") {
        Some(path) if !path.is_null() => path.clone(),
        _ => json!([field["id"].clone()]),
    }
}

struct Fill<'a> {
    path: &'a Value,
    params: &'a Map<String, Value>,
    field_params: &'a [(String, Value)],
}

/// The template with its markers replaced; None where a marker has nothing to give.
fn fill(template: &Value, with: &Fill) -> Option<Value> {
    match template {
        Value::Array(items) => Some(Value::Array(items.iter().map(|item| fill(item, with).unwrap_or(Value::Null)).collect())),
        Value::Object(object) => {
            if let Some(name) = object.get("$field") {
                // A field gives only its path (the one thing a template asks of it).
                return (name.as_str() == Some("path")).then(|| with.path.clone());
            }
            if let Some(name) = object.get("$param") {
                return name.as_str().and_then(|name| with.params.get(name)).cloned();
            }
            if let Some(name) = object.get("$field_param") {
                return name.as_str().and_then(|name| with.field_params.iter().find(|(key, _)| key == name)).map(|(_, other)| path_of(other));
            }
            Some(Value::Object(
                object.iter().filter_map(|(key, value)| fill(value, with).map(|filled| (key.clone(), filled))).collect(),
            ))
        }
        other => Some(other.clone()),
    }
}

/// A text with * as the wildcard, matched whole, as the regular expression the engine's pattern match reads.
fn glob_pattern(text: &str) -> String {
    let mut out = String::from("^");
    for character in text.chars() {
        match character {
            '*' => out.push_str(".*"),
            '.' | '+' | '?' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                out.push('\\');
                out.push(character);
            }
            other => out.push(other),
        }
    }
    out.push('$');
    out
}

fn normalized_params(operator: &Value, params: Option<&Value>) -> Map<String, Value> {
    let lower = operator["param_case"].as_str() == Some("lower");
    let glob = operator["param_form"].as_str() == Some("glob");
    let shape = |value: &Value| -> Value {
        match value {
            Value::String(text) => {
                let cased = if lower { text.to_lowercase() } else { text.clone() };
                Value::String(if glob { glob_pattern(&cased) } else { cased })
            }
            other => other.clone(),
        }
    };
    params
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| {
                    let shaped = match value {
                        Value::Array(items) => Value::Array(items.iter().map(shape).collect()),
                        other => shape(other),
                    };
                    (key.clone(), shaped)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn ready(operator: &Value, params: &Map<String, Value>) -> bool {
    let input = operator["input"].as_str();
    if input == Some("none") {
        return true;
    }
    // A comparison repeated for each entry of a list param (tags, words) is ready once the list holds one entry.
    if let Some(each) = operator.get("each").filter(|each| each.is_object()) {
        return each["param"].as_str().and_then(|name| params.get(name)).and_then(Value::as_array).is_some_and(|list| !list.is_empty());
    }
    // `any` compares with one given value of any shape, empty text, false and null included.
    if input == Some("any") {
        return params.contains_key("value");
    }
    if input == Some("values") {
        return params.get("values").and_then(Value::as_array).is_some_and(|list| !list.is_empty());
    }
    // A comparison made of parts (a range, a day) is ready once any part is.
    if let Some(parts) = operator.get("parts").and_then(Value::as_array) {
        return parts.iter().any(|part| part["when"].as_str().is_some_and(|when| present(params.get(when))));
    }
    if input == Some("text") {
        return params.get("text").and_then(Value::as_str).is_some_and(|text| !text.trim().is_empty());
    }
    present(params.get("value"))
}

/// The field, operator and normalized params a rule means, or None when the rule is not finished (unknown field or
/// operator, a comparison the field's kind does not offer, missing params). The one place that decides which rules
/// count.
pub struct Resolved<'a> {
    pub field: &'a Value,
    pub operator: &'a Value,
    pub params: Map<String, Value>,
    pub field_params: Vec<(String, Value)>,
}

pub fn resolve_rule<'a>(rule: &Value, fields: &'a HashMap<String, Value>, vocabulary: &'a Vocabulary) -> Option<Resolved<'a>> {
    let field = rule.get("field").and_then(Value::as_str).and_then(|id| fields.get(id))?;
    let operator = rule.get("operator").and_then(Value::as_str).and_then(|id| vocabulary.operator(id))?;
    let kind = &field["kind"];
    if !operator["applies_to"].as_array().is_some_and(|kinds| kinds.contains(kind)) {
        return None;
    }
    let params = normalized_params(operator, rule.get("params"));
    if !ready(operator, &params) {
        return None;
    }
    // A comparison may name another field through DATA; an absent or unlike-kind field is unfinished.
    let mut field_params: Vec<(String, Value)> = Vec::new();
    for name in operator["field_params"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        let other = params.get(name).and_then(Value::as_str).and_then(|id| fields.get(id))?;
        if &other["kind"] != kind {
            return None;
        }
        field_params.push((name.to_owned(), other.clone()));
    }
    Some(Resolved { field, operator, params, field_params })
}

fn compile_rule(rule: &Value, fields: &HashMap<String, Value>, vocabulary: &Vocabulary) -> Option<(Value, Vec<String>)> {
    let Resolved { field, operator, params, field_params } = resolve_rule(rule, fields, vocabulary)?;
    let path = path_of(field);
    let with = |params: &Map<String, Value>, template: &Value| fill(template, &Fill { path: &path, params, field_params: &field_params });
    let binding = if let Some(each) = operator.get("each").filter(|each| each.is_object()) {
        let entries = each["param"].as_str().and_then(|name| params.get(name)).and_then(Value::as_array).cloned().unwrap_or_default();
        let name = each["as"].as_str().unwrap_or_default().to_owned();
        let mut copies: Vec<Value> = entries
            .into_iter()
            .map(|entry| {
                let mut one = params.clone();
                one.insert(name.clone(), entry);
                with(&one, &operator["binding"]).unwrap_or(Value::Null)
            })
            .collect();
        if copies.len() == 1 { copies.remove(0) } else { combine(&each["combine"], copies) }
    } else if let Some(parts) = operator.get("parts").and_then(Value::as_array) {
        let mut chosen: Vec<Value> = parts
            .iter()
            .filter(|part| part["when"].as_str().is_some_and(|when| present(params.get(when))))
            .map(|part| with(&params, &part["binding"]).unwrap_or(Value::Null))
            .collect();
        if chosen.len() == 1 { chosen.remove(0) } else { combine(&operator["combine"], chosen) }
    } else {
        with(&params, &operator["binding"]).unwrap_or(Value::Null)
    };
    let binding = if operator["negate"] == Value::Bool(true) { negated(binding) } else { binding };
    let mut reads = vec![field["id"].as_str().unwrap_or_default().to_owned()];
    reads.extend(field_params.iter().filter_map(|(_, other)| other["id"].as_str().map(str::to_owned)));
    Some((binding, reads))
}

/// Compile a rule tree over `fields` (`[{id, kind, path?}]`; a later field with an id an earlier one holds replaces
/// it). Refused only when a group must be joined and the vocabulary has no combinator at all.
pub fn compile(tree: Option<&Value>, fields: &[Value], vocabulary: &Vocabulary) -> Result<Compiled, String> {
    let by_id: HashMap<String, Value> =
        fields.iter().filter_map(|field| field["id"].as_str().map(|id| (id.to_owned(), field.clone()))).collect();
    let mut reads: Vec<String> = Vec::new();
    let mut incomplete = Vec::new();
    fn visit(
        node: &Value,
        by_id: &HashMap<String, Value>,
        vocabulary: &Vocabulary,
        reads: &mut Vec<String>,
        incomplete: &mut Vec<Value>,
    ) -> Result<Option<Value>, String> {
        if node["kind"].as_str() == Some("group") {
            let mut members = Vec::new();
            for member in node["rules"].as_array().into_iter().flatten() {
                if let Some(binding) = visit(member, by_id, vocabulary, reads, incomplete)? {
                    members.push(binding);
                }
            }
            if members.is_empty() {
                return Ok(None);
            }
            let negate = node["negate"].as_bool().unwrap_or(false);
            if members.len() == 1 && !negate {
                return Ok(members.pop());
            }
            let combinator = node["combinator"]
                .as_str()
                .and_then(|id| vocabulary.combinator(id))
                .or_else(|| vocabulary.first_combinator.as_deref().and_then(|id| vocabulary.combinator(id)))
                .ok_or_else(|| "The comparison rows hold no combinator to join a group's rules with.".to_owned())?;
            let joined = combine(&combinator["op"], members);
            return Ok(Some(if negate { negated(joined) } else { joined }));
        }
        match compile_rule(node, by_id, vocabulary) {
            Some((binding, read)) => {
                for field in read {
                    if !reads.contains(&field) {
                        reads.push(field);
                    }
                }
                Ok(Some(binding))
            }
            None => {
                incomplete.push(node.clone());
                Ok(None)
            }
        }
    }
    let binding = match tree {
        Some(tree) if !tree.is_null() => visit(tree, &by_id, vocabulary, &mut reads, &mut incomplete)?,
        _ => None,
    };
    Ok(Compiled { binding, reads, incomplete })
}

/// Every field a tree names, once each, as compile wants them: `[{id, kind}]`. A rule's `field` is the fact's name
/// (any text); its optional `field_kind` (default `fact`) picks the comparisons it offers.
pub fn fields_of_tree(tree: &Value) -> Vec<Value> {
    let mut found: Vec<Value> = Vec::new();
    fn visit(node: &Value, found: &mut Vec<Value>) {
        if !node.is_object() {
            return;
        }
        if node["kind"].as_str() == Some("group") {
            for rule in node["rules"].as_array().into_iter().flatten() {
                visit(rule, found);
            }
        } else if let Some(field) = node.get("field").filter(|field| !field.is_null()) {
            if !found.iter().any(|known| &known["id"] == field) {
                let kind = node.get("field_kind").filter(|kind| !kind.is_null()).cloned().unwrap_or_else(|| json!("fact"));
                found.push(json!({"id": field, "kind": kind}));
            }
        }
    }
    visit(tree, &mut found);
    found
}

/// JavaScript's truthiness of a JSON value, as the short spelling has always been read.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// The rule tree (all must hold) of tests in the short spelling data files use: `{path, equals | one_of | starts_with
/// | present, not}`. A rule's field is the path as JSON text, read at that path; `not` negates that test; a test that
/// names none of the comparisons is left unfinished. `present` says what "present" means: `is_known` (not null) or
/// `is_not_empty` (not null and not ''). Answers the tree and its fields.
pub fn tree_of_tests(tests: &[Value], present_as: &str) -> (Value, Vec<Value>) {
    let mut fields: Vec<Value> = Vec::new();
    let rules: Vec<Value> = tests
        .iter()
        .map(|test| {
            let (operator, params) = if truthy(&test["present"]) && present_as == "is_not_empty" {
                ("is_not_empty", json!({}))
            } else if let Some(equals) = test.get("equals") {
                if equals.is_null() { ("is_unknown", json!({})) } else { ("equals", json!({"value": equals})) }
            } else if let Some(values) = test.get("one_of") {
                ("is_any_of", json!({"values": values}))
            } else if let Some(text) = test.get("starts_with") {
                ("begins_with", json!({"text": text}))
            } else if let Some(given) = test.get("present") {
                (if truthy(given) { "is_known" } else { "is_unknown" }, json!({}))
            } else {
                ("no_comparison_named", json!({}))
            };
            let path = test.get("path").cloned().unwrap_or(Value::Null);
            let id = serde_json::to_string(&path).unwrap_or_default();
            if !fields.iter().any(|field| field["id"] == id.as_str()) {
                fields.push(json!({"id": id, "kind": "fact", "path": path}));
            }
            let rule = json!({"kind": "rule", "field": id, "operator": operator, "params": params});
            if truthy(&test["not"]) {
                json!({"kind": "group", "combinator": "and", "negate": true, "rules": [rule]})
            } else {
                rule
            }
        })
        .collect();
    (json!({"kind": "group", "combinator": "and", "negate": false, "rules": rules}), fields)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vocabulary() -> Vocabulary {
        Vocabulary::new(serde_json::from_str(crate::OPERATORS).expect("rule-operators.json"))
    }

    #[test]
    fn an_empty_tree_and_an_unfinished_rule_constrain_nothing() {
        let fields = vec![json!({"id": "n", "kind": "number"})];
        let empty = compile(Some(&json!({"kind": "group", "rules": []})), &fields, &vocabulary()).unwrap();
        assert!(empty.binding.is_none() && empty.incomplete.is_empty());
        let unfinished = json!({"kind": "rule", "field": "n", "operator": "greater_than", "params": {}});
        let compiled = compile(Some(&unfinished), &fields, &vocabulary()).unwrap();
        assert!(compiled.binding.is_none());
        assert_eq!(compiled.incomplete, vec![unfinished]);
    }

    #[test]
    fn a_kind_that_does_not_offer_a_comparison_is_unfinished() {
        let fields = vec![json!({"id": "t", "kind": "text"})];
        let rule = json!({"kind": "rule", "field": "t", "operator": "greater_than", "params": {"value": 1}});
        assert_eq!(compile(Some(&rule), &fields, &vocabulary()).unwrap().incomplete.len(), 1);
    }

    #[test]
    fn glob_text_is_escaped_and_matched_whole() {
        assert_eq!(glob_pattern("a.b*"), "^a\\.b.*$");
        assert_eq!(glob_pattern("(x)?"), "^\\(x\\)\\?$");
    }

    #[test]
    fn a_field_param_must_name_a_field_of_the_same_kind() {
        let fields = vec![json!({"id": "a", "kind": "number"}), json!({"id": "b", "kind": "number"}), json!({"id": "c", "kind": "text"})];
        let rule = |other: &str| json!({"kind": "rule", "field": "a", "operator": "at_least_field", "params": {"text": other}});
        let same = compile(Some(&rule("b")), &fields, &vocabulary()).unwrap();
        assert_eq!(same.reads, vec!["a".to_owned(), "b".to_owned()]);
        assert_eq!(compile(Some(&rule("c")), &fields, &vocabulary()).unwrap().incomplete.len(), 1);
    }
}
