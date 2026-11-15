use trillion_local::ecma_json;
use trillion_local::record_canonical;
use ecma_json::{JsString, Value};
use record_canonical::{canonical, identity, Error, Limits};
use std::cmp::Ordering;

fn value(raw: &str) -> Value {
    ecma_json::parse(raw.as_bytes(), Default::default()).unwrap()
}
// Explicit synthetic comparator. These controls exercise canonical mechanics,
// never qualify a production locale or substitute this comparator for ICU.
fn lexical(a: &JsString, b: &JsString) -> Result<Ordering, ()> {
    Ok(a.units().cmp(b.units()))
}

#[test]
fn nested_objects_reorder_but_array_sequence_stays_original() {
    let input = value(r#"{"z":[{"z":1,"a":2},3,2],"a":{"y":false,"b":null}}"#);
    assert_eq!(
        canonical(&input, Limits::default(), &mut lexical).unwrap(),
        r#"{"a":{"b":null,"y":false},"z":[{"a":2,"z":1},3,2]}"#
    );
}
#[test]
fn integer_properties_reenumerate_numerically_after_locale_sort() {
    let input = value(r#"{"z":0,"10":10,"2":2,"01":1,"4294967295":3,"a":4}"#);
    assert_eq!(
        canonical(&input, Limits::default(), &mut lexical).unwrap(),
        r#"{"2":2,"10":10,"01":1,"4294967295":3,"a":4,"z":0}"#
    );
}
#[test]
fn locale_ties_preserve_source_ecmascript_enumeration_including_nested_objects() {
    let input = value(r#"{"z":{"b":1,"a":2},"10":0,"2":0,"a":3}"#);
    let mut ties = |_: &JsString, _: &JsString| Ok::<_, ()>(Ordering::Equal);
    assert_eq!(
        canonical(&input, Limits::default(), &mut ties).unwrap(),
        r#"{"2":0,"10":0,"z":{"b":1,"a":2},"a":3}"#
    );
}
#[test]
fn serializer_owner_retains_lone_utf16_and_ecmascript_number_spelling() {
    let input = value(r#"{"z":"\ud800","a":[-0,1e-7,1e21,1e400]}"#);
    assert_eq!(
        canonical(&input, Limits::default(), &mut lexical).unwrap(),
        r#"{"a":[0,1e-7,1e+21,null],"z":"\ud800"}"#
    );
}
#[test]
fn existing_content_identity_grammar_hashes_exact_canonical_utf8() {
    assert_eq!(
        identity(&value(r#"{"z":1,"a":2}"#), Limits::default(), &mut lexical).unwrap(),
        "1f:bf45b62781e04b92e506fd95427f1b4b60579334474ca10bbd16317cde8dcbbb"
    );
}
#[test]
fn locale_failure_refuses_without_fallback_or_private_error_text() {
    let mut unavailable =
        |_: &JsString, _: &JsString| Err::<Ordering, _>("private-provider-detail");
    let error = canonical(
        &value(r#"{"private-a":1,"private-z":2}"#),
        Limits::default(),
        &mut unavailable,
    )
    .unwrap_err();
    assert_eq!(error, trillion_local::cause!(Error::Comparator));
    assert!(!format!("{error:?} {error}").contains("private"));
}
#[test]
fn one_operation_comparison_budget_is_shared_across_nested_objects() {
    let input = value(r#"[{"b":1,"a":2},{"b":3,"a":4}]"#);
    let mut limits = Limits::default();
    limits.comparisons = 1;
    assert_eq!(
        canonical(&input, limits, &mut lexical).unwrap_err(),
        trillion_local::cause!(Error::Bounds)
    );
}
#[test]
fn complete_bounds_are_checked_before_callback_or_rebuild() {
    let input = value(r#"{"a":[1,2,3],"z":"long"}"#);
    let mut calls = 0;
    let mut comparator = |_: &JsString, _: &JsString| {
        calls += 1;
        Ok::<_, ()>(Ordering::Equal)
    };
    let mut limits = Limits::default();
    limits.json.nodes = 2;
    assert_eq!(
        canonical(&input, limits, &mut comparator).unwrap_err(),
        trillion_local::cause!(Error::Bounds)
    );
    assert_eq!(calls, 0);
    let mut limits = Limits::default();
    limits.comparisons = 0;
    assert_eq!(
        canonical(&input, limits, &mut lexical).unwrap_err(),
        trillion_local::cause!(Error::InvalidLimits)
    );
    let mut limits = Limits::default();
    limits.json.input_bytes = 1;
    assert_eq!(
        canonical(&input, limits, &mut lexical).unwrap_err(),
        trillion_local::cause!(Error::Bounds)
    );
}
