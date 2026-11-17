//! crates/compile-rules/src/lib.rs
//!
//! Purpose
//!   Turn a person's filter (a tree of rules and groups) into ONE
//!   composition-ast binding the formula engine evaluates, in a Rust host.
//!   This is rules/compile-rules.mjs, rule for rule: the meaning of each
//!   comparison lives in rules/rule-operators.json as a binding template; this
//!   file only fills templates and nests groups. It never compares a value.
//!
//! Rule tree (plain JSON, the same shape a saved view stores)
//!   group: {kind:"group", combinator:<combinator id>, negate:boolean, rules:[node]}
//!   rule:  {kind:"rule", field:<field id>, operator:<operator id>, params:{...}}
//!
//! Non-negotiable invariants
//!   - A rule the person has not finished (unknown field or operator, missing
//!     params) is left out and reported in `incomplete`, never guessed.
//!   - An empty tree compiles to `binding: None`, which means "every row".
//!   - Every group binding selects the row itself before combining.
//!   - No field, operator or combinator id is named in this file.
//!   - tests/parity.rs holds this compiler to compile-rules.mjs's output.

use std::collections::{BTreeSet, HashMap};
use std::sync::OnceLock;

use serde_json::{json, Map, Value};

/// The comparisons and combinators, looked up once (compile-rules.mjs `ruleVocabulary`).
pub struct Vocabulary {
    operators: HashMap<String, Value>,
    combinators: HashMap<String, Value>,
    first_combinator: Option<String>,
}

impl Vocabulary {
    /// The vocabulary rules/rule-operators.json ships.
    pub fn shipped() -> &'static Vocabulary {
        static SHIPPED: OnceLock<Vocabulary> = OnceLock::new();
        SHIPPED.get_or_init(|| {
            let data: Value = serde_json::from_str(include_str!("../../../rules/rule-operators.json"))
                .expect("rules/rule-operators.json is JSON");
            Vocabulary::from_data(&data).expect("rules/rule-operators.json has operators and combinators")
        })
    }

    /// A vocabulary from operator DATA of the rule-operators.json shape.
    pub fn from_data(data: &Value) -> Result<Vocabulary, String> {
        let rows = |key: &str| {
            data.get(key)
                .and_then(Value::as_array)
                .ok_or_else(|| format!("the rule operators need a list of {key}"))
        };
        let by_id = |list: &Vec<Value>| -> HashMap<String, Value> {
            list.iter()
                .filter_map(|row| row.get("id").and_then(Value::as_str).map(|id| (id.to_owned(), row.clone())))
                .collect()
        };
        let combinators = rows("combinators")?;
        Ok(Vocabulary {
            operators: by_id(rows("operators")?),
            first_combinator: combinators
                .first()
                .and_then(|row| row.get("id"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            combinators: by_id(combinators),
        })
    }
}

/// A field a rule may name: its id, its kind (which comparisons it offers) and its path in a row (default `[id]`).
#[derive(Clone, Debug)]
pub struct Field {
    pub id: String,
    pub kind: String,
    pub path: Option<Value>,
}

/// A compiled tree: `binding` None constrains nothing; `reads` are the field ids the binding reads; `incomplete` the
/// rules left out because they are not finished.
#[derive(Debug, PartialEq)]
pub struct Compiled {
    pub binding: Option<Value>,
    pub reads: Vec<String>,
    pub incomplete: Vec<Value>,
}

fn is_group(node: &Value) -> bool {
    node.get("kind").and_then(Value::as_str) == Some("group")
}

fn present(value: Option<&Value>) -> bool {
    !matches!(value, None | Some(Value::Null)) && value.and_then(Value::as_str) != Some("")
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

fn row_binding() -> Map<String, Value> {
    let mut row = Map::new();
    row.insert("$kind".into(), json!("binding"));
    row.insert("select".into(), json!({"from": "self"}));
    row
}

fn combine(op: &Value, members: Vec<Value>) -> Value {
    let mut binding = row_binding();
    binding.insert("transform".into(), json!([{"op": op, "args": {"values": members}}]));
    Value::Object(binding)
}

fn negated(binding: Value) -> Value {
    let mut binding = match binding {
        Value::Object(map) => map,
        other => return other,
    };
    let mut transform = binding
        .get("transform")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    transform.push(json!({"op": "op:core.not"}));
    binding.insert("transform".into(), Value::Array(transform));
    Value::Object(binding)
}

/// A text with * as the wildcard, matched whole, as the regular expression the engine's pattern match reads.
fn glob_pattern(text: &str) -> String {
    let mut pattern = String::from("^");
    for character in text.chars() {
        match character {
            '*' => pattern.push_str(".*"),
            '.' | '+' | '?' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                pattern.push('\\');
                pattern.push(character);
            }
            other => pattern.push(other),
        }
    }
    pattern.push('$');
    pattern
}

fn normalized_params(operator: &Value, params: Option<&Value>) -> Map<String, Value> {
    let lower = text(operator, "param_case") == Some("lower");
    let glob = text(operator, "param_form") == Some("glob");
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
        .map(|params| {
            params
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
    let input = text(operator, "input");
    if input == Some("none") {
        return true;
    }
    if let Some(each) = operator.get("each") {
        let list = text(each, "param").and_then(|name| params.get(name));
        return list.and_then(Value::as_array).is_some_and(|list| !list.is_empty());
    }
    // `any` compares with one given value of any shape, empty text, false and null included.
    if input == Some("any") {
        return params.contains_key("value");
    }
    if input == Some("values") {
        return params.get("values").and_then(Value::as_array).is_some_and(|list| !list.is_empty());
    }
    if let Some(parts) = operator.get("parts").and_then(Value::as_array) {
        return parts
            .iter()
            .any(|part| present(text(part, "when").and_then(|name| params.get(name))));
    }
    if input == Some("text") {
        return params
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty());
    }
    present(params.get("value"))
}

fn path_of(field: &Field) -> Value {
    field.path.clone().unwrap_or_else(|| json!([field.id]))
}

/// A template filled: None is JavaScript's `undefined` (a key holding it is left out, an array entry becomes null).
fn fill(template: &Value, target: &Value, params: &Map<String, Value>, field_params: &[(String, Field)]) -> Option<Value> {
    match template {
        Value::Array(items) => Some(Value::Array(
            items
                .iter()
                .map(|item| fill(item, target, params, field_params).unwrap_or(Value::Null))
                .collect(),
        )),
        Value::Object(map) => {
            if let Some(name) = map.get("$field") {
                return name.as_str().and_then(|name| target.get(name)).cloned();
            }
            if let Some(name) = map.get("$param") {
                return name.as_str().and_then(|name| params.get(name)).cloned();
            }
            if let Some(name) = map.get("$field_param") {
                return name
                    .as_str()
                    .and_then(|name| field_params.iter().find(|(asked, _)| asked == name))
                    .map(|(_, other)| path_of(other));
            }
            Some(Value::Object(
                map.iter()
                    .filter_map(|(key, value)| fill(value, target, params, field_params).map(|filled| (key.clone(), filled)))
                    .collect(),
            ))
        }
        other => Some(other.clone()),
    }
}

/// What a finished rule means: its field, its operator, its normalized params and the other fields it names.
struct Resolved<'a> {
    field: &'a Field,
    operator: &'a Value,
    params: Map<String, Value>,
    field_params: Vec<(String, Field)>,
}

/// The field, operator and normalized params a rule means, or None when the rule is not finished.
fn resolve_rule<'a>(
    rule: &Value,
    fields: &'a HashMap<String, Field>,
    vocabulary: &'a Vocabulary,
) -> Option<Resolved<'a>> {
    let field = fields.get(text(rule, "field")?)?;
    let operator = vocabulary.operators.get(text(rule, "operator")?)?;
    let applies = operator.get("applies_to").and_then(Value::as_array)?;
    if !applies.iter().any(|kind| kind.as_str() == Some(field.kind.as_str())) {
        return None;
    }
    let params = normalized_params(operator, rule.get("params"));
    if !ready(operator, &params) {
        return None;
    }
    let mut field_params = Vec::new();
    for name in operator.get("field_params").and_then(Value::as_array).into_iter().flatten() {
        let name = name.as_str()?;
        let other = fields.get(params.get(name).and_then(Value::as_str)?)?;
        if other.kind != field.kind {
            return None;
        }
        field_params.push((name.to_owned(), other.clone()));
    }
    Some(Resolved { field, operator, params, field_params })
}

fn compile_rule(rule: &Value, fields: &HashMap<String, Field>, vocabulary: &Vocabulary) -> Option<(Value, Vec<String>)> {
    let Resolved { field, operator, params, field_params } = resolve_rule(rule, fields, vocabulary)?;
    let target = json!({"path": path_of(field)});
    let template = operator.get("binding").unwrap_or(&Value::Null);
    let binding = if let Some(each) = operator.get("each") {
        let list = text(each, "param").and_then(|name| params.get(name)).and_then(Value::as_array)?;
        let bound = text(each, "as")?;
        let mut copies: Vec<Value> = list
            .iter()
            .map(|entry| {
                let mut with = params.clone();
                with.insert(bound.to_owned(), entry.clone());
                fill(template, &target, &with, &field_params).unwrap_or(Value::Null)
            })
            .collect();
        if copies.len() == 1 {
            copies.remove(0)
        } else {
            combine(each.get("combine").unwrap_or(&Value::Null), copies)
        }
    } else if let Some(parts) = operator.get("parts").and_then(Value::as_array) {
        let mut filled: Vec<Value> = parts
            .iter()
            .filter(|part| present(text(part, "when").and_then(|name| params.get(name))))
            .map(|part| fill(part.get("binding").unwrap_or(&Value::Null), &target, &params, &field_params).unwrap_or(Value::Null))
            .collect();
        if filled.len() == 1 {
            filled.remove(0)
        } else {
            combine(operator.get("combine").unwrap_or(&Value::Null), filled)
        }
    } else {
        fill(template, &target, &params, &field_params).unwrap_or(Value::Null)
    };
    let binding = if truthy(operator.get("negate")) { negated(binding) } else { binding };
    let mut reads = vec![field.id.clone()];
    reads.extend(field_params.iter().map(|(_, other)| other.id.clone()));
    Some((binding, reads))
}

/// Compile a rule tree (compile-rules.mjs `compileRules`).
pub fn compile_rules(tree: Option<&Value>, fields: &[Field], vocabulary: &Vocabulary) -> Compiled {
    let fields: HashMap<String, Field> = fields.iter().map(|field| (field.id.clone(), field.clone())).collect();
    let mut reads = BTreeSet::new();
    let mut read_order = Vec::new();
    let mut incomplete = Vec::new();
    fn visit(
        node: &Value,
        fields: &HashMap<String, Field>,
        vocabulary: &Vocabulary,
        reads: &mut BTreeSet<String>,
        read_order: &mut Vec<String>,
        incomplete: &mut Vec<Value>,
    ) -> Option<Value> {
        if is_group(node) {
            let members: Vec<Value> = node
                .get("rules")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|rule| visit(rule, fields, vocabulary, reads, read_order, incomplete))
                .collect();
            if members.is_empty() {
                return None;
            }
            let combinator = text(node, "combinator")
                .and_then(|id| vocabulary.combinators.get(id))
                .or_else(|| vocabulary.first_combinator.as_ref().and_then(|id| vocabulary.combinators.get(id)));
            let negate = truthy(node.get("negate"));
            let joined = if members.len() == 1 && !negate {
                members.into_iter().next()?
            } else {
                combine(combinator.and_then(|row| row.get("op")).unwrap_or(&Value::Null), members)
            };
            return Some(if negate { negated(joined) } else { joined });
        }
        match compile_rule(node, fields, vocabulary) {
            Some((binding, read)) => {
                for field in read {
                    if reads.insert(field.clone()) {
                        read_order.push(field);
                    }
                }
                Some(binding)
            }
            None => {
                incomplete.push(node.clone());
                None
            }
        }
    }
    let binding = tree
        .filter(|tree| !tree.is_null())
        .and_then(|tree| visit(tree, &fields, vocabulary, &mut reads, &mut read_order, &mut incomplete));
    Compiled { binding, reads: read_order, incomplete }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields() -> Vec<Field> {
        vec![
            Field { id: "name".into(), kind: "text".into(), path: None },
            Field { id: "size".into(), kind: "bytes".into(), path: None },
        ]
    }

    #[test]
    fn an_empty_tree_constrains_nothing() {
        let tree = json!({"kind": "group", "combinator": "and", "negate": false, "rules": []});
        let compiled = compile_rules(Some(&tree), &fields(), Vocabulary::shipped());
        assert_eq!(compiled.binding, None);
        assert_eq!(compile_rules(None, &fields(), Vocabulary::shipped()).binding, None);
    }

    #[test]
    fn an_unfinished_rule_is_reported_never_guessed() {
        let unfinished = json!({"kind": "rule", "field": "name", "operator": "starts_with", "params": {"text": "  "}});
        let unknown = json!({"kind": "rule", "field": "colour", "operator": "starts_with", "params": {"text": "a"}});
        let tree = json!({"kind": "group", "combinator": "and", "negate": false, "rules": [unfinished, unknown]});
        let compiled = compile_rules(Some(&tree), &fields(), Vocabulary::shipped());
        assert_eq!(compiled.binding, None);
        assert_eq!(compiled.incomplete.len(), 2);
    }

    #[test]
    fn a_glob_is_escaped_and_anchored() {
        assert_eq!(glob_pattern("._*"), "^\\._.*$");
        assert_eq!(glob_pattern(".spotlight-v100*"), "^\\.spotlight-v100.*$");
    }
}
