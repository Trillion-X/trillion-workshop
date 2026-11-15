// src/storage/record_store/record_log.rs
//
// ONE SCOPE OF AN ACCOUNT'S RECORDS KEPT AS A LOG OF ROWS AND ONE KEPT STATE PER RECORD, WITH ITS ORDER-FREE CHECKSUM
// MOVED ALONG BY EVERY WRITE: THE STORE RECORD SYNC SETTLES.
//
// Purpose
//   The parts of old trillion `parts/record-log/do-work/record-log-store.mjs` that record sync (`record_sync.rs`) reads
//   and writes, ported one to one over the storage boundary (`crate::storage::Storage`), so the same code runs on the
//   memory supply and on the SQLite supply, in the account's records store file beside record store (schema `record_store`,
//   families `settle_log`, `settle_records`, `settle_sums`, `settle_positions` in `families.json`):
//   - `write`: a person's write made here; each record becomes one envelope (whole, field changes, or a removal) that
//     carries what it replaced (`prior` / `was` / `added`) and the stamp this computer gave it (`stamp_after`);
//   - `log_after` / `last_log_id`: the log, oldest first, by UUIDv7 row id;
//   - `apply_changes`: another copy's changes, merged by stamps (`merge_from`) or, for a change that names none,
//     compared with what it replaced (`change_from`), conflicts settled by `by_content` and kept apart (`kept_apart`);
//   - `take_records`: records made exactly as another copy holds them (a bucket the other side would not take);
//   - `checksum`, `records_in_buckets(_page)`: the sums of `digest.rs` and the records of chosen buckets;
//   - one position per copy that settles with this store (`settle_positions`), never a record, so it never travels.
//
// Non-Negotiable Invariants
//   1. Every write is one scope (`Scope::begin`): its log row, every kept state it changed and the sums are written
//      together or not at all.
//   2. The sums are a function of what is kept: a live record's kind and fields, and every kept state's stamps (a
//      removal keeps its stamps, so a removal settles like any other change). They move by subtracting a record's old
//      hashes and adding its new ones, so a write costs the records it touches, never the store.
//   3. Applying a change that changes nothing writes nothing: no log row, no state, no sums. (Old trillion still wrote
//      a kept-apart row for a conflict it had already kept; here a kept-apart change whose merge changes nothing is
//      passed over too, so a repeated settle writes nothing even after a conflict.)
//   4. A row's id is a UUIDv7 made from this computer's clock and counted up within one millisecond, so ids sort by when
//      they were written, as old trillion's `uuidv7`.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::digest::{bucket_of, json_text, text_hash, Sums};
use super::record_sync::{by_content, same, seq_from, Actor, Applied, BucketRecord, ChangeRow, Checksum, Conflict, LogPage, LogRow, SettleStore, SyncError};
use super::stamps::{envelope_of_kept, kept_from, merge, same_kept, stamp_after, state_from, state_of, Envelope, Fields, Kept, Meta, Typed};
use crate::storage::{Bound, Intent, Order, Range, Read, Scope, Storage, Value as Stored, When};
use serde_json::Value;
#[cfg_attr(all(hosted_records, target_arch = "wasm32"), allow(unused_imports))]
use std::{
    collections::BTreeMap,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const LOG: &str = "settle_log";
const RECORDS: &str = "settle_records";
const SUMS: &str = "settle_sums";
const POSITIONS: &str = "settle_positions";

/// The clock a store's row ids are made from (milliseconds).
pub type Clock = Box<dyn Fn() -> i64 + Send>;

fn system_ms() -> i64 {
    #[cfg(all(hosted_records, target_arch = "wasm32"))]
    return i64::try_from(crate::host_clock::now_ms()).unwrap_or(i64::MAX);
    #[cfg(not(all(hosted_records, target_arch = "wasm32")))]
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |time| i64::try_from(time.as_millis()).unwrap_or(i64::MAX))
}

// Within one millisecond the 12-bit rand_a field counts up (old trillion's module-level `lastMs` and `counter`).
static LAST: Mutex<(i64, u16)> = Mutex::new((0, 0));

/// A time-ordered id (UUIDv7, RFC 9562) for log rows, from `ms`.
pub fn uuidv7(ms: i64) -> String {
    let (ms, counter) = {
        let mut last = LAST.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut ms = ms.max(0);
        let mut counter = 0u16;
        if ms <= last.0 {
            counter = last.1 + 1;
            ms = last.0;
            if counter > 0xfff {
                counter = 0;
                ms += 1;
            }
        }
        *last = (ms, counter);
        (ms, counter)
    };
    let mut bytes = [0u8; 16];
    #[cfg(not(hosted_records))]
    let _ = ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes);
    #[cfg(hosted_records)]
    crate::host_clock::fill_random(&mut bytes);
    let mut rest = ms;
    for index in (0..6).rev() {
        bytes[index] = (rest % 256) as u8;
        rest /= 256;
    }
    bytes[6] = 0x70 | (counter >> 8) as u8;
    bytes[7] = (counter & 0xff) as u8;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

fn storage(error: crate::storage::Error) -> SyncError {
    SyncError::storage(error.cause())
}

/// The settle stamp of a record store change at `sequence` (a hybrid logical clock value: milliseconds << 16 | count):
/// its milliseconds as 12 hex digits, its count as 4, then `0000`, so it sorts with the stamps this store gives its own
/// writes (`seq_from`: 12 hex digits of milliseconds first) and every copy of the change gets the same one.
pub fn mirror_stamp(sequence: i64) -> String {
    let sequence = sequence.max(0);
    format!("{:012x}{:04x}0000", sequence >> 16, sequence & 0xffff)
}

/// One scope of records (an account and a records resource) kept for settling.
pub struct RecordLog<S: Storage> {
    storage: S,
    account: String,
    resource: String,
    clock: Clock,
    /// While one apply runs (`apply_changes`, `take_records`): every kept state it read or wrote, so each record is read
    /// once (all of a batch in one `read_many`) and decoded once, however often the apply looks at it.
    held: std::cell::RefCell<Option<std::collections::HashMap<String, Option<Kept>>>>,
    /// The kept-state rows that apply wrote, put together in one `write_many` before its log row and sums.
    pending: std::cell::RefCell<Vec<Vec<(&'static str, Stored)>>>,
}

fn typed_value(typed: Option<&Typed>) -> Value {
    typed.map_or(Value::Null, |typed| serde_json::json!({ "type": typed.kind, "value": typed.value }))
}

impl<S: Storage> RecordLog<S> {
    pub fn new(storage: S, account: &str, resource: &str) -> Self {
        Self::with_clock(storage, account, resource, Box::new(system_ms))
    }

    pub fn with_clock(storage: S, account: &str, resource: &str, clock: Clock) -> Self {
        Self { storage, account: account.into(), resource: resource.into(), clock, held: Default::default(), pending: Default::default() }
    }

    pub fn storage(&self) -> &S {
        &self.storage
    }

    fn scope_key(&self) -> Vec<Stored> {
        vec![Stored::from(self.account.as_str()), Stored::from(self.resource.as_str())]
    }

    fn scope_range(&self) -> Range<'static> {
        Range { order: Order::Key, from: Bound::Included(self.scope_key()), to: Bound::Included(self.scope_key()), reverse: false, limit: None }
    }

    /// The body of `apply_changes` while its records are held: what it applied, whether anything changed, the sums,
    /// who wrote it and the envelopes of its log row.
    #[allow(clippy::type_complexity)]
    fn apply_held(&self, rows: &[ChangeRow], actor: Actor, keep_apart: Option<&str>) -> Result<(Applied, bool, Sums, Actor, Vec<Envelope>), SyncError> {
        let mut conflicts = Vec::new();
        let mut applied = 0;
        let from_copy = actor.from_copy.clone();
        let mut out = Vec::new();
        let mut sums = self.sums()?;
        for row in rows {
            for sent in &row.envelopes {
                let change = if sent.at.is_none() { self.change_from(sent, &mut conflicts)? } else { self.merge_from(sent, from_copy.as_deref(), &mut conflicts)? };
                let Some(mut change) = change else { continue };
                // Applied at once, so a later envelope for the same record compares against it; its order among
                // records (seq) is written into it.
                let seq = seq_from(&uuidv7((self.clock)()), 0);
                change.seq = Some(seq.clone());
                self.apply_envelope(&mut sums, &mut change, &seq, true)?;
                out.push(change);
                applied += 1;
            }
        }
        if let Some(kind) = keep_apart {
            for mut envelope in self.kept_apart(&conflicts, kind)? {
                let seq = seq_from(&uuidv7((self.clock)()), 0);
                envelope.seq = Some(seq.clone());
                // A kept-apart change that changes nothing (the versions were kept already) is not written.
                if self.apply_envelope(&mut sums, &mut envelope, &seq, true)? {
                    out.push(envelope);
                }
            }
        }
        let changed = !out.is_empty();
        Ok((Applied { applied, conflicts }, changed, sums, actor, out))
    }

    /// The kept state of a record, a removal included (old trillion `keptOrRemoved`).
    pub fn kept_or_removed(&self, id: &str) -> Result<Option<Kept>, SyncError> {
        if let Some(held) = self.held.borrow().as_ref().and_then(|held| held.get(id)) {
            return Ok(held.clone());
        }
        let mut key = self.scope_key();
        key.push(Stored::from(id));
        let row = self.storage.get(RECORDS, &key, &[Read::whole("type"), Read::whole("value"), Read::whole("meta")]).map_err(storage)?;
        Ok(row.map(|row| Self::kept_of(&row.0)))
    }

    /// Starts one apply over the records `ids`: their kept states read in one batch (`read_many`) and held until
    /// `end_apply`. Catch-up applied each envelope as two point reads, two decodes and a put (19 MB/s at 16 MB, 13 MB/s
    /// at 1 GiB, measured by `settle_catch_up_measured`); now a batch is one read and one write of its records.
    fn begin_apply(&self, ids: &[&str]) -> Result<(), SyncError> {
        let mut unique: Vec<&str> = ids.to_vec();
        unique.sort_unstable();
        unique.dedup();
        let read = [Read::whole("type"), Read::whole("value"), Read::whole("meta")];
        let keys: Vec<Vec<Stored>> = unique.iter().map(|id| {
            let mut key = self.scope_key();
            key.push(Stored::from(*id));
            key
        }).collect();
        let mut held = std::collections::HashMap::with_capacity(unique.len());
        for (chunk, ids) in keys.chunks(500).zip(unique.chunks(500)) {
            let queries: Vec<crate::storage::Query<'_>> = chunk.iter().map(|key| crate::storage::Query::Get { family: RECORDS, key, read: &read }).collect();
            for (reply, id) in self.storage.read_many(&queries).map_err(storage)?.into_iter().zip(ids) {
                let crate::storage::Reply::Row(row) = reply else { return Err(SyncError::storage(crate::cause!())) };
                held.insert(id.to_string(), row.map(|row| Self::kept_of(&row.0)));
            }
        }
        *self.held.borrow_mut() = Some(held);
        Ok(())
    }

    /// Puts what the apply wrote (one `write_many`).
    fn flush(&self) -> Result<(), SyncError> {
        let rows = std::mem::take(&mut *self.pending.borrow_mut());
        if rows.is_empty() {
            return Ok(());
        }
        let writes: Vec<crate::storage::Write<'_>> = rows.iter().map(|row| crate::storage::Write::Put { family: RECORDS, row, when: When::Always }).collect();
        self.storage.write_many(&writes).map_err(storage).map(|_| ())
    }

    /// Ends one apply: what it wrote is put, and nothing is held any longer.
    fn end_apply(&self) -> Result<(), SyncError> {
        let flushed = self.flush();
        *self.held.borrow_mut() = None;
        flushed
    }

    fn kept_of(row: &[Stored]) -> Kept {
        let kind = row.first().and_then(Stored::as_text).map(str::to_string);
        let value = row.get(1).and_then(Stored::as_text).and_then(|text| serde_json::from_str::<Fields>(text).ok());
        let meta = row.get(2).and_then(Stored::as_text).and_then(|text| serde_json::from_str::<Meta>(text).ok()).unwrap_or_default();
        Kept { kind: kind.filter(|_| value.is_some()), value, meta }
    }

    /// The live record (old trillion `kept`): its kind and value, or None when it is not held or was removed.
    pub fn kept(&self, id: &str) -> Result<Option<Typed>, SyncError> {
        Ok(self.kept_or_removed(id)?.and_then(|kept| match (kept.kind, kept.value) {
            (Some(kind), Some(value)) => Some(Typed { kind, value }),
            _ => None,
        }))
    }

    /// A record's value, for reading.
    pub fn read(&self, id: &str) -> Result<Option<Fields>, SyncError> {
        Ok(self.kept(id)?.map(|typed| typed.value))
    }

    fn sums(&self) -> Result<Sums, SyncError> {
        let row = self.storage.get(SUMS, &self.scope_key(), &[Read::whole("lanes")]).map_err(storage)?;
        Ok(row.and_then(|row| row.0.first().and_then(Stored::as_text).and_then(Sums::from_text)).unwrap_or_default())
    }

    fn put_sums(&self, sums: &Sums) -> Result<(), SyncError> {
        let row = [("account", Stored::from(self.account.as_str())), ("resource", Stored::from(self.resource.as_str())), ("lanes", Stored::from(sums.text()))];
        self.storage.put(SUMS, &row, When::Always).map_err(storage).map(|_| ())
    }

    /// Writes a kept state (or erases it: None), moving `sums` from what was held.
    fn set_state(&self, sums: &mut Sums, id: &str, held: Option<&Kept>, after: Option<&Kept>) -> Result<(), SyncError> {
        if let Some(held) = held {
            if let (Some(kind), Some(value)) = (&held.kind, &held.value) {
                sums.remove(id, kind, value);
            }
            sums.stamps(id, Some(&held.meta.text()), None);
        }
        let mut key = self.scope_key();
        key.push(Stored::from(id));
        let applying = self.held.borrow().is_some();
        if let Some(held) = self.held.borrow_mut().as_mut() {
            held.insert(id.to_string(), after.cloned());
        }
        match after {
            None => {
                // A put of the same record still waiting would come back after the erase: put what waits first.
                self.flush()?;
                let range = Range { order: Order::Key, from: Bound::Included(key.clone()), to: Bound::Included(key), reverse: false, limit: None };
                self.storage.erase(RECORDS, &range).map_err(storage)?;
            }
            Some(after) => {
                if let (Some(kind), Some(value)) = (&after.kind, &after.value) {
                    sums.add(id, kind, value);
                }
                sums.stamps(id, None, Some(&after.meta.text()));
                let value = after.value.as_ref().map_or(Stored::Null, |value| Stored::from(json_text(&Value::Object(value.clone()))));
                let kind = match (&after.kind, &after.value) {
                    (Some(kind), Some(_)) => Stored::from(kind.as_str()),
                    _ => Stored::Null,
                };
                let row = [
                    ("account", Stored::from(self.account.as_str())),
                    ("resource", Stored::from(self.resource.as_str())),
                    ("id", Stored::from(id)),
                    ("bucket", Stored::Integer(bucket_of(id) as i64)),
                    ("type", kind),
                    ("value", value),
                    ("meta", Stored::from(after.meta.text())),
                ];
                if applying {
                    self.pending.borrow_mut().push(row.to_vec());
                } else {
                    self.storage.put(RECORDS, &row, When::Always).map_err(storage)?;
                }
            }
        }
        Ok(())
    }

    // A live envelope (being committed now) is first given what it replaces (old trillion `annotate`).
    fn annotate(envelope: &mut Envelope, before: Option<&Typed>) {
        if envelope.remove || envelope.purge || envelope.value.is_some() {
            envelope.prior = Some(before.cloned());
            return;
        }
        let mut was = Fields::new();
        let mut added = Vec::new();
        let unset = envelope.unset.clone().unwrap_or_default();
        for field in envelope.set.iter().flat_map(|set| set.keys().cloned()).chain(unset.iter().cloned()) {
            match before.and_then(|before| before.value.get(&field)) {
                Some(item) => {
                    was.insert(field, item.clone());
                }
                None => {
                    if !unset.contains(&field) {
                        added.push(field);
                    }
                }
            }
        }
        envelope.was = Some(was);
        if !added.is_empty() {
            envelope.added = Some(added);
        }
    }

    // One envelope applied to the kept states (old trillion `applyEnvelope`). `seq` is the envelope's position; the stamp
    // of a change made here is moved after what the record holds and written into the envelope when moved.
    fn apply_envelope(&self, sums: &mut Sums, envelope: &mut Envelope, seq: &str, live: bool) -> Result<bool, SyncError> {
        let held = self.kept_or_removed(&envelope.id)?;
        let before = held.as_ref().and_then(|held| match (&held.kind, &held.value) {
            (Some(kind), Some(value)) => Some(Typed { kind: kind.clone(), value: value.clone() }),
            _ => None,
        });
        if live {
            Self::annotate(envelope, before.as_ref());
        }
        if envelope.purge {
            // The copy this one settles with holds nothing for the id, not even a removal: nothing is kept.
            if held.is_some() {
                self.set_state(sums, &envelope.id, held.as_ref(), None)?;
            }
            return Ok(held.is_some());
        }
        let stamp = match &envelope.at {
            Some(at) => at.clone(),
            None => {
                let stamp = stamp_after(seq, held.as_ref().map(|held| held.meta.at.as_str()));
                if live && stamp != seq {
                    envelope.at = Some(stamp.clone());
                }
                stamp
            }
        };
        // A whole value or removal stamped after everything held replaces it; anything else is merged field by field;
        // `exact` makes the record the state the envelope carries, whatever this copy held.
        let replaces = !envelope.exact
            && envelope.whole_or_removal()
            && envelope.stamps.is_none()
            && envelope.removed.is_none()
            && envelope.floor_kind.is_none()
            && envelope.floor.as_ref().is_none_or(|floor| *floor == stamp)
            && !held.as_ref().is_some_and(|held| !super::stamps::js_less(&held.meta.at, &stamp));
        let after = if replaces {
            Some(if envelope.remove {
                Kept { kind: None, value: None, meta: Meta { at: stamp.clone(), k: Some("removed".into()), ..Meta::default() } }
            } else {
                Kept { kind: envelope.kind.clone(), value: envelope.value.clone(), meta: Meta { at: stamp.clone(), ..Meta::default() } }
            })
        } else if envelope.exact {
            kept_from(&state_from(envelope, &stamp))
        } else {
            kept_from(&merge(&state_of(held.as_ref()), &state_from(envelope, &stamp)))
        };
        let Some(after) = after else { return Ok(false) };
        if same_kept(held.as_ref(), Some(&after)) {
            return Ok(false);
        }
        self.set_state(sums, &envelope.id, held.as_ref(), Some(&after))?;
        Ok(true)
    }

    // The envelope of one record a person writes here (old trillion `envelopeFor`): None when it changes nothing.
    fn envelope_for(&self, id: &str, kind: &str, value: Option<&Fields>) -> Result<Option<Envelope>, SyncError> {
        let before = self.kept(id)?;
        let Some(value) = value else {
            return Ok(before.map(|_| Envelope { id: id.into(), remove: true, ..Envelope::default() }));
        };
        let Some(before) = before.filter(|before| before.kind == kind) else {
            return Ok(Some(Envelope { id: id.into(), kind: Some(kind.into()), value: Some(value.clone()), ..Envelope::default() }));
        };
        let mut set = Fields::new();
        for (field, item) in value {
            if before.value.get(field).map(json_text) != Some(json_text(item)) {
                set.insert(field.clone(), item.clone());
            }
        }
        let unset: Vec<String> = before.value.keys().filter(|field| !value.contains_key(*field)).cloned().collect();
        if set.is_empty() && unset.is_empty() {
            return Ok(None);
        }
        Ok(Some(Envelope { id: id.into(), kind: Some(kind.into()), set: (!set.is_empty()).then_some(set), unset: (!unset.is_empty()).then_some(unset), ..Envelope::default() }))
    }

    fn append(&self, actor: &Actor, envelopes: &[Envelope], row_id: String) -> Result<String, SyncError> {
        let row = [
            ("account", Stored::from(self.account.as_str())),
            ("resource", Stored::from(self.resource.as_str())),
            ("row", Stored::from(row_id.as_str())),
            ("actor", Stored::from(serde_json::to_string(actor).unwrap_or_default())),
            ("envelopes", Stored::from(serde_json::to_string(envelopes).unwrap_or_default())),
        ];
        self.storage.put(LOG, &row, When::Always).map_err(storage)?;
        Ok(row_id)
    }

    /// The scope of one write: its own transaction, or, when the storage is already inside a write someone else owns
    /// (a copy's write unit lends its open transaction, `copies.rs` `write_at`), a savepoint inside it, so the log row,
    /// the kept states and the sums commit or roll back with that write (as `mod.rs` `write` joins a lent write). A
    /// storage inside a read only transaction is refused: a read never turns into a writer.
    fn begin(&self) -> Result<Scope<'_>, SyncError> {
        let intent = if self.storage.scoped() {
            if !self.storage.writing().map_err(storage)? {
                return Err(SyncError::storage(crate::cause!()));
            }
            Intent::Nested
        } else {
            Intent::Write
        };
        Scope::begin(&self.storage, intent).map_err(storage)
    }

    /// A write made here: each (id, kind, value) is a whole value, its changed fields, or (value None) a removal, as
    /// one log row. Answers the row id, or None when nothing changed.
    pub fn write(&mut self, records: &[(&str, &str, Option<Fields>)], actor: Actor) -> Result<Option<String>, SyncError> {
        if let Some((id, _, _)) = records.iter().find(|(id, _, _)| id.is_empty() || id.contains('/')) {
            return Err(SyncError::new(400, format!("A record id must be text without \"/\": {id}"), crate::cause!()));
        }
        self.write_rows(records, actor)
    }

    /// The record store's own write of these records (`copies.rs` `write_at`: what a write unit changed in `versions`,
    /// each as the record store now holds it), made into this settle store in the same open transaction, so the settle
    /// store is the account's actual records and a settle catches them up. The ids were already checked by the record
    /// store (any nonempty text, `/` included: old trillion's `/` rule named its own path addressing, which the record
    /// store does not use). One log row; None when the settle store already held every value.
    ///
    /// A mirrored write leaves no log row: the record store already keeps every change (`versions`, with its history),
    /// and a second log of the same values more than doubled what a store keeps per write (measured by `month_tests.rs`:
    /// 2,976 bytes per arrival with the log, the guard 2,048). Its kept states and sums move as any write's do, so a
    /// settle with a copy that took the same changes finds the same root; a copy that differs is caught up by the
    /// buckets that differ (`record_sync.rs` `settle_with`: the roots differ, so the answer carries the buckets), merged
    /// by stamps both ways. Answers the row id the write would have had, or None when nothing changed.
    ///
    /// Each record carries the stamp the record store gave the change (`mirror_stamp` of its sequence). The record store
    /// sequence of a change is the writer's, carried as is to every copy, so every computer's settle store holds the same
    /// states with the same stamps and the same root: a settle between two copies that took the same changes is one
    /// request that writes nothing.
    pub fn mirror(&mut self, records: &[(&str, &str, Option<Fields>, String)], actor: Actor) -> Result<Option<String>, SyncError> {
        if let Some((id, ..)) = records.iter().find(|(id, ..)| id.is_empty()) {
            return Err(SyncError::new(400, format!("A record id must be nonempty text: {id:?}"), crate::cause!()));
        }
        let scope = self.begin()?;
        let mut sums = self.sums()?;
        let mut changed = false;
        for (id, kind, value, stamp) in records {
            // Whole, at its stamp: the settle state of a record is a function of the record store's current row alone
            // (`carry.rs` `Versions` reads the same state from it), whatever changes led there.
            let mut envelope = match value {
                Some(value) => Envelope { id: (*id).into(), kind: Some((*kind).into()), value: Some(value.clone()), at: Some(stamp.clone()), ..Envelope::default() },
                // A removal is kept with its stamp even for a record this store never held live (a copy that took only
                // the record's tombstone), as the record store keeps the tombstone.
                None => Envelope { id: (*id).into(), remove: true, at: Some(stamp.clone()), ..Envelope::default() },
            };
            changed |= self.apply_envelope(&mut sums, &mut envelope, stamp, false)?;
        }
        let _ = actor;
        if changed {
            self.put_sums(&sums)?;
        }
        scope.commit().map_err(storage)?;
        Ok(changed.then(|| uuidv7((self.clock)())))
    }

    /// Takes every value of record `id` out of this scope's log (the engine's erasure, `mod.rs` `erase`): each envelope
    /// of it becomes a removal at the stamp it had, so its net change still crosses as a removal and nothing it held
    /// is left in any row. Its kept state is left to the write that erases it (a removal). Old trillion kept each erasable
    /// value sealed under a key beside the row and dropped the key (`keysBeside`, erasable.mjs); here the values are
    /// taken out of the rows themselves, in the same transaction as the erase. Answers how many rows changed. A scan of
    /// the scope's log: an erase is rare, and the log is bounded by the settle positions' retention.
    pub fn erase_values(&mut self, id: &str) -> Result<usize, SyncError> {
        let scope = self.begin()?;
        let found = self.storage.scan(LOG, &self.scope_range(), &[Read::whole("row"), Read::whole("actor"), Read::whole("envelopes")]).map_err(storage)?;
        let mut changed = 0;
        for row in found {
            let text = |at: usize| row.0.get(at).and_then(Stored::as_text).map(str::to_string);
            let (Some(row_id), Some(actor), Some(envelopes)) = (text(0), text(1), text(2)) else { continue };
            let Ok(mut envelopes) = serde_json::from_str::<Vec<Envelope>>(&envelopes) else { continue };
            let mut touched = false;
            for (index, envelope) in envelopes.iter_mut().enumerate() {
                if envelope.id != id {
                    continue;
                }
                let at = super::record_sync::envelope_stamp(&row_id, envelope, index);
                *envelope = Envelope { id: id.to_string(), remove: true, at: Some(at), ..Envelope::default() };
                touched = true;
            }
            if touched {
                let actor: Actor = serde_json::from_str(&actor).unwrap_or_default();
                self.append(&actor, &envelopes, row_id)?;
                changed += 1;
            }
        }
        scope.commit().map_err(storage)?;
        Ok(changed)
    }

    fn write_rows(&mut self, records: &[(&str, &str, Option<Fields>)], actor: Actor) -> Result<Option<String>, SyncError> {
        self.write_stamped(records, &[], actor)
    }

    fn write_stamped(&mut self, records: &[(&str, &str, Option<Fields>)], stamps: &[Option<String>], actor: Actor) -> Result<Option<String>, SyncError> {
        let scope = self.begin()?;
        let mut envelopes = Vec::new();
        for (at, (id, kind, value)) in records.iter().enumerate() {
            if let Some(mut envelope) = self.envelope_for(id, kind, value.as_ref())? {
                envelope.at = stamps.get(at).cloned().flatten();
                envelopes.push(envelope);
            }
        }
        if envelopes.is_empty() {
            return Ok(None);
        }
        let row_id = uuidv7((self.clock)());
        let mut sums = self.sums()?;
        for (index, envelope) in envelopes.iter_mut().enumerate() {
            self.apply_envelope(&mut sums, envelope, &seq_from(&row_id, index), true)?;
        }
        self.put_sums(&sums)?;
        let row_id = self.append(&actor, &envelopes, row_id)?;
        scope.commit().map_err(storage)?;
        Ok(Some(row_id))
    }

    /// The newest of the positions `keys` name (one copy's cursors for one direction), None when none is set.
    fn newest_position(&self, keys: &[String]) -> Result<Option<String>, SyncError> {
        let mut newest: Option<String> = None;
        for key in keys {
            if let Some(at) = self.position(key)? {
                if newest.as_deref().is_none_or(|held| super::stamps::js_less(held, &at)) {
                    newest = Some(at);
                }
            }
        }
        Ok(newest)
    }

    /// A field this copy changed since the copy last took our changes, that the copy changed since we last took its
    /// changes, with a different value on each side, is a conflict: both values are kept apart (`kept_apart`), so
    /// neither is picked silently. `position(copy)` (and `sent:<copy>` at the asking side) is how far the copy has taken
    /// ours; `from:<copy>` (and `took:<copy>`) how far we have taken its. A value equal on both sides is not a conflict.
    /// Re-reading the same change is harmless: the field-stamp join is idempotent, so the same conflict is kept once.
    fn concurrent_fields(&self, copy: &str, envelope: &Envelope, held: &Kept, at: &str, conflicts: &mut Vec<Conflict>) -> Result<(), SyncError> {
        let sent = self.newest_position(&[copy.to_string(), format!("sent:{copy}")])?;
        let took = self.newest_position(&[format!("from:{copy}"), format!("took:{copy}")])?;
        if took.as_deref().is_some_and(|took| !super::stamps::js_less(took, at)) {
            return Ok(());
        }
        let local = super::stamps::state_of(Some(held));
        let there: Fields = envelope.set.clone().or_else(|| envelope.value.clone()).unwrap_or_default();
        for (field, theirs) in &there {
            let Some(cell) = local.fields.get(field) else { continue };
            let Some(mine) = cell.value.as_ref() else { continue };
            let local_changed = sent.as_deref().is_none_or(|sent| super::stamps::js_less(sent, &cell.stamp));
            if !local_changed || mine == theirs {
                continue;
            }
            conflicts.push(Conflict {
                id: envelope.id.clone(),
                kind: held.kind.clone(),
                field: Some(field.clone()),
                reason: "changed_here".into(),
                here: mine.clone(),
                there: theirs.clone(),
                before: Value::Null,
                kept: "here".into(),
                at: Some(at.to_string()),
            });
        }
        Ok(())
    }

    // What one stamped envelope from another copy does here (old trillion `mergeFrom`): merged field by field, the
    // later stamp kept. A field both copies changed from different values is a conflict, and both versions are kept
    // apart; the stamps alone say which one stays. None when it changes nothing here.
    fn merge_from(&self, envelope: &Envelope, from: Option<&str>, conflicts: &mut Vec<Conflict>) -> Result<Option<Envelope>, SyncError> {
        let at = envelope.at.clone().unwrap_or_default();
        let held = self.kept_or_removed(&envelope.id)?;
        // A change with no `prior` cannot show what the sender knew, so it is judged by the copy's positions instead.
        if let (Some(copy), Some(held), None) = (from, held.as_ref(), envelope.prior.as_ref()) {
            self.concurrent_fields(copy, envelope, held, &at, conflicts)?;
        }
        let after = kept_from(&merge(&state_of(held.as_ref()), &state_from(envelope, &at)));
        let here = held.as_ref().and_then(|held| match (&held.kind, &held.value) {
            (Some(kind), Some(value)) => Some(Typed { kind: kind.clone(), value: value.clone() }),
            _ => None,
        });
        let kind = here.as_ref().map(|here| here.kind.clone()).or_else(|| envelope.kind.clone());
        let met = match &held {
            Some(held) if !held.meta.at.is_empty() && super::stamps::js_less(&at, &held.meta.at) => held.meta.at.clone(),
            _ => at.clone(),
        };
        let after_value = |field: &str| after.as_ref().and_then(|after| after.value.as_ref()).and_then(|value| value.get(field)).cloned();
        if envelope.whole_or_removal() {
            let there = if envelope.remove { None } else { Some(Typed { kind: envelope.kind.clone().unwrap_or_default(), value: envelope.value.clone().unwrap_or_default() }) };
            if let Some(prior) = &envelope.prior {
                let (now_v, prior_v, there_v) = (typed_value(here.as_ref()), typed_value(prior.as_ref()), typed_value(there.as_ref()));
                if !same(Some(&now_v), Some(&prior_v)) && !same(Some(&now_v), Some(&there_v)) {
                    let kept = after.as_ref().and_then(|after| match (&after.kind, &after.value) {
                        (Some(kind), Some(value)) => Some(Typed { kind: kind.clone(), value: value.clone() }),
                        _ => None,
                    });
                    match (&here, &there) {
                        (Some(now), Some(there)) if now.kind == there.kind => {
                            let before = prior.as_ref().filter(|prior| prior.kind == now.kind).map(|prior| prior.value.clone()).unwrap_or_default();
                            let mut fields: Vec<&String> = now.value.keys().collect();
                            fields.extend(there.value.keys().filter(|field| !now.value.contains_key(*field)));
                            for field in fields {
                                let (mine, theirs, was) = (now.value.get(field), there.value.get(field), before.get(field));
                                if same(mine, theirs) || same(mine, was) {
                                    continue;
                                }
                                conflicts.push(Conflict {
                                    id: envelope.id.clone(),
                                    kind: kind.clone(),
                                    field: Some(field.clone()),
                                    reason: "changed_here".into(),
                                    here: mine.cloned().unwrap_or(Value::Null),
                                    there: theirs.cloned().unwrap_or(Value::Null),
                                    before: was.cloned().unwrap_or(Value::Null),
                                    kept: if same(after_value(field).as_ref(), theirs) { "there" } else { "here" }.into(),
                                    at: Some(met.clone()),
                                });
                            }
                        }
                        _ => conflicts.push(Conflict {
                            id: envelope.id.clone(),
                            kind: kind.clone(),
                            field: None,
                            reason: "changed_here".into(),
                            here: now_v,
                            there: there_v.clone(),
                            before: prior_v,
                            kept: if same(Some(&typed_value(kept.as_ref())), Some(&there_v)) { "there" } else { "here" }.into(),
                            at: Some(met.clone()),
                        }),
                    }
                }
            }
        } else if let Some(was) = &envelope.was {
            let unset = envelope.unset.clone().unwrap_or_default();
            let set = envelope.set.clone().unwrap_or_default();
            for field in set.keys().chain(unset.iter()) {
                let there = if unset.contains(field) { None } else { set.get(field) };
                let now = here.as_ref().and_then(|here| here.value.get(field));
                let expected = was.get(field);
                if same(now, there) || same(now, expected) {
                    continue;
                }
                conflicts.push(Conflict {
                    id: envelope.id.clone(),
                    kind: kind.clone(),
                    field: Some(field.clone()),
                    reason: "changed_here".into(),
                    here: now.cloned().unwrap_or(Value::Null),
                    there: there.cloned().unwrap_or(Value::Null),
                    before: expected.cloned().unwrap_or(Value::Null),
                    kept: if same(after_value(field).as_ref(), there) { "there" } else { "here" }.into(),
                    at: Some(met.clone()),
                });
            }
        }
        // A conflict whose winner is already held here changes nothing here, but it is still answered and kept apart.
        if same_kept(held.as_ref(), after.as_ref()) {
            return Ok(None);
        }
        let mut change = envelope.clone();
        change.was = None;
        change.prior = None;
        change.added = None;
        Ok(Some(change))
    }

    // A change another copy made that names no stamps (old trillion `changeFrom`): each field only where this copy
    // still holds what the change replaced; a field changed here since is kept as it is here, unless `by_content` says
    // the other copy's value wins it.
    fn change_from(&self, envelope: &Envelope, conflicts: &mut Vec<Conflict>) -> Result<Option<Envelope>, SyncError> {
        let now = self.kept(&envelope.id)?;
        // A change this copy cannot place (it names no stamps, or no basis) is not applied, but it is kept apart as a
        // version with its cause, so nothing a copy sent is lost (`kept_apart`).
        let no_basis = |conflicts: &mut Vec<Conflict>| {
            let sent = serde_json::json!({ "no_basis": { "kind": envelope.kind, "value": envelope.value, "set": envelope.set, "unset": envelope.unset, "remove": envelope.remove } });
            conflicts.push(Conflict { id: envelope.id.clone(), kind: None, field: None, reason: "no_basis".into(), here: Value::Null, there: sent, before: Value::Null, kept: "there".into(), at: None });
        };
        if envelope.whole_or_removal() {
            let Some(prior) = &envelope.prior else {
                no_basis(conflicts);
                return Ok(None);
            };
            let after = if envelope.remove { None } else { Some(Typed { kind: envelope.kind.clone().unwrap_or_default(), value: envelope.value.clone().unwrap_or_default() }) };
            let (held_v, after_v, prior_v) = (typed_value(now.as_ref()), typed_value(after.as_ref()), typed_value(prior.as_ref()));
            if same(Some(&held_v), Some(&after_v)) {
                return Ok(None);
            }
            if !same(Some(&held_v), Some(&prior_v)) {
                let wins = by_content(Some(&held_v), Some(&after_v));
                let kind = now.as_ref().map(|now| now.kind.clone()).or_else(|| after.as_ref().map(|after| after.kind.clone()));
                conflicts.push(Conflict { id: envelope.id.clone(), kind, field: None, reason: "changed_here".into(), here: held_v, there: after_v, before: prior_v, kept: if wins { "there" } else { "here" }.into(), at: None });
                if !wins {
                    return Ok(None);
                }
            }
            return Ok(Some(if envelope.remove {
                Envelope { id: envelope.id.clone(), remove: true, ..Envelope::default() }
            } else {
                Envelope { id: envelope.id.clone(), kind: envelope.kind.clone(), value: envelope.value.clone(), ..Envelope::default() }
            }));
        }
        let Some(was) = &envelope.was else {
            no_basis(conflicts);
            return Ok(None);
        };
        if let Some(now) = now.as_ref().filter(|now| Some(&now.kind) != envelope.kind.as_ref()) {
            conflicts.push(Conflict {
                id: envelope.id.clone(),
                kind: Some(now.kind.clone()),
                field: None,
                reason: "changed_here".into(),
                here: typed_value(Some(now)),
                there: serde_json::json!({ "type": envelope.kind }),
                before: Value::Null,
                kept: "here".into(),
                at: None,
            });
            return Ok(None);
        }
        let unset_in = envelope.unset.clone().unwrap_or_default();
        let set_in = envelope.set.clone().unwrap_or_default();
        let mut set = Fields::new();
        let mut unset = Vec::new();
        for field in set_in.keys().chain(unset_in.iter()) {
            let removing = unset_in.contains(field);
            let after = if removing { None } else { set_in.get(field) };
            let expected = was.get(field);
            let held = now.as_ref().and_then(|now| now.value.get(field));
            if same(held, after) {
                continue;
            }
            if !same(held, expected) {
                // A field on a record removed here stays removed: the record is not made again from one field of it.
                let wins = now.is_some() && by_content(held, after);
                conflicts.push(Conflict {
                    id: envelope.id.clone(),
                    kind: envelope.kind.clone(),
                    field: Some(field.clone()),
                    reason: "changed_here".into(),
                    here: held.cloned().unwrap_or(Value::Null),
                    there: after.cloned().unwrap_or(Value::Null),
                    before: expected.cloned().unwrap_or(Value::Null),
                    kept: if wins { "there" } else { "here" }.into(),
                    at: None,
                });
                if !wins {
                    continue;
                }
            }
            match after {
                None => unset.push(field.clone()),
                Some(item) => {
                    set.insert(field.clone(), item.clone());
                }
            }
        }
        if set.is_empty() && unset.is_empty() {
            return Ok(None);
        }
        Ok(Some(Envelope { id: envelope.id.clone(), kind: envelope.kind.clone(), set: (!set.is_empty()).then_some(set), unset: (!unset.is_empty()).then_some(unset), ..Envelope::default() }))
    }

    // The versions a conflict met, kept as one record per contested record (`<kind>:<record id>`), one field per
    // version: the field's name is the contested field (or * for the whole record) and a checksum of the version, so
    // two copies that met the same conflict write the same fields and every later fork only adds fields, never
    // replaces one (old trillion `keptApart`).
    fn kept_apart(&self, conflicts: &[Conflict], kind: &str) -> Result<Vec<Envelope>, SyncError> {
        let mut by_record: BTreeMap<String, Fields> = BTreeMap::new();
        let mut order: Vec<String> = Vec::new();
        let mut stamp_of: BTreeMap<String, String> = BTreeMap::new();
        for conflict in conflicts {
            if !matches!(conflict.reason.as_str(), "changed_here" | "no_basis") || conflict.kind.as_deref() == Some(kind) {
                continue;
            }
            let id = format!("{kind}:{}", conflict.id);
            if !by_record.contains_key(&id) {
                order.push(id.clone());
            }
            let versions = by_record.entry(id.clone()).or_default();
            if let Some(at) = &conflict.at {
                if stamp_of.get(&id).is_none_or(|held| super::stamps::js_less(held, at)) {
                    stamp_of.insert(id.clone(), at.clone());
                }
            }
            // A no-basis change's local side is the record itself, already kept: only what was sent is a version.
            let sides: &[&Value] = if conflict.reason == "no_basis" { &[&conflict.there] } else { &[&conflict.here, &conflict.there] };
            for version in sides {
                let [a, b] = text_hash(&json_text(version));
                let key = format!("{}|{a:08x}{b:08x}", conflict.field.as_deref().unwrap_or("*"));
                versions.insert(key, serde_json::json!({ "record": conflict.id, "record_type": conflict.kind, "field": conflict.field, "value": version }));
            }
        }
        let mut out = Vec::new();
        for id in order {
            let versions = by_record.remove(&id).unwrap_or_default();
            if let Some(at) = stamp_of.get(&id) {
                out.push(Envelope { id, kind: Some(kind.into()), set: Some(versions), at: Some(at.clone()), ..Envelope::default() });
                continue;
            }
            let held = self.kept(&id)?.filter(|held| held.kind == kind);
            let set: Fields = versions.into_iter().filter(|(key, _)| !held.as_ref().is_some_and(|held| held.value.contains_key(key))).collect();
            if set.is_empty() {
                continue;
            }
            out.push(match held {
                Some(_) => Envelope { id, kind: Some(kind.into()), set: Some(set), ..Envelope::default() },
                None => Envelope { id, kind: Some(kind.into()), value: Some(set), ..Envelope::default() },
            });
        }
        Ok(out)
    }

    /// Every position this store keeps: (copy, took_through, settled_at).
    pub fn positions(&self) -> Result<Vec<(String, Option<String>, String)>, SyncError> {
        let mut range = Range::all();
        range.from = Bound::Included(self.scope_key());
        range.to = Bound::Included(self.scope_key());
        let rows = self.storage.scan(POSITIONS, &range, &[Read::whole("copy"), Read::whole("took_through"), Read::whole("settled_at")]).map_err(storage)?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let text = |at: usize| row.0.get(at).and_then(Stored::as_text).map(str::to_string);
                (text(0).unwrap_or_default(), text(1), text(2).unwrap_or_default())
            })
            .collect())
    }

    /// How many log rows the store keeps (a test's measure of "wrote nothing").
    pub fn log_rows(&self) -> Result<u64, SyncError> {
        self.storage.count(LOG, &self.scope_range()).map_err(storage)
    }
}

fn record_of(row: &[Stored]) -> Option<BucketRecord> {
    let id = row.first().and_then(Stored::as_text)?.to_string();
    let kind = row.get(1).and_then(Stored::as_text).map(str::to_string);
    let value = row.get(2).and_then(Stored::as_text).and_then(|text| serde_json::from_str::<Fields>(text).ok());
    let meta = row.get(3).and_then(Stored::as_text).and_then(|text| serde_json::from_str::<Meta>(text).ok());
    Some(BucketRecord { id, kind: kind.filter(|_| value.is_some()), value, meta })
}

impl<S: Storage> SettleStore for RecordLog<S> {
    fn log_after(&self, position: Option<&str>, limit: usize) -> Result<LogPage, SyncError> {
        let first = Range { limit: Some(1), ..self.scope_range() };
        let oldest = self.storage.scan(LOG, &first, &[Read::whole("row")]).map_err(storage)?.into_iter().next().and_then(|row| row.0.first().and_then(Stored::as_text).map(str::to_string));
        if limit == 0 {
            return Ok(LogPage { rows: Vec::new(), oldest, last: position.map(str::to_string), more: false });
        }
        let mut range = Range { limit: Some(limit + 1), ..self.scope_range() };
        if let Some(position) = position {
            let mut cursor = self.scope_key();
            cursor.push(Stored::from(position));
            range.from = Bound::Excluded(cursor);
        }
        let found = self.storage.scan(LOG, &range, &[Read::whole("row"), Read::whole("actor"), Read::whole("envelopes")]).map_err(storage)?;
        let more = found.len() > limit;
        let rows: Vec<LogRow> = found
            .into_iter()
            .take(limit)
            .filter_map(|row| {
                let text = |at: usize| row.0.get(at).and_then(Stored::as_text);
                Some(LogRow {
                    id: text(0)?.to_string(),
                    actor: text(1).and_then(|text| serde_json::from_str(text).ok()).unwrap_or_default(),
                    envelopes: text(2).and_then(|text| serde_json::from_str(text).ok()).unwrap_or_default(),
                })
            })
            .collect();
        let last = rows.last().map(|row| row.id.clone()).or_else(|| position.map(str::to_string));
        Ok(LogPage { rows, oldest, last, more })
    }

    fn last_log_id(&self) -> Result<Option<String>, SyncError> {
        let range = Range { limit: Some(1), ..self.scope_range() }.reverse();
        Ok(self.storage.scan(LOG, &range, &[Read::whole("row")]).map_err(storage)?.into_iter().next().and_then(|row| row.0.first().and_then(Stored::as_text).map(str::to_string)))
    }

    fn checksum(&self) -> Result<Checksum, SyncError> {
        let sums = self.sums()?;
        Ok(Checksum { root: sums.root(), buckets: sums.text() })
    }

    fn apply_changes(&mut self, rows: &[ChangeRow], actor: Actor, keep_apart: Option<&str>) -> Result<Applied, SyncError> {
        let scope = self.begin()?;
        let ids: Vec<&str> = rows.iter().flat_map(|row| row.envelopes.iter().map(|envelope| envelope.id.as_str())).collect();
        self.begin_apply(&ids)?;
        let applied = self.apply_held(rows, actor, keep_apart);
        let ended = self.end_apply();
        let applied = applied?;
        ended?;
        if applied.1 {
            let sums = applied.2;
            self.put_sums(&sums)?;
            self.append(&applied.3, &applied.4, uuidv7((self.clock)()))?;
        }
        scope.commit().map_err(storage)?;
        Ok(applied.0)
    }

    fn take_records(&mut self, records: &[BucketRecord], actor: Actor) -> Result<usize, SyncError> {
        let scope = self.begin()?;
        let mut envelopes = Vec::new();
        for record in records {
            if let Some(meta) = &record.meta {
                // With its stamps, a record is made exactly the state it is there (a removed one included).
                let held = self.kept_or_removed(&record.id)?;
                let given = Kept { kind: record.value.as_ref().and(record.kind.clone()), value: record.value.clone(), meta: meta.clone() };
                if held.as_ref().is_some_and(|held| same_kept(Some(held), Some(&given))) {
                    continue;
                }
                let mut envelope = envelope_of_kept(&record.id, &given);
                envelope.exact = true;
                envelopes.push(envelope);
                continue;
            }
            match &record.value {
                None => {
                    if self.kept_or_removed(&record.id)?.is_some() {
                        envelopes.push(Envelope { id: record.id.clone(), purge: true, ..Envelope::default() });
                    }
                }
                Some(value) => {
                    let now = self.kept(&record.id)?;
                    let kind = record.kind.clone().unwrap_or_default();
                    if now.as_ref().is_some_and(|now| now.kind == kind && json_text(&Value::Object(now.value.clone())) == json_text(&Value::Object(value.clone()))) {
                        continue;
                    }
                    envelopes.push(Envelope { id: record.id.clone(), kind: Some(kind), value: Some(value.clone()), ..Envelope::default() });
                }
            }
        }
        if envelopes.is_empty() {
            return Ok(0);
        }
        let row_id = uuidv7((self.clock)());
        let mut sums = self.sums()?;
        for (index, envelope) in envelopes.iter_mut().enumerate() {
            self.apply_envelope(&mut sums, envelope, &seq_from(&row_id, index), true)?;
        }
        self.put_sums(&sums)?;
        self.append(&actor, &envelopes, row_id)?;
        scope.commit().map_err(storage)?;
        Ok(envelopes.len())
    }

    fn records_in_buckets(&self, buckets: &[usize]) -> Result<Vec<BucketRecord>, SyncError> {
        let mut out = Vec::new();
        let mut after = None;
        loop {
            let (records, next) = self.records_in_buckets_page(buckets, after.as_deref(), usize::MAX, usize::MAX)?;
            out.extend(records);
            match next {
                None => return Ok(out),
                Some(cursor) => after = Some(cursor),
            }
        }
    }

    // The cursor is "<bucket>:<id>" of the last record answered: pages walk the asked buckets in order, each in id
    // order, along the `by_bucket` order.
    fn records_in_buckets_page(&self, buckets: &[usize], after: Option<&str>, limit: usize, bytes: usize) -> Result<(Vec<BucketRecord>, Option<String>), SyncError> {
        let mut wanted: Vec<usize> = buckets.to_vec();
        wanted.sort_unstable();
        wanted.dedup();
        let (from_bucket, from_id) = match after.and_then(|after| after.split_once(':')) {
            Some((bucket, id)) => (bucket.parse::<usize>().unwrap_or(0), Some(id.to_string())),
            None => (0, None),
        };
        let mut records = Vec::new();
        let mut size = 0usize;
        let read = [Read::whole("id"), Read::whole("type"), Read::whole("value"), Read::whole("meta")];
        for bucket in wanted.into_iter().filter(|bucket| *bucket >= from_bucket) {
            let mut scope = self.scope_key();
            scope.push(Stored::Integer(bucket as i64));
            let mut from = Bound::Included(scope.clone());
            if bucket == from_bucket {
                if let Some(id) = &from_id {
                    let mut cursor = scope.clone();
                    cursor.push(Stored::from(id.as_str()));
                    from = Bound::Excluded(cursor);
                }
            }
            let page = limit.saturating_sub(records.len()).saturating_add(1).min(1 << 20);
            let range = Range { order: Order::Named("by_bucket"), from, to: Bound::Included(scope), reverse: false, limit: Some(page) };
            for row in self.storage.scan(RECORDS, &range, &read).map_err(storage)? {
                let Some(record) = record_of(&row.0) else { continue };
                let own = record.value.as_ref().map_or(0, |value| json_text(&Value::Object(value.clone())).len());
                // A record that would take the page past its bounds starts the next page: one larger than a whole page
                // is a page of its own.
                if !records.is_empty() && (records.len() >= limit || size.saturating_add(own) > bytes) {
                    let last: &BucketRecord = records.last().expect("a page holds a record");
                    let cursor = format!("{}:{}", bucket_of(&last.id), last.id);
                    return Ok((records, Some(cursor)));
                }
                size += own;
                records.push(record);
            }
        }
        Ok((records, None))
    }

    fn position(&self, copy: &str) -> Result<Option<String>, SyncError> {
        let mut key = self.scope_key();
        key.push(Stored::from(copy));
        let row = self.storage.get(POSITIONS, &key, &[Read::whole("took_through")]).map_err(storage)?;
        Ok(row.and_then(|row| row.0.first().and_then(Stored::as_text).map(str::to_string)))
    }

    fn move_position(&mut self, copy: &str, took_through: Option<&str>, at: &str) -> Result<bool, SyncError> {
        if self.position(copy)?.as_deref() == took_through && took_through.is_some() {
            return Ok(false);
        }
        let row = [
            ("account", Stored::from(self.account.as_str())),
            ("resource", Stored::from(self.resource.as_str())),
            ("copy", Stored::from(copy)),
            ("took_through", took_through.map_or(Stored::Null, Stored::from)),
            ("settled_at", Stored::from(at)),
        ];
        self.storage.put(POSITIONS, &row, When::Always).map_err(storage)?;
        Ok(true)
    }

    fn forget_position(&mut self, copy: &str) -> Result<bool, SyncError> {
        let mut key = self.scope_key();
        key.push(Stored::from(copy));
        let range = Range { order: Order::Key, from: Bound::Included(key.clone()), to: Bound::Included(key), reverse: false, limit: None };
        Ok(self.storage.erase(POSITIONS, &range).map_err(storage)? > 0)
    }
}
