// src/storage/record_store/stamps.rs
//
// EVERY FIELD OF EVERY RECORD CARRIES THE STAMP OF THE WRITE THAT SET IT, AND TWO COPIES MERGE BY KEEPING, FIELD BY
// FIELD, THE LATER STAMP: THE SAME ANSWER IN ANY ORDER, ANY NUMBER OF TIMES, ACROSS ANY NUMBER OF COPIES.
//
// Purpose
//   A one to one port of old trillion `parts/record-log/do-work/record-stamps.mjs` (Trillion-X/trillion origin/main).
//   Copies of a record store that change apart (a computer offline, a peer, another store of the account) must end equal
//   however their changes cross. Comparing each change with what it replaced settles two copies, but not three: a
//   change passed on through a third copy looks new on one and stale on another, and the copies stay apart. A record's
//   state here is a join: each field is (value or removed, stamp), and the record has a floor (the stamp of its last
//   whole write or removal: fields stamped before it are gone) with the kind of write that set it. Merging two states
//   keeps the later stamp per field and the later floor, so it is commutative, associative and idempotent, and copies
//   that have seen the same changes hold the same state.
//
// Non-Negotiable Invariants
//   1. A stamp is text that sorts by when its write was made (a log row's time, then its own bits, then the envelope's
//      computer in the row): the later write wins. A write made here is always stamped after everything the record holds
//      (`stamp_after`), so a copy whose clock runs behind another's never loses its own newer change.
//   2. Two different values with one stamp (two copies that each moved past the same stamp at once) are settled by
//      `tie_by_content`, the same rule on every copy.
//   3. One state keeps one stamps text (sorted). What is kept is compact: `Meta` = { at (the latest stamp), f (the
//      floor, when it is not `at`), k ("removed" when the floor is a removal), s (fields stamped other than `at`), d
//      (removed fields stamped after the floor) }. A record written whole once keeps only { at }.
//   4. Nothing here reads storage or names a record kind: states in, states out.
//   5. Texts compare by UTF-16 code unit (`js_less`), as JavaScript compares strings, so both implementations rank the
//      same two values the same way.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing this documentation. Maintain and extend this detail.

use super::digest::json_text;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use std::{cmp::Ordering, collections::BTreeMap};

/// A record's fields.
pub type Fields = Map<String, Value>;

/// JavaScript's string order: by UTF-16 code unit.
pub fn js_cmp(a: &str, b: &str) -> Ordering {
    crate::record_stamps::compare_text(a, b)
}
/// `a < b` in JavaScript's string order.
pub fn js_less(a: &str, b: &str) -> bool {
    js_cmp(a, b) == Ordering::Less
}
fn later<'a>(a: &'a str, b: &'a str) -> &'a str {
    if js_cmp(a, b) == Ordering::Greater { a } else { b }
}

/// A stamp after `held` and no earlier than `fresh`: a write made here wins over everything the record holds.
/// The one owner's rule (`crate::record_stamps::stamp_after`); a suffix that would split a UTF-16 surrogate pair (never
/// one of this store's ASCII stamps) is taken lossily, as this store did before.
pub fn stamp_after(fresh: &str, held: Option<&str>) -> String {
    let held = held.unwrap_or("");
    crate::record_stamps::stamp_after(fresh, held).unwrap_or_else(|_| {
        let tail: Vec<u16> = fresh.encode_utf16().collect();
        format!("{held}{}", String::from_utf16_lossy(&tail[tail.len().saturating_sub(7)..]))
    })
}

/// The kind of write that set a floor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Floor {
    Whole,
    Removed,
}

/// One field of a state.
#[derive(Clone, Debug, PartialEq)]
pub struct Cell {
    pub stamp: String,
    /// None: removed.
    pub value: Option<Value>,
}

/// A record's state (old trillion `{ floor, kind, type, typeAt, fields }`).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct State {
    pub floor: String,
    pub kind: Option<Floor>,
    pub kind_of_record: Option<String>,
    pub type_at: String,
    pub fields: BTreeMap<String, Cell>,
}

/// The stamps a kept record keeps (old trillion `meta`).
#[derive(Clone, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Meta {
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub f: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub k: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub d: Option<BTreeMap<String, String>>,
}
impl Meta {
    /// `JSON.stringify(meta)`: the members in the order old trillion makes them (at, f, k, s, d), each map sorted.
    pub fn text(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// A record as kept: a live record (`kind` and `value` set) or what a removal left (both None).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Kept {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub value: Option<Fields>,
    pub meta: Meta,
}

/// A record's kind and value (old trillion `{ type, value }`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Typed {
    #[serde(rename = "type")]
    pub kind: String,
    pub value: Fields,
}

fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

/// One change of one record, as it is written to a log row and as it crosses (old trillion's envelope): a whole value
/// (`kind` + `value`), field changes (`set` / `unset`), a removal (`remove`), or `purge` (nothing kept for the id). The
/// stamps it may name (`at`, `stamps`, `floor`, `floor_kind`, `removed`), and what it replaced (`prior` for a whole
/// value or removal, `was` / `added` for field changes) so a copy that changed it from something else meets a conflict.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
pub struct Envelope {
    pub id: String,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Fields>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub remove: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub purge: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub set: Option<Fields>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unset: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stamps: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub floor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub floor_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<BTreeMap<String, String>>,
    /// `Some(None)`: the record held nothing before; None: not said.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub prior: Option<Option<Typed>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub was: Option<Fields>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub exact: bool,
}
impl Envelope {
    /// Whether it carries a whole value or a removal.
    pub fn whole_or_removal(&self) -> bool {
        self.remove || self.value.is_some()
    }
}

fn own_stamp(stamps: Option<&BTreeMap<String, String>>, field: &str, fallback: &str) -> String {
    stamps.and_then(|stamps| stamps.get(field)).cloned().unwrap_or_else(|| fallback.to_string())
}

/// The state a kept record holds (old trillion `stateOf`).
pub fn state_of(kept: Option<&Kept>) -> State {
    let Some(kept) = kept else { return State::default() };
    let meta = &kept.meta;
    let at = meta.at.clone();
    let floor = meta.f.clone().unwrap_or_else(|| at.clone());
    let mut fields = BTreeMap::new();
    for (field, stamp) in meta.d.iter().flatten() {
        fields.insert(field.clone(), Cell { stamp: stamp.clone(), value: None });
    }
    if let (Some(_), Some(value)) = (&kept.kind, &kept.value) {
        for (field, item) in value {
            fields.insert(field.clone(), Cell { stamp: own_stamp(meta.s.as_ref(), field, &at), value: Some(item.clone()) });
        }
    }
    let removed = meta.k.as_deref() == Some("removed") || kept.kind.is_none();
    State { floor, kind: Some(if removed { Floor::Removed } else { Floor::Whole }), kind_of_record: kept.kind.clone(), type_at: at, fields }
}

fn floor_kind(text: Option<&str>) -> Floor {
    if text == Some("removed") { Floor::Removed } else { Floor::Whole }
}

/// The state one envelope carries: stamped `stamp` unless it names its own (old trillion `stateFrom`).
pub fn state_from(envelope: &Envelope, stamp: &str) -> State {
    let at = envelope.at.clone().unwrap_or_else(|| stamp.to_string());
    let mut fields = BTreeMap::new();
    if envelope.remove {
        for (field, removed_at) in envelope.removed.iter().flatten() {
            fields.insert(field.clone(), Cell { stamp: removed_at.clone(), value: None });
        }
        return State { floor: envelope.floor.clone().unwrap_or(at), kind: Some(Floor::Removed), kind_of_record: None, type_at: String::new(), fields };
    }
    if let Some(value) = &envelope.value {
        for (field, item) in value {
            fields.insert(field.clone(), Cell { stamp: own_stamp(envelope.stamps.as_ref(), field, &at), value: Some(item.clone()) });
        }
        for (field, removed_at) in envelope.removed.iter().flatten() {
            fields.insert(field.clone(), Cell { stamp: removed_at.clone(), value: None });
        }
        return State {
            floor: envelope.floor.clone().unwrap_or_else(|| at.clone()),
            kind: Some(floor_kind(envelope.floor_kind.as_deref())),
            kind_of_record: envelope.kind.clone(),
            type_at: at,
            fields,
        };
    }
    for (field, item) in envelope.set.iter().flatten() {
        fields.insert(field.clone(), Cell { stamp: own_stamp(envelope.stamps.as_ref(), field, &at), value: Some(item.clone()) });
    }
    for field in envelope.unset.iter().flatten() {
        fields.insert(field.clone(), Cell { stamp: own_stamp(envelope.stamps.as_ref(), field, &at), value: None });
    }
    State {
        floor: envelope.floor.clone().unwrap_or_default(),
        kind: envelope.floor.as_ref().map(|_| floor_kind(envelope.floor_kind.as_deref())),
        kind_of_record: envelope.kind.clone(),
        type_at: at,
        fields,
    }
}

/// Removed first, then the lower value text: the rule every copy runs for one stamp on two values (true: b wins).
/// The rule is `crate::record_stamps::tie_by_content`'s (the one owner of the field join), with this store's value text
/// (`json_text`).
pub fn tie_by_content(a: &Cell, b: &Cell) -> bool {
    crate::record_stamps::tie_by_content(&joined_cell(a), &joined_cell(b), &encode).unwrap_or(false)
}

/// This store's value text, as the one join owner asks it (it never fails).
fn encode(value: &Value) -> Result<String, std::convert::Infallible> {
    Ok(json_text(value))
}

fn joined_cell(cell: &Cell) -> crate::record_stamps::Cell {
    match &cell.value {
        Some(value) => crate::record_stamps::Cell::live(cell.stamp.clone(), value.clone()),
        None => crate::record_stamps::Cell::removed(cell.stamp.clone()),
    }
}

fn joined(state: &State) -> crate::record_stamps::State {
    use crate::record_stamps::FloorKind;
    crate::record_stamps::State {
        floor: state.floor.clone(),
        kind: state.kind.map(|kind| match kind { Floor::Whole => FloorKind::Whole, Floor::Removed => FloorKind::Removed }),
        record_type: state.kind_of_record.clone(),
        type_at: state.type_at.clone(),
        fields: state.fields.iter().map(|(field, cell)| (field.clone(), joined_cell(cell))).collect(),
    }
}

fn from_joined(state: crate::record_stamps::State) -> State {
    use crate::record_stamps::{CellContent, FloorKind};
    State {
        floor: state.floor,
        kind: state.kind.map(|kind| match kind { FloorKind::Whole => Floor::Whole, FloorKind::Removed => Floor::Removed }),
        kind_of_record: state.record_type,
        type_at: state.type_at,
        fields: state.fields.iter().map(|(field, cell)| {
            let value = match &cell.content { CellContent::Value(value) => Some(value.clone()), CellContent::Removed => None };
            (field.to_string(), Cell { stamp: cell.stamp.clone(), value })
        }).collect(),
    }
}

/// The join of two states (old trillion `merge`, with `tieByContent`). One owner runs it for every store:
/// `crate::record_stamps::merge` (the journal lane's port of the same record-stamps.mjs); this store keeps only its own
/// kept and wire shapes (`Meta`, `Envelope`) around it. Before, this file kept a second copy of the join.
pub fn merge(a: &State, b: &State) -> State {
    match crate::record_stamps::merge(&joined(a), &joined(b), &encode) {
        Ok(state) => from_joined(state),
        Err(never) => match never {},
    }
}

/// Whether the state is a record: its floor is a whole write, or a field was written after a removal.
pub fn exists(state: &State) -> bool {
    crate::record_stamps::exists(&joined(state))
}

/// The state as kept: a record, what a removal left, or None for a state that holds nothing (old trillion `keptFrom`).
pub fn kept_from(state: &State) -> Option<Kept> {
    if state.floor.is_empty() && state.fields.is_empty() {
        return None;
    }
    let mut at = state.floor.clone();
    for cell in state.fields.values() {
        at = later(&at, &cell.stamp).to_string();
    }
    let mut meta = Meta { at: at.clone(), ..Meta::default() };
    if state.floor != at {
        meta.f = Some(state.floor.clone());
    }
    if state.kind == Some(Floor::Removed) {
        meta.k = Some("removed".into());
    }
    let live = exists(state);
    let mut value = Fields::new();
    // Stamps in one order (BTreeMap), so two copies holding one state keep the same stamps text.
    for (field, cell) in &state.fields {
        match &cell.value {
            None => {
                if js_cmp(&cell.stamp, &state.floor) == Ordering::Greater {
                    meta.d.get_or_insert_with(BTreeMap::new).insert(field.clone(), cell.stamp.clone());
                }
            }
            Some(item) => {
                if live {
                    value.insert(field.clone(), item.clone());
                    if cell.stamp != at {
                        meta.s.get_or_insert_with(BTreeMap::new).insert(field.clone(), cell.stamp.clone());
                    }
                }
            }
        }
    }
    Some(if live { Kept { kind: state.kind_of_record.clone(), value: Some(value), meta } } else { Kept { kind: None, value: None, meta } })
}

/// The envelope that carries a kept state whole to another copy: merged there, it gives that copy at least this
/// state (old trillion `envelopeOfKept`).
pub fn envelope_of_kept(id: &str, kept: &Kept) -> Envelope {
    let meta = &kept.meta;
    let mut envelope = Envelope {
        id: id.to_string(),
        at: Some(meta.at.clone()),
        floor: Some(meta.f.clone().unwrap_or_else(|| meta.at.clone())),
        floor_kind: meta.k.clone(),
        removed: meta.d.clone(),
        ..Envelope::default()
    };
    match &kept.kind {
        None => envelope.remove = true,
        Some(kind) => {
            envelope.kind = Some(kind.clone());
            envelope.value = Some(kept.value.clone().unwrap_or_default());
            envelope.stamps = meta.s.clone();
        }
    }
    envelope
}

/// `JSON.stringify` of a kept form, for `same_kept`.
fn kept_text(kept: Option<&Kept>) -> String {
    match kept {
        None => "null".into(),
        Some(kept) => format!(
            "{{\"type\":{},\"value\":{},\"meta\":{}}}",
            kept.kind.as_deref().map_or_else(|| "null".into(), super::digest::quoted),
            kept.value.as_ref().map_or_else(|| "null".into(), |value| json_text(&Value::Object(value.clone()))),
            kept.meta.text()
        ),
    }
}

/// Whether two kept forms are the same state.
pub fn same_kept(a: Option<&Kept>, b: Option<&Kept>) -> bool {
    kept_text(a) == kept_text(b)
}
