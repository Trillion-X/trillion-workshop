// src/storage/record_store/cascade.rs
//
// Purpose: Erasing a record together with the records that exist only because of it: a booking link with its
// reservations, each reservation with its interval holds and its operations. A kind declares, as DATA (`settings.json`
// `erase_with`), which records are erased with one of its records; `erase_cascading` follows those rules from each
// record erased in turn, each record once, and erases every record reached in one write scope, so the whole cascade
// commits together or not at all.
//
// Ported one to one from old trillion `parts/record-log/do-work/record-log-store.mjs` (tag
// old-trillion-before-worker-retire): `erasedWith` :854 and `erase` :3611 (the waiting queue, `seen`, `also`), with the
// rule shapes of `src/record-model.json` `erase_with`:
// - `{ id: "<template with {id}>", kind? }`: a record named from this one's id;
// - `{ field: path, kind? }`: the record a field of this one names;
// - `{ kind, order, equal? }`: the records of `kind` whose one-field declared order holds this one's id, or `equal`, a
//   template where `{id}` is the id and `{key}` the id after its kind's `kind:` (old `{ type, index, equal }`).
// Dropped, and why: the old erase scrubbed a record's erasable fields and kept the record; this store's erase takes the
// whole record into custody (`RecordStore::erase`), so a cascade erases whole records. The old "only kinds with erasable
// fields are erased" is moot for the same reason: every record reached is erased. A record reached that is already
// gone is passed over.
//
// Non-Negotiable Invariants:
// - The cascade is one write scope: a refusal anywhere (an order not filled yet, a storage refusal) erases nothing.
// - Each record is erased once, whatever the number of rules that reach it; the asked record first.
// - An `order` rule reads its order only when it is filled under its current declaration (`ids_where`), so a cascade
//   never misses a child that the order does not know yet; it refuses instead.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{validate, Intent, RecordStore, Storage};
use crate::records::{Error, MAX_PAGE_ITEMS, Records};
use serde::Deserialize;
use std::collections::{HashSet, VecDeque};

/// The records erased with one record of `kind` (one DATA row).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EraseWith {
    pub kind: String,
    pub with: Vec<EraseLink>,
}
/// One rule of `EraseWith` (old `erase_with[]`).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EraseLink {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub field: Option<Vec<String>>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub order: Option<String>,
    #[serde(default)]
    pub equal: Option<String>,
}
impl EraseWith {
    pub fn valid(&self) -> bool {
        !self.kind.is_empty()
            && self.with.iter().all(|link| match (&link.id, &link.field, &link.order) {
                (Some(id), None, None) => id.contains("{id}"),
                (None, Some(field), None) => !field.is_empty(),
                (None, None, Some(order)) => !order.is_empty() && link.kind.is_some(),
                _ => false,
            })
    }
}

impl<S: Storage + Send> RecordStore<S> {
    /// The ids `rules` reach from one record (old `erasedWith`).
    fn erased_with(&self, account: &str, resource: &str, id: &str, kind: &str, value: &serde_json::Value) -> Result<Vec<String>, Error> {
        let mut out = Vec::new();
        for rule in self.settings.erase_with.iter().filter(|rule| rule.kind == kind) {
            for link in &rule.with {
                if let Some(template) = &link.id {
                    out.push(template.replace("{id}", id));
                } else if let Some(path) = &link.field {
                    let mut at = Some(value);
                    for step in path {
                        at = at.and_then(|here| here.get(step));
                    }
                    if let Some(named) = at.and_then(serde_json::Value::as_str).filter(|named| !named.is_empty()) {
                        out.push(named.to_owned());
                    }
                } else if let Some(order) = &link.order {
                    let key = id.strip_prefix(&format!("{kind}:")).unwrap_or(id);
                    let equal = link.equal.as_deref().map_or_else(|| id.to_owned(), |template| template.replace("{id}", id).replace("{key}", key));
                    out.extend(self.ids_where(account, resource, order, &serde_json::Value::String(equal), MAX_PAGE_ITEMS)?);
                }
            }
        }
        Ok(out)
    }

    /// Erase `id` and every record the `erase_with` rules reach from it, in one write scope (old `erase`): the ids
    /// erased, the asked one first. Nothing is erased when the asked record is absent.
    pub fn erase_cascading(&mut self, account: &str, resource: &str, id: &str) -> Result<Vec<String>, Error> {
        validate(account, resource, id)?;
        let intent = if self.storage.scoped() { Intent::Nested } else { Intent::Write };
        self.storage.open_scope(intent).map_err(|error| Error::Unavailable(error.cause()))?;
        let done = (|| {
            let mut erased = Vec::new();
            let mut seen = HashSet::new();
            let mut waiting = VecDeque::from([id.to_owned()]);
            while let Some(next) = waiting.pop_front() {
                if !seen.insert(next.clone()) {
                    continue;
                }
                let Some(record) = self.get(account, resource, &next)?.record else { continue };
                if let Some(kind) = self.kind_of(&record.value) {
                    waiting.extend(self.erased_with(account, resource, &next, &kind, &record.value)?);
                }
                if self.erase(account, resource, &next)?.is_some() {
                    erased.push(next);
                }
            }
            Ok(erased)
        })();
        let closed = self.storage.close_scope(done.is_ok());
        if done.is_err() {
            // The scope rolled back the stamps it minted; the scope's stamp is read again from storage.
            self.stamps.remove(&(account.to_owned(), resource.to_owned()));
        }
        let erased = done?;
        closed.map_err(super::uncertain)?;
        Ok(erased)
    }
}
