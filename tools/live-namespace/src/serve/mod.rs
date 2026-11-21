// src/serve/mod.rs
//
// Purpose: One run of the Namespace tool: the person's files (the account files of this crate) served from one state folder.
// `mcp` answers each operation of the account files' routes DATA as an MCP tool over stdio (`mcp.rs`), through the door
// (`AccountFilesDoor::call_with_control_fitting`); the engine runs it as a session that takes calls, so every caller (an AI,
// a device's folder) reaches the files through the engine's one door and the run opens no port.
//
// Non-Negotiable Invariants:
// - The store credential reaches the run only on the file descriptors the engine attached, is read once into `secrets::Held`,
//   and is never printed, logged or put in an answer.
// - A call never makes the person's files: the first run makes them (`ensure_files`) from the attached connection's own facts, and
//   every later call finds the rows that are there.
// - Every call stops taking steps in time to answer inside its deadline (`ANSWER_MARGIN`), and a call asked to stop
//   (the caller went away) takes no later step.
//
// Key Concepts:
// - `Namespace` is the door, the person's rows, the state folder and the account name a run serves; `Namespace::call` is the one call.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

pub mod mcp;
pub mod rows;
pub mod settings;
pub mod shares;

use live_namespace::{
    account_files::{
        account_routes::{AccountFilesDoor, Failure},
        CallControl,
        bind::{self, NewAccountFiles},
        settings::call_deadline,
        usage,
    },
    secrets::{self, Held},
    store::{
        by_calls::RowsByCalls,
        link::Link,
        through_the_door::Door,
        SqlStore, Store,
    },
};
use serde_json::Value;
use settings::{Rows, Settings};
use std::{
    error::Error,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

/// How long before a call's deadline it takes its last step, so it can check its caller again and answer in time (the
/// engine's door margin, src/native_boot/mcp_local.rs `ACCOUNT_FILES_ANSWER_MARGIN`).
const ANSWER_MARGIN: Duration = Duration::from_millis(500);

type Refusal = Box<dyn Error + Send + Sync>;

/// The person's files served by this run.
pub struct Namespace {
    door: &'static AccountFilesDoor,
    state: PathBuf,
    store: Store,
    account: String,
    call_limit: Duration,
    /// The https address a share opens at; none, and `share_file` is refused.
    share: Option<String>,
    /// The computer the run is on, `{id, label}` as the engine filled it; null for a run the engine did not start.
    computer: Value,
    /// Every operation a call may name: the door's and `THIS_COMPUTER`.
    operations: Vec<String>,
}

/// The one operation the run answers itself, not the door: the computer it is on.
const THIS_COMPUTER: &str = "this_computer";

/// The folder of the run's own folder a raw span's bytes are written in.
const BYTE_RESULTS: &str = "byte-results";

impl Namespace {
    /// Open the run: read the attached connections once, open the person's rows, make the files on a first run, and start the
    /// usage flush.
    pub fn open(settings: &Settings, state: &Path, computer: Value) -> Result<Self, Refusal> {
        let door = AccountFilesDoor::shipped().ok_or("the account files door DATA is refused")?;
        let (state, held, store) = open_rows(settings, state)?;
        ensure_files(&store, settings, &held)?;
        usage::flush_rows_every(door.usage_flush_period(), |line| live_namespace::quiet_eprintln!("{line}"));
        let share = settings.share.as_ref().map(|share| share.origin.clone());
        let operations = door.operations().iter().cloned().chain([THIS_COMPUTER.to_owned()]).collect();
        Ok(Self { door, state, store, account: settings.account.clone(), call_limit: Duration::from_secs(settings.call_seconds), share,
            computer, operations })
    }

    /// The person's rows, opened as a run opens them, for a command that only reads or binds them.
    pub fn rows(settings: &Settings, state: &Path) -> Result<Store, Refusal> {
        Ok(open_rows(settings, state)?.2)
    }

    /// The operations this run answers: the routes DATA's and `this_computer`.
    pub fn operations(&self) -> &[String] {
        &self.operations
    }

    /// One call of the account files' operation `operation`. `current` is asked before every step: when it answers no
    /// (the caller went away) the call takes no later step. `fits` bounds a read's answer to the message that carries it.
    /// `answer_now` gives the call's answer before the call ends (a raw span's, at its first byte).
    pub fn call(
        &self,
        operation: &str,
        input: &Value,
        current: Arc<dyn Fn() -> bool + Send + Sync>,
        fits: &dyn Fn(&Value) -> bool,
        answer_now: Arc<dyn Fn(&Value) + Send + Sync>,
    ) -> Result<Value, Failure> {
        if operation == THIS_COMPUTER {
            return Ok(serde_json::json!({"id": self.computer["id"], "label": self.computer["label"]}));
        }
        let limit = call_deadline(Instant::now(), self.call_limit, input);
        let until = limit.checked_sub(ANSWER_MARGIN).unwrap_or(limit);
        let live = {
            let current = current.clone();
            Arc::new(move || Instant::now() < limit && current()) as Arc<dyn Fn() -> bool + Send + Sync>
        };
        let mut control = CallControl::new(until, live, self.door.bytes_let_in());
        if let Some(origin) = &self.share {
            control = control.with_share_origin(origin);
        }
        // A raw span's bytes are a file in the run's own folder, answered at its first byte: the engine hands them to the caller
        // raw as the file grows and removes it (the row's `session.byte_result`).
        control = control.with_byte_results(self.state.clone(), BYTE_RESULTS, answer_now);
        self.door.call_with_control_fitting(&self.state, &self.store, &self.account, operation, input, control, fits)
    }

}

/// The state folder (made when it is not there, readable by its owner only), what the run holds of its attached connections, and the
/// person's rows opened as `settings` says: a SQL store this run opens itself, or the rows another tool's session keeps, reached by
/// calls through this run's door (so this run never holds that database's login).
pub(crate) fn open_rows(settings: &Settings, state: &Path) -> Result<(PathBuf, Arc<Held>, Store), Refusal> {
    make_private_folder(state)?;
    let state = std::fs::canonicalize(state)?;
    let fields: Vec<(&str, &str, i32)> = settings.attached.iter().map(|attached| (attached.service.as_str(), attached.field.as_str(), attached.fd)).collect();
    let held = secrets::keep(Held::from_descriptors(&fields)?);
    let store: Store = match &settings.store {
        Rows::Sqlite { file } => Arc::new(SqlStore::open(Link::sqlite(&state.join(file))?)?),
        // A second connection hears every other process's commits, so a wait for a change (`list_changes`) wakes at once on any computer.
        Rows::Postgres { connection } => {
            let connection = held.plain(connection).map_err(|_| "the database connection is not attached: attach it to start the run")?;
            let links = (0..live_namespace::store::postgres_connections()).map(|_| Link::postgres(connection.as_str())).collect::<Result<Vec<_>, _>>()?;
            Arc::new(SqlStore::open_many(links)?.hearing(Link::postgres(connection.as_str())?)?)
        }
        Rows::Run { tool, fd } => Arc::new(RowsByCalls::new(Door::from_descriptor(*fd, tool)?.sender())),
    };
    Ok((state, held, store))
}

/// Make the state folder when it is not there, readable by its owner only.
fn make_private_folder(state: &Path) -> Result<(), Refusal> {
    use std::os::unix::fs::DirBuilderExt as _;
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(state)?;
    Ok(())
}

/// Make the person's files on a first run, from the facts of the attached connection: an S3-compatible store, the key id its
/// requests are signed with, and the folder every key starts in. Files that are there are left as they are.
fn ensure_files(store: &Store, settings: &Settings, held: &Held) -> Result<(), Refusal> {
    if bind::binding_in(store).is_some() {
        return Ok(());
    }
    let fact = |field: &str| -> Result<String, Refusal> {
        let name = secrets::held_name(secrets::SERVICE, field).map_err(|error| error.to_string())?;
        Ok(held.plain(&name).map_err(|_| format!("the files-store connection holds no {field}: attach it to start the first run"))?.to_string())
    };
    let files = NewAccountFiles {
        endpoint: fact("endpoint")?,
        bucket: fact("bucket")?,
        region: fact("region")?,
        key_id: fact("key-id")?,
        key_prefix: settings.key_prefix.clone(),
    };
    if !files.valid() {
        return Err("the files-store connection does not hold together (an https endpoint, plain names)".into());
    }
    if !held.holds(&secrets::held_name(secrets::SERVICE, "secret").map_err(|error| error.to_string())?) {
        return Err("the files-store connection holds no secret: attach it to start the first run".into());
    }
    bind::make_new(store, &settings.account, Some(&files)).map_err(|error| error.to_string())?;
    Ok(())
}
