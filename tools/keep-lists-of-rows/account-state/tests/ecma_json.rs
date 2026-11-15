//! Fixed ECMAScript JSON-origin vectors and explicit opposing bounds.
//! No external program/model/provider is invoked by these controls.
use trillion_local::ecma_json::{self as ecma, Error, JsString, Limits, Object, Value};

fn encode(input: &str) -> String {
    ecma::stringify(&ecma::parse(input.as_bytes(), Limits::default()).unwrap(), Limits::default()).unwrap()
}

#[test]
fn nested_object_order_survives_and_duplicate_names_keep_first_slot_last_value() {
    let input = r#"{"z":{"b":1,"a":2,"b":{"q":3,"p":4}},"a":[{"z":0,"a":1}],"z":{"last":8,"first":9}}"#;
    assert_eq!(encode(input), r#"{"z":{"last":8,"first":9},"a":[{"z":0,"a":1}]}"#);
    assert_eq!(encode(r#"{"nested":{"b":1,"a":2,"b":3},"tail":4}"#), r#"{"nested":{"b":3,"a":2},"tail":4}"#);
}

#[test]
fn integer_keys_follow_js_own_property_order_recursively_including_boundary_cases() {
    let input = r#"{"z":0,"10":10,"2":2,"0":0,"01":1,"4294967295":5,"4294967294":4,"-0":6,"+1":7,"nested":{"3":3,"a":1,"1":1}}"#;
    assert_eq!(encode(input), r#"{"0":0,"2":2,"10":10,"4294967294":4,"z":0,"01":1,"4294967295":5,"-0":6,"+1":7,"nested":{"1":1,"3":3,"a":1}}"#);
    assert_eq!(encode(r#"{"\u0032":1,"2":2,"a":3}"#), r#"{"2":2,"a":3}"#);
}

#[test]
fn proto_and_constructor_names_are_plain_data_and_do_not_change_object_behavior() {
    assert_eq!(encode(r#"{"__proto__":{"polluted":true},"constructor":1,"prototype":2,"__proto__":3}"#),
        r#"{"__proto__":3,"constructor":1,"prototype":2}"#);
}

#[test]
fn utf16_strings_preserve_lone_surrogates_pairs_nul_and_exact_stringify_escaping() {
    let vectors = [
        (r#""\uD800""#, r#""\ud800""#),
        (r#""\uDC00""#, r#""\udc00""#),
        (r#""\uD83D\uDE00""#, "\"😀\""),
        (r#""\ud800\ud800\udc00""#, "\"\\ud800𐀀\""),
        (r#""\u0000\u0008\u0009\u000a\u000c\u000d\u001f\"\\\/""#,
            r#""\u0000\b\t\n\f\r\u001f\"\\/""#),
        (r#""\u2028\u2029""#, "\"\u{2028}\u{2029}\""),
    ];
    for (input, expected) in vectors { assert_eq!(encode(input), expected); }
    let value = ecma::parse(br#""\ud800""#, Limits::default()).unwrap();
    let Value::String(text) = value else { panic!("expected string"); };
    assert_eq!(text.units(), [0xd800]); assert!(text.to_rust_string().is_err());
    let text = JsString::from("😀"); assert_eq!(text.len(), 2);
}

#[test]
fn lone_surrogate_keys_are_retained_and_escaped_equivalent_duplicates_replace() {
    assert_eq!(encode(r#"{"\ud800":1,"x":2,"\uD800":3,"\udc00":4}"#), r#"{"\ud800":3,"x":2,"\udc00":4}"#);
    let parsed = ecma::parse(br#"{"\ud800":1}"#, Limits::default()).unwrap();
    let Value::Object(object) = parsed else { panic!("expected object"); };
    assert_eq!(object.get(&JsString::from_units(vec![0xd800])), Some(&Value::Number(1.0)));
}

#[test]
fn numbers_use_binary64_and_ecmascript_fixed_exponent_boundaries() {
    let vectors = [
        ("-0", "0"), ("-0.0", "0"), ("1.0", "1"), ("1e20", "100000000000000000000"),
        ("1e21", "1e+21"), ("1e-6", "0.000001"), ("1e-7", "1e-7"),
        ("9007199254740993", "9007199254740992"),
        ("1000000000000000100", "1000000000000000100"),
        ("1e400", "null"), ("-1e400", "null"), ("1e-400", "0"), ("-1e-400", "0"),
        ("5e-324", "5e-324"), ("1.7976931348623157e308", "1.7976931348623157e+308"),
    ];
    for (input, expected) in vectors { assert_eq!(encode(input), expected, "numeric fixture {input}"); }
    let Value::Number(zero) = ecma::parse(b"-0", Limits::default()).unwrap() else { panic!("expected number"); };
    assert!(zero.is_sign_negative(), "value model retains -0 even though stringify emits 0");
    assert_eq!(ecma::stringify(&Value::Number(f64::NAN), Limits::default()).unwrap(), "null");
}

#[test]
fn rejects_non_json_syntax_invalid_utf8_trailing_data_and_non_json_whitespace() {
    for input in ["", " ", "undefined", "NaN", "Infinity", "+1", "01", "-01", "1.", ".1", "1e", "1e+", "--1",
        "[1,]", "[,1]", "{\"a\":1,}", "{a:1}", "{'a':1}", "true false", "nullx", "[1 2]",
        "\u{feff}null", "\u{a0}null", "/*x*/null", "\"line\nbreak\"", "\"\\x00\"", "\"\\u12\"", "\"\\uGGGG\"", "\"unfinished"] {
        assert_eq!(ecma::parse(input.as_bytes(), Limits::default()).unwrap_err(), trillion_local::cause!(Error::InvalidJson), "syntax fixture {input:?}");
    }
    assert_eq!(ecma::parse(&[b'"', 0xff, b'"'], Limits::default()).unwrap_err(), trillion_local::cause!(Error::InvalidJson));
    assert_eq!(encode(" \t\n\r [true,false,null] \r\n"), "[true,false,null]");
}

#[test]
fn input_and_output_byte_bounds_are_inclusive_and_do_not_return_partial_output() {
    let mut limits = Limits::default(); limits.input_bytes = 4;
    assert_eq!(ecma::parse(b"null", limits).unwrap(), Value::Null);
    assert_eq!(ecma::parse(b"null ", limits).unwrap_err(), trillion_local::cause!(Error::InputBound));
    limits.output_bytes = 4; assert_eq!(ecma::stringify(&Value::Null, limits).unwrap(), "null");
    limits.output_bytes = 3; assert_eq!(ecma::stringify(&Value::Null, limits).unwrap_err(), trillion_local::cause!(Error::OutputBound));
    let value = Value::String(JsString::from_units(vec![0xd800]));
    limits.output_bytes = 8; assert_eq!(ecma::stringify(&value, limits).unwrap(), r#""\ud800""#);
    limits.output_bytes = 7; assert_eq!(ecma::stringify(&value, limits).unwrap_err(), trillion_local::cause!(Error::OutputBound));
}

#[test]
fn nesting_nodes_and_container_bounds_apply_to_parser_and_manually_built_values() {
    let mut limits = Limits::default(); limits.depth = 1;
    assert!(ecma::parse(b"[1]", limits).is_ok());
    assert_eq!(ecma::parse(b"[[]]", limits).unwrap_err(), trillion_local::cause!(Error::DepthBound));
    assert_eq!(ecma::stringify(&Value::Array(vec![Value::Array(vec![])]), limits).unwrap_err(), trillion_local::cause!(Error::DepthBound));
    limits.depth = 0; assert!(ecma::parse(b"0", limits).is_ok());
    assert_eq!(ecma::parse(b"{}", limits).unwrap_err(), trillion_local::cause!(Error::DepthBound));
    limits = Limits::default(); limits.nodes = 2;
    assert!(ecma::parse(b"[1]", limits).is_ok());
    assert_eq!(ecma::parse(b"[1,2]", limits).unwrap_err(), trillion_local::cause!(Error::NodeBound));
    assert_eq!(ecma::stringify(&Value::Array(vec![Value::Null,Value::Null]), limits).unwrap_err(), trillion_local::cause!(Error::NodeBound));
    limits = Limits::default(); limits.container_entries = 1;
    assert!(ecma::parse(br#"{"a":1}"#, limits).is_ok());
    assert_eq!(ecma::parse(br#"{"a":1,"a":2}"#, limits).unwrap_err(), trillion_local::cause!(Error::ContainerBound));
    let mut object = Object::new(); object.insert("a".into(), Value::Null); object.insert("b".into(), Value::Null);
    assert_eq!(ecma::stringify(&Value::Object(object), limits).unwrap_err(), trillion_local::cause!(Error::ContainerBound));
}

#[test]
fn string_bounds_count_utf16_units_and_all_source_occurrences_even_duplicates() {
    let mut limits = Limits::default(); limits.string_units = 2;
    assert!(ecma::parse("\"😀\"".as_bytes(), limits).is_ok());
    assert_eq!(ecma::parse("\"😀x\"".as_bytes(), limits).unwrap_err(), trillion_local::cause!(Error::StringBound));
    assert_eq!(ecma::stringify(&Value::String("😀x".into()), limits).unwrap_err(), trillion_local::cause!(Error::StringBound));
    limits = Limits::default(); limits.total_string_units = 4;
    assert!(ecma::parse(br#"{"a":"x","a":"y"}"#, limits).is_ok());
    limits.total_string_units = 3;
    assert_eq!(ecma::parse(br#"{"a":"x","a":"y"}"#, limits).unwrap_err(), trillion_local::cause!(Error::TotalStringBound));
    let mut object = Object::new(); object.insert("ab".into(), Value::String("cd".into()));
    assert_eq!(ecma::stringify(&Value::Object(object), limits).unwrap_err(), trillion_local::cause!(Error::TotalStringBound));
}

#[test]
fn numeric_lexical_and_hard_configuration_bounds_refuse_without_a_new_codec() {
    let mut limits = Limits::default(); limits.number_bytes = 3;
    assert!(ecma::parse(b"1e2", limits).is_ok());
    assert_eq!(ecma::parse(b"1e+2", limits).unwrap_err(), trillion_local::cause!(Error::NumberBound));
    limits = Limits::default(); limits.depth = ecma::HARD_DEPTH + 1;
    assert_eq!(ecma::parse(b"null", limits).unwrap_err(), trillion_local::cause!(Error::InvalidLimits));
    assert_eq!(ecma::stringify(&Value::Null, limits).unwrap_err(), trillion_local::cause!(Error::InvalidLimits));
    limits = Limits::default(); limits.nodes = 0;
    assert_eq!(ecma::parse(b"null", limits).unwrap_err(), trillion_local::cause!(Error::NodeBound));
    limits = Limits::default(); limits.string_units = 0; limits.total_string_units = 0;
    assert!(ecma::parse(br#""""#, limits).is_ok());
}

#[test]
fn stringify_parse_stringify_is_stable_for_json_origin_values_with_lossy_lexical_forms() {
    for input in [r#"{"z":1e20,"a":{"b":"\ud800","a":-0},"2":[1e400,5e-324]}"#,
        r#"{"escaped\u0000name":"quote\" slash\\ /","emoji":"\ud83d\ude00"}"#] {
        let first = encode(input); let second = encode(&first); assert_eq!(first, second);
    }
}

#[test]
fn debug_and_errors_do_not_echo_private_json_values() {
    let value = ecma::parse(br#"{"private-key-marker":"private-value-marker"}"#, Limits::default()).unwrap();
    assert!(!format!("{value:?}").contains("private"));
    let error = ecma::parse(br#"{"private-key-marker":"private-value-marker""#, Limits::default()).unwrap_err();
    assert!(!format!("{error:?} {error}").contains("private"));
}
