// src/serve/mod.rs
//
// Purpose: One run of the Namespace tool: the person's files (the account files of this crate) served two ways from one
// state folder. `mcp` answers each operation of the account files' routes DATA as an MCP tool over stdio (`mcp.rs`); `dav`
// is the WebDAV folder on a loopback port (`dav.rs`) that Finder, a file browser or an editor mounts and opens files in by range.
// Both go through the same door (`AccountFilesDoor::call_while_fitting`), so a file written one way is the file read the other.
//
// Non-Negotiable Invariants:
// - The store credential reaches the run only on the file descriptors the engine attached, is read once into `secrets::Held`,
//   and is never printed, logged or put in an answer.
// - A call never creates a store: the first run makes it (`ensure_store`) from the attached connection's own facts, and
//   every later call opens the file that is there.
// - Every call stops taking steps in time to answer inside its deadline (`ANSWER_MARGIN`), and a call asked to stop
//   (the caller went away) takes no later step.
//
// Key Concepts:
// - `Namespace` is the door, the state folder and the account name a run serves; `Namespace::call` is the one call.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

pub mod dav;
pub mod mcp;
pub mod settings;

use live_namespace::{
    account_files::{
        account_routes::{AccountFilesDoor, Failure},
        bind::{self, NewAccountFiles},
        settings::call_deadline,
        usage, FILES,
    },
    legacy_records::Bounds,
    secrets::{self, Held},
    storage::record_store_resources,
};
use serde_json::Value;
use settings::Settings;
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
    account: String,
}

impl Namespace {
    /// Open the run: read the attached connection once, make the store on a first run, and start the usage flush.
    pub fn open(settings: &Settings, state: &Path) -> Result<Self, Refusal> {
        let door = AccountFilesDoor::shipped().ok_or("the account files door DATA is refused")?;
        make_private_folder(state)?;
        let state = std::fs::canonicalize(state)?;
        let fields: Vec<(&str, i32)> = settings.attached.iter().map(|attached| (attached.field.as_str(), attached.fd)).collect();
        let held = secrets::keep(Held::from_descriptors(&fields)?);
        ensure_store(&state, settings, &held)?;
        usage::flush_rows_every(door.usage_flush_period(), |line| live_namespace::quiet_eprintln!("{line}"));
        Ok(Self { door, state, account: settings.account.clone() })
    }

    /// The operations this run answers, as the routes DATA lists them.
    pub fn operations(&self) -> &[String] {
        self.door.operations()
    }

    /// One call of the account files' operation `operation`. `current` is asked before every step: when it answers no
    /// (the caller went away) the call takes no later step. `fits` bounds a read's answer to the message that carries it.
    pub fn call(
        &self,
        operation: &str,
        input: &Value,
        current: Arc<dyn Fn() -> bool + Send + Sync>,
        fits: &dyn Fn(&Value) -> bool,
    ) -> Result<Value, Failure> {
        let limit = call_deadline(Instant::now(), Bounds::default().elapsed, input);
        let until = limit.checked_sub(ANSWER_MARGIN).unwrap_or(limit);
        let live = {
            let current = current.clone();
            Arc::new(move || Instant::now() < limit && current()) as Arc<dyn Fn() -> bool + Send + Sync>
        };
        self.door.call_while_fitting(&self.state, &self.account, operation, input, until, live, fits)
    }

}

/// Make the state folder when it is not there, readable by its owner only.
fn make_private_folder(state: &Path) -> Result<(), Refusal> {
    use std::os::unix::fs::DirBuilderExt as _;
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(state)?;
    Ok(())
}

/// Make the person's files store on a first run, from the facts of the attached connection: an S3-compatible store, the key
/// id its requests are signed with, and the folder every key starts in. A store that is there is left as it is.
fn ensure_store(state: &Path, settings: &Settings, held: &Held) -> Result<(), Refusal> {
    let path = record_store_resources::placement(FILES)
        .and_then(|placement| placement.in_state(state))
        .ok_or("the account files have no placement in a state folder")?;
    if std::fs::symlink_metadata(&path).is_ok() {
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
    bind::make_new(state, &settings.account, Some(&files)).map_err(|error| match error.downcast_ref::<live_namespace::records::Error>() {
        Some(refused) => format!("{refused} ({})", refused.cause()),
        None => error.to_string(),
    })?;
    Ok(())
}
