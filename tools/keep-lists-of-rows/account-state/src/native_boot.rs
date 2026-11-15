// src/native_boot.rs
//
// Purpose: Read the Mac app's private app files list (which account: its state
// folder, restore record, port and custody) and the signed app's own carried frontend
// file map (opaque and pinned: path -> BLAKE3 content identity, plus the
// client tree's identities and the source commit the files were taken from), and
// compose them.
//
// Non-Negotiable Invariants:
// - The private Launch message cannot select or authenticate its own state.
// - Reuse the existing per-user app files list; never mint an account or session.
// - A missing installed opened account refuses without a backend or environment fallback.
// - The app files list names no bundle file: the bundle is the one record of its own client and
//   its file pins, so installing a new signed build changes nothing outside the bundle.
// - The carried file map is opaque here: this module checks every pin in it and never
//   learns what any file is for. A reader that wants one file asks for it by its path
//   (`Frontend::file`); which screens, sign-in ways and policies apply is the account's
//   own rows' answer at run time (the tools catalog rows, the sign-in settings and
//   ways rows), never a field here.
//
// Key Concepts: installed reader DATA, protected take-over of the app's folder, current account mount,
// original root provenance and retained frontend byte identities.
//
// Security Considerations: read bounded regular files, reject aliases and changed
// named files; never print app files list contents, credentials or customer records.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

pub mod catalog_source;
pub mod own_records_start;
mod mcp_frontend;
mod record_delivery;
mod browser_workspace_write;
pub(crate) mod mcp_local;
pub(crate) mod forwarder_connection;
pub(crate) mod mcp_outbound;
pub(crate) mod connection_management;
pub(crate) mod mcp_credential;
pub(crate) mod mcp_selected_personal;
mod mcp_workspace_write;
mod service_origin;
mod show_rules;
pub mod tool_label_locale;
pub mod tool_screens;

mod live_heads;
pub(crate) use live_heads::PreparedHeads;

use crate::{
    account::{AccountIdentity, AccountResult, NativeAccountOwner},
    import::FilePin,
    local_account::{witnessed, FixedGeneration, LocalAccount, ProcessIdentity, SelectedLocalState},
    workspace::{ScreenModules, WorkspaceAssets, WorkspaceDom},
};
use content_crypto::advanced::blake3;
use serde::Deserialize;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fmt,
    fs::{self, OpenOptions},
    io::Read,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use zeroize::Zeroizing;

/// The folder in an account's state folder where a launch keeps the rows of each asset tree it opened
/// (`Frontend::open`), named by the tree identity.
pub const KEPT_ASSET_TREES: &str = "workspace-asset-trees";
const MAX_DESCRIPTOR: usize = 16_384;
const MAX_DATA: usize = 1024 * 1024;
/// The largest pinned file (`PinnedData`): a carried file, a product DATA file or a service configuration.
const MAX_PINNED: usize = 16 * 1024 * 1024;
/// The largest carried file map: it grows with the files a release carries, never with a kind list.
const MAX_CARRIED_SELECTION: usize = 256 * 1024;
/// The largest account restore record (`Selection::write_starting_rows` reads its user id).
const MAX_RECEIPT: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone)]
pub enum Error {
    Unavailable(crate::refusal_cause::Cause),
    Invalid(crate::refusal_cause::Cause),
    Changed(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Unavailable(cause) => cause,
            Self::Invalid(cause) => cause,
            Self::Changed(cause) => cause,
        }
    }
}
crate::impl_caused!(Error);

impl PartialEq for Error { fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) } }
impl Eq for Error {}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let result: std::fmt::Result = {
        f.write_str(match self {
            Self::Unavailable(_) => "installed native selection unavailable",
            Self::Invalid(_) => "installed native selection refused",
            Self::Changed(_) => "installed native selection changed",
        })

        };
        result?;
        write!(f, " cause={}", self.cause())
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
/// Which check of the selection stage refused an installed app's account (`Selection::installed_at_checked`): one fixed
/// word from the closed list below, never a path, a field's value or a file's bytes. Startup prints it with the stage
/// (src/native_entry.rs `StartupFailure`: `native-startup-error stage=selection:<step>`), so the next refusal names its
/// check without anyone reading the app's private files.
///
/// - `app-files-list`: the app files list is not this user's own private 0600 regular file, does not parse, or changed
///   since it was read.
/// - `app-contents`: this program is not an app's (no `Contents/MacOS`, and no release the app's launch plan runs).
/// - `computer-reader`: the app's `Resources/computer-reader.json` names no relative `local_runtime.frontend_root`.
/// - `frontend-selection`: the carried `frontend-selection.json` is missing, too large, of another shape, names another
///   root or a path outside its folder, or a client identity is not a BLAKE3 hash.
/// - `account-fields`: the list's versions, restore record pin, account files store, prior processes, inventory proofs
///   or root source are refused.
/// - `port`: the list's port is not the loopback port this start serves.
/// - `state-folder`: the list's state folder is not an exact existing folder, not the requested one, or not under an
///   entry of this computer's home layout.
/// - `frontend-files`: a carried file is missing or its bytes are not its pin.
/// - `service-origin`: the product settings (PRODUCT_SETTINGS) are unreadable or their `app_host` makes no https origin.
#[derive(Debug, Clone)]
pub struct Refused {
    step: &'static str,
    error: Error,
    cause: crate::refusal_cause::Cause,
}
impl PartialEq for Refused { fn eq(&self, other: &Self) -> bool { self.step == other.step && self.error == other.error } }
impl Eq for Refused {}
impl Refused {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { &self.cause }
    /// The check's fixed word.
    pub fn step(&self) -> &'static str {
        self.step
    }
    /// The refusal kind, as the unchecked readers answer it.
    pub fn error(&self) -> Error {
        self.error.clone()
    }
}
crate::impl_caused!(Refused);

impl fmt::Display for Refused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at {}", self.error, self.step)
    }
}
impl std::error::Error for Refused {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
/// Name the check a selection read refused at.
trait At<T> {
    fn at(self, step: &'static str) -> Result<T, Refused>;
}
impl<T> At<T> for Result<T, Error> {
    fn at(self, step: &'static str) -> Result<T, Refused> {
        self.map_err(|error| Refused { step, cause: error.cause(), error })
    }
}
fn valid_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn relative(path: &Path) -> bool {
    !path.as_os_str().is_empty() && path.components().all(|p| matches!(p, Component::Normal(_)))
}
fn exact_path(path: &Path) -> Result<PathBuf, Error> {
    if !path.is_absolute()
        || path
            .components()
            .any(|p| matches!(p, Component::ParentDir | Component::CurDir))
    {
        return Err(crate::cause!(Error::Invalid));
    }
    let actual = fs::canonicalize(path).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if actual != path {
        return Err(crate::cause!(Error::Invalid));
    }
    Ok(actual)
}
fn bounded(path: &Path, limit: usize, private: bool) -> Result<Zeroizing<Vec<u8>>, Error> {
    bounded_generation(path, limit, private).map(|(bytes, _)| bytes)
}
/// `bounded`, with the exact generation the bytes were read at (the same before the read, after it and by name).
fn bounded_generation(path: &Path, limit: usize, private: bool) -> Result<(Zeroizing<Vec<u8>>, FixedGeneration), Error> {
    exact_path(path)?;
    use crate::tool_runs::os::{Open, OwnerFiles, This};
    let mut file = This::open(OpenOptions::new().read(true), path, Open::NO_FOLLOW).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let before = file.metadata().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let facts = This::facts(&before).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if !before.is_file()
        || before.len() > limit as u64
        || (private
            && (facts.owner != This::this_owner().map_err(|error| crate::carry_cause!(Error::Unavailable, error))? || facts.mode & 0o777 != 0o600))
    {
        return Err(crate::cause!(Error::Invalid));
    }
    let mut bytes = Zeroizing::new(Vec::new());
    (&mut file)
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let after = file.metadata().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let named = fs::symlink_metadata(path).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let generation = FixedGeneration::of(&before).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if bytes.len() > limit
        || !named.is_file()
        || generation != FixedGeneration::of(&after).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?
        || generation != FixedGeneration::of(&named).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?
    {
        return Err(crate::cause!(Error::Changed));
    }
    Ok((bytes, generation))
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinnedData {
    pub path: PathBuf,
    pub pin: FilePin,
}
impl PinnedData {
    pub fn read(&self) -> Result<Zeroizing<Vec<u8>>, Error> {
        self.read_generation().map(|(bytes, _)| bytes)
    }
    /// `read`, with the exact generation the matching bytes were read at.
    fn read_generation(&self) -> Result<(Zeroizing<Vec<u8>>, FixedGeneration), Error> {
        if self.pin.bytes == 0 || self.pin.bytes > MAX_PINNED as u64 || !valid_hash(&self.pin.blake3)
        {
            return Err(crate::cause!(Error::Invalid));
        }
        let (bytes, generation) = bounded_generation(&self.path, MAX_PINNED, false)?;
        if bytes.len() as u64 != self.pin.bytes
            || blake3::hash(&bytes).to_hex().as_str() != self.pin.blake3
        {
            return Err(crate::cause!(Error::Changed));
        }
        Ok((bytes, generation))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootSource {
    pub state: PathBuf,
    pub pin: FilePin,
}
/// The signed app's web client and the files it carries beside it: the client tree (its folder and identities, opened
/// by `open`) and the carried file map, every file named by its path inside `root` with its pin. Nothing here names
/// what a file is for: each reader asks for its own file by path (`file`), and a file no reader asks for is still
/// pinned and checked (`Selection::assert_current`).
pub struct Frontend {
    pub root: PathBuf,
    pub manifest_identity: String,
    pub tree_identity: String,
    pub module_manifest_identity: String,
    /// Every carried file, by its path inside `root` (the key), with its full path and pin.
    pub files: BTreeMap<String, PinnedData>,
    /// Where the release took the carried files from.
    pub source: CarriedSource,
}
/// Where a release took the carried files from: a repository and the exact commit that holds them. Recorded in the
/// app so its files can be rebuilt, audited and rolled back to; never inherited from an earlier app.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CarriedSource {
    pub repo: String,
    pub commit: String,
}
impl Frontend {
    /// The carried file at `name` (its path inside the frontend folder), or None when this app carries none there.
    pub fn file(&self, name: &str) -> Option<&PinnedData> {
        self.files.get(name)
    }
    /// The carried file at `name`, or unavailable when this app carries none there.
    pub fn required(&self, name: &str) -> Result<&PinnedData, Error> {
        self.file(name).ok_or(crate::cause!(Error::Unavailable))
    }
    /// Open the captured shell through the same canonical artifact consumer as
    /// native launch and packaging inspection. The capture file's name is part of the
    /// capture format; a renamed capture file or missing sibling is not a valid carry.
    pub fn open_shell(
        &self,
    ) -> Result<Option<Arc<crate::workspace_page::CapturedWorkspaceShell>>, Error> {
        let Some(source) = self.file(SHELL_CAPTURE) else {
            return Ok(None);
        };
        source.read()?;
        if source.path.file_name() != Some(std::ffi::OsStr::new("capture.json")) {
            return Err(crate::cause!(Error::Invalid));
        }
        let parent = source.path.parent().ok_or(crate::cause!(Error::Invalid))?;
        crate::workspace_page::CapturedWorkspaceShell::open(parent, &source.pin.blake3)
            .map(|shell| Some(Arc::new(shell)))
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))
    }
    /// Open the pinned asset tree. With `kept` (a launch passes its state folder's `KEPT_ASSET_TREES`), the tree's
    /// rows are kept there under the tree identity and a later launch reads them instead of every asset
    /// (`WorkspaceAssets::open_keeping`); without it the whole tree is read, as packaging inspection does.
    pub fn open(&self, kept: Option<&Path>) -> Result<(Arc<WorkspaceAssets>, WorkspaceDom), Error> {
        exact_path(&self.root)?;
        let modules = ScreenModules::open(self.root.join("built"), &self.module_manifest_identity)
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let assets = WorkspaceAssets::open_keeping(
            self.root.join("built/assets"),
            &self.manifest_identity,
            &self.tree_identity,
            Some(modules),
            kept,
        )
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let first_answers = self.required(FIRST_ANSWERS)?;
        let dom = WorkspaceDom::from_source(&first_answers.read()?, &first_answers.pin.blake3)
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok((Arc::new(assets), dom))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AppKv {
    sqlite: PathBuf,
    #[serde(rename = "namespace")]
    store: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Prior {
    pid: u32,
    started_seconds: u64,
    started_fraction: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeSelection {
    version: String,
    receipt_bytes: u64,
    app_kv: AppKv,
    prior_processes: Vec<Prior>,
    root_source: Option<RootSource>,
}
/// What the signed app carries about its own web client (`Resources/local-workspace/frontend-selection.json`, written
/// by the shell's connection): where its files were taken from, the client tree's identities, and the carried file map,
/// path (inside the folder that holds this file) -> pin. The map is opaque: no key here is a kind of file, and a file a
/// new publisher's release adds needs no change to this reader, the connection or the installer.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Carried {
    source: CarriedSource,
    frontend: CarriedTree,
    files: BTreeMap<String, CarriedPin>,
}
/// One carried file's pin: its exact byte count and BLAKE3 content identity, and nothing else.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CarriedPin {
    bytes: u64,
    blake3: String,
}
/// The client tree inside the carried folder: its root is that folder (`.`) and its three identities.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CarriedTree {
    root: String,
    manifest_identity: String,
    tree_identity: String,
    module_manifest_identity: String,
}
/// The carried file map's file name, in the frontend folder computer-reader.json `local_runtime.frontend_root` names.
pub const CARRIED_SELECTION: &str = "frontend-selection.json";
/// The carried files trillion-local's own readers still open by path. Each is migration debt of the reader that opens it
/// (engine-feature-boundary.json), not a kind the carried map knows: the map carries any path, and a path no reader
/// names is still pinned and checked.
pub const FIRST_ANSWERS: &str = "data/first_answers.json";
pub const INPUTS: &str = "data/inputs.json";
pub const CLIENT_PROGRAM: &str = "data/client_program.json";
pub const SHELL_CAPTURE: &str = "data/shell_capture/capture.json";
pub const MCP_CAPTURE: &str = "data/mcp_capture/capture.json";
/// Read the carried file map at `path`: its frontend root is `.` (the folder holding it) and every key of its file
/// map is a relative path inside that folder, so each becomes that file's full path there.
fn carried(path: &Path) -> Result<Frontend, Error> {
    let folder = exact_path(path.parent().ok_or(crate::cause!(Error::Invalid))?)?;
    let carried: Carried =
        serde_json::from_slice(&bounded(path, MAX_CARRIED_SELECTION, false)?).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    let commit = &carried.source.commit;
    if carried.frontend.root != "."
        || carried.source.repo.is_empty()
        || carried.source.repo.len() > 256
        || carried.source.repo.chars().any(char::is_control)
        || commit.len() != 40
        || !commit.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || carried.files.len() > 4096
    {
        return Err(crate::cause!(Error::Invalid));
    }
    let mut files = BTreeMap::new();
    for (name, pin) in carried.files {
        // A plain relative path: no empty, `.` or `..` part, so one file has exactly one name in the map.
        if name.split('/').any(|part| part.is_empty() || part == "." || part == "..")
            || !relative(Path::new(&name))
            || name == CARRIED_SELECTION
        {
            return Err(crate::cause!(Error::Invalid));
        }
        let path = folder.join(&name);
        files.insert(name, PinnedData { path, pin: FilePin { bytes: pin.bytes, blake3: pin.blake3 } });
    }
    Ok(Frontend {
        root: folder,
        manifest_identity: carried.frontend.manifest_identity,
        tree_identity: carried.frontend.tree_identity,
        module_manifest_identity: carried.frontend.module_manifest_identity,
        files,
        source: carried.source,
    })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Adoption {
    version: String,
    state: PathBuf,
    receipt_identity: String,
    port: u16,
    inventory_absence_proofs: Option<PathBuf>,
    native: NativeSelection,
}

/// Whether the state folder the app selected is, when it lies inside this computer's one home, under an entry of the home
/// layout trillion-local writes (src/native_entry/home.rs `Home::admits`, the same check the computer config's accounts
/// folder gets): an app files list naming any other entry there is refused, so the state is never made at an unlisted
/// entry.
pub(crate) fn state_in_its_entry(state: &Path) -> bool {
    crate::native_entry::home::Home::of_this_process().is_none_or(|home| home.admits(state).is_ok())
}

/// The opened account is read before acquiring the existing local-runtime.lock. It is
/// not authorization; LocalAccount independently checks current state/session.
pub struct Selection {
    pub selected: SelectedLocalState,
    pub root_source: Option<RootSource>,
    pub frontend: Frontend,
    /// Set once the account's missing starting rows were written (`write_starting_rows`).
    starting_rows: OnceLock<()>,
    descriptor: PathBuf,
    descriptor_identity: blake3::Hash,
    /// The hosting app's public service origin (service_origin.rs `product_origin`), selected only for an installed app.
    service_origin: Option<String>,
    address: SocketAddr,
    /// The generation each pinned file (and the app files list) was last read at and matched its pin, by path: a check
    /// that finds the same generation reads nothing (`assert_current`, `local_account::witnessed`).
    seen: Mutex<HashMap<PathBuf, Option<FixedGeneration>>>,
    /// How many times a check read a file because its generation was not the one last matched (`rereads`).
    rereads: AtomicU64,
}
impl Selection {
    /// `path` is the private app files list; `carried_selection` is the signed app's carried frontend file map
    /// (`CARRIED_SELECTION` in its frontend folder), which names the client and the sign-in and reveal policy DATA.
    pub fn from_descriptor(
        path: &Path,
        carried_selection: &Path,
        requested_state: &Path,
        address: SocketAddr,
    ) -> Result<Self, Error> {
        Self::from_descriptor_checked(path, carried_selection, requested_state, address).map_err(|refused| refused.error)
    }
    /// `from_descriptor`, naming the check that refused (`Refused`).
    fn from_descriptor_checked(
        path: &Path,
        carried_selection: &Path,
        requested_state: &Path,
        address: SocketAddr,
    ) -> Result<Self, Refused> {
        if address.ip() != IpAddr::V4(Ipv4Addr::LOCALHOST) || address.port() < 1024 {
            return Err(crate::cause!(Error::Invalid)).at("port");
        }
        let bytes = bounded(path, MAX_DESCRIPTOR, true).at("app-files-list")?;
        let descriptor_identity = blake3::hash(&bytes);
        let source: Adoption = serde_json::from_slice(&bytes).map_err(|error| crate::carry_cause!(Error::Invalid, error)).at("app-files-list")?;
        let native = source.native;
        let frontend = carried(carried_selection).at("frontend-selection")?;
        if !valid_hash(&frontend.manifest_identity)
            || !valid_hash(&frontend.tree_identity)
            || !valid_hash(&frontend.module_manifest_identity)
        {
            return Err(crate::cause!(Error::Invalid)).at("frontend-selection");
        }
        if source.port != address.port() {
            return Err(crate::cause!(Error::Invalid)).at("port");
        }
        if exact_path(&source.state).at("state-folder")? != exact_path(requested_state).at("state-folder")?
            || !state_in_its_entry(&source.state)
        {
            return Err(crate::cause!(Error::Invalid)).at("state-folder");
        }
        if source.version != "trillion.local-runtime-adoption/v1"
            || native.version != "trillion.native-selection/v1"
            || !valid_hash(&source.receipt_identity)
            || native.receipt_bytes == 0
            || native.receipt_bytes > 4 * 1024 * 1024
            || !relative(&native.app_kv.sqlite)
            || native.app_kv.store.is_empty()
            || native.app_kv.store.len() > 128
            || !native
                .app_kv
                .store
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            || native.prior_processes.len() > 16
            || source
                .inventory_absence_proofs
                .as_deref()
                .is_some_and(|p| !p.is_absolute())
        {
            return Err(crate::cause!(Error::Invalid)).at("account-fields");
        }
        let mut pids = HashSet::new();
        if native.prior_processes.iter().any(|p| {
            p.pid <= 1
                || p.pid > i32::MAX as u32
                || !pids.insert(p.pid)
                || p.started_seconds == 0
                || p.started_fraction >= 1_000_000
        }) {
            return Err(crate::cause!(Error::Invalid)).at("account-fields");
        }
        if let Some(root) = &native.root_source {
            exact_path(&root.state).at("account-fields")?;
            if root.pin.bytes == 0
                || root.pin.bytes > 4 * 1024 * 1024
                || !valid_hash(&root.pin.blake3)
            {
                return Err(crate::cause!(Error::Invalid)).at("account-fields");
            }
        }
        let result = Self {
            selected: SelectedLocalState {
                root: source.state,
                receipt: FilePin {
                    bytes: native.receipt_bytes,
                    blake3: source.receipt_identity,
                },
                app_kv_sqlite: native.app_kv.sqlite,
                app_kv_store: native.app_kv.store,
                prior_processes: native
                    .prior_processes
                    .into_iter()
                    .map(|p| ProcessIdentity {
                        pid: p.pid,
                        started_seconds: p.started_seconds,
                        started_fraction: p.started_fraction,
                    })
                    .collect(),
            },
            root_source: native.root_source,
            frontend,
            starting_rows: OnceLock::new(),
            descriptor: path.into(),
            descriptor_identity,
            service_origin: None,
            address,
            seen: Mutex::default(),
            rereads: AtomicU64::new(0),
        };
        result.current()?;
        Ok(result)
    }
    /// The app files list and every pinned file are still the exact files they were opened as, each checked by
    /// `local_account::witnessed`: a file whose generation (`FixedGeneration`: inode, owner, mode, size, modified and
    /// changed times) is the one last matched is not read again; any other is read and its bytes matched to their pin
    /// once more, so an edit, a replacement or an edit that puts the modified time back (it changes the changed time)
    /// is refused exactly as by a check that always read.
    pub fn assert_current(&self) -> Result<(), Error> {
        self.current().map_err(|refused| refused.error)
    }
    /// `assert_current`, naming the check that refused: the app files list, or a carried file.
    fn current(&self) -> Result<(), Refused> {
        let mut seen = self.seen.lock().map_err(|error| crate::carry_cause!(Error::Unavailable, error)).at("app-files-list")?;
        let mut reread = witnessed(seen.entry(self.descriptor.clone()).or_default(), &self.descriptor, || {
            let (bytes, generation) = bounded_generation(&self.descriptor, MAX_DESCRIPTOR, true)?;
            if content_crypto::advanced::blake3::hash(&bytes) != self.descriptor_identity {
                return Err(crate::cause!(Error::Changed));
            }
            Ok(generation)
        })
        .at("app-files-list")? as u64;
        // Every carried file, whatever it is for.
        for data in self.frontend.files.values() {
            reread += witnessed(seen.entry(data.path.clone()).or_default(), &data.path, || {
                data.read_generation().map(|(_, generation)| generation)
            })
            .at("frontend-files")? as u64;
        }
        self.rereads.fetch_add(reread, Ordering::Relaxed);
        Ok(())
    }
    /// How many times `assert_current` read a file because its generation was not the one last matched (the first
    /// check when the account is opened reads each once).
    /// Write, once, each starting row the account lacks (its copies row and its copy rules row,
    /// `account::rows::StartingRows`) from the starting rows the app's product settings name (section `new_accounts`,
    /// `product_starting_rows`), exactly as a computer writes its config's `new_accounts` (computer.rs
    /// `write_starting_rows`); a row the account already has is kept. Product settings with no such section write the
    /// shipped rows, the same as a computer config's missing rows. Run once, at the account's open (native_entry.rs,
    /// before any route is served); the account's user id is read from its pinned restore record.
    ///
    /// Why (lead-66, measured Nov 5 2026): only a computer making an account (src/account/create.rs) or opening one with
    /// its config wrote starting rows, and this entry passed none, so the Mac app's account had rows a computer's had not.
    pub fn write_starting_rows(&self) -> Result<(), Error> {
        if self.starting_rows.get().is_some() {
            return Ok(());
        }
        let receipt = PinnedData {
            path: self.selected.root.join(RECEIPT_FILE),
            pin: self.selected.receipt.clone(),
        };
        if receipt.pin.bytes == 0 || receipt.pin.bytes > MAX_RECEIPT as u64 {
            return Err(crate::cause!(Error::Invalid));
        }
        let bytes = receipt.read()?;
        let user = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|receipt| receipt["account"]["userId"].as_str().filter(|id| !id.is_empty()).map(str::to_owned))
            .ok_or(crate::cause!(Error::Invalid))?;
        let starting = product_starting_rows(crate::account_files::identity::section(STARTING_SECTION).ok().flatten())?;
        let storage = crate::account::rows::open(&self.selected.root).map_err(|error| Error::Unavailable(error.cause()))?;
        starting.write_missing_on_open(&*storage, &user).map_err(|error| Error::Unavailable(error.cause()))?;
        let _ = self.starting_rows.set(());
        Ok(())
    }
    pub fn rereads(&self) -> u64 {
        self.rereads.load(Ordering::Relaxed)
    }
    pub fn address(&self) -> SocketAddr {
        self.address
    }
    /// The account the running app opens from the app files list at `descriptor`, which the app names on the command
    /// line (`native-serve DESCRIPTOR`): the state folder and port are the list's own. The list is trusted
    /// as this user's own private file (0600 and owned by this user, `bounded`), not by the folder it is in.
    /// The existing signed Mac connection verifies the bundle before launching it.
    pub fn installed_at(descriptor: &Path) -> Result<Self, Error> {
        Self::installed_at_checked(descriptor).map_err(|refused| refused.error)
    }
    /// `installed_at`, naming the check that refused (`Refused`): what startup reports.
    pub fn installed_at_checked(descriptor: &Path) -> Result<Self, Refused> {
        // A bad app files list is refused before the running app is looked for.
        let source = read_app_files_list(descriptor).at("app-files-list")?;
        let contents = running_contents().at("app-contents")?;
        Self::installed_with(&contents, descriptor, source, None)
    }
    /// The account an app at `contents` opens from `descriptor`: exactly what `installed_at` does for the running
    /// app, so a preflight can read an installed app's opened account the way it starts.
    pub fn installed_from(contents: &Path, descriptor: &Path) -> Result<Self, Error> {
        Self::installed_from_checked(contents, descriptor).map_err(|refused| refused.error)
    }
    /// `installed_from`, naming the check that refused (`Refused`).
    pub fn installed_from_checked(contents: &Path, descriptor: &Path) -> Result<Self, Refused> {
        Self::installed_with(contents, descriptor, read_app_files_list(descriptor).at("app-files-list")?, None)
    }
    /// `frontend` is a web client folder given by the caller, else the app's carried one is read.
    fn installed_with(contents: &Path, descriptor: &Path, source: Adoption, frontend: Option<PathBuf>) -> Result<Self, Refused> {
        let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), source.port);
        let frontend = match frontend {
            Some(folder) => folder,
            None => contents.join(local_runtime_path(contents, "/local_runtime/frontend_root").at("computer-reader")?),
        };
        let mut selection =
            Self::from_descriptor_checked(descriptor, &frontend.join(CARRIED_SELECTION), &source.state, address)?;
        selection.select_installed_service_origin().at("service-origin")?;
        Ok(selection)
    }
}
/// The loopback port the app's files list names (the same file `native-serve` takes), for a command
/// on this computer that calls that account (src/account/hooks.rs `command`). The file is read as `installed_at`
/// reads it: this user's own private file.
pub fn app_port(app_files_list: &Path) -> Result<u16, Error> {
    read_app_files_list(app_files_list).map(|kept| kept.port)
}
/// The selected account's state folder and owner id, for a command on this computer that reaches its vault
/// (src/secrets/credential-home.json `state_from`, `account_from`; src/secrets.rs `reach`): the state folder is the
/// field `state_field` of the app's files list at `app_files_list`, read as `installed_at` reads it (this user's own
/// private file); the account is the 64-hex owner id at `account_pointer` of the state folder's own `state_file`, as
/// src/local_account.rs `open_source` reads it from the restore receipt.
pub fn selected_account(app_files_list: &Path, state_field: &str, state_file: &str, account_pointer: &str) -> Result<(PathBuf, String), Error> {
    let list: serde_json::Value = serde_json::from_slice(&bounded(app_files_list, MAX_DESCRIPTOR, true)?).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    let state = list.get(state_field).and_then(|state| state.as_str()).map(PathBuf::from).ok_or(crate::cause!(Error::Invalid))?;
    let state = exact_path(&state)?;
    if Path::new(state_file).components().count() != 1 || !matches!(Path::new(state_file).components().next(), Some(Component::Normal(_))) {
        return Err(crate::cause!(Error::Invalid));
    }
    let receipt: serde_json::Value = serde_json::from_slice(&bounded(&state.join(state_file), MAX_RECEIPT, false)?).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    let account = receipt
        .pointer(account_pointer)
        .and_then(|account| account.as_str())
        .filter(|account| account.len() == 64 && account.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
        .ok_or(crate::cause!(Error::Invalid))?;
    Ok((state, account.to_owned()))
}
/// The app files list at `descriptor`, read as this user's own private file (`bounded`).
fn read_app_files_list(descriptor: &Path) -> Result<Adoption, Error> {
    serde_json::from_slice(&bounded(descriptor, MAX_DESCRIPTOR, true)?).map_err(|error| crate::carry_cause!(Error::Invalid, error))
}
/// A relative path the app's computer-reader.json names at `pointer`.
fn local_runtime_path(contents: &Path, pointer: &str) -> Result<PathBuf, Error> {
    let data = bounded(&contents.join("Resources/computer-reader.json"), MAX_DATA, false)?;
    let settings: serde_json::Value = serde_json::from_slice(&data).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    let name = PathBuf::from(settings.pointer(pointer).and_then(|v| v.as_str()).ok_or(crate::cause!(Error::Invalid))?);
    if relative(&name) { Ok(name) } else { Err(crate::cause!(Error::Invalid)) }
}
/// The Contents folder of the app whose program this process is: the folder above `Contents/MacOS/<program>`, or, for an
/// engine the app runs from elsewhere (one built from main on this computer), the app's Contents its launch names
/// (`APP_CONTENTS`).
fn running_contents() -> Result<PathBuf, Error> {
    let exe = std::env::current_exe().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let macos = exe.parent().ok_or(crate::cause!(Error::Unavailable))?;
    let contents = macos.parent().ok_or(crate::cause!(Error::Unavailable))?;
    if macos.file_name() != Some(std::ffi::OsStr::new("MacOS")) || contents.file_name() != Some(std::ffi::OsStr::new("Contents")) {
        return app_contents(std::env::var_os(APP_CONTENTS));
    }
    Ok(contents.to_owned())
}

/// The app's variable naming its Contents for an engine it runs from outside the app (trillion-apps
/// macos/Shared/LocalRuntimeReadiness.swift `NativeEngineLaunch`).
pub const APP_CONTENTS: &str = "TRILLION_APP_CONTENTS";

/// The app's Contents `contents` names: an absolute `Contents` folder holding the app's files list
/// (`Resources/computer-reader.json`) and its `MacOS` folder. Anything else names no app.
fn app_contents(contents: Option<std::ffi::OsString>) -> Result<PathBuf, Error> {
    let contents = PathBuf::from(contents.ok_or(crate::cause!(Error::Unavailable))?);
    if !contents.is_absolute() || contents.file_name() != Some(std::ffi::OsStr::new("Contents"))
        || !contents.join("MacOS").is_dir() || !contents.join("Resources/computer-reader.json").is_file() {
        return Err(crate::cause!(Error::Unavailable));
    }
    Ok(contents)
}
/// The receipt file in an account's state folder (its user id is `account.userId`).
const RECEIPT_FILE: &str = "restore-receipt.json";
/// The product settings section (src/account_files/identity.json `sections`) that holds the starting rows the hosting
/// app writes into an account that opens without them: the same shape as a computer config's `new_accounts`.
const STARTING_SECTION: &str = "new_accounts";
/// The starting rows the hosting app writes: the product settings' `new_accounts` (`section`) when the launcher wrote one,
/// else the shipped rows (`account/rows/new-accounts.json`, the one owner of the starting rows a computer also falls back
/// to). Refused (`Error::Invalid`) when the section is not starting rows or its rows do not hold together
/// (`StartingRows::valid`).
fn product_starting_rows(section: Option<&serde_json::Value>) -> Result<crate::account::rows::StartingRows, Error> {
    let Some(section) = section else { return Ok(crate::account::rows::shipped().clone()) };
    let rows: crate::account::rows::StartingRows = serde_json::from_value(section.clone()).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
    rows.valid().then_some(rows).ok_or(crate::cause!(Error::Invalid))
}
/// The account one composition serves, as both entries choose it: the hosting app's `Selection`, taken over (with the
/// browser build's frontend DATA and the product's service origin), or a computer's config (the account folder and the
/// computer's public origin; no frontend, no hosting app). The account routes, the device routes and MCP need only this; the browser workspace needs the hosting app's frontend and asks
/// for it (`frontend`), which a computer refuses.
pub struct Chosen {
    /// The hosting app's opened account, when the hosting app chose the account.
    hosting: Option<Selection>,
    /// A computer's own choice, when a computer config chose the account.
    computer: Option<ComputerChoice>,
}

/// What a computer config gives a composition.
struct ComputerChoice {
    selected: SelectedLocalState,
    origin: String,
}

impl Chosen {
    /// The opened account taken over from the hosting app.
    pub fn hosting(selection: Selection) -> Self {
        Self { hosting: Some(selection), computer: None }
    }

    /// A computer's choice: the account folder it opened and its public origin.
    pub fn computer(selected: SelectedLocalState, origin: String) -> Self {
        Self { hosting: None, computer: Some(ComputerChoice { selected, origin }) }
    }

    /// The selected account state.
    pub fn selected(&self) -> &SelectedLocalState {
        match (&self.hosting, &self.computer) {
            (Some(selection), _) => &selection.selected,
            (None, Some(computer)) => &computer.selected,
            (None, None) => unreachable!("a choice is made by one of its two entries"),
        }
    }

    /// The hosting app's opened account is still the exact files it was taken over as. A computer's choice has no pinned files
    /// beyond the account's own restore record, which the account owner checks.
    pub fn assert_current(&self) -> Result<(), Error> {
        match &self.hosting {
            Some(selection) => selection.assert_current(),
            None => Ok(()),
        }
    }

    /// The browser build's frontend DATA: the hosting app's only. A computer has none.
    pub fn frontend(&self) -> Result<&Frontend, Error> {
        self.hosting.as_ref().map(|selection| &selection.frontend).ok_or(crate::cause!(Error::Unavailable))
    }

    /// The public origin: the signed app's service origin, or the computer config's.
    pub fn selected_service_origin(&self) -> Result<Option<String>, Error> {
        match (&self.hosting, &self.computer) {
            (Some(selection), _) => selection.selected_service_origin(),
            (None, Some(computer)) => Ok(Some(computer.origin.clone())),
            (None, None) => Err(crate::cause!(Error::Unavailable)),
        }
    }

    /// The forwarder the hosting app's outbound connection reaches, as `host:port` (its service endpoints' TLS host and
    /// port): where the engine's own computer opens its session (native_entry/computer/hosting.rs). None where the app
    /// names no service.
    pub(crate) fn forwarder_endpoint(&self) -> Option<String> {
        let service = self.selected_mcp_service_endpoints().ok()??;
        Some(format!("{}:{}", service.tls_host(), service.tls_port()))
    }

    /// The hosting app's outbound MCP service endpoints. A computer opens its forwarder sessions itself and has none here.
    pub fn selected_mcp_service_endpoints(&self) -> Result<Option<service_origin::McpServiceEndpoints>, Error> {
        match &self.hosting {
            Some(selection) => selection.selected_mcp_service_endpoints(),
            None => Ok(None),
        }
    }

    /// The tool-label locale: trillion-local's own, the same at a computer and in the hosting app.
    pub fn selected_tool_label_locale(&self) -> Result<Option<Arc<crate::tool_label_locale::QualifiedLocale>>, Error> {
        crate::native_boot::tool_label_locale::engine_locale().map(Some)
    }
}

/// Retain the taken-over app files list/policy witness for the whole private host
/// lifetime. Current account state remains owned by LocalAccount; the opened account
/// never supplies replacement rights or a successful answer on its own.
pub struct SelectedAccount {
    owner: LocalAccount,
    /// Shared with this account's browser-session check owner (`admission_owner`), which checks the same choice.
    selection: Arc<Chosen>,
    /// The account's own sign-in (src/account/account_routes.rs), shared by every owner of this account: the one source of
    /// who a credential is. None only before the account routes open it.
    sign_in: Option<Arc<crate::account::account_routes::SignIn>>,
    /// The store budget this account's own-records store uses instead of the computer's (`None`, the production value).
    /// Set only by a test, through `set_store_budget`.
    store_budget: Option<crate::storage::record_store_resources::StoreBudget>,
}
impl SelectedAccount {
    /// The account's base reader and its current own-record routes, for one admitted logical read of the account's own
    /// records (`local_account::own_records::read_own_with_keys`).
    pub(crate) fn own_read_context(
        &mut self,
    ) -> Result<
        (
            Arc<crate::storage::record_store_resources::Readers>,
            Option<crate::local_account::own_records::OwnReadRoutes>,
        ),
        crate::records::Error,
    > {
        self.owner.own_read_context()
    }
    /// Give this account's own-records store a budget of its own (a test's synthetic one), instead of the computer's.
    #[cfg(test)]
    pub(crate) fn set_store_budget(&mut self, budget: crate::storage::record_store_resources::StoreBudget) {
        self.store_budget = Some(budget);
    }
    /// Give this owner the account's sign-in. Owners made by `admission_owner` after this share it.
    pub(crate) fn set_sign_in(&mut self, sign_in: Arc<crate::account::account_routes::SignIn>) {
        self.sign_in = Some(sign_in);
    }

    /// Give this owner an in-memory door, for tests: a person signs in to it with
    /// `signed_in::test_token(owner_id)`.
    #[cfg(test)]
    pub(crate) fn sign_in_in_memory(&mut self) -> Arc<crate::account::account_routes::SignIn> {
        let account = self.owner.account();
        let sign_in = crate::account::account_routes::in_memory(&account.user_id, &account.owner_id);
        self.sign_in = Some(sign_in.clone());
        sign_in
    }

    /// The devices the hosting app's account enrolled in this state (`LocalAccount::enrolled_devices`), read while the
    /// opened account is current.
    pub(crate) fn enrolled_devices(&mut self) -> AccountResult<Vec<String>> {
        self.assert_source_current()?;
        let devices = self.owner.enrolled_devices()?;
        self.assert_source_current()?;
        Ok(devices)
    }

    /// The account's sign-in, or unavailable before the account routes opened it.
    pub(crate) fn sign_in(&self) -> crate::account::AccountResult<&Arc<crate::account::account_routes::SignIn>> {
        self.sign_in.as_ref().ok_or(crate::cause!(crate::account::AccountError::SourceUnavailable))
    }

    /// The forwarder the hosting app's outbound connection reaches (`Chosen::forwarder_endpoint`).
    pub(crate) fn forwarder_endpoint(&self) -> Option<String> {
        self.selection.forwarder_endpoint()
    }

    /// The selected account's state folder: where the account's routes keep the account's tool runs.
    pub(crate) fn state_root(&self) -> &Path {
        &self.selection.selected().root
    }

    /// One bounded step of the account's own-records migration to record store, inside
    /// the taken-over opened account: it is asserted current before and
    /// after, and the step itself opens its old trillion snapshot under the
    /// owner's own browser-session check.
    pub fn own_records_step(
        &mut self,
        session: &str,
        cancel: Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<crate::local_account::own_records::Step, crate::records::Error> {
        self.selection.assert_current().map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
        let step = self.owner.own_records_step(session, cancel)?;
        self.selection.assert_current().map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
        Ok(step)
    }

    /// One operation on the account's own record store (`OwnRecords::store_mut`), inside the taken-over opened account: the
    /// wake ticker's record source (`own_records_start::WakeStore`) takes the owner for each read or write alone.
    pub(crate) fn with_own_store<T>(
        &mut self,
        session: &str,
        cancel: Arc<std::sync::atomic::AtomicBool>,
        operation: impl FnOnce(&mut crate::local_account::own_records::OwnStore, &str) -> Result<T, crate::records::Error>,
    ) -> Result<T, crate::records::Error> {
        self.selection.assert_current().map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
        let answer = self.owner.with_own_records(session, cancel, |records| {
            let (store, account) = records.store_mut();
            let account = account.to_owned();
            operation(store, &account)
        })?;
        self.selection.assert_current().map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
        Ok(answer)
    }

    /// The account's own records file (`LocalAccount::own_writer`), inside the taken-over opened account: wake's idle upkeep
    /// keeps the log beside it (`sqlite::LogKeeper`).
    pub(crate) fn own_records_file(&mut self) -> Result<PathBuf, crate::records::Error> {
        self.selection.assert_current().map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
        Ok(self.owner.own_writer()?.path().to_owned())
    }

    /// The account and state folder a run of this account's tools uses (`tool_runs::tools::Place`).
    pub(crate) fn tool_place(&self) -> (String, PathBuf) {
        (self.account().owner_id, self.state_root().to_owned())
    }

    /// The old Worker vault the account's RecordBook keeps (`LocalAccount::old_secrets`), inside the taken-over
    /// opened account, with the account it belongs to and the state folder its own vault lives in.
    pub fn old_secrets(
        &mut self,
        session: &str,
        cancel: Arc<std::sync::atomic::AtomicBool>,
        from: &crate::secrets::CarriedFrom,
    ) -> Result<(crate::local_account::OldSecrets, String, PathBuf), crate::records::Error> {
        self.selection.assert_current().map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
        let old = self.owner.old_secrets(session, cancel, from)?;
        self.selection.assert_current().map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
        Ok((old, self.account().owner_id, self.state_root().to_owned()))
    }

    /// One bounded current type-id page through the existing account reader.
    /// The taken-over opened account checks both the caller's access and the returned page;
    /// LocalAccount retains browser rights, source custody and cancellation.
    pub fn current_record_ids(
        &mut self,
        session: &str,
        record_type: &str,
        prefix: &str,
        before: Option<&str>,
        limit: usize,
        cancel: Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<crate::storage::record_store::native::TypeIds, crate::records::Error> {
        self.selection.assert_current().map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
        let page = self.owner.current_record_ids(session, record_type, prefix, before, limit, cancel)?;
        self.selection.assert_current().map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
        Ok(page)
    }

    /// Read the existing aggregate SQL observer without executing measurement
    /// SQL. This internal/library diagnostic carries no record values or rights.
    pub fn sql_work(&self) -> Result<crate::sqlite_work::Observation, crate::sqlite_work::Error> {
        self.owner.sql_work()
    }
    /// Enable only on an exclusively owned synthetic fixture; never on a live account.
    /// # Safety
    /// All attached handles must be idle and their SQL literals synthetic.
    #[cfg(feature = "sql-statement-attribution")]
    pub unsafe fn enable_fixture_sql_attribution(&self, capacity: usize) -> Result<crate::sqlite_work::WorkMeter, crate::sqlite_work::Error> {
        unsafe { self.owner.enable_account_fixture_sql_attribution(capacity) }
    }

    /// Count one complete caller operation across this account's request contexts.
    pub fn begin_sql_observation(&self) -> Result<crate::sqlite_work::ObservationWindow, crate::sqlite_work::Error> {
        self.owner.begin_sql_observation()
    }


    pub fn new(owner: LocalAccount, selection: Selection) -> Result<Self, Error> {
        Self::chosen(owner, Chosen::hosting(selection))
    }
    /// The owner of an account either entry chose (`Chosen`): the hosting app's opened account or a computer's config.
    pub fn chosen(owner: LocalAccount, selection: Chosen) -> Result<Self, Error> {
        selection.assert_current()?;
        if owner.state_identity() != selection.selected().receipt.blake3 {
            return Err(crate::cause!(Error::Changed));
        }
        selection.assert_current()?;
        Ok(Self { owner, selection: Arc::new(selection), sign_in: None, store_budget: None })
    }
    /// The owner the workspace admits browser sessions on (`WorkspaceSessions::with_admission`): this same account
    /// and opened account, read through its own read-only observer under this account's state lock
    /// (`LocalAccount::admission_owner`), so the browser-session check never waits on this owner's writer.
    pub fn admission_owner(&self) -> Result<Self, Error> {
        self.selection.assert_current()?;
        let owner = self.owner.admission_owner().map_err(|error| Error::Unavailable(error.cause()))?;
        Ok(Self { owner, selection: self.selection.clone(), sign_in: self.sign_in.clone(), store_budget: None })
    }
    /// A request-owned context for a command on this same selected account. The selection, sign-in and existing
    /// state lock stay the same; mutable command state and physical writer handles belong to this request. Creating
    /// it under a short admission hold never retains the supplying account's mutex during command execution.
    pub(crate) fn command_owner(&self) -> Result<Self, Error> {
        self.selection.assert_current()?;
        let owner = self.owner.command_owner().map_err(|error| Error::Unavailable(error.cause()))?;
        self.selection.assert_current()?;
        Ok(Self { owner, selection: self.selection.clone(), sign_in: self.sign_in.clone(), store_budget: None })
    }
    /// Load original shipped-program DATA only from this retained opened account.
    /// A caller-measured hash cannot select replacement viewer audiences; the
    /// app files list must already name and pin this source. Missing optional DATA
    /// disables the viewer feature without preventing unrelated account reads.
    pub fn viewer_program_data(&mut self) -> AccountResult<crate::workspace_startup::ProgramData> {
        self.assert_source_current()?;
        let selected = self
            .selection
            .frontend()
            .map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceUnavailable, error))?
            .file(CLIENT_PROGRAM)
            .ok_or(crate::cause!(crate::account::AccountError::SourceUnavailable))?;
        let bytes = selected
            .read()
            .map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceChanged, error))?;
        let data =
            crate::workspace_startup::ProgramData::from_source(&bytes, &selected.pin.blake3)?;
        self.assert_source_current()?;
        Ok(data)
    }
}
impl NativeAccountOwner for SelectedAccount {
    fn resource_connection_key(&mut self,session:&str,key:&crate::account::SecretNativeKey)->AccountResult<Option<crate::account::SecretResourceKey>> {
        self.assert_source_current()?;
        let selection=&self.selection;
        let result=self.owner.enroll_native_resource_key(session,key,&||selection.assert_current().map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceChanged, error)));
        self.assert_source_current()?;result
    }

    fn account(&self) -> AccountIdentity {
        self.owner.account()
    }
    fn now_ms(&mut self) -> AccountResult<u64> {
        self.owner.now_ms()
    }
    fn assert_source_current(&mut self) -> AccountResult<()> {
        self.selection
            .assert_current()
            .map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceChanged, error))?;
        self.owner.assert_source_current()
    }
}

/// Viewer and native-key/browser reads share this exact selected account;
/// opened-account and restore-record witnesses remain current through the narrow result.
impl crate::workspace_startup::ViewerSource for SelectedAccount {
    fn current_viewer(
        &mut self,
        session_id: &str,
    ) -> AccountResult<crate::workspace_startup::ViewerState> {
        self.selection
            .assert_current()
            .map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceChanged, error))?;
        let state = self.owner.startup_viewer_state(session_id)?;
        self.selection
            .assert_current()
            .map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceChanged, error))?;
        Ok(state)
    }
    fn service_setting(&mut self, name: &str) -> AccountResult<Option<String>> {
        self.selection
            .assert_current()
            .map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceChanged, error))?;
        self.owner.startup_service_setting(name)
    }
    fn assert_current(&mut self) -> AccountResult<()> {
        self.assert_source_current()
    }
}

pub mod native_commands;


#[cfg(test)]
mod release_launch_tests {
    //! An engine the Mac app runs from outside the app reads the app's Contents its launch names.
    use super::*;

    #[cfg(owner_files = "posix")]
    #[test]
    fn an_engine_outside_the_app_takes_the_contents_its_launch_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let contents = root.join("Trillion.app/Contents");
        std::fs::create_dir_all(contents.join("MacOS")).unwrap();
        std::fs::create_dir_all(contents.join("Resources")).unwrap();
        std::fs::write(contents.join("Resources/computer-reader.json"), b"{}").unwrap();
        let some = |path: &Path| Some(std::ffi::OsString::from(path));
        assert_eq!(app_contents(some(&contents)).ok(), Some(contents.clone()));
        assert!(app_contents(some(&root.join("Trillion.app"))).is_err(), "not a Contents folder");
        assert!(app_contents(None).is_err());
        let empty = root.join("Other.app/Contents");
        std::fs::create_dir_all(empty.join("MacOS")).unwrap();
        assert!(app_contents(some(&empty)).is_err(), "an app with no files list");
    }
}

#[cfg(test)]
mod starting_rows_tests {
    //! The hosting app's open writes each starting row its account lacks, from its product settings' `new_accounts`
    //! (`Selection::write_starting_rows`), and keeps every row the account already has (lead-66, Nov 5 2026).
    use super::*;
    use crate::account::rows::{self, store::Store, StartingRows};
    use serde_json::json;

    mod carried_selection {
        include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/support/carried_selection.rs"));
    }

    /// An account made as a computer makes one, and the Selection the hosting app opens it by (its app files list pins
    /// the account's own restore record).
    struct Opened {
        _dir: tempfile::TempDir,
        state: PathBuf,
        user: String,
        descriptor: PathBuf,
        carried: PathBuf,
    }

    fn made() -> Opened {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let state = root.join("state");
        let key = crate::secrets::secrets_key::ComputerKey::from_bytes(vec![7u8; 32]).unwrap();
        let created = crate::account::create::create_account(&state, &key, &StartingRows::for_tests()).unwrap();
        let receipt = std::fs::read(state.join(RECEIPT_FILE)).unwrap();
        let pinned = |name: &str, value: serde_json::Value| {
            let path = root.join(name);
            let bytes = serde_json::to_vec(&value).unwrap();
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &bytes).unwrap();
            json!({"path":path,"pin":{"bytes":bytes.len(),"blake3":blake3::hash(&bytes).to_hex().as_str()}})
        };
        let inputs = pinned("data/inputs.json", json!({"element_id":"first","item_reads":{"element_id":"items"}}));
        let first_answers = pinned("data/first_answers.json", json!({"kept":{"store_prefix":"trillion-kept-"}}));
        let whole = json!({"version":"trillion.local-runtime-adoption/v1","state":state,
            "receipt_identity":blake3::hash(&receipt).to_hex().as_str(),"port":28788,"native":{
            "version":"trillion.native-selection/v1","receipt_bytes":receipt.len(),
            "app_kv":{"sqlite":"storage/kv/current.sqlite","namespace":"trillion-local-app"},
            "prior_processes":[],"root_source":null,"frontend":{"root":root,
            "manifest_identity":"b".repeat(64),"tree_identity":"c".repeat(64),
            "module_manifest_identity":"d".repeat(64),
            "files":{"data/inputs.json":inputs,"data/first_answers.json":first_answers}}}});
        let descriptor = root.join("adoption.json");
        let carried = carried_selection::write_selection(&descriptor, &whole);
        Opened { _dir: dir, state, user: created.user_id, descriptor, carried }
    }

    impl Opened {
        /// Open the account as `native-serve` does (`Selection::write_starting_rows`, once at the open).
        fn open(&self) -> Selection {
            let selection = Selection::from_descriptor(&self.descriptor, &self.carried, &self.state,
                "127.0.0.1:28788".parse().unwrap()).expect("the hosting app selects its account");
            selection.write_starting_rows().expect("the account opens");
            selection
        }

        /// The account's copies row, as the copy rule reads it.
        fn copies(&self) -> Option<crate::account::computers::copy_rule::ListRow<crate::account::computers::copy_rule::CopySettings>> {
            let storage = rows::open(&self.state).unwrap();
            crate::account::computers::copy_rule::copies(&Store::new(&*storage), &self.user).unwrap()
        }
    }

    #[test]
    fn product_starting_rows_are_the_named_section_or_the_shipped_rows() {
        let section = crate::account_files::identity::section(STARTING_SECTION).unwrap();
        assert_eq!(section, None, "the product settings name no starting rows: the shipped rows are their one owner");
        assert_eq!(product_starting_rows(None).unwrap(), *rows::shipped(), "no section: the shipped rows are written");
        assert_eq!(product_starting_rows(Some(&json!({"copies": 5}))), Err(crate::cause!(Error::Invalid)), "not starting rows");
    }

    #[test]
    fn a_native_open_keeps_the_accounts_own_rows_and_writes_nothing_twice() {
        let account = made();
        let before = account.copies().expect("the account was made with its copies row");
        let selection = account.open();
        assert_eq!(account.copies().unwrap().revision, before.revision, "the account's own copies row is kept");
        selection.write_starting_rows().unwrap();
        account.open();
        assert_eq!(account.copies().unwrap().revision, before.revision, "a second open writes nothing more");
    }
}
