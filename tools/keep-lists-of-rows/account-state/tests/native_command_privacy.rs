//! Draft controls for schema-based native command input privacy.
//! Parent wiring remains separate; these controls are intentionally not run here.

use trillion_local::{
    ecma_json::{self, Limits, Value},
    local_account::record_writer::native_command_context::privacy::{
        PrivacyError, assert_replayable_input, operation_private_value,
    },
};

fn json(source: &str) -> Value {
    ecma_json::parse(source.as_bytes(), Limits::default()).unwrap()
}
fn compact(value: &Value) -> String {
    ecma_json::stringify(value, Limits::default()).unwrap()
}

#[test]
fn all_of_and_only_matching_any_of_branch_redact_nested_write_only_values() {
    let input = json(r#"{"kind":"stored","secret":"credential","visible":true}"#);
    let schema = json(
        r#"{
          "allOf":[{"properties":{"secret":{"type":"string","writeOnly":true}}}],
          "anyOf":[
            {"properties":{"kind":{"enum":["stored"]},"secret":{"writeOnly":true}}},
            {"properties":{"kind":{"enum":["other"]},"visible":{"writeOnly":true}}}
          ]
        }"#,
    );
    let projected = operation_private_value(&input, &schema).unwrap();
    assert_eq!(
        compact(&projected),
        r#"{"kind":"stored","secret":"[write-only]","visible":true}"#
    );
}

#[test]
fn matching_any_of_branches_are_unioned_and_one_of_ambiguity_falls_back_safely() {
    let input = json(r#"{"kind":"x","password":"p","privateKey":"k"}"#);
    let any_of = json(
        r#"{"anyOf":[
          {"properties":{"kind":{"enum":["x"]},"password":{"writeOnly":true}}},
          {"properties":{"kind":{"enum":["x"]},"privateKey":{"writeOnly":true}}}
        ]}"#,
    );
    let projected = operation_private_value(&input, &any_of).unwrap();
    assert_eq!(
        compact(&projected),
        r#"{"kind":"x","password":"[write-only]","privateKey":"[write-only]"}"#
    );

    let one_of = json(
        r#"{"oneOf":[
          {"properties":{"kind":{"enum":["x"]},"password":{"writeOnly":true}}},
          {"properties":{"kind":{"enum":["x"]},"privateKey":{"writeOnly":true}}}
        ]}"#,
    );
    let projected = operation_private_value(&input, &one_of).unwrap();
    assert_eq!(
        compact(&projected),
        r#"{"kind":"x","password":"[write-only]","privateKey":"[write-only]"}"#
    );
}

#[test]
fn no_matching_union_uses_canonical_all_branches_fallback() {
    let input = json(r#"{"kind":"other","password":"p","privateKey":"k"}"#);
    let schema = json(
        r#"{"anyOf":[
          {"properties":{"kind":{"enum":["first"]},"password":{"writeOnly":true}}},
          {"properties":{"kind":{"enum":["second"]},"privateKey":{"writeOnly":true}}}
        ]}"#,
    );
    let projected = operation_private_value(&input, &schema).unwrap();
    assert_eq!(
        compact(&projected),
        r#"{"kind":"other","password":"[write-only]","privateKey":"[write-only]"}"#
    );
}

#[test]
fn tuple_items_and_additional_properties_are_walked_without_changing_public_values() {
    let input = json(r#"{"rows":[{"token":"t","label":"public"}],"extra":"x"}"#);
    let schema = json(
        r#"{
          "properties":{"rows":{"items":[{"properties":{"token":{"writeOnly":true}}}]}},
          "additionalProperties":{"writeOnly":true}
        }"#,
    );
    let projected = operation_private_value(&input, &schema).unwrap();
    assert_eq!(
        compact(&projected),
        r#"{"rows":[{"token":"[write-only]","label":"public"}],"extra":"[write-only]"}"#
    );
}

#[test]
fn unsupported_pattern_matching_keeps_possible_private_branch_in_scope() {
    let input = json(r#"{"kind":"id-123","secret":"s","public":"p"}"#);
    let schema = json(
        r#"{"oneOf":[
          {"properties":{"kind":{"pattern":"^id-[0-9]+$"},"secret":{"writeOnly":true}}},
          {"properties":{"kind":{"enum":["never"]},"public":{"writeOnly":true}}}
        ]}"#,
    );
    let projected = operation_private_value(&input, &schema).unwrap();
    assert_eq!(
        compact(&projected),
        r#"{"kind":"id-123","secret":"[write-only]","public":"p"}"#
    );
}

#[test]
fn raw_write_only_replay_refusal_has_no_input_or_schema_in_diagnostics() {
    let input = json(r#"{"credential":"distinctive-secret-value"}"#);
    let schema = json(r#"{"properties":{"credential":{"writeOnly":true}}}"#);
    let error = assert_replayable_input(&input, &schema).unwrap_err();
    assert!(matches!(error, PrivacyError::WriteOnly(_)));
    let diagnostic = format!("{error:?} {error}");
    assert!(!diagnostic.contains("distinctive-secret-value"));
    assert!(!diagnostic.contains("credential"));
}

#[test]
fn depth_exhaustion_fails_closed() {
    let mut input = json("null");
    for _ in 0..130 {
        input = Value::Array(vec![input]);
    }
    assert!(matches!(operation_private_value(&input, &json("{}")).unwrap_err(), PrivacyError::Complexity(_)));
}
