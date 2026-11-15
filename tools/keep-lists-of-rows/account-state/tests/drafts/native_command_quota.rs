//! Draft port parity cases. This path is intentionally outside Cargo's
//! discovered integration-test roots until the native command owner mounts it.
use serde_json::Value as DataValue;
use trillion_local::{
    ecma_json::{self, Limits, Value},
    native_command_quota::{own_resource_command_quota, QuotaDecision, QuotaErrorKind},
};

fn rates() -> DataValue {
    serde_json::from_slice(include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/own-resource-command-quota.json")))
        .unwrap()
}

fn input(source: &str) -> Value {
    ecma_json::parse(source.as_bytes(), Limits::default()).unwrap()
}

fn estimate(operation: &str, input: Value) -> trillion_local::native_command_quota::QuotaEstimate {
    match own_resource_command_quota(operation, input, &rates()).unwrap() {
        QuotaDecision::Estimate(estimate) => estimate,
        QuotaDecision::DelegateToDatabase { .. } => panic!("expected semantic-command estimate"),
    }
}

#[test]
fn dynamic_semantic_operation_uses_installed_default_rate_and_records_facts() {
    // This operation flows through the same generic selection as any other
    // installed DATA operation; it has no source branch or copied rate.
    let result = estimate(
        "workspace:write",
        input(r#"{"items":["a","b"],"text":"🙂"}"#),
    );
    let installed = rates();
    let default = &installed["default"];
    assert_eq!(result.work_facts.input_bytes, 33);
    assert_eq!(result.work_facts.input_nodes, 5);
    assert_eq!(result.work_facts.input_sources, Some(2));
    assert_eq!(result.work_facts.page_limit, None);
    assert_eq!(result.estimate.calls, 1);
    assert_eq!(
        result.estimate.statements,
        default["statements"][0].as_f64().unwrap()
            + default["statements"][1].as_f64().unwrap() * 5.0
    );
    assert_eq!(
        result.estimate.rows_read,
        default["rows_read"][0].as_f64().unwrap() + default["rows_read"][1].as_f64().unwrap() * 5.0
    );
    assert_eq!(
        result.estimate.rows_written,
        default["rows_written"][0].as_f64().unwrap()
            + default["rows_written"][1].as_f64().unwrap() * 5.0
    );
}

#[test]
fn operation_override_replaces_default_and_page_limit_sets_work() {
    let installed = rates();
    let operation_rates = &installed["operations"]["collections:project"];
    let result = estimate("collections:project", input(r#"{"limit":40}"#));
    assert_eq!(result.work_facts.page_limit, Some(40.0));
    assert_eq!(result.work_facts.input_nodes, 2);
    assert_eq!(
        result.estimate.statements,
        operation_rates["statements"][0].as_f64().unwrap()
            + operation_rates["statements"][1].as_f64().unwrap() * 40.0
    );
    assert_eq!(
        result.estimate.rows_read,
        operation_rates["rows_read"][0].as_f64().unwrap()
            + operation_rates["rows_read"][1].as_f64().unwrap() * 40.0
    );
    assert_eq!(
        result.estimate.rows_written,
        operation_rates["rows_written"][0].as_f64().unwrap()
            + operation_rates["rows_written"][1].as_f64().unwrap() * 40.0
    );
}

#[test]
fn database_owned_operations_are_explicitly_delegated() {
    for operation in ["records:read", "records:delete", "resolve"] {
        let delegated = own_resource_command_quota(operation, input("{}"), &rates()).unwrap();
        assert!(matches!(
            delegated,
            QuotaDecision::DelegateToDatabase { .. }
        ));
    }
}

#[test]
fn malformed_operation_and_uninstalled_rate_data_refuse_without_fallback() {
    for operation in [
        "",
        "workspace",
        ":write",
        "workspace:",
        "workspace::write",
        "9workspace:write",
        "workspace:9write",
        "workspace:_write",
    ] {
        let error = own_resource_command_quota(operation, input("{}"), &rates()).unwrap_err();
        assert_eq!(error.kind, QuotaErrorKind::InvalidOperation);
        assert_eq!(error.status, 400);
    }

    let malformed_override = serde_json::json!({
        "default":{"statements":[1,1],"rows_read":[1,1],"rows_written":[1,1]},
        "operations":{"workspace:write":{"statements":[9,9]}}
    });
    let error = own_resource_command_quota("workspace:write", input("{}"), &malformed_override)
        .unwrap_err();
    assert_eq!(error.kind, QuotaErrorKind::InvalidInstalledRates);
}

#[test]
fn page_and_source_bounds_match_the_command_contract() {
    for source in [
        r#"{"items":"long source text"}"#,
        r#"{"items":{"length":1000}}"#,
    ] {
        let error = own_resource_command_quota("lists:put", input(source), &rates()).unwrap_err();
        assert_eq!(error.kind, QuotaErrorKind::InvalidInput);
    }
    for source in [
        r#"{"limit":0}"#,
        r#"{"limit":1001}"#,
        r#"{"limit":1.5}"#,
        r#"{"limit":null}"#,
    ] {
        let error = own_resource_command_quota("lists:put", input(source), &rates()).unwrap_err();
        assert_eq!(error.kind, QuotaErrorKind::InvalidPageLimit);
        assert_eq!(error.status, 400);
    }
    let accepted = estimate(
        "lists:put",
        input(&format!(
            "{{\"items\":{}}}",
            serde_json::to_string(&vec![0; 100]).unwrap()
        )),
    );
    assert_eq!(accepted.work_facts.input_sources, Some(100));

    let too_many = format!(
        "{{\"items\":{}}}",
        serde_json::to_string(&vec![0; 101]).unwrap()
    );
    let error = own_resource_command_quota("lists:put", input(&too_many), &rates()).unwrap_err();
    assert_eq!(error.kind, QuotaErrorKind::TooManySources);
    assert_eq!(error.status, 400);
}

#[test]
fn serialized_utf8_byte_count_and_two_megabyte_refusal_are_exact() {
    let text = r#"{"x":"🙂"}"#;
    let result = estimate("lists:put", input(text));
    assert_eq!(
        result.work_facts.input_bytes,
        ecma_json::stringify(&input(text), Limits::default())
            .unwrap()
            .len()
    );
    assert_eq!(result.work_facts.input_bytes, 12);

    let exact = format!("{{\"x\":\"{}\"}}", "a".repeat(1_999_992));
    let admitted = estimate("lists:put", input(&exact));
    assert_eq!(admitted.work_facts.input_bytes, 2_000_000);

    let oversized = format!("{{\"x\":\"{}\"}}", "a".repeat(1_999_993));
    let error = own_resource_command_quota("lists:put", input(&oversized), &rates()).unwrap_err();
    assert_eq!(error.kind, QuotaErrorKind::InputTooLarge);
    assert_eq!(error.status, 413);
}
