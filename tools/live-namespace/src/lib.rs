// src/lib.rs
//
// Purpose: The person's files (Namespace) as a library: the account files (`account_files`, moved from trillion-rust
// src/account_files) over the record store they keep their names in, and what they ask of the engine they were moved out of, kept in
// the smallest form that answers it here. `main.rs` and `serve/` make it a tool: MCP over stdio and a WebDAV folder.
//
// Non-Negotiable Invariants:
// - The record store is the source of tools/keep-lists-of-rows/account-state, included from there and never copied: one source,
//   two users. Everything else this tool needs from the engine is named below and lives in `cause_book/`, `engine/` or `host/`.
// - `host/` is what this tool is for the engine's modules it calls (the computer under it, the held credential, the MCP bounds); each
//   file's header says which engine module it stands for and what it keeps of it.
// - No module here names a person, a store, a host or a credential value.
//
// Key Concepts:
// - `cause_book/`: the engine's refusal causes (src/mcp/cause.rs of trillion-rust at 5fbc2ff4b1), which every error here carries.
// - `engine/`, `record_indexes`, `resource_authority`: files of the engine kept as they were, which the record store reads.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

/// `println!` that never panics: a closed stdout is not a failure of the tool, so the write's error is ignored.
#[macro_export]
macro_rules! quiet_println {
    ($($arg:tt)*) => {{ use ::std::io::Write as _; let _ = ::std::writeln!(::std::io::stdout(), $($arg)*); }};
}

/// `eprintln!` that never panics (see `quiet_println`).
#[macro_export]
macro_rules! quiet_eprintln {
    ($($arg:tt)*) => {{ use ::std::io::Write as _; let _ = ::std::writeln!(::std::io::stderr(), $($arg)*); }};
}

extern crate self as trillion_local;

#[path = "cause_book/cause.rs"]
pub mod refusal_cause;
#[path = "cause_book/foreign_causes.rs"]
mod foreign_causes;
#[path = "cause_book/foreign_storage_causes.rs"]
mod foreign_storage_causes;

// The record store and what it stands on, from tools/keep-lists-of-rows/account-state. This tool uses the part that keeps the
// person's files; the rest of what that tree declares stays unused here.
#[allow(dead_code, unused_imports, unused_variables, unused_mut, non_snake_case, private_interfaces, clippy::all)]
#[path = "../../keep-lists-of-rows/account-state/src"]
mod state {
    pub mod ecma_json;
    pub mod import;
    pub mod kept_runs;
    pub mod legacy_kept;
    pub mod legacy_records;
    pub mod record_canonical;
    pub mod record_log;
    pub mod record_model_policy;
    pub mod record_sealed;
    pub mod record_source;
    pub mod record_stamps;
    pub mod record_value;
    pub mod record_write_model;
    pub mod records;
    pub mod scan;
    pub mod sqlite_work;
    pub mod storage;
}
pub use state::{
    ecma_json, import, kept_runs, legacy_kept, legacy_records, record_canonical, record_log, record_model_policy, record_sealed,
    record_source, record_stamps, record_value, record_write_model, records, scan, sqlite_work, storage,
};

// Files of the engine the record store reads, as they were at 5fbc2ff4b1.
#[allow(clippy::possible_missing_else)]
pub mod record_indexes;
pub mod resource_authority;
#[path = "engine/signed_authority.rs"]
pub mod signed_authority;

// What this tool is for the engine modules the record store and the account files call.
#[path = "host/account.rs"]
pub mod account;
#[path = "host/account_rights.rs"]
pub mod account_rights;
#[path = "host/https.rs"]
pub(crate) mod https;
#[path = "host/local_account.rs"]
pub mod local_account;
#[path = "host/mcp.rs"]
pub mod mcp;
#[path = "host/rule_bindings.rs"]
pub mod rule_bindings;
#[path = "host/secrets.rs"]
pub mod secrets;
#[path = "host/tool_runs.rs"]
pub mod tool_runs;
#[path = "host/workspace_domain.rs"]
pub(crate) mod workspace_domain;

pub mod account_files;
