//! Pure deterministic JSON-byte canonicalization.
//!
//! This leaf owns the byte encoding shared by signed entitlement material and
//! proof-controller records. Its implementation intentionally preserves the
//! existing byte contract while removing any dependency on either consumer.

#![forbid(unsafe_code)]

use serde_json::Value;

/// Canonicalize a JSON value using the repository's established byte contract.
pub fn canonicalize(value: &Value) -> String {
    canonicalize_value(value)
}

/// Canonicalize a JSON value to bytes using the same contract as [`canonicalize`].
pub fn canonicalize_bytes(value: &Value) -> Vec<u8> {
    canonicalize(value).into_bytes()
}

fn canonicalize_value(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => canonicalize_string(value),
        Value::Array(values) => {
            let values = values
                .iter()
                .map(canonicalize_value)
                .collect::<Vec<_>>()
                .join(",");
            format!("[{values}]")
        }
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            let values = keys
                .into_iter()
                .map(|key| {
                    let value = values
                        .get(key)
                        .expect("object keys come from the same object");
                    format!("{}:{}", canonicalize_string(key), canonicalize_value(value))
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{values}}}")
        }
    }
}

fn canonicalize_string(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{0008}' => output.push_str("\\b"),
            '\u{000c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            control if control.is_control() => {
                use std::fmt::Write as _;
                write!(output, "\\u{:04x}", control as u32)
                    .expect("writing to a String cannot fail");
            }
            character => output.push(character),
        }
    }
    output.push('"');
    output
}

#[cfg(test)]
mod tests {
    use super::{canonicalize, canonicalize_bytes};
    use serde_json::{json, Value};

    #[test]
    fn sorts_every_object_and_preserves_array_order() {
        let value: Value = serde_json::from_str(r#"{"z":[3,1,2],"a":{"z":1,"a":2}}"#)
            .expect("fixture is valid JSON");
        assert_eq!(canonicalize(&value), r#"{"a":{"a":2,"z":1},"z":[3,1,2]}"#);
    }

    #[test]
    fn emits_the_established_minimal_escape_contract() {
        let value =
            json!({"value": "quote\" slash\\ backspace\u{0008} form\u{000c}\n\r\t\u{001f}"});
        assert_eq!(
            canonicalize(&value),
            "{\"value\":\"quote\\\" slash\\\\ backspace\\b form\\f\\n\\r\\t\\u001f\"}"
        );
    }

    #[test]
    fn string_and_byte_apis_are_identical() {
        let value = json!({"null": null, "bool": true, "number": -3.125});
        assert_eq!(
            canonicalize(&value).into_bytes(),
            canonicalize_bytes(&value)
        );
    }
}
