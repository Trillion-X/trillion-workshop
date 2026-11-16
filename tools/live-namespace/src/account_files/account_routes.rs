// src/account_files/account_routes.rs
//
// Purpose: The person's files on this computer. Which address and operations are answered here and what a
// tool run may be granted here are product DATA (`account-files-routes.json`); the file the account's files
// store lives in under its state folder is the account files resources' placement (src/storage/record_store_resources.json); each
// operation is the account files' own tool of that name (`AccountFiles::call`). No file, folder or tool is named here.
//
// Non-Negotiable Invariants:
// - The account files store is opened only when it exists (never created by a call), from the account's own state
//   folder, under the store's bounds; bytes are reached through the account's origin records and its secrets
//   vault (`secrets::open_home`), so a secret never leaves the vault.
// - This module makes no check that lets a call in: the door admits the person's key (or a run capability narrowed to the names it
//   touches) before it opens anything, and checks the key again before the answer leaves.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{AccountFiles, AccountFilesError, objects::ObjectError};
use crate::{
    account_rights::run_rules::Rules,
    sqlite_work::WorkMeter,
    storage::{Storage, record_store_resources},
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    path::Path,
    sync::{Arc, OnceLock},
    time::Instant,
};

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
    run_operations: Rules,
    /// Where a finished tool run's output files are kept in the person's files.
    run_outputs: RunOutputs,
    #[serde(rename = "_usage")]
    _usage: String,
    /// How the account's own usage counts are kept (`usage.rs`).
    usage: Usage,
    /// The words in the files' names searched with one question (`AccountFiles::search`).
    search: FileSearch,
    #[serde(rename = "_page")]
    _page: String,
    /// How the person's own page reaches these operations (`page_call`).
    page: Page,
    #[serde(rename = "_old_paths")]
    _old_paths: String,
    /// The paths old trillion's page called for the person's files, each one of these operations (`page_paths`).
    old_paths: super::page_paths::OldPaths,
    #[serde(rename = "_call_bytes")]
    _call_bytes: String,
    /// What lets in the bytes a call reads or writes (`call_while`).
    call_bytes: CallBytes,
    #[serde(rename = "_funded")]
    _funded: String,
    /// How a funded host opens each account's allowance (read only when `call_bytes` is `funded`).
    funded: FundedSettings,
    #[serde(rename = "_recent")]
    _recent: String,
    /// The files used most recently (`recent.rs`).
    recent: super::recent::RecentSettings,
    #[serde(rename = "_facts")]
    _facts: String,
    /// The facts kept about each file (`recent.rs` facts).
    facts: super::recent::FactsSettings,
    #[serde(rename = "_setup_facts")]
    _setup_facts: String,
    /// Get started's facts about the account's own mechanics (Round 2 contract C).
    setup_facts: SetupFacts,
    #[serde(rename = "_held_connections")]
    _held_connections: String,
    /// Which connected accounts hold values in the account's vault, by the names alone.
    held_connections: HeldConnections,
}

/// The one read of Get started's facts at this door (`_setup_facts`): its operation, answered by the account routes'
/// own composition (src/native_boot/mcp_local.rs `setup_facts_at`), and the most characters each input text may hold.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SetupFacts {
    operation: String,
    most_input_chars: usize,
}

/// The one read of which connected accounts hold values in the vault (`_held_connections`): its operation, answered by
/// the account routes' own composition (src/native_boot/mcp_local.rs `held_connections_at`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HeldConnections {
    operation: String,
}

/// How the person's own page reaches these operations: which of them it reads with GET.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    reads: Vec<String>,
}

/// What lets in the bytes a call reads or writes.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CallBytes {
    /// Let in under one name, every byte counted as the account's own usage.
    Counted,
    /// None let in: every physical read and write refuses before a request is sent.
    Refused,
    /// Let in only by the funded byte allowance the host opened for the call's account (`AccountFilesDoor::fund`):
    /// a byte no current signed capture covers is refused before a request is sent, and every byte is also counted
    /// as the account's own usage.
    Funded,
}

/// How a funded host's allowances are sized and whose captures they trust (DATA `funded`).
#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct FundedSettings {
    /// The bytes one held chunk carries (one durable hold per chunk, never per read).
    pub chunk_bytes: u64,
    /// The resident balance below which the allowance's own thread holds the next chunk.
    pub low_water_bytes: u64,
    /// The signature domain every signed funding instruction is verified under.
    pub signature_domain: String,
    /// The funding issuers whose signed captures fund bytes: their public keys only. Empty: no capture is trusted.
    pub issuers: Vec<FundingIssuer>,
}

/// One trusted funding issuer's public key (a public value: no secret lives in DATA).
#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct FundingIssuer {
    pub issuer: String,
    pub key_id: String,
    /// The Ed25519 public key, 32 bytes, base64url without padding.
    pub public_key: String,
}

/// The host owner a funded door asks for an account's byte allowance (`resource_authority::budget::account_files::
/// Funded`). None: the account has no current capture, so its bytes are refused.
pub trait FundsBytes: Send + Sync {
    fn allowance(
        &self,
        state_root: &Path,
        account: &str,
    ) -> Option<Arc<super::source_reads::Allowance>>;
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
            && (1..=crate::records::MAX_PAGE_ITEMS).contains(&self.word_hits)
            && self.k.is_finite()
            && self.k > 0.0
            && self.rank.is_finite()
            && self.rank > 0.0
            && ![&self.place, &self.source, &self.key_prefix]
                .iter()
                .any(|text| text.is_empty())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunOutputs {
    /// The folder, from the root, under which each run's outputs are kept: `<folder>/<tool>/<run>/<file>`.
    folder: String,
}
impl RunOutputs {
    fn valid(&self) -> bool {
        self.folder.starts_with('/')
            && !self.folder.ends_with('/')
            && self.folder.len() <= MOST_FOLDER_BYTES
            && !self.folder.chars().any(char::is_control)
    }
}

/// The longest folder the DATA may name for run outputs.
const MOST_FOLDER_BYTES: usize = 200;

/// The most characters of an open step's reason that the refusal carries.
const MOST_REASON_CHARS: usize = 200;

/// An open step's own error text (a state folder's path, an error code: never a value or a key), cut short.
fn why(error: &dyn std::fmt::Debug) -> String {
    format!("{error:?}")
        .chars()
        .take(MOST_REASON_CHARS)
        .collect()
}

/// Which step of opening the account's files failed, so a refusal says where, not only that.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// A resource's placement is not declared in `record_store_resources.json` or names no state file.
    Placement,
    /// The state folder holds no account files store file (a call never creates one).
    NoStore,
    /// The store file exists and record store could not open it, with the error it gave.
    StoreOpen(String),
    /// The account's secrets vault could not be opened, with the error it gave.
    Vault(String),
}
impl Step {
    /// The step's name and the reason it gave, as the refusal's detail.
    pub fn detail(&self) -> Value {
        let (step, reason) = match self {
            Step::Placement => ("placement", ""),
            Step::NoStore => ("no_store_file", ""),
            Step::StoreOpen(reason) => ("store_open", reason.as_str()),
            Step::Vault(reason) => ("vault_open", reason.as_str()),
        };
        serde_json::json!({ "step": step, "reason": reason })
    }
}

/// Why an account's files call could not be answered.
#[derive(Debug)]
pub enum Failure {
    /// The account keeps no account files store in its state folder, or it could not be opened: at this step.
    Unavailable(Step, crate::refusal_cause::Cause),
    /// The account files refused or failed the call.
    AccountFiles(AccountFilesError, crate::refusal_cause::Cause),
    /// New bytes were refused before anything was sent: this state folder is not the one the real store `origin` was
    /// bound to. The fix is the exact command that binds it (`bind_command`).
    NotBound { origin: String, fix: String, cause: crate::refusal_cause::Cause },
}

/// The command that binds `store` (the account files store file of `account`) to its own folder on purpose: trillion-local's
/// own `account-files-bind` subcommand, by the full path of the running trillion-local, with the app not running.
fn bind_command(store: &Path, account: &str) -> String {
    let engine = std::env::current_exe()
        .map_or_else(|_| "the engine".to_owned(), |exe| exe.display().to_string());
    format!(
        "with the app quit, run: {engine} account-files-bind {} {account}",
        store.display()
    )
}
impl Failure {
    /// Preserve a lower records refusal's construction site through the files boundary.
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::AccountFiles(error, _) => error.cause(),
            Self::Unavailable(_, cause) |
            Self::NotBound { cause, .. } => cause.clone(),
        }
    }

    /// What the refusal names to its caller: the open step that failed and why.
    pub fn detail(&self) -> Option<Value> {
        match self {
            Failure::Unavailable(step, _) => Some(step.detail()),
            Failure::NotBound { origin, fix, .. } => {
                Some(serde_json::json!({ "origin": origin, "fix": fix }))
            }
            Failure::AccountFiles(AccountFilesError::Invalid(words, _), _) => {
                Some(serde_json::json!({ "words": words }))
            }
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
            Failure::AccountFiles(AccountFilesError::Invalid(_, _), _) => {
                ("original_input_refused", false)
            }
            Failure::AccountFiles(AccountFilesError::IdentityMismatch(..), _) => ("namespace_identity_mismatch", false),
            // Refused before anything was sent: a copy of the state folder may not write into the real store.
            Failure::NotBound { .. } => ("namespace_origin_not_bound", false),
            Failure::AccountFiles(_, _) => ("namespace_source_unavailable", true),
        }
    }
}
crate::impl_caused!(Failure);


/// This owner, by its plain name.
pub type Files = AccountFilesDoor;

/// Who the files page road (`page_routes`) answers: the account's own files (its state folder and owner id) and
/// whether a request is the person's own signed-in page (asked before the call and again before its answer leaves).
pub struct PageRoad {
    pub state_root: std::path::PathBuf,
    pub account: String,
    pub signed_in: Arc<dyn Fn(&axum::http::Method, &axum::http::HeaderMap) -> bool + Send + Sync>,
}

/// The person's page road to their files at a door that serves no browser workspace (a computer's door): every path
/// under `/work/api/files/` whose owner route (src/server/owner-routes.json, `workspace_domain::OwnerRoutes`) is this resource's
/// row, made into the same call the hosting app's page makes (`AccountFilesDoor::page_call`, local_workspace.rs
/// `call_files`) and answered the same way: the files' own answer, or its refusal code as `error` and `failure_code`,
/// `outcome_unknown` and `detail`. A path there that the row does not name answers 404 `no-owner`, as the hosting app
/// answers a path no owner it mounts names. A request that is not the person's own signed-in page answers 401. Before, only the hosting
/// app served it, and at a computer `/work/api/files/*` was 404 (measured on place-fsn1, 2026-11-04). Old trillion served
/// it for every account from one Worker (Trillion-X/trillion tag old-trillion-before-worker-retire, src/worker.mjs:808-810:
/// an API read with no session answers 401; :824-826: a `/work/api/` path that is the account's files call goes to
/// the signed-in account's own files).
pub fn page_routes(road: PageRoad) -> axum::Router {
    let road = Arc::new(road);
    axum::Router::new().route(
        "/work/api/files/{*operation}",
        axum::routing::any(move |request: axum::extract::Request| {
            let road = road.clone();
            async move { page_answer(&road, request).await }
        }),
    )
}

async fn page_answer(
    road: &Arc<PageRoad>,
    request: axum::extract::Request,
) -> axum::response::Response {
    use axum::{http::StatusCode, response::IntoResponse as _};
    let answer = |status: StatusCode, body: Value| -> axum::response::Response {
        (
            status,
            [
                (axum::http::header::CONTENT_TYPE, "application/json"),
                (axum::http::header::CACHE_CONTROL, "no-store"),
            ],
            body.to_string(),
        )
            .into_response()
    };
    let refused = |status: StatusCode, code: &str, cause: crate::refusal_cause::Cause| {
        crate::quiet_eprintln!("account-files-refusal code={code} cause={cause}");
        answer(
            status,
            serde_json::json!({"error": code, "failure_code": code, "cause": cause.id()}),
        )
    };
    let Some(files) = Files::shipped() else {
        return refused(StatusCode::SERVICE_UNAVAILABLE, "unavailable", crate::cause!(account_files page_refusal));
    };
    let Ok(routes) = crate::workspace_domain::OwnerRoutes::from_product() else {
        return refused(StatusCode::SERVICE_UNAVAILABLE, "unavailable", crate::cause!(account_files page_refusal));
    };
    let (parts, body) = request.into_parts();
    let method = parts.method.clone();
    let Some(path) = parts
        .uri
        .path()
        .strip_prefix("/work/api")
        .filter(|path| path.starts_with('/'))
        .map(str::to_owned)
    else {
        return refused(StatusCode::NOT_FOUND, "no-owner", crate::cause!(account_files page_refusal));
    };
    let query = parts.uri.query().unwrap_or("").to_owned();
    let bound = crate::mcp::request_bytes();
    let Ok(bytes) = axum::body::to_bytes(body, bound).await else {
        return refused(StatusCode::PAYLOAD_TOO_LARGE, "too_large", crate::cause!(account_files page_refusal));
    };
    let body = match method {
        axum::http::Method::GET | axum::http::Method::HEAD => None,
        _ if bytes.is_empty() => Some(serde_json::json!({})),
        _ => match serde_json::from_slice::<Value>(&bytes) {
            Ok(body) => Some(body),
            Err(_) => return refused(StatusCode::BAD_REQUEST, "original_input_refused", crate::cause!(account_files page_refusal)),
        },
    };
    let call = match routes.resolve(&path, method.as_str(), &query, body, None) {
        Ok(Some(call)) => call,
        Ok(None) => return refused(StatusCode::NOT_FOUND, "no-owner", crate::cause!(account_files page_refusal)),
        Err(_) => return refused(StatusCode::BAD_REQUEST, "original_input_refused", crate::cause!(account_files page_refusal)),
    };
    let (operation, input) = match files.page_call(&call.operation, &call.input) {
        None => return refused(StatusCode::NOT_FOUND, "no-owner", crate::cause!(account_files page_refusal)),
        Some(Err(error)) => return refused(StatusCode::BAD_REQUEST, "original_input_refused", error.cause()),
        Some(Ok(call)) => call,
    };
    if !(road.signed_in)(&method, &parts.headers) {
        return refused(StatusCode::UNAUTHORIZED, "unauthenticated", crate::cause!(account_files page_refusal));
    }
    let (worker, headers) = (road.clone(), parts.headers.clone());
    let ran = tokio::task::spawn_blocking(move || {
        let until = Instant::now() + crate::workspace_store::Limits::default().elapsed;
        let (signed_in, again) = (worker.signed_in.clone(), headers.clone());
        let current: Arc<dyn Fn() -> bool + Send + Sync> =
            Arc::new(move || signed_in(&method, &again));
        let ran = files.call_while(
            &worker.state_root,
            &worker.account,
            &operation,
            &input,
            until,
            current.clone(),
        );
        (ran, current())
    })
    .await;
    let Ok((ran, still_signed_in)) = ran else {
        return refused(StatusCode::SERVICE_UNAVAILABLE, "unavailable", crate::cause!(account_files page_refusal));
    };
    // The session is asked again before the answer leaves, as the hosting app's page road asks it.
    if !still_signed_in {
        return refused(StatusCode::UNAUTHORIZED, "unauthenticated", crate::cause!(account_files page_refusal));
    }
    match ran {
        Ok(body) => answer(StatusCode::OK, body),
        Err(failure) => {
            let (code, unknown) = failure.code();
            crate::quiet_eprintln!("account-files-refusal code={code} cause={}", failure.cause());
            let status = match &failure {
                Failure::AccountFiles(AccountFilesError::NotFound(_), _) => StatusCode::NOT_FOUND,
                Failure::AccountFiles(AccountFilesError::Invalid(_, _), _) => StatusCode::BAD_REQUEST,
                Failure::NotBound { .. } => StatusCode::CONFLICT,
                _ => StatusCode::SERVICE_UNAVAILABLE,
            };
            answer(
                status,
                serde_json::json!({"error": code, "failure_code": code, "outcome_unknown": unknown, "detail": failure.detail(), "cause": failure.cause().id()}),
            )
        }
    }
}

/// The account files door's DATA.
pub struct AccountFilesDoor {
    settings: Settings,
    /// The funded host's allowances, installed once by the host (`fund`).
    funds: OnceLock<Arc<dyn FundsBytes>>,
}

impl AccountFilesDoor {
    /// The shipped DATA, read and checked once per process.
    pub fn shipped() -> Option<&'static AccountFilesDoor> {
        static SHIPPED: OnceLock<Option<AccountFilesDoor>> = OnceLock::new();
        SHIPPED
            .get_or_init(|| Some(DATA).and_then(|bytes| AccountFilesDoor::from_data(bytes).ok()))
            .as_ref()
    }

    pub fn from_data(bytes: &[u8]) -> Result<Self, serde_json::Error> {
        let settings: Settings = serde_json::from_slice(bytes)?;
        let operations_granted = settings
            .operations
            .iter()
            .all(|operation| !operation.is_empty());
        if settings.resource.is_empty()
            || settings.operations.is_empty()
            || !operations_granted
            || !settings.run_operations.valid()
            || !settings.run_outputs.valid()
            || !settings.search.valid(&settings.operations)
            || !settings
                .page
                .reads
                .iter()
                .all(|read| settings.operations.contains(read))
            || !settings
                .old_paths
                .valid(&|operation| settings.operations.iter().any(|known| known == operation))
            || !settings.recent.valid(&settings.operations)
            || !settings.facts.valid()
            || settings.setup_facts.most_input_chars == 0
            || !settings
                .operations
                .contains(&settings.setup_facts.operation)
            || !settings
                .run_operations
                .grantable(&settings.setup_facts.operation)
            || settings
                .page
                .reads
                .contains(&settings.setup_facts.operation)
            || !settings
                .operations
                .contains(&settings.held_connections.operation)
            || !settings
                .run_operations
                .grantable(&settings.held_connections.operation)
            || settings
                .page
                .reads
                .contains(&settings.held_connections.operation)
            || settings.held_connections.operation == settings.setup_facts.operation
        {
            return Err(serde::de::Error::custom("account files door DATA refused"));
        }
        Ok(Self {
            settings,
            funds: OnceLock::new(),
        })
    }

    /// Whether this door lets bytes in only by a funded allowance (DATA `call_bytes` is `funded`).
    pub fn funds_bytes(&self) -> bool {
        self.settings.call_bytes == CallBytes::Funded
    }

    /// How a funded host opens each account's allowance (DATA `funded`).
    pub fn funded_settings(&self) -> &FundedSettings {
        &self.settings.funded
    }

    /// Install the host's funded allowances (once; a second call changes nothing and answers false).
    pub fn fund(&self, funds: Arc<dyn FundsBytes>) -> bool {
        self.funds.set(funds).is_ok()
    }

    /// The resource every account files operation is addressed to.
    pub fn resource(&self) -> &str {
        &self.settings.resource
    }

    /// Whether this owner answers `operation` at `resource`.
    pub fn answers(&self, resource: &str, operation: &str) -> bool {
        resource == self.settings.resource
            && self
                .settings
                .operations
                .iter()
                .any(|known| known == operation)
    }

    /// How the files' names are searched.
    /// Whether `operation` at `resource` is Get started's facts read (`setup_facts`), answered by the account routes'
    /// own composition and never by the files' `call`.
    pub fn answers_setup_facts(&self, resource: &str, operation: &str) -> bool {
        resource == self.settings.resource && operation == self.settings.setup_facts.operation
    }

    /// Whether `operation` at `resource` is the read of which connected accounts hold values in the vault
    /// (`held_connections`), answered by the account routes' own composition and never by the files' `call`.
    pub fn answers_held_connections(&self, resource: &str, operation: &str) -> bool {
        resource == self.settings.resource && operation == self.settings.held_connections.operation
    }

    /// The asking browser's {user_agent, origin} a `setup_facts` call gave, each text (empty when left out) of at most
    /// `most_input_chars`; None for any other input.
    pub fn setup_facts_asked(&self, input: &Value) -> Option<(String, String)> {
        let fields = input.as_object()?;
        if fields
            .keys()
            .any(|key| key != "user_agent" && key != "origin")
        {
            return None;
        }
        let text = |name: &str| match fields.get(name) {
            None | Some(Value::Null) => Some(String::new()),
            Some(Value::String(text))
                if text.chars().count() <= self.settings.setup_facts.most_input_chars =>
            {
                Some(text.clone())
            }
            Some(_) => None,
        };
        Some((text("user_agent")?, text("origin")?))
    }

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

    /// What a run may be granted here (`account_rights::run_rules`).
    pub fn run_rules(&self) -> &Rules {
        &self.settings.run_operations
    }

    /// The files used most recently: how they are kept and which operations keep a use.
    pub fn recent(&self) -> &super::recent::RecentSettings {
        &self.settings.recent
    }

    /// The facts kept about each file.
    pub fn facts(&self) -> &super::recent::FactsSettings {
        &self.settings.facts
    }

    /// A page's call of these operations, as the page's route table sends it: the row whose family is this resource
    /// (src/server/owner-routes.json) makes the operation `<resource>:request` with input {path, method, body}. The
    /// path's last segment names the operation. One of `page.reads` is a GET whose query's one `input` field holds its
    /// JSON input object (none is `{}`); every other operation is a POST whose body is its JSON input object. `None`
    /// when `operation` is not that family; a call naming no operation here, with the other method, another
    /// query field, a query on a POST, or an input that is not a JSON object is refused. The page's session admits
    /// it; no key is involved. The answer is the same operation and input an AI's key sends here. A path old trillion's
    /// page called (DATA `old_paths`: /namespace/*, /recent-files) is first made into the operation its row names, with the
    /// input as the old route took it (`page_paths`).
    pub fn page_call(&self, operation: &str, input: &Value) -> Option<Result<(String, Value), crate::refusal_cause::CodedError<()>>> {
        if operation.strip_suffix(":request") != Some(self.settings.resource.as_str()) {
            return None;
        }
        // A path under old trillion's page road to this door that no row takes, under any method, has no owner here
        // (404 no-owner): it is not ported (`page_paths::OldPaths::unported`).
        if self.settings.old_paths.unported(
            input
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ) {
            return None;
        }
        let call = || -> Result<(String, Value), crate::refusal_cause::CodedError<()>> {
            let decode =
                |text: &str, form| crate::workspace_domain::decode(text, form).map_err(|error| crate::refusal_cause::CodedError::with_cause((), error.cause()));
            let target = input.get("path").and_then(Value::as_str).ok_or_else(|| crate::refusal_cause::CodedError::new(()))?;
            let method = input.get("method").and_then(Value::as_str);
            // A path old trillion's page called is the operation its DATA row names, with the input as the old route took it.
            if let Some(call) =
                self.settings
                    .old_paths
                    .call(method.unwrap_or_default(), target, input.get("body"))
            {
                return call;
            }
            let (path, query) = target.split_once('?').unwrap_or((target, ""));
            let name = decode(path.rsplit('/').next().unwrap_or_default(), false)?;
            if !self.answers(&self.settings.resource, &name) {
                return Err(crate::refusal_cause::CodedError::new(()));
            }
            if !self.settings.page.reads.contains(&name) {
                let body = input
                    .get("body")
                    .filter(|body| body.is_object())
                    .ok_or_else(|| crate::refusal_cause::CodedError::new(()))?;
                if method != Some("POST") || !query.is_empty() {
                    return Err(crate::refusal_cause::CodedError::new(()));
                }
                return Ok((name, body.clone()));
            }
            if method != Some("GET") {
                return Err(crate::refusal_cause::CodedError::new(()));
            }
            let mut given = None;
            for pair in query.split('&').filter(|pair| !pair.is_empty()) {
                match pair.split_once('=') {
                    Some(("input", text)) if given.is_none() => given = Some(decode(text, true)?),
                    _ => return Err(crate::refusal_cause::CodedError::new(())),
                }
            }
            let given = match given {
                None => Value::Object(serde_json::Map::new()),
                Some(text) => serde_json::from_str(&text).map_err(|error| crate::refusal_cause::CodedError::with_cause((), crate::refusal_cause::Caused::cause(&error)))?,
            };
            if !given.is_object() {
                return Err(crate::refusal_cause::CodedError::new(()));
            }
            Ok((name, given))
        };
        Some(call())
    }

    /// The full name in the person's files of one output file of one run: the DATA's folder, the tool's id after its
    /// last `:` (a character outside letters, digits, `.`, `_` and `-` becomes `-`; nothing or only dots is `tool`),
    /// the run's identity and the file's own name. The same tool, run and file are always the same name, so a retried
    /// run keeps one file.
    pub fn run_output_name(&self, tool: &str, run: &str, file: &str) -> String {
        let mut tool: String = tool
            .rsplit(':')
            .next()
            .unwrap_or_default()
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        if tool.chars().all(|c| c == '.') {
            tool = "tool".to_owned();
        }
        format!("{}/{tool}/{run}/{file}", self.settings.run_outputs.folder)
    }

    /// How often the account usage flush runs (DATA `usage.flush_seconds`).
    pub fn usage_flush_period(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.settings.usage.flush_seconds.max(1))
    }

    /// The control a finished tool run's outputs are kept with (`tool_runs::tools::outputs`, which asks only
    /// `write_file` and `find_file`): taking no step after `until`, and admitted by the one named unmetered byte check
    /// of run outputs, counted under `namespace.bytes.unmetered.workshop run outputs.*`. Each output is bounded by
    /// the row's declaration and `WRITE_MAX_BYTES`. Until a host composes a funded allowance, this name is the
    /// only write trillion-local makes for itself.
    pub fn run_outputs_control(until: Instant) -> super::CallControl {
        static ADMISSION: OnceLock<super::source_reads::Admission> = OnceLock::new();
        let admission = ADMISSION
            .get_or_init(|| super::source_reads::Unmetered::new("workshop run outputs").into());
        super::CallControl::new(until, Arc::new(|| true), admission.clone())
    }

    /// Answer one call: open `account`'s account files in `state_root` and run the account files' tool `operation`, with a
    /// transient current/cancellation check at every account files commit and byte boundary. A paged operation takes no
    /// step after `until` and answers where to resume. Partial earlier steps and an already transmitted PUT retain
    /// their existing unknown-effect semantics. The call's bytes are let in as DATA `call_bytes` says: `counted`,
    /// under one name, every byte also the account's own usage count (`call_with_control` adds the
    /// account's tally); `refused`, none let in (`none()`), so every physical read and write of file bytes
    /// refuses before any request is sent and listing, finding and stat still answer. The AI's key and the person's
    /// own page both call here, so both are admitted alike.
    pub fn call_while(
        &self,
        state_root: &Path,
        account: &str,
        operation: &str,
        input: &Value,
        until: Instant,
        current: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<Value, Failure> {
        self.call_with_control(
            state_root,
            account,
            operation,
            input,
            super::CallControl::new(until, current, self.bytes_let_in_for(state_root, account)),
        )
    }

    /// The same call with a caller-owned bound on the complete answer envelope. Bounded transports use this so a read
    /// selects a smaller raw byte range before it asks the account's source for bytes.
    pub fn call_while_fitting(
        &self,
        state_root: &Path,
        account: &str,
        operation: &str,
        input: &Value,
        until: Instant,
        current: Arc<dyn Fn() -> bool + Send + Sync>,
        fits: &dyn Fn(&Value) -> bool,
    ) -> Result<Value, Failure> {
        self.call_with_control_fitting(
            state_root,
            account,
            operation,
            input,
            super::CallControl::new(until, current, self.bytes_let_in_for(state_root, account)),
            fits,
        )
    }

    /// What lets in the bytes of `account`'s call at `state_root`: as `bytes_let_in`, and for a funded door the
    /// allowance the host opened for that account, or none (refused) when the host has none for it.
    pub fn bytes_let_in_for(&self, state_root: &Path, account: &str) -> LetIn {
        match self.settings.call_bytes {
            CallBytes::Funded => self
                .funds
                .get()
                .and_then(|funds| funds.allowance(state_root, account))
                .map_or_else(LetIn::none, LetIn::from),
            _ => self.bytes_let_in(),
        }
    }

    /// What lets in the bytes of a call here (DATA `call_bytes`).
    pub fn bytes_let_in(&self) -> LetIn {
        static COUNTED: OnceLock<LetIn> = OnceLock::new();
        match self.settings.call_bytes {
            CallBytes::Counted => COUNTED
                .get_or_init(|| super::source_reads::Unmetered::new("person's calls").into())
                .clone(),
            // A funded door's allowance belongs to one account (`bytes_let_in_for`); with no account, none.
            CallBytes::Refused | CallBytes::Funded => LetIn::none(),
        }
    }

    /// One admitted caller's complete control: its byte admission (a metered
    /// `Allowance` reads and writes) and its grant-aware share delivery owner.
    pub fn call_with_control(
        &self,
        state_root: &Path,
        account: &str,
        operation: &str,
        input: &Value,
        control: super::CallControl,
    ) -> Result<Value, Failure> {
        self.call_with_control_inner(state_root, account, operation, input, control, None)
    }

    /// One admitted call whose read answer must fit the caller's complete response envelope.
    pub fn call_with_control_fitting(
        &self,
        state_root: &Path,
        account: &str,
        operation: &str,
        input: &Value,
        control: super::CallControl,
        fits: &dyn Fn(&Value) -> bool,
    ) -> Result<Value, Failure> {
        self.call_with_control_inner(state_root, account, operation, input, control, Some(fits))
    }

    /// Deliver a complete immutable file to the caller's private borrowed sink, through the same Files/vault,
    /// account usage and byte policy as an ordinary call. `control` must come from the caller's fresh authorization
    /// for this exact `read_file` identity, with its cancellation and deadline; a run's lifetime alone or its output
    /// admission is not input authority. The owner creating the control uses `bytes_let_in_for` for this account.
    /// No successful proof is returned for a partial delivery, changed source or revoked call. The caller owns
    /// private file creation, cleanup on every error, sync and publication after success; this owner returns no URL
    /// or provider credential, and neither buffers the whole file nor creates a cache or another Files store.
    pub fn stream_with_control(
        &self,
        state_root: &Path,
        account: &str,
        identity: &str,
        max_bytes: u64,
        control: super::CallControl,
        sink: &mut dyn std::io::Write,
    ) -> Result<super::StreamedFile, Failure> {
        if !self
            .settings
            .operations
            .iter()
            .any(|operation| operation == "read_file")
        {
            return Err(Failure::AccountFiles(AccountFilesError::Invalid(
                "not an account's files operation",
             crate::cause!()), crate::cause!()));
        }
        control
            .check()
            .map_err(|error| Failure::AccountFiles(error.into(), crate::cause!()))?;
        let control = control.counting(super::usage::Meters::global().tally(state_root, account));
        self.open(state_root, account)?
            .with_control(control)
            .stream_to(identity, max_bytes, sink)
            .map_err(|value| Failure::AccountFiles(value, crate::cause!()))
    }

    fn call_with_control_inner(
        &self,
        state_root: &Path,
        account: &str,
        operation: &str,
        input: &Value,
        control: super::CallControl,
        fits: Option<&dyn Fn(&Value) -> bool>,
    ) -> Result<Value, Failure> {
        if !self
            .settings
            .operations
            .iter()
            .any(|known| known == operation)
        {
            return Err(Failure::AccountFiles(AccountFilesError::Invalid(
                "not an account's files operation",
             crate::cause!()), crate::cause!()));
        }
        control
            .check()
            .map_err(|error| Failure::AccountFiles(error.into(), crate::cause!()))?;
        // Every byte this call's handle writes or reads is also the account's own usage count (`usage.rs`).
        let control = control.counting(super::usage::Meters::global().tally(state_root, account));
        let mut account_files = self.open(state_root, account)?.with_control(control);
        account_files
            .check_current()
            .map_err(|value| Failure::AccountFiles(value, crate::cause!()))?;
        let answer = match fits {
            Some(fits) => account_files.call_fitting(operation, input, fits),
            None => account_files.call(operation, input),
        };
        answer
            .ok_or(Failure::AccountFiles(AccountFilesError::Invalid(
                "not an account's files operation",
             crate::cause!()), crate::cause!()))?
            .map_err(|error| match error {
                AccountFilesError::Objects(ObjectError::NotBound(origin, cause), _) => {
                    let store = record_store_resources::placement(super::FILES)
                        .and_then(|placement| placement.in_state(state_root))
                        .unwrap_or_default();
                    Failure::NotBound {
                        cause,
                        origin,
                        fix: bind_command(&store, account),
                    }
                }
                other => Failure::AccountFiles(other, crate::cause!()),
            })
    }

    /// One page of the files step of `account`'s erasure (src/account/erase.rs `files_page`), on its account files
    /// opened as every call opens them: through the account files' own functions, so their bytes go to the byte
    /// release. An account with no account files store has no files to erase.
    pub(crate) fn erasure_page(
        &self,
        state_root: &Path,
        account: &str,
        cursor: &str,
    ) -> Result<crate::account::erase::Page, crate::account::erase::StepFailure> {
        match self.open(state_root, account) {
            Err(Failure::Unavailable(Step::NoStore, _)) => Ok(crate::account::erase::Page {
                erased: 0,
                next: None,
            }),
            Err(failure) => Err(crate::account::erase::StepFailure { cause: failure.cause().into(),
                words: failure.code().0.to_owned(),
                transient: true,
            }),
            Ok(mut files) => crate::account::erase::files_page(&mut files, cursor),
        }
    }

    fn open(
        &self,
        state_root: &Path,
        account: &str,
    ) -> Result<AccountFiles<impl Storage + Send>, Failure> {
        let path = record_store_resources::placement(super::FILES)
            .and_then(|placement| placement.in_state(state_root))
            .ok_or(Failure::Unavailable(Step::Placement, crate::cause!()))?;
        // Never create a store: an account without one has no account files here.
        if !std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_file()) {
            return Err(Failure::Unavailable(Step::NoStore, crate::cause!()));
        }
        let store = record_store_resources::open(&path, WorkMeter::new())
            .map_err(|error| Failure::Unavailable(Step::StoreOpen(why(&error)), crate::cause!()))?;
        let vault = crate::secrets::open_home(state_root, account)
            .map_err(|error| Failure::Unavailable(Step::Vault(why(&error)), crate::cause!()))?;
        // The account files' own binding (bind.rs), tied to the account. An account's files never bound has none, and `tie` of an
        // empty binding names nothing any origin holds, so a real store takes no new bytes from it.
        let home = super::bind::tie(
            account,
            &super::bind::binding_in(&store, account).unwrap_or_default(),
        );
        Ok(AccountFiles::open(store, account, Box::new(vault))
            .map_err(|value| Failure::AccountFiles(value, crate::cause!()))?
            .at_home(home))
    }
}

/// The physical identity of a state folder, used by the funding holds (src/resource_authority/budget/funding.rs) to
/// notice the folder swapped under a live process. The account files no longer uses it: a store is bound to the account files'
/// own binding (bind.rs), which a legitimate copy or restore keeps. Its inode and the time it was created on its volume. A clone or copy of
/// the folder (an APFS `clonefile`, `cp -c`, `cp -R`) is a new directory with its own inode and creation time; a
/// folder moved within its volume keeps both. It is read from the file system, never from a file inside the folder,
/// so a copy cannot carry it along.
pub fn folder_identity(folder: &Path) -> std::io::Result<String> {
    use crate::tool_runs::os::{OwnerFiles, This};
    let metadata = crate::io_operation!((std::fs::metadata(folder)).map_err(std::io::Error::from))?;
    let created = crate::io_operation!((crate::io_operation!((metadata
        .created()).map_err(std::io::Error::from))?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(std::io::Error::other)).map_err(std::io::Error::from))?;
    Ok(format!(
        "{}:{}.{:09}",
        crate::io_operation!((This::facts(&metadata)).map_err(std::io::Error::from))?.inode,
        created.as_secs(),
        created.subsec_nanos()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_call_preserves_old_path_and_decode_sources_and_distinct_local_conditions() {
        let files = Files::shipped().unwrap();
        let family = format!("{}:request", files.resource());
        let bad_decode = files.page_call(&family, &json!({"path":"/files/list_files?input=%zz", "method":"GET"})).unwrap().unwrap_err();
        assert_eq!(bad_decode.cause(), crate::workspace_domain::decode("%zz", true).unwrap_err().cause());
        let method = files.page_call(&family, &json!({"path":"/files/list_files", "method":"POST"})).unwrap().unwrap_err();
        let field = files.page_call(&family, &json!({"path":"/files/list_files?private-field=secret-value", "method":"GET"})).unwrap().unwrap_err();
        assert_ne!(method.cause(), field.cause());
        assert!(!field.cause().id().contains("secret-value"));
        let old = files.page_call(&family, &json!({"path":"/namespace/files/private-file-name", "method":"GET"})).unwrap().unwrap_err();
        assert!(old.cause().file().ends_with("account_files/page_paths.rs"));
        assert!(!old.cause().id().contains("private-file-name"));
    }

    use crate::account_rights::run_rules::{Named, Scope};
    use serde_json::json;
    use std::time::Duration;

    #[test]
    fn a_stopped_file_stream_refuses_before_opening_a_store_or_delivering_bytes() {
        let door = AccountFilesDoor::shipped().unwrap();
        let state = tempfile::tempdir().unwrap();
        let control = super::super::CallControl::new(
            Instant::now() + Duration::from_secs(1),
            Arc::new(|| false),
            door.bytes_let_in_for(state.path(), "synthetic-account"),
        );
        let mut sink = Vec::new();
        let identity = content_crypto::Multihash::hash(b"synthetic file").to_code_hex();
        assert!(matches!(
            door.stream_with_control(
                state.path(),
                "synthetic-account",
                &identity,
                99,
                control,
                &mut sink
            ),
            Err(Failure::AccountFiles(AccountFilesError::Records(
                crate::records::Error::Unavailable(_)
            , _), _))
        ));
        assert!(sink.is_empty());
        assert_eq!(std::fs::read_dir(state.path()).unwrap().count(), 0);
    }

    #[test]
    fn canonical_file_references_use_the_search_prefix_and_complete_content_identity_owner() {
        let door = AccountFilesDoor::shipped().unwrap();
        let identity =
            content_crypto::Multihash::blake3(b"synthetic reference bytes").to_code_hex();
        let alias = format!("{}{identity}", door.file_search().key_prefix);
        assert_eq!(door.canonical_reference(&alias), Some(identity.as_str()));
        let uppercase = alias.to_ascii_uppercase();
        let expected = identity.to_ascii_uppercase();
        assert_eq!(
            door.canonical_reference(&uppercase),
            Some(expected.as_str())
        );
        let short = content_crypto::Multihash::from_digest(0x1f, vec![0xaa])
            .unwrap()
            .to_code_hex();
        let unsupported = content_crypto::Multihash::from_digest(0x21, vec![0xcc; 32])
            .unwrap()
            .to_code_hex();
        for malformed in [short, format!("0{identity}"), unsupported] {
            let alias = format!("{}{malformed}", door.file_search().key_prefix);
            assert_eq!(door.canonical_reference(&alias), None);
        }
    }

    #[test]
    fn the_shipped_door_answers_the_account_files_tools_and_names_what_each_call_touches() {
        let door = AccountFilesDoor::shipped().expect("account files door DATA");
        let resource = door.resource();
        assert!(door.answers(resource, "list_files"));
        assert!(!door.answers(resource, "remove_everything"));
        assert!(!door.answers("@elsewhere", "list_files"));
        let rules = door.run_rules();
        let named = |operation: &str, input: Value| {
            rules.named(operation, &input, resource).map(|named| {
                named
                    .iter()
                    .map(|item| match item.scope {
                        Scope::Id(id) => format!("id {id}"),
                        Scope::Prefix(prefix) => format!("prefix {prefix}"),
                        Scope::Unbounded => "everything".to_owned(),
                    })
                    .collect::<Vec<_>>()
            })
        };
        assert_eq!(
            named("list_files", json!({"folder": "/Recordings/"})),
            Some(vec!["prefix /Recordings/".to_owned()])
        );
        assert_eq!(
            named("list_files", json!({})),
            Some(vec!["prefix ".to_owned()]),
            "no folder is the root"
        );
        assert_eq!(
            named(
                "read_file",
                json!({"name_or_identity": "/Recordings/a.mp4"})
            ),
            Some(vec!["id /Recordings/a.mp4".to_owned()])
        );
        assert_eq!(
            named("files_summary", json!({})),
            Some(vec!["everything".to_owned()])
        );
        assert_eq!(
            named("write_file", json!({"text": "x"})),
            None,
            "a write names its name"
        );
        assert_eq!(
            rules.named("find_file", &json!({"name_or_identity": "/a"}), resource),
            Some(vec![Named {
                kind: resource,
                scope: Scope::Id("/a")
            }])
        );
    }

    #[test]
    fn a_runs_output_is_named_by_the_data_folder_the_tool_the_run_and_the_file() {
        let door = AccountFilesDoor::shipped().expect("account files door DATA");
        let id = |name: &str| format!("tool{}{name}", ':');
        let name = door.run_output_name(&id("copy-a-site"), "0123abcd", "site.json");
        assert!(
            name.starts_with('/') && name.ends_with("/copy-a-site/0123abcd/site.json"),
            "{name}"
        );
        assert_eq!(
            name,
            door.run_output_name(&id("copy-a-site"), "0123abcd", "site.json")
        );
        let odd = door.run_output_name(&id("odd name/x"), "r", "f");
        assert!(odd.ends_with("/odd-name-x/r/f"), "{odd}");
        for dots in [id(".."), id("."), id("")] {
            assert!(
                door.run_output_name(&dots, "r", "f").ends_with("/tool/r/f"),
                "{dots}"
            );
        }
        let shipped = String::from_utf8(DATA.to_vec()).unwrap();
        let data = |folder: &str| {
            shipped.replace(
                "\"folder\": \"/Tool results\"",
                &format!("\"folder\": \"{folder}\""),
            )
        };
        assert!(AccountFilesDoor::from_data(data("/Kept results").as_bytes()).is_ok());
        for folder in ["", "Tool results", "/Tool results/"] {
            assert!(
                AccountFilesDoor::from_data(data(folder).as_bytes()).is_err(),
                "{folder:?}"
            );
        }
    }

    #[test]
    fn an_account_without_a_account_files_store_is_unavailable_and_none_is_created() {
        let door = AccountFilesDoor::shipped().expect("account files door DATA");
        let state = tempfile::tempdir().unwrap();
        let answer = door.call_while(
            state.path(),
            "account-1",
            "files_summary",
            &json!({}),
            Instant::now() + Duration::from_secs(5),
            Arc::new(|| true),
        );
        assert!(
            matches!(answer, Err(Failure::Unavailable(Step::NoStore, _))),
            "{answer:?}"
        );
        assert_eq!(
            std::fs::read_dir(state.path()).unwrap().count(),
            0,
            "nothing was created"
        );
    }

    #[test]
    fn a_store_file_record_store_cannot_open_is_refused_at_the_store_open_step_with_its_reason() {
        let door = AccountFilesDoor::shipped().expect("account files door DATA");
        let state = tempfile::tempdir().unwrap();
        let path = record_store_resources::placement(super::super::FILES)
            .and_then(|placement| placement.in_state(state.path()))
            .unwrap();
        std::fs::write(&path, vec![b'x'; 4096]).unwrap();
        let answer = door.call_while(
            state.path(),
            "account-1",
            "files_summary",
            &json!({}),
            Instant::now() + Duration::from_secs(5),
            Arc::new(|| true),
        );
        let Err(failure @ Failure::Unavailable(Step::StoreOpen(_), _)) = answer else {
            panic!("{answer:?}")
        };
        assert_eq!(failure.code(), ("namespace_unavailable", false));
        let detail = failure.detail().unwrap();
        assert_eq!(detail["step"], "store_open");
        assert!(
            !detail["reason"].as_str().unwrap().is_empty()
                && detail["reason"].as_str().unwrap().chars().count() <= MOST_REASON_CHARS
        );
    }

    #[test]
    fn a_good_store_without_a_vault_is_refused_at_the_vault_open_step() {
        let door = AccountFilesDoor::shipped().expect("account files door DATA");
        let state = tempfile::tempdir().unwrap();
        // record store opens a canonical path (the temporary folder is a link on macOS).
        let root = std::fs::canonicalize(state.path()).unwrap();
        let path = record_store_resources::placement(super::super::FILES)
            .and_then(|placement| placement.in_state(&root))
            .unwrap();
        drop(record_store_resources::open(&path, WorkMeter::new()).unwrap());
        let answer = door.call_while(
            &root,
            "account-1",
            "files_summary",
            &json!({}),
            Instant::now() + Duration::from_secs(5),
            Arc::new(|| true),
        );
        // Without the Mac account key or the vault file the vault cannot open; a host that has both and an empty
        // vault goes on to answer, so only the refusal's step is checked.
        if let Err(Failure::Unavailable(step, _)) = answer {
            assert!(matches!(step, Step::Vault(_)), "{step:?}");
        }
    }

    #[test]
    fn a_folders_identity_is_its_own_a_copy_has_another_and_a_move_keeps_it() {
        let root = tempfile::tempdir().unwrap();
        let (one, other) = (root.path().join("one"), root.path().join("other"));
        std::fs::create_dir(&one).unwrap();
        std::fs::create_dir(&other).unwrap();
        let identity = folder_identity(&one).unwrap();
        assert_eq!(identity, folder_identity(&one).unwrap());
        assert_ne!(
            identity,
            folder_identity(&other).unwrap(),
            "another folder is another identity, whatever its contents"
        );
        std::fs::write(one.join("file"), b"x").unwrap();
        assert_eq!(
            identity,
            folder_identity(&one).unwrap(),
            "what is inside does not change it"
        );
        let moved = root.path().join("moved");
        std::fs::rename(&one, &moved).unwrap();
        assert_eq!(
            identity,
            folder_identity(&moved).unwrap(),
            "a move within the volume keeps it"
        );
        assert!(folder_identity(&root.path().join("missing")).is_err());
    }

    fn shipped_files() -> &'static Files {
        Files::shipped().unwrap()
    }
    fn files_from(bytes: &[u8]) -> Result<Files, serde_json::Error> {
        Files::from_data(bytes)
    }

    #[test]
    fn the_page_reaches_every_operation_reads_by_get_and_the_rest_by_post_with_its_body() {
        let files = shipped_files();
        let family = format!("{}:request", files.resource());
        let call = |input: Value| files.page_call(&family, &input);
        assert!(
            files
                .page_call(
                    "@own-records:request",
                    &json!({"path": "/files/list_files", "method": "GET"})
                )
                .is_none()
        );
        let input = url::form_urlencoded::byte_serialize(br#"{"folder":"/A"}"#).collect::<String>();
        assert_eq!(
            call(json!({"path": format!("/files/list_files?input={input}"), "method": "GET"})),
            Some(Ok(("list_files".into(), json!({"folder": "/A"}))))
        );
        assert_eq!(
            call(json!({"path": "/files/files_summary", "method": "GET"})),
            Some(Ok(("files_summary".into(), json!({}))))
        );
        assert_eq!(
            call(
                json!({"path": "/files/write_file_piece", "method": "POST", "body": {"upload_id": "u"}})
            ),
            Some(Ok(("write_file_piece".into(), json!({"upload_id": "u"}))))
        );
        for refused in [
            json!({"path": "/files/write_file?input=%7B%7D", "method": "GET"}),
            json!({"path": "/files/list_files", "method": "POST", "body": {}}),
            json!({"path": "/files/write_file?x=1", "method": "POST", "body": {}}),
            json!({"path": "/files/write_file", "method": "POST", "body": [1]}),
            json!({"path": "/files/list_files?input=%5B%5D", "method": "GET"}),
            json!({"path": "/files/list_files?other=1", "method": "GET"}),
            json!({"path": "/files/remove_everything", "method": "GET"}),
        ] {
            assert_eq!(call(refused.clone()), Some(Err(crate::refusal_cause::CodedError::new(()))), "{refused}");
        }
        // Every page read is one of the operations here.
        let data: Value = serde_json::from_slice(DATA).unwrap();
        for read in data["page"]["reads"].as_array().unwrap() {
            assert!(
                files.answers(files.resource(), read.as_str().unwrap()),
                "{read}"
            );
        }
    }

    /// The port of the page's half of old test/namespace-account-route.test.mjs (every page Namespace path is the
    /// account's files call, answered by its owner) and test/namespace-file-lookup.test.mjs and
    /// test/namespace-no-name-in-urls.test.mjs (a file name travels only in a POST body; a name in a GET's URL is
    /// refused), at Trillion-X/trillion tag old-trillion-before-worker-retire, onto this door's DATA rows: each old
    /// page path becomes the operation old src/file-tools.mjs made of it, with the input the old route took.
    #[test]
    fn the_paths_old_trillions_page_called_are_the_operations_its_file_tools_made_of_them() {
        let files = shipped_files();
        let family = format!("{}:request", files.resource());
        let call = |method: &str, path: &str, body: Value| {
            files.page_call(
                &family,
                &json!({"path": path, "method": method, "body": body}),
            )
        };
        let identity = format!("1f:{}", "a".repeat(64));
        let encoded = format!("1f%3A{}", "a".repeat(64));
        let name = "/Private/Medical/Dad surgery.pdf";
        let answers = [
            (
                ("GET", "/namespace/summary".to_owned(), json!({})),
                ("files_summary", json!({})),
            ),
            (
                (
                    "POST",
                    "/namespace/listing".to_owned(),
                    json!({"collection": "/A", "after": "/A/b", "limit": 5}),
                ),
                (
                    "list_files",
                    json!({"folder": "/A", "after": "/A/b", "limit": 5}),
                ),
            ),
            (
                ("POST", "/namespace/listing".to_owned(), json!({})),
                ("list_files", json!({})),
            ),
            (
                (
                    "POST",
                    "/namespace/contents/read".to_owned(),
                    json!({"name": name, "offset": 3, "length": 9}),
                ),
                (
                    "read_file",
                    json!({"name_or_identity": name, "offset": 3, "length": 9}),
                ),
            ),
            (
                (
                    "POST",
                    "/namespace/contents/read".to_owned(),
                    json!({"name": name, "upload_id": "0123456789abcdef0123456789abcdef", "offset": 3, "length": 9}),
                ),
                (
                    "read_file",
                    json!({"name_or_identity": name, "upload_id": "0123456789abcdef0123456789abcdef", "offset": 3, "length": 9}),
                ),
            ),
            (
                (
                    "POST",
                    "/namespace/contents/read".to_owned(),
                    json!({"identity": identity}),
                ),
                ("read_file", json!({"name_or_identity": identity})),
            ),
            (
                (
                    "GET",
                    format!("/namespace/contents/{encoded}?offset=4&length=8"),
                    json!({}),
                ),
                (
                    "read_file",
                    json!({"name_or_identity": identity, "offset": 4, "length": 8}),
                ),
            ),
            (
                (
                    "POST",
                    "/namespace/files/lookup".to_owned(),
                    json!({"name": name, "seconds": 60}),
                ),
                ("find_file", json!({"name_or_identity": name})),
            ),
            (
                ("GET", format!("/namespace/files/{encoded}"), json!({})),
                ("find_file", json!({"name_or_identity": identity})),
            ),
            (
                (
                    "POST",
                    "/namespace/write".to_owned(),
                    json!({"name": "/n.txt", "text": "hi", "media_type": "text/plain", "app": "x"}),
                ),
                (
                    "write_file",
                    json!({"name": "/n.txt", "text": "hi", "media_type": "text/plain"}),
                ),
            ),
            (
                ("GET", "/namespace/results".to_owned(), json!({})),
                ("list_file_results", json!({})),
            ),
            (
                (
                    "GET",
                    "/namespace/results?kind=transcript&after=1f%3Ab&limit=20".to_owned(),
                    json!({}),
                ),
                (
                    "list_file_results",
                    json!({"kind": "transcript", "after": "1f:b", "limit": 20}),
                ),
            ),
            (
                (
                    "POST",
                    "/namespace/results".to_owned(),
                    json!({"results": [{"identity": identity, "kind": "facts", "value": {}}]}),
                ),
                (
                    "record_file_results",
                    json!({"results": [{"identity": identity, "kind": "facts", "value": {}}]}),
                ),
            ),
            (
                (
                    "POST",
                    "/namespace/results/many".to_owned(),
                    json!({"kind": "transcript", "identities": [identity]}),
                ),
                (
                    "read_file_results_many",
                    json!({"kind": "transcript", "identities": [identity]}),
                ),
            ),
            (
                (
                    "POST",
                    format!("/namespace/results/{encoded}/merge"),
                    json!({"kind": "facts", "value": {"a": 1}, "only_if_empty": true}),
                ),
                (
                    "merge_file_result",
                    json!({"identity": identity, "kind": "facts", "value": {"a": 1}, "only_if_empty": true}),
                ),
            ),
            (
                (
                    "GET",
                    format!("/namespace/results/{encoded}?kind=summary"),
                    json!({}),
                ),
                (
                    "read_file_results",
                    json!({"identity": identity, "kind": "summary"}),
                ),
            ),
            (
                (
                    "GET",
                    "/recent-files?limit=20&before=x".to_owned(),
                    json!({}),
                ),
                ("recent_files", json!({"limit": 20, "before": "x"})),
            ),
            (
                ("GET", "/recent-files".to_owned(), json!({})),
                ("recent_files", json!({})),
            ),
            (
                (
                    "POST",
                    "/recent-files".to_owned(),
                    json!({"file": name, "kind": "opened"}),
                ),
                ("record_file_use", json!({"file": name, "kind": "opened"})),
            ),
        ];
        for ((method, path, body), (operation, input)) in answers {
            assert_eq!(
                call(method, &path, body),
                Some(Ok((operation.to_owned(), input))),
                "{method} {path}"
            );
        }
        // A file name in a GET's URL is refused, never looked up or read (old src/namespace.mjs:2304-2321 answered 400).
        let in_url = url::form_urlencoded::byte_serialize(name.as_bytes())
            .collect::<String>()
            .replace('+', "%20");
        for path in [
            format!("/namespace/files/{in_url}"),
            format!("/namespace/contents/{in_url}"),
            format!("/namespace/results/{in_url}"),
            "/namespace/files/lookup".to_owned(),
            "/namespace/contents/read".to_owned(),
        ] {
            assert_eq!(call("GET", &path, json!({})), Some(Err(crate::refusal_cause::CodedError::new(()))), "{path}");
        }
        // A path old trillion answered by an owner not ported here has no owner at this door (404 no-owner), never 400.
        for path in [
            "/namespace/results/timeline",
            "/namespace/growing",
            "/namespace/tidy/apply",
        ] {
            assert_eq!(call("GET", path, json!({})), None, "{path}");
        }
        // The door's own page road is unchanged beside them.
        assert_eq!(
            call("GET", "/files/files_summary", json!({})),
            Some(Ok(("files_summary".into(), json!({}))))
        );
    }

    #[test]
    fn what_lets_bytes_in_is_data() {
        let shipped = String::from_utf8(DATA.to_vec()).unwrap();
        assert!(
            !shipped_files().bytes_let_in().is_none(),
            "the shipped DATA counts its bytes"
        );
        let refused = files_from(
            shipped
                .replace("\"call_bytes\": \"counted\"", "\"call_bytes\": \"refused\"")
                .as_bytes(),
        )
        .unwrap();
        assert!(refused.bytes_let_in().is_none());
        assert!(
            files_from(
                shipped
                    .replace("\"call_bytes\": \"counted\"", "\"call_bytes\": \"free\"")
                    .as_bytes()
            )
            .is_err()
        );
        // Funded: none let in until the host installs its allowances, then only the account's own.
        let funded = files_from(
            shipped
                .replace("\"call_bytes\": \"counted\"", "\"call_bytes\": \"funded\"")
                .as_bytes(),
        )
        .unwrap();
        assert!(funded.funds_bytes() && funded.bytes_let_in().is_none());
        assert!(
            funded
                .bytes_let_in_for(Path::new("/state"), "account-1")
                .is_none(),
            "no host allowances: refused"
        );
        struct One(Arc<super::super::source_reads::Allowance>);
        impl FundsBytes for One {
            fn allowance(
                &self,
                _: &Path,
                account: &str,
            ) -> Option<Arc<super::super::source_reads::Allowance>> {
                (account == "account-1").then(|| self.0.clone())
            }
        }
        struct Endless;
        struct Open;
        impl super::super::source_reads::Supply for Endless {
            fn hold(
                &self,
                _: u64,
            ) -> Result<Box<dyn super::super::source_reads::Chunk>, ObjectError> {
                Ok(Box::new(Open))
            }
        }
        impl super::super::source_reads::Chunk for Open {
            fn settle(self: Box<Self>, _: u64) -> Result<(), ObjectError> {
                Ok(())
            }
        }
        let allowance = super::super::source_reads::Allowance::open(
            Arc::new(Endless),
            100,
            10,
            &super::super::counters::Registry::default(),
        )
        .unwrap();
        assert!(funded.fund(Arc::new(One(allowance))));
        assert!(
            !funded.fund(Arc::new(One(super::super::source_reads::Allowance::open(
                Arc::new(Endless),
                100,
                10,
                &super::super::counters::Registry::default()
            )
            .unwrap()))),
            "installed once"
        );
        assert!(
            !funded
                .bytes_let_in_for(Path::new("/state"), "account-1")
                .is_none()
        );
        assert!(
            funded
                .bytes_let_in_for(Path::new("/state"), "account-2")
                .is_none(),
            "another account has its own or none"
        );
        let unknown = shipped.replace(
            "\"reads\": [\"list_files\"",
            "\"reads\": [\"no_such_operation\", \"list_files\"",
        );
        assert!(
            files_from(unknown.as_bytes()).is_err(),
            "a page read is one of the operations here"
        );
    }

    #[test]
    fn files_route_preserves_the_original_record_failure_cause() {
        let original = crate::cause!(crate::records::Error::Unavailable);
        let cause = original.cause();
        let files = AccountFilesError::Records(original, crate::cause!(account_files records_boundary));
        let failure = Failure::AccountFiles(files, crate::cause!(account_files route_boundary));
        assert_eq!(failure.code(), ("namespace_source_unavailable", true));
        assert_eq!(failure.cause(), cause);
    }

    #[test]
    fn a_refused_unbound_origin_is_its_own_code_and_names_the_fix() {
        let fix = bind_command(Path::new("/state/file-catalog.sqlite"), "account-1");
        let failure = Failure::NotBound {
                        cause: crate::cause!(account_files origin_not_bound),
            origin: "b2".into(),
            fix: fix.clone(),
        };
        assert_eq!(failure.code(), ("namespace_origin_not_bound", false));
        let detail = failure.detail().unwrap();
        assert_eq!(detail["origin"], "b2");
        assert_eq!(detail["fix"], fix);
        assert!(
            fix.starts_with("with the app quit, run: /")
                && fix.ends_with(" account-files-bind /state/file-catalog.sqlite account-1"),
            "{fix}"
        );
    }

    #[test]
    fn every_step_names_itself_and_its_reason_in_the_detail() {
        let named = |step: Step| Failure::Unavailable(step, crate::cause!()).detail().unwrap();
        assert_eq!(
            named(Step::Placement),
            json!({"step": "placement", "reason": ""})
        );
        assert_eq!(
            named(Step::NoStore),
            json!({"step": "no_store_file", "reason": ""})
        );
        assert_eq!(
            named(Step::StoreOpen("a".into())),
            json!({"step": "store_open", "reason": "a"})
        );
        assert_eq!(
            named(Step::Vault("c".into())),
            json!({"step": "vault_open", "reason": "c"})
        );
        assert!(
            Failure::AccountFiles(crate::cause!(AccountFilesError::NotFound), crate::cause!())
                .detail()
                .is_none()
        );
        let long = "y".repeat(1000);
        assert!(why(&long).chars().count() <= MOST_REASON_CHARS);
    }
}
