use ecma_json::{JsString, Object, Value};
use metadata::{AppBasis, Error, ManagedBrowser, Origin, Phase};
use trillion_local::ecma_json;
use trillion_local::local_account::record_writer::native_command_context::execution_metadata as metadata;

struct Input {
    call: JsString,
    request: JsString,
    operation: JsString,
    reader: JsString,
}
impl Input {
    fn new() -> Self {
        Self {
            call: "call-1".into(),
            request: "request-1".into(),
            operation: "setting.save".into(),
            reader: "person-1".into(),
        }
    }
    fn borrowed(&self) -> ManagedBrowser<'_> {
        ManagedBrowser {
            call_id: &self.call,
            request_id: &self.request,
            operation: &self.operation,
            reader: &self.reader,
            app: None,
            app_basis: AppBasis::Unknown,
            origin: Origin::Real,
        }
    }
}
fn json(raw: &str) -> Value {
    ecma_json::parse(raw.as_bytes(), ecma_json::Limits::default()).unwrap()
}
fn encoded(value: &Value) -> String {
    ecma_json::stringify(value, ecma_json::Limits::default()).unwrap()
}
fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    let Value::Object(value) = value else {
        panic!("expected fixture object")
    };
    value.get(&key.into()).unwrap()
}

#[test]
fn ordinary_source_shape_keeps_authenticated_recorder_distinct_from_unknown_actor() {
    let input = Input::new();
    let record = metadata::begin(&input.borrowed(), 0).unwrap();
    assert_eq!(record.id, JsString::from("execution:call-1"));
    assert_eq!(record.record_type, "execution");
    assert_eq!(
        encoded(&record.value),
        r#"{"execution_ref":"execution:call-1","call_id":"call-1","operation":"setting.save","request_id":"request-1","capture_kind":"managed_dispatch","origin":"real","captured_at":"1970-01-01T00:00:00.000Z","recorder":{"reader":"person-1","basis":"authenticated","app_basis":"unknown"},"actor":{"basis":"unknown"},"phase":"dispatching","links":{},"created_at":"1970-01-01T00:00:00.000Z","updated_at":"1970-01-01T00:00:00.000Z","coverage":{"before_dispatch":true,"input_output":"not_captured","native_host":"managed_boundary_only"}}"#
    );
}

#[test]
fn terminal_update_preserves_original_metadata_and_timestamp_only_update_writes_nothing() {
    let input = Input::new();
    let mut start = metadata::begin(&input.borrowed(), 0).unwrap();
    if let Value::Object(value) = &mut start.value {
        value.insert("source_ref".into(), Value::String("original-source".into()));
    }
    let first = metadata::finish(&start.value, &start.id, Phase::Returned, None, 1000).unwrap();
    assert!(first.changed);
    assert_eq!(
        field(&first.record.value, "source_ref"),
        field(&start.value, "source_ref")
    );
    assert_eq!(
        field(&first.record.value, "recorder"),
        field(&start.value, "recorder")
    );
    assert_eq!(
        field(&first.record.value, "actor"),
        field(&start.value, "actor")
    );
    assert_eq!(
        field(&first.record.value, "coverage"),
        field(&start.value, "coverage")
    );
    let second =
        metadata::finish(&first.record.value, &start.id, Phase::Returned, None, 2000).unwrap();
    assert!(!second.changed);
    assert_eq!(encoded(&second.record.value), encoded(&first.record.value));
}

#[test]
fn known_failure_and_unknown_outcome_remain_distinct_without_output_capture() {
    let input = Input::new();
    let start = metadata::begin(&input.borrowed(), 0).unwrap();
    let error = "interrupted".into();
    let unknown =
        metadata::finish(&start.value, &start.id, Phase::Unknown, Some(&error), 1000).unwrap();
    assert_eq!(
        field(&unknown.record.value, "phase"),
        &Value::String("unknown".into())
    );
    let failed =
        metadata::finish(&start.value, &start.id, Phase::Failed, Some(&error), 1000).unwrap();
    assert_eq!(
        field(&failed.record.value, "phase"),
        &Value::String("failed".into())
    );
    assert_eq!(
        field(&failed.record.value, "error_code"),
        &Value::String(error)
    );
    assert_eq!(
        field(&failed.record.value, "coverage"),
        field(&start.value, "coverage")
    );
}

#[test]
fn ids_are_never_generated_or_truncated_and_utf16_surrogates_survive() {
    let mut input = Input::new();
    input.call = JsString::from_units(vec![0xd800]);
    let record = metadata::begin(&input.borrowed(), 0).unwrap();
    assert!(encoded(&record.value).contains(r#""execution_ref":"execution:\ud800""#));
    input.call = JsString::from_units(vec![65; 8192]);
    assert_refusal(metadata::begin(&input.borrowed(), 0).unwrap_err(), "Error::Bounds");
    input.call = "".into();
    assert_refusal(metadata::begin(&input.borrowed(), 0).unwrap_err(), "Error::Invalid");
    input.call = "execution:existing".into();
    assert_eq!(
        metadata::begin(&input.borrowed(), 0).unwrap().id,
        input.call
    );
}

#[test]
fn bounds_and_wrong_original_reference_refuse_before_a_completion_can_be_claimed() {
    let input = Input::new();
    let start = metadata::begin(&input.borrowed(), 0).unwrap();
    assert_refusal(metadata::finish(&start.value, &"other".into(), Phase::Returned, None, 0).unwrap_err(), "Error::Invalid");
    assert_refusal(metadata::finish(&Value::Null, &start.id, Phase::Returned, None, 0).unwrap_err(), "Error::Invalid");
    let mut excessive = Object::new();
    excessive.insert("execution_ref".into(), Value::String(start.id.clone()));
    excessive.insert("extra".into(), Value::Array(vec![Value::Null; 100_001]));
    // The bound is refused where the JSON stringify runs, so that file is the origin, not this one.
    let refused = metadata::finish(&Value::Object(excessive), &start.id, Phase::Returned, None, 0).unwrap_err();
    assert!(matches!(refused, Error::Bounds(_)), "{refused:?}");
    assert_eq!(refused.cause().file(), "src/ecma_json.rs");
}

#[test]
fn exact_iso_milliseconds_and_extended_years_do_not_use_rfc3339_approximations() {
    let input = Input::new();
    assert_eq!(
        field(
            &metadata::begin(&input.borrowed(), -1).unwrap().value,
            "captured_at"
        ),
        &Value::String("1969-12-31T23:59:59.999Z".into())
    );
    assert_eq!(
        field(
            &metadata::begin(&input.borrowed(), 253_402_300_800_000)
                .unwrap()
                .value,
            "captured_at"
        ),
        &Value::String("+010000-01-01T00:00:00.000Z".into())
    );
    assert_refusal(metadata::begin(&input.borrowed(), 8_640_000_000_000_001).unwrap_err(), "Error::UnsupportedTime");
}

#[test]
fn caller_app_and_origin_metadata_does_not_promote_an_agent_identity() {
    let input = Input::new();
    let app = JsString::from("fixture-app");
    let mut request = input.borrowed();
    request.app = Some(&app);
    request.app_basis = AppBasis::ClientDeclared;
    request.origin = Origin::Synthetic;
    let record = metadata::begin(&request, 0).unwrap();
    assert_eq!(
        field(&record.value, "recorder"),
        &json(
            r#"{"reader":"person-1","app":"fixture-app","basis":"authenticated","app_basis":"client_declared"}"#
        )
    );
    assert_eq!(
        field(&record.value, "actor"),
        &json(r#"{"basis":"unknown"}"#)
    );
    assert_eq!(
        field(&record.value, "origin"),
        &Value::String("synthetic".into())
    );
    assert!(!format!("{record:?}").contains("person-1"));
    assert!(!format!("{record:?}").contains("call-1"));
}

/// The refusal's variant condition and its production file. Line and column are incidental: an edit above the
/// production site must not fail this test, and the file plus condition still name the exact construction.
fn assert_refusal(error: Error, condition: &str) {
    let cause = error.cause();
    assert_eq!(cause.file(), "src/local_account/native_command_context/execution_metadata.rs");
    assert_eq!(cause.condition(), condition);
}
