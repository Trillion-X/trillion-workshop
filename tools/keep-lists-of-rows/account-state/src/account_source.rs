// Purpose: supply pinned original account data and the existing protected
// native-key purpose root to the native account policy owner.
// Invariants: original data is read only; account IDs and independent pins are
// required; no credential home, principal, nonce, gate or auth database is made.
// Security: only exact selected KV bodies are read; roots stay in zeroizing
// memory; errors and Debug never contain private paths, IDs or credential data.
// Scope: physical generation continuity is not live rights. A mutable adopted
// authority and its resource-route generation remain the host owner's job.
//! Physical suppliers for the pure `account` policy. Neither CatalogSource nor
//! SelectedKvSource implements NativeAccountOwner: a retained snapshot is not
//! the current local account authority. In particular, a resumed application's
//! mutable sessions must come from its actual mounted owner, not this bundle.

use crate::account::{
    AccountError, AccountIdentity, AccountResult, NativeKeyDerivationRoot, NativeKeyDeriver,
    SecretNativeKey, NATIVE_ROOT_NAME,
};
use crate::import::{self, FilePin, NativeCatalog, ReadLimits, ReadonlyOriginal};
use content_crypto::advanced::blake3;
use serde_json::Value;
use std::{
    collections::BTreeSet,
    fmt,
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
};
use zeroize::Zeroizing;
use crate::tool_runs::os::{Open, OwnerFiles, This};

pub(crate) mod binding_identity;

const MAX_ROOT_BYTES: usize = 128;
const MAX_KV_INDEX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_KV_ENTRIES: u64 = 100_000;
const MAX_KV_VALUE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SAFE_MS: u64 = 9_007_199_254_740_991;

fn hex(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn bounded_id(text: &str) -> bool {
    !text.is_empty() && text.len() <= 512 && !text.chars().any(char::is_control)
}
fn credential_name(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 255
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b":_-".contains(&b))
}

#[derive(Clone, PartialEq, Eq)]
struct Generation {
    device: u64,
    inode: u64,
    bytes: u64,
    mode: u32,
    uid: u32,
    links: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}
impl Generation {
    /// The file's generation, as the computer's owner-only files say it (src/tool_runs/os.rs `OwnerFiles`); a
    /// computer without them cannot say, and the source is unavailable there.
    fn of(meta: &Metadata) -> AccountResult<Self> {
        let facts = This::facts(meta).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        Ok(Self {
            device: facts.device,
            inode: facts.inode,
            bytes: meta.len(),
            mode: facts.mode,
            uid: facts.owner,
            links: facts.links,
            modified: facts.modified,
            changed: facts.changed,
        })
    }
    fn matches(&self, meta: &Metadata) -> bool {
        Self::of(meta).is_ok_and(|now| *self == now)
    }
}

// Descriptor first: O_NONBLOCK prevents a malicious FIFO from blocking before
// fstat can reject it. O_NOFOLLOW rejects a final-component symbolic link.
fn open_regular(path: &Path) -> AccountResult<(File, Generation)> {
    let file = This::open(OpenOptions::new().read(true), path, Open::NO_FOLLOW).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    let opened = file.metadata().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    if !opened.is_file() {
        return Err(crate::cause!(AccountError::SourceUnavailable));
    }
    let generation = Generation::of(&opened)?;
    check_named(path, &generation)?;
    Ok((file, generation))
}
fn check_named(path: &Path, generation: &Generation) -> AccountResult<()> {
    let named = fs::symlink_metadata(path).map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?;
    if named.file_type().is_symlink() || !generation.matches(&named) {
        return Err(crate::cause!(AccountError::SourceChanged));
    }
    Ok(())
}
fn contained(base: &Path, relative: &str) -> AccountResult<PathBuf> {
    let path = Path::new(relative);
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(crate::cause!(AccountError::SourceUnavailable));
    }
    let mut joined = base.to_path_buf();
    for component in path.components() {
        joined.push(component);
        let meta = fs::symlink_metadata(&joined).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if meta.file_type().is_symlink() {
            return Err(crate::cause!(AccountError::SourceUnavailable));
        }
    }
    Ok(joined)
}
fn read_pinned(path: &Path, pin: &FilePin, cap: u64) -> AccountResult<Zeroizing<Vec<u8>>> {
    if !hex(&pin.blake3) || pin.bytes > cap {
        return Err(crate::cause!(AccountError::SourceUnavailable));
    }
    let (mut file, generation) = open_regular(path)?;
    if generation.bytes != pin.bytes {
        return Err(crate::cause!(AccountError::SourceChanged));
    }
    let mut bytes = Zeroizing::new(Vec::with_capacity(pin.bytes as usize));
    (&mut file)
        .take(pin.bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    if bytes.len() as u64 != pin.bytes
        || blake3::hash(&bytes).to_hex().as_str() != pin.blake3
        || !generation.matches(&file.metadata().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?)
    {
        return Err(crate::cause!(AccountError::SourceChanged));
    }
    check_named(path, &generation)?;
    Ok(bytes)
}
fn file_pin(value: &Value) -> AccountResult<FilePin> {
    let pin = FilePin {
        bytes: value["bytes"]
            .as_u64()
            .ok_or(crate::cause!(AccountError::SourceUnavailable))?,
        blake3: value["fileIdentity"]
            .as_str()
            .filter(|v| hex(v))
            .ok_or(crate::cause!(AccountError::SourceUnavailable))?
            .to_owned(),
    };
    Ok(pin)
}

/// Exact immutable original-cohort identity. Reopening verifies its retained
/// restore-record/index pins and rejects a running owner process; it does not grant rights.
#[derive(Clone)]
pub struct CatalogSource {
    state: PathBuf,
    receipt_pin: FilePin,
    account: AccountIdentity,
    limits: ReadLimits,
    receipt_generation: Generation,
    index_path: PathBuf,
    index_generation: Generation,
    root_reference: Option<String>,
}
impl fmt::Debug for CatalogSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CatalogSource([redacted immutable provenance])")
    }
}
impl CatalogSource {
    pub fn open(
        state: impl AsRef<Path>,
        receipt_pin: FilePin,
        account: AccountIdentity,
        limits: ReadLimits,
    ) -> AccountResult<Self> {
        let state = fs::canonicalize(state).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let (_, receipt_generation) = open_regular(&state.join("restore-receipt.json"))?;
        let catalog = NativeCatalog::open(
            &state,
            receipt_pin.clone(),
            import_account(&account),
            limits.clone(),
        )
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        // Reading existing policy or checking a held key does not require a
        // derivation root. Absence is carried to the capability constructor;
        // a present malformed reference still refuses.
        let reference = match catalog.receipt()["rootCredentials"].get(NATIVE_ROOT_NAME) {
            None => None,
            Some(value) => Some(
                value
                    .as_str()
                    .filter(|v| credential_name(v))
                    .ok_or(crate::cause!(AccountError::RootUnavailable))?
                    .to_owned(),
            ),
        };
        let index_path = contained(
            &state,
            catalog.receipt()["objects"]["path"]
                .as_str()
                .ok_or(crate::cause!(AccountError::SourceUnavailable))?,
        )?;
        let (_, index_generation) = open_regular(&index_path)?;
        check_named(&state.join("restore-receipt.json"), &receipt_generation)?;
        let source = Self {
            state,
            receipt_pin,
            account,
            limits,
            receipt_generation,
            index_path,
            index_generation,
            root_reference: reference,
        };
        source.catalog()?;
        Ok(source)
    }
    pub fn account(&self) -> AccountIdentity {
        self.account.clone()
    }
    fn catalog(&self) -> AccountResult<NativeCatalog> {
        check_named(
            &self.state.join("restore-receipt.json"),
            &self.receipt_generation,
        )?;
        check_named(&self.index_path, &self.index_generation)?;
        let catalog = NativeCatalog::open(
            &self.state,
            self.receipt_pin.clone(),
            import_account(&self.account),
            self.limits.clone(),
        )
        .map_err(|error| crate::carry_cause!(AccountError::SourceChanged, error))?;
        if catalog.receipt()["rootCredentials"][NATIVE_ROOT_NAME].as_str()
            != self.root_reference.as_deref()
        {
            return Err(crate::cause!(AccountError::SourceChanged));
        }
        check_named(
            &self.state.join("restore-receipt.json"),
            &self.receipt_generation,
        )?;
        check_named(&self.index_path, &self.index_generation)?;
        Ok(catalog)
    }
    /// Physical retained generation only. Never use this as a current-rights
    /// decision or to declare a historical APP_KV session current.
    pub fn assert_pinned_source(&self) -> AccountResult<()> {
        self.catalog().map(|_| ())
    }
    pub fn open_own_policy(
        &self,
        independent_sqlite_pin: FilePin,
    ) -> AccountResult<ReadonlyOriginal> {
        let catalog = self.catalog()?;
        // The one owner rule (`local_account::is_own_policy`); a restored catalog's object also says its class.
        let mut own = catalog.objects().filter(|object| {
            object.binding == crate::local_account::POLICY_BINDING
                && crate::local_account::is_own_policy(&object.descriptor, &self.account.owner_id)
                && object.descriptor["className"] == "AccountControl"
        });
        let selected = own.next().ok_or(crate::cause!(AccountError::SourceUnavailable))?;
        if own.next().is_some() {
            return Err(crate::cause!(AccountError::SourceUnavailable));
        }
        let object = catalog
            .open_object(
                &selected.binding,
                &selected.original_id,
                independent_sqlite_pin,
            )
            .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        self.assert_pinned_source()?;
        Ok(object)
    }
}
fn import_account(account: &AccountIdentity) -> import::AccountIdentity {
    import::AccountIdentity {
        user_id: account.user_id.clone(),
        owner_id: account.owner_id.clone(),
    }
}

// Use the operating system's current uid home; an environment variable cannot
// redirect production root custody. Fixture homes are private test-only inputs.
fn credential_home() -> AccountResult<PathBuf> {
    let home = This::home_folder().map_err(|error| crate::carry_cause!(AccountError::RootUnavailable, error))?;
    let home = home.to_str().ok_or(crate::cause!(AccountError::RootUnavailable))?;
    let path = Path::new(home);
    if !path.is_absolute() {
        return Err(crate::cause!(AccountError::RootUnavailable));
    }
    let home = fs::canonicalize(path).map_err(|error| crate::carry_cause!(AccountError::RootUnavailable, error))?;
    contained(&home, &root_credentials_folder()?).map_err(|error| crate::carry_cause!(AccountError::RootUnavailable, error))
}

/// The folder inside this uid's home that holds the root credential files: the launcher's product settings section
/// `root_credentials_folder` (src/account_files/identity.json), a relative path (`contained` refuses any other). A
/// launcher that declares none has no root credentials here.
fn root_credentials_folder() -> AccountResult<String> {
    match crate::account_files::identity::section("root_credentials_folder") {
        Ok(Some(Value::String(folder))) if !folder.is_empty() => Ok(folder.clone()),
        _ => Err(crate::cause!(AccountError::RootUnavailable)),
    }
}
fn root_metadata(path: &Path, file: &File, generation: &Generation) -> AccountResult<()> {
    bounded_metadata(path, file, generation, MAX_ROOT_BYTES)
}
/// A browser session token: the 64-hex id account creation writes (src/account/create.rs `session_file`), or the
/// signed pass the account's sign-in tool gave the browser (a JWT, src/account/signed_in.rs), at most the signed-in
/// settings' `max_token_bytes`, in the JWT's own characters (base64url parts joined by dots).
fn session_token(text: &str) -> bool {
    hex(text)
        || (text.len() <= crate::account::signed_in::settings().max_token_bytes
            && text.split('.').count() == 3
            && text.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')))
}
fn session_bytes() -> usize {
    crate::account::signed_in::settings().max_token_bytes
}
fn bounded_metadata(path: &Path, file: &File, generation: &Generation, max_bytes: usize) -> AccountResult<()> {
    let meta = file.metadata().map_err(|error| crate::carry_cause!(AccountError::RootUnavailable, error))?;
    let facts = This::facts(&meta).map_err(|error| crate::carry_cause!(AccountError::RootUnavailable, error))?;
    if !meta.is_file()
        || facts.owner != This::this_owner().map_err(|error| crate::carry_cause!(AccountError::RootUnavailable, error))?
        || facts.mode & 0o7777 != 0o600
        || !(64..=max_bytes as u64).contains(&meta.len())
        || !generation.matches(&meta)
    {
        return Err(crate::cause!(AccountError::RootUnavailable));
    }
    check_named(path, generation).map_err(|error| crate::carry_cause!(AccountError::RootUnavailable, error))
}
fn read_root(
    path: &Path,
    file: &File,
    generation: &Generation,
) -> AccountResult<Zeroizing<Vec<u8>>> {
    read_bounded(path, file, generation, MAX_ROOT_BYTES)
}
fn read_bounded(path: &Path, file: &File, generation: &Generation, max_bytes: usize) -> AccountResult<Zeroizing<Vec<u8>>> {
    bounded_metadata(path, file, generation, max_bytes)?;
    let mut bytes = Zeroizing::new(vec![0u8; max_bytes + 1]);
    let mut at = 0;
    while at < bytes.len() {
        let count = This::read_at(file, &mut bytes[at..], at as u64)
            .map_err(|error| crate::carry_cause!(AccountError::RootUnavailable, error))?;
        if count == 0 {
            break;
        }
        at += count;
    }
    bytes.truncate(at);
    if at as u64 != generation.bytes {
        return Err(crate::cause!(AccountError::RootUnavailable));
    }
    bounded_metadata(path, file, generation, max_bytes)?;
    Ok(bytes)
}
/// The bytes of the credential file `name` in the credentials folder of this uid's home (the credential-file owner's
/// home, the same one the protected native root is read from): a regular file of this uid, mode 600, 64 to 128 bytes,
/// read into zeroizing memory. For a root another owner derives its own key from (the old Worker's secrets root,
/// which the restore receipt's `rootCredentials` names). Absent, unreadable or malformed: `RootUnavailable`.
pub(crate) fn read_credential(name: &str) -> AccountResult<Zeroizing<Vec<u8>>> {
    if !credential_name(name) {
        return Err(crate::cause!(AccountError::RootUnavailable));
    }
    let path = contained(&credential_home()?, name).map_err(|error| crate::carry_cause!(AccountError::RootUnavailable, error))?;
    let (file, generation) = open_regular(&path).map_err(|error| crate::carry_cause!(AccountError::RootUnavailable, error))?;
    read_root(&path, &file, &generation)
}
fn decode_root(bytes: &[u8]) -> AccountResult<Zeroizing<[u8; 32]>> {
    let text = std::str::from_utf8(bytes).map_err(|error| crate::carry_cause!(AccountError::RootUnavailable, error))?.trim();
    if text.len() != 64 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(crate::cause!(AccountError::RootUnavailable));
    }
    fn nibble(byte: u8) -> u8 {
        if byte.is_ascii_digit() {
            byte - b'0'
        } else {
            byte.to_ascii_lowercase() - b'a' + 10
        }
    }
    let mut root = Zeroizing::new([0u8; 32]);
    for (out, pair) in root.iter_mut().zip(text.as_bytes().chunks_exact(2)) {
        *out = nibble(pair[0]) * 16 + nibble(pair[1]);
    }
    Ok(root)
}

/// Protected existing root capability; no raw getter, Serialize or copied home.
/// Every derivation checks the original descriptor, named file, exact mode/uid,
/// bounded bytes and pinned catalog around the pure cryptographic operation.
pub struct ProtectedNativeRoot {
    source: CatalogSource,
    path: PathBuf,
    file: File,
    generation: Generation,
    byte_identity: Zeroizing<[u8; 32]>,
    root: NativeKeyDerivationRoot,
}
impl fmt::Debug for ProtectedNativeRoot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ProtectedNativeRoot([redacted])")
    }
}
impl ProtectedNativeRoot {
    pub fn open_existing(source: CatalogSource) -> AccountResult<Self> {
        let home = credential_home()?;
        Self::open_in_home(source, &home)
    }
    fn open_in_home(source: CatalogSource, home: &Path) -> AccountResult<Self> {
        source.assert_pinned_source()?;
        let reference = source
            .root_reference
            .as_deref()
            .ok_or(crate::cause!(AccountError::RootUnavailable))?;
        let path = contained(home, reference).map_err(|error| crate::carry_cause!(AccountError::RootUnavailable, error))?;
        let (file, generation) = open_regular(&path).map_err(|error| crate::carry_cause!(AccountError::RootUnavailable, error))?;
        let bytes = read_root(&path, &file, &generation)?;
        let byte_identity = Zeroizing::new(*blake3::hash(&bytes).as_bytes());
        let root =
            NativeKeyDerivationRoot::from_original_root(source.account(), decode_root(&bytes)?)?;
        let capability = Self {
            source,
            path,
            file,
            generation,
            byte_identity,
            root,
        };
        capability.assert_root_current()?;
        Ok(capability)
    }
    fn assert_root_current(&self) -> AccountResult<()> {
        self.source.assert_pinned_source()?;
        let bytes = read_root(&self.path, &self.file, &self.generation)?;
        let identity = Zeroizing::new(*blake3::hash(&bytes).as_bytes());
        // Hash equality is constant-time in the declared BLAKE3 supplier.
        let expected = blake3::Hash::from(*self.byte_identity);
        let observed = blake3::Hash::from(*identity);
        if expected != observed {
            return Err(crate::cause!(AccountError::RootUnavailable));
        }
        self.source.assert_pinned_source()
    }
}
impl NativeKeyDeriver for ProtectedNativeRoot {
    fn derive_existing(
        &self,
        account: &AccountIdentity,
        original_nonce: &str,
    ) -> AccountResult<SecretNativeKey> {
        self.assert_root_current()?;
        let key = self.root.derive_existing(account, original_nonce)?;
        self.assert_root_current()?;
        Ok(key)
    }
}

/// Existing app-owned browser token supplier. Only its original BLAKE3 session
/// identity is returned in memory; the bearer token has no public getter and
/// is never minted, refreshed, written or copied into another credential home.
/// This proves token-file continuity, not that its session is still authorized.
pub struct ProtectedBrowserSession {
    path: PathBuf,
    file: File,
    generation: Generation,
    identity: Zeroizing<String>,
}
impl fmt::Debug for ProtectedBrowserSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ProtectedBrowserSession([redacted])")
    }
}
impl ProtectedBrowserSession {
    pub fn open_existing(selected_state: impl AsRef<Path>) -> AccountResult<Self> {
        let state = fs::canonicalize(selected_state).map_err(|error| crate::carry_cause!(AccountError::BrowserInactive, error))?;
        let path =
            contained(&state, "browser-session.key").map_err(|error| crate::carry_cause!(AccountError::BrowserInactive, error))?;
        let (file, generation) = open_regular(&path).map_err(|error| crate::carry_cause!(AccountError::BrowserInactive, error))?;
        let bytes = read_bounded(&path, &file, &generation, session_bytes())
            .map_err(|error| crate::carry_cause!(AccountError::BrowserInactive, error))?;
        let text = std::str::from_utf8(&bytes)
            .map_err(|error| crate::carry_cause!(AccountError::BrowserInactive, error))?
            .trim();
        if !session_token(text) {
            return Err(crate::cause!(AccountError::BrowserInactive));
        }
        let identity = Zeroizing::new(blake3::hash(text.as_bytes()).to_hex().to_string());
        let session = Self {
            path,
            file,
            generation,
            identity,
        };
        session.assert_token_current()?;
        Ok(session)
    }
    /// The browser session token itself, for the one place trillion-local hands it to the browser the hosting app shows:
    /// the owner page entry (native_entry parent_kept `owner_page`), which sets it as the session cookie of the
    /// response to the app's own bearer. Read the same way as `open_existing`; never logged, kept only by the caller.
    /// Ported from side/engine-keeps-nothing 542df2ce; old trillion macos/App/LocalWorkspaceBrowserSession.swift:155-170
    /// read this same file in the app.
    pub(crate) fn token(selected_state: impl AsRef<Path>) -> AccountResult<Zeroizing<String>> {
        let state = fs::canonicalize(selected_state).map_err(|error| crate::carry_cause!(AccountError::BrowserInactive, error))?;
        let path = contained(&state, "browser-session.key").map_err(|error| crate::carry_cause!(AccountError::BrowserInactive, error))?;
        let (file, generation) = open_regular(&path).map_err(|error| crate::carry_cause!(AccountError::BrowserInactive, error))?;
        let bytes = read_bounded(&path, &file, &generation, session_bytes()).map_err(|error| crate::carry_cause!(AccountError::BrowserInactive, error))?;
        let text = std::str::from_utf8(&bytes).map_err(|error| crate::carry_cause!(AccountError::BrowserInactive, error))?.trim();
        if !session_token(text) {
            return Err(crate::cause!(AccountError::BrowserInactive));
        }
        Ok(Zeroizing::new(text.to_owned()))
    }
    /// The token file is still the generation its bytes were read at (`open_existing` read them between two checks of
    /// that generation): the same generation (device, inode, size, mode, owner, links, modified and changed times) on
    /// the held file and by name is the same unchanged bytes, so they are not read again. An edit changes the changed
    /// time even when it puts the modified time back.
    pub fn assert_token_current(&self) -> AccountResult<()> {
        bounded_metadata(&self.path, &self.file, &self.generation, session_bytes()).map_err(|error| crate::carry_cause!(AccountError::BrowserInactive, error))
    }
    /// Digest only, without the `session:` prefix expected by the pure account
    /// owner interface. The returned private identity must never be logged.
    pub fn identity(&self) -> AccountResult<Zeroizing<String>> {
        self.assert_token_current()?;
        Ok(Zeroizing::new(self.identity.to_string()))
    }
}

/// Pinned raw-JSON APP_KV source. This reads exact named bodies only and honors
/// original expiration. It does not decode hidden Workerd transfer graphs and
/// does not supply a running app's resumed or mutated session state.
pub struct SelectedKvSource {
    source: CatalogSource,
    manifest_path: PathBuf,
    manifest_pin: FilePin,
    manifest_generation: Generation,
    source_root: PathBuf,
    index_path: PathBuf,
    index_pin: FilePin,
    index_generation: Generation,
    count: u64,
}
impl fmt::Debug for SelectedKvSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SelectedKvSource([redacted immutable provenance])")
    }
}
impl SelectedKvSource {
    pub fn open(
        source: CatalogSource,
        manifest_path: impl AsRef<Path>,
        manifest_pin: FilePin,
    ) -> AccountResult<Self> {
        let catalog = source.catalog()?;
        if catalog.receipt()["source"]["bundleManifestIdentity"] != manifest_pin.blake3 {
            return Err(crate::cause!(AccountError::SourceUnavailable));
        }
        let manifest_path = manifest_path.as_ref().to_path_buf();
        let (_, manifest_generation) = open_regular(&manifest_path)?;
        let bytes = read_pinned(&manifest_path, &manifest_pin, source.limits.metadata_bytes)?;
        let manifest: Value = serde_json::from_slice(&bytes).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if manifest["version"] != "trillion.local-transfer-bundle/v1"
            || manifest["account"]["userId"] != source.account.user_id
            || manifest["account"]["ownerId"] != source.account.owner_id
            || manifest["rootCredentials"][NATIVE_ROOT_NAME].as_str()
                != source.root_reference.as_deref()
        {
            return Err(crate::cause!(AccountError::SourceUnavailable));
        }
        let source_root = fs::canonicalize(
            manifest["sourceRoot"]
                .as_str()
                .ok_or(crate::cause!(AccountError::SourceUnavailable))?,
        )
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        if !source_root.is_dir() {
            return Err(crate::cause!(AccountError::SourceUnavailable));
        }
        let base = fs::canonicalize(
            manifest_path
                .parent()
                .ok_or(crate::cause!(AccountError::SourceUnavailable))?,
        )
        .map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        let index_path = contained(
            &base,
            manifest["kv"]["path"]
                .as_str()
                .ok_or(crate::cause!(AccountError::SourceUnavailable))?,
        )?;
        let index_pin = file_pin(&manifest["kv"])?;
        let count = manifest["kv"]["count"]
            .as_u64()
            .filter(|count| *count <= MAX_KV_ENTRIES)
            .ok_or(crate::cause!(AccountError::SourceUnavailable))?;
        let (_, index_generation) = open_regular(&index_path)?;
        let reader = Self {
            source,
            manifest_path,
            manifest_pin,
            manifest_generation,
            source_root,
            index_path,
            index_pin,
            index_generation,
            count,
        };
        reader.index()?;
        Ok(reader)
    }
    fn assert_pinned_source(&self) -> AccountResult<()> {
        self.source.assert_pinned_source()?;
        check_named(&self.manifest_path, &self.manifest_generation)?;
        check_named(&self.index_path, &self.index_generation)?;
        read_pinned(
            &self.manifest_path,
            &self.manifest_pin,
            self.source.limits.metadata_bytes,
        )?;
        Ok(())
    }
    fn index(&self) -> AccountResult<Zeroizing<Vec<u8>>> {
        self.assert_pinned_source()?;
        let bytes = read_pinned(&self.index_path, &self.index_pin, MAX_KV_INDEX_BYTES)?;
        let mut count = 0u64;
        let mut keys = BTreeSet::new();
        for line in bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
            count += 1;
            if count > self.count || line.len() as u64 > self.source.limits.metadata_bytes {
                return Err(crate::cause!(AccountError::SourceUnavailable));
            }
            let entry: Value = serde_json::from_slice(line).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            let binding = entry["binding"]
                .as_str()
                .filter(|b| !b.is_empty() && b.len() <= 128)
                .ok_or(crate::cause!(AccountError::SourceUnavailable))?;
            let key = entry["key"]
                .as_str()
                .filter(|k| !k.is_empty() && k.len() <= 512)
                .ok_or(crate::cause!(AccountError::SourceUnavailable))?;
            if !keys.insert((binding.to_owned(), key.to_owned())) {
                return Err(crate::cause!(AccountError::SourceUnavailable));
            }
        }
        if count != self.count {
            return Err(crate::cause!(AccountError::SourceUnavailable));
        }
        self.assert_pinned_source()?;
        Ok(bytes)
    }
    fn exact(&self, key: &str, now_ms: u64) -> AccountResult<Option<Value>> {
        if now_ms == 0 || now_ms > MAX_SAFE_MS {
            return Err(crate::cause!(AccountError::InvalidInput));
        }
        let index = self.index()?;
        let mut selected = None;
        for line in index.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
            let entry: Value = serde_json::from_slice(line).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
            if entry["binding"] == "APP_KV" && entry["key"] == key {
                selected = Some(entry);
                break;
            }
        }
        let Some(entry) = selected else {
            self.assert_pinned_source()?;
            return Ok(None);
        };
        let expired = if let Some(expiry) = entry.get("expiration") {
            let seconds = expiry
                .as_u64()
                .filter(|s| *s <= MAX_SAFE_MS / 1000)
                .ok_or(crate::cause!(AccountError::SourceUnavailable))?;
            seconds * 1000 <= now_ms
        } else {
            false
        };
        if entry.get("state").is_some() {
            if entry["state"] == "expired-before-copy"
                && expired
                && entry["originalBytesRecovered"] == false
            {
                self.assert_pinned_source()?;
                return Ok(None);
            }
            return Err(crate::cause!(AccountError::SourceUnavailable));
        }
        if expired {
            self.assert_pinned_source()?;
            return Ok(None);
        }
        let pin = file_pin(&entry)?;
        let path = contained(
            &self.source_root,
            entry["valueFile"]
                .as_str()
                .ok_or(crate::cause!(AccountError::SourceUnavailable))?,
        )?;
        let bytes = read_pinned(&path, &pin, MAX_KV_VALUE_BYTES)?;
        let value = serde_json::from_slice(&bytes).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        self.assert_pinned_source()?;
        Ok(Some(value))
    }
    pub fn personal_key(&self, digest: &str, now_ms: u64) -> AccountResult<Option<Value>> {
        if !hex(digest) {
            return Err(crate::cause!(AccountError::InvalidInput));
        }
        self.exact(&format!("personal-key:{digest}"), now_ms)
    }
    pub fn listing(
        &self,
        user_id: &str,
        digest: &str,
        now_ms: u64,
    ) -> AccountResult<Option<Value>> {
        if user_id != self.source.account.user_id || !hex(digest) {
            return Err(crate::cause!(AccountError::InvalidInput));
        }
        self.exact(&format!("user-key:{user_id}:{digest}"), now_ms)
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::OpenOptionsExt as _;
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;
    use std::ffi::CString;
    use std::io::Write;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use tempfile::{tempdir, TempDir};

    struct Fixture {
        _root: TempDir,
        state: PathBuf,
        credentials: PathBuf,
        manifest: PathBuf,
        receipt_pin: FilePin,
        manifest_pin: FilePin,
        sqlite_pin: FilePin,
    }
    fn account() -> AccountIdentity {
        AccountIdentity {
            user_id: "fixture-user".into(),
            owner_id: "b".repeat(64),
        }
    }
    fn pin(path: &Path) -> FilePin {
        let bytes = fs::read(path).unwrap();
        FilePin {
            bytes: bytes.len() as u64,
            blake3: blake3::hash(&bytes).to_hex().to_string(),
        }
    }
    fn write_json(path: &Path, value: &Value) {
        fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    }
    fn protected_file(path: &Path, bytes: &[u8]) {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .unwrap();
        file.write_all(bytes).unwrap();
    }
    fn fixture() -> Fixture {
        let root = tempdir().unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let state = base.join("original-state");
        let credentials = base.join("fixture-credentials");
        let bundle = base.join("source-bundle");
        let bodies = base.join("source-bodies");
        for path in [&state, &credentials, &bundle, &bodies] {
            fs::create_dir(path).unwrap();
        }
        protected_file(
            &credentials.join("fixture-native-root"),
            format!("{}\n", "01".repeat(32)).as_bytes(),
        );
        protected_file(
            &state.join("browser-session.key"),
            "c".repeat(64).as_bytes(),
        );
        let db_path = state.join("policy.sqlite");
        let db = Connection::open(&db_path).unwrap();
        db.execute_batch("CREATE TABLE account_control_state(singleton INTEGER PRIMARY KEY, epoch INTEGER, state_json TEXT, updating_id TEXT, bootstrapped INTEGER); INSERT INTO account_control_state VALUES(1,7,'{}',NULL,1); CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL);").unwrap();
        db.close().unwrap();
        let sqlite_pin = pin(&db_path);
        let object = json!({"binding":"ACCOUNT_CONTROL","className":"AccountControl","originalId":"a".repeat(64),"localId":"d".repeat(64),"names":[format!("policy:{}",account().owner_id)],"sqlite":"policy.sqlite"});
        fs::write(state.join("objects.ndjson"), format!("{}\n", object)).unwrap();
        // An unrelated body is deliberately invalid JSON. No exact selected
        // read may open it or require its value bytes for metadata admission.
        fs::write(bodies.join("unrelated.json"), b"private-unrelated-invalid").unwrap();
        write_json(
            &bodies.join("session.json"),
            &json!({"userId":"fixture-user","created_at":"2026-10-25T00:00:00.000Z","browser_generation":3}),
        );
        write_json(
            &bodies.join("personal.json"),
            &json!({"userId":"fixture-user","made":"fixture"}),
        );
        write_json(&bodies.join("listing.json"), &json!({"made":"fixture"}));
        let digest = "e".repeat(64);
        let specs = [
            ("session:fixture-session".into(), "session.json", None),
            (format!("personal-key:{digest}"), "personal.json", None),
            (
                format!("user-key:fixture-user:{digest}"),
                "listing.json",
                None,
            ),
            (
                "session:expired".into(),
                "nonexistent-expired.json",
                Some(1u64),
            ),
            ("session:unrelated".into(), "unrelated.json", None),
        ];
        let entries: Vec<Value> = specs.into_iter().map(|(key,file,expiration)| {
            let file_pin = if bodies.join(file).exists() { pin(&bodies.join(file)) }
                else { FilePin {bytes:2,blake3:"f".repeat(64)} };
            let mut value = json!({"binding":"APP_KV","key":key,"valueFile":file,"bytes":file_pin.bytes,"fileIdentity":file_pin.blake3});
            if let Some(expiration) = expiration { value["expiration"] = json!(expiration); }
            value
        }).collect();
        fs::write(
            bundle.join("kv.ndjson"),
            entries.iter().map(|v| format!("{v}\n")).collect::<String>(),
        )
        .unwrap();
        let index_pin = pin(&bundle.join("kv.ndjson"));
        let manifest = bundle.join("manifest.json");
        write_json(
            &manifest,
            &json!({"version":"trillion.local-transfer-bundle/v1","sourceRoot":bodies,"account":{"userId":account().user_id,"ownerId":account().owner_id},"rootCredentials":{"NATIVE_KEY_DERIVATION_ROOT":"fixture-native-root"},"kv":{"path":"kv.ndjson","bytes":index_pin.bytes,"fileIdentity":index_pin.blake3,"count":entries.len()}}),
        );
        let manifest_pin = pin(&manifest);
        let object_index = pin(&state.join("objects.ndjson"));
        write_json(
            &state.join("restore-receipt.json"),
            &json!({"version":"trillion.local-restore-indexed/v1","complete":true,"account":{"userId":account().user_id,"ownerId":account().owner_id},"rootCredentials":{"NATIVE_KEY_DERIVATION_ROOT":"fixture-native-root"},"proof":{"workerdStructuredClone":true,"userSQLIntegrity":true,"providerContacted":false},"replay":{"runtimeStarted":false,"alarmsRestored":false,"alarmsArmed":false},"source":{"bundleManifestIdentity":manifest_pin.blake3},"objects":{"path":"objects.ndjson","bytes":object_index.bytes,"fileIdentity":object_index.blake3,"count":1}}),
        );
        let receipt_pin = pin(&state.join("restore-receipt.json"));
        Fixture {
            _root: root,
            state,
            credentials,
            manifest,
            receipt_pin,
            manifest_pin,
            sqlite_pin,
        }
    }
    fn source(f: &Fixture) -> CatalogSource {
        CatalogSource::open(
            &f.state,
            f.receipt_pin.clone(),
            account(),
            ReadLimits::default(),
        )
        .unwrap()
    }
    fn kv(f: &Fixture) -> SelectedKvSource {
        SelectedKvSource::open(source(f), &f.manifest, f.manifest_pin.clone()).unwrap()
    }
    fn change_receipt(f: &mut Fixture, change: impl FnOnce(&mut Value)) {
        let path = f.state.join("restore-receipt.json");
        let mut value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        change(&mut value);
        write_json(&path, &value);
        f.receipt_pin = pin(&path);
    }

    #[test]
    fn fixture_root_matches_pure_derivation_and_refuses_other_scope() {
        let f = fixture();
        let root = ProtectedNativeRoot::open_in_home(source(&f), &f.credentials).unwrap();
        let pure = NativeKeyDerivationRoot::from_original_root(account(), Zeroizing::new([1; 32]))
            .unwrap();
        let nonce = "ab".repeat(16);
        assert_eq!(
            root.derive_existing(&account(), &nonce).unwrap().identity(),
            pure.derive_existing(&account(), &nonce).unwrap().identity()
        );
        let mut foreign = account();
        foreign.user_id = "another-user".into();
        assert!(root.derive_existing(&foreign, &nonce).is_err());
        assert!(root
            .derive_existing(&account(), "not-an-original-nonce")
            .is_err());
        assert_eq!(format!("{root:?}"), "ProtectedNativeRoot([redacted])");
        assert!(!format!("{:?}", source(&f)).contains("fixture-user"));
    }
    #[test]
    fn root_removal_rotation_and_in_place_change_refuse() {
        for operation in 0..4 {
            let f = fixture();
            let path = f.credentials.join("fixture-native-root");
            let root = ProtectedNativeRoot::open_in_home(source(&f), &f.credentials).unwrap();
            match operation {
                0 => fs::remove_file(&path).unwrap(),
                1 => {
                    fs::rename(&path, f.credentials.join("old-retained-root")).unwrap();
                    protected_file(&path, "01".repeat(32).as_bytes());
                }
                2 => fs::write(&path, "02".repeat(32)).unwrap(),
                _ => fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap(),
            }
            assert!(root.derive_existing(&account(), &"ab".repeat(16)).is_err());
        }
    }
    #[test]
    fn root_mode_link_fifo_and_malformed_bytes_refuse() {
        for operation in 0..5 {
            let f = fixture();
            let path = f.credentials.join("fixture-native-root");
            match operation {
                0 => fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap(),
                1 => {
                    let saved = f.credentials.join("saved");
                    fs::rename(&path, &saved).unwrap();
                    symlink(saved, &path).unwrap();
                }
                2 => {
                    fs::remove_file(&path).unwrap();
                    let text = CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
                    assert_eq!(unsafe { libc::mkfifo(text.as_ptr(), 0o600) }, 0);
                }
                3 => fs::write(&path, b"short").unwrap(),
                _ => fs::write(&path, vec![b'g'; 129]).unwrap(),
            }
            assert!(ProtectedNativeRoot::open_in_home(source(&f), &f.credentials).is_err());
        }
    }
    #[test]
    fn source_account_pin_runtime_and_root_reference_refuse() {
        let f = fixture();
        let mut foreign = account();
        foreign.owner_id = "a".repeat(64);
        assert!(CatalogSource::open(
            &f.state,
            f.receipt_pin.clone(),
            foreign,
            ReadLimits::default()
        )
        .is_err());
        let mut wrong = f.receipt_pin.clone();
        wrong.blake3 = "0".repeat(64);
        assert!(CatalogSource::open(&f.state, wrong, account(), ReadLimits::default()).is_err());
        let original = source(&f);
        fs::write(f.state.join("local-runtime.lock"), b"fixture-active").unwrap();
        assert!(original.assert_pinned_source().is_err());
        let mut f = fixture();
        change_receipt(&mut f, |r| {
            r["rootCredentials"][NATIVE_ROOT_NAME] = json!("../foreign-root")
        });
        assert!(CatalogSource::open(
            &f.state,
            f.receipt_pin.clone(),
            account(),
            ReadLimits::default()
        )
        .is_err());
    }
    #[test]
    fn same_bytes_catalog_replacement_is_a_different_generation() {
        for file in ["restore-receipt.json", "objects.ndjson"] {
            let f = fixture();
            let source = source(&f);
            let path = f.state.join(file);
            let old = fs::read(&path).unwrap();
            fs::rename(&path, f.state.join(format!("retained-{file}"))).unwrap();
            fs::write(&path, old).unwrap();
            assert!(source.assert_pinned_source().is_err());
        }
    }
    #[test]
    fn exact_own_policy_retains_original_sql_and_independent_pin() {
        let f = fixture();
        let source = source(&f);
        let mut original = source.open_own_policy(f.sqlite_pin.clone()).unwrap();
        let rows = original
            .query(
                "SELECT epoch FROM account_control_state WHERE singleton=?",
                &[rusqlite::types::Value::Integer(1)],
            )
            .unwrap();
        assert!(matches!(rows.rows[0][0], import::SqlValue::Integer(7)));
        let mut wrong = f.sqlite_pin.clone();
        wrong.blake3 = "0".repeat(64);
        assert!(source.open_own_policy(wrong).is_err());
    }
    #[test]
    fn policy_source_does_not_require_a_root_or_accept_ambiguous_own_names() {
        let mut f = fixture();
        change_receipt(&mut f, |r| {
            r["rootCredentials"]
                .as_object_mut()
                .unwrap()
                .remove(NATIVE_ROOT_NAME);
        });
        let original = source(&f);
        assert!(original.open_own_policy(f.sqlite_pin.clone()).is_ok());
        assert!(ProtectedNativeRoot::open_in_home(original, &f.credentials).is_err());
        let mut f = fixture();
        let path = f.state.join("objects.ndjson");
        let first = fs::read_to_string(&path).unwrap();
        let mut second: Value = serde_json::from_str(first.trim()).unwrap();
        second["originalId"] = json!("9".repeat(64));
        fs::write(&path, format!("{first}{second}\n")).unwrap();
        let index = pin(&path);
        change_receipt(&mut f, |r| {
            r["objects"]["count"] = json!(2);
            r["objects"]["bytes"] = json!(index.bytes);
            r["objects"]["fileIdentity"] = json!(index.blake3);
        });
        assert!(source(&f).open_own_policy(f.sqlite_pin.clone()).is_err());
    }
    #[test]
    fn selected_kv_reads_only_exact_bodies_and_does_not_revive_expiry() {
        let f = fixture();
        let reader = kv(&f);
        let digest = "e".repeat(64);
        assert_eq!(
            reader.personal_key(&digest, 2000).unwrap().unwrap()["userId"],
            "fixture-user"
        );
        assert!(reader.listing("foreign-user", &digest, 2000).is_err());
        assert_eq!(
            reader
                .listing("fixture-user", &digest, 2000)
                .unwrap()
                .unwrap()["made"],
            "fixture"
        );
        assert_eq!(
            format!("{reader:?}"),
            "SelectedKvSource([redacted immutable provenance])"
        );
    }
    #[test]
    fn kv_wrong_manifest_pin_and_changed_body_index_or_source_refuse() {
        let f = fixture();
        let mut wrong = f.manifest_pin.clone();
        wrong.blake3 = "a".repeat(64);
        assert!(SelectedKvSource::open(source(&f), &f.manifest, wrong).is_err());
        let reader = kv(&f);
        let manifest: Value = serde_json::from_slice(&fs::read(&f.manifest).unwrap()).unwrap();
        fs::write(
            Path::new(manifest["sourceRoot"].as_str().unwrap()).join("personal.json"),
            b"{}",
        )
        .unwrap();
        assert!(reader.personal_key(&"e".repeat(64), 2000).is_err());
        let f = fixture();
        let reader = kv(&f);
        fs::write(f.manifest.parent().unwrap().join("kv.ndjson"), b"{}\n").unwrap();
        assert!(reader.personal_key(&"e".repeat(64), 2000).is_err());
        let f = fixture();
        let reader = kv(&f);
        fs::write(&f.manifest, b"{}").unwrap();
        assert!(reader.personal_key(&"e".repeat(64), 2000).is_err());
    }
    #[test]
    fn browser_supplier_exposes_original_digest_only_and_detects_rotation() {
        let f = fixture();
        let browser = ProtectedBrowserSession::open_existing(&f.state).unwrap();
        assert_eq!(
            browser.identity().unwrap().as_str(),
            blake3::hash("c".repeat(64).as_bytes()).to_hex().as_str()
        );
        assert_eq!(
            format!("{browser:?}"),
            "ProtectedBrowserSession([redacted])"
        );
        let path = f.state.join("browser-session.key");
        fs::rename(&path, f.state.join("retained-browser-session.key")).unwrap();
        protected_file(&path, "c".repeat(64).as_bytes());
        assert!(browser.identity().is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(ProtectedBrowserSession::open_existing(&f.state).is_err());
    }
}
