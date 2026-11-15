use trillion_local::ecma_json::{self, JsString, Value};

use trillion_local::rule_bindings;
use rule_bindings::{BindingEvaluator, CompiledRules, Error, Limits, TextSemantics};
#[path = "support/workshop_data.rs"]
mod workshop_data;


fn json(raw: &str) -> Value {
    ecma_json::parse(raw.as_bytes(), ecma_json::Limits::default()).unwrap()
}
fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(object) => object.get(&JsString::from(key)),
        _ => None,
    }
}
fn rules_data() -> Value {
    workshop_data::rule_operators()
}
fn field(id: &str, kind: &str, path: &[&str]) -> Value {
    let mut path_value = Vec::new();
    for part in path {
        path_value.push(Value::String(JsString::from(*part)));
    }
    let mut object = ecma_json::Object::new();
    object.insert("id".into(), Value::String(JsString::from(id)));
    object.insert("kind".into(), Value::String(JsString::from(kind)));
    object.insert("path".into(), Value::Array(path_value));
    Value::Object(object)
}
fn compile(
    tree: Option<&Value>,
    fields: &[Value],
    text: &mut impl TextSemantics,
) -> Result<CompiledRules, Error> {
    rule_bindings::compile_rules(tree, fields, &rules_data(), text, Limits::default())
}
fn words(ids: &[JsString]) -> Vec<String> {
    ids.iter().map(|id| id.to_rust_string().unwrap()).collect()
}
fn compact(value: &Value) -> String {
    ecma_json::stringify(value, ecma_json::Limits::default()).unwrap()
}

/// Deliberately supports only ASCII. A production adapter must delegate to its
/// locale owner and refuse strings outside its verified compatibility scope.
struct AsciiText;
impl TextSemantics for AsciiText {
    fn to_locale_lowercase(&mut self, value: &JsString) -> Result<JsString, Error> {
        if !value.units().iter().all(|unit| *unit <= 0x7f) {
            return Err(trillion_local::cause!(Error::Unsupported));
        }
        Ok(JsString::from_units(
            value
                .units()
                .iter()
                .map(|unit| {
                    if (b'A' as u16..=b'Z' as u16).contains(unit) {
                        *unit + 32
                    } else {
                        *unit
                    }
                })
                .collect(),
        ))
    }
    fn trim_is_empty(&mut self, value: &JsString) -> Result<bool, Error> {
        if !value.units().iter().all(|unit| *unit <= 0x7f) {
            return Err(trillion_local::cause!(Error::Unsupported));
        }
        Ok(value
            .units()
            .iter()
            .all(|unit| matches!(*unit, 9..=13 | 32)))
    }
}
#[derive(Default)]
struct Capture {
    seen_binding: bool,
}
impl BindingEvaluator for Capture {
    fn evaluate(&mut self, binding: &Value, input: &Value) -> Result<Value, Error> {
        self.seen_binding = matches!(binding, Value::Object(_));
        let _ = input;
        Ok(Value::Bool(true))
    }
}

#[test]
fn empty_and_incomplete_trees_keep_null_binding_and_source_order() {
    let mut text = AsciiText;
    let fields = vec![
        field("title", "text", &["title"]),
        field("done", "boolean", &["done"]),
        field("count", "number", &["count"]),
    ];
    let empty = json(r#"{"kind":"group","combinator":"and","negate":false,"rules":[]}"#);
    let result = compile(Some(&empty), &fields, &mut text).unwrap();
    assert!(result.binding.is_none());
    assert!(result.reads.is_empty());
    assert!(result.incomplete.is_empty());
    assert!(compile(None, &fields, &mut text).unwrap().binding.is_none());
    let tree = json(
        r#"{"kind":"group","combinator":"and","negate":false,"rules":[
      {"kind":"rule","field":"done","operator":"is_true","params":{}},
      {"kind":"rule","field":"title","operator":"operator_missing","params":{}},
      {"kind":"rule","field":"count","operator":"is_true","params":{}}]}"#,
    );
    let result = compile(Some(&tree), &fields, &mut text).unwrap();
    assert_eq!(words(&result.reads), ["done"]);
    assert_eq!(
        result.incomplete,
        vec![
            match &tree {
                Value::Object(root) => match root.get(&JsString::from("rules")).unwrap() {
                    Value::Array(a) => a[1].clone(),
                    _ => unreachable!(),
                },
                _ => unreachable!(),
            },
            match &tree {
                Value::Object(root) => match root.get(&JsString::from("rules")).unwrap() {
                    Value::Array(a) => a[2].clone(),
                    _ => unreachable!(),
                },
                _ => unreachable!(),
            }
        ]
    );
    let binding = result.binding.unwrap();
    assert!(compact(&binding).contains("op:core.eq"));
}

#[test]
fn declared_field_kinds_gate_operator_readiness_and_lowering() {
    let mut text = AsciiText;
    let fields = vec![
        field("title", "text", &["card", "title"]),
        field("done", "boolean", &["done"]),
    ];
    let tree =
        json(r#"{"kind":"rule","field":"title","operator":"contains","params":{"text":"MIXED"}}"#);
    let result = compile(Some(&tree), &fields, &mut text).unwrap();
    assert_eq!(words(&result.reads), ["title"]);
    let binding = result.binding.unwrap();
    assert!(compact(&binding).contains("mixed"));
    assert!(compact(&binding).contains("card"));
    let wrong_kind =
        json(r#"{"kind":"rule","field":"done","operator":"contains","params":{"text":"x"}}"#);
    assert!(compile(Some(&wrong_kind), &fields, &mut text)
        .unwrap()
        .binding
        .is_none());
    let whitespace =
        json(r#"{"kind":"rule","field":"title","operator":"contains","params":{"text":" \t\n "}}"#);
    let result = compile(Some(&whitespace), &fields, &mut text).unwrap();
    assert!(result.binding.is_none());
    assert_eq!(result.incomplete, vec![whitespace]);
    let unicode =
        json(r#"{"kind":"rule","field":"title","operator":"contains","params":{"text":"İ"}}"#);
    assert_eq!(
        compile(Some(&unicode), &fields, &mut text).unwrap_err(),
        trillion_local::cause!(Error::Unsupported)
    );
}

#[test]
fn default_combinator_empty_groups_and_group_negation_follow_the_source() {
    let mut text = AsciiText;
    let fields = vec![field("a", "boolean", &["a"]), field("b", "boolean", &["b"])];
    let tree = json(
        r#"{"kind":"group","negate":true,"rules":[
      {"kind":"rule","field":"a","operator":"is_true","params":{}},
      {"kind":"group","combinator":"or","negate":false,"rules":[]},
      {"kind":"rule","field":"b","operator":"is_false","params":{}}]}"#,
    );
    let result = compile(Some(&tree), &fields, &mut text).unwrap();
    let binding = compact(&result.binding.unwrap());
    assert!(binding.contains("op:core.and")); // omitted parent combinator falls back to the first DATA row
    assert!(binding.contains("op:core.not"));
    assert_eq!(words(&result.reads), ["a", "b"]);
    let single = json(
        r#"{"kind":"group","combinator":"or","negate":false,"rules":[{"kind":"rule","field":"a","operator":"is_true","params":{}}]}"#,
    );
    assert!(!compact(
        &compile(Some(&single), &fields, &mut text)
            .unwrap()
            .binding
            .unwrap()
    )
    .contains("op:core.or"));
}

#[test]
fn each_and_parts_use_operator_templates_and_declared_combinators() {
    let mut text = AsciiText;
    let fields = vec![
        field("tags", "tags", &["labels"]),
        field("size", "number", &["size"]),
    ];
    let each = json(
        r#"{"kind":"rule","field":"tags","operator":"has_any_of","params":{"values":["alpha","beta"]}}"#,
    );
    let binding = compact(
        &compile(Some(&each), &fields, &mut text)
            .unwrap()
            .binding
            .unwrap(),
    );
    assert!(binding.contains("op:core.or"));
    assert!(binding.contains("alpha"));
    assert!(binding.contains("beta"));
    let one = json(
        r#"{"kind":"rule","field":"tags","operator":"has_any_of","params":{"values":["alpha"]}}"#,
    );
    assert!(!compact(
        &compile(Some(&one), &fields, &mut text)
            .unwrap()
            .binding
            .unwrap()
    )
    .contains("op:core.or"));
    let parts =
        json(r#"{"kind":"rule","field":"size","operator":"between","params":{"min":3,"max":9}}"#);
    let binding = compact(
        &compile(Some(&parts), &fields, &mut text)
            .unwrap()
            .binding
            .unwrap(),
    );
    assert!(binding.contains("op:core.and"));
    assert!(binding.contains("op:core.ge"));
    assert!(binding.contains("op:core.le"));
    let one_part =
        json(r#"{"kind":"rule","field":"size","operator":"between","params":{"min":3}}"#);
    let binding = compact(
        &compile(Some(&one_part), &fields, &mut text)
            .unwrap()
            .binding
            .unwrap(),
    );
    assert!(binding.contains("op:core.ge"));
    assert!(!binding.contains("op:core.and"));
}

#[test]
fn field_parameter_reads_keep_declared_order_and_require_matching_kinds() {
    let mut text = AsciiText;
    let fields = vec![
        field("title", "text", &["title"]),
        field("backup", "text", &["fallback"]),
        field("count", "number", &["count"]),
    ];
    let tree = json(
        r#"{"kind":"rule","field":"title","operator":"matches_field","params":{"text":"backup"}}"#,
    );
    let result = compile(Some(&tree), &fields, &mut text).unwrap();
    assert_eq!(words(&result.reads), ["title", "backup"]);
    assert!(compact(&result.binding.unwrap()).contains("fallback"));
    let unlike = json(
        r#"{"kind":"rule","field":"title","operator":"matches_field","params":{"text":"count"}}"#,
    );
    let result = compile(Some(&unlike), &fields, &mut text).unwrap();
    assert!(result.binding.is_none());
    assert_eq!(result.incomplete, vec![unlike]);
}

#[test]
fn utf16_field_identity_is_preserved_and_injected_evaluator_receives_the_binding() {
    let mut text = AsciiText;
    let lone = JsString::from_units(vec![0xD800]);
    let mut descriptor = ecma_json::Object::new();
    descriptor.insert("id".into(), Value::String(lone.clone()));
    descriptor.insert("kind".into(), Value::String(JsString::from("boolean")));
    let fields = vec![Value::Object(descriptor)];
    let mut rule = ecma_json::Object::new();
    rule.insert("kind".into(), Value::String(JsString::from("rule")));
    rule.insert("field".into(), Value::String(lone.clone()));
    rule.insert("operator".into(), Value::String(JsString::from("is_true")));
    rule.insert("params".into(), json("{}"));
    let compiled = compile(Some(&Value::Object(rule)), &fields, &mut text).unwrap();
    assert_eq!(compiled.reads, vec![lone.clone()]);
    let path = get(compiled.binding.as_ref().unwrap(), "select")
        .and_then(|s| get(s, "path"))
        .and_then(|p| match p {
            Value::Array(a) => a.first(),
            _ => None,
        })
        .and_then(|v| match v {
            Value::String(s) => Some(s),
            _ => None,
        })
        .unwrap();
    assert_eq!(path, &lone);
    let mut evaluator = Capture::default();
    assert_eq!(
        compiled.evaluate(&mut evaluator, &json("{}")),
        Ok(Value::Bool(true))
    );
    assert!(evaluator.seen_binding);
}

#[test]
fn malformed_declarations_and_budget_exhaustion_refuse() {
    let mut text = AsciiText;
    let missing_kind = vec![json(r#"{"id":"x","path":["x"]}"#)];
    assert_eq!(
        compile(None, &missing_kind, &mut text).unwrap_err(),
        trillion_local::cause!(Error::Invalid)
    );
    let malformed_vocabulary = json(
        r#"{"operators":[{"id":"broken","input":"none","applies_to":"text","binding":{}}],"combinators":[{"id":"and","op":"op:core.and"}]}"#,
    );
    assert_eq!(
        rule_bindings::compile_rules(
            None,
            &[],
            &malformed_vocabulary,
            &mut text,
            Limits::default()
        )
        .unwrap_err(),
        trillion_local::cause!(Error::Invalid)
    );
    let fields = vec![field("x", "boolean", &["x"])];
    let tree = json(r#"{"kind":"rule","field":"x","operator":"is_true","params":{}}"#);
    let limits = Limits {
        nodes: 1,
        ..Limits::default()
    };
    assert_eq!(
        rule_bindings::compile_rules(Some(&tree), &fields, &rules_data(), &mut text, limits)
            .unwrap_err(),
        trillion_local::cause!(Error::Bounds)
    );
}
