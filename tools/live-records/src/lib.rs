// src/lib.rs
//
// Purpose: The person's own records as a library: the operations of the records door (`records`: read, list, search, write and result of
// records, read and write of workspace labels) over the person's rows in their own SQL database (the shared crate `rows-store`), what
// one run reads from its settings (`settings`), how it reads the connection the engine attached (`attached`), and how an answer too big
// for one message is sent as byte pages (`answer`). `main.rs` and `serve/` make it a tool: MCP over stdio, run by the engine as a session
// that takes calls, so every caller (a run, an AI, a device) reaches the records through the engine's one door.
//
// Non-Negotiable Invariants:
// - The contract is tools/records-door/README.md; this crate answers it and changes none of it. What it does not answer it refuses with
//   `original_input_refused` (see README.md of this tool, "What is not here").
// - No module here names a door address, a record kind, a person, a host or a credential value: every name is the call's or the settings'.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

/// `eprintln!` that never panics: a closed stderr is not a failure of the tool, so the write's error is ignored.
#[macro_export]
macro_rules! quiet_eprintln {
    ($($arg:tt)*) => {{ use ::std::io::Write as _; let _ = ::std::writeln!(::std::io::stderr(), $($arg)*); }};
}

pub mod answer;
pub mod attached;
pub mod records;
pub mod settings;
