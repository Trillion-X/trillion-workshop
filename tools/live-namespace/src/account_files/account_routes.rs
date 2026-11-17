// src/account_files/account_routes.rs
//
// Purpose: The person's files as one door. Which address and operations are answered here is product DATA
// (`account-files-routes.json`); each operation is the account files' own tool of that name (`AccountFiles::call`). No file,
// folder or tool is named here. The rows the files keep are the `Store` a call is given (src/store), never opened or made here.
//
// Non-Negotiable Invariants:
// - The door makes no check that lets a call in: who may call is the engine's, which starts this tool for them. A call
//   takes no step once its caller is no longer current (`CallControl`), and its answer fits the message that carries it.
// - Bytes are reached through the account's origin records and the held credential (`secrets::open_home`), so a secret
//   never leaves the run.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{objects::ObjectError, AccountFiles, AccountFilesError};
use crate::store::Store;
use serde::Deserialize;
use serde_json::Value;
use std::{path::Path, sync::OnceLock};

/// What lets a call's bytes in (`source_reads`).
pub type LetIn = super::source_reads::Admission;

/// The declared product DATA file this owner is read from.
const DATA: &[u8] = include_bytes!("account-files-routes.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    resource: String,
    operations: Vec<String>,
    /// The words in the files' names searched with one question (`AccountFiles::search`).
    search: FileSearch,
    #[serde(rename = "_usage")]
    _usage: String,
    /// How the account's own usage counts are kept (`usage.rs`).
    usage: Usage,
    #[serde(rename = "_recent")]
    _recent: String,
    /// The files used most recently (`recent.rs`).
    recent: super::recent::RecentSettings,
    #[serde(rename = "_facts")]
    _facts: String,
    /// The facts kept about each file (`recent.rs` facts).
    facts: super::recent::FactsSettings,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Usage {
    /// How often the flush thread writes counted accounts' day rows.
    flush_seconds: u64,
}

/// How the files' names are searched (account-files-routes.json `search`; old trillion search.json lane `file-names`).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileSearch {
    #[serde(rename = "_what")]
    _what: String,
    /// The account files tool that answers it.
    pub operation: String,
    pub limit: usize,
    pub most: usize,
    pub question_chars: usize,
    pub min_word_length: usize,
    /// Postings asked of the index per word: a word with this many is common and narrows nothing.
    pub word_hits: usize,
    /// Reciprocal rank fusion's k, and this lane's weight in it (old search.json `file-names` rank).
    pub k: f64,
    pub rank: f64,
    pub place: String,
    pub source: String,
    /// What a file's result id starts with (old search.mjs `file:${identity}`).
    pub key_prefix: String,
    /// The account files tool a result's address opens it with.
    pub open: String,
}
impl FileSearch {
    fn valid(&self, operations: &[String]) -> bool {
        operations.contains(&self.operation)
            && operations.contains(&self.open)
            && (1..=self.most).contains(&self.limit)
            && self.question_chars > 0
            && self.min_word_length > 0
            && (1..=crate::store::MAX_PAGE_ITEMS).contains(&self.word_hits)
            && self.k.is_finite()
            && self.k > 0.0
            && self.rank.is_finite()
            && self.rank > 0.0
            && ![&self.place, &self.source, &self.key_prefix]
                .iter()
                .any(|text| text.is_empty())
    }
}

/// The most characters of an open step's reason that the refusal carries.
const MOST_REASON_CHARS: usize = 200;

/// An open step's own error text (an error code: never a value or a key), cut short.
fn why(error: &dyn std::fmt::Debug) -> String {
    format!("{error:?}").chars().take(MOST_REASON_CHARS).collect()
}

/// Which step of opening the account's files failed, so a refusal says where, not only that.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// The held credential could not be opened, with the error it gave.
    Vault(String),
}
impl Step {
    /// The step's name and the reason it gave, as the refusal's detail.
    pub fn detail(&self) -> Value {
        let Step::Vault(reason) = self;
        serde_json::json!({ "step": "vault_open", "reason": reason })
    }
}

/// Why an account's files call could not be answered.
#[derive(Debug)]
pub enum Failure {
    /// The files could not be opened: at this step.
    Unavailable(Step, crate::refusal_cause::Cause),
    /// The account files refused or failed the call.
    AccountFiles(AccountFilesError, crate::refusal_cause::Cause),
    /// New bytes were refused before anything was sent: these rows are not the ones the real store `origin` was
    /// bound to. The fix is the command that binds them.
    NotBound { origin: String, fix: String, cause: crate::refusal_cause::Cause },
}

/// The command that binds the files: this tool's own `account-files-bind` subcommand.
fn bind_command() -> String {
    let program = std::env::current_exe().map_or_else(|_| "this tool".to_owned(), |exe| exe.display().to_string());
    format!("run: {program} account-files-bind")
}
impl Failure {
    /// Preserve a lower refusal's construction site through the files boundary.
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::AccountFiles(error, _) => error.cause(),
            Self::Unavailable(_, cause) | Self::NotBound { cause, .. } => cause.clone(),
        }
    }

    /// What the refusal names to its caller: the open step that failed and why.
    pub fn detail(&self) -> Option<Value> {
        match self {
            Failure::Unavailable(step, _) => Some(step.detail()),
            Failure::NotBound { origin, fix, .. } => Some(serde_json::json!({ "origin": origin, "fix": fix })),
            Failure::AccountFiles(AccountFilesError::Invalid(words, _), _) => Some(serde_json::json!({ "words": words })),
            Failure::AccountFiles(AccountFilesError::IdentityMismatch(identity, byte_length, _), _) => {
                Some(serde_json::json!({ "identity": identity, "byte_length": byte_length }))
            }
            Failure::AccountFiles(_, _) => None,
        }
    }

    /// The refusal code, and whether the call may have had an effect.
    pub fn code(&self) -> (&'static str, bool) {
        match self {
            Failure::Unavailable(_, _) => ("namespace_unavailable", false),
            Failure::AccountFiles(AccountFilesError::NotFound(_), _) => ("namespace_not_found", false),
            Failure::AccountFiles(AccountFilesError::Invalid(_, _), _) => ("original_input_refused", false),
            Failure::AccountFiles(AccountFilesError::IdentityMismatch(..), _) => ("namespace_identity_mismatch", false),
            // Refused before anything was sent: rows that are not the real ones may not write into the real store.
            Failure::NotBound { .. } => ("namespace_origin_not_bound", false),
            Failure::AccountFiles(_, _) => ("namespace_source_unavailable", true),
        }
    }
}
crate::impl_caused!(Failure);

/// This owner, by its plain name.
pub type Files = AccountFilesDoor;

/// The account files door's DATA.
pub struct AccountFilesDoor {
    settings: Settings,
}

impl AccountFilesDoor {
    /// The shipped DATA, read and checked once per process.
    pub fn shipped() -> Option<&'static AccountFilesDoor> {
        static SHIPPED: OnceLock<Option<AccountFilesDoor>> = OnceLock::new();
        SHIPPED.get_or_init(|| AccountFilesDoor::from_data(DATA).ok()).as_ref()
    }

    pub fn from_data(bytes: &[u8]) -> Result<Self, serde_json::Error> {
        let settings: Settings = serde_json::from_slice(bytes)?;
        if settings.resource.is_empty()
            || settings.operations.is_empty()
            || settings.operations.iter().any(|operation| operation.is_empty())
            || !settings.search.valid(&settings.operations)
            || !settings.recent.valid(&settings.operations)
            || !settings.facts.valid()
        {
            return Err(serde::de::Error::custom("account files door DATA refused"));
        }
        Ok(Self { settings })
    }

    /// The resource every account files operation is addressed to.
    pub fn resource(&self) -> &str {
        &self.settings.resource
    }

    /// The operations this owner answers, in the order its DATA lists them.
    pub fn operations(&self) -> &[String] {
        &self.settings.operations
    }

    /// Whether this owner answers `operation` at `resource`.
    pub fn answers(&self, resource: &str, operation: &str) -> bool {
        resource == self.settings.resource && self.settings.operations.iter().any(|known| known == operation)
    }

    /// How the files' names are searched.
    pub fn file_search(&self) -> &FileSearch {
        &self.settings.search
    }

    /// The lookup identity of a public file-result reference. This only
    /// removes the spelling this owner's search DATA declares; it opens no
    /// file, key or store. The shared multihash parser and this file owner's
    /// complete-identity check keep malformed or unsupported aliases intact.
    /// Ports old trillion src/record-model-tools.mjs:90.
    pub fn canonical_reference<'a>(&self, requested: &'a str) -> Option<&'a str> {
        let requested = requested.trim();
        let prefix = &self.file_search().key_prefix;
        if !requested.get(..prefix.len())?.eq_ignore_ascii_case(prefix) {
            return None;
        }
        let identity = requested.get(prefix.len()..)?;
        let parsed = content_crypto::Multihash::from_code_hex(identity).ok()?;
        let canonical = parsed.to_code_hex();
        (canonical.eq_ignore_ascii_case(identity) && super::release::is_identity(&canonical))
            .then_some(identity)
    }

    /// The files used most recently: how they are kept and which operations keep a use.
    pub fn recent(&self) -> &super::recent::RecentSettings {
        &self.settings.recent
    }

    /// The facts kept about each file.
    pub fn facts(&self) -> &super::recent::FactsSettings {
        &self.settings.facts
    }

    /// How often the account usage flush runs (DATA `usage.flush_seconds`).
    pub fn usage_flush_period(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.settings.usage.flush_seconds.max(1))
    }

    /// What lets in the bytes of a call here: one name, every byte also the account's own usage count (`call_with_control_inner`
    /// adds the account's tally).
    pub fn bytes_let_in(&self) -> LetIn {
        static COUNTED: OnceLock<LetIn> = OnceLock::new();
        COUNTED.get_or_init(|| super::source_reads::Unmetered::new("person's calls").into()).clone()
    }

    /// One admitted call whose read answer must fit the caller's complete response envelope.
    #[allow(clippy::too_many_arguments)]
    pub fn call_with_control_fitting(
        &self,
        state_root: &Path,
        store: &Store,
        account: &str,
        operation: &str,
        input: &Value,
        control: super::CallControl,
        fits: &dyn Fn(&Value) -> bool,
    ) -> Result<Value, Failure> {
        self.call_with_control_inner(state_root, store, account, operation, input, control, Some(fits))
    }

    /// Deliver a complete immutable file to the caller's private borrowed sink, through the same files, usage and byte
    /// policy as an ordinary call. No successful proof is returned for a partial delivery, changed source or a stopped call.
    /// The caller owns private file creation, cleanup on every error, sync and publication after success; this owner
    /// returns no URL or provider credential, and neither buffers the whole file nor creates a cache.
    #[allow(clippy::too_many_arguments)]
    pub fn stream_with_control(
        &self,
        state_root: &Path,
        store: &Store,
        account: &str,
        identity: &str,
        max_bytes: u64,
        control: super::CallControl,
        sink: &mut dyn std::io::Write,
    ) -> Result<super::StreamedFile, Failure> {
        if !self.settings.operations.iter().any(|operation| operation == "read_file") {
            return Err(Failure::AccountFiles(AccountFilesError::Invalid("not an account's files operation", crate::cause!()), crate::cause!()));
        }
        control.check().map_err(|error| Failure::AccountFiles(error.into(), crate::cause!()))?;
        let control = control.counting(super::usage::Meters::global().tally(state_root, store, account));
        self.open(store, account)?
            .with_control(control)
            .stream_to(identity, max_bytes, sink)
            .map_err(|value| Failure::AccountFiles(value, crate::cause!()))
    }

    #[allow(clippy::too_many_arguments)]
    fn call_with_control_inner(
        &self,
        state_root: &Path,
        store: &Store,
        account: &str,
        operation: &str,
        input: &Value,
        control: super::CallControl,
        fits: Option<&dyn Fn(&Value) -> bool>,
    ) -> Result<Value, Failure> {
        if !self.settings.operations.iter().any(|known| known == operation) {
            return Err(Failure::AccountFiles(AccountFilesError::Invalid("not an account's files operation", crate::cause!()), crate::cause!()));
        }
        control.check().map_err(|error| Failure::AccountFiles(error.into(), crate::cause!()))?;
        // Every byte this call's handle writes or reads is also the account's own usage count (`usage.rs`).
        let control = control.counting(super::usage::Meters::global().tally(state_root, store, account));
        let mut account_files = self.open(store, account)?.with_control(control);
        account_files.check_current().map_err(|value| Failure::AccountFiles(value, crate::cause!()))?;
        let answer = match fits {
            Some(fits) => account_files.call_fitting(operation, input, fits),
            None => account_files.call(operation, input),
        };
        answer
            .ok_or(Failure::AccountFiles(AccountFilesError::Invalid("not an account's files operation", crate::cause!()), crate::cause!()))?
            .map_err(|error| match error {
                AccountFilesError::Objects(ObjectError::NotBound(origin, cause), _) => Failure::NotBound { cause, origin, fix: bind_command() },
                other => Failure::AccountFiles(other, crate::cause!()),
            })
    }

    fn open(&self, store: &Store, account: &str) -> Result<AccountFiles, Failure> {
        let vault = crate::secrets::open_home().map_err(|error| Failure::Unavailable(Step::Vault(why(&error)), crate::cause!()))?;
        // The account files' own binding (bind.rs), tied to the account. Files never bound have none, and `tie` of an
        // empty binding names nothing any origin holds, so a real store takes no new bytes from them.
        let home = super::bind::tie(account, &super::bind::binding_in(store).unwrap_or_default());
        Ok(AccountFiles::open(store.clone(), account, Box::new(vault))
            .map_err(|value| Failure::AccountFiles(value, crate::cause!()))?
            .at_home(home))
    }
}
