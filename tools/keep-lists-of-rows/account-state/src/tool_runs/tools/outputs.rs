// src/tool_runs/tools/outputs.rs
//
// Purpose: Keep the files a finished tool run made in the person's own files (their files) and tell the
// caller where each one is. A row declares them in `invoke.outputs`: a list of `{name, path, keep_in, media_type,
// max_bytes?, tree?}`. `path` is a file the tool writes inside its private folder (the same container paths its argv uses),
// `keep_in` is `files` (the only destination a run's output is kept in), `media_type` is what the kept file is, and `max_bytes`
// is the most the tool may keep under that name. The tool needs no route, no credential and no code of its own to put a
// file in the person's files; it writes a file and says where.
//
// Non-Negotiable Invariants:
// - The declaration is read before anything starts: a malformed one, a path outside the run's folder, two outputs of
//   one name, or a `keep_in` other than `files` refuses the run.
// - Only a run that exited 0 keeps outputs. A file is read only when it is a regular file inside the run's private
//   folder (a link out of the folder is refused) and at most the row's `max_bytes`. Without an explicit bound the
//   ordinary single-write bound applies. Larger declared files use the account files' existing bounded upload pieces.
// - A kept file is named by DATA (`account-files-routes.json` `run_outputs`): `<folder>/<tool>/<run>/<file>`, where `<run>` is
//   the run's own identity, so a retry names the same file and the account files keeps it once.
// - A run whose outputs cannot all be kept answers the tool's exit code with an `error` that says why, and no
//   `files`; it never answers a file that was not kept.
// - A retry of a run that already finished does not run the tool again. It finds each output by name, or resumes its
//   upload from the private folder retained until every output is kept. Accepted pieces are checked again by the
//   account files before finish; a changed file can never silently replace accepted bytes.
// - A tree declares `tree: {files_from, max_files, max_bytes}`: a literal dotted field of the original process's JSON
//   result containing `{name, bytes, blake3}` entries. Outer `max_bytes` bounds each file, the tree's bounds their
//   count and sum. Only those safe relative names are kept, under `<output name>/<relative name>`; links and special
//   files are refused. Every length and BLAKE3 must match before that file is published. The original process journal
//   already keeps the result, so a retry needs no directory scan, mutable manifest file, extra journal or cache.
//
// Key Concepts:
// - `Files`: the person's files the outputs are kept in. `FilesInProcess` is the account's files (`account_files::door`);
//   a test gives an account files of its own.
// - The answer's `files` is `{<output name>: {identity, bytes, media_type, name}}`.
//
// Security Considerations:
// - A tool names a file only inside its own folder; where it is kept is trillion-local's DATA, never the tool's choice.
// - No byte of a file is logged; a refusal names a reason, never a path or content.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::refusal_cause::CodedError;
use super::{relative_inside, single_name, Failure, MAX_PACKAGE_FILES};
use crate::account_files::{account_routes::Failure as FilesFailure, account_routes::AccountFilesDoor, AccountFilesError, WRITE_MAX_BYTES};
use base64::{engine::general_purpose::STANDARD, Engine};
use content_crypto::subtree::SUBTREE_BYTES;
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Instant,
};
use crate::tool_runs::os::{OwnerFiles, This};

/// The most outputs one row may declare.
const MOST_OUTPUTS: usize = 16;
/// The longest media type a row may declare.
const MOST_MEDIA_TYPE_BYTES: usize = 255;

/// One output a row declares, with its path already placed inside the run's folder.
#[derive(Debug, PartialEq)]
pub(super) struct Output {
    name: String,
    path: PathBuf,
    file: String,
    media_type: String,
    limit: u64,
    tree: Option<Tree>,
    /// An original-result entry's immutable byte identity, never a caller's file name or a mutable Files manifest.
    identity: Option<String>,
}

#[derive(Debug, PartialEq)]
struct Tree {
    files_from: String,
    max_files: usize,
    max_bytes: u64,
}

struct Member { relative: String, output: Output, bytes: u64 }

/// Why an output was not kept. A reason, never a path or content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Refused {
    /// The tool did not make the file (or, on a retry, it was never kept).
    Missing(crate::refusal_cause::Cause),
    /// The path is not a regular file inside the run's folder.
    NotAFile(crate::refusal_cause::Cause),
    /// The file is larger than the row allows or the person's files take in one piece.
    TooLarge(crate::refusal_cause::Cause),
    /// A tree member no longer has the byte identity the first process recorded.
    IdentityMismatch(crate::refusal_cause::Cause),
    /// The person's files could not take it now.
    Unavailable(crate::refusal_cause::Cause),
    /// The person's files could not take it, and the door said why: the failed step and its reason, or the
    /// Account files' own error (words only, never a value or a key).
    Because(String, crate::refusal_cause::Cause),
}
impl Refused {
    pub(super) fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Missing(cause) | Self::NotAFile(cause) | Self::TooLarge(cause)
            | Self::IdentityMismatch(cause) | Self::Unavailable(cause) | Self::Because(_, cause) => cause.clone(),
        }
    }

    fn said(&self) -> String {
        match self {
            Self::Missing(_) => "the tool did not make the file".to_owned(),
            Self::NotAFile(_) => "the path is not a file inside the tool's folder".to_owned(),
            Self::TooLarge(_) => "the file is larger than a tool may keep".to_owned(),
            Self::IdentityMismatch(_) => "the file does not match the original process result".to_owned(),
            Self::Unavailable(_) => "your files are not available to keep it in".to_owned(),
            Self::Because(why, _) => format!("your files are not available to keep it in ({why})"),
        }
    }
}
crate::impl_caused!(Refused);


/// A file kept in the person's files.
#[derive(Debug, PartialEq)]
pub(super) struct Kept {
    identity: String,
    bytes: u64,
    media_type: String,
    name: String,
}
impl Kept {
    fn described(&self) -> Value {
        json!({"identity": self.identity, "bytes": self.bytes, "media_type": self.media_type, "name": self.name})
    }
}

/// The person's files, as far as a run's outputs need them: the name an output is kept under, and the files tools
/// (`write_file` and `find_file`, the account files' own contract) that keep and find it.
pub(super) trait Files {
    fn name(&self, tool: &str, run: &str, file: &str) -> Result<String, Refused>;
    fn call(&self, operation: &str, input: &Value) -> Result<Value, Refused>;
}

/// The account's own files (`account_files::door`), written and read in this process with no second door call.
pub(super) struct FilesInProcess<'a> {
    pub state_root: &'a Path,
    pub account: &'a str,
    pub until: Instant,
}
impl Files for FilesInProcess<'_> {
    fn name(&self, tool: &str, run: &str, file: &str) -> Result<String, Refused> {
        Ok(AccountFilesDoor::shipped().ok_or(crate::cause!(Refused::Unavailable))?.run_output_name(tool, run, file))
    }

    fn call(&self, operation: &str, input: &Value) -> Result<Value, Refused> {
        let door = AccountFilesDoor::shipped().ok_or(crate::cause!(Refused::Unavailable))?;
        door.call_with_control(self.state_root, self.account, operation, input, AccountFilesDoor::run_outputs_control(self.until))
            .map_err(|failure| match failure {
                FilesFailure::AccountFiles(AccountFilesError::NotFound(cause), _) => Refused::Missing(cause),
                FilesFailure::AccountFiles(AccountFilesError::Invalid(_, cause), _) => Refused::TooLarge(cause),
                FilesFailure::Unavailable(step, cause) => Refused::Because(step.detail().to_string(), cause),
                FilesFailure::NotBound { origin, fix, cause } => Refused::Because(format!("store {origin} is not bound to this state folder; {fix}"), cause),
                FilesFailure::AccountFiles(other, _) => { let cause = other.cause(); Refused::Because(format!("{other:?}").chars().take(200).collect(), cause) },
            })
    }
}

/// Keep `bytes` under the name for (`tool`, `run`, `file`); the same bytes under the same name are kept once.
fn store(files: &dyn Files, tool: &str, run: &str, output: &Output, bytes: &[u8]) -> Result<Kept, Refused> {
    let name = files.name(tool, run, &output.file)?;
    let input = json!({"name": name, "content_base64": STANDARD.encode(bytes), "media_type": output.media_type});
    files.call("write_file", &input)?;
    // write_file reports the requested MIME type even when content deduplication preserves an earlier one.
    // Read the actual kept metadata, like the large-upload path, and prove this name still holds our exact bytes.
    let stored = find(files, tool, run, output)?;
    let expected = content_crypto::Multihash::blake3(bytes).to_code_hex();
    if stored.identity != expected || stored.bytes != bytes.len() as u64 {
        return Err(crate::cause!(Refused::IdentityMismatch));
    }
    Ok(stored)
}

/// Keep a large output through the account files' existing resumable write. The upload token names this run's
/// exact output, never a caller-selected file or identity. Every accepted piece is replayed and verified on retry,
/// so an interrupted upload resumes without trusting an offset supplied by the process or skipping changed bytes.
fn store_pieces(files: &dyn Files, tool: &str, run: &str, output: &Output, file: &mut fs::File, length: u64) -> Result<Kept, Refused> {
    let name = files.name(tool, run, &output.file)?;
    let token = content_crypto::hash(format!("workshop-output\0{tool}\0{run}\0{}", output.name).as_bytes());
    let upload_id: String = token[..16].iter().map(|byte| format!("{byte:02x}")).collect();
    let started = files.call("write_file_start", &json!({"upload_id": upload_id, "name": name,
        "byte_length": length, "media_type": output.media_type}))?;
    match started["state"].as_str() {
        Some("finished") => return find(files, tool, run, output),
        Some("open") => {}
        _ => return Err(crate::cause!(Refused::Unavailable)),
    }
    let mut offset = 0u64;
    let mut hash = content_crypto::StreamingHasher::new();
    let mut piece = vec![0; SUBTREE_BYTES];
    while offset < length {
        let take = (length - offset).min(SUBTREE_BYTES as u64) as usize;
        file.read_exact(&mut piece[..take]).map_err(|error| crate::carry_cause!(Refused::Missing, error))?;
        hash.update(&piece[..take]);
        files.call("write_file_piece", &json!({"upload_id": upload_id, "name": name, "offset": offset,
            "content_base64": STANDARD.encode(&piece[..take])}))?;
        offset += take as u64;
    }
    if file.read(&mut piece[..1]).map_err(|error| crate::carry_cause!(Refused::Missing, error))? != 0 {
        return Err(crate::cause!(Refused::TooLarge));
    }
    verify_digest(output, &hash.finalize())?;
    files.call("write_file_finish", &json!({"upload_id": upload_id, "name": name}))?;
    find(files, tool, run, output)
}

/// The file already kept under that name.
fn find(files: &dyn Files, tool: &str, run: &str, output: &Output) -> Result<Kept, Refused> {
    let name = files.name(tool, run, &output.file)?;
    let found = kept(&files.call("find_file", &json!({"name_or_identity": name}))?, name)?;
    if output.identity.as_ref().is_some_and(|identity| found.identity != *identity) { return Err(crate::cause!(Refused::IdentityMismatch)) }
    Ok(found)
}

fn verify_digest(output: &Output, digest: &[u8; 32]) -> Result<(), Refused> {
    if let Some(expected) = &output.identity {
        let actual = format!("1f:{}", digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>());
        if actual != *expected { return Err(crate::cause!(Refused::IdentityMismatch)) }
    }
    Ok(())
}

/// What the files tools answered about a kept file.
fn kept(answer: &Value, name: String) -> Result<Kept, Refused> {
    Ok(Kept {
        identity: answer["identity"].as_str().ok_or(crate::cause!(Refused::Unavailable))?.to_owned(),
        bytes: answer["byte_length"].as_u64().ok_or(crate::cause!(Refused::Unavailable))?,
        media_type: answer["media_type"].as_str().ok_or(crate::cause!(Refused::Unavailable))?.to_owned(),
        name,
    })
}

/// The outputs `invoke` declares, each path placed inside the run's folder by `place` (the row's container paths).
/// None declared is an empty list; a declaration trillion-local cannot honour refuses the run.
pub(super) fn declared(invoke: &Value, place: &dyn Fn(&str) -> Option<PathBuf>) -> Result<Vec<Output>, Failure> {
    let items = match &invoke["outputs"] {
        Value::Null => return Ok(Vec::new()),
        Value::Array(items) if items.len() <= MOST_OUTPUTS => items,
        _ => return Err(crate::cause!(Failure::NotRunnableHere)),
    };
    let mut names = BTreeSet::new();
    let mut outputs = Vec::new();
    let mut files = BTreeSet::new();
    for item in items {
        let name = item["name"].as_str().filter(|name| single_name(name)).ok_or(crate::cause!(Failure::NotRunnableHere))?;
        let media_type = item["media_type"].as_str()
            .filter(|media| !media.is_empty() && media.len() <= MOST_MEDIA_TYPE_BYTES && !media.chars().any(char::is_control))
            .ok_or(crate::cause!(Failure::NotRunnableHere))?;
        let path = item["path"].as_str().filter(|path| !path.ends_with('/')).and_then(place).ok_or(crate::cause!(Failure::NotRunnableHere))?;
        let file = path.file_name().and_then(|file| file.to_str()).filter(|file| single_name(file)).ok_or(crate::cause!(Failure::NotRunnableHere))?.to_owned();
        let limit = match item.get("max_bytes") {
            None | Some(Value::Null) => WRITE_MAX_BYTES as u64,
            Some(bytes) => bytes.as_u64().filter(|bytes| *bytes > 0).ok_or(crate::cause!(Failure::NotRunnableHere))?,
        };
        let tree = match item.get("tree") {
            None => None,
            Some(value) => {
                let fields = value.as_object().filter(|fields| fields.len() == 3
                    && fields.keys().all(|key| matches!(key.as_str(), "files_from" | "max_files" | "max_bytes")))
                    .ok_or(crate::cause!(Failure::NotRunnableHere))?;
                let files_from = fields["files_from"].as_str().filter(|field| !field.is_empty()
                    && field.split('.').all(single_name)).ok_or(crate::cause!(Failure::NotRunnableHere))?;
                let max_files = fields["max_files"].as_u64().filter(|count| *count > 0 && *count <= MAX_PACKAGE_FILES as u64)
                    .ok_or(crate::cause!(Failure::NotRunnableHere))? as usize;
                let max_bytes = fields["max_bytes"].as_u64().filter(|bytes| *bytes > 0).ok_or(crate::cause!(Failure::NotRunnableHere))?;
                Some(Tree { files_from: files_from.to_owned(), max_files, max_bytes })
            }
        };
        // Trees own a namespace folder named by their logical output; ordinary outputs own their file basename.
        let destination = if tree.is_some() { name } else { &file };
        if item["keep_in"] != "files" || !names.insert(name.to_owned()) || !files.insert(destination.to_owned()) {
            return Err(crate::cause!(Failure::NotRunnableHere));
        }
        outputs.push(Output { name: name.to_owned(), path, file, media_type: media_type.to_owned(), limit, tree, identity: None });
    }
    Ok(outputs)
}

/// Keep every output of a run that exited 0 and describe them: `{<name>: {identity, bytes, media_type, name}}`.
/// `inside` is the run's private folder; `run` the run's identity; `replayed` a retry of a run already finished,
/// which finds kept files by name and resumes any missing output from the retained private folder.
pub(super) fn keep(outputs: &[Output], inside: &Path, files: &dyn Files, tool: &str, run: &str, replayed: bool)
    -> Result<Value, CodedError> {
    keep_with_result(outputs, inside, files, tool, run, replayed, &Value::Null)
}

/// Keep a result-bound output tree from the original parsed process result. That result comes from the process
/// journal on replay. Static-file callers retain their old API and behavior through `keep` above.
pub(super) fn keep_with_result(outputs: &[Output], inside: &Path, files: &dyn Files, tool: &str, run: &str,
    replayed: bool, result: &Value) -> Result<Value, CodedError> {
    let said = |output: &Output, refused: Refused| CodedError::with_cause(format!("the output {} was not kept: {}", output.name, refused.said()), refused.cause());
    // Validate every result manifest before any upload. Counts, sums and names
    // come from the first process's durable result; a later caller supplies none of this recovery authority.
    let mut plans = BTreeMap::new();
    for output in outputs {
        if output.tree.is_some() {
            let members = members(output, result).map_err(|refused| said(output, refused))?;
            plans.insert(output.name.clone(), members);
        }
    }
    let mut described = Map::new();
    for output in outputs {
        if let Some(members) = plans.get(&output.name) {
            // Preflight all missing destinations before uploading even the first member. Kept files are checked
            // against the original identities; a cleaned private folder is never consulted for an already-kept tree.
            for member in members {
                match if replayed { find(files, tool, run, &member.output) } else { Err(crate::cause!(Refused::Missing)) } {
                    // Namespace owns MIME metadata by content identity. Deduplicated bytes retain the media type
                    // already kept there, exactly as on the first keep; the original manifest binds bytes, not MIME.
                    Ok(kept) if kept.bytes == member.bytes => (),
                    Ok(_) => return Err(said(output, crate::cause!(Refused::Unavailable))),
                    Err(Refused::Missing(_)) => { checked_member(&member.output, inside, member.bytes).map_err(|refused| said(output, refused))?; },
                    Err(refused) => return Err(said(output, refused)),
                }
            }
            let mut entries = Map::new();
            let mut bytes = 0u64;
            for member in members {
                let kept = keep_file(&member.output, inside, files, tool, run, replayed).map_err(|refused| said(output, refused))?;
                if kept.bytes != member.bytes || kept.identity != member.output.identity.as_deref().unwrap_or_default() {
                    return Err(said(output, crate::cause!(Refused::IdentityMismatch)));
                }
                bytes += kept.bytes;
                entries.insert(member.relative.clone(), kept.described());
            }
            described.insert(output.name.clone(), json!({"files": entries, "bytes": bytes}));
        } else {
            let kept = keep_file(output, inside, files, tool, run, replayed).map_err(|refused| said(output, refused))?;
            described.insert(output.name.clone(), kept.described());
        }
    }
    Ok(Value::Object(described))
}

fn keep_file(output: &Output, inside: &Path, files: &dyn Files, tool: &str, run: &str, replayed: bool) -> Result<Kept, Refused> {
    let kept = if replayed { find(files, tool, run, output) } else { Err(crate::cause!(Refused::Missing)) };
    match kept {
            Err(Refused::Missing(_)) => open(output, inside).and_then(|(mut file, length)| {
                if output.identity.is_some() && length != output.limit { return Err(crate::cause!(Refused::TooLarge)) }
                if length > WRITE_MAX_BYTES as u64 {
                    store_pieces(files, tool, run, output, &mut file, length)
                } else {
                    let mut bytes = Vec::new();
                    file.take(output.limit.min(WRITE_MAX_BYTES as u64).saturating_add(1)).read_to_end(&mut bytes).map_err(|error| crate::carry_cause!(Refused::Missing, error))?;
                    if bytes.len() as u64 > output.limit || bytes.len() > WRITE_MAX_BYTES { return Err(crate::cause!(Refused::TooLarge)) }
                    verify_digest(output, &content_crypto::hash(&bytes))?;
                    store(files, tool, run, output, &bytes)
                }
            }),
            other => other,
    }
}

fn safe_member(path: &str) -> bool {
    relative_inside(path) && !path.contains('\\') && !path.chars().any(char::is_control)
        && path.split('/').all(single_name)
}

fn members(output: &Output, result: &Value) -> Result<Vec<Member>, Refused> {
    let tree = output.tree.as_ref().ok_or(crate::cause!(Refused::Unavailable))?;
    let entries = tree.files_from.split('.').try_fold(result, |value, field| value.get(field)).and_then(Value::as_array)
        .filter(|entries| entries.len() <= tree.max_files).ok_or(crate::cause!(Refused::TooLarge))?;
    let mut members: Vec<Member> = Vec::with_capacity(entries.len());
    let mut total = 0u64;
    for entry in entries {
        let fields = entry.as_object().filter(|fields| fields.len() == 3
            && fields.keys().all(|key| matches!(key.as_str(), "name" | "bytes" | "blake3"))).ok_or(crate::cause!(Refused::Unavailable))?;
        let relative = fields["name"].as_str().filter(|name| safe_member(name)).ok_or(crate::cause!(Refused::NotAFile))?;
        let bytes = fields["bytes"].as_u64().filter(|bytes| *bytes <= output.limit).ok_or(crate::cause!(Refused::TooLarge))?;
        let hash = fields["blake3"].as_str().filter(|hash| hash.len() == 64
            && hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))).ok_or(crate::cause!(Refused::Unavailable))?;
        total = total.checked_add(bytes).filter(|total| *total <= tree.max_bytes).ok_or(crate::cause!(Refused::TooLarge))?;
        if members.iter().any(|member| Path::new(relative).starts_with(&member.relative) || Path::new(&member.relative).starts_with(relative)) {
            return Err(crate::cause!(Refused::NotAFile));
        }
        members.push(Member { relative: relative.to_owned(), bytes, output: Output {
            name: format!("{}/{relative}", output.name), file: format!("{}/{relative}", output.name),
            path: output.path.join(relative), media_type: output.media_type.clone(), limit: bytes,
            tree: None, identity: Some(format!("1f:{hash}")),
        }});
    }
    members.sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok(members)
}

/// A manifest member must be an ordinary single-link file, through ordinary folders inside this run's private root.
/// No symlink, hard link, directory or special object is ever read as a declared tree member.
fn checked_member(output: &Output, inside: &Path, bytes: u64) -> Result<(), Refused> {
    if !output.path.starts_with(inside) { return Err(crate::cause!(Refused::NotAFile)) }
    for ancestor in output.path.ancestors().take_while(|path| *path != inside) {
        let metadata = fs::symlink_metadata(ancestor).map_err(|error| crate::carry_cause!(Refused::Missing, error))?;
        if ancestor == output.path.as_path() {
            if !metadata.is_file() || This::facts(&metadata).map_err(|error| crate::carry_cause!(Refused::Unavailable, error))?.links != 1 {
                return Err(crate::cause!(Refused::NotAFile));
            }
            if metadata.len() != bytes { return Err(crate::cause!(Refused::TooLarge)) }
        } else if !metadata.is_dir() { return Err(crate::cause!(Refused::NotAFile)) }
    }
    // The local source is hashed in bounded pieces before the first Namespace write. The uploader verifies again
    // while it reads, so a later change cannot publish a file with another identity under the original manifest.
    let (mut file, _) = open(output, inside)?;
    let mut hash = content_crypto::StreamingHasher::new();
    let mut buffer = vec![0; SUBTREE_BYTES];
    let mut read = 0u64;
    loop {
        let count = file.read(&mut buffer).map_err(|error| crate::carry_cause!(Refused::Missing, error))?;
        if count == 0 { break }
        read = read.checked_add(count as u64).filter(|read| *read <= bytes).ok_or(crate::cause!(Refused::TooLarge))?;
        hash.update(&buffer[..count]);
    }
    if read != bytes { return Err(crate::cause!(Refused::TooLarge)) }
    verify_digest(output, &hash.finalize())?;
    Ok(())
}

/// One output file's bytes: a regular file inside the run's folder, at most its limit.
fn open(output: &Output, inside: &Path) -> Result<(fs::File, u64), Refused> {
    let real = fs::canonicalize(&output.path).map_err(|error| crate::carry_cause!(Refused::Missing, error))?;
    if !real.starts_with(inside) {
        return Err(crate::cause!(Refused::NotAFile));
    }
    let file = fs::File::open(&real).map_err(|error| crate::carry_cause!(Refused::Missing, error))?;
    let metadata = file.metadata().map_err(|error| crate::carry_cause!(Refused::Missing, error))?;
    if !metadata.is_file() {
        return Err(crate::cause!(Refused::NotAFile));
    }
    if metadata.len() > output.limit {
        return Err(crate::cause!(Refused::TooLarge));
    }
    Ok((file, metadata.len()))
}

#[cfg(test)]
mod tests;
