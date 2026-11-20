//! crates/timed-action/src/lib.rs
//!
//! Purpose
//!   timed-action as one library every host calls: when work is due, on a repeat or once. The recurrence reducers
//!   (recurring.rs), wall time in named zones (wall_time.rs over date.rs and js.rs), the due evaluator (evaluate.rs),
//!   the wake answer (when_to_wake.rs), the spread of fires (spread.rs), quiet hours (quiet_hours.rs), zone drift
//!   (zone_drift.rs) and the scheduled-action writes (records.rs). requests.rs is the one table of what is answered;
//!   two hosts carry it: host.rs (wasm-bindgen, for pages and Node tools) and main.rs (a WASI command, the one
//!   component the engine runs as a tool).
//!
//! Non-negotiable invariants
//!   - Nothing reads a clock, a random number or a host zone. A zone is a name the bundled tz database knows.
//!   - Every answer is the TypeScript's answer for the same request: same keys, same values, same refusal words.
//!   - The only reading of host data is the two DATA files this crate includes at build time (quiet-hours.json).

pub mod collation;
pub mod date;
pub mod evaluate;
pub mod js;
pub mod quiet_hours;
pub mod records;
pub mod recurring;
pub mod requests;
pub mod spread;
pub mod wall_time;
pub mod when_to_wake;
pub mod zone_drift;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod host;
