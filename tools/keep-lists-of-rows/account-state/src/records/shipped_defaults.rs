// src/records/shipped_defaults.rs
//
// Purpose: Defaults that ship with the deploy and changes that stay with the person. A reader sees the shipped value of
// an id unless the person changed it; only the change is kept in their store. Ported from Trillion-X/trillion
// src/shipped-defaults.mjs (overlayRecords, overlayFacts), deleted there by 4ffa1dc4a2 with no new home, plus
// `lay_under`, the same rule for one record whose fields a default and the person both hold.
//
// Non-Negotiable Invariants:
//   1. Nothing lives in both: a shipped value is never written into the store. An untouched default costs no row, and a
//      changed shipped value reaches every person who never touched it on the next deploy, with no row written.
//   2. The person's own value wins. Their edit is kept under the default's own id, exactly as any value of theirs, so
//      every reader that reads that id reads it unchanged; in one record, a field they keep wins, a `by_id` entry of
//      theirs replaces the shipped entry with its id, and a `switched` id they turned off stays off.
//   3. A removed default leaves one change record (`<change_kind>:<id>`, { id, removed: true, at }), so it stays gone;
//      the change record's kind is the caller's (the tool that keeps it names it; src names no record kind);
//      writing it again takes the change record away.
//   4. A write equal to the shipped value (ignoring the fields named in `ignore`) is a reset: the person's own value and
//      any change record go, and the shipped value is read again.
//   5. reset_default(id) goes back to the shipped value; changes_from_defaults() lists every shipped id the person
//      changed; changed(id) says whether one id was.
//   6. Change records are written unwatched: they are about the defaults, never a record anyone's rules look at.
//   7. A field read of a kind with shipped values is refused (`refuses_field_read`), so a reader never gets an answer
//      that silently leaves the defaults out.
//
// Key Concepts: the layer never knows what a default is about: which ids ship, with which values, and how a record's
// lists are laid under the person's own are handed in (the default publisher's rows, the tools repository's
// tools/starting-set/shipped-defaults.json). Its field names are this module's settings.json.
//
// Security Considerations: a read through the layer writes nothing; the store is byte-equal before and after.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::ecma_json::{JsString, Object, Value};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

#[derive(Deserialize)]
struct ChangeFields {
    id: String,
    removed: String,
    at: String,
}

#[derive(Deserialize)]
struct RowFields {
    record: String,
    value: String,
    merge: String,
    by_id: String,
    switched: String,
    field: String,
    off_in: String,
    id: String,
    on: String,
}

#[derive(Deserialize)]
struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    change: ChangeFields,
    row: RowFields,
    max_depth: usize,
}

fn settings() -> &'static Settings {
    static SETTINGS: OnceLock<Settings> = OnceLock::new();
    SETTINGS.get_or_init(|| {
        serde_json::from_str(include_str!("shipped_defaults/settings.json"))
            .expect("src/records/shipped_defaults/settings.json is well formed")
    })
}

fn key(name: &str) -> JsString {
    JsString::from(name)
}
fn get<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(object) => object.get(&key(name)),
        _ => None,
    }
}
fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => s.to_rust_string().ok(),
        _ => None,
    }
}
fn list(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}
fn id_of(value: &Value) -> Option<String> {
    get(value, &settings().row.id).and_then(text)
}

/// The record label a published default is laid under (its row's `record`).
pub fn record_of(row: &Value) -> Option<String> {
    get(row, &settings().row.record).and_then(text)
}

/// Equal as data whatever order the keys were kept in, leaving out the named fields at the top level
/// (shipped-defaults.mjs `sameValue`).
pub fn same_value(left: Option<&Value>, right: Option<&Value>, ignore: &[&str]) -> bool {
    fn canonical(value: &Value, depth: usize, out: &mut String) -> bool {
        if depth > settings().max_depth {
            return false;
        }
        match value {
            Value::Object(object) => {
                let mut entries: Vec<_> = object.insertion_entries().collect();
                entries.sort_by(|(a, _), (b, _)| a.units().cmp(b.units()));
                out.push('{');
                for (name, child) in entries {
                    out.push_str(&format!("{:?}", name.units()));
                    out.push(':');
                    if !canonical(child, depth + 1, out) {
                        return false;
                    }
                    out.push(',');
                }
                out.push('}');
            }
            Value::Array(items) => {
                out.push('[');
                for child in items {
                    if !canonical(child, depth + 1, out) {
                        return false;
                    }
                    out.push(',');
                }
                out.push(']');
            }
            Value::String(s) => out.push_str(&format!("s{:?}", s.units())),
            Value::Number(n) => out.push_str(&format!("n{}", n.to_bits())),
            Value::Bool(b) => out.push_str(if *b { "t" } else { "f" }),
            Value::Null => out.push('z'),
        }
        true
    }
    let without = |value: Option<&Value>| -> Value {
        match value {
            Some(Value::Object(object)) => {
                let mut kept = Object::new();
                for (name, child) in object.insertion_entries() {
                    if !ignore.iter().any(|field| name.units() == key(field).units()) {
                        kept.insert(name.clone(), child.clone());
                    }
                }
                Value::Object(kept)
            }
            Some(other) => other.clone(),
            None => Value::Null,
        }
    };
    let (mut a, mut b) = (String::new(), String::new());
    canonical(&without(left), 0, &mut a) && canonical(&without(right), 0, &mut b) && a == b
}

/// Lay one published default under the person's own record of the same label. With no record of theirs, the shipped
/// fields are the record; with one, every field they keep wins, except the lists the row's `merge` names: a `by_id`
/// list keeps the shipped entries (each replaced where it stood by the person's entry with its id) and then the person's
/// own, and a `switched` list keeps the person's ids and then every shipped id not already there that the person's
/// `off_in` map does not hold with `on` false. Nothing is written: the answer is a new value.
pub fn lay_under(row: &Value, own: Option<&Value>) -> Option<Value> {
    let fields = &settings().row;
    let Some(Value::Object(shipped)) = get(row, &fields.value) else {
        return own.cloned();
    };
    let merge = get(row, &fields.merge);
    let by_id: BTreeSet<String> = list(merge.and_then(|m| get(m, &fields.by_id))).iter().filter_map(text).collect();
    let switched: BTreeMap<String, String> = list(merge.and_then(|m| get(m, &fields.switched)))
        .iter()
        .filter_map(|s| Some((get(s, &fields.field).and_then(text)?, get(s, &fields.off_in).and_then(text)?)))
        .collect();
    let own = match own {
        Some(Value::Object(object)) => object.clone(),
        _ => Object::new(),
    };
    let mut out = own.clone();
    for (name, value) in shipped.insertion_entries() {
        let field = name.to_rust_string().unwrap_or_default();
        let mine = own.get(name);
        if by_id.contains(&field) {
            let mine = list(mine);
            let mut kept: Vec<Value> = list(Some(value))
                .iter()
                .map(|entry| match id_of(entry) {
                    Some(id) => mine.iter().find(|m| id_of(m).as_deref() == Some(&id)).unwrap_or(entry).clone(),
                    None => entry.clone(),
                })
                .collect();
            let shipped_ids: BTreeSet<String> = list(Some(value)).iter().filter_map(id_of).collect();
            kept.extend(mine.iter().filter(|m| id_of(m).is_none_or(|id| !shipped_ids.contains(&id))).cloned());
            out.insert(name.clone(), Value::Array(kept));
        } else if let Some(off_in) = switched.get(&field) {
            let off = own.get(&key(off_in));
            let mut kept: Vec<Value> = list(mine).to_vec();
            for id in list(Some(value)) {
                let Some(word) = text(id) else { continue };
                let present = kept.iter().any(|k| text(k).as_deref() == Some(&word));
                let turned_off = off
                    .and_then(|o| get(o, &word))
                    .is_some_and(|entry| matches!(get(entry, &fields.on), Some(Value::Bool(false))));
                if !present && !turned_off {
                    kept.push(id.clone());
                }
            }
            out.insert(name.clone(), Value::Array(kept));
        } else if mine.is_none() {
            out.insert(name.clone(), value.clone());
        }
    }
    Some(Value::Object(out))
}

/// One write to the store under the layer: `value` None removes the record.
#[derive(Clone, PartialEq)]
pub struct Entry {
    pub id: String,
    pub kind: String,
    pub value: Option<Value>,
}

/// The store's own records ({ read, typeOf, ids, write } of shipped-defaults.mjs).
pub trait OwnRecords {
    fn read(&self, id: &str) -> Option<Value>;
    fn kind_of(&self, id: &str) -> Option<String>;
    fn ids(&self, kind: &str) -> Vec<String>;
    /// `unwatched` marks change records (invariant 6).
    fn write(&mut self, entries: Vec<Entry>, unwatched: bool);
}

/// One shipped default: its kind and value.
#[derive(Clone)]
pub struct Shipped {
    pub kind: String,
    pub value: Value,
}

/// overlayRecords: the store's records with the shipped defaults read through them.
pub struct OverlayRecords<S> {
    pub store: S,
    shipped: BTreeMap<String, Shipped>,
    change_kind: String,
    ignore: Vec<String>,
}

/// How one shipped id was changed by the person.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    Edited,
    Removed,
}

impl<S: OwnRecords> OverlayRecords<S> {
    /// `change_kind` is the record kind of the change record a removed default leaves, named by the tool that keeps it.
    pub fn new(store: S, shipped: BTreeMap<String, Shipped>, change_kind: &str, ignore: &[&str]) -> Self {
        Self { store, shipped, change_kind: change_kind.to_owned(), ignore: ignore.iter().map(|s| (*s).to_owned()).collect() }
    }
    fn change_id(&self, id: &str) -> String {
        format!("{}:{id}", self.change_kind)
    }
    fn removed(&self) -> BTreeSet<String> {
        let change = &settings().change;
        self.store
            .ids(&self.change_kind)
            .iter()
            .filter_map(|id| self.store.read(id))
            .filter(|c| matches!(get(c, &change.removed), Some(Value::Bool(true))))
            .filter_map(|c| get(&c, &change.id).and_then(text))
            .collect()
    }
    fn shipped_of(&self, id: &str) -> Option<&Shipped> {
        self.shipped.get(id).filter(|_| !self.removed().contains(id))
    }
    /// Replace only the shared definitions (a new deploy); the person's edits and removals stay in the store.
    pub fn replace_defaults(&mut self, next: BTreeMap<String, Shipped>) -> bool {
        let same = next.len() == self.shipped.len()
            && next.iter().all(|(id, n)| {
                self.shipped.get(id).is_some_and(|o| o.kind == n.kind && same_value(Some(&o.value), Some(&n.value), &[]))
            });
        if !same {
            self.shipped = next;
        }
        !same
    }
    pub fn read(&self, id: &str) -> Option<Value> {
        self.store.read(id).or_else(|| self.shipped_of(id).map(|s| s.value.clone()))
    }
    pub fn kind_of(&self, id: &str) -> Option<String> {
        self.store.kind_of(id).or_else(|| self.shipped_of(id).map(|s| s.kind.clone()))
    }
    /// The store's ids of a kind, then every shipped id of that kind the person kept no value of and did not remove.
    pub fn ids(&self, kind: &str) -> Vec<String> {
        let mut own = self.store.ids(kind);
        let removed = self.removed();
        let seen: BTreeSet<String> = own.iter().cloned().collect();
        own.extend(
            self.shipped
                .iter()
                .filter(|(id, s)| s.kind == kind && !seen.contains(*id) && !removed.contains(*id))
                .map(|(id, _)| id.clone()),
        );
        own
    }
    /// A field read (by kind) is the store's own only for a kind that ships no values (invariant 7).
    pub fn refuses_field_read(&self, kind: &str) -> bool {
        self.shipped.values().any(|s| s.kind == kind)
    }
    fn write_change(&mut self, id: &str, removed_at: Option<&str>) {
        let change = &settings().change;
        if removed_at.is_none() && self.store.kind_of(&self.change_id(id)).is_none() {
            return;
        }
        let value = removed_at.map(|at| {
            let mut v = Object::new();
            v.insert(key(&change.id), Value::String(key(id)));
            v.insert(key(&change.removed), Value::Bool(true));
            v.insert(key(&change.at), Value::String(key(at)));
            Value::Object(v)
        });
        self.store.write(
            vec![Entry { id: self.change_id(id), kind: self.change_kind.clone(), value }],
            true,
        );
    }
    /// Write through the layer (invariants 2-4); `now` is the time a removal is stamped with.
    pub fn write(&mut self, entries: Vec<Entry>, now: &str) {
        let ignored = self.ignore.clone();
        let ignore: Vec<&str> = ignored.iter().map(String::as_str).collect();
        let mut passed = Vec::new();
        for entry in entries {
            let Some(original) = self.shipped.get(&entry.id).cloned() else {
                passed.push(entry);
                continue;
            };
            let own = self.store.kind_of(&entry.id).is_some();
            match &entry.value {
                None => {
                    if own {
                        passed.push(entry.clone());
                    }
                    self.write_change(&entry.id, Some(now));
                }
                Some(value) if same_value(Some(value), Some(&original.value), &ignore) => {
                    if own {
                        passed.push(Entry { value: None, ..entry.clone() });
                    }
                    self.write_change(&entry.id, None);
                }
                Some(_) => {
                    passed.push(entry.clone());
                    self.write_change(&entry.id, None);
                }
            }
        }
        if !passed.is_empty() {
            self.store.write(passed, false);
        }
    }
    pub fn reset_default(&mut self, id: &str) -> bool {
        let Some(original) = self.shipped.get(id).cloned() else { return false };
        if self.store.kind_of(id).is_some() {
            self.store.write(vec![Entry { id: id.to_owned(), kind: original.kind, value: None }], false);
        }
        self.write_change(id, None);
        true
    }
    pub fn changed(&self, id: &str) -> bool {
        self.shipped.contains_key(id) && (self.removed().contains(id) || self.store.kind_of(id).is_some())
    }
    pub fn changes_from_defaults(&self) -> Vec<(String, Change)> {
        let removed = self.removed();
        self.shipped
            .keys()
            .filter_map(|id| {
                if removed.contains(id) {
                    Some((id.clone(), Change::Removed))
                } else if self.store.kind_of(id).is_some() {
                    Some((id.clone(), Change::Edited))
                } else {
                    None
                }
            })
            .collect()
    }
    pub fn shipped(&self, id: &str) -> Option<&Value> {
        self.shipped.get(id).map(|s| &s.value)
    }
}

/// The newest value per name ({ read, list, write, reset } of shipped-defaults.mjs overlayFacts).
pub trait Facts {
    fn read(&self, name: &str) -> Option<Value>;
    fn list(&self, prefix: &str) -> Vec<Value>;
    fn write(&mut self, name: &str, value: Value);
    fn reset(&mut self, name: &str);
}

/// overlayFacts: the facts under `prefix` with the shipped values (worked out at each read by `shipped`) read through
/// them. A removal is the person's own value (whatever the reader writes for it), so it needs no change record.
pub struct OverlayFacts<F, D, N> {
    pub facts: F,
    shipped: D,
    prefix: String,
    name_of: N,
    ignore: Vec<String>,
}

impl<F: Facts, D: Fn() -> BTreeMap<String, Value>, N: Fn(&Value) -> Option<String>> OverlayFacts<F, D, N> {
    pub fn new(facts: F, shipped: D, prefix: &str, name_of: N, ignore: &[&str]) -> Self {
        Self { facts, shipped, prefix: prefix.to_owned(), name_of, ignore: ignore.iter().map(|s| (*s).to_owned()).collect() }
    }
    pub fn read(&self, name: &str) -> Option<Value> {
        match self.facts.read(name) {
            Some(own) if !matches!(own, Value::Null) => Some(own),
            _ if name.starts_with(&self.prefix) => (self.shipped)().get(name).cloned(),
            _ => None,
        }
    }
    pub fn list(&self, asked: &str) -> Vec<Value> {
        let mut own: Vec<Value> = self.facts.list(asked).into_iter().filter(|v| !matches!(v, Value::Null)).collect();
        if asked != self.prefix {
            return own;
        }
        let named: BTreeSet<String> = own.iter().filter_map(&self.name_of).collect();
        own.extend((self.shipped)().into_iter().filter(|(name, _)| !named.contains(name)).map(|(_, v)| v));
        own
    }
    pub fn write(&mut self, name: &str, value: Value) {
        let ignore: Vec<&str> = self.ignore.iter().map(String::as_str).collect();
        let original = if name.starts_with(&self.prefix) { (self.shipped)().get(name).cloned() } else { None };
        if original.is_some() && !matches!(value, Value::Null) && same_value(Some(&value), original.as_ref(), &ignore) {
            return self.facts.reset(name);
        }
        self.facts.write(name, value)
    }
    pub fn reset_default(&mut self, name: &str) -> bool {
        if !(self.shipped)().contains_key(name) {
            return false;
        }
        self.facts.reset(name);
        true
    }
    pub fn changes_from_defaults(&self) -> Vec<(String, Change)> {
        let removed = &settings().change.removed;
        (self.shipped)()
            .keys()
            .filter_map(|name| {
                let own = self.facts.read(name).filter(|v| !matches!(v, Value::Null))?;
                let change =
                    if matches!(get(&own, removed), Some(Value::Bool(true))) { Change::Removed } else { Change::Edited };
                Some((name.clone(), change))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests;
