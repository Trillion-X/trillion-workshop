// src/workspace_modules.rs
//
// Purpose: Read public saved-screen program archives by their immutable BLAKE3 identity.
//
// Non-Negotiable Invariants: A digest is a content identity, never publication or account authority. The injected
// source admits only public screen archives; this reader never reaches arbitrary account files or a private store.
//
// Key Concepts: A saved screen is public JavaScript program text; each declared archive is independently addressed;
// static package screens and the person's saved screens share the same bounded archive parser.
//
// Security Considerations: Bound compressed bytes, expanded bytes, archive members, member sizes and cached text;
// reject path escape, links, duplicate names, invalid identities, corrupt/trailing gzip data and non-zero tar tail data.
// Cache successful immutable bytes only. Never cache an absence or source error, and never make a rights decision here.
//
// AI Assistant Directive:
// Keep this small source contract explicit. Do not add storage, account, network, Node or publication authority here.

use crate::workspace::{SupplyFuture, WorkspaceError};
use content_crypto::advanced::blake3;
use flate2::bufread::GzDecoder;
use std::{
    collections::{BTreeMap, VecDeque},
    io::{Cursor, Read},
    sync::{Arc, Mutex},
};
use tar::Archive;

const MAX_ARCHIVE_COMPRESSED_BYTES: usize = 16 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES: usize = 64 * 1024 * 1024;
const MAX_ARCHIVE_MEMBERS: usize = 256;
const MAX_MEMBER_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CACHE_ARCHIVES: usize = 16;
const MAX_CACHE_TEXT_BYTES: usize = 64 * 1024 * 1024;

/// A syntactically valid immutable archive identity. Constructing one proves only the shape of the identity; it
/// does not say that an archive is public or even exists.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ScreenBundleIdentity(String);

impl ScreenBundleIdentity {
    pub fn parse(value: &str) -> Result<Self, WorkspaceError> {
        let Some(hex) = value.strip_prefix("1f:") else {
            return Err(crate::cause!(WorkspaceError::Invalid));
        };
        if !digest(hex) {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The caller is the publication/content owner. It MUST return bytes only when this exact identity is an admitted
/// public screen archive. Implementations must not treat a matching BLAKE3 value, a private account file, or a
/// caller-provided file address as permission to disclose bytes. Return `None` for a current absence; do not
/// synthesize an archive. The reader preserves errors and does not cache `None` or failures.
pub trait PublicScreenArchiveSource: Send + Sync {
    fn read_admitted_public_screen_archive(
        &self,
        identity: ScreenBundleIdentity,
        max_compressed_bytes: usize,
    ) -> SupplyFuture<Option<Vec<u8>>>;
}

/// Parsed immutable program text from one validated public screen archive. This parser is also the intended shared
/// primitive for the deployment-pinned package-module reader; that reader can call `parse_screen_archive` and then
/// apply its manifest's expected file count and entry-file checks.
pub struct ScreenModuleBundle {
    identity: ScreenBundleIdentity,
    files: BTreeMap<String, Vec<u8>>,
    text_bytes: usize,
    expanded_bytes: usize,
    member_count: usize,
}

impl ScreenModuleBundle {
    pub fn identity(&self) -> &ScreenBundleIdentity {
        &self.identity
    }
    pub fn member_count(&self) -> usize {
        self.member_count
    }
    pub fn text_bytes(&self) -> usize {
        self.text_bytes
    }

    /// Complete decompressed tar bytes, including metadata and padding. The
    /// static package owner uses this to preserve its cross-archive budget.
    pub fn expanded_bytes(&self) -> usize {
        self.expanded_bytes
    }

    pub fn files(&self) -> impl Iterator<Item = (&str, &[u8])> {
        self.files
            .iter()
            .map(|(name, bytes)| (name.as_str(), bytes.as_slice()))
    }

    pub fn read(&self, file: &str) -> Result<Vec<u8>, WorkspaceError> {
        let name = safe_member(file)?;
        self.files
            .get(&name)
            .cloned()
            .ok_or(crate::cause!(WorkspaceError::NotFound))
    }
}

/// Parse exactly one gzip member containing a tar of regular files. The compressed bytes must hash to `identity`.
/// Valid UTF-8 members are retained; other regular members remain counted and bounded but are not servable, matching
/// the original public screen route's text-only behavior. No archive is extracted to disk or executed.
pub fn parse_screen_archive(
    identity: ScreenBundleIdentity,
    compressed: &[u8],
) -> Result<ScreenModuleBundle, WorkspaceError> {
    parse_screen_archive_with_budget(
        identity,
        compressed,
        MAX_ARCHIVE_EXPANDED_BYTES,
        MAX_ARCHIVE_MEMBERS,
    )
}

/// Preserve a caller's aggregate remainder before decompression begins. A caller
/// may tighten, but cannot enlarge, the per-archive limits.
pub fn parse_screen_archive_with_budget(
    identity: ScreenBundleIdentity,
    compressed: &[u8],
    remaining_expanded: usize,
    remaining_members: usize,
) -> Result<ScreenModuleBundle, WorkspaceError> {
    let max_expanded = remaining_expanded.min(MAX_ARCHIVE_EXPANDED_BYTES);
    let max_members = remaining_members.min(MAX_ARCHIVE_MEMBERS);
    if compressed.is_empty() {
        return Err(crate::cause!(WorkspaceError::Integrity));
    }
    if compressed.len() > MAX_ARCHIVE_COMPRESSED_BYTES {
        return Err(crate::cause!(WorkspaceError::TooLarge));
    }
    if format!("1f:{}", blake3::hash(compressed).to_hex()) != identity.as_str() {
        return Err(crate::cause!(WorkspaceError::Integrity));
    }

    // Bound actual decompression before tar parsing. Tar APIs can consume PAX/GNU extension members internally,
    // before yielding a normal member, so a counter over yielded entries alone is not a decompression bound.
    let compressed_cursor = Cursor::new(compressed);
    let mut decoder = GzDecoder::new(compressed_cursor);
    let mut expanded = Vec::new();
    decoder
        .by_ref()
        .take(max_expanded as u64 + 1)
        .read_to_end(&mut expanded)
        .map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
    if expanded.len() > max_expanded {
        return Err(crate::cause!(WorkspaceError::TooLarge));
    }
    let compressed_cursor = decoder.into_inner();
    if compressed_cursor.position() != compressed.len() as u64 {
        return Err(crate::cause!(WorkspaceError::Integrity));
    }

    let mut archive = Archive::new(Cursor::new(expanded.as_slice()));
    let mut files = BTreeMap::new();
    let mut text_bytes = 0usize;
    let mut member_count = 0usize;
    let mut seen = BTreeMap::<String, ()>::new();

    {
        let entries = archive.entries().map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        for item in entries {
            let mut entry = item.map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
            member_count = member_count
                .checked_add(1)
                .ok_or(crate::cause!(WorkspaceError::TooLarge))?;
            if member_count > max_members {
                return Err(crate::cause!(WorkspaceError::TooLarge));
            }
            if !entry.header().entry_type().is_file() {
                return Err(crate::cause!(WorkspaceError::Integrity));
            }

            // `path_bytes` preserves the archive's effective PAX/GNU path. Validate it before retaining or keying it.
            let path_bytes = entry.path_bytes();
            let raw_name = std::str::from_utf8(path_bytes.as_ref())
                .map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?
                .to_owned();
            let name = safe_member(&raw_name).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
            if seen.insert(name.clone(), ()).is_some() {
                return Err(crate::cause!(WorkspaceError::Integrity));
            }

            let length = entry.header().size().map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
            if length > MAX_MEMBER_BYTES {
                return Err(crate::cause!(WorkspaceError::TooLarge));
            }
            let length = usize::try_from(length).map_err(|error| crate::carry_cause!(WorkspaceError::TooLarge, error))?;
            let mut body = Vec::with_capacity(length.min(64 * 1024));
            (&mut entry)
                .take(length as u64 + 1)
                .read_to_end(&mut body)
                .map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
            if body.len() != length {
                return Err(crate::cause!(WorkspaceError::Integrity));
            }
            if std::str::from_utf8(&body).is_ok() {
                text_bytes = text_bytes
                    .checked_add(body.len())
                    .ok_or(crate::cause!(WorkspaceError::TooLarge))?;
                if text_bytes > MAX_ARCHIVE_EXPANDED_BYTES {
                    return Err(crate::cause!(WorkspaceError::TooLarge));
                }
                files.insert(name, body);
            }
        }
    }

    // Tar parsing stops at the end marker. Remaining decompressed bytes may only be zero tar padding.
    let tar_cursor = archive.into_inner();
    let tar_offset =
        usize::try_from(tar_cursor.position()).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
    let tar_tail = expanded
        .get(tar_offset..)
        .ok_or(crate::cause!(WorkspaceError::Integrity))?;
    if tar_tail.iter().any(|byte| *byte != 0) {
        return Err(crate::cause!(WorkspaceError::Integrity));
    }

    Ok(ScreenModuleBundle {
        identity,
        files,
        text_bytes,
        expanded_bytes: expanded.len(),
        member_count,
    })
}

struct CachedBundle {
    bundle: Arc<ScreenModuleBundle>,
    text_bytes: usize,
}
#[derive(Default)]
struct Cache {
    rows: VecDeque<(ScreenBundleIdentity, CachedBundle)>,
    text_bytes: usize,
}

/// Public saved-screen reader. It resolves each requested identity through the injected existing public
/// content owner. Successful immutable archives are kept in a bounded positive-only LRU; misses and source errors
/// are never remembered, so a later save can be loaded by the same reader without restarting the host.
pub struct SavedScreenModules {
    source: Arc<dyn PublicScreenArchiveSource>,
    cache: Mutex<Cache>,
    load_gate: tokio::sync::Mutex<()>,
}

impl SavedScreenModules {
    pub fn new(source: Arc<dyn PublicScreenArchiveSource>) -> Self {
        Self {
            source,
            cache: Mutex::new(Cache::default()),
            load_gate: tokio::sync::Mutex::new(()),
        }
    }

    pub async fn read(&self, path: &str) -> Result<Vec<u8>, WorkspaceError> {
        let (identity, file) = screen_module_path(path)?;
        if let Some(bundle) = self.cached(&identity)? {
            return bundle.read(&file);
        }

        // Admit source-buffer allocation and archive expansion together. A
        // second miss waits without retaining an archive buffer; cancellation
        // drops this guard. Recheck after admission to coalesce equal identities.
        let _load = self.load_gate.lock().await;
        if let Some(bundle) = self.cached(&identity)? {
            return bundle.read(&file);
        }

        let Some(compressed) = self
            .source
            .read_admitted_public_screen_archive(identity.clone(), MAX_ARCHIVE_COMPRESSED_BYTES)
            .await?
        else {
            return Err(crate::cause!(WorkspaceError::NotFound));
        };
        let bundle = Arc::new(parse_screen_archive(identity.clone(), &compressed)?);
        self.remember(identity, Arc::clone(&bundle))?;
        bundle.read(&file)
    }

    fn cached(
        &self,
        identity: &ScreenBundleIdentity,
    ) -> Result<Option<Arc<ScreenModuleBundle>>, WorkspaceError> {
        let mut cache = self.cache.lock().map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
        let Some(index) = cache.rows.iter().position(|(key, _)| key == identity) else {
            return Ok(None);
        };
        let row = cache
            .rows
            .remove(index)
            .ok_or(crate::cause!(WorkspaceError::Unavailable))?;
        let bundle = Arc::clone(&row.1.bundle);
        cache.rows.push_back(row);
        Ok(Some(bundle))
    }

    fn remember(
        &self,
        identity: ScreenBundleIdentity,
        bundle: Arc<ScreenModuleBundle>,
    ) -> Result<(), WorkspaceError> {
        if bundle.text_bytes > MAX_CACHE_TEXT_BYTES {
            return Ok(());
        }
        let mut cache = self.cache.lock().map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
        if let Some(index) = cache.rows.iter().position(|(key, _)| key == &identity) {
            let existing = cache
                .rows
                .remove(index)
                .ok_or(crate::cause!(WorkspaceError::Unavailable))?;
            cache.text_bytes = cache.text_bytes.saturating_sub(existing.1.text_bytes);
        }
        while cache.rows.len() >= MAX_CACHE_ARCHIVES
            || cache.text_bytes.saturating_add(bundle.text_bytes) > MAX_CACHE_TEXT_BYTES
        {
            let Some((_, removed)) = cache.rows.pop_front() else {
                break;
            };
            cache.text_bytes = cache.text_bytes.saturating_sub(removed.text_bytes);
        }
        cache.text_bytes = cache
            .text_bytes
            .checked_add(bundle.text_bytes)
            .ok_or(crate::cause!(WorkspaceError::TooLarge))?;
        cache.rows.push_back((
            identity,
            CachedBundle {
                text_bytes: bundle.text_bytes,
                bundle,
            },
        ));
        Ok(())
    }
}

fn screen_module_path(path: &str) -> Result<(ScreenBundleIdentity, String), WorkspaceError> {
    if path.len() > 4096 || path.contains(['?', '#']) || !path.starts_with("/workshop/modules/") {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    let suffix = &path["/workshop/modules/".len()..];
    let (raw_identity, raw_file) = suffix.split_once('/').ok_or(crate::cause!(WorkspaceError::Invalid))?;
    let identity = ScreenBundleIdentity::parse(&percent_decode_segment(raw_identity)?)?;
    let file = raw_file
        .split('/')
        .map(percent_decode_segment)
        .collect::<Result<Vec<_>, _>>()?
        .join("/");
    let file = safe_member(&file)?;
    Ok((identity, file))
}

fn percent_decode_segment(segment: &str) -> Result<String, WorkspaceError> {
    let bytes = segment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes
                .get(index + 1..index + 3)
                .ok_or(crate::cause!(WorkspaceError::Invalid))?;
            let text = std::str::from_utf8(hex).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
            decoded.push(u8::from_str_radix(text, 16).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    let decoded = String::from_utf8(decoded).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
    if decoded.contains(['/', '\\']) {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    Ok(decoded)
}

fn safe_member(path: &str) -> Result<String, WorkspaceError> {
    if path.is_empty()
        || path.len() > 4096
        || path.starts_with('/')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || path
            .chars()
            .any(|character| character.is_control() || matches!(character, '\\' | ':' | '?' | '#'))
    {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    Ok(path.to_owned())
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
