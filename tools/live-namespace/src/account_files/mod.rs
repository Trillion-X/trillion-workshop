// src/account_files/mod.rs
//
// Purpose: The person's files (every file they keep) served by trillion-local: the file list lives in record store
// records, the bytes live in S3-compatible object stores. This module answers the account files' existing tool contract
// (the Worker's `src/file-tools.mjs`: list_files, find_file, files_summary, show_file, read_file, write_file) with
// the same field names, so a client that spoke to the hosted Worker reads the same shapes here, and the generic name
// operations (`names.rs`: find_names, move_names, copy_names, set_aside, put_back, list_set_aside, forget_set_aside,
// retire_names), the byte release of files deleted for good (`release.rs`: queue_release, release_gone_bytes,
// list_released), the results kept about files (`results.rs`) and the WebDAV folder (`dav.rs` reads, `dav_write.rs` writes).
//
// Non-Negotiable Invariants:
// - Every read is bounded: a list page is one scope walk plus one batch get of the page's files (at most 1000
//   names); a lookup is at most three gets; a byte read asks the store for exactly the asked range (at most 256 KiB)
//   and never a whole object.
// - Every change is records: an upload keeps its bytes in a store first, then writes the file record, then the name
//   record. A crash between them leaves a stored, unnamed file (the contract already shows unnamed files), never a
//   name without bytes.
// - Nothing here deletes bytes in a store but the byte release (`release.rs`), and only an object nothing names.
// - New bytes land only in a store whose origin record takes new bytes (`Origin::takes_new_bytes`); a store being
//   emptied into another (`moves.rs`) answers reads of what it still holds and takes nothing new.
//
// Key Concepts (record layout; account = the person's account, resource = one scope per kind of fact):
// - `@namespace/names<folder>`: one record per name in that folder, id = the full name. A list page is one
//   `list_page` walk of the scope: the id order is the old `ORDER BY name` (both compare UTF-8 bytes).
// - `@namespace/folders<folder>`: one record per child folder, id = the child folder's full path.
// - `@namespace/set-aside/names<folder>` and `@namespace/set-aside/folders<folder>`: the same two trees for names set
//   aside (`Tree`): a name set aside keeps its record there, kind `namespace-set-aside`, and its file no longer lists
//   it; putting it back moves it home.
// - `@namespace/files`: one record per content identity (`1f:` + BLAKE3 hex): size, media type, store, key, span
//   count, aliases and names.
// - `@namespace/spans`: a chunked file's spans (offset, length, chunk), apart from the file so list pages stay small.
// - `@namespace/chunks`: one record per chunk: its store and key (the one record a chunk's location lives in).
// - `ALIASES`: alias identity (`12:`) -> file identity.
// - `@namespace/origins`: the account's stores (`objects::Origin`).
// - `@namespace/home`: the one record (`this`) holding the account files' own random binding, which a real store's origin
//   names (tied to the account) to take new bytes (`bind.rs`). Inside the account files, so a copy or restore keeps it.
// - `@namespace/shares`: one record per grant-bound share URL its delivery owner minted (`share_file`), id = the
//   BLAKE3 of the URL (hex): what was shared, when, until when and under which grant; never the URL.
// - `@namespace/uploads`: uploads that were in progress when the hosted Worker stopped.
// - `@namespace/usage`: the account's own usage counts, one row per UTC day (`usage.rs`): stored bytes (level and
//   written), source bytes read and tool work milliseconds, written off the request path. No price lives here.
// - `recent.rs` `RECENT_FILES` and `RECENT_ORDER`: the files the person used most recently, one row per file and one
//   newest-first order row. The facts kept about each file are its results of kind DATA `facts.kind` (`results.rs`).
// - Totals (`files_summary`) are record store declared totals (`settings.json` `totals`), kept in the same write as the record.
//
// Security Considerations:
// - Credentials never enter a record: an origin record names vault values; `objects.rs` signs through the vault.
// - Names and identities are bounded and NUL-free (record store validates every scope and id).
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

pub mod account_routes;
pub mod bind;
pub mod counters;
pub mod dav;
pub mod dav_write;
pub mod history_keeper;
pub mod identity;
pub mod migrate;
pub mod moves;
pub(crate) mod names;
pub mod objects;
pub mod page_paths;
mod paged_spans;
pub mod recent;
mod release;
mod results;
mod secrets;
pub mod settings;
pub mod share_delivery;
pub mod sign_up_hosting;
pub mod source_reads;
pub mod take;
pub mod usage;
mod write;

use self::objects::{MOST_SHARE_SECONDS, ObjectError, Objects, Origin, S3Objects, Secrets};
use crate::{
    records::{Error, MAX_PAGE_ITEMS, Mutation, Record, Records},
    storage::{Storage, record_store::RecordStore},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use content_crypto::advanced::blake3;
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    sync::Arc,
    time::{Duration, Instant},
};

/// Transient control for one account files call. It owns only the caller's live
/// checker and clock, never a credential or the capability whose life it
/// checks. Each record commit and byte-operation boundary checks it afresh.
/// It always carries exactly one byte check (`source_reads::Admission`):
/// every physical read and write goes through it, and a defaulted control's
/// `Admission::none()` refuses every physical read and write.
#[derive(Clone)]
pub struct CallControl {
    until: Option<Instant>,
    current: Arc<dyn Fn() -> bool + Send + Sync>,
    admission: source_reads::Admission,
    share_delivery: Option<Arc<dyn share_delivery::ShareDelivery>>,
    idle: Option<Duration>,
}
impl Default for CallControl {
    fn default() -> Self {
        Self {
            until: None,
            current: Arc::new(|| true),
            admission: source_reads::Admission::none(),
            share_delivery: None,
            idle: None,
        }
    }
}
impl CallControl {
    /// Control one call's byte requests directly through the same owner used by
    /// the account files routes. Cancellation can be composed into `current`; the
    /// caller's byte check meters every physical read and write.
    pub fn new(
        until: Instant,
        current: Arc<dyn Fn() -> bool + Send + Sync>,
        admission: source_reads::Admission,
    ) -> Self {
        Self {
            until: Some(until),
            current,
            admission,
            share_delivery: None,
            idle: None,
        }
    }

    /// The same control with `idle` as the longest one store socket read or write may wait for progress (DATA
    /// `transfer.idle_seconds` when none is given).
    pub fn with_idle(mut self, idle: Duration) -> Self {
        self.idle = Some(idle);
        self
    }

    /// The idle bound of this call's store requests.
    pub fn idle(&self) -> Duration {
        self.idle.unwrap_or_else(settings::idle)
    }

    /// The byte check every port asks before it sends a request.
    pub fn admission(&self) -> &source_reads::Admission {
        &self.admission
    }

    /// The same control, its byte check also counting every byte for the account `tally` belongs to (`usage.rs`).
    pub fn counting(mut self, tally: Arc<usage::Tally>) -> Self {
        self.admission = self.admission.counting(tally);
        self
    }

    /// The grant-aware delivery owner for share links. Without it a share is
    /// refused: no unobserved provider URL is ever minted.
    pub fn with_share_delivery(mut self, delivery: Arc<dyn share_delivery::ShareDelivery>) -> Self {
        self.share_delivery = Some(delivery);
        self
    }
    fn check(&self) -> Result<(), Error> {
        if self.until.is_some_and(|until| Instant::now() >= until)
            || !(self.current)()
            || self.until.is_some_and(|until| Instant::now() >= until)
        {
            return Err(crate::cause!(Error::Unavailable));
        }
        Ok(())
    }
    fn timeout(&self, maximum: Duration) -> Result<Duration, ObjectError> {
        self.check()
            .map_err(|error| ObjectError::Unavailable("account files call stopped".into(), error.cause()))?;
        let remaining = self.until.map_or(maximum, |until| {
            until.saturating_duration_since(Instant::now()).min(maximum)
        });
        if remaining.is_zero() {
            return Err(ObjectError::Unavailable(
                "account files call stopped".into(),
             crate::cause!()));
        }
        Ok(remaining)
    }
}

pub const FILES: &str = "@namespace/files";
pub const SPANS: &str = "@namespace/spans";
pub const CHUNKS: &str = "@namespace/chunks";
pub const ALIASES: &str = "@namespace/aliases";
pub const ORIGINS: &str = "@namespace/origins";
pub const SHARES: &str = "@namespace/shares";
pub const UPLOADS: &str = "@namespace/uploads";
pub const HOME: &str = "@namespace/home";
/// The account's own usage counts, one row per UTC day (`usage.rs`).
pub const USAGE: &str = "@namespace/usage";
/// Files deleted for good, noted for the byte release (`release.rs`): id = file identity.
pub const RELEASE_NOTED: &str = "@account-files/release/noted";
/// Stored objects waiting to be removed (`release.rs`): id = `release::row_id(origin, key)`.
pub const RELEASE_WAITING: &str = "@account-files/release/waiting";
/// Stored objects removed: the record of storage given back (`release.rs`), the same id.
pub const RELEASE_DONE: &str = "@account-files/release/done";
/// What was worked out about a file (`results.rs`): one scope per file identity, id = the result's kind.
pub const RESULTS: &str = "@account-files/results/";
/// The same results by kind (`results.rs`): one scope per kind, id = the file identity it is kept under.
pub const RESULTS_BY_KIND: &str = "@account-files/result-kinds/";
/// How many results of each kind are kept (`results.rs`): id = the kind.
pub const RESULT_COUNTS: &str = "@account-files/result-counts";

/// The `kind` of each record (record store's `kind_field`), which the declared totals group by.
pub const NAME_KIND: &str = "namespace-name";
pub const FOLDER_KIND: &str = "namespace-folder";
pub const FILE_KIND: &str = "namespace-file";
pub const SPANS_KIND: &str = "namespace-spans";
pub const CHUNK_KIND: &str = "namespace-chunk";
pub const ALIAS_KIND: &str = "namespace-alias";
pub const ORIGIN_KIND: &str = "namespace-origin";
pub const UPLOAD_KIND: &str = "namespace-upload";
pub const SHARE_KIND: &str = "namespace-share";
pub const SET_ASIDE_KIND: &str = "namespace-set-aside";
pub const HOME_KIND: &str = "namespace-home";
pub const USAGE_KIND: &str = "namespace-usage-day";
pub const RELEASE_NOTED_KIND: &str = "files-release-noted";
pub const RELEASE_KEY_KIND: &str = "files-release-key";
pub const RELEASED_KIND: &str = "files-released";
pub const RESULT_KIND: &str = "files-result";
pub const RESULT_INDEX_KIND: &str = "files-result-index";
pub const RESULT_COUNT_KIND: &str = "files-result-count";

/// One tree of names: the scope roots of its names and its child folders (one scope per folder, the folder's full
/// path appended), the kind its name records carry, and the field of a file record that lists its names there (what
/// keeps the file: `names` for the person's names, `set_aside` for names set aside, so the byte release (`release.rs`,
/// the old byte release's list of what keeps a file, ports/account-files-byte-release.json) reads them in its one
/// record).
pub struct Tree {
    names: &'static str,
    folders: &'static str,
    name_kind: &'static str,
    listed_in: &'static str,
}
impl Tree {
    /// The names scope of a folder.
    pub fn names(&self, folder: &str) -> String {
        format!("{}{folder}", self.names)
    }
    /// The child-folders scope of a folder.
    pub fn folders(&self, folder: &str) -> String {
        format!("{}{folder}", self.folders)
    }
}
/// The person's names.
pub const LIVE: Tree = Tree {
    names: "@namespace/names",
    folders: "@namespace/folders",
    name_kind: NAME_KIND,
    listed_in: "names",
};
/// The names set aside, each at the full name it had.
pub const SET_ASIDE: Tree = Tree {
    names: "@namespace/set-aside/names",
    folders: "@namespace/set-aside/folders",
    name_kind: SET_ASIDE_KIND,
    listed_in: "set_aside",
};

/// The contract's bounds (the Worker's `file-tools.mjs` and `account_files.mjs`).
pub const DEFAULT_LIST_LIMIT: usize = 200;
pub const READ_MAX_BYTES: u64 = 262_144;
pub const READ_DEFAULT_BYTES: u64 = 65_536;
pub const VIEW_TEXT_BYTES: u64 = 65_536;
pub const PICTURE_MAX_BYTES: u64 = 3 * 1024 * 1024;
pub const NAMES_SHOWN: usize = 20;
pub const WRITE_MAX_BYTES: usize = 16 * 1024 * 1024;
/// How many of its names a file record lists (`names`). The name records own every name; a file's list is the reverse
/// index `find_file` shows (at most `NAMES_SHOWN`) and a move keeps current. Without a bound a content many names share
/// (the empty file, a licence copied into every codebase) would rewrite an ever larger record for each new name. The
/// largest list the hosted Worker kept was 145 names.
pub const NAMES_LISTED: usize = 256;

/// The names scope of a folder.
pub fn names_scope(folder: &str) -> String {
    LIVE.names(folder)
}
/// The child-folders scope of a folder.
pub fn folders_scope(folder: &str) -> String {
    LIVE.folders(folder)
}
/// The folder a name or folder sits in (`/` for a top-level one).
pub fn parent(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) | None => "/",
        Some(at) => &path[..at],
    }
}
/// A folder as the contract names it: absolute, no trailing slash except the root.
pub fn folder_name(folder: &str) -> String {
    let trimmed = folder.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".into()
    } else if trimmed.starts_with('/') {
        trimmed.into()
    } else {
        format!("/{trimmed}")
    }
}

/// Why an account's files call did not answer.
#[derive(Debug)]
pub enum AccountFilesError {
    /// No file with that name or identity (the contract's 404).
    NotFound(crate::refusal_cause::Cause),
    /// The call's input is outside the contract (the contract's 400).
    Invalid(&'static str, crate::refusal_cause::Cause),
    /// A finish asked for an identity its bytes do not have, so nothing was kept (the contract's 409). Carries the identity
    /// and the byte length the bytes do have, which the refusal names to its caller (`detail`).
    IdentityMismatch(String, u64, crate::refusal_cause::Cause),
    Records(Error, crate::refusal_cause::Cause),
    Objects(ObjectError, crate::refusal_cause::Cause),
}
impl AccountFilesError {
    /// Wrapped failures retain their producer's identity through file routes.
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::NotFound(cause) | Self::Invalid(_, cause) | Self::IdentityMismatch(_, _, cause) => cause,
            Self::Records(error, _) => error.cause_ref(),
            Self::Objects(error, _) => error.cause_ref(),
        }
    }
}
crate::impl_caused!(AccountFilesError);

impl fmt::Display for AccountFilesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound(_) => f.write_str("No file with that name or identity is in your files."),
            Self::Invalid(why, _) => f.write_str(why),
            Self::IdentityMismatch(..) => f.write_str("The bytes are not the file you asked for, so nothing was kept."),
            Self::Records(error, _) => write!(f, "{error}"),
            Self::Objects(error, _) => write!(f, "{error}"),
        }
    }
}
impl std::error::Error for AccountFilesError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
impl From<Error> for AccountFilesError {
    fn from(error: Error) -> Self {
        { let cause = error.cause(); Self::Records(error, cause) }
    }
}
impl From<ObjectError> for AccountFilesError {
    fn from(error: ObjectError) -> Self {
        { let cause = error.cause(); Self::Objects(error, cause) }
    }
}
type Answer<T> = Result<T, AccountFilesError>;

/// A whole immutable file delivered through the account files' bounded byte reader. The caller owns the sink's
/// private placement and publication; an error never proves or publishes an earlier partial delivery.
#[derive(Debug, PartialEq, Eq)]
pub struct StreamedFile {
    pub byte_length: u64,
    pub identity: String,
}

/// The exact metadata and encoded content length of the base64 form of a bounded read. The read checks the actual
/// UTF-8 form after fetching and falls back to base64 when text escaping would exceed the same bound. Reserving the
/// recent-use word here keeps its later optional `recent_use_not_kept` field inside the transport bound too.
fn read_file_candidate(
    identity: &str,
    media_type: &str,
    size: u64,
    offset: u64,
    length: u64,
    reserve_warning: bool,
) -> Value {
    let encoded_length = usize::try_from(length).unwrap_or(0).div_ceil(3) * 4;
    let mut candidate = json!({
        "identity": identity,
        "media_type": media_type,
        "byte_length": size,
        "offset": offset,
        "bytes_returned": length,
        "encoding": "base64",
        "content": "A".repeat(encoded_length),
    });
    if reserve_warning {
        let reserve = settings::settings().read.response_metadata_reserve_bytes;
        candidate["recent_use_not_kept"] = json!("x".repeat(reserve));
    }
    candidate
}

/// One file, resolved from a name or an identity.
struct Found {
    /// The name asked for, when the call named one.
    name: Option<String>,
    file: Record,
}

/// The account files of one account.
pub struct AccountFiles<S: Storage + Send> {
    pub store: RecordStore<S>,
    account: String,
    objects: Box<dyn Objects>,
    /// When a paged call (a carry of names) stops taking steps and answers where to resume.
    until: Option<Instant>,
    control: CallControl,
    /// The account files' own binding tied to the account (`bind::tie` of `bind::binding_in`), when the account routes know it: new
    /// bytes then go only to a loopback store or to a store whose origin names exactly this binding. An account's files
    /// opened with no folder (an operator tool on a store file it was pointed at) is not held to it.
    home: Option<String>,
    /// The time in Unix milliseconds the byte release reads (`release.rs`): when a file was noted, a release row
    /// queued, claimed and released, and when a write began. The system clock unless a test sets one (`with_clock`).
    clock: Clock,
}

/// A clock in Unix milliseconds.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;
fn system_ms() -> Clock {
    Arc::new(|| u64::try_from(chrono::Utc::now().timestamp_millis()).unwrap_or(0))
}

impl<S: Storage + Send> AccountFiles<S> {
    /// Read time from `clock` (tests of the byte release's claim and write-race windows).
    pub fn with_clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }
    fn now_ms(&self) -> u64 {
        (self.clock)()
    }

    /// The account files of `account` in `store`, reaching its bytes through the account's own origin records, signed
    /// through the secrets `vault`.
    pub fn open(store: RecordStore<S>, account: &str, vault: Box<dyn Secrets>) -> Answer<Self> {
        let page = store.list_page(account, ORIGINS, "", MAX_PAGE_ITEMS)?;
        let origins = page
            .items
            .into_iter()
            .map(|record| {
                let origin: Origin = serde_json::from_value(record.value)
                    .map_err(|_| Error::Invalid("invalid origin record", crate::cause!()))?;
                Ok((record.id, origin))
            })
            .collect::<Result<Vec<_>, Error>>()?;
        let objects = S3Objects::new(origins, vault)?;
        Ok(Self {
            store,
            account: account.into(),
            objects: Box::new(objects),
            until: None,
            control: CallControl::default(),
            home: None,
            clock: system_ms(),
        })
    }

    /// The account files with a given byte port (tests and simulations).
    pub fn with_objects(store: RecordStore<S>, account: &str, objects: Box<dyn Objects>) -> Self {
        Self {
            store,
            account: account.into(),
            objects,
            until: None,
            control: CallControl::default(),
            home: None,
            clock: system_ms(),
        }
    }

    /// Apply one caller-owned control to all record and byte boundaries. The
    /// same control carries current rights, deadline, byte check and shares.
    pub fn with_control(mut self, control: CallControl) -> Self {
        self.until = control.until;
        self.control = control;
        self.objects.set_control(self.control.clone());
        self
    }

    /// Hold new bytes to the account files binding `identity` (`bind::tie`): a store that is not on this computer's
    /// loopback takes them only when its origin names exactly this binding.
    pub fn at_home(mut self, identity: String) -> Self {
        self.home = Some(identity);
        self
    }

    /// Paged calls stop taking steps at `until` and answer where to resume, so a call ends inside its caller's time.
    pub fn until(mut self, until: Instant) -> Self {
        self.until = Some(until);
        self.control.until = Some(until);
        self.objects.set_control(self.control.clone());
        self
    }

    /// Use the caller's current authorization/cancellation witness at each
    /// physical effect. Existing completed steps remain completed; an object
    /// PUT already accepted by its store cannot be undone by this checker.
    pub fn while_current(mut self, current: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        self.control.current = current;
        self.objects.set_control(self.control.clone());
        self
    }

    /// Reuse the caller's current grant-aware share delivery owner. Chunked
    /// files can use that owner because it reads through this account files.
    pub fn with_share_delivery(mut self, delivery: Arc<dyn share_delivery::ShareDelivery>) -> Self {
        self.control.share_delivery = Some(delivery);
        self.objects.set_control(self.control.clone());
        self
    }

    fn check_current(&self) -> Answer<()> {
        Ok(self.control.check()?)
    }

    /// Reuse record store's own atomic check, including before a recovered receipt is
    /// disclosed and immediately before commit. There is no second store or
    /// rollback claim for earlier independent account files steps.
    fn mutate(&mut self, resource: &str, input: Mutation) -> Answer<crate::records::Change> {
        let control = self.control.clone();
        Ok(self
            .store
            .mutate_local_with_check(&self.account, resource, input, || control.check())?)
    }

    fn get(&self, resource: &str, id: &str) -> Answer<Option<Record>> {
        Ok(self.store.get(&self.account, resource, id)?.record)
    }

    /// The record at `id` and the version a write there must name: a name or folder carried away leaves a tombstone,
    /// so writing the id again names the tombstone's version, not 0.
    fn held(&self, resource: &str, id: &str) -> Answer<(i64, Option<Record>)> {
        Ok(self
            .store
            .held_record_with_version(&self.account, resource, id)?)
    }

    /// The file a name or identity points at (an alias is followed once).
    fn resolve(&self, name_or_identity: &str) -> Answer<Found> {
        let (name, identity) = if name_or_identity.starts_with('/') {
            let named = self
                .get(&names_scope(parent(name_or_identity)), name_or_identity)?
                .ok_or(crate::cause!(AccountFilesError::NotFound))?;
            let file = text(&named.value, "file").ok_or(crate::cause!(AccountFilesError::NotFound))?;
            (Some(name_or_identity.to_owned()), file.to_owned())
        } else {
            (None, name_or_identity.to_owned())
        };
        if let Some(file) = self.get(FILES, &identity)? {
            return Ok(Found { name, file });
        }
        let alias = self
            .get(ALIASES, &identity)?
            .ok_or(crate::cause!(AccountFilesError::NotFound))?;
        let target = text(&alias.value, "identity").ok_or(crate::cause!(AccountFilesError::NotFound))?;
        let file = self
            .get(FILES, target)?
            .ok_or(crate::cause!(AccountFilesError::NotFound))?;
        Ok(Found { name, file })
    }

    /// `list_files`: one page of a folder's names, and on the first page its child folders.
    pub fn list_files(
        &self,
        folder: Option<&str>,
        after: Option<&str>,
        limit: Option<usize>,
    ) -> Answer<Value> {
        self.list_tree(&LIVE, folder, after, limit)
    }

    /// One page of a folder's names in `tree`, and on the first page its child folders.
    fn list_tree(
        &self,
        tree: &Tree,
        folder: Option<&str>,
        after: Option<&str>,
        limit: Option<usize>,
    ) -> Answer<Value> {
        let folder = folder_name(folder.unwrap_or("/"));
        let after = after.unwrap_or("");
        let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_PAGE_ITEMS);
        let page = self
            .store
            .list_page(&self.account, &tree.names(&folder), after, limit)?;
        let names = self.name_rows(&page.items)?;
        let (folders, revisions) = if after.is_empty() {
            self.child_folders(tree, &folder)?
        } else {
            (Vec::new(), Map::new())
        };
        Ok(json!({
            "collection": folder,
            "names": names,
            "next_after": page.next,
            "folders": folders,
            "folder_revisions": revisions,
        }))
    }

    /// The contract's rows of name records: each name's facts, its file's media type, and the file's other names.
    fn name_rows(&self, records: &[Record]) -> Answer<Vec<Value>> {
        // The page's files, read in one batch.
        let identities: Vec<&str> = records
            .iter()
            .filter_map(|record| text(&record.value, "file"))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let files = self.store.get_many(&self.account, FILES, &identities)?;
        let files: Vec<(&str, Record)> = identities
            .into_iter()
            .zip(files)
            .filter_map(|(id, file)| file.map(|file| (id, file)))
            .collect();
        Ok(records
            .iter()
            .map(|record| {
                let value = &record.value;
                let file = text(value, "file")
                    .and_then(|id| files.iter().find(|(file, _)| *file == id))
                    .map(|(_, file)| file);
                let mut row = Map::new();
                row.insert("name".into(), json!(record.id));
                for field in ["identity", "byte_length", "modified_at_ms", "named_at"] {
                    row.insert(
                        field.into(),
                        value.get(field).cloned().unwrap_or(Value::Null),
                    );
                }
                let stored = match (value.get("identity"), file) {
                    (Some(Value::Null) | None, _) => Value::Null,
                    (_, found) => json!(found.is_some()),
                };
                row.insert("stored".into(), stored);
                row.insert(
                    "media_type".into(),
                    file.and_then(|file| file.value.get("media_type").cloned())
                        .unwrap_or(Value::Null),
                );
                if let Some(others) = file
                    .and_then(|file| file.value.get("names"))
                    .and_then(Value::as_array)
                {
                    let also: Vec<&Value> = others
                        .iter()
                        .filter(|other| other.as_str() != Some(record.id.as_str()))
                        .collect();
                    if !also.is_empty() {
                        row.insert("also_named".into(), json!(also.len()));
                        row.insert(
                            "also_at".into(),
                            json!(also.iter().take(3).collect::<Vec<_>>()),
                        );
                    }
                }
                Value::Object(row)
            })
            .collect())
    }

    /// A folder's child folders in `tree` (at most one page of 1000), each with its revision: the newest change stamp
    /// of the names directly in it.
    fn child_folders(
        &self,
        tree: &Tree,
        folder: &str,
    ) -> Answer<(Vec<String>, Map<String, Value>)> {
        let (folders, _) =
            self.store
                .ids(&self.account, &tree.folders(folder), None, MAX_PAGE_ITEMS)?;
        let mut revisions = Map::new();
        for child in &folders {
            let stamp = self.store.stamp(&self.account, &tree.names(child))?;
            revisions.insert(child.clone(), json!(format!("folder:{stamp}")));
        }
        Ok((folders, revisions))
    }

    /// `find_file`: one file by its full name or its identity (or an alias identity).
    pub fn find_file(&self, name_or_identity: &str) -> Answer<Value> {
        if name_or_identity.is_empty() {
            return Err(AccountFilesError::Invalid("name_or_identity is required", crate::cause!()));
        }
        let found = self.resolve(name_or_identity)?;
        Ok(file_row(&found.file))
    }

    /// `search`: the files whose names hold every asked word, best first (old trillion src/search.mjs:1364
    /// `words-in-names`, its `file-names` lane, finished as src/search.mjs:1750 `finish` describes a found file).
    /// The record store word index proposes the files (every text of a file record, its `names` among them, indexed at write
    /// time); a file is kept when every asked word starts a word of the last part of one of its names, and that name
    /// is the one shown. Each result carries the read that opens it (`find_file` by that name). Dropped from the old
    /// lane: its in-memory name view and the table scan past it (the index replaces both), and `open_url` (these routes
    /// has no address of the page that would open it; the result's `address` is the call that does).
    pub fn search(&self, question: &str, limit: Option<u64>) -> Answer<Value> {
        let door = account_routes::AccountFilesDoor::shipped().ok_or(crate::cause!(Error::Unavailable))?;
        let asked = door.file_search();
        let limit = match limit {
            None => asked.limit,
            Some(limit) => usize::try_from(limit)
                .ok()
                .filter(|limit| (1..=asked.most).contains(limit))
                .ok_or(AccountFilesError::Invalid(
                    "limit is a whole number from 1 to the search's most",
                 crate::cause!()))?,
        };
        if question.trim().is_empty() {
            return Err(AccountFilesError::Invalid("question is required", crate::cause!()));
        }
        let (question, terms) = crate::record_value::search::terms(
            question,
            asked.question_chars,
            asked.min_word_length,
        );
        let mut held: BTreeMap<String, Record> = BTreeMap::new();
        let mut results = Vec::new();
        if !terms.is_empty() {
            let ids = crate::record_value::search::candidates(
                |word| {
                    let found = self.store.search(
                        &self.account,
                        FILES,
                        self.store.settings().search.every_text(),
                        word,
                        asked.word_hits,
                    )?;
                    Ok::<_, Error>(
                        found
                            .records
                            .into_iter()
                            .map(|record| {
                                let id = record.id.clone();
                                held.insert(id.clone(), record);
                                id
                            })
                            .collect(),
                    )
                },
                &terms,
                asked.word_hits,
            )?;
            for id in ids.unwrap_or_default() {
                if results.len() >= limit {
                    break;
                }
                let Some(file) = held.get(&id) else { continue };
                let names = file
                    .value
                    .get("names")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let Some(path) = names.iter().filter_map(Value::as_str).find(|name| {
                    crate::record_value::search::holds_every(
                        name.rsplit('/').next().unwrap_or_default(),
                        &terms,
                    )
                }) else {
                    continue;
                };
                let name = path.rsplit('/').next().unwrap_or(path);
                let rank = results.len() + 1;
                let score = asked.rank / (asked.k + rank as f64);
                results.push(json!({
                    "id": format!("{}{}", asked.key_prefix, file.id),
                    "source": asked.source,
                    "identity": file.id,
                    "name": name,
                    "path": path,
                    "title": name,
                    "media_type": file.value.get("media_type"),
                    "byte_length": file.value.get("byte_length"),
                    "found_in": [asked.place],
                    "places": [{"place": asked.place, "said": null}],
                    "said": null,
                    "address": {"resource": door.resource(), "operation": asked.open, "input": {"name_or_identity": path}},
                    "score": (score * 1e5).round() / 1e5,
                }));
            }
        }
        Ok(
            json!({"question": question, "terms": terms, "results": results, "unavailable": [], "pending": []}),
        )
    }

    /// `files_summary`: the account files' totals, one read of the account's declared totals.
    pub fn files_summary(&self) -> Answer<Value> {
        let totals = self.store.totals(&self.account)?;
        let mut by_origin = Map::new();
        let (mut files, mut bytes) = (0i64, 0i64);
        for row in totals.iter().filter(|row| row.total == "namespace-file/origin") {
            let origin = row.group.clone().unwrap_or_default();
            by_origin.insert(origin, json!({ "files": row.count, "bytes": row.sum }));
            files += row.count;
            bytes += row.sum;
        }
        let one = |total: &str| {
            totals
                .iter()
                .filter(|row| row.total == total)
                .fold((0i64, 0i64), |(count, sum), row| {
                    (count + row.count, sum + row.sum)
                })
        };
        let (names, _) = one("namespace-name/all");
        let (chunks, chunk_bytes) = one("namespace-chunk/all");
        let (uploads, upload_bytes) = one("namespace-upload/all");
        Ok(json!({
            "files": files,
            "bytes": bytes,
            "by_origin": by_origin,
            "names": names,
            "uploads_in_progress": uploads,
            "bytes_in_progress": upload_bytes,
            "chunks": chunks,
            "chunk_bytes": chunk_bytes,
        }))
    }

    /// `read_file`: up to 256 KiB of a file from `offset`, read as ranged GETs of the objects that hold those bytes.
    pub fn read_file(
        &self,
        name_or_identity: &str,
        offset: u64,
        length: Option<u64>,
    ) -> Answer<Value> {
        self.read_file_encoded(name_or_identity, offset, length, false)
    }

    fn read_provisional_file(
        &self,
        name: &str,
        upload_id: &str,
        offset: u64,
        requested: Option<u64>,
        base64: bool,
        fits: Option<&dyn Fn(&Value) -> bool>,
    ) -> Answer<Value> {
        write::validate_upload_id(upload_id)?;
        let upload = self
            .get(UPLOADS, upload_id)?
            .ok_or(crate::cause!(AccountFilesError::NotFound))?;
        if text(&upload.value, "name") != Some(name) {
            return Err(crate::cause!(AccountFilesError::NotFound));
        }
        match text(&upload.value, "status").unwrap_or("open") {
            "open" => {}
            "cancelled" => return Err(crate::cause!(AccountFilesError::NotFound)),
            "finished" => {
                let identity = text(&upload.value, "identity").ok_or(crate::cause!(Error::Unavailable))?;
                let found = self.resolve(name)?;
                if found.file.id != identity {
                    return Err(crate::cause!(AccountFilesError::NotFound));
                }
                return self.read_file_encoded_fitting(name, offset, requested, base64, fits);
            }
            _ => return Err(crate::cause!(AccountFilesError::NotFound)),
        }
        write::ensure_name_binding(&upload.value, name)?;
        self.ensure_name_version(&upload.value, name)?;
        let arrived = upload
            .value
            .get("next_offset")
            .and_then(Value::as_u64)
            .ok_or(crate::cause!(Error::Unavailable))?;
        let span_count = upload
            .value
            .get("span_count")
            .and_then(Value::as_u64)
            .ok_or(crate::cause!(Error::Unavailable))?;
        let media_type = text(&upload.value, "media_type").unwrap_or("application/octet-stream");
        let asked = requested.unwrap_or(READ_DEFAULT_BYTES).min(READ_MAX_BYTES);
        let available = arrived.saturating_sub(offset).min(asked);
        let mut length = available;
        if let Some(fits) = fits {
            let mut low = 0u64;
            let mut high = available;
            while low < high {
                let middle = low + (high - low).div_ceil(2);
                let candidate = json!({"upload_id":upload_id,"name":name,"state":"open","length_known":false,
                    "arrived_length":arrived,"total_length":null,"offset":offset,"bytes_returned":middle,
                    "encoding":"base64","content":"x".repeat(middle as usize * 4 / 3 + 8),"retry":offset.saturating_add(middle) < offset.saturating_add(asked)});
                if fits(&candidate) {
                    low = middle;
                } else {
                    high = middle - 1;
                }
            }
            if available > 0 && low == 0 {
                return Err(crate::cause!(Error::Unavailable).into());
            }
            length = low;
        }
        let bytes = if length == 0 {
            Vec::new()
        } else {
            let virtual_file = Record {
                id: upload_id.to_owned(),
                version: upload.version,
                value: json!({
                    "byte_length":arrived,"spans":span_count,"span_layout":paged_spans::APPEND_LAYOUT,"span_set":upload_id,
                    "media_type":media_type
                }),
            };
            self.read_range(&virtual_file, offset, length)?
        };
        self.ensure_name_version(&upload.value, name)?;
        let current = self.get(UPLOADS, upload_id)?.ok_or(crate::cause!(Error::Unavailable))?;
        if text(&current.value, "status") != Some("open")
            || text(&current.value, "name") != Some(name)
        {
            return Err(crate::cause!(Error::Unavailable).into());
        }
        let (encoding, content) = match std::str::from_utf8(&bytes) {
            Ok(text) if !base64 && !media_type.starts_with("image/") => ("utf-8", text.to_owned()),
            _ => ("base64", BASE64.encode(&bytes)),
        };
        let answer = json!({"upload_id":upload_id,"name":name,"state":"open","length_known":false,
            "arrived_length":arrived,"total_length":null,"offset":offset,"bytes_returned":bytes.len(),
            "encoding":encoding,"content":content,"retry":offset.saturating_add(bytes.len() as u64) < offset.saturating_add(asked)});
        if fits.is_some_and(|fits| !fits(&answer)) {
            return Err(crate::cause!(Error::Unavailable).into());
        }
        Ok(answer)
    }

    /// An explicit binary encoding keeps a bounded byte window inside its
    /// JSON copier bound even when valid UTF-8 control bytes need 6x escaping.
    fn read_file_encoded(
        &self,
        name_or_identity: &str,
        offset: u64,
        length: Option<u64>,
        base64: bool,
    ) -> Answer<Value> {
        self.read_file_encoded_fitting(name_or_identity, offset, length, base64, None)
    }

    /// A read whose answer must fit the actual transport envelope. It chooses the largest raw prefix whose base64 form
    /// (including the possible `recent_use_not_kept` word) fits, then makes exactly one byte read for that prefix. This
    /// keeps old trillion's `/namespace/contents/read` range contract (`src/file-tools.mjs:130` in the old owner)
    /// while returning fewer bytes when the transport cannot carry the requested window.
    fn read_file_encoded_fitting(
        &self,
        name_or_identity: &str,
        offset: u64,
        length: Option<u64>,
        base64: bool,
        fits: Option<&dyn Fn(&Value) -> bool>,
    ) -> Answer<Value> {
        let found = self.resolve(name_or_identity)?;
        let file = &found.file;
        let size = file
            .value
            .get("byte_length")
            .and_then(Value::as_u64)
            .ok_or(crate::cause!(Error::Unavailable))?;
        let media_type = text(&file.value, "media_type")
            .unwrap_or("application/octet-stream")
            .to_owned();
        let requested = length
            .unwrap_or(READ_DEFAULT_BYTES)
            .min(READ_MAX_BYTES)
            .min(size.saturating_sub(offset));
        let length = if let Some(fits) = fits {
            let reserve_warning = requested > 0 && offset == 0;
            let mut low = 0;
            let mut high = requested;
            while low < high {
                let middle = low + (high - low).div_ceil(2);
                let candidate = read_file_candidate(
                    &file.id,
                    &media_type,
                    size,
                    offset,
                    middle,
                    reserve_warning,
                );
                if fits(&candidate) {
                    low = middle;
                } else {
                    high = middle - 1;
                }
            }
            if requested > 0 && low == 0 {
                return Err(crate::cause!(Error::Unavailable).into());
            }
            low
        } else {
            requested
        };
        let bytes = if length == 0 {
            Vec::new()
        } else {
            self.read_range(file, offset, length)?
        };
        let (mut encoding, mut content) = match std::str::from_utf8(&bytes) {
            Ok(text) if !base64 && !media_type.starts_with("image/") => ("utf-8", text.to_owned()),
            _ => ("base64", BASE64.encode(&bytes)),
        };
        let mut answer = json!({
            "identity": file.id,
            "media_type": media_type,
            "byte_length": size,
            "offset": offset,
            "bytes_returned": bytes.len(),
            "encoding": encoding,
            "content": content,
        });
        if let Some(fits) = fits {
            let reserve_warning = requested > 0 && offset == 0;
            let mut fit_answer = answer.clone();
            if reserve_warning {
                let reserve = settings::settings().read.response_metadata_reserve_bytes;
                fit_answer["recent_use_not_kept"] = json!("x".repeat(reserve));
            }
            if !fits(&fit_answer) && encoding == "utf-8" {
                encoding = "base64";
                content = BASE64.encode(&bytes);
                answer["encoding"] = json!(encoding);
                answer["content"] = json!(content);
                fit_answer = answer.clone();
                if reserve_warning {
                    let reserve = settings::settings().read.response_metadata_reserve_bytes;
                    fit_answer["recent_use_not_kept"] = json!("x".repeat(reserve));
                }
            }
            if !fits(&fit_answer) {
                return Err(crate::cause!(Error::Unavailable).into());
            }
        }
        Ok(answer)
    }

    /// `read_file_span`: one span of a file's bytes in one answer, base64, for a transport that carries raw bytes and
    /// so has no door message to fit (the byte route, src/mcp/carried/bytes.rs). `read_file` answers at most what one
    /// door message holds, so a response of several MiB cost hundreds of calls and one connection to the store each;
    /// this makes the one byte read `read_range` makes, a ranged GET per stored object the span crosses. The span is
    /// inside the file (length >= 1) and at most one ranged read (`objects::MAX_RANGE_BYTES`).
    pub fn read_file_span(&self, name_or_identity: &str, offset: u64, length: u64) -> Answer<Value> {
        let found = self.resolve(name_or_identity)?;
        let file = &found.file;
        let size = file
            .value
            .get("byte_length")
            .and_then(Value::as_u64)
            .ok_or(crate::cause!(Error::Unavailable))?;
        if length == 0 || length > objects::MAX_RANGE_BYTES || offset.checked_add(length).is_none_or(|end| end > size) {
            return Err(AccountFilesError::Invalid("the span must be 1 byte up to one ranged read, inside the file", crate::cause!()));
        }
        let bytes = self.read_range(file, offset, length)?;
        Ok(json!({
            "identity": file.id,
            "media_type": text(&file.value, "media_type").unwrap_or("application/octet-stream"),
            "byte_length": size,
            "offset": offset,
            "bytes_returned": bytes.len(),
            "encoding": "base64",
            "content": BASE64.encode(&bytes),
        }))
    }

    /// `show_file`: a file's facts and, when the file is small enough, its first text or its picture.
    /// The store objects one file's bytes are kept in, counted by the byte release's own walk (`release.rs` `objects_of`,
    /// with nothing draining): each chunk of a chunked file is one object, a chunk several of its span records name is
    /// counted once, and a whole-file object is one object. `chunks-v1` files give a few large objects; `pages-32k-v1`
    /// files give one object per 32 KiB piece.
    pub fn file_objects(&self, name_or_identity: &str) -> Answer<Value> {
        let found = self.resolve(name_or_identity)?;
        let file = &found.file;
        let (gone, shared) = self.objects_of(file, &BTreeSet::new())?;
        Ok(json!({ "identity": file.id, "layout": text(&file.value, "span_layout"),
            "spans": file.value.get("spans").and_then(Value::as_u64).unwrap_or(0), "objects": gone.len() as u64 + shared }))
    }

    pub fn show_file(&self, name_or_identity: &str) -> Answer<Value> {
        let found = self.resolve(name_or_identity)?;
        let file = &found.file;
        let size = file
            .value
            .get("byte_length")
            .and_then(Value::as_u64)
            .ok_or(crate::cause!(Error::Unavailable))?;
        let media_type = text(&file.value, "media_type")
            .unwrap_or("application/octet-stream")
            .to_owned();
        let first_name = file
            .value
            .get("names")
            .and_then(Value::as_array)
            .and_then(|names| names.first())
            .and_then(Value::as_str);
        let name = found
            .name
            .clone()
            .or(first_name.map(str::to_owned))
            .unwrap_or_else(|| file.id.clone());
        let mut shown = json!({ "name": name, "identity": file.id, "media_type": media_type, "byte_length": size });
        if media_type.starts_with("image/") && size > 0 && size <= PICTURE_MAX_BYTES {
            shown["image"] = json!({ "media_type": media_type, "data": BASE64.encode(self.read_range(file, 0, size)?) });
        } else if is_text(&media_type) && size > 0 {
            let read = size.min(VIEW_TEXT_BYTES);
            let bytes = self.read_range(file, 0, read)?;
            shown["first_text"] = json!({ "text": String::from_utf8_lossy(&bytes), "shown_bytes": bytes.len(), "byte_length": size });
        }
        Ok(shown)
    }

    /// `share_file`: ask the supplied grant-aware delivery owner for a share of
    /// one immutable identity, including a chunked file. Without that owner the
    /// share is refused: this byte port never mints a provider URL, whose reads
    /// would bypass the byte check. The audit keeps identity, expiry and
    /// grant id, never the URL; its id is the URL's BLAKE3 digest.
    pub fn share_file(&mut self, name_or_identity: &str, seconds: u64) -> Answer<Value> {
        if !(1..=MOST_SHARE_SECONDS).contains(&seconds) {
            return Err(AccountFilesError::Invalid(
                "seconds must be 1 up to 604800 (seven days)",
             crate::cause!()));
        }
        let found = self.resolve(name_or_identity)?;
        let file = &found.file;
        let delivery = self.control.share_delivery.clone()
            .ok_or(AccountFilesError::Invalid("an account's files share needs its grant-aware delivery owner; a raw provider URL would bypass the byte admission", crate::cause!()))?;
        let size = file
            .value
            .get("byte_length")
            .and_then(Value::as_u64)
            .ok_or(crate::cause!(Error::Unavailable))?;
        let signed_at = chrono::Utc::now();
        self.check_current()?;
        let minted = delivery.mint(
            &share_delivery::ShareFile {
                identity: file.id.clone(),
                byte_length: size,
                media_type: text(&file.value, "media_type")
                    .unwrap_or("application/octet-stream")
                    .to_owned(),
            },
            seconds,
        )?;
        if minted.grant_id.is_empty()
            || minted.grant_id.len() > 1024
            || minted.grant_id.chars().any(char::is_control)
            || minted.url.len() > 16 * 1024
            || !url::Url::parse(&minted.url).is_ok_and(|url| {
                url.username().is_empty()
                    && url.password().is_none()
                    && (url.scheme() == "https"
                        || url.scheme() == "http"
                            && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
            })
        {
            return Err(AccountFilesError::Invalid(
                "the share delivery owner returned no valid grant-bound URL",
             crate::cause!()));
        }
        let (url, grant_id) = (minted.url, minted.grant_id);
        self.check_current()?;
        let expires_at = signed_at + chrono::Duration::seconds(seconds as i64);
        let at = |time: chrono::DateTime<chrono::Utc>| {
            time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        };
        let share = content_crypto::advanced::blake3::hash(url.as_bytes())
            .to_hex()
            .to_string();
        let value = json!({
            "kind": SHARE_KIND, "identity": file.id, "name": found.name, "byte_length": size, "seconds": seconds,
            "signed_at": at(signed_at), "expires_at": at(expires_at), "delivery": "grant-bound", "grant_id": grant_id,
        });
        self.mutate(
            SHARES,
            Mutation {
                id: share.clone(),
                expected_version: 0,
                request_key: share.clone(),
                deleted: false,
                value,
            },
        )?;
        Ok(json!({
            "url": url, "share": share, "identity": file.id, "name": found.name, "byte_length": size,
            "media_type": text(&file.value, "media_type").unwrap_or("application/octet-stream"), "expires_at": at(expires_at),
        }))
    }

    /// The bytes `offset..offset+length` of a file (length >= 1, within the file): one ranged GET of a whole-file
    /// object, or one ranged GET per chunk the range crosses (spans record + one batch get of those chunks first).
    pub fn read_range(&self, file: &Record, offset: u64, length: u64) -> Answer<Vec<u8>> {
        self.read_range_inner(file, offset, length, false)
    }

    /// The native verifier additionally requires the exact physical object length on each actual response. Keep
    /// span resolution in this one owner; ordinary ranged reads retain their existing contract and request count.
    fn read_range_verified(&self, file: &Record, offset: u64, length: u64) -> Answer<Vec<u8>> {
        self.read_range_inner(file, offset, length, true)
    }

    fn append_page(
        &self,
        set: &str,
        span_count: u64,
        total: u64,
        page: u64,
    ) -> Answer<(Record, Vec<paged_spans::Span>)> {
        let id = paged_spans::page_id(set, page);
        self.check_current()?;
        let record = self
            .get(SPANS, &id)?
            .filter(|record| record.id == id)
            .ok_or(crate::cause!(Error::Unavailable))?;
        self.check_current()?;
        let spans = paged_spans::parse_variable_page(&record.value, set, page)
            .map_err(|error| Error::Unavailable(error.cause()))?;
        let expected = (span_count - page * paged_spans::SPANS_PER_PAGE)
            .min(paged_spans::SPANS_PER_PAGE) as usize;
        if spans.len() != expected
            || (page == 0 && record.value.get("start_offset").and_then(Value::as_u64) != Some(0))
            || (page + 1 == span_count.div_ceil(paged_spans::SPANS_PER_PAGE)
                && record.value.get("end_offset").and_then(Value::as_u64) != Some(total))
        {
            return Err(crate::cause!(Error::Unavailable).into());
        }
        Ok((record, spans))
    }

    /// Locate every append span crossed by one read. Page byte ranges are
    /// binary-searched, then their seams and exact requested coverage are
    /// checked before the caller is allowed to fetch any chunk object.
    fn append_spans_for_range(
        &self,
        set: &str,
        span_count: u64,
        total: u64,
        offset: u64,
        end: u64,
    ) -> Answer<Vec<paged_spans::Span>> {
        if span_count == 0 || offset >= end || end > total {
            return Err(crate::cause!(Error::Unavailable).into());
        }
        let pages = span_count.div_ceil(paged_spans::SPANS_PER_PAGE);
        let locate = |target: u64| -> Answer<u64> {
            let mut low = 0u64;
            let mut high = pages;
            while low < high {
                let middle = low + (high - low) / 2;
                let (record, _) = self.append_page(set, span_count, total, middle)?;
                let page_end = record
                    .value
                    .get("end_offset")
                    .and_then(Value::as_u64)
                    .ok_or(crate::cause!(Error::Unavailable))?;
                if target < page_end {
                    high = middle;
                } else {
                    low = middle + 1;
                }
            }
            if low >= pages {
                return Err(crate::cause!(Error::Unavailable).into());
            }
            Ok(low)
        };
        let first = locate(offset)?;
        let last = locate(end - 1)?;
        let mut spans = Vec::new();
        let mut expected = 0u64;
        for page in first..=last {
            let (record, parsed) = self.append_page(set, span_count, total, page)?;
            let start = record
                .value
                .get("start_offset")
                .and_then(Value::as_u64)
                .ok_or(crate::cause!(Error::Unavailable))?;
            let page_end = record
                .value
                .get("end_offset")
                .and_then(Value::as_u64)
                .ok_or(crate::cause!(Error::Unavailable))?;
            if page == first {
                if page > 0 {
                    let (prior, _) = self.append_page(set, span_count, total, page - 1)?;
                    if prior.value.get("end_offset").and_then(Value::as_u64) != Some(start) {
                        return Err(crate::cause!(Error::Unavailable).into());
                    }
                } else if start != 0 {
                    return Err(crate::cause!(Error::Unavailable).into());
                }
            } else if start != expected {
                return Err(crate::cause!(Error::Unavailable).into());
            }
            if page == last && page + 1 < pages {
                let (next, _) = self.append_page(set, span_count, total, page + 1)?;
                if next.value.get("start_offset").and_then(Value::as_u64) != Some(page_end) {
                    return Err(crate::cause!(Error::Unavailable).into());
                }
            }
            expected = page_end;
            spans.extend(parsed.into_iter().filter(|span| {
                span.offset < end
                    && span
                        .offset
                        .checked_add(span.length)
                        .is_some_and(|span_end| span_end > offset)
            }));
        }
        let mut covered = offset;
        for span in &spans {
            let span_end = span
                .offset
                .checked_add(span.length)
                .filter(|span_end| *span_end <= total)
                .ok_or(crate::cause!(Error::Unavailable))?;
            let from = offset.max(span.offset);
            let to = end.min(span_end);
            if from != covered || to <= from {
                return Err(crate::cause!(Error::Unavailable).into());
            }
            covered = to;
        }
        if covered != end {
            return Err(crate::cause!(Error::Unavailable).into());
        }
        Ok(spans)
    }

    /// Deliver one canonical BLAKE3 file identity without a transport frame or a second byte store. The sink is
    /// borrowed and must remain private until this succeeds. Every logical range retains the existing bounded
    /// reader and byte admission; each sink write checks the caller's live control before and
    /// after delivery, including short writes and interrupted writes. The caller must bind that control to fresh
    /// authorization for this exact `read_file`, as well as cancellation and its deadline.
    pub(crate) fn stream_to(
        &self,
        identity: &str,
        max_bytes: u64,
        sink: &mut dyn std::io::Write,
    ) -> Answer<StreamedFile> {
        use content_crypto::Multihash;
        self.check_current()?;
        let hash = Multihash::from_code_hex(identity).map_err(|_| {
            AccountFilesError::Invalid("a canonical BLAKE3 file identity is required", crate::cause!())
        })?;
        if hash.code != Multihash::BLAKE3_CODE
            || hash.as_bytes().len() != blake3::OUT_LEN
            || hash.to_code_hex() != identity
        {
            return Err(AccountFilesError::Invalid(
                "a canonical BLAKE3 file identity is required",
             crate::cause!()));
        }
        let file = self
            .get(FILES, identity)?
            .ok_or(crate::cause!(AccountFilesError::NotFound))?;
        self.check_current()?;
        if file.id != identity || text(&file.value, "kind") != Some(FILE_KIND) {
            return Err(crate::cause!(Error::Unavailable).into());
        }
        let length = file
            .value
            .get("byte_length")
            .and_then(Value::as_u64)
            .ok_or(crate::cause!(Error::Unavailable))?;
        if length > max_bytes {
            return Err(AccountFilesError::Invalid(
                "the file exceeds the caller's byte bound",
             crate::cause!()));
        }
        // As read_file does, an empty logical file needs no physical request. Its canonical hash and the final
        // file row still have to agree. Raw object EOF is a separate storage audit, not input-read authority.
        let mut digest = blake3::Hasher::new();
        let mut offset = 0u64;
        while offset < length {
            let window = (length - offset).min(READ_MAX_BYTES);
            let next = offset
                .checked_add(window)
                .filter(|next| *next <= max_bytes)
                .ok_or(crate::cause!(Error::Unavailable))?;
            let bytes = self.read_range(&file, offset, window)?;
            self.check_current()?;
            if bytes.len() as u64 != window {
                return Err(crate::cause!(Error::Unavailable).into());
            }
            digest.update(&bytes);
            let mut remaining = bytes.as_slice();
            while !remaining.is_empty() {
                self.check_current()?;
                let written = crate::io_operation!(sink.write(remaining));
                self.check_current()?;
                match written {
                    Ok(written) if written > 0 && written <= remaining.len() => {
                        remaining = &remaining[written..]
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(Error::Unavailable(crate::refusal_cause::Caused::cause(&error)).into()),
                    _ => return Err(crate::cause!(Error::Unavailable).into()),
                }
            }
            offset = next;
        }
        if digest.finalize().as_bytes().as_slice() != hash.as_bytes() {
            return Err(crate::cause!(Error::Unavailable).into());
        }
        self.check_current()?;
        let current = self.get(FILES, identity)?.ok_or(crate::cause!(Error::Unavailable))?;
        self.check_current()?;
        if current.id != file.id || current.version != file.version || current.value != file.value {
            return Err(crate::cause!(Error::Unavailable).into());
        }
        Ok(StreamedFile {
            byte_length: offset,
            identity: file.id,
        })
    }

    fn read_range_inner(
        &self,
        file: &Record,
        offset: u64,
        length: u64,
        verified: bool,
    ) -> Answer<Vec<u8>> {
        let spans = file.value.get("spans").and_then(Value::as_u64).unwrap_or(0);
        let byte_length = file
            .value
            .get("byte_length")
            .and_then(Value::as_u64)
            .ok_or(crate::cause!(Error::Unavailable))?;
        let end = offset
            .checked_add(length)
            .filter(|end| length > 0 && *end <= byte_length)
            .ok_or(crate::cause!(Error::Unavailable))?;
        let capacity = usize::try_from(length).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let layout = file.value.get("span_layout");
        let span_set = file.value.get("span_set");
        let mut pieces: Vec<(u64, u64, String)> = Vec::new();
        if layout.is_some() || span_set.is_some() {
            let set = span_set.and_then(Value::as_str).ok_or(crate::cause!(Error::Unavailable))?;
            match layout.and_then(Value::as_str) {
                Some(layout) if paged_spans::is_variable(layout) => {
                    if spans == 0 {
                        return Err(crate::cause!(Error::Unavailable).into());
                    }
                    for span in self.append_spans_for_range(set, spans, byte_length, offset, end)? {
                        pieces.push((span.offset, span.length, span.chunk));
                    }
                }
                Some(paged_spans::LAYOUT) => {
                    if spans == 0
                        || spans
                            != byte_length.div_ceil(content_crypto::subtree::SUBTREE_BYTES as u64)
                    {
                        return Err(crate::cause!(Error::Unavailable).into());
                    }
                    let ordinals = paged_spans::crossed(offset, length, byte_length)
                        .map_err(|error| Error::Unavailable(error.cause()))?;
                    let page_numbers: BTreeSet<u64> = ordinals
                        .iter()
                        .map(|ordinal| paged_spans::page_number(*ordinal))
                        .collect();
                    let page_ids: Vec<String> = page_numbers
                        .iter()
                        .map(|page| paged_spans::page_id(set, *page))
                        .collect();
                    let page_id_refs: Vec<&str> = page_ids.iter().map(String::as_str).collect();
                    self.check_current()?;
                    let page_records = self.store.get_many(&self.account, SPANS, &page_id_refs)?;
                    self.check_current()?;
                    let mut parsed_pages = Vec::with_capacity(page_numbers.len());
                    for ((page, page_id), record) in
                        page_numbers.iter().zip(page_ids.iter()).zip(page_records)
                    {
                        let record = record
                            .filter(|record| record.id == *page_id)
                            .ok_or(crate::cause!(Error::Unavailable))?;
                        let parsed = paged_spans::parse_page(&record.value, set, *page)
                            .map_err(|error| Error::Unavailable(error.cause()))?;
                        parsed_pages.push((*page, parsed));
                    }
                    for ordinal in ordinals {
                        let page = paged_spans::page_number(ordinal);
                        let spans = parsed_pages
                            .iter()
                            .find(|(held, _)| *held == page)
                            .map(|(_, spans)| spans)
                            .ok_or(crate::cause!(Error::Unavailable))?;
                        let span = spans
                            .get((ordinal % paged_spans::SPANS_PER_PAGE) as usize)
                            .ok_or(crate::cause!(Error::Unavailable))?;
                        pieces.push((span.offset, span.length, span.chunk.clone()));
                    }
                }
                _ => return Err(crate::cause!(Error::Unavailable).into()),
            }
        } else if spans > 0 {
            // Migrated files keep their original single-array span record.
            let held = self.get(SPANS, &file.id)?.ok_or(crate::cause!(Error::Unavailable))?;
            let list = held
                .value
                .get("spans")
                .and_then(Value::as_array)
                .ok_or(crate::cause!(Error::Unavailable))?;
            for span in list {
                let (Some(start), Some(size), Some(chunk)) = (
                    span.get("offset").and_then(Value::as_u64),
                    span.get("length").and_then(Value::as_u64),
                    span.get("chunk").and_then(Value::as_str),
                ) else {
                    return Err(crate::cause!(Error::Unavailable).into());
                };
                let span_end = start
                    .checked_add(size)
                    .filter(|span_end| size > 0 && *span_end <= byte_length)
                    .ok_or(crate::cause!(Error::Unavailable))?;
                if start < end && span_end > offset {
                    pieces.push((start, size, chunk.to_owned()));
                }
            }
        }
        if spans == 0 {
            let origin = text(&file.value, "origin").ok_or(crate::cause!(Error::Unavailable))?;
            let key = text(&file.value, "key").ok_or(crate::cause!(Error::Unavailable))?;
            self.check_current()?;
            let bytes = if verified {
                self.objects
                    .read_verified(origin, key, offset, length, byte_length)?
            } else {
                self.objects.read(origin, key, offset, length)?
            };
            self.check_current()?;
            return Ok(bytes);
        }
        // Prove the selected pieces partition this exact window before a physical read. Corrupt overlapping,
        // repeated, gapped or unordered spans must not turn one bounded read into many reads whose bytes are only
        // rejected after collection. Both legacy and paged layouts pass through this one coverage check.
        let mut covered = offset;
        for (start, size, _) in &pieces {
            let span_end = start
                .checked_add(*size)
                .filter(|span_end| *size > 0 && *span_end <= byte_length)
                .ok_or(crate::cause!(Error::Unavailable))?;
            let from = offset.max(*start);
            let to = end.min(span_end);
            if from != covered || to <= from {
                return Err(crate::cause!(Error::Unavailable).into());
            }
            covered = to;
        }
        if covered != end {
            return Err(crate::cause!(Error::Unavailable).into());
        }
        let chunk_ids: Vec<&str> = pieces.iter().map(|(_, _, chunk)| chunk.as_str()).collect();
        self.check_current()?;
        let chunks = self.store.get_many(&self.account, CHUNKS, &chunk_ids)?;
        self.check_current()?;
        let mut bytes = Vec::with_capacity(capacity);
        for ((start, size, _), chunk) in pieces.iter().zip(chunks) {
            let chunk = chunk.ok_or(crate::cause!(Error::Unavailable))?;
            let from = offset.max(*start);
            let to = end.min(start + size);
            let origin = text(&chunk.value, "origin").ok_or(crate::cause!(Error::Unavailable))?;
            let key = text(&chunk.value, "key").ok_or(crate::cause!(Error::Unavailable))?;
            self.check_current()?;
            let part = if verified {
                let total = chunk
                    .value
                    .get("byte_length")
                    .and_then(Value::as_u64)
                    .ok_or(crate::cause!(Error::Unavailable))?;
                if total != *size {
                    return Err(crate::cause!(Error::Unavailable).into());
                }
                self.objects
                    .read_verified(origin, key, from - start, to - from, total)?
            } else {
                self.objects.read(origin, key, from - start, to - from)?
            };
            self.check_current()?;
            if part.len() as u64 != to - from {
                return Err(crate::cause!(Error::Unavailable).into());
            }
            bytes.extend(part);
        }
        if bytes.len() as u64 != length {
            return Err(crate::cause!(Error::Unavailable).into());
        }
        Ok(bytes)
    }

    /// `write_file`: keep `bytes` under `name`. The bytes go to the first store (by rank, among the stores that take
    /// new bytes) that accepts them, then the file record, then the name record (and any missing folder records).
    /// Content already kept is not sent again.
    pub fn write_file(
        &mut self,
        name: &str,
        bytes: &[u8],
        media_type: &str,
        origins: &[(String, Origin)],
    ) -> Answer<Value> {
        self.check_current()?;
        if !name.starts_with('/') || name.ends_with('/') || name.contains('\0') {
            return Err(AccountFilesError::Invalid(
                "name must be an absolute file path",
             crate::cause!()));
        }
        if bytes.len() > WRITE_MAX_BYTES {
            return Err(AccountFilesError::Invalid(
                "a written file is at most 16 MiB; larger files upload in pieces",
             crate::cause!()));
        }
        let identity = format!("1f:{}", blake3::hash(bytes).to_hex());
        let now = now_iso();
        let held = self.get(FILES, &identity)?;
        let already_kept = held.is_some();
        let request = |what: &str| format!("namespace-write:{}", blake3::hash(format!("{what}\0{name}\0{identity}\0{now}").as_bytes()).to_hex());
        match held {
            Some(file) => {
                let mut value = file.value.clone();
                if lists_name(&mut value, name)? {
                    self.mutate(
                        FILES,
                        Mutation {
                            id: identity.clone(),
                            expected_version: file.version,
                            request_key: request("file"),
                            deleted: false,
                            value,
                        },
                    )?;
                }
            }
            None => {
                let mut ranked: Vec<&(String, Origin)> = origins
                    .iter()
                    .filter(|(_, origin)| origin.takes_new_bytes)
                    .collect();
                ranked.sort_by_key(|(_, origin)| origin.rank);
                let mut kept = None;
                let mut refused = None;
                for (id, origin) in ranked {
                    // A copy of a person's state folder must never write into the person's real store: a store off
                    // this computer's loopback takes new bytes from the one folder it was bound to, and from no other.
                    if let Some(home) = &self.home {
                        if !origin.is_loopback()
                            && origin.bound_to.as_deref() != Some(home.as_str())
                        {
                            refused = Some(ObjectError::NotBound(id.clone(), crate::cause!()));
                            continue;
                        }
                    }
                    let key = format!("{}{identity}", origin.file_key_prefix);
                    self.check_current()?;
                    let started = self.now_ms();
                    match self.objects.write(id, &key, bytes, media_type) {
                        Ok(()) => {
                            // Bytes that raced a release of the same object are sent again (release.rs `may_record`).
                            self.record_or_again(id, &key, started)?;
                            kept = Some((id.clone(), key));
                            break;
                        }
                        Err(error) => refused = Some(error),
                    }
                    self.check_current()?;
                }
                let (origin, key) = kept.ok_or_else(|| {
                    refused.map_or(
                        AccountFilesError::Invalid("the account has no store", crate::cause!()),
                        |value| AccountFilesError::Objects(value, crate::cause!()),
                    )
                })?;
                let value = json!({
                    "kind": FILE_KIND, "byte_length": bytes.len(), "media_type": media_type, "origin": origin, "key": key,
                    "stored_at": now, "checked_at": now, "spans": 0, "aliases": [], "names": [name],
                });
                // A file whose bytes were given back left a tombstone (`release.rs`): kept again, it names that version.
                let (version, _) = self.held(FILES, &identity)?;
                self.mutate(
                    FILES,
                    Mutation {
                        id: identity.clone(),
                        expected_version: version,
                        request_key: request("file"),
                        deleted: false,
                        value,
                    },
                )?;
            }
        }
        self.place_name(
            name,
            &identity,
            bytes.len() as u64,
            None,
            &now,
            &request("name"),
        )?;
        Ok(
            json!({ "identity": identity, "name": name, "byte_length": bytes.len(), "media_type": media_type, "already_kept": already_kept }),
        )
    }

    /// Point `name` at `identity`: one name record, the previous file's names when the name moved, and folder records
    /// for folders that do not exist yet (walked up until one exists). `modified_at_ms` is when the bytes were last
    /// changed where they came from (a file taken from a computer folder keeps its own time), else null.
    fn place_name(
        &mut self,
        name: &str,
        identity: &str,
        byte_length: u64,
        modified_at_ms: Option<i64>,
        now: &str,
        request_key: &str,
    ) -> Answer<()> {
        let scope = names_scope(parent(name));
        let (expected_version, held) = self.held(&scope, name)?;
        let previous = held
            .as_ref()
            .and_then(|record| text(&record.value, "file"))
            .filter(|file| *file != identity)
            .map(str::to_owned);
        let value = json!({
            "kind": NAME_KIND, "name": name, "identity": identity, "file": identity, "byte_length": byte_length,
            "modified_at_ms": modified_at_ms, "named_at": now,
        });
        if held.as_ref().is_some_and(|record| record.value == value) {
            return Ok(());
        }
        self.mutate(
            &scope,
            Mutation {
                id: name.into(),
                expected_version,
                request_key: request_key.into(),
                deleted: false,
                value,
            },
        )?;
        if let Some(previous) = previous {
            if let Some(file) = self.get(FILES, &previous)? {
                let mut value = file.value.clone();
                if let Some(names) = value["names"].as_array_mut() {
                    names.retain(|held| held.as_str() != Some(name));
                    self.mutate(
                        FILES,
                        Mutation {
                            id: previous,
                            expected_version: file.version,
                            request_key: format!("{request_key}:left"),
                            deleted: false,
                            value,
                        },
                    )?;
                }
            }
        }
        self.ensure_folders(&LIVE, parent(name), request_key)
    }

    /// Folder records in `tree` for `folder` and each ancestor that has none yet (walked up until one exists).
    fn ensure_folders(&mut self, tree: &Tree, folder: &str, request_key: &str) -> Answer<()> {
        let mut folder = folder.to_owned();
        while folder != "/" {
            let scope = tree.folders(parent(&folder));
            let (expected_version, held) = self.held(&scope, &folder)?;
            if held.is_some() {
                break;
            }
            let value = json!({ "kind": FOLDER_KIND, "folder": folder });
            self.mutate(
                &scope,
                Mutation {
                    id: folder.clone(),
                    expected_version,
                    request_key: format!("{request_key}:folder"),
                    deleted: false,
                    value,
                },
            )?;
            folder = parent(&folder).to_owned();
        }
        Ok(())
    }

    /// One tool call of the contract, by the Worker's tool name and input fields (`src/file-tools.mjs`). None when
    /// the name is not an account's files tool, so a caller can continue to its next tool owner. An operation that
    /// keeps a use of the file it names (DATA `recent.uses`) keeps it when it answered (`recent.rs`).
    pub fn call(&mut self, tool: &str, input: &Value) -> Option<Answer<Value>> {
        let skip_recent_use = self.skip_recent_use(tool, input);
        let answer = self.call_one(tool, input, None)?;
        Some(answer.map(|answer| {
            if skip_recent_use {
                answer
            } else {
                self.keep_use(tool, input, answer)
            }
        }))
    }

    /// One tool call whose read answer is selected to fit its caller's complete response envelope.
    pub fn call_fitting(
        &mut self,
        tool: &str,
        input: &Value,
        fits: &dyn Fn(&Value) -> bool,
    ) -> Option<Answer<Value>> {
        let skip_recent_use = self.skip_recent_use(tool, input);
        let answer = self.call_one(tool, input, Some(fits))?;
        Some(answer.and_then(|answer| {
            let answer = if skip_recent_use {
                answer
            } else {
                self.keep_use(tool, input, answer)
            };
            if tool != "read_file" || fits(&answer) {
                Ok(answer)
            } else {
                Err(crate::cause!(Error::OutcomeUnknown).into())
            }
        }))
    }

    /// A provisional prefix is not yet an immutable file-use event. Replaying
    /// an already-finished write is the same event as its first finish, so do
    /// not append a second recent-use mutation for that retry.
    fn skip_recent_use(&self, tool: &str, input: &Value) -> bool {
        let Some(upload_id) = input.get("upload_id").and_then(Value::as_str) else {
            return false;
        };
        self.get(UPLOADS, upload_id)
            .ok()
            .flatten()
            .is_some_and(|upload| {
                let status = text(&upload.value, "status").unwrap_or("open");
                (tool == "read_file" && status == "open")
                    || (tool == "write_file_finish" && status == "finished")
            })
    }

    /// One tool call, without the use it may keep.
    fn call_one(
        &mut self,
        tool: &str,
        input: &Value,
        fits: Option<&dyn Fn(&Value) -> bool>,
    ) -> Option<Answer<Value>> {
        let field = |name: &str| input.get(name).and_then(Value::as_str);
        let number = |name: &str| input.get(name).and_then(Value::as_u64);
        let asked = || {
            field("name_or_identity")
                .ok_or(AccountFilesError::Invalid("name_or_identity is required", crate::cause!()))
        };
        Some(match tool {
            "list_files" => self.list_files(
                field("folder"),
                field("after"),
                number("limit").map(|limit| limit as usize),
            ),
            "find_file" => asked().and_then(|asked| self.find_file(asked)),
            "files_summary" => self.files_summary(),
            "usage_days" => usage::days(
                &self.store,
                &self.account,
                field("after"),
                number("limit").map(|limit| limit as usize),
            )
            .map_err(AccountFilesError::from),
            "search" => field("question")
                .ok_or(AccountFilesError::Invalid("question is required", crate::cause!()))
                .and_then(|question| self.search(question, number("limit"))),
            "show_file" => asked().and_then(|asked| self.show_file(asked)),
            "file_objects" => asked().and_then(|asked| self.file_objects(asked)),
            "share_file" => asked().and_then(|asked| {
                let seconds =
                    number("seconds").ok_or(AccountFilesError::Invalid("seconds is required", crate::cause!()))?;
                self.share_file(asked, seconds)
            }),
            "read_file" => asked().and_then(|asked| {
                let base64 = match input.get("encoding") {
                    None => false,
                    Some(Value::String(value)) if value == "auto" => false,
                    Some(Value::String(value)) if value == "base64" => true,
                    _ => {
                        return Err(AccountFilesError::Invalid(
                            "encoding must be auto or base64",
                         crate::cause!()));
                    }
                };
                if input.get("upload_id").is_some() {
                    let upload_id = field("upload_id")
                        .ok_or(AccountFilesError::Invalid("upload_id must be a string", crate::cause!()))?;
                    self.read_provisional_file(
                        asked,
                        upload_id,
                        number("offset").unwrap_or(0),
                        number("length"),
                        base64,
                        fits,
                    )
                } else {
                    self.read_file_encoded_fitting(
                        asked,
                        number("offset").unwrap_or(0),
                        number("length"),
                        base64,
                        fits,
                    )
                }
            }),
            "read_file_span" => asked().and_then(|asked| {
                let (Some(offset), Some(length)) = (number("offset"), number("length")) else {
                    return Err(AccountFilesError::Invalid("offset and length are required", crate::cause!()));
                };
                self.read_file_span(asked, offset, length)
            }),
            "write_file" => (|| {
                let name = field("name").ok_or(AccountFilesError::Invalid("name is required", crate::cause!()))?;
                let bytes = match (field("content_base64"), field("text")) {
                    (Some(encoded), None) => BASE64
                        .decode(encoded)
                        .map_err(|_| AccountFilesError::Invalid("content_base64 is not base64", crate::cause!()))?,
                    (None, Some(text)) => text.as_bytes().to_vec(),
                    _ => {
                        return Err(AccountFilesError::Invalid(
                            "exactly one of content_base64 or text is required",
                         crate::cause!()));
                    }
                };
                let media_type = field("media_type")
                    .unwrap_or("application/octet-stream")
                    .to_owned();
                let origins = self.origins()?;
                self.write_file(name, &bytes, &media_type, &origins)
            })(),
            "write_file_start" => (|| {
                let upload_id = field("upload_id")
                    .ok_or(AccountFilesError::Invalid("upload_id is required", crate::cause!()))?;
                let name = field("name").ok_or(AccountFilesError::Invalid("name is required", crate::cause!()))?;
                let byte_length = match input.get("length_known") {
                    Some(Value::Bool(false)) => {
                        if input
                            .get("byte_length")
                            .is_some_and(|value| !value.is_null())
                        {
                            return Err(AccountFilesError::Invalid(
                                "byte_length must be omitted when length_known is false",
                             crate::cause!()));
                        }
                        None
                    }
                    Some(Value::Bool(true)) => {
                        Some(number("byte_length").ok_or(AccountFilesError::Invalid(
                            "byte_length is required when length_known is true",
                         crate::cause!()))?)
                    }
                    Some(_) => {
                        return Err(AccountFilesError::Invalid("length_known must be a boolean", crate::cause!()));
                    }
                    None => Some(
                        number("byte_length")
                            .ok_or(AccountFilesError::Invalid("byte_length is required", crate::cause!()))?,
                    ),
                };
                let media_type = field("media_type").unwrap_or("application/octet-stream");
                let app = match input.get("app") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(app)) => Some(app.as_str()),
                    _ => {
                        return Err(AccountFilesError::Invalid(
                            "app attribution must be a string",
                         crate::cause!()));
                    }
                };
                self.write_file_start_with_length(upload_id, name, byte_length, media_type, app)
            })(),
            "write_file_piece" => (|| {
                let upload_id = field("upload_id")
                    .ok_or(AccountFilesError::Invalid("upload_id is required", crate::cause!()))?;
                let name = field("name").ok_or(AccountFilesError::Invalid("name is required", crate::cause!()))?;
                let offset =
                    number("offset").ok_or(AccountFilesError::Invalid("offset is required", crate::cause!()))?;
                let encoded = field("content_base64")
                    .ok_or(AccountFilesError::Invalid("content_base64 is required", crate::cause!()))?;
                let bytes = write::decode_piece(encoded)?;
                self.write_file_piece(upload_id, name, offset, &bytes)
            })(),
            "write_file_finish" => (|| {
                let upload_id = field("upload_id")
                    .ok_or(AccountFilesError::Invalid("upload_id is required", crate::cause!()))?;
                let name = field("name").ok_or(AccountFilesError::Invalid("name is required", crate::cause!()))?;
                self.write_file_finish_expecting(upload_id, name, field("identity"))
            })(),
            "write_file_described_spans" => (|| {
                let upload_id = field("upload_id")
                    .ok_or(AccountFilesError::Invalid("upload_id is required", crate::cause!()))?;
                let name = field("name").ok_or(AccountFilesError::Invalid("name is required", crate::cause!()))?;
                let spans = input.get("spans").and_then(Value::as_array)
                    .ok_or(AccountFilesError::Invalid("spans is required", crate::cause!()))?;
                self.write_described_spans(upload_id, name, spans)
            })(),
            "read_file_described_spans" => (|| {
                let upload_id = field("upload_id")
                    .ok_or(AccountFilesError::Invalid("upload_id is required", crate::cause!()))?;
                self.read_described_spans(upload_id)
            })(),
            "write_file_cancel" => (|| {
                let upload_id = field("upload_id")
                    .ok_or(AccountFilesError::Invalid("upload_id is required", crate::cause!()))?;
                let name = field("name").ok_or(AccountFilesError::Invalid("name is required", crate::cause!()))?;
                self.write_file_cancel(upload_id, name)
            })(),
            "find_names" => field("prefix")
                .ok_or(AccountFilesError::Invalid("prefix is required", crate::cause!()))
                .and_then(|prefix| {
                    self.find_names(
                        prefix,
                        field("after"),
                        number("limit").map(|limit| limit as usize),
                    )
                }),
            "recent_files" => self.recent_files(number("limit"), field("before")),
            "record_file_use" => match (field("file"), field("kind")) {
                (Some(file), Some(kind)) => self.record_file_use(file, kind),
                _ => Err(AccountFilesError::Invalid(
                    "say which file this was and what happened",
                 crate::cause!())),
            },
            "set_file_facts" => match (field("identity"), input.get("facts")) {
                // Old src/file-tools.mjs:135: the results merge of kind `facts`; read back by read_file_results.
                (Some(identity), Some(facts)) => account_routes::Files::shipped()
                    .ok_or(AccountFilesError::Records(
                        crate::cause!(crate::records::Error::Unavailable),
                     crate::cause!()))
                    .and_then(|files| {
                        self.merge_file_result(
                            identity,
                            &files.facts().kind,
                            facts,
                            field("produced_by"),
                            false,
                        )
                    }),
                _ => Err(AccountFilesError::Invalid(
                    "identity and facts are required",
                 crate::cause!())),
            },
            "list_set_aside" => self.list_tree(
                &SET_ASIDE,
                field("folder"),
                field("after"),
                number("limit").map(|limit| limit as usize),
            ),
            "move_names" | "copy_names" | "set_aside" | "put_back" => (|| {
                let required = |name: &'static str| {
                    field(name).ok_or(AccountFilesError::Invalid(
                        "from and to, or name, are required",
                     crate::cause!()))
                };
                let (from, to, kept, source, target) = match tool {
                    "move_names" => (required("from")?, required("to")?, false, &LIVE, &LIVE),
                    "copy_names" => (required("from")?, required("to")?, true, &LIVE, &LIVE),
                    "set_aside" => (
                        required("name")?,
                        required("name")?,
                        false,
                        &LIVE,
                        &SET_ASIDE,
                    ),
                    _ => (
                        required("name")?,
                        required("name")?,
                        false,
                        &SET_ASIDE,
                        &LIVE,
                    ),
                };
                let limit = number("limit").map(|limit| limit as usize);
                self.carry_names(
                    names::Carry {
                        source,
                        from,
                        target,
                        to,
                        kept,
                    },
                    field("after"),
                    limit,
                )
            })(),
            "forget_set_aside" => field("name")
                .ok_or(AccountFilesError::Invalid("name is required", crate::cause!()))
                .and_then(|name| {
                    self.forget_set_aside(
                        name,
                        field("after"),
                        number("limit").map(|limit| limit as usize),
                    )
                }),
            "retire_names" => match input.get("names").and_then(Value::as_array) {
                Some(rows) => self.retire_names(rows),
                None => Err(AccountFilesError::Invalid(settings::word("retire_list"), crate::cause!())),
            },
            "queue_release" => self.queue_release(number("limit").map(|limit| limit as usize)),
            "release_gone_bytes" => {
                self.release_gone_bytes(number("limit").map(|limit| limit as usize))
            }
            "list_released" => {
                self.list_released(field("after"), number("limit").map(|limit| limit as usize))
            }
            "record_file_results" => match input.get("results").and_then(Value::as_array) {
                Some(items) => self.record_file_results(items),
                None => Err(AccountFilesError::Invalid(settings::word(
                    "result_write_list",
                ), crate::cause!())),
            },
            "read_file_results" => field("identity")
                .ok_or(AccountFilesError::Invalid(settings::word(
                    "result_identity",
                ), crate::cause!()))
                .and_then(|identity| {
                    self.read_file_results(identity, field("kind"), field("caller"))
                }),
            "read_file_result_fields" => (|| {
                let identity = field("identity").ok_or(AccountFilesError::Invalid(
                    settings::word("result_identity"),
                 crate::cause!()))?;
                let kind = field("kind")
                    .ok_or(AccountFilesError::Invalid(settings::word("result_kind"), crate::cause!()))?;
                let fields: Option<Vec<&str>> = input
                    .get("fields")
                    .and_then(Value::as_array)
                    .map(|fields| fields.iter().filter_map(Value::as_str).collect());
                let fields = fields
                    .filter(|named| Some(named.len()) == input["fields"].as_array().map(Vec::len))
                    .ok_or(AccountFilesError::Invalid(settings::word("result_fields"), crate::cause!()))?;
                self.read_file_result_fields(identity, kind, &fields, field("caller"))
            })(),
            "list_file_results" => self.list_file_results(
                field("kind"),
                field("after"),
                number("limit").map(|limit| limit as usize),
                field("caller"),
            ),
            "read_file_results_many" => (|| {
                let kind = field("kind")
                    .ok_or(AccountFilesError::Invalid(settings::word("result_many"), crate::cause!()))?;
                let identities: Vec<&str> = input
                    .get("identities")
                    .and_then(Value::as_array)
                    .ok_or(AccountFilesError::Invalid(settings::word("result_many"), crate::cause!()))?
                    .iter()
                    .filter_map(Value::as_str)
                    .collect();
                self.read_file_results_many(&identities, kind, field("caller"))
            })(),
            "merge_file_result" => (|| {
                let identity = field("identity").ok_or(AccountFilesError::Invalid(
                    settings::word("result_identity"),
                 crate::cause!()))?;
                let kind = field("kind")
                    .ok_or(AccountFilesError::Invalid(settings::word("result_kind"), crate::cause!()))?;
                let patch = input
                    .get("value")
                    .ok_or(AccountFilesError::Invalid(settings::word("result_patch"), crate::cause!()))?;
                let only_if_empty = input.get("only_if_empty") == Some(&Value::Bool(true));
                self.merge_file_result(identity, kind, patch, field("produced_by"), only_if_empty)
            })(),
            "remove_file_result" => (|| {
                let identity = field("identity").ok_or(AccountFilesError::Invalid(
                    settings::word("result_identity"),
                 crate::cause!()))?;
                let kind = field("kind")
                    .ok_or(AccountFilesError::Invalid(settings::word("result_kind"), crate::cause!()))?;
                self.remove_file_result(identity, kind)
            })(),
            // The read-only WebDAV folder (src/account_files/dav.rs), one request a call: the /dav route signs
            // the caller in and passes {prefix, method, path, depth?, range?}; the answer is the HTTP answer as data.
            "dav" => (|| {
                let request = dav::Request {
                    method: field("method")
                        .ok_or(AccountFilesError::Invalid(settings::word("dav_request"), crate::cause!()))?,
                    path: field("path").unwrap_or(""),
                    depth: field("depth"),
                    range: field("range"),
                };
                let answer = self.dav(field("prefix").unwrap_or(""), &request)?;
                Ok(serde_json::json!({
                    "status": answer.status,
                    "headers": answer.headers,
                    "body_base64": BASE64.encode(&answer.body),
                }))
            })(),
            // The writable half of the same folder (src/account_files/dav_write.rs), one request a call: the /dav route
            // passes a PUT, DELETE, MKCOL, COPY or MOVE here with its headers and body; the answer is the same data.
            "dav_write" => (|| {
                let body = match field("body_base64") {
                    Some(encoded) => BASE64
                        .decode(encoded)
                        .map_err(|_| AccountFilesError::Invalid(settings::word("dav_body"), crate::cause!()))?,
                    None => Vec::new(),
                };
                let request = dav_write::request_of(input, &body)
                    .ok_or(AccountFilesError::Invalid(settings::word("dav_request"), crate::cause!()))?;
                let answer = self.dav_write(field("prefix").unwrap_or(""), &request)?;
                Ok(serde_json::json!({
                    "status": answer.status,
                    "headers": answer.headers,
                    "body_base64": BASE64.encode(&answer.body),
                }))
            })(),
            _ => return None,
        })
    }

    /// The account's origin records (for `write_file`).
    pub fn origins(&self) -> Answer<Vec<(String, Origin)>> {
        let page = self
            .store
            .list_page(&self.account, ORIGINS, "", MAX_PAGE_ITEMS)?;
        page.items
            .into_iter()
            .map(|record| {
                Ok((
                    record.id,
                    serde_json::from_value(record.value)
                        .map_err(|_| Error::Invalid("invalid origin record", crate::cause!()))?,
                ))
            })
            .collect()
    }
}

/// The contract's file row (`find_file`): the record's facts, its aliases and up to 20 of its names, sorted.
fn file_row(file: &Record) -> Value {
    let value = &file.value;
    let mut names: Vec<&str> = value
        .get("names")
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    names.sort_unstable();
    names.truncate(NAMES_SHOWN);
    let mut row = Map::new();
    row.insert("identity".into(), json!(file.id));
    for field in [
        "byte_length",
        "media_type",
        "key",
        "origin",
        "spans",
        "prefix_identity",
        "stored_at",
        "checked_at",
    ] {
        row.insert(
            field.into(),
            value.get(field).cloned().unwrap_or(Value::Null),
        );
    }
    row.insert(
        "aliases".into(),
        value.get("aliases").cloned().unwrap_or_else(|| json!([])),
    );
    row.insert("names".into(), json!(names));
    Value::Object(row)
}

fn text<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

fn is_text(media_type: &str) -> bool {
    media_type.starts_with("text/") || matches!(media_type, "application/json" | "application/xml" | "application/javascript")
}

/// Add `name` to a file record's `names` unless it is listed already or the list holds `NAMES_LISTED`; true when the
/// record changed and must be written.
fn lists_name(file: &mut Value, name: &str) -> Answer<bool> {
    let names = file
        .get_mut("names")
        .and_then(Value::as_array_mut)
        .ok_or(crate::cause!(Error::Unavailable))?;
    if names.len() >= NAMES_LISTED || names.iter().any(|held| held.as_str() == Some(name)) {
        return Ok(false);
    }
    names.push(json!(name));
    Ok(true)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
