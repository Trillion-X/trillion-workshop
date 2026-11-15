//! The account's own records on record store: the legacy RecordBook is the canonical
//! home for unbound records, and affinity-selected own-work resources hold
//! complete routed work groups.
//!
//! Purpose: hold the record store (`crate::storage::record_store`) of this account's
//! `own-records` resource and its field keys (`own-record-keys`) inside the
//! account's own RecordBook SQLite file, fill both once from the old store (the
//! kept-run checkpoint with its key roots, the erasable-key table, then the
//! journal tail), and answer native reads from that base plus installed
//! affinity-selected own-work resources. Point reads follow a durable typed
//! identity; ID and ordered pages merge live rows across the base and verified
//! installed catalogue resources, and typed schemas fold their original event
//! sequences across those resources. Collection stamps are equality witnesses
//! over the full per-resource change vector. Record bodies never choose their
//! own physical route.
//!
//! Non-Negotiable Invariants:
//! - The legacy `@own-records` and `@own-record-keys` scopes live in the original
//!   RecordBook file beside the account's other tables. Unbound and legacy
//!   identities stay there until an explicit proved carry completes.
//! - Each `@own-work/<key>` resource is a separate declared record store file. An atomic
//!   work group keeps its records, field keys, kept command result and joined local
//!   effects on that one selected physical target. This code speaks only the
//!   `Storage` trait.
//! - Reads answer only from record store, and only once the migration is complete. There
//!   is no old-store answer and no per-read import from the old store.
//! - The migration is resumable at every step. Its position is one record of a
//!   separate record store resource (`own-records-migration`), written after each step; a
//!   step whose position write was lost is redone, and every step is idempotent
//!   (the first checkpoint page after opening skips ids record store already holds, the
//!   journal step writes only what differs).
//! - A command runs only once the base migration is Ready, and only on record store. A
//!   routed point/group binding and its installed target are checked against the
//!   current source generation before and after a read.
//! - Every read through `LocalAccount` keeps the account's admission, state lock and
//!   snapshot witness around it: the admitted original snapshot is finished
//!   (fresh witness check) after the record store and key reads, before any answer
//!   escapes.
//!
//! Key Concepts:
//! - Phases: `checkpoint` (kept-run pages in id order, resumable `after` the last
//!   key, each page with the keys of the id interval it covered), `erasable` (the
//!   old `record_erasable_keys` rows of ids that hold no key yet: erased, or a
//!   key kept there), `journal` (log rows past the checkpoint's `covered`
//!   position, absorbed through `migrate::absorb`, their keys replacing older
//!   ones), `workspace` (the old `workspace_records` rows, label -> exact JSON text, copied into the workspace store's record store
//!   resource as version 1 and read back equal; a label record store already holds stays), `orders` (declared orders filled a
//!   bounded step at a time), `ready`
//!   (reads and commands allowed).
//! - Field keys: one record store record per keyed id in `own-record-keys`, `{"key":
//!   base64}` or `{"erased": true}`; no record is a missing key. The record
//!   bodies in `own-records` never carry a key, so a record's history keeps no
//!   key either.
//! - Commands (`InCommand`): a native command reads its before-states and keys
//!   and writes its records, their new keys and its own command record
//!   (`own-commands`, one per permit id) here, inside its own IMMEDIATE
//!   transaction lent to record store (each write joined by a savepoint), so they all
//!   commit or roll back together. record store is the only store a command writes:
//!   nothing appends to the old journal, so once the migration is Ready nothing
//!   is left to follow.
//!
//! Security Considerations:
//! - Stored forms travel byte for byte; sealed values stay sealed and keys stay
//!   with the account's key owner. Diagnostics carry counts only.
//!
//! AI Assistant Directive:
//! The extensive documentation in this codebase is a critical design feature.
//! You are forbidden from simplifying or removing it. Maintain and extend this detail.
use crate::storage::old_record_tables;

use crate::{
    legacy_kept::LegacyKept,
    legacy_records::StoredRecord,
    record_sealed::SecretFieldKey,
    record_source::BoundedRecordSql,
    record_value::KeyState,
    records::{Error, Mutation, Records},
    storage::{
        record_store_resources::lists,
        record_store::{
            migrate::{absorb, digest},
            native::{body, stored_form, RecordStoreCurrent, TypeIds},
            settings::Limits,
            OrderCursor, RecordStore, SharedSearchMemory, RealClock,
        },
        sqlite::{self, Access, Supply},
        Storage,
    },
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::{path::Path, time::Duration};
use zeroize::{Zeroize, Zeroizing};

/// The record store the account's own records live in (its RecordBook file).
pub(crate) type OwnStore = RecordStore<Supply<sqlite::Handle>>;

/// The record store resource that holds the account's own records.
pub(crate) const RESOURCE: &str = "own-records";
/// The record store resource that holds the field key of each keyed record (same id as the record it opens).
pub(crate) const KEYS: &str = "own-record-keys";
/// The record store resource that holds one record per native command (by permit id): its binding, input, context and result.
pub(crate) const COMMANDS: &str = "own-commands";
/// The record store resource that holds the migration's position (one record).
pub(crate) const POSITION_RESOURCE: &str = "own-records-position";
const POSITION_ID: &str = "position";
/// The row of the directory of the account's volume stores (`book_directory::Directory`), in the primary book.
const DIRECTORY_ID: &str = "book-directory";

/// The account's span directory, read from its row in the primary book (a fresh account has the one default span).
pub(crate) fn directory_of<S: Storage>(store: &RecordStore<S>, account: &str) -> Result<crate::storage::record_store_resources::book_directory::Directory, Error> {
    match store.held_record_with_version(account, RESOURCE, DIRECTORY_ID)?.1 {
        Some(record) => serde_json::from_value(record.value)
            .map_err(|_| Error::Invalid("the account's book directory is unreadable", crate::cause!())),
        None => Ok(crate::storage::record_store_resources::book_directory::Directory::new()),
    }
}

/// Publishes `directory` as the account's span directory. Called only when a split or merge has copied its span: the row
/// is compare-and-set on the version it was read at, so two publishes cannot both win.
pub(crate) fn publish_directory<S: Storage + Send>(store: &mut RecordStore<S>, account: &str, directory: &crate::storage::record_store_resources::book_directory::Directory) -> Result<(), Error> {
    let (version, _) = store.held_record_with_version(account, RESOURCE, DIRECTORY_ID)?;
    let value = serde_json::to_value(directory).map_err(|_| Error::Invalid("the book directory cannot be written", crate::cause!()))?;
    store.mutate(account, RESOURCE, crate::records::Mutation {
        id: DIRECTORY_ID.into(),
        expected_version: version,
        request_key: format!("book-directory-{}", directory.generation()),
        deleted: false,
        value,
    })?;
    Ok(())
}
/// The record store resource that holds the account's resource-identity header (one record), copied from the old store at
/// start by the generic copy (`Position::Copy`).
pub(crate) const IDENTITY: &str = "own-resource-identity";
/// The header's record id: the old table's singleton key.
const IDENTITY_ID: &str = "1";
/// The record store schema (families DATA in `src/storage/record_store/families.json`).
pub(crate) const SCHEMA: &str = "record_store";
/// Protected declaration of the native command's actual local closure. The
/// addressed owner produces it; generic records writes cannot reach IDENTITY.
/// Old customer-database-resource.mjs:82-90 opens its own records/list owner
/// without PersonStore's automation watcher (person-store.mjs:951-974). An
/// independent history therefore does not inherit another history's rules.
/// Local rule/recipe/run kinds come only from the installed model, never a
/// caller assertion that mutable account-wide rules happen to be absent.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CommandClosure {
    contract: String,
    account: String,
    history: crate::storage::record_store_resources::domains::Identity,
    model_revision: String,
    local_roots: Vec<String>,
    rule_roots: Vec<String>,
    external_mutable_dependencies: Vec<String>,
    revision: String,
}
impl CommandClosure {
    fn identity(&self) -> Result<String, Error> {
        let bytes = serde_json::to_vec(&(&self.contract, &self.account, &self.history,
            &self.model_revision, &self.local_roots, &self.rule_roots,
            &self.external_mutable_dependencies)).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok(content_crypto::advanced::blake3::hash(&bytes).to_hex().to_string())
    }
    fn local_roots() -> Vec<String> {
        [RESOURCE, KEYS, COMMANDS, IDENTITY, POSITION_RESOURCE].into_iter().map(str::to_owned).collect()
    }
    fn produced(account: &str, history: &crate::storage::record_store_resources::domains::Identity,
        model: &crate::record_model_policy::Installed) -> Result<Self, Error> {
        let mut rule_roots = Vec::new();
        if let Some(kinds) = crate::rule_bindings::rules_and_runs::Kinds::of(model).map_err(|error| Error::Unavailable(error.cause()))? {
            rule_roots.extend([kinds.rule, kinds.recipe, kinds.run, kinds.outcome, kinds.send]);
            rule_roots.extend(kinds.own);
            rule_roots.sort(); rule_roots.dedup();
        }
        let model_revision = content_crypto::advanced::blake3::hash(
            &serde_json::to_vec(model.json()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?).to_hex().to_string();
        let mut result = Self { contract: "native-command-closure/v1".into(), account: account.into(),
            history: history.clone(), model_revision, local_roots: Self::local_roots(), rule_roots,
            // Every rule, recipe, step observation and write in the native
            // command resolves through the selected transaction. A future
            // external dependency needs an actual atomic group producer;
            // this owner cannot fabricate one or open a parallel snapshot.
            external_mutable_dependencies: Vec::new(), revision: String::new() };
        result.revision = result.identity()?;
        Ok(result)
    }
    fn valid_for(&self, account: &str, history: &crate::storage::record_store_resources::domains::Identity) -> Result<bool, Error> {
        Ok(self.contract == "native-command-closure/v1" && self.account == account
            && self.history == *history && self.local_roots == Self::local_roots()
            && self.external_mutable_dependencies.is_empty()
            && self.model_revision.len() == content_crypto::advanced::blake3::OUT_LEN * 2
            && self.revision == self.identity()?)
    }
}

/// Verify the protected local command closure in the SAME source snapshot as
/// its header/effects. Adoption passes no model: it must transfer the complete
/// retained descriptor verbatim, rather than reinterpreting an arbitrary subset
/// as a closure. Native model activation additionally compares the real model.
pub(crate) fn command_closure_current<S: Storage>(store: &RecordStore<S>, account: &str,
    history: &crate::storage::record_store_resources::domains::Identity,
    model: Option<&crate::record_model_policy::Installed>) -> Result<bool, Error> {
    if !domain_current(store, account, history)? { return Ok(false); }
    command_closure_integrity(store,account,history,model)
}
/// Maintenance may resume an already sealed exact source; that is not ordinary
/// read or write admission. Its original caller and canonical transfer fence
/// remain mandatory at the maintenance owner.
pub(crate) fn command_closure_for_transfer<S:Storage>(store:&RecordStore<S>,account:&str,
    history:&crate::storage::record_store_resources::domains::Identity)->Result<bool,Error> {
    if !domain_integrity_current(store,account,history)? {return Ok(false);}
    command_closure_integrity(store,account,history,None)
}
fn command_closure_integrity<S:Storage>(store:&RecordStore<S>,account:&str,
    history:&crate::storage::record_store_resources::domains::Identity,
    model:Option<&crate::record_model_policy::Installed>)->Result<bool,Error> {
    let (_, held) = store.held_record_with_version(account, IDENTITY, "command-closure")?;
    let Some(held) = held else { return Ok(false); };
    let closure: CommandClosure = serde_json::from_value(held.value).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if !closure.valid_for(account, history)? { return Ok(false); }
    match model {
        Some(model) => Ok(closure == CommandClosure::produced(account, history, model)?),
        None => Ok(true),
    }
}

/// The most checkpoint records one step asks for; a refused page is asked again in halves.
const CHECKPOINT_PAGE: usize = 4096;
/// The most journal rows one step absorbs.
const JOURNAL_ROWS: usize = 256;
/// The most erasable-key rows one step reads.
const ERASABLE_ROWS: usize = 4096;
/// The most workspace records one workspace step copies.
const WORKSPACE_ROWS: usize = 256;
/// The most live records one order-fill step covers.
const ORDER_STEP: usize = 1000;
/// The most old rows one copy step moves.
const COPY_ROWS: usize = 256;

/// Where the migration stands; the phase names are the stderr protocol's progress words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "kebab-case")]
pub enum Position {
    /// Checkpoint pages are read in id order after `after` (the last checkpoint key a step covered); `protected` says a
    /// page held a record whose fields are sealed under a key.
    Checkpoint {
        after: Option<String>,
        #[serde(default)]
        protected: bool,
    },
    /// The erasable-key rows are read after record id `after`; the checkpoint covers the journal to `watermark`.
    Erasable {
        after: Option<String>,
        watermark: i64,
        #[serde(default)]
        protected: bool,
    },
    /// The journal is absorbed past `watermark` (a `record_log` rowid); `protected` as the earlier phases found it.
    Journal {
        watermark: i64,
        #[serde(default)]
        protected: bool,
    },
    /// The old workspace records are copied into the workspace store's record store resource in label order after `after`;
    /// the journal stands at `watermark`.
    Workspace {
        after: Option<String>,
        watermark: i64,
    },
    /// The copy named `copy` (a `copy` of src/storage/record_store_resources.json) moves its old table in walk order after the
    /// cursor `after`, then each later copy; the journal stands at `watermark`.
    Copy {
        copy: String,
        after: Option<serde_json::Value>,
        watermark: i64,
    },
    /// Declared orders are filled; the journal stands at `watermark`.
    Orders { watermark: i64 },
    /// Reads and commands are answered once every copy's name is in `copied`; the old journal stood at `watermark`
    /// when the migration finished. A store made Ready before a copy was declared runs it next.
    Ready {
        watermark: i64,
        #[serde(default)]
        copied: Vec<String>,
    },
}
impl Position {
    /// Ready, with every copy run.
    fn finished(&self) -> bool {
        let Self::Ready { copied, .. } = self else {
            return false;
        };
        copy_names().all(|name| copied.iter().any(|done| done == name))
    }
}

/// The name of every copy, in the order the copy phase runs them.
fn copy_names() -> impl Iterator<Item = &'static str> {
    crate::storage::record_store_resources::copies().map(|(row, copy)| copy.name(row))
}

/// The position after the copy `done` (None: before the first) has run: the next copy, or the orders.
fn after_copy(done: Option<&str>, watermark: i64) -> Position {
    let mut names = copy_names();
    let next = match done {
        None => names.next(),
        Some(done) => names.skip_while(|name| *name != done).nth(1),
    };
    match next {
        Some(name) => Position::Copy {
            copy: name.to_owned(),
            after: None,
            watermark,
        },
        None => Position::Orders { watermark },
    }
}

/// The account's resource-identity header, as the old store kept it.
#[derive(Debug, Deserialize)]
pub(crate) struct Identity {
    pub owner: String,
    pub resource: String,
    pub generation: i64,
    pub ready: i64,
}

/// The resource-identity header of `account` in the record store on `db` (a read joins a transaction `db` holds), None
/// when the store holds none. A header of another shape refuses.
pub(crate) fn identity(
    db: &crate::storage::sqlite::Connection,
    account: &str,
) -> Result<Option<Identity>, Error> {
    let store = crate::workspace_store::lend_store(db, Access::Read).map_err(|error| Error::Unavailable(error.cause()))?;
    let (_, held) = store.held_record_with_version(account, IDENTITY, IDENTITY_ID)?;
    let Some(record) = held else { return Ok(None) };
    serde_json::from_value(record.value)
        .map(Some)
        .map_err(|_| Error::Invalid("the resource identity is unreadable", crate::cause!()))
}

/// Test fixtures of the resource-identity header in the account's record store, where a first start's copy leaves it.
#[cfg(test)]
pub(crate) mod identity_fixture {
    use super::*;

    /// Make the RecordBook file `path` hold the account's record store (its tables) with `header` as `account`'s header.
    pub(crate) fn put(path: &Path, account: &str, header: serde_json::Value) {
        drop(
            crate::storage::record_store_resources::open(
                path,
                crate::sqlite_work::WorkMeter::new(),
            )
            .unwrap(),
        );
        change(
            &crate::storage::sqlite::Connection::open(path).unwrap(),
            account,
            header,
        );
    }

    /// Replace `account`'s header with `header` on `db`, joining a write transaction `db` holds.
    pub(crate) fn change(
        db: &crate::storage::sqlite::Connection,
        account: &str,
        header: serde_json::Value,
    ) {
        let mut store = crate::workspace_store::lend_store(db, Access::Write).unwrap();
        let (version, _) = store
            .held_record_with_version(account, IDENTITY, IDENTITY_ID)
            .unwrap();
        let mutation = Mutation {
            id: IDENTITY_ID.into(),
            expected_version: version,
            request_key: format!("identity-fixture-{}", version + 1),
            deleted: false,
            value: header,
        };
        store
            .mutate_local_with_check(account, IDENTITY, mutation, || Ok(()))
            .unwrap();
    }

    /// The header `owner`, `@own-records`, `generation`, `ready` as the copy writes it.
    pub(crate) fn header(owner: &str, generation: i64, ready: i64) -> serde_json::Value {
        serde_json::json!({"singleton": 1, "owner": owner, "resource": "@own-records", "generation": generation, "ready": ready})
    }
}

/// What one migration step did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Checkpoint {
        records: usize,
        keys: usize,
        more: bool,
    },
    Erasable {
        keys: usize,
        more: bool,
    },
    Journal {
        rows: usize,
        ids: usize,
    },
    Workspace {
        records: usize,
        more: bool,
    },
    Copy {
        records: usize,
        more: bool,
    },
    Orders {
        complete: bool,
    },
    Ready,
}

/// What one journal step did.
enum Followed {
    /// `rows` journal rows were absorbed, writing `ids` records.
    Absorbed { rows: usize, ids: usize },
    /// The rows' records together exceeded the read bounds: nothing was written, and the next step asks for fewer.
    Smaller,
    /// No journal row is past the watermark.
    End,
}

/// The record store of one account's own records and the migration's position in it.
pub struct OwnRecords {
    /// The account's records as every read sees them (the store, the account, whether the migration is done).
    read: OwnRead<Supply<sqlite::Handle>>,
    /// Read-only handles of the same file, for reads that hold no account owner (`read_own`).
    readers: std::sync::Arc<crate::storage::record_store_resources::Readers>,
    /// The selected restore this store was opened for; a newly selected restore opens its own.
    source_identity: String,
    position: Position,
    /// The version of the position record, for its next compare-and-set write.
    position_version: i64,
    /// Set until the first checkpoint step after opening: that page may hold ids an interrupted step already wrote.
    resumed: bool,
    /// The kept-run reader with the migration's allowances (`old_record_tables::kept`).
    kept: LegacyKept,
    /// The most journal rows the next journal step absorbs: halved when their records together exceed the read
    /// bounds, doubled back toward `JOURNAL_ROWS` after each step that fits.
    journal_rows: usize,
    /// Set by a step that used nothing it read (its read went over the bounds): the snapshot it hands back is closed
    /// unfinished, since a refused read retires it and no answer rests on it.
    read_unused: bool,
}

/// The record store body of a field key: its standard base64 text, the shape the old store kept it in.
fn key_body(key: &[u8; 32]) -> serde_json::Value {
    let text = Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(key));
    serde_json::json!({ "key": text.as_str() })
}

/// Zeroize the key text of record store key bodies this account read or wrote, before they are dropped.
fn wipe_key_bodies<'a>(bodies: impl IntoIterator<Item = &'a mut serde_json::Value>) {
    for body in bodies {
        if let Some(serde_json::Value::String(text)) = body.get_mut("key") {
            text.zeroize();
        }
    }
}

/// `record_sealed::SEALED_MARK` as stored JSON text writes it (JSON writes NUL only as `\u0000`).
const SEALED_JSON: &str = "\\u0000sealed";

/// A record that needs a field key: its checkpoint names one, or its stored JSON holds a sealed field. A false match
/// only refuses a store that keeps no key table; it never opens a value.
fn needs_key(record: &StoredRecord) -> bool {
    record.protected_key_present || record.value_json.contains(SEALED_JSON)
}

/// The key state one record store key record answers: no record is a missing key, `{"erased": true}` an erased one.
fn key_state(record: Option<serde_json::Value>) -> Result<KeyState, Error> {
    let Some(mut body) = record else {
        return Ok(KeyState::Missing);
    };
    let answer = (|| {
        if body.get("erased").and_then(serde_json::Value::as_bool) == Some(true) {
            return Ok(KeyState::Erased);
        }
        let text = body
            .get("key")
            .and_then(serde_json::Value::as_str)
            .ok_or(Error::Invalid("a key record holds no key", crate::cause!()))?;
        let decoded = Zeroizing::new(
            base64::engine::general_purpose::STANDARD
                .decode(text)
                .map_err(|_| Error::Invalid("a key record's key is not base64", crate::cause!()))?,
        );
        let bytes: [u8; 32] = decoded
            .as_slice()
            .try_into()
            .map_err(|_| Error::Invalid("a key record's key is not 32 bytes", crate::cause!()))?;
        Ok(KeyState::Present(SecretFieldKey::from_bytes(
            Zeroizing::new(bytes),
        )))
    })();
    wipe_key_bodies([&mut body]);
    answer
}

/// Verify a snapshot's complete logical header before returning the physical
/// authority token. Missing authority is a refusal, including a restored
/// pre-transfer image that has no local adoption state.
pub(crate) fn domain_authority<S: Storage>(store: &RecordStore<S>, account: &str,
    identity: &crate::storage::record_store_resources::domains::Identity) -> Result<String, Error> {
    let expected = serde_json::to_value(identity).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let (_, logical) = store.held_record_with_version(account, IDENTITY, "command-domain")?;
    if logical.is_none_or(|header| header.value != expected) || !position_finished(store, account)? {
        return Err(crate::cause!(Error::Conflict));
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Physical { incarnation: String }
    let (_, physical) = store.held_record_with_version(account, IDENTITY, "command-authority")?;
    let physical: Physical = serde_json::from_value(physical.ok_or(crate::cause!(Error::Conflict))?.value)
        .map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
    if physical.incarnation.trim().is_empty() { return Err(crate::cause!(Error::Conflict)); }
    Ok(physical.incarnation)
}

/// The existing protected physical-header CAS on a generic supplied target.
/// Only the admitted controller calls this inside sealed target activation.
pub(crate) fn replace_domain_authority<S:Storage>(store:&mut RecordStore<S>,account:&str,
    history:&crate::storage::record_store_resources::domains::Identity,source:&str,target:&str,move_id:&str)->Result<(),Error> {
    if source==target || target.trim().is_empty() || move_id.trim().is_empty()
        || domain_authority(store,account,history)?!=source {return Err(crate::cause!(Error::Conflict));}
    let (version,_)=store.held_record_with_version(account,IDENTITY,"command-authority")?;
    store.mutate_local_with_check(account,IDENTITY,Mutation {id:"command-authority".into(),expected_version:version,
        request_key:move_id.into(),deleted:false,value:serde_json::json!({"incarnation":target})},||Ok(()))?;
    Ok(())
}

/// The original internal-row CAS, with the selected command domain's same
/// header/currentness, capture, replica acknowledgement and confirmed commit.
/// The caller supplies the existing authority check, generic copy-owner ack,
/// and scope-aware notice hold. No new public operation or result store exists.
#[allow(clippy::too_many_arguments)]
pub(crate) fn mutate_internal_checked(
    domain: &crate::storage::record_store_resources::domains::Bound,
    authority: &crate::local_account::NativeDomainAuthority,
    account: &str,
    resource: &str,
    input: Mutation,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    until: std::time::Instant,
    capture_required: bool,
    mut check: impl FnMut() -> Result<(), Error>,
    mut acknowledge: impl FnMut(&dyn Storage, Option<&crate::storage::record_store_resources::carry::commit_log::CapturedCommit>) -> Result<(), Error>,
    notices: impl FnOnce() -> crate::records::changes::HeldChanges,
    budget: Option<crate::storage::record_store_resources::StoreBudget>,
) -> Result<crate::records::Change, Error> {
    use crate::storage::record_store_resources::carry::{commit_log, live_adopt as adoption};
    if domain.selection().create || cancel.load(std::sync::atomic::Ordering::Acquire) || std::time::Instant::now() >= until {
        return Err(crate::cause!(Error::Unavailable));
    }
    check()?;
    let writer = domain.writer()?;
    let source = writer.lend(cancel.clone(), until)?;
    let tx = source.begin_waiting(sqlite::TransactionBehavior::Immediate, until)?;
    let held = notices();
    let raw = sqlite::lend(&tx, SCHEMA, Access::Write).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let limits = crate::storage::record_store::settings::shipped().ok_or(crate::cause!(Error::Unavailable))?.live_adoption;
    let history = serde_json::to_value(domain.selection().identity()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let slot = adoption::command_slot(account, &history).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let mut capture = adoption::CommandCapture::begin_admitted(&raw, &slot, limits,
        Some(std::sync::Arc::new(authority.clone()))).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let move_authority = capture.as_ref().map(|capture| capture.native_fence()).transpose().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let _fence = match (&move_authority, &capture) {
        (Some(authority), Some(capture)) => Some(authority.hold(capture.source_incarnation().map_err(|error| Error::Unavailable(error.cause()))?).map_err(|error| Error::Unavailable(error.cause()))?),
        _ => None,
    };
    if capture_required {
        match &capture { Some(capture) => capture.enable_replication(), None => capture = Some(adoption::CommandCapture::unbound(&raw, limits)) }
    }
    let recording = adoption::Recording::new(raw);
    recording.bind(capture.clone());
    // The production budget is the computer's own (`computer_limits`, its keep-free reserve); a caller that passes one
    // (the records-write fixture) keeps its own, and nothing else changes.
    let budget = match budget {
        Some(budget) => budget,
        None => crate::storage::record_store_resources::StoreBudget {
            limits: crate::storage::record_store_resources::computer_limits(&recording, writer.path())?,
            reserve: crate::storage::record_store_resources::this_computer_reserve(),
        },
    };
    let mut store = crate::storage::record_store_resources::native_with_limits(recording, writer.path(), budget.limits, budget.reserve)?;
    let (_, header) = store.held_record_with_version(account, IDENTITY, "command-domain")?;
    if header.is_none_or(|header| header.value != history) || !position_finished(&store, account)? {
        return Err(crate::cause!(Error::Conflict));
    }
    let physical = domain_authority(&store, account, &domain.selection().identity())?;
    let native_permit = authority.hold_native(&physical).map_err(|error| Error::Unavailable(error.cause()))?;
    let result = (|| -> Result<crate::records::Change, Error> {
    if !command_closure_current(&store, account, &domain.selection().identity(), None)? { return Err(crate::cause!(Error::Conflict)); }
    check()?;
    let identity = content_crypto::advanced::blake3::hash(&serde_json::to_vec(&("internal-domain-cas/v1", account, &history, resource, &input))
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?).to_hex().to_string();
    let changed = store.mutate_local_with_check(account, resource, input, &mut check)?;
    let frame = if capture_required {
        let effects = capture.as_ref().ok_or(crate::cause!(Error::Unavailable))?.final_effects(store.storage()).map_err(|error| Error::Unavailable(error.cause()))?;
        if effects.is_empty() { None } else {
            Some(commit_log::append_commit(store.storage(), &slot, &identity, &effects, limits).map_err(|error| Error::Unavailable(error.cause()))?)
        }
    } else { None };
    acknowledge(store.storage(), frame.as_ref())?;
    check()?;
    if cancel.load(std::sync::atomic::Ordering::Acquire) || std::time::Instant::now() >= until { return Err(crate::cause!(Error::Unavailable)); }
    if let Some(capture) = &capture { capture.flush(&**store.storage()).map_err(|error| Error::Unavailable(error.cause()))?; }
    Ok(changed)
    })();
    drop(store);
    let changed = match result {
        Ok(changed) => changed,
        Err(error) => {
            tx.progress_handler(0, None::<fn() -> bool>);
            if !tx.is_autocommit() && tx.rollback().is_err() {
                native_permit.mark_outcome_unknown();
                return Err(crate::cause!(Error::OutcomeUnknown));
            }
            return Err(error);
        }
    };
    tx.commit().map_err(|_| {
        native_permit.mark_outcome_unknown();
        crate::cause!(Error::OutcomeUnknown)
    })?;
    held.published();
    Ok(changed)
}

/// The account's own records inside a native command's own IMMEDIATE transaction, lent to record store (`sqlite::lend`): the
/// command reads its before-states and keys here and writes its records, keys and its command record here, so all of
/// them commit or roll back with the command. Every record store write joins the held transaction through a savepoint. A store
/// lent with the command's search memory (`lend_carrying`) takes it in and gives it back when it is dropped, so the
/// stores of one command, and the commands after it, do not read a scope's unflushed tail again.
pub struct InCommand<'db> {
    store: RecordStore<crate::storage::record_store_resources::carry::live_adopt::Recording<Box<dyn Storage + 'db>>>,
    account: String,
    domain: Option<crate::storage::record_store_resources::domains::Identity>,
    /// The command's search memory this store took in (`lend_carrying`), given back when it is dropped.
    carried: Option<std::rc::Rc<SharedSearchMemory>>,
    /// The stores of the account's placed lists (`bind_list_homes`): a list's rows are read and written there
    /// (src/storage/record_store_resources/lists.rs). None writes and reads only this store.
    list_homes: Option<ListHomes>,
}

/// The stores a command reaches its placed lists' rows in: the account's state folder resources, the installed model and
/// record store settings the account's writers open with, and the command's own cancellation and deadline.
#[derive(Clone)]
pub(crate) struct ListHomes {
    pub(crate) resources: std::sync::Arc<crate::storage::record_store_resources::StateResources>,
    pub(crate) model: std::sync::Arc<crate::record_model_policy::Installed>,
    pub(crate) settings: &'static crate::storage::record_store::settings::Settings,
    pub(crate) cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub(crate) deadline: std::time::Instant,
}

impl ListHomes {
    /// Read the list store `resource` as it is committed now.
    fn read<T>(&self, resource: &str, read: impl for<'c> FnOnce(RecordStore<Supply<&'c sqlite::Connection>>) -> Result<T, Error>) -> Result<T, Error> {
        self.resources.readers(resource)?.read_with(self.settings, read)
    }

    /// Run `write` on the list store `resource` in a transaction of its own, the store made ready first (its position
    /// and identity rows, `OwnRecords::initialize_new_work_store`) when it is new; committed when `write` succeeds. The
    /// store's search memory stays on its kept writer from one write to the next, as the primary's does
    /// (`LentWriter::keep_search`), so a write does not read the store's unflushed tail and segment list again; the store
    /// takes its turn in the account's idle maintenance (`record_store::maintenance`: owed search merges, the exit step,
    /// free pages, the one-time vacuum).
    fn write<T>(&self, account: &str, generation: i64, resource: &str, write: impl FnOnce(&mut InCommand<'_>) -> Result<T, Error>) -> Result<T, Error> {
        let writer = self.resources.writer(resource)?;
        crate::storage::record_store::maintenance::register(writer.path(), account, RESOURCE);
        let lent = writer.lend(self.cancel.clone(), self.deadline)?;
        let search = std::rc::Rc::new(SharedSearchMemory::new(lent.take_search()));
        let transaction = lent.begin_waiting(sqlite::TransactionBehavior::Immediate, self.deadline)?;
        let limits = InCommand::limits(lent.connection(), writer.path())?;
        let mut command = InCommand::lend_carrying_memo(lent.connection(), account, limits, &search, None, self.settings)?;
        command.set_model(&self.model)?;
        if !command.ready()? {
            command.install_new_work_resource(generation)?;
        }
        let answer = write(&mut command)?;
        drop(command);
        transaction.commit().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if let Some(memory) = search.committed() {
            lent.keep_search(memory);
        }
        Ok(answer)
    }
}
impl Drop for InCommand<'_> {
    fn drop(&mut self) {
        if let Some(shared) = &self.carried {
            shared.give_back(self.store.take_search());
        }
    }
}
impl<'db> InCommand<'db> {
    /// The shipped `native` limits for the store in `path`, sized once per command to the disk the file is on.
    pub fn limits(db: &crate::storage::sqlite::Connection, path: &Path) -> Result<Limits, Error> {
        crate::storage::record_store_resources::computer_limits(
            &crate::storage::record_store_resources::command_storage(db, None).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,
            path,
        )
    }

    /// Lend the command's held write transaction `db`. Refuses outside a write transaction: a command never begins
    /// one here and never writes inside a read.
    pub fn lend(
        db: &'db crate::storage::sqlite::Connection,
        account: &str,
        limits: Limits,
    ) -> Result<Self, Error> {
        Self::lend_memo(db, account, limits, None, shipped_settings()?)
    }

    /// `lend` with the record store settings of the account's installed tools (`installed_settings`): the writer's store
    /// is built from the same settings the readers open with.
    pub fn lend_with(
        db: &'db crate::storage::sqlite::Connection,
        account: &str,
        limits: Limits,
        settings: &'static crate::storage::record_store::settings::Settings,
    ) -> Result<Self, Error> {
        Self::lend_memo(db, account, limits, None, settings)
    }

    fn lend_memo(
        db: &'db crate::storage::sqlite::Connection,
        account: &str,
        limits: Limits,
        memo: Option<std::sync::Arc<crate::storage::record_store_resources::CommandMemory>>,
        settings: &'static crate::storage::record_store::settings::Settings,
    ) -> Result<Self, Error> {
        let supply = crate::storage::record_store_resources::command_storage(db, memo).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Self::from_boxed_storage(supply, account, limits, settings)
    }

    /// Lend the already-held transaction selected by the command owner. The
    /// supplied adapter owns physical access, nested rollback and custody; this
    /// owner uses only the storage contract for effects, field keys, indexes and
    /// command receipts. It never opens or commits the outer transaction.
    ///
    /// The command owner must still retain its admission and final disclosure
    /// witnesses. A bare supply grants neither, and an unscoped/read-only supply
    /// is refused before record or model inspection.
    pub(crate) fn from_storage(
        supply: impl Storage + 'db,
        account: &str,
        limits: Limits,
        settings: &'static crate::storage::record_store::settings::Settings,
    ) -> Result<Self, Error> {
        Self::from_boxed_storage(Box::new(supply), account, limits, settings)
    }

    fn from_boxed_storage(supply: Box<dyn Storage + 'db>, account: &str, limits: Limits, settings: &'static crate::storage::record_store::settings::Settings) -> Result<Self, Error> {
        supply.custody().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if !supply.scoped() || !supply.writing().map_err(|error| crate::carry_cause!(Error::Unavailable, error))? {
            return Err(crate::cause!(Error::Unavailable));
        }
        let mut store = RecordStore::with_settings(
            crate::storage::record_store_resources::carry::live_adopt::Recording::new(
                supply,
            ),
            Box::new(RealClock),
            settings,
            limits,
        )?;
        let model = crate::record_model_policy::own_model().map_err(|error| Error::Unavailable(error.cause()))?;
        store.set_referrer_model(model.referrer_parts().to_vec(), Some(vec!["stored".into()]))?;
        if !store.storage().scoped() || !store.storage().writing().map_err(|error| Error::Unavailable(error.cause()))? {
            return Err(crate::cause!(Error::Unavailable));
        }
        Ok(Self {
            store,
            account: account.to_owned(),
            domain: None,
            carried: None,
            list_homes: None,
        })
    }

    /// Every lend of a native transaction shares its one complete adoption capture.
    pub(crate) fn bind_adoption(&self, capture: Option<std::rc::Rc<crate::storage::record_store_resources::carry::live_adopt::CommandCapture>>) {
        self.store.storage().bind(capture);
    }

    /// `lend`, with the command's search memory when no other store of the command holds it (`SharedSearchMemory`).
    pub fn lend_carrying(
        db: &'db crate::storage::sqlite::Connection,
        account: &str,
        limits: Limits,
        shared: &std::rc::Rc<SharedSearchMemory>,
    ) -> Result<Self, Error> {
        Self::lend_carrying_memo(db, account, limits, shared, None, shipped_settings()?)
    }

    pub(crate) fn lend_carrying_memo(
        db: &'db crate::storage::sqlite::Connection,
        account: &str,
        limits: Limits,
        shared: &std::rc::Rc<SharedSearchMemory>,
        memo: Option<std::sync::Arc<crate::storage::record_store_resources::CommandMemory>>,
        settings: &'static crate::storage::record_store::settings::Settings,
    ) -> Result<Self, Error> {
        let mut lent = Self::lend_memo(db, account, limits, memo, settings)?;
        if let Some(memory) = shared.lend() {
            lent.store.carry_search(memory);
            lent.carried = Some(shared.clone());
        }
        Ok(lent)
    }

    /// Use the admitted command's installed model for its same-write participation index.
    pub fn set_model(
        &mut self,
        model: &crate::record_model_policy::Installed,
    ) -> Result<(), Error> {
        self.store
            .set_referrer_model(model.referrer_parts().to_vec(), Some(vec!["stored".into()]))
    }

    pub(crate) fn bind_domain(&mut self, identity: Option<crate::storage::record_store_resources::domains::Identity>) {
        self.domain = identity;
    }

    /// Read and write the account's placed lists' rows in their own stores (src/storage/record_store_resources/lists.rs).
    pub(crate) fn bind_list_homes(&mut self, homes: Option<ListHomes>) {
        self.list_homes = homes;
    }

    /// The list store the record `id` is kept in now, when it is a placed list's row.
    fn list_point(&self, id: &str) -> Result<Option<(&ListHomes, String)>, Error> {
        let Some(homes) = &self.list_homes else { return Ok(None) };
        Ok(lists::point_home(&self.store, &self.account, id)?.map(|home| (homes, home)))
    }

    /// Prepare this installed model's declared index families on the same held command write transaction,
    /// before the native command captures its schema witness. No record or index row is seeded here.
    pub fn prepare_referrers(&self) -> Result<(), Error> {
        self.store
            .storage()
            .prepare_declared_families(self.store.referrer_families())
            .map_err(|error| Error::Unavailable(error.cause()))
    }

    /// Whether the one-time migration is complete. A command reads and writes the account's records only then.
    pub fn ready(&self) -> Result<bool, Error> {
        let (_, held) =
            self.store
                .held_record_with_version(&self.account, POSITION_RESOURCE, POSITION_ID)?;
        let Some(record) = held else { return Ok(false) };
        let position: Position = serde_json::from_value(record.value)
            .map_err(|_| Error::Invalid("migration position is unreadable", crate::cause!()))?;
        Ok(position.finished())
    }

    /// Initialize and read back a newly created internal own-work store on
    /// this exact command writer and transaction, before the affinity owner
    /// activates it as a growth target.
    pub(crate) fn install_new_work_resource(&mut self, generation: i64) -> Result<(), Error> {
        OwnRecords::initialize_new_work_store(&mut self.store, &self.account, generation)?;
        if !self.ready()? {
            return Err(Error::Invalid("new own-work store did not become Ready", crate::cause!()));
        }
        let (_, held) =
            self.store
                .held_record_with_version(&self.account, IDENTITY, IDENTITY_ID)?;
        let identity: Identity = serde_json::from_value(
            held.ok_or(Error::Invalid("new own-work identity is absent", crate::cause!()))?
                .value,
        )
        .map_err(|_| Error::Invalid("new own-work identity is unreadable", crate::cause!()))?;
        if identity.owner != self.account
            || identity.resource != "@own-records"
            || identity.generation != generation
            || identity.ready != 1
        {
            return Err(Error::Invalid(
                "new own-work identity readback does not match",
             crate::cause!()));
        }
        Ok(())
    }

    /// Install or verify the complete domain header on the SAME transaction
    /// as effects, keys, indexes and receipt. No primary-store publication.
    pub(crate) fn command_domain(&mut self, selected: &crate::storage::record_store_resources::domains::Selection) -> Result<(), Error> {
        let (version, header) = self.store.held_record_with_version(&self.account, IDENTITY, "command-domain")?;
        if let Some(header) = header {
            if header.value != serde_json::to_value(selected.identity()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))? { return Err(crate::cause!(Error::Conflict)); }
            return Ok(());
        }
        if !selected.create || version != 0 { return Err(crate::cause!(Error::Conflict)); }
        for resource in [RESOURCE, KEYS, COMMANDS, IDENTITY, POSITION_RESOURCE] {
            if self.store.stamp(&self.account, resource)? != 0 { return Err(crate::cause!(Error::Conflict)); }
        }
        self.install_new_work_resource(selected.generation)?;
        self.store.mutate_local_with_check(&self.account, IDENTITY, Mutation {
            id: "command-domain".into(), expected_version: 0,
            request_key: "install-command-domain".into(), deleted: false, value: serde_json::to_value(selected.identity()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,
        }, || Ok(()))?;
        Ok(())
    }

    /// Install a physical incarnation only alongside the first logical header.
    /// The token comes from independently admitted canonical authority. An old
    /// domain lacking this row is not fresh and cannot be blessed on open.
    pub(crate) fn command_domain_with_authority(&mut self,
        selected: &crate::storage::record_store_resources::domains::Selection,
        incarnation: &str) -> Result<(), Error> {
        if incarnation.trim().is_empty() { return Err(crate::cause!(Error::Conflict)); }
        let (logical_version, logical) = self.store.held_record_with_version(&self.account, IDENTITY, "command-domain")?;
        let (version, physical) = self.store.held_record_with_version(&self.account, IDENTITY, "command-authority")?;
        if logical.is_some() {
            self.command_domain(selected)?;
            let physical = physical.ok_or(crate::cause!(Error::Conflict))?;
            if physical.value != serde_json::json!({"incarnation": incarnation}) { return Err(crate::cause!(Error::Conflict)); }
            return Ok(());
        }
        if logical_version != 0 || version != 0 || physical.is_some() { return Err(crate::cause!(Error::Conflict)); }
        self.command_domain(selected)?;
        self.store.mutate_local_with_check(&self.account, IDENTITY, Mutation {
            id: "command-authority".into(), expected_version: 0,
            request_key: "install-command-authority".into(), deleted: false,
            value: serde_json::json!({"incarnation": incarnation}),
        }, || Ok(()))?;
        Ok(())
    }

    /// Read the physical header without treating missing local move state as
    /// authority. The caller must compare it with fresh canonical admission.
    pub(crate) fn command_authority(&self) -> Result<String, Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Physical { incarnation: String }
        let (_, physical) = self.store.held_record_with_version(&self.account, IDENTITY, "command-authority")?;
        let physical: Physical = serde_json::from_value(physical.ok_or(crate::cause!(Error::Conflict))?.value)
            .map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
        if physical.incarnation.trim().is_empty() { return Err(crate::cause!(Error::Conflict)); }
        Ok(physical.incarnation)
    }

    /// The mover calls this in the target activation transaction after the
    /// complete source image was proved and canonical authority retired the
    /// source. The old physical token must still match the copied image.
    pub(crate) fn replace_command_authority(&mut self, source: &str, target: &str,
        move_id: &str) -> Result<(), Error> {
        if source == target || target.trim().is_empty() || move_id.trim().is_empty()
            || self.command_authority()? != source { return Err(crate::cause!(Error::Conflict)); }
        let (version, _) = self.store.held_record_with_version(&self.account, IDENTITY, "command-authority")?;
        self.store.mutate_local_with_check(&self.account, IDENTITY, Mutation {
            id: "command-authority".into(), expected_version: version,
            request_key: move_id.into(), deleted: false,
            value: serde_json::json!({"incarnation": target}),
        }, || Ok(()))?;
        Ok(())
    }

    /// Activate the currently admitted installed model's local command closure
    /// beside the history header, on this held transaction before effects. An
    /// existing external dependency/corrupt descriptor refuses; it is never
    /// rewritten into an invented independent closure. A new model revision
    /// updates only protected metadata; no rule values or private keys move.
    pub(crate) fn activate_command_closure(&mut self,
        history: &crate::storage::record_store_resources::domains::Identity,
        model: &crate::record_model_policy::Installed) -> Result<(), Error> {
        if !domain_current(&self.store, &self.account, history)? { return Err(crate::cause!(Error::Conflict)); }
        let expected = CommandClosure::produced(&self.account, history, model)?;
        let (version, held) = self.store.held_record_with_version(&self.account, IDENTITY, "command-closure")?;
        if let Some(held) = held {
            let prior: CommandClosure = serde_json::from_value(held.value).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            if !prior.valid_for(&self.account, history)? { return Err(crate::cause!(Error::Conflict)); }
            if prior == expected { return Ok(()); }
        } else if version != 0 { return Err(crate::cause!(Error::Conflict)); }
        self.store.mutate_local_with_check(&self.account, IDENTITY, Mutation {
            id: "command-closure".into(), expected_version: version,
            request_key: format!("activate-command-closure:{version}:{}", expected.revision), deleted: false,
            value: serde_json::to_value(expected).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,
        }, || Ok(()))?;
        Ok(())
    }

    /// The rule executor verifies the model it actually refreshed against the
    /// descriptor activated before effects. A changed installed model cannot
    /// reinterpret half of one command under another rule/recipe vocabulary.
    pub(crate) fn command_closure_matches(&self, model: &crate::record_model_policy::Installed) -> Result<bool, Error> {
        match &self.domain {
            Some(history) => command_closure_current(&self.store, &self.account, history, Some(model)),
            None => Ok(true),
        }
    }

    /// A cursor captured after this command has its write reservation. Only this transaction can add later changes
    /// until commit, so a removal feed read here never includes another command's changes.
    pub(crate) fn change_cursor(&self) -> Result<i64, Error> {
        self.store.stamp(&self.account, RESOURCE)
    }

    pub(crate) fn removals_after(&self, cursor: i64) -> Result<Vec<i64>, Error> {
        deleted_sequences(&self.store, &self.account, RESOURCE, cursor)
    }

    /// One record's stored form, None when absent or deleted.
    pub fn stored(&self, id: &str) -> Result<Option<StoredRecord>, Error> {
        if let Some((homes, home)) = self.list_point(id)? {
            let account = &self.account;
            return homes.read(&home, |store| store.held_record_with_version(account, RESOURCE, id)?.1
                .map(|record| stored_form(id, &record.value)).transpose());
        }
        let (_, held) = self
            .store
            .held_record_with_version(&self.account, RESOURCE, id)?;
        held.map(|record| stored_form(id, &record.value))
            .transpose()
    }

    /// Whether `id` ever held a record: a deletion's tombstone keeps its version, so a removed identity is not fresh.
    pub fn ever_held(&self, id: &str) -> Result<bool, Error> {
        if let Some((homes, home)) = self.list_point(id)? {
            let account = &self.account;
            return homes.read(&home, |store| Ok(store.held_version(account, RESOURCE, id)? > 0));
        }
        Ok(self.store.held_version(&self.account, RESOURCE, id)? > 0)
    }

    /// One record's field key: present, erased, or missing (no key record).
    pub fn key(&self, id: &str) -> Result<KeyState, Error> {
        if let Some((homes, home)) = self.list_point(id)? {
            let account = &self.account;
            return homes.read(&home, |store| key_state(store.held_record_with_version(account, KEYS, id)?.1.map(|record| record.value)));
        }
        key_state(
            self.store
                .held_record_with_version(&self.account, KEYS, id)?
                .1
                .map(|record| record.value),
        )
    }

    /// Live ids of `record_type`, descending, strictly before `before`.
    pub fn ids_of_type(
        &self,
        record_type: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<TypeIds, Error> {
        if let Some(homes) = &self.list_homes {
            if let Some(home) = lists::kind_home(&self.store, &self.account, record_type)? {
                let account = &self.account;
                let (ids, next) = homes.read(&home, |store| store.ids_of_kind(account, RESOURCE, record_type, before, limit))?;
                return Ok(TypeIds { ids, next });
            }
        }
        let (ids, next) =
            self.store
                .ids_of_kind(&self.account, RESOURCE, record_type, before, limit)?;
        Ok(TypeIds { ids, next })
    }

    /// Make `forms` (each written id's final stored form, None when removed) the account's current records and keep
    /// each attached key beside the record it opens: one record store change per changed record, one per new key. `request`
    /// names this change (its log id); each record's write is keyed by it, so a retried write is the same change.
    /// `check` is the command's current-rights and source check, run inside each write. A key is only ever created:
    /// its producer proved it missing in this same transaction, so a held key record surfaces as a conflict.
    ///
    /// With the account's list stores bound (`bind_list_homes`), a placed list's rows and their keys go to their list's
    /// store, in its own transaction, before this one (src/storage/record_store_resources/lists.rs `plan`), a list record
    /// keeps its placement, and the row pointers and homes index that change are written here with the rest.
    pub fn write(
        &mut self,
        forms: &BTreeMap<String, Option<StoredRecord>>,
        keys: &[(&str, &[u8; 32])],
        request: &str,
        mut check: impl FnMut() -> Result<(), Error>,
    ) -> Result<usize, Error> {
        let Some(homes) = self.list_homes.clone() else { return self.write_here(forms, keys, request, check) };
        let plan = lists::plan(&self.store, &self.account, forms, |id| self.stored(id))?;
        let keys_of = |forms: &BTreeMap<String, Option<StoredRecord>>| -> Vec<(&str, &[u8; 32])> {
            keys.iter().filter(|(id, _)| forms.get(*id).is_some_and(Option::is_some)).copied().collect()
        };
        let mut written = 0;
        if !plan.stores.is_empty() {
            let generation = original_generation(&self.store, &self.account)?.ok_or(crate::cause!(Error::Unavailable))?;
            for (store, forms) in &plan.stores {
                let keys = keys_of(forms);
                written += homes.write(&self.account, generation, store, |command| command.write_here(forms, &keys, request, &mut check))?;
            }
        }
        written += plan.write_index(&mut self.store, &self.account, request, &mut check)?;
        written += self.write_here(&plan.primary, &keys_of(&plan.primary), request, check)?;
        Ok(written)
    }

    /// `write` into this store alone.
    fn write_here(
        &mut self,
        forms: &BTreeMap<String, Option<StoredRecord>>,
        keys: &[(&str, &[u8; 32])],
        request: &str,
        mut check: impl FnMut() -> Result<(), Error>,
    ) -> Result<usize, Error> {
        let mut written = 0;
        for (id, form) in forms {
            if form.as_ref().is_some_and(|form| form.id != *id) {
                return Err(Error::Invalid("a written record misnames its id", crate::cause!()));
            }
            let (version, held) =
                self.store
                    .held_record_with_version(&self.account, RESOURCE, id)?;
            let held = held
                .map(|record| stored_form(id, &record.value))
                .transpose()?;
            let unchanged = match (&held, form) {
                (None, None) => true,
                (Some(held), Some(form)) => digest(held) == digest(form),
                _ => false,
            };
            if unchanged {
                continue;
            }
            let mutation = Mutation {
                id: id.clone(),
                expected_version: version,
                request_key: format!("own-records-{request}-{id}"),
                deleted: form.is_none(),
                value: form.as_ref().map_or(serde_json::Value::Null, body),
            };
            self.store
                .mutate_local_with_check(&self.account, RESOURCE, mutation, &mut check)?;
            written += 1;
        }
        for (id, key) in keys {
            if !forms.contains_key(*id) {
                return Err(Error::Invalid("a key opens no written record", crate::cause!()));
            }
            let mutation = Mutation {
                id: (*id).to_owned(),
                expected_version: 0,
                request_key: format!("own-record-keys-{request}-{id}"),
                deleted: false,
                value: key_body(key),
            };
            self.store
                .mutate_local_with_check(&self.account, KEYS, mutation, &mut check)?;
            written += 1;
        }
        Ok(written)
    }

    /// One native command's record (by permit id) and its compare-and-set version.
    pub fn command(&self, permit_id: &str) -> Result<(i64, Option<serde_json::Value>), Error> {
        let (version, held) =
            self.store
                .held_record_with_version(&self.account, COMMANDS, permit_id)?;
        Ok((version, held.map(|record| record.value)))
    }

    /// Write one native command's record over `expected_version`, inside the command's transaction.
    pub fn put_command(
        &mut self,
        permit_id: &str,
        expected_version: i64,
        value: serde_json::Value,
        check: impl FnMut() -> Result<(), Error>,
    ) -> Result<(), Error> {
        let mutation = Mutation {
            id: permit_id.to_owned(),
            expected_version,
            request_key: format!("own-commands-{permit_id}-{expected_version}"),
            deleted: false,
            value,
        };
        self.store
            .mutate_local_with_check(&self.account, COMMANDS, mutation, check)
            .map(|_| ())
    }

    /// Make each id's record and field key here the bodies given, as another store keeps them (None: removed), a list's
    /// move copying a page (src/storage/record_store_resources/lists.rs `step`). An id already holding the body is left
    /// as it is, so a page copied again writes nothing.
    pub(crate) fn copy_in(&mut self, rows: &[KeptBodies], request: &str) -> Result<usize, Error> {
        let mut written = 0;
        for (id, record, key) in rows {
            for (resource, body) in [(RESOURCE, record), (KEYS, key)] {
                let (version, held) = self.store.held_record_with_version(&self.account, resource, id)?;
                let mut held = held.map(|held| held.value);
                let same = held == *body;
                wipe_key_bodies(held.iter_mut());
                if same {
                    continue;
                }
                self.store.mutate_local_with_check(&self.account, resource, Mutation {
                    id: id.clone(),
                    expected_version: version,
                    request_key: format!("{resource}-{request}-{id}"),
                    deleted: body.is_none(),
                    value: body.clone().unwrap_or(serde_json::Value::Null),
                }, || Ok(()))?;
                written += 1;
            }
        }
        Ok(written)
    }
}

/// Inside a command the account's own records are the logical reader's whole supply too: stored forms, field keys and
/// live ids, all from record store on the command's held transaction, so the command reads its own earlier writes.
impl crate::record_value::CurrentKeys for InCommand<'_> {
    fn assert_current(&mut self) -> crate::record_value::Result<()> {
        Ok(())
    }
    fn key(&mut self, owner_id: &str) -> crate::record_value::Result<KeyState> {
        InCommand::key(self, owner_id).map_err(logical_error)
    }
}
impl crate::record_value::Supply for InCommand<'_> {
    fn record_domain(&self) -> Option<serde_json::Value> {
        self.domain.as_ref().and_then(|domain| serde_json::to_value(domain).ok())
    }
    fn qualify_root_identity(&self, id: &str, kind: &str, stamp: &str) -> crate::record_value::Result<String> {
        match &self.domain {
            Some(domain) => domain.root_identity(&self.account, id, kind, stamp).map_err(logical_error),
            None => Ok(stamp.to_owned()),
        }
    }
    fn stored(&mut self, id: &str) -> crate::record_value::Result<Option<StoredRecord>> {
        InCommand::stored(self, id).map_err(logical_error)
    }
}
impl crate::record_value::CurrentIds for InCommand<'_> {
    fn ids_of_type(
        &mut self,
        record_type: &str,
        before: Option<&str>,
        limit: usize,
    ) -> crate::record_value::Result<(Vec<String>, Option<String>)> {
        let page =
            InCommand::ids_of_type(self, record_type, before, limit).map_err(logical_error)?;
        Ok((page.ids, page.next))
    }
}

/// Closed first-open observations. Only these labels, outcomes and error
/// categories reach stderr; no error argument or account/source data is logged.
#[derive(Clone, Copy)]
enum OpenStage {
    BrowserAdmission,
    SourceWitness,
    OriginalCommands,
    Store,
    PositionRead,
    PositionDecode,
    KeptReader,
    SourceFinish,
}
impl OpenStage {
    fn label(self) -> &'static str {
        match self {
            Self::BrowserAdmission => "browser-admission",
            Self::SourceWitness => "source-witness",
            Self::OriginalCommands => "original-commands",
            Self::Store => "store",
            Self::PositionRead => "position-read",
            Self::PositionDecode => "position-decode",
            Self::KeptReader => "kept-reader",
            Self::SourceFinish => "source-finish",
        }
    }
}
#[derive(Clone, Copy)]
enum StepStage {
    Read,
    Import,
    Covered,
    Advance,
    ErasableRead,
    ErasableHeld,
    ErasableImport,
    ErasableAdvance,
    WorkspaceRead,
    WorkspaceHeld,
    WorkspaceImport,
    WorkspaceCheck,
    WorkspaceAdvance,
    CopyRead,
    CopyHeld,
    CopyImport,
    CopyCheck,
    CopyAdvance,
    JournalRead,
    JournalCanonical,
    JournalAbsorb,
    JournalKeys,
    JournalAdvance,
}
impl StepStage {
    fn label(self) -> &'static str {
        match self {
            Self::Read => "checkpoint-read",
            Self::Import => "checkpoint-import",
            Self::Covered => "checkpoint-covered",
            Self::Advance => "checkpoint-advance",
            Self::ErasableRead => "erasable-read",
            Self::ErasableHeld => "erasable-held",
            Self::ErasableImport => "erasable-import",
            Self::ErasableAdvance => "erasable-advance",
            Self::WorkspaceRead => "workspace-read",
            Self::WorkspaceHeld => "workspace-held",
            Self::WorkspaceImport => "workspace-import",
            Self::WorkspaceCheck => "workspace-check",
            Self::WorkspaceAdvance => "workspace-advance",
            Self::CopyRead => "copy-read",
            Self::CopyHeld => "copy-held",
            Self::CopyImport => "copy-import",
            Self::CopyCheck => "copy-check",
            Self::CopyAdvance => "copy-advance",
            Self::JournalRead => "journal-read",
            Self::JournalCanonical => "journal-canonical",
            Self::JournalAbsorb => "journal-absorb",
            Self::JournalKeys => "journal-keys",
            Self::JournalAdvance => "journal-advance",
        }
    }
}

/// Identify only the native owner's static Invalid diagnostic. Never hash an
/// error's Debug representation, a record, a source path or a result body.
pub(crate) fn report_static_error(error: &Error) {
    crate::quiet_eprintln!("native-own-records-error cause={}", error.cause());
    if let Error::Invalid(message, _) = error {
        if message.len() <= 512 {
            crate::quiet_eprintln!(
                "native-own-records-static-error id={}",
                content_crypto::advanced::blake3::hash(message.as_bytes()).to_hex()
            );
        }
    }
}

fn observed<T>(
    scope: &'static str,
    stage: &'static str,
    result: Result<T, Error>,
) -> Result<T, Error> {
    let category = match result.as_ref().err() {
        None => "none",
        Some(Error::Conflict(_)) => "conflict",
        Some(Error::Invalid(_, _)) => "invalid",
        Some(Error::Refused(_, _)) => "refused",
        Some(Error::Unavailable(_)) => "unavailable",
        Some(Error::OutcomeUnknown(_)) => "outcome-unknown",
    };
    crate::quiet_eprintln!(
        "{scope} stage={stage} outcome={} category={category}",
        if result.is_ok() { "passed" } else { "refused" }
    );
    if let Err(error) = &result {
        report_static_error(error);
    }
    result
}
fn observed_open<T>(stage: OpenStage, result: Result<T, Error>) -> Result<T, Error> {
    observed("native-own-records-open", stage.label(), result)
}
fn observed_step<T>(stage: StepStage, result: Result<T, Error>) -> Result<T, Error> {
    observed("native-own-records-step", stage.label(), result)
}

/// A list's move, one page a step, over this account's stores (src/storage/record_store_resources/lists.rs `step`, old
/// placed-lists.mjs `continueMoves`, the resource's alarm): the primary is this writer's own store, a list's store is
/// read through the routed read and written in its own transaction (`ListHomes::write`).
impl OwnRecords {
    /// One step of each list whose move is under way (at most the DATA's `lists_per_pass` a round), round after round
    /// while within `longest`. True once no list moves.
    pub(crate) fn continue_list_moves(&mut self, longest: Duration) -> Result<bool, Error> {
        let settings = lists::move_settings().ok_or(crate::cause!(Error::Unavailable))?;
        let started = std::time::Instant::now();
        loop {
            let (_, index) = lists::index(&self.read.current.store, &self.read.current.account)?;
            if index.moving.is_empty() {
                return Ok(true);
            }
            for list in index.moving.iter().take(settings.lists_per_pass) {
                lists::step(self, list, settings)?;
            }
            if started.elapsed() >= longest {
                return Ok(false);
            }
        }
    }

    /// The stores of this account's placed lists, for a write made outside any command.
    fn list_homes(&self) -> Result<ListHomes, Error> {
        let routes = self.read.routes.as_ref().ok_or(crate::cause!(Error::Unavailable))?;
        Ok(ListHomes {
            resources: routes.resources.clone(),
            model: crate::record_model_policy::installed(&routes.state).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,
            settings: installed_settings(&routes.state)?,
            cancel: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            deadline: std::time::Instant::now() + LIST_STORE_WRITE,
        })
    }

    /// Each id's record and field key bodies as `store` keeps them (None: the primary).
    fn bodies(&self, store: Option<&str>, ids: &[String]) -> Result<Vec<KeptBodies>, Error> {
        match store {
            None => kept_bodies(&self.read.current.store, &self.read.current.account, ids),
            Some(store) => self.read.read_routed(store, |view| kept_bodies(&view.current.store, &view.current.account, ids)),
        }
    }

    fn resource_generation(&self) -> Result<Option<i64>, Error> {
        original_generation(&self.read.current.store, &self.read.current.account)
    }

    fn configure_work_reads(
        &mut self,
        state: &Path,
        owner: &str,
        generation: i64,
        meter: crate::sqlite_work::WorkMeter,
    ) -> Result<(), Error> {
        if !self.ready() {
            self.read.routes = None;
            return Ok(());
        }
        let resources =
            crate::storage::record_store_resources::StateResources::new(state, meter.clone())
                .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        self.read.routes = Some(std::sync::Arc::new(OwnWorkReadRoutes {
            state: state.canonicalize().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,
            owner: owner.to_owned(),
            generation: generation.to_string(),
            meter,
            resources: std::sync::Arc::new(resources),
        }));
        Ok(())
    }

    /// Whether the selected RecordBook's record store own-record migration is Ready.
    /// Resource routing checks this before it creates a fresh internal work
    /// file, so an incomplete source can never be bypassed by a new target.
    pub(crate) fn source_ready(
        path: &Path,
        owner_id: &str,
        meter: crate::sqlite_work::WorkMeter,
    ) -> Result<bool, Error> {
        let store = crate::storage::record_store_resources::open(path, meter)?;
        position_finished(&store, owner_id)
    }

    /// Initialize the own-record contract through a caller's already-owned
    /// record store handle. The placement owner uses this inside its lent writer and
    /// install transaction, so metadata and readback share the selected file
    /// and cannot race a second opener.
    pub(crate) fn initialize_new_work_store<S: Storage>(
        store: &mut RecordStore<S>,
        owner_id: &str,
        generation: i64,
    ) -> Result<(), Error> {
        if owner_id.is_empty() || !(1..=9_007_199_254_740_991).contains(&generation) {
            return Err(Error::Invalid(
                "new own-work owner or generation is invalid",
             crate::cause!()));
        }
        // A reserved target may be reopened after an interrupted install,
        // but it must not contain record history from an unknown file. The
        // scope stamp includes deleted rows as well as live rows.
        if store.stamp(owner_id, RESOURCE)? != 0 {
            return Err(Error::Invalid("new own-work target is not empty", crate::cause!()));
        }
        Self::write_ready_rows(store, owner_id, generation)
    }

    /// The own records store of a computer that kept only a copy of the account and is now let answer it
    /// (src/native_entry/computer/join_itself.rs `ensure_account_stores`): its own records are the account's own, taken
    /// from the writer's feed, so it is made ready as a new account's store is (`initialize_new_work_store`), with the
    /// records it already holds. The position and identity rows are not followed (only `replicated_resources` are), so a
    /// computer that never made them reads its store as not ready and refuses every records call. A store that already
    /// has a position is left as it is.
    pub(crate) fn initialize_copied_work_store<S: Storage>(
        store: &mut RecordStore<S>,
        owner_id: &str,
        generation: i64,
    ) -> Result<(), Error> {
        if owner_id.is_empty() || !(1..=9_007_199_254_740_991).contains(&generation) {
            return Err(Error::Invalid(
                "new own-work owner or generation is invalid",
             crate::cause!()));
        }
        if store
            .held_record_with_version(owner_id, POSITION_RESOURCE, POSITION_ID)?
            .1
            .is_some()
        {
            return Ok(());
        }
        Self::write_ready_rows(store, owner_id, generation)
    }

    /// The ready position and the identity row of a new own-work store, and every declared order marked filled (filled
    /// first for the records the store already holds, `ORDER_STEP` at a time).
    fn write_ready_rows<S: Storage>(
        store: &mut RecordStore<S>,
        owner_id: &str,
        generation: i64,
    ) -> Result<(), Error> {
        let position = Position::Ready {
            watermark: 0,
            copied: copy_names().map(str::to_owned).collect(),
        };
        let identity = serde_json::json!({
            "singleton": 1,
            "owner": owner_id,
            "resource": "@own-records",
            "generation": generation,
            "ready": 1
        });
        for (resource, id, value, key) in [
            (
                POSITION_RESOURCE,
                POSITION_ID,
                serde_json::to_value(&position)
                    .map_err(|_| Error::Invalid("new own-work position is unwritable", crate::cause!()))?,
                format!("new-own-work-position-{owner_id}-{generation}"),
            ),
            (
                IDENTITY,
                IDENTITY_ID,
                identity,
                format!("new-own-work-identity-{owner_id}-{generation}"),
            ),
        ] {
            let (version, held) = store.held_record_with_version(owner_id, resource, id)?;
            if let Some(record) = held {
                if record.value != value {
                    return Err(Error::Invalid(
                        "new own-work file has a conflicting identity",
                     crate::cause!()));
                }
                continue;
            }
            store.mutate_local_with_check(
                owner_id,
                resource,
                Mutation {
                    id: id.to_owned(),
                    expected_version: version,
                    request_key: key,
                    deleted: false,
                    value,
                },
                || Ok(()),
            )?;
        }
        // A new affinity target starts with an empty own-record scope, so every declared order can be marked filled
        // now. Later writes keep those indexes in the same scope; without this empty fill, routed list reads would
        // refuse on the missing order-state row even though all existing records are indexed.
        let orders = store
            .settings()
            .orders
            .iter()
            .map(|declared| declared.order.clone())
            .collect::<Vec<_>>();
        for order in orders {
            // An empty scope fills in one step; a copied one in one step per `ORDER_STEP` records it holds. The bound is
            // the scope's stamp, never below the records it holds, so a store that does not fill is refused, not looped on.
            let mut steps =
                store.stamp(owner_id, RESOURCE)?.unsigned_abs() as usize / ORDER_STEP + 2;
            while !store.fill_order(owner_id, RESOURCE, &order, ORDER_STEP)? {
                steps -= 1;
                if steps == 0 {
                    return Err(crate::cause!(Error::Unavailable));
                }
            }
        }
        Ok(())
    }

    /// Open the record store inside the account's RecordBook file (`path`, canonical) for `owner_id`, with the shipped
    /// `native` host limits: the native record bound and a byte budget sized to the disk the file is on.
    pub(crate) fn open(
        path: &Path,
        owner_id: &str,
        source_identity: &str,
        meter: crate::sqlite_work::WorkMeter,
    ) -> Result<Self, Error> {
        observed_open(
            OpenStage::OriginalCommands,
            old_record_tables::may_create_store(path),
        )?;
        let mut store = observed_open(
            OpenStage::Store,
            crate::storage::record_store_resources::open(path, meter.clone()),
        )?;
        let model = crate::record_model_policy::own_model().map_err(|error| Error::Unavailable(error.cause()))?;
        store.set_referrer_model(model.referrer_parts().to_vec(), Some(vec!["stored".into()]))?;
        let held = observed_open(
            OpenStage::PositionRead,
            store.get(owner_id, POSITION_RESOURCE, POSITION_ID),
        )?;
        let (position, position_version) = match held.record {
            Some(record) => (
                observed_open(
                    OpenStage::PositionDecode,
                    serde_json::from_value(record.value)
                        .map_err(|_| Error::Invalid("migration position is unreadable", crate::cause!())),
                )?,
                record.version,
            ),
            None => (
                Position::Checkpoint {
                    after: None,
                    protected: false,
                },
                0,
            ),
        };
        let kept = observed_open(OpenStage::KeptReader, old_record_tables::kept())?;
        Ok(Self {
            read: OwnRead {
            domain: None,
                current: RecordStoreCurrent::new(store, owner_id, RESOURCE),
                ready: position.finished(),
                key_reads: None,
                key_resource: RESOURCE.into(),
                routed_records: BTreeMap::new(),
                books: Some(crate::storage::record_store_resources::books::Books::new(path, meter.clone(), None)),
                routes: None,
            },
            readers: std::sync::Arc::new(crate::storage::record_store_resources::Readers::new(
                path.to_owned(),
                meter,
            )),
            source_identity: source_identity.to_owned(),
            position,
            position_version,
            resumed: true,
            kept,
            journal_rows: JOURNAL_ROWS,
            read_unused: false,
        })
    }

    pub fn position(&self) -> &Position {
        &self.position
    }

    pub fn ready(&self) -> bool {
        self.position.finished()
    }

    /// The account's record store and the account its records are kept under, for
    /// the other resources of that store (`crate::workspace_store`).
    pub(crate) fn store(&self) -> (&RecordStore<Supply<sqlite::Handle>>, &str) {
        (&self.read.current.store, &self.read.current.account)
    }

    /// The account's record store, writable, for trillion-local's own resources of that store (the wake book,
    /// `crate::wake`), and the account its records are kept under.
    pub(crate) fn store_mut(&mut self) -> (&mut OwnStore, &str) {
        (&mut self.read.current.store, &self.read.current.account)
    }

    /// Write the migration's next position (compare-and-set on its version).
    fn advance(&mut self, next: Position) -> Result<(), Error> {
        let account = self.read.current.account.clone();
        let value = serde_json::to_value(&next)
            .map_err(|_| Error::Invalid("migration position is unwritable", crate::cause!()))?;
        let change = self.read.current.store.mutate(
            &account,
            POSITION_RESOURCE,
            Mutation {
                id: POSITION_ID.into(),
                expected_version: self.position_version,
                request_key: format!("own-records-position-{}", self.position_version + 1),
                deleted: false,
                value,
            },
        )?;
        self.position_version = change.version;
        self.position = next;
        self.read.ready = self.position.finished();
        Ok(())
    }

    /// One bounded migration step against the old store's readonly snapshot `source`.
    pub(crate) fn step<S: BoundedRecordSql>(&mut self, source: S) -> Result<(Step, S), Error> {
        match self.position.clone() {
            Position::Checkpoint { after, protected } => {
                let mut source = source;
                let mut limit = CHECKPOINT_PAGE;
                // A page over its output budget is asked again in halves (`old_record_tables::PageRefusal::OverBudget`); every
                // other refusal ends the step. Source failures retire the readonly snapshot, and repeating them on
                // that handle can only hide the first cause and spend more work.
                let page = loop {
                    match old_record_tables::checkpoint_page(
                        &mut source,
                        &self.kept,
                        after.as_deref(),
                        limit,
                    ) {
                        Err(old_record_tables::PageRefusal::OverBudget(_))
                            if limit > 1
                                && source.read_source_state().is_ok_and(|state| {
                                    state.usable && state.scoped && state.custody && !state.writing
                                }) =>
                        {
                            limit /= 2
                        }
                        read => {
                            break observed_step(
                                StepStage::Read,
                                read.map_err(old_record_tables::PageRefusal::into_error),
                            )?
                        }
                    }
                };
                let protected = protected || page.records.iter().any(needs_key);
                let mut records = page.records;
                let mut keys = page.keys;
                let account = self.read.current.account.clone();
                if std::mem::take(&mut self.resumed) {
                    // The step before a restart may have committed this page's records or keys without its position.
                    let mut fresh = Vec::with_capacity(records.len());
                    for record in records {
                        if self
                            .read
                            .current
                            .store
                            .held_version(&account, RESOURCE, &record.id)?
                            == 0
                        {
                            fresh.push(record);
                        }
                    }
                    records = fresh;
                    let mut fresh = Vec::with_capacity(keys.len());
                    for (id, key) in keys {
                        if self.read.current.store.held_version(&account, KEYS, &id)? == 0 {
                            fresh.push((id, key));
                        }
                    }
                    keys = fresh;
                }
                let batch: Vec<(String, serde_json::Value)> = records
                    .iter()
                    .map(|record| {
                        (
                            record.id.clone(),
                            crate::storage::record_store::native::body(record),
                        )
                    })
                    .collect();
                if !batch.is_empty() {
                    observed_step(
                        StepStage::Import,
                        self.read.current.store.import(&account, RESOURCE, &batch),
                    )?;
                }
                let mut held: Vec<(String, serde_json::Value)> = keys
                    .iter()
                    .map(|(id, key)| (id.clone(), key_body(key)))
                    .collect();
                let written = if held.is_empty() {
                    Ok(0)
                } else {
                    self.read.current.store.import(&account, KEYS, &held)
                };
                wipe_key_bodies(held.iter_mut().map(|(_, body)| body));
                observed_step(StepStage::Import, written)?;
                let (imported, keyed) = (batch.len(), held.len());
                let next = match (page.more, page.last_key) {
                    (true, Some(last)) => Position::Checkpoint {
                        after: Some(last),
                        protected,
                    },
                    (true, None) => {
                        return observed_step(
                            StepStage::Advance,
                            Err(Error::Invalid(
                                "a checkpoint page with more records named no key",
                             crate::cause!())),
                        )
                    }
                    (false, _) => Position::Erasable {
                        after: None,
                        watermark: observed_step(
                            StepStage::Covered,
                            old_record_tables::covered(&mut source),
                        )?,
                        protected,
                    },
                };
                observed_step(StepStage::Advance, self.advance(next))?;
                Ok((
                    Step::Checkpoint {
                        records: imported,
                        keys: keyed,
                        more: page.more,
                    },
                    source,
                ))
            }
            Position::Erasable {
                after,
                watermark,
                protected,
            } => {
                let mut source = source;
                let read = observed_step(
                    StepStage::ErasableRead,
                    old_record_tables::erasable_after(&mut source, after.as_deref(), ERASABLE_ROWS),
                )?;
                // Without the table no erasure or kept key is known: a sealed record then has no answer, never a missing key.
                let Some((rows, last)) = read else {
                    if protected {
                        return observed_step(
                            StepStage::ErasableRead,
                            Err(Error::Invalid("sealed records name no erasable-key table", crate::cause!())),
                        );
                    }
                    observed_step(
                        StepStage::ErasableAdvance,
                        self.advance(Position::Journal {
                            watermark,
                            protected: false,
                        }),
                    )?;
                    return Ok((
                        Step::Erasable {
                            keys: 0,
                            more: false,
                        },
                        source,
                    ));
                };
                let account = self.read.current.account.clone();
                // A key the checkpoint or journal holds answers first, so an erasable row only fills an id with none.
                let ids: Vec<&str> = rows.iter().map(|(id, _)| id.as_str()).collect();
                let mut held = observed_step(
                    StepStage::ErasableHeld,
                    self.read.current.store.get_many(&account, KEYS, &ids),
                )?;
                let absent: Vec<bool> = held.iter().map(Option::is_none).collect();
                wipe_key_bodies(held.iter_mut().flatten().map(|record| &mut record.value));
                let mut batch: Vec<(String, serde_json::Value)> = rows
                    .iter()
                    .zip(absent)
                    .filter(|(_, absent)| *absent)
                    .map(|((id, erasable), _)| {
                        (
                            id.clone(),
                            match erasable {
                                old_record_tables::Erasable::Erased => {
                                    serde_json::json!({ "erased": true })
                                }
                                old_record_tables::Erasable::Key(key) => key_body(key),
                            },
                        )
                    })
                    .collect();
                let written = if batch.is_empty() {
                    Ok(0)
                } else {
                    self.read.current.store.import(&account, KEYS, &batch)
                };
                wipe_key_bodies(batch.iter_mut().map(|(_, body)| body));
                observed_step(StepStage::ErasableImport, written)?;
                let more = last.is_some();
                let next = match last {
                    Some(last) => Position::Erasable {
                        after: Some(last),
                        watermark,
                        protected,
                    },
                    None => Position::Journal {
                        watermark,
                        protected,
                    },
                };
                observed_step(StepStage::ErasableAdvance, self.advance(next))?;
                Ok((
                    Step::Erasable {
                        keys: batch.len(),
                        more,
                    },
                    source,
                ))
            }
            Position::Journal {
                watermark,
                protected,
            } => {
                let (followed, source) = self.follow(source, watermark, protected)?;
                let (rows, ids) = match followed {
                    Followed::Absorbed { rows, ids } => (rows, ids),
                    Followed::Smaller => (0, 0),
                    Followed::End => {
                        self.advance(Position::Workspace {
                            after: None,
                            watermark,
                        })?;
                        (0, 0)
                    }
                };
                Ok((Step::Journal { rows, ids }, source))
            }
            Position::Workspace { after, watermark } => {
                let mut source = source;
                let read = observed_step(
                    StepStage::WorkspaceRead,
                    old_record_tables::workspace_after(
                        &mut source,
                        after.as_deref(),
                        WORKSPACE_ROWS,
                    ),
                )?;
                let Some(page) = read else {
                    observed_step(
                        StepStage::WorkspaceAdvance,
                        self.advance(after_copy(None, watermark)),
                    )?;
                    return Ok((
                        Step::Workspace {
                            records: 0,
                            more: false,
                        },
                        source,
                    ));
                };
                let account = self.read.current.account.clone();
                let resource = crate::workspace_store::resource()
                    .map_err(|_| Error::Invalid("workspace resource DATA", crate::cause!()))?;
                // A label the record store already holds was written there after the old store's last change: it stays.
                let labels: Vec<&str> = page.rows.iter().map(|(label, _)| label.as_str()).collect();
                let held = observed_step(
                    StepStage::WorkspaceHeld,
                    self.read
                        .current
                        .store
                        .get_many(&account, resource, &labels),
                )?;
                let batch: Vec<(String, serde_json::Value)> = page
                    .rows
                    .iter()
                    .zip(&held)
                    .filter(|(_, held)| held.is_none())
                    .map(|((label, text), _)| {
                        (label.clone(), serde_json::Value::String(text.clone()))
                    })
                    .collect();
                let written = if batch.is_empty() {
                    Ok(0)
                } else {
                    self.read.current.store.import(&account, resource, &batch)
                };
                observed_step(StepStage::WorkspaceImport, written)?;
                // Every copied value reads back as the same JSON text, or the step refuses.
                let ids: Vec<&str> = batch.iter().map(|(label, _)| label.as_str()).collect();
                let back = self.read.current.store.get_many(&account, resource, &ids);
                let same = back.and_then(|back| {
                    if back.iter().zip(&batch).all(|(record, (_, value))| {
                        record.as_ref().is_some_and(|record| &record.value == value)
                    }) {
                        Ok(())
                    } else {
                        Err(Error::Invalid(
                            "a copied workspace record reads back different",
                         crate::cause!()))
                    }
                });
                observed_step(StepStage::WorkspaceCheck, same)?;
                let more = page.last.is_some();
                let next = match page.last {
                    Some(last) => Position::Workspace {
                        after: Some(last),
                        watermark,
                    },
                    None => after_copy(None, watermark),
                };
                observed_step(StepStage::WorkspaceAdvance, self.advance(next))?;
                Ok((
                    Step::Workspace {
                        records: batch.len(),
                        more,
                    },
                    source,
                ))
            }
            Position::Copy {
                copy: name,
                after,
                watermark,
            } => {
                let mut source = source;
                let (row, copy) = crate::storage::record_store_resources::copies()
                    .find(|(row, copy)| copy.name(row) == name)
                    .ok_or(Error::Invalid("the copy position names no declared copy", crate::cause!()))?;
                let resource = row.resource.as_str();
                let read = observed_step(
                    StepStage::CopyRead,
                    old_record_tables::rows_after(&mut source, copy, after.as_ref(), COPY_ROWS),
                )?;
                let Some(page) = read else {
                    observed_step(
                        StepStage::CopyAdvance,
                        self.advance(after_copy(Some(&name), watermark)),
                    )?;
                    return Ok((
                        Step::Copy {
                            records: 0,
                            more: false,
                        },
                        source,
                    ));
                };
                let account = self.read.current.account.clone();
                // An id the record store ever held (a deletion keeps its version) was written there after the old
                // store's last change: it stays as it is.
                let held = page
                    .rows
                    .iter()
                    .map(|(id, _)| self.read.current.store.held_version(&account, resource, id))
                    .collect::<Result<Vec<_>, _>>();
                let held = observed_step(StepStage::CopyHeld, held)?;
                let batch: Vec<(String, serde_json::Value)> = page
                    .rows
                    .into_iter()
                    .zip(&held)
                    .filter(|(_, held)| **held == 0)
                    .map(|(row, _)| row)
                    .collect();
                let written = if batch.is_empty() {
                    Ok(0)
                } else {
                    self.read.current.store.import(&account, resource, &batch)
                };
                observed_step(StepStage::CopyImport, written)?;
                // Every copied value reads back the same, or the step refuses.
                let ids: Vec<&str> = batch.iter().map(|(id, _)| id.as_str()).collect();
                let same = self
                    .read
                    .current
                    .store
                    .get_many(&account, resource, &ids)
                    .and_then(|back| {
                        if back.iter().zip(&batch).all(|(record, (_, value))| {
                            record.as_ref().is_some_and(|record| &record.value == value)
                        }) {
                            Ok(())
                        } else {
                            Err(Error::Invalid("a copied record reads back different", crate::cause!()))
                        }
                    });
                observed_step(StepStage::CopyCheck, same)?;
                let more = page.last.is_some();
                let next = match page.last {
                    Some(last) => Position::Copy {
                        copy: name.clone(),
                        after: Some(last),
                        watermark,
                    },
                    None => after_copy(Some(&name), watermark),
                };
                observed_step(StepStage::CopyAdvance, self.advance(next))?;
                Ok((
                    Step::Copy {
                        records: batch.len(),
                        more,
                    },
                    source,
                ))
            }
            Position::Orders { watermark } => {
                let account = self.read.current.account.clone();
                // An order the settings no longer declare leaves first (`retire_orders`), so a record erased later
                // leaves no row of it behind; then every declared order is filled.
                let mut complete = self
                    .read
                    .current
                    .store
                    .retire_orders(&account, RESOURCE, ORDER_STEP)?;
                for declared in self
                    .read
                    .current
                    .store
                    .settings()
                    .orders
                    .iter()
                    .filter(|_| complete)
                {
                    if !self.read.current.store.fill_order(
                        &account,
                        RESOURCE,
                        &declared.order,
                        ORDER_STEP,
                    )? {
                        complete = false;
                        break;
                    }
                }
                if complete {
                    let copied = copy_names().map(str::to_owned).collect();
                    self.advance(Position::Ready { watermark, copied })?;
                }
                Ok((Step::Orders { complete }, source))
            }
            Position::Ready { watermark, copied } => {
                let missing = copy_names().find(|name| !copied.iter().any(|done| done == name));
                let Some(missing) = missing else {
                    return Ok((Step::Ready, source));
                };
                observed_step(
                    StepStage::CopyAdvance,
                    self.advance(Position::Copy {
                        copy: missing.to_owned(),
                        after: None,
                        watermark,
                    }),
                )?;
                Ok((
                    Step::Copy {
                        records: 0,
                        more: true,
                    },
                    source,
                ))
            }
        }
    }

    /// Absorb the journal rows past `watermark` (at most `journal_rows`): each changed id's canonical answer becomes
    /// its record store current record. Answers what the step did, and hands the snapshot back. When the rows' records together
    /// exceed the read bounds, nothing is written and the next step asks for half as many rows; one row whose records
    /// alone exceed them refuses. `protected` says the store holds sealed records.
    fn follow<S: BoundedRecordSql>(
        &mut self,
        source: S,
        watermark: i64,
        protected: bool,
    ) -> Result<(Followed, S), Error> {
        let mut source = source;
        let limit = self.journal_rows;
        let journal = observed_step(
            StepStage::JournalRead,
            old_record_tables::journal_after(&mut source, watermark, limit),
        )?;
        // A journal that keeps no keys cannot name the key of a sealed record it writes, nor that it kept the
        // checkpoint's: no answer, never a missing key.
        const KEYLESS: &str = "sealed records in a journal that keeps no keys";
        if protected && !journal.keyed {
            return Err(Error::Invalid(KEYLESS, crate::cause!()));
        }
        if journal.rows == 0 {
            return Ok((Followed::End, source));
        }
        let (canonical, source) = match observed_step(
            StepStage::JournalCanonical,
            old_record_tables::canonical(source, &self.kept, &journal.ids),
        )? {
            old_record_tables::Canonical::Answers(canonical, source) => (canonical, source),
            old_record_tables::Canonical::OverBounds(source) if limit > 1 => {
                self.journal_rows = limit / 2;
                self.read_unused = true;
                return Ok((Followed::Smaller, source));
            }
            old_record_tables::Canonical::OverBounds(_) => {
                return Err(Error::Invalid(
                    "one journal row's records exceed the original read bounds",
                 crate::cause!()));
            }
        };
        if !journal.keyed
            && canonical
                .iter()
                .any(|(_, record)| record.as_ref().is_some_and(needs_key))
        {
            return Err(Error::Invalid(KEYLESS, crate::cause!()));
        }
        let absorbed = canonical.iter().try_for_each(|(id, record)| {
            absorb(
                &mut self.read.current,
                id,
                record.as_ref(),
                format!("own-records-journal-{}-{id}", journal.last),
            )
            .map(drop)
        });
        observed_step(StepStage::JournalAbsorb, absorbed)?;
        // A journal row's key is the newest the old key owner held for its id: it replaces a checkpoint key.
        let account = self.read.current.account.clone();
        let keyed = journal
            .keys
            .iter()
            .try_for_each(|(id, key)| -> Result<(), Error> {
                let (version, mut held) = self
                    .read
                    .current
                    .store
                    .held_record_with_version(&account, KEYS, id)?;
                let mut body = key_body(key);
                let same = held.as_ref().is_some_and(|held| held.value == body);
                wipe_key_bodies(held.iter_mut().map(|held| &mut held.value));
                if same {
                    wipe_key_bodies([&mut body]);
                    return Ok(());
                }
                self.read.current.store.mutate(
                    &account,
                    KEYS,
                    Mutation {
                        id: id.clone(),
                        expected_version: version,
                        request_key: format!("own-records-journal-{}-key-{id}", journal.last),
                        deleted: false,
                        value: body,
                    },
                )?;
                Ok(())
            });
        observed_step(StepStage::JournalKeys, keyed)?;
        observed_step(
            StepStage::JournalAdvance,
            self.advance(Position::Journal {
                watermark: journal.last,
                protected,
            }),
        )?;
        self.journal_rows = (limit * 2).min(JOURNAL_ROWS);
        Ok((
            Followed::Absorbed {
                rows: journal.rows,
                ids: canonical.len(),
            },
            source,
        ))
    }
}

/// The account's own records as one read sees them: the record store they are kept in (the writer's own handle, or a
/// read-only reader of the same file, `crate::storage::record_store_resources::Readers`), the account, and whether the one-time
/// migration is done (nothing is read before it is).
pub struct OwnRead<S: Storage> {
    current: RecordStoreCurrent<S>,
    domain: Option<crate::storage::record_store_resources::domains::Identity>,
    ready: bool,
    /// Only a protected response asks for its exact field-key dependencies. Ordinary retained readers do not
    /// accumulate observations across calls. This holds identities, never key material.
    key_reads: Option<KeyReads>,
    /// The physical own-record resource whose key table backs this view.
    key_resource: String,
    /// Reused point snapshots for routed ids. A door may read the same id to
    /// check device-only policy and then again to build its answer. Routed
    /// lookups open separate physical snapshots, so memoize the first stored
    /// form within this logical read.
    routed_records: BTreeMap<String, (String, Option<StoredRecord>)>,
    /// Set only by the selected account owner after the RecordBook is ready.
    /// Public observer reads remain pinned to the file they were given.
    routes: Option<std::sync::Arc<OwnWorkReadRoutes>>,
    /// The account's volume stores beyond the primary book (`Books`, `<stem>.overflow-N`). A point read that misses the
    /// primary searches them: a record a volume command placed in a further store is found wherever it landed.
    books: Option<crate::storage::record_store_resources::books::Books>,
}

pub(crate) struct OwnWorkReadRoutes {
    state: std::path::PathBuf,
    owner: String,
    generation: String,
    meter: crate::sqlite_work::WorkMeter,
    resources: std::sync::Arc<crate::storage::record_store_resources::StateResources>,
}
pub(crate) type OwnReadRoutes = std::sync::Arc<OwnWorkReadRoutes>;

impl OwnWorkReadRoutes {
    pub(crate) fn same_context(&self, other: &Self) -> bool {
        self.state == other.state
            && self.owner == other.owner
            && self.generation == other.generation
    }
}

impl OwnWorkReadRoutes {
    fn directory(
        &self,
    ) -> Result<crate::local_account::resource_affinity::store::AffinityDirectory, Error> {
        crate::local_account::resource_affinity::store::AffinityDirectory::new(
            &self.state,
            self.meter.clone(),
            self.owner.clone(),
            self.generation.clone(),
        )
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))
    }

    fn target(&self, id: &str) -> Result<Option<String>, Error> {
        let identity = crate::local_account::resource_affinity::Identity {
            kind: "own-record".into(),
            id: id.to_owned(),
        };
        let route = self
            .directory()?
            .resolve_points_read_only(&[identity], || Ok(()))
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok(route
            .map(|route| route.resource)
            .filter(|resource| resource != "@own-records"))
    }

    /// A reverse page has a fixed catalogue work bound as well as each index page's raw-key bound. A collection
    /// needing more streams refuses instead of silently omitting a resource or collecting an unbounded catalogue.
    fn referrer_resources(&self) -> Result<Vec<String>, Error> {
        let page = self
            .directory()?
            .installed_resources_page_read_only(None, crate::records::MAX_PAGE_ITEMS, || Ok(()))
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if page.next.is_some() {
            return Err(crate::cause!(Error::Unavailable));
        }
        Ok(page.resources)
    }

    fn installed(&self) -> Result<Vec<String>, Error> {
        self.directory()?
            .installed_resources(|| Ok(()))
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))
    }
}

/// One field-key observation, retained only in memory beside the protected answer. The content identity also
/// detects an erased/recreated key whose per-record version restarted; no value or key leaves this witness.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct KeyRead {
    version: i64,
    key_identity: Option<[u8; 32]>,
    erased: bool,
}
pub(crate) type KeyReads = BTreeMap<(String, String), KeyRead>;
pub(crate) fn key_read(version: i64, record: &Option<crate::records::Record>) -> KeyRead {
    let body = record.as_ref().map(|record| &record.value);
    KeyRead {
        version,
        key_identity: body
            .and_then(|body| body.get("key"))
            .and_then(serde_json::Value::as_str)
            .map(|key| {
                content_crypto::advanced::blake3::derive_key(
                    "record field-key read witness",
                    key.as_bytes(),
                )
            }),
        erased: body
            .and_then(|body| body.get("erased"))
            .and_then(serde_json::Value::as_bool)
            == Some(true),
    }
}

/// The original command receipt, result and result key from one read-only
/// record snapshot. The caller opens the result with the retained key state and
/// carries these exact version/key observations through final delivery checks.
pub(crate) struct OriginalCommandResultSnapshot {
    pub(crate) receipt: crate::local_account::command_journal::Completion,
    pub(crate) result_kind: String,
    pub(crate) result_value: crate::ecma_json::Value,
    pub(crate) command_version: i64,
    pub(crate) result_version: i64,
    pub(crate) key_reads: KeyReads,
}

/// Read the canonical journal, protected result and its field key in one
/// existing read-only record snapshot. Feature identities arrive already
/// bound by the selected native command owner.
/// Check the base resource header inside the very snapshot holding the receipt,
/// result and keys. No writer is lent to learn the generation.
pub(crate) fn original_generation(
    store: &RecordStore<impl Storage>,
    owner_id: &str,
) -> Result<Option<i64>, Error> {
    let (_, held) = store.held_record_with_version(owner_id, IDENTITY, IDENTITY_ID)?;
    let Some(held) = held else { return Ok(None) };
    let header: Identity = serde_json::from_value(held.value).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if header.owner != owner_id
        || header.resource != "@own-records"
        || header.ready != 1
        || !(1..=9_007_199_254_740_991).contains(&header.generation)
    {
        return Err(crate::cause!(Error::Unavailable));
    }
    Ok(Some(header.generation))
}

/// A new independent domain cannot bypass an unfinished base migration or
/// revive a superseded account resource generation.
pub(crate) fn original_command_source_matches(
    store: &RecordStore<impl Storage>, owner_id: &str, generation: i64,
) -> Result<bool, Error> {
    Ok(position_finished(store, owner_id)? && original_generation_matches(store, owner_id, generation)?)
}

pub(crate) fn original_generation_matches(
    store: &RecordStore<impl Storage>,
    owner_id: &str,
    generation: i64,
) -> Result<bool, Error> {
    Ok(original_generation(store, owner_id)? == Some(generation))
}

pub(crate) fn read_original_command_result(
    readers: &crate::storage::record_store_resources::Readers,
    owner_id: &str,
    command_id: &str,
    result_id: &str,
    binding: &crate::local_account::command_journal::CommandBinding,
    capture: &crate::local_account::command_journal::Capture<'_>,
    descriptor: &crate::record_write_model::write_command::ResultRecord,
) -> crate::local_account::command_journal::Result<Option<OriginalCommandResultSnapshot>> {
    // Public original-record reconciliation always requires its integer source generation.
    let generation = Some(binding.generation.as_i64()
        .ok_or(crate::cause!(crate::local_account::command_journal::Error::Unavailable))?);
    readers.read(|store| read_original_command_result_in(store, readers.books(), owner_id, command_id, result_id,
            binding, capture, descriptor, generation))
        .map_err(|error| crate::local_account::command_journal::Error::Unavailable(error.cause()))?
}

/// The same journal/result/key snapshot for a just-committed native command.
/// The producer supplies its original optional resource-generation guard;
/// legacy browser commands bind their session in the journal instead.
pub(crate) fn read_original_command_result_bounded(
    readers: &crate::storage::record_store_resources::Readers,
    owner_id: &str,
    command_id: &str,
    result_id: &str,
    binding: &crate::local_account::command_journal::CommandBinding,
    capture: &crate::local_account::command_journal::Capture<'_>,
    descriptor: &crate::record_write_model::write_command::ResultRecord,
    generation: Option<i64>,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    until: std::time::Instant,
) -> crate::local_account::command_journal::Result<Option<OriginalCommandResultSnapshot>> {
    readers.read_bounded(cancel, until, |store| read_original_command_result_in(store, readers.books(), owner_id, command_id, result_id,
            binding, capture, descriptor, generation))
        .map_err(|error| crate::local_account::command_journal::Error::Unavailable(error.cause()))?
}

fn read_original_command_result_in<S: Storage>(
    mut store: RecordStore<S>,
    books: crate::storage::record_store_resources::books::Books,
    owner_id: &str,
    command_id: &str,
    result_id: &str,
    binding: &crate::local_account::command_journal::CommandBinding,
    capture: &crate::local_account::command_journal::Capture<'_>,
    descriptor: &crate::record_write_model::write_command::ResultRecord,
    generation: Option<i64>,
) -> std::result::Result<
    crate::local_account::command_journal::Result<Option<OriginalCommandResultSnapshot>>,
    crate::records::Error,
> {
    let model =
        crate::record_model_policy::own_model().map_err(|error| Error::Unavailable(error.cause()))?;
    store.set_referrer_model(
        model.referrer_parts().to_vec(),
        Some(vec!["stored".into()]),
    )?;
    if let Some(generation) = generation {
        if !original_generation_matches(&store, owner_id, generation)? {
            return Err(crate::cause!(Error::Unavailable));
        }
    }
    if !position_finished(&store, owner_id)? {
        return Err(crate::cause!(Error::Unavailable));
    }
    let (command_version, command) =
        store.held_record_with_version(owner_id, COMMANDS, command_id)?;
    let receipt = match crate::local_account::command_journal::read_original_record(
        binding,
        capture,
        command.map(|record| record.value),
    ) {
        Ok(Some(receipt)) => receipt,
        Ok(None) => return Ok(Ok(None)),
        Err(error) => return Ok(Err(error)),
    };
    let (result_version, result) =
        store.held_record_with_version(owner_id, RESOURCE, result_id)?;
    let result = result.ok_or(crate::cause!(Error::Unavailable))?;
    let stored =
        crate::storage::record_store::native::stored_form(result_id, &result.value)?;
    let raw = crate::ecma_json::parse(stored.value_json.as_bytes(), Default::default())
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let crate::ecma_json::Value::Object(raw) = raw else {
        return Err(crate::cause!(Error::Unavailable));
    };
    let Some(crate::ecma_json::Value::Object(sealed)) =
        raw.get(&descriptor.field.as_str().into())
    else {
        return Err(crate::cause!(Error::Unavailable));
    };
    if stored.record_type != descriptor.kind
        || raw.get(&"source_record".into()).is_some()
        || !crate::record_sealed::is_sealed(sealed)
        || sealed.get(&"k".into()).is_some()
    {
        return Err(crate::cause!(Error::Unavailable));
    }
    // This result belongs to the base command transaction. Routes never
    // redirect one part of a command to another physical snapshot.
    let mut view = OwnRead {
            domain: None,
        current: RecordStoreCurrent::new(store, owner_id, RESOURCE),
        ready: true,
        key_reads: Some(BTreeMap::new()),
        key_resource: RESOURCE.to_owned(),
        routed_records: BTreeMap::new(),
        books: Some(books),
        routes: None,
    };
    let opened = crate::record_value::read(
        result_id,
        &mut view,
        &crate::record_value::OpenPolicy::default(),
        crate::record_value::Limits::default(),
    )
    .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?
    .ok_or(crate::cause!(Error::Unavailable))?;
    let key_reads = view.key_reads.take().unwrap_or_default();
    Ok(Ok(Some(OriginalCommandResultSnapshot {
        receipt,
        result_kind: opened.record_type().to_owned(),
        result_value: opened.value().clone(),
        command_version,
        result_version,
        key_reads,
    })))
}

/// The same single-snapshot read, retaining only the exact field-key owner identities the logical reader used.
pub(crate) fn read_own_with_keys<T, E: From<Error>>(
    readers: &crate::storage::record_store_resources::Readers,
    owner_id: &str,
    routes: Option<OwnReadRoutes>,
    read: impl for<'c> FnOnce(&mut OwnRead<Supply<&'c sqlite::Connection>>) -> Result<T, E>,
) -> Result<(T, KeyReads), E> {
    read_own_observed(readers, owner_id, true, routes, None, read)
}

/// Read the explicitly admitted domain, with its full history header in the
/// same snapshot as the value and key observations. There is no route lookup.
pub(crate) fn read_bound_with_keys<T, E: From<Error>>(
    readers: &crate::storage::record_store_resources::Readers,
    owner_id: &str,
    routes: Option<OwnReadRoutes>,
    identity: Option<&crate::storage::record_store_resources::domains::Identity>,
    model: &crate::record_model_policy::Installed,
    read: impl for<'c> FnOnce(&mut OwnRead<Supply<&'c sqlite::Connection>>) -> Result<T, E>,
) -> Result<(T, KeyReads), E> {
    read_own_observed(readers, owner_id, true, routes, identity.map(|identity| (identity, model)), read)
}

pub(crate) fn domain_current<S:Storage>(store:&RecordStore<S>,owner_id:&str,
    identity:&crate::storage::record_store_resources::domains::Identity)->Result<bool,Error> {
    if !domain_integrity_current(store,owner_id,identity)? {return Ok(false);}
    let stream=crate::storage::record_store_resources::carry::live_adopt::command_slot(owner_id,
        &serde_json::to_value(identity).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    Ok(crate::storage::record_store_resources::carry::live_adopt::command_access(store.storage(),&stream).is_ok())
}
fn domain_integrity_current<S: Storage>(
    store: &RecordStore<S>, owner_id: &str,
    identity: &crate::storage::record_store_resources::domains::Identity,
) -> Result<bool, Error> {
    if !original_command_source_matches(store, owner_id, identity.generation)? { return Ok(false); }
    // The same physical snapshot must contain a complete materialized history.
    // A copied ready/header row cannot make an encrypted shadow or a partially
    // received command visible through the native reader instead of Copies.
    let limits=crate::storage::record_store::settings::shipped().ok_or(crate::cause!(Error::Unavailable))?.live_adoption;
    let stream=crate::storage::record_store_resources::carry::live_adopt::command_slot(owner_id,
        &serde_json::to_value(identity).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let frontier=crate::storage::record_store_resources::carry::commit_log::frontiers(store.storage(),&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if frontier.stored!=frontier.materialized {return Ok(false);}
    let (_, header) = store.held_record_with_version(owner_id, IDENTITY, "command-domain")?;
    Ok(header.is_some_and(|header| serde_json::from_value::<crate::storage::record_store_resources::domains::Identity>(header.value)
        .is_ok_and(|held| held == *identity)))
}

/// Check the domain and every disclosed key together in one fresh snapshot,
/// after the caller's current-rights checks and before any bytes are released.
pub(crate) fn domain_keys_unchanged(
    readers: &crate::storage::record_store_resources::Readers, owner_id: &str,
    identity: &crate::storage::record_store_resources::domains::Identity,
    physical: &str,
    expected: &KeyReads,
) -> Result<bool, Error> {
    readers.read(|store| {
        // Identity, physical authority and field-key custody share the same
        // final snapshot. An earlier physical-header check is not sufficient.
        if domain_authority(&store, owner_id, identity)? != physical { return Ok(false); }
        for ((resource, id), expected) in expected {
            if resource != RESOURCE || observed_key_in(&store, owner_id, id)? != *expected { return Ok(false); }
        }
        Ok(true)
    })
}

/// The record store settings a read of the account's installed tools opens with: the shipped settings plus the orders the
/// installed tools join (`settings::with_joined_orders`). With no routes, the shipped settings alone.
fn read_settings(routes: Option<&OwnWorkReadRoutes>) -> Result<&'static crate::storage::record_store::settings::Settings, Error> {
    match routes {
        Some(routes) => installed_settings(&routes.state),
        None => shipped_settings(),
    }
}

/// The shipped record store settings (the default when no installed tool's orders are read).
pub(crate) fn shipped_settings() -> Result<&'static crate::storage::record_store::settings::Settings, Error> {
    crate::storage::record_store::settings::shipped().ok_or(crate::cause!(Error::Unavailable))
}

/// The record store settings of the account whose state folder is `state`: the shipped settings plus the orders its
/// installed tools join. One `with_joined_orders` value per distinct join, shared by the account's readers and writers.
pub(crate) fn installed_settings(state: &Path) -> Result<&'static crate::storage::record_store::settings::Settings, Error> {
    let model = crate::record_model_policy::installed(state)
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    crate::storage::record_store::settings::with_joined_orders(&model.orders())
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))
}

fn read_own_observed<T, E: From<Error>>(
    readers: &crate::storage::record_store_resources::Readers,
    owner_id: &str,
    observe: bool,
    routes: Option<OwnReadRoutes>,
    domain: Option<(&crate::storage::record_store_resources::domains::Identity, &crate::record_model_policy::Installed)>,
    read: impl for<'c> FnOnce(&mut OwnRead<Supply<&'c sqlite::Connection>>) -> Result<T, E>,
) -> Result<(T, KeyReads), E> {
    let settings = read_settings(routes.as_deref())?;
    readers.read_with(settings, |mut store| {
        let model = match &routes {
            Some(routes) => crate::record_model_policy::installed(&routes.state),
            None => crate::record_model_policy::own_model(),
        }
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        store.set_referrer_model(model.referrer_parts().to_vec(), Some(vec!["stored".into()]))?;
        if let Some((_, model)) = domain {
            store.set_referrer_model(model.referrer_parts().to_vec(), Some(vec!["stored".into()]))?;
        }
        if let Some((identity, _)) = domain {
            if !domain_current(&store, owner_id, identity)? { return Err(crate::cause!(Error::Conflict).into()); }
        }
        let ready = position_finished(&store, owner_id)?;
        let mut view = OwnRead {
            domain: domain.map(|(identity, _)| identity.clone()),
            current: RecordStoreCurrent::new(store, owner_id, RESOURCE),
            ready,
            key_reads: observe.then(BTreeMap::new),
            key_resource: RESOURCE.into(),
            routed_records: BTreeMap::new(),
            books: Some(readers.books()),
            routes,
        };
        let answer = read(&mut view)?;
        Ok((answer, view.key_reads.unwrap_or_default()))
    })
}

/// Freshly check just these field-key records, not a whole-book revision. An unrelated record write does not
/// withdraw a valid snapshot; erasure, replacement or rotation of a key it used does. Key bodies are wiped here
/// just as on the original key read, and none is returned.
pub(crate) fn keys_unchanged(
    readers: &crate::storage::record_store_resources::Readers,
    owner_id: &str,
    routes: Option<&OwnReadRoutes>,
    expected: &KeyReads,
) -> Result<bool, Error> {
    if expected.is_empty() {
        return Ok(true);
    }
    for ((resource, id), expected) in expected {
        let routed = resource != RESOURCE;
        if !routed {
            if let Some(routes) = routes {
                if !route_generation_current(readers, owner_id, routes)?
                    || routes.target(id)?.is_some()
                {
                    return Ok(false);
                }
            }
        }
        if routed {
            let Some(routes) = routes else {
                return Ok(false);
            };
            if !route_generation_current(readers, owner_id, routes)?
                || !routes
                    .installed()?
                    .iter()
                    .any(|installed| installed == resource)
                || routes.target(id)?.as_deref() != Some(resource.as_str())
            {
                return Ok(false);
            }
        }
        let actual = if routed {
            let key_readers = routes
                .ok_or(crate::cause!(Error::Unavailable))?
                .resources
                .readers(resource)
                .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            observed_key_record(&key_readers, owner_id, id)?
        } else {
            observed_key_record(readers, owner_id, id)?
        };
        if &actual != expected {
            return Ok(false);
        }
        if let Some(routes) = routes {
            let current_target = routes.target(id)?;
            if !route_generation_current(readers, owner_id, routes)?
                || (routed
                    && !routes
                        .installed()?
                        .iter()
                        .any(|installed| installed == resource))
                || current_target.as_deref() != routed.then_some(resource.as_str())
            {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

/// Observe a field key on the caller's held snapshot and wipe its temporary
/// stored body after deriving the retained, value-free witness.
pub(crate) fn observed_key_in(
    store: &RecordStore<impl Storage>,
    owner_id: &str,
    id: &str,
) -> Result<KeyRead, Error> {
    if !position_finished(store, owner_id)? {
        return Err(crate::cause!(Error::Unavailable));
    }
    let (version, mut held) = store.held_record_with_version(owner_id, KEYS, id)?;
    let actual = key_read(version, &held);
    if let Some(record) = held.as_mut() {
        wipe_key_bodies([&mut record.value]);
    }
    Ok(actual)
}

fn observed_key_record(
    readers: &crate::storage::record_store_resources::Readers,
    owner_id: &str,
    id: &str,
) -> Result<KeyRead, Error> {
    readers.read(|store| observed_key_in(&store, owner_id, id))
}

fn route_generation_current(
    readers: &crate::storage::record_store_resources::Readers,
    owner_id: &str,
    routes: &OwnWorkReadRoutes,
) -> Result<bool, Error> {
    if routes.owner != owner_id {
        return Ok(false);
    }
    readers.read(|store| {
        let (_, held) = store.held_record_with_version(owner_id, IDENTITY, IDENTITY_ID)?;
        let Some(record) = held else {
            return Ok(false);
        };
        let identity: Identity = serde_json::from_value(record.value)
            .map_err(|_| Error::Invalid("the resource identity is unreadable", crate::cause!()))?;
        Ok(identity.owner == owner_id
            && identity.resource == "@own-records"
            && identity.generation.to_string() == routes.generation
            && identity.ready == 1)
    })
}

/// Retire the old store's tables from `owner_id`'s RecordBook at `path` (canonical; src/storage/record_store_resources.json
/// `retire`, `record_store_resources::retire_old`): refused until the account's one-time migration is finished
/// (`Position::finished`), since until then its startup phases read them. The operator's step, with the app quit.
pub fn retire_old_tables(
    path: &Path,
    owner_id: &str,
    meter: crate::sqlite_work::WorkMeter,
) -> Result<crate::storage::record_store_resources::Retired, Error> {
    crate::storage::record_store_resources::retire_old(path, meter, |store| {
        position_finished(store, owner_id)
    })
}

/// Carry, then empty, the account's own old object files in the state folder `state_root` (canonical;
/// `record_store_resources::retire_old_objects`) into `owner_id`'s record store in the RecordBook at `book`. Refused until the
/// one-time migration is finished, and once its first Ready is older than the store's undo window: an own record
/// deleted after the migration keeps its tombstone only for that window, and the carry knows a deleted id only by
/// it, so past the window an old file could bring a deleted record back. The operator's step, with the app quit.
pub fn retire_old_objects(
    state_root: &Path,
    book: &Path,
    owner_id: &str,
    account_ids: &[&str],
    meter: crate::sqlite_work::WorkMeter,
) -> Result<Vec<crate::storage::record_store_resources::EmptiedObject>, Error> {
    crate::storage::record_store_resources::retire_old_objects(
        state_root,
        book,
        owner_id,
        account_ids,
        meter,
        |store| {
            let Some(until_ms) = old_objects_carry_until(store, owner_id)? else {
                return Ok(false);
            };
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?
                .as_millis();
            Ok(now_ms < u128::from(until_ms))
        },
    )
}

/// The last moment (milliseconds since 1970) `retire_old_objects` may carry `owner_id`'s old object files: the
/// migration's first Ready plus the store's undo window. None while the migration is not finished, or when its first
/// Ready is unknown (then the carry is refused).
pub fn old_objects_carry_until(
    store: &RecordStore<impl Storage>,
    owner_id: &str,
) -> Result<Option<u64>, Error> {
    if !position_finished(store, owner_id)? {
        return Ok(None);
    }
    Ok(first_ready_ms(store, owner_id)?
        .map(|ready_ms| ready_ms.saturating_add(store.settings().undo_windows.records)))
}

/// The wall-clock time `owner_id`'s migration position first became Ready: the oldest Ready version whose older
/// neighbour (still held) is another phase; a store made Ready again after a later copy is Ready since the first. None
/// when the oldest version held is Ready (the versions before it have left by the exit step, so when it first became
/// Ready is unknown) or the position never was Ready. The history is read newest first, every held version once.
fn first_ready_ms(store: &RecordStore<impl Storage>, owner_id: &str) -> Result<Option<u64>, Error> {
    let (mut first, mut newer_ready, mut oldest_ready) = (None, None, false);
    let mut before = None;
    loop {
        let page = store.history(owner_id, POSITION_RESOURCE, POSITION_ID, before, 256)?;
        for held in &page.versions {
            let ready = held
                .value
                .as_ref()
                .is_some_and(|value| value["phase"] == "ready");
            if !ready && newer_ready.is_some() {
                first = newer_ready;
            }
            newer_ready = ready.then(|| crate::storage::record_store::stamp_ms(held.valid_from));
            oldest_ready = ready;
        }
        match page.next {
            Some(next) => before = Some(next),
            None => return Ok(if oldest_ready { None } else { first }),
        }
    }
}

/// Whether `owner_id`'s one-time migration is done, as the store's position record says.
fn position_finished(store: &RecordStore<impl Storage>, owner_id: &str) -> Result<bool, Error> {
    let Some(record) = store
        .held_record_with_version(owner_id, POSITION_RESOURCE, POSITION_ID)?
        .1
    else {
        return Ok(false);
    };
    let position: Position = serde_json::from_value(record.value)
        .map_err(|_| Error::Invalid("migration position is unreadable", crate::cause!()))?;
    Ok(position.finished())
}

/// Deleted change-feed sequence ids after one resource's real HLC cursor.
fn deleted_sequences<S: Storage>(
    store: &RecordStore<S>,
    account: &str,
    resource: &str,
    mut after: i64,
) -> Result<Vec<i64>, Error> {
    let mut sequences = Vec::new();
    loop {
        let page = store.changes_page_readonly(
            account,
            resource,
            after,
            crate::records::MAX_PAGE_ITEMS,
        )?;
        sequences.extend(
            page.items
                .iter()
                .filter(|change| change.deleted)
                .map(|change| change.sequence),
        );
        match page.next {
            Some(next) if next > after => after = next,
            _ => break,
        }
    }
    Ok(sequences)
}

/// Every live schema event in one resource, retaining its source sequence for a cross-resource fold.
fn schema_events<S: Storage>(
    store: &RecordStore<S>,
    account: &str,
    resource: &str,
) -> Result<Vec<(String, String)>, Error> {
    let mut events = Vec::new();
    let mut before: Option<String> = None;
    loop {
        let (ids, next) = store.ids_of_kind(
            account,
            resource,
            crate::storage::kind_views::SCHEMA_KIND,
            before.as_deref(),
            crate::records::MAX_PAGE_ITEMS,
        )?;
        let asked: Vec<&str> = ids.iter().map(String::as_str).collect();
        for record in store
            .get_many(account, resource, &asked)?
            .into_iter()
            .flatten()
        {
            let sequence = record
                .value
                .get("sequence")
                .and_then(serde_json::Value::as_str)
                .ok_or(Error::Invalid("a schema change has no sequence", crate::cause!()))?
                .to_owned();
            let stored = record
                .value
                .get("stored")
                .and_then(serde_json::Value::as_str)
                .ok_or(Error::Invalid("a schema change has no stored value", crate::cause!()))?
                .to_owned();
            events.push((sequence, stored));
        }
        match next {
            Some(next) => before = Some(next),
            None => break,
        }
    }
    Ok(events)
}

fn ordered_cursor(
    settings: &crate::storage::record_store::settings::Settings,
    declared: &crate::storage::record_store::orders::Declared,
    record: &crate::records::Record,
) -> Result<OrderCursor, Error> {
    let kind = record
        .value
        .get(&settings.kind_field)
        .and_then(serde_json::Value::as_str);
    let value = crate::storage::record_store::orders::value_of(declared, kind, &record.value)?
        .ok_or(crate::cause!(Error::Unavailable))?;
    Ok(OrderCursor {
        value,
        id: record.id.clone(),
    })
}

fn add_ordered_work(total: &mut serde_json::Value, work: &serde_json::Value) {
    for field in ["seeks", "rows_read"] {
        let current = total
            .get(field)
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let added = work
            .get(field)
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        total[field] = serde_json::json!(current.saturating_add(added));
    }
}

fn logical_collection_stamp(stamps: &[(String, i64)]) -> Result<String, Error> {
    let digest = content_crypto::advanced::blake3::hash(
        &serde_json::to_vec(stamps).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,
    );
    Ok(digest.to_hex().to_string())
}

/// Qualify values and a complete history frontier in the SAME caller-owned
/// physical snapshot. The current writer observation must precede that scope.
pub(crate) fn assert_domain_snapshot_head(store:&dyn Storage,account:&str,history:&crate::storage::record_store_resources::domains::Identity,
    head:&crate::account::computers::copies::CurrentDomainHead)->Result<(),Error> {
    let stream=crate::storage::record_store_resources::carry::live_adopt::command_slot(account,
        &serde_json::to_value(history).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let limits=crate::storage::record_store::settings::shipped().ok_or(crate::cause!(Error::Unavailable))?.live_adoption;
    let frontier=crate::storage::record_store_resources::carry::commit_log::frontiers(store,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let digest=crate::storage::record_store_resources::carry::commit_log::last_digest(store,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if frontier.stored!=frontier.materialized || frontier.materialized!=head.through || digest!=head.digest {return Err(crate::cause!(Error::Conflict));}
    Ok(())
}

impl<S: Storage> OwnRead<S> {
    pub(crate) fn assert_domain_head(&self,head:&crate::account::computers::copies::CurrentDomainHead)->Result<(),Error> {
        assert_domain_snapshot_head(self.current.store.storage(),&self.current.account,self.domain.as_ref().ok_or(crate::cause!(Error::Conflict))?,head)
    }
    /// The records resources and their native change-feed cursors, in stable resource order. These are true per-file
    /// record store stamps; unlike `stamp()`, each value is a cursor accepted by that resource's `changes_page`.
    pub(crate) fn change_stamps(&self) -> Result<Vec<(String, i64)>, Error> {
        self.assert_route_generation()?;
        let Some(routes) = self.routes.as_ref() else {
            let account = self.current.account.clone();
            return Ok(vec![(
                "@own-records".into(),
                self.current.store.stamp(&account, RESOURCE)?,
            )]);
        };
        let installed = routes.installed()?;
        let resources = self.read_resources(installed.clone())?;
        let stamps = self.stamps_of_resources(&resources)?;
        if routes.installed()? != installed || self.read_resources(installed)? != resources {
            return Err(crate::cause!(Error::Unavailable));
        }
        self.assert_route_generation()?;
        Ok(stamps)
    }

    /// Stamps of exactly the resource set this caller already bounded and verified. This never recollects a
    /// catalogue, so a reverse page cannot widen its work while checking the collection's equality witness.
    fn stamps_of_resources(&self, resources: &[String]) -> Result<Vec<(String, i64)>, Error> {
        let mut stamps = Vec::with_capacity(resources.len());
        for resource in resources {
            let stamp = if resource == "@own-records" {
                self.current.store.stamp(&self.current.account, RESOURCE)?
            } else {
                self.read_routed(&resource, |view| {
                    view.current.store.stamp(&view.current.account, RESOURCE)
                })?
            };
            stamps.push((resource.clone(), stamp));
        }
        Ok(stamps)
    }

    /// Removed record change sequences after the supplied per-resource record store cursors. The result contains the actual
    /// change-feed sequence ids, not aggregate witnesses, so wake ownership can name the changes it observed.
    pub(crate) fn removed_since(&self, cursors: &[(String, i64)]) -> Result<Vec<i64>, Error> {
        self.assert_route_generation()?;
        let Some(routes) = self.routes.as_ref() else {
            let account = self.current.account.clone();
            let after = cursors
                .iter()
                .find(|(resource, _)| resource == "@own-records")
                .map_or(0, |(_, at)| *at);
            return deleted_sequences(&self.current.store, &account, RESOURCE, after);
        };
        let installed = routes.installed()?;
        let resources = self.read_resources(installed.clone())?;
        let mut removed = Vec::new();
        for resource in resources {
            let after = cursors
                .iter()
                .find(|(name, _)| name == &resource)
                .map_or(0, |(_, at)| *at);
            if resource == "@own-records" {
                removed.extend(deleted_sequences(
                    &self.current.store,
                    &self.current.account,
                    RESOURCE,
                    after,
                )?);
            } else {
                removed.extend(self.read_routed(&resource, |view| {
                    deleted_sequences(&view.current.store, &view.current.account, RESOURCE, after)
                })?);
            }
        }
        if routes.installed()? != installed {
            return Err(crate::cause!(Error::Unavailable));
        }
        self.assert_route_generation()?;
        removed.sort_unstable();
        removed.dedup();
        Ok(removed)
    }

    fn assert_route_generation(&self) -> Result<(), Error> {
        let Some(routes) = self.routes.as_ref() else {
            return Ok(());
        };
        let (_, held) =
            self.current
                .store
                .held_record_with_version(&routes.owner, IDENTITY, IDENTITY_ID)?;
        let Some(record) = held else {
            return Err(crate::cause!(Error::Unavailable));
        };
        let identity: Identity = serde_json::from_value(record.value)
            .map_err(|_| Error::Invalid("the resource identity is unreadable", crate::cause!()))?;
        if identity.owner != routes.owner
            || identity.resource != "@own-records"
            || identity.generation.to_string() != routes.generation
            || identity.ready != 1
        {
            return Err(crate::cause!(Error::Unavailable));
        }
        Ok(())
    }

    fn read_routed<T>(
        &self,
        resource: &str,
        read: impl FnOnce(&mut OwnRead<Supply<&sqlite::Connection>>) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let routes = self.routes.as_ref().ok_or(crate::cause!(Error::Unavailable))?;
        let readers = routes
            .resources
            .readers(resource)
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let owner = routes.owner.clone();
        let settings = read_settings(Some(routes.as_ref()))?;
        readers.read_with(settings, |mut store| {
            store.set_referrer_model(
                self.current.store.referrer_parts().to_vec(),
                self.current
                    .store
                    .referrer_value_path()
                    .map(<[String]>::to_vec),
            )?;
            let ready = position_finished(&store, &owner)?;
            let mut view = OwnRead {
            domain: None,
                current: RecordStoreCurrent::new(store, &owner, RESOURCE),
                ready,
                key_reads: None,
                key_resource: resource.to_owned(),
                routed_records: BTreeMap::new(),
                books: None,
                routes: None,
            };
            read(&mut view)
        })
    }

    fn read_routed_key(&mut self, resource: &str, id: &str) -> Result<KeyState, Error> {
        let routes = self.routes.as_ref().ok_or(crate::cause!(Error::Unavailable))?.clone();
        let readers = routes
            .resources
            .readers(resource)
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let owner = routes.owner.clone();
        let key_resource = resource.to_owned();
        let observe = self.key_reads.is_some();
        let (answer, observed) = readers.read(|mut store| {
            store.set_referrer_model(
                self.current.store.referrer_parts().to_vec(),
                self.current
                    .store
                    .referrer_value_path()
                    .map(<[String]>::to_vec),
            )?;
            let ready = position_finished(&store, &owner)?;
            let mut view = OwnRead {
            domain: None,
                current: RecordStoreCurrent::new(store, &owner, RESOURCE),
                ready,
                key_reads: observe.then(BTreeMap::new),
                key_resource: key_resource.clone(),
                routed_records: BTreeMap::new(),
                books: None,
                routes: None,
            };
            let answer = view.key(id)?;
            Ok::<_, Error>((answer, view.key_reads.unwrap_or_default()))
        })?;
        if let Some(parent) = self.key_reads.as_mut() {
            let key = (resource.to_owned(), id.to_owned());
            let used = observed.get(&key).ok_or(crate::cause!(Error::Unavailable))?;
            if parent.get(&key).is_some_and(|earlier| earlier != used) {
                return Err(crate::cause!(Error::Unavailable));
            }
            parent.insert(key, used.clone());
        }
        Ok(answer)
    }

    /// The other store that answers for `id`: the own-work route it is bound to, else the store of the placed list it is
    /// a row of (src/storage/record_store_resources/lists.rs `point_home`); None for this store.
    fn point_resource(&self, id: &str) -> Result<Option<String>, Error> {
        self.assert_route_generation()?;
        let Some(routes) = self.routes.as_ref() else { return Ok(None) };
        match routes.target(id)? {
            Some(resource) => Ok(Some(resource)),
            None => lists::point_home(&self.current.store, &self.current.account, id),
        }
    }

    /// The stores a read across kinds asks besides this one: every installed own-work route and every placed list's
    /// store, sorted, `@own-records` (this store) among them.
    fn read_resources(&self, installed: Vec<String>) -> Result<Vec<String>, Error> {
        let mut resources = installed;
        resources.extend(lists::every_home(&self.current.store, &self.current.account)?);
        resources.push("@own-records".into());
        resources.sort();
        resources.dedup();
        Ok(resources)
    }

    fn catalogue_ids(
        &mut self,
        record_type: &str,
        prefix: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<TypeIds, Error> {
        self.assert_route_generation()?;
        let routes = self.routes.as_ref().ok_or(crate::cause!(Error::Unavailable))?.clone();
        if !(1..=crate::records::MAX_PAGE_ITEMS).contains(&limit) {
            return Err(Error::Invalid("invalid page size", crate::cause!()));
        }
        let installed = routes.installed()?;
        let mut resources = installed.clone();
        resources.push("@own-records".into());
        resources.sort();
        resources.dedup();

        let mut ids = std::collections::BTreeSet::new();
        let mut more = false;
        for resource in resources {
            let page = if resource == "@own-records" {
                self.routes = None;
                let page = self.ids_of_type(record_type, prefix, before, limit);
                self.routes = Some(routes.clone());
                page?
            } else {
                self.read_routed(&resource, |view| {
                    view.ids_of_type(record_type, prefix, before, limit)
                })?
            };
            more |= page.next.is_some();
            for id in page.ids {
                if !ids.insert(id) {
                    return Err(Error::Invalid(
                        "an own-record id is present in multiple resources",
                     crate::cause!()));
                }
            }
        }
        let mut ids = ids.into_iter().rev().collect::<Vec<_>>();
        more |= ids.len() > limit;
        ids.truncate(limit);
        let next = (more && !ids.is_empty())
            .then(|| ids.last().cloned())
            .flatten();
        if routes.installed()? != installed {
            return Err(crate::cause!(Error::Unavailable));
        }
        self.assert_route_generation()?;
        Ok(TypeIds { ids, next })
    }

    /// Keep the index's declaration set equal to the model used by this logical read. This changes no records;
    /// the existing signature state reports incomplete until any pre-model records have been walked by idle work.
    pub fn set_model(
        &mut self,
        model: &crate::record_model_policy::Installed,
    ) -> Result<(), Error> {
        self.current
            .store
            .set_referrer_model(model.referrer_parts().to_vec(), Some(vec!["stored".into()]))
    }

    /// One bounded reverse-index page over the complete logical collection. Each physical stream advances only
    /// through the smallest unfinished frontier, so an empty raw-budget page cannot skip another stream's holders.
    /// Every holder remains a proposal: the records door must open it and recheck its logical model parts.
    pub fn referrers(
        &mut self,
        target: &str,
        role: Option<&str>,
        after: Option<&str>,
        limit: usize,
    ) -> Result<crate::storage::record_store::Referrers, Error> {
        if !self.ready {
            return Err(crate::cause!(Error::Unavailable));
        }
        if !(1..=crate::records::MAX_PAGE_ITEMS).contains(&limit) {
            return Err(Error::Invalid("invalid page size", crate::cause!()));
        }
        if self.routes.is_none() {
            return self.current.store.referrers_of(
                &self.current.account,
                RESOURCE,
                target,
                role,
                after,
                Some(limit),
            );
        }
        self.assert_route_generation()?;
        let routes = self.routes.as_ref().ok_or(crate::cause!(Error::Unavailable))?.clone();
        let installed = routes.referrer_resources()?;
        let resources = self.read_resources(installed.clone())?;
        let before_stamps = self.stamps_of_resources(&resources)?;
        let mut holders =
            BTreeMap::<String, (String, Vec<crate::storage::record_store::Referrer>)>::new();
        let (mut frontier, mut complete, mut examined) = (None::<String>, true, 0usize);
        for resource in resources.iter().cloned() {
            let page = if resource == "@own-records" {
                self.current.store.referrers_of(
                    &self.current.account,
                    RESOURCE,
                    target,
                    role,
                    after,
                    Some(limit),
                )?
            } else {
                self.read_routed(&resource, |view| view.referrers(target, role, after, limit))?
            };
            complete &= page.complete;
            examined = examined.saturating_add(page.examined);
            if let Some(next) = page.next {
                if frontier.as_ref().is_none_or(|held| next < *held) {
                    frontier = Some(next);
                }
            }
            for holder in page.referrers {
                let entry = holders
                    .entry(holder.id.clone())
                    .or_insert_with(|| (resource.clone(), Vec::new()));
                if entry.0 != resource {
                    return Err(Error::Invalid(
                        "an own-record id is present in multiple resources",
                     crate::cause!()));
                }
                entry.1.push(holder);
            }
        }
        let mut selected = Vec::new();
        let mut last = None;
        let mut overflow = false;
        let mut shown = 0;
        for (id, (resource, entries)) in holders {
            if frontier.as_ref().is_some_and(|frontier| id > *frontier) {
                break;
            }
            if shown == limit {
                overflow = true;
                break;
            }
            let pointed = self.point_resource(&id)?;
            if pointed.as_deref().unwrap_or("@own-records") != resource {
                return Err(crate::cause!(Error::Unavailable));
            }
            selected.extend(entries);
            last = Some(id);
            shown += 1;
        }
        let next = if overflow { last } else { frontier };
        if routes.referrer_resources()? != installed || self.read_resources(installed.clone())? != resources {
            return Err(crate::cause!(Error::Unavailable));
        }
        self.assert_route_generation()?;
        if self.stamps_of_resources(&resources)? != before_stamps {
            return Err(crate::cause!(Error::Unavailable));
        }
        Ok(crate::storage::record_store::Referrers {
            referrers: selected,
            next,
            complete,
            examined,
        })
    }

    /// One page of `id`'s stored versions, newest first (`RecordStore::history`), each in its stored form.
    pub fn versions(
        &self,
        id: &str,
        before_version: Option<i64>,
        limit: usize,
    ) -> Result<crate::record_value::history::StoredHistory, Error> {
        if let Some(resource) = self.point_resource(id)? {
            let answer =
                self.read_routed(&resource, |view| view.versions(id, before_version, limit))?;
            if self.point_resource(id)?.as_deref() != Some(resource.as_str()) {
                return Err(crate::cause!(Error::Unavailable));
            }
            return Ok(answer);
        }
        let page = self.current.store.history(
            &self.current.account,
            RESOURCE,
            id,
            before_version,
            limit,
        )?;
        let versions = page
            .versions
            .into_iter()
            .map(|held| {
                Ok(crate::record_value::history::StoredVersion {
                    version: held.version,
                    at_ms: crate::storage::record_store::stamp_ms(held.valid_from),
                    stored: held
                        .value
                        .as_ref()
                        .filter(|_| !held.deleted)
                        .map(|value| stored_form(id, value))
                        .transpose()?,
                })
            })
            .collect::<Result<Vec<_>, Error>>()?;
        Ok(crate::record_value::history::StoredHistory {
            versions,
            next: page.next,
        })
    }

    /// One record's stored form, None when absent or deleted.
    pub fn stored(&mut self, id: &str) -> Result<Option<StoredRecord>, Error> {
        if let Some(resource) = self.point_resource(id)? {
            if let Some((observed_resource, stored)) = self.routed_records.get(id) {
                if observed_resource != &resource {
                    return Err(crate::cause!(Error::Unavailable));
                }
                return Ok(stored.clone());
            }
            let answer = self.read_routed(&resource, |view| view.stored(id))?;
            if self.point_resource(id)?.as_deref() != Some(resource.as_str()) {
                return Err(crate::cause!(Error::Unavailable));
            }
            self.routed_records
                .insert(id.to_owned(), (resource, answer.clone()));
            return Ok(answer);
        }
        if !self.ready {
            return Err(crate::cause!(Error::Unavailable));
        }
        // The span owner alone answers: the directory names the one store that holds the id, so a miss costs the same however
        // many stores the account has (the lookup the directory cost, not a fan-out).
        let directory = directory_of(&self.current.store, &self.current.account)?;
        let owner = directory.owner(id);
        if owner == 0 {
            return self.current.stored_with_held_version(id).map(|(_, stored)| stored);
        }
        let Some(books) = &self.books else { return Err(crate::cause!(Error::Unavailable)) };
        books
            .open_book(owner)?
            .get(&self.current.account, RESOURCE, id)?
            .record
            .map(|record| stored_form(id, &record.value))
            .transpose()
    }

    /// One record's field key: present, erased, or missing (no key record).
    pub fn key(&mut self, id: &str) -> Result<KeyState, Error> {
        if let Some(resource) = self.point_resource(id)? {
            let answer = self.read_routed_key(&resource, id)?;
            if self.point_resource(id)?.as_deref() != Some(resource.as_str()) {
                return Err(crate::cause!(Error::Unavailable));
            }
            return Ok(answer);
        }
        if !self.ready {
            return Err(crate::cause!(Error::Unavailable));
        }
        let account = self.current.account.clone();
        let (version, held) = self
            .current
            .store
            .held_record_with_version(&account, KEYS, id)?;
        if let Some(observed) = self.key_reads.as_mut() {
            let key = (self.key_resource.clone(), id.to_owned());
            let witness = key_read(version, &held);
            if observed
                .get(&key)
                .is_some_and(|earlier| earlier != &witness)
            {
                return Err(crate::cause!(Error::Unavailable));
            }
            observed.insert(key, witness);
        }
        key_state(held.map(|record| record.value))
    }

    /// Live ids of `record_type`, descending, strictly before `before`, and only those starting with `prefix`
    /// (empty: all). Ids sharing a prefix are one contiguous run of the id order, so the walk starts just above the
    /// run and stops at its first id outside it.
    pub fn ids_of_type(
        &mut self,
        record_type: &str,
        prefix: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<TypeIds, Error> {
        if self.routes.is_some() {
            if let Some(home) = lists::kind_home(&self.current.store, &self.current.account, record_type)? {
                return self.read_routed(&home, |view| view.ids_of_type(record_type, prefix, before, limit));
            }
            return self.catalogue_ids(record_type, prefix, before, limit);
        }
        if !self.ready {
            return Err(crate::cause!(Error::Unavailable));
        }
        let start = if prefix.is_empty() {
            before.map(str::to_owned)
        } else {
            let ceiling = format!("{prefix}\u{10FFFF}");
            Some(match before {
                Some(before) if before < ceiling.as_str() => before.to_owned(),
                _ => ceiling,
            })
        };
        let page = self.spanned_ids(record_type, start.as_deref(), limit)?;
        if prefix.is_empty() {
            return Ok(page);
        }
        let inside = page
            .ids
            .iter()
            .take_while(|id| id.starts_with(prefix))
            .count();
        let left_run = inside < page.ids.len();
        let mut ids = page.ids;
        ids.truncate(inside);
        let next = if left_run { None } else { page.next };
        Ok(TypeIds { ids, next })
    }

    /// One page of the account's ids of `record_type`, newest first, strictly before `before`, across every store of the
    /// account. The span directory names each span's store, so the walk starts at the span holding `before` and goes down
    /// one span at a time until the page is full: a page inside the top span asks one store, however many stores there are.
    fn spanned_ids(&mut self, record_type: &str, before: Option<&str>, limit: usize) -> Result<TypeIds, Error> {
        let account = self.current.account.clone();
        let directory = directory_of(&self.current.store, &account)?;
        let spans = directory.spans();
        let mut ids: Vec<String> = Vec::new();
        let mut upper: Option<String> = before.map(str::to_owned);
        for index in (0..spans.len()).rev() {
            if ids.len() >= limit {
                break;
            }
            let span = &spans[index];
            if let (Some(upper), Some(from)) = (upper.as_deref(), span.from.as_deref()) {
                if from >= upper {
                    continue;
                }
            }
            let next_from = spans.get(index + 1).and_then(|next| next.from.as_deref());
            let bound: Option<String> = match (upper.as_deref(), next_from) {
                (Some(upper), Some(next)) => Some(if next < upper { next } else { upper }.to_owned()),
                (Some(upper), None) => Some(upper.to_owned()),
                (None, Some(next)) => Some(next.to_owned()),
                (None, None) => None,
            };
            let want = limit - ids.len();
            let (found, _) = if span.store == 0 {
                self.current
                    .store
                    .ids_of_kind(&account, RESOURCE, record_type, bound.as_deref(), want)?
            } else {
                let books = self
                    .books
                    .as_ref()
                    .ok_or(crate::cause!(Error::Unavailable))?;
                books
                    .open_book(span.store)?
                    .ids_of_kind(&account, RESOURCE, record_type, bound.as_deref(), want)?
            };
            ids.extend(
                found
                    .into_iter()
                    .filter(|id| span.from.as_deref().is_none_or(|from| id.as_str() >= from)),
            );
            upper = span.from.clone();
        }
        let next = if ids.len() < limit { None } else { ids.last().cloned() };
        Ok(TypeIds { ids, next })
    }

    /// One page of records in a declared order, newest value first, past `cursor`.
    pub fn ordered(
        &mut self,
        order: &str,
        cursor: Option<&OrderCursor>,
        limit: usize,
    ) -> Result<crate::storage::record_store::Ordered, Error> {
        if !self.ready {
            return Err(crate::cause!(Error::Unavailable));
        }
        self.ordered_any(order, cursor, true, limit)
    }

    /// A stable equality witness for the account's complete logical own-record collection.
    ///
    /// The resource stamps are HLC values local to each physical record store scope. Their maximum is not a collection
    /// version: a lower-stamp resource can change while another resource retains a higher stamp. The witness hashes
    /// the sorted resource/stamp vector and is intentionally equality-only, never an ordered feed cursor.
    pub fn stamp(&mut self) -> Result<String, Error> {
        if !self.ready {
            return Err(crate::cause!(Error::Unavailable));
        }
        logical_collection_stamp(&self.change_stamps()?)
    }

    /// A declared-order page merged across the base resource and every verified installed own-work resource.
    fn ordered_any(
        &mut self,
        order: &str,
        cursor: Option<&OrderCursor>,
        reverse: bool,
        limit: usize,
    ) -> Result<crate::storage::record_store::Ordered, Error> {
        if !self.ready {
            return Err(crate::cause!(Error::Unavailable));
        }
        if self.routes.is_none() {
            let account = self.current.account.clone();
            return self
                .current
                .store
                .ordered_page(&account, RESOURCE, order, cursor, reverse, limit);
        }
        if !(1..=crate::records::MAX_PAGE_ITEMS).contains(&limit) {
            return Err(Error::Invalid("invalid page size", crate::cause!()));
        }
        self.assert_route_generation()?;
        let routes = self.routes.as_ref().ok_or(crate::cause!(Error::Unavailable))?.clone();
        let settings = self.current.store.settings();
        let declared = settings
            .orders
            .iter()
            .find(|item| item.order == order)
            .ok_or(Error::Invalid("the order is not declared", crate::cause!()))?;
        // An order over a placed list's kind is kept where the list's rows are: its store alone answers.
        if let Some(home) = declared.kind.as_deref().map(|kind| lists::kind_home(&self.current.store, &self.current.account, kind)).transpose()?.flatten() {
            return self.read_routed(&home, |view| view.current.store.ordered_page(&view.current.account, RESOURCE, order, cursor, reverse, limit));
        }
        let installed = routes.installed()?;
        let before_stamps = self.change_stamps()?;
        let resources = self.read_resources(installed.clone())?;

        struct Stream {
            resource: String,
            head: Option<crate::records::Record>,
            head_cursor: Option<OrderCursor>,
            more: bool,
        }
        let mut work = serde_json::json!({"seeks": 0u64, "rows_read": 0u64});
        let mut streams = Vec::with_capacity(resources.len());
        for resource in resources {
            let page = self.ordered_resource(&resource, order, cursor, reverse)?;
            add_ordered_work(&mut work, &page.work);
            let head = page.records.into_iter().next();
            let head_cursor = head
                .as_ref()
                .map(|record| ordered_cursor(settings, declared, record))
                .transpose()?;
            streams.push(Stream {
                resource,
                head,
                head_cursor,
                more: page.next.is_some(),
            });
        }

        let mut records = Vec::with_capacity(limit);
        let mut ids = std::collections::BTreeSet::new();
        let mut last_cursor = None;
        let mut last_had_more = false;
        while records.len() < limit {
            let selected = streams
                .iter()
                .enumerate()
                .filter_map(|(index, stream)| stream.head_cursor.as_ref().map(|key| (index, key)))
                .reduce(|best, candidate| {
                    let ordering = candidate
                        .1
                        .value
                        .cmp(&best.1.value)
                        .then_with(|| candidate.1.id.cmp(&best.1.id));
                    if (reverse && ordering.is_gt()) || (!reverse && ordering.is_lt()) {
                        candidate
                    } else {
                        best
                    }
                })
                .map(|(index, _)| index);
            let Some(index) = selected else {
                break;
            };
            let stream = &mut streams[index];
            let record = stream.head.take().ok_or(crate::cause!(Error::Unavailable))?;
            let key = stream.head_cursor.take().ok_or(crate::cause!(Error::Unavailable))?;
            if !ids.insert(record.id.clone()) {
                return Err(Error::Invalid(
                    "an own-record id is present in multiple resources",
                 crate::cause!()));
            }
            last_cursor = Some(key.clone());
            last_had_more = stream.more;
            records.push(record);
            if records.len() < limit && stream.more {
                let page = self.ordered_resource(&stream.resource, order, Some(&key), reverse)?;
                add_ordered_work(&mut work, &page.work);
                stream.more = page.next.is_some();
                stream.head = page.records.into_iter().next();
                stream.head_cursor = stream
                    .head
                    .as_ref()
                    .map(|record| ordered_cursor(settings, declared, record))
                    .transpose()?;
            }
        }
        let has_more = last_had_more || streams.iter().any(|stream| stream.head.is_some());
        if routes.installed()? != installed {
            return Err(crate::cause!(Error::Unavailable));
        }
        self.assert_route_generation()?;
        if self.change_stamps()? != before_stamps {
            return Err(crate::cause!(Error::Unavailable));
        }
        Ok(crate::storage::record_store::Ordered {
            records,
            next: has_more.then_some(last_cursor).flatten(),
            work,
        })
    }

    /// The ids the word index (`RecordStore::search`, every searched field) proposes for `word`, newest change first, across
    /// the account's own records and every installed route, at most `limit`. Ids are only proposals: the door's search
    /// opens each one and checks it, so a route's change between these reads is answered by that check, not here.
    fn search_any(&self, word: &str, limit: usize) -> Result<Vec<String>, Error> {
        if !self.ready {
            return Err(crate::cause!(Error::Unavailable));
        }
        let account = self.current.account.clone();
        let every = self.current.store.settings().search.every_text();
        let own = self
            .current
            .store
            .search(&account, RESOURCE, every, word, limit)?;
        let mut ids: Vec<String> = own.records.into_iter().map(|record| record.id).collect();
        if let Some(routes) = self.routes.as_ref() {
            self.assert_route_generation()?;
            let installed = self.read_resources(routes.clone().installed()?)?;
            for resource in installed
                .iter()
                .filter(|resource| resource.as_str() != "@own-records")
            {
                let routed = self.read_routed(resource, |view| {
                    view.current.store.search(
                        &view.current.account,
                        RESOURCE,
                        view.current.store.settings().search.every_text(),
                        word,
                        limit,
                    )
                })?;
                ids.extend(routed.records.into_iter().map(|record| record.id));
            }
        }
        let mut seen = std::collections::BTreeSet::new();
        ids.retain(|id| seen.insert(id.clone()));
        ids.truncate(limit);
        Ok(ids)
    }

    fn ordered_resource(
        &self,
        resource: &str,
        order: &str,
        cursor: Option<&OrderCursor>,
        reverse: bool,
    ) -> Result<crate::storage::record_store::Ordered, Error> {
        if resource == "@own-records" {
            self.current.store.ordered_page(
                &self.current.account,
                RESOURCE,
                order,
                cursor,
                reverse,
                1,
            )
        } else {
            self.read_routed(resource, |view| {
                view.current.store.ordered_page(
                    &view.current.account,
                    RESOURCE,
                    order,
                    cursor,
                    reverse,
                    1,
                )
            })
        }
    }

    /// The schema fold for the complete logical collection. Event sequence is the global logical ordering; resource
    /// name is a deterministic tie-break for malformed or legacy duplicate sequence values.
    fn all_kind_schemas(
        &self,
    ) -> Result<std::collections::BTreeMap<String, crate::storage::kind_views::KindSchema>, Error>
    {
        if self.routes.is_none() {
            return Ok((*crate::storage::kind_views::schemas(
                &self.current.store,
                &self.current.account,
                RESOURCE,
            )?)
            .clone());
        }
        self.assert_route_generation()?;
        let routes = self.routes.as_ref().ok_or(crate::cause!(Error::Unavailable))?.clone();
        let installed = routes.installed()?;
        let before_stamps = self.change_stamps()?;
        let resources = self.read_resources(installed.clone())?;
        let mut events = Vec::new();
        for resource in &resources {
            let found = if resource == "@own-records" {
                schema_events(&self.current.store, &self.current.account, RESOURCE)?
            } else {
                self.read_routed(resource, |view| {
                    schema_events(&view.current.store, &view.current.account, RESOURCE)
                })?
            };
            events.extend(
                found
                    .into_iter()
                    .map(|(sequence, stored)| (sequence, resource.clone(), stored)),
            );
        }
        events.sort_by(|left, right| (&left.0, &left.1).cmp(&(&right.0, &right.1)));
        let folded =
            crate::storage::kind_views::fold(events.iter().map(|(_, _, stored)| stored.as_str()))?;
        if routes.installed()? != installed {
            return Err(crate::cause!(Error::Unavailable));
        }
        self.assert_route_generation()?;
        if self.change_stamps()? != before_stamps {
            return Err(crate::cause!(Error::Unavailable));
        }
        Ok(folded)
    }
}

/// How long a list store's write outside a command (a move's page) may wait for that store.
const LIST_STORE_WRITE: Duration = Duration::from_secs(30);

/// One id's record body and field key body as a store keeps them.
type KeptBodies = (String, Option<serde_json::Value>, Option<serde_json::Value>);

fn kept_bodies<S: Storage>(store: &RecordStore<S>, account: &str, ids: &[String]) -> Result<Vec<KeptBodies>, Error> {
    ids.iter().map(|id| Ok((
        id.clone(),
        store.held_record_with_version(account, RESOURCE, id)?.1.map(|record| record.value),
        store.held_record_with_version(account, KEYS, id)?.1.map(|record| record.value),
    ))).collect()
}

impl lists::MoveStores for OwnRecords {
    fn ids_after(&mut self, store: Option<&str>, kind: &str, after: Option<&str>, limit: usize) -> Result<Vec<String>, Error> {
        match store {
            None => Ok(self.read.current.store.ids_of_kind_after(&self.read.current.account, RESOURCE, kind, after, limit)?.0),
            Some(store) => self.read.read_routed(store, |view| {
                Ok(view.current.store.ids_of_kind_after(&view.current.account, RESOURCE, kind, after, limit)?.0)
            }),
        }
    }

    fn copy(&mut self, from: Option<&str>, to: &str, ids: &[String], request: &str) -> Result<(), Error> {
        let mut rows = self.bodies(from, ids)?;
        let generation = original_generation(&self.read.current.store, &self.read.current.account)?.ok_or(crate::cause!(Error::Unavailable))?;
        let account = self.read.current.account.clone();
        let copied = self.list_homes()?.write(&account, generation, to, |command| command.copy_in(&rows, request));
        wipe_key_bodies(rows.iter_mut().filter_map(|(_, _, key)| key.as_mut()));
        copied.map(|_| ())
    }

    fn remove(&mut self, store: Option<&str>, ids: &[String], request: &str) -> Result<(), Error> {
        let rows: Vec<_> = ids.iter().map(|id| (id.clone(), None, None)).collect();
        let account = self.read.current.account.clone();
        match store {
            None => {
                for (resource, scope) in [(RESOURCE, "records"), (KEYS, "keys")] {
                    let mut removals = Vec::new();
                    for id in ids {
                        let (version, held) = self.read.current.store.held_record_with_version(&account, resource, id)?;
                        if held.is_some() {
                            removals.push(Mutation { id: id.clone(), expected_version: version, request_key: format!("{resource}-{request}-{scope}-{id}"), deleted: true, value: serde_json::Value::Null });
                        }
                    }
                    if !removals.is_empty() {
                        self.read.current.store.mutate_many(&account, resource, removals)?;
                    }
                }
                Ok(())
            }
            Some(store) => {
                let generation = original_generation(&self.read.current.store, &account)?.ok_or(crate::cause!(Error::Unavailable))?;
                self.list_homes()?.write(&account, generation, store, |command| command.copy_in(&rows, request)).map(|_| ())
            }
        }
    }

    fn list(&mut self, id: &str) -> Result<(i64, Option<StoredRecord>), Error> {
        let (version, held) = self.read.current.store.held_record_with_version(&self.read.current.account, RESOURCE, id)?;
        Ok((version, held.map(|record| stored_form(id, &record.value)).transpose()?))
    }

    fn keep(&mut self, list: Option<(&StoredRecord, i64)>, index: &lists::Plan, request: &str) -> Result<(), Error> {
        let account = self.read.current.account.clone();
        // A page's pointers in one transaction, then the index, then the list record.
        let pointers = index.pointer_writes(&self.read.current.store, &account, request)?;
        if !pointers.is_empty() {
            self.read.current.store.mutate_many(&account, lists::ROW_HOMES, pointers)?;
        }
        index.write_homes(&mut self.read.current.store, &account, request, || Ok(()))?;
        if let Some((list, version)) = list {
            self.read.current.store.mutate_local_with_check(&account, RESOURCE, Mutation {
                id: list.id.clone(),
                expected_version: version,
                request_key: format!("own-records-{request}-{}", list.id),
                deleted: false,
                value: body(list),
            }, || Ok(()))?;
        }
        Ok(())
    }

    fn now(&self) -> String {
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }
}

/// A record-contract error as the logical reader carries it: the store's own refusal is an invalid stored form, every
/// other failure an unavailable supply.
fn logical_error(error: Error) -> crate::record_value::Error {
    match error {
        Error::Invalid(_, cause) => crate::record_value::Error::Invalid(cause),
        error => crate::record_value::Error::Source(error.cause()),
    }
}

/// Idle upkeep over the same physical stores the logical read uses. Each pass writes at most one existing
/// model-walk page in one store; the next pass discovers the first still-pending scope from current signatures.
impl OwnRead<Supply<sqlite::Handle>> {
    /// The declared orders and totals of each placed list's store filled for the rows it held before they were declared
    /// (`RecordStore::fill_order`, `fill_total`), as the account's own store's are by idle upkeep: an order over a placed
    /// list's kind is read from its store alone (`ordered_any`), and an order not filled there refuses its page. One
    /// bounded step after another while within `longest`; true once every store's orders and totals are filled.
    pub(crate) fn fill_list_store_orders(&mut self, longest: Duration) -> Result<bool, Error> {
        let Some(routes) = self.routes.as_ref().cloned() else { return Ok(true) };
        let started = std::time::Instant::now();
        let settings = read_settings(Some(routes.as_ref()))?;
        let rows = self.current.store.referrers_walk_rows();
        for home in lists::every_home(&self.current.store, &self.current.account)? {
            let account = self.current.account.clone();
            if routes.resources.readers(&home)?.read_with(settings, |store| store.orders_filled(&account, RESOURCE))? {
                continue;
            }
            let writer = routes.resources.writer(&home)?;
            let source = writer.lend(std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)), started + longest + LIST_STORE_WRITE)?;
            let tx = source.begin(crate::storage::sqlite::TransactionBehavior::Immediate)?;
            let mut records = InCommand::lend_with(&tx, &account, InCommand::limits(&tx, writer.path())?, settings)?;
            let mut filled = true;
            for order in settings.orders.iter().map(|declared| declared.order.clone()) {
                while !records.store.fill_order(&account, RESOURCE, &order, rows)? {
                    if started.elapsed() >= longest {
                        filled = false;
                        break;
                    }
                }
            }
            for total in settings.totals.iter().map(|declared| declared.total.clone()) {
                if filled && !records.store.fill_total(&account, RESOURCE, &total, rows)? {
                    filled = false;
                }
            }
            drop(records);
            tx.commit().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            if !filled {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub(crate) fn walk_referrers_step(
        &mut self,
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
        longest: Duration,
    ) -> Result<bool, Error> {
        use std::sync::atomic::Ordering;
        let deadline = std::time::Instant::now() + longest;
        if !self.ready || cancel.load(Ordering::Acquire) {
            return Err(crate::cause!(Error::Unavailable));
        }
        self.assert_route_generation()?;
        let rows = self.current.store.referrers_walk_rows();
        let base = self
            .current
            .store
            .walk_referrers(&self.current.account, RESOURCE, rows)?;
        if base.kind.is_some() {
            return Ok(false);
        }
        let Some(routes) = self.routes.as_ref().cloned() else {
            return Ok(true);
        };
        let installed = routes.referrer_resources()?;
        // Every routed store and every placed list's store walks its own rows.
        let resources: Vec<String> = self.read_resources(installed.clone())?.into_iter().filter(|resource| resource != "@own-records").collect();
        for resource in &resources {
            if cancel.load(Ordering::Acquire) {
                return Err(crate::cause!(Error::Unavailable));
            }
            if std::time::Instant::now() >= deadline {
                return Ok(false);
            }
            let pending = self.read_routed(resource, |view| {
                view.current
                    .store
                    .referrers_pending(&view.current.account, RESOURCE)
            })?;
            if !pending {
                continue;
            }
            self.assert_route_generation()?;
            if routes.referrer_resources()? != installed {
                return Err(crate::cause!(Error::Unavailable));
            }
            let writer = routes
                .resources
                .writer(resource)
                .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            let source = writer
                .lend(cancel.clone(), deadline)
                .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            let tx = source
                .begin(crate::storage::sqlite::TransactionBehavior::Immediate)
                .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            let mut records = InCommand::lend(
                &tx,
                &self.current.account,
                InCommand::limits(&tx, writer.path())?,
            )?;
            if !records.ready()? {
                return Err(crate::cause!(Error::Unavailable));
            }
            records.store.set_referrer_model(
                self.current.store.referrer_parts().to_vec(),
                self.current
                    .store
                    .referrer_value_path()
                    .map(<[String]>::to_vec),
            )?;
            records
                .store
                .walk_referrers_lent(&self.current.account, RESOURCE, rows)?;
            drop(records);
            if cancel.load(Ordering::Acquire) || std::time::Instant::now() >= deadline {
                return Err(crate::cause!(Error::Unavailable));
            }
            self.assert_route_generation()?;
            if routes.referrer_resources()? != installed {
                return Err(crate::cause!(Error::Unavailable));
            }
            tx.commit().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            return Ok(false);
        }
        if routes.referrer_resources()? != installed {
            return Err(crate::cause!(Error::Unavailable));
        }
        self.assert_route_generation()?;
        Ok(true)
    }
}

/// The account's own records are the logical reader's whole supply: stored forms, field keys and live ids, all from
/// record store, through the writer's handle (`OwnRecords`, under the account's admission and snapshot witness) or a reader's
/// (`read_own`, admitted before and after by its caller).
impl<S: Storage> crate::record_value::CurrentKeys for OwnRead<S> {
    fn assert_current(&mut self) -> crate::record_value::Result<()> {
        if self.ready {
            Ok(())
        } else {
            Err(crate::cause!(crate::record_value::Error::Source))
        }
    }
    fn key(&mut self, owner_id: &str) -> crate::record_value::Result<KeyState> {
        OwnRead::key(self, owner_id).map_err(logical_error)
    }
}
impl<S: Storage> crate::record_value::Supply for OwnRead<S> {
    fn record_domain(&self) -> Option<serde_json::Value> {
        self.domain.as_ref().and_then(|domain| serde_json::to_value(domain).ok())
    }
    fn record_generation(&self) -> crate::record_value::Result<Option<i64>> {
        original_generation(&self.current.store, &self.current.account).map_err(logical_error)
    }
    fn qualify_root_identity(&self, id: &str, kind: &str, stamp: &str) -> crate::record_value::Result<String> {
        match &self.domain {
            Some(domain) => domain.root_identity(&self.current.account, id, kind, stamp).map_err(logical_error),
            None => Ok(stamp.to_owned()),
        }
    }
    fn stored(&mut self, id: &str) -> crate::record_value::Result<Option<StoredRecord>> {
        OwnRead::stored(self, id).map_err(logical_error)
    }
}
impl<S: Storage> crate::record_value::history::VersionSupply for OwnRead<S> {
    fn versions(
        &mut self,
        id: &str,
        before_version: Option<i64>,
        limit: usize,
    ) -> crate::record_value::Result<crate::record_value::history::StoredHistory> {
        if !self.ready {
            return Err(crate::cause!(crate::record_value::Error::Source));
        }
        OwnRead::versions(self, id, before_version, limit).map_err(logical_error)
    }
    /// One seek of the own store's versions (`RecordStore::record_at`); a record routed to another store walks that
    /// store's history (the trait's default).
    fn version_at(
        &mut self,
        id: &str,
        at_ms: u64,
    ) -> crate::record_value::Result<crate::record_value::history::VersionAt> {
        if !self.ready {
            return Err(crate::cause!(crate::record_value::Error::Source));
        }
        if self.point_resource(id).map_err(logical_error)?.is_some() {
            let mut before = None;
            let mut oldest: Option<crate::record_value::history::StoredVersion> = None;
            for _ in 0..64 {
                let page = OwnRead::versions(self, id, before, 100).map_err(logical_error)?;
                for held in page.versions {
                    if held.at_ms <= at_ms {
                        return Ok(crate::record_value::history::VersionAt {
                            version: Some(held),
                            complete: true,
                            kept_from_ms: None,
                        });
                    }
                    oldest = Some(held);
                }
                match page.next {
                    Some(next) => before = Some(next),
                    None => {
                        let incomplete = oldest
                            .as_ref()
                            .filter(|first| first.version > 1)
                            .map(|first| first.at_ms);
                        return Ok(crate::record_value::history::VersionAt {
                            version: None,
                            complete: incomplete.is_none(),
                            kept_from_ms: incomplete,
                        });
                    }
                }
            }
            return Ok(crate::record_value::history::VersionAt {
                version: None,
                complete: false,
                kept_from_ms: oldest.map(|first| first.at_ms),
            });
        }
        let at = self
            .current
            .store
            .record_at(&self.current.account, RESOURCE, id, at_ms)
            .map_err(logical_error)?;
        let version = at
            .version
            .map(|held| -> Result<_, Error> {
                Ok(crate::record_value::history::StoredVersion {
                    version: held.version,
                    at_ms: crate::storage::record_store::stamp_ms(held.valid_from),
                    stored: held
                        .value
                        .as_ref()
                        .filter(|_| !held.deleted)
                        .map(|value| stored_form(id, value))
                        .transpose()?,
                })
            })
            .transpose()
            .map_err(logical_error)?;
        Ok(crate::record_value::history::VersionAt {
            version,
            complete: at.complete,
            kept_from_ms: at.kept_from,
        })
    }
}
impl<S: Storage> crate::record_value::CurrentIds for OwnRead<S> {
    fn ids_of_type(
        &mut self,
        record_type: &str,
        before: Option<&str>,
        limit: usize,
    ) -> crate::record_value::Result<(Vec<String>, Option<String>)> {
        let page =
            OwnRead::ids_of_type(self, record_type, "", before, limit).map_err(logical_error)?;
        Ok((page.ids, page.next))
    }
}
/// The generic list read's supply (`record_value::list`): a declared order of the account's own records, either way.
impl<S: Storage> crate::record_value::list::OrderedSupply for OwnRead<S> {
    fn set_model(
        &mut self,
        model: &crate::record_model_policy::Installed,
    ) -> crate::record_value::Result<()> {
        OwnRead::set_model(self, model).map_err(logical_error)
    }
    fn referrers(
        &mut self,
        target: &str,
        role: Option<&str>,
        after: Option<&str>,
        limit: usize,
    ) -> crate::record_value::Result<crate::storage::record_store::Referrers> {
        OwnRead::referrers(self, target, role, after, limit).map_err(logical_error)
    }
    fn settings(&self) -> &'static crate::storage::record_store::settings::Settings {
        self.current.store.settings()
    }
    fn ordered(
        &mut self,
        order: &str,
        cursor: Option<&OrderCursor>,
        reverse: bool,
        limit: usize,
    ) -> crate::record_value::Result<crate::storage::record_store::Ordered> {
        if !self.ready {
            return Err(crate::cause!(crate::record_value::Error::Source));
        }
        self.ordered_any(order, cursor, reverse, limit)
            .map_err(logical_error)
    }
    fn search_ids(&mut self, word: &str, limit: usize) -> crate::record_value::Result<Vec<String>> {
        if !self.ready {
            return Err(crate::cause!(crate::record_value::Error::Source));
        }
        self.search_any(word, limit).map_err(logical_error)
    }
    fn search_pending(&mut self) -> crate::record_value::Result<bool> {
        if !self.ready {
            return Err(crate::cause!(crate::record_value::Error::Source));
        }
        let ready = self
            .current
            .store
            .search_ready(&self.current.account, RESOURCE)
            .map_err(logical_error)?;
        Ok(!ready)
    }
}

/// A kind's typed schema (`storage::kind_views`), folded from the schema history the account's own records keep: what
/// a records read needs to answer a kind as a typed table.
impl<S: Storage> crate::storage::kind_views::KindSchemas for OwnRead<S> {
    fn kind_schema(
        &mut self,
        kind: &str,
    ) -> crate::record_value::Result<Option<crate::storage::kind_views::KindSchema>> {
        if !self.ready {
            return Err(crate::cause!(crate::record_value::Error::Source));
        }
        let schemas = self.all_kind_schemas().map_err(logical_error)?;
        Ok(schemas.get(kind).cloned())
    }
}
impl crate::storage::kind_views::KindSchemas for OwnRecords {
    fn kind_schema(
        &mut self,
        kind: &str,
    ) -> crate::record_value::Result<Option<crate::storage::kind_views::KindSchema>> {
        crate::storage::kind_views::KindSchemas::kind_schema(&mut self.read, kind)
    }
}

/// The writer's handle reads as its `OwnRead`.
impl std::ops::Deref for OwnRecords {
    type Target = OwnRead<Supply<sqlite::Handle>>;
    fn deref(&self) -> &Self::Target {
        &self.read
    }
}
impl std::ops::DerefMut for OwnRecords {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.read
    }
}
impl crate::record_value::CurrentKeys for OwnRecords {
    fn assert_current(&mut self) -> crate::record_value::Result<()> {
        crate::record_value::CurrentKeys::assert_current(&mut self.read)
    }
    fn key(&mut self, owner_id: &str) -> crate::record_value::Result<KeyState> {
        crate::record_value::CurrentKeys::key(&mut self.read, owner_id)
    }
}
impl crate::record_value::Supply for OwnRecords {
    fn stored(&mut self, id: &str) -> crate::record_value::Result<Option<StoredRecord>> {
        crate::record_value::Supply::stored(&mut self.read, id)
    }
}
impl crate::record_value::history::VersionSupply for OwnRecords {
    fn versions(
        &mut self,
        id: &str,
        before_version: Option<i64>,
        limit: usize,
    ) -> crate::record_value::Result<crate::record_value::history::StoredHistory> {
        crate::record_value::history::VersionSupply::versions(
            &mut self.read,
            id,
            before_version,
            limit,
        )
    }
    fn version_at(
        &mut self,
        id: &str,
        at_ms: u64,
    ) -> crate::record_value::Result<crate::record_value::history::VersionAt> {
        crate::record_value::history::VersionSupply::version_at(&mut self.read, id, at_ms)
    }
}
impl crate::record_value::CurrentIds for OwnRecords {
    fn ids_of_type(
        &mut self,
        record_type: &str,
        before: Option<&str>,
        limit: usize,
    ) -> crate::record_value::Result<(Vec<String>, Option<String>)> {
        crate::record_value::CurrentIds::ids_of_type(&mut self.read, record_type, before, limit)
    }
}
impl crate::record_value::list::OrderedSupply for OwnRecords {
    fn set_model(
        &mut self,
        model: &crate::record_model_policy::Installed,
    ) -> crate::record_value::Result<()> {
        crate::record_value::list::OrderedSupply::set_model(&mut self.read, model)
    }
    fn referrers(
        &mut self,
        target: &str,
        role: Option<&str>,
        after: Option<&str>,
        limit: usize,
    ) -> crate::record_value::Result<crate::storage::record_store::Referrers> {
        crate::record_value::list::OrderedSupply::referrers(
            &mut self.read,
            target,
            role,
            after,
            limit,
        )
    }
    fn settings(&self) -> &'static crate::storage::record_store::settings::Settings {
        crate::record_value::list::OrderedSupply::settings(&self.read)
    }
    fn ordered(
        &mut self,
        order: &str,
        cursor: Option<&OrderCursor>,
        reverse: bool,
        limit: usize,
    ) -> crate::record_value::Result<crate::storage::record_store::Ordered> {
        crate::record_value::list::OrderedSupply::ordered(
            &mut self.read,
            order,
            cursor,
            reverse,
            limit,
        )
    }
    fn search_ids(&mut self, word: &str, limit: usize) -> crate::record_value::Result<Vec<String>> {
        crate::record_value::list::OrderedSupply::search_ids(&mut self.read, word, limit)
    }
    fn search_pending(&mut self) -> crate::record_value::Result<bool> {
        crate::record_value::list::OrderedSupply::search_pending(&mut self.read)
    }
}

/// The physical read limits of the old-store snapshot the migration and the journal follow read through: whole
/// checkpoint pages and the canonical reader at its largest allowance.
fn migration_read_limits() -> crate::import::ReadLimits {
    crate::import::ReadLimits {
        rows: 4096,
        cell_bytes: 8 * 1024 * 1024,
        result_bytes: 32 * 1024 * 1024,
        // A bounded seek across 64 kept runs builds one recursive CTE per run.
        // The copied account's 48-run statement is 93,912 bytes, above the
        // generic reader's 64 KiB SQL ceiling. The read adapter validates this
        // 256 KiB ceiling and still accepts only one readonly statement.
        sql_bytes: 256 * 1024,
        vm_steps: 50_000_000,
        elapsed: Duration::from_secs(30),
        ..crate::import::ReadLimits::default()
    }
}

/// The old-store snapshot opened under the account's current browser session check and file witness.
pub(super) type Snapshot<'w> =
    crate::record_source::SnapshotRecordSql<super::WorkspaceReadWitness<'w>>;

/// How long a read may spend finishing a small migration itself before it refuses as not ready yet. A store this
/// finishes in a few steps (a new or small account) answers at once; a large one is finished by the startup task.
const READ_MIGRATION_TIME: Duration = Duration::from_secs(1);

impl super::LocalAccount {
    fn configure_own_work_reads(&mut self, held: &mut OwnRecords) -> Result<(), Error> {
        let model = crate::record_model_policy::installed(&self.source.selected.root)
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        held.set_model(&model)?;
        if !held.ready() {
            return Ok(());
        }
        let owner = self.source.account.owner_id.clone();
        let state = self.source.selected.root.clone();
        let meter = self.source.sql_work.clone();
        let Some(generation) = held.resource_generation()? else {
            // Older fixture/source stores without a migrated identity header
            // have no legal own-work generation to route through yet.
            held.read.routes = None;
            return Ok(());
        };
        held.configure_work_reads(&state, &owner, generation, meter)
    }

    fn checked_work_read<T>(
        &mut self,
        held: &OwnRecords,
        answer: Result<T, Error>,
    ) -> Result<T, Error> {
        let expected = held
            .read
            .routes
            .as_ref()
            .map(|routes| routes.generation.clone());
        let answer = answer?;
        if let Some(expected) = expected {
            if held
                .resource_generation()?
                .map(|generation| generation.to_string())
                .as_deref()
                != Some(expected.as_str())
            {
                return Err(crate::cause!(Error::Unavailable));
            }
        }
        Ok(answer)
    }

    /// The held own-records store of the selected source, opened on first use;
    /// the caller admits the read and puts the store back in `own_records`.
    pub(crate) fn take_own_records(&mut self) -> Result<OwnRecords, Error> {
        let source_identity = self.source.state_identity().to_owned();
        if let Some(held) = self.own_records.take() {
            if held.source_identity == source_identity {
                return Ok(held);
            }
        }
        let path = self
            .source
            .record_book_path
            .clone()
            .ok_or(crate::cause!(Error::Unavailable))?;
        OwnRecords::open(
            &path,
            &self.source.account.owner_id,
            &source_identity,
            self.source.sql_work.clone(),
        )
    }
    pub(crate) fn put_own_records(&mut self, held: OwnRecords) {
        self.own_records = Some(held);
    }
    /// The selected account's base reader and the current verified own-work route context for one admitted logical
    /// read. The caller keeps this context with its snapshot and uses the same route identity at the final key check.
    pub(crate) fn own_read_context(
        &mut self,
    ) -> Result<
        (
            std::sync::Arc<crate::storage::record_store_resources::Readers>,
            Option<OwnReadRoutes>,
        ),
        Error,
    > {
        let mut held = self.take_own_records()?;
        self.configure_own_work_reads(&mut held)?;
        let context = (held.readers.clone(), held.read.routes.clone());
        self.put_own_records(held);
        Ok(context)
    }
    /// The kept read-write handle of the selected source's own records file that the account's commands borrow
    /// (`record_store_resources::Writer::lend`). It opens no store: a command before the own records exist writes nothing.
    pub(crate) fn own_writer(
        &mut self,
    ) -> Result<std::sync::Arc<crate::storage::record_store_resources::Writer>, Error> {
        let path = self
            .source
            .record_book_path
            .clone()
            .ok_or(crate::cause!(Error::Unavailable))?;
        if let Some(writer) = self.writer.as_ref().filter(|writer| writer.path() == path) {
            return Ok(writer.clone());
        }
        // Requests share the physical writer's retained connection/search cache,
        // not a mutable account hold. Its lend operation releases the cache mutex
        // before any connection is opened or any transaction runs.
        let writer = self.shared_primary_writer()?;
        self.writer = Some(writer.clone());
        Ok(writer)
    }

    /// Open the account's own-records store on first use, only after current
    /// browser admission and the existing readonly source witness are held.
    /// The later migration/read step retains its separate fresh snapshot.
    fn own_records_held(
        &mut self,
        session_id: &str,
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<OwnRecords, Error> {
        if cancel.load(std::sync::atomic::Ordering::Acquire) {
            return Err(crate::cause!(Error::Unavailable));
        }
        let source_identity = self.source.state_identity().to_owned();
        if let Some(held) = self.own_records.take() {
            if held.source_identity == source_identity {
                return Ok(held);
            }
            // A newly selected restore cannot use the prior source's cached
            // record store cursor or physical handle, even when the pathname matches.
        }
        let path = self
            .source
            .record_book_path
            .clone()
            .ok_or(crate::cause!(Error::Unavailable))?;
        let owner_id = self.source.account.owner_id.clone();
        let meter = self.source.sql_work.clone();
        let admitted = observed_open(
            OpenStage::BrowserAdmission,
            crate::account::current_browser(self, session_id).map_err(|error| Error::Unavailable(error.cause())),
        )?;
        let source = observed_open(
            OpenStage::SourceWitness,
            self.current_record_source_limited(
                session_id,
                path.clone(),
                admitted,
                migration_read_limits(),
                cancel,
            )
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error)),
        )?;
        let held = OwnRecords::open(&path, &owner_id, &source_identity, meter);
        observed_open(
            OpenStage::SourceFinish,
            source.finish().map_err(|error| crate::carry_cause!(Error::Unavailable, error)),
        )?;
        held
    }

    /// Run `step` on the account's own records with the old-store snapshot opened under the current browser
    /// session check and file witness; the snapshot is finished (a fresh witness check) before the answer escapes, so a
    /// late revocation, replacement or cancellation withholds even a completed read.
    fn with_snapshot<T>(
        &mut self,
        session_id: &str,
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
        held: &mut OwnRecords,
        step: impl for<'w> FnOnce(&mut OwnRecords, Snapshot<'w>) -> Result<(T, Snapshot<'w>), Error>,
    ) -> Result<T, Error> {
        if cancel.load(std::sync::atomic::Ordering::Acquire) {
            return Err(crate::cause!(Error::Unavailable));
        }
        let path = self
            .source
            .record_book_path
            .clone()
            .ok_or(crate::cause!(Error::Unavailable))?;
        let admitted = crate::account::current_browser(self, session_id).map_err(|error| Error::Unavailable(error.cause()))?;
        let source = self
            .current_record_source_limited(
                session_id,
                path,
                admitted,
                migration_read_limits(),
                cancel,
            )
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let (answer, source) = step(held, source)?;
        if std::mem::take(&mut held.read_unused) {
            // Dropping an unfinished snapshot closes and rolls back its read; nothing the step kept came from it.
            drop(source);
            return Ok(answer);
        }
        source.finish().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok(answer)
    }

    /// One bounded migration step (startup preparation). Answers what it did.
    pub fn own_records_step(
        &mut self,
        session_id: &str,
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<Step, Error> {
        let mut held = self.own_records_held(session_id, cancel.clone())?;
        let answer = self.with_snapshot(session_id, cancel, &mut held, |records, source| {
            records.step(source)
        });
        self.own_records = Some(held);
        answer
    }

    /// Read the account's own records with `read`, inside one
    /// admitted snapshot, which `read` may use (the key owner reads field keys through it) and hands back to be
    /// finished. A store not migrated yet first takes migration steps for at most `READ_MIGRATION_TIME`.
    pub(super) fn with_own_records_source<T>(
        &mut self,
        session_id: &str,
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
        read: impl for<'w> FnOnce(&mut OwnRecords, Snapshot<'w>) -> Result<(T, Snapshot<'w>), Error>,
    ) -> Result<T, Error> {
        let mut held = self.own_records_held(session_id, cancel.clone())?;
        let started = std::time::Instant::now();
        let mut answer = Ok(());
        while !held.ready() && started.elapsed() < READ_MIGRATION_TIME && answer.is_ok() {
            answer =
                self.with_snapshot(session_id, cancel.clone(), &mut held, |records, source| {
                    records.step(source).map(|(_, source)| ((), source))
                });
        }
        let answer = answer.and_then(|()| {
            crate::account::current_browser(self, session_id).map_err(|error| Error::Unavailable(error.cause()))?;
            self.configure_own_work_reads(&mut held)?;
            self.with_snapshot(session_id, cancel, &mut held, read)
        });
        let answer = self.checked_work_read(&held, answer);
        self.own_records = Some(held);
        answer
    }

    /// `with_own_records_source` for a read that needs only the record store records. Once the migration is finished the old
    /// store's records are never read again, so such a read opens no old-store snapshot: it is admitted with the
    /// current browser session before it runs and again before its answer escapes (a late revocation withholds even a
    /// completed read, as the snapshot's finish did). Until then it runs the migration's steps first.
    pub(crate) fn with_own_records<T>(
        &mut self,
        session_id: &str,
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
        read: impl FnOnce(&mut OwnRecords) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let mut held = self.own_records_held(session_id, cancel.clone())?;
        if !held.ready() {
            self.own_records = Some(held);
            return self.with_own_records_source(session_id, cancel, |records, source| {
                Ok((read(records)?, source))
            });
        }
        let answer = (|| {
            if cancel.load(std::sync::atomic::Ordering::Acquire) {
                return Err(crate::cause!(Error::Unavailable));
            }
            crate::account::current_browser(self, session_id).map_err(|error| Error::Unavailable(error.cause()))?;
            self.configure_own_work_reads(&mut held)?;
            let answer = read(&mut held);
            let answer = self.checked_work_read(&held, answer)?;
            crate::account::current_browser_read_only(self, session_id).map_err(|error| Error::Unavailable(error.cause()))?;
            Ok(answer)
        })();
        self.own_records = Some(held);
        answer
    }
}

#[cfg(test)]
mod routed_read_tests {
    use super::*;
    use crate::{
        records::Mutation,
        storage::record_store_resources::{self, StateResources},
    };

    /// Old trillion placed-lists.mjs:10-41 binds one transaction's records to
    /// their selected home; record-log-store.mjs:1198 keeps required parts in
    /// that write. Exercise the actual native owner rather than a parallel
    /// RecordStore-only implementation, with one body for unlike supplies.
    #[test]
    fn native_command_closure_uses_the_same_storage_contract_on_unlike_supplies() {
        use crate::storage::{Intent, Scope};
        let memory = crate::storage::memory::Memory::open(SCHEMA).unwrap();
        let disk = tempfile::tempdir().unwrap();
        let path = disk.path().canonicalize().unwrap().join("native-command-contract");
        let open_memory = || Box::new(memory.reopen()) as Box<dyn Storage>;
        let open_disk = || Box::new(crate::storage::sqlite::open_owned(
            &path, SCHEMA, crate::storage::sqlite::Bounds {
                value_bytes: 1 << 20,
                work: u64::MAX / 2,
                deadline: Duration::MAX,
                spend: crate::storage::sqlite::Spend::EachOperation,
                cancel: None,
                busy: Duration::from_millis(50),
            },
        ).unwrap()) as Box<dyn Storage>;
        for open in [&open_memory as &dyn Fn() -> Box<dyn Storage>, &open_disk] {
            let limits = Limits::fixed(1 << 20, 128 << 20);
            let model = crate::record_model_policy::Installed::from_rows(
                &[serde_json::json!({"record_model":{"kinds":[{
                    "type":"fixture-holder", "parts":[{"role":"source", "path":["target"]}]
                }]}})], true,
            ).unwrap();
            let owner = "synthetic-native-supply";
            let key = [53u8; 32];
            let form = typed_record("holder", "fixture-holder",
                r#"{"target":"source:one","words":"first"}"#, "1");
            let forms = BTreeMap::from([("holder".into(), Some(form.clone()))]);

            let supply = open();
            assert!(InCommand::from_storage(&*supply, owner, limits, shipped_settings().unwrap()).is_err(),
                "a native lend cannot create its own transaction");
            {
                let read = Scope::current_read(&*supply).unwrap();
                assert!(InCommand::from_storage(&*read, owner, limits, shipped_settings().unwrap()).is_err(),
                    "a read snapshot cannot authorize effects");
            }
            {
                let transaction = Scope::begin(&*supply, Intent::Write).unwrap();
                let mut records = InCommand::from_storage(&*transaction, owner, limits, shipped_settings().unwrap()).unwrap();
                records.install_new_work_resource(1).unwrap();
                records.set_model(&model).unwrap();
                records.prepare_referrers().unwrap();
                drop(records);
                transaction.commit().unwrap();
            }
            for commit in [false, true] {
                let transaction = Scope::begin(&*supply, Intent::Write).unwrap();
                let mut records = InCommand::from_storage(&*transaction, owner, limits, shipped_settings().unwrap()).unwrap();
                records.set_model(&model).unwrap();
                records.prepare_referrers().unwrap();
                assert_eq!(records.write(&forms, &[("holder", &key)], "effect", || Ok(())).unwrap(), 2);
                records.put_command("receipt", 0, serde_json::json!({"effect":"holder","result":"first"}), || Ok(())).unwrap();
                assert!(matches!(records.put_command("receipt", 0,
                    serde_json::json!({"effect":"different"}), || Ok(())), Err(Error::Conflict(_))),
                    "same expected receipt version has at most one successor");
                assert_eq!(records.stored("holder").unwrap().unwrap().value_json, form.value_json);
                assert!(matches!(records.key("holder").unwrap(), KeyState::Present(_)));
                assert_eq!(records.command("receipt").unwrap().0, 1);
                assert_eq!(records.store.referrers_of(owner, RESOURCE, "source:one", Some("source"), None, Some(10))
                    .unwrap().referrers.len(), 1);
                drop(records);
                if commit { transaction.commit().unwrap(); } else { transaction.rollback().unwrap(); }

                let observer = open();
                let fresh = Scope::current_read(&*observer).unwrap();
                let view = RecordStore::new(&*fresh, Box::new(RealClock), limits).unwrap();
                for (resource, id) in [(RESOURCE, "holder"), (KEYS, "holder"), (COMMANDS, "receipt")] {
                    assert_eq!(view.held_record_with_version(owner, resource, id).unwrap().1.is_some(), commit,
                        "effect, key and receipt share the outer commit outcome");
                }
            }
            let transaction = Scope::begin(&*supply, Intent::Write).unwrap();
            let mut records = InCommand::from_storage(&*transaction, owner, limits, shipped_settings().unwrap()).unwrap();
            records.set_model(&model).unwrap();
            assert_eq!(records.write(&forms, &[], "effect", || Ok(())).unwrap(), 0,
                "recovering the exact effect does not create a new version");
            assert_eq!(records.command("receipt").unwrap().1.unwrap()["result"], "first");
            assert!(matches!(records.write(&BTreeMap::from([("holder".into(), None)]), &[], "revoked",
                || Err(crate::cause!(Error::Unavailable))), Err(Error::Unavailable(_))));
            assert!(records.stored("holder").unwrap().is_some(), "failed current-rights check leaves the effect intact");
            drop(records);
            transaction.commit().unwrap();
        }
    }

    fn record(id: &str, value: &str, sequence: &str) -> StoredRecord {
        StoredRecord {
            id: id.into(),
            record_type: "note".into(),
            sequence: sequence.into(),
            value_json: value.into(),
            meta_json: None,
            protected_key_present: false,
        }
    }

    fn typed_record(id: &str, record_type: &str, value: &str, sequence: &str) -> StoredRecord {
        StoredRecord {
            id: id.into(),
            record_type: record_type.into(),
            sequence: sequence.into(),
            value_json: value.into(),
            meta_json: None,
            protected_key_present: false,
        }
    }

    fn schema_record(id: &str, sequence: &str, stored: &str) -> StoredRecord {
        typed_record(
            id,
            crate::storage::kind_views::SCHEMA_KIND,
            stored,
            sequence,
        )
    }

    fn put_record(
        store: &mut RecordStore<Supply<crate::storage::sqlite::Handle>>,
        owner: &str,
        id: &str,
        stored: &StoredRecord,
    ) {
        let version = store
            .held_record_with_version(owner, RESOURCE, id)
            .unwrap()
            .0;
        store
            .mutate(
                owner,
                RESOURCE,
                Mutation {
                    id: id.into(),
                    expected_version: version,
                    request_key: format!("routed-read-{id}-{version}"),
                    deleted: false,
                    value: body(stored),
                },
            )
            .unwrap();
    }

    fn request(
        owner: &str,
        ids: &[&str],
        group: &str,
    ) -> crate::local_account::resource_affinity::ResolveRequest {
        crate::local_account::resource_affinity::ResolveRequest {
            owner: owner.into(),
            generation: "1".into(),
            identities: ids
                .iter()
                .map(|id| crate::local_account::resource_affinity::Identity {
                    kind: "own-record".into(),
                    id: (*id).into(),
                })
                .collect(),
            group: Some(group.into()),
        }
    }

    /// Old trillion record-log-store.mjs:1198 keeps parts in the same write; the native boundary must read
    /// paths through exact stored JSON and preserve the enclosing transaction's retry and rollback ownership.
    /// A tool's joined order (`with_joined_orders`) is the one the account's writer and readers open with: the writer keeps
    /// its ordered rows as it writes them, idle upkeep fills the order from the rows written before, and a read through the
    /// same settings answers the order's rows without a row walk. The shipped settings do not declare the order at all.
    #[test]
    fn a_joined_order_is_written_filled_and_read_through_the_account_settings() {
        let settings = crate::storage::record_store::settings::with_joined_orders(&serde_json::json!([{
            "_why": "the ai-job tool's status order (test)", "order": "ai-job/status", "kind": "ai-job", "path": ["stored", "status"]
        }]))
        .unwrap();
        let state = tempfile::tempdir().unwrap();
        let meter = crate::sqlite_work::WorkMeter::new();
        let resources = StateResources::new(state.path(), meter.clone()).unwrap();
        let writer = resources.writer("@test-db/joined-order").unwrap();
        let mut store = record_store_resources::open(writer.path(), meter).unwrap();
        OwnRecords::initialize_new_work_store(&mut store, "owner", 1).unwrap();
        drop(store);
        let limits = |tx: &crate::storage::sqlite::Transaction<'_>| InCommand::limits(tx, writer.path()).unwrap();
        let source = writer
            .lend(
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                std::time::Instant::now() + Duration::from_secs(30),
            )
            .unwrap();
        let tx = source.begin(crate::storage::sqlite::TransactionBehavior::Immediate).unwrap();
        {
            let mut records = InCommand::lend_with(&tx, "owner", limits(&tx), settings).unwrap();
            records.prepare_referrers().unwrap();
            for n in 0..40 {
                let status = if n % 4 == 0 { "waiting" } else { "done" };
                let job = typed_record(&format!("job:{n:02}"), "ai-job", &serde_json::json!({"status": status}).to_string(), "2026-11-12T00:00:00Z");
                let forms = BTreeMap::from([(format!("job:{n:02}"), Some(job))]);
                assert_eq!(records.write(&forms, &[], "same-write", || Ok(())).unwrap(), 1);
            }
            // Before the fill the order answers nothing: its rows are not kept yet, so the ordered read refuses.
            assert!(records.store.ordered_page("owner", RESOURCE, "ai-job/status", None, true, 10).is_err());
            let mut passes = 0;
            while !records.store.fill_order("owner", RESOURCE, "ai-job/status", 16).unwrap() {
                passes += 1;
                assert!(passes < 100, "the order fills in bounded passes");
            }
        }
        tx.commit().unwrap();
        drop(source);
        let readers = resources.readers("@test-db/joined-order").unwrap();
        // The order is read by its values, greatest first, a page of 10 at a time: "waiting" sorts above "done", so the
        // first page is exactly the ten waiting jobs and the next pages are the forty done ones. A row walk by id would
        // not put the waiting jobs first.
        let page = |after: Option<crate::storage::record_store::OrderCursor>| {
            readers
                .read_with(settings, |store| {
                    store.ordered_page("owner", RESOURCE, "ai-job/status", after.as_ref(), true, 10).map_err(Error::from)
                })
                .unwrap()
        };
        let statuses = |answer: &crate::storage::record_store::Ordered| -> Vec<String> {
            answer.records.iter().map(|record| record.value.to_string()).collect()
        };
        let first = page(None);
        assert_eq!(first.records.len(), 10, "one page of the order is ten rows");
        assert!(statuses(&first).iter().all(|value| value.contains("waiting")), "{:?}", statuses(&first));
        let second = page(first.next.clone());
        assert!(statuses(&second).iter().all(|value| value.contains("done")), "the cursor moves past the waiting jobs: {:?}", statuses(&second));
        let third = page(second.next.clone());
        assert_eq!(third.records.len(), 10, "the cursor keeps paging");
        assert!(third.next.is_some(), "the order continues past the third page");
        let shipped = readers.read(|store| store.ordered_page("owner", RESOURCE, "ai-job/status", None, true, 10).map_err(Error::from));
        assert!(shipped.is_err(), "the shipped settings do not declare the tool's order");
    }

    /// A bounded read (`read_bounded_with`) takes the one physical read's budget: a deadline already passed, or a cancel
    /// already raised, refuses before the store opens; a live budget answers.
    #[test]
    fn a_bounded_read_refuses_past_its_deadline_or_cancel_and_answers_inside_its_budget() {
        let state = tempfile::tempdir().unwrap();
        let meter = crate::sqlite_work::WorkMeter::new();
        let resources = StateResources::new(state.path(), meter.clone()).unwrap();
        let writer = resources.writer("@test-db/bounded-read").unwrap();
        let mut store = record_store_resources::open(writer.path(), meter).unwrap();
        OwnRecords::initialize_new_work_store(&mut store, "owner", 1).unwrap();
        drop(store);
        let readers = resources.readers("@test-db/bounded-read").unwrap();
        let settings = shipped_settings().unwrap();
        let clear = || std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let answer = |until: std::time::Instant, cancel| {
            readers.read_bounded_with::<_, crate::records::Error>(settings, cancel, until, |store| {
                Ok(store.current_record("owner", RESOURCE, "missing")?.is_none())
            })
        };
        assert!(answer(std::time::Instant::now(), clear()).is_err(), "a passed deadline refuses");
        let raised = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        assert!(answer(std::time::Instant::now() + Duration::from_secs(30), raised).is_err(), "a raised cancel refuses");
        assert!(answer(std::time::Instant::now() + Duration::from_secs(30), clear()).unwrap(), "a live budget answers");
    }

    /// The readers pool gives a read beside a held walk its own snapshot (`Readers::take` pops an idle handle or opens one):
    /// a read made while a bounded walk holds its handle answers inside that hold, so no call waits for a walk's whole length.
    #[test]
    fn a_read_beside_a_held_walk_answers_inside_the_hold() {
        let state = tempfile::tempdir().unwrap();
        let meter = crate::sqlite_work::WorkMeter::new();
        let resources = StateResources::new(state.path(), meter.clone()).unwrap();
        let writer = resources.writer("@test-db/held-walk").unwrap();
        let mut store = record_store_resources::open(writer.path(), meter).unwrap();
        OwnRecords::initialize_new_work_store(&mut store, "owner", 1).unwrap();
        drop(store);
        // The rows are written in committed chunks of 100, one command each.
        for chunk in (0..1_101).collect::<Vec<usize>>().chunks(100) {
            let source = writer
                .lend(
                    std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    std::time::Instant::now() + Duration::from_secs(30),
                )
                .unwrap();
            let tx = source.begin(crate::storage::sqlite::TransactionBehavior::Immediate).unwrap();
            {
                let mut records = InCommand::lend(&tx, "owner", InCommand::limits(&tx, writer.path()).unwrap()).unwrap();
                records.prepare_referrers().unwrap();
                for &n in chunk {
                    let job = typed_record(&format!("job:{n:04}"), "ai-job", "{\"status\":\"done\"}", "2026-11-12T00:00:00Z");
                    let forms = BTreeMap::from([(format!("job:{n:04}"), Some(job))]);
                    assert_eq!(records.write(&forms, &[], "same-write", || Ok(())).unwrap(), 1);
                }
            }
            tx.commit().unwrap();
            drop(source);
        }
        let readers = resources.readers("@test-db/held-walk").unwrap();
        let beside = readers
            .read::<_, crate::records::Error>(|walk| {
                let (ids, _) = walk.ids_of_kind("owner", RESOURCE, "ai-job", None, 1_000)?;
                assert_eq!(ids.len(), 1_000, "one bounded slice of the walk");
                readers.read::<_, crate::records::Error>(|store| {
                    Ok(store.current_record("owner", RESOURCE, "job:0100")?.is_some())
                })
            })
            .unwrap();
        assert!(beside, "a read beside the held walk answers the record it asks for");
    }

    #[test]
    fn installed_parts_index_the_native_command_write_and_rollback_together() {
        let state = tempfile::tempdir().unwrap();
        let model = crate::record_model_policy::Installed::from_rows(
            &[serde_json::json!({"record_model": {"kinds": [{
            "type": "fixture-holder", "parts": [
                {"role":"named", "path":["targets"], "role_from":["as"]},
                {"role":"source", "path":["refs"], "each":["ref"], "role_from":["role"]}
            ]}]}})],
            true,
        )
        .unwrap();
        let meter = crate::sqlite_work::WorkMeter::new();
        let resources = StateResources::new(state.path(), meter.clone()).unwrap();
        let writer = resources.writer("@test-db/index-model").unwrap();
        let mut store = record_store_resources::open(writer.path(), meter).unwrap();
        OwnRecords::initialize_new_work_store(&mut store, "owner", 1).unwrap();
        drop(store);
        let form = typed_record("holder", "fixture-holder", &serde_json::json!({
            "targets":["source:one"], "as":"consulted", "refs":[{"ref":"source:two", "role":"counterexample"}],
            "actor":{"basis":"unknown"}
        }).to_string(), "2026-11-07T00:00:00Z");
        for commit in [false, true] {
            let source = writer
                .lend(
                    std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    std::time::Instant::now() + Duration::from_secs(30),
                )
                .unwrap();
            let tx = source
                .begin(crate::storage::sqlite::TransactionBehavior::Immediate)
                .unwrap();
            let mut records =
                InCommand::lend(&tx, "owner", InCommand::limits(&tx, writer.path()).unwrap())
                    .unwrap();
            records.set_model(&model).unwrap();
            records.prepare_referrers().unwrap();
            let schema = crate::storage::sqlite::schema_version(&tx).unwrap();
            let forms = BTreeMap::from([("holder".into(), Some(form.clone()))]);
            assert_eq!(
                records.write(&forms, &[], "same-write", || Ok(())).unwrap(),
                1
            );
            let indexed = records
                .store
                .referrers_of(
                    "owner",
                    RESOURCE,
                    "source:one",
                    Some("consulted"),
                    None,
                    Some(1),
                )
                .unwrap();
            assert!(indexed.complete);
            assert_eq!(
                indexed
                    .referrers
                    .iter()
                    .map(|holder| holder.id.as_str())
                    .collect::<Vec<_>>(),
                ["holder"]
            );
            assert_eq!(
                records.write(&forms, &[], "same-write", || Ok(())).unwrap(),
                0,
                "exact retry writes no version or index keys"
            );
            assert_eq!(crate::storage::sqlite::schema_version(&tx).unwrap(),schema,
                "same-write participation preserves the schema witness taken after declared preparation");
            drop(records);
            if commit {
                tx.commit().unwrap();
            } else {
                drop(tx);
            }
            drop(source);
            let readers = resources.readers("@test-db/index-model").unwrap();
            let result = read_own_with_keys::<_, Error>(&readers, "owner", None, |view| {
                view.set_model(&model)?;
                let before = view.stamp()?;
                let page = view.referrers("source:two", Some("counterexample"), None, 1)?;
                assert_eq!(view.stamp()?, before, "reverse inspection is read-only");
                Ok(page)
            })
            .unwrap()
            .0;
            assert_eq!(result.referrers.len(), usize::from(commit));
        }
    }

    #[test]
    fn corrupt_native_envelopes_refuse_referrer_writes_and_cannot_complete_backfill() {
        let state = tempfile::tempdir().unwrap();
        let path = state
            .path()
            .canonicalize()
            .unwrap()
            .join("corrupt-index.sqlite");
        let mut store =
            record_store_resources::open(&path, crate::sqlite_work::WorkMeter::new()).unwrap();
        let model = crate::record_model_policy::Installed::from_rows(
            &[serde_json::json!({"record_model":{"kinds":[{
                "type":"fixture-holder","parts":[{"role":"named","path":["target"]}]
            }]}})],
            true,
        )
        .unwrap();
        store
            .set_referrer_model(model.referrer_parts().to_vec(), Some(vec!["stored".into()]))
            .unwrap();
        let malformed = Mutation {
            id: "broken".into(),
            expected_version: 0,
            request_key: "corrupt".into(),
            deleted: false,
            value: serde_json::json!({"kind":"fixture-holder","stored":"{"}),
        };
        assert_eq!(
            store
                .mutate("owner", RESOURCE, malformed.clone())
                .unwrap_err(),
            crate::cause!(Error::Unavailable)
        );
        assert_eq!(
            store.held_version("owner", RESOURCE, "broken").unwrap(),
            0,
            "invalid indexed write rolls back"
        );
        store.set_referrer_parts(Vec::new()).unwrap();
        store.mutate("owner", RESOURCE, malformed).unwrap();
        store
            .set_referrer_model(model.referrer_parts().to_vec(), Some(vec!["stored".into()]))
            .unwrap();
        assert!(store.referrers_pending("owner", RESOURCE).unwrap());
        assert_eq!(
            store.walk_referrers("owner", RESOURCE, 1).unwrap_err(),
            crate::cause!(Error::Unavailable)
        );
        assert!(
            !store
                .referrers_of("owner", RESOURCE, "source:unknown", None, None, Some(1))
                .unwrap()
                .complete,
            "a corrupt source never becomes an empty completed model walk"
        );
    }

    #[test]
    fn routed_referrer_pages_do_not_skip_holders_after_an_empty_budget_page() {
        let state = tempfile::tempdir().unwrap();
        let owner = "owner";
        let meter = crate::sqlite_work::WorkMeter::new();
        let model = crate::record_model_policy::Installed::from_rows(
            &[serde_json::json!({"record_model": {"kinds": [{
                "type":"note", "parts":[{"role":"named", "path":["target"], "role_from":["as"]}]
            }]}})],
            true,
        )
        .unwrap();
        let path = state.path().canonicalize().unwrap().join("base.sqlite");
        drop(crate::storage::sqlite::Connection::open(&path).unwrap());
        let mut base = record_store_resources::open(&path, meter.clone()).unwrap();
        OwnRecords::initialize_new_work_store(&mut base, owner, 1).unwrap();
        base.set_referrer_model(model.referrer_parts().to_vec(), Some(vec!["stored".into()]))
            .unwrap();
        for index in 0..260 {
            let id = format!("a{index:04}");
            put_record(
                &mut base,
                owner,
                &id,
                &record(
                    &id,
                    "{\"target\":\"source:target\",\"as\":\"other\"}",
                    "001",
                ),
            );
        }
        put_record(
            &mut base,
            owner,
            "z-base",
            &record(
                "z-base",
                "{\"target\":\"source:target\",\"as\":\"wanted\"}",
                "001",
            ),
        );
        let directory = crate::local_account::resource_affinity::store::AffinityDirectory::new(
            state.path(),
            meter.clone(),
            owner,
            "1",
        )
        .unwrap();
        for (id, group) in [("a0010-routed", "first"), ("a0300-routed", "second")] {
            let route = directory
                .install_and_resolve(&request(owner, &[id], group), || Ok(()))
                .unwrap();
            let (_, mut store) = record_store_resources::open_state_resource(
                &route.resource,
                state.path(),
                meter.clone(),
            )
            .unwrap();
            store
                .set_referrer_model(model.referrer_parts().to_vec(), Some(vec!["stored".into()]))
                .unwrap();
            put_record(
                &mut store,
                owner,
                id,
                &record(
                    id,
                    "{\"target\":\"source:target\",\"as\":\"wanted\"}",
                    "001",
                ),
            );
        }
        let routes = std::sync::Arc::new(OwnWorkReadRoutes {
            state: state.path().canonicalize().unwrap(),
            owner: owner.into(),
            generation: "1".into(),
            meter: meter.clone(),
            resources: std::sync::Arc::new(StateResources::new(state.path(), meter).unwrap()),
        });
        let mut read = OwnRead {
            domain: None,
            current: RecordStoreCurrent::new(base, owner, RESOURCE),
            ready: true,
            key_reads: None,
            key_resource: RESOURCE.into(),
            routed_records: BTreeMap::new(),
            books: None,
            routes: Some(routes),
        };
        // A changed adapter/model uses the original persisted walk. Old rows in a routed target remain honest
        // (`complete:false`) until idle upkeep walks that store; a read never builds the index itself.
        let new_model = crate::record_model_policy::Installed::from_rows(&[serde_json::json!({"record_model":{"kinds":[{
            "type":"note","parts":[{"role":"named","path":["target"],"role_from":["as"],"absolute_prefix":"source:"}]
        }]}})],true).unwrap();
        read.set_model(&new_model).unwrap();
        assert!(
            !read
                .referrers("source:target", Some("wanted"), None, 1)
                .unwrap()
                .complete
        );
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut done = false;
        for _ in 0..10 {
            if read
                .walk_referrers_step(cancel.clone(), Duration::from_secs(30))
                .unwrap()
            {
                done = true;
                break;
            }
        }
        assert!(
            done,
            "one bounded walk page per idle pass reaches base and both routed stores"
        );
        let before = read.stamp().unwrap();
        let (mut after, mut found) = (None::<String>, Vec::new());
        for _ in 0..10 {
            let page = read
                .referrers("source:target", Some("wanted"), after.as_deref(), 1)
                .unwrap();
            assert!(page.complete);
            found.extend(page.referrers.into_iter().map(|holder| holder.id));
            match page.next {
                Some(next) => {
                    assert!(after.as_ref().is_none_or(|after| after < &next));
                    after = Some(next);
                }
                None => {
                    after = None;
                    break;
                }
            }
        }
        assert!(after.is_none(), "bounded pages finish");
        assert_eq!(found, ["a0010-routed", "a0300-routed", "z-base"]);
        assert_eq!(
            read.stamp().unwrap(),
            before,
            "all merged reverse pages remain read-only"
        );
    }

    #[test]
    fn a_lower_stamp_resource_change_invalidates_the_full_logical_witness() {
        let before = vec![
            ("@own-records".into(), 11),
            ("high".into(), 900),
            ("low".into(), 7),
        ];
        let after = vec![
            ("@own-records".into(), 11),
            ("high".into(), 900),
            ("low".into(), 8),
        ];
        assert_eq!(
            before.iter().map(|(_, stamp)| *stamp).max(),
            after.iter().map(|(_, stamp)| *stamp).max()
        );
        assert_ne!(
            logical_collection_stamp(&before).unwrap(),
            logical_collection_stamp(&after).unwrap()
        );
    }

    #[test]
    fn routed_point_history_key_and_catalogue_pages_share_the_verified_affinity() {
        let state = tempfile::tempdir().unwrap();
        let owner = "account:routed-read";
        let meter = crate::sqlite_work::WorkMeter::new();
        let base_path = state
            .path()
            .canonicalize()
            .unwrap()
            .join("record-book.sqlite");
        drop(crate::storage::sqlite::Connection::open(&base_path).unwrap());
        let mut base = record_store_resources::open(&base_path, meter.clone()).unwrap();
        OwnRecords::initialize_new_work_store(&mut base, owner, 1).unwrap();
        put_record(
            &mut base,
            owner,
            "legacy",
            &record("legacy", "{\"v\":0}", "2026-01-01T00:00:00Z"),
        );
        put_record(
            &mut base,
            owner,
            "decision-base",
            &typed_record(
                "decision-base",
                "decision",
                "{\"created_at\":\"2026-01-01T00:00:00Z\"}",
                "2026-01-01T00:00:00Z",
            ),
        );
        put_record(&mut base, owner, "schema-base", &schema_record("schema-base", "001",
            &serde_json::json!({"kind":"record:merged", "event":"field_added", "field":"base", "old_type":null, "new_type":"text", "changed_at":"2026-10-31T00:00:00.000Z"}).to_string()));

        let first_request = request(
            owner,
            &[
                "routed-a",
                "routed-b",
                "routed-gone",
                "decision-first",
                "schema-first",
            ],
            "batch:a",
        );
        let second_request = request(
            owner,
            &["routed-z", "decision-second", "schema-second"],
            "batch:z",
        );
        let first = crate::local_account::resource_affinity::store::AffinityDirectory::new(
            state.path(),
            meter.clone(),
            owner,
            "1",
        )
        .unwrap()
        .install_and_resolve(&first_request, || Ok(()))
        .unwrap();
        let second = crate::local_account::resource_affinity::store::AffinityDirectory::new(
            state.path(),
            meter.clone(),
            owner,
            "1",
        )
        .unwrap()
        .install_and_resolve(&second_request, || Ok(()))
        .unwrap();
        assert_ne!(
            first.resource, second.resource,
            "unrelated groups have distinct physical targets"
        );
        let retry = crate::local_account::resource_affinity::store::AffinityDirectory::new(
            state.path(),
            meter.clone(),
            owner,
            "1",
        )
        .unwrap()
        .install_and_resolve(&first_request, || Ok(()))
        .unwrap();
        assert_eq!(
            retry.resource, first.resource,
            "an exact retry retains the installed route"
        );

        for resource in [&first.resource, &second.resource] {
            let (_, mut store) =
                record_store_resources::open_state_resource(resource, state.path(), meter.clone())
                    .unwrap();
            OwnRecords::initialize_new_work_store(&mut store, owner, 1).unwrap();
        }

        let missing = &first_request.identities[0];
        let point_key = format!(
            "1f:{}",
            content_crypto::advanced::blake3::hash(
                &serde_json::to_vec(&(missing.kind.as_str(), missing.id.as_str())).unwrap(),
            )
            .to_hex()
        );
        let point_resource = format!("@own-work-point/{point_key}");
        let (_, mut point_store) = record_store_resources::open_state_resource(
            &point_resource,
            state.path(),
            meter.clone(),
        )
        .unwrap();
        let (version, held) = point_store
            .held_record_with_version(owner, &point_resource, "binding")
            .unwrap();
        assert!(held.is_some());
        point_store
            .mutate(
                owner,
                &point_resource,
                Mutation {
                    id: "binding".into(),
                    expected_version: version,
                    request_key: "remove-point-projection".into(),
                    deleted: true,
                    value: serde_json::Value::Null,
                },
            )
            .unwrap();
        let repaired = crate::local_account::resource_affinity::store::AffinityDirectory::new(
            state.path(),
            meter.clone(),
            owner,
            "1",
        )
        .unwrap()
        .resolve_points(&first_request.identities, || Ok(()))
        .unwrap()
        .unwrap();
        assert_eq!(
            repaired.resource, first.resource,
            "canonical membership repairs a missing point projection"
        );

        for (resource, id) in [
            (&first.resource, "routed-a"),
            (&first.resource, "routed-b"),
            (&first.resource, "routed-gone"),
            (&first.resource, "decision-first"),
            (&first.resource, "schema-first"),
            (&second.resource, "routed-z"),
            (&second.resource, "decision-second"),
            (&second.resource, "schema-second"),
        ] {
            let (path, mut store) =
                record_store_resources::open_state_resource(resource, state.path(), meter.clone())
                    .unwrap();
            let stored = match id {
                "decision-first" => typed_record(id, "decision", "{\"created_at\":\"2026-01-03T00:00:00Z\"}", "2026-01-03T00:00:00Z"),
                "decision-second" => typed_record(id, "decision", "{\"created_at\":\"2026-01-02T00:00:00Z\"}", "2026-01-02T00:00:00Z"),
                "schema-first" => schema_record(id, "002", &serde_json::json!({"kind":"record:merged", "event":"field_added", "field":"routed", "old_type":null, "new_type":"number", "changed_at":"2026-10-31T00:00:00.000Z"}).to_string()),
                "schema-second" => schema_record(id, "003", &serde_json::json!({"kind":"record:merged", "event":"field_added", "field":"last", "old_type":null, "new_type":"boolean", "changed_at":"2026-10-31T00:00:00.000Z"}).to_string()),
                _ => record(id, "{\"v\":1}", "2026-01-02T00:00:00Z"),
            };
            put_record(&mut store, owner, id, &stored);
            if id == "routed-a" {
                put_record(
                    &mut store,
                    owner,
                    id,
                    &record(id, "{\"v\":2}", "2026-01-03T00:00:00Z"),
                );
                store
                    .mutate(
                        owner,
                        KEYS,
                        Mutation {
                            id: id.into(),
                            expected_version: 0,
                            request_key: "key-routed-a".into(),
                            deleted: false,
                            value: key_body(&[7; 32]),
                        },
                    )
                    .unwrap();
            }
            if id == "routed-b" {
                store
                    .mutate(
                        owner,
                        KEYS,
                        Mutation {
                            id: id.into(),
                            expected_version: 0,
                            request_key: "key-erased-b".into(),
                            deleted: false,
                            value: serde_json::json!({"erased": true}),
                        },
                    )
                    .unwrap();
            }
            assert!(path.is_file());
        }
        let (_, mut gone_store) = record_store_resources::open_state_resource(
            &first.resource,
            state.path(),
            meter.clone(),
        )
        .unwrap();
        gone_store
            .mutate(
                owner,
                RESOURCE,
                Mutation {
                    id: "routed-gone".into(),
                    expected_version: 1,
                    request_key: "erase-routed-gone".into(),
                    deleted: true,
                    value: serde_json::Value::Null,
                },
            )
            .unwrap();

        // Reopen the directory after publication: these reads use the durable
        // point/group rows and verified installed-resource catalogue.
        let routes = std::sync::Arc::new(OwnWorkReadRoutes {
            state: state.path().canonicalize().unwrap(),
            owner: owner.into(),
            generation: "1".into(),
            meter: meter.clone(),
            resources: std::sync::Arc::new(
                StateResources::new(state.path(), meter.clone()).unwrap(),
            ),
        });
        let mut read = OwnRead {
            domain: None,
            current: RecordStoreCurrent::new(base, owner, RESOURCE),
            ready: true,
            key_reads: None,
            key_resource: RESOURCE.into(),
            routed_records: BTreeMap::new(),
            books: None,
            routes: Some(routes),
        };

        let decision_page = read.ordered("decision/created_at", None, 2).unwrap();
        assert_eq!(
            decision_page
                .records
                .iter()
                .map(|record| record.id.as_str())
                .collect::<Vec<_>>(),
            vec!["decision-first", "decision-second"]
        );
        let decision_tail = read
            .ordered("decision/created_at", decision_page.next.as_ref(), 2)
            .unwrap();
        assert_eq!(
            decision_tail
                .records
                .iter()
                .map(|record| record.id.as_str())
                .collect::<Vec<_>>(),
            vec!["decision-base"]
        );
        let ascending = crate::record_value::list::OrderedSupply::ordered(
            &mut read,
            "decision/created_at",
            None,
            false,
            2,
        )
        .unwrap();
        assert_eq!(
            ascending
                .records
                .iter()
                .map(|record| record.id.as_str())
                .collect::<Vec<_>>(),
            vec!["decision-base", "decision-second"]
        );
        let typed =
            crate::storage::kind_views::KindSchemas::kind_schema(&mut read, "record:merged")
                .unwrap()
                .unwrap();
        assert_eq!(
            typed.fields,
            std::collections::BTreeMap::from([
                ("base".into(), crate::storage::kind_views::FieldType::Text),
                (
                    "routed".into(),
                    crate::storage::kind_views::FieldType::Number
                ),
                (
                    "last".into(),
                    crate::storage::kind_views::FieldType::Boolean
                ),
            ])
        );
        let before = read.stamp().unwrap();
        let cursors = read.change_stamps().unwrap();
        assert_eq!(
            cursors.len(),
            3,
            "base plus two installed resources have real per-resource cursors"
        );
        let (_, mut changed_store) = record_store_resources::open_state_resource(
            &first.resource,
            state.path(),
            meter.clone(),
        )
        .unwrap();
        let version = changed_store
            .held_version(owner, RESOURCE, "decision-first")
            .unwrap();
        let change = changed_store
            .mutate(
                owner,
                RESOURCE,
                Mutation {
                    id: "decision-first".into(),
                    expected_version: version,
                    request_key: "erase-routed-decision".into(),
                    deleted: true,
                    value: serde_json::Value::Null,
                },
            )
            .unwrap();
        assert_ne!(
            read.stamp().unwrap(),
            before,
            "a routed shard write invalidates the whole collection witness"
        );
        assert!(read
            .removed_since(&cursors)
            .unwrap()
            .contains(&change.sequence));

        assert_eq!(
            read.stored("routed-a").unwrap().unwrap().value_json,
            "{\"v\":2}"
        );
        assert!(
            read.stored("routed-gone").unwrap().is_none(),
            "a routed tombstone stays absent"
        );
        assert!(matches!(
            read.key("routed-a").unwrap(),
            KeyState::Present(_)
        ));
        assert!(matches!(read.key("routed-b").unwrap(), KeyState::Erased));
        let history = read.versions("routed-a", None, 10).unwrap();
        assert_eq!(history.versions.len(), 2);
        assert_eq!(
            history.versions[0].stored.as_ref().unwrap().value_json,
            "{\"v\":2}"
        );

        let page = read.ids_of_type("note", "", None, 2).unwrap();
        assert_eq!(page.ids, vec!["routed-z", "routed-b"]);
        assert_eq!(page.next.as_deref(), Some("routed-b"));
        let tail = read
            .ids_of_type("note", "", page.next.as_deref(), 2)
            .unwrap();
        assert_eq!(tail.ids, vec!["routed-a", "legacy"]);
        assert_eq!(tail.next, None);
        let prefixed = read.ids_of_type("note", "routed-", None, 10).unwrap();
        assert_eq!(prefixed.ids, vec!["routed-z", "routed-b", "routed-a"]);

        let (version, identity) = read
            .current
            .store
            .held_record_with_version(owner, IDENTITY, IDENTITY_ID)
            .unwrap();
        let mut changed = identity.unwrap().value;
        changed["generation"] = serde_json::json!(2);
        let mut base_again = record_store_resources::open(&base_path, meter).unwrap();
        base_again
            .mutate(
                owner,
                IDENTITY,
                Mutation {
                    id: IDENTITY_ID.into(),
                    expected_version: version,
                    request_key: "change-generation".into(),
                    deleted: false,
                    value: changed,
                },
            )
            .unwrap();
        assert!(matches!(read.stored("routed-a"), Err(Error::Unavailable(_))));
    }
}

#[cfg(test)]
mod command_closure_tests {
    use super::*;
    use crate::storage::record_store_resources::{self, domains, StateResources};
    use std::sync::{Arc, atomic::AtomicBool};
    use std::time::Instant;

    fn model(rule: &str) -> crate::record_model_policy::Installed {
        crate::record_model_policy::Installed::from_rows(&[serde_json::json!({"record_model": {
            "rules_and_runs": {"rule":rule,"outcome":"fixture-outcome","run":"fixture-run",
                "recipe":"fixture-recipe","send":"fixture-send","own":[rule,"fixture-run"]}
        }})], true).unwrap()
    }
    fn selected() -> domains::Selection {
        domains::Selection { id:"fixture-history".into(), incarnation:"first".into(), generation:1, create:true }
    }
    fn writer(root: &Path) -> Arc<record_store_resources::Writer> {
        let resources = StateResources::new(root, crate::sqlite_work::WorkMeter::new()).unwrap();
        resources.writer("@test-db/closure-owner").unwrap()
    }
    fn descriptor(store: &RecordStore<impl Storage>) -> (i64, CommandClosure) {
        let (version, held) = store.held_record_with_version("owner", IDENTITY, "command-closure").unwrap();
        (version, serde_json::from_value(held.unwrap().value).unwrap())
    }

    #[test]
    fn native_closure_activation_and_rollback_share_the_command_transaction() {
        let root=tempfile::tempdir().unwrap(); let writer=writer(root.path());
        let model=model("fixture-rule"); let selected=selected();
        for commit in [false,true] {
            let source=writer.lend(Arc::new(AtomicBool::new(false)),Instant::now()+Duration::from_secs(30)).unwrap();
            let tx=source.begin(crate::storage::sqlite::TransactionBehavior::Immediate).unwrap();
            let mut records=InCommand::lend(&tx,"owner",InCommand::limits(&tx,writer.path()).unwrap()).unwrap();
            records.command_domain(&selected).unwrap();
            records.activate_command_closure(&selected.identity(),&model).unwrap();
            assert!(command_closure_current(&records.store,"owner",&selected.identity(),Some(&model)).unwrap());
            let (version,closure)=descriptor(&records.store);
            assert_eq!(version,1);
            assert_eq!(closure.local_roots,CommandClosure::local_roots());
            assert!(closure.rule_roots.contains(&"fixture-rule".into()));
            assert!(closure.external_mutable_dependencies.is_empty());
            assert_eq!(records.store.stamp("owner",RESOURCE).unwrap(),0,"activation copies no rule values");
            assert_eq!(records.store.stamp("owner",KEYS).unwrap(),0,"activation copies no private keys");
            drop(records);
            if commit {tx.commit().unwrap();} else {tx.rollback().unwrap();}
            let store=record_store_resources::open(writer.path(),crate::sqlite_work::WorkMeter::new()).unwrap();
            assert_eq!(store.current_record("owner",IDENTITY,"command-closure").unwrap().is_some(),commit);
        }
    }

    #[test]
    fn model_activation_updates_its_protected_revision_once_and_history_does_not_cross() {
        let root=tempfile::tempdir().unwrap();let writer=writer(root.path());let selected=selected();
        let first=model("fixture-rule");let second=model("other-rule");
        let source=writer.lend(Arc::new(AtomicBool::new(false)),Instant::now()+Duration::from_secs(30)).unwrap();
        let tx=source.begin(crate::storage::sqlite::TransactionBehavior::Immediate).unwrap();
        let mut records=InCommand::lend(&tx,"owner",InCommand::limits(&tx,writer.path()).unwrap()).unwrap();
        records.command_domain(&selected).unwrap();records.activate_command_closure(&selected.identity(),&first).unwrap();
        let (before,old)=descriptor(&records.store);
        records.activate_command_closure(&selected.identity(),&first).unwrap();
        assert_eq!(descriptor(&records.store).0,before,"same admitted model does not write metadata again");
        records.activate_command_closure(&selected.identity(),&second).unwrap();
        let (after,new)=descriptor(&records.store);assert_eq!(after,before+1);assert_ne!(new.revision,old.revision);
        assert!(!command_closure_current(&records.store,"owner",&selected.identity(),Some(&first)).unwrap());
        assert!(command_closure_current(&records.store,"owner",&selected.identity(),Some(&second)).unwrap());
        assert!(command_closure_current(&records.store,"owner",&selected.identity(),None).unwrap(),"whole-domain adoption preserves declared roots");
        // Reinstalling an earlier model is a fresh protected metadata change,
        // not a retry of that model's first activation at another version.
        records.activate_command_closure(&selected.identity(),&first).unwrap();
        assert_eq!(descriptor(&records.store).0,after+1);
        assert!(command_closure_current(&records.store,"owner",&selected.identity(),Some(&first)).unwrap());
        let mut other=selected.identity();other.incarnation="other".into();
        assert!(!command_closure_current(&records.store,"owner",&other,None).unwrap());
        assert!(!command_closure_current(&records.store,"other-owner",&selected.identity(),None).unwrap());
        drop(records);tx.commit().unwrap();
    }

    #[test]
    fn a_retained_external_mutable_dependency_cannot_be_rewritten_as_a_local_closure() {
        let root=tempfile::tempdir().unwrap();let writer=writer(root.path());let selected=selected();let model=model("fixture-rule");
        let source=writer.lend(Arc::new(AtomicBool::new(false)),Instant::now()+Duration::from_secs(30)).unwrap();
        let tx=source.begin(crate::storage::sqlite::TransactionBehavior::Immediate).unwrap();
        let mut records=InCommand::lend(&tx,"owner",InCommand::limits(&tx,writer.path()).unwrap()).unwrap();
        records.command_domain(&selected).unwrap();records.activate_command_closure(&selected.identity(),&model).unwrap();
        let (version,mut closure)=descriptor(&records.store);
        closure.external_mutable_dependencies.push("fixture-external-history".into());
        closure.revision=closure.identity().unwrap();
        records.store.mutate_local_with_check("owner",IDENTITY,Mutation {id:"command-closure".into(),expected_version:version,
            request_key:"fixture-external-contract".into(),deleted:false,value:serde_json::to_value(&closure).unwrap()},||Ok(())).unwrap();
        assert!(!command_closure_current(&records.store,"owner",&selected.identity(),None).unwrap());
        assert!(matches!(records.activate_command_closure(&selected.identity(),&model),Err(Error::Conflict(_))));
        assert_eq!(descriptor(&records.store).1.external_mutable_dependencies,closure.external_mutable_dependencies);
        drop(records);tx.rollback().unwrap();
    }
}

#[cfg(test)]
mod overflow_book_read_tests {
    use super::*;
    use crate::records::Mutation;
    use crate::storage::record_store_resources::books::Books;
    use serde_json::json;

    /// Old trillion's own-record-overflow-read.test.mjs: a record that landed in a further book of the volume is found by
    /// the account's own-records read, not only the primary book's.
    #[test]
    fn a_record_kept_in_an_overflow_book_is_read_by_the_own_records_read() {
        let dir = tempfile::tempdir().unwrap();
        let primary = dir.path().canonicalize().unwrap().join("own-records.sqlite");
        let owner = "synthetic-owner";
        let meter = crate::sqlite_work::WorkMeter::new();
        let books = Books::new(&primary, meter.clone(), None);
        books.open_book(0).unwrap();
        let body = json!({"kind": "note", "sequence": "1", "stored": "{\"words\":\"KEPT\"}", "meta": null, "protected": false});
        books
            .open_book(1)
            .unwrap()
            .mutate(owner, RESOURCE, Mutation {
                id: "kept-1".into(),
                expected_version: 0,
                request_key: "overflow-kept-1".into(),
                deleted: false,
                value: body,
            })
            .unwrap();
        // A split publishes the directory after its carry: the span from "kept-1" is held by overflow-1.
        let directory = crate::storage::record_store_resources::book_directory::Directory::new().split(0, "kept-1", 1).unwrap();
        publish_directory(&mut books.open_book(0).unwrap(), owner, &directory).unwrap();
        let mut held = OwnRecords::open(&primary, owner, "synthetic-source", meter).unwrap();
        // A fresh store has no migration to finish: it is ready as soon as it opens.
        held.read.ready = true;
        assert!(
            held.stored("kept-1").unwrap().is_some(),
            "the record in overflow-1 is read by the own-records read"
        );
    }

    /// Opens an account whose volume has `books` stores: the primary and `books - 1` further stores, each seeded with
    /// finished rows, read through the own-records read with a fresh store that is ready.
    fn account_with_books(dir: &std::path::Path, name: &str, books: usize, meter: &crate::sqlite_work::WorkMeter) -> OwnRecords {
        let primary = dir.canonicalize().unwrap().join(format!("{name}.sqlite"));
        let owner = "synthetic-owner";
        let store = Books::new(&primary, meter.clone(), None);
        for order in 0..books {
            let mut book = store.open_book(order).unwrap();
            for row in 0..20 {
                book.mutate(owner, RESOURCE, Mutation {
                    id: format!("row-{order}-{row}"),
                    expected_version: 0,
                    request_key: format!("seed-{order}-{row}"),
                    deleted: false,
                    value: json!({"kind": "note", "sequence": "1", "stored": "{\"words\":\"seed\"}", "meta": null, "protected": false}),
                })
                .unwrap();
            }
        }
        // Each further book is a span from "row-<order>", published the way a split publishes it.
        let mut directory = crate::storage::record_store_resources::book_directory::Directory::new();
        for order in 1..books {
            directory = directory.split(directory.generation(), &format!("row-{order}"), order).unwrap();
        }
        publish_directory(&mut store.open_book(0).unwrap(), owner, &directory).unwrap();
        let mut held = OwnRecords::open(&primary, owner, "synthetic-source", meter.clone()).unwrap();
        held.read.ready = true;
        held
    }

    /// Seed decision proof (lead, 2026-11-12): a read that finds nothing must touch the same number of stores however many
    /// stores the account has. Today the own-records point read asks each further store in turn, so a miss on three stores
    /// costs three lookups where a miss on one costs one.
    #[test]
    fn a_read_that_misses_touches_the_same_stores_however_many_books_the_account_has() {
        let dir = tempfile::tempdir().unwrap();
        let meter = crate::sqlite_work::WorkMeter::new();
        let mut one = account_with_books(dir.path(), "one-book", 1, &meter);
        let window = meter.begin_observation().unwrap();
        assert!(one.stored("absent").unwrap().is_none());
        let one_lookups = window.finish().unwrap().work.sql_statements;
        let mut three = account_with_books(dir.path(), "three-books", 3, &meter);
        let window = meter.begin_observation().unwrap();
        assert!(three.stored("absent").unwrap().is_none());
        let three_lookups = window.finish().unwrap().work.sql_statements;
        assert_eq!(
            three_lookups, one_lookups,
            "a miss on three stores costs {three_lookups} lookups, a miss on one costs {one_lookups}"
        );
    }

    /// Red first: a page of ids across an account's stores is the newest ids of all of them, not of the primary alone.
    #[test]
    fn an_ids_page_reads_across_the_spans_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let meter = crate::sqlite_work::WorkMeter::new();
        let mut held = account_with_books(dir.path(), "paged", 3, &meter);
        let page = held.ids_of_type("note", "", None, 5).unwrap();
        // Ids sort as text, so "row-2-9" is newer than "row-2-19": the top span's page is row-2-9 down to row-2-5.
        assert_eq!(page.ids, vec!["row-2-9", "row-2-8", "row-2-7", "row-2-6", "row-2-5"]);
    }

    /// The cost of an id page does not grow with the number of stores: a page inside the top span opens one further store
    /// whether the account has three stores or five.
    #[test]
    fn an_ids_page_costs_the_same_however_many_books_the_account_has() {
        let dir = tempfile::tempdir().unwrap();
        let meter = crate::sqlite_work::WorkMeter::new();
        let mut three = account_with_books(dir.path(), "paged-three", 3, &meter);
        let window = meter.begin_observation().unwrap();
        three.ids_of_type("note", "", None, 5).unwrap();
        let three_statements = window.finish().unwrap().work.sql_statements;
        let mut five = account_with_books(dir.path(), "paged-five", 5, &meter);
        let window = meter.begin_observation().unwrap();
        five.ids_of_type("note", "", None, 5).unwrap();
        let five_statements = window.finish().unwrap().work.sql_statements;
        assert_eq!(five_statements, three_statements, "an id page costs {five_statements} statements on five stores, {three_statements} on three");
    }

    /// Gap (a), books-chooser: once the primary book is flagged full the chooser names a second book, but an ordinary
    /// record write still lands in the primary (incident 24). The scenario fails until the write path asks the chooser.
    fn ordinary_write_body() -> Result<(), String> {
        use crate::storage::{Intent, Scope};
        let dir = tempfile::tempdir().map_err(|error| format!("tempdir: {error}"))?;
        let primary = dir.path().canonicalize().map_err(|error| format!("canonicalize: {error}"))?.join("own-records.sqlite");
        let owner = "synthetic-owner";
        let meter = crate::sqlite_work::WorkMeter::new();
        // The primary is flagged full by its live level: a row every store has reached.
        let full = crate::storage::record_store::store_size::SizeRow::parse(&serde_json::json!({"limit_bytes": 1, "levels": [{"id": "refuse-growth", "at_share": 1.0, "refuses": ["growth"]}]}))
            .ok_or_else(|| "a size row that every store reaches".to_string())?;
        let books = Books::new(&primary, meter.clone(), Some(full));
        drop(books.open_book(0).map_err(|error| format!("open book: {error:?}"))?);
        drop(OwnRecords::open(&primary, owner, "synthetic-source", meter).map_err(|error| format!("open: {error:?}"))?);
        let head = books.head().map_err(|error| format!("head: {error:?}"))?;
        if head.order != 1 {
            return Err(format!("the chooser names book {} once the primary is flagged, not a second book", head.order));
        }
        let supply: Box<dyn crate::storage::Storage> = Box::new(crate::storage::sqlite::open_owned(&primary, SCHEMA, crate::storage::sqlite::Bounds {
            value_bytes: 1 << 20,
            work: u64::MAX / 2,
            deadline: Duration::MAX,
            spend: crate::storage::sqlite::Spend::EachOperation,
            cancel: None,
            busy: Duration::from_millis(50),
        }).map_err(|error| format!("open store: {error:?}"))?);
        let form = StoredRecord {
            id: "ordinary-1".into(),
            record_type: "note".into(),
            sequence: "1".into(),
            value_json: r#"{"words":"ORDINARY"}"#.into(),
            meta_json: None,
            protected_key_present: false,
        };
        let forms = BTreeMap::from([("ordinary-1".to_owned(), Some(form))]);
        let transaction = Scope::begin(&*supply, Intent::Write).map_err(|error| format!("begin: {error:?}"))?;
        let mut records = InCommand::from_storage(&*transaction, owner, Limits::fixed(1 << 20, 128 << 20), shipped_settings().unwrap())
            .map_err(|error| format!("command: {error:?}"))?;
        records.write(&forms, &[], "ordinary-write", || Ok(())).map_err(|error| format!("write: {error:?}"))?;
        drop(records);
        transaction.commit().map_err(|error| format!("commit: {error:?}"))?;
        match books.find(owner, RESOURCE, "ordinary-1").map_err(|error| format!("find: {error:?}"))? {
            Some((1, _)) => Ok(()),
            Some((order, _)) => Err(format!("the ordinary write landed in book {order} while the chooser names book 1")),
            None => Err("the ordinary write is held by no book".into()),
        }
    }

    #[test]
    fn ordinary_write_reaches_a_second_book_once_the_first_is_full() {
        crate::simulation::verdict("ordinary-write-reaches-a-second-book-once-the-first-is-full", ordinary_write_body);
    }
}

/// Every list keeps its rows in a store of its own (src/storage/record_store_resources/lists.rs), through this owner: the
/// native command's write (`InCommand::write`) and the account's read (`OwnRead`), on real SQLite files in a fresh state
/// folder. Ported from old trillion test/placed-lists.test.mjs (a placed list's rows live in its database, every read
/// finds them there, a move copies a page a step and no row is lost). Every record word is synthetic fixture text.
#[cfg(test)]
mod list_store_tests {
    use super::*;
    use crate::storage::record_store_resources::{lists, StateResources, Writer};
    use std::sync::{atomic::AtomicBool, Arc};
    use std::time::Instant;

    const OWNER: &str = "synthetic-owner";

    struct Account {
        _dir: tempfile::TempDir,
        state: std::path::PathBuf,
        resources: Arc<StateResources>,
        primary: Arc<Writer>,
        meter: crate::sqlite_work::WorkMeter,
    }

    /// A fresh account: its primary store made ready at generation 1, as a new account's is.
    fn account() -> Account {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().canonicalize().unwrap();
        let meter = crate::sqlite_work::WorkMeter::new();
        let resources = Arc::new(StateResources::new(&state, meter.clone()).unwrap());
        let primary = resources.writer("@test-db/primary").unwrap();
        let account = Account { _dir: dir, state, resources, primary, meter };
        command(&account, false, |records| records.install_new_work_resource(1));
        account
    }

    fn homes(account: &Account) -> ListHomes {
        ListHomes {
            resources: account.resources.clone(),
            model: crate::record_model_policy::own_model().unwrap(),
            settings: shipped_settings().unwrap(),
            cancel: Arc::new(AtomicBool::new(false)),
            deadline: Instant::now() + Duration::from_secs(30),
        }
    }

    /// One native command on the primary, with the account's list stores bound or not, committed.
    fn command<T>(account: &Account, bound: bool, write: impl FnOnce(&mut InCommand<'_>) -> Result<T, Error>) -> T {
        let lent = account.primary.lend(Arc::new(AtomicBool::new(false)), Instant::now() + Duration::from_secs(30)).unwrap();
        let transaction = lent.begin(crate::storage::sqlite::TransactionBehavior::Immediate).unwrap();
        let mut records = InCommand::lend(&transaction, OWNER, InCommand::limits(&transaction, account.primary.path()).unwrap()).unwrap();
        if bound {
            records.bind_list_homes(Some(homes(account)));
        }
        let answer = write(&mut records).unwrap();
        drop(records);
        transaction.commit().unwrap();
        answer
    }

    fn form(id: &str, kind: &str, value: serde_json::Value) -> StoredRecord {
        StoredRecord { id: id.into(), record_type: kind.into(), sequence: "1".into(), value_json: value.to_string(), meta_json: None, protected_key_present: false }
    }

    fn write(account: &Account, request: &str, forms: Vec<(&str, Option<StoredRecord>)>) {
        let forms: BTreeMap<String, Option<StoredRecord>> = forms.into_iter().map(|(id, form)| (id.to_owned(), form)).collect();
        command(account, true, |records| records.write(&forms, &[], request, || Ok(())));
    }

    /// The account's read, routed to its other stores as the selected account's is (`configure_work_reads`).
    fn read(account: &Account) -> OwnRecords {
        let mut held = OwnRecords::open(account.primary.path(), OWNER, "synthetic-source", account.meter.clone()).unwrap();
        held.configure_work_reads(&account.state, OWNER, 1, account.meter.clone()).unwrap();
        held
    }

    /// Live rows of `kind` the primary file itself holds.
    fn primary_rows(account: &Account, kind: &str) -> i64 {
        let db = rusqlite::Connection::open(account.primary.path()).unwrap();
        db.query_row("SELECT COUNT(*) FROM versions WHERE resource='own-records' AND kind=? AND valid_to IS 9223372036854775807 AND deleted IS 0",
            [kind], |row| row.get(0)).unwrap()
    }

    fn list_value(row_type: &str, placement: Option<serde_json::Value>) -> serde_json::Value {
        let mut value = serde_json::json!({"id": row_type, "label": "Synthetic list", "row_type": row_type,
            "title_field": "text", "fields": [{"id": "text", "label": "Text", "kind": "text"}]});
        if let Some(placement) = placement {
            value["placement"] = placement;
        }
        value
    }

    fn list(row_type: &str, placement: Option<serde_json::Value>) -> StoredRecord {
        form(&format!("list:{row_type}"), "list", list_value(row_type, placement))
    }

    fn row(id: &str, row_type: &str, text: &str) -> StoredRecord {
        form(id, &format!("record:{row_type}"), serde_json::json!({"text": text}))
    }

    fn text(records: &mut OwnRecords, id: &str) -> Option<String> {
        records.stored(id).unwrap().map(|stored| serde_json::from_str::<serde_json::Value>(&stored.value_json).unwrap()["text"].as_str().unwrap().to_owned())
    }

    fn placement(records: &mut OwnRecords, list: &str) -> serde_json::Value {
        serde_json::from_str::<serde_json::Value>(&records.stored(list).unwrap().unwrap().value_json).unwrap()["placement"].clone()
    }

    fn every_id(records: &mut OwnRecords, kind: &str) -> Vec<String> {
        let (mut ids, mut before) = (Vec::new(), None::<String>);
        loop {
            let page = records.ids_of_type(kind, "", before.as_deref(), 7).unwrap();
            ids.extend(page.ids.iter().cloned());
            match page.next {
                Some(next) => before = Some(next),
                None => return ids,
            }
        }
    }

    #[test]
    fn a_new_lists_rows_are_written_and_read_in_a_store_of_their_own() {
        let account = account();
        write(&account, "definition", vec![("list:proof", Some(list("proof", None)))]);
        let mut records = read(&account);
        assert_eq!(placement(&mut records, "list:proof"), serde_json::json!({"database": "proof"}), "a new list is given a store of its own");

        // One row whose id names its type, one whose id does not (as a library row's `x-money:...` does).
        write(&account, "rows", vec![("record:proof:one", Some(row("record:proof:one", "proof", "first"))), ("proof-two", Some(row("proof-two", "proof", "second")))]);
        assert!(account.state.join("list-proof.sqlite").is_file(), "the list's rows have a file of their own");
        assert_eq!(primary_rows(&account, "record:proof"), 0, "no row of the list is kept in the primary");

        let mut records = read(&account);
        assert_eq!(text(&mut records, "record:proof:one").as_deref(), Some("first"));
        assert_eq!(text(&mut records, "proof-two").as_deref(), Some("second"), "a read by id alone finds the row in its list's store");
        assert_eq!(every_id(&mut records, "record:proof"), ["record:proof:one", "proof-two"], "the list's page reads its store");
        let in_command = command(&account, true, |records| Ok((records.stored("proof-two")?.is_some(), records.ever_held("proof-two")?)));
        assert_eq!(in_command, (true, true), "a command reads the row where it is kept");

        // An update and a removal are made in the list's store; the primary still holds none of its rows.
        write(&account, "update", vec![("proof-two", Some(row("proof-two", "proof", "changed")))]);
        write(&account, "remove", vec![("record:proof:one", None)]);
        let mut records = read(&account);
        assert_eq!(text(&mut records, "proof-two").as_deref(), Some("changed"));
        assert_eq!(text(&mut records, "record:proof:one"), None);
        assert_eq!(every_id(&mut records, "record:proof"), ["proof-two"]);
        assert_eq!(primary_rows(&account, "record:proof"), 0);

        // A save of the list that names no placement keeps the one it has.
        write(&account, "resave", vec![("list:proof", Some(list("proof", None)))]);
        let mut records = read(&account);
        assert_eq!(placement(&mut records, "list:proof"), serde_json::json!({"database": "proof"}));
    }

    #[test]
    fn a_list_kept_in_the_primary_moves_a_page_a_step_and_every_row_reads_before_during_and_after() {
        let account = account();
        // A list made before every list had a store of its own: its rows were written into the primary.
        let rows = 600;
        let ids: Vec<String> = (0..rows).map(|at| format!("item-{at:04}")).collect();
        let legacy: Vec<(String, Option<StoredRecord>)> = std::iter::once(("list:library".to_owned(), Some(list("library", None))))
            .chain(ids.iter().map(|id| (id.clone(), Some(row(id, "library", &format!("text of {id}"))))))
            .collect();
        for (at, page) in legacy.chunks(200).enumerate() {
            let page: BTreeMap<_, _> = page.iter().cloned().collect();
            command(&account, false, |records| records.write(&page, &[], &format!("legacy-{at}"), || Ok(())));
        }
        assert_eq!(primary_rows(&account, "record:library"), rows as i64);
        let everything = |account: &Account| {
            let mut records = read(account);
            let listed = every_id(&mut records, "record:library");
            let found = ids.iter().filter(|id| text(&mut records, id).as_deref() == Some(format!("text of {id}").as_str())).count();
            (listed.len(), found)
        };
        assert_eq!(everything(&account), (rows, rows), "before the move");

        // A save naming a store starts the move; the rows stay where they are until it copies them.
        write(&account, "place", vec![("list:library", Some(list("library", Some(serde_json::json!({"database": "library"})))))]);
        let index = lists::index(&read(&account).read.current.store, OWNER).unwrap().1;
        assert!(index.moving.contains("list:library") && index.homes.is_empty(), "{index:?}");
        assert_eq!(placement(&mut read(&account), "list:library")["moving"], serde_json::json!({"to": "library", "cursor": null, "copied": 0}));

        let settings = lists::move_settings().unwrap();
        let mut steps = Vec::new();
        loop {
            let mut records = read(&account);
            let stepped = lists::step(&mut records, "list:library", settings).unwrap();
            drop(records);
            // During the move every row is still read: from the primary until the flip, from its own store after.
            assert_eq!(everything(&account), (rows, rows), "during the move, after {stepped:?}");
            if steps.is_empty() {
                // A write while the move copies lands in both stores, so it is read after the flip too.
                write(&account, "during", vec![("item-0000", Some(row("item-0000", "library", "text of item-0000")))]);
            }
            let done = stepped == lists::Stepped::Done;
            steps.push(stepped);
            if done {
                break;
            }
            assert!(steps.len() < 20, "{steps:?}");
        }
        assert!(steps.contains(&lists::Stepped::Flipped), "{steps:?}");
        assert!(steps.iter().any(|step| matches!(step, lists::Stepped::Retired { .. })), "{steps:?}");
        assert_eq!(everything(&account), (rows, rows), "after the move");
        assert_eq!(primary_rows(&account, "record:library"), 0, "the old home's copies are retired");
        let mut records = read(&account);
        let index = lists::index(&records.read.current.store, OWNER).unwrap().1;
        assert_eq!(index.homes.get("library").map(String::as_str), Some("@list/library"));
        assert!(index.moving.is_empty(), "{index:?}");
        let kept = placement(&mut records, "list:library");
        assert_eq!(kept["database"], "library");
        assert_eq!(kept["earlier"].as_array().map(Vec::len), Some(1), "the record names the home it had: {kept}");
        assert!(kept.get("moving").is_none() && kept.get("retiring").is_none(), "{kept}");

        // A step of a settled list does nothing, and a new row lands in the list's store.
        assert_eq!(lists::step(&mut records, "list:library", settings).unwrap(), lists::Stepped::Settled);
        drop(records);
        write(&account, "after", vec![("item-new", Some(row("item-new", "library", "text of item-new")))]);
        assert_eq!(primary_rows(&account, "record:library"), 0);
        assert_eq!(text(&mut read(&account), "item-new").as_deref(), Some("text of item-new"));
    }

    /// Every row of `kind` the account reads now, by id, with the BLAKE3 digest of its stored form.
    fn rows_read(records: &mut OwnRecords, kind: &str) -> BTreeMap<String, [u8; 32]> {
        let (mut rows, mut before) = (BTreeMap::new(), None::<String>);
        loop {
            let page = records.ids_of_type(kind, "", before.as_deref(), crate::records::MAX_PAGE_ITEMS).unwrap();
            for id in &page.ids {
                let stored = records.stored(id).unwrap().unwrap_or_else(|| panic!("{id} is listed but not read"));
                assert!(rows.insert(id.clone(), digest(&stored)).is_none(), "{id} is listed twice");
            }
            match page.next {
                Some(next) => before = Some(next),
                None => return rows,
            }
        }
    }

    /// The move proved on a copy of a real account (never the account itself): `TRILLION_LIST_PROOF_BOOK` names a copy of
    /// an account's RecordBook in a scratch folder of its own, `TRILLION_LIST_PROOF_LIST` the record id of a list kept in
    /// its primary. The list is given its own store and moved a page a step; every row is read, and its stored form
    /// compared, before the move, after every step and after it, and none may be lost or changed. Run by hand:
    /// `cargo test --lib list_store_tests::a_real_accounts_copy -- --ignored --nocapture`.
    #[test]
    #[ignore = "needs a copy of a real account's RecordBook; run by hand with TRILLION_LIST_PROOF_BOOK and TRILLION_LIST_PROOF_LIST"]
    fn a_real_accounts_copy_moves_a_list_into_its_own_store_and_loses_no_row() {
        let book = std::path::PathBuf::from(std::env::var("TRILLION_LIST_PROOF_BOOK").unwrap()).canonicalize().unwrap();
        let list_id = std::env::var("TRILLION_LIST_PROOF_LIST").unwrap();
        let state = book.parent().unwrap().to_path_buf();
        let owner: String = rusqlite::Connection::open(&book).unwrap()
            .query_row("SELECT account FROM versions WHERE resource='own-resource-identity' LIMIT 1", [], |row| row.get(0)).unwrap();
        let meter = crate::sqlite_work::WorkMeter::new();
        let open = || {
            let mut held = OwnRecords::open(&book, &owner, "list-move-proof", meter.clone()).unwrap();
            assert!(held.ready(), "the copy's own records are ready");
            let generation = original_generation(&held.read.current.store, &owner).unwrap().unwrap();
            held.configure_work_reads(&state, &owner, generation, meter.clone()).unwrap();
            held
        };
        let mut list = open().stored(&list_id).unwrap().unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&list.value_json).unwrap();
        let row_type = value["row_type"].as_str().unwrap().to_owned();
        let kind = format!("record:{row_type}");
        let started = Instant::now();
        let before = rows_read(&mut open(), &kind);
        crate::quiet_eprintln!("list-move-proof phase=before rows={} read_ms={}", before.len(), started.elapsed().as_millis());
        assert!(!before.is_empty());

        // The list is given its own store by a save naming it, through the native command's write.
        value["placement"] = serde_json::json!({"database": row_type});
        list.value_json = value.to_string();
        let writer = Arc::new(Writer::new(book.clone(), meter.clone(), 64 * 1024 * 1024));
        let lent = writer.lend(Arc::new(AtomicBool::new(false)), Instant::now() + Duration::from_secs(60)).unwrap();
        let transaction = lent.begin(crate::storage::sqlite::TransactionBehavior::Immediate).unwrap();
        let mut records = InCommand::lend(&transaction, &owner, InCommand::limits(&transaction, &book).unwrap()).unwrap();
        records.bind_list_homes(Some(ListHomes {
            resources: Arc::new(StateResources::new(&state, meter.clone()).unwrap()),
            model: crate::record_model_policy::own_model().unwrap(),
            settings: shipped_settings().unwrap(),
            cancel: Arc::new(AtomicBool::new(false)),
            deadline: Instant::now() + Duration::from_secs(60),
        }));
        records.write(&BTreeMap::from([(list_id.clone(), Some(list))]), &[], &format!("list-move-proof-place-{list_id}"), || Ok(())).unwrap();
        drop(records);
        transaction.commit().unwrap();
        drop(lent);

        let settings = lists::move_settings().unwrap();
        let (mut steps, mut copied, mut retired) = (0usize, 0usize, 0usize);
        let moving = Instant::now();
        // One mover held across steps, as the account's idle upkeep holds its own records, and the idle maintenance's
        // turn after each step (`maintenance::run_next`), as each idle pass gives one.
        let mut mover = open();
        loop {
            let step_started = Instant::now();
            let stepped = lists::step(&mut mover, &list_id, settings).unwrap();
            let step_ms = step_started.elapsed().as_millis();
            // A store another test of this process registered and removed is refused on its turn, as any gone store is.
            if let Some((one, outcome)) = crate::storage::record_store::maintenance::run_next(Duration::from_secs(5)) {
                crate::quiet_eprintln!("{}", crate::storage::record_store::maintenance::turn_line(&one, &outcome));
            }
            steps += 1;
            match stepped {
                lists::Stepped::Copied { rows } => copied += rows,
                lists::Stepped::Retired { rows } => retired += rows,
                _ => {}
            }
            // Every row, every step for a list of a few thousand rows; at the flip and the end for any list.
            let full = before.len() <= 5_000 || matches!(stepped, lists::Stepped::Flipped | lists::Stepped::Done);
            if full {
                assert_eq!(rows_read(&mut open(), &kind), before, "after step {steps} ({stepped:?}) every row reads as it was");
            }
            crate::quiet_eprintln!("list-move-proof step={steps} stepped={stepped:?} step_ms={step_ms} checked_every_row={full}");
            if stepped == lists::Stepped::Done {
                break;
            }
        }
        let after = rows_read(&mut open(), &kind);
        assert_eq!(after, before, "after the move no row is lost or changed");
        let primary: i64 = rusqlite::Connection::open(&book).unwrap().query_row(
            "SELECT COUNT(*) FROM versions WHERE account=? AND resource='own-records' AND kind=? AND valid_to IS 9223372036854775807 AND deleted IS 0",
            [owner.as_str(), kind.as_str()], |row| row.get(0)).unwrap();
        assert_eq!(primary, 0, "the primary keeps no live row of the list");
        let store = state.join(format!("list-{row_type}.sqlite"));
        crate::quiet_eprintln!("list-move-proof phase=after rows={} copied={copied} retired={retired} steps={steps} move_ms={} store_bytes={}",
            after.len(), moving.elapsed().as_millis(), std::fs::metadata(&store).unwrap().len());
    }
}
