// src/storage/record_store/orders.rs
//
// Purpose: Declared field orders of the record store. Any record kind can declare, as DATA (`settings.json` `orders`),
// an order over one field of its value. The store keeps one `ordered` row per record per order that applies to it,
// so a page in that order is one range scan over the order rows plus one get per record shown.
//
// Non-Negotiable Invariants:
// - The order value is the field's ECMA JSON text (`ecma_json::stringify`) held as UTF-16BE bytes. Bytes compare in
//   UTF-16 code-unit order, so the order equals the old engine's declared indexes, which compare that same text by
//   code unit and then by id (`record_indexes::cmp`).
// - A record whose kind the order does not name, or whose value lacks the field, has no row in that order.
// - A field whose value cannot be read is a refused write, never a silently missing row.
//
// Key Concepts:
// - `Declared`: `{ order, kind?, path, then? }`. With `then`, the order value is the ECMA JSON text of the array of
//   the named fields' values in that order (`[path value, then values...]`), so a record lists by `path`, then by
//   each `then` field, whatever key order its writer used; a record lacking any named field has no row. A path step into a string that holds JSON reads that JSON text (a connection
//   that keeps a value as exact JSON text, such as the native seam's `stored`, is ordered by the value inside it).
// - `value_of`: the order value of one record value for one declaration; `field_value`: of one field value.
//
// Security Considerations:
// - Order rows hold one field's text per record; erase removes them with the record (`mod.rs`).
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::{
    ecma_json::{self, JsString, Value as Ecma},
    records::Error,
};
use serde::Deserialize;
use serde_json::Value;

/// What an order's rows depend on (old trillion record-model.mjs `signatureOf`, record-log-store.mjs index
/// signatures): its kind, path and `then`. A changed signature under the same name fills the order again.
pub fn signature_of(declared: &Declared) -> String {
    serde_json::json!({ "kind": declared.kind, "path": declared.path, "then": declared.then, "carry": declared.carry }).to_string()
}

/// One declared order, as DATA.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Declared {
    #[serde(rename = "_why")]
    pub why: String,
    /// The order's name, as readers ask for it (`RecordStore::ordered_page`).
    pub order: String,
    /// The record kind (the value's `kind_field`) the order covers; none covers every record.
    #[serde(default)]
    pub kind: Option<String>,
    /// The field, as a path of object keys from the record value.
    pub path: Vec<String>,
    /// Further fields the order lists by after `path`, each a path from the record value.
    #[serde(default)]
    pub then: Vec<Vec<String>>,
    /// Fields kept beside each order row (old trillion record-indexes `carry`), so a page of the order can answer them
    /// without reading its records (`RecordStore::ordered_scan` with `carried`). Each a path from the record value.
    #[serde(default)]
    pub carry: Vec<Vec<String>>,
}
impl Declared {
    pub fn valid(&self) -> bool {
        !self.order.is_empty()
            && !self.order.contains('\0')
            && std::iter::once(&self.path).chain(&self.then)
                .all(|path| !path.is_empty() && path.iter().all(|step| !step.is_empty()))
            && self.kind.as_ref().is_none_or(|kind| !kind.is_empty())
            && self.carry.iter().all(|path| !path.is_empty() && path.iter().all(|step| !step.is_empty()))
    }
}

/// The carried fields of a record in `declared` (old `carry`): a JSON object of each carried path's last step to its
/// value (null when absent), none when the order carries nothing.
pub fn carried_of(declared: &Declared, value: &Value) -> Option<Vec<u8>> {
    if declared.carry.is_empty() {
        return None;
    }
    let mut out = serde_json::Map::new();
    for path in &declared.carry {
        let mut at = Some(value);
        for step in path {
            at = at.and_then(|here| here.get(step));
        }
        out.insert(path.join("."), at.cloned().unwrap_or(Value::Null));
    }
    serde_json::to_vec(&Value::Object(out)).ok()
}
/// The UTF-16BE bytes of a plain text (the punctuation an order value's array text holds).
pub fn units(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(u16::to_be_bytes).collect()
}
/// An order value back as JSON: the field (or the array of fields of an order with `then`).
pub fn decode(value: &[u8]) -> Option<Value> {
    if value.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = value.chunks(2).map(|pair| u16::from_be_bytes([pair[0], pair[1]])).collect();
    serde_json::from_str(&String::from_utf16(&units).ok()?).ok()
}

/// The parse limits of a JSON text crossed by a path: the hard ceilings (the record is already bounded by its host).
fn limits() -> ecma_json::Limits {
    ecma_json::Limits {
        input_bytes: ecma_json::HARD_BYTES,
        output_bytes: ecma_json::HARD_BYTES,
        depth: ecma_json::HARD_DEPTH,
        nodes: ecma_json::HARD_NODES,
        string_units: ecma_json::HARD_BYTES,
        total_string_units: ecma_json::HARD_BYTES,
        container_entries: ecma_json::HARD_NODES,
        number_bytes: ecma_json::HARD_NUMBER_BYTES,
    }
}
fn unreadable(_: ecma_json::Error) -> Error {
    Error::Invalid("a declared order's field cannot be read", crate::cause!())
}

/// The order value of `value` (a record of kind `kind`) in `declared`: the UTF-16BE bytes of the field's ECMA JSON
/// text, or none when the order does not cover the record or the field is absent.
pub fn value_of(declared: &Declared, kind: Option<&str>, value: &Value) -> Result<Option<Vec<u8>>, Error> {
    if declared.kind.as_deref().is_some_and(|wanted| Some(wanted) != kind) {
        return Ok(None);
    }
    let Some(first) = leaf(&declared.path, value)? else { return Ok(None) };
    if declared.then.is_empty() {
        return encode(&first).map(Some);
    }
    let mut fields = Vec::with_capacity(1 + declared.then.len());
    fields.push(first);
    for path in &declared.then {
        let Some(next) = leaf(path, value)? else { return Ok(None) };
        fields.push(next);
    }
    encode(&Ecma::Array(fields)).map(Some)
}

/// The value at `path` in a record value, as ECMA JSON; none when a step is absent.
fn leaf(path: &[String], value: &Value) -> Result<Option<Ecma>, Error> {
    let mut at = value;
    for (step, key) in path.iter().enumerate() {
        match at {
            Value::Object(fields) => match fields.get(key) {
                Some(next) => at = next,
                None => return Ok(None),
            },
            // A string holding JSON: the rest of the path reads the JSON text it holds.
            Value::String(text) => return inside_text(text, &path[step..]),
            _ => return Ok(None),
        }
    }
    ecma_json::parse(&serde_json::to_vec(at).map_err(|_| Error::Invalid("invalid record value", crate::cause!()))?, limits())
        .map(Some)
        .map_err(unreadable)
}

/// The order value of one field value: the UTF-16BE bytes of its ECMA JSON text. A reader bounds a page with it
/// (the decisions screen's "before this created_at").
pub fn field_value(value: &Value) -> Result<Vec<u8>, Error> {
    let leaf = ecma_json::parse(&serde_json::to_vec(value).map_err(|_| Error::Invalid("invalid record value", crate::cause!()))?, limits())
        .map_err(unreadable)?;
    encode(&leaf)
}

fn inside_text(text: &str, path: &[String]) -> Result<Option<Ecma>, Error> {
    let document = ecma_json::parse(text.as_bytes(), limits()).map_err(unreadable)?;
    let mut at = &document;
    for key in path {
        match at {
            Ecma::Object(fields) => match fields.get(&JsString::from(key.as_str())) {
                Some(next) => at = next,
                None => return Ok(None),
            },
            _ => return Ok(None),
        }
    }
    Ok(Some(at.clone()))
}

/// UTF-16BE bytes of the value's ECMA JSON text.
fn encode(value: &Ecma) -> Result<Vec<u8>, Error> {
    let text = ecma_json::stringify(value, limits()).map_err(unreadable)?;
    Ok(text.encode_utf16().flat_map(u16::to_be_bytes).collect())
}

