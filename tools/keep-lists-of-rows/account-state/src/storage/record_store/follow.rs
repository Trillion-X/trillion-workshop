// src/storage/record_store/follow.rs
//
// Purpose: a copy of an account's records on another computer follows the writer's change feed. It applies changes the
// writer took, keeps the writer's stamps and versions, and reports how far it has caught up.
//
// Non-Negotiable Invariants:
// - A change keeps the stamp and version the writer gave it. The copy never mints a stamp for it.
// - One page is one write: every change of a page is applied, or none is.
// - A change already held (same id, version and stamp) is a no-op, so a page can be sent again.
// - A change behind the copy's newest stamp that it does not already hold is refused as out of order.
// - A change whose version does not beat the copy's version of that record is refused.
// - A page from a writer whose term number is below the newest term the copy accepted is refused.
// - A record store's feed only. The vault is its own store (`held-values.sqlite`) and travels on its own feed, as the
//   sealed records it holds; the secrets key that opens them never travels here (src/secrets/root.rs).
// - What travels with a change (`Carried`): the record's saved request answers (so a retry at a new writer is answered
//   with its first answer), the versions in between that the copy does not hold yet (so its history is the writer's),
//   and whether the change is an erase (so the copy moves every version of the record into custody, as the writer did,
//   instead of keeping the erased value in its history).
// - A copy that took a change the writer never acknowledged, and was out of reach while another computer took over,
//   rolls that change back when it first hears the new writer (`roll_back_after`): every version after the stamp the
//   new writer held when it took its term goes, and the version live at that stamp is current again.
// - A copy that keeps values sealed (`Carried::sealed`: a computer that only keeps a copy, src/account/computers/sealed.rs)
//   never reads them: it keeps each value and saved answer as they came, matches a change it already holds by version,
//   stamp and deletion only, keeps no erased value in custody (sealed or plain), and marks the scope as holding sealed
//   values until `open_sealed` opens them with the secrets key.
//
// Key Concepts:
// - Writer term: a number the writer role carries. The copy keeps the highest one it accepted for the scope.
// - Caught-up stamp: the newest stamp the copy holds for the scope (`RecordStore::stamp`). It is what the writer's
//   acknowledgement waits on, reported through `FeedSource::caught_up`.
// - The change feed (`Records::changes_page`) lists each record's current version. The writer adds the versions in
//   between from its history (`carried_page`, at most `history_limit` per record), and the copy writes those it does
//   not hold as history rows, so an as-of read answers the same at both.
// - History pages: a change whose versions in between the copy cannot complete from what it carries (`history_gap`:
//   every version after the copy's own, or from the oldest the writer keeps, up to the change's own) is taken only
//   after the copy pulled the rest, one bounded page at a time (`FeedSource::history`, the writer's `history_page`,
//   applied by `apply_history`). Each history page is applied as the writer made those versions, so the record at the
//   copy is a state the writer had; the copy's stamp stays below the change until the change itself is applied, so it
//   never reports holding a change it does not hold whole. A writer that dies in the middle leaves the copy below it.
// - Versions the writer no longer keeps (its undo window ended, or an erase moved them to custody before a later write
//   of the same id) are not sent; each change says the oldest version the writer keeps (`Carried::kept`), and a copy
//   holding an older one drops its own rows of the record, so it keeps no version (and no erased value) the writer
//   has not. Both then answer an as-of read inside the undo window the same.
//
// Security Considerations:
// - The term number is checked against the copy's own stored floor, not against anything the writer says about itself.
// - Refusals leave nothing behind: no row, saved answer or stamp moves.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
//
//! Public API (kept small on purpose; the writer term and Ack lanes build on it):
//! - `RecordStore::apply_from_writer(account, resource, term, changes)`: apply one page of the writer's changes. Returns
//!   what was applied, what was already held, and the caught-up stamp.
//! - `RecordStore::stamp(account, resource)` (in `mod.rs`): the caught-up report of this copy.
//! - `FeedSource`: what a copy asks of the writer's computer: one page after a stamp (with the writer's term
//!   number), and a report that this copy holds a stamp. The forwarder connection will implement it; a test
//!   implements it over a local store.
//! - `catch_up(store, source, account, resource, limit)`: pull pages until the writer has no more, apply each whole
//!   (`apply_page_whole`: versions in between pulled in history pages when a change does not carry them all), and
//!   report the caught-up stamp to the writer. Returns that stamp.
//! - `RecordStore::history_gap`, `RecordStore::history_page`, `RecordStore::apply_history`: what a copy lacks of a change, the writer's side of
//!   one history page, and the copy's side.
//! - `RecordStore::carried_page(account, resource, after, limit, history_limit)`: the writer's side of one page, with what
//!   travels with each change.
//! - `RecordStore::apply_carried(account, resource, term, carried)`: `apply_from_writer` for carried changes.
//! - `RecordStore::roll_back_after(account, resource, base)`: undo every change after `base` (see the invariants).
//! - `RecordStore::open_sealed(account, resource, unseal)` and `RecordStore::holds_sealed`: a copy that kept values sealed
//!   (`Carried::sealed`, a computer that only keeps a copy) opens them once it holds the secrets key.
//! Not here: the writer term itself, the Ack wait, and moving the writer role (src/account/computers).

use super::{exact, ring::Ring, text, unavailable, uncertain, validate, Batch, Bound, Order, Range, Version, Written, CURRENT, CUSTODY, FULL_ROW, VERSIONS};
use crate::{
    records::{changes::Changed, Change, Error, MAX_PAGE_ITEMS},
    storage::{Read as Field, Storage, Value, When},
};
use serde::{Deserialize, Serialize};

/// The family that holds the newest writer term a copy accepted, per (account, resource).
pub(super) const FOLLOW: &str = "follow";
/// The `follow` row that keeps the base of that term (the stamp the writer held when it took it) is the resource's
/// own row with this ending on its resource name. Resource names never hold it (`record_store_resources.json`).
const BASE_ENDING: &str = "\u{1}base";
/// The `follow` row that says the copy holds sealed values of the resource (`Carried::sealed`), until `open_sealed`
/// opens them: the resource's own row with this ending.
const SEALED_ENDING: &str = "\u{1}sealed";
/// The `follow` row that marks a restore (`RecordStore::restore`): the resource's name, this ending, the restore stamp, the
/// separator below and the record id; its `term` is the stamp of the erase it undid. Read by `carried_page`, so the
/// change it made travels as a restore (`Carried::restored`), and kept by a copy that took it, so it travels on from
/// there too.
const RESTORED_ENDING: &str = "\u{1}restored\u{1}";
const RESTORED_SEPARATOR: &str = "\u{1}";

/// The `follow` row key of the restore of `id` at `stamp`.
fn restored_key(account: &str, resource: &str, id: &str, stamp: i64) -> Vec<Value> {
    vec![text(account), Value::Text(format!("{resource}{RESTORED_ENDING}{stamp}{RESTORED_SEPARATOR}{id}"))]
}

/// Mark, inside a write's batch, that the change of `id` at `stamp` is the restore of its erase at `erased_at`.
pub(super) fn mark_restored(batch: &mut Batch, account: &str, resource: &str, id: &str, stamp: i64, erased_at: i64) {
    let mut key = restored_key(account, resource, id, stamp).into_iter();
    let (account, resource) = (key.next().unwrap_or(Value::Null), key.next().unwrap_or(Value::Null));
    batch.put(FOLLOW, vec![("account", account), ("resource", resource), ("lease", Value::Integer(erased_at))], false);
}

/// What one page did to the copy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Applied {
    /// Changes written into the copy.
    pub applied: usize,
    /// Changes the copy already held (same id, version and stamp), so nothing was written for them.
    pub held: usize,
    /// The copy's newest stamp for the scope after the page (its caught-up stamp).
    pub stamp: i64,
}

/// One change as it travels from the writer to a copy: the change, the record's saved request answers, whether it is an
/// erase, and the versions the record had in between.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Carried {
    pub change: Change,
    /// The record's saved request answers as the writer's current row holds them (the text of their ring).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipts: Option<String>,
    /// The change is an erase: the writer moved every version into custody.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub erased: bool,
    /// Versions the record had after the asked stamp and before this change, oldest first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<Past>,
    /// The oldest version of the record the writer still keeps (its history rows and current row; 0 when not told).
    /// Versions below it left the writer (its undo window ended, or an erase took them), so a copy that holds an older
    /// version drops its own rows of the record instead of keeping versions the writer no longer has.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub kept: i64,
    /// This copy keeps the change sealed (src/account/computers/sealed.rs): its values and saved answers are kept as they came
    /// and never read here, a change already held is matched by its version, stamp and deletion only (each seal has a
    /// fresh nonce, so a page sent again carries other bytes), and an erase keeps no value, sealed or plain, in custody.
    /// Set by the receiving computer (`copies.rs`), never trusted from the wire.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sealed: bool,
    /// The change is the operator's restore of the record erased at this stamp (`RecordStore::restore`): a copy that holds
    /// that erase brings the record's versions back from its own custody (and takes the restored versions in `history`,
    /// which then holds them too, not only those after the asked stamp) before it takes the change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restored: Option<i64>,
}

/// One replaced version of a record: live from `from` until `to`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Past {
    pub from: i64,
    pub to: i64,
    pub version: i64,
    pub deleted: bool,
    pub value: Option<serde_json::Value>,
}

impl From<Change> for Carried {
    fn from(change: Change) -> Self {
        Carried { change, receipts: None, erased: false, history: Vec::new(), kept: 0, sealed: false, restored: None }
    }
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

/// One page of the versions in between of one record (`RecordStore::history_page`, `FeedSource::history`), oldest first: the
/// term and base it is sent under, the versions, whether more follow, and the oldest version the source still keeps.
#[derive(Clone, Debug, PartialEq)]
pub struct HistoryPage {
    pub term: u64,
    pub base: i64,
    pub versions: Vec<Past>,
    pub more: bool,
    pub kept: i64,
    /// This copy keeps the versions sealed (set by the receiving computer, never trusted from the wire).
    pub sealed: bool,
}

/// What a copy is missing of one change of a page: the change at `index` of the page needs the versions of `id` after
/// the copy's own `version` (made at stamp `since`), which the change does not carry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Gap {
    pub index: usize,
    pub id: String,
    pub version: i64,
    pub since: i64,
}

/// How a copy opens what it kept sealed (`RecordStore::open_sealed`), given the record version it belongs to: the record id,
/// its version and the stamp it was made at. Each answers `None` for what is not sealed, and an error for what is
/// sealed and does not open.
pub trait Unseal {
    fn value(&self, id: &str, version: i64, from: i64, value: &serde_json::Value) -> Result<Option<serde_json::Value>, Error>;
    fn receipts(&self, id: &str, version: i64, from: i64, text: &str) -> Result<Option<String>, Error>;
}

/// One page the writer answers: its term number and that term's base, its changes after the asked stamp, and
/// whether more follow.
#[derive(Clone, Debug)]
pub struct WriterPage {
    pub term: u64,
    pub base: i64,
    pub changes: Vec<Carried>,
    pub more: bool,
}

/// The writer's side of a copy: the computer the copy pulls from, and where the copy reports its stamp.
pub trait FeedSource {
    /// The writer's changes after `after` (its stamps), at most `limit`, with its term number.
    fn page(&self, account: &str, resource: &str, after: i64, limit: usize) -> Result<WriterPage, Error>;
    /// Tell the writer this copy holds every change up to `stamp`. An Ack waits on this report.
    fn caught_up(&self, account: &str, resource: &str, stamp: i64) -> Result<(), Error>;
    /// One page of the versions of `id` after `version` and before `before`, oldest first (at most `limit`). `since` is
    /// the stamp the copy's own `version` was made at: the source starts its walk there (`RecordStore::history_page`).
    #[allow(clippy::too_many_arguments)]
    fn history(&self, account: &str, resource: &str, id: &str, version: i64, since: i64, before: i64, limit: usize) -> Result<HistoryPage, Error>;
}

/// Pull from `source` until it has no more changes, applying each page. Reports the caught-up stamp to the writer
/// and returns it. A page that moves no stamp ends the pull with an error, so a source that stalls cannot loop forever.
pub fn catch_up<S: Storage + Send>(
    store: &mut super::RecordStore<S>,
    source: &dyn FeedSource,
    account: &str,
    resource: &str,
    limit: usize,
) -> Result<i64, Error> {
    if !(1..=MAX_PAGE_ITEMS).contains(&limit) {
        return Err(Error::Invalid("invalid page size", crate::cause!()));
    }
    loop {
        let before = store.stamp(account, resource)?;
        let page = source.page(account, resource, before, limit)?;
        let applied = store.apply_page_whole(source, account, resource, &page, limit)?;
        if !page.more {
            source.caught_up(account, resource, applied.stamp)?;
            return Ok(applied.stamp);
        }
        if applied.stamp == before {
            return Err(crate::cause!(Error::Unavailable));
        }
    }
}

impl<S: Storage + Send> super::RecordStore<S> {
    /// Apply one page of the writer's changes to this copy, all or nothing. `term` is the writer's term number for
    /// the page; a term below the newest accepted one is refused. Changes must be in increasing stamp order.
    pub fn apply_from_writer(
        &mut self,
        account: &str,
        resource: &str,
        term: u64,
        changes: &[Change],
    ) -> Result<Applied, Error> {
        let carried: Vec<Carried> = changes.iter().cloned().map(Carried::from).collect();
        self.apply_carried(account, resource, term, &carried)
    }

    /// `apply_from_writer` for changes with what travels with them (`Carried`).
    pub fn apply_carried(&mut self, account: &str, resource: &str, term: u64, changes: &[Carried]) -> Result<Applied, Error> {
        self.apply_carried_at(account, resource, term, 0, changes)
    }

    /// `apply_carried`, keeping `base` as the base of `term` when the page moves the copy's floor to it.
    pub fn apply_carried_at(
        &mut self,
        account: &str,
        resource: &str,
        term: u64,
        base: i64,
        changes: &[Carried],
    ) -> Result<Applied, Error> {
        validate(account, resource, "follow")?;
        let term_value = i64::try_from(term).map_err(|_| Error::Invalid("writer term out of range", crate::cause!()))?;
        if changes.len() > MAX_PAGE_ITEMS {
            return Err(Error::Invalid("page holds more changes than the page bound", crate::cause!()));
        }
        self.write(account, resource, |store| store.apply_feed(account, resource, term, term_value, base, changes))
    }

    fn apply_feed(
        &mut self,
        account: &str,
        resource: &str,
        term: u64,
        term_value: i64,
        base: i64,
        changes: &[Carried],
    ) -> Result<Written<Applied>, Error> {
        let floor = self.accepted_term(account, resource)?;
        if term < floor {
            return Err(Error::Invalid("a change from a stale writer term is refused", crate::cause!()));
        }
        if changes.windows(2).any(|pair| pair[1].change.sequence <= pair[0].change.sequence) {
            return Err(Error::Invalid("changes in a page must be in increasing stamp order", crate::cause!()));
        }
        let mut newest = self.newest_stamp(account, resource).map_err(unavailable)?;
        let mut applied = 0;
        let mut held = 0;
        for carried in changes {
            let change = &carried.change;
            validate(account, resource, &change.id)?;
            let receipts = match &carried.receipts {
                // Sealed saved answers are kept as they came: this copy cannot read them.
                Some(text) if carried.sealed => Some(text.clone()),
                Some(text) => Some(Ring::parse(Some(text)).and_then(|ring| ring.text()).ok_or(Error::Invalid("the receipts of a change are unreadable", crate::cause!()))?),
                None => None,
            };
            if change.sequence <= 0 || change.sequence == CURRENT || change.version < 1 {
                return Err(Error::Invalid("a change needs a stamp and a version of one or more", crate::cause!()));
            }
            if change.deleted == change.value.is_some() {
                return Err(Error::Invalid("a deleted change has no value; a live change has one", crate::cause!()));
            }
            let current = self.current(account, resource, &change.id)?;
            if let Some(current) = &current {
                if current.version == change.version && current.valid_from == change.sequence {
                    if current.deleted != change.deleted || (!carried.sealed && current.value()? != change.value) {
                        return Err(Error::Invalid("a held change does not match the writer's change", crate::cause!()));
                    }
                    if !carried.sealed && receipts.is_some() && current.ring != receipts {
                        // The same change, now with the writer's saved answers: keep them, so a retry is answered here.
                        let mut batch = Batch::default();
                        Self::put_version(&mut batch, account, resource, &Version { ring: receipts.clone(), ..current.clone() });
                        batch.send(&self.storage).map_err(uncertain)?;
                        applied += 1;
                        continue;
                    }
                    held += 1;
                    continue;
                }
            }
            if change.sequence <= newest {
                return Err(Error::Invalid("a change is out of order for this copy", crate::cause!()));
            }
            let held_version = current.as_ref().map_or(0, |current| current.version);
            if change.version <= held_version {
                return Err(crate::cause!(Error::Conflict));
            }
            let before = match &current {
                Some(current) if !current.deleted => current.value()?,
                _ => None,
            };
            let mut batch = Batch::default();
            if carried.erased {
                if !change.deleted || !carried.history.is_empty() {
                    return Err(Error::Invalid("an erase is a deletion with no versions in between", crate::cause!()));
                }
                self.erase_from_writer(&mut batch, account, resource, change, receipts, before.as_ref(), carried.sealed)?;
                batch.send(&self.storage).map_err(uncertain)?;
                newest = change.sequence;
                applied += 1;
                continue;
            }
            if let Some(erased_at) = carried.restored {
                // The writer restored the record it erased at `erased_at`: a copy that holds that erase brings the
                // versions back as the writer did, before it takes the restored version below.
                if let Some(tombstone) = current.as_ref().filter(|current| current.deleted && current.valid_from == erased_at) {
                    self.restore_from_writer(&mut batch, account, resource, &change.id, erased_at, tombstone.version, &carried.history)?;
                }
                mark_restored(&mut batch, account, resource, &change.id, change.sequence, erased_at);
            }
            // The writer no longer keeps the versions after this copy's own (its undo window ended, or an erase took
            // them): this copy drops its own rows of the record, so it keeps no version the writer has not, and no
            // erased value.
            let dropped = current.is_some() && carried.kept > held_version + 1;
            if dropped {
                batch.erase(VERSIONS, vec![text(account), text(resource), text(&change.id)]);
            }
            // The versions in between that this copy does not hold, as the writer's history has them.
            let mut between: Vec<&Past> = carried.history.iter().filter(|past| past.version > held_version && past.version < change.version).collect();
            between.sort_by_key(|past| past.version);
            let mut until = change.sequence;
            for (at, past) in between.iter().enumerate() {
                let next_from = between.get(at + 1).map_or(change.sequence, |next| next.from);
                if past.from >= past.to || past.to != next_from || past.deleted == past.value.is_some() {
                    return Err(Error::Invalid("the versions in between do not chain", crate::cause!()));
                }
                if at == 0 {
                    until = past.from;
                }
            }
            if let Some(current) = current.as_ref().filter(|_| !dropped) {
                if until <= current.valid_from {
                    return Err(Error::Invalid("the versions in between start before the copy's own version", crate::cause!()));
                }
                // An `overwrite` resource keeps no history, copies included: the replaced version is rewritten away.
                if !crate::storage::record_store_resources::overwrites(resource) {
                    let replaced = Version { valid_to: until, ring: None, ..current.clone() };
                    Self::put_version(&mut batch, account, resource, &replaced);
                }
            }
            for past in &between {
                let body = past.value.as_ref().map(|value| serde_json::to_vec(value).map_err(|_| Error::Invalid("invalid record value", crate::cause!()))).transpose()?;
                let kind = past.value.as_ref().and_then(|value| self.kind_of(value));
                let row = Version { id: change.id.clone(), valid_from: past.from, valid_to: past.to, version: past.version, deleted: past.deleted, body, ring: None, kind };
                // An overwrite resource keeps no history: every version in between is a replaced one, so none is written.
                if !crate::storage::record_store_resources::overwrites(resource) {
                    Self::put_version(&mut batch, account, resource, &row);
                }
            }
            let body = change
                .value
                .as_ref()
                .map(|value| serde_json::to_vec(value).map_err(|_| Error::Invalid("invalid record value", crate::cause!())))
                .transpose()?;
            if body.as_ref().is_some_and(|body| body.len() > self.limits().max_record_bytes) {
                return Err(Error::Invalid("record exceeds the host's record bound", crate::cause!()));
            }
            let next = Version {
                id: change.id.clone(),
                valid_from: change.sequence,
                valid_to: CURRENT,
                version: change.version,
                deleted: change.deleted,
                body,
                ring: receipts,
                kind: change.value.as_ref().and_then(|value| self.kind_of(value)),
            };
            Self::put_version(&mut batch, account, resource, &next);
            self.written.push(Changed {
                scope: None, resource: resource.to_owned(),
                kind: next.kind.clone(),
                id: change.id.clone(),
                sequence: change.sequence,
            });
            self.search_changed(account, resource, &change.id, change.sequence, change.value.as_ref()).map_err(uncertain)?;
            self.index_derived(&mut batch, account, resource, &change.id, before.as_ref(), change.value.as_ref())?;
            batch.send(&self.storage).map_err(uncertain)?;
            // The exit step runs at every applied change, as it does at a local write (`mutate`): the replaced versions the
            // writer no longer keeps leave the copy too, a bounded step at a time. A copy that is never written to would
            // keep them forever otherwise.
            self.exit_step(account, resource, change.sequence).map_err(uncertain)?;
            newest = change.sequence;
            applied += 1;
        }
        let term_moves = term > floor;
        if term_moves {
            for row in Self::term_rows(account, resource, term_value, base) {
                self.storage.put(FOLLOW, &row, When::Always).map_err(uncertain)?;
            }
        }
        if applied > 0 && changes.iter().any(|carried| carried.sealed) {
            self.storage.put(FOLLOW, &Self::sealed_row(account, resource, 1), When::Always).map_err(uncertain)?;
        }
        let outcome = Applied { applied, held, stamp: newest };
        if applied == 0 && !term_moves {
            return Ok(Written::Keep(outcome));
        }
        if self.storage.allocated_bytes().map_err(uncertain)? > self.limits().byte_budget {
            return Err(Error::Invalid("the store's byte budget would be exceeded", crate::cause!()));
        }
        let stamp = (applied > 0).then_some(newest);
        Ok(Written::Commit(outcome, stamp))
    }

    /// Apply one page of the writer's feed whole: every change with every version in between the writer keeps. A
    /// change whose versions in between the page does not carry in full (it carries at most `feed_history_items`, and
    /// a page must fit `message_body_bytes`) is filled first from `source`, one bounded history page at a time
    /// (`fill_history`), after the changes before it are applied. The copy's caught-up stamp passes a change only once
    /// it holds all of it: while it fills, its stamp stays below the change's own.
    pub fn apply_page_whole(&mut self, source: &dyn FeedSource, account: &str, resource: &str, page: &WriterPage, limit: usize) -> Result<Applied, Error> {
        let mut rest: &[Carried] = &page.changes;
        let mut from = 0;
        let (mut applied, mut held) = (0, 0);
        while let Some(gap) = self.history_gap(account, resource, rest, from)? {
            if gap.index > 0 {
                let done = self.apply_carried_at(account, resource, page.term, page.base, &rest[..gap.index])?;
                applied += done.applied;
                held += done.held;
            }
            let carried = &rest[gap.index];
            self.fill_history(source, account, resource, carried.change.version, &gap, limit)?;
            rest = &rest[gap.index..];
            if self.history_gap(account, resource, &rest[..1], 0)?.is_some() {
                // The source did not send what it keeps: the change is not taken, so the stamp does not pass it.
                return Err(crate::cause!(Error::Unavailable));
            }
            from = 1;
        }
        let done = self.apply_carried_at(account, resource, page.term, page.base, rest)?;
        Ok(Applied { applied: applied + done.applied, held: held + done.held, stamp: done.stamp })
    }

    /// Pull the versions in between of the change `gap` names (before version `before`) from `source`, page by page,
    /// and apply each (`apply_history`).
    fn fill_history(&mut self, source: &dyn FeedSource, account: &str, resource: &str, before: i64, gap: &Gap, limit: usize) -> Result<(), Error> {
        let (mut version, mut since) = (gap.version, gap.since);
        loop {
            let page = source.history(account, resource, &gap.id, version, since, before, limit)?;
            let last = page.versions.last().map(|past| (past.version, past.from));
            self.apply_history(account, resource, page.term, page.base, &gap.id, page.kept, &page.versions, page.sealed)?;
            if !page.more {
                return Ok(());
            }
            match last {
                Some((last, from)) if last > version => (version, since) = (last, from),
                // A source that says more follow but sends nothing new cannot loop forever.
                _ => return Err(crate::cause!(Error::Unavailable)),
            }
        }
    }

    /// The first change of `changes` (from `from` on) whose versions in between this copy cannot complete from what
    /// the change carries: it needs every version after its own (or from the oldest the writer keeps, `kept`) up to
    /// the change's own. An erase carries none (the copy moves the record into custody).
    pub fn history_gap(&self, account: &str, resource: &str, changes: &[Carried], from: usize) -> Result<Option<Gap>, Error> {
        for (index, carried) in changes.iter().enumerate().skip(from) {
            if carried.erased {
                continue;
            }
            let change = &carried.change;
            validate(account, resource, &change.id)?;
            let (held, since) = self.current(account, resource, &change.id)?.map_or((0, 0), |current| (current.version, current.valid_from));
            if held >= change.version {
                continue;
            }
            let mut need = (held + 1).max(carried.kept);
            let mut versions: Vec<i64> = carried.history.iter().map(|past| past.version).filter(|version| *version >= need && *version < change.version).collect();
            versions.sort_unstable();
            versions.dedup();
            let mut whole = true;
            for version in versions {
                if version != need {
                    whole = false;
                    break;
                }
                need += 1;
            }
            if !whole || need != change.version {
                return Ok(Some(Gap { index, id: change.id.clone(), version: held, since }));
            }
        }
        Ok(None)
    }

    /// Apply one history page of record `id` (oldest first) to this copy, in one write: each version is taken as the
    /// writer made it, in order, so the newest of the page is the record's current version here until the change it
    /// leads to arrives. Every state the copy passes through is one the writer had; its caught-up stamp stays below
    /// that change's stamp. Versions already held are skipped; the first new one must follow the copy's own version,
    /// or be the oldest the writer keeps (`kept`), when the copy then drops its own rows of the record (the writer no
    /// longer keeps them: undo window or erase). Refused below the copy's term floor. At a copy that keeps values
    /// sealed (`sealed`) the values are kept as they came. Answers how many versions were written.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_history(&mut self, account: &str, resource: &str, term: u64, base: i64, id: &str, kept: i64, versions: &[Past], sealed: bool) -> Result<usize, Error> {
        validate(account, resource, id)?;
        let term_value = i64::try_from(term).map_err(|_| Error::Invalid("writer term out of range", crate::cause!()))?;
        if versions.len() > MAX_PAGE_ITEMS {
            return Err(Error::Invalid("page holds more versions than the page bound", crate::cause!()));
        }
        let written = self.write(account, resource, |store| {
            let floor = store.accepted_term(account, resource)?;
            if term < floor {
                return Err(Error::Invalid("a change from a stale writer term is refused", crate::cause!()));
            }
            let current = store.current(account, resource, id)?;
            let held = current.as_ref().map_or(0, |current| current.version);
            let fresh: Vec<&Past> = versions.iter().filter(|past| past.version > held).collect();
            let dropped = current.is_some() && kept > held + 1;
            for (at, past) in fresh.iter().enumerate() {
                if past.from >= past.to || past.to == CURRENT || past.deleted == past.value.is_some() {
                    return Err(Error::Invalid("the versions in between do not chain", crate::cause!()));
                }
                if let Some(next) = fresh.get(at + 1) {
                    if next.version != past.version + 1 || next.from != past.to {
                        return Err(Error::Invalid("the versions in between do not chain", crate::cause!()));
                    }
                }
            }
            let Some(first) = fresh.first() else {
                if !dropped {
                    return Ok(Written::Keep(0));
                }
                // The writer keeps none of the versions after the copy's own: only the drop is made.
                let mut batch = Batch::default();
                let before = match &current { Some(current) if !current.deleted => current.value()?, _ => None };
                batch.erase(VERSIONS, vec![text(account), text(resource), text(id)]);
                store.search_erase(account, resource, id).map_err(uncertain)?;
                store.index_derived(&mut batch, account, resource, id, before.as_ref(), None)?;
                batch.send(&store.storage).map_err(uncertain)?;
                return Ok(Written::Commit(0, None));
            };
            if (dropped && first.version != kept) || (!dropped && first.version != held + 1) {
                return Err(Error::Invalid("the versions in between do not follow the copy's own", crate::cause!()));
            }
            let before = match &current { Some(current) if !current.deleted => current.value()?, _ => None };
            let mut batch = Batch::default();
            if dropped {
                batch.erase(VERSIONS, vec![text(account), text(resource), text(id)]);
            } else if let Some(current) = &current {
                if first.from <= current.valid_from {
                    return Err(Error::Invalid("the versions in between start before the copy's own version", crate::cause!()));
                }
                if !crate::storage::record_store_resources::overwrites(resource) {
                    Self::put_version(&mut batch, account, resource, &Version { valid_to: first.from, ring: None, ..current.clone() });
                }
            }
            let last = fresh.len() - 1;
            for (at, past) in fresh.iter().enumerate() {
                let body = past.value.as_ref().map(|value| serde_json::to_vec(value).map_err(|_| Error::Invalid("invalid record value", crate::cause!()))).transpose()?;
                if body.as_ref().is_some_and(|body| body.len() > store.limits().max_record_bytes) {
                    return Err(Error::Invalid("record exceeds the host's record bound", crate::cause!()));
                }
                let kind = past.value.as_ref().and_then(|value| store.kind_of(value));
                let valid_to = if at == last { CURRENT } else { past.to };
                let row = Version { id: id.to_owned(), valid_from: past.from, valid_to, version: past.version, deleted: past.deleted, body, ring: None, kind };
                // An overwrite resource keeps no history: only the current version (the last) is written.
                if at == last || !crate::storage::record_store_resources::overwrites(resource) {
                    Self::put_version(&mut batch, account, resource, &row);
                }
            }
            let newest = fresh[last];
            store.written.push(Changed { scope: None, resource: resource.to_owned(), kind: newest.value.as_ref().and_then(|value| store.kind_of(value)), id: id.to_owned(), sequence: newest.from });
            store.search_changed(account, resource, id, newest.from, newest.value.as_ref()).map_err(uncertain)?;
            store.index_derived(&mut batch, account, resource, id, before.as_ref(), newest.value.as_ref())?;
            batch.send(&store.storage).map_err(uncertain)?;
            store.exit_step(account, resource, newest.from).map_err(uncertain)?;
            if term > floor {
                for row in Self::term_rows(account, resource, term_value, base) {
                    store.storage.put(FOLLOW, &row, When::Always).map_err(uncertain)?;
                }
            }
            if sealed {
                store.storage.put(FOLLOW, &Self::sealed_row(account, resource, 1), When::Always).map_err(uncertain)?;
            }
            if store.storage.allocated_bytes().map_err(uncertain)? > store.limits().byte_budget {
                return Err(Error::Invalid("the store's byte budget would be exceeded", crate::cause!()));
            }
            Ok(Written::Commit(fresh.len(), None))
        })?;
        // The scope's newest stamp may have moved: forget the remembered one, so the next write reads it again.
        self.stamps.remove(&(account.to_owned(), resource.to_owned()));
        Ok(written)
    }

    /// An erase the writer made, applied at this copy inside the page's write: every version of the record moves into
    /// custody under the writer's erase stamp (so the operator's undo window and the exit step treat it as at the
    /// writer), and the record keeps only the writer's tombstone, with its saved answers and no value. At a copy that keeps
    /// values sealed (`sealed`), the versions go to custody with no value at all.
    fn erase_from_writer(
        &mut self,
        batch: &mut Batch,
        account: &str,
        resource: &str,
        change: &Change,
        receipts: Option<String>,
        before: Option<&serde_json::Value>,
        sealed: bool,
    ) -> Result<(), Error> {
        let key = vec![text(account), text(resource), text(&change.id)];
        let rows = self.scan_rows(VERSIONS, &exact(key.clone()), &FULL_ROW).map_err(unavailable)?;
        let mut kind = None;
        for row in rows {
            let mut version = Version::from_row(row, CURRENT)?;
            if version.valid_to == CURRENT {
                kind = version.kind.clone();
            }
            if sealed {
                // A copy that keeps values sealed keeps no erased value in custody, not even sealed: only the writer
                // can restore, and the erased value must not outlive the erase anywhere it cannot be restored.
                version.body = None;
            }
            let mut fields = version.fields(account, resource);
            fields.push(("erased_at", Value::Integer(change.sequence)));
            batch.put(CUSTODY, fields, true);
        }
        batch.erase(VERSIONS, key);
        self.search_erase(account, resource, &change.id).map_err(uncertain)?;
        self.index_derived(batch, account, resource, &change.id, before, None)?;
        let tombstone = Version {
            id: change.id.clone(),
            valid_from: change.sequence,
            valid_to: CURRENT,
            version: change.version,
            deleted: true,
            body: None,
            ring: receipts,
            kind: kind.clone(),
        };
        Self::put_version(batch, account, resource, &tombstone);
        self.written.push(Changed { scope: None, resource: resource.to_owned(), kind, id: change.id.clone(), sequence: change.sequence });
        Ok(())
    }

    /// The writer's restore of the record `id` it erased at `erased_at`, applied at this copy inside the page's write,
    /// whose current row is that erase's tombstone (version `tombstone`): every version this copy keeps in custody under
    /// the erase comes back as history (the one current at the erase closed at it), and the versions the writer brought
    /// back that travel with the change (`history`, before the tombstone) replace them, values as they came (sealed
    /// at a copy that keeps values sealed). A copy that keeps values sealed kept no value in custody: a live version
    /// with no value does not come back from custody, only from `history` (at most `feed_history_items` of them).
    #[allow(clippy::too_many_arguments)]
    fn restore_from_writer(
        &mut self,
        batch: &mut Batch,
        account: &str,
        resource: &str,
        id: &str,
        erased_at: i64,
        tombstone: i64,
        history: &[Past],
    ) -> Result<(), Error> {
        let key = vec![Value::Integer(erased_at), text(account), text(resource), text(id)];
        let rows = self.scan_rows(CUSTODY, &exact(key.clone()), &FULL_ROW).map_err(unavailable)?;
        for row in rows {
            let mut version = Version::from_row(row, CURRENT)?;
            if !version.deleted && version.body.is_none() {
                continue;
            }
            if version.valid_to == CURRENT {
                version.valid_to = erased_at;
            }
            version.ring = None;
            Self::put_version(batch, account, resource, &version);
        }
        batch.erase(CUSTODY, key);
        for past in history.iter().filter(|past| past.version < tombstone && past.to <= erased_at) {
            if past.from >= past.to || past.deleted == past.value.is_some() {
                return Err(Error::Invalid("a restored version is not a version", crate::cause!()));
            }
            let body = past.value.as_ref().map(|value| serde_json::to_vec(value).map_err(|_| Error::Invalid("invalid record value", crate::cause!()))).transpose()?;
            let kind = past.value.as_ref().and_then(|value| self.kind_of(value));
            let row = Version { id: id.to_owned(), valid_from: past.from, valid_to: past.to, version: past.version, deleted: past.deleted, body, ring: None, kind };
            // It may be there already, brought back from custody just above: the writer's row replaces it.
            batch.put(VERSIONS, row.fields(account, resource), false);
        }
        Ok(())
    }

    /// Open every sealed value and sealed saved answers this copy holds of the scope (a computer that kept them sealed and now
    /// holds the root: one the account's row named answering later), in one write: each version row's value and the
    /// current row's saved answers become plain, and the current version's kind, search entries, orders and totals are
    /// built as a write would have built them. A row that is not sealed is left as it is. Anything that does not open
    /// refuses the whole step and changes nothing. Answers how many rows were opened.
    pub fn open_sealed(&mut self, account: &str, resource: &str, unseal: &dyn Unseal) -> Result<usize, Error> {
        validate(account, resource, "sealed")?;
        if !self.holds_sealed(account, resource)? {
            return Ok(0);
        }
        self.write(account, resource, |store| {
            let rows = store.scan_rows(VERSIONS, &exact(vec![text(account), text(resource)]), &FULL_ROW).map_err(unavailable)?;
            let mut opened = 0;
            for row in rows {
                let mut version = Version::from_row(row, CURRENT)?;
                let mut changed = false;
                let sealed_value = version.value()?;
                if let Some(value) = &sealed_value {
                    if let Some(plain) = unseal.value(&version.id, version.version, version.valid_from, value)? {
                        let body = serde_json::to_vec(&plain).map_err(|_| Error::Invalid("invalid record value", crate::cause!()))?;
                        version.kind = store.kind_of(&plain);
                        version.body = Some(body);
                        changed = true;
                    }
                }
                if let Some(ring) = &version.ring {
                    if let Some(plain) = unseal.receipts(&version.id, version.version, version.valid_from, ring)? {
                        version.ring = Some(Ring::parse(Some(&plain)).and_then(|ring| ring.text()).ok_or(Error::Invalid("the receipts of a change are unreadable", crate::cause!()))?);
                        changed = true;
                    }
                }
                if !changed {
                    continue;
                }
                let mut batch = Batch::default();
                // The row is there already: replace it where it is (a history row is otherwise written only as new).
                batch.put(VERSIONS, version.fields(account, resource), false);
                if version.valid_to == CURRENT && !version.deleted {
                    let value = version.value()?;
                    store.search_changed(account, resource, &version.id, version.valid_from, value.as_ref()).map_err(uncertain)?;
                    store.index_derived(&mut batch, account, resource, &version.id, sealed_value.as_ref(), value.as_ref())?;
                }
                batch.send(&store.storage).map_err(uncertain)?;
                opened += 1;
            }
            store.storage.put(FOLLOW, &Self::sealed_row(account, resource, 0), When::Always).map_err(uncertain)?;
            Ok(Written::Commit(opened, None))
        })
    }

    /// Undo every change of the scope after the stamp `base`: the copy took them from a writer that never
    /// acknowledged them, and the new writer's history starts at `base`. For each record changed after `base`, every
    /// version from after `base` goes and the version live at `base` is current again (no record, when it had none).
    /// An erase after `base` is undone too: the versions it moved into custody come back first (at a copy that keeps
    /// values sealed, custody kept no value, so a live version does not come back from there; see the status doc).
    /// The version made current again keeps the record's saved answers of changes up to `base` (those after go with their
    /// versions); sealed saved answers cannot be read here, so at a copy that keeps them sealed it has none until the writer
    /// next sends the record. Answers how many records were rolled back.
    pub fn roll_back_after(&mut self, account: &str, resource: &str, base: i64) -> Result<usize, Error> {
        validate(account, resource, "follow")?;
        if base < 0 {
            return Err(Error::Invalid("invalid rollback stamp", crate::cause!()));
        }
        let rolled = self.write(account, resource, |store| {
            let mut ids = Vec::new();
            let mut cursor = base;
            loop {
                let page = store.changes_page_readonly(account, resource, cursor, MAX_PAGE_ITEMS)?;
                ids.extend(page.items.iter().map(|change| change.id.clone()));
                match page.next {
                    Some(next) => cursor = next,
                    None => break,
                }
            }
            if ids.is_empty() {
                return Ok(Written::Keep(0));
            }
            // The erases after `base`, by record: their custody rows come back with the rollback.
            let erased_after = {
                let range = crate::storage::Range::all().after(vec![Value::Integer(base), text(account), text(resource), text("")]);
                let rows = store.scan_rows(CUSTODY, &range, &super::EXIT_CUSTODY).map_err(unavailable)?;
                let mut erased: Vec<(i64, String)> = Vec::new();
                for mut row in rows {
                    let (at, owner, scope, id) = (row.take(0), row.take(1), row.take(2), row.take(3));
                    let (Some(at), Some(owner), Some(scope), Some(id)) = (at.as_integer(), owner.as_text(), scope.as_text(), id.as_text()) else {
                        return Err(crate::cause!(Error::Unavailable));
                    };
                    if at > base && owner == account && scope == resource && !erased.iter().any(|(held, named)| *held == at && named == id) {
                        erased.push((at, id.to_owned()));
                    }
                }
                erased
            };
            for id in &ids {
                let key = vec![text(account), text(resource), text(id)];
                let rows = store.scan_rows(VERSIONS, &exact(key.clone()), &FULL_ROW).map_err(unavailable)?;
                let mut versions: Vec<Version> = rows.into_iter().map(|row| Version::from_row(row, CURRENT)).collect::<Result<_, _>>()?;
                let current = versions.iter().find(|version| version.valid_to == CURRENT).cloned();
                let mut batch = Batch::default();
                for (at, _) in erased_after.iter().filter(|(_, named)| named == id) {
                    let custody = vec![Value::Integer(*at), text(account), text(resource), text(id)];
                    for row in store.scan_rows(CUSTODY, &exact(custody.clone()), &FULL_ROW).map_err(unavailable)? {
                        let version = Version::from_row(row, CURRENT)?;
                        if version.deleted || version.body.is_some() {
                            versions.push(version);
                        }
                    }
                    batch.erase(CUSTODY, custody);
                }
                let kept = versions.iter().find(|version| version.valid_from <= base && version.valid_to > base).cloned();
                let before = match &current {
                    Some(current) if !current.deleted => current.value()?,
                    _ => None,
                };
                // The saved answers of changes up to `base`, from the current row that goes (when they are readable here).
                let receipts = current.as_ref().and_then(|current| Ring::parse(current.ring.as_deref()))
                    .map(|ring| Ring(ring.0.into_iter().filter(|receipt| receipt.at <= base).collect()))
                    .filter(|ring| !ring.0.is_empty())
                    .and_then(|ring| ring.text());
                batch.erase(VERSIONS, key);
                // A restore after `base` of an erase at or before it (marked at the current row's stamp): the erase
                // stands again, so the versions it held go back into custody under it, as the writer still holds them
                // (with no value at a copy that keeps values sealed).
                let restore = match &current {
                    Some(current) if current.valid_from > base => {
                        let marker = restored_key(account, resource, id, current.valid_from);
                        let row = store.storage().get(FOLLOW, &marker, &[Field::whole("lease")]).map_err(unavailable)?;
                        row.and_then(|mut row| row.take(0).as_integer()).filter(|erased_at| *erased_at <= base).map(|erased_at| (erased_at, marker))
                    }
                    _ => None,
                };
                let sealed = store.holds_sealed(account, resource)?;
                for version in versions.iter().filter(|version| version.valid_to <= base) {
                    match &restore {
                        Some((erased_at, _)) if version.valid_to <= *erased_at => {
                            let valid_to = if version.valid_to == *erased_at { CURRENT } else { version.valid_to };
                            let held = Version { valid_to, body: if sealed { None } else { version.body.clone() }, ..version.clone() };
                            let mut fields = held.fields(account, resource);
                            fields.push(("erased_at", Value::Integer(*erased_at)));
                            batch.put(CUSTODY, fields, false);
                        }
                        _ => Self::put_version(&mut batch, account, resource, &Version { ring: None, ..version.clone() }),
                    }
                }
                if let Some((_, marker)) = &restore {
                    batch.erase(FOLLOW, marker.clone());
                }
                let after = match &kept {
                    Some(kept) => {
                        let restored = Version { valid_to: CURRENT, ring: kept.ring.clone().or(receipts), ..kept.clone() };
                        Self::put_version(&mut batch, account, resource, &restored);
                        if restored.deleted { None } else { restored.value()? }
                    }
                    None => None,
                };
                store.search_erase(account, resource, id).map_err(uncertain)?;
                if let (Some(kept), Some(value)) = (&kept, &after) {
                    store.search_changed(account, resource, id, kept.valid_from, Some(value)).map_err(uncertain)?;
                }
                store.index_derived(&mut batch, account, resource, id, before.as_ref(), after.as_ref())?;
                batch.send(&store.storage).map_err(uncertain)?;
            }
            Ok(Written::Commit(ids.len(), None))
        })?;
        // The scope's newest stamp went back: forget the remembered one, so the next write reads it again.
        self.stamps.remove(&(account.to_owned(), resource.to_owned()));
        Ok(rolled)
    }
}

/// The writer's side, readable over a supply lent from an open transaction (which is not `Send`).
impl<S: Storage> super::RecordStore<S> {
    /// The newest writer term this copy accepted for the scope (0 when none).
    pub fn accepted_term(&self, account: &str, resource: &str) -> Result<u64, Error> {
        Ok(self.accepted(account, resource)?.0)
    }

    /// The newest writer term this copy accepted for the scope and its base (the stamp that writer held of the scope
    /// when it took the term); (0, 0) when none.
    pub fn accepted(&self, account: &str, resource: &str) -> Result<(u64, i64), Error> {
        validate(account, resource, "lease")?;
        let read = |name: String| -> Result<i64, Error> {
            let key = [text(account), Value::Text(name)];
            let row = self.storage().get(FOLLOW, &key, &[Field::whole("lease")]).map_err(unavailable)?;
            Ok(row.and_then(|mut row| row.take(0).as_integer()).unwrap_or(0))
        };
        let term = u64::try_from(read(resource.to_owned())?).unwrap_or(0);
        let base = read(format!("{resource}{BASE_ENDING}"))?;
        Ok((term, base))
    }

    /// Whether this copy holds sealed values of the scope that `open_sealed` has not opened yet.
    pub fn holds_sealed(&self, account: &str, resource: &str) -> Result<bool, Error> {
        validate(account, resource, "sealed")?;
        let key = [text(account), Value::Text(format!("{resource}{SEALED_ENDING}"))];
        let row = self.storage().get(FOLLOW, &key, &[Field::whole("lease")]).map_err(unavailable)?;
        Ok(row.and_then(|mut row| row.take(0).as_integer()).unwrap_or(0) > 0)
    }

    fn sealed_row(account: &str, resource: &str, held: i64) -> Vec<(&'static str, Value)> {
        vec![("account", text(account)), ("resource", Value::Text(format!("{resource}{SEALED_ENDING}"))), ("lease", Value::Integer(held))]
    }

    fn term_rows(account: &str, resource: &str, term_value: i64, base: i64) -> [Vec<(&'static str, Value)>; 2] {
        [
            vec![("account", text(account)), ("resource", text(resource)), ("lease", Value::Integer(term_value))],
            vec![("account", text(account)), ("resource", Value::Text(format!("{resource}{BASE_ENDING}"))), ("lease", Value::Integer(base))],
        ]
    }

    /// This computer takes term `term` as the writer of the scope, holding `base` (its stamp when it took it): its own
    /// floor and base move there, so its own later changes count as that term's. Nothing moves for a term at or below
    /// the floor. May run inside a lent write transaction (it joins it).
    pub fn take_term(&mut self, account: &str, resource: &str, term: u64, base: i64) -> Result<(), Error> {
        validate(account, resource, "lease")?;
        let term_value = i64::try_from(term).map_err(|_| Error::Invalid("writer term out of range", crate::cause!()))?;
        self.write(account, resource, |store| {
            if term <= store.accepted_term(account, resource)? {
                return Ok(Written::Keep(()));
            }
            for row in Self::term_rows(account, resource, term_value, base) {
                store.storage.put(FOLLOW, &row, When::Always).map_err(uncertain)?;
            }
            Ok(Written::Commit((), None))
        })
    }

    /// The writer's side of one page of its feed after `after`: each changed record at its newest version, with its
    /// saved answers, whether it was erased (its erase is still in custody), and at most `history_limit` of the versions it
    /// had in between (the newest of them), oldest first. `more` says another page follows.
    pub fn carried_page(&self, account: &str, resource: &str, after: i64, limit: usize, history_limit: usize) -> Result<(Vec<Carried>, bool), Error> {
        let page = self.changes_page_readonly(account, resource, after, limit)?;
        let more = page.next.is_some();
        let mut carried = Vec::with_capacity(page.items.len());
        for change in page.items {
            let restored = if change.deleted {
                None
            } else {
                let key = restored_key(account, resource, &change.id, change.sequence);
                let row = self.storage().get(FOLLOW, &key, &[Field::whole("lease")]).map_err(unavailable)?;
                row.and_then(|mut row| row.take(0).as_integer())
            };
            let key = vec![text(account), text(resource), text(&change.id)];
            let rows = self.scan_rows(VERSIONS, &exact(key), &FULL_ROW).map_err(unavailable)?;
            let mut receipts = None;
            let mut history = Vec::new();
            let mut kept = change.version;
            for row in rows {
                let version = Version::from_row(row, CURRENT)?;
                // A restore also carries the versions it brought back (they end at or before the erase).
                let brought_back = restored.is_some_and(|erased_at| version.valid_to <= erased_at);
                kept = kept.min(version.version);
                if version.valid_to == CURRENT {
                    receipts = version.ring.clone();
                } else if (version.valid_to > after || brought_back) && version.version < change.version {
                    history.push(Past { from: version.valid_from, to: version.valid_to, version: version.version, deleted: version.deleted, value: version.value()? });
                }
            }
            history.sort_by_key(|past| past.version);
            if history.len() > history_limit {
                history.drain(..history.len() - history_limit);
            }
            let erased = change.deleted && {
                let key = vec![Value::Integer(change.sequence), text(account), text(resource), text(&change.id)];
                !self.scan_rows(CUSTODY, &exact(key), &[Field::whole("id")]).map_err(unavailable)?.is_empty()
            };
            if erased {
                history.clear();
            }
            carried.push(Carried { change, receipts, erased, history, kept, sealed: false, restored });
        }
        Ok((carried, more))
    }

    /// The writer's side of one history page (`FeedSource::history`): the versions of `id` after `version` and before
    /// `before`, oldest first, at most `limit`, whether more follow, and the oldest version this store still keeps of
    /// the record (0 when it holds none). The walk starts at the rows that ended after `since` (the stamp the asking
    /// copy's own version was made at), so a page costs its own rows, never the record's whole history.
    #[allow(clippy::too_many_arguments)]
    pub fn history_page(&self, account: &str, resource: &str, id: &str, version: i64, since: i64, before: i64, limit: usize) -> Result<(Vec<Past>, bool, i64), Error> {
        validate(account, resource, id)?;
        if !(1..=MAX_PAGE_ITEMS).contains(&limit) {
            return Err(Error::Invalid("invalid page size", crate::cause!()));
        }
        let scope = vec![text(account), text(resource), text(id)];
        let oldest = Range { order: Order::Key, from: Bound::Included(scope.clone()), to: Bound::Included(scope.clone()), reverse: false, limit: Some(1) };
        let kept = match self.scan_rows(VERSIONS, &oldest, &FULL_ROW).map_err(unavailable)?.pop() {
            Some(row) => Version::from_row(row, CURRENT)?.version,
            None => 0,
        };
        let mut versions = Vec::new();
        let mut walked = since;
        loop {
            let range = Range {
                order: Order::Key,
                from: Bound::Excluded([scope.as_slice(), &[Value::Integer(walked)]].concat()),
                to: Bound::Included(scope.clone()),
                reverse: false,
                limit: Some(limit + 2),
            };
            let rows = self.scan_rows(VERSIONS, &range, &FULL_ROW).map_err(unavailable)?;
            let full = rows.len() == limit + 2;
            for row in rows {
                let row = Version::from_row(row, CURRENT)?;
                walked = row.valid_to;
                if row.valid_to == CURRENT || row.version >= before {
                    return Ok((versions, false, kept));
                }
                if row.version <= version {
                    continue;
                }
                if versions.len() == limit {
                    return Ok((versions, true, kept));
                }
                versions.push(Past { from: row.valid_from, to: row.valid_to, version: row.version, deleted: row.deleted, value: row.value()? });
            }
            if !full {
                return Ok((versions, false, kept));
            }
        }
    }
}
