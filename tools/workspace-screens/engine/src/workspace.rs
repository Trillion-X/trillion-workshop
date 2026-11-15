// src/workspace.rs
//
// Purpose: Adapt the existing workspace artifact and first-answer contract through actual injected owners.
//
// Non-Negotiable Invariants: Preserve exact artifact identities, current session and original canonical/live ownership; refuse missing supplies.
//
// Key Concepts: Pinned static tree and public versioned archives; supplied shared shell; bounded permits and response bodies.
//
// Security Considerations: No fabricated account, fallback UI, private native key in HTML, archive extraction or old Node backend.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

// Purpose: Host the existing versioned workspace assets and HTML/first-answer
// contract through CURRENT injected account, canonical operation and live owners.
// Invariants: no business screen catalogue, replacement styles, native bearer in
// the page, fallback account, Node backend, or inference of authority from assets.
// Security: pin the complete asset tree and exact manifest; confine paths; bound
// work/body lifetime; retain original operation recovery on cancellation.
// AI Assistant Directive: Preserve this contract documentation when changing it.
use crate::tool_runs::os::{Open, OwnerFiles, This};
use axum::{
    body::{to_bytes, Body, Bytes, HttpBody},
    extract::{Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    Router,
};
use content_crypto::advanced::blake3;
use http_body::{Frame, SizeHint};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    future::Future,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    task::{Context, Poll},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub use crate::workspace_modules as saved_modules;

pub type SupplyFuture<T> = Pin<Box<dyn Future<Output = Result<T, WorkspaceError>> + Send>>;
/// The closed set of HTTP answer classes a workspace request can end in (the classes are HTTP's, not a list a
/// package extends). `NoOwner` is the one answer for an operation nothing mounted in this process answers: no route
/// names it, or the owner it reaches serves a different request. It is final (404 with `failure_code` `no-owner`):
/// the page waits out a busy 503 but never asks again after a 404.
#[derive(Clone, Debug)]
pub enum WorkspaceError {
    Unavailable(crate::refusal_cause::Cause),
    Unauthorized(crate::refusal_cause::Cause),
    Forbidden(crate::refusal_cause::Cause),
    NotFound(crate::refusal_cause::Cause),
    Invalid(crate::refusal_cause::Cause),
    TooLarge(crate::refusal_cause::Cause),
    Conflict(crate::refusal_cause::Cause),
    Integrity(crate::refusal_cause::Cause),
    NoOwner(crate::refusal_cause::Cause),
}
/// Stable code in the `NoOwner` answer's body, for the page and for logs.
pub const NO_OWNER_CODE: &str = "no-owner";
impl WorkspaceError {
    /// Static identity of the condition that failed, retained across route mappings.
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Unavailable(cause) => cause.clone(),
            Self::Unauthorized(cause) => cause.clone(),
            Self::Forbidden(cause) => cause.clone(),
            Self::NotFound(cause) => cause.clone(),
            Self::Invalid(cause) => cause.clone(),
            Self::TooLarge(cause) => cause.clone(),
            Self::Conflict(cause) => cause.clone(),
            Self::Integrity(cause) => cause.clone(),
            Self::NoOwner(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(WorkspaceError);


impl IntoResponse for WorkspaceError {
    fn into_response(self) -> Response {
        let (status, message, code) = match self {
            Self::Unavailable(_) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "workspace owner unavailable",
                None,
            ),
            Self::Unauthorized(_) => (StatusCode::UNAUTHORIZED, "current sign-in required", None),
            Self::Forbidden(_) => (StatusCode::FORBIDDEN, "workspace request refused", None),
            Self::NotFound(_) => (StatusCode::NOT_FOUND, "workspace address not found", None),
            Self::Invalid(_) => (StatusCode::BAD_REQUEST, "invalid workspace request", None),
            Self::TooLarge(_) => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "workspace bound exceeded",
                None,
            ),
            Self::Conflict(_) => (StatusCode::CONFLICT, "workspace request conflicts", None),
            Self::Integrity(_) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "workspace artifact unavailable",
                None,
            ),
            Self::NoOwner(_) => (
                StatusCode::NOT_FOUND,
                "nothing here answers this request",
                Some(NO_OWNER_CODE),
            ),
        };
        let mut body = match code {
            Some(code) => json!({"error":message,"failure_code":code}),
            None => json!({"error":message}),
        };
        body["cause"] = json!(self.cause().id());
        crate::quiet_eprintln!("workspace-refusal status={} cause={}", status.as_u16(), self.cause());
        (
            status,
            [(header::CACHE_CONTROL, "no-store")],
            axum::Json(body),
        )
            .into_response()
    }
}
fn digest(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Clone)]
struct Asset {
    relative: String,
    bytes: u64,
    identity: String,
}
pub struct WorkspaceAssets {
    root: PathBuf,
    files: BTreeMap<String, Asset>,
    public_assets: BTreeMap<String, String>,
    manifest: Value,
    manifest_identity: String,
    tree_identity: String,
    modules: Option<ScreenModules>,
}
impl WorkspaceAssets {
    /// Uses the existing localRuntimeTree JSON-line BLAKE3 representation. Pins
    /// must come from the admitted artifact owner, never the requesting browser.
    /// Opening is bounded initialization; it does not execute any asset or script.
    pub fn open(
        root: impl AsRef<Path>,
        manifest_identity: &str,
        tree_identity: &str,
    ) -> Result<Self, WorkspaceError> {
        Self::open_with_modules(root, manifest_identity, tree_identity, None)
    }
    /// Versioned screen modules have their own ORIGINAL archive owner, not the
    /// static workspace directory. Only an explicitly pinned set may satisfy it.
    pub fn open_with_modules(
        root: impl AsRef<Path>,
        manifest_identity: &str,
        tree_identity: &str,
        modules: Option<ScreenModules>,
    ) -> Result<Self, WorkspaceError> {
        Self::open_keeping(root, manifest_identity, tree_identity, modules, None)
    }
    /// `open_with_modules`, keeping the tree's rows when `kept` names a folder: the rows (the exact JSON-line bytes
    /// the tree identity is the BLAKE3 of) are kept in `kept/<tree identity>`, so a later open of the same tree reads
    /// that one file instead of every asset. A kept file is used only when its BLAKE3 is the pinned tree identity, so
    /// it needs no trust of its own; any other content is read from the folder and kept again. Each asset's bytes are
    /// still checked against its row's identity on every read (`read_pinned`), so a changed asset is refused when it
    /// is read. Measured on 2026-10-30 at load 100: reading and hashing the 64 MB, 1,624-file tree was 215-276 ms of
    /// every warm native start and 1,037 ms of a cold one.
    pub fn open_keeping(
        root: impl AsRef<Path>,
        manifest_identity: &str,
        tree_identity: &str,
        modules: Option<ScreenModules>,
        kept: Option<&Path>,
    ) -> Result<Self, WorkspaceError> {
        if !digest(manifest_identity) || !digest(tree_identity) {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
        let root = root.as_ref().canonicalize().map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        let is_tree = |rows: &[u8]| {
            content_crypto::advanced::blake3::hash(rows)
                .to_hex()
                .as_str()
                == tree_identity
        };
        let file = kept.map(|kept| kept.join(tree_identity));
        let rows = match file.as_deref().and_then(kept_rows) {
            Some(rows) if is_tree(&rows) => rows,
            _ => {
                let rows = scan_rows(&root)?;
                if !is_tree(&rows) {
                    return Err(crate::cause!(WorkspaceError::Integrity));
                }
                if let (Some(kept), Some(file)) = (kept, file.as_deref()) {
                    keep_rows(kept, file, &rows);
                }
                rows
            }
        };
        let files = table(&rows)?;
        let manifest_asset = files
            .get("/workspace/files.json")
            .ok_or(crate::cause!(WorkspaceError::Integrity))?;
        if manifest_asset.identity != manifest_identity || manifest_asset.bytes > 2 * 1024 * 1024 {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        let raw = read_pinned(&root, manifest_asset)?;
        let manifest: Value = serde_json::from_slice(&raw).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        for key in ["script", "stylesheet"] {
            check_reference(
                manifest
                    .get(key)
                    .and_then(Value::as_str)
                    .ok_or(crate::cause!(WorkspaceError::Integrity))?,
                &files,
            )?;
        }
        let preload = manifest
            .get("preload")
            .and_then(Value::as_array)
            .ok_or(crate::cause!(WorkspaceError::Integrity))?;
        for value in preload {
            check_reference(value.as_str().ok_or(crate::cause!(WorkspaceError::Integrity))?, &files)?;
        }
        let screens = manifest
            .get("screens")
            .and_then(Value::as_object)
            .ok_or(crate::cause!(WorkspaceError::Integrity))?;
        for value in screens.values() {
            for path in value.as_array().ok_or(crate::cause!(WorkspaceError::Integrity))? {
                check_reference(path.as_str().ok_or(crate::cause!(WorkspaceError::Integrity))?, &files)?;
            }
        }
        let imports = manifest
            .pointer("/import_map/imports")
            .and_then(Value::as_object)
            .ok_or(crate::cause!(WorkspaceError::Integrity))?;
        for value in imports.values() {
            let path = value.as_str().ok_or(crate::cause!(WorkspaceError::Integrity))?;
            if path.starts_with("/workshop/modules/") {
                modules
                    .as_ref()
                    .ok_or(crate::cause!(WorkspaceError::Integrity))?
                    .check(path)?;
            } else {
                check_reference(path, &files)?;
            }
        }
        check_manifest_references(&manifest, &files, modules.as_ref())?;
        let public_assets = public_asset_aliases(&manifest, &files)?;
        Ok(Self {
            root,
            files,
            public_assets,
            manifest,
            manifest_identity: manifest_identity.into(),
            tree_identity: tree_identity.into(),
            modules,
        })
    }
    pub fn manifest_identity(&self) -> &str {
        &self.manifest_identity
    }
    pub fn tree_identity(&self) -> &str {
        &self.tree_identity
    }
    pub fn manifest(&self) -> &Value {
        &self.manifest
    }
    /// Only immutable product files admitted by this exact tree are public.
    /// This is not an account-file or arbitrary filesystem classifier.
    fn public_program(&self, path: &str) -> Result<bool, WorkspaceError> {
        if self.public_assets.contains_key(path) {
            return Ok(true);
        }
        if path.starts_with("/workspace/") {
            return if self.files.contains_key(&asset_path(path)?) {
                Ok(true)
            } else {
                Err(crate::cause!(WorkspaceError::NotFound))
            };
        }
        Ok(false)
    }
    pub fn read(&self, path: &str) -> Result<Vec<u8>, WorkspaceError> {
        if path.starts_with("/workshop/modules/") {
            return self
                .modules
                .as_ref()
                .ok_or(crate::cause!(WorkspaceError::NotFound))?
                .read(path);
        }
        let path = asset_path(self.public_assets.get(path).map_or(path, String::as_str))?;
        read_pinned(
            &self.root,
            self.files.get(&path).ok_or(crate::cause!(WorkspaceError::NotFound))?,
        )
    }
}

/// The preserved screen-modules.json + content-addressed tar.gz owner.
/// Reads only explicitly declared public program bytes; never extracts files,
/// executes code, reads account data or infers account/operation authority.
pub struct ScreenModules {
    manifest_identity: String,
    files: BTreeMap<String, Bytes>,
}
impl ScreenModules {
    pub fn open(
        built_root: impl AsRef<Path>,
        manifest_identity: &str,
    ) -> Result<Self, WorkspaceError> {
        if !digest(manifest_identity) {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
        let root = built_root.as_ref().canonicalize().map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        let manifest_path = root.join("screen-modules.json");
        let metadata = fs::symlink_metadata(&manifest_path).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        if !metadata.is_file() || metadata.len() > 1024 * 1024 {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        let raw = limited_file(&manifest_path, metadata.len())?;
        if blake3::hash(&raw).to_hex().as_str() != manifest_identity {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        let manifest: Value = serde_json::from_slice(&raw).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        let modules = manifest
            .get("modules")
            .and_then(Value::as_object)
            .ok_or(crate::cause!(WorkspaceError::Integrity))?;
        if modules.len() > 64 {
            return Err(crate::cause!(WorkspaceError::TooLarge));
        }
        let mut files = BTreeMap::new();
        let mut counts = BTreeMap::new();
        let mut compressed = 0_u64;
        let mut inflated_total = 0_usize;
        let mut entries_total = 0_usize;
        for row in modules.values() {
            let bundle = row
                .get("bundle")
                .and_then(Value::as_str)
                .ok_or(crate::cause!(WorkspaceError::Integrity))?;
            let hash = bundle
                .strip_prefix("1f:")
                .filter(|h| digest(h))
                .ok_or(crate::cause!(WorkspaceError::Integrity))?;
            let entry_name = row
                .get("file")
                .and_then(Value::as_str)
                .filter(|n| safe_member(n))
                .ok_or(crate::cause!(WorkspaceError::Integrity))?;
            let expected = row
                .get("files")
                .and_then(Value::as_u64)
                .filter(|n| (1..=256).contains(n))
                .ok_or(crate::cause!(WorkspaceError::Integrity))? as usize;
            if !counts.contains_key(bundle) {
                let archive_path = root
                    .join("screen-modules")
                    .join(format!("{hash}.tar.gz"))
                    .canonicalize()
                    .map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
                if !archive_path.starts_with(&root) {
                    return Err(crate::cause!(WorkspaceError::Integrity));
                }
                let meta = fs::symlink_metadata(&archive_path).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
                if !meta.is_file() {
                    return Err(crate::cause!(WorkspaceError::Integrity));
                }
                compressed = compressed
                    .checked_add(meta.len())
                    .ok_or(crate::cause!(WorkspaceError::TooLarge))?;
                if compressed > 16 * 1024 * 1024 {
                    return Err(crate::cause!(WorkspaceError::TooLarge));
                }
                let archive_bytes = limited_file(&archive_path, meta.len())?;
                if blake3::hash(&archive_bytes).to_hex().as_str() != hash {
                    return Err(crate::cause!(WorkspaceError::Integrity));
                }
                let parsed = saved_modules::parse_screen_archive_with_budget(
                    saved_modules::ScreenBundleIdentity::parse(bundle)?,
                    &archive_bytes,
                    (64 * 1024 * 1024_usize).saturating_sub(inflated_total),
                    1024_usize.saturating_sub(entries_total),
                )?;
                inflated_total = inflated_total
                    .checked_add(parsed.expanded_bytes())
                    .ok_or(crate::cause!(WorkspaceError::TooLarge))?;
                entries_total = entries_total
                    .checked_add(parsed.member_count())
                    .ok_or(crate::cause!(WorkspaceError::TooLarge))?;
                if inflated_total > 64 * 1024 * 1024 || entries_total > 1024 {
                    return Err(crate::cause!(WorkspaceError::TooLarge));
                }
                for (name, body) in parsed.files() {
                    files.insert(
                        format!("/workshop/modules/{bundle}/{name}"),
                        Bytes::copy_from_slice(body),
                    );
                }
                counts.insert(bundle.to_owned(), parsed.member_count());
            }
            if counts.get(bundle) != Some(&expected)
                || !files.contains_key(&format!("/workshop/modules/{bundle}/{entry_name}"))
            {
                return Err(crate::cause!(WorkspaceError::Integrity));
            }
        }
        Ok(Self {
            manifest_identity: manifest_identity.into(),
            files,
        })
    }
    pub fn manifest_identity(&self) -> &str {
        &self.manifest_identity
    }
    fn check(&self, path: &str) -> Result<(), WorkspaceError> {
        if !self.files.contains_key(&module_path(path)?) {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        Ok(())
    }
    fn read(&self, path: &str) -> Result<Vec<u8>, WorkspaceError> {
        self.files
            .get(&module_path(path)?)
            .map(|b| b.to_vec())
            .ok_or(crate::cause!(WorkspaceError::NotFound))
    }
}
fn safe_member(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.starts_with('/')
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
        && !path
            .chars()
            .any(|c| c.is_control() || matches!(c, '\\' | ':' | '?' | '#'))
}
fn module_path(path: &str) -> Result<String, WorkspaceError> {
    let decoded = decoded_path(path, "/workshop/modules/")?;
    let (bundle, file) = decoded
        .strip_prefix("/workshop/modules/")
        .and_then(|v| v.split_once('/'))
        .ok_or(crate::cause!(WorkspaceError::Invalid))?;
    if !bundle.strip_prefix("1f:").is_some_and(digest) || !safe_member(file) {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    Ok(decoded)
}
fn check_reference(path: &str, files: &BTreeMap<String, Asset>) -> Result<(), WorkspaceError> {
    if !files.contains_key(&asset_path(path)?) {
        return Err(crate::cause!(WorkspaceError::Integrity));
    }
    Ok(())
}
/// Optional pinned DATA can give a public program file a stable root-file URL.
/// Aliases are canonical ASCII filenames with an extension, never a page, operation,
/// directory or encoded path. Targets remain exact files in the pinned named tree;
/// no alias can expose an arbitrary file or replace an existing tree address.
fn public_asset_aliases(
    manifest: &Value,
    files: &BTreeMap<String, Asset>,
) -> Result<BTreeMap<String, String>, WorkspaceError> {
    let Some(value) = manifest.get("public_assets") else {
        return Ok(BTreeMap::new());
    };
    let aliases = value.as_object().ok_or(crate::cause!(WorkspaceError::Integrity))?;
    let mut result = BTreeMap::new();
    for (alias, value) in aliases {
        let name = alias.strip_prefix('/').ok_or(crate::cause!(WorkspaceError::Integrity))?;
        if name.len() > 255
            || !name.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
            || !name.as_bytes().last().is_some_and(u8::is_ascii_alphanumeric)
            || !name.contains('.')
            || name.bytes().any(|byte| !byte.is_ascii_alphanumeric() && !b"._-".contains(&byte))
            || files.contains_key(alias)
        {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        let target = value.as_str().ok_or(crate::cause!(WorkspaceError::Integrity))?;
        if !target.starts_with("/workspace/named/") || asset_path(target)? != target {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        check_reference(target, files)?;
        result.insert(alias.clone(), target.to_owned());
    }
    Ok(result)
}
fn check_manifest_references(
    value: &Value,
    files: &BTreeMap<String, Asset>,
    modules: Option<&ScreenModules>,
) -> Result<(), WorkspaceError> {
    match value {
        Value::String(path) if path.starts_with("/workspace/") => check_reference(path, files),
        Value::String(path) if path.starts_with("/workshop/modules/") => {
            modules.ok_or(crate::cause!(WorkspaceError::Integrity))?.check(path)
        }
        Value::Array(values) => {
            for value in values {
                check_manifest_references(value, files, modules)?;
            }
            Ok(())
        }
        Value::Object(values) => {
            for value in values.values() {
                check_manifest_references(value, files, modules)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}
fn tree_row(rows: &mut Vec<u8>, value: impl Serialize) -> Result<(), WorkspaceError> {
    serde_json::to_writer(&mut *rows, &value).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
    rows.push(b'\n');
    Ok(())
}
/// The tree's rows, read from the folder: a directory row `[path, "directory", mode]` and a file row
/// `[path, "file", mode, bytes, blake3]` per entry, in name order, one JSON line each.
fn scan_rows(root: &Path) -> Result<Vec<u8>, WorkspaceError> {
    let (mut rows, mut count, mut bytes) = (Vec::new(), 0, 0);
    scan_assets(root, "", &mut rows, &mut count, &mut bytes)?;
    Ok(rows)
}
/// The served files of a tree, from its rows. The rows were checked against the pinned tree identity first.
fn table(rows: &[u8]) -> Result<BTreeMap<String, Asset>, WorkspaceError> {
    let mut files = BTreeMap::new();
    for (count, line) in rows
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .enumerate()
    {
        if count >= 4096 {
            return Err(crate::cause!(WorkspaceError::TooLarge));
        }
        let row: Vec<Value> = serde_json::from_slice(line).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        let relative = row
            .first()
            .and_then(Value::as_str)
            .filter(|path| {
                !path.starts_with('/')
                    && path
                        .split('/')
                        .all(|part| !part.is_empty() && part != "." && part != "..")
            })
            .ok_or(crate::cause!(WorkspaceError::Integrity))?;
        match (row.get(1).and_then(Value::as_str), row.len()) {
            (Some("directory"), 3) => {}
            (Some("file"), 5) => {
                let bytes = row[3].as_u64().ok_or(crate::cause!(WorkspaceError::Integrity))?;
                let identity = row[4]
                    .as_str()
                    .filter(|identity| digest(identity))
                    .ok_or(crate::cause!(WorkspaceError::Integrity))?;
                files.insert(
                    format!("/{relative}"),
                    Asset {
                        relative: relative.to_owned(),
                        bytes,
                        identity: identity.to_owned(),
                    },
                );
            }
            _ => return Err(crate::cause!(WorkspaceError::Integrity)),
        }
    }
    Ok(files)
}
/// A kept rows file's bytes, or nothing when it is absent, not a regular file or larger than any tree's rows can be.
fn kept_rows(file: &Path) -> Option<Vec<u8>> {
    let metadata = fs::symlink_metadata(file).ok()?;
    if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
        return None;
    }
    limited_file(file, metadata.len()).ok()
}
/// Keep a tree's rows under their identity (written whole, then renamed to its name). A failure only means the next
/// open reads the tree again.
fn keep_rows(kept: &Path, file: &Path, rows: &[u8]) {
    // Owner-only folders (src/tool_runs/os.rs `OwnerFiles`); a computer without them keeps no rows.
    if This::make_folder(kept, 0o700, true).is_err() {
        return;
    }
    let partial = file.with_extension(format!("partial-{}", std::process::id()));
    if fs::write(&partial, rows).is_ok() && fs::rename(&partial, file).is_err() {
        let _ = fs::remove_file(&partial);
    }
}
fn scan_assets(
    root: &Path,
    relative: &str,
    rows: &mut Vec<u8>,
    count: &mut usize,
    bytes: &mut u64,
) -> Result<(), WorkspaceError> {
    if relative.len() > 4096 || relative.split('/').count() > 64 {
        return Err(crate::cause!(WorkspaceError::TooLarge));
    }
    let remaining = 4096_usize.saturating_sub(*count);
    let mut children = fs::read_dir(root.join(relative))
        .map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?
        .take(remaining + 1)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
    if children.len() > remaining {
        return Err(crate::cause!(WorkspaceError::TooLarge));
    }
    children.sort_by_key(|entry| entry.file_name());
    for entry in children {
        *count += 1;
        if *count > 4096 {
            return Err(crate::cause!(WorkspaceError::TooLarge));
        }
        let name = entry.file_name().into_string().map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        if name == "." || name == ".." || name.contains(['/', '\\']) {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        let rel = if relative.is_empty() {
            name
        } else {
            format!("{relative}/{name}")
        };
        let metadata = fs::symlink_metadata(root.join(&rel)).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        let mode = This::mode_of(&metadata.permissions())
            .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?
            & 0o777;
        if metadata.is_dir() {
            tree_row(rows, (&rel, "directory", mode))?;
            scan_assets(root, &rel, rows, count, bytes)?;
        } else if metadata.is_file() {
            if metadata.len() > 64 * 1024 * 1024 {
                return Err(crate::cause!(WorkspaceError::TooLarge));
            }
            *bytes = bytes
                .checked_add(metadata.len())
                .ok_or(crate::cause!(WorkspaceError::TooLarge))?;
            if *bytes > 256 * 1024 * 1024 {
                return Err(crate::cause!(WorkspaceError::TooLarge));
            }
            let raw = limited_file(&root.join(&rel), metadata.len())?;
            let identity = blake3::hash(&raw).to_hex().to_string();
            tree_row(rows, (&rel, "file", mode, metadata.len(), &identity))?;
        } else {
            return Err(crate::cause!(WorkspaceError::Integrity));
        } // no escaping or mutable symbolic-link supply
    }
    Ok(())
}
fn limited_file(path: &Path, bytes: u64) -> Result<Vec<u8>, WorkspaceError> {
    let file =
        This::open(fs::OpenOptions::new().read(true), path, Open::NO_FOLLOW).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
    let metadata = file.metadata().map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
    if !metadata.is_file() || metadata.len() != bytes {
        return Err(crate::cause!(WorkspaceError::Integrity));
    }
    let mut raw = Vec::new();
    file.take(bytes + 1)
        .read_to_end(&mut raw)
        .map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
    if raw.len() as u64 != bytes {
        return Err(crate::cause!(WorkspaceError::Integrity));
    }
    Ok(raw)
}
fn read_pinned(root: &Path, asset: &Asset) -> Result<Vec<u8>, WorkspaceError> {
    let path = root
        .join(&asset.relative)
        .canonicalize()
        .map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
    if !path.starts_with(root) {
        return Err(crate::cause!(WorkspaceError::Integrity));
    }
    let bytes = limited_file(&path, asset.bytes)?;
    if blake3::hash(&bytes).to_hex().as_str() != asset.identity {
        return Err(crate::cause!(WorkspaceError::Integrity));
    }
    Ok(bytes)
}
fn asset_path(path: &str) -> Result<String, WorkspaceError> {
    decoded_path(path, "/workspace/")
}
fn decoded_path(path: &str, prefix: &str) -> Result<String, WorkspaceError> {
    if path.len() > 4096 || !path.starts_with(prefix) || path.contains(['?', '#']) {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    let mut result = String::new();
    for part in path.split('/').skip(1) {
        let mut decoded = Vec::new();
        let bytes = part.as_bytes();
        let mut at = 0;
        while at < bytes.len() {
            if bytes[at] == b'%' {
                if at + 2 >= bytes.len() {
                    return Err(crate::cause!(WorkspaceError::Invalid));
                }
                let hex = std::str::from_utf8(&bytes[at + 1..at + 3])
                    .map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
                decoded.push(u8::from_str_radix(hex, 16).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?);
                at += 3;
            } else {
                decoded.push(bytes[at]);
                at += 1;
            }
        }
        let decoded = String::from_utf8(decoded).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
        if decoded.is_empty()
            || decoded == "."
            || decoded == ".."
            || decoded
                .chars()
                .any(|c| c.is_control() || matches!(c, '/' | '\\' | '?' | '#'))
        {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
        result.push('/');
        result.push_str(&decoded);
    }
    Ok(result)
}

/// These names are read from the SAME source contract as the selected bundle.
pub struct WorkspaceDom {
    answers_id: String,
    item_reads_id: String,
    source_identity: String,
}
impl WorkspaceDom {
    pub fn from_source(bytes: &[u8], expected: &str) -> Result<Self, WorkspaceError> {
        if bytes.len() > 1024 * 1024
            || !digest(expected)
            || blake3::hash(bytes).to_hex().as_str() != expected
        {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        let value: Value = serde_json::from_slice(bytes).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        let answers_id = value
            .get("element_id")
            .and_then(Value::as_str)
            .filter(|v| html_id(v))
            .ok_or(crate::cause!(WorkspaceError::Integrity))?
            .into();
        let item_reads_id = value
            .pointer("/item_reads/element_id")
            .and_then(Value::as_str)
            .filter(|v| html_id(v))
            .ok_or(crate::cause!(WorkspaceError::Integrity))?
            .into();
        Ok(Self {
            answers_id,
            item_reads_id,
            source_identity: expected.into(),
        })
    }
    pub fn source_identity(&self) -> &str {
        &self.source_identity
    }
}
fn html_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

// Session/cookie data deliberately has no Debug or Serialize implementation.
#[derive(Clone)]
pub struct WorkspaceRequestHead {
    pub method: Method,
    pub uri: Uri,
    pub headers: HeaderMap,
}
pub struct WorkspaceRequest {
    pub head: WorkspaceRequestHead,
    pub body: Bytes,
}
pub struct WorkspaceSession {
    pub account_id: String,
    pub session_id: String,
}
pub trait CurrentSession: Send + Sync {
    /// Recheck current sign-in/revocation/selected local origin; asset or listener
    /// identity alone MUST NOT create this answer. No SQL is imposed by the host.
    fn current(
        &self,
        request: WorkspaceRequestHead,
        permit: WorkspacePermit,
    ) -> SupplyFuture<WorkspaceSession>;
    /// The origin (`scheme://host[:port]`) a request came by, when the session owner answers at more than its local
    /// listener; `None`: the request's own loopback Host is the page's address.
    fn origin_of(&self, _request: &WorkspaceRequestHead) -> Option<String> {
        None
    }
}
/// Ordinary Rust JSON and original ECMAScript JSON share the same bounded
/// answer envelope. The latter retains UTF-16 code units, order and binary64
/// values without a lossy serde conversion or a string-valued body.
#[derive(Clone)]
pub enum WorkspaceAnswerEnvelope {
    Json(Value),
    Ecma(crate::ecma_json::Value),
}
impl From<Value> for WorkspaceAnswerEnvelope {
    fn from(value: Value) -> Self {
        Self::Json(value)
    }
}
impl From<crate::ecma_json::Value> for WorkspaceAnswerEnvelope {
    fn from(value: crate::ecma_json::Value) -> Self {
        Self::Ecma(value)
    }
}
pub fn workspace_json_limits(bytes: usize) -> crate::ecma_json::Limits {
    let bytes = bytes.min(crate::ecma_json::HARD_BYTES);
    crate::ecma_json::Limits {
        input_bytes: bytes,
        output_bytes: bytes,
        depth: crate::ecma_json::HARD_DEPTH,
        nodes: crate::ecma_json::HARD_NODES,
        string_units: bytes,
        total_string_units: bytes,
        container_entries: crate::ecma_json::HARD_NODES,
        number_bytes: crate::ecma_json::HARD_NUMBER_BYTES,
    }
}
impl WorkspaceAnswerEnvelope {
    pub fn status(&self) -> Option<u16> {
        let number = match self {
            Self::Json(value) => value
                .get("status")
                .and_then(Value::as_u64)
                .map(|v| v as f64),
            Self::Ecma(crate::ecma_json::Value::Object(value)) => match value.get(&"status".into())
            {
                Some(crate::ecma_json::Value::Number(v)) => Some(*v),
                _ => None,
            },
            _ => None,
        }?;
        (number.is_finite() && number.fract() == 0.0 && (100.0..=599.0).contains(&number))
            .then_some(number as u16)
    }
    pub fn has_body(&self) -> bool {
        match self {
            Self::Json(value) => value.get("body").is_some(),
            Self::Ecma(crate::ecma_json::Value::Object(value)) => {
                value.get(&"body".into()).is_some()
            }
            _ => false,
        }
    }
    pub fn json_text(&self, limit: usize) -> Result<String, WorkspaceError> {
        match self {
            Self::Json(value) => {
                let mut output = BoundedText {
                    bytes: Vec::new(),
                    limit,
                    escape_script: false,
                };
                serde_json::to_writer(&mut output, value).map_err(|error| crate::carry_cause!(WorkspaceError::TooLarge, error))?;
                String::from_utf8(output.bytes).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))
            }
            Self::Ecma(value) => crate::ecma_json::stringify(value, workspace_json_limits(limit))
                .map_err(|error| crate::carry_cause!(WorkspaceError::TooLarge, error)),
        }
    }
}
pub struct FirstAnswer {
    pub path: String,
    pub envelope: WorkspaceAnswerEnvelope,
    pub copy: bool,
}
pub struct WorkspacePage {
    /// Existing shared page-shell output, with #root, without its island script.
    /// The host supplies no fallback shell, theme, layout, account or key.
    pub document: String,
    pub screen_entry: Option<String>,
    pub listed_reads: Vec<String>,
    pub item_reads: Vec<String>,
    pub known: Vec<(String, Value)>,
    pub answers: Vec<FirstAnswer>,
}
pub enum WorkspacePageResponse {
    Complete(WorkspacePage),
    Stream(WorkspaceStreamingPage),
}
pub struct WorkspaceStreamingPage {
    pub page: WorkspacePage,
    pub reads: crate::workspace_stream::WorkspaceReadBatch,
    pub limits: crate::workspace_stream::StreamLimits,
}
pub trait WorkspaceOperations: Send + Sync {
    /// Existing complete-page consumers keep their one original call. Actual
    /// producers can return the typed head-first path without a second auth read.
    fn page_response(
        &self,
        session: WorkspaceSession,
        request: WorkspaceRequestHead,
        permit: WorkspacePermit,
    ) -> SupplyFuture<WorkspacePageResponse> {
        let answer = self.page(session, request, permit);
        Box::pin(async move { answer.await.map(WorkspacePageResponse::Complete) })
    }
    fn page(
        &self,
        session: WorkspaceSession,
        request: WorkspaceRequestHead,
        permit: WorkspacePermit,
    ) -> SupplyFuture<WorkspacePage>;
    /// Dispatch through the canonical operation owner, including fresh commit
    /// checks, original idempotency/uncertain-effect recovery and response shape.
    /// A detached blocking worker MUST retain the supplied permit until it ends.
    fn invoke(
        &self,
        session: WorkspaceSession,
        request: WorkspaceRequest,
        permit: WorkspacePermit,
    ) -> SupplyFuture<Response>;
}
pub trait WorkspaceLive: Send + Sync {
    /// The existing live protocol owner performs upgrade, Origin/session rights,
    /// revision/resume/window semantics and closure. Retain permit for the actual
    /// upgraded connection, not merely the 101 response; obey its cancellation.
    fn subscribe(
        &self,
        session: WorkspaceSession,
        request: Request,
        permit: WorkspacePermit,
    ) -> SupplyFuture<Response>;
}
pub struct WorkspaceSupplies {
    pub sessions: Option<Arc<dyn CurrentSession>>,
    pub operations: Option<Arc<dyn WorkspaceOperations>>,
    pub live: Option<Arc<dyn WorkspaceLive>>,
    pub dom: WorkspaceDom,
}
/// `max_inflight` requests of one kind run at once (private requests, public program reads, live sockets each have
/// their own). A request past them waits in a fair queue of at most `max_waiting` private requests (program reads:
/// the admitted product inventory) for at most `admission_wait`, then is refused busy (503). A page opens with more
/// reads than `max_inflight` at once, so refusing them at once instead of queueing answered 503 to the page's own first
/// reads (Mac app, 2026-10-30: viewer, workspace:read and show rules refused in 2 ms while 8 others ran).
#[derive(Clone, Copy)]
pub struct WorkspaceLimits {
    pub max_inflight: usize,
    pub max_waiting: usize,
    pub admission_wait: std::time::Duration,
    pub request_bytes: usize,
    pub response_bytes: usize,
    pub document_bytes: usize,
}
impl Default for WorkspaceLimits {
    fn default() -> Self {
        Self {
            max_inflight: 8,
            max_waiting: 256,
            admission_wait: std::time::Duration::from_secs(15),
            request_bytes: 1024 * 1024,
            response_bytes: 64 * 1024 * 1024,
            document_bytes: 16 * 1024 * 1024,
        }
    }
}
/// A live socket holds `active` for its whole life; a request holds its queued `slot` until its body ends.
struct PermitInner {
    active: Option<Arc<AtomicUsize>>,
    cancelled: Arc<AtomicBool>,
    _slot: Option<OwnedSemaphorePermit>,
}
impl Drop for PermitInner {
    fn drop(&mut self) {
        if let Some(active) = &self.active {
            active.fetch_sub(1, Ordering::AcqRel);
        }
    }
}
#[derive(Clone)]
pub struct WorkspacePermit(Arc<PermitInner>);
impl WorkspacePermit {
    pub fn cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::Acquire)
    }
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::Release);
    }
    /// Share the existing request cancellation state with bounded synchronous
    /// suppliers. This creates no new lifetime, grant or cancellation owner.
    pub fn cancellation_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.0.cancelled)
    }
}
struct CancelOnDrop(Option<WorkspacePermit>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(permit) = &self.0 {
            permit.cancel();
        }
    }
}
/// One kind of request's permits and how many wait for one.
struct Slots {
    slots: Arc<Semaphore>,
    waiting: Arc<AtomicUsize>,
}
impl Slots {
    fn new(count: usize) -> Self {
        Self {
            slots: Arc::new(Semaphore::new(count)),
            waiting: Arc::new(AtomicUsize::new(0)),
        }
    }
}
struct WorkspaceState {
    assets: Arc<WorkspaceAssets>,
    supplies: WorkspaceSupplies,
    limits: WorkspaceLimits,
    live: Arc<AtomicUsize>,
    operations: Slots,
    programs: Slots,
    saved_modules: Option<Arc<saved_modules::SavedScreenModules>>,
    page_policy: PagePolicy,
}
pub fn route_table(
    assets: Arc<WorkspaceAssets>,
    supplies: WorkspaceSupplies,
    limits: WorkspaceLimits,
) -> Result<Router, WorkspaceError> {
    route_table_with_module_reader(assets, supplies, limits, None)
}
/// Adds the existing public content owner's saved-screen reader. This
/// supplies program bytes only; account/API/live authorization stays unchanged.
pub fn route_table_with_saved_modules(
    assets: Arc<WorkspaceAssets>,
    supplies: WorkspaceSupplies,
    limits: WorkspaceLimits,
    modules: Arc<saved_modules::SavedScreenModules>,
) -> Result<Router, WorkspaceError> {
    route_table_with_module_reader(assets, supplies, limits, Some(modules))
}
fn route_table_with_module_reader(
    assets: Arc<WorkspaceAssets>,
    supplies: WorkspaceSupplies,
    limits: WorkspaceLimits,
    saved_modules: Option<Arc<saved_modules::SavedScreenModules>>,
) -> Result<Router, WorkspaceError> {
    if !(1..=64).contains(&limits.max_inflight)
        || !(1..=4096).contains(&limits.max_waiting)
        || limits.admission_wait.is_zero()
        || limits.admission_wait > std::time::Duration::from_secs(60)
        || !(1..=16 * 1024 * 1024).contains(&limits.request_bytes)
        || !(1..=256 * 1024 * 1024).contains(&limits.response_bytes)
        || !(1024..=64 * 1024 * 1024).contains(&limits.document_bytes)
    {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    let page_policy = PagePolicy::shipped()?;
    Ok(Router::new()
        .fallback(dispatch)
        .with_state(Arc::new(WorkspaceState {
            assets,
            supplies,
            limits,
            live: Arc::new(AtomicUsize::new(0)),
            operations: Slots::new(limits.max_inflight),
            programs: Slots::new(limits.max_inflight),
            saved_modules,
            page_policy,
        })))
}
/// A live socket holds its count for as long as it is open, so it never takes a request's permit (a page's own socket
/// held one of the eight for its whole life); at most `max_inflight` are open at once, and one more is refused at once.
fn admit_live(state: &WorkspaceState) -> Result<WorkspacePermit, WorkspaceError> {
    state
        .live
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            (n < state.limits.max_inflight).then_some(n + 1)
        })
        .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
    Ok(WorkspacePermit(Arc::new(PermitInner {
        active: Some(Arc::clone(&state.live)),
        cancelled: Arc::new(AtomicBool::new(false)),
        _slot: None,
    })))
}
/// Every request waits fairly for a permit of its kind instead of being refused when a burst arrives: private requests
/// (pages and /work/api operations) and public program reads have separate permits, so a module preload burst never
/// holds up the person's reads, and reading public code never acquires account authority. Queue memory is bounded:
/// at most `maximum_waiting` wait (for program reads, the admitted product inventory, one full declared preload
/// burst), each for at most `admission_wait`; past either the request is refused busy (503).
async fn admit_queued(
    slots: &Slots,
    maximum_waiting: usize,
    wait: std::time::Duration,
) -> Result<WorkspacePermit, WorkspaceError> {
    slots
        .waiting
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            (n < maximum_waiting).then_some(n + 1)
        })
        .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
    struct Waiting(Arc<AtomicUsize>);
    impl Drop for Waiting {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::AcqRel);
        }
    }
    let waiting = Waiting(slots.waiting.clone());
    let slot = tokio::time::timeout(wait, slots.slots.clone().acquire_owned())
        .await
        .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?
        .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
    drop(waiting);
    Ok(WorkspacePermit(Arc::new(PermitInner {
        active: None,
        cancelled: Arc::new(AtomicBool::new(false)),
        _slot: Some(slot),
    })))
}
fn is_live_path(path: &str) -> bool {
    path == "/work/live" || path.starts_with("/work/live/")
}
async fn dispatch(State(state): State<Arc<WorkspaceState>>, request: Request) -> Response {
    let preference = crate::mcp::work_requested(request.headers());
    if preference != Some(true) {
        let mut response = dispatch_measured(state, request).await;
        if preference.is_some() { response.headers_mut().insert(crate::mcp::WORK_HEADER, axum::http::HeaderValue::from_static("unavailable")); }
        return response;
    }
    let work = crate::storage::request_work::RequestWork::default();
    let is_operation = request.uri().path().starts_with("/work/") && !is_live_path(request.uri().path());
    let response = work.observe(dispatch_measured(state, request)).await;
    if is_operation && response.status().is_success() { crate::mcp::measure_response(&work, response) } else { response }
}
async fn dispatch_measured(state: Arc<WorkspaceState>, request: Request) -> Response {
    let path = request.uri().path();
    let product_program = match state.assets.public_program(path) {
        Ok(public) => public,
        Err(error) => return error.into_response(),
    };
    if product_program && !matches!(*request.method(), Method::GET | Method::HEAD) {
        return crate::cause!(WorkspaceError::Invalid).into_response();
    }
    let public_module = path.starts_with("/workshop/modules/");
    if public_module {
        if !matches!(*request.method(), Method::GET | Method::HEAD) {
            return crate::cause!(WorkspaceError::Invalid).into_response();
        }
        if let Err(error) = module_path(path) {
            return error.into_response();
        }
    }
    let live_request = is_live_path(path);
    let admitted = if product_program || public_module {
        admit_queued(
            &state.programs,
            state.assets.files.len().max(state.limits.max_inflight),
            state.limits.admission_wait,
        )
        .await
    } else if live_request {
        admit_live(&state)
    } else {
        admit_queued(
            &state.operations,
            state.limits.max_waiting,
            state.limits.admission_wait,
        )
        .await
    };
    let permit = match admitted {
        Ok(permit) => permit,
        Err(error) => {
            if path.starts_with("/work/") {
                crate::workspace_domain::report_unadmitted(path, &error);
            }
            return error.into_response();
        }
    };
    let mut cancellation = CancelOnDrop(Some(permit.clone()));
    let answer = dispatch_admitted(&state, request, permit.clone()).await;
    let response = match answer {
        Ok(response) => response,
        Err(error) => {
            permit.cancel();
            error.into_response()
        }
    };
    cancellation.0 = None;
    hold_response(response, permit, state.limits.response_bytes, live_request)
}
async fn dispatch_admitted(
    state: &Arc<WorkspaceState>,
    request: Request,
    permit: WorkspacePermit,
) -> Result<Response, WorkspaceError> {
    // A Workshop route row's root path (`root`, src/server/tool-routes.json) is that route under /work/api: it is moved
    // there before anything else, so it is admitted, signed in and answered exactly as the route itself.
    let request = match crate::workspace_domain::workshop_root_target(request.method(), request.uri())? {
        Some(uri) => {
            let (mut parts, body) = request.into_parts();
            parts.uri = uri;
            Request::from_parts(parts, body)
        }
        None => request,
    };
    let path = request.uri().path();
    // Existing handleScreenModule serves public, immutable PROGRAM bytes by
    // content identity (never account data). Preserve that narrow policy and
    // its CORS header; it does not admit a private page or operation.
    if path.starts_with("/workshop/modules/") {
        return static_response(
            state,
            request.method().clone(),
            path.to_owned(),
            permit,
            true,
        )
        .await;
    }
    // Original Worker semantics: pinned product JS/CSS/fonts/WASM are the same
    // public program for every page. They hold no account data. Keep their
    // exact-byte/path/method checks; no session or operation owner is consulted.
    if state.assets.public_program(path)? {
        return static_response(
            state,
            request.method().clone(),
            path.to_owned(),
            permit,
            false,
        )
        .await;
    }
    let sessions = state
        .supplies
        .sessions
        .as_ref()
        .ok_or(crate::cause!(WorkspaceError::Unavailable))?;
    let operations = state
        .supplies
        .operations
        .as_ref()
        .ok_or(crate::cause!(WorkspaceError::Unavailable))?;
    let head = WorkspaceRequestHead {
        method: request.method().clone(),
        uri: request.uri().clone(),
        headers: request.headers().clone(),
    };
    let session = match sessions.current(head.clone(), permit.clone()).await {
        Ok(session) => session,
        Err(error) => {
            if path.starts_with("/work/") {
                crate::workspace_domain::report_unadmitted(path, &error);
            }
            return Err(error);
        }
    };
    if session.account_id.is_empty() || session.session_id.is_empty() {
        return Err(crate::cause!(WorkspaceError::Unauthorized));
    }
    if is_live_path(path) {
        if *request.method() != Method::GET
            || request.headers().contains_key(header::TRANSFER_ENCODING)
            || request
                .headers()
                .get(header::CONTENT_LENGTH)
                .is_some_and(|v| v != "0")
        {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
        return state
            .supplies
            .live
            .as_ref()
            .ok_or(crate::cause!(WorkspaceError::Unavailable))?
            .subscribe(session, request, permit)
            .await;
    }
    if path.starts_with("/work/") {
        let body = to_bytes(request.into_body(), state.limits.request_bytes)
            .await
            .map_err(|error| crate::carry_cause!(WorkspaceError::TooLarge, error))?;
        let mut response = operations
            .invoke(session, WorkspaceRequest { head, body }, permit)
            .await?;
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return Ok(response);
    }
    if *request.method() != Method::GET {
        return Err(crate::cause!(WorkspaceError::NotFound));
    }
    // Every HTML page leaves here, and only here, so every one carries the policy with its own fresh nonce.
    let (nonce, policy) = state
        .page_policy
        .for_response(&head.headers, sessions.origin_of(&head).as_deref())?;
    let mut response = match operations
        .page_response(session, head, permit.clone())
        .await?
    {
        WorkspacePageResponse::Complete(page) => {
            let html = render_page(
                &state.assets,
                &state.supplies.dom,
                page,
                state.limits.document_bytes,
                &nonce,
            )?;
            (
                [
                    (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                    (header::CACHE_CONTROL, "no-store"),
                ],
                html,
            )
                .into_response()
        }
        WorkspacePageResponse::Stream(page) => {
            if !Arc::ptr_eq(&page.reads.permit.0, &permit.0) {
                return Err(crate::cause!(WorkspaceError::Invalid));
            }
            stream_page(
                &state.assets,
                &state.supplies.dom,
                page,
                state.limits.document_bytes,
                &nonce,
            )?
        }
    };
    response
        .headers_mut()
        .insert(state.page_policy.header.clone(), policy);
    Ok(response)
}

/// The workspace page's Content-Security-Policy is the account routes' setting (src/server/page-policy.json, compiled in);
/// this owner only spells it. A source is a CSP keyword, the response's own nonce
/// or the engine's own loopback address in a named scheme. The address is the request's Host, which the session owner
/// has already admitted as exactly this listener's authority (`CurrentSession::current`); it is parsed again here as a
/// loopback socket address so no other host can enter the header. Read and checked once, at route table construction.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PagePolicyData {
    #[serde(rename = "_what")]
    _what: String,
    header: String,
    nonce_bytes: usize,
    directives: Vec<PolicyDirective>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyDirective {
    directive: String,
    sources: Vec<PolicySource>,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum PolicySource {
    Keyword { keyword: String },
    ResponseNonce,
    EngineAddress { scheme: String },
}
const PAGE_POLICY: &[u8] = include_bytes!("server/page-policy.json");
struct PagePolicy {
    header: HeaderName,
    nonce_bytes: usize,
    directives: Vec<PolicyDirective>,
}
impl PagePolicy {
    fn shipped() -> Result<Self, WorkspaceError> {
        let data: PagePolicyData = serde_json::from_slice(PAGE_POLICY).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        let word = |v: &str, more: &[u8]| {
            !v.is_empty()
                && v.len() <= 64
                && v.bytes()
                    .all(|b| b.is_ascii_lowercase() || more.contains(&b))
        };
        let nonces = data
            .directives
            .iter()
            .flat_map(|d| &d.sources)
            .filter(|s| matches!(s, PolicySource::ResponseNonce))
            .count();
        if !(16..=64).contains(&data.nonce_bytes)
            || data.directives.is_empty()
            || nonces == 0
            || data.directives.iter().any(|d| {
                !word(&d.directive, b"-")
                    || d.sources.is_empty()
                    || d.sources.iter().any(|s| match s {
                        PolicySource::Keyword { keyword } => !word(keyword, b"-"),
                        PolicySource::ResponseNonce => false,
                        PolicySource::EngineAddress { scheme } => !word(scheme, b""),
                    })
            })
        {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        Ok(Self {
            header: HeaderName::from_bytes(data.header.as_bytes()).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?,
            nonce_bytes: data.nonce_bytes,
            directives: data.directives,
        })
    }
    /// A fresh nonce and the header value naming it, for one page response.
    fn for_response(
        &self,
        headers: &HeaderMap,
        origin: Option<&str>,
    ) -> Result<(String, HeaderValue), WorkspaceError> {
        let mut hosts = headers.get_all(header::HOST).iter();
        let host = hosts
            .next()
            .filter(|_| hosts.next().is_none())
            .and_then(|v| v.to_str().ok())
            .ok_or(crate::cause!(WorkspaceError::Invalid))?;
        // A page at the account's public origin (the session owner admitted it there) reaches its account routes over TLS: each
        // engine address takes the scheme's secure form. A page at the local listener keeps its loopback address.
        let secure = match origin {
            Some(origin) if origin == format!("https://{host}") => true,
            _ => {
                let address: std::net::SocketAddr =
                    host.parse().map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
                if !address.ip().is_loopback() || address.port() == 0 || address.to_string() != host
                {
                    return Err(crate::cause!(WorkspaceError::Invalid));
                }
                false
            }
        };
        let mut bytes = vec![0; self.nonce_bytes];
        ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes)
            .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
        let nonce =
            base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, &bytes);
        let value = self
            .directives
            .iter()
            .map(|d| {
                std::iter::once(d.directive.clone())
                    .chain(d.sources.iter().map(|s| match s {
                        PolicySource::Keyword { keyword } => format!("'{keyword}'"),
                        PolicySource::ResponseNonce => format!("'nonce-{nonce}'"),
                        PolicySource::EngineAddress { scheme } if secure => {
                            format!("{scheme}s://{host}")
                        }
                        PolicySource::EngineAddress { scheme } => format!("{scheme}://{host}"),
                    }))
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect::<Vec<_>>()
            .join("; ");
        Ok((nonce, HeaderValue::from_str(&value).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?))
    }
}
async fn static_response(
    state: &Arc<WorkspaceState>,
    method: Method,
    path: String,
    permit: WorkspacePermit,
    public_module: bool,
) -> Result<Response, WorkspaceError> {
    if !matches!(method, Method::GET | Method::HEAD) {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    let assets = Arc::clone(&state.assets);
    let worker = permit.clone();
    let asked = path.clone();
    let static_bytes = crate::storage::request_work::spawn_blocking(move || {
        if worker.cancelled() {
            return Err(crate::cause!(WorkspaceError::Unavailable));
        }
        assets.read(&asked)
    })
    .await
    .map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
    let bytes = match static_bytes {
        Err(WorkspaceError::NotFound(_)) if public_module && state.saved_modules.is_some() => {
            if permit.cancelled() {
                return Err(crate::cause!(WorkspaceError::Unavailable));
            }
            state
                .saved_modules
                .as_ref()
                .ok_or(crate::cause!(WorkspaceError::Unavailable))?
                .read(&path)
                .await?
        }
        answer => answer?,
    };
    if permit.cancelled() {
        return Err(crate::cause!(WorkspaceError::Unavailable));
    }
    if bytes.len() > state.limits.response_bytes {
        return Err(crate::cause!(WorkspaceError::TooLarge));
    }
    let length = bytes.len();
    let mut response = Response::new(if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(bytes)
    });
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(if public_module {
            "text/javascript; charset=utf-8"
        } else {
            mime(path_extension(state.assets.public_assets.get(&path).map_or(path.as_str(), String::as_str)))
        }),
    );
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&length.to_string()).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?,
    );
    let cache = if public_module || path.starts_with("/workspace/named/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    if public_module {
        let decoded = module_path(&path)?;
        let identity = decoded
            .strip_prefix("/workshop/modules/")
            .and_then(|v| v.split('/').next())
            .ok_or(crate::cause!(WorkspaceError::Invalid))?;
        response.headers_mut().insert(
            "x-content-identity",
            HeaderValue::from_str(identity).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?,
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        );
    }
    Ok(response)
}
fn path_extension(path: &str) -> &str {
    path.rsplit('.').next().unwrap_or("")
}
fn mime(extension: &str) -> &'static str {
    match extension {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "png" => "image/png",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    }
}

struct BoundedText {
    bytes: Vec<u8>,
    limit: usize,
    escape_script: bool,
}
impl Write for BoundedText {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let escaped = if self.escape_script {
            bytes.iter().filter(|b| **b == b'<').count().checked_mul(5)
        } else {
            Some(0)
        };
        let length = crate::io_operation!((escaped
            .and_then(|extra| bytes.len().checked_add(extra))
            .ok_or_else(|| io::Error::other("workspace output bound"))).map_err(std::io::Error::from))?;
        if length > self.limit.saturating_sub(self.bytes.len()) {
            return crate::io_operation!(Err(io::Error::other("workspace output bound")));
        }
        for byte in bytes {
            if self.escape_script && *byte == b'<' {
                self.bytes.extend_from_slice(b"\\u003c");
            } else {
                self.bytes.push(*byte);
            }
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn push(output: &mut BoundedText, value: &str) -> Result<(), WorkspaceError> {
    output
        .write_all(value.as_bytes())
        .map_err(|error| crate::carry_cause!(WorkspaceError::TooLarge, error))
}
fn script_text(output: &mut BoundedText, text: &str) -> Result<(), WorkspaceError> {
    for character in text.chars() {
        let escape = match character {
            '<' => Some("\\u003c"),
            '&' => Some("\\u0026"),
            '\u{2028}' => Some("\\u2028"),
            '\u{2029}' => Some("\\u2029"),
            _ => None,
        };
        if let Some(escape) = escape {
            push(output, escape)?;
        } else {
            let mut bytes = [0; 4];
            push(output, character.encode_utf8(&mut bytes))?;
        }
    }
    Ok(())
}
fn script_json(output: &mut BoundedText, value: impl Serialize) -> Result<(), WorkspaceError> {
    let mut encoded = BoundedText {
        bytes: Vec::new(),
        limit: output.limit.saturating_sub(output.bytes.len()),
        escape_script: false,
    };
    serde_json::to_writer(&mut encoded, &value).map_err(|error| crate::carry_cause!(WorkspaceError::TooLarge, error))?;
    script_text(
        output,
        std::str::from_utf8(&encoded.bytes).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?,
    )
}
fn script_envelope(
    output: &mut BoundedText,
    value: &WorkspaceAnswerEnvelope,
) -> Result<(), WorkspaceError> {
    let text = value.json_text(output.limit.saturating_sub(output.bytes.len()))?;
    script_text(output, &text)
}
fn attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
}
/// Writes the page document's own parts. A plain inline `<script>` the document carries (the captured shell's thread
/// cover, a v1 early socket) receives the response's nonce; any other script form gets none, so the policy refuses it.
fn push_document(output: &mut BoundedText, part: &str, nonce: &str) -> Result<(), WorkspaceError> {
    let mut pieces = part.split("<script>");
    push(output, pieces.next().unwrap_or(""))?;
    for piece in pieces {
        push(output, &format!("<script nonce=\"{nonce}\">"))?;
        push(output, piece)?;
    }
    Ok(())
}
/// `nonce` is the response's own policy nonce (`PagePolicy::for_response`): the import map and every plain inline
/// script of the document carry it. It must be base64url, as that owner makes it.
pub fn render_page(
    assets: &WorkspaceAssets,
    dom: &WorkspaceDom,
    page: WorkspacePage,
    limit: usize,
    nonce: &str,
) -> Result<String, WorkspaceError> {
    if !(16..=128).contains(&nonce.len())
        || !nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    if page.document.len() > limit
        || page.listed_reads.len() > 512
        || page.answers.len() > 1024
        || page.known.len() > 64
        || page.item_reads.len() > 512
    {
        return Err(crate::cause!(WorkspaceError::TooLarge));
    }
    let document = &page.document;
    if document.matches("</head>").count() != 1
        || document.matches("</body>").count() != 1
        || document.matches("<body").count() != 1
        || document.matches("id=\"root\"").count() + document.matches("id='root'").count() != 1
    {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    let script = assets.manifest["script"]
        .as_str()
        .ok_or(crate::cause!(WorkspaceError::Integrity))?;
    if document.contains(script)
        || document.contains("type=\"importmap\"")
        || document.contains("type='importmap'")
    {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    let mut ids = BTreeSet::from([dom.answers_id.as_str(), dom.item_reads_id.as_str()]);
    if dom.answers_id == dom.item_reads_id {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    for (id, _) in &page.known {
        if !html_id(id) || !ids.insert(id) {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
    }
    for id in ids {
        if document.contains(&format!("id=\"{id}\"")) || document.contains(&format!("id='{id}'")) {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
    }
    for reads in [&page.listed_reads, &page.item_reads] {
        for path in reads {
            if !path.starts_with("/work/api/")
                || path.len() > 8192
                || path.chars().any(char::is_control)
            {
                return Err(crate::cause!(WorkspaceError::Invalid));
            }
        }
    }
    let head_end = document.find("</head>").ok_or(crate::cause!(WorkspaceError::Invalid))?;
    let body_start = document
        .find("<body")
        .and_then(|at| document[at..].find('>').map(|n| at + n + 1))
        .ok_or(crate::cause!(WorkspaceError::Invalid))?;
    let body_end = document.find("</body>").ok_or(crate::cause!(WorkspaceError::Invalid))?;
    if head_end >= body_start || body_start > body_end {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    let mut output = BoundedText {
        bytes: Vec::new(),
        limit,
        escape_script: false,
    };
    push_document(&mut output, &document[..head_end], nonce)?;
    if let Some(map) = assets.manifest.get("import_map") {
        push(
            &mut output,
            &format!("<script type=\"importmap\" nonce=\"{nonce}\">"),
        )?;
        script_json(&mut output, map)?;
        push(&mut output, "</script>")?;
    }
    let mut preload = BTreeSet::new();
    for path in assets.manifest["preload"]
        .as_array()
        .ok_or(crate::cause!(WorkspaceError::Integrity))?
    {
        preload.insert(path.as_str().ok_or(crate::cause!(WorkspaceError::Integrity))?);
    }
    if let Some(entry) = &page.screen_entry {
        if let Some(paths) = assets.manifest["screens"]
            .get(entry)
            .and_then(Value::as_array)
        {
            for path in paths {
                preload.insert(path.as_str().ok_or(crate::cause!(WorkspaceError::Integrity))?);
            }
        }
    }
    for path in preload {
        push(
            &mut output,
            &format!("<link rel=\"modulepreload\" href=\"{}\">", attribute(path)),
        )?;
    }
    push(
        &mut output,
        &format!(
            "<link rel=\"stylesheet\" href=\"{}\">",
            attribute(
                assets.manifest["stylesheet"]
                    .as_str()
                    .ok_or(crate::cause!(WorkspaceError::Integrity))?
            )
        ),
    )?;
    push_document(&mut output, &document[head_end..body_start], nonce)?;
    for (id, value) in &page.known {
        push(
            &mut output,
            &format!("<script type=\"application/json\" id=\"{id}\">"),
        )?;
        script_json(&mut output, value)?;
        push(&mut output, "</script>")?;
    }
    for (id, reads) in [
        (&dom.answers_id, &page.listed_reads),
        (&dom.item_reads_id, &page.item_reads),
    ] {
        push(
            &mut output,
            &format!("<script type=\"application/json\" id=\"{id}\">"),
        )?;
        script_json(&mut output, reads)?;
        push(&mut output, "</script>")?;
    }
    push_document(&mut output, &document[body_start..body_end], nonce)?;
    // Preserve pageShellHtml's ordering: an async module may run immediately
    // from a warm cache, so its #root mount must already have been parsed.
    push(
        &mut output,
        &format!(
            "<script type=\"module\" async src=\"{}\"></script>",
            attribute(script)
        ),
    )?;
    let listed: BTreeSet<_> = page.listed_reads.iter().map(String::as_str).collect();
    let mut answered = BTreeSet::new();
    for answer in &page.answers {
        if !listed.contains(answer.path.as_str())
            || !answered.insert((&answer.path, answer.copy))
            || answer.envelope.status().is_none()
            || !answer.envelope.has_body()
        {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
        push(
            &mut output,
            &format!(
                "<script type=\"application/json\" data-page-answer=\"{}\"{}>",
                attribute(&answer.path),
                if answer.copy { " data-page-copy" } else { "" }
            ),
        )?;
        script_envelope(&mut output, &answer.envelope)?;
        push(&mut output, "</script>")?;
    }
    push_document(&mut output, &document[body_end..], nonce)?;
    String::from_utf8(output.bytes).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))
}

/// Private response metadata: callers cannot grant custody through an HTTP header.
/// Run all admission work before any final receipt reads, including for composed answers.
#[derive(Clone, Default)]
struct ResponseCustody {
    admissions: Vec<Arc<dyn Fn() -> bool + Send + Sync>>,
    receipts: Vec<Arc<dyn Fn() -> bool + Send + Sync>>,
}
pub(crate) fn retain_response_custody(
    response: &mut Response,
    admission: Arc<dyn Fn() -> bool + Send + Sync>,
    receipt: Arc<dyn Fn() -> bool + Send + Sync>,
) {
    let mut custody = response.extensions_mut().remove::<ResponseCustody>().unwrap_or_default();
    custody.admissions.push(admission);
    custody.receipts.push(receipt);
    response.extensions_mut().insert(custody);
}
struct CustodiedBytes {
    bytes: Bytes,
    _custody: ResponseCustody,
}
impl AsRef<[u8]> for CustodiedBytes {
    fn as_ref(&self) -> &[u8] { &self.bytes }
}
struct PermitBody {
    inner: Body,
    permit: WorkspacePermit,
    remaining: usize,
    failed: bool,
    cancel_on_drop: bool,
    custody: Option<ResponseCustody>,
}
impl Drop for PermitBody {
    fn drop(&mut self) {
        if self.cancel_on_drop {
            self.permit.cancel();
        }
    }
}
impl HttpBody for PermitBody {
    type Data = Bytes;
    type Error = io::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        if self.failed {
            return Poll::Ready(None);
        }
        match Pin::new(&mut self.inner).poll_frame(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                if let Some(data) = chunk.data_ref() {
                    if data.len() > self.remaining {
                        self.failed = true;
                        self.permit.cancel();
                        return Poll::Ready(Some(Err(io::Error::other(
                            "workspace response bound",
                        ))));
                    }
                    self.remaining -= data.len();
                }
                if let Some(custody) = &self.custody {
                    if !custody.admissions.iter().all(|current| current())
                        || !custody.receipts.iter().all(|current| current())
                        || self.permit.cancelled()
                    {
                        self.failed = true;
                        self.permit.cancel();
                        return Poll::Ready(Some(Err(io::Error::other("workspace response source changed"))));
                    }
                    // Keep the same source views alive for the transport's ownership of emitted bytes.
                    return Poll::Ready(Some(Ok(chunk.map_data(|bytes| Bytes::from_owner(CustodiedBytes {
                        bytes, _custody: custody.clone(),
                    })))));
                }
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(Some(Err(_))) => {
                self.failed = true;
                self.permit.cancel();
                Poll::Ready(Some(Err(io::Error::other(
                    "workspace response interrupted",
                ))))
            }
            other => other.map(|v| {
                v.map(|v| v.map_err(|_refusal_io_source| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&_refusal_io_source).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io(io::Error::other("workspace response interrupted"), _refusal_io_cause) }))
            }),
        }
    }
    fn is_end_stream(&self) -> bool {
        self.failed || self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}
fn hold_response(
    mut response: Response,
    permit: WorkspacePermit,
    limit: usize,
    live_request: bool,
) -> Response {
    if response
        .body()
        .size_hint()
        .upper()
        .is_some_and(|n| n > limit as u64)
    {
        permit.cancel();
        response = crate::cause!(WorkspaceError::TooLarge).into_response();
    }
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    // Only a successful live-route upgrade hands its lifetime to the live owner, which retains
    // the permit and observes upgrade failure/connection EOF. Dropping the empty
    // 101 HTTP body must not cancel an otherwise live upgraded connection.
    // An ordinary operation's status alone cannot transfer lifetime ownership.
    // Only the typed constructed stream owns its own disconnect/EOF policy.
    // A caller's arbitrary response cannot gain that policy through HTTP headers.
    let cancel_on_drop = !crate::workspace_stream::has_marker(&response)
        && (!live_request || response.status() != StatusCode::SWITCHING_PROTOCOLS);
    let custody = response.extensions_mut().remove::<ResponseCustody>();
    let (parts, body) = response.into_parts();
    Response::from_parts(
        parts,
        Body::new(PermitBody {
            inner: body,
            permit,
            remaining: limit,
            failed: false,
            cancel_on_drop,
            custody,
        }),
    )
}

#[cfg(test)]
mod response_custody_controls {
    use super::*;
    async fn permit() -> WorkspacePermit {
        admit_queued(&Slots::new(1), 1, std::time::Duration::from_secs(1)).await.unwrap()
    }
    #[tokio::test]
    async fn current_body_delivers_and_retains_source_until_bytes_drop() {
        let permit = permit().await;
        let kept = Arc::new(());
        let weak = Arc::downgrade(&kept);
        let mut response = Response::new(Body::from("original result"));
        retain_response_custody(&mut response, Arc::new(move || { let _ = &kept; true }), Arc::new(|| true));
        let response = hold_response(response, permit.clone(), 1024, false);
        let bytes = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(&bytes[..], b"original result");
        assert!(permit.cancelled());
        assert!(weak.upgrade().is_some());
        drop(bytes);
        assert!(weak.upgrade().is_none());
    }
    #[tokio::test]
    async fn revocation_after_dispatch_withholds_the_body_and_cancels() {
        let permit = permit().await;
        let live = Arc::new(AtomicBool::new(true));
        let source = live.clone();
        let mut response = Response::new(Body::from("private result"));
        retain_response_custody(&mut response, Arc::new(move || source.load(Ordering::Acquire)), Arc::new(|| true));
        let response = hold_response(response, permit.clone(), 1024, false);
        live.store(false, Ordering::Release);
        assert!(to_bytes(response.into_body(), 1024).await.is_err());
        assert!(permit.cancelled());
    }
    #[tokio::test]
    async fn all_admissions_precede_all_primary_checks_for_composed_results() {
        let permit = permit().await;
        let primary = Arc::new(AtomicBool::new(true));
        let receipt = primary.clone();
        let mut response = Response::new(Body::from("composed private result"));
        retain_response_custody(&mut response, Arc::new(|| true), Arc::new(move || receipt.load(Ordering::Acquire)));
        retain_response_custody(&mut response, Arc::new(move || { primary.store(false, Ordering::Release); true }), Arc::new(|| true));
        let response = hold_response(response, permit.clone(), 1024, false);
        assert!(to_bytes(response.into_body(), 1024).await.is_err());
        assert!(permit.cancelled());
    }
    #[tokio::test]
    async fn cancellation_during_last_primary_check_withholds_bytes() {
        let permit = permit().await;
        let cancelled = permit.clone();
        let mut response = Response::new(Body::from("private result"));
        retain_response_custody(&mut response, Arc::new(|| true), Arc::new(move || { cancelled.cancel(); true }));
        assert!(to_bytes(hold_response(response, permit.clone(), 1024, false).into_body(), 1024).await.is_err());
        assert!(permit.cancelled());
    }
}

fn stream_page(
    assets: &WorkspaceAssets,
    dom: &WorkspaceDom,
    mut streaming: WorkspaceStreamingPage,
    limit: usize,
    nonce: &str,
) -> Result<Response, WorkspaceError> {
    // Validate the exact declared path/copy pairs before any supplied read can
    // execute. The existing renderer remains the shell, asset and JSON owner.
    let listed: BTreeSet<_> = streaming.page.listed_reads.iter().cloned().collect();
    let mut seen: BTreeSet<(String, bool)> = streaming
        .page
        .answers
        .iter()
        .map(|a| (a.path.clone(), a.copy))
        .collect();
    for (path, copy) in std::iter::once((
        &streaming.reads.revision.path,
        streaming.reads.revision.copy,
    ))
    .chain(streaming.reads.current.iter().map(|r| (&r.path, r.copy)))
    .chain(streaming.reads.copies.iter().map(|r| (&r.path, r.copy)))
    {
        if !listed.contains(path) || !seen.insert((path.clone(), copy)) {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
    }
    let rendered = render_page(assets, dom, streaming.page, limit, nonce)?;
    let end = rendered.rfind("</body>").ok_or(crate::cause!(WorkspaceError::Invalid))?;
    let prefix = Bytes::copy_from_slice(&rendered.as_bytes()[..end]);
    let suffix = Bytes::copy_from_slice(&rendered.as_bytes()[end..]);
    streaming.limits.response_bytes = streaming.limits.response_bytes.min(limit);
    let max_chunk = streaming.limits.answer_chunk_bytes;
    let serialize: crate::workspace_stream::AnswerSerializer = Arc::new(move |answer| {
        if answer.envelope.status().is_none() || !answer.envelope.has_body() {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
        let mut out = BoundedText {
            bytes: Vec::new(),
            limit: max_chunk,
            escape_script: false,
        };
        push(
            &mut out,
            &format!(
                "<script type=\"application/json\" data-page-answer=\"{}\"{}>",
                attribute(&answer.path),
                if answer.copy { " data-page-copy" } else { "" }
            ),
        )?;
        script_envelope(&mut out, &answer.envelope)?;
        push(&mut out, "</script>")?;
        Ok(Bytes::from(out.bytes))
    });
    let body = crate::workspace_stream::WorkspaceStream::new(
        prefix,
        suffix,
        streaming.reads,
        serialize,
        streaming.limits,
    )?;
    let mut response = Response::new(Body::new(body));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    crate::workspace_stream::mark_response(&mut response);
    Ok(response)
}

