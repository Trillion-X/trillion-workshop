//! The Rust compiler against rules/compile-rules.mjs: every operator of rules/rule-operators.json, on every field kind
//! it applies to, with finished and unfinished params, alone and in nested, negated and/or groups, compiles to the same
//! binding, reads and unfinished rules in both. The JavaScript side runs in node, the compiler the pages use.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use formula_engine_compile_rules::{compile_rules, Field, Vocabulary};
use serde_json::{json, Value};

fn rules_folder() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../rules")
}

/// The params a person could give an operator of this input, finished and not.
fn params_for(input: &str, other_field: &str) -> Vec<Value> {
    match input {
        "none" => vec![json!({})],
        "value" | "any" => vec![json!({"value": 5}), json!({"value": null}), json!({})],
        "values" | "words" => vec![json!({"values": ["Ab*c.", "x"]}), json!({"values": ["one"]}), json!({"values": []})],
        "text" => vec![json!({"text": "Ab*c.(d)"}), json!({"text": other_field}), json!({"text": "   "})],
        "range" | "day" => vec![json!({"min": 1, "max": 9}), json!({"min": 1}), json!({"max": ""}), json!({})],
        other => panic!("rule-operators.json names an input this test does not cover: {other}"),
    }
}

#[test]
fn every_operator_and_group_compiles_as_compile_rules_mjs_does() {
    let data: Value = serde_json::from_str(&std::fs::read_to_string(rules_folder().join("rule-operators.json")).unwrap()).unwrap();
    let kinds: Vec<String> = {
        let mut kinds: Vec<String> = data["operators"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|operator| operator["applies_to"].as_array().unwrap().iter().map(|kind| kind.as_str().unwrap().to_owned()))
            .collect();
        kinds.sort();
        kinds.dedup();
        kinds
    };
    // Two fields of every kind (one with an explicit path), so a comparison naming another field has one to name.
    let fields: Vec<Field> = kinds
        .iter()
        .flat_map(|kind| {
            [
                Field { id: format!("{kind}_a"), kind: kind.clone(), path: None },
                Field { id: format!("{kind}_b"), kind: kind.clone(), path: Some(json!(["facts", format!("{kind}_b")])) },
            ]
        })
        .collect();
    let mut rules = Vec::new();
    for operator in data["operators"].as_array().unwrap() {
        for kind in operator["applies_to"].as_array().unwrap() {
            let kind = kind.as_str().unwrap();
            for params in params_for(operator["input"].as_str().unwrap(), &format!("{kind}_b")) {
                rules.push(json!({"kind": "rule", "field": format!("{kind}_a"), "operator": operator["id"], "params": params}));
            }
        }
    }
    rules.push(json!({"kind": "rule", "field": "no_such_field", "operator": "is_true", "params": {}}));
    let mut trees: Vec<Value> = rules.to_vec();
    for (index, pair) in rules.chunks(2).enumerate() {
        let combinator = if index % 2 == 0 { "and" } else { "or" };
        trees.push(json!({"kind": "group", "combinator": combinator, "negate": index % 3 == 0, "rules": pair}));
    }
    trees.push(json!({"kind": "group", "combinator": "nope", "negate": true, "rules": [
        {"kind": "group", "combinator": "or", "negate": false, "rules": rules.iter().take(5).cloned().collect::<Vec<_>>()},
        rules[7].clone(),
    ]}));
    trees.push(json!({"kind": "group", "combinator": "and", "negate": false, "rules": []}));

    let field_rows: Vec<Value> = fields
        .iter()
        .map(|field| match &field.path {
            Some(path) => json!({"id": field.id, "kind": field.kind, "path": path}),
            None => json!({"id": field.id, "kind": field.kind}),
        })
        .collect();
    let script = format!(
        "import {{compileRules, ruleVocabulary}} from {compile};\n\
         import {{readFileSync}} from 'node:fs';\n\
         const operators = JSON.parse(readFileSync({operators}, 'utf8'));\n\
         const vocabulary = ruleVocabulary(operators);\n\
         const asked = JSON.parse(readFileSync(0, 'utf8'));\n\
         process.stdout.write(JSON.stringify(asked.trees.map(tree => compileRules(tree, {{fields: asked.fields, vocabulary}}))));\n",
        compile = serde_json::to_string(&format!("file://{}", rules_folder().join("compile-rules.mjs").display())).unwrap(),
        operators = serde_json::to_string(&rules_folder().join("rule-operators.json").display().to_string()).unwrap(),
    );
    let mut node = Command::new("node")
        .args(["--input-type=module", "-e", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("node runs compile-rules.mjs");
    node.stdin
        .take()
        .unwrap()
        .write_all(json!({"trees": trees, "fields": field_rows}).to_string().as_bytes())
        .unwrap();
    let output = node.wait_with_output().unwrap();
    assert!(output.status.success(), "node failed");
    let expected: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(expected.len(), trees.len());
    let vocabulary = Vocabulary::shipped();
    for (tree, expected) in trees.iter().zip(expected) {
        let compiled = compile_rules(Some(tree), &fields, vocabulary);
        let got = json!({
            "binding": compiled.binding,
            "reads": compiled.reads,
            "incomplete": compiled.incomplete,
        });
        assert_eq!(got, expected, "tree {tree}");
    }
}
