// src/account_files/take.rs
//
// Purpose: Take a folder of this computer into the account's account files, file for file: every regular file under the
// folder becomes a name under the target folder (its path below the folder kept as AccountFiles folders) pointing at a
// BLAKE3 file record whose bytes are in the account's own store. It is the engine's own subcommand
// (`account-files-take`, src/main.rs), the bulk road beside the door's `write_file` (at most 16 MiB a call) and
// `write_file_piece` (32 KiB a call, one store object per piece): a file here goes to the store in one streamed PUT,
// or, past what one PUT may carry, in large chunks of one PUT each.
//
// Non-Negotiable Invariants:
// - Bytes before records: a file's object (or every chunk) is kept in a store before its file record is written, and
//   the file record before its name, the same order as `write_file`, so a stop leaves stored, unnamed bytes, never a
//   name without bytes.
// - One read pass hashes a file (its BLAKE3 identity and the SHA-256 of each object to send) before any byte is sent;
//   the send is signed with that SHA-256, so the store refuses a body that changed between the two passes.
// - Content already kept is never sent again: the file record (by identity) or a chunk record is found first.
// - A name already pointing at the same identity is not written again, so running the same take twice writes nothing
//   the second time: the run resumes by re-reading, never by a checkpoint of its own.
// - New bytes go only to a store that takes them and, off loopback, names these account files's binding (`bind.rs`), the
//   same rule as `write_file`.
// - Nothing on the computer is changed or removed: the folder is only read. Symbolic links are not followed.
// - Credentials never leave the vault; output lines carry names, identities and counts only.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{
    bind, folder_name, lists_name, now_iso,
    objects::{Body, ObjectError, Objects, Origin, S3Objects},
    Answer, AccountFiles, AccountFilesError, CHUNKS, CHUNK_KIND, FILES, FILE_KIND, SPANS, SPANS_KIND,
};
use crate::{
    records::{Error, Mutation},
    sqlite_work::WorkMeter,
    storage::{record_store_resources, Storage},
    tool_runs::os::{FileFacts, Open, OwnerFiles, This},
};
use content_crypto::{advanced::blake3, Multihash};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, OnceLock,
    },
};

type Failure = Box<dyn std::error::Error>;

/// The most bytes one object PUT carries here. An S3-compatible store refuses a single PUT past 5 GB (B2 and S3 both
/// say so); 4 GiB stays under it.
pub const WHOLE_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// The size of each chunk of a file past `WHOLE_MAX_BYTES` (the last is shorter): 1 GiB, so a 100 GB recording is 100
/// chunk records and one spans record of 100 entries.
pub const CHUNK_BYTES: u64 = 1024 * 1024 * 1024;
/// How many times one file is tried when its store or its records did not answer, or its store failed on its own side
/// (HTTP 5xx); a store that refuses the request itself (4xx) or denies access is not tried again. A try after the first waits a little longer each time (`BUSY_WAIT` times the try), since another
/// worker holding the store file's one writer answers busy.
const TRIES: usize = 6;
const BUSY_WAIT: std::time::Duration = std::time::Duration::from_millis(40);
const READ_BUFFER: usize = 1024 * 1024;

/// One take: the computer folder, the AccountFiles folder its files are named under, the entry names left out at any
/// depth (a `.git` folder, `node_modules`), how many files are in flight at once, and the object sizes.
pub struct Take<'a> {
    pub from: &'a Path,
    pub to: &'a str,
    pub skip: &'a [String],
    pub width: usize,
    pub whole_max: u64,
    pub chunk_bytes: u64,
}

/// What one take did, the run's last output line.
#[derive(Default, Debug)]
pub struct Totals {
    pub files: AtomicU64,
    pub bytes: AtomicU64,
    /// Files whose bytes were sent (the rest were kept already).
    pub sent_files: AtomicU64,
    pub sent_bytes: AtomicU64,
    /// Names written (a name already pointing at its content is not).
    pub named: AtomicU64,
    pub failed: AtomicU64,
    /// Entries that are not regular files (links, sockets) or whose path is not UTF-8.
    pub passed_over: AtomicU64,
}
impl Totals {
    fn line(&self) -> Value {
        let n = |count: &AtomicU64| count.load(Ordering::Relaxed);
        json!({ "totals": { "files": n(&self.files), "bytes": n(&self.bytes), "sent_files": n(&self.sent_files),
            "sent_bytes": n(&self.sent_bytes), "named": n(&self.named), "failed": n(&self.failed), "passed_over": n(&self.passed_over) } })
    }
}

/// One file to take: where it is and the full name it gets.
struct Item {
    path: PathBuf,
    name: String,
}

/// What keeping one file did.
pub struct Kept {
    pub identity: String,
    pub byte_length: u64,
    pub sent: bool,
    pub named: bool,
}

/// The engine subcommand: take `take.from` into `account`'s account files in the state folder `state`, writing one JSON
/// line per file and a last totals line to `out`. Each of `take.width` workers opens its own handle on the account files
/// store file (RecordStore orders their commits; a lost race on a record is read again) with the account's vault, admitted as
/// the named unmetered operator write `account files take`.
pub fn run(state: &Path, account: &str, take: &Take, out: &mut (dyn Write + Send)) -> Result<Totals, Failure> {
    let path = record_store_resources::placement(super::FILES)
        .and_then(|placement| placement.in_state(state))
        .ok_or(crate::refusal_cause::CodedError::new("the account files has no placement in a state folder"))?;
    if !std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_file()) {
        return Err(crate::refusal_cause::CodedError::new(format!("{} holds no account files store file", state.display())).into());
    }
    let store = record_store_resources::open(&path, WorkMeter::new())?;
    let home = bind::tie(account, &bind::binding_in(&store, account).unwrap_or_default());
    let origins = AccountFiles::origins_in(&store, account)?;
    let sender = || -> Result<Box<dyn Objects>, Failure> {
        let vault = crate::secrets::open_home(state, account)?;
        Ok(Box::new(S3Objects::unmetered(origins.clone(), Box::new(vault), "account files take")?))
    };
    let records = AccountFiles::with_objects(store, account, sender()?).at_home(home);
    let mut senders = Vec::with_capacity(take.width.max(1));
    for _ in 0..take.width.max(1) {
        senders.push(sender()?);
    }
    take_with(records, senders, take, out)
}

/// A full read proof: no source bytes, provider locations or credentials leave this native operation.
#[derive(Debug, serde::Serialize, PartialEq, Eq)]
pub struct Verification {
    verified: bool,
    byte_length: u64,
    identity: String,
}

/// Bounded machine codes only. In particular, provider response bodies and local paths are never displayed.
#[derive(Debug, Clone)]
pub enum VerifyError {
    StateUnavailable(crate::refusal_cause::Cause),
    VaultUnavailable(crate::refusal_cause::Cause),
    VaultRequiresWrite(crate::refusal_cause::Cause),
    VaultKeyMismatch(crate::refusal_cause::Cause),
    NameInvalid(crate::refusal_cause::Cause),
    NotFound(crate::refusal_cause::Cause),
    StoredUnavailable(crate::refusal_cause::Cause),
    IdentityInvalid(crate::refusal_cause::Cause),
    SourceUnavailable(crate::refusal_cause::Cause),
    SourceNotRegular(crate::refusal_cause::Cause),
    LengthMismatch(crate::refusal_cause::Cause),
    ByteMismatch(crate::refusal_cause::Cause),
    IdentityMismatch(crate::refusal_cause::Cause),
    SourceChanged(crate::refusal_cause::Cause),
    StoredChanged(crate::refusal_cause::Cause),
}
impl VerifyError {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::StateUnavailable(cause) => cause,
            Self::VaultUnavailable(cause) => cause,
            Self::VaultRequiresWrite(cause) => cause,
            Self::VaultKeyMismatch(cause) => cause,
            Self::NameInvalid(cause) => cause,
            Self::NotFound(cause) => cause,
            Self::StoredUnavailable(cause) => cause,
            Self::IdentityInvalid(cause) => cause,
            Self::SourceUnavailable(cause) => cause,
            Self::SourceNotRegular(cause) => cause,
            Self::LengthMismatch(cause) => cause,
            Self::ByteMismatch(cause) => cause,
            Self::IdentityMismatch(cause) => cause,
            Self::SourceChanged(cause) => cause,
            Self::StoredChanged(cause) => cause,
        }
    }
}
crate::impl_caused!(VerifyError);

impl PartialEq for VerifyError {
    fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) }
}
impl Eq for VerifyError {}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::StateUnavailable(_) => "verify_state_unavailable",
            Self::VaultUnavailable(_) => "verify_vault_unavailable",
            Self::VaultRequiresWrite(_) => "verify_vault_requires_write",
            Self::VaultKeyMismatch(_) => "verify_vault_key_mismatch",
            Self::NameInvalid(_) => "verify_name_invalid",
            Self::NotFound(_) => "verify_not_found",
            Self::StoredUnavailable(_) => "verify_stored_unavailable",
            Self::IdentityInvalid(_) => "verify_identity_invalid",
            Self::SourceUnavailable(_) => "verify_source_unavailable",
            Self::SourceNotRegular(_) => "verify_source_not_regular",
            Self::LengthMismatch(_) => "verify_length_mismatch",
            Self::ByteMismatch(_) => "verify_byte_mismatch",
            Self::IdentityMismatch(_) => "verify_identity_mismatch",
            Self::SourceChanged(_) => "verify_source_changed",
            Self::StoredChanged(_) => "verify_stored_changed",
        })
    }
}
impl std::error::Error for VerifyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

/// Compare an explicit local file with an exact account name or content identity. This sibling of `run` reuses its
/// declared store placement, binding, vault and named native operator byte port. It opens no server, issues no grant,
/// and writes neither objects nor account records. The native operator reason admits only the reads done below.
pub fn verify(state: &Path, account: &str, name: &str, local_file: &Path) -> Result<Verification, VerifyError> {
    verify_opening(state, account, name, local_file, || {
        crate::secrets::open_home_read_only(state, account)
            .map(|vault| Box::new(vault) as Box<dyn super::objects::Secrets>)
            .map_err(|error| match error {
                crate::secrets::Error::Refused("vault_read_only_requires_write", cause) => VerifyError::VaultRequiresWrite(cause),
                crate::secrets::Error::Refused("vault_read_only_key_mismatch", cause) => VerifyError::VaultKeyMismatch(cause),
                other => VerifyError::VaultUnavailable(other.cause()),
            })
    })
}

/// The production composition with a vault opener supplied at its existing native boundary. Tests supply a real
/// temporary vault with a synthetic key here; the selected account-store and S3 open paths are identical.
fn verify_opening(state: &Path, account: &str, name: &str, local_file: &Path,
    vault: impl FnOnce() -> Result<Box<dyn super::objects::Secrets>, VerifyError>) -> Result<Verification, VerifyError> {
    let path = record_store_resources::placement(super::FILES)
        .and_then(|placement| placement.in_state(state)).ok_or(crate::cause!(VerifyError::StateUnavailable))?;
    if !std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_file()) {
        return Err(crate::cause!(VerifyError::StateUnavailable));
    }
    let store = record_store_resources::open_read_only(&path, WorkMeter::new()).map_err(|error| VerifyError::StateUnavailable(error.cause()))?;
    let home = bind::tie(account, &bind::binding_in(&store, account).unwrap_or_default());
    let origins = AccountFiles::origins_in(&store, account).map_err(|error| VerifyError::StoredUnavailable(error.cause()))?;
    let objects = S3Objects::unmetered(origins, vault()?, "account files verify")
        .map_err(|error| VerifyError::StoredUnavailable(error.cause()))?;
    verify_with(&AccountFiles::with_objects(store, account, Box::new(objects)).at_home(home), name, local_file)
}

/// The local descriptor's generation, including all facts the existing computer owner exposes and its exact size.
/// Named-path facts must agree both before and after the comparison: replacing the path with identical bytes is
/// still a different source. Metadata reads do not follow a final symbolic link.
#[derive(PartialEq, Eq)]
struct SourceGeneration {
    facts: FileFacts,
    byte_length: u64,
}
impl SourceGeneration {
    fn of(metadata: &std::fs::Metadata) -> Result<Self, VerifyError> {
        if !metadata.is_file() { return Err(crate::cause!(VerifyError::SourceNotRegular)); }
        let facts = This::facts(metadata).map_err(|error| crate::carry_cause!(VerifyError::SourceUnavailable, error))?;
        Ok(Self { facts, byte_length: metadata.len() })
    }
}

/// Compose the existing exact-name resolver and bounded range reader. Old trillion `src/namespace.mjs:2340-2348`
/// resolves exact names and reads bounded ranges; `src/file-tools.mjs:57` assembles successive ranges. This native
/// composition retains that range owner and additionally checks every byte, both full BLAKE3 streams and the source
/// generation. Memory stays at two `READ_MAX_BYTES` windows, including for files larger than an MCP response.
pub fn verify_with<S: Storage + Send>(records: &AccountFiles<S>, name: &str, local_file: &Path) -> Result<Verification, VerifyError> {
    if name.is_empty() || name.ends_with('/') || name.contains('\0') {
        return Err(crate::cause!(VerifyError::NameInvalid));
    }
    records.check_current().map_err(|error| VerifyError::StoredUnavailable(error.cause()))?;
    let found = records.resolve(name).map_err(|error| { let cause = error.cause(); match error {
        AccountFilesError::NotFound(_) => VerifyError::NotFound(cause),
        _ => VerifyError::StoredUnavailable(cause),
    }})?;
    let file = &found.file;
    let identity = Multihash::from_code_hex(&file.id).map_err(|error| crate::carry_cause!(VerifyError::IdentityInvalid, error))?;
    if identity.code != Multihash::BLAKE3_CODE || identity.as_bytes().len() != blake3::OUT_LEN
        || identity.to_code_hex() != file.id || super::text(&file.value, "kind") != Some(FILE_KIND) {
        return Err(crate::cause!(VerifyError::IdentityInvalid));
    }
    let length = file.value.get("byte_length").and_then(Value::as_u64).ok_or(crate::cause!(VerifyError::StoredUnavailable))?;
    let mut source = This::open(std::fs::OpenOptions::new().read(true), local_file, Open::NO_FOLLOW)
        .map_err(|error| crate::carry_cause!(VerifyError::SourceUnavailable, error))?;
    let generation = SourceGeneration::of(&source.metadata().map_err(|error| crate::carry_cause!(VerifyError::SourceUnavailable, error))?)?;
    let named = SourceGeneration::of(&std::fs::symlink_metadata(local_file).map_err(|error| crate::carry_cause!(VerifyError::SourceUnavailable, error))?)?;
    if generation != named { return Err(crate::cause!(VerifyError::SourceChanged)); }
    if generation.byte_length != length { return Err(crate::cause!(VerifyError::LengthMismatch)); }
    if length == 0 {
        if file.value.get("spans").and_then(Value::as_u64).unwrap_or(0) != 0
            || file.value.get("span_layout").is_some() || file.value.get("span_set").is_some() {
            return Err(crate::cause!(VerifyError::StoredUnavailable));
        }
        let origin = super::text(&file.value, "origin").ok_or(crate::cause!(VerifyError::StoredUnavailable))?;
        let key = super::text(&file.value, "key").ok_or(crate::cause!(VerifyError::StoredUnavailable))?;
        // An empty key names the bucket itself at S3, whose HEAD may also answer 200 with zero bytes.
        if key.is_empty() { return Err(crate::cause!(VerifyError::StoredUnavailable)); }
        records.check_current().map_err(|error| VerifyError::StoredUnavailable(error.cause()))?;
        let stat = records.objects.stat(origin, key).map_err(|error| VerifyError::StoredUnavailable(error.cause()))?;
        records.check_current().map_err(|error| VerifyError::StoredUnavailable(error.cause()))?;
        if !stat.is_some_and(|stat| stat.length == 0) { return Err(crate::cause!(VerifyError::StoredUnavailable)); }
    }
    let mut local_hash = content_crypto::advanced::blake3::Hasher::new();
    let mut stored_hash = content_crypto::advanced::blake3::Hasher::new();
    let mut local = vec![0; super::READ_MAX_BYTES as usize];
    let mut offset = 0;
    while offset < length {
        let window = (length - offset).min(super::READ_MAX_BYTES);
        let bytes = &mut local[..window as usize];
        source.read_exact(bytes).map_err(|error| crate::carry_cause!(VerifyError::SourceUnavailable, error))?;
        let stored = records.read_range_verified(file, offset, window).map_err(|error| VerifyError::StoredUnavailable(error.cause()))?;
        if stored.len() != bytes.len() { return Err(crate::cause!(VerifyError::StoredUnavailable)); }
        if stored.as_slice() != &*bytes { return Err(crate::cause!(VerifyError::ByteMismatch)); }
        local_hash.update(bytes);
        stored_hash.update(&stored);
        offset += window;
    }
    let descriptor = SourceGeneration::of(&source.metadata().map_err(|error| crate::carry_cause!(VerifyError::SourceChanged, error))?)
        .map_err(|error| VerifyError::SourceChanged(error.cause()))?;
    let named = SourceGeneration::of(&std::fs::symlink_metadata(local_file).map_err(|error| crate::carry_cause!(VerifyError::SourceChanged, error))?)
        .map_err(|error| VerifyError::SourceChanged(error.cause()))?;
    if generation != descriptor || generation != named { return Err(crate::cause!(VerifyError::SourceChanged)); }
    if blake_identity(local_hash.finalize()).map_err(|error| crate::carry_cause!(VerifyError::IdentityInvalid, error))? != file.id
        || blake_identity(stored_hash.finalize()).map_err(|error| crate::carry_cause!(VerifyError::IdentityInvalid, error))? != file.id {
        return Err(crate::cause!(VerifyError::IdentityMismatch));
    }
    records.check_current().map_err(|error| VerifyError::StoredUnavailable(error.cause()))?;
    let current = records.resolve(name).map_err(|error| VerifyError::StoredChanged(error.cause()))?.file;
    if current.id != file.id || current.version != file.version || current.value != file.value {
        return Err(crate::cause!(VerifyError::StoredChanged));
    }
    Ok(Verification { verified: true, byte_length: length, identity: file.id.clone() })
}

/// Take `take.from` with the account files `records` (the one handle on the store file) and one byte port per worker
/// (tests pass ports over a byte port in memory). Workers hash and send in parallel; every record read and write goes
/// through `records`, one at a time: the record store forgets its search memory whenever another handle on the file
/// commits, so a handle for each worker made every write reload its folder's index (about 7 new files a second).
pub fn take_with<S: Storage + Send>(records: AccountFiles<S>, senders: Vec<Box<dyn Objects>>, take: &Take, out: &mut (dyn Write + Send)) -> Result<Totals, Failure> {
    let to = folder_name(take.to);
    let totals = Totals::default();
    let stopped = AtomicBool::new(false);
    let stopped_cause = Mutex::new(None);
    // One worker per byte port: a worker always finds a port free, so no file is passed by for want of one.
    let width = take.width.max(1).min(senders.len()).max(1);
    let records = Mutex::new(records);
    let pool = Mutex::new(senders);
    let out = Mutex::new(out);
    let say = |line: Value| {
        if let Ok(mut out) = out.lock() {
            let _ = writeln!(out, "{line}");
        }
    };
    let mut items = Vec::new();
    walk(take.from, take.from, &to, take.skip, &mut items, &totals, &say)?;
    let work = |item: Item| {
        if stopped.load(Ordering::Relaxed) {
            return;
        }
        let Some(sender) = pool.lock().ok().and_then(|mut pool| pool.pop()) else { return };
        let mut answer = Err(AccountFilesError::Invalid("not tried", crate::cause!()));
        for tried in 0..TRIES {
            if tried > 0 {
                std::thread::sleep(BUSY_WAIT * tried as u32);
            }
            answer = keep_local(&records, &*sender, &item.name, &item.path, take);
            match &answer {
                Ok(_) => break,
                Err(AccountFilesError::Objects(ObjectError::Unavailable(_, _), _) | AccountFilesError::Records(Error::Unavailable(_) | Error::OutcomeUnknown(_) | Error::Conflict(_), _)) => continue,
                // A store's own failure (B2 answered 500 for about 1 in 1,500 small PUTs on Nov 3) is tried again.
                Err(AccountFilesError::Objects(ObjectError::Refused(status, _), _)) if *status >= 500 => continue,
                Err(_) => break,
            }
        }
        if let Ok(mut pool) = pool.lock() {
            pool.push(sender);
        }
        match answer {
            Ok(kept) => {
                totals.files.fetch_add(1, Ordering::Relaxed);
                totals.bytes.fetch_add(kept.byte_length, Ordering::Relaxed);
                if kept.sent {
                    totals.sent_files.fetch_add(1, Ordering::Relaxed);
                    totals.sent_bytes.fetch_add(kept.byte_length, Ordering::Relaxed);
                }
                if kept.named {
                    totals.named.fetch_add(1, Ordering::Relaxed);
                }
                say(json!({ "name": item.name, "identity": kept.identity, "byte_length": kept.byte_length, "sent": kept.sent, "named": kept.named }));
            }
            Err(error) => {
                totals.failed.fetch_add(1, Ordering::Relaxed);
                // A store that denies access (a spending cap answers 403) refuses every file after this one too.
                if matches!(error, AccountFilesError::Objects(ObjectError::Denied(..) | ObjectError::NotBound(_, _), _)) {
                    let mut retained = stopped_cause.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    if retained.is_none() { *retained = Some(error.cause()); }
                    stopped.store(true, Ordering::Relaxed);
                }
                say(json!({ "name": item.name, "failed": error.to_string(), "cause": error.cause().id() }));
            }
        }
    };

    let queue = Mutex::new(items.into_iter());
    std::thread::scope(|threads| {
        for _ in 0..width {
            let (queue, work) = (&queue, &work);
            threads.spawn(move || loop {
                let next = queue.lock().ok().and_then(|mut queue| queue.next());
                match next {
                    Some(item) => work(item),
                    None => return,
                }
            });
        }
    });
    say(totals.line());
    if stopped.load(Ordering::Relaxed) {
        let cause = stopped_cause.into_inner().unwrap_or_else(std::sync::PoisonError::into_inner)
            .expect("a stopped take retains its store refusal cause");
        return Err(crate::refusal_cause::CodedError::with_cause("a store refused the take; files after it were not tried", cause).into());
    }
    Ok(totals)
}

/// Every regular file under `folder`, named under `to` by its path below `root`, in name order, leaving out entries
/// named in `skip` at any depth. Symbolic links are not followed.
fn walk(root: &Path, folder: &Path, to: &str, skip: &[String], items: &mut Vec<Item>, totals: &Totals, say: &dyn Fn(Value)) -> std::io::Result<()> {
    let mut entries: Vec<_> = crate::io_operation!((crate::io_operation!((std::fs::read_dir(folder)).map_err(std::io::Error::from))?.collect::<Result<_, _>>()).map_err(std::io::Error::from))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let file_name = entry.file_name();
        if skip.iter().any(|skipped| file_name.to_str() == Some(skipped.as_str())) {
            continue;
        }
        let kind = crate::io_operation!((entry.file_type()).map_err(std::io::Error::from))?;
        let path = entry.path();
        if kind.is_dir() {
            crate::io_operation!((walk(root, &path, to, skip, items, totals, say)).map_err(std::io::Error::from))?;
            continue;
        }
        let relative = path.strip_prefix(root).ok().and_then(Path::to_str).map(str::to_owned);
        match relative {
            Some(relative) if kind.is_file() && !relative.contains('\0') => {
                let name = if to == "/" { format!("/{relative}") } else { format!("{to}/{relative}") };
                items.push(Item { path, name });
            }
            _ => {
                totals.passed_over.fetch_add(1, Ordering::Relaxed);
                say(json!({ "passed_over": path.to_string_lossy(), "why": if kind.is_symlink() { "a symbolic link" } else if kind.is_file() { "its path is not UTF-8" } else { "not a regular file" } }));
            }
        }
    }
    Ok(())
}

/// One object to send: its identity, where it starts in the file, its length and its SHA-256.
struct Piece {
    identity: String,
    offset: u64,
    length: u64,
    sha256: [u8; 32],
}

// The identity owner labels the streaming BLAKE3 digest. The separate SHA-256 below signs provider PUTs only.
fn blake_identity(digest: blake3::Hash) -> std::io::Result<String> {
    crate::io_operation!(Multihash::from_digest(Multihash::BLAKE3_CODE, digest.as_bytes().to_vec())
        .map(|hash| hash.to_code_hex()).map_err(std::io::Error::other))
}

/// The one read pass: the file's BLAKE3 identity and, for each object it is sent as (the whole file, or each chunk),
/// that object's identity, location and SHA-256.
fn hash_pass(path: &Path, length: u64, whole_max: u64, chunk_bytes: u64) -> std::io::Result<(String, Vec<Piece>)> {
    let size = if length <= whole_max { length.max(1) } else { chunk_bytes.max(1) };
    let mut file = crate::io_operation!((File::open(path)).map_err(std::io::Error::from))?;
    let mut whole = blake3::Hasher::new();
    let mut pieces = Vec::new();
    let mut piece = (blake3::Hasher::new(), Sha256::new(), 0u64);
    let mut offset = 0u64;
    let mut buffer = vec![0u8; READ_BUFFER];
    loop {
        let room = (size - piece.2).min(buffer.len() as u64) as usize;
        let read = crate::io_operation!((file.read(&mut buffer[..room])).map_err(std::io::Error::from))?;
        if read == 0 {
            break;
        }
        let bytes = &buffer[..read];
        whole.update(bytes);
        piece.0.update(bytes);
        piece.1.update(bytes);
        piece.2 += read as u64;
        if piece.2 == size {
            let (blake, sha, done) = std::mem::replace(&mut piece, (blake3::Hasher::new(), Sha256::new(), 0));
            let identity = crate::io_operation!((blake_identity(blake.finalize())).map_err(std::io::Error::from))?;
            pieces.push(Piece { identity, offset, length: done, sha256: sha.finalize().into() });
            offset += done;
        }
    }
    if piece.2 > 0 || pieces.is_empty() {
        let (blake, sha, done) = piece;
        let identity = crate::io_operation!((blake_identity(blake.finalize())).map_err(std::io::Error::from))?;
        pieces.push(Piece { identity, offset, length: done, sha256: sha.finalize().into() });
        offset += done;
    }
    if offset != length {
        return crate::io_operation!(Err(std::io::Error::other("the file changed size while it was read")));
    }
    Ok((crate::io_operation!((blake_identity(whole.finalize())).map_err(std::io::Error::from))?, pieces))
}

/// The records handle, for one short use. A worker that panicked while holding it left the store consistent (every
/// write is one store transaction), so a poisoned lock is still taken.
fn locked<S: Storage + Send>(records: &Mutex<AccountFiles<S>>) -> std::sync::MutexGuard<'_, AccountFiles<S>> {
    records.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}


impl<S: Storage + Send> AccountFiles<S> {
    /// The account's origin records in `store` (what `open` reads), for a caller that builds its own byte port.
    pub fn origins_in(store: &crate::storage::record_store::RecordStore<S>, account: &str) -> Answer<Vec<(String, Origin)>> {
        use crate::records::{Records, MAX_PAGE_ITEMS};
        store
            .list_page(account, super::ORIGINS, "", MAX_PAGE_ITEMS)?
            .items
            .into_iter()
            .map(|record| Ok((record.id, serde_json::from_value(record.value).map_err(|_| Error::Invalid("invalid origin record", crate::cause!()))?)))
            .collect()
    }

    /// One record write, tried again while the store file's one writer is held by another process (RecordStore answers that as
    /// unavailable before anything commits; the same request key makes a repeat of a write that did land a no-op), so
    /// a file whose bytes were sent is not hashed and sent again for a busy writer.
    fn mutate_waiting(&mut self, resource: &str, mutation: Mutation) -> Answer<crate::records::Change> {
        let mut tried = 0;
        loop {
            match self.mutate(resource, mutation.clone()) {
                Err(AccountFilesError::Records(Error::Unavailable(_), _)) if tried < TRIES * 8 => {
                    tried += 1;
                    std::thread::sleep(BUSY_WAIT);
                }
                other => return other,
            }
        }
    }

    /// The first store (by rank) that takes new bytes from these account files: the same rule as `write_file`.
    fn landing(&self) -> Answer<(String, Origin)> {
        let mut origins: Vec<(String, Origin)> = self.origins()?.into_iter().filter(|(_, origin)| origin.takes_new_bytes).collect();
        origins.sort_by_key(|(_, origin)| origin.rank);
        let mut refused = None;
        for (id, origin) in origins {
            if let Some(home) = &self.home {
                if !origin.is_loopback() && origin.bound_to.as_deref() != Some(home.as_str()) {
                    refused = Some(ObjectError::NotBound(id, crate::cause!()));
                    continue;
                }
            }
            return Ok((id, origin));
        }
        Err(refused.map_or(AccountFilesError::Invalid("the account has no store that takes new bytes", crate::cause!()), |value| AccountFilesError::Objects(value, crate::cause!())))
    }
}

/// Keep the computer file at `path` under `name`: hash it, send what the store does not hold yet, write the file
/// record, then the name (keeping the file's own modification time).
pub fn keep_local<S: Storage + Send>(records: &Mutex<AccountFiles<S>>, objects: &dyn Objects, name: &str, path: &Path, take: &Take) -> Answer<Kept> {
    locked(records).check_current()?;
    if !name.starts_with('/') || name.ends_with('/') || name.contains('\0') {
        return Err(AccountFilesError::Invalid("name must be an absolute file path", crate::cause!()));
    }
    let metadata = std::fs::metadata(path).map_err(|error| AccountFilesError::Objects(ObjectError::Unavailable(format!("the computer file could not be read: {error}"), crate::cause!()), crate::cause!()))?;
    let length = metadata.len();
    let modified_at_ms = metadata.modified().ok().and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok()).map(|at| at.as_millis() as i64);
    let (identity, pieces) = hash_pass(path, length, take.whole_max, take.chunk_bytes).map_err(|error| AccountFilesError::Objects(ObjectError::Unavailable(format!("the computer file could not be read: {error}"), crate::cause!()), crate::cause!()))?;
    let now = now_iso();
    let request = |what: &str| format!("account-files-take:{}", blake3::hash(format!("{what}\0{name}\0{identity}\0{now}").as_bytes()).to_hex());
    let mut sent = false;
    let held_file = locked(records).get(FILES, &identity)?;
    match held_file {
        Some(file) => {
            let mut value = file.value.clone();
            if lists_name(&mut value, name)? {
                locked(records).mutate_waiting(FILES, Mutation { id: identity.clone(), expected_version: file.version, request_key: format!("{}@{}", request("names"), file.version), deleted: false, value })?;
            }
        }
        None => {
            let (origin_id, origin) = locked(records).landing()?;
            let media_type = media_type_of(name);
            let value = if pieces.len() == 1 && length <= take.whole_max {
                let key = format!("{}{identity}", origin.file_key_prefix);
                send(objects, &origin_id, &key, path, &pieces[0], media_type)?;
                json!({ "kind": FILE_KIND, "byte_length": length, "media_type": media_type, "origin": origin_id, "key": key,
                    "stored_at": now, "checked_at": now, "spans": 0, "aliases": [], "names": [name] })
            } else {
                let mut spans = Vec::with_capacity(pieces.len());
                for piece in &pieces {
                    if locked(records).get(CHUNKS, &piece.identity)?.is_none() {
                        let key = format!("{}{}", origin.file_key_prefix, piece.identity);
                        send(objects, &origin_id, &key, path, piece, "application/octet-stream")?;
                        let chunk = json!({ "kind": CHUNK_KIND, "byte_length": piece.length, "origin": origin_id, "key": key });
                        match locked(records).mutate_waiting(CHUNKS, Mutation { id: piece.identity.clone(), expected_version: 0, request_key: request(&piece.identity), deleted: false, value: chunk }) {
                            Ok(_) | Err(AccountFilesError::Records(Error::Conflict(_), _)) => {}
                            Err(error) => return Err(error),
                        }
                    }
                    spans.push(json!({ "offset": piece.offset, "length": piece.length, "chunk": piece.identity }));
                }
                let list = json!({ "kind": SPANS_KIND, "spans": spans });
                match locked(records).mutate_waiting(SPANS, Mutation { id: identity.clone(), expected_version: 0, request_key: request("spans"), deleted: false, value: list }) {
                    Ok(_) | Err(AccountFilesError::Records(Error::Conflict(_), _)) => {}
                    Err(error) => return Err(error),
                }
                json!({ "kind": FILE_KIND, "byte_length": length, "media_type": media_type, "origin": origin_id, "key": "",
                    "stored_at": now, "checked_at": now, "spans": pieces.len(), "aliases": [], "names": [name] })
            };
            sent = true;
            // A worker that kept the same content a moment ago wrote the record first: this file then only adds
            // its name, which the caller's next try does.
            locked(records).mutate_waiting(FILES, Mutation { id: identity.clone(), expected_version: 0, request_key: request("file"), deleted: false, value })?;
        }
    }
    let mut records = locked(records);
    let held = records.get(&super::names_scope(super::parent(name)), name)?;
    let named = !held.is_some_and(|record| record.value.get("file").and_then(Value::as_str) == Some(identity.as_str()));
    if named {
        records.place_name(name, &identity, length, modified_at_ms, &now, &request("name"))?;
    }
    Ok(Kept { identity, byte_length: length, sent, named })
}

/// One streamed PUT of `piece` of the file at `path`, signed with the SHA-256 the hash pass read.
fn send(objects: &dyn Objects, origin: &str, key: &str, path: &Path, piece: &Piece, media_type: &str) -> Answer<()> {
    let mut file = File::open(path).map_err(|error| AccountFilesError::Objects(ObjectError::Unavailable(format!("the computer file could not be read: {error}"), crate::cause!()), crate::cause!()))?;
    file.seek(SeekFrom::Start(piece.offset)).map_err(|error| AccountFilesError::Objects(ObjectError::Unavailable(format!("the computer file could not be read: {error}"), crate::cause!()), crate::cause!()))?;
    let mut bytes = file.take(piece.length);
    objects.write_stream(origin, key, Body { length: piece.length, sha256: piece.sha256, bytes: &mut bytes }, media_type)?;
    Ok(())
}

/// The media type a name's extension says (DATA: `take.json` `media_types`), else `application/octet-stream`.
pub fn media_type_of(name: &str) -> &'static str {
    #[derive(Deserialize)]
    struct Settings {
        media_types: HashMap<String, String>,
    }
    static TYPES: OnceLock<HashMap<String, &'static str>> = OnceLock::new();
    let types = TYPES.get_or_init(|| {
        let settings: Settings = serde_json::from_str(include_str!("take.json")).unwrap_or(Settings { media_types: HashMap::new() });
        settings.media_types.into_iter().map(|(extension, kind)| (extension, &*Box::leak(kind.into_boxed_str()))).collect()
    });
    let file = name.rsplit('/').next().unwrap_or(name);
    file.rsplit_once('.')
        .filter(|(stem, _)| !stem.is_empty())
        .and_then(|(_, extension)| types.get(&extension.to_ascii_lowercase()).copied())
        .unwrap_or("application/octet-stream")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account_files::objects::{Listing, Objects, Stat};
    use crate::storage::{memory::Memory, record_store::{settings, RecordStore, RealClock}};
    use std::sync::Arc;
    use std::time::Instant;

    #[derive(Default)]
    struct Held {
        objects: Mutex<HashMap<String, Vec<u8>>>,
        puts: AtomicU64,
        reads: AtomicU64,
        stats: AtomicU64,
        max_read: AtomicU64,
        short_read: AtomicBool,
        unavailable: AtomicBool,
        after_read: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    }
    struct Port {
        held: Arc<Held>,
        admission: Option<crate::account_files::source_reads::Admission>,
    }
    impl Port {
        fn new(held: Arc<Held>) -> Self { Self { held, admission: None } }
        fn read_checked(&self, origin: &str, key: &str, offset: u64, length: u64, total: Option<u64>) -> Result<Vec<u8>, ObjectError> {
            self.held.max_read.fetch_max(length, Ordering::SeqCst);
            if self.held.unavailable.load(Ordering::SeqCst) {
                return Err(ObjectError::Unavailable("synthetic unavailable response".into(), crate::cause!()));
            }
            if let Some(admission) = &self.admission {
                admission.admit_read(&crate::account_files::source_reads::SourceRead {
                    origin: origin.to_owned(), offset, requested_bytes: length,
                })?;
            }
            let mut answer = {
                let objects = self.held.objects.lock().unwrap();
                let bytes = objects.get(key).ok_or(ObjectError::Refused(404, crate::cause!()))?;
                if total.is_some_and(|total| bytes.len() as u64 != total) { return Err(crate::cause!(ObjectError::RangeNotHonoured)); }
                bytes.get(offset as usize..(offset + length) as usize)
                    .ok_or_else(|| ObjectError::Unavailable("synthetic short object".into(), crate::cause!()))?.to_vec()
            };
            if self.held.short_read.load(Ordering::SeqCst) { answer.pop(); }
            if let Some(after_read) = self.held.after_read.lock().unwrap().take() { after_read(); }
            self.held.reads.fetch_add(length, Ordering::SeqCst);
            if let Some(admission) = &self.admission {
                admission.observed_read(&crate::account_files::source_reads::SourceReadObservation {
                    request_started: true, response_status: Some(206), source_body_bytes_observed: Some(answer.len() as u64),
                    bytes_returned: answer.len() as u64, outcome: crate::account_files::source_reads::ReadOutcome::Complete,
                });
            }
            Ok(answer)
        }
    }
    impl Objects for Port {
        fn set_control(&mut self, control: crate::account_files::CallControl) { self.admission = Some(control.admission().clone()); }
        fn read(&self, origin: &str, key: &str, offset: u64, length: u64) -> Result<Vec<u8>, ObjectError> {
            self.read_checked(origin, key, offset, length, None)
        }
        fn read_verified(&self, origin: &str, key: &str, offset: u64, length: u64, total: u64) -> Result<Vec<u8>, ObjectError> {
            self.read_checked(origin, key, offset, length, Some(total))
        }
        fn write(&self, _: &str, key: &str, bytes: &[u8], _: &str) -> Result<(), ObjectError> {
            self.held.puts.fetch_add(1, Ordering::SeqCst);
            self.held.objects.lock().unwrap().insert(key.to_owned(), bytes.to_vec());
            Ok(())
        }
        fn write_stream(&self, origin: &str, key: &str, body: Body<'_>, media_type: &str) -> Result<(), ObjectError> {
            let mut bytes = Vec::new();
            body.bytes.take(body.length).read_to_end(&mut bytes).map_err(|error| ObjectError::Unavailable(error.to_string(), crate::cause!()))?;
            // The store's own check: a body whose SHA-256 is not the signed one is refused.
            if bytes.len() as u64 != body.length || <[u8; 32]>::from(Sha256::digest(&bytes)) != body.sha256 {
                return Err(ObjectError::Refused(400, crate::cause!()));
            }
            self.write(origin, key, &bytes, media_type)
        }
        fn stat(&self, _: &str, key: &str) -> Result<Option<Stat>, ObjectError> {
            self.held.stats.fetch_add(1, Ordering::SeqCst);
            Ok(self.held.objects.lock().unwrap().get(key).map(|bytes| Stat { length: bytes.len() as u64, media_type: None }))
        }
        fn list(&self, _: &str, _: &str, _: &str, _: usize) -> Result<Listing, ObjectError> {
            Ok(Listing::default())
        }
    }

    fn account_files_of(store: &Memory, held: &Arc<Held>) -> AccountFiles<Memory> {
        let mut records = RecordStore::new(store.reopen(), Box::new(RealClock), settings::Limits::fixed(1 << 20, 10 << 30)).unwrap();
        let origin = json!({ "kind": "namespace-origin", "rank": 1, "file_key_prefix": "p/", "reach": {
            "key_id": {"value": "k"}, "secret": {"value": "s"}, "bucket": {"value": "b"}, "endpoint": {"value": "http://127.0.0.1:9"}, "region": {"value": "r"} } });
        use crate::records::Records;
        let _ = records.mutate("a", super::super::ORIGINS, Mutation { id: "local".into(), expected_version: 0, request_key: "fill-origin".into(), deleted: false, value: origin });
        AccountFiles::with_objects(records, "a", Box::new(Port::new(held.clone())))
    }

    fn senders(held: &Arc<Held>, count: usize) -> Vec<Box<dyn Objects>> {
        (0..count).map(|_| Box::new(Port::new(held.clone())) as Box<dyn Objects>).collect()
    }

    fn folder() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("project/src")).unwrap();
        std::fs::create_dir_all(root.join("project/.git")).unwrap();
        std::fs::create_dir_all(root.join("project/node_modules/x")).unwrap();
        std::fs::write(root.join("project/src/main.rs"), b"fn main() {}\n").unwrap();
        std::fs::write(root.join("project/LICENSE"), b"same words").unwrap();
        std::fs::write(root.join("copy-of-LICENSE"), b"same words").unwrap();
        std::fs::write(root.join("empty.txt"), b"").unwrap();
        std::fs::write(root.join("big.mov"), (0..2500u32).map(|n| (n % 253) as u8).collect::<Vec<_>>()).unwrap();
        std::fs::write(root.join("project/.git/HEAD"), b"ref").unwrap();
        std::fs::write(root.join("project/node_modules/x/i.js"), b"x").unwrap();
        std::os::unix::fs::symlink(root.join("empty.txt"), root.join("link")).unwrap();
        dir
    }

    fn take<'a>(from: &'a Path, skip: &'a [String]) -> Take<'a> {
        Take { from, to: "/Codebases/one", skip, width: 3, whole_max: 1000, chunk_bytes: 1000 }
    }

    fn verification_file(bytes: &[u8]) -> (tempfile::TempDir, PathBuf, Memory, Arc<Held>, AccountFiles<Memory>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("local");
        std::fs::write(&path, bytes).unwrap();
        let store = Memory::open("record_store").unwrap();
        let held = Arc::new(Held::default());
        let files = Mutex::new(account_files_of(&store, &held));
        keep_local(&files, &Port::new(held.clone()), "/verify", &path, &Take {
            from: dir.path(), to: "/", skip: &[], width: 1,
            whole_max: super::super::READ_MAX_BYTES, chunk_bytes: super::super::READ_MAX_BYTES / 2 + 3,
        }).unwrap();
        (dir, path, store, held, files.into_inner().unwrap())
    }

    /// A different handle observes every committed record mutation; byte writes have a separate counter.
    fn verify_without_writes(files: &AccountFiles<Memory>, name: &str, path: &Path, store: &Memory, held: &Held) -> Result<Verification, VerifyError> {
        let (mark, puts) = (store.mark().unwrap(), held.puts.load(Ordering::SeqCst));
        let answer = verify_with(files, name, path);
        assert_eq!(store.mark().unwrap(), mark, "verification must not mutate account records");
        assert_eq!(held.puts.load(Ordering::SeqCst), puts, "verification must not write objects");
        answer
    }

    #[test]
    fn file_stream_delivers_bounded_verified_chunks_without_record_or_object_writes() {
        let bytes: Vec<u8> = (0..super::super::READ_MAX_BYTES * 3 + 19).map(|n| (n % 251) as u8).collect();
        let (_dir, _path, store, held, files) = verification_file(&bytes);
        let identity = Multihash::hash(&bytes).to_code_hex();
        let (mark, puts) = (store.mark().unwrap(), held.puts.load(Ordering::SeqCst));
        struct ShortWriter(Vec<u8>);
        impl Write for ShortWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                let n = bytes.len().min(97);
                self.0.extend_from_slice(&bytes[..n]);
                Ok(n)
            }
            fn flush(&mut self) -> std::io::Result<()> { panic!("the sink's publication belongs to its caller") }
        }
        let mut sink = ShortWriter(Vec::new());
        let proof = files.stream_to(&identity, bytes.len() as u64, &mut sink).unwrap();
        assert_eq!(proof, super::super::StreamedFile { identity, byte_length: bytes.len() as u64 });
        assert_eq!(sink.0, bytes);
        assert!(held.max_read.load(Ordering::SeqCst) <= super::super::READ_MAX_BYTES);
        assert_eq!(store.mark().unwrap(), mark);
        assert_eq!(held.puts.load(Ordering::SeqCst), puts);
    }

    #[test]
    fn file_stream_refuses_names_bounds_and_corruption_and_keeps_the_empty_read_contract() {
        let (_dir, _path, _store, held, files) = verification_file(b"correct bytes");
        let identity = Multihash::hash(b"correct bytes").to_code_hex();
        let mut sink = Vec::new();
        assert!(files.stream_to("/verify", 99, &mut sink).is_err());
        assert!(files.stream_to(&identity, 1, &mut sink).is_err());
        assert!(sink.is_empty());
        assert_eq!(held.reads.load(Ordering::SeqCst), 0);
        held.short_read.store(true, Ordering::SeqCst);
        assert!(files.stream_to(&identity, 99, &mut sink).is_err());
        assert!(sink.is_empty(), "a short physical range is never delivered");
        held.short_read.store(false, Ordering::SeqCst);
        for bytes in held.objects.lock().unwrap().values_mut() { bytes[0] ^= 1; }
        assert!(files.stream_to(&identity, 99, &mut sink).is_err(), "full hash failure must never return proof");
        let (_dir, _path, _store, held, files) = verification_file(b"");
        let identity = Multihash::hash(b"").to_code_hex();
        assert_eq!(files.stream_to(&identity, 0, &mut Vec::new()).unwrap().byte_length, 0);
        held.objects.lock().unwrap().clear();
        let files = files.with_control(super::super::CallControl::new(Instant::now() + std::time::Duration::from_secs(5),
            Arc::new(|| true), crate::account_files::source_reads::Admission::none()));
        assert_eq!(files.read_file(&identity, 0, None).unwrap()["bytes_returned"], 0);
        assert_eq!(files.stream_to(&identity, 0, &mut Vec::new()).unwrap().byte_length, 0);
        assert_eq!(held.stats.load(Ordering::SeqCst), 0, "an empty logical read does not ask the physical store");
        assert_eq!(held.reads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn file_stream_and_range_reads_refuse_invalid_span_coverage_before_fetching_bytes() {
        let bytes: Vec<u8> = (0..super::super::READ_MAX_BYTES * 2 + 19).map(|n| (n % 251) as u8).collect();
        for damage in 0..6 {
            let (_dir, _path, _store, held, mut files) = verification_file(&bytes);
            let identity = Multihash::hash(&bytes).to_code_hex();
            let spans = files.get(SPANS, &identity).unwrap().unwrap();
            let mut value = spans.value;
            let list = value["spans"].as_array_mut().unwrap();
            match damage {
                0 => list[1] = list[0].clone(),
                1 => list.swap(0, 1),
                2 => list[0]["length"] = json!(list[0]["length"].as_u64().unwrap() - 1),
                3 => list[0]["length"] = json!(u64::MAX),
                4 => list[0]["length"] = json!(0),
                _ => list[0]["length"] = json!(bytes.len() as u64 + 1),
            }
            files.mutate(SPANS, Mutation { id: identity.clone(), expected_version: spans.version,
                request_key: "invalid-span-coverage".into(), deleted: false, value }).unwrap();
            let file = files.get(FILES, &identity).unwrap().unwrap();
            assert!(files.read_range(&file, 0, super::super::READ_MAX_BYTES).is_err());
            let mut sink = Vec::new();
            assert!(files.stream_to(&identity, bytes.len() as u64, &mut sink).is_err());
            assert!(sink.is_empty());
            assert_eq!(held.reads.load(Ordering::SeqCst), 0, "invalid coverage must refuse before physical reads");
        }
    }

    #[test]
    fn file_stream_stops_before_delivery_on_read_revocation_and_after_each_sink_write() {
        for revoke_in_sink in [false, true] {
            let (_dir, _path, _store, held, files) = verification_file(b"correct bytes");
            let identity = Multihash::hash(b"correct bytes").to_code_hex();
            let current = Arc::new(AtomicBool::new(true));
            let checked = current.clone();
            let files = files.with_control(super::super::CallControl::new(Instant::now() + std::time::Duration::from_secs(5),
                Arc::new(move || checked.load(Ordering::SeqCst)),
                crate::account_files::source_reads::Unmetered::new("file stream test").into()));
            if !revoke_in_sink {
                let revoked = current.clone();
                *held.after_read.lock().unwrap() = Some(Box::new(move || revoked.store(false, Ordering::SeqCst)));
            }
            struct RevokingWriter { bytes: Vec<u8>, current: Arc<AtomicBool> }
            impl Write for RevokingWriter {
                fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                    self.bytes.push(bytes[0]);
                    self.current.store(false, Ordering::SeqCst);
                    Ok(1)
                }
                fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
            }
            let mut sink = RevokingWriter { bytes: Vec::new(), current };
            assert!(files.stream_to(&identity, 99, &mut sink).is_err());
            assert_eq!(sink.bytes.len(), usize::from(revoke_in_sink), "revocation must stop further delivery");
        }
    }

    #[test]
    fn file_stream_refuses_sink_failures_deadlines_and_changed_file_records() {
        let (_dir, _path, store, held, files) = verification_file(b"correct bytes");
        let identity = Multihash::hash(b"correct bytes").to_code_hex();
        struct RefusingWriter;
        impl Write for RefusingWriter {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> { Ok(0) }
            fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
        }
        assert!(files.stream_to(&identity, 99, &mut RefusingWriter).is_err());
        struct FailingWriter { attempts: usize, bytes: Vec<u8> }
        impl Write for FailingWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.attempts += 1;
                match self.attempts {
                    1 => { self.bytes.push(bytes[0]); Ok(1) }
                    2 => crate::io_operation!(Err(std::io::ErrorKind::Interrupted.into())),
                    3 => crate::io_operation!(Err(std::io::ErrorKind::BrokenPipe.into())),
                    _ => panic!("a failed sink must receive no more bytes"),
                }
            }
            fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
        }
        let mut sink = FailingWriter { attempts: 0, bytes: Vec::new() };
        assert!(files.stream_to(&identity, 99, &mut sink).is_err());
        assert_eq!(sink.attempts, 3);
        assert_eq!(sink.bytes, b"c");
        let expired = account_files_of(&store, &held).with_control(super::super::CallControl::new(Instant::now(),
            Arc::new(|| true), crate::account_files::source_reads::Unmetered::new("expired file stream").into()));
        let reads = held.reads.load(Ordering::SeqCst);
        assert!(expired.stream_to(&identity, 99, &mut Vec::new()).is_err());
        assert_eq!(held.reads.load(Ordering::SeqCst), reads);
        let mut writer = account_files_of(&store, &held);
        let file = writer.get(super::super::FILES, &identity).unwrap().unwrap();
        let changed_id = identity.clone();
        *held.after_read.lock().unwrap() = Some(Box::new(move || {
            let mut value = file.value;
            value["media_type"] = Value::Null;
            writer.mutate(super::super::FILES, Mutation { id: changed_id, expected_version: file.version,
                request_key: "stream-file-changed".into(), deleted: false, value }).unwrap();
        }));
        assert!(files.stream_to(&identity, 99, &mut Vec::new()).is_err(), "changed metadata must not produce proof");
    }

    #[test]
    fn native_verify_compares_every_window_across_chunks_without_writes() {
        let bytes: Vec<u8> = (0..super::super::READ_MAX_BYTES * 3 + 19).map(|n| (n % 251) as u8).collect();
        let (_dir, path, store, held, files) = verification_file(&bytes);
        let proof = verify_without_writes(&files, "/verify", &path, &store, &held).unwrap();
        assert_eq!(proof.identity, Multihash::hash(&bytes).to_code_hex());
        assert_eq!(proof.byte_length, bytes.len() as u64);
        assert_eq!(held.reads.load(Ordering::SeqCst), bytes.len() as u64);
        assert!(held.max_read.load(Ordering::SeqCst) <= super::super::READ_MAX_BYTES);
        assert_eq!(serde_json::to_value(&proof).unwrap(), json!({
            "verified": true, "byte_length": bytes.len(), "identity": proof.identity,
        }), "the proof exposes only its three facts");
        verify_without_writes(&files, &proof.identity, &path, &store, &held).unwrap();
        let mut wrong = bytes.clone();
        *wrong.last_mut().unwrap() ^= 1;
        std::fs::write(&path, wrong).unwrap();
        assert_eq!(verify_without_writes(&files, "/verify", &path, &store, &held), Err(crate::cause!(VerifyError::ByteMismatch)),
            "a mismatch in the last window cannot pass");
    }

    #[test]
    fn native_verify_refuses_wrong_names_lengths_and_missing_local_files() {
        let (_dir, path, store, held, files) = verification_file(b"correct bytes");
        for name in ["/missing", "/verify/other", "/Verify"] {
            assert_eq!(verify_without_writes(&files, name, &path, &store, &held), Err(crate::cause!(VerifyError::NotFound)));
        }
        for name in ["", "/verify/", "bad\0name"] {
            assert_eq!(verify_without_writes(&files, name, &path, &store, &held), Err(crate::cause!(VerifyError::NameInvalid)));
        }
        for wrong in [&b"short"[..], &b"correct bytes plus"[..]] {
            std::fs::write(&path, wrong).unwrap();
            assert_eq!(verify_without_writes(&files, "/verify", &path, &store, &held), Err(crate::cause!(VerifyError::LengthMismatch)));
        }
        assert_eq!(verify_without_writes(&files, "/verify", &path.with_file_name("missing"), &store, &held), Err(crate::cause!(VerifyError::SourceUnavailable)));
        assert_eq!(held.reads.load(Ordering::SeqCst), 0, "names and local lengths are checked before provider reads");
    }

    #[test]
    fn native_verify_hashes_empty_files_without_requesting_a_zero_range() {
        let (_dir, path, store, held, files) = verification_file(b"");
        assert_eq!(verify_without_writes(&files, "/verify", &path, &store, &held).unwrap(), Verification {
            verified: true, byte_length: 0, identity: Multihash::hash(b"").to_code_hex(),
        });
        assert_eq!(held.reads.load(Ordering::SeqCst), 0);
        assert_eq!(held.max_read.load(Ordering::SeqCst), 0);
        held.objects.lock().unwrap().clear();
        assert_eq!(verify_without_writes(&files, "/verify", &path, &store, &held), Err(crate::cause!(VerifyError::StoredUnavailable)),
            "an empty local hash cannot stand in for a missing stored object");
    }

    #[test]
    fn native_verify_refuses_a_corrupt_empty_object_key_before_any_request() {
        let (_dir, path, store, held, mut files) = verification_file(b"");
        let file = files.resolve("/verify").unwrap().file;
        let mut value = file.value;
        value["key"] = json!("");
        files.mutate(FILES, Mutation {
            id: file.id, expected_version: file.version, request_key: "empty-key-before-verification".into(),
            deleted: false, value,
        }).unwrap();
        let (reads, stats) = (held.reads.load(Ordering::SeqCst), held.stats.load(Ordering::SeqCst));
        assert_eq!(verify_without_writes(&files, "/verify", &path, &store, &held), Err(crate::cause!(VerifyError::StoredUnavailable)));
        assert_eq!(held.reads.load(Ordering::SeqCst), reads);
        assert_eq!(held.stats.load(Ordering::SeqCst), stats, "an empty key must never cause a bucket HEAD");
    }

    #[test]
    fn native_verify_refuses_overlong_whole_objects_and_chunks_even_when_every_prefix_byte_matches() {
        for bytes in [b"correct bytes".to_vec(), vec![b'x'; super::super::READ_MAX_BYTES as usize + 19]] {
            let (_dir, path, store, held, files) = verification_file(&bytes);
            for object in held.objects.lock().unwrap().values_mut() { object.extend_from_slice(b"suffix"); }
            assert_eq!(verify_without_writes(&files, "/verify", &path, &store, &held), Err(crate::cause!(VerifyError::StoredUnavailable)));
        }
        let (_dir, path, store, held, files) = verification_file(b"");
        held.objects.lock().unwrap().values_mut().next().unwrap().push(b'x');
        assert_eq!(verify_without_writes(&files, "/verify", &path, &store, &held), Err(crate::cause!(VerifyError::StoredUnavailable)));
    }

    #[test]
    fn native_verify_refuses_a_port_that_has_no_physical_response_length_witness() {
        struct Unproved(Port);
        impl Objects for Unproved {
            fn set_control(&mut self, control: crate::account_files::CallControl) { self.0.set_control(control); }
            fn read(&self, origin: &str, key: &str, offset: u64, length: u64) -> Result<Vec<u8>, ObjectError> {
                self.0.read(origin, key, offset, length)
            }
            fn write(&self, _: &str, _: &str, _: &[u8], _: &str) -> Result<(), ObjectError> { panic!("verification never writes") }
            fn write_stream(&self, _: &str, _: &str, _: Body<'_>, _: &str) -> Result<(), ObjectError> { panic!("verification never writes") }
            fn stat(&self, _: &str, _: &str) -> Result<Option<Stat>, ObjectError> { panic!("a separate HEAD cannot prove the GET size") }
            fn list(&self, _: &str, _: &str, _: &str, _: usize) -> Result<Listing, ObjectError> { panic!("verification never lists") }
        }
        let (_dir, path, store, held, mut files) = verification_file(b"correct bytes");
        files.objects = Box::new(Unproved(Port::new(held.clone())));
        assert_eq!(verify_without_writes(&files, "/verify", &path, &store, &held), Err(crate::cause!(VerifyError::StoredUnavailable)));
        // The logical Files contract uses the required reader, not this optional audit witness.
        let mut returned = Vec::new();
        files.stream_to(&Multihash::hash(b"correct bytes").to_code_hex(), 13, &mut returned).unwrap();
        assert_eq!(returned, b"correct bytes");
    }

    #[test]
    fn native_verify_production_open_reads_real_sqlite_and_vault_without_mutation_on_success_or_failure() {
        use crate::{records::Records, secrets::{HeldAs, Secrets, SecretsKey}};
        use credentials_vault::VaultIdentity;
        use std::{collections::BTreeMap, net::TcpListener, time::{Duration, Instant}};
        use zeroize::Zeroizing;

        for (response, physical_total, chunked, empty) in [
            (206, 13, false, false), (206, 14, false, false), (206, 14, true, false),
            (404, 0, false, false), (200, 0, false, false), (403, 0, false, false),
            (200, 0, false, true), (404, 0, false, true),
            (200, 1, false, true), (200, 2, false, true),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let state = dir.path().canonicalize().unwrap();
            let source = state.join("local");
            let bytes: &'static [u8] = if empty { b"" } else { b"correct bytes" };
            std::fs::write(&source, bytes).unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let files_path = record_store_resources::placement(FILES).unwrap().in_state(&state).unwrap();
            let mut records = record_store_resources::open(&files_path, WorkMeter::new()).unwrap();
            records.mutate("a", super::super::ORIGINS, Mutation {
                id: "local".into(), expected_version: 0, request_key: "native-verify-origin".into(), deleted: false,
                value: json!({"kind":"namespace-origin", "rank":1, "file_key_prefix":"p/", "reach": {
                    "key_id":{"held":"store-key-id"}, "secret":{"held":"store-secret"}, "bucket":{"held":"store-bucket"},
                    "region":{"held":"store-region"}, "endpoint":{"value":endpoint} }}),
            }).unwrap();
            let held = Arc::new(Held::default());
            let mut files = AccountFiles::with_objects(records, "a", Box::new(Port::new(held.clone())));
            let origins = files.origins().unwrap();
            if chunked {
                let files = Mutex::new(files);
                keep_local(&files, &Port::new(held.clone()), "/verify", &source, &Take {
                    from: &state, to: "/", skip: &[], width: 1, whole_max: 1, chunk_bytes: super::super::READ_MAX_BYTES,
                }).unwrap();
                drop(files);
            } else {
                files.write_file("/verify", bytes, "text/plain", &origins).unwrap();
                drop(files);
            }
            let vault_path = record_store_resources::placement(crate::secrets::resource().unwrap()).unwrap().in_state(&state).unwrap();
            let key = SecretsKey::new(Zeroizing::new(format!("nm_{}_{}", "c".repeat(64), "a".repeat(64)))).unwrap();
            let vault = Secrets::open(record_store_resources::open(&vault_path, WorkMeter::new()).unwrap(), "a", &key, VaultIdentity::new("testhost").unwrap()).unwrap();
            for (field, value, as_kind) in [
                ("key-id", "synthetic-key", HeldAs::Plain), ("secret", "synthetic-secret", HeldAs::Sigv4SigningRoot),
                ("bucket", "synthetic-bucket", HeldAs::Plain), ("region", "synthetic-region", HeldAs::Plain),
            ] {
                vault.connect("store", field, Zeroizing::new(value.into()), as_kind).unwrap();
            }
            drop(vault);
            // With no writer or sidecars, any journal created by opening a supposed reader is a test failure.
            for path in [&files_path, &vault_path] {
                let db = crate::storage::sqlite::Connection::open(path).unwrap();
                db.pragma_update(None, "journal_mode", "DELETE").unwrap();
            }
            let image = || -> BTreeMap<PathBuf, Vec<u8>> {
                std::fs::read_dir(&state).unwrap().map(|entry| {
                    let path = entry.unwrap().path();
                    (path.file_name().unwrap().into(), std::fs::read(&path).unwrap())
                }).collect()
            };
            let before = image();
            let puts = held.puts.load(Ordering::SeqCst);
            let server = std::thread::spawn(move || {
                let until = Instant::now() + Duration::from_secs(3);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < until =>
                            std::thread::sleep(Duration::from_millis(5)),
                        Err(error) => panic!("the real signed GET must arrive within its bound: {error}"),
                    }
                };
                // accept inherits nonblocking mode on this computer; the fixture uses bounded blocking reads.
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut request = Vec::new();
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") {
                    assert!(request.len() < 8192, "the request header is bounded");
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                let request = String::from_utf8(request).unwrap();
                assert!(request.starts_with(if empty { "HEAD " } else { "GET " }), "only reads may reach the object store");
                if !empty { assert!(request.to_ascii_lowercase().contains("range: bytes=0-12\r\n")); }
                assert!(request.contains("AWS4-HMAC-SHA256"), "the real vault supplies signing");
                match response {
                    200 if empty && physical_total > 0 => {
                        let duplicate = if physical_total == 1 { 1 } else { 0 };
                        write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nContent-Length: {duplicate}\r\nConnection: close\r\n\r\n").unwrap();
                    }
                    206 => {
                        write!(stream, "HTTP/1.1 206 Partial Content\r\nContent-Length: 13\r\nContent-Range: bytes 0-12/{physical_total}\r\nConnection: close\r\n\r\n").unwrap();
                        let sent = stream.write_all(bytes);
                        if physical_total == 13 { sent.unwrap(); }
                    }
                    _ => write!(stream, "HTTP/1.1 {response} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap(),
                }
            });
            let result = verify_opening(&state, "a", "/verify", &source, || {
                let store = record_store_resources::open_read_only(&vault_path, WorkMeter::new()).map_err(|error| crate::carry_cause!(VerifyError::StateUnavailable, error))?;
                let vault = Secrets::open_read_only(store, "a", &key, VaultIdentity::new("testhost").unwrap()).map_err(|error| crate::carry_cause!(VerifyError::StateUnavailable, error))?;
                Ok(Box::new(vault))
            });
            server.join().unwrap();
            if (response == 206 && physical_total == 13) || (empty && response == 200 && physical_total == 0) { assert!(result.unwrap().verified); }
            else { assert_eq!(result, Err(crate::cause!(VerifyError::StoredUnavailable))); }
            assert_eq!(image(), before, "native production open must not change records, schema or journal files (HTTP {response})");
            assert_eq!(held.puts.load(Ordering::SeqCst), puts);
        }
    }

    #[test]
    fn native_verify_refuses_short_unavailable_and_corrupt_stored_reads() {
        let (_dir, path, store, held, files) = verification_file(b"correct bytes");
        held.short_read.store(true, Ordering::SeqCst);
        assert_eq!(verify_without_writes(&files, "/verify", &path, &store, &held), Err(crate::cause!(VerifyError::StoredUnavailable)));
        held.short_read.store(false, Ordering::SeqCst);
        held.unavailable.store(true, Ordering::SeqCst);
        assert_eq!(verify_without_writes(&files, "/verify", &path, &store, &held), Err(crate::cause!(VerifyError::StoredUnavailable)));
        held.unavailable.store(false, Ordering::SeqCst);
        for bytes in held.objects.lock().unwrap().values_mut() { bytes[0] ^= 1; }
        assert_eq!(verify_without_writes(&files, "/verify", &path, &store, &held), Err(crate::cause!(VerifyError::ByteMismatch)));
        let mut corrupt = b"correct bytes".to_vec();
        corrupt[0] ^= 1;
        std::fs::write(&path, corrupt).unwrap();
        assert_eq!(verify_without_writes(&files, "/verify", &path, &store, &held), Err(crate::cause!(VerifyError::IdentityMismatch)),
            "matching local and stored corruption must still match the recorded full identity");
        held.objects.lock().unwrap().clear();
        assert_eq!(verify_without_writes(&files, "/verify", &path, &store, &held), Err(crate::cause!(VerifyError::StoredUnavailable)),
            "a 404 for a missing stored object cannot yield proof");
    }

    #[test]
    fn native_verify_refuses_local_generation_changes_and_same_byte_replacement() {
        for replace in [false, true] {
            let (_dir, path, store, held, files) = verification_file(b"correct bytes");
            let changed_path = path.clone();
            *held.after_read.lock().unwrap() = Some(Box::new(move || {
                if replace {
                    let replacement = changed_path.with_file_name("replacement");
                    std::fs::write(&replacement, b"correct bytes").unwrap();
                    std::fs::rename(replacement, changed_path).unwrap();
                } else {
                    // Same bytes and length, changed generation: a byte-only test would accept it.
                    File::open(changed_path).unwrap().set_modified(std::time::UNIX_EPOCH).unwrap();
                }
            }));
            assert_eq!(verify_without_writes(&files, "/verify", &path, &store, &held), Err(crate::cause!(VerifyError::SourceChanged)));
        }
    }

    #[test]
    fn native_verify_refuses_an_account_name_retargeted_during_the_read() {
        let (_dir, path, store, held, files) = verification_file(b"correct bytes");
        let mut writer = account_files_of(&store, &held);
        let scope = super::super::names_scope("/");
        let named = writer.get(&scope, "/verify").unwrap().unwrap();
        let mut value = named.value;
        // Both records refer to valid immutable content, but the requested name changes during the read.
        let origins = writer.origins().unwrap();
        let other = writer.write_file("/other", b"other bytes", "text/plain", &origins).unwrap();
        let other = other["identity"].as_str().unwrap().to_owned();
        value["file"] = json!(other);
        let before = store.mark().unwrap();
        let puts = held.puts.load(Ordering::SeqCst);
        *held.after_read.lock().unwrap() = Some(Box::new(move || {
            writer.mutate(&scope, Mutation {
                id: "/verify".into(), expected_version: named.version,
                request_key: "retarget-during-verify".into(), deleted: false, value,
            }).unwrap();
        }));
        assert_eq!(verify_with(&files, "/verify", &path), Err(crate::cause!(VerifyError::StoredChanged)));
        assert_eq!(store.mark().unwrap(), before + 1, "only the explicit synthetic retarget wrote a record");
        assert_eq!(held.puts.load(Ordering::SeqCst), puts);
    }

    #[test]
    fn native_verify_respects_call_control_and_refuses_invalid_stored_identities() {
        let (_dir, path, store, held, mut files) = verification_file(b"correct bytes");
        let scope = super::super::names_scope("/");
        let named = files.get(&scope, "/verify").unwrap().unwrap();
        let valid = files.resolve("/verify").unwrap().file;
        let wrong_identity = format!("12:{}", "11".repeat(32));
        files.mutate(FILES, Mutation {
            id: wrong_identity.clone(), expected_version: 0, request_key: "wrong-identity".into(),
            deleted: false, value: valid.value,
        }).unwrap();
        let mut value = named.value;
        value["file"] = json!(wrong_identity);
        files.mutate(&scope, Mutation {
            id: "/verify".into(), expected_version: named.version, request_key: "wrong-identity-name".into(),
            deleted: false, value,
        }).unwrap();
        assert_eq!(verify_without_writes(&files, "/verify", &path, &store, &held), Err(crate::cause!(VerifyError::IdentityInvalid)));
        let files = files.while_current(Arc::new(|| false));
        assert_eq!(verify_without_writes(&files, "/verify", &path, &store, &held), Err(crate::cause!(VerifyError::StoredUnavailable)));
        assert_eq!(held.reads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn native_verify_refuses_symlinks_directories_and_a_real_fifo_without_waiting() {
        let (dir, path, store, held, files) = verification_file(b"correct bytes");
        let link = dir.path().join("link");
        This::link(&path, &link).unwrap();
        assert_eq!(verify_without_writes(&files, "/verify", &link, &store, &held), Err(crate::cause!(VerifyError::SourceUnavailable)));
        assert_eq!(verify_without_writes(&files, "/verify", dir.path(), &store, &held), Err(crate::cause!(VerifyError::SourceNotRegular)));
        let fifo = dir.path().join("fifo");
        assert!(std::process::Command::new("mkfifo").arg(&fifo).status().unwrap().success(), "a real FIFO fixture must be created");
        let (send, receive) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            send.send(verify_without_writes(&files, "/verify", &fifo, &store, &held)).unwrap();
        });
        assert_eq!(receive.recv_timeout(std::time::Duration::from_secs(2)).expect("opening a FIFO must not wait for a writer"),
            Err(crate::cause!(VerifyError::SourceNotRegular)));
        worker.join().unwrap();
    }

    #[test]
    fn a_folder_is_taken_file_for_file_under_its_files_folder_and_a_second_take_writes_nothing() {
        let dir = folder();
        let skip = vec![".git".to_owned(), "node_modules".to_owned()];
        let held = Arc::new(Held::default());
        let store = Memory::open("record_store").unwrap();
        let mut out = Vec::new();
        let totals = take_with(account_files_of(&store, &held), senders(&held, 3), &take(dir.path(), &skip), &mut out).unwrap();
        let said = String::from_utf8(out).unwrap();
        assert_eq!(totals.files.load(Ordering::Relaxed), 5, "{said}");
        assert_eq!(totals.passed_over.load(Ordering::Relaxed), 1, "the link is passed over: {said}");
        assert_eq!(totals.failed.load(Ordering::Relaxed), 0, "{said}");
        assert_eq!(totals.named.load(Ordering::Relaxed), 5);
        assert!(!said.contains(".git") && !said.contains("node_modules"), "{said}");
        // The shared content is sent once; the big file is three chunks of at most 1000 bytes.
        let puts_first = held.puts.load(Ordering::SeqCst);
        // Six objects: main.rs, the licence once, the empty file, three chunks. Two workers that hash the same licence at
        // the same moment may both send it (the same content-named key, so the store still holds one object).
        assert_eq!(held.objects.lock().unwrap().len(), 3 + 3, "main.rs, the licence once, the empty file, three chunks");
        assert!((6..=7).contains(&puts_first), "{puts_first}");

        let mut reader = account_files_of(&store, &held);
        let listed = reader.call("list_files", &json!({ "folder": "/Codebases/one/project/src" })).unwrap().unwrap();
        assert_eq!(listed["names"][0]["name"], "/Codebases/one/project/src/main.rs", "{listed}");
        let found = reader.call("find_file", &json!({ "name_or_identity": "/Codebases/one/copy-of-LICENSE" })).unwrap().unwrap();
        assert_eq!(found["names"].as_array().unwrap().len(), 2, "{found}");
        let big = std::fs::read(dir.path().join("big.mov")).unwrap();
        let range = reader.read_range(&reader.get(FILES, &format!("1f:{}", blake3::hash(&big).to_hex())).unwrap().unwrap(), 900, 1200).unwrap();
        assert_eq!(range, big[900..2100].to_vec(), "a range across two chunks reads the file's own bytes");
        assert_eq!(media_type_of("/a/b.MOV"), "video/quicktime");
        assert_eq!(media_type_of("/a/.env"), "application/octet-stream");

        let mut again = Vec::new();
        let second = take_with(account_files_of(&store, &held), senders(&held, 2), &take(dir.path(), &skip), &mut again).unwrap();
        assert_eq!(second.files.load(Ordering::Relaxed), 5, "{}", String::from_utf8(again.clone()).unwrap());
        assert_eq!(second.sent_files.load(Ordering::Relaxed), 0);
        assert_eq!(second.named.load(Ordering::Relaxed), 0, "{}", String::from_utf8(again).unwrap());
        assert_eq!(held.puts.load(Ordering::SeqCst), puts_first, "nothing is sent again");
    }

    #[test]
    fn a_mcp_read_fits_binary_control_and_unicode_ranges_before_reading_their_bytes() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};

        let cases = [
            ("image/heic", vec![0x91; 32 * 1024], true),
            ("text/plain", vec![0; 32 * 1024], false),
            ("text/plain", "🌍é".repeat(8192).into_bytes(), false),
        ];
        for (case, (media_type, bytes, explicit_base64)) in cases.into_iter().enumerate() {
            let store = Memory::open("record_store").unwrap();
            let held = Arc::new(Held::default());
            let control = crate::account_files::CallControl::new(
                std::time::Instant::now() + std::time::Duration::from_secs(30),
                Arc::new(|| true),
                crate::account_files::source_reads::Unmetered::new("bounded read test").into(),
            );
            let mut files = account_files_of(&store, &held).with_control(control);
            let origins = files.origins().unwrap();
            files.write_file("/read-fit.bin", &bytes, media_type, &origins).unwrap();
            let identity = files.find_file("/read-fit.bin").unwrap()["identity"].as_str().unwrap().to_owned();

            let mut joined = Vec::new();
            let mut offset = 0u64;
            let saw_warning_reserve = std::sync::atomic::AtomicBool::new(false);
            while offset < bytes.len() as u64 {
                let input = if explicit_base64 {
                    json!({"name_or_identity": "/read-fit.bin", "offset": offset, "length": bytes.len(), "encoding": "base64"})
                } else {
                    json!({"name_or_identity": "/read-fit.bin", "offset": offset, "length": bytes.len()})
                };
                let fits = |candidate: &serde_json::Value| {
                    if candidate.get("recent_use_not_kept").is_some() {
                        saw_warning_reserve.store(true, Ordering::SeqCst);
                    }
                    crate::mcp::tool_answer_fits(candidate)
                };
                let answer = files.call_fitting("read_file", &input, &fits).unwrap().unwrap();
                if offset == 0 { assert!(saw_warning_reserve.load(Ordering::SeqCst)); }
                assert!(crate::mcp::tool_answer_fits(&answer), "case {case}: {answer}");
                if offset == 0 {
                    let mut with_warning = answer.clone();
                    let reserve = crate::account_files::settings::settings().read.response_metadata_reserve_bytes;
                    with_warning["recent_use_not_kept"] = json!("x".repeat(reserve));
                    assert!(crate::mcp::tool_answer_fits(&with_warning), "case {case}: warning reserve");
                }
                assert_eq!(answer["identity"], identity);
                assert_eq!(answer["offset"].as_u64(), Some(offset));
                let returned = answer["bytes_returned"].as_u64().unwrap();
                assert!(returned > 0 && returned <= bytes.len() as u64);
                let page = match answer["encoding"].as_str().unwrap() {
                    "base64" => STANDARD.decode(answer["content"].as_str().unwrap()).unwrap(),
                    "utf-8" => answer["content"].as_str().unwrap().as_bytes().to_vec(),
                    encoding => panic!("unexpected encoding {encoding}"),
                };
                assert_eq!(page.len() as u64, returned);
                joined.extend_from_slice(&page);
                offset += returned;
            }
            assert_eq!(joined, bytes, "case {case}: joined ranges reproduce the source");
            assert_eq!(held.reads.load(Ordering::SeqCst), bytes.len() as u64,
                "only delivered bytes are admitted and read for case {case}");
            let eof = files.call_fitting("read_file", &json!({"name_or_identity": "/read-fit.bin", "offset": offset}),
                &crate::mcp::tool_answer_fits).unwrap().unwrap();
            assert_eq!(eof["bytes_returned"], 0, "EOF is an empty successful range");
            assert!(files.call_fitting("read_file", &json!({"name_or_identity": "/read-fit.bin", "offset": 0, "length": 1}),
                &|_| false).unwrap().is_err(), "an envelope that cannot carry one byte is refused");
            assert_eq!(held.reads.load(Ordering::SeqCst), bytes.len() as u64,
                "EOF and a refused envelope read no source bytes");
        }
    }

    #[test]
    fn a_file_that_changes_between_the_hash_and_the_send_is_refused_by_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f");
        std::fs::write(&path, b"first bytes").unwrap();
        let (_, pieces) = hash_pass(&path, 11, 1000, 1000).unwrap();
        std::fs::write(&path, b"other bytes").unwrap();
        let held = Arc::new(Held::default());
        assert!(send(&Port::new(held.clone()), "local", "p/x", &path, &pieces[0], "text/plain").is_err());
        assert_eq!(held.puts.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_file_names_list_stops_at_its_bound_and_every_name_still_points_at_it() {
        let dir = tempfile::tempdir().unwrap();
        for n in 0..(super::super::NAMES_LISTED + 4) {
            std::fs::write(dir.path().join(format!("{n:04}.txt")), b"").unwrap();
        }
        let held = Arc::new(Held::default());
        let store = Memory::open("record_store").unwrap();
        let mut out = Vec::new();
        let totals = take_with(account_files_of(&store, &held), senders(&held, 1), &Take { from: dir.path(), to: "/", skip: &[], width: 1, whole_max: 1000, chunk_bytes: 1000 }, &mut out).unwrap();
        assert_eq!(totals.named.load(Ordering::Relaxed) as usize, super::super::NAMES_LISTED + 4);
        let reader = account_files_of(&store, &held);
        let empty = reader.get(FILES, &format!("1f:{}", blake3::hash(b"").to_hex())).unwrap().unwrap();
        assert_eq!(empty.value["names"].as_array().unwrap().len(), super::super::NAMES_LISTED);
        let last = format!("/{:04}.txt", super::super::NAMES_LISTED + 3);
        let named = reader.get(&super::super::names_scope("/"), &last).unwrap().unwrap();
        assert_eq!(named.value["file"], empty.id);
    }
}
