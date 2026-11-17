// src/serve/mod.rs
//
// Purpose: One run of the records tool: the person's records served from one state folder. `Records::open` reads the attached connection
// once, opens the person's rows (their own Postgres database, or a SQLite file in the state folder) and answers each call; `mcp.rs` is the
// MCP server over stdio that carries the calls. The engine runs it as a session that takes calls, so every caller reaches the records
// through the engine's one door and the run opens no port.
//
// Non-Negotiable Invariants:
// - The database connection reaches the run only on the file descriptor the engine attached, is read once into `Held`, and is never
//   printed, logged or put in an answer or an error.
// - The first run makes the tables when they are not there (`SqlStore::open`); a call never makes them.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

pub mod mcp;

use live_records::{
    attached::Held,
    records::Records,
    settings::{Rows, Settings},
};
use rows_store::store::{link::Link, SqlStore};
use std::{error::Error, path::Path, sync::Arc};

type Refusal = Box<dyn Error + Send + Sync>;

/// Open the run: the state folder (made when it is not there, readable by its owner only), the attached connection, the person's rows.
pub fn open(settings: &Settings, state: &Path) -> Result<Records, Refusal> {
    use std::os::unix::fs::DirBuilderExt as _;
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(state)?;
    let state = std::fs::canonicalize(state)?;
    let held = Held::from_descriptors(&settings.attached)?;
    let store = match &settings.store {
        Rows::Sqlite { file } => SqlStore::open(Link::sqlite(&state.join(file))?)?,
        Rows::Postgres { connection } => {
            let connection = held.plain(connection).ok_or("the database connection is not attached: attach it to start the run")?;
            SqlStore::open(Link::postgres(connection.as_str())?)?
        }
    };
    Ok(Records::new(Arc::new(store), settings.clone()))
}
