// src/storage/record_store/partial.rs
//
// Purpose: Read and write part of a record without the whole of it: a record's size without reading it, the named
// top-level fields of a record (`read_selected`), every field but some (`read_own`, `write_own`), and the members of
// one list field (`member_count`, `read_member`, `write_member`, `members_where`), each with a byte budget checked
// before anything is parsed; and a bounded memory of whole records already read (`RecordMemory`, an LRU by count and
// bytes) that answers an unchanged record again without reading its body.
//
// Ported from old trillion `parts/eeaf/do-work/eeaf-sqlite-store.mjs` (tag old-trillion-before-worker-retire):
// `readSelected` :853, `readOwn` :893, `memberCount`/`readMember` :904-915, `membersWhere` :931, `writeOwn` :936,
// `writeMember` :948, `sizeOf` :457, and the record-rows LRU with its allocation budget checked before `JSON.parse`
// (`createRecordMemory`, `test/eeaf-memory-bounds.test.mjs`, `test/eeaf-record-memory.test.mjs`). The old store
// decomposed each record into rows, so a partial read was a range of rows; the record store that is live for own records
// keeps one JSON body per version, so here a partial read is one bounded read of the body and a borrowed parse of its
// top level (`serde_json::value::RawValue`): an unrequested field is skipped as raw text and never decoded, and only
// the asked fields are decoded, after their raw sizes passed the budget.
//
// Non-Negotiable Invariants:
// - A record's stored size is answered without reading its body (`Read::at_most(body, 0)` answers the length only).
// - A body larger than the read's budget is refused before it leaves storage; selected fields larger together than the
//   budget are refused before any of them is decoded (`TooLarge` carries the bytes found).
// - A selected read answers exactly the asked fields that are present: null and false are present, an absent field is
//   left out, a repeated name is one field, an empty name is refused.
// - A partial write changes only its fields: `write_own` keeps every omitted field as stored, `write_member` replaces one
//   member or appends at the end (never a gap) of a list field that is a list, through the ordinary compare-and-set write.
// - The memory hands out copies, holds at most `count` records and `bytes` of their stored bodies, never keeps a record
//   larger than its byte bound, and answers a record again only at the same storage mark and scope stamp it was read at.
//
// Security Considerations:
// - These reads answer stored values like `get` does; the caller opens sealed fields and decides admission.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

#[cfg_attr(hosted_records, allow(unused_imports))]
use super::{text, unavailable, validate, Field, RecordStore, Storage, Value, CURRENT, VERSIONS};
use crate::records::{Error, Mutation, Records};
use serde_json::value::RawValue;
use std::collections::{BTreeMap, HashMap, VecDeque};

/// Why a partial read refused.
#[derive(Debug)]
pub enum PartialError {
    Store(Error, crate::refusal_cause::Cause),
    /// The body or the selected fields are larger than the read's budget: the bytes found.
    TooLarge { cause: crate::refusal_cause::Cause, bytes: u64 },
    /// A shared child (`shared.rs`) is larger than what is left of the read's expansion budget: its content id and the
    /// bytes found (old `record_too_large` with the child's `record_id`).
    ChildTooLarge { cause: crate::refusal_cause::Cause, id: String, bytes: u64 },
    /// The asked field is not what the operation needs (not a list, not an object member, a gap).
    Shape(&'static str, crate::refusal_cause::Cause),
}
impl PartialError {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Store(_, cause) => cause.clone(),
            Self::TooLarge { cause, .. } => cause.clone(),
            Self::ChildTooLarge { cause, .. } => cause.clone(),
            Self::Shape(_, cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(PartialError);


impl PartialEq for PartialError {
    fn eq(&self, other: &Self) -> bool {
        match (self,other) {
            (Self::Store(a0, _),Self::Store(b0, _)) => a0 == b0,
            (Self::TooLarge { bytes: a0, .. }, Self::TooLarge { bytes: b0, .. }) => a0 == b0,
            (Self::ChildTooLarge { id: a0, bytes: a1, .. }, Self::ChildTooLarge { id: b0, bytes: b1, .. }) => a0 == b0 && a1 == b1,
            (Self::Shape(a0, _),Self::Shape(b0, _)) => a0 == b0,
            _ => false,
        }
    }
}

impl From<Error> for PartialError {
    fn from(error: Error) -> Self {
        let cause = error.cause();
        Self::Store(error, cause)
    }
}
type Result<T> = std::result::Result<T, PartialError>;

/// The current row of a record: its version, whether it is a tombstone, and its body bounded by `at_most`.
struct Current {
    version: i64,
    deleted: bool,
    body: Value,
}

fn names_valid(names: &[&str]) -> Result<()> {
    if names.iter().any(|name| name.is_empty()) {
        return Err(PartialError::Shape("Selected fields must name fields", crate::cause!()));
    }
    Ok(())
}
fn top_level(body: &[u8]) -> Result<BTreeMap<String, &RawValue>> {
    let text = std::str::from_utf8(body).map_err(|_| PartialError::from(crate::cause!(Error::Unavailable)))?;
    serde_json::from_str::<BTreeMap<String, &RawValue>>(text).map_err(|_| PartialError::Shape("the record is not an object", crate::cause!()))
}
fn decode(raw: &RawValue) -> Result<serde_json::Value> {
    serde_json::from_str(raw.get()).map_err(|_| PartialError::from(crate::cause!(Error::Unavailable)))
}

impl<S: Storage> RecordStore<S> {
    fn current_bounded(&self, account: &str, resource: &str, id: &str, at_most: usize) -> Result<Option<Current>> {
        validate(account, resource, id)?;
        let key = [text(account), text(resource), text(id), Value::Integer(CURRENT)];
        let read = [Field::whole("version"), Field::whole("deleted"), Field::at_most("body", at_most)];
        let Some(mut row) = self.get_row(&key, &read).map_err(unavailable)? else { return Ok(None) };
        let version = row.take(0).as_integer().ok_or(crate::cause!(Error::Unavailable))?;
        let deleted = row.take(1).as_integer().ok_or(crate::cause!(Error::Unavailable))? != 0;
        Ok(Some(Current { version, deleted, body: row.take(2) }))
    }
    /// The body of a live record within `budget` bytes: None when there is no live record.
    fn live_body(&self, account: &str, resource: &str, id: &str, budget: usize) -> Result<Option<(i64, Vec<u8>)>> {
        let Some(current) = self.current_bounded(account, resource, id, budget)? else { return Ok(None) };
        if current.deleted {
            return Ok(None);
        }
        match current.body {
            Value::Blob(bytes) => Ok(Some((current.version, bytes))),
            Value::Oversized(bytes) => Err(PartialError::TooLarge { cause: crate::cause!(), bytes }),
            _ => Err(PartialError::from(crate::cause!(Error::Unavailable))),
        }
    }

    /// The members of one list field, each as stored text (never decoded here).
    fn members<'b>(body: &'b [u8], field: &str) -> Result<Option<Vec<&'b RawValue>>> {
        let fields = top_level(body)?;
        let Some(raw) = fields.get(field) else { return Ok(None) };
        let list: Vec<&RawValue> = serde_json::from_str(raw.get()).map_err(|_| PartialError::Shape("the field is not a list", crate::cause!()))?;
        Ok(Some(list))
    }
    /// How many members a list field holds (0 when the record or the field is absent).
    pub fn member_count(&self, account: &str, resource: &str, id: &str, field: &str, body_budget: usize) -> Result<usize> {
        let Some((_, body)) = self.live_body(account, resource, id, body_budget)? else { return Ok(0) };
        Ok(Self::members(&body, field)?.map_or(0, |list| list.len()))
    }
    /// One member of a list field, decoded alone (None past the end).
    pub fn read_member(&self, account: &str, resource: &str, id: &str, field: &str, ordinal: usize, body_budget: usize) -> Result<Option<serde_json::Value>> {
        let Some((_, body)) = self.live_body(account, resource, id, body_budget)? else { return Ok(None) };
        let Some(list) = Self::members(&body, field)? else { return Ok(None) };
        list.get(ordinal).map(|raw| decode(raw)).transpose()
    }
    /// The ordinals of the members of a list field whose own field `name` holds exactly `value` (old `membersWhere`).
    pub fn members_where(&self, account: &str, resource: &str, id: &str, field: &str, name: &str, value: &serde_json::Value, body_budget: usize) -> Result<Vec<usize>> {
        let Some((_, body)) = self.live_body(account, resource, id, body_budget)? else { return Ok(Vec::new()) };
        let Some(list) = Self::members(&body, field)? else { return Ok(Vec::new()) };
        let mut found = Vec::new();
        for (ordinal, raw) in list.iter().enumerate() {
            let Ok(member) = serde_json::from_str::<BTreeMap<String, &RawValue>>(raw.get()) else { continue };
            if let Some(held) = member.get(name) {
                if &decode(held)? == value {
                    found.push(ordinal);
                }
            }
        }
        Ok(found)
    }
    /// The named fields of an object list's members, by ordinal, only members that hold one of them; `ordinals` picks
    /// members (old trillion record-log-store.mjs / eeaf-sqlite-store.mjs:913 `memberFields`). The body is read within
    /// `body_budget` and only the asked members' asked fields are decoded.
    pub fn member_fields(&self, account: &str, resource: &str, id: &str, field: &str, names: &[&str], ordinals: Option<&[usize]>, body_budget: usize)
        -> Result<Vec<(usize, serde_json::Map<String, serde_json::Value>)>> {
        names_valid(names)?;
        if names.is_empty() || ordinals.is_some_and(<[usize]>::is_empty) {
            return Ok(Vec::new());
        }
        let Some((_, body)) = self.live_body(account, resource, id, body_budget)? else { return Ok(Vec::new()) };
        let Some(list) = Self::members(&body, field)? else { return Ok(Vec::new()) };
        let mut found = Vec::new();
        for (ordinal, raw) in list.iter().enumerate() {
            if ordinals.is_some_and(|picked| !picked.contains(&ordinal)) {
                continue;
            }
            let Ok(member) = serde_json::from_str::<BTreeMap<String, &RawValue>>(raw.get()) else { continue };
            let mut held = serde_json::Map::new();
            for name in names {
                if let Some(raw) = member.get(*name) {
                    held.insert((*name).to_owned(), decode(raw)?);
                }
            }
            if !held.is_empty() {
                found.push((ordinal, held));
            }
        }
        Ok(found)
    }
    /// The stored size of a live record's value in bytes, without reading it (old `sizeOf`); None when there is none.
    pub fn record_size(&self, account: &str, resource: &str, id: &str) -> Result<Option<u64>> {
        let Some(current) = self.current_bounded(account, resource, id, 0)? else { return Ok(None) };
        if current.deleted {
            return Ok(None);
        }
        match current.body {
            Value::Oversized(bytes) => Ok(Some(bytes)),
            Value::Blob(bytes) => Ok(Some(bytes.len() as u64)),
            _ => Err(PartialError::from(crate::cause!(Error::Unavailable))),
        }
    }

    /// The named top-level fields of a live record (old `readSelected`): None when there is none. The body is read
    /// within `body_budget`, and the selected fields' stored text together must fit `budget` before any is decoded.
    pub fn read_selected(&self, account: &str, resource: &str, id: &str, names: &[&str], body_budget: usize, budget: usize) -> Result<Option<serde_json::Map<String, serde_json::Value>>> {
        names_valid(names)?;
        let Some((_, body)) = self.live_body(account, resource, id, body_budget)? else { return Ok(None) };
        let fields = top_level(&body)?;
        let mut chosen: Vec<(&str, &RawValue)> = Vec::new();
        for name in names {
            if chosen.iter().any(|(known, _)| known == name) {
                continue;
            }
            if let Some(raw) = fields.get(*name) {
                chosen.push((name, raw));
            }
        }
        let bytes: u64 = chosen.iter().map(|(_, raw)| raw.get().len() as u64).sum();
        if bytes > budget as u64 {
            return Err(PartialError::TooLarge { cause: crate::cause!(), bytes });
        }
        let mut answer = serde_json::Map::new();
        for (name, raw) in chosen {
            answer.insert(name.to_string(), decode(raw)?);
        }
        Ok(Some(answer))
    }

    /// Every top-level field of a live record but the `omit`ted ones (old `readOwn`); an omitted field is never decoded,
    /// and the rest must fit `budget`.
    pub fn read_own(&self, account: &str, resource: &str, id: &str, omit: &[&str], body_budget: usize, budget: usize) -> Result<Option<serde_json::Map<String, serde_json::Value>>> {
        names_valid(omit)?;
        let Some((_, body)) = self.live_body(account, resource, id, body_budget)? else { return Ok(None) };
        let fields = top_level(&body)?;
        let kept: Vec<(&String, &&RawValue)> = fields.iter().filter(|(name, _)| !omit.contains(&name.as_str())).collect();
        let bytes: u64 = kept.iter().map(|(_, raw)| raw.get().len() as u64).sum();
        if bytes > budget as u64 {
            return Err(PartialError::TooLarge { cause: crate::cause!(), bytes });
        }
        kept.into_iter().map(|(name, raw)| Ok((name.clone(), decode(raw)?))).collect::<Result<_>>().map(Some)
    }

}

impl<S: Storage + Send> RecordStore<S> {
    /// Write a record's fields but the `omit`ted ones, which keep their stored values (old `writeOwn`): one ordinary
    /// compare-and-set write at `expected_version`. Answers the new version.
    pub fn write_own(&mut self, account: &str, resource: &str, id: &str, value: &serde_json::Map<String, serde_json::Value>, omit: &[&str], expected_version: i64, request_key: &str, body_budget: usize) -> Result<i64> {
        names_valid(omit)?;
        let (version, body) = self.live_body(account, resource, id, body_budget)?.ok_or(PartialError::Shape("writeOwn needs a live record", crate::cause!()))?;
        if version != expected_version {
            return Err(PartialError::from(crate::cause!(Error::Conflict)));
        }
        let held = top_level(&body)?;
        let mut next = serde_json::Map::new();
        for (name, raw) in &held {
            if omit.contains(&name.as_str()) {
                next.insert(name.clone(), decode(raw)?);
            }
        }
        for (name, one) in value {
            if !omit.contains(&name.as_str()) {
                next.insert(name.clone(), one.clone());
            }
        }
        let written = self.mutate(account, resource, Mutation { id: id.into(), expected_version, request_key: request_key.into(), deleted: false, value: serde_json::Value::Object(next) })?;
        Ok(written.version)
    }

    /// Replace member `ordinal` of a list field, or append at its end (old `writeMember`): a gap, a field that holds
    /// anything but a list, or a member that is not an object is refused and nothing is written. One ordinary
    /// compare-and-set write at the record's current version; answers the new version.
    pub fn write_member(&mut self, account: &str, resource: &str, id: &str, field: &str, ordinal: usize, member: &serde_json::Value, request_key: &str, body_budget: usize) -> Result<i64> {
        if !member.is_object() {
            return Err(PartialError::Shape("writeMember needs an object", crate::cause!()));
        }
        let (version, body) = self.live_body(account, resource, id, body_budget)?.ok_or(PartialError::Shape("writeMember needs a live record", crate::cause!()))?;
        let held = top_level(&body)?;
        let list = match held.get(field) {
            None => Vec::new(),
            Some(raw) => serde_json::from_str::<Vec<&RawValue>>(raw.get()).map_err(|_| PartialError::Shape("the field is not a list", crate::cause!()))?,
        };
        if ordinal > list.len() {
            return Err(PartialError::Shape("a list cannot skip an ordinal", crate::cause!()));
        }
        let mut next = serde_json::Map::new();
        for (name, raw) in &held {
            if name != field {
                next.insert(name.clone(), decode(raw)?);
            }
        }
        let mut members: Vec<serde_json::Value> = list.iter().map(|raw| decode(raw)).collect::<Result<_>>()?;
        if ordinal == members.len() {
            members.push(member.clone());
        } else {
            members[ordinal] = member.clone();
        }
        next.insert(field.to_string(), serde_json::Value::Array(members));
        let written = self.mutate(account, resource, Mutation { id: id.into(), expected_version: version, request_key: request_key.into(), deleted: false, value: serde_json::Value::Object(next) })?;
        Ok(written.version)
    }
}

/// A bounded memory of whole records already read (old record-rows LRU): at most `count` records and `bytes` of their
/// stored bodies; a record larger than `bytes` is never kept and is read every time. A remembered record is answered
/// again only while the storage mark and the scope's stamp are the ones it was read at, so another handle's commit or
/// any write to the scope makes the next read fresh.
pub struct RecordMemory {
    count: usize,
    bytes: usize,
    held: HashMap<(String, String, String), Remembered>,
    order: VecDeque<(String, String, String)>,
    used: usize,
}
struct Remembered {
    at: (i64, i64),
    size: usize,
    value: Option<serde_json::Value>,
}
impl RecordMemory {
    pub fn new(count: usize, bytes: usize) -> Self {
        RecordMemory { count, bytes, held: HashMap::new(), order: VecDeque::new(), used: 0 }
    }
    /// How many records and stored bytes the memory holds.
    pub fn held(&self) -> (usize, usize) {
        (self.held.len(), self.used)
    }
    /// Forget everything (a rollback the caller saw).
    pub fn clear(&mut self) {
        self.held.clear();
        self.order.clear();
        self.used = 0;
    }
    fn forget(&mut self, key: &(String, String, String)) {
        if let Some(gone) = self.held.remove(key) {
            self.used -= gone.size;
            self.order.retain(|known| known != key);
        }
    }
    fn touch(&mut self, key: &(String, String, String)) {
        self.order.retain(|known| known != key);
        self.order.push_back(key.clone());
    }
    /// A live record's value (a copy), from memory when unchanged, else read within `budget` bytes (checked before it is
    /// parsed) and remembered when it fits.
    pub fn read<S: Storage>(&mut self, store: &RecordStore<S>, account: &str, resource: &str, id: &str, budget: usize) -> Result<Option<serde_json::Value>> {
        let at = (store.storage().mark().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?, store.stamp(account, resource)?);
        let key = (account.to_string(), resource.to_string(), id.to_string());
        if let Some(known) = self.held.get(&key) {
            if known.at == at {
                let value = known.value.clone();
                self.touch(&key);
                return Ok(value);
            }
        }
        self.forget(&key);
        let value = match store.live_body(account, resource, id, budget)? {
            None => None,
            Some((_, body)) => Some((body.len(), serde_json::from_slice::<serde_json::Value>(&body).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?)),
        };
        let size = value.as_ref().map_or(0, |(size, _)| *size);
        let value = value.map(|(_, value)| value);
        if size <= self.bytes && self.count > 0 {
            while self.held.len() >= self.count || self.used + size > self.bytes {
                let Some(oldest) = self.order.pop_front() else { break };
                if let Some(gone) = self.held.remove(&oldest) {
                    self.used -= gone.size;
                }
            }
            self.used += size;
            self.held.insert(key.clone(), Remembered { at, size, value: value.clone() });
            self.order.push_back(key);
        }
        Ok(value)
    }
}

#[cfg(test)]
#[path = "partial_tests.rs"]
mod tests;
