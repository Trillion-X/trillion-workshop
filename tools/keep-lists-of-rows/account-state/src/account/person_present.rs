// src/account/person_present.rs
//
// Purpose: a write that needs the person present. A declaring record (a list) may mark one of its fields with
// `record_write_model::PERSON_PRESENT_MARK`, naming values that a write may set only with a fresh confirmation by the
// person. This module says which confirmations a write needs (`required`). The person is present when the caller's own
// sign-in pass was issued within Better Auth's fresh-session age (`signed_in::Principal::fresh`, set only by the door:
// src/native_boot/mcp_local.rs `invoke_as`, src/local_workspace/write.rs); otherwise such a write is refused
// (`REFUSAL_CODE`), naming what it needs, and the person renews the pass by signing in again (the person's lead, Nov 13 2026).
//
// Non-Negotiable Invariants:
// - The engine names no list, row kind, field or value. The mark and its values are DATA in the declaring record;
//   this module reads them only through the live record model (`record_write_model::Model`).
// - A row's write needs a confirmation for each marked value it newly sets (a value its field did not already hold).
//   Writing another value, leaving the field as it is, removing the row or writing an unmarked field needs nothing.
// - The mark protects itself: a write of a declaring record that removes any (row kind, field, value) it marked needs a
//   confirmation for each one. Adding to a mark needs nothing.
// - Rows read their marks from EVERY current declaration of their kind, before and after the batch.
// - Without a fresh pass of the caller's own, nothing confirms: a write that needs the person present is refused.
//
// Security Considerations:
// - Record ids, fields and values are the person's own words: Debug is redacted and nothing here logs them.

use crate::ecma_json::{JsString, Value as JsValue};
use crate::record_write_model::Model;
use std::{collections::BTreeSet, fmt};

/// The field of a request, beside its request_key, that once carried a confirmation by the person present. A request may
/// still carry it; it is ignored.
pub const REQUEST_FIELD: &str = "person_present";
/// The refusal code of a write that needs the person present.
pub const REFUSAL_CODE: &str = "needs_person_present";
/// The largest confirmation a request may carry.
pub const MAX_PROOF_BYTES: usize = 65_536;

/// One confirmation a write needs: setting `value` in `field` of the record `record` (for a declaring record, the
/// mark on its field `field` that kept `value`).
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Requirement {
    pub record: String,
    pub field: String,
    pub value: String,
}
impl fmt::Debug for Requirement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PersonPresentRequirement([redacted])")
    }
}

/// The values of a field, as text: one text, or the texts of an array (other values set nothing markable).
fn texts(value: Option<&JsValue>) -> BTreeSet<JsString> {
    match value {
        Some(JsValue::String(text)) => BTreeSet::from([text.clone()]),
        Some(JsValue::Array(items)) => {
            items.iter().filter_map(|item| match item { JsValue::String(text) => Some(text.clone()), _ => None }).collect()
        }
        _ => BTreeSet::new(),
    }
}
fn member<'a>(value: &'a JsValue, name: &JsString) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(object) => object.get(name),
        _ => None,
    }
}
fn rust(text: &JsString) -> Result<String, crate::refusal_cause::CodedError<()>> {
    text.to_rust_string().map_err(|_| crate::refusal_cause::CodedError::new(()))
}

/// The confirmations one write needs, in order and without repeats. `declared` is the model of the declarations
/// current before the batch; `effective` the model after the batch's effective writes. `old` is the record this write
/// replaces at its point of the batch (its kind and value), none for a new record. `value` none removes the record.
/// Err when a name the write involves is not text (a lone surrogate); the caller refuses the write.
pub fn required(declared: &Model, effective: &Model, id: &JsString, kind: &JsString, value: Option<&JsValue>,
    old: Option<(&JsString, &JsValue)>) -> Result<Vec<Requirement>, crate::refusal_cause::CodedError<()>> {
    let record = rust(id)?;
    let mut needed = BTreeSet::new();
    // The mark protects itself: every (row kind, field, value) the record marked before and does not mark now.
    let before = old.map(|(kind, value)| declared.marks_declared(kind, value)).unwrap_or_default();
    if !before.is_empty() {
        let after = value.map(|value| declared.marks_declared(kind, value)).unwrap_or_default();
        for (_, field, marked) in before.difference(&after) {
            needed.insert(Requirement { record: record.clone(), field: rust(field)?, value: rust(marked)? });
        }
    }
    // A row: each marked value it newly sets.
    if let Some(value) = value {
        let mut marks = declared.person_present_marks(kind);
        for (field, values) in effective.person_present_marks(kind) {
            marks.entry(field).or_default().extend(values);
        }
        let held = old.filter(|(old_kind, _)| *old_kind == kind).map(|(_, value)| value);
        for (field, values) in marks {
            let now = texts(member(value, &field));
            let was = held.map(|held| texts(member(held, &field))).unwrap_or_default();
            for set in now.difference(&was).filter(|set| values.contains(*set)) {
                needed.insert(Requirement { record: record.clone(), field: rust(&field)?, value: rust(set)? });
            }
        }
    }
    Ok(needed.into_iter().collect())
}
