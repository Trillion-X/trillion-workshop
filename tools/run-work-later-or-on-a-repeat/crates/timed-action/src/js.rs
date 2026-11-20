//! crates/timed-action/src/js.rs
//!
//! Purpose
//!   The JavaScript value rules the timed-action rules were written under, kept in one place: how a number reads as
//!   text, what counts as text, a whole number or a true value, how a value coerces to a number or a string, how two
//!   values are the same map key, how a value is written as JSON, and how a refusal is worded and typed. Every module
//!   reads values through these, so a rule holds here the way it holds in the TypeScript.
//!
//! Non-negotiable invariants
//!   - A missing key is `undefined` (get_opt returns None); `get` gives the null it reads as where a missing key and a
//!     null both mean "not set" (`??`, `||`, falsy checks).
//!   - Numbers are f64, as JavaScript keeps them. An integer prints as the integer, any other number prints by the
//!     ECMAScript Number::toString rule (number_text), so text built from a number matches the TypeScript.
//!   - A refusal carries the TypeScript's words and its error kind (Error, TypeError, RangeError).

use serde_json::{Map, Value};

/// The value a missing or null key reads as where JavaScript reads `undefined` and `null` alike.
pub static NULL: Value = Value::Null;

/// The error kind a refusal is thrown as in the TypeScript.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Error,
    TypeError,
    RangeError,
}

/// A refusal: the message the TypeScript throws and the kind of error it throws.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    pub kind: Kind,
    pub message: String,
}

pub type Res<T> = Result<T, Refused>;

impl Refused {
    pub fn error(message: impl Into<String>) -> Self {
        Self { kind: Kind::Error, message: message.into() }
    }
    pub fn type_error(message: impl Into<String>) -> Self {
        Self { kind: Kind::TypeError, message: message.into() }
    }
    pub fn range_error(message: impl Into<String>) -> Self {
        Self { kind: Kind::RangeError, message: message.into() }
    }
}

/// `value[key]`: the value, or null when the key is missing or the value is not an object.
pub fn get<'a>(value: &'a Value, key: &str) -> &'a Value {
    get_opt(value, key).unwrap_or(&NULL)
}

/// `value[key]` as JavaScript sees it: None (undefined) when the key is missing or the value is not an object.
pub fn get_opt<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|object| object.get(key))
}

/// The elements of a list, or nothing when the value is not an array (`Array.isArray(x) ? x : []`).
pub fn list(value: &Value) -> &[Value] {
    match value.as_array() {
        Some(items) => items,
        None => &[],
    }
}

/// JavaScript truthiness: null, false, 0, NaN and the empty string are false; everything else is true.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => {
            let x = number.as_f64().unwrap_or(f64::NAN);
            x != 0.0 && !x.is_nan()
        }
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `typeof x === 'string' && x.length > 0 ? x : null`.
pub fn text(value: &Value) -> Option<&str> {
    match value.as_str() {
        Some(text) if !text.is_empty() => Some(text),
        _ => None,
    }
}

/// The text a value names an identity by: a non-empty string, or a finite number as its text; otherwise none.
pub fn identity_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => number.as_f64().filter(|x| x.is_finite()).map(number_text),
        _ => None,
    }
}

/// `Number.isInteger(x)` for a value: its number when it is a whole finite number.
pub fn as_integer(value: &Value) -> Option<f64> {
    value.as_f64().filter(|x| x.is_finite() && x.fract() == 0.0)
}

/// `String(x)` for a value that is not undefined.
pub fn to_str(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_text(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { to_str(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `String(x)` for an optional value: the text "undefined" when the value is missing.
pub fn to_str_opt(value: Option<&Value>) -> String {
    match value {
        Some(value) => to_str(value),
        None => "undefined".to_string(),
    }
}

/// `Number(x)` (ToNumber) for a value.
pub fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => string_number(text),
        Value::Array(_) | Value::Object(_) => string_number(&to_str(value)),
    }
}

/// `Number(x)` for an optional value: NaN when the value is missing.
pub fn to_number_opt(value: Option<&Value>) -> f64 {
    value.map_or(f64::NAN, to_number)
}

/// The number a string reads as (StringToNumber): blank is 0, a decimal number or an infinity, otherwise NaN.
fn string_number(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if trimmed.bytes().all(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b'e' | b'E' | b'+' | b'-')) {
        trimmed.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// A number as a JSON value: an integer stays an integer; NaN and the infinities are null, as JSON.stringify writes them.
pub fn num(x: f64) -> Value {
    if !x.is_finite() {
        return Value::Null;
    }
    if x.fract() == 0.0 && x.abs() < 9.0e15 {
        Value::from(x as i64)
    } else {
        Value::from(x)
    }
}

/// `Math.round(x)`: halves round toward positive infinity.
pub fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `Math.min(a, b)`: NaN when either is NaN (f64::min would ignore it).
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a <= b {
        a
    } else {
        b
    }
}

/// The number text of ECMAScript Number::toString (String(x) for a number).
pub fn number_text(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x == 0.0 {
        return "0".to_string();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    // Rust's exponent form carries the shortest digits that read back to the same number, which is what the
    // ECMAScript algorithm asks for.
    let exponent_form = format!("{:e}", x.abs());
    let (mantissa, exponent) = exponent_form.split_once('e').unwrap_or((exponent_form.as_str(), "0"));
    let exponent: i64 = exponent.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i64;
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{}{}", digits, "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{}", "0".repeat((-n) as usize), digits)
    } else {
        let e = n - 1;
        let exponent_text = if e >= 0 { format!("+{e}") } else { format!("{e}") };
        if k == 1 {
            format!("{digits}e{exponent_text}")
        } else {
            format!("{}.{}e{}", &digits[..1], &digits[1..], exponent_text)
        }
    };
    format!("{sign}{body}")
}

/// JSON.stringify of a value this crate built: keys in their order, numbers as ECMAScript writes them, and a
/// non-finite number as null.
pub fn json_text(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => {
            let x = number.as_f64().unwrap_or(f64::NAN);
            if x.is_finite() {
                number_text(x)
            } else {
                "null".to_string()
            }
        }
        Value::String(text) => serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(items) => format!("[{}]", items.iter().map(json_text).collect::<Vec<_>>().join(",")),
        Value::Object(object) => format!(
            "{{{}}}",
            object
                .iter()
                .map(|(key, item)| format!("{}:{}", serde_json::to_string(key).unwrap_or_default(), json_text(item)))
                .collect::<Vec<_>>()
                .join(",")
        ),
    }
}

/// `encodeURIComponent(text)`: unreserved characters stay, every other UTF-8 byte is %XX in upper-case hex.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The identity of a value as a Map key (SameValueZero). Objects and arrays are never the same key as another value
/// (None), because a JavaScript Map compares them by reference and parsed input never shares a reference.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Key {
    Missing,
    Null,
    Bool(bool),
    Number(u64),
    Text(String),
}

pub fn key_of(value: Option<&Value>) -> Option<Key> {
    match value {
        None => Some(Key::Missing),
        Some(Value::Null) => Some(Key::Null),
        Some(Value::Bool(flag)) => Some(Key::Bool(*flag)),
        Some(Value::Number(number)) => {
            let x = number.as_f64().unwrap_or(f64::NAN);
            let x = if x == 0.0 { 0.0 } else { x };
            Some(Key::Number(x.to_bits()))
        }
        Some(Value::String(text)) => Some(Key::Text(text.clone())),
        Some(Value::Array(_) | Value::Object(_)) => None,
    }
}

/// An object written from (key, value) pairs in order; a key given again keeps its first place, as an object does.
pub fn object(pairs: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in pairs {
        map.insert(key.to_string(), value);
    }
    Value::Object(map)
}
