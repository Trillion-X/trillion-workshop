//! Bounded JSON.parse / JSON.stringify value model for original ECMAScript JSON.
//!
//! Purpose: retain nested property insertion order, UTF-16 code units (including
//! lone surrogates), and binary64 numbers before any lossy serde conversion.
//! Invariants: array-index object keys enumerate numerically; duplicate property
//! names replace the value in the first position; no replacer, reviver, prototype,
//! toJSON, BigInt, undefined, symbol or function behavior is invented here.
//! This owner performs no storage, hashing, authority, provider or tool-running work.
//! Existing content identities remain with content-crypto's BLAKE3 owner.

use std::{collections::HashMap, fmt};

pub const HARD_BYTES: usize = 32 * 1024 * 1024;
pub const HARD_DEPTH: usize = 256;
pub const HARD_NODES: usize = 1_000_000;
pub const HARD_NUMBER_BYTES: usize = 4096;

/// Inclusive bounds. Depth counts nested containers (a scalar has depth zero).
/// Nodes count every parsed value, including overwritten duplicate values;
/// string totals include every parsed key/string occurrence, also duplicates.
/// A container-entry bound counts source members, not just surviving names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub input_bytes: usize,
    pub output_bytes: usize,
    pub depth: usize,
    pub nodes: usize,
    pub string_units: usize,
    pub total_string_units: usize,
    pub container_entries: usize,
    pub number_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            input_bytes: 8 * 1024 * 1024,
            output_bytes: 8 * 1024 * 1024,
            depth: 128,
            nodes: 100_000,
            string_units: 1024 * 1024,
            total_string_units: 4 * 1024 * 1024,
            container_entries: 100_000,
            number_bytes: 128,
        }
    }
}
impl Limits {
    pub fn validate(&self) -> Result<(), Error> {
        if self.input_bytes > HARD_BYTES
            || self.output_bytes > HARD_BYTES
            || self.depth > HARD_DEPTH
            || self.nodes > HARD_NODES
            || self.string_units > HARD_BYTES
            || self.total_string_units > HARD_BYTES
            || self.container_entries > HARD_NODES
            || self.number_bytes > HARD_NUMBER_BYTES
        {
            return Err(crate::cause!(Error::InvalidLimits));
        }
        Ok(())
    }
}

/// Refusals never contain input text, property names, values or credentials.
#[derive(Debug, Clone)]
pub enum Error {
    InvalidLimits(crate::refusal_cause::Cause),
    InvalidJson(crate::refusal_cause::Cause),
    InputBound(crate::refusal_cause::Cause),
    OutputBound(crate::refusal_cause::Cause),
    DepthBound(crate::refusal_cause::Cause),
    NodeBound(crate::refusal_cause::Cause),
    StringBound(crate::refusal_cause::Cause),
    TotalStringBound(crate::refusal_cause::Cause),
    ContainerBound(crate::refusal_cause::Cause),
    NumberBound(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::InvalidLimits(cause) => cause,
            Self::InvalidJson(cause) => cause,
            Self::InputBound(cause) => cause,
            Self::OutputBound(cause) => cause,
            Self::DepthBound(cause) => cause,
            Self::NodeBound(cause) => cause,
            Self::StringBound(cause) => cause,
            Self::TotalStringBound(cause) => cause,
            Self::ContainerBound(cause) => cause,
            Self::NumberBound(cause) => cause,
        }
    }
}
crate::impl_caused!(Error);

// Equality keeps the domain classification; source identity is compared explicitly via cause().
impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) }
}
impl Eq for Error {}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidLimits(_) => "ECMAScript JSON limits are invalid",
            Self::InvalidJson(_) => "ECMAScript JSON input is invalid",
            Self::InputBound(_) => "ECMAScript JSON input exceeds its byte bound",
            Self::OutputBound(_) => "ECMAScript JSON output exceeds its byte bound",
            Self::DepthBound(_) => "ECMAScript JSON exceeds its nesting bound",
            Self::NodeBound(_) => "ECMAScript JSON exceeds its value count bound",
            Self::StringBound(_) => "ECMAScript JSON string exceeds its UTF-16 unit bound",
            Self::TotalStringBound(_) => "ECMAScript JSON exceeds its total string unit bound",
            Self::ContainerBound(_) => "ECMAScript JSON container exceeds its entry bound",
            Self::NumberBound(_) => "ECMAScript JSON number exceeds its lexical byte bound",
        })
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

/// ECMAScript strings are UTF-16 sequences, not necessarily Unicode scalar
/// strings. The explicit conversion to Rust text refuses lone surrogates.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct JsString(Vec<u16>);
impl JsString {
    pub fn from_units(units: Vec<u16>) -> Self {
        Self(units)
    }
    pub fn units(&self) -> &[u16] {
        &self.0
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn to_rust_string(&self) -> Result<String, Error> {
        String::from_utf16(&self.0).map_err(|error| crate::carry_cause!(Error::InvalidJson, error))
    }
}
impl From<&str> for JsString {
    fn from(value: &str) -> Self {
        Self(value.encode_utf16().collect())
    }
}
impl From<String> for JsString {
    fn from(value: String) -> Self {
        Self::from(value.as_str())
    }
}
impl fmt::Debug for JsString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JsString([redacted])")
    }
}

/// Object entries retain insertion order; their index never supplies output order.
#[derive(Clone, PartialEq, Default)]
pub struct Object {
    entries: Vec<(JsString, Value)>,
    index: HashMap<JsString, usize>,
}
impl Object {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub fn get(&self, key: &JsString) -> Option<&Value> {
        self.index.get(key).map(|at| &self.entries[*at].1)
    }
    pub fn insert(&mut self, key: JsString, value: Value) -> Option<Value> {
        if let Some(at) = self.index.get(&key) {
            return Some(std::mem::replace(&mut self.entries[*at].1, value));
        }
        self.index.insert(key.clone(), self.entries.len());
        self.entries.push((key, value));
        None
    }
    pub fn insertion_entries(&self) -> impl Iterator<Item = (&JsString, &Value)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }
    /// Ordinary own-property order: array indices [0, 2^32-2], ascending, then
    /// remaining string names in their original positions. `4294967295` is not one.
    pub fn property_entries(&self) -> Vec<(&JsString, &Value)> {
        let mut entries: Vec<_> = self.insertion_entries().collect();
        entries.sort_by(|(a, _), (b, _)| match (array_index(a), array_index(b)) {
            (Some(a), Some(b)) => a.cmp(&b),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        });
        entries
    }
}
impl fmt::Debug for Object {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Object([redacted])")
    }
}
fn array_index(key: &JsString) -> Option<u32> {
    let units = key.units();
    if units.is_empty() || units.len() > 10 || (units.len() > 1 && units[0] == b'0' as u16) {
        return None;
    }
    let mut value = 0_u32;
    for unit in units {
        if !(b'0' as u16..=b'9' as u16).contains(unit) {
            return None;
        }
        value = value
            .checked_mul(10)?
            .checked_add(u32::from(*unit - b'0' as u16))?;
    }
    (value != u32::MAX).then_some(value)
}

/// JSON-origin values only. Number contains the binary64 value produced by
/// JSON.parse; infinity from lexical overflow stringifies to null, as in JS.
#[derive(Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Array(Vec<Value>),
    Object(Object),
}
impl fmt::Debug for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("EcmaJsonValue([redacted])")
    }
}

struct Budget {
    limits: Limits,
    nodes: usize,
    strings: usize,
}
impl Budget {
    fn node(&mut self) -> Result<(), Error> {
        self.nodes = self.nodes.checked_add(1).ok_or(crate::cause!(Error::NodeBound))?;
        if self.nodes > self.limits.nodes {
            return Err(crate::cause!(Error::NodeBound));
        }
        Ok(())
    }
    fn string(&mut self, units: usize) -> Result<(), Error> {
        if units > self.limits.string_units {
            return Err(crate::cause!(Error::StringBound));
        }
        self.strings = self
            .strings
            .checked_add(units)
            .ok_or(crate::cause!(Error::TotalStringBound))?;
        if self.strings > self.limits.total_string_units {
            return Err(crate::cause!(Error::TotalStringBound));
        }
        Ok(())
    }
    fn container(&self, depth: usize, count: usize) -> Result<(), Error> {
        if depth > self.limits.depth {
            return Err(crate::cause!(Error::DepthBound));
        }
        if count > self.limits.container_entries {
            return Err(crate::cause!(Error::ContainerBound));
        }
        Ok(())
    }
}

/// Parse valid UTF-8 JSON bytes, retaining every information item needed for
/// JSON.stringify of the resulting ordinary JS value. No serde Value bridge.
pub fn parse(input: &[u8], limits: Limits) -> Result<Value, Error> {
    limits.validate()?;
    if input.len() > limits.input_bytes {
        return Err(crate::cause!(Error::InputBound));
    }
    let text = std::str::from_utf8(input).map_err(|error| crate::carry_cause!(Error::InvalidJson, error))?;
    let mut parser = Parser {
        input: text,
        at: 0,
        budget: Budget {
            limits,
            nodes: 0,
            strings: 0,
        },
    };
    let value = parser.value(0)?;
    parser.space();
    if parser.at != input.len() {
        return Err(crate::cause!(Error::InvalidJson));
    }
    Ok(value)
}
struct Parser<'a> {
    input: &'a str,
    at: usize,
    budget: Budget,
}
impl Parser<'_> {
    fn byte(&self) -> Option<u8> {
        self.input.as_bytes().get(self.at).copied()
    }
    fn space(&mut self) {
        while matches!(self.byte(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.at += 1;
        }
    }
    fn take(&mut self, byte: u8) -> bool {
        if self.byte() == Some(byte) {
            self.at += 1;
            true
        } else {
            false
        }
    }
    fn value(&mut self, depth: usize) -> Result<Value, Error> {
        self.space();
        self.budget.node()?;
        match self.byte() {
            Some(b'n') => {
                self.literal("null")?;
                Ok(Value::Null)
            }
            Some(b't') => {
                self.literal("true")?;
                Ok(Value::Bool(true))
            }
            Some(b'f') => {
                self.literal("false")?;
                Ok(Value::Bool(false))
            }
            Some(b'"') => Ok(Value::String(self.string()?)),
            Some(b'[') => self.array(depth + 1),
            Some(b'{') => self.object(depth + 1),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(crate::cause!(Error::InvalidJson)),
        }
    }
    fn literal(&mut self, text: &str) -> Result<(), Error> {
        if self.input[self.at..].starts_with(text) {
            self.at += text.len();
            Ok(())
        } else {
            Err(crate::cause!(Error::InvalidJson))
        }
    }
    fn array(&mut self, depth: usize) -> Result<Value, Error> {
        self.budget.container(depth, 0)?;
        self.at += 1;
        self.space();
        let mut array = Vec::new();
        if self.take(b']') {
            return Ok(Value::Array(array));
        }
        loop {
            self.budget.container(depth, array.len() + 1)?;
            array.push(self.value(depth)?);
            self.space();
            if self.take(b']') {
                break;
            }
            if !self.take(b',') {
                return Err(crate::cause!(Error::InvalidJson));
            }
        }
        Ok(Value::Array(array))
    }
    fn object(&mut self, depth: usize) -> Result<Value, Error> {
        self.budget.container(depth, 0)?;
        self.at += 1;
        self.space();
        let mut object = Object::new();
        if self.take(b'}') {
            return Ok(Value::Object(object));
        }
        let mut members = 0_usize;
        loop {
            members += 1;
            self.budget.container(depth, members)?;
            self.space();
            let key = self.string()?;
            self.space();
            if !self.take(b':') {
                return Err(crate::cause!(Error::InvalidJson));
            }
            object.insert(key, self.value(depth)?);
            self.space();
            if self.take(b'}') {
                break;
            }
            if !self.take(b',') {
                return Err(crate::cause!(Error::InvalidJson));
            }
        }
        Ok(Value::Object(object))
    }
    fn string(&mut self) -> Result<JsString, Error> {
        if !self.take(b'"') {
            return Err(crate::cause!(Error::InvalidJson));
        }
        let mut units = Vec::new();
        loop {
            let byte = self.byte().ok_or(crate::cause!(Error::InvalidJson))?;
            if byte == b'"' {
                self.at += 1;
                self.budget.string(units.len())?;
                return Ok(JsString(units));
            }
            if byte < 0x20 {
                return Err(crate::cause!(Error::InvalidJson));
            }
            let mut next = [0_u16; 2];
            let count;
            if byte == b'\\' {
                self.at += 1;
                next[0] = match self.byte().ok_or(crate::cause!(Error::InvalidJson))? {
                    b'"' => {
                        self.at += 1;
                        b'"' as u16
                    }
                    b'\\' => {
                        self.at += 1;
                        b'\\' as u16
                    }
                    b'/' => {
                        self.at += 1;
                        b'/' as u16
                    }
                    b'b' => {
                        self.at += 1;
                        8
                    }
                    b'f' => {
                        self.at += 1;
                        12
                    }
                    b'n' => {
                        self.at += 1;
                        10
                    }
                    b'r' => {
                        self.at += 1;
                        13
                    }
                    b't' => {
                        self.at += 1;
                        9
                    }
                    b'u' => {
                        self.at += 1;
                        self.hex_unit()?
                    }
                    _ => return Err(crate::cause!(Error::InvalidJson)),
                };
                count = 1;
            } else {
                let character = self.input[self.at..]
                    .chars()
                    .next()
                    .ok_or(crate::cause!(Error::InvalidJson))?;
                self.at += character.len_utf8();
                count = character.encode_utf16(&mut next).len();
            }
            let length = units.len().checked_add(count).ok_or(crate::cause!(Error::StringBound))?;
            if length > self.budget.limits.string_units {
                return Err(crate::cause!(Error::StringBound));
            }
            if self
                .budget
                .strings
                .checked_add(length)
                .ok_or(crate::cause!(Error::TotalStringBound))?
                > self.budget.limits.total_string_units
            {
                return Err(crate::cause!(Error::TotalStringBound));
            }
            units.extend_from_slice(&next[..count]);
        }
    }
    fn hex_unit(&mut self) -> Result<u16, Error> {
        let mut value = 0_u16;
        for _ in 0..4 {
            let digit = match self.byte().ok_or(crate::cause!(Error::InvalidJson))? {
                b'0'..=b'9' => self.byte().unwrap() - b'0',
                b'a'..=b'f' => self.byte().unwrap() - b'a' + 10,
                b'A'..=b'F' => self.byte().unwrap() - b'A' + 10,
                _ => return Err(crate::cause!(Error::InvalidJson)),
            };
            self.at += 1;
            value = value * 16 + u16::from(digit);
        }
        Ok(value)
    }
    fn number(&mut self) -> Result<Value, Error> {
        let start = self.at;
        self.take(b'-');
        if !self.take(b'0') {
            if !matches!(self.byte(), Some(b'1'..=b'9')) {
                return Err(crate::cause!(Error::InvalidJson));
            }
            self.digits();
        }
        if self.take(b'.') {
            let before = self.at;
            self.digits();
            if self.at == before {
                return Err(crate::cause!(Error::InvalidJson));
            }
        }
        if matches!(self.byte(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.byte(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            let before = self.at;
            self.digits();
            if self.at == before {
                return Err(crate::cause!(Error::InvalidJson));
            }
        }
        if self.at - start > self.budget.limits.number_bytes {
            return Err(crate::cause!(Error::NumberBound));
        }
        let number = self.input[start..self.at]
            .parse::<f64>()
            .map_err(|error| crate::carry_cause!(Error::InvalidJson, error))?;
        Ok(Value::Number(number))
    }
    fn digits(&mut self) {
        while matches!(self.byte(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
    }
}

/// JSON.stringify with no spacing/replacer on this ordinary JSON-origin value.
/// All output is private until success; a bound refusal returns no partial text.
pub fn stringify(value: &Value, limits: Limits) -> Result<String, Error> {
    limits.validate()?;
    let mut encoder = Encoder {
        text: String::new(),
        budget: Budget {
            limits,
            nodes: 0,
            strings: 0,
        },
    };
    encoder.value(value, 0)?;
    Ok(encoder.text)
}
struct Encoder {
    text: String,
    budget: Budget,
}
impl Encoder {
    fn push(&mut self, text: &str) -> Result<(), Error> {
        if self
            .text
            .len()
            .checked_add(text.len())
            .ok_or(crate::cause!(Error::OutputBound))?
            > self.budget.limits.output_bytes
        {
            return Err(crate::cause!(Error::OutputBound));
        }
        self.text.push_str(text);
        Ok(())
    }
    fn value(&mut self, value: &Value, depth: usize) -> Result<(), Error> {
        self.budget.node()?;
        match value {
            Value::Null => self.push("null"),
            Value::Bool(value) => self.push(if *value { "true" } else { "false" }),
            Value::Number(value) => {
                if value.is_finite() {
                    let mut buffer = ryu_js::Buffer::new();
                    self.push(buffer.format_finite(*value))
                } else {
                    self.push("null")
                }
            }
            Value::String(value) => self.string(value),
            Value::Array(values) => {
                self.budget.container(depth + 1, values.len())?;
                self.push("[")?;
                for (at, value) in values.iter().enumerate() {
                    if at != 0 {
                        self.push(",")?;
                    }
                    self.value(value, depth + 1)?;
                }
                self.push("]")
            }
            Value::Object(object) => {
                self.budget.container(depth + 1, object.len())?;
                self.push("{")?;
                for (at, (key, value)) in object.property_entries().into_iter().enumerate() {
                    if at != 0 {
                        self.push(",")?;
                    }
                    self.string(key)?;
                    self.push(":")?;
                    self.value(value, depth + 1)?;
                }
                self.push("}")
            }
        }
    }
    fn string(&mut self, value: &JsString) -> Result<(), Error> {
        self.budget.string(value.len())?;
        self.push("\"")?;
        let units = value.units();
        let mut at = 0;
        while at < units.len() {
            let unit = units[at];
            at += 1;
            match unit {
                0x22 => self.push("\\\"")?,
                0x5c => self.push("\\\\")?,
                8 => self.push("\\b")?,
                9 => self.push("\\t")?,
                10 => self.push("\\n")?,
                12 => self.push("\\f")?,
                13 => self.push("\\r")?,
                0..=0x1f => self.escape_unit(unit)?,
                0xd800..=0xdbff if at < units.len() && (0xdc00..=0xdfff).contains(&units[at]) => {
                    let scalar = 0x10000
                        + ((u32::from(unit) - 0xd800) << 10)
                        + (u32::from(units[at]) - 0xdc00);
                    at += 1;
                    let character = char::from_u32(scalar).ok_or(crate::cause!(Error::InvalidJson))?;
                    self.push(character.encode_utf8(&mut [0_u8; 4]))?;
                }
                0xd800..=0xdfff => self.escape_unit(unit)?,
                _ => {
                    let character = char::from_u32(u32::from(unit)).ok_or(crate::cause!(Error::InvalidJson))?;
                    self.push(character.encode_utf8(&mut [0_u8; 4]))?;
                }
            }
        }
        self.push("\"")
    }
    fn escape_unit(&mut self, unit: u16) -> Result<(), Error> {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let bytes = [
            b'\\',
            b'u',
            HEX[(unit >> 12) as usize],
            HEX[((unit >> 8) & 15) as usize],
            HEX[((unit >> 4) & 15) as usize],
            HEX[(unit & 15) as usize],
        ];
        self.push(std::str::from_utf8(&bytes).map_err(|error| crate::carry_cause!(Error::InvalidJson, error))?)
    }
}

#[cfg(test)]
mod refusal_cause_tests {
    use super::*;

    #[test]
    fn different_invalid_json_conditions_keep_exact_private_value_free_causes() {
        let utf8 = parse(&[0xff], Default::default()).unwrap_err();
        let trailing = parse(b"null private-field-value", Default::default()).unwrap_err();
        let syntax = parse(b"?private-field-value", Default::default()).unwrap_err();
        let utf16 = JsString::from_units(vec![0xd800]).to_rust_string().unwrap_err();
        assert!(matches!(utf8, Error::InvalidJson(_)));
        assert!(matches!(trailing, Error::InvalidJson(_)));
        assert!(matches!(syntax, Error::InvalidJson(_)));
        assert_ne!(utf8.cause(), trailing.cause());
        assert_ne!(trailing.cause(), syntax.cause());
        assert_ne!(utf8.cause(), syntax.cause());
        assert_ne!(utf16.cause(), utf8.cause());
        assert_ne!(utf16.cause(), syntax.cause());
        assert_eq!(utf8.cause(), parse(&[0xff], Default::default()).unwrap_err().cause());
        let source = include_str!("ecma_json.rs");
        let line = |text: &str| (source.lines().position(|line| line.contains(text)).unwrap() + 1) as u32;
        assert_eq!(utf8.cause().line(), line("let text = std::str::from_utf8(input).map_err"));
        assert_eq!(trailing.cause().line(), line("return Err(crate::cause!(Error::InvalidJson));"));
        assert_eq!(syntax.cause().line(), line("_ => Err(crate::cause!(Error::InvalidJson)),"));
        assert_eq!(utf16.cause().line(), line("String::from_utf16(&self.0).map_err"));
        for error in [utf8, trailing, syntax, utf16] {
            assert_eq!(error.cause().file(), "src/ecma_json.rs");
            assert_eq!(error.cause().condition(), "Error::InvalidJson");
            assert!(!error.cause().id().contains("private-field-value"));
            assert!(!format!("{error:?}").contains("private-field-value"));
        }
    }
}
