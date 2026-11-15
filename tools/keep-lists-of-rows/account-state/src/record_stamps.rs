//! Field-stamped record joins, ported from the current record-log owner.
//!
//! Purpose: keep the value and removal stamp of each top-level field, together
//! with the floor established by the last whole write or record removal.
//!
//! Invariants: older-than-floor fields cannot return; equal-stamp values use
//! the same by-content rule on every copy; metadata field names are sorted by
//! JavaScript's UTF-16 order. This module performs no storage or provider work.
//! A caller supplies the original value-text encoder when exchanging states
//! with the existing owner. `serde_json` bytes are not claimed to be the bytes
//! of JavaScript `JSON.stringify` (number formatting and object order differ).
//!
//! The source owner's record-type selection is deliberately retained: equal
//! type stamps prefer the left non-null type. Callers must keep a record's
//! type fixed, or settle such a type conflict outside this field-value join.

use serde::{de::{MapAccess, Visitor}, ser::SerializeMap, Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use std::{cmp::Ordering, collections::HashMap, fmt};

/// An insertion-ordered map. Replacing a name keeps its first position, as in
/// the source owner's JavaScript Map/Object assignment. Duplicate input names
/// therefore keep their last value without acquiring another field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderedMap<T> { entries: Vec<(String, T)>, index: HashMap<String, usize> }

impl<T> Default for OrderedMap<T> { fn default() -> Self { Self { entries: Vec::new(), index: HashMap::new() } } }
impl<T> OrderedMap<T> {
    pub fn new() -> Self { Self::default() }
    pub fn len(&self) -> usize { self.entries.len() }
    pub fn is_empty(&self) -> bool { self.entries.is_empty() }
    pub fn get(&self, key: &str) -> Option<&T> { self.index.get(key).map(|position| &self.entries[*position].1) }
    pub fn insert(&mut self, key: impl Into<String>, value: T) -> Option<T> {
        let key = key.into();
        if let Some(position) = self.index.get(&key) {
            return Some(std::mem::replace(&mut self.entries[*position].1, value));
        }
        self.index.insert(key.clone(), self.entries.len());
        self.entries.push((key, value)); None
    }
    pub fn iter(&self) -> impl Iterator<Item = (&str, &T)> { self.entries.iter().map(|(key, value)| (key.as_str(), value)) }
    pub fn keys(&self) -> impl Iterator<Item = &str> { self.entries.iter().map(|(key, _)| key.as_str()) }
    /// JavaScript Object.keys/entries puts array-index names first numerically,
    /// then other names in insertion order. State.fields itself remains a Map
    /// and uses `iter`, not this object enumeration rule.
    pub fn object_entries(&self) -> Vec<(&str, &T)> {
        let mut result: Vec<_> = self.iter().collect();
        result.sort_by(|(a, _), (b, _)| match (array_index(a), array_index(b)) {
            (Some(a), Some(b)) => a.cmp(&b),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        });
        result
    }
    fn order_as_object(&mut self) {
        self.entries.sort_by(|(a, _), (b, _)| match (array_index(a), array_index(b)) {
            (Some(a), Some(b)) => a.cmp(&b), (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater, (None, None) => Ordering::Equal,
        });
        self.index.clear();
        for (position, (name, _)) in self.entries.iter().enumerate() { self.index.insert(name.clone(), position); }
    }
}
fn array_index(name: &str) -> Option<u32> {
    let value: u32 = name.parse().ok()?;
    (value != u32::MAX && value.to_string() == name).then_some(value)
}
impl<T> FromIterator<(String, T)> for OrderedMap<T> {
    fn from_iter<I: IntoIterator<Item = (String, T)>>(values: I) -> Self {
        let mut map = Self::new(); for (key, value) in values { map.insert(key, value); } map
    }
}
impl<T: Serialize> Serialize for OrderedMap<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.len()))?;
        for (key, value) in &self.entries { map.serialize_entry(key, value)?; }
        map.end()
    }
}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for OrderedMap<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct OrderedVisitor<T>(std::marker::PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for OrderedVisitor<T> {
            type Value = OrderedMap<T>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("an ordered object") }
            fn visit_map<A: MapAccess<'de>>(self, mut input: A) -> Result<Self::Value, A::Error> {
                let mut result = OrderedMap::new();
                while let Some((key, value)) = input.next_entry::<String, T>()? { result.insert(key, value); }
                Ok(result)
            }
        }
        deserializer.deserialize_map(OrderedVisitor(std::marker::PhantomData))
    }
}

pub type Fields = OrderedMap<Value>;
pub type StampMap = OrderedMap<String>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FloorKind { Whole, Removed }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CellContent { Value(Value), Removed }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cell { pub stamp: String, pub content: CellContent }
impl Cell {
    pub fn live(stamp: impl Into<String>, value: Value) -> Self { Self { stamp: stamp.into(), content: CellContent::Value(value) } }
    pub fn removed(stamp: impl Into<String>) -> Self { Self { stamp: stamp.into(), content: CellContent::Removed } }
    pub fn is_removed(&self) -> bool { matches!(self.content, CellContent::Removed) }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct State {
    pub floor: String,
    pub kind: Option<FloorKind>,
    pub record_type: Option<String>,
    pub type_at: String,
    pub fields: OrderedMap<Cell>,
}

/// Compact kept metadata. A whole write at one stamp needs only `at`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Meta {
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub f: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub k: Option<FloorKind>,
    #[serde(default, skip_serializing_if = "OrderedMap::is_empty")]
    pub s: StampMap,
    #[serde(default, skip_serializing_if = "OrderedMap::is_empty")]
    pub d: StampMap,
}

/// `record_type=None` is the kept record-removal marker, not a JSON-null field.
/// `meta=None` supports a live record kept before field stamps existed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Kept {
    #[serde(rename = "type")]
    pub record_type: Option<String>,
    pub value: Option<Fields>,
    pub meta: Option<Meta>,
}

/// Typed input distinguishes a whole object from a patch with no `value`.
/// This is a Rust value model, not an implicit parser for the legacy flat JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EnvelopeBody { Whole(Fields), Patch { set: Fields, unset: Vec<String> }, Remove }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope {
    pub id: String,
    pub record_type: Option<String>,
    pub body: EnvelopeBody,
    pub at: Option<String>,
    pub floor: Option<String>,
    pub floor_kind: Option<FloorKind>,
    pub stamps: StampMap,
    pub removed: StampMap,
}

/// JavaScript relational string comparison and Array.sort compare UTF-16 code
/// units; UTF-8 byte order would reverse some supplementary/BMP comparisons.
pub fn compare_text(a: &str, b: &str) -> Ordering { a.encode_utf16().cmp(b.encode_utf16()) }
fn later<'a>(a: &'a str, b: &'a str) -> &'a str { if compare_text(a, b).is_gt() { a } else { b } }

#[derive(Debug, Clone)]
pub enum StampError { SplitSurrogate(crate::refusal_cause::Cause) }
impl StampError {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::SplitSurrogate(cause) => cause,
        }
    }
}
crate::impl_caused!(StampError);

impl PartialEq for StampError { fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) } }
impl Eq for StampError {}

impl fmt::Display for StampError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let result: std::fmt::Result = { f.write_str("stamp suffix splits a UTF-16 surrogate pair")
        };
        result?;
        write!(f, " cause={}", self.cause())
    }
}
impl std::error::Error for StampError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

/// Source `stampAfter`: if the local fresh stamp is behind, append its last
/// seven UTF-16 units to the held stamp. Real log stamps are nonempty ASCII.
/// Reject an unrepresentable split surrogate instead of silently changing it.
pub fn stamp_after(fresh: &str, held: &str) -> Result<String, StampError> {
    if held.is_empty() || compare_text(fresh, held).is_gt() { return Ok(fresh.into()); }
    let units: Vec<u16> = fresh.encode_utf16().collect();
    let suffix = String::from_utf16(&units[units.len().saturating_sub(7)..]).map_err(|error| crate::carry_cause!(StampError::SplitSurrogate, error))?;
    Ok(format!("{held}{suffix}"))
}

/// Expand a kept value/removal, including legacy unstamped records.
pub fn state_of(kept: Option<&Kept>) -> State {
    let Some(kept) = kept else { return State::default(); };
    let at = kept.meta.as_ref().map(|meta| meta.at.as_str()).unwrap_or("");
    let floor = kept.meta.as_ref().and_then(|meta| meta.f.as_deref()).unwrap_or(at);
    let mut fields = OrderedMap::new();
    if let Some(meta) = &kept.meta { for (field, stamp) in meta.d.object_entries() { fields.insert(field, Cell::removed(stamp)); } }
    if kept.record_type.is_some() {
        if let Some(value) = &kept.value {
            for (field, value) in value.object_entries() {
                let stamp = kept.meta.as_ref().and_then(|meta| meta.s.get(field)).map(String::as_str).unwrap_or(at);
                fields.insert(field, Cell::live(stamp, value.clone()));
            }
        }
    }
    State {
        floor: floor.into(),
        kind: Some(if kept.record_type.is_none() || kept.meta.as_ref().and_then(|meta| meta.k) == Some(FloorKind::Removed) { FloorKind::Removed } else { FloorKind::Whole }),
        record_type: kept.record_type.clone(), type_at: at.into(), fields,
    }
}

/// Expand one envelope; whole/removal floors suppress older fields while a
/// patch without an explicit floor leaves the held floor alone during merge.
pub fn state_from(envelope: &Envelope, stamp: &str) -> State {
    let at = envelope.at.as_deref().unwrap_or(stamp);
    let mut fields = OrderedMap::new();
    let (floor, kind, record_type, type_at) = match &envelope.body {
        EnvelopeBody::Remove => {
            for (field, removed_at) in envelope.removed.object_entries() { fields.insert(field, Cell::removed(removed_at)); }
            (envelope.floor.as_deref().unwrap_or(at), Some(FloorKind::Removed), None, "")
        }
        EnvelopeBody::Whole(value) => {
            for (field, value) in value.object_entries() {
                fields.insert(field, Cell::live(envelope.stamps.get(field).map(String::as_str).unwrap_or(at), value.clone()));
            }
            for (field, removed_at) in envelope.removed.object_entries() { fields.insert(field, Cell::removed(removed_at)); }
            (envelope.floor.as_deref().unwrap_or(at), Some(envelope.floor_kind.unwrap_or(FloorKind::Whole)), envelope.record_type.clone(), at)
        }
        EnvelopeBody::Patch { set, unset } => {
            for (field, value) in set.object_entries() { fields.insert(field, Cell::live(envelope.stamps.get(field).map(String::as_str).unwrap_or(at), value.clone())); }
            for field in unset { fields.insert(field, Cell::removed(envelope.stamps.get(field).map(String::as_str).unwrap_or(at))); }
            (envelope.floor.as_deref().unwrap_or(""), envelope.floor.as_ref().map(|_| envelope.floor_kind.unwrap_or(FloorKind::Whole)), envelope.record_type.clone(), at)
        }
    };
    State { floor: floor.into(), kind, record_type, type_at: type_at.into(), fields }
}

fn cell_text<E>(cell: &Cell, encode: &impl Fn(&Value) -> Result<String, E>) -> Result<String, E> {
    match &cell.content { CellContent::Removed => Ok(String::new()), CellContent::Value(value) => Ok(format!("~{}", encode(value)?)) }
}
/// Source tieByContent: removed ranks first, then the lower original JSON text.
/// `true` means the right cell wins. No hashes or replacement codec are used.
pub fn tie_by_content<E>(a: &Cell, b: &Cell, encode: &impl Fn(&Value) -> Result<String, E>) -> Result<bool, E> {
    Ok(compare_text(&cell_text(b, encode)?, &cell_text(a, encode)?).is_lt())
}

/// Join fields and floors using source content ties. Encoding failure returns
/// no state and never mutates either input. Values must use one stable encoder
/// across all participating copies; it is not an arbitrary ordering callback.
pub fn merge<E>(a: &State, b: &State, encode: &impl Fn(&Value) -> Result<String, E>) -> Result<State, E> {
    let floor = later(&a.floor, &b.floor).to_owned();
    let kind = match compare_text(&a.floor, &b.floor) {
        Ordering::Equal => if a.kind == Some(FloorKind::Removed) || b.kind == Some(FloorKind::Removed) { Some(FloorKind::Removed) } else { a.kind.or(b.kind) },
        Ordering::Greater => a.kind,
        Ordering::Less => b.kind,
    };
    let (record_type, type_at) = if compare_text(&b.type_at, &a.type_at).is_gt() && b.record_type.is_some() {
        (b.record_type.clone(), b.type_at.clone())
    } else if a.record_type.is_some() { (a.record_type.clone(), a.type_at.clone()) }
    else { (b.record_type.clone(), b.type_at.clone()) };
    let mut fields: OrderedMap<Cell> = a.fields.iter().filter(|(_, cell)| !compare_text(&cell.stamp, &floor).is_lt()).map(|(field, cell)| (field.to_owned(), cell.clone())).collect();
    for (field, cell) in b.fields.iter() {
        if compare_text(&cell.stamp, &floor).is_lt() { continue; }
        let selected = match fields.get(field) {
            None => cell.clone(),
            Some(held) => match compare_text(&held.stamp, &cell.stamp) {
                Ordering::Greater => held.clone(),
                Ordering::Less => cell.clone(),
                Ordering::Equal => if tie_by_content(held, cell, encode)? { cell.clone() } else { held.clone() },
            },
        };
        fields.insert(field, selected);
    }
    Ok(State { floor, kind, record_type, type_at, fields })
}

/// A whole floor keeps a live empty record. After removal, at least one live
/// field must be strictly later than the floor to recreate the record.
pub fn exists(state: &State) -> bool {
    state.kind == Some(FloorKind::Whole) || state.fields.iter().any(|(_, cell)| !cell.is_removed() && compare_text(&cell.stamp, &state.floor).is_gt())
}

/// Compact a joined state. Field values retain Map order; only metadata names
/// are sorted, exactly where the source sorts them. Tombstones at the floor
/// need no extra `d` entry; the floor already carries their deletion.
pub fn kept_from(state: &State) -> Option<Kept> {
    if state.floor.is_empty() && state.fields.is_empty() { return None; }
    let mut at = state.floor.as_str();
    for (_, cell) in state.fields.iter() { at = later(at, &cell.stamp); }
    let mut meta = Meta { at: at.into(), f: (state.floor != at).then(|| state.floor.clone()), k: (state.kind == Some(FloorKind::Removed)).then_some(FloorKind::Removed), ..Meta::default() };
    let live = exists(state);
    let mut value = Fields::new();
    for (field, cell) in state.fields.iter() { if live { if let CellContent::Value(content) = &cell.content { value.insert(field, content.clone()); } } }
    let mut names: Vec<&str> = state.fields.keys().collect(); names.sort_by(|a, b| compare_text(a, b));
    for field in names {
        let cell = state.fields.get(field).expect("name came from this state");
        if cell.is_removed() {
            if compare_text(&cell.stamp, &state.floor).is_gt() { meta.d.insert(field, cell.stamp.clone()); }
        } else if live && cell.stamp != at { meta.s.insert(field, cell.stamp.clone()); }
    }
    value.order_as_object(); meta.s.order_as_object(); meta.d.order_as_object();
    Some(Kept { record_type: if live { state.record_type.clone() } else { None }, value: live.then_some(value), meta: Some(meta) })
}

#[derive(Debug, Clone)]
pub struct MissingMeta(pub crate::refusal_cause::Cause);
impl MissingMeta { pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { &self.0 } }
crate::impl_caused!(MissingMeta);
impl PartialEq for MissingMeta { fn eq(&self, _other: &Self) -> bool { true } }
impl Eq for MissingMeta {}

impl fmt::Display for MissingMeta { fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "a transported kept state requires stamps cause={}", self.0) } }
impl std::error::Error for MissingMeta {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

/// Carry the complete kept state to another copy. Legacy unstamped records
/// require their real log stamp first; never invent one from local wall time.
pub fn envelope_of_kept(id: impl Into<String>, kept: &Kept) -> Result<Envelope, MissingMeta> {
    let meta = kept.meta.as_ref().ok_or(MissingMeta(crate::cause!()))?;
    Ok(Envelope {
        id: id.into(), record_type: kept.record_type.clone(),
        body: if kept.record_type.is_none() { EnvelopeBody::Remove } else { EnvelopeBody::Whole(kept.value.clone().unwrap_or_default()) },
        at: Some(meta.at.clone()), floor: Some(meta.f.clone().unwrap_or_else(|| meta.at.clone())), floor_kind: meta.k,
        stamps: if kept.record_type.is_none() { StampMap::new() } else { meta.s.clone() }, removed: meta.d.clone(),
    })
}

/// The source compares JSON.stringify of the *whole* kept value model, including
/// insertion order. Supply that exact value model encoder when this distinction
/// matters; semantic Rust equality is deliberately a separate operation.
pub fn same_kept<E>(a: Option<&Kept>, b: Option<&Kept>, encode_kept: &impl Fn(Option<&Kept>) -> Result<Vec<u8>, E>) -> Result<bool, E> {
    Ok(encode_kept(a)? == encode_kept(b)?)
}
