// src/lib.rs
//
// Purpose: The person's rows in their own SQL database, as a library two tools share: `store` (`Rows`, the trait of what a tool that keeps
// rows asks of its database, and `SqlStore`, its one implementation over SQLite or Postgres with the same statements) and `refusal_cause`
// (the engine's refusal causes, which every error of the store carries). Moved from tools/live-namespace (its src/store and
// src/cause_book), which moved them from the engine; live-records (the person's own records) and live-namespace (the person's files)
// both depend on this crate, so there is one copy.
//
// Non-Negotiable Invariants:
// - No module here names a person, a record kind, a host or a credential value.
// - The macros of `refusal_cause` are exported at this crate's root, so a tool that depends on it re-exports them (`pub use rows_store::cause;`)
//   and keeps writing `crate::cause!` as before.
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

#[path = "cause_book/cause.rs"]
pub mod refusal_cause;
#[path = "cause_book/foreign_causes.rs"]
mod foreign_causes;
#[path = "cause_book/foreign_storage_causes.rs"]
mod foreign_storage_causes;

pub mod store;
