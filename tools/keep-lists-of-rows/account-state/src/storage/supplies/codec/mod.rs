// src/storage/supplies/codec/mod.rs
//
// Purpose: Turn one `Value` of the storage contract into bytes a database that knows nothing of SQLite's dynamic
// typing can compare, and back. Every supply that stores bytes (SQL columns, key-value keys) uses these two forms, so
// the contract's value order is kept by byte order alone.
//
// Non-Negotiable Invariants:
// - `ordered` keeps the contract's value order under plain byte comparison: NULL, then numbers (by value), then text
//   (by bytes), then blobs (by bytes). It is self-delimiting, so a tuple of values is the concatenation of its parts,
//   and a prefix of a tuple is a prefix of its bytes.
// - `plain` is for values never compared by order (row bodies): tag, then length and bytes. It round-trips every value
//   exactly, including an integer above 2^53 and a real's exact bits.
// - A value read back equals the value written. `Oversized` is a read result and is never encoded.
//
// Key Concepts:
// - Tags: 0 NULL, 1 number, 2 text, 3 blob (ordered). A number is a sortable f64 of its value, a kind byte (integer
//   before real when equal) and an exact payload, so two integers that share an f64 still order exactly.
//
// Security Considerations:
// - Pure functions over bytes; no I/O. A malformed input is `Error::Invalid`, never a panic.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use local_engine::storage::{Error, Result, Value};

const NULL: u8 = 0;
const NUMBER: u8 = 1;
const TEXT: u8 = 2;
const BLOB: u8 = 3;
const INTEGER_KIND: u8 = 0;
const REAL_KIND: u8 = 1;

/// A real as eight bytes whose unsigned byte order is the real's numeric order.
fn sortable_real(number: f64) -> [u8; 8] {
    let bits = number.to_bits();
    (if bits >> 63 == 1 { !bits } else { bits ^ (1 << 63) }).to_be_bytes()
}
fn escaped(tag: u8, bytes: &[u8], out: &mut Vec<u8>) {
    out.push(tag);
    for byte in bytes {
        out.push(*byte);
        if *byte == 0 {
            out.push(0xFF);
        }
    }
    out.extend_from_slice(&[0, 0]);
}

/// Append the ordered form of one value.
pub fn ordered(value: &Value, out: &mut Vec<u8>) -> Result<()> {
    match value {
        Value::Null => out.push(NULL),
        Value::Integer(number) => {
            out.push(NUMBER);
            out.extend_from_slice(&sortable_real(*number as f64));
            out.push(INTEGER_KIND);
            out.extend_from_slice(&((*number as u64) ^ (1 << 63)).to_be_bytes());
        }
        // SQLite stores a NaN as NULL; so does this form.
        Value::Real(number) if number.is_nan() => out.push(NULL),
        Value::Real(number) => {
            out.push(NUMBER);
            out.extend_from_slice(&sortable_real(*number));
            out.push(REAL_KIND);
            out.extend_from_slice(&number.to_bits().to_be_bytes());
        }
        Value::Text(text) => escaped(TEXT, text.as_bytes(), out),
        Value::Blob(blob) => escaped(BLOB, blob, out),
        Value::Oversized(_) => return Err(local_engine::cause!(Error::Invalid)),
    }
    Ok(())
}

/// The ordered form of a tuple of values.
pub fn ordered_tuple<'a>(values: impl IntoIterator<Item = &'a Value>) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    for value in values {
        ordered(value, &mut out)?;
    }
    Ok(out)
}

/// The ordered form of one value.
pub fn ordered_one(value: &Value) -> Result<Vec<u8>> {
    ordered_tuple(std::iter::once(value))
}

/// How many bytes the first ordered value of `input` takes.
pub fn ordered_len(input: &[u8]) -> Result<usize> {
    match input.first() {
        Some(&NULL) => Ok(1),
        Some(&NUMBER) if input.len() >= 18 => Ok(18),
        Some(&TEXT) | Some(&BLOB) => {
            let mut at = 1;
            while at < input.len() {
                if input[at] == 0 {
                    match input.get(at + 1) {
                        Some(0) => return Ok(at + 2),
                        Some(0xFF) => at += 2,
                        _ => return Err(local_engine::cause!(Error::Invalid)),
                    }
                } else {
                    at += 1;
                }
            }
            Err(local_engine::cause!(Error::Invalid))
        }
        _ => Err(local_engine::cause!(Error::Invalid)),
    }
}

/// Read the first ordered value of `input` and how many bytes it took.
pub fn read_ordered(input: &[u8]) -> Result<(Value, usize)> {
    let length = ordered_len(input)?;
    let value = match input[0] {
        NULL => Value::Null,
        NUMBER => {
            let payload: [u8; 8] = input[10..18].try_into().map_err(|error| local_engine::carry_cause!(Error::Invalid, error))?;
            match input[9] {
                INTEGER_KIND => Value::Integer((u64::from_be_bytes(payload) ^ (1 << 63)) as i64),
                REAL_KIND => Value::Real(f64::from_bits(u64::from_be_bytes(payload))),
                _ => return Err(local_engine::cause!(Error::Invalid)),
            }
        }
        tag => {
            let body = &input[1..length - 2];
            let mut bytes = Vec::with_capacity(body.len());
            let mut at = 0;
            while at < body.len() {
                bytes.push(body[at]);
                at += if body[at] == 0 { 2 } else { 1 };
            }
            if tag == TEXT {
                Value::Text(String::from_utf8(bytes).map_err(|error| local_engine::carry_cause!(Error::Invalid, error))?)
            } else {
                Value::Blob(bytes)
            }
        }
    };
    Ok((value, length))
}

/// Read `count` ordered values from the front of `input`; returns them and the bytes used.
pub fn read_ordered_tuple(input: &[u8], count: usize) -> Result<(Vec<Value>, usize)> {
    let mut values = Vec::with_capacity(count);
    let mut at = 0;
    for _ in 0..count {
        let (value, used) = read_ordered(&input[at..])?;
        values.push(value);
        at += used;
    }
    Ok((values, at))
}

const PLAIN_NULL: u8 = 0;
const PLAIN_INTEGER: u8 = 1;
const PLAIN_REAL: u8 = 2;
const PLAIN_TEXT: u8 = 3;
const PLAIN_BLOB: u8 = 4;

/// Append the plain form of one value.
pub fn plain(value: &Value, out: &mut Vec<u8>) -> Result<()> {
    match value {
        Value::Null => out.push(PLAIN_NULL),
        Value::Integer(number) => {
            out.push(PLAIN_INTEGER);
            out.extend_from_slice(&number.to_be_bytes());
        }
        Value::Real(number) if number.is_nan() => out.push(PLAIN_NULL),
        Value::Real(number) => {
            out.push(PLAIN_REAL);
            out.extend_from_slice(&number.to_bits().to_be_bytes());
        }
        Value::Text(text) => {
            out.push(PLAIN_TEXT);
            out.extend_from_slice(&u32::try_from(text.len()).map_err(|error| local_engine::carry_cause!(Error::TooBig, error))?.to_be_bytes());
            out.extend_from_slice(text.as_bytes());
        }
        Value::Blob(blob) => {
            out.push(PLAIN_BLOB);
            out.extend_from_slice(&u32::try_from(blob.len()).map_err(|error| local_engine::carry_cause!(Error::TooBig, error))?.to_be_bytes());
            out.extend_from_slice(blob);
        }
        Value::Oversized(_) => return Err(local_engine::cause!(Error::Invalid)),
    }
    Ok(())
}

pub fn plain_one(value: &Value) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    plain(value, &mut out)?;
    Ok(out)
}

/// Read the first plain value of `input` and how many bytes it took.
pub fn read_plain(input: &[u8]) -> Result<(Value, usize)> {
    let eight = |from: usize| -> Result<[u8; 8]> {
        input.get(from..from + 8).and_then(|bytes| bytes.try_into().ok()).ok_or(local_engine::cause!(Error::Invalid))
    };
    let sized = |from: usize| -> Result<&[u8]> {
        let length = input.get(from..from + 4).and_then(|bytes| bytes.try_into().ok()).map(u32::from_be_bytes).ok_or(local_engine::cause!(Error::Invalid))? as usize;
        input.get(from + 4..from + 4 + length).ok_or(local_engine::cause!(Error::Invalid))
    };
    match input.first() {
        Some(&PLAIN_NULL) => Ok((Value::Null, 1)),
        Some(&PLAIN_INTEGER) => Ok((Value::Integer(i64::from_be_bytes(eight(1)?)), 9)),
        Some(&PLAIN_REAL) => Ok((Value::Real(f64::from_bits(u64::from_be_bytes(eight(1)?))), 9)),
        Some(&PLAIN_TEXT) => {
            let bytes = sized(1)?;
            Ok((Value::Text(String::from_utf8(bytes.to_vec()).map_err(|error| local_engine::carry_cause!(Error::Invalid, error))?), 5 + bytes.len()))
        }
        Some(&PLAIN_BLOB) => {
            let bytes = sized(1)?;
            Ok((Value::Blob(bytes.to_vec()), 5 + bytes.len()))
        }
        _ => Err(local_engine::cause!(Error::Invalid)),
    }
}

/// Read a whole plain value (nothing may follow it).
pub fn read_plain_whole(input: &[u8]) -> Result<Value> {
    let (value, used) = read_plain(input)?;
    if used == input.len() {
        Ok(value)
    } else {
        Err(local_engine::cause!(Error::Invalid))
    }
}

/// The smallest byte string greater than every string that starts with `prefix`; None when none exists.
pub fn prefix_end(prefix: &[u8]) -> Option<Vec<u8>> {
    let mut end = prefix.to_vec();
    while let Some(last) = end.pop() {
        if last != 0xFF {
            end.push(last + 1);
            return Some(end);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn samples() -> Vec<Value> {
        let mut values = vec![
            Value::Null,
            Value::Integer(i64::MIN),
            Value::Integer(-5),
            Value::Real(-4.5),
            Value::Integer(0),
            Value::Integer(1),
            Value::Real(1.5),
            Value::Integer(2),
            Value::Integer((1 << 60) + 1),
            Value::Integer((1 << 60) + 2),
            Value::Integer(i64::MAX),
            Value::Text(String::new()),
            Value::Text("a".into()),
            Value::Text("a\0".into()),
            Value::Text("a\0b".into()),
            Value::Text("ab".into()),
            Value::Text("b".into()),
            Value::Blob(Vec::new()),
            Value::Blob(vec![0]),
            Value::Blob(vec![0, 0]),
            Value::Blob(vec![0xFF]),
        ];
        values.sort_by_key(|a| ordered_one(a).unwrap());
        values
    }

    #[test]
    fn byte_order_is_the_contract_order_and_values_round_trip() {
        let expected = [
            Value::Null,
            Value::Integer(i64::MIN),
            Value::Integer(-5),
            Value::Real(-4.5),
            Value::Integer(0),
            Value::Integer(1),
            Value::Real(1.5),
            Value::Integer(2),
            Value::Integer((1 << 60) + 1),
            Value::Integer((1 << 60) + 2),
            Value::Integer(i64::MAX),
            Value::Text(String::new()),
            Value::Text("a".into()),
            Value::Text("a\0".into()),
            Value::Text("a\0b".into()),
            Value::Text("ab".into()),
            Value::Text("b".into()),
            Value::Blob(Vec::new()),
            Value::Blob(vec![0]),
            Value::Blob(vec![0, 0]),
            Value::Blob(vec![0xFF]),
        ];
        assert_eq!(samples(), expected);
        for value in &expected {
            let bytes = ordered_one(value).unwrap();
            assert_eq!(read_ordered(&bytes).unwrap(), (value.clone(), bytes.len()), "{value:?}");
            let bytes = plain_one(value).unwrap();
            assert_eq!(read_plain_whole(&bytes).unwrap(), *value, "{value:?}");
        }
    }

    #[test]
    fn a_tuple_prefix_is_a_byte_prefix() {
        let full = ordered_tuple(&[Value::from("acct"), Value::from("res"), Value::Integer(7)]).unwrap();
        let prefix = ordered_tuple(&[Value::from("acct"), Value::from("res")]).unwrap();
        assert!(full.starts_with(&prefix));
        let (values, used) = read_ordered_tuple(&full, 3).unwrap();
        assert_eq!((values, used), (vec![Value::from("acct"), Value::from("res"), Value::Integer(7)], full.len()));
        assert_eq!(prefix_end(&[1, 2, 0xFF]), Some(vec![1, 3]));
        assert_eq!(prefix_end(&[0xFF]), None);
    }
}
