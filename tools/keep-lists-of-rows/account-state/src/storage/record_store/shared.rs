// src/storage/record_store/shared.rs
//
// Purpose: Content-addressed shared child objects, stored once: an object under a field (at any depth) of a kind the DATA names
// (`settings.json` `shared_children`) is kept in `kept_shared_objects` under its content identity (`1f:` + BLAKE3 of its
// canonical JSON) and the record holds only a link to it, so a child many records hold is stored once whatever their
// number. Reads put the child back whole, through a byte-bounded memory of shared values, each child's stored size
// checked against the read's expansion budget before it is parsed.
//
// Ported from old trillion `parts/eeaf/do-work/eeaf-sqlite-store.mjs` (tag old-trillion-before-worker-retire):
// `contentId` (:42, :341), `decompose` storing a shared child once (:311-314), the shared-object LRU
// (`sharedCacheBytes`) and the expansion budget (`sharedExpansionBytes`), with their tests in
// test/eeaf-memory-bounds.test.mjs and test/eeaf-selected-fields.test.mjs.
//
// Non-Negotiable Invariants:
// - Only a kind and field the DATA names share; any other record is written exactly as given.
// - A shared child is written only when its identity is absent (`When::Absent`), in the same write scope as the record
//   that links it, so a refused record write leaves no new child behind and an equal child is never written twice.
// - The link is `{"\u0000shared": "1f:<hex>"}`: a key no JSON a person writes through the doors holds unescaped, so it
//   is never mistaken for a value; a read answers the child, never the link.
// - The memory hands out copies, holds at most `bytes` of shared values, and never keeps one larger than that; a child
//   larger than the read's expansion budget is refused (`TooLarge`) before it is parsed, and reads whole with a larger one.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::partial::PartialError;
use super::{text, unavailable, validate, Field, Intent, RecordStore, Storage, Value, When};
use crate::records::{Change, Error, Mutation, Records};
use content_crypto::advanced::blake3;
use serde::Deserialize;
use std::collections::{HashMap, VecDeque};

const SHARED: &str = "kept_shared_objects";
/// The key of a link to a shared child.
pub const LINK: &str = "\u{0}shared";

/// One DATA row: the top-level object fields of `kind` stored once by content.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SharedChildren {
    pub kind: String,
    pub fields: Vec<String>,
}

/// The content identity of a child: `1f:` and the BLAKE3 hex of its canonical JSON (keys in order).
pub fn content_id(child: &serde_json::Value) -> String {
    format!("1f:{}", blake3::hash(serde_json::to_string(child).unwrap_or_default().as_bytes()).to_hex())
}
fn link_of(value: &serde_json::Value) -> Option<&str> {
    let object = value.as_object()?;
    (object.len() == 1).then(|| object.get(LINK)?.as_str()).flatten()
}

/// A byte-bounded memory of shared values (old `sharedCacheBytes`).
pub struct SharedMemory {
    bytes: usize,
    held: HashMap<String, (usize, serde_json::Value)>,
    order: VecDeque<String>,
    used: usize,
}
impl SharedMemory {
    pub fn new(bytes: usize) -> Self {
        SharedMemory { bytes, held: HashMap::new(), order: VecDeque::new(), used: 0 }
    }
    /// How many shared values and stored bytes the memory holds.
    pub fn held(&self) -> (usize, usize) {
        (self.held.len(), self.used)
    }
    fn remember(&mut self, id: &str, size: usize, value: &serde_json::Value) {
        if size > self.bytes || self.held.contains_key(id) {
            return;
        }
        while self.used + size > self.bytes {
            let Some(oldest) = self.order.pop_front() else { break };
            if let Some((gone, _)) = self.held.remove(&oldest) {
                self.used -= gone;
            }
        }
        self.used += size;
        self.held.insert(id.to_string(), (size, value.clone()));
        self.order.push_back(id.to_string());
    }
    /// A remembered child as stored (its nested links not yet put back) with its stored size.
    fn recall(&mut self, id: &str) -> Option<(usize, serde_json::Value)> {
        let held = self.held.get(id)?.clone();
        self.order.retain(|known| known != id);
        self.order.push_back(id.to_string());
        Some(held)
    }
    /// Let every remembered value go (old `forgetCached`): after a rolled-back write the caller forgets, and the byte
    /// count is back to zero.
    pub fn forget(&mut self) {
        self.held.clear();
        self.order.clear();
        self.used = 0;
    }
}

/// Store every object under a named field once by content, innermost first, at any depth of `value` (old `decompose`
/// called `contentId` on every nested object, :311-314): an outer child links its inner children before its own identity
/// is taken, so equal outer children with equal inner children share both.
fn share(value: &mut serde_json::Value, fields: &[String], children: &mut Vec<(String, Vec<u8>)>) -> Result<(), Error> {
    match value {
        serde_json::Value::Object(object) => {
            for (key, slot) in object.iter_mut() {
                share(slot, fields, children)?;
                if slot.is_object() && link_of(slot).is_none() && fields.iter().any(|field| field == key) {
                    let id = content_id(slot);
                    if !children.iter().any(|(known, _)| known == &id) {
                        children.push((id.clone(), serde_json::to_vec(slot).map_err(|_| Error::Invalid("a shared child is not JSON", crate::cause!()))?));
                    }
                    *slot = serde_json::json!({ LINK: id });
                }
            }
        }
        serde_json::Value::Array(list) => {
            for slot in list {
                share(slot, fields, children)?;
            }
        }
        _ => {}
    }
    Ok(())
}

impl<S: Storage + Send> RecordStore<S> {
    fn shared_fields(&self, value: &serde_json::Value) -> Vec<String> {
        let kind = value.get(self.settings.kind_field.as_str()).and_then(serde_json::Value::as_str);
        self.settings.shared_children.iter().filter(|row| Some(row.kind.as_str()) == kind).flat_map(|row| row.fields.clone()).collect()
    }

    /// Write a record, storing each object under a field its kind's DATA names once by content and linking it, at any
    /// depth of the record (one write scope).
    pub fn mutate_sharing(&mut self, account: &str, resource: &str, mut input: Mutation) -> Result<Change, Error> {
        validate(account, resource, &input.id)?;
        let fields = self.shared_fields(&input.value);
        if fields.is_empty() {
            return self.mutate(account, resource, input);
        }
        let mut children = Vec::new();
        share(&mut input.value, &fields, &mut children)?;
        let intent = if self.storage.scoped() { Intent::Nested } else { Intent::Write };
        self.storage.open_scope(intent).map_err(|error| Error::Unavailable(error.cause()))?;
        let done = (|| {
            for (id, body) in &children {
                let row = [("account", text(account)), ("resource", text(resource)), ("id", text(id)), ("body", Value::Blob(body.clone()))];
                self.storage.put(SHARED, &row, When::Absent).map_err(unavailable)?;
            }
            self.mutate(account, resource, input)
        })();
        let closed = self.storage.close_scope(done.is_ok());
        let change = done?;
        closed.map_err(super::uncertain)?;
        Ok(change)
    }

    /// How many shared children the scope holds.
    pub fn shared_count(&self, account: &str, resource: &str) -> Result<u64, Error> {
        let scope = vec![text(account), text(resource)];
        let range = super::Range { order: super::Order::Key, from: super::Bound::Included(scope.clone()), to: super::Bound::Included(scope), reverse: false, limit: None };
        self.storage.count(SHARED, &range).map_err(unavailable)
    }

    /// A live record with its shared children put back whole, nested ones too.
    ///
    /// `expansion` is one budget for the whole answer (old `sharedExpansionBytes`, the caller's remaining allowance): the
    /// record's own stored body counts first, then every child each time it is put back (a child linked eight times
    /// counts eight times, old 'nested shared fan-out'). A child is taken from `memory` or else read within what is left
    /// of the budget, so a cold child larger than what is left is refused before it leaves storage and before it is
    /// parsed; a remembered child is charged its stored size the same way, so whether the memory is warm, cold or
    /// cleared never changes which reads are admitted (old 'shared read admission is stable').
    pub fn get_sharing(&self, account: &str, resource: &str, id: &str, memory: &mut SharedMemory, expansion: usize) -> Result<Option<serde_json::Value>, PartialError> {
        let Some(own) = self.record_size(account, resource, id)? else { return Ok(None) };
        let own = usize::try_from(own).unwrap_or(usize::MAX);
        if own > expansion {
            return Err(PartialError::TooLarge { cause: crate::cause!(), bytes: own as u64 });
        }
        let mut left = expansion - own;
        let Some(record) = self.get(account, resource, id)?.record else { return Ok(None) };
        let mut value = record.value;
        self.expand(account, resource, &mut value, memory, &mut left)?;
        Ok(Some(value))
    }

    fn expand(&self, account: &str, resource: &str, slot: &mut serde_json::Value, memory: &mut SharedMemory, left: &mut usize) -> Result<(), PartialError> {
        if let Some(link) = link_of(slot).map(str::to_owned) {
            let (size, mut child) = match memory.recall(&link) {
                Some(held) => held,
                None => {
                    let row = self
                        .storage
                        .get(SHARED, &[text(account), text(resource), text(&link)], &[Field::at_most("body", *left)])
                        .map_err(unavailable)?
                        .ok_or(PartialError::from(crate::cause!(Error::Unavailable)))?;
                    let body = match row.0.into_iter().next() {
                        Some(Value::Blob(body)) => body,
                        Some(Value::Oversized(bytes)) => return Err(PartialError::ChildTooLarge { cause: crate::cause!(), id: link, bytes }),
                        _ => return Err(PartialError::from(crate::cause!(Error::Unavailable))),
                    };
                    let child: serde_json::Value = serde_json::from_slice(&body).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                    memory.remember(&link, body.len(), &child);
                    (body.len(), child)
                }
            };
            if size > *left {
                return Err(PartialError::ChildTooLarge { cause: crate::cause!(), id: link, bytes: size as u64 });
            }
            *left -= size;
            self.expand(account, resource, &mut child, memory, left)?;
            *slot = child;
            return Ok(());
        }
        match slot {
            serde_json::Value::Object(object) => object.values_mut().try_for_each(|inner| self.expand(account, resource, inner, memory, left)),
            serde_json::Value::Array(list) => list.iter_mut().try_for_each(|inner| self.expand(account, resource, inner, memory, left)),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
#[path = "shared_tests.rs"]
mod tests;
