// src/import.rs
//
// Purpose: Read independently pinned original SQLite snapshots and their retained metadata without replacing their schema.
//
// Non-Negotiable Invariants:
// - Preserve original bytes, account identity, exact file pins and source-table semantics.
// - Read only an explicitly selected retained source; never create a replacement account or mutate originals.
// - Bound schema discovery, rows, cells, SQL work, elapsed time and returned bytes; refuse partial success.
//
// Key Concepts:
// - Independently retained BLAKE3 file pins, account-scoped selections and read-only SQLite snapshots.
// - Explicit read budgets, measured statement/scan work and safe original-value inspection.
//
// Security Considerations:
// - A path or successful decode grants no current account or resource authority.
// - Retain confinement, alias/sidecar checks, restore record continuity and redacted failures.
// - Keep this physical original-reader supply separate from canonical account policy and record mutation.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! Read the actual pinned native-original cohort without translating its schema.
//! This is separate from the new Rust record store. No provider or JavaScript program.
use rusqlite::types::{Value, ValueRef};
use content_crypto::advanced::blake3;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::collections::BTreeMap;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use crate::tool_runs::os::{Open, OwnerFiles, This};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

pub enum ImportError {
    Refused(&'static str, crate::refusal_cause::Cause),
    Budget(&'static str, crate::refusal_cause::Cause),
    Deadline(&'static str, crate::refusal_cause::Cause),
    Io(io::Error, crate::refusal_cause::Cause),
    Sqlite(rusqlite::Error, crate::refusal_cause::Cause),
    Json(serde_json::Error, crate::refusal_cause::Cause),
}
impl std::fmt::Debug for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportError").field("cause", &self.cause()).finish()
    }
}
impl ImportError {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { match self {
        Self::Refused(_, cause) => cause,
        Self::Budget(_, cause) => cause,
        Self::Deadline(_, cause) => cause,
        Self::Io(_, cause) => cause,
        Self::Sqlite(_, cause) => cause,
        Self::Json(_, cause) => cause,
    } }
}
crate::impl_caused!(ImportError);


impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let result: std::fmt::Result = {
        match self {
            Self::Refused(reason, _) | Self::Budget(reason, _) | Self::Deadline(reason, _) => f.write_str(reason),
            Self::Io(error, _) => write!(f, "original snapshot I/O failed ({:?})", error.kind()),
            Self::Sqlite(_, _) => f.write_str("original SQLite operation refused or failed"),
            Self::Json(_, _) => f.write_str("original metadata is invalid JSON"),
        }

        };
        result?;
        write!(f, " cause={}", self.cause())
    }
}
impl std::error::Error for ImportError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
impl From<io::Error> for ImportError {
    #[track_caller]
    fn from(e: io::Error) -> Self {
        Self::Io(e, crate::cause!(caller_site: import_error_conversion))
    }
}
impl From<rusqlite::Error> for ImportError {
    #[track_caller]
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e, crate::cause!(caller_site: import_error_conversion))
    }
}
impl From<serde_json::Error> for ImportError {
    #[track_caller]
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e, crate::cause!(caller_site: import_error_conversion))
    }
}
pub type ImportResult<T> = Result<T, ImportError>;
const MAX_SCHEMA_COLUMNS: usize = 1024;
#[track_caller]
fn refuse<T>(reason: &'static str) -> ImportResult<T> {
    Err(ImportError::Refused(reason, crate::cause!(caller_site: ImportError::Refused)))
}
fn hex(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A caller-supplied, independently retained raw-byte identity. Observing a new
/// digest is not evidence that bytes still equal an earlier qualified snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilePin {
    pub bytes: u64,
    pub blake3: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountIdentity {
    pub user_id: String,
    pub owner_id: String,
}
#[derive(Debug, Clone)]
pub struct ReadLimits {
    pub metadata_bytes: u64,
    pub index_bytes: u64,
    pub object_bytes: u64,
    pub objects: usize,
    pub rows: usize,
    pub columns: usize,
    pub result_bytes: usize,
    pub cell_bytes: usize,
    pub sql_bytes: usize,
    pub vm_steps: u64,
    pub elapsed: Duration,
}
impl Default for ReadLimits {
    fn default() -> Self {
        Self {
            metadata_bytes: 1024 * 1024,
            index_bytes: 16 * 1024 * 1024,
            object_bytes: 16 * 1024 * 1024 * 1024,
            objects: 4096,
            rows: 256,
            columns: 256,
            result_bytes: 4 * 1024 * 1024,
            cell_bytes: 1024 * 1024,
            sql_bytes: 64 * 1024,
            vm_steps: 2_000_000,
            elapsed: Duration::from_secs(2),
        }
    }
}
impl ReadLimits {
    pub(crate) fn validate(&self) -> ImportResult<()> {
        if self.metadata_bytes == 0
            || self.metadata_bytes > 16 * 1024 * 1024
            || self.index_bytes == 0
            || self.index_bytes > 64 * 1024 * 1024
            || self.object_bytes == 0
            || self.object_bytes > 64 * 1024 * 1024 * 1024
            || self.objects == 0
            || self.objects > 65536
            || self.rows == 0
            || self.rows > 4096
            || self.columns == 0
            || self.columns > MAX_SCHEMA_COLUMNS
            || self.cell_bytes == 0
            || self.cell_bytes > 16 * 1024 * 1024
            || self.result_bytes == 0
            || self.result_bytes > 64 * 1024 * 1024
            || self.sql_bytes == 0
            || self.sql_bytes > 1024 * 1024
            || self.vm_steps == 0
            || self.vm_steps > 100_000_000
            || self.elapsed.is_zero()
            || self.elapsed > Duration::from_secs(30)
        {
            return refuse("original read bounds are invalid");
        }
        Ok(())
    }
}
#[derive(Debug, Clone)]
pub struct OriginalObject {
    pub binding: String,
    pub original_id: String,
    pub sqlite_relative: PathBuf,
    /// Exact native-index entry, including names, original hidden-storage
    /// identity and original/source provenance. No new key or ID is generated.
    pub descriptor: Json,
}
#[derive(Debug)]
pub struct NativeCatalog {
    state: PathBuf,
    receipt: Json,
    receipt_pin: FilePin,
    index_path: PathBuf,
    index_pin: FilePin,
    objects: BTreeMap<(String, String), OriginalObject>,
    limits: ReadLimits,
}
/// Whether both describe the same unchanged file, as the computer's owner-only files say it (src/tool_runs/os.rs
/// `OwnerFiles`); a computer that cannot say answers no, so nothing is taken as unchanged there.
fn unchanged(a: &Metadata, b: &Metadata) -> bool {
    let (Ok(x), Ok(y)) = (This::facts(a), This::facts(b)) else { return false };
    x.device == y.device && x.inode == y.inode && a.len() == b.len() && x.modified == y.modified && x.changed == y.changed
}
fn regular_file(path: &Path) -> ImportResult<Metadata> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return refuse("original input is not a regular file");
    }
    Ok(meta)
}
fn guarded_file(path: &Path) -> ImportResult<(File, Metadata)> {
    let before = regular_file(path)?;
    let file = This::open(OpenOptions::new().read(true), path, Open::NO_FOLLOW)?;
    let opened = file.metadata()?;
    if !unchanged(&before, &opened) || !unchanged(&opened, &regular_file(path)?) {
        return refuse("original input changed while opening");
    }
    Ok((file, opened))
}
fn bounded_bytes(path: &Path, pin: &FilePin, max: u64) -> ImportResult<Vec<u8>> {
    if !hex(&pin.blake3) || pin.bytes > max {
        return refuse("original metadata pin exceeds its bound");
    }
    let (file, before) = guarded_file(path)?;
    if before.len() != pin.bytes {
        return refuse("original metadata size differs from its pin");
    }
    let mut data = Vec::with_capacity(pin.bytes as usize);
    file.take(pin.bytes + 1).read_to_end(&mut data)?;
    if data.len() as u64 != pin.bytes
        || blake3::hash(&data).to_hex().as_str() != pin.blake3
        || !unchanged(&before, &regular_file(path)?)
    {
        return refuse("original metadata bytes differ from their pin");
    }
    Ok(data)
}
fn inside(state: &Path, relative: &Path) -> ImportResult<PathBuf> {
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return refuse("original metadata path must be a contained relative path");
    }
    let mut current = state.to_path_buf();
    for part in relative.components() {
        current.push(part.as_os_str());
        if fs::symlink_metadata(&current)?.file_type().is_symlink() {
            return refuse("original metadata path traverses a symbolic link");
        }
    }
    let actual = fs::canonicalize(&current)?;
    if !actual.starts_with(state) {
        return refuse("original metadata path leaves the selected state");
    }
    Ok(actual)
}
fn json_pin(value: &Json) -> ImportResult<FilePin> {
    let bytes = value
        .get("bytes")
        .and_then(Json::as_u64)
        .ok_or(ImportError::Refused("original index byte size is missing", crate::cause!()))?;
    let identity = value
        .get("fileIdentity")
        .and_then(Json::as_str)
        .ok_or(ImportError::Refused(
            "original index raw identity is missing",
         crate::cause!()))?;
    if !hex(identity) {
        return refuse("original index raw identity is invalid");
    }
    Ok(FilePin {
        bytes,
        blake3: identity.into(),
    })
}
impl NativeCatalog {
    pub fn open(
        state: impl AsRef<Path>,
        receipt_pin: FilePin,
        account: AccountIdentity,
        limits: ReadLimits,
    ) -> ImportResult<Self> {
        limits.validate()?;
        if account.user_id.is_empty() || !hex(&account.owner_id) {
            return refuse("an exact original account identity is required");
        }
        let state = fs::canonicalize(state)?;
        if !state.is_dir() {
            return refuse("selected original state is not a directory");
        }
        reject_active_state(&state)?;
        let receipt_path = inside(&state, Path::new("restore-receipt.json"))?;
        let receipt: Json = serde_json::from_slice(&bounded_bytes(
            &receipt_path,
            &receipt_pin,
            limits.metadata_bytes,
        )?)?;
        if receipt["version"] != "trillion.local-restore-indexed/v1"
            || receipt["complete"] != true
            || receipt["account"]["userId"] != account.user_id
            || receipt["account"]["ownerId"] != account.owner_id
            || receipt["proof"]["workerdStructuredClone"] != true
            || receipt["proof"]["userSQLIntegrity"] != true
            || receipt["proof"]["providerContacted"] != false
            || !receipt["source"]["bundleManifestIdentity"]
                .as_str()
                .is_some_and(hex)
            || receipt["replay"]["runtimeStarted"] != false
            || receipt["replay"]["alarmsRestored"] != false
            || receipt["replay"]["alarmsArmed"] != false
            || receipt.get("runtimeContinuation").is_some()
            || receipt["partial_original"] == true
            || receipt["complete_original"] == false
            || receipt["objects"]["partial_original"] == true
            || receipt["objects"]["complete_original"] == false
        {
            return refuse("selected state is not the pinned unlaunched full-original cohort");
        }
        let count = receipt["objects"]["count"]
            .as_u64()
            .ok_or(ImportError::Refused("original object count is missing", crate::cause!()))?;
        if count == 0 || count > limits.objects as u64 {
            return refuse("original object count exceeds its bound");
        }
        let index_relative = receipt["objects"]["path"]
            .as_str()
            .ok_or(ImportError::Refused(
                "original object index path is missing",
             crate::cause!()))?;
        let index_path = inside(&state, Path::new(index_relative))?;
        let index_pin = json_pin(&receipt["objects"])?;
        let bytes = bounded_bytes(&index_path, &index_pin, limits.index_bytes)?;
        let mut objects = BTreeMap::new();
        for line in bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
            if objects.len() >= limits.objects || line.len() as u64 > limits.metadata_bytes {
                return refuse("original object index exceeds its bound");
            }
            let descriptor: Json = serde_json::from_slice(line)?;
            let binding = descriptor["binding"]
                .as_str()
                .ok_or(ImportError::Refused("original binding is missing", crate::cause!()))?
                .to_string();
            let id = descriptor["originalId"]
                .as_str()
                .ok_or(ImportError::Refused("original ID is missing", crate::cause!()))?
                .to_string();
            if binding.is_empty()
                || binding.len() > 128
                || !hex(&id)
                || descriptor["partial_original"] == true
                || descriptor["complete_original"] == false
            {
                return refuse("original index contains an invalid or partial identity");
            }
            let sqlite_relative = PathBuf::from(
                descriptor["sqlite"]
                    .as_str()
                    .ok_or(ImportError::Refused("original SQLite path is missing", crate::cause!()))?,
            );
            inside(&state, &sqlite_relative)?;
            let key = (binding.clone(), id.clone());
            if objects
                .insert(
                    key,
                    OriginalObject {
                        binding,
                        original_id: id,
                        sqlite_relative,
                        descriptor,
                    },
                )
                .is_some()
            {
                return refuse("original object index repeats an identity");
            }
        }
        if objects.len() as u64 != count {
            return refuse("original object index count differs from its receipt");
        }
        Ok(Self {
            state,
            receipt,
            receipt_pin,
            index_path,
            index_pin,
            objects,
            limits,
        })
    }
    /// Only the full-original index is exposed. A separately scoped accountSlices
    /// section stays separate and never becomes another full original.
    pub fn objects(&self) -> impl Iterator<Item = &OriginalObject> {
        self.objects.values()
    }
    pub fn receipt(&self) -> &Json {
        &self.receipt
    }
    fn recheck(&self) -> ImportResult<()> {
        reject_active_state(&self.state)?;
        bounded_bytes(
            &self.state.join("restore-receipt.json"),
            &self.receipt_pin,
            self.limits.metadata_bytes,
        )?;
        bounded_bytes(&self.index_path, &self.index_pin, self.limits.index_bytes)?;
        Ok(())
    }
    pub fn open_object(
        &self,
        binding: &str,
        original_id: &str,
        sqlite_pin: FilePin,
    ) -> ImportResult<ReadonlyOriginal> {
        self.recheck()?;
        let object = self
            .objects
            .get(&(binding.to_string(), original_id.to_string()))
            .ok_or(ImportError::Refused(
                "object is outside the selected full-original cohort",
             crate::cause!()))?
            .clone();
        let path = inside(&self.state, &object.sqlite_relative)?;
        let (quiescent_sidecars, sidecar_witness) = admit_quiescent_sidecars(
            &self.state,
            &path,
            &self.receipt,
            &object,
            &sqlite_pin,
            &self.limits,
        )?;
        let metadata = verify_sqlite_file(&path, &sqlite_pin, self.limits.object_bytes)?;
        let uri = crate::storage::sqlite::immutable_uri(&crate::storage::sqlite::no_follow_path(&path))
            .ok_or(ImportError::Refused("original SQLite path is not UTF-8", crate::cause!()))?;
        let connection = Connection::open_with_flags(
            uri,
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_URI
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        crate::record_source::configure_read(&connection, &self.limits)?;
        if !unchanged(&metadata, &regular_file(&path)?) {
            return refuse("original SQLite source changed while opening");
        }
        self.recheck()?;
        check_sidecars(&path, quiescent_sidecars.as_ref())?;
        if let Some(witness) = &sidecar_witness {
            witness.recheck()?;
        }
        Ok(ReadonlyOriginal {
            connection,
            path,
            quiescent_sidecars,
            sidecar_witness,
            source_root: self.state.clone(),
            metadata,
            pin: sqlite_pin,
            object,
            limits: self.limits.clone(),
            receipt_pin: self.receipt_pin.clone(),
            source_manifest: self.receipt["source"].clone(),
            last_query_timing: QueryTiming::default(),
        })
    }
}
fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}
fn reject_active_state(state: &Path) -> ImportResult<()> {
    match fs::symlink_metadata(state.join("local-runtime.lock")) {
        Ok(_) => refuse("selected original state has a runtime ownership lock"),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
fn present(path: &Path) -> ImportResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}
/// Only empty WAL generations the restore record qualifies may accompany an immutable read.
/// SHM is verified, kept where it is and never opened by SQLite immutable mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuiescentSidecarPins {
    pub wal: FilePin,
    pub shm: Option<FilePin>,
}
fn check_sidecars(path: &Path, pins: Option<&QuiescentSidecarPins>) -> ImportResult<()> {
    if present(&sidecar(path, "-journal"))? {
        return refuse("original SQLite source has a rollback journal");
    }
    if let Some(pins) = pins {
        if pins.wal.bytes != 0 {
            return refuse("original SQLite WAL is not empty");
        }
        bounded_bytes(&sidecar(path, "-wal"), &pins.wal, 0)?;
        match &pins.shm {
            Some(pin) => {
                bounded_bytes(&sidecar(path, "-shm"), pin, 1024 * 1024)?;
            }
            None if present(&sidecar(path, "-shm"))? => {
                return refuse("original SQLite SHM is not receipt-qualified")
            }
            None => (),
        }
    } else if present(&sidecar(path, "-wal"))? || present(&sidecar(path, "-shm"))? {
        return refuse("original SQLite source has unqualified sidecars");
    }
    Ok(())
}
/// The initial BLAKE3 qualifies bytes; the held open file and fresh named/open
/// metadata preserve that exact generation during this one source lifetime.
/// This is not a cross-source cache and does not qualify fresh account rights.
#[derive(Debug)]
struct PinnedSidecarWitness {
    path: PathBuf,
    file: File,
    metadata: Metadata,
    directories: Vec<PinnedWitnessDirectory>,
}
#[derive(Debug)]
struct PinnedWitnessDirectory {
    path: PathBuf,
    metadata: Metadata,
}
fn same_witness_generation(a: &Metadata, b: &Metadata) -> bool {
    let (Ok(x), Ok(y)) = (This::facts(a), This::facts(b)) else { return false };
    unchanged(a, b) && x.mode == y.mode && x.owner == y.owner && x.group == y.group && x.links == y.links
}
fn witness_directory(path: &Path) -> ImportResult<Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return refuse("original proof ancestry is not a real directory");
    }
    Ok(metadata)
}
impl PinnedWitnessDirectory {
    fn open(path: PathBuf) -> ImportResult<Self> {
        let metadata = witness_directory(&path)?;
        // Parent custody needs fresh no-follow metadata, not directory-data
        // access or listing rights. Only the proof file retains an open handle.
        let witness = Self { path, metadata };
        witness.recheck()?;
        Ok(witness)
    }
    fn recheck(&self) -> ImportResult<()> {
        if !same_witness_generation(&self.metadata, &witness_directory(&self.path)?) {
            return refuse("original proof directory changed during use");
        }
        Ok(())
    }
}
impl PinnedSidecarWitness {
    fn read(
        state: &Path,
        path: PathBuf,
        pin: &FilePin,
        max_bytes: u64,
    ) -> ImportResult<(Vec<u8>, Self)> {
        if !hex(&pin.blake3) || pin.bytes > max_bytes {
            return refuse("original metadata pin exceeds its bound");
        }
        let relative = path
            .parent()
            .and_then(|parent| parent.strip_prefix(state).ok())
            .ok_or(ImportError::Refused(
                "original proof leaves its selected source",
             crate::cause!()))?;
        // Retain only the finite source-to-proof ancestry, never unrelated
        // global parents. Directory replacement cannot preserve file custody.
        if relative.components().count() > 63 {
            return refuse("original proof ancestry exceeds its bound");
        }
        let mut current = state.to_path_buf();
        let mut directories = vec![PinnedWitnessDirectory::open(current.clone())?];
        for part in relative.components() {
            if !matches!(part, Component::Normal(_)) {
                return refuse("original proof ancestry is not a contained path");
            }
            current.push(part.as_os_str());
            directories.push(PinnedWitnessDirectory::open(current.clone())?);
        }
        let (mut file, metadata) = guarded_file(&path)?;
        if metadata.len() != pin.bytes {
            return refuse("original metadata size differs from its pin");
        }
        let mut data = Vec::with_capacity(pin.bytes as usize);
        (&mut file).take(pin.bytes + 1).read_to_end(&mut data)?;
        if data.len() as u64 != pin.bytes || blake3::hash(&data).to_hex().as_str() != pin.blake3 {
            return refuse("original metadata bytes differ from their pin");
        }
        let witness = Self {
            path,
            file,
            metadata,
            directories,
        };
        witness.recheck()?;
        Ok((data, witness))
    }
    fn recheck(&self) -> ImportResult<()> {
        for directory in &self.directories {
            directory.recheck()?;
        }
        if !same_witness_generation(&self.metadata, &self.file.metadata()?)
            || !same_witness_generation(&self.metadata, &regular_file(&self.path)?)
        {
            return refuse("original proof file changed during use");
        }
        // Recheck ancestry after named-file observation as well. These are
        // ordinary-change guards, not an OS exclusion lock against a writer.
        for directory in &self.directories {
            directory.recheck()?;
        }
        Ok(())
    }
}
fn sidecar_pins_from_files(
    files: &[Json],
    relative: &str,
    main: &FilePin,
    expected_total: Option<u64>,
) -> ImportResult<QuiescentSidecarPins> {
    if !(2..=3).contains(&files.len()) {
        return refuse("original sidecar proof has an unexpected file cohort");
    }
    let mut main_pin = None;
    let mut wal = None;
    let mut shm = None;
    let mut total = 0u64;
    for file in files {
        let name = file["path"].as_str().ok_or(ImportError::Refused(
            "original sidecar proof path is missing",
         crate::cause!()))?;
        let pin = FilePin {
            bytes: file["bytes"]
                .as_u64()
                .ok_or(ImportError::Refused("original sidecar size is missing", crate::cause!()))?,
            blake3: file["identity"]
                .as_str()
                .ok_or(ImportError::Refused("original sidecar identity is missing", crate::cause!()))?
                .to_string(),
        };
        if !hex(&pin.blake3) {
            return refuse("original sidecar identity is invalid");
        }
        total = total
            .checked_add(pin.bytes)
            .ok_or(ImportError::Refused("original sidecar proof size overflow", crate::cause!()))?;
        let slot = if name == relative {
            &mut main_pin
        } else if name == format!("{relative}-wal") {
            &mut wal
        } else if name == format!("{relative}-shm") {
            &mut shm
        } else {
            return refuse("original sidecar proof changes native placement");
        };
        if slot.replace(pin).is_some() {
            return refuse("original sidecar proof repeats a file");
        }
    }
    if main_pin.as_ref() != Some(main) || expected_total.is_some_and(|expected| expected != total) {
        return refuse("original sidecar proof disagrees with the supplied main SQLite pin");
    }
    let wal = wal.ok_or(ImportError::Refused(
        "original sidecar proof lacks an empty WAL",
     crate::cause!()))?;
    if wal.bytes != 0 || wal.blake3 != blake3::hash(&[]).to_hex().as_str() {
        return refuse("original sidecar proof WAL is not the exact empty generation");
    }
    if shm
        .as_ref()
        .is_some_and(|pin| pin.bytes == 0 || pin.bytes > 1024 * 1024)
    {
        return refuse("original sidecar proof SHM exceeds its bound");
    }
    Ok(QuiescentSidecarPins { wal, shm })
}
/// A pristine extension's pre-clone file witness covers inherited originals.
/// It is independently pinned by the already authenticated native restore record;
/// it is not rewritten into a fictitious last-delta import footprint.
fn inherited_sidecar_witness(
    state: &Path,
    receipt: &Json,
    object: &OriginalObject,
    main: &FilePin,
    limits: &ReadLimits,
) -> ImportResult<Option<(QuiescentSidecarPins, PinnedSidecarWitness)>> {
    let Some(reference) = receipt["extension"].get("files") else {
        return Ok(None);
    };
    let extension = &receipt["extension"];
    if extension["version"] != "trillion.pristine-native-extension/v1"
        || extension["stableSource"] != true
        || extension["independentCloneBytesVerified"] != true
        || extension["copyOnWriteRequired"] != true
        || extension["providerContacted"] != false
        || extension["applicationStarted"] != false
    {
        return refuse("inherited sidecars lack the exact pristine clone proof");
    }
    let name = reference["path"].as_str().ok_or(ImportError::Refused(
        "inherited file witness path is missing",
     crate::cause!()))?;
    let path = inside(state, Path::new(name))?;
    let pin = json_pin(reference)?;
    let count = reference["count"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 100_000)
        .ok_or(ImportError::Refused(
            "inherited file witness count exceeds its bound",
         crate::cause!()))?;
    let (data, witness) = PinnedSidecarWitness::read(state, path, &pin, limits.index_bytes)?;
    let text = std::str::from_utf8(&data)
        .map_err(|_| ImportError::Refused("inherited file witness is not UTF-8", crate::cause!()))?;
    let relative = object.sqlite_relative.to_str().ok_or(ImportError::Refused(
        "original SQLite relative path is not UTF-8",
     crate::cause!()))?;
    let wal_name = format!("{relative}-wal");
    let shm_name = format!("{relative}-shm");
    let mut paths = std::collections::BTreeSet::new();
    let mut selected = Vec::new();
    let mut rows = 0u64;
    for line in text.lines() {
        rows += 1;
        if rows > count || line.len() as u64 > limits.metadata_bytes {
            return refuse("inherited file witness exceeds its row bound");
        }
        let row: Json = serde_json::from_str(line)?;
        if row.as_object().is_none_or(|object| object.len() != 3) {
            return refuse("inherited file witness row shape is invalid");
        }
        let file = row["path"].as_str().ok_or(ImportError::Refused(
            "inherited file witness row path is missing",
         crate::cause!()))?;
        if file.is_empty()
            || Path::new(file)
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
            || !paths.insert(file.to_string())
            || row["bytes"].as_u64().is_none()
            || !row["identity"].as_str().is_some_and(hex)
        {
            return refuse("inherited file witness has an invalid or repeated path/pin");
        }
        if file == relative || file == wal_name || file == shm_name {
            selected.push(row);
        }
    }
    if rows != count {
        return refuse("inherited file witness count differs from its receipt");
    }
    // A newly added object need not appear in the inherited witness. The normal
    // exact-delta restore record remains its authority. Do not widen to another path.
    if selected.is_empty() {
        return Ok(None);
    }
    if selected.len() == 1 {
        if selected[0]["path"] != relative {
            return refuse("inherited sidecar witness is missing the main SQLite file");
        }
        let held = FilePin {
            bytes: selected[0]["bytes"]
                .as_u64()
                .ok_or(ImportError::Refused("inherited SQLite size is missing", crate::cause!()))?,
            blake3: selected[0]["identity"]
                .as_str()
                .ok_or(ImportError::Refused("inherited SQLite identity is missing", crate::cause!()))?
                .into(),
        };
        if &held != main {
            return refuse("inherited main SQLite pin differs from its retained witness");
        }
        return Ok(None);
    }
    let pins = sidecar_pins_from_files(&selected, relative, main, None)?;
    Ok(Some((pins, witness)))
}
fn admit_quiescent_sidecars(
    state: &Path,
    path: &Path,
    receipt: &Json,
    object: &OriginalObject,
    main: &FilePin,
    limits: &ReadLimits,
) -> ImportResult<(Option<QuiescentSidecarPins>, Option<PinnedSidecarWitness>)> {
    let relative = object.sqlite_relative.to_str().ok_or(ImportError::Refused(
        "original SQLite relative path is not UTF-8",
     crate::cause!()))?;
    let footprints = receipt["extension"]["capacity"]["localImportedFootprints"].as_array();
    if footprints.is_some_and(|entries| entries.len() > 4096) {
        return refuse("original sidecar footprint count exceeds its bound");
    }
    let matching = footprints
        .into_iter()
        .flatten()
        .filter(|entry| entry["binding"] == object.binding && entry["id"] == object.original_id)
        .collect::<Vec<_>>();
    if matching.len() > 1 {
        return refuse("original sidecars have ambiguous import footprints");
    }
    if let Some(footprint) = matching.first() {
        if receipt["extension"]["version"] != "trillion.pristine-native-extension/v1" {
            return refuse("original sidecars lack a qualified pristine importer receipt");
        }
        let files = footprint["files"].as_array().ok_or(ImportError::Refused(
            "original sidecar footprint files are missing",
         crate::cause!()))?;
        let has_sidecars = files.iter().any(|file| {
            file["path"].as_str().is_some_and(|name| {
                name == format!("{relative}-wal") || name == format!("{relative}-shm")
            })
        });
        if has_sidecars {
            let total = footprint["localImportedBytes"]
                .as_u64()
                .ok_or(ImportError::Refused(
                    "original imported footprint total is missing",
                 crate::cause!()))?;
            let pins = sidecar_pins_from_files(files, relative, main, Some(total))?;
            check_sidecars(path, Some(&pins))?;
            return Ok((Some(pins), None));
        }
        // A main-only delta never authorizes newly appeared sidecars.
        check_sidecars(path, None)?;
        return Ok((None, None));
    }
    if let Some((pins, witness)) = inherited_sidecar_witness(state, receipt, object, main, limits)?
    {
        check_sidecars(path, Some(&pins))?;
        return Ok((Some(pins), Some(witness)));
    }
    check_sidecars(path, None)?;
    Ok((None, None))
}
fn verify_sqlite_file(path: &Path, pin: &FilePin, max: u64) -> ImportResult<Metadata> {
    if !hex(&pin.blake3) || pin.bytes < 100 || pin.bytes > max {
        return refuse("original SQLite pin exceeds its bound");
    }
    let (mut file, before) = guarded_file(path)?;
    if before.len() != pin.bytes {
        return refuse("original SQLite size differs from its pin");
    }
    let mut hash = blake3::Hasher::new();
    let mut remaining = pin.bytes;
    let mut buffer = [0u8; 64 * 1024];
    let mut header = Vec::new();
    while remaining > 0 {
        let limit = remaining.min(buffer.len() as u64) as usize;
        let count = file.read(&mut buffer[..limit])?;
        if count == 0 {
            return refuse("original SQLite source ended early");
        }
        if header.is_empty() {
            header.extend_from_slice(&buffer[..count.min(16)]);
        }
        hash.update(&buffer[..count]);
        remaining -= count as u64;
    }
    let mut extra = [0u8; 1];
    if file.read(&mut extra)? != 0
        || header != b"SQLite format 3\0"
        || hash.finalize().to_hex().as_str() != pin.blake3
        || !unchanged(&before, &file.metadata()?)
        || !unchanged(&before, &regular_file(path)?)
    {
        return refuse("original SQLite bytes differ from their pin");
    }
    Ok(before)
}
/// Text and BLOB stay byte-distinct. TEXT is bytes because SQLite can store
/// invalid UTF-8; an adapter must not silently replace those bytes. REAL uses
/// raw IEEE754 bits so signed zero and infinities survive serialization.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "sqlite_type", content = "value", rename_all = "lowercase")]
pub enum SqlValue {
    Null,
    Integer(#[serde(with = "int64_text")] i64),
    RealBits(#[serde(with = "uint64_text")] u64),
    Text(Vec<u8>),
    Blob(Vec<u8>),
}
mod int64_text {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &i64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
        let text = String::deserialize(deserializer)?;
        let value = text.parse::<i64>().map_err(serde::de::Error::custom)?;
        if value.to_string() != text {
            return Err(serde::de::Error::custom("noncanonical int64"));
        }
        Ok(value)
    }
}
mod uint64_text {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let text = String::deserialize(deserializer)?;
        let value = text.parse::<u64>().map_err(serde::de::Error::custom)?;
        if value.to_string() != text {
            return Err(serde::de::Error::custom("noncanonical uint64"));
        }
        Ok(value)
    }
}
impl SqlValue {
    pub(crate) fn from_ref(value: ValueRef<'_>) -> Self {
        match value {
            ValueRef::Null => Self::Null,
            ValueRef::Integer(n) => Self::Integer(n),
            ValueRef::Real(n) => Self::RealBits(n.to_bits()),
            ValueRef::Text(bytes) => Self::Text(bytes.to_vec()),
            ValueRef::Blob(bytes) => Self::Blob(bytes.to_vec()),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueryRows {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<SqlValue>>,
    pub progress_callbacks: u64,
}
/// Fixed aggregate wall durations for the last attempted original query. These
/// include scheduling time and are diagnostic observations, not CPU/bill units.
/// No SQL, path, parameter or result bytes enter this transport.
#[derive(Debug, Default, Clone, Copy, Serialize)]
pub struct QueryTiming {
    pub precheck_us: u64,
    pub sql_us: u64,
    pub postcheck_us: u64,
}
fn elapsed_us(start: Instant) -> u64 {
    start.elapsed().as_micros().min(u64::MAX as u128) as u64
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotCopyReceipt {
    pub binding: String,
    pub original_id: String,
    pub native_descriptor: Json,
    pub source_receipt: FilePin,
    pub source_manifest: Json,
    pub sqlite: FilePin,
    pub source_quiescent_sidecars: Option<QuiescentSidecarPins>,
    pub preserves_original_sql_schema_and_hidden_bytes: bool,
    pub hidden_storage_decoded: bool,
    pub runtime_started: bool,
}
pub struct ReadonlyOriginal {
    connection: Connection,
    path: PathBuf,
    quiescent_sidecars: Option<QuiescentSidecarPins>,
    sidecar_witness: Option<PinnedSidecarWitness>,
    source_root: PathBuf,
    metadata: Metadata,
    pin: FilePin,
    object: OriginalObject,
    limits: ReadLimits,
    receipt_pin: FilePin,
    source_manifest: Json,
    last_query_timing: QueryTiming,
}
impl ReadonlyOriginal {
    pub fn original(&self) -> &OriginalObject {
        &self.object
    }
    /// Physical per-query ceilings, not record/account authority. A consumer
    /// may choose a smaller window but cannot widen these in a budgeted call.
    pub fn read_limits(&self) -> &ReadLimits {
        &self.limits
    }
    /// Reset on every query, including a failed precheck. Failed SQL retains
    /// both its duration and the subsequent source-continuity check duration.
    pub fn last_query_timing(&self) -> QueryTiming {
        self.last_query_timing
    }
    fn check_source(&self) -> ImportResult<()> {
        reject_active_state(&self.source_root)?;
        if let Some(witness) = &self.sidecar_witness {
            witness.recheck()?;
        }
        check_sidecars(&self.path, self.quiescent_sidecars.as_ref())?;
        if !unchanged(&self.metadata, &regular_file(&self.path)?) {
            return refuse("original SQLite source changed during use");
        }
        Ok(())
    }
    /// One read statement, with bound parameters. SQL containing a semicolon is
    /// refused to avoid silently accepting an unexecuted trailing statement.
    /// Bound excess is an error; rows are never silently truncated.
    pub fn query(&mut self, sql: &str, params: &[Value]) -> ImportResult<QueryRows> {
        self.query_inner(sql, params, None, false)
    }
    /// Caller caps may only tighten this source's independently qualified read
    /// limits. The absolute deadline includes both source continuity checks.
    pub fn query_with_budget(
        &mut self,
        sql: &str,
        params: &[Value],
        budget: crate::record_source::QueryBudget,
    ) -> ImportResult<QueryRows> {
        self.query_inner(sql, params, Some(budget), false)
    }
    fn query_inner(
        &mut self,
        sql: &str,
        params: &[Value],
        budget: Option<crate::record_source::QueryBudget>,
        ordered_prefix: bool,
    ) -> ImportResult<QueryRows> {
        self.last_query_timing = QueryTiming::default();
        let start = Instant::now();
        let checked = self.check_source();
        self.last_query_timing.precheck_us = elapsed_us(start);
        checked?;
        let start = Instant::now();
        let result = match budget {
            Some(budget) if ordered_prefix => crate::record_source::query_ordered_prefix_with_budget(
                &self.connection, &self.limits, sql, params, None, budget,
            ),
            Some(budget) => crate::record_source::query_bounded_with_budget(
                &self.connection,
                &self.limits,
                sql,
                params,
                None,
                budget,
            ),
            None => crate::record_source::query_bounded(
                &self.connection,
                &self.limits,
                sql,
                params,
                None,
            ),
        };
        self.last_query_timing.sql_us = elapsed_us(start);
        let start = Instant::now();
        let checked = self.check_source();
        self.last_query_timing.postcheck_us = elapsed_us(start);
        checked?;
        if budget.is_some_and(|budget| Instant::now() >= budget.deadline) {
            return Err(ImportError::Budget(
                "original caller query deadline exhausted",
             crate::cause!()));
        }
        result
    }
    pub fn schema(&mut self) -> ImportResult<QueryRows> {
        self.query(
            "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name",
            &[],
        )
    }
    /// Raw-byte import into a fresh file in a caller-selected Rust data owner.
    /// This preserves encrypted/native KV bytes, not how a running program interprets them.
    /// No overwrites, merge, schema rewriting, keys, session reset or provider call.
    pub fn copy_to_new(&self, destination: impl AsRef<Path>) -> ImportResult<SnapshotCopyReceipt> {
        self.check_source()?;
        let destination = destination.as_ref();
        let parent = fs::canonicalize(destination.parent().ok_or(ImportError::Refused(
            "fresh import needs an existing parent",
         crate::cause!()))?)?;
        if parent.starts_with(&self.source_root) {
            return refuse("fresh import cannot write inside the original state");
        }
        let name = destination
            .file_name()
            .ok_or(ImportError::Refused("fresh import filename is missing", crate::cause!()))?;
        let target = parent.join(name);
        let mut output = This::open(OpenOptions::new().write(true).create_new(true), &target, Open::owner_only(0o600))?;
        let owned = output.metadata()?;
        let result = (|| {
            let (mut input, before) = guarded_file(&self.path)?;
            let mut total = 0u64;
            let mut buffer = [0u8; 64 * 1024];
            let mut hash = blake3::Hasher::new();
            loop {
                let count = input.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                total = total
                    .checked_add(count as u64)
                    .ok_or(ImportError::Refused("fresh import size overflow", crate::cause!()))?;
                if total > self.pin.bytes {
                    return refuse("original source grew during fresh import");
                }
                output.write_all(&buffer[..count])?;
                hash.update(&buffer[..count]);
            }
            output.sync_all()?;
            if total != self.pin.bytes
                || hash.finalize().to_hex().as_str() != self.pin.blake3
                || !unchanged(&before, &input.metadata()?)
            {
                return refuse("fresh import bytes differ from the pinned original");
            }
            self.check_source()?;
            verify_sqlite_file(&target, &self.pin, self.limits.object_bytes)?;
            Ok(SnapshotCopyReceipt {
                binding: self.object.binding.clone(),
                original_id: self.object.original_id.clone(),
                native_descriptor: self.object.descriptor.clone(),
                source_receipt: self.receipt_pin.clone(),
                source_manifest: self.source_manifest.clone(),
                sqlite: self.pin.clone(),
                source_quiescent_sidecars: self.quiescent_sidecars.clone(),
                preserves_original_sql_schema_and_hidden_bytes: true,
                hidden_storage_decoded: false,
                runtime_started: false,
            })
        })();
        drop(output);
        if result.is_err() {
            // Retire only our new file, never a replacement or existing original.
            if let Ok(now) = regular_file(&target) {
                let is_ours = matches!((This::facts(&owned), This::facts(&now)),
                    (Ok(owned), Ok(now)) if owned.device == now.device && owned.inode == now.inode);
                if is_ours {
                    let _ = fs::remove_file(&target);
                }
            }
        }
        result
    }
}

// The generic reader receives bounded SQL only; the original index entry, restore record
// provenance and source continuity remain private to this physical supplier.
impl crate::record_source::BoundedRecordSql for ReadonlyOriginal {
    fn read_limits(&self) -> Option<&ReadLimits> {
        Some(ReadonlyOriginal::read_limits(self))
    }
    fn query(&mut self, sql: &str, params: &[Value]) -> ImportResult<QueryRows> {
        ReadonlyOriginal::query(self, sql, params)
    }
    fn query_with_budget(
        &mut self,
        sql: &str,
        params: &[Value],
        budget: crate::record_source::QueryBudget,
    ) -> ImportResult<QueryRows> {
        ReadonlyOriginal::query_with_budget(self, sql, params, budget)
    }
    fn supports_ordered_prefix(&self) -> bool { true }
    fn query_ordered_prefix_with_budget(&mut self, sql: &str, params: &[Value], budget: crate::record_source::QueryBudget) -> ImportResult<QueryRows> {
        self.query_inner(sql, params, Some(budget), true)
    }
    fn last_query_timing(&self) -> Option<QueryTiming> {
        Some(ReadonlyOriginal::last_query_timing(self))
    }
}

#[cfg(test)]
mod refusal_source_tests {
    use super::*;

    fn first_conversion() -> ImportResult<()> {
        let synthetic: io::Result<()> = Err(io::Error::other("private-source-value"));
        synthetic?; // first import conversion condition
        Ok(())
    }
    fn second_conversion() -> ImportResult<()> {
        let synthetic: io::Result<()> = Err(io::Error::other("private-source-value"));
        synthetic?; // second import conversion condition
        Ok(())
    }

    #[test]
    fn io_conversions_keep_the_question_mark_condition_without_io_values() {
        let first = first_conversion().unwrap_err();
        let second = second_conversion().unwrap_err();
        assert_ne!(first.cause(), second.cause());
        let source = include_str!("import.rs");
        for (error, line_text) in [
            (first, "synthetic?; // first import conversion condition"),
            (second, "synthetic?; // second import conversion condition"),
        ] {
            let source_line = source.lines().position(|line| line.trim() == line_text).unwrap() + 1;
            assert_eq!(error.cause().file(), "src/import.rs");
            assert_eq!(error.cause().line() as usize, source_line);
            assert!(error.to_string().contains(&error.cause().id()));
            assert!(!error.to_string().contains("private-source-value"));
            assert!(!format!("{error:?}").contains("private-source-value"));
        }
    }
}
