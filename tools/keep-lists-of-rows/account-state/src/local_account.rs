// Purpose: adopt the existing mutable local account behind its original state
// lock, policy directory, APP_KV store and protected browser identity.
// Invariants: observation is not authority; original state is never treated as
// immutable, bootstrapped empty, replaced by a new auth DB or silently refilled.
// Key concepts: selected current state, exact restore-record/index lineage, the
// local-runtime.lock startup lock held under flock, ordinary SQLite/WAL reads and
// policy revisions.
// Security: only selected session/key lookups, bounded point queries and bodies;
// no keys in argv/logs, no process signals or JS fallback; a crashed owner's lock
// is free (the kernel released it) and is taken over, a held one refuses.
//! Source contracts: scripts/local-state-lock.mjs, local-restored-session.mjs,
//! local-restore-workerd.mjs; src/account-control.mjs::gateSourceSnapshot and
//! policySourceSnapshot. Observers remain read-only. Narrow admitted commands
//! borrow the same original writable owners; native_enrollment preserves the
//! original device-key lifecycle and keeps its credential in secrets.

use crate::{
    account::{
        AccountError, AccountIdentity, AccountResult, NativeAccountOwner,
        NativeGateView, BROWSER_RESOURCE,
    },
    account_source::ProtectedBrowserSession,
    import::FilePin,
};
use content_crypto::advanced::blake3;
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fmt,
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;
use crate::tool_runs::os::{Open, OwnerFiles, This};

pub(crate) mod catalog_source;
pub(crate) mod record_delivery;
mod source_check;
mod show_rules;
pub mod service_records;
pub use show_rules::ShowRulesDeliveryWitness;
pub(crate) use show_rules::tools_json;
pub mod command_journal;
#[cfg(test)]
mod current_record_tests;
mod state_lock_recovery;
mod live_heads;
mod tool_screens;
pub(crate) mod catalog_delivery;
mod waiting_sources;
pub(crate) use live_heads::DeliveryWitness;
pub mod logical;
pub mod own_records;
pub mod resource_affinity;
pub mod record_writer;
mod resource_connection;
mod connection_management;
pub(crate) use connection_management::{NativeDomainAuthority, NativeAuthorityPermit, NativeDomainControl};
mod connection_credential;
mod native_enrollment;

const MAX_JSON: usize = 4 * 1024 * 1024;
const MAX_INDEX: usize = 16 * 1024 * 1024;
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const POLICY_SOURCE_FACT: &str = "policy-source";
/// Existing localOnlyOptions store, not a newly minted storage identity.
pub const EXISTING_APP_KV_STORE: &str = "trillion-local-app";
fn hex(text: &str, n: usize) -> bool {
    text.len() == n
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
/// The account control's object binding (src/account/create.rs, a new account's object index; an account the Mac app
/// made lists more of its objects, `overdue-index` among them, under the same binding).
pub const POLICY_BINDING: &str = "ACCOUNT_CONTROL";

/// Whether the object index row `row` names `name` among its names.
fn named(row: &Value, name: &str) -> bool {
    row["names"].as_array().is_some_and(|names| names.iter().any(|n| n == name))
}

/// The one owner rule of the account's policy store: the object index row of the account control named
/// `policy:<owner_id>`. An account has exactly one (`own_store_file`); its other account control objects (an account the
/// Mac app made lists `overdue-index` first) are never its policy store.
pub fn is_own_policy(row: &Value, owner_id: &str) -> bool {
    row["binding"] == POLICY_BINDING && named(row, &format!("policy:{owner_id}"))
}

/// The name the account's own records object carries: `own-record-resource:` and [owner id, the browser resource].
fn own_records_name(owner_id: &str) -> Option<String> {
    Some(format!("own-record-resource:{}", serde_json::to_string(&[owner_id, BROWSER_RESOURCE]).ok()?))
}

/// The binding the account's own records are placed in (src/storage/record_store_resources.json, `own-records`).
fn own_records_binding() -> Option<&'static str> {
    match crate::storage::record_store_resources::placement(own_records::RESOURCE).map(|placement| &placement.file) {
        Some(crate::storage::record_store_resources::FileOf::Object(binding)) => Some(binding.as_str()),
        _ => None,
    }
}

/// The one owner rule of the account's own records store: the object index row of the own records' binding named by
/// `own_records_name`. Another record book of the account (an account the Mac app made keeps several) is never it.
pub fn is_own_records(row: &Value, owner_id: &str) -> bool {
    match (own_records_binding(), own_records_name(owner_id)) {
        (Some(binding), Some(name)) => row["binding"] == binding && named(row, &name),
        _ => false,
    }
}

/// The file of the one object of the object index `index` (its text) that `is_own` takes (`is_own_policy`,
/// `is_own_records`), relative to the account folder. None when no row or more than one is taken, or when that row's
/// original id is not 64 hex digits or its file is not a plain relative path. This is the rule `open_source` keeps,
/// for a reader that has only the index text (a computer joining or starting an account's copies).
pub fn own_store_file(index: &str, is_own: impl Fn(&Value) -> bool) -> Option<PathBuf> {
    let mut own = index.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|row| is_own(row));
    let row = own.next()?;
    if own.next().is_some() || !row["originalId"].as_str().is_some_and(|id| hex(id, 64)) {
        return None;
    }
    let path = PathBuf::from(row["sqlite"].as_str()?);
    let plain = !path.as_os_str().is_empty() && path.components().all(|part| matches!(part, Component::Normal(_)));
    plain.then_some(path)
}

fn present(v: &Value) -> bool {
    !v.is_null() && v != &Value::Bool(false) && v != ""
}

#[derive(Clone, PartialEq, Eq)]
struct Inode {
    dev: u64,
    ino: u64,
    uid: u32,
}
impl Inode {
    /// The file's identity, as the computer's owner-only files say it (src/tool_runs/os.rs `OwnerFiles`); a computer
    /// without them cannot say, and the source is unavailable there.
    fn of(m: &Metadata) -> AccountResult<Self> {
        let facts = This::facts(m).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        Ok(Self {
            dev: facts.device,
            ino: facts.inode,
            uid: facts.owner,
        })
    }
    fn check(&self, path: &Path) -> AccountResult<()> {
        let m = fs::symlink_metadata(path).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if !m.is_file() || m.file_type().is_symlink() || self != &Self::of(&m)? {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        Ok(())
    }
}
fn open_regular(path: &Path) -> AccountResult<(File, Inode)> {
    let file = This::open(OpenOptions::new().read(true), path, Open::NO_FOLLOW).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    let m = file.metadata().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    let identity = Inode::of(&m)?;
    if !m.is_file() || identity.uid != This::this_owner().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))? {
        return Err(crate::cause!(AccountError::SourceUnavailable));
    }
    identity.check(path)?;
    Ok((file, identity))
}
fn contained(root: &Path, relative: &Path) -> AccountResult<PathBuf> {
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(crate::cause!(AccountError::InvalidInput));
    }
    let mut path = root.to_path_buf();
    for part in relative.components() {
        path.push(part.as_os_str());
        if fs::symlink_metadata(&path)
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?
            .file_type()
            .is_symlink()
        {
            return Err(crate::cause!(AccountError::SourceUnavailable));
        }
    }
    Ok(path)
}
fn bounded_file(path: &Path, max: usize) -> AccountResult<Zeroizing<Vec<u8>>> {
    bounded_file_generation(path, max).map(|(bytes, _)| bytes)
}
/// `bounded_file`, with the generation of the file the bytes were read from, taken before the read: a file changed
/// during the read has another generation now, so a `witnessed` check reads it again.
fn bounded_file_generation(path: &Path, max: usize) -> AccountResult<(Zeroizing<Vec<u8>>, FixedGeneration)> {
    let (mut file, inode) = open_regular(path)?;
    let before = file.metadata().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    if before.len() > max as u64 {
        return Err(crate::cause!(AccountError::SourceUnavailable));
    }
    let mut bytes = Zeroizing::new(Vec::new());
    (&mut file)
        .take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    let after = file.metadata().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    inode.check(path)?;
    let generation = FixedGeneration::of(&before)?;
    if bytes.len() > max
        || before.len() != after.len()
        || generation.modified != FixedGeneration::of(&after)?.modified
    {
        return Err(crate::cause!(AccountError::SourceChanged));
    }
    Ok((bytes, generation))
}
/// A file's exact OS generation (device, inode, owner, mode, size, modified and changed times): equal only while the
/// file is the same unchanged file. An edit changes `changed` even when it puts `modified` back, so a check that finds
/// the same generation need not read the bytes again.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct FixedGeneration {
    inode: Inode,
    mode: u32,
    bytes: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}
impl FixedGeneration {
    pub(crate) fn of(m: &Metadata) -> AccountResult<Self> {
        let facts = This::facts(m).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        Ok(Self {
            inode: Inode::of(m)?,
            mode: facts.mode,
            bytes: m.len(),
            modified: facts.modified,
            changed: facts.changed,
        })
    }
}
/// One check of the file at `path` against `seen`, the generation it was last read at and matched: a file whose
/// generation by name is `seen` is not read (one `lstat`); any other (changed, replaced, a path redirected through a
/// changed folder, absent, or not yet seen) is read and matched again by `read`, which answers the generation its
/// matching bytes were read at, and that becomes `seen`. So an edit, a replacement or an edit that puts the modified
/// time back (it changes the changed time) is refused by `read` exactly as a check that always read. Answers whether
/// it read.
pub(crate) fn witnessed<E>(
    seen: &mut Option<FixedGeneration>,
    path: &Path,
    read: impl FnOnce() -> Result<FixedGeneration, E>,
) -> Result<bool, E> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && seen.as_ref().is_some_and(|seen| FixedGeneration::of(&m).is_ok_and(|now| *seen == now))) {
        return Ok(false);
    }
    *seen = Some(read()?);
    Ok(true)
}
/// Restore-record/index bytes are pinned once at mount. Later checks use their exact
/// OS generation, without rereading the entire catalogue for every SQL lookup.
pub(crate) struct FixedFile {
    path: PathBuf,
    generation: FixedGeneration,
}
impl FixedFile {
    fn check(&self) -> AccountResult<()> {
        let m = fs::symlink_metadata(&self.path).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if !m.is_file() || FixedGeneration::of(&m)? != self.generation {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        Ok(())
    }
}
fn pinned_bytes(
    path: &Path,
    pin: &FilePin,
    max: usize,
) -> AccountResult<(Zeroizing<Vec<u8>>, FixedFile)> {
    let (file, inode) = open_regular(path)?;
    let generation = FixedGeneration::of(&file.metadata().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?)?;
    let bytes = bounded_file(path, max)?;
    inode.check(path)?;
    if generation != FixedGeneration::of(&file.metadata().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?)?
        || bytes.len() as u64 != pin.bytes
        || blake3::hash(&bytes).to_hex().as_str() != pin.blake3
    {
        return Err(crate::cause!(AccountError::SourceChanged));
    }
    let witness = FixedFile {
        path: path.into(),
        generation,
    };
    witness.check()?;
    Ok((bytes, witness))
}

/// Actual process incarnation, observed without signals or process supervision.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub started_seconds: u64,
    pub started_fraction: u64,
}
impl fmt::Debug for ProcessIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ProcessIdentity([redacted])")
    }
}
struct ObservedLock {
    path: PathBuf,
    inode: Inode,
    bytes: Zeroizing<Vec<u8>>,
    owner: ProcessIdentity,
}
impl ObservedLock {
    fn read(root: &Path, expected: ProcessIdentity) -> AccountResult<Self> {
        let path = root.join("local-runtime.lock");
        let (file, inode) = open_regular(&path)?;
        let m = file.metadata().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if This::facts(&m).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?.mode & 0o777 != 0o600 {
            return Err(crate::cause!(AccountError::SourceUnavailable));
        }
        let bytes = bounded_file(&path, 1024)?;
        let row: Value = serde_json::from_slice(&bytes).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if row["pid"].as_u64() != Some(expected.pid as u64)
            || !row["token"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 128)
            || ProcessIdentity::observe(expected.pid)? != Some(expected)
        {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        Ok(Self {
            path,
            inode,
            bytes,
            owner: expected,
        })
    }
    fn assert_current(&self) -> AccountResult<()> {
        self.inode.check(&self.path)?;
        if bounded_file(&self.path, 1024)?.as_slice() != self.bytes.as_slice()
            || ProcessIdentity::observe(self.owner.pid)? != Some(self.owner)
        {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        Ok(())
    }
}

/// An exact selected current state. The independent restore-record pin is retained by
/// the existing recovery/adoption owner; never computed from untrusted Launch.
pub struct SelectedLocalState {
    pub root: PathBuf,
    pub receipt: FilePin,
    pub app_kv_sqlite: PathBuf,
    pub app_kv_store: String,
    /// All actual prior owned backend incarnations, including its storage child.
    pub prior_processes: Vec<ProcessIdentity>,
}
impl fmt::Debug for SelectedLocalState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SelectedLocalState([redacted])")
    }
}

struct CurrentSqlite {
    connection: crate::sqlite_work::SuppliedConnection,
    path: PathBuf,
    inode: Inode,
    steps: Arc<AtomicU64>,
}
fn check_sqlite_sidecars(path: &Path) -> AccountResult<()> {
    for suffix in ["-wal", "-shm"] {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        match fs::symlink_metadata(PathBuf::from(name)) {
            Ok(m) if m.is_file() && This::this_owner().is_ok_and(|me| This::facts(&m).is_ok_and(|facts| facts.owner == me)) => {}
            Ok(_) => return Err(crate::cause!(AccountError::SourceChanged)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(crate::cause!(AccountError::SourceUnavailable)),
        }
    }
    Ok(())
}
impl CurrentSqlite {
    #[cfg(test)]
    fn open(path: PathBuf) -> AccountResult<Self> {
        Self::open_with_meter(path, crate::sqlite_work::WorkMeter::new())
    }
    fn open_with_meter(path: PathBuf, meter: crate::sqlite_work::WorkMeter) -> AccountResult<Self> {
        let (_file, inode) = open_regular(&path)?;
        check_sqlite_sidecars(&path)?;
        // Ordinary read-only WAL transactions; immutable=1 is intentionally not
        // used for a current working database. No original schema is created.
        let connection = Connection::open_with_flags(
            &crate::storage::sqlite::no_follow_path(&path),
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        // SAFETY: this freshly opened handle has no trace callback or prepared
        // statement. Custody moves with the observer into the selected readers;
        // the authorizer/progress handlers below use separate SQLite hooks.
        let shared_meter = meter.clone();
        let connection =
            unsafe { crate::sqlite_work::ObservedConnection::attach_untraced(connection, meter) }
                .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let connection = crate::sqlite_work::SuppliedConnection::from(connection);
        connection
            .busy_timeout(Duration::from_millis(300))
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        connection
            .pragma_update(None, "query_only", true)
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        connection.set_limit(
            rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
            MAX_JSON as i32,
        );
        let steps = Arc::new(AtomicU64::new(0));
        let progress = steps.clone();
        connection.progress_handler(
            1,
            Some(move || progress.fetch_add(1, Ordering::Relaxed) >= 200_000
                || shared_meter.budget_progress(1) != crate::sqlite_work::BudgetStop::None),
        );
        let current = Self {
            connection,
            path,
            inode,
            steps,
        };
        current.assert_file()?;
        Ok(current)
    }
    fn assert_file(&self) -> AccountResult<()> {
        self.inode.check(&self.path)?;
        check_sqlite_sidecars(&self.path)?;
        // Named metadata can be restored after SQLite opened a replacement.
        // Reuse the physical readonly/HAS_MOVED guard on this retained handle.
        crate::record_source::check_readonly_connection(&self.connection)
            .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))
    }
    fn transaction(&mut self) -> AccountResult<Transaction<'_>> {
        self.assert_file()?;
        self.steps.store(0, Ordering::Relaxed);
        self.connection.transaction().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))
    }
}
/// Same bounded physical KV owner for selected APP and OAuth stores.
/// This supplies bytes/source facts only; callers retain current scope rights.
fn read_kv_source_observed(
    source: &mut CurrentSqlite,
    blob_root: &Path,
    key: &str,
    now: u64,
    maximum: usize,
) -> AccountResult<(Option<Zeroizing<Vec<u8>>>, Option<(FixedFile, Option<u64>)>)> {
    read_kv_source_inner(source, blob_root, key, now, maximum, true)
}
fn read_kv_source_inner(
    source: &mut CurrentSqlite,
    blob_root: &Path,
    key: &str,
    now: u64,
    maximum: usize,
    retain_generation: bool,
) -> AccountResult<(Option<Zeroizing<Vec<u8>>>, Option<(FixedFile, Option<u64>)>)> {
    if maximum == 0 {
        return Err(crate::cause!(AccountError::InvalidInput));
    }
    let tx = source.transaction()?;
    let entry: Option<(String, Option<i64>)> = tx
        .query_row(
            "SELECT blob_id,expiration FROM _mf_entries WHERE key=? LIMIT 1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    let Some((blob, expiration)) = entry else {
        return Ok((None, None));
    };
    if expiration.is_some_and(|at| at < 0 || at as u64 <= now) {
        return Ok((None, None));
    }
    if blob.is_empty() || blob.len() > 256 || !blob.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(crate::cause!(AccountError::SourceUnavailable));
    }
    let path = blob_root.join(blob);
    let observed = if retain_generation {
        let metadata = fs::symlink_metadata(&path).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        Some(FixedFile {
            path: path.clone(),
            generation: FixedGeneration::of(&metadata)?,
        })
    } else {
        None
    };
    let bytes = bounded_file(&path, maximum.min(MAX_JSON))?;
    if let Some(observed) = &observed {
        observed.check()?;
    }
    tx.commit().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    Ok((
        Some(bytes),
        observed.map(|observed| (observed, expiration.map(|at| at as u64))),
    ))
}
fn directory_read(tx: &Transaction<'_>, name: &str) -> AccountResult<Value> {
    let text: Option<String> = tx
        .query_row(
            "SELECT value FROM policy_directory WHERE name=? LIMIT 1",
            [name],
            |r| r.get(0),
        )
        .optional()
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    match text {
        None => Ok(Value::Null),
        Some(text) => {
            let text = Zeroizing::new(text);
            if text.len() > MAX_JSON {
                return Err(crate::cause!(AccountError::SourceUnavailable));
            }
            serde_json::from_str(&text).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))
        }
    }
}

/// One public setting of a restore receipt's environment (`public_environment`): `None` when the receipt is invalid, so
/// the value is unavailable; otherwise the value, or `None` when the receipt names none.
fn public_setting(environment: Option<&BTreeMap<String, String>>, name: &str) -> AccountResult<Option<String>> {
    let environment = environment.ok_or(crate::cause!(AccountError::SourceUnavailable))?;
    Ok(environment.get(name).cloned())
}

/// Existing readRestoredLocalState public environment source. Invalid or absent
/// configuration disables this feature, not unrelated account/session reads.
/// Private references are checked only for source conflicts, never resolved.
fn public_environment(receipt: &Value) -> Option<BTreeMap<String, String>> {
    // Original local base does not define OPERATOR, and restore overlays only
    // these explicit public values plus the separate publisher credential.
    let empty = serde_json::Map::new();
    let map = match receipt.get("environment") {
        None | Some(Value::Null) => &empty,
        Some(Value::Object(map)) => map,
        _ => return None,
    };
    let mut kept = BTreeMap::new();
    for (name, value) in map {
        if !matches!(
            name.as_str(),
            "OPERATOR_ACCOUNT_ID" | "MARKETPLACE_PUBLISHER_ACCOUNT_ID" | "WORKSHOP_IDENTITY"
        ) {
            return None;
        }
        let value = value.as_str().filter(|s| !s.is_empty())?;
        kept.insert(name.clone(), value.to_owned());
    }
    if let Some(private) = receipt.get("bindingCredentials") {
        for (name, reference) in private.as_object()? {
            if name != "MARKETPLACE_PUBLISHER_ACCOUNT_ID" || kept.contains_key(name) {
                return None;
            }
            let reference = reference.as_str()?;
            if reference.is_empty()
                || !reference
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b":_-".contains(&b))
            {
                return None;
            }
        }
    }
    Some(kept)
}

/// The restore record's `rootCredentials`: each Worker root binding the restored account was sealed under, and the
/// name of the credential file that holds it (names only, never a value). A malformed entry is left out, so its root
/// reads as absent.
fn root_credentials(receipt: &Value) -> BTreeMap<String, String> {
    receipt["rootCredentials"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(binding, name)| Some((binding.clone(), name.as_str()?.to_owned())))
        .collect()
}

/// Safe observation of the existing live owner, not a native-account authority.
pub struct LocalAccountObserver {
    sql_work: crate::sqlite_work::WorkMeter,
    selected: SelectedLocalState,
    account: AccountIdentity,
    state_identity: String,
    receipt_file: FixedFile,
    index_file: FixedFile,
    lock: Option<ObservedLock>,
    session: ProtectedBrowserSession,
    session_id: Zeroizing<String>,
    policy: CurrentSqlite,
    kv: CurrentSqlite,
    blob_root: PathBuf,
    last_clock: u64,
    gate_paths: BTreeMap<String, PathBuf>,
    current_gate: Option<(String, CurrentSqlite)>,
    record_book_path: Option<PathBuf>,
    public_environment: Option<BTreeMap<String, String>>,
    root_credentials: BTreeMap<String, String>,
}
impl fmt::Debug for LocalAccountObserver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LocalAccountObserver([redacted])")
    }
}
impl LocalAccountObserver {
    pub fn observe_current(
        selected: SelectedLocalState,
    ) -> AccountResult<Self> {
        Self::open_source(selected, true)
    }
    /// Lend the independently selected original canonical policy's supplier.
    /// The native resource owner keeps its own state lock/inode/generation
    /// witnesses; it never constructs an opener from a moving domain or caller
    /// path. Supplier details stay in the existing storage adapter.
    fn canonical_policy_supply(&self) -> AccountResult<Arc<dyn crate::storage::SelectedSource>> {
        self.policy.assert_file()?;
        let mut bounds = crate::storage::record_store_resources::bounds();
        bounds.spend = crate::storage::sqlite::Spend::WholeHandle;
        bounds.busy = Duration::ZERO;
        Ok(crate::storage::sqlite::selected_source(self.policy.path.clone(),
            "account_policy", bounds, self.sql_work.clone()))
    }

    fn open_source(
        selected: SelectedLocalState,
        observe_old_owner: bool,
    ) -> AccountResult<Self> {
        Self::open_source_with_meter(selected, observe_old_owner, crate::sqlite_work::WorkMeter::new())
    }
    fn open_source_with_meter(
        mut selected: SelectedLocalState,
        observe_old_owner: bool,
        sql_work: crate::sqlite_work::WorkMeter,
    ) -> AccountResult<Self> {
        selected.root = fs::canonicalize(&selected.root).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let receipt_path = selected.root.join("restore-receipt.json");
        let (receipt_bytes, receipt_file) =
            pinned_bytes(&receipt_path, &selected.receipt, MAX_JSON)?;
        let receipt: Value = serde_json::from_slice(&receipt_bytes).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let user = receipt["account"]["userId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(crate::cause!(AccountError::SourceUnavailable))?;
        let owner = receipt["account"]["ownerId"]
            .as_str()
            .filter(|s| hex(s, 64))
            .ok_or(crate::cause!(AccountError::SourceUnavailable))?;
        if receipt["complete"] != true
            || (observe_old_owner && selected.prior_processes.is_empty())
            || selected.prior_processes.len() > 16
        {
            return Err(crate::cause!(AccountError::SourceUnavailable));
        }
        let account = AccountIdentity {
            user_id: user.into(),
            owner_id: owner.into(),
        };
        let index = contained(
            &selected.root,
            Path::new(
                receipt["objects"]["path"]
                    .as_str()
                    .ok_or(crate::cause!(AccountError::SourceUnavailable))?,
            ),
        )?;
        let pin = FilePin {
            bytes: receipt["objects"]["bytes"]
                .as_u64()
                .ok_or(crate::cause!(AccountError::SourceUnavailable))?,
            blake3: receipt["objects"]["fileIdentity"]
                .as_str()
                .ok_or(crate::cause!(AccountError::SourceUnavailable))?
                .into(),
        };
        let (bytes, index_file) = pinned_bytes(&index, &pin, MAX_INDEX)?;
        let mut policy_paths = Vec::new();
        let mut gate_paths = BTreeMap::new();
        let mut record_book_path = None;
        // The account's own records are placed in the file of its own restored object of this binding (`is_own_records`).
        own_records_binding().ok_or(crate::cause!(AccountError::SourceUnavailable))?;
        let mut count = 0u64;
        for line in bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
            count += 1;
            if count > 4096 {
                return Err(crate::cause!(AccountError::SourceUnavailable));
            }
            let row: Value = serde_json::from_slice(line).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            if is_own_records(&row, &account.owner_id) {
                if record_book_path.is_some()
                    || !row["originalId"].as_str().is_some_and(|id| hex(id, 64))
                {
                    return Err(crate::cause!(AccountError::SourceUnavailable));
                }
                record_book_path = Some(contained(
                    &selected.root,
                    Path::new(
                        row["sqlite"]
                            .as_str()
                            .ok_or(crate::cause!(AccountError::SourceUnavailable))?,
                    ),
                )?);
            }
            if row["binding"] == POLICY_BINDING {
                for name in row["names"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    let Some(text) = name.strip_prefix("gate:") else {
                        continue;
                    };
                    let Ok(parts) = serde_json::from_str::<Vec<String>>(text) else {
                        continue;
                    };
                    if parts.len() != 3
                        || parts[0] != account.owner_id
                        || parts[1].is_empty()
                        || parts[1].len() > 256
                        || parts[1].chars().any(char::is_control)
                        || parts[2].is_empty()
                        || parts[2].len() > 512
                        || parts[2].chars().any(char::is_control)
                    {
                        continue;
                    }
                    let path = contained(
                        &selected.root,
                        Path::new(
                            row["sqlite"]
                                .as_str()
                                .ok_or(crate::cause!(AccountError::SourceUnavailable))?,
                        ),
                    )?;
                    if gate_paths.insert(name.to_owned(), path).is_some() {
                        return Err(crate::cause!(AccountError::SourceUnavailable));
                    }
                }
            }
            if is_own_policy(&row, &account.owner_id) {
                if !row["originalId"].as_str().is_some_and(|s| hex(s, 64)) {
                    return Err(crate::cause!(AccountError::SourceUnavailable));
                }
                policy_paths.push(contained(
                    &selected.root,
                    Path::new(
                        row["sqlite"]
                            .as_str()
                            .ok_or(crate::cause!(AccountError::SourceUnavailable))?,
                    ),
                )?);
            }
        }
        if count
            != receipt["objects"]["count"]
                .as_u64()
                .ok_or(crate::cause!(AccountError::SourceUnavailable))?
            || policy_paths.len() != 1
        {
            return Err(crate::cause!(AccountError::SourceUnavailable));
        }
        let lock = if observe_old_owner {
            // The opened account lists every retained process incarnation. Array
            // order is not ownership: match the exact existing lock owner.
            let bytes = bounded_file(&selected.root.join("local-runtime.lock"), 1024)?;
            let row: Value = serde_json::from_slice(&bytes).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            let pid = row["pid"]
                .as_u64()
                .and_then(|p| u32::try_from(p).ok())
                .ok_or(crate::cause!(AccountError::SourceUnavailable))?;
            let mut matches = selected.prior_processes.iter().filter(|p| p.pid == pid);
            let expected = *matches.next().ok_or(crate::cause!(AccountError::SourceChanged))?;
            if matches.next().is_some() {
                return Err(crate::cause!(AccountError::SourceChanged));
            }
            Some(ObservedLock::read(&selected.root, expected)?)
        } else {
            None
        };
        let session = ProtectedBrowserSession::open_existing(&selected.root)?;
        let session_id = session.identity()?;
        let policy = CurrentSqlite::open_with_meter(policy_paths.remove(0), sql_work.clone())?;
        let kv = CurrentSqlite::open_with_meter(
            contained(&selected.root, &selected.app_kv_sqlite)?,
            sql_work.clone(),
        )?;
        if selected.app_kv_store.is_empty()
            || !selected
                .app_kv_store
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err(crate::cause!(AccountError::InvalidInput));
        }
        let blob_root = contained(
            &selected.root,
            &PathBuf::from("storage/kv")
                .join(&selected.app_kv_store)
                .join("blobs"),
        )?;
        let state_identity = selected.receipt.blake3.clone();
        let public_environment = public_environment(&receipt);
        let root_credentials = root_credentials(&receipt);
        let observed = Self {
            sql_work,
            selected,
            account,
            state_identity,
            receipt_file,
            index_file,
            lock,
            session,
            session_id,
            policy,
            kv,
            blob_root,
            last_clock: 1,
            gate_paths,
            current_gate: None,
            record_book_path,
            public_environment,
            root_credentials,
        };
        if observe_old_owner {
            observed.assert_observed()?;
        } else {
            observed.assert_files()?;
        }
        Ok(observed)
    }
    pub fn state_identity(&self) -> &str {
        &self.state_identity
    }
    pub fn session_identity(&self) -> Zeroizing<String> {
        Zeroizing::new(self.session_id.to_string())
    }
    fn clock(&mut self) -> AccountResult<u64> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?
            .as_millis();
        let now = u64::try_from(now).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if now < self.last_clock || now > MAX_SAFE {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        self.last_clock = now;
        Ok(now)
    }
    fn assert_files(&self) -> AccountResult<()> {
        self.receipt_file.check()?;
        self.index_file.check()?;
        self.session.assert_token_current()?;
        self.policy.assert_file()?;
        self.kv.assert_file()?;
        if let Some((_, gate)) = &self.current_gate {
            gate.assert_file()?;
        }
        Ok(())
    }
    pub fn assert_observed(&self) -> AccountResult<()> {
        self.lock
            .as_ref()
            .ok_or(crate::cause!(AccountError::SourceUnavailable))?
            .assert_current()?;
        self.assert_files()
    }
    fn read_kv(&mut self, key: &str, now: u64) -> AccountResult<Option<Value>> {
        self.read_kv_bytes(key, now)?
            .map(|bytes| serde_json::from_slice(&bytes).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error)))
            .transpose()
    }
    // Reuse the exact selected store/expiry/blob custody for byte-part
    // consumers. Parts may split JSON tokens; parsing belongs after bounded
    // concatenation and content-identity verification, not at each blob edge.
    fn read_kv_bytes(&mut self, key: &str, now: u64) -> AccountResult<Option<Zeroizing<Vec<u8>>>> {
        self.read_kv_bytes_bounded(key, now, MAX_JSON)
    }
    fn read_kv_bytes_bounded(
        &mut self,
        key: &str,
        now: u64,
        maximum: usize,
    ) -> AccountResult<Option<Zeroizing<Vec<u8>>>> {
        read_kv_source_inner(&mut self.kv, &self.blob_root, key, now, maximum, false)
            .map(|(bytes, _)| bytes)
    }
    /// The same existing bounded KV read, with the physical facts it already
    /// observed retained for a caller's last-chunk witness. No extra SQL or
    /// alternate KV decoder is used. Expired/absent points carry no blob grant.
    fn read_kv_bytes_bounded_observed(
        &mut self,
        key: &str,
        now: u64,
        maximum: usize,
    ) -> AccountResult<(Option<Zeroizing<Vec<u8>>>, Option<(FixedFile, Option<u64>)>)> {
        read_kv_source_observed(&mut self.kv, &self.blob_root, key, now, maximum)
    }
    fn gate_paused(&mut self, name: &str, sign_in: &str, resource: &str) -> AccountResult<bool> {
        let Some(path) = self.gate_paths.get(name) else {
            // An unmaterialized gate has no retained gate-local pause. The
            // canonical directory's current update/erasure checks still apply.
            return Ok(false);
        };
        if self
            .current_gate
            .as_ref()
            .is_none_or(|(key, _)| key != name)
        {
            self.current_gate = Some((
                name.into(),
                CurrentSqlite::open_with_meter(path.clone(), self.sql_work.clone())?,
            ));
        }
        let tx = self
            .current_gate
            .as_mut()
            .ok_or(crate::cause!(AccountError::SourceUnavailable))?
            .1
            .transaction()?;
        let identity = directory_read(&tx, "identity")?;
        if identity != json!({"owner":self.account.owner_id,"sign_in":sign_in,"resource":resource})
        {
            return Err(crate::cause!(AccountError::RightsRefused));
        }
        let paused = present(&directory_read(&tx, "fence")?);
        tx.commit().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        Ok(paused)
    }
}

/// The owner's startup lock (`state_lock_recovery::StateLockFile`): held under `flock` for this owner's whole life, its
/// record names this process and carries a fresh token. A clean end removes the file; any other end leaves only a
/// stale record, which the next claim takes over because the kernel has released the lock.
struct ExistingStateLock {
    lock: state_lock_recovery::StateLockFile,
    bytes: Zeroizing<Vec<u8>>,
    /// The generation the state lock was last read at and found its own bytes (`witnessed`).
    seen: Mutex<Option<FixedGeneration>>,
}
impl ExistingStateLock {
    fn acquire(lock: state_lock_recovery::StateLockFile, binding: &state_lock_recovery::OwnerBinding) -> AccountResult<Self> {
        use ring::rand::{SecureRandom, SystemRandom};
        let mut random = [0u8; 16];
        SystemRandom::new().fill(&mut random).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        random[6] = (random[6] & 15) | 64;
        random[8] = (random[8] & 63) | 128;
        let token: String = random
            .iter()
            .enumerate()
            .map(|(i, b)| {
                format!(
                    "{}{:02x}",
                    if matches!(i, 4 | 6 | 8 | 10) { "-" } else { "" },
                    b
                )
            })
            .collect();
        let mut row = json!({"pid":std::process::id(),"token":token});
        binding.bind(&mut row)?;
        let bytes = Zeroizing::new(serde_json::to_vec(&row).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?);
        Self::write_new(lock, bytes, |file, bytes| {
            file.write_all(bytes).and_then(|_| file.sync_all())
        })
    }
    fn write_new(
        mut lock: state_lock_recovery::StateLockFile,
        bytes: Zeroizing<Vec<u8>>,
        write: impl FnOnce(&mut File, &[u8]) -> std::io::Result<()>,
    ) -> AccountResult<Self> {
        lock.write(&bytes, write)?;
        Ok(Self {
            lock,
            bytes,
            seen: Mutex::default(),
        })
    }
    fn assert_current(&self) -> AccountResult<()> {
        // The same generation as when it last held its own bytes is the same unchanged state lock (`witnessed`).
        let mut seen = self.seen.lock().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        witnessed(&mut seen, self.lock.path(), || {
            self.lock.inode().check(self.lock.path())?;
            let (bytes, generation) = bounded_file_generation(self.lock.path(), 1024)?;
            if bytes.as_slice() != self.bytes.as_slice() {
                return Err(crate::cause!(AccountError::SourceChanged));
            }
            Ok(generation)
        })?;
        Ok(())
    }
}
impl Drop for ExistingStateLock {
    fn drop(&mut self) {
        // The name goes while the lock is still held; the lock is released after, when `lock` drops.
        if self.assert_current().is_ok() {
            let _ = fs::remove_file(self.lock.path());
        }
    }
}

/// The concrete owner after actual controlled handoff. Its reads remain current
/// ordinary SQLite/WAL transactions against the SAME mutable original schemas.
/// One request's carried account witness: off outside a request, open until a full check passes, then passed until
/// the request ends or a check finds a change.
#[derive(Clone, Default)]
struct CarriedWitness(Arc<std::sync::atomic::AtomicU8>);
const CARRY_OFF: u8 = 0;
const CARRY_OPEN: u8 = 1;
const CARRY_PASSED: u8 = 2;
impl CarriedWitness {
    fn passed(&self) -> bool {
        self.0.load(Ordering::Acquire) == CARRY_PASSED
    }
    fn clear(&self) {
        let _ = self.0.compare_exchange(CARRY_PASSED, CARRY_OPEN, Ordering::AcqRel, Ordering::Acquire);
    }
    fn pass(&self) {
        let _ = self.0.compare_exchange(CARRY_OPEN, CARRY_PASSED, Ordering::AcqRel, Ordering::Acquire);
    }
    fn open(&self) -> CarriedRequest {
        self.0.store(CARRY_OPEN, Ordering::Release);
        CarriedRequest(self.0.clone())
    }
}
/// A request that carries the account witness (`LocalAccount::carry_witness`); dropping it ends the carry.
pub(crate) struct CarriedRequest(Arc<std::sync::atomic::AtomicU8>);
impl Drop for CarriedRequest {
    fn drop(&mut self) {
        self.0.store(CARRY_OFF, Ordering::Release);
    }
}
#[cfg(test)]
mod carried_witness_tests {
    use super::*;
    #[allow(unused_imports)]
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    #[test]
    fn a_pass_is_carried_only_inside_a_request_and_only_until_a_check_finds_a_change() {
        let carried = CarriedWitness::default();
        carried.pass();
        assert!(!carried.passed(), "outside a request nothing is carried");
        let request = carried.open();
        assert!(!carried.passed(), "a request starts with no passed check");
        carried.pass();
        assert!(carried.passed());
        carried.clear();
        assert!(!carried.passed(), "a full check that has begun is not carried until it passes");
        carried.pass();
        drop(request);
        assert!(!carried.passed(), "the next request checks in full again");
    }
}
pub struct LocalAccount {
    // Drop the writable resources before releasing the state lock.
    /// The record book handle its commands borrow (`own_writer`, `record_store_resources::Writer`).
    writer: Option<std::sync::Arc<crate::storage::record_store_resources::Writer>>,
    /// The primary physical writer's existing connection/search cache, retained by the account across request-owned
    /// contexts. Admission owners share this lazy pointer but keep `writer` empty and never borrow its connection.
    primary_writer: Arc<std::sync::OnceLock<Arc<crate::storage::record_store_resources::Writer>>>,
    /// Request owners share bounded per-domain handles; creating another
    /// command context never creates another resource registry.
    domain_resources: Arc<std::sync::OnceLock<Arc<crate::storage::record_store_resources::StateResources>>>,
    /// The account witness carried through one request (`carry_witness`).
    carried: CarriedWitness,
    own_records: Option<own_records::OwnRecords>,
    /// What the last refused record write named (`record_writer::Error::OutsideChoices`), until its caller takes it.
    write_refusal: Option<record_writer::Named>,
    /// Read-only handles of the record book for the workspace store's reads, opened on first use (`store_read`): an
    /// owner that holds no writer (the rights-check owner) reads through them too.
    store_readers: Option<Arc<crate::storage::record_store_resources::Readers>>,
    workspace_heads: Option<live_heads::SelectedLiveHeads>,
    source: LocalAccountObserver,
    /// Shared with this account's rights-check owner (`admission_owner`), which holds no writer of its own.
    state_lock: Arc<ExistingStateLock>,
}
impl fmt::Debug for LocalAccount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LocalAccount([redacted])")
    }
}
impl LocalAccount {
    /// The account's own records store file (its RecordBook), when the account's objects name one.
    pub(crate) fn records_file(&self) -> Option<PathBuf> {
        self.source.record_book_path.clone()
    }
    /// A reader of the account's own `account_policy.access` (its `policy-source:account` part's `access`: the
    /// capabilities and limits its plan and contracts give, as old trillion's payment fold left them), read fresh from
    /// the same policy database on each call. Null when the part names none.
    pub(crate) fn access_reader(&self) -> crate::account::account_routes::AccessReader {
        let path = self.source.policy.path.clone();
        Arc::new(move || {
            let mut policy = CurrentSqlite::open_with_meter(path.clone(), crate::sqlite_work::WorkMeter::new()).map_err(|error| AccountError::SourceUnavailable(error.cause()))?;
            let tx = policy.transaction().map_err(|error| AccountError::SourceUnavailable(error.cause()))?;
            let account = directory_read(&tx, "policy-source:account").map_err(|error| AccountError::SourceUnavailable(error.cause()))?;
            Ok(account.get("access").cloned().unwrap_or(Value::Null))
        })
    }
    /// Cold start/restart under the local-runtime.lock startup lock.
    /// `selected` supplies the independently retained opened account; acquiring this
    /// state lock grants no account rights. A crashed owner's lock is taken over;
    /// live or changed owners remain refused.
    pub fn open_selected_after_handoff(
        mut selected: SelectedLocalState,
    ) -> AccountResult<Self> {
        selected.root = fs::canonicalize(&selected.root).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if !selected.root.is_dir() || selected.prior_processes.len() > 16 {
            return Err(crate::cause!(AccountError::InvalidInput));
        }
        let mut pids = std::collections::HashSet::new();
        for old in &selected.prior_processes {
            if !pids.insert(old.pid) || ProcessIdentity::observe(old.pid)? == Some(*old) {
                return Err(crate::cause!(AccountError::SourceChanged));
            }
        }
        // Obtain exclusive original-owner custody BEFORE opening current state.
        // Any refusal below drops only this exact newly-written state lock.
        let state_lock = state_lock_recovery::with_selected_claim(
            &selected.root,
            &selected.receipt,
            &selected.prior_processes,
            |binding, lock| ExistingStateLock::acquire(lock, binding),
        )?;
        let source = LocalAccountObserver::open_source(selected, false)?;
        let owner = Self {
            writer: None,
            primary_writer: Arc::new(std::sync::OnceLock::new()),
            domain_resources: Arc::new(std::sync::OnceLock::new()),
            carried: Default::default(),
            own_records: None,
            write_refusal: None,
            store_readers: None,
            workspace_heads: None,
            source,
            state_lock: Arc::new(state_lock),
        };
        owner.assert_owned()?;
        Ok(owner)
    }
    /// A second owner of this same account only for checking rights: a read-only observer of its own over the same
    /// selected files (`LocalAccountObserver::open_source`), under this owner's state lock. The rights check reads the session
    /// and its gate and writes nothing (a key's sign-in use note is deferred, `defers_use_note`), so checking a
    /// browser's or an AI key's rights never waits on this owner's writer (a page write or a long read holding it).
    /// Every write is admitted again by this owner when it commits.
    pub fn admission_owner(&self) -> AccountResult<Self> {
        self.reopen_under_state_lock()
    }
    /// A request-owned command context of the same selected account. It shares the retained state lock and the
    /// primary physical writer's existing connection/search cache, but no mutable reader or carried request witness. The command still checks current selection,
    /// caller rights and its physical source at admission, effect, commit and result disclosure; this constructor
    /// grants no right to write. Independent commands need no hold of the account that supplied this context.
    pub(crate) fn command_owner(&self) -> AccountResult<Self> {
        let mut owner = self.reopen_under_state_lock()?;
        owner.writer = Some(self.shared_primary_writer().map_err(|error| AccountError::SourceUnavailable(error.cause()))?);
        Ok(owner)
    }
    /// Retain the primary file's existing Writer owner across independent commands. Initializing this pointer opens
    /// no file and takes no write reservation. Writer::lend checks the file identity and holds its kept-handle mutex
    /// only while taking a handle; command I/O and authorization callbacks run outside it.
    pub(crate) fn shared_primary_writer(&self) -> Result<Arc<crate::storage::record_store_resources::Writer>, crate::records::Error> {
        let path = self.source.record_book_path.as_ref().ok_or(crate::cause!(crate::records::Error::Unavailable))?;
        let writer = self.primary_writer.get_or_init(|| Arc::new(crate::storage::record_store_resources::Writer::new(
            path.clone(), self.source.sql_work.clone(), crate::record_log::MAX_JOURNAL_BYTES as i32,
        )));
        if writer.path() != path { return Err(crate::cause!(crate::records::Error::Unavailable)); }
        Ok(writer.clone())
    }
    /// Reopen the same read-only source observer under its existing state lock. Writable storage belongs to the
    /// command's separately admitted physical writer, never to the observer or the admission owner's mutex.
    fn reopen_under_state_lock(&self) -> AccountResult<Self> {
        let selected = &self.source.selected;
        let selected = SelectedLocalState {
            root: selected.root.clone(),
            receipt: selected.receipt.clone(),
            app_kv_sqlite: selected.app_kv_sqlite.clone(),
            app_kv_store: selected.app_kv_store.clone(),
            prior_processes: selected.prior_processes.clone(),
        };
        let source = LocalAccountObserver::open_source_with_meter(
            selected, false, self.source.sql_work.fork(),
        )?;
        if source.state_identity() != self.source.state_identity() || source.account != self.source.account {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        let owner = Self {
            writer: None,
            primary_writer: self.primary_writer.clone(),
            domain_resources: self.domain_resources.clone(),
            carried: Default::default(),
            own_records: None,
            write_refusal: None,
            store_readers: None,
            workspace_heads: None,
            source,
            state_lock: self.state_lock.clone(),
        };
        owner.assert_owned()?;
        Ok(owner)
    }
    pub fn adopt_after_handoff(source: LocalAccountObserver) -> AccountResult<Self> {
        // No signals, stop commands, state lock minting for an immutable snapshot, or
        // unverified takeover. The existing recovery owner requires exact
        // selected state and a proved retired process incarnation.
        for old in &source.selected.prior_processes {
            if ProcessIdentity::observe(old.pid)? == Some(*old) {
                return Err(crate::cause!(AccountError::SourceChanged));
            }
        }
        source.assert_files()?;
        let state_lock = state_lock_recovery::with_selected_claim(
            &source.selected.root,
            &source.selected.receipt,
            &source.selected.prior_processes,
            |binding, lock| ExistingStateLock::acquire(lock, binding),
        )?;
        let owner = Self {
            writer: None,
            primary_writer: Arc::new(std::sync::OnceLock::new()),
            domain_resources: Arc::new(std::sync::OnceLock::new()),
            carried: Default::default(),
            own_records: None,
            write_refusal: None,
            store_readers: None,
            workspace_heads: None,
            source,
            state_lock: Arc::new(state_lock),
        };
        owner.assert_owned()?;
        Ok(owner)
    }
    /// The state lock and the account's files are the exact ones this account opened. Inside a request that carries the
    /// witness (`carry_witness`), a check after the first one that passed answers from it; a command's own
    /// boundaries still check in full (`assert_owned_now`).
    fn assert_owned(&self) -> AccountResult<()> {
        if self.carried.passed() {
            return Ok(());
        }
        self.assert_owned_now()
    }
    /// The full check of the state lock and the account's files, whether or not a witness is carried; a pass is carried
    /// for the rest of the request.
    fn assert_owned_now(&self) -> AccountResult<()> {
        self.carried.clear();
        self.state_lock.assert_current()?;
        self.source.assert_files()?;
        self.carried.pass();
        Ok(())
    }
    /// Carry the account witness through one request: until the answer drops, a check that follows a passed full
    /// check (the first in the request, or a command boundary's) is not repeated. Without it every check is full.
    pub(crate) fn carry_witness(&self) -> CarriedRequest {
        self.carried.open()
    }
    pub fn state_identity(&self) -> &str {
        self.source.state_identity()
    }
    /// The account's state folder: where its installed tools, and so its record model, are found
    /// (record_model_policy `installed`).
    pub(crate) fn state_root(&self) -> &Path {
        &self.source.selected.root
    }
    pub fn session_identity(&self) -> Zeroizing<String> {
        self.source.session_identity()
    }
    /// Actual SQL on all selected current handles, including policy/session,
    /// canonical records, and the separate record store own-records connection once opened.
    /// These units are not provider billing or disk I/O.
    pub fn sql_work(&self) -> Result<crate::sqlite_work::Observation, crate::sqlite_work::Error> {
        self.source.sql_work.snapshot()
    }
    /// Count one complete caller operation across this account's request contexts.
    pub fn begin_sql_observation(&self) -> Result<crate::sqlite_work::ObservationWindow, crate::sqlite_work::Error> {
        self.source.sql_work.account_view().begin_observation()
    }


    /// Enable SQL template attribution only for a selected synthetic or copied
    /// fixture before its measured operation. Production builds omit this API.
    ///
    /// # Safety
    /// The caller must prove the selected account is an isolated fixture, with
    /// no live customer traffic or secret-bearing SQL literals in its trace.
    #[cfg(feature = "sql-statement-attribution")]
    pub unsafe fn enable_fixture_sql_attribution(
        &self,
        capacity: usize,
    ) -> Result<crate::sqlite_work::WorkMeter, crate::sqlite_work::Error> {
        let meter = self.source.sql_work.clone();
        unsafe { meter.enable_fixture_statement_attribution(capacity)?; }
        Ok(meter)
    }

    /// Complete account fixture attribution, separate from local source witnesses.
    /// # Safety
    /// Every account context and its SQL literals must be exclusively synthetic.
    #[cfg(feature = "sql-statement-attribution")]
    pub unsafe fn enable_account_fixture_sql_attribution(&self, capacity: usize) -> Result<crate::sqlite_work::WorkMeter, crate::sqlite_work::Error> {
        let meter = self.source.sql_work.account_view();
        unsafe { meter.enable_fixture_statement_attribution(capacity)?; }
        Ok(meter)
    }

    /// Project only the explicit viewer control from the SAME gate just
    /// admitted for this ordinary browser. No clone or second policy query.
    pub fn startup_viewer_state(
        &mut self,
        session_id: &str,
    ) -> AccountResult<crate::workspace_startup::ViewerState> {
        let (admission, gate) = self.current_window_with_policy(session_id)?;
        let client_programs = gate
            .snapshot
            .get("account_controls")
            .and_then(Value::as_object)
            .and_then(|controls| controls.get("client_programs"))
            .cloned();
        self.assert_owned()?;
        Ok(crate::workspace_startup::ViewerState {
            admission,
            client_programs,
        })
    }

    /// Exact selected public restore-record values only. An invalid restore receipt is unavailable; a valid one that
    /// names no such value proves its absence (the original local base defines none of them, see `public_environment`).
    /// This method never reads shell environment or any credential value.
    pub fn startup_service_setting(&self, name: &str) -> AccountResult<Option<String>> {
        self.assert_owned()?;
        let value = public_setting(self.source.public_environment.as_ref(), name)?;
        self.assert_owned()?;
        Ok(value)
    }

    /// One record's stored form from the account's own records (record store), read under
    /// the browser's current rights check and snapshot witness. This is not a
    /// decrypted value or a public response; the logical consumer still owns
    /// key/erasure resolution and disclosure.
    pub fn current_stored_record(
        &mut self,
        session_id: &str,
        id: &str,
        cancel: Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<Option<crate::legacy_records::StoredRecord>, crate::records::Error> {
        self.with_own_records(session_id, cancel, |records| records.stored(id))
    }

    /// Live ids of one record type (under an optional id prefix), newest id
    /// first, from the account's own records (record store), read under the browser's
    /// current rights check and snapshot witness.
    pub fn current_record_ids(
        &mut self,
        session_id: &str,
        record_type: &str,
        prefix: &str,
        before: Option<&str>,
        limit: usize,
        cancel: Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<crate::storage::record_store::native::TypeIds, crate::records::Error> {
        self.with_own_records(session_id, cancel, |records| records.ids_of_type(record_type, prefix, before, limit))
    }

    /// Every live id of one record type, newest first, read page by page in
    /// one admitted snapshot; refused when there are more than `most`, so a
    /// caller that needs the whole set never answers with part of it.
    pub fn current_record_ids_complete(
        &mut self,
        session_id: &str,
        record_type: &str,
        most: usize,
        cancel: Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<Vec<String>, crate::records::Error> {
        self.with_own_records(session_id, cancel, |records| {
            let mut ids = Vec::new();
            let mut before = None;
            loop {
                let page = records.ids_of_type(record_type, "", before.as_deref(), crate::records::MAX_PAGE_ITEMS)?;
                ids.extend(page.ids);
                if ids.len() > most {
                    return Err(crate::records::Error::Invalid("more ids than the read keeps", crate::cause!()));
                }
                match page.next {
                    Some(next) => before = Some(next),
                    None => return Ok(ids),
                }
            }
        })
    }

    fn current_record_source<'a>(
        &'a mut self,
        session_id: &'a str,
        cancel: Arc<std::sync::atomic::AtomicBool>,
    ) -> crate::legacy_records::Result<
        crate::record_source::SnapshotRecordSql<WorkspaceReadWitness<'a>>,
    > {
        let path = self
            .source
            .record_book_path
            .clone()
            .ok_or(crate::cause!(crate::legacy_records::Error::Source))?;
        self.current_record_source_at(session_id, path, cancel)
    }
    // Private source opener reused only after the selected inventory owner
    // qualifies an exact resource path. No public caller supplies this path.
    fn current_record_source_at<'a>(
        &'a mut self,
        session_id: &'a str,
        path: PathBuf,
        cancel: Arc<std::sync::atomic::AtomicBool>,
    ) -> crate::legacy_records::Result<
        crate::record_source::SnapshotRecordSql<WorkspaceReadWitness<'a>>,
    > {
        use crate::legacy_records::Error;
        if cancel.load(Ordering::Acquire) {
            return Err(crate::cause!(Error::Source));
        }
        let admitted =
            crate::account::current_browser(self, session_id).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        self.current_record_source_at_admitted(session_id, path, admitted, cancel)
    }
    // Reuse the rights check already captured by a direct logical operation.
    // SnapshotRecordSql::begin still freshly checks that exact witness before
    // any query; finish checks it again before the provisional value escapes.
    fn current_record_source_at_admitted<'a>(
        &'a mut self,
        session_id: &'a str,
        path: PathBuf,
        admitted: crate::account::BrowserAdmission,
        cancel: Arc<std::sync::atomic::AtomicBool>,
    ) -> crate::legacy_records::Result<
        crate::record_source::SnapshotRecordSql<WorkspaceReadWitness<'a>>,
    > {
        self.current_record_source_limited(session_id, path, admitted, crate::import::ReadLimits::default(), cancel)
    }
    // The same admitted snapshot with the caller's physical read limits (the
    // own-records migration reads whole checkpoint pages through it).
    fn current_record_source_limited<'a>(
        &'a mut self,
        session_id: &'a str,
        path: PathBuf,
        admitted: crate::account::BrowserAdmission,
        limits: crate::import::ReadLimits,
        cancel: Arc<std::sync::atomic::AtomicBool>,
    ) -> crate::legacy_records::Result<
        crate::record_source::SnapshotRecordSql<WorkspaceReadWitness<'a>>,
    > {
        use crate::{legacy_records::Error, record_source::SnapshotRecordSql};
        if cancel.load(Ordering::Acquire) {
            return Err(crate::cause!(Error::Source));
        }
        let CurrentSqlite {
            connection,
            path,
            inode,
            ..
        } = CurrentSqlite::open_with_meter(path, self.source.sql_work.clone())
            .map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let witness = WorkspaceReadWitness {
            owner: std::cell::RefCell::new(self),
            session_id,
            admitted,
            path,
            inode,
        };
        SnapshotRecordSql::begin(connection, limits, witness, cancel)
            .map_err(|error| crate::carry_cause!(Error::Source, error))
    }

    /// The window's rights check, and the account's own policy for the window's
    /// screens (access, allowances, client programs). The policy is read here
    /// only for what those screens project; it does not admit the window.
    pub(crate) fn current_window_with_policy(
        &mut self,
        session_id: &str,
    ) -> AccountResult<(crate::account::BrowserAdmission, NativeGateView)> {
        let admitted = crate::account::current_browser(self, session_id)?;
        let gate = self.gate_for_resource(
            &format!("session:{session_id}"),
            crate::account::BROWSER_RESOURCE,
        )?;
        Ok((admitted, gate))
    }

    fn gate_for_resource(
        &mut self,
        sign_in: &str,
        resource: &str,
    ) -> AccountResult<NativeGateView> {
        self.assert_owned()?;
        let name =
            serde_json::to_string(&[self.source.account.owner_id.as_str(), sign_in, resource])
                .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let gate_name = format!("gate:{name}");
        let paused = self.source.gate_paused(&gate_name, sign_in, resource)?;
        let tx = self.source.policy.transaction()?;
        let revision = directory_read(&tx, "revision")?;
        let epoch = if revision.is_null() {
            0
        } else {
            revision
                .as_u64()
                .filter(|v| *v <= MAX_SAFE)
                .ok_or(crate::cause!(AccountError::SourceUnavailable))?
        };
        let changing = present(&directory_read(&tx, "update")?)
            || present(&directory_read(&tx, "account-erasure-continuation")?);
        let own_source = directory_read(&tx, POLICY_SOURCE_FACT)?;
        let mut snapshot = if !own_source.is_null() {
            let account = directory_read(&tx, "policy-source:account")?;
            let row = directory_read(&tx, &format!("policy-source:sign-in:{sign_in}"))?;
            if !account["lifecycle"].is_object() {
                return Err(crate::cause!(AccountError::SourceUnavailable));
            }
            let mut snapshot = account.clone();
            snapshot["sign_ins"] = json!({sign_in:if row.is_null(){json!({})}else{row}});
            snapshot
        } else {
            let cached = directory_read(&tx, &format!("source-snapshot:{sign_in}"))?;
            if cached["revision"].as_u64() != Some(epoch) || !cached["snapshot"].is_object() {
                return Err(crate::cause!(AccountError::SourceUnavailable));
            }
            // Exact existing current-revision publication, as gateSourceSnapshot;
            // never a new empty snapshot or a fabricated PersonStore answer.
            cached["snapshot"].clone()
        };
        if !snapshot["lifecycle"].is_object() || !snapshot["sign_ins"].is_object() {
            return Err(crate::cause!(AccountError::SourceUnavailable));
        }
        snapshot["epoch"] = json!(epoch);
        tx.commit().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        self.assert_owned()?;
        Ok(NativeGateView {
            owner_id: self.source.account.owner_id.clone(),
            gate_name,
            snapshot,
            epoch,
            updating: changing,
            paused,
            authoritative_last_used: None,
        })
    }
}

/// This short-lived witness borrows the SAME exclusively mounted account. It
/// cannot outlive the state lock or authorize a historical restored copy.
struct WorkspaceReadWitness<'a> {
    owner: std::cell::RefCell<&'a mut LocalAccount>,
    session_id: &'a str,
    admitted: crate::account::BrowserAdmission,
    path: PathBuf,
    inode: Inode,
}
impl crate::workspace_store::Source for WorkspaceReadWitness<'_> {
    fn assert_current(&self) -> Result<(), crate::workspace_store::Kind> {
        use crate::workspace_store::Kind;
        self.inode
            .check(&self.path)
            .map_err(|error| Kind::SourceChanged(error.cause()))?;
        check_sqlite_sidecars(&self.path).map_err(|error| Kind::SourceChanged(error.cause()))?;
        let mut owner = self
            .owner
            .try_borrow_mut()
            .map_err(|error| crate::carry_cause!(Kind::SourceUnavailable, error))?;
        let current = crate::account::current_browser_read_only(&mut **owner, self.session_id)
            .map_err(|error| Kind::SourceChanged(error.cause()))?;
        if current.account != self.admitted.account || !self.admitted.still() {
            return Err(crate::cause!(Kind::SourceChanged));
        }
        Ok(())
    }
}
impl crate::record_source::RecordSourceWitness for WorkspaceReadWitness<'_> {
    fn assert_current(&mut self) -> crate::import::ImportResult<()> {
        crate::workspace_store::Source::assert_current(self).map_err(|_| {
            crate::import::ImportError::Refused(
                "selected current record source changed or unavailable",
             crate::cause!())
        })
    }
    fn assert_query_source(&mut self) -> crate::import::ImportResult<()> {
        // This witness is private and borrows the sole LocalAccount throughout
        // one read. Queries cannot disclose or execute effects; all secrets
        // remain provisional until finish freshly rechecks browser generation,
        // policy epoch and session. Repeating that SQL around every internal
        // query granted no additional disclosure protection.

        self.inode.check(&self.path).map_err(|_refusal_source| crate::import::ImportError::Refused("selected current record custody changed", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: crate::import::ImportError::Refused))))?;
        check_sqlite_sidecars(&self.path).map_err(|_refusal_source| crate::import::ImportError::Refused("selected current record custody changed", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: crate::import::ImportError::Refused))))?;
        self.owner
            .try_borrow()
            .map_err(|_| {
                crate::import::ImportError::Refused("selected current record owner borrowed", crate::cause!())
            })?
            .assert_owned()
            .map_err(|_refusal_source| crate::import::ImportError::Refused("selected current record custody changed", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: crate::import::ImportError::Refused))))
    }
}
impl NativeAccountOwner for LocalAccount {
    fn resource_connection_key(&mut self,session:&str,key:&crate::account::SecretNativeKey)->AccountResult<Option<crate::account::SecretResourceKey>> {self.enroll_native_resource_key(session,key,&||Ok(()))}

    fn account(&self) -> AccountIdentity {
        self.source.account.clone()
    }
    fn now_ms(&mut self) -> AccountResult<u64> {
        self.assert_owned()?;
        self.source.clock()
    }
    fn assert_source_current(&mut self) -> AccountResult<()> {
        self.assert_owned()
    }
}

#[cfg(test)]
impl LocalAccount {
    /// The personal key row `digest` names now. The write tests use it as the admission stand-in that refuses once
    /// the key is withdrawn; production reads a key through the sign-in (src/account/sign_in/keys.rs), not here.
    pub(crate) fn personal_key(&mut self, digest: &str) -> AccountResult<Option<Value>> {
        self.assert_owned()?;
        if !hex(digest, 64) {
            return Err(crate::cause!(AccountError::InvalidInput));
        }
        let now = self.source.clock()?;
        self.source.read_kv(&format!("personal-key:{digest}"), now)
    }
}

#[cfg(test)]
mod current_sqlite_tests {
    use super::*;
    #[allow(unused_imports)]
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    #[test]
    fn restored_directory_cannot_admit_a_different_current_account_sqlite_handle() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let selected = root.join("selected");
        let replacement = root.join("replacement");
        let held = root.join("held");
        for (directory, value) in [(&selected, "original"), (&replacement, "decoy")] {
            fs::create_dir(directory).unwrap();
            let db = Connection::open(directory.join("policy.sqlite")).unwrap();
            db.execute_batch(
                "CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL)",
            )
            .unwrap();
            db.execute(
                "INSERT INTO policy_directory VALUES('synthetic-marker',?)",
                [serde_json::to_string(value).unwrap()],
            )
            .unwrap();
            db.close().unwrap();
        }
        let path = selected.join("policy.sqlite");
        let (_original_file, inode) = open_regular(&path).unwrap();
        let stamp = |m: Metadata| {
            (
                m.dev(),
                m.ino(),
                m.len(),
                m.mtime(),
                m.mtime_nsec(),
                m.ctime(),
                m.ctime_nsec(),
            )
        };
        let before = stamp(fs::metadata(&path).unwrap());
        let bytes_before = fs::read(&path).unwrap();
        // Reproduce the verify -> SQLite-open interval with physical renames.
        // Construct the actual private consumer at its completed-open boundary;
        // no production callback or public unchecked constructor is introduced.
        fs::rename(&selected, &held).unwrap();
        fs::rename(&replacement, &selected).unwrap();
        let wrong = Connection::open_with_flags(
            &crate::storage::sqlite::no_follow_path(&path),
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .unwrap();
        assert_eq!(
            wrong
                .query_row("SELECT value FROM policy_directory", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "\"decoy\""
        );
        fs::rename(&selected, &replacement).unwrap();
        fs::rename(&held, &selected).unwrap();
        assert_eq!(before, stamp(fs::metadata(&path).unwrap()));
        assert_eq!(bytes_before, fs::read(&path).unwrap());
        inode.check(&path).unwrap();
        check_sqlite_sidecars(&path).unwrap();
        let mut current = CurrentSqlite {
            connection: wrong.into(),
            path: path.clone(),
            inode,
            steps: Arc::new(AtomicU64::new(0)),
        };
        assert!(matches!(current.assert_file(), Err(AccountError::SourceChanged(_))));
        assert!(matches!(
            current.transaction(),
            Err(AccountError::SourceChanged(_))
        ));

        let mut correct = CurrentSqlite::open(path).unwrap();
        correct.assert_file().unwrap();
        let tx = correct.transaction().unwrap();
        assert_eq!(directory_read(&tx, "synthetic-marker").unwrap(), "original");
        tx.commit().unwrap();
    }

    #[test]
    fn current_account_sqlite_refuses_a_writable_handle_with_matching_named_inode() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let path = root.join("policy.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("CREATE TABLE preserved(value INTEGER)")
            .unwrap();
        let (_file, inode) = open_regular(&path).unwrap();
        let current = CurrentSqlite {
            connection: connection.into(),
            path,
            inode,
            steps: Arc::new(AtomicU64::new(0)),
        };
        assert!(matches!(current.assert_file(), Err(AccountError::SourceChanged(_))));
    }
}

// The old Worker's per-person vault as the account's RecordBook keeps it, read once for the startup preparation that
// carries it into the account's own vault (`native_boot::own_records_start::carry_secrets`): the RecordBook's
// `held_values(address, bytes)` rows (its sealed snapshot and the identity of the root it is sealed under), read on
// the admitted readonly snapshot and finished (a fresh witness check) before they escape, with the credential file
// the restore record's `rootCredentials` names for that root. The snapshot stays sealed here; only
// `secrets::carry` opens it, in this process.
/// The physical read limits of the one secrets read: two rows, the sealed snapshot at most the vault's own
/// snapshot bound.
fn secrets_read_limits() -> crate::import::ReadLimits {
    crate::import::ReadLimits {
        cell_bytes: 16 * 1024 * 1024,
        result_bytes: 32 * 1024 * 1024,
        ..crate::import::ReadLimits::default()
    }
}

/// What the startup preparation carries: the old vault (None when the RecordBook keeps none) and the credential file
/// the restore record names for its root (None when it names none).
pub struct OldSecrets {
    pub vault: Option<crate::secrets::OldVault>,
    pub root_file: Option<String>,
}

impl LocalAccount {
    /// The old Worker vault the account's RecordBook keeps, read under the browser's current rights check and file witness.
    pub fn old_secrets(
        &mut self,
        session_id: &str,
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
        from: &crate::secrets::CarriedFrom,
    ) -> Result<OldSecrets, crate::records::Error> {
        let root_file = self.source.root_credentials.get(&from.root_binding).cloned();
        let path = self.source.record_book_path.clone().ok_or(crate::cause!(crate::records::Error::Unavailable))?;
        let admitted = crate::account::current_browser(self, session_id).map_err(|error| crate::records::Error::Unavailable(error.cause()))?;
        let mut source = self
            .current_record_source_limited(session_id, path, admitted, secrets_read_limits(), cancel)
            .map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
        let vault = crate::storage::old_record_tables::secrets(&mut source, &from.snapshot_address, &from.sealed_under_address)?;
        source.finish().map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
        Ok(OldSecrets { vault, root_file })
    }
}

#[cfg(test)]
mod startup_setting_tests {
    use super::*;

    #[test]
    fn a_receipt_without_environment_proves_the_operator_setting_absent() {
        let receipt = serde_json::json!({"account": "a", "complete": true, "objects": []});
        let environment = public_environment(&receipt);
        assert_eq!(public_setting(environment.as_ref(), "OPERATOR_ACCOUNT_ID").unwrap(), None);
    }

    #[test]
    fn a_receipt_naming_the_operator_returns_it_and_an_invalid_receipt_stays_unavailable() {
        let receipt = serde_json::json!({"environment": {"OPERATOR_ACCOUNT_ID": "person-1"}});
        let environment = public_environment(&receipt);
        assert_eq!(public_setting(environment.as_ref(), "OPERATOR_ACCOUNT_ID").unwrap(), Some("person-1".to_owned()));
        assert!(matches!(public_setting(None, "OPERATOR_ACCOUNT_ID"), Err(AccountError::SourceUnavailable(_))));
    }
}
