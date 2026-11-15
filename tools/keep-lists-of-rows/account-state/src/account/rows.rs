//! The account's own rows that are not records: the computers rows and the account's own lists (its copy rule's rows and
//! runs, its limits row), stored in the account's rows database (`families.json`, schema `sign_in`, its stored name kept so
//! no stored row moves). Sign-in itself is the Better Auth Workshop tool (trillion-workshop tools/better-auth); the engine
//! only checks who is signed in (`super::signed_in`).
//!
//! Files:
//! - `store.rs`  typed rows over the families
//! - `tokens.rs` random text, fingerprints and the address shape

pub(crate) mod store;
pub(crate) mod tokens;

use serde::{Deserialize, Serialize};
use crate::account::computers::UnknownKeys;
use std::sync::OnceLock;

/// The names the rows' files go by in an account's state folder.
#[derive(Debug)]
pub(crate) struct Contract {
    /// The account's rows database, in its state folder.
    pub database_file: String,
    /// Written beside the database at each start, naming the account and origin served, for the command line on this
    /// computer.
    pub door_note_file: String,
}

/// The rows' contract, made once.
pub(crate) fn contract() -> &'static Contract {
    static CONTRACT: OnceLock<Contract> = OnceLock::new();
    CONTRACT.get_or_init(|| Contract { database_file: "sign-in.sqlite".into(), door_note_file: "sign-in-door.json".into() })
}

/// The computer's own sign-in values: needed before an account is known (the body limit of a request), or about the
/// computer rather than an account. A computer takes them from its config (`choose_computer`); the hosting app, which has no
/// computer config yet, from `computers/settings.json` `this_computer_sign_in`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComputerSignIn {
    /// Leading labels of the origin's host the passkey relying party leaves out (`passkeys.rs` `relying_party`): a
    /// passkey made on the parent domain or any of its hosts signs in on every one of them (never fewer than two
    /// labels; an IP address is kept whole).
    pub relying_party_drop_labels: usize,
    /// The largest request body the sign-in routes read.
    pub max_body_bytes: usize,
    /// Most expired rows of one family one write of a new row of that family deletes.
    pub expired_rows_per_write: usize,
    /// Keys this engine does not know: kept, logged once when the config is checked, never refused.
    #[serde(flatten)]
    pub unknown_keys: UnknownKeys,
}

/// This computer's sign-in values when its config leaves them out: the shipped ones (`computers/settings.json`).
pub(crate) fn shipped_computer() -> ComputerSignIn {
    crate::account::computers::settings().this_computer_sign_in.clone()
}

impl ComputerSignIn {
    fn valid(&self) -> bool {
        self.relying_party_drop_labels <= 8 && (1024..=1 << 20).contains(&self.max_body_bytes) && self.expired_rows_per_write <= 10_000
    }
}

static CHOSEN_COMPUTER: OnceLock<ComputerSignIn> = OnceLock::new();

/// Take `values` as this computer's sign-in values for the rest of the process (the computer config's `sign_in`). Only the
/// first choice counts; a second, different one or invalid values are refused.
pub fn choose_computer(values: ComputerSignIn) -> std::result::Result<(), crate::refusal_cause::CodedError<&'static str>> {
    if !values.valid() {
        return Err(crate::refusal_cause::CodedError::new("the computer's sign-in values are refused"));
    }
    if CHOSEN_COMPUTER.get_or_init(|| values.clone()) != &values {
        return Err(crate::refusal_cause::CodedError::new("this process already has other sign-in values"));
    }
    Ok(())
}

/// This computer's sign-in values: the ones chosen at start, or the hosting app's (`computers/settings.json`).
pub(crate) fn computer() -> &'static ComputerSignIn {
    CHOSEN_COMPUTER.get().unwrap_or(&crate::account::computers::settings().this_computer_sign_in)
}

/// The rows an account starts with: its copies row and copy rules row (src/account/computers/copy_rule.rs) and its first
/// files origin. A computer's are its config's `new_accounts`; the hosting app's are its product settings' `new_accounts`.
/// They are written into an account when it is made, never again. A config's sign-in rows from before sign-in moved to the
/// Better Auth tool are kept as unknown keys, never read.
#[derive(Clone, Deserialize, Serialize, Debug, PartialEq)]
pub struct StartingRows {
    /// The account's copies row: the least computers that keep a copy, vote, may answer and are always on.
    #[serde(default = "shipped_copies")]
    pub copies: crate::account::computers::copy_rule::CopySettings,
    /// The account's copy rules row: the `short_by` formula, the trigger rule that reads it and the workflow it starts.
    #[serde(default = "shipped_copies_rules")]
    pub copies_rules: crate::account::computers::copy_rule::CopyRules,
    /// The byte store each account this computer makes gets as its first files origin (src/account_files/bind.rs
    /// `NewAccountFiles`), written once when the account is made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<crate::account_files::bind::NewAccountFiles>,
    /// Keys this engine does not know: kept, logged once when the config is checked, never refused.
    #[serde(flatten)]
    pub unknown_keys: UnknownKeys,
}

/// The shipped starting rows (`rows/new-accounts.json`).
pub(crate) fn shipped() -> &'static StartingRows {
    static SHIPPED: OnceLock<StartingRows> = OnceLock::new();
    SHIPPED.get_or_init(|| serde_json::from_slice(include_bytes!("rows/new-accounts.json")).expect("rows/new-accounts.json is valid"))
}

fn shipped_copies() -> crate::account::computers::copy_rule::CopySettings {
    shipped().copies.clone()
}

fn shipped_copies_rules() -> crate::account::computers::copy_rule::CopyRules {
    shipped().copies_rules.clone()
}

impl StartingRows {
    /// Whether every row holds together.
    pub fn valid(&self) -> bool {
        self.copies.valid() && self.copies_rules.valid() && self.files.as_ref().is_none_or(crate::account_files::bind::NewAccountFiles::valid)
    }

    /// Write each row `account` lacks at creation, once (a compare-and-set at revision 0). Answers how many rows it wrote.
    pub(crate) fn write_missing(&self, storage: &dyn crate::storage::Storage, account: &str) -> Result<usize> {
        let store = store::Store::new(storage);
        crate::account::computers::copy_rule::write_missing(&store, account, &self.copies, &self.copies_rules)
            .map_err(|error| Error::Storage(error.cause()))
    }

    /// At each start: the repair of an older copy rules row.
    pub(crate) fn write_missing_on_open(&self, storage: &dyn crate::storage::Storage, account: &str) -> Result<usize> {
        let store = store::Store::new(storage);
        crate::account::computers::copy_rule::repair_on_open(&store, account, &self.copies_rules)
            .map_err(|error| Error::Storage(error.cause()))
    }

    /// The rows the tests give an account.
    #[cfg(test)]
    pub(crate) fn for_tests() -> Self {
        let (copies, copies_rules) = crate::account::computers::copy_rule::for_tests();
        StartingRows { copies, copies_rules, files: None, unknown_keys: UnknownKeys::new() }
    }
}

/// Every refusal the account's own rows give.
#[derive(Clone, Debug, Eq)]
pub(crate) enum Error {
    /// A stored value is larger than a row holds.
    TooLarge(crate::refusal_cause::Cause),
    /// The selected source explicitly could not qualify a current read.
    /// No row is absent, and no physical storage failure is implied.
    SourceNotCurrent(crate::refusal_cause::Cause),
    /// The storage refused or is unavailable; never a reason to admit.
    Storage(crate::refusal_cause::Cause),
}

impl Error {
    /// The content-free source condition; retained separately from public class equality.
    pub(crate) fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::TooLarge(cause) | Self::Storage(cause) | Self::SourceNotCurrent(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Error);

impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool {
        matches!((self, other), (Self::TooLarge(_), Self::TooLarge(_)) | (Self::Storage(_), Self::Storage(_))
            | (Self::SourceNotCurrent(_), Self::SourceNotCurrent(_)))
    }
}


pub(crate) type Result<T> = std::result::Result<T, Error>;

impl From<crate::storage::Error> for Error {
    fn from(error: crate::storage::Error) -> Self {
        match error {
            crate::storage::Error::NotCurrent(cause) => Error::SourceNotCurrent(cause),
            _ => Error::Storage(error.cause()),
        }
    }
}

/// Milliseconds since the Unix epoch.
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// One storage supply shared by every request: an SQLite handle (or the
/// in-memory supply) is not `Sync`, so each call takes it under one lock. Every
/// sign-in write is a single statement, so no scope spans two calls.
pub(crate) struct Locked<S>(std::sync::Mutex<S>);

impl<S> Locked<S> {
    pub(crate) fn new(storage: S) -> Self {
        Locked(std::sync::Mutex::new(storage))
    }
}

macro_rules! locked {
    ($self:ident) => {
        $self.0.lock().map_err(|error| crate::carry_cause!(crate::storage::Error::Unavailable, error))?
    };
}

impl<S: crate::storage::Storage + Send> crate::storage::Storage for Locked<S> {
    fn schema(&self) -> &'static crate::storage::Schema {
        match self.0.lock() {
            Ok(storage) => storage.schema(),
            Err(poisoned) => poisoned.into_inner().schema(),
        }
    }
    fn get(&self, family: &str, key: &[crate::storage::Value], read: &[crate::storage::Read<'_>]) -> crate::storage::Result<Option<crate::storage::Row>> {
        locked!(self).get(family, key, read)
    }
    fn scan(&self, family: &str, range: &crate::storage::Range<'_>, read: &[crate::storage::Read<'_>]) -> crate::storage::Result<Vec<crate::storage::Row>> {
        locked!(self).scan(family, range, read)
    }
    fn put(&self, family: &str, row: &[(&str, crate::storage::Value)], when: crate::storage::When<'_>) -> crate::storage::Result<u64> {
        locked!(self).put(family, row, when)
    }
    fn count(&self, family: &str, range: &crate::storage::Range<'_>) -> crate::storage::Result<u64> {
        locked!(self).count(family, range)
    }
    fn erase(&self, family: &str, range: &crate::storage::Range<'_>) -> crate::storage::Result<u64> {
        locked!(self).erase(family, range)
    }
    fn present(&self, family: &str) -> crate::storage::Result<bool> {
        locked!(self).present(family)
    }
    fn custody(&self) -> crate::storage::Result<()> {
        locked!(self).custody()
    }
    fn location(&self) -> Option<&str> {
        None
    }
    fn scoped(&self) -> bool {
        self.0.lock().map(|storage| storage.scoped()).unwrap_or(false)
    }
    fn writing(&self) -> crate::storage::Result<bool> {
        locked!(self).writing()
    }
    fn changes(&self) -> u64 {
        self.0.lock().map(|storage| storage.changes()).unwrap_or(0)
    }
    fn mark(&self) -> crate::storage::Result<i64> {
        locked!(self).mark()
    }
    fn schema_mark(&self) -> crate::storage::Result<i64> {
        locked!(self).schema_mark()
    }
    fn allocated_bytes(&self) -> crate::storage::Result<u64> {
        locked!(self).allocated_bytes()
    }
    fn open_scope(&self, intent: crate::storage::Intent) -> crate::storage::Result<()> {
        locked!(self).open_scope(intent)
    }
    fn close_scope(&self, commit: bool) -> crate::storage::Result<()> {
        locked!(self).close_scope(commit)
    }
}

/// One sign-in storage, shared by the sign-in routes and the account routes that admit
/// every request with it, so both see the same keys, grants and sessions.
pub(crate) type Shared = std::sync::Arc<dyn crate::storage::Storage + Send + Sync>;

/// Open (or create) the account's own sign-in database
/// `contract().database_file` in `state_root` (the selected account's state folder).
pub(crate) fn open(state_root: &std::path::Path) -> std::result::Result<Shared, crate::storage::Error> {
    let bounds = crate::storage::sqlite::Bounds {
        value_bytes: 64 * 1024,
        work: 10_000_000,
        deadline: std::time::Duration::from_secs(5),
        spend: crate::storage::sqlite::Spend::EachOperation,
        cancel: None,
        busy: std::time::Duration::from_secs(5),
    };
    // Reused admission handles carry request-local numeric observation too.
    let supply = crate::storage::sqlite::open_owned_observed(&state_root.join(&contract().database_file), "sign_in", bounds,
        crate::sqlite_work::WorkMeter::new())?;
    Ok(std::sync::Arc::new(Locked::new(supply)))
}

/// What the note beside the database says: the account, its address (the name its credentials carry) and the
/// public origin the routes served at their last start. Read by the command line on this computer.
#[derive(Debug, PartialEq, Eq, serde::Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DoorNote {
    pub account: String,
    /// Empty in a note an earlier build wrote, before credentials named the address; what needs it refuses then.
    #[serde(default)]
    pub address: String,
    pub origin: String,
}

/// Write the note for `account` (address `address`) at `origin` in `state_root`. It names no secret; it is
/// replaced in one rename so a reader never sees half of it.
pub(crate) fn write_door_note(state_root: &std::path::Path, account: &str, address: &str, origin: &str) -> std::io::Result<()> {
    let note = crate::io_operation!((serde_json::to_vec(&DoorNote { account: account.to_string(), address: address.to_string(), origin: origin.to_string() })).map_err(std::io::Error::from))?;
    let path = state_root.join(&contract().door_note_file);
    let beside = state_root.join(format!("{}.new", contract().door_note_file));
    crate::io_operation!((std::fs::write(&beside, note)).map_err(std::io::Error::from))?;
    crate::io_operation!(std::fs::rename(&beside, &path))
}
