//! Trillion storage candidates for the `workload-simulation` engine.
//!
//! - [`meter`]: one metered SQLite owner shared by every candidate
//!   (`sqlite_work` + index-entry meter + faults + gauges).
//! - [`candidates`]: S0 record log, S2 log row + current row, S5 versioned row,
//!   loaded from `candidates/<id>.json` DATA.
//! - [`real_seed`]: start stores from a clone of the restored account.
//! - [`files`]: DATA file names, the disk guard and JSON output.

pub mod candidates;
pub mod files;
pub mod meter;
pub mod real_seed;
