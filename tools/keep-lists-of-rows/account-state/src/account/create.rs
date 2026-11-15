// src/account/create.rs
//
// Purpose: Create a brand-new account at a computer. The account gets a random internal owner id and user id, and its own
// signing key (src/account/computers.rs `AccountKey`), whose public key gives the account its address: the name its
// credentials carry and the forwarder sends by. The computer's state folder gets the restore file and object index the
// account opener reads, the secrets key sealed to the computer's own key (src/secrets/root.rs), the signing key kept
// as a secret in the account's vault (sealed under that root), the account's own rows database (src/account/rows) holding
// its starting rows from the making computer's config `new_accounts` (its copies row and copy rules row; the public key
// becomes the account's own row there at the first start), the account's own records store, empty and ready (no old engine to copy from),
// and the account's own files store, empty with its home binding (src/account_files/bind.rs `make_new`). No email, no import,
// no old formats.
//
// Non-Negotiable Invariants:
// - The owner id and user id are random; the address is derived from the account's public key (`computers::address_of`).
//   Nothing in an id names the computer, the machine or the person.
// - The restore file is written last. Until it exists, the folder is not an account, so a half-made folder never
//   opens as one.
// - An existing folder that holds anything is refused. An account is never created over another.
// - The root is sealed to the computer key before the restore file names the account. The root, the computer key and any
//   sealed byte are never printed, logged or put in an error.
//
// Key Concepts:
// - `create_account(state_root, computer, rows)`: makes the folder and its files, and answers what the opener needs
//   (`SelectedLocalState`).
// - `command`: the CLI line `trillion-local account create <computer-config>`. It reads the computer config the computer entry
//   reads (src/native_entry/computer.rs) and makes the new account in a folder named by its owner id inside the config's
//   `accounts` folder, sealed to the config's `place_key_file`, with the free-space floor of the config's `report`.
// - Names, sizes and starting values are DATA in `create.json`.

use crate::{
    account::computers,
    secrets::secrets_key::{self, ComputerKey},
    local_account::{SelectedLocalState, EXISTING_APP_KV_STORE},
};
use content_crypto::advanced::blake3;
use ring::rand::{SecureRandom, SystemRandom};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fmt, fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

/// The names, sizes and starting values of a new account, as DATA in `create.json`.
#[derive(Deserialize)]
struct Settings {
    receipt_file: String,
    index_file: String,
    policy_file: String,
    app_kv_file: String,
    session_file: String,
    records_file: String,
    records_name_prefix: String,
    records_generation: i64,
    id_bytes: usize,
    user_prefix: String,
    policy_source: Value,
    account_policy: Value,
}

fn settings() -> Result<Settings, Error> {
    serde_json::from_slice(include_bytes!("create.json")).map_err(|error| crate::carry_cause!(Error::Settings, error))
}


/// Why an account was not created. No variant carries an id, a key or the contents of a file.
#[derive(Debug)]
pub enum Error {
    /// The state folder already holds something.
    NotEmpty(crate::refusal_cause::Cause),
    /// The computer config is missing or unreadable, or not the config shape.
    Config(&'static str, crate::refusal_cause::Cause),
    /// The settings DATA is unreadable.
    Settings(crate::refusal_cause::Cause),
    /// A file or database could not be written.
    Write(&'static str, crate::refusal_cause::Cause),
    /// The secrets key could not be made or sealed.
    Root(crate::secrets::Error, crate::refusal_cause::Cause),
    /// The operating system's random source did not answer.
    Random(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::NotEmpty(cause) => cause,
            Self::Config(_, cause) => cause,
            Self::Settings(cause) => cause,
            Self::Write(_, cause) => cause,
            Self::Root(error, _) => error.cause_ref(),
            Self::Random(cause) => cause,
        }
    }
}
crate::impl_caused!(Error);


impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotEmpty(_) => write!(f, "the state folder already holds files; an account is not created over them"),
            Self::Config(why, _) => write!(f, "the computer config is not usable: {why}"),
            Self::Settings(_) => write!(f, "the account creation settings are unreadable"),
            Self::Write(why, _) => write!(f, "the account could not be written: {why}"),
            Self::Root(error, _) => write!(f, "{error}"),
            Self::Random(_) => write!(f, "the operating system's random source did not answer"),
        }?;
        write!(f, "; cause={}", self.cause())
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

/// A new account as made: its ids and the selection the account opener takes.
pub struct Created {
    pub selection: SelectedLocalState,
    pub user_id: String,
    pub owner_id: String,
    /// The account's address (`computers::address_of` its signing key).
    pub address: String,
}

fn random_hex(bytes: usize) -> Result<String, Error> {
    let mut random = Zeroizing::new(vec![0u8; bytes]);
    SystemRandom::new().fill(&mut random).map_err(|error| crate::carry_cause!(Error::Random, error))?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Make a new account in `state_root` (created if absent; it must hold nothing), sealed to `computer`, with `rows` as its
/// starting rows (the making computer's starting rows, src/account/rows.rs `StartingRows`).
pub fn create_account(state_root: &Path, computer: &ComputerKey, rows: &crate::account::rows::StartingRows)
    -> Result<Created, Error> {
    let settings = settings()?;
    fs::create_dir_all(state_root).map_err(|_| Error::Write("the state folder could not be made", crate::cause!()))?;
    let mut entries = fs::read_dir(state_root).map_err(|_| Error::Write("the state folder could not be read", crate::cause!()))?;
    if entries.next().is_some() {
        return Err(crate::cause!(Error::NotEmpty));
    }
    let account_key = computers::AccountKey::generate().map_err(|error| crate::carry_cause!(Error::Random, error))?;
    let owner_id = random_hex(settings.id_bytes)?;
    let user_id = format!("{}{}", settings.user_prefix, random_hex(settings.id_bytes)?);
    let root = secrets_key::generate().map_err(|value| Error::Root(value, crate::cause!()))?;
    let identity = secrets_key::key_identity(&root).map_err(|value| Error::Root(value, crate::cause!()))?;
    secrets_key::write_sealed(state_root, &root, computer).map_err(|value| Error::Root(value, crate::cause!()))?;
    write_policy(state_root, &settings, &user_id)?;
    write_app_kv(state_root, &settings, &user_id, &identity)?;
    write_file(&state_root.join(&settings.session_file), &random_hex(settings.id_bytes)?)?;
    // The signing key is kept in the account's vault, sealed under the root, and read back from it: the key the
    // account signs with is the one its vault keeps.
    let vault = crate::secrets::open_with_secrets_key(state_root, &owner_id, &root).map_err(|value| Error::Root(value, crate::cause!()))?;
    vault.create_if_absent(&computers::settings().signing_key_value, account_key.secret_text()).map_err(|value| Error::Root(value, crate::cause!()))?;
    let kept = computers::kept_account_key(&vault).map_err(|value| Error::Write(value.code, value.cause()))?;
    if kept.public_key() != account_key.public_key() {
        return Err(Error::Write("the vault did not keep the account's signing key", crate::cause!()));
    }
    let address = kept.address();
    // The account's own rows database; the account's public key becomes its row there at the account's first start.
    // The account's starting rows are its own from here on: written once, before the restore file names it.
    let account_rows = crate::account::rows::open(state_root).map_err(|value| Error::Write("the account rows database could not be made", crate::refusal_cause::Caused::cause(&value)))?;
    rows.write_missing(&*account_rows, &user_id).map_err(|_| Error::Write("the account's starting rows could not be written", crate::cause!()))?;
    // The computer that creates the account is its first holder: its kind row is written here (`making_kind`), so its first
    // computers row is not refused as a computer no kind allows (`computers::answer_allowed`).
    let making = computers::ComputerSigner::of(computer).map_err(|error| Error::Write("the making computer's id could not be read", error.cause()))?;
    let kinds = crate::account::rows::store::Store::new(&*account_rows);
    computers::ensure_kind(&kinds, &user_id, &making.computer_id(), &computers::settings().host_kinds.making_kind)
        .map_err(|error| Error::Write("the making computer's host kind could not be written", error.cause()))?;
    drop(account_rows);
    let records_binding = write_records(state_root, &settings, &owner_id)?;
    // The account's own files store, made with its records store (src/account_files/bind.rs `make_new`): before, a new
    // account answered its files unavailable (`no_store_file`) until a store was installed by hand.
    // With the making computer's byte store (`rows.files`), its first origin too: bound, its secret in the vault.
    crate::account_files::bind::make_new(state_root, &owner_id, rows.files.as_ref().map(|files| (files, &vault)))
        .map_err(|_| Error::Write("the own files store could not be made", crate::cause!()))?;
    write_receipt(state_root, &settings, &user_id, &owner_id, &records_binding)?;
    let receipt = fs::read(state_root.join(&settings.receipt_file)).map_err(|_| Error::Write("the receipt could not be read", crate::cause!()))?;
    Ok(Created {
        selection: SelectedLocalState {
            root: state_root.to_owned(),
            receipt: crate::import::FilePin { bytes: receipt.len() as u64, blake3: blake3::hash(&receipt).to_hex().to_string() },
            app_kv_sqlite: PathBuf::from(&settings.app_kv_file),
            app_kv_store: EXISTING_APP_KV_STORE.into(),
            prior_processes: vec![],
        },
        user_id,
        owner_id,
        address,
    })
}

/// The name start of a folder an account is being made in, before it is named by its owner id. Such a folder is never an
/// account: a computer removes the ones a stopped sign-up left (`native_entry::computer`).
pub const UNFINISHED_PREFIX: &str = ".new-";

/// Make a new account in a folder named by its owner id inside `accounts` (the computer's accounts folder), sealed to
/// `computer`. The owner id names the folder, so it is known only once the account key is made: the account is made in a
/// fresh `.new-` folder beside the others, then the folder is given its name. The restore file is written last inside it, so
/// a half-made account never opens, under either name. Used by the command line and by a computer's sign-up.
pub fn create_named(accounts: &Path, computer: &ComputerKey, rows: &crate::account::rows::StartingRows)
    -> Result<Created, Error> {
    let making = accounts.join(format!("{UNFINISHED_PREFIX}{}", random_hex(8)?));
    let created = create_account(&making, computer, rows)?;
    let named = accounts.join(&created.owner_id);
    fs::rename(&making, &named).map_err(|_| Error::Write("the account folder could not be named", crate::cause!()))?;
    Ok(created)
}

/// The account's own records store, empty and ready: a record store in `records_file` whose own-records position is
/// already finished, as a new own-work store is made (`OwnRecords::initialize_new_work_store`). Answers the object
/// binding the account opener finds it by (the own-records resource's placement, src/storage/record_store_resources.json).
fn write_records(state_root: &Path, settings: &Settings, owner_id: &str) -> Result<String, Error> {
    use crate::storage::record_store_resources::{self, FileOf};
    let binding = match record_store_resources::placement(crate::local_account::own_records::RESOURCE).map(|placement| &placement.file) {
        Some(FileOf::Object(binding)) => binding.clone(),
        _ => return Err(crate::cause!(Error::Settings)),
    };
    let path = state_root.join(&settings.records_file);
    let mut store = record_store_resources::open(&path, crate::sqlite_work::WorkMeter::new())
        .map_err(|error| Error::Write("the own records store could not be made", error.cause()))?;
    crate::local_account::own_records::OwnRecords::initialize_new_work_store(&mut store, owner_id, settings.records_generation)
        .map_err(|error| Error::Write("the own records store could not be made ready", error.cause()))?;
    Ok(binding)
}

fn write_file(path: &Path, text: &str) -> Result<(), Error> {
    use crate::tool_runs::os::{Open, OwnerFiles, This};
    let mut file = This::open(fs::OpenOptions::new().write(true).create_new(true), &path, Open::owner_only(0o600))
        .map_err(|_| Error::Write("a file could not be created", crate::cause!()))?;
    file.write_all(text.as_bytes()).and_then(|()| file.sync_all()).map_err(|_| Error::Write("a file could not be written", crate::cause!()))
}

/// The policy database: the account's policy parts, which the opener reads from `policy-source:account`.
fn write_policy(state_root: &Path, settings: &Settings, user_id: &str) -> Result<(), Error> {
    // This is an original fresh account, never an imported policy. Bind its
    // canonical management owner before the restore receipt can publish it.
    let mut policy = settings.account_policy.clone();
    let fields = policy.as_object_mut().ok_or(crate::cause!(Error::Settings))?;
    let controls = fields.entry("account_controls").or_insert_with(|| json!({}));
    controls.as_object_mut().ok_or(crate::cause!(Error::Settings))?.insert("owner_user_id".into(), json!(user_id));
    let db = Connection::open(state_root.join(&settings.policy_file)).map_err(|_| Error::Write("the policy database could not be made", crate::cause!()))?;
    db.execute_batch("CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL);")
        .map_err(|_| Error::Write("the policy database could not be made", crate::cause!()))?;
    for (name, value) in [
        ("revision", json!(1)),
        ("policy-source", settings.policy_source.clone()),
        ("policy-source:account", policy),
    ] {
        db.execute("INSERT INTO policy_directory VALUES(?,?)", [name, &value.to_string()])
            .map_err(|_| Error::Write("the policy database could not be filled", crate::cause!()))?;
    }
    Ok(())
}

/// The app key-value database: the account key's identity rows, as the Mac enrollment writes them, and their blobs.
/// The folder the app key-value blobs of the account in `state_root` are kept in.
fn kv_blobs(state_root: &Path) -> PathBuf {
    state_root.join("storage/kv").join(EXISTING_APP_KV_STORE).join("blobs")
}

fn write_app_kv(state_root: &Path, settings: &Settings, user_id: &str, identity: &str) -> Result<(), Error> {
    let blobs = kv_blobs(state_root);
    fs::create_dir_all(&blobs).map_err(|_| Error::Write("the app key-value folder could not be made", crate::cause!()))?;
    let created_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| Error::Write("the clock is before 1970", crate::cause!()))?.as_millis() as u64;
    let db = Connection::open(state_root.join(&settings.app_kv_file)).map_err(|_| Error::Write("the app key-value database could not be made", crate::cause!()))?;
    db.execute_batch("CREATE TABLE _mf_entries(key TEXT PRIMARY KEY,blob_id TEXT NOT NULL,expiration INTEGER);")
        .map_err(|_| Error::Write("the app key-value database could not be made", crate::cause!()))?;
    for (name, blob, value) in [
        (format!("personal-key:{identity}"), "personal", json!({"userId": user_id, "created_ms": created_ms})),
        (format!("user-key:{user_id}:{identity}"), "user", json!({"created_ms": created_ms})),
    ] {
        db.execute("INSERT INTO _mf_entries(key,blob_id) VALUES(?,?)", [&name, blob])
            .map_err(|_| Error::Write("the app key-value row could not be written", crate::cause!()))?;
        write_file(&blobs.join(blob), &value.to_string())?;
    }
    Ok(())
}

/// The rows of the stores an account's routes open besides its records, vault and own rows (they travel to every
/// computer of the account that may answer as records of the writer's feed, src/account/computers/account_stores.rs):
/// the account policy's
/// directory rows, and the app key-value entries with their blobs. The browser session key is each computer's own and
/// never travels.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountStores {
    /// `policy_directory` rows: name and value (JSON text).
    pub policy: Vec<(String, String)>,
    /// `_mf_entries` rows: key, blob id, expiration, and the blob's text.
    pub kv: Vec<KvEntry>,
}

/// One app key-value entry and its blob.
#[derive(Clone, Debug, PartialEq, serde::Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KvEntry {
    pub key: String,
    pub blob_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expiration: Option<i64>,
    pub blob: String,
}

/// One app key-value entry's index row: the key, the blob that holds its bytes, and that blob's file as it is now (its size
/// and change time; `None` when it is not there). A put makes a new blob, or replaces the bytes under the same id
/// (`apply_account_stores` writes a blob beside and renames it over), and either shows in the row or in the file's mark,
/// so the same row at two times names the same bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KvRow {
    pub key: String,
    pub blob_id: String,
    pub expiration: Option<i64>,
    pub blob_mark: Option<(u64, std::time::SystemTime)>,
}

/// The rows of the account stores with no blob read: what a step compares to find what changed (`read_account_store_rows`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountStoreRows {
    pub policy: Vec<(String, String)>,
    pub kv: Vec<KvRow>,
}

fn unreadable(source: &rusqlite::Error) -> Error {
    Error::Write("an account store could not be read", crate::refusal_cause::Caused::stored_cause(source).unwrap_or_else(|| crate::cause!(condition: Error::Write)))
}

/// The policy rows and the key-value index rows of the account in `state_root` (its policy database at `policy_file`),
/// with no blob read. Read only.
pub fn read_account_store_rows(state_root: &Path, policy_file: &Path) -> Result<AccountStoreRows, Error> {
    let settings = settings()?;
    let open = |path: PathBuf| Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|source| unreadable(&source));
    let policy_db = open(state_root.join(policy_file))?;
    let mut statement = policy_db.prepare("SELECT name, value FROM policy_directory ORDER BY name").map_err(|source| unreadable(&source))?;
    let policy = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(|source| unreadable(&source))?
        .collect::<Result<Vec<_>, _>>().map_err(|source| unreadable(&source))?;
    let kv_db = open(state_root.join(&settings.app_kv_file))?;
    let mut statement = kv_db.prepare("SELECT key, blob_id, expiration FROM _mf_entries ORDER BY key").map_err(|source| unreadable(&source))?;
    let mut kv = statement.query_map([], |row| Ok(KvRow { key: row.get(0)?, blob_id: row.get(1)?, expiration: row.get(2)?, blob_mark: None })).map_err(|source| unreadable(&source))?
        .collect::<Result<Vec<_>, _>>().map_err(|source| unreadable(&source))?;
    let blobs = kv_blobs(state_root);
    for row in &mut kv {
        row.blob_mark = blob_file(&blobs, &row.blob_id).and_then(|file| fs::metadata(file).ok())
            .and_then(|meta| meta.modified().ok().map(|changed| (meta.len(), changed)));
    }
    Ok(AccountStoreRows { policy, kv })
}

/// The file of the key-value blob `blob_id` in the blob folder `blobs`; `None` when the id is not a file name.
fn blob_file(blobs: &Path, blob_id: &str) -> Option<PathBuf> {
    Path::new(blob_id).components().all(|part| matches!(part, std::path::Component::Normal(_))).then(|| blobs.join(blob_id))
}

/// The text of the key-value blob `blob_id` of the account in `state_root`.
pub fn read_kv_blob(state_root: &Path, blob_id: &str) -> Result<String, Error> {
    let file = blob_file(&kv_blobs(state_root), blob_id).ok_or_else(|| Error::Write("a key-value blob id is not a file name", crate::cause!()))?;
    fs::read_to_string(file).map_err(|_| Error::Write("a key-value blob could not be read", crate::cause!()))
}

/// Where the account stores last changed, by their files: the size and change time of the policy database and the app
/// key-value database, each with its write-ahead log (a file that is not there is `None`). Every row change of either
/// store changes one of these files, so two equal answers mean no row changed between them, and a stat of four files
/// replaces a read of every row. Taken before the rows are read, so a change made while they are read shows at the next.
pub fn account_stores_marks(state_root: &Path, policy_file: &Path) -> Vec<Option<(u64, std::time::SystemTime)>> {
    let Ok(settings) = settings() else { return Vec::new() };
    let mark = |file: PathBuf| fs::metadata(file).ok().and_then(|meta| meta.modified().ok().map(|changed| (meta.len(), changed)));
    [state_root.join(policy_file), state_root.join(&settings.app_kv_file)].into_iter()
        .flat_map(|file| {
            let mut log = file.clone().into_os_string();
            log.push("-wal");
            [file, PathBuf::from(log)]
        })
        .map(mark)
        .collect()
}

/// The rows of the stores the account's routes open besides its records, vault and own rows, read from the account
/// in `state_root` (its policy database at `policy_file`, the file its object index names, and its app key-value
/// database and blobs), which the account's writer writes as records (src/account/computers/account_stores.rs).
/// Read only; the browser session key is this computer's own and is not read. More than `most_bytes` of rows is refused.
pub fn read_account_stores(state_root: &Path, policy_file: &Path, most_bytes: usize) -> Result<AccountStores, Error> {
    let rows = read_account_store_rows(state_root, policy_file)?;
    let mut size = 0usize;
    let mut count = |text: &str| -> Result<(), Error> {
        size = size.saturating_add(text.len());
        if size > most_bytes { Err(Error::Write("the account stores are larger than one answer carries", crate::cause!())) } else { Ok(()) }
    };
    for (name, value) in &rows.policy {
        count(name)?;
        count(value)?;
    }
    let mut kv = Vec::with_capacity(rows.kv.len());
    for KvRow { key, blob_id, expiration, .. } in rows.kv {
        let blob = read_kv_blob(state_root, &blob_id)?;
        count(&key)?;
        count(&blob)?;
        kv.push(KvEntry { key, blob_id, expiration, blob });
    }
    Ok(AccountStores { policy: rows.policy, kv })
}

/// The rows of the account stores a computer keeps for itself and that never travel (src/account/computers/settings.json
/// `account_stores`): the policy names and app key-value keys that start with one of these.
#[derive(Clone, Debug, Default)]
pub struct KeptHere<'a> {
    pub policy: &'a [String],
    pub kv: &'a [String],
}

impl KeptHere<'_> {
    fn policy(&self, name: &str) -> bool {
        self.policy.iter().any(|prefix| name.starts_with(prefix.as_str()))
    }
    fn kv(&self, key: &str) -> bool {
        self.kv.iter().any(|prefix| key.starts_with(prefix.as_str()))
    }
}

/// Make the stores the account's routes open in `state_root` hold `stores`, as a new account's are made (`write_policy`,
/// `write_app_kv`), made first when absent: the policy database at `policy_file`, the app key-value database and its
/// blobs, and a browser session key of this computer's own (only when it has none). Every row of `stores` is written
/// (inserted, or its value replaced when it differs), and every row not in `stores` is removed, except the rows this
/// computer keeps for itself (`kept_here`), which are never touched. Each database changes in one transaction. A blob is
/// written new (beside, then renamed over) only when it is absent or holds other bytes. Answers how many rows changed.
/// The computer that may answer an account writes its stores this way from the account's records
/// (src/account/computers/account_stores.rs), so a change at the writer reaches it through the writer's feed.
pub fn apply_account_stores(state_root: &Path, policy_file: &Path, stores: &AccountStores, kept_here: &KeptHere<'_>) -> Result<usize, Error> {
    let settings = settings()?;

    let mut changed = 0usize;
    let mut db = Connection::open(with_folder(state_root, policy_file)?).map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?;
    db.busy_timeout(std::time::Duration::from_secs(5)).map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL);").map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?;
    {
        let held: Vec<String> = {
            let mut statement = tx.prepare("SELECT name FROM policy_directory").map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?;
            let names = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?;
            names.collect::<Result<_, _>>().map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?
        };
        let given: std::collections::HashSet<&str> = stores.policy.iter().map(|(name, _)| name.as_str()).collect();
        for name in held.iter().filter(|name| !kept_here.policy(name) && !given.contains(name.as_str())) {
            changed += tx.execute("DELETE FROM policy_directory WHERE name=?", [name]).map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?;
        }
        for (name, value) in stores.policy.iter().filter(|(name, _)| !kept_here.policy(name)) {
            changed += tx.execute("INSERT INTO policy_directory VALUES(?1,?2) ON CONFLICT(name) DO UPDATE SET value=excluded.value \
                WHERE value IS NOT excluded.value", [name, value]).map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?;
        }
    }
    tx.commit().map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?;
    drop(db);
    let blobs = kv_blobs(state_root);
    fs::create_dir_all(&blobs).map_err(|_| Error::Write("the app key-value folder could not be made", crate::cause!()))?;
    for entry in &stores.kv {
        if !Path::new(&entry.blob_id).components().all(|part| matches!(part, std::path::Component::Normal(_))) {
            return Err(Error::Write("a key-value blob id is not a file name", crate::cause!()));
        }
        let blob = blobs.join(&entry.blob_id);
        if fs::read(&blob).ok().as_deref() != Some(entry.blob.as_bytes()) {
            let beside = blobs.join(format!(".{}.new", entry.blob_id));
            let _ = fs::remove_file(&beside);
            write_file(&beside, &entry.blob)?;
            fs::rename(&beside, &blob).map_err(|_| Error::Write("a key-value blob could not be written", crate::cause!()))?;
        }
    }
    let mut db = Connection::open(state_root.join(&settings.app_kv_file)).map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?;
    db.busy_timeout(std::time::Duration::from_secs(5)).map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS _mf_entries(key TEXT PRIMARY KEY,blob_id TEXT NOT NULL,expiration INTEGER);").map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?;
    {
        let held: Vec<String> = {
            let mut statement = tx.prepare("SELECT key FROM _mf_entries").map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?;
            let keys = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?;
            keys.collect::<Result<_, _>>().map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?
        };
        let given: std::collections::HashSet<&str> = stores.kv.iter().map(|entry| entry.key.as_str()).collect();
        for key in held.iter().filter(|key| !kept_here.kv(key) && !given.contains(key.as_str())) {
            changed += tx.execute("DELETE FROM _mf_entries WHERE key=?", [key]).map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?;
        }
        for entry in stores.kv.iter().filter(|entry| !kept_here.kv(&entry.key)) {
            changed += tx.execute("INSERT INTO _mf_entries(key,blob_id,expiration) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE \
                SET blob_id=excluded.blob_id, expiration=excluded.expiration \
                WHERE blob_id IS NOT excluded.blob_id OR expiration IS NOT excluded.expiration",
                rusqlite::params![entry.key, entry.blob_id, entry.expiration]).map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?;
        }
    }
    tx.commit().map_err(|_refusal_source| Error::Write("an account store could not be made", crate::refusal_cause::Caused::stored_cause(&_refusal_source).unwrap_or_else(|| crate::cause!(condition: Error::Write))))?;
    let session = state_root.join(&settings.session_file);
    if !session.exists() {
        write_file(&session, &random_hex(settings.id_bytes)?)?;
    }
    Ok(changed)
}

/// The store file `file` (relative) of the account in `state_root`, its folders made first: the object index of an account
/// the Mac app made names its stores in nested folders (`storage/do/trillion-local-<class>/<id>.sqlite`), which a joining
/// computer's new folder does not have yet (measured 2026-11-05, record:findings:place-copies-blocked-2026-11-05).
fn with_folder(state_root: &Path, file: &Path) -> Result<PathBuf, Error> {
    let path = state_root.join(file);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| Error::Write("an account store's folder could not be made", crate::cause!()))?;
    }
    Ok(path)
}

/// Whether the account in `state_root` has its policy database at `policy_file` with at least one row: the stores its
/// account routes open are there.
pub fn account_stores_held(state_root: &Path, policy_file: &Path) -> bool {
    let path = state_root.join(policy_file);
    if !path.exists() {
        return false;
    }
    Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|db| db.query_row("SELECT COUNT(*) FROM policy_directory", [], |row| row.get::<_, i64>(0)))
        .is_ok_and(|count| count > 0)
}

/// Make the account's own records store in `state_root` empty and ready, as a new account's is (`write_records`), at the
/// path its object index names (`records_file`, relative). A computer that joins an account by itself and may answer
/// it does this before its copies follow the writer's records.
pub fn write_ready_records(state_root: &Path, records_file: &Path, owner_id: &str) -> Result<(), Error> {
    let settings = settings()?;
    let mut store = crate::storage::record_store_resources::open(&with_folder(state_root, records_file)?, crate::sqlite_work::WorkMeter::new())
        .map_err(|error| Error::Write("the own records store could not be made", error.cause()))?;
    crate::local_account::own_records::OwnRecords::initialize_new_work_store(&mut store, owner_id, settings.records_generation)
        .map_err(|error| Error::Write("the own records store could not be made ready", error.cause()))
}

/// Make the own records store of a computer that kept only a copy of the account and is now let answer it ready, with the
/// records its copies already hold (`OwnRecords::initialize_copied_work_store`), at the path its object index names
/// (`records_file`, relative). A store that already has a position is left as it is.
pub fn make_copied_records_ready(state_root: &Path, records_file: &Path, owner_id: &str) -> Result<(), Error> {
    let settings = settings()?;
    let mut store = crate::storage::record_store_resources::open(&with_folder(state_root, records_file)?, crate::sqlite_work::WorkMeter::new())
        .map_err(|error| Error::Write("the own records store could not be opened", error.cause()))?;
    crate::local_account::own_records::OwnRecords::initialize_copied_work_store(&mut store, owner_id, settings.records_generation)
        .map_err(|error| Error::Write("the own records store could not be made ready", error.cause()))
}

/// The object index (one row: the account control's policy database) and the restore file that names it. Written
/// last, so the folder is an account only once both exist.
fn write_receipt(state_root: &Path, settings: &Settings, user_id: &str, owner_id: &str, records_binding: &str) -> Result<(), Error> {
    let records_name = format!("{}{}", settings.records_name_prefix,
        serde_json::to_string(&[owner_id, crate::account::BROWSER_RESOURCE]).map_err(|error| crate::carry_cause!(Error::Settings, error))?);
    let index = [
        json!({
            "binding": "ACCOUNT_CONTROL",
            "originalId": random_hex(settings.id_bytes)?,
            "names": [format!("policy:{owner_id}")],
            "sqlite": settings.policy_file,
        }),
        json!({
            "binding": records_binding,
            "originalId": random_hex(settings.id_bytes)?,
            "names": [records_name],
            "sqlite": settings.records_file,
        }),
    ]
    .iter()
    .map(|row| row.to_string())
    .collect::<Vec<_>>()
    .join("\n");
    write_file(&state_root.join(&settings.index_file), &index)?;
    let receipt = json!({
        "complete": true,
        "account": {"userId": user_id, "ownerId": owner_id},
        "objects": {
            "path": settings.index_file,
            "bytes": index.len(),
            "fileIdentity": blake3::hash(index.as_bytes()).to_hex().as_str(),
            "count": 2,
        },
    })
    .to_string();
    write_file(&state_root.join(&settings.receipt_file), &receipt)
}

/// The address of the account whose folder is `state_root`, read from the signing key its vault keeps, with the secrets key
/// opened by `computer`. Read only: nothing is written and no key is returned.
pub fn address_of_folder(state_root: &Path, computer: &ComputerKey) -> Result<String, Error> {
    let owner_id = state_root.file_name().and_then(|name| name.to_str()).ok_or(Error::Config("the account folder has no owner id name", crate::cause!()))?;
    let root = secrets_key::open_sealed_with(state_root, computer).map_err(|value| Error::Root(value, crate::cause!()))?;
    let vault = crate::secrets::open_with_secrets_key(state_root, owner_id, &root).map_err(|value| Error::Root(value, crate::cause!()))?;
    let kept = computers::kept_account_key(&vault).map_err(|value| Error::Write(value.code, value.cause()))?;
    Ok(kept.address())
}

/// `account create <computer-config>`: make a new account at the computer the config names (src/native_entry/computer.rs), in
/// a folder named by its owner id inside the config's `accounts` folder, and print its user id, owner id and address.
/// `account address <computer-config> <owner-id>`: print the address of an account the config's `accounts` folder holds.
pub fn command(args: &[String], out: &mut dyn Write) -> Result<(), Box<dyn std::error::Error>> {
    if let [verb, config, owner] = args {
        if verb == "address" {
            let config = crate::native_entry::computer::read_config(Path::new(config)).map_err(|error| Error::Config("it is not the computer config", error.cause()))?;
            let computer = ComputerKey::read(&config.computer_key_file).map_err(|value| Error::Root(value, crate::cause!()))?;
            let address = address_of_folder(&config.accounts.join(owner), &computer)?;
            crate::io_operation!(writeln!(out, "address {address}"))?;
            return Ok(());
        }
    }
    let config = match args {
        [verb, config] if verb == "create" => config,
        _ => return Err(crate::refusal_cause::CodedError::new("usage: trillion-local account create COMPUTER_CONFIG | account address COMPUTER_CONFIG OWNER_ID").into()),
    };
    let config = crate::native_entry::computer::read_config(Path::new(config)).map_err(|error| Error::Config("it is not the computer config", error.cause()))?;
    if computers::choose_this_computer(config.report.clone()).is_err() && computers::this_computer() != &config.report {
        return Err(Error::Config("this process already reports another computer", crate::cause!()).into());
    }
    crate::account::rows::choose_computer(config.sign_in.clone())
        .map_err(|error| Error::Config("this process already has other sign-in values", error.cause()))?;
    let computer = ComputerKey::read(&config.computer_key_file).map_err(|value| Error::Root(value, crate::cause!()))?;
    let starting = config.new_accounts.as_ref().ok_or(Error::Config("the computer config has no new_accounts", crate::cause!()))?;
    let created = create_named(&config.accounts, &computer, starting)?;
    crate::io_operation!(writeln!(out, "created account {} owner {} address {}", created.user_id, created.owner_id, created.address))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_account::LocalAccount;
    use base64::Engine as _;

    fn computer_key(byte: u8) -> ComputerKey {
        ComputerKey::from_bytes(vec![byte; 32]).unwrap()
    }

    #[test]
    fn a_new_account_names_no_computer_seals_its_root_and_refuses_a_second_create() {
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("state");
        let created = create_account(&state, &computer_key(7), &crate::account::rows::StartingRows::for_tests()).unwrap();
        assert!(created.user_id.starts_with("account-") && created.user_id.len() == 8 + 64);
        assert_eq!(created.owner_id.len(), 64);
        // The address is the one the account's own key names, the vault keeps that key, and the owner id is its own.
        let root = secrets_key::open(&fs::read(state.join("account-root.sealed")).unwrap(), &computer_key(7)).unwrap();
        let vault = crate::secrets::open_with_secrets_key(&state, &created.owner_id, &root).unwrap();
        assert_eq!(computers::kept_account_key(&vault).unwrap().address(), created.address);
        assert_ne!(created.owner_id, created.address);

        for name in ["restore-receipt.json", "objects.jsonl", "policy.sqlite", "records.sqlite", "current-kv.sqlite", "browser-session.key", "account-root.sealed", "sign-in.sqlite"] {
            assert!(state.join(name).exists(), "{name} is missing");
        }
        assert!(matches!(create_account(&state, &computer_key(7), &crate::account::rows::StartingRows::for_tests()), Err(Error::NotEmpty(_))));
    }

    #[test]
    fn an_account_address_reads_back_from_its_folder_with_the_computer_key_only() {
        let temp = tempfile::tempdir().unwrap();
        let accounts = temp.path().join("accounts");
        let created = create_named(&accounts, &computer_key(7), &crate::account::rows::StartingRows::for_tests()).unwrap();
        let folder = accounts.join(&created.owner_id);
        assert_eq!(address_of_folder(&folder, &computer_key(7)).unwrap(), created.address);
        assert!(address_of_folder(&folder, &computer_key(8)).is_err());
    }

    #[test]
    fn a_created_account_can_enroll_its_native_history_under_its_original_canonical_owner() {
        use crate::{account::{AccountIdentity,NativeAccountOwner},account_rights::resource_connection::{self,NativeChange},storage::record_store_resources::domains::Identity};
        use std::{sync::{Arc,atomic::AtomicBool},time::{Duration,Instant}};
        let parent=fs::canonicalize(std::env::temp_dir()).unwrap();
        let temp=tempfile::tempdir_in(parent).unwrap();
        let state=temp.path().join("state");
        let created=create_account(&state,&computer_key(7),&crate::account::rows::StartingRows::for_tests()).unwrap();
        let account=AccountIdentity {user_id:created.user_id.clone(),owner_id:created.owner_id.clone()};
        let mut owner=LocalAccount::open_selected_after_handoff(created.selection).unwrap();
        let history=Identity {id:"created-history".into(),incarnation:"first".into(),generation:1};
        let mut current=|held:&mut LocalAccount| {
            if NativeAccountOwner::account(held)!=account {return Err(crate::cause!(crate::account::AccountError::SourceChanged));}
            Ok(())
        };
        let cancel=Arc::new(AtomicBool::new(false));let deadline=Instant::now()+Duration::from_secs(10);
        let admitted=owner.change_native_domain_authority(&history,&NativeChange::Enroll {request_key:"created-enrollment".into()},cancel.clone(),deadline,&mut current,None).unwrap();
        let readback=owner.native_domain_authority(&history,cancel,deadline,&mut current).unwrap();
        assert_eq!(readback.registration(),admitted.registration());
        assert_eq!(admitted.registration().history,history);
        assert_eq!(admitted.registration().revision,1);
        let db=crate::storage::sqlite::open_owned(&state.join("policy.sqlite"),"account_policy",crate::storage::record_store_resources::bounds()).unwrap();
        let other=AccountIdentity {user_id:"another-created-user".into(),owner_id:account.owner_id.clone()};
        assert_eq!(resource_connection::native_observe(&db,&other,&history).unwrap_err(),crate::cause!(crate::account_rights::Error::NotCanonical),
            "created source cannot authorize another user's native history");
    }

    #[test]
    fn the_sealed_root_of_a_new_account_opens_with_its_computer_key_only() {
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("state");
        let keys = temp.path().join("computer.key");
        let key = base64::engine::general_purpose::STANDARD.encode([9u8; 32]);
        fs::write(&keys, &key).unwrap();
        let computer = ComputerKey::read(&keys).unwrap();
        create_account(&state, &computer, &crate::account::rows::StartingRows::for_tests()).unwrap();
        assert!(secrets_key::open_sealed(&state, &keys).is_ok());
        let other = temp.path().join("other.key");
        fs::write(&other, base64::engine::general_purpose::STANDARD.encode([8u8; 32])).unwrap();
        assert!(secrets_key::open_sealed(&state, &other).is_err());
    }

    #[test]
    fn the_new_accounts_receipt_names_the_ids_the_opener_reads() {
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("state");
        let created = create_account(&state, &computer_key(7), &crate::account::rows::StartingRows::for_tests()).unwrap();
        let receipt: Value = serde_json::from_slice(&fs::read(state.join("restore-receipt.json")).unwrap()).unwrap();
        assert_eq!(receipt["complete"], true);
        assert_eq!(receipt["account"]["userId"], created.user_id.as_str());
        assert_eq!(receipt["account"]["ownerId"], created.owner_id.as_str());
        // The account's starting rows are its own, written with it.
        let rows = crate::account::rows::open(&state).unwrap();
        let store = crate::account::rows::store::Store::new(&*rows);
        let starting = crate::account::rows::StartingRows::for_tests();
        let copies = computers::copy_rule::copies_source(&store, &created.user_id).unwrap();
        assert_eq!(copies, computers::copy_rule::Source::Stored(starting.copies), "its copies row");
        let rules = computers::copy_rule::rules_source(&store, &created.user_id).unwrap();
        assert_eq!(rules, computers::copy_rule::Source::Stored(starting.copies_rules), "and its copy rules row");
    }

    /// How far the existing opener gets on a created account on this system. The stop is recorded in the failure
    /// message, which names a step and no bytes.
    #[test]
    fn a_created_account_is_opened_by_the_existing_opener_as_far_as_it_goes() {
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("state");
        let created = create_account(&state, &computer_key(7), &crate::account::rows::StartingRows::for_tests()).unwrap();
        let opened = LocalAccount::open_selected_after_handoff(created.selection);
        assert!(opened.is_ok(), "the existing opener stopped at: {:?}", opened.err());
        // The opener took the account's lock for this process.
        let lock: Value = serde_json::from_slice(&fs::read(state.join("local-runtime.lock")).unwrap()).unwrap();
        assert_eq!(lock["pid"], std::process::id());
    }
}
