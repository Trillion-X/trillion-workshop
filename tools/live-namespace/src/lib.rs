// src/lib.rs
//
// Purpose: The person's files (Namespace) as a library: the account files (`account_files`, moved from trillion-rust
// src/account_files) over the record store they keep their names in, and what they ask of the engine they were moved out of, kept in
// the smallest form that answers it here. `main.rs` and `serve/` make it a tool: MCP over stdio, run by the engine as a session that takes calls.
//
// Non-Negotiable Invariants:
// - The record store is this tool's own (`store/`). Everything else this tool needs from the engine is named below and lives in `cause_book/`, `engine/` or `host/`.
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

pub mod store;

// What this tool is for the engine modules the record store and the account files call.
#[path = "host/https.rs"]
pub(crate) mod https;
#[path = "host/mcp.rs"]
pub mod mcp;
#[path = "host/secrets.rs"]
pub mod secrets;
#[path = "host/tool_runs.rs"]
pub mod tool_runs;

pub mod account_files;
pub mod share_bytes;
