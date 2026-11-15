//! The account stores travel as records: an account's policy directory and app key-value entries (with their blobs,
//! src/account/create.rs `AccountStores`) are kept, at each computer the account's row names, as records of one resource of
//! the account's own records store (`settings.json` `account_stores.resource`), so the writer's feed carries every change of
//! them to every copy, as it carries every record.
//!
//! Why: before, these stores travelled once, in the answer to `Message::Holding` that a computer joining by itself asks
//! (src/native_entry/computer/join_itself.rs), and no later change of them at the writer ever reached a computer that
//! already kept the account: a rights change, a connection or an enrollment written at the writer was missing at the
//! computer that answered after the writer died. Old trillion kept these stores at one computer (its Durable Object), so
//! there is no old code to port; the transport is the copies' own feed (`copies.rs`), not a second one.
//!
//! How, at one computer (`AccountStoresCopy::step`, run on each step of the account's copies, after each push a copy
//! took, and around each request the computer answers):
//! - The stores stay the read owner at each computer: the account's routes read their own policy database and key-value
//!   entries, unchanged. Only the transport moved.
//! - **At the writer** (it holds the writer turn and may answer): a step that finds the store files as the last step left
//!   them under the same term reads nothing and takes no lock (`create::account_stores_marks`: the size and change time of
//!   the four files every row change touches). When they changed, the index rows are read (never a blob) and compared to
//!   the rows the records hold; only the rows that differ are made into records (a blob is read only for a row that is
//!   new or has another blob id: a blob never changes under its id), a row gone is a deleted record, at most
//!   `rows_per_write` per write, each write acknowledged by the copies as any records write (`Copies::write_in`): not
//!   acknowledged, not made, kept in the stores, and tried again on the next step. A request does not wait for its step.
//! - **At every other computer that may answer**, and at the writer first when the resource moved under another writer:
//!   once the resource's stamp moved past the one its stores match, the records are written back into its own stores
//!   (`create::apply_account_stores`): every travelling row the records hold, and no other. Its own rows are compared to
//!   the records' only when its store files changed.
//! - **A computer that only keeps a copy** takes the records sealed, as every record, and makes no stores from them: it
//!   gets ids only (join_itself.rs). Once the row lets it answer and the root reaches it, its copies open what it held
//!   (`Copies::open_held`) and the next step writes its stores, so its account routes open
//!   (`Computer::ensure_account_stores`).
//! - Rows a computer keeps for itself never travel and are never touched by the records: the names and keys that start
//!   with `policy_kept_here` or `kv_kept_here` (the operator's service records each computer publishes itself).
//!
//! Non-Negotiable Invariants:
//! - Only the writer writes the resource, only through `Copies::write_in` (one unit with its acknowledgement).
//! - A computer writes its stores from the records only when it may answer; a copy-only computer writes no store.
//! - A writer never writes its stores' rows over records it has not taken yet: when the resource moved since its stores
//!   last matched it (another writer wrote it), the records are written into its stores first, then its own changes.
//! - Numbers and names are DATA in `settings.json` (`account_stores`).

use super::{copies::Copies, settings};
use crate::{
    account::create::{self, AccountStoreRows, AccountStores, KeptHere, KvEntry, KvRow},
    records::Mutation,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicI64, Ordering}, Mutex},
};

/// `settings.json` `account_stores`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountStoresSettings {
    #[serde(rename = "_what")]
    _what: String,
    pub resource: String,
    pub policy_prefix: String,
    pub kv_prefix: String,
    pub policy_kept_here: Vec<String>,
    pub kv_kept_here: Vec<String>,
    pub rows_per_write: usize,
}

fn shipped() -> &'static AccountStoresSettings {
    &settings().account_stores
}

/// The resource the account stores travel in.
pub fn resource() -> &'static str {
    &shipped().resource
}

fn kept_here() -> KeptHere<'static> {
    KeptHere { policy: &shipped().policy_kept_here, kv: &shipped().kv_kept_here }
}

/// What one step did (`AccountStoresCopy::step`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stepped {
    /// Rows of this computer's stores written from the records.
    pub taken: usize,
    /// Records the writer wrote from its stores.
    pub written: usize,
    /// The writer's stores held a change and its write was not acknowledged (`Copies::write_in` refused it): the change is
    /// only at this computer until a later step writes it, and is lost if this computer dies first. The request that made
    /// it is answered as its route answered it, without waiting for this step: it ran, and a refused copy is not its failure
    /// (src/native_entry/computer.rs `forward` runs the step beside the answer).
    pub refused: bool,
}

/// The account stores of one account at one computer, and what they last matched.
pub struct AccountStoresCopy {
    folder: PathBuf,
    /// The policy database, relative to `folder` (the file the object index names for the account control).
    policy_file: PathBuf,
    /// The resource's stamp this computer's stores match (`i64::MIN`: not known yet).
    matched: AtomicI64,
    /// What the records hold of this computer's stores, and where the store files were then (`None`: not known yet).
    kept: Mutex<Option<Kept>>,
    /// One step at a time.
    one: Mutex<()>,
    /// The record store's files and the stores' files as they were when a step at a computer that does not hold the writer turn
    /// found its stores matching the records (`None`: not known, or a step has not finished that way). While neither changed, a
    /// step at such a computer has nothing to compare and opens no store: every request wakes the account, so opening the
    /// records store each time cost a sqlite open and schema check per request (measured 2026-11-13: the whole engine at
    /// 400% CPU in `Stores::open` under `Computer::wake`).
    quiet: Mutex<Option<(Marks, Marks)>>,
    /// A thread is running steps for requests (`Copies::account_stores_step_soon`).
    scheduled: std::sync::atomic::AtomicBool,
}

type Marks = Vec<Option<(u64, std::time::SystemTime)>>;

/// What a key-value row is without its blob's text: the blob id, the expiration and the blob file's mark
/// (`create::KvRow`). Two equal rows hold the same bytes.
type KvKind = (String, Option<i64>, Option<(u64, std::time::SystemTime)>);

/// The travelling rows of a computer's stores with no blob read: policy name to value, key-value key to its `KvKind`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Rows {
    policy: BTreeMap<String, String>,
    kv: BTreeMap<String, KvKind>,
}

/// The rows the account's records hold of this computer's stores, the store files as they were when the rows were read,
/// and the writer term under which a step found nothing left to write (`None`: a step has not settled under a term).
struct Kept {
    rows: Rows,
    marks: Marks,
    term: Option<u64>,
}

impl Rows {
    /// The travelling rows of `rows`: the rows a computer keeps for itself are left out.
    fn of(rows: AccountStoreRows) -> Self {
        let kept = kept_here();
        Self {
            policy: rows.policy.into_iter().filter(|(name, _)| !kept.policy.iter().any(|prefix| name.starts_with(prefix.as_str()))).collect(),
            kv: rows.kv.into_iter()
                .filter(|row| !kept.kv.iter().any(|prefix| row.key.starts_with(prefix.as_str())))
                .map(|KvRow { key, blob_id, expiration, blob_mark }| (key, (blob_id, expiration, blob_mark)))
                .collect(),
        }
    }

    /// The changes that make the records of `self` (what the records hold) the records of `now`, in id order within each store.
    fn changes(&self, now: &Rows) -> Vec<Change> {
        let mut changes = Vec::new();
        changes.extend(now.policy.iter().filter(|(name, value)| self.policy.get(*name) != Some(*value))
            .map(|(name, value)| Change::Policy(name.clone(), value.clone())));
        changes.extend(self.policy.keys().filter(|name| !now.policy.contains_key(*name)).map(|name| Change::PolicyGone(name.clone())));
        changes.extend(now.kv.iter().filter(|(key, row)| self.kv.get(*key) != Some(*row)).map(|(key, row)| Change::Kv(key.clone(), row.clone())));
        changes.extend(self.kv.keys().filter(|key| !now.kv.contains_key(*key)).map(|key| Change::KvGone(key.clone())));
        changes
    }

    /// `self` after `change`.
    fn made(&mut self, change: &Change) {
        match change {
            Change::Policy(name, value) => { self.policy.insert(name.clone(), value.clone()); }
            Change::PolicyGone(name) => { self.policy.remove(name); }
            Change::Kv(key, row) => { self.kv.insert(key.clone(), row.clone()); }
            Change::KvGone(key) => { self.kv.remove(key); }
        }
    }
}

/// One record the writer makes from its stores, or deletes.
enum Change {
    Policy(String, String),
    PolicyGone(String),
    Kv(String, KvKind),
    KvGone(String),
}

impl Change {
    /// The id of the record this change makes.
    fn id(&self) -> String {
        let settings = shipped();
        match self {
            Self::Policy(name, _) | Self::PolicyGone(name) => format!("{}{name}", settings.policy_prefix),
            Self::Kv(key, _) | Self::KvGone(key) => format!("{}{key}", settings.kv_prefix),
        }
    }

    /// The value of the record: `None` deletes it. A key-value row reads its blob from the account's folder `folder` here, the
    /// only place a blob is read.
    fn value(&self, folder: &Path) -> Option<Result<Value, create::Error>> {
        match self {
            Self::Policy(name, value) => Some(Ok(policy_value(name, value))),
            Self::Kv(key, (blob_id, expiration, _)) => Some(create::read_kv_blob(folder, blob_id).map(|blob| kv_value(key, blob_id, *expiration, &blob))),
            Self::PolicyGone(_) | Self::KvGone(_) => None,
        }
    }
}

fn policy_value(name: &str, value: &str) -> Value {
    json!({"name": name, "value": value})
}

fn kv_value(key: &str, blob_id: &str, expiration: Option<i64>, blob: &str) -> Value {
    json!({"key": key, "blob_id": blob_id, "expiration": expiration, "blob": blob})
}

/// The stores the records `records` hold (record id to value); a record that does not read as a row is left out.
fn as_stores(records: &BTreeMap<String, Value>) -> AccountStores {
    let settings = shipped();
    let mut stores = AccountStores::default();
    for (id, value) in records {
        if id.starts_with(&settings.policy_prefix) {
            if let (Some(name), Some(text)) = (value["name"].as_str(), value["value"].as_str()) {
                stores.policy.push((name.to_owned(), text.to_owned()));
            }
        } else if id.starts_with(&settings.kv_prefix) {
            if let (Some(key), Some(blob_id), Some(blob)) = (value["key"].as_str(), value["blob_id"].as_str(), value["blob"].as_str()) {
                stores.kv.push(KvEntry { key: key.to_owned(), blob_id: blob_id.to_owned(), expiration: value["expiration"].as_i64(), blob: blob.to_owned() });
            }
        }
    }
    stores
}

impl AccountStoresCopy {
    /// The account stores of the account in `folder`, whose policy database is `policy_file` (relative to it).
    pub fn new(folder: PathBuf, policy_file: PathBuf) -> Self {
        Self { folder, policy_file, matched: AtomicI64::new(i64::MIN), kept: Mutex::new(None), one: Mutex::new(()), scheduled: std::sync::atomic::AtomicBool::new(false), quiet: Mutex::new(None) }
    }

    /// The policy database, relative to the account folder.
    pub fn policy_file(&self) -> &Path {
        &self.policy_file
    }

    /// Whether this computer's stores are there: its policy database holds a row.
    pub fn held(&self) -> bool {
        create::account_stores_held(&self.folder, &self.policy_file)
    }

    fn marks(&self) -> Marks {
        create::account_stores_marks(&self.folder, &self.policy_file)
    }

    /// The travelling rows of this computer's stores now, with the store files as they were just before they were read.
    /// `None` when they cannot be read (absent: a computer that has not made them yet).
    fn local(&self) -> Option<(Rows, Marks)> {
        if !self.held() {
            return None;
        }
        let marks = self.marks();
        create::read_account_store_rows(&self.folder, &self.policy_file).ok().map(|rows| (Rows::of(rows), marks))
    }

    /// What the records hold of these stores: the stores as they are now, after they were made to match the records.
    fn match_now(&self, term: Option<u64>) {
        let kept = self.local().map(|(rows, marks)| Kept { rows, marks, term });
        *self.kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = kept;
    }

    /// Whether a step at the writer under `term` has nothing to do: the last step left the stores matching the records under
    /// this term, and no store file changed since. Nobody else writes the resource under a term this computer holds.
    fn settled(&self, term: u64) -> bool {
        let kept = self.kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        kept.as_ref().is_some_and(|kept| kept.term == Some(term) && kept.marks == self.marks())
    }

    /// Whether a step at a computer that does not hold the writer turn has nothing to do: the last such step left the stores
    /// matching the records and neither the records' file nor a store file has changed since.
    fn quiet(&self, copies: &Copies) -> bool {
        if copies.holding().is_some() || self.matched.load(Ordering::Acquire) == i64::MIN {
            return false;
        }
        let quiet = self.quiet.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        quiet.as_ref().is_some_and(|(records, stores)| !stores.is_empty() && *stores == self.marks() && *records == copies.records_marks(resource()))
    }

    /// Whether a step for `copies` has anything to do: not when this computer cannot keep stores, nor when it holds the writer
    /// turn and the last step under that turn left the store files as they are.
    pub fn wants_step(&self, copies: &Copies) -> bool {
        copies.may_answer() && copies.holds_secrets_key() && !copies.holding().is_some_and(|term| self.settled(term)) && !self.quiet(copies)
    }

    /// Run steps on a thread of their own while one is wanted: a request that asks while a thread already runs adds nothing
    /// to wait for, and the thread looks again when it ends. Used by every caller that must not wait for the copies.
    pub fn step_soon(&self, copies: &std::sync::Arc<Copies>) {
        use std::sync::atomic::Ordering::AcqRel;
        if !self.wants_step(copies) || self.scheduled.swap(true, AcqRel) {
            return;
        }
        let copies = copies.clone();
        std::thread::spawn(move || loop {
            let before = copies.account_stores_of().map(|stores| (copies.records_marks(resource()), stores.marks()));
            copies.account_stores_step();
            let Some(stores) = copies.account_stores_of() else { return };
            stores.scheduled.store(false, std::sync::atomic::Ordering::Release);
            // A step that left both files as it found them has nothing a second one would do differently (a refused or
            // unreadable step waits for the next request): looping on it would spin a core.
            let unchanged = before == Some((copies.records_marks(resource()), stores.marks()));
            if unchanged || !stores.wants_step(&copies) || stores.scheduled.swap(true, AcqRel) {
                return;
            }
        });
    }

    /// One step for `copies` (see the module doc). Errors are left for the next step; nothing here refuses a request.
    pub fn step(&self, copies: &Copies) -> Stepped {
        let mut stepped = Stepped::default();
        if let Some(line) = copies.shadow_mismatch() {
            crate::quiet_eprintln!("{line}");
        }
        // Only a computer that may answer and holds the root keeps stores: a copy-only computer's records are sealed, and
        // one let answer later opens them only once the root reached it (`Copies::open_held`).
        if !copies.may_answer() || !copies.holds_secrets_key() {
            return stepped;
        }
        if copies.holding().is_some_and(|term| self.settled(term)) || self.quiet(copies) {
            return stepped;
        }
        let _one = self.one.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // A step that waited for the lock finds the work of the step that held it done.
        if copies.holding().is_some_and(|term| self.settled(term)) {
            return stepped;
        }
        let resource = resource();
        // Taken before anything is read, so a change made while this step reads shows at the next one.
        let records_marks = copies.records_marks(resource);
        *self.quiet.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        let stamp = copies.stamp(resource);
        let term = copies.holding();
        if stamp != self.matched.load(Ordering::Acquire) {
            // The records moved since this computer's stores last matched them (or it never compared): take them. Never
            // from a resource nobody wrote yet (stamp 0): the account's first writer writes its own rows there, and a
            // computer whose stores hold rows must not take "none" over them (measured 2026-11-04: an account that got
            // voters later had its own policy rows removed at its first step, and no other computer ever opened it).
            let Ok(records) = copies.records_of(resource) else { return stepped };
            if stamp != 0 {
                match create::apply_account_stores(&self.folder, &self.policy_file, &as_stores(&records), &kept_here()) {
                    Ok(changed) => stepped.taken = changed,
                    Err(error) => {
                        crate::quiet_eprintln!("computers-account-stores event=take-refused cause={}", error.cause());
                        return stepped;
                    }
                }
            }
            self.matched.store(stamp, Ordering::Release);
            // What the records hold is what the stores now match; a resource nobody wrote holds no row.
            if stamp != 0 {
                self.match_now(None);
            } else {
                *self.kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Kept { rows: Rows::default(), marks: self.marks(), term: None });
            }
            if stepped.taken > 0 {
                crate::quiet_eprintln!("computers-account-stores event=taken account={} rows={}", copies.address(), stepped.taken);
            }
        }
        let Some(term) = term else {
            // A change of its stores that this computer made while it was the writer and no copy acknowledged (`refused`),
            // or made at all while it was not, is held by no other computer: the writer will never write it. It is put
            // back to the records, as an unacknowledged records write is rolled back, so a computer that may answer never
            // answers from a change the account does not hold (measured here: B took the term and A kept serving its
            // unacknowledged revision). Never over a resource nobody wrote yet (see above). Its rows are read only when its
            // store files changed since they last matched.
            if stamp != 0 {
                let changed = self.kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref().is_none_or(|kept| kept.marks != self.marks());
                if changed {
                    let Some((rows, marks)) = self.local() else { return stepped };
                    let same = self.kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref().is_some_and(|kept| kept.rows == rows);
                    if same {
                        if let Some(kept) = self.kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_mut() {
                            kept.marks = marks;
                        }
                    } else {
                        let Ok(records) = copies.records_of(resource) else { return stepped };
                        match create::apply_account_stores(&self.folder, &self.policy_file, &as_stores(&records), &kept_here()) {
                            Ok(changed) => {
                                stepped.taken += changed;
                                crate::quiet_eprintln!("computers-account-stores event=put-back account={} rows={changed}", copies.address());
                            }
                            Err(error) => {
                                crate::quiet_eprintln!("computers-account-stores event=take-refused cause={}", error.cause());
                                return stepped;
                            }
                        }
                        self.match_now(None);
                    }
                }
            }
            let stores = self.kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref().map(|kept| kept.marks.clone());
            if let Some(stores) = stores.filter(|stores| *stores == self.marks()) {
                *self.quiet.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((records_marks, stores));
            }
            return stepped;
        };
        let Some((rows, marks)) = self.local() else { return stepped };
        let known = self.kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref().map(|kept| kept.rows.clone());
        let Some(mut held) = known else {
            // The stores were not readable when the records were last taken and are now: take the records first, at the next step.
            self.matched.store(i64::MIN, Ordering::Release);
            return stepped;
        };
        let changes = held.changes(&rows);
        if changes.is_empty() && stamp != 0 {
            *self.kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Kept { rows, marks, term: Some(term) });
            return stepped;
        }
        let owner = copies.owner().to_owned();
        for batch in changes.chunks(shipped().rows_per_write.max(1)) {
            let mut records = Vec::with_capacity(batch.len());
            for change in batch {
                match change.value(&self.folder).transpose() {
                    Ok(value) => records.push((change.id(), value)),
                    Err(error) => {
                        crate::quiet_eprintln!("computers-account-stores event=read-refused cause={}", error.cause());
                        return stepped;
                    }
                }
            }
            let written = copies.write_in(resource, |store| {
                for (id, value) in &records {
                    let version = store.held_version(&owner, resource, id)?;
                    let mutation = Mutation {
                        id: id.clone(),
                        expected_version: version,
                        request_key: format!("{resource}:{id}:{}", version + 1),
                        deleted: value.is_none(),
                        value: value.clone().unwrap_or(Value::Null),
                    };
                    store.mutate_local_with_check(&owner, resource, mutation, || Ok(()))?;
                }
                Ok(())
            });
            if let Err(refused) = written {
                crate::quiet_eprintln!("computers-account-stores event=write-refused cause={}", refused.cause());
                stepped.refused = true;
                // What the records hold is `held`; the stores hold more, and no store file mark names that, so the next
                // step compares the rows whichever role it has (a computer that lost the term puts the change back).
                *self.kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Kept { rows: held, marks: Vec::new(), term: None });
                return stepped;
            }
            batch.iter().for_each(|change| held.made(change));
            stepped.written += batch.len();
        }
        *self.kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Kept { rows, marks, term: Some(term) });
        self.matched.store(copies.stamp(resource), Ordering::Release);
        if stepped.written > 0 {
            crate::quiet_eprintln!("computers-account-stores event=written account={} records={}", copies.address(), stepped.written);
        }
        stepped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The travelling rows of `stores`, as the records they travel as: record id to value.
    fn as_records(stores: &AccountStores) -> BTreeMap<String, Value> {
        let settings = shipped();
        let kept = kept_here();
        let mut records = BTreeMap::new();
        for (name, value) in &stores.policy {
            if !kept.policy.iter().any(|prefix| name.starts_with(prefix.as_str())) {
                records.insert(format!("{}{name}", settings.policy_prefix), policy_value(name, value));
            }
        }
        for entry in &stores.kv {
            if !kept.kv.iter().any(|prefix| entry.key.starts_with(prefix.as_str())) {
                records.insert(format!("{}{}", settings.kv_prefix, entry.key), kv_value(&entry.key, &entry.blob_id, entry.expiration, &entry.blob));
            }
        }
        records
    }

    #[test]
    fn a_row_travels_as_one_record_and_comes_back_the_same_and_kept_rows_never_travel() {
        let stores = AccountStores {
            policy: vec![("policy-source".into(), "{\"from\":\"new-account\"}".into()), ("revision".into(), "3".into())],
            kv: vec![
                KvEntry { key: "personal-key:x".into(), blob_id: "personal".into(), expiration: None, blob: "{\"a\":1}".into() },
                KvEntry { key: "service-record:show".into(), blob_id: "s".into(), expiration: Some(9), blob: "{}".into() },
            ],
        };
        let records = as_records(&stores);
        assert_eq!(records.len(), 3, "the service record is this computer's own: {records:?}");
        assert!(records.contains_key("policy:revision") && records.contains_key("kv:personal-key:x"));
        let back = as_stores(&records);
        assert_eq!(back.policy, stores.policy);
        assert_eq!(back.kv, stores.kv[..1].to_vec());
        assert_eq!(records, as_records(&back));
    }

    #[test]
    fn a_computers_stores_take_every_travelling_row_and_keep_their_own() {
        let dir = tempfile::tempdir().unwrap();
        let policy = Path::new("policy.sqlite");
        let first = AccountStores {
            policy: vec![("a".into(), "1".into()), ("b".into(), "2".into())],
            kv: vec![KvEntry { key: "k".into(), blob_id: "one".into(), expiration: None, blob: "x".into() },
                     KvEntry { key: "service-record:mine".into(), blob_id: "mine".into(), expiration: None, blob: "m".into() }],
        };
        assert!(create::apply_account_stores(dir.path(), policy, &first, &KeptHere::default()).unwrap() >= 4);
        assert!(create::account_stores_held(dir.path(), policy));
        // The records hold b changed, a gone, c new, and the key-value entry k with another blob; the service record is kept.
        let records = as_records(&AccountStores {
            policy: vec![("b".into(), "20".into()), ("c".into(), "3".into())],
            kv: vec![KvEntry { key: "k".into(), blob_id: "two".into(), expiration: Some(5), blob: "y".into() }],
        });
        create::apply_account_stores(dir.path(), policy, &as_stores(&records), &kept_here()).unwrap();
        let read = create::read_account_stores(dir.path(), policy, usize::MAX).unwrap();
        assert_eq!(read.policy, vec![("b".to_owned(), "20".to_owned()), ("c".to_owned(), "3".to_owned())]);
        let keys: Vec<(&str, &str, Option<i64>)> = read.kv.iter().map(|entry| (entry.key.as_str(), entry.blob.as_str(), entry.expiration)).collect();
        assert_eq!(keys, vec![("k", "y", Some(5)), ("service-record:mine", "m", None)]);
        // Taking the same records again changes nothing.
        assert_eq!(create::apply_account_stores(dir.path(), policy, &as_stores(&records), &kept_here()).unwrap(), 0);
    }
}
