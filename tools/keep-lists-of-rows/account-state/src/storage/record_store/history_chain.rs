// src/storage/record_store/history_chain.rs
//
// Purpose: The proof that kept record history files are whole: each kept file's first line names the content identity
// (BLAKE3) of the file kept before it, `{"history_chain":{"previous":"1f:<hex>"|null}}`, and the store keeps the identity
// of the newest file (the head). Whoever holds the files and the head can show none was changed, dropped or put out of
// order. Also the archive form a kept file travels in (gzip, the chain-checked JSONL bytes exactly) and the verified
// keep of one archive: written, read back, and its identity checked before history may advance.
//
// Ported one to one from old trillion `src/record-history.mjs` (tag old-trillion-before-worker-retire):
// `historyIdentity` :63, `substitutedTo` :69, `createHistoryChainVerifier` :88, `checkHistoryChain` :141,
// `checkHistoryChainPage` :157, `encodeRecordHistoryArchive` / `decodeRecordHistoryArchive` :308-317,
// `archiveReadbackIdentity` :321, `keepRecordHistoryArchive` :352. The archive step that writes the files is
// `history_archive.rs`.
//
// Non-Negotiable Invariants:
// - A file that names no predecessor is allowed only as a run at the very start of a history (files kept before the
//   chain header existed), and only where the check allows it; the first chained file may name the last of them, or
//   none (as the first chain header was written).
// - A file rewritten to erase a record's words has a new identity while the file after it names the old one: each such
//   rewrite is kept as a substitution { file, old_identity, new_identity } (identities, never words), and a link to an
//   old identity holds when its substitutions lead to the identity the file has now. Conflicting or cyclic
//   substitutions hold nothing.
// - The paged check reads files and writes nothing; its cursor is its own text, refused when it is not.
// - A keep advances nothing until the archive read back is exactly the archive written: same declared size, same
//   streamed bytes (never more than the declared size is pulled), same BLAKE3, labelled gzip. An observer of the keep's
//   stages never receives a name or bytes, and a failing observer cannot stop the keep.
//
// Key Concepts:
// - `Verifier`: one file at a time against the chain; `state` is what a paged check carries in its cursor.
// - `Keeper`: where kept files live (the account's files, `account_files::history_keeper`); `put` and `get` only.
//
// Security Considerations:
// - Identities and substitution rows hold no record words; a kept file is the store's own history of its records.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use content_crypto::advanced::blake3;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::io::{Read as _, Write as _};

/// A history refusal keeps its existing words beside its source identity.
pub type HistoryError = crate::refusal_cause::CodedError<String>;

/// The content identity of kept bytes: `1f:` and the BLAKE3 hex of the bytes.
pub fn history_identity(bytes: &[u8]) -> String {
    format!("1f:{}", blake3::hash(bytes).to_hex())
}

/// The first line of a kept file: the identity of the file kept before it (None for the first).
pub fn chain_line(previous: Option<&str>) -> Vec<u8> {
    let mut line = serde_json::to_vec(&json!({ "history_chain": { "previous": previous } })).expect("chain line");
    line.push(b'\n');
    line
}

/// A kept file rewritten in place (erasure): its name, the identity it had and the identity it has now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Substitution {
    pub file: String,
    pub old_identity: String,
    pub new_identity: String,
}

/// Where `identity` of `file` leads through its substitutions; None when they conflict or loop.
fn substituted_to(substitutions: &[Substitution], identity: &str, file: Option<&str>) -> Option<String> {
    let mut to: HashMap<(String, String), String> = HashMap::new();
    for item in substitutions {
        if item.file.is_empty() {
            continue;
        }
        let key = (item.file.clone(), item.old_identity.clone());
        if let Some(next) = to.get(&key) {
            if next != &item.new_identity {
                return None;
            }
        }
        to.insert(key, item.new_identity.clone());
    }
    let file = file.unwrap_or_default().to_string();
    let mut identity = identity.to_string();
    let mut seen = HashSet::new();
    while let Some(next) = to.get(&(file.clone(), identity.clone())) {
        if !seen.insert(identity.clone()) {
            return None;
        }
        identity = next.clone();
    }
    Some(identity)
}

/// A break in the chain: how many files held before it, and why.
#[derive(Clone, Debug)]
pub struct Broken {
    pub cause: crate::refusal_cause::Cause,
    pub at: u64,
    pub why: String,
}
impl Broken {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { &self.cause }
}
crate::impl_caused!(Broken);
impl PartialEq for Broken {
    fn eq(&self, other: &Self) -> bool { self.at == other.at && self.why == other.why }
}
impl Eq for Broken {}
impl std::fmt::Display for Broken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "history chain refused cause={}", self.cause)
    }
}
impl std::error::Error for Broken {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
/// The end of a whole check: the head reached, the files checked, and the leading files that named no predecessor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reached {
    pub head: Option<String>,
    pub files: u64,
    pub unchained: u64,
}

/// What a paged check carries between calls.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifierState {
    #[serde(default)]
    pub previous: Option<String>,
    #[serde(default)]
    pub at: u64,
    #[serde(default)]
    pub unchained: u64,
    #[serde(default, rename = "lastUnchained")]
    pub last_unchained: Option<String>,
    #[serde(default)]
    pub chained: bool,
    #[serde(default, rename = "lastFile")]
    pub last_file: Option<String>,
    /// A check that begins at a tail takes the first file's named predecessor as given: it proves the files after it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub anchor: bool,
}

/// One file at a time against the chain.
pub struct Verifier<'s> {
    substitutions: &'s [Substitution],
    state: VerifierState,
    leading_unchained: bool,
}

/// The predecessor a file's first line names: Some(None) for a chain line naming none, None for no chain line.
fn named_previous(bytes: &[u8]) -> Option<Option<String>> {
    let first = bytes.split(|byte| *byte == b'\n').next().unwrap_or_default();
    let line: serde_json::Value = serde_json::from_slice(first).ok()?;
    match line.get("history_chain")?.get("previous")? {
        serde_json::Value::Null => Some(None),
        serde_json::Value::String(text) => Some(Some(text.clone())),
        _ => None,
    }
}

impl<'s> Verifier<'s> {
    pub fn new(substitutions: &'s [Substitution], start: VerifierState, leading_unchained: bool) -> Self {
        Verifier { substitutions, state: start, leading_unchained }
    }
    /// Take the next file, oldest first: None while the chain holds.
    pub fn take(&mut self, name: &str, bytes: &[u8]) -> Option<Broken> {
        let s = &mut self.state;
        let Some(named) = named_previous(bytes) else {
            if !self.leading_unchained || s.chained {
                return Some(Broken { cause: crate::cause!(), at: s.at, why: format!("{name} does not name the file before it.") });
            }
            s.unchained += 1;
            s.last_unchained = Some(history_identity(bytes));
            s.last_file = Some(name.to_string());
            s.at += 1;
            return None;
        };
        if s.anchor {
            s.previous = named.clone();
            s.anchor = false;
        }
        let through = |identity: &Option<String>| -> Option<String> {
            identity.as_deref().and_then(|identity| substituted_to(self.substitutions, identity, s.last_file.as_deref()))
        };
        let first_chained = !s.chained && s.unchained > 0 && (named == s.last_unchained || (named.is_some() && through(&named) == s.last_unchained));
        if !first_chained && named != s.previous && !(named.is_some() && through(&named) == s.previous) {
            return Some(Broken { cause: crate::cause!(), at: s.at, why: format!("{name} follows a file that is missing or was changed.") });
        }
        s.chained = true;
        s.previous = Some(history_identity(bytes));
        s.last_file = Some(name.to_string());
        s.at += 1;
        None
    }
    pub fn state(&self) -> VerifierState {
        self.state.clone()
    }
    /// The identity of the last file taken.
    pub fn last(&self) -> Option<&str> {
        self.state.previous.as_deref()
    }
    pub fn count(&self) -> u64 {
        self.state.at
    }
    /// Whether `identity` (of `file`) is `head`, directly or through substitutions.
    pub fn matches_head(&self, identity: Option<&str>, file: &str, head: Option<&str>) -> bool {
        identity == head || head.and_then(|head| substituted_to(self.substitutions, head, Some(file))).as_deref() == identity
    }
    /// The end of the files: the newest must be `head`.
    pub fn end(mut self, head: Option<&str>) -> Result<Reached, Broken> {
        let s = &mut self.state;
        if !s.chained && s.unchained > 0 {
            s.previous = s.last_unchained.clone();
        }
        let through = head.and_then(|head| substituted_to(self.substitutions, head, s.last_file.as_deref()));
        if s.previous.as_deref() != head && through != s.previous {
            return Err(Broken { cause: crate::cause!(), at: s.at, why: "The newest kept file is not the one the store last kept: a file is missing or was changed.".into() });
        }
        Ok(Reached { head: head.map(str::to_string), files: s.at, unchained: s.unchained })
    }
}

/// Check kept files, oldest first, against the head the store kept: each names the one before it, and the newest is the
/// head.
pub fn check_history_chain<'f>(files: impl IntoIterator<Item = (&'f str, &'f [u8])>, head: Option<&str>, substitutions: &[Substitution]) -> Result<Reached, Broken> {
    let mut check = Verifier::new(substitutions, VerifierState::default(), false);
    for (name, bytes) in files {
        if let Some(broken) = check.take(name, bytes) {
            return Err(broken);
        }
    }
    check.end(head)
}

/// One page of kept file names, and the cursor of the next page (None at the end).
pub struct Listed {
    pub names: Vec<String>,
    pub cursor: Option<String>,
}
/// Where kept files are listed and read (a paged check's view of the keeper).
pub trait KeptFiles {
    fn list(&mut self, after: Option<&str>, limit: usize) -> Result<Listed, HistoryError>;
    fn read(&mut self, name: &str) -> Result<Option<Vec<u8>>, HistoryError>;
}

/// What one paged check call is asked.
pub struct PageCheck<'a> {
    pub head: Option<&'a str>,
    pub substitutions: &'a [Substitution],
    pub cursor: Option<&'a str>,
    pub limit: usize,
    pub names_only: bool,
    pub anchor: bool,
    /// The clock (milliseconds) for timing, when the answer should carry it.
    pub timing: Option<&'a mut dyn FnMut() -> f64>,
}
/// Where a paged check's time went, when asked: listing, reading, hashing (whole milliseconds) and the bytes read.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Timing {
    pub list_ms: u64,
    pub read_ms: u64,
    pub hash_ms: u64,
    pub bytes: u64,
}
/// One paged check answer.
#[derive(Clone, Debug, PartialEq)]
pub enum Paged {
    Broken(Broken, Option<Timing>),
    More { cursor: String, files: u64, timing: Option<Timing> },
    Done(Reached, Option<Timing>),
    /// A names-only page: the names, and the cursor of the next (None at the end).
    Names { names: Vec<String>, cursor: Option<String> },
}

#[derive(Serialize, Deserialize)]
struct Cursor {
    list: Option<String>,
    #[serde(flatten)]
    state: VerifierState,
}

/// The same check as `check_history_chain` over a long history, a bounded page of files a call. The cursor is what a
/// page before answered; none starts at the first file. Leading files that name no predecessor are allowed as a run at
/// the very start and counted. Reads files and writes nothing.
pub fn check_history_chain_page(files: &mut dyn KeptFiles, ask: PageCheck<'_>) -> Result<Paged, HistoryError> {
    let PageCheck { head, substitutions, cursor, limit, names_only, anchor, mut timing } = ask;
    let mut state: Cursor = match cursor {
        Some(text) => serde_json::from_str(text).map_err(|error| HistoryError::with_cause("This cursor is not from this check.".to_string(), crate::refusal_cause::Caused::cause(&error)))?,
        None => Cursor { list: None, state: VerifierState { anchor, ..VerifierState::default() } },
    };
    if !(1..=200).contains(&limit) {
        return Err(HistoryError::new("Check between 1 and 200 files a call.".to_string()));
    }
    if anchor && cursor.is_some() && state.state.at == 0 {
        state.state.anchor = true;
    }
    let mut check = Verifier::new(substitutions, state.state, true);
    let mut spent = Timing::default();
    let clock = |timing: &mut Option<&mut dyn FnMut() -> f64>| timing.as_mut().map_or(0.0, |clock| clock());
    let mut began = clock(&mut timing);
    let page = files.list(state.list.as_deref(), limit)?;
    spent.list_ms = (clock(&mut timing) - began).round() as u64;
    // Names only reads no file: a walk to the end of the list, whose cursors let a check begin near the end (anchor).
    if names_only {
        let next = page.cursor.as_ref().map(|list| serde_json::to_string(&Cursor { list: Some(list.clone()), state: VerifierState::default() }).expect("cursor"));
        return Ok(Paged::Names { names: page.names, cursor: next });
    }
    let shown = |spent: &Timing, timing: &Option<&mut dyn FnMut() -> f64>| timing.is_some().then(|| spent.clone());
    for name in &page.names {
        began = clock(&mut timing);
        let bytes = files.read(name)?;
        spent.read_ms += (clock(&mut timing) - began).round() as u64;
        let Some(bytes) = bytes else {
            return Ok(Paged::Broken(Broken { cause: crate::cause!(), at: check.count(), why: format!("{name} is listed but cannot be read.") }, None));
        };
        spent.bytes += bytes.len() as u64;
        began = clock(&mut timing);
        let broken = check.take(name, &bytes);
        spent.hash_ms += (clock(&mut timing) - began).round() as u64;
        if let Some(broken) = broken {
            return Ok(Paged::Broken(broken, shown(&spent, &timing)));
        }
    }
    let timed = shown(&spent, &timing);
    if let Some(list) = page.cursor {
        let files = check.count();
        let cursor = serde_json::to_string(&Cursor { list: Some(list), state: check.state() }).expect("cursor");
        return Ok(Paged::More { cursor, files, timing: timed });
    }
    Ok(match check.end(head) {
        Ok(reached) => Paged::Done(reached, timed),
        Err(broken) => Paged::Broken(broken, timed),
    })
}

/// Kept history compressed, keeping the exact chain-checked JSONL bytes when read back.
pub fn encode_archive(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).expect("gzip into memory");
    encoder.finish().expect("gzip into memory")
}
/// The JSONL bytes of a gzip archive.
pub fn decode_archive(bytes: &[u8]) -> Result<Vec<u8>, HistoryError> {
    let mut plain = Vec::new();
    flate2::read::GzDecoder::new(bytes).read_to_end(&mut plain).map_err(|error| HistoryError::with_cause("The record history file is not a gzip archive.".to_string(), crate::refusal_cause::Caused::cause(&error)))?;
    Ok(plain)
}

/// One kept object read back: its declared size, its labels, and its body as a stream of chunks.
pub struct KeptObject<'a> {
    pub size: u64,
    pub blake3: Option<String>,
    pub encoding: Option<String>,
    pub body: Box<dyn Iterator<Item = Result<Vec<u8>, HistoryError>> + 'a>,
}
/// Where kept history files live: the account's own files.
pub trait Keeper {
    /// Keep `bytes` under `name`, labelled with their BLAKE3 hex and their encoding.
    fn put(&mut self, name: &str, bytes: &[u8], blake3_hex: &str, encoding: &str) -> Result<(), HistoryError>;
    /// Read a kept object back (None when there is none).
    fn get(&mut self, name: &str) -> Result<Option<KeptObject<'_>>, HistoryError>;
}

fn mismatch(cause: crate::refusal_cause::Cause) -> HistoryError {
    HistoryError::with_cause("The record history file did not match its source bytes.".to_string(), cause)
}
/// The BLAKE3 hex of a read-back body, hashed in place chunk by chunk: the declared size is checked before any chunk is
/// pulled, and the stream must fit that exact size and end; a chunk past it stops the read there.
pub fn readback_identity(kept: KeptObject<'_>, size: u64) -> Result<String, HistoryError> {
    if kept.size != size {
        return Err(mismatch(crate::cause!()));
    }
    let mut hash = blake3::Hasher::new();
    let mut read = 0u64;
    for chunk in kept.body {
        let chunk = chunk?;
        if chunk.len() as u64 > size - read {
            return Err(mismatch(crate::cause!()));
        }
        hash.update(&chunk);
        read += chunk.len() as u64;
    }
    if read != size {
        return Err(mismatch(crate::cause!()));
    }
    Ok(hash.finalize().to_hex().to_string())
}

/// Keep and verify one compressed archive: compress, identify, put, get, read back, verify. Each stage is observed by
/// name with its wall time, its byte count and whether it succeeded; an observer that panics cannot stop the keep. A
/// failure at any stage answers Err, and the caller advances nothing.
pub fn keep_archive(keeper: &mut dyn Keeper, name: &str, bytes: &[u8], observe: &mut dyn FnMut(&str, f64, u64, bool), elapsed: &mut dyn FnMut() -> f64) -> Result<u64, HistoryError> {
    let size = bytes.len() as u64;
    fn stage<T>(label: &str, size: u64, observe: &mut dyn FnMut(&str, f64, u64, bool), elapsed: &mut dyn FnMut() -> f64, work: impl FnOnce() -> Result<T, HistoryError>) -> Result<T, HistoryError> {
        let began = elapsed();
        let done = work();
        let took = elapsed() - began;
        let ok = done.is_ok();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| observe(label, took, size, ok)));
        done
    }
    let archived = stage("archive-compress", size, observe, elapsed, || Ok(encode_archive(bytes)))?;
    let digest = stage("archive-identity", size, observe, elapsed, || Ok(blake3::hash(&archived).to_hex().to_string()))?;
    stage("archive-put", size, observe, elapsed, || keeper.put(name, &archived, &digest, "gzip"))?;
    let kept = stage("archive-get", size, observe, elapsed, || keeper.get(name)?.ok_or_else(|| HistoryError::new("The record history file did not read back.".to_string())))?;
    let (labels_hash, labels_encoding) = (kept.blake3.clone(), kept.encoding.clone());
    let read_back = stage("archive-read", size, observe, elapsed, || readback_identity(kept, archived.len() as u64))?;
    stage("archive-verify", size, observe, elapsed, || {
        if read_back != digest || labels_hash.as_deref() != Some(digest.as_str()) || labels_encoding.as_deref() != Some("gzip") {
            return Err(mismatch(crate::cause!()));
        }
        Ok(())
    })?;
    Ok(archived.len() as u64)
}

#[cfg(test)]
#[path = "history_chain_tests.rs"]
mod tests;
