// src/storage/record_store/referrers.rs
//
// Purpose: What points to a record: the referrers index. A record kind declares, as DATA (`settings.json` `referrer_parts`),
// the fields where its records name other records (one id, a list of ids, or a list of objects each naming one), each
// under a role. The store keeps one `kept_holders` row per (named record, referrer, role, ordinal) beside every write, so
// "what holds this record" is one range of that index, each referrer checked against its current value before it is
// answered. This is participation read the other way: what a record is inside.
//
// Ported one to one from old trillion (tag old-trillion-before-worker-retire):
// - `parts/record-log/do-work/record-model.mjs:224` `partsOf` (a kind's parts: `role`, `path`, `each`, `role_from`,
//   `id_prefix`, `absolute_prefix`, `absolute_only`) and `:27` `isId`, `:67` `at`;
// - `parts/record-log/do-work/record-log-store.mjs:241` `holderKey` (`p|participant|referrer|role|ordinal`), `:1198` the
//   referrer keys a write keeps, and `:3843` `holdersOf` (one raw key page of `max(256, limit * 4)` bounds the candidates;
//   referrers in id order after `after`; a referrer cut by the page is read whole once; `next` is a referrer id, never an
//   ordinal; a byte budget of `min(record bounds, 2 MiB)` stops the page between referrers).
// - `record-model.mjs` `setsOf` (one interaction set per role over a list: its members in order, named `set:` and the
//   first 32 hex of BLAKE3 over their ids' JSON), `record-log-store.mjs:243` `setKey` (`s|set|referrer|role`), `:245`
//   `setHash`, and `set(name)` (:3818: one range of set keys, each referrer checked against the record it names);
// - `record-log-store.mjs:1438-1451` the model walk's state (`parts`: the signature each kind was last walked under;
//   `walking`: the kind, cursor and signature of the walk in progress), `kindsToWalk`, `partsPending`, and `:2318`
//   `buildModel`'s parts phase: one page of a kind's own records (`MODEL_PAGE` 256, here `settings.json`
//   `referrers_walk_rows`) whose keys and cursor are written in one write, so a restart walks on from the point whose keys
//   exist. A kind whose declared parts change (its signature, old `signatureOf`) is walked again.
// The own-record composition supplies the current installed model's logical parts with its explicit stored-value
// envelope; bare stores may still use settings DATA. The same parts owner serves both forms. Dropped: the model
// walk's second phase (`seen_walked`: every record once for the value kinds its properties hold) belongs to the record
// model's property inventory, which this store does not keep. `narrow_model` and `model_budget` (bounded reads of
// declaring records) have no declaring records to read here.
//
// Non-Negotiable Invariants:
// - The index changes in the same write as the record (`index_derived`, inside the write scope): a refused or rolled
//   back write leaves it as it was. Only keys that changed are written or erased.
// - An id is text, not empty, with no `/` and no NUL (old `isId`); anything else is no part.
// - `referrers_of` answers only parts the referrer's current value still holds: a key left by a crash or an older rule is
//   never an answer. A page holds at most `limit` referrers (1..=1000, default 100) before finishing its last referrer.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{
    text, unavailable, uncertain, validate, Batch, Bound, Field, Order, Range, RecordStore,
    Storage, Value, Written,
};
use crate::records::Error;
use content_crypto::advanced::blake3;
use serde::Deserialize;
use std::collections::BTreeSet;

pub(super) const REFERRERS: &str = "kept_holders";
pub(super) const SETS: &str = "kept_sets";
const WALK: &str = "kept_holders_walk";
const SEP: char = '\u{0}';
/// The ordinal stored for a part that names one id (old `ordinal ?? ''`, which sorts before every number).
const ONE: i64 = -1;

/// One declared part of a kind (old record-model kind `parts[]`).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReferrerPart {
    /// The record kind (the value's `kind_field`) whose records hold this part.
    pub kind: String,
    pub role: String,
    /// The field, as a path of object keys from the record value.
    pub path: Vec<String>,
    /// For a list of objects: the path inside each member to the id it names.
    #[serde(default)]
    pub each: Option<Vec<String>>,
    /// A path whose text names the role instead (into the record, or into each member with `each`).
    #[serde(default)]
    pub role_from: Option<Vec<String>>,
    /// Prepended to an id that does not start with it (unless it starts with `absolute_prefix`).
    #[serde(default)]
    pub id_prefix: Option<String>,
    #[serde(default)]
    pub absolute_prefix: Option<String>,
    /// Only ids that start with `absolute_prefix` are parts.
    #[serde(default)]
    pub absolute_only: bool,
}
impl ReferrerPart {
    pub fn valid(&self) -> bool {
        !self.kind.is_empty()
            && !self.role.is_empty()
            && !self.role.contains(SEP)
            && !self.path.is_empty()
            && (!self.absolute_only || self.absolute_prefix.is_some())
    }
}

/// One part a record holds: the record it names, under which role, at which list ordinal (None for one id).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Part {
    pub id: String,
    pub role: String,
    pub ordinal: Option<usize>,
}

/// One record holding the asked record (old `holdersOf` `referrers[]`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Referrer {
    pub id: String,
    pub kind: Option<String>,
    pub role: String,
    pub ordinal: Option<usize>,
    /// The interaction set this member sits in (old `set`), for a list member.
    pub set: Option<String>,
}
/// One page of referrers and the referrer id the next page starts after.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Referrers {
    pub referrers: Vec<Referrer>,
    pub next: Option<String>,
    /// False while records written before their kind was named (or before its parts changed) are still to be walked:
    /// a referrer among them may be missing (old `complete: !partsPending()`).
    pub complete: bool,
    /// Raw index keys examined (old `examined`).
    pub examined: usize,
}

fn is_id(value: &serde_json::Value) -> Option<&str> {
    value
        .as_str()
        .filter(|id| !id.is_empty() && !id.contains('/') && !id.contains(SEP))
}
fn at<'v>(value: &'v serde_json::Value, path: &[String]) -> Option<&'v serde_json::Value> {
    let mut here = value;
    for field in path {
        here = here.as_object()?.get(field)?;
    }
    Some(here)
}

/// The parts a record value of `kind` holds by `declared` (old `partsOf`).
pub fn parts_of(
    declared: &[ReferrerPart],
    kind: Option<&str>,
    value: &serde_json::Value,
) -> Vec<Part> {
    let mut out = Vec::new();
    if !value.is_object() {
        return out;
    }
    for part in declared
        .iter()
        .filter(|part| Some(part.kind.as_str()) == kind)
    {
        let qualified = |id: &str| -> Option<String> {
            if part.absolute_only {
                return part
                    .absolute_prefix
                    .as_deref()
                    .filter(|prefix| id.starts_with(prefix))
                    .map(|_| id.to_owned());
            }
            match &part.id_prefix {
                Some(prefix)
                    if !id.starts_with(prefix.as_str())
                        && !part
                            .absolute_prefix
                            .as_deref()
                            .is_some_and(|absolute| id.starts_with(absolute)) =>
                {
                    Some(format!("{prefix}{id}"))
                }
                _ => Some(id.to_owned()),
            }
        };
        let role_of = |from: &serde_json::Value| -> String {
            let Some(path) = &part.role_from else {
                return part.role.clone();
            };
            match at(from, path).and_then(serde_json::Value::as_str) {
                Some(named)
                    if !named.trim().is_empty()
                        && named.encode_utf16().count() <= 80
                        && !named.contains(SEP) =>
                {
                    named.trim().to_owned()
                }
                _ => part.role.clone(),
            }
        };
        let Some(held) = at(value, &part.path).filter(|held| !held.is_null()) else {
            continue;
        };
        let mut one = |item: &serde_json::Value, ordinal: Option<usize>| {
            let id = match &part.each {
                Some(each) => at(item, each),
                None => Some(item),
            };
            if let Some(target) = id.and_then(is_id).and_then(qualified) {
                let role = role_of(if part.each.is_some() { item } else { value });
                out.push(Part {
                    id: target,
                    role,
                    ordinal,
                });
            }
        };
        match held {
            serde_json::Value::Array(members) => members
                .iter()
                .enumerate()
                .for_each(|(ordinal, member)| one(member, Some(ordinal))),
            single => one(single, None),
        }
    }
    out
}

/// One interaction set a record holds (old `setsOf` item).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct HeldSet {
    pub set: String,
    pub role: String,
    pub members: Vec<String>,
}
/// One interaction set by name: its members in order and the records holding it (old `set(name)`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SetReferrers {
    pub set: String,
    pub members: Vec<String>,
    pub referrers: Vec<(String, Option<String>, String)>,
    pub complete: bool,
}
/// What one walk step did (old `buildModel` answer): the kind walked, records walked, and whether nothing is left.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReferrersWalk {
    pub kind: Option<String>,
    pub walked: usize,
    pub done: bool,
}

/// The name of the set of `ids` in order (old `setHash`: the first 32 hex of BLAKE3 over `JSON.stringify(ids)`).
pub fn set_name(ids: &[String]) -> String {
    let hex = blake3::hash(serde_json::to_string(ids).unwrap_or_default().as_bytes()).to_hex();
    format!("set:{}", &hex.as_str()[..32])
}
/// The interaction sets a record's parts make: one per role over a list, members in ordinal order (old `setsOf`).
pub fn sets_of(parts: &[Part]) -> Vec<HeldSet> {
    let mut by_role: Vec<(String, Vec<&Part>)> = Vec::new();
    for part in parts.iter().filter(|part| part.ordinal.is_some()) {
        match by_role.iter_mut().find(|(role, _)| role == &part.role) {
            Some((_, members)) => members.push(part),
            None => by_role.push((part.role.clone(), vec![part])),
        }
    }
    by_role
        .into_iter()
        .map(|(role, mut members)| {
            members.sort_by_key(|part| part.ordinal);
            let ids: Vec<String> = members.into_iter().map(|part| part.id.clone()).collect();
            HeldSet {
                set: set_name(&ids),
                role,
                members: ids,
            }
        })
        .collect()
}
/// What a kind's referrer keys depend on (old `signatureOf`): its declared parts, in DATA order.
fn signature_of(declared: &[ReferrerPart], kind: &str) -> String {
    let rows: Vec<serde_json::Value> = declared
        .iter()
        .filter(|part| part.kind == kind)
        .map(|part| {
            serde_json::json!([
                part.role,
                part.path,
                part.each,
                part.role_from,
                part.id_prefix,
                part.absolute_prefix,
                part.absolute_only
            ])
        })
        .collect();
    serde_json::json!({ "parts": rows, "sets": 1 }).to_string()
}
fn walk_row(
    account: &str,
    resource: &str,
    kind: &str,
    signature: &str,
    after: Option<&str>,
    done: bool,
) -> Vec<(&'static str, Value)> {
    vec![
        ("account", text(account)),
        ("resource", text(resource)),
        ("kind", text(kind)),
        ("signature", text(signature)),
        ("after", after.map_or(Value::Null, text)),
        ("done", Value::Integer(i64::from(done))),
    ]
}
fn set_key(account: &str, resource: &str, referrer: &str, held: &HeldSet) -> Vec<Value> {
    vec![
        text(account),
        text(resource),
        text(&held.set),
        text(referrer),
        text(&held.role),
    ]
}
const SET_FIELDS: [&str; 5] = ["account", "resource", "set", "holder", "role"];

fn key(account: &str, resource: &str, referrer: &str, part: &Part) -> Vec<Value> {
    vec![
        text(account),
        text(resource),
        text(&part.id),
        text(referrer),
        text(&part.role),
        Value::Integer(part.ordinal.map_or(ONE, |n| n as i64)),
    ]
}
const FIELDS: [&str; 6] = [
    "account",
    "resource",
    "participant",
    "holder",
    "role",
    "ordinal",
];

impl<S: Storage> RecordStore<S> {
    /// The declared families this model's reverse index may first write. The native command owner prepares
    /// these before taking its schema witness; reads never prepare them and unrelated stores keep lazy creation.
    pub fn referrer_families(&self) -> &'static [&'static str] {
        if self.referrer_parts().is_empty() {
            &[]
        } else {
            &[REFERRERS, SETS, WALK]
        }
    }

    /// Apply the one logical parts owner after opening only the composition's explicit envelope. In particular,
    /// a JSON-looking string at an ordinary declared part path is still a string, never a second source of links.
    fn record_parts(
        &self,
        kind: Option<&str>,
        value: &serde_json::Value,
    ) -> Result<Vec<Part>, Error> {
        if !self
            .referrer_parts()
            .iter()
            .any(|part| Some(part.kind.as_str()) == kind)
        {
            return Ok(Vec::new());
        }
        match self.referrer_value_path() {
            None => Ok(parts_of(self.referrer_parts(), kind, value)),
            Some(path) => match at(value, path) {
                Some(serde_json::Value::String(text)) => {
                    let logical = serde_json::from_str(text).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                    Ok(parts_of(self.referrer_parts(), kind, &logical))
                }
                Some(logical) => Ok(parts_of(self.referrer_parts(), kind, logical)),
                None => Err(crate::cause!(Error::Unavailable)),
            },
        }
    }

    /// The adapter is part of the walk's signature: switching an envelope cannot reuse a former completed walk.
    fn referrer_signature(&self, kind: &str) -> String {
        let parts = signature_of(self.referrer_parts(), kind);
        match self.referrer_value_path() {
            None => parts,
            Some(path) => serde_json::json!({"parts":parts,"value_path":path}).to_string(),
        }
    }

    /// Keep the referrers index equal to a record's current value (called from `index_derived`, in the write's batch).
    pub(super) fn index_referrers(
        &self,
        batch: &mut Batch,
        account: &str,
        resource: &str,
        id: &str,
        before: Option<&serde_json::Value>,
        after: Option<&serde_json::Value>,
    ) -> Result<(), Error> {
        let declared = self.referrer_parts();
        if declared.is_empty() {
            return Ok(());
        }
        // A kind's first record, written while its kind is named and no walk stands for it, leaves nothing to walk
        // (old :2178: a store opened empty records every kind as walked). One read of its walk row, and one seek of its
        // list only when there is none.
        if let Some(kind) = after
            .and_then(|value| self.kind_of(value))
            .filter(|kind| declared.iter().any(|part| &part.kind == kind))
        {
            if self.walk_state(account, resource, &kind)?.is_none() {
                let scope = vec![text(account), text(resource), text(&kind)];
                let range = Range {
                    order: Order::Named("live_kind"),
                    from: Bound::Included(scope.clone()),
                    to: Bound::Included(scope),
                    reverse: false,
                    limit: Some(2),
                };
                let others = self
                    .scan_rows(super::VERSIONS, &range, &[Field::whole("id")])
                    .map_err(unavailable)?;
                if others
                    .into_iter()
                    .all(|mut row| row.take(0).as_text() == Some(id))
                {
                    batch.put(
                        WALK,
                        walk_row(
                            account,
                            resource,
                            &kind,
                            &self.referrer_signature(&kind),
                            None,
                            true,
                        ),
                        false,
                    );
                }
            }
        }
        let parts = |value: Option<&serde_json::Value>| -> Result<BTreeSet<Part>, Error> {
            match value {
                Some(value) => self
                    .record_parts(self.kind_of(value).as_deref(), value)
                    .map(|parts| parts.into_iter().collect()),
                None => Ok(BTreeSet::new()),
            }
        };
        let (old, new) = (parts(before)?, parts(after)?);
        for gone in old.difference(&new) {
            batch.erase(REFERRERS, key(account, resource, id, gone));
        }
        for came in new.difference(&old) {
            batch.put(
                REFERRERS,
                FIELDS
                    .into_iter()
                    .zip(key(account, resource, id, came))
                    .collect(),
                false,
            );
        }
        let sets = |parts: &BTreeSet<Part>| -> BTreeSet<HeldSet> {
            sets_of(&parts.iter().cloned().collect::<Vec<_>>())
                .into_iter()
                .collect()
        };
        let (old, new) = (sets(&old), sets(&new));
        for gone in old.difference(&new) {
            batch.erase(SETS, set_key(account, resource, id, gone));
        }
        for came in new.difference(&old) {
            batch.put(
                SETS,
                SET_FIELDS
                    .into_iter()
                    .zip(set_key(account, resource, id, came))
                    .collect(),
                false,
            );
        }
        Ok(())
    }

    /// The kinds the DATA names, in DATA order, each once.
    fn referrer_kinds(&self) -> Vec<String> {
        let mut kinds: Vec<String> = Vec::new();
        for part in self.referrer_parts() {
            if !kinds.contains(&part.kind) {
                kinds.push(part.kind.clone());
            }
        }
        kinds
    }
    /// Where the walk of one kind stands: (signature, after, done), None before its first step.
    fn walk_state(
        &self,
        account: &str,
        resource: &str,
        kind: &str,
    ) -> Result<Option<(String, Option<String>, bool)>, Error> {
        let read = [
            Field::whole("signature"),
            Field::whole("after"),
            Field::whole("done"),
        ];
        let Some(mut row) = self
            .storage
            .get(WALK, &[text(account), text(resource), text(kind)], &read)
            .map_err(unavailable)?
        else {
            return Ok(None);
        };
        let signature = row.take(0).as_text().ok_or(crate::cause!(Error::Unavailable))?.to_owned();
        let after = row.take(1).as_text().map(str::to_owned);
        let done = row.take(2).as_integer() == Some(1);
        Ok(Some((signature, after, done)))
    }
    /// The first kind still to walk and the cursor to walk it from (old `state.walking ?? kindsToWalk(state)[0]`).
    fn next_walk(
        &self,
        account: &str,
        resource: &str,
    ) -> Result<Option<(String, String, Option<String>)>, Error> {
        for kind in self.referrer_kinds() {
            let signature = self.referrer_signature(&kind);
            match self.walk_state(account, resource, &kind)? {
                Some((held, _, true)) if held == signature => continue,
                Some((held, after, false)) if held == signature => {
                    return Ok(Some((kind, signature, after)))
                }
                Some(_) => return Ok(Some((kind, signature, None))),
                // Never walked: a kind with no record yet has nothing to walk (old :2178, a store opened empty), and
                // its records are indexed by their own writes. One seek of its `live_kind` list says which.
                None => {
                    let scope = vec![text(account), text(resource), text(&kind)];
                    let range = Range {
                        order: Order::Named("live_kind"),
                        from: Bound::Included(scope.clone()),
                        to: Bound::Included(scope),
                        reverse: false,
                        limit: Some(1),
                    };
                    if self
                        .scan_rows(super::VERSIONS, &range, &[Field::whole("id")])
                        .map_err(unavailable)?
                        .is_empty()
                    {
                        continue;
                    }
                    return Ok(Some((kind, signature, None)));
                }
            }
        }
        Ok(None)
    }
    /// Whether records written before their kind was named (or before its parts changed) are still to be walked
    /// (old `partsPending`).
    pub fn referrers_pending(&self, account: &str, resource: &str) -> Result<bool, Error> {
        validate(account, resource, "holders")?;
        Ok(self.next_walk(account, resource)?.is_some())
    }
    /// The records a walk step reads at most (`settings.json` `referrers_walk_rows`, old `MODEL_PAGE`).
    pub fn referrers_walk_rows(&self) -> usize {
        self.settings.referrers_walk_rows
    }
}

impl<S: Storage + Send> RecordStore<S> {
    /// One step of the walk of records kept before their kind's parts were named: at most `limit` records of the first
    /// kind still to walk, in id order along its own `live_kind` list, their referrer and set keys and the walk's cursor
    /// written in one write (old `buildModel` parts phase). A stopped walk goes on from the record after its cursor and
    /// never needs a record twice; a kind whose parts changed is walked again from its start.
    pub fn walk_referrers(
        &mut self,
        account: &str,
        resource: &str,
        limit: usize,
    ) -> Result<ReferrersWalk, Error> {
        self.walk_referrers_step(account, resource, limit)
    }
}

// Read-only inspection and a command's thread-local lent transaction need no movable supply.
impl<S: Storage> RecordStore<S> {
    /// The existing bounded walk on a command owner's already-held write transaction. Never opens a writer from
    /// a read, and every index key and cursor still join that transaction through the normal savepoint owner.
    pub fn walk_referrers_lent(
        &mut self,
        account: &str,
        resource: &str,
        limit: usize,
    ) -> Result<ReferrersWalk, Error> {
        if !self.storage.scoped() || !self.storage.writing().map_err(unavailable)? {
            return Err(crate::cause!(Error::Unavailable));
        }
        self.walk_referrers_step(account, resource, limit)
    }

    fn walk_referrers_step(
        &mut self,
        account: &str,
        resource: &str,
        limit: usize,
    ) -> Result<ReferrersWalk, Error> {
        validate(account, resource, "holders")?;
        let Some((kind, signature, after)) = self.next_walk(account, resource)? else {
            return Ok(ReferrersWalk {
                kind: None,
                walked: 0,
                done: true,
            });
        };
        let walked = self.write(account, resource, |store| {
            // The one walk step (`RecordStore::walk_page`), shared with the search walk and the order fill.
            let (walked, next) = store.walk_page(
                account,
                resource,
                "live_kind",
                vec![text(account), text(resource), text(&kind)],
                after.as_deref(),
                limit.max(1),
            )?;
            let ids: Vec<String> = walked.iter().map(|(id, _)| id.clone()).collect();
            let versions: Vec<_> = walked.into_iter().map(|(_, version)| version).collect();
            let mut batch = Batch::default();
            for (id, version) in ids.iter().zip(versions) {
                let Some(version) = version else { continue };
                let Some(value) = version.value()? else {
                    continue;
                };
                let parts = store.record_parts(store.kind_of(&value).as_deref(), &value)?;
                for part in &parts {
                    batch.put(
                        REFERRERS,
                        FIELDS
                            .into_iter()
                            .zip(key(account, resource, id, part))
                            .collect(),
                        false,
                    );
                }
                for held in sets_of(&parts) {
                    batch.put(
                        SETS,
                        SET_FIELDS
                            .into_iter()
                            .zip(set_key(account, resource, id, &held))
                            .collect(),
                        false,
                    );
                }
            }
            let done = next.is_none();
            batch.put(
                WALK,
                walk_row(
                    account,
                    resource,
                    &kind,
                    &signature,
                    if done {
                        None
                    } else {
                        ids.last().map(String::as_str)
                    },
                    done,
                ),
                false,
            );
            batch.send(&store.storage).map_err(uncertain)?;
            Ok(Written::Commit(ids.len(), None))
        })?;
        Ok(ReferrersWalk {
            kind: Some(kind),
            walked,
            done: !self.referrers_pending(account, resource)?,
        })
    }

    /// The interaction sets one live record holds (old `setsOf(id)`); None when there is no such record.
    pub fn sets_of(
        &self,
        account: &str,
        resource: &str,
        id: &str,
    ) -> Result<Option<Vec<HeldSet>>, Error> {
        validate(account, resource, id)?;
        let Some(record) = self.current_record(account, resource, id)? else {
            return Ok(None);
        };
        Ok(Some(sets_of(&self.record_parts(
            self.kind_of(&record.value).as_deref(),
            &record.value,
        )?)))
    }

    /// One interaction set by its name: its members in order and the records holding it, each under its role (one
    /// range of set keys, each referrer checked against the record it names), None when nothing holds it now (old `set`).
    pub fn set(
        &self,
        account: &str,
        resource: &str,
        name: &str,
        limit: Option<usize>,
    ) -> Result<Option<SetReferrers>, Error> {
        validate(account, resource, name)?;
        let most = limit.unwrap_or(100).clamp(1, 1000);
        let scope = vec![text(account), text(resource), text(name)];
        let range = Range {
            order: Order::Key,
            from: Bound::Included(scope.clone()),
            to: Bound::Included(scope),
            reverse: false,
            limit: Some(most * 4),
        };
        let rows = self
            .storage
            .scan(
                SETS,
                &range,
                &[Field::whole("holder"), Field::whole("role")],
            )
            .map_err(unavailable)?;
        let (mut members, mut referrers) = (None, Vec::new());
        for mut row in rows {
            let referrer = row.take(0).as_text().ok_or(crate::cause!(Error::Unavailable))?.to_owned();
            let role = row.take(1).as_text().ok_or(crate::cause!(Error::Unavailable))?.to_owned();
            let Some(record) = self.current_record(account, resource, &referrer)? else {
                continue;
            };
            let kind = self.kind_of(&record.value);
            let parts = self.record_parts(kind.as_deref(), &record.value)?;
            let Some(held) = sets_of(&parts)
                .into_iter()
                .find(|held| held.role == role && held.set == name)
            else {
                continue;
            };
            members.get_or_insert(held.members);
            referrers.push((referrer, kind, role));
            if referrers.len() >= most {
                break;
            }
        }
        let complete = !self.referrers_pending(account, resource)?;
        Ok(members.map(|members| SetReferrers {
            set: name.to_owned(),
            members,
            referrers,
            complete,
        }))
    }

    /// The records holding `id`, in referrer id order after `after`, of `role` only when named (old `holdersOf`).
    pub fn referrers_of(
        &self,
        account: &str,
        resource: &str,
        id: &str,
        role: Option<&str>,
        after: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Referrers, Error> {
        // The named participant is an exact reference identity, not necessarily an ordinary record id: a model
        // may name a future resource whose bounded identity is longer than the ordinary record-key allowance.
        validate(account, resource, "holders")?;
        if id.is_empty()
            || id.len() > self.limits.max_record_bytes
            || id.contains('/')
            || id.contains(SEP)
        {
            return Err(Error::Invalid("invalid reference identity", crate::cause!()));
        }
        let most = limit.unwrap_or(100).clamp(1, 1000);
        let budget = (most * 4).max(256);
        let scope = vec![text(account), text(resource), text(id)];
        let from = match after {
            Some(after) => Bound::Excluded([scope.as_slice(), &[text(after)]].concat()),
            None => Bound::Included(scope.clone()),
        };
        let page_of = |from: Bound, limit: usize| {
            let range = Range {
                order: Order::Key,
                from,
                to: Bound::Included(scope.clone()),
                reverse: false,
                limit: Some(limit),
            };
            self.storage
                .scan(
                    REFERRERS,
                    &range,
                    &[Field::whole("holder"), Field::whole("role")],
                )
                .map_err(unavailable)
        };
        let page = page_of(from, budget + 1)?;
        let mut keys: Vec<(String, String)> = Vec::with_capacity(page.len());
        for mut row in page {
            let referrer = row.take(0).as_text().ok_or(crate::cause!(Error::Unavailable))?.to_owned();
            let held = row.take(1).as_text().ok_or(crate::cause!(Error::Unavailable))?.to_owned();
            keys.push((referrer, held));
        }
        let cut = keys.len() > budget;
        let tail = if cut {
            Some(keys[budget].0.clone())
        } else {
            None
        };
        let mut groups: Vec<(String, BTreeSet<String>)> = Vec::new();
        for (referrer, held) in keys.iter().take(budget) {
            if groups.last().map(|(id, _)| id) != Some(referrer) {
                groups.push((referrer.clone(), BTreeSet::new()));
            }
            groups.last_mut().expect("pushed").1.insert(held.clone());
        }
        let byte_budget = self.limits.max_record_bytes.min(2 * 1024 * 1024);
        let (mut referrers, mut last, mut stopped, mut bytes) =
            (Vec::new(), None::<String>, false, 0usize);
        for (referrer, roles) in &groups {
            if referrers.len() >= most {
                stopped = true;
                break;
            }
            // A complete group with no asked role needs no record body; a group the page cut is settled by its parts.
            if role.is_some_and(|role| !roles.contains(role))
                && tail.as_deref() != Some(referrer.as_str())
            {
                last = Some(referrer.clone());
                continue;
            }
            if let Some(record) = self.current_record(account, resource, referrer)? {
                let size = serde_json::to_vec(&record.value).map_or(0, |body| body.len());
                if bytes > 0 && bytes + size > byte_budget {
                    stopped = true;
                    break;
                }
                bytes += size;
                let kind = self.kind_of(&record.value);
                let current = self.record_parts(kind.as_deref(), &record.value)?;
                let in_sets = sets_of(&current);
                let mut selected: Vec<Part> = current
                    .into_iter()
                    .filter(|part| part.id == id && role.is_none_or(|role| part.role == role))
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect();
                selected.sort_by(|a, b| {
                    (&a.role, a.ordinal.map_or(ONE, |n| n as i64))
                        .cmp(&(&b.role, b.ordinal.map_or(ONE, |n| n as i64)))
                });
                referrers.extend(selected.into_iter().map(|part| {
                    let set = part.ordinal.and_then(|_| {
                        in_sets
                            .iter()
                            .find(|held| held.role == part.role)
                            .map(|held| held.set.clone())
                    });
                    Referrer {
                        id: referrer.clone(),
                        kind: kind.clone(),
                        role: part.role,
                        ordinal: part.ordinal,
                        set,
                    }
                }));
            }
            last = Some(referrer.clone());
        }
        // Seek past the whole last referrer, a group the raw page cut included: `next` is the exact referrer id.
        let next = match &last {
            Some(last) if stopped || cut => {
                let beyond = Bound::Excluded([scope.as_slice(), &[text(last)]].concat());
                (!page_of(beyond, 1)?.is_empty()).then(|| last.clone())
            }
            _ => None,
        };
        let complete = !self.referrers_pending(account, resource)?;
        Ok(Referrers {
            referrers,
            next,
            complete,
            examined: keys.len().min(budget),
        })
    }
}

#[cfg(test)]
#[path = "referrers_tests.rs"]
mod tests;
