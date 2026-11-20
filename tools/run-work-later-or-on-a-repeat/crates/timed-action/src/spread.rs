//! crates/timed-action/src/spread.rs
//!
//! Purpose
//!   Spread scheduled fires so many stores do not all run at :00, without ever making a time a person pinned late. A
//!   recurring occurrence slips later by a share of its own interval (capped); a one-off fire that lands on a round
//!   minute moves only earlier, by a few seconds, and never before its record was created. The offset comes from the
//!   row's own id (BLAKE3), so the same row has the same offset on every wake and after every restart.
//!
//! Non-negotiable invariants
//!   1. Pure: nothing reads a clock or randomness. The fraction is the first four bytes of BLAKE3(id) read as a
//!      big-endian unsigned integer over 2^32, so a replayed wake gives the same answer.
//!   2. Every number is the caller's `spread` config (src/scheduler.json `spread`); with none, nothing moves.
//!   3. A recurring occurrence only moves later and by at most `recurring_cap_seconds`; a one-off moves only earlier,
//!      only from a minute divisible by `one_shot_minute_mod`, and never before `created_at_ms`.
//!   4. Config numbers are read as JavaScript reads them (ToNumber); a missing number is NaN, which the arithmetic
//!      carries as the TypeScript does.

use serde_json::Value;

use crate::js::{get, get_opt, to_number, to_number_opt, truthy};

const MS_PER_MINUTE: f64 = 60_000.0;

/// `fractionOf(id)`: a number in [0, 1) that is the same for the same id on every wake.
pub fn fraction_of(id: &str) -> f64 {
    let hash = blake3::hash(id.as_bytes());
    let bytes = hash.as_bytes();
    let word = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    f64::from(word) / 4_294_967_296.0
}

/// `intervalMsOf(cadence)`: the length of a schedule's step in milliseconds, from its cadence; 0 for a unit it does not know.
pub fn interval_ms_of(cadence: &Value) -> f64 {
    let unit_minutes = match get(cadence, "unit").as_str() {
        Some("minute") => 1.0,
        Some("hour") => 60.0,
        Some("day") => 1_440.0,
        Some("week") => 10_080.0,
        _ => return 0.0,
    };
    let interval = match get(cadence, "interval") {
        Value::Null => 1.0,
        other => to_number(other),
    };
    unit_minutes * interval * MS_PER_MINUTE
}

/// A config number, read as ToNumber reads it: NaN when the key is missing.
fn number_of(config: &Value, key: &str) -> f64 {
    to_number_opt(get_opt(config, key))
}

/// `spreadRecurringStart(startMs, id, intervalMs, config)`: the start moved later by frac(id) x recurring_frac x
/// interval, at most the cap.
pub fn spread_recurring_start(start_ms: f64, id: &str, interval_ms: f64, config: &Value) -> f64 {
    if !truthy(config) || interval_ms.is_nan() || interval_ms <= 0.0 {
        return start_ms;
    }
    let slip = crate::js::min(
        fraction_of(id) * number_of(config, "recurring_frac") * interval_ms,
        number_of(config, "recurring_cap_seconds") * 1_000.0,
    );
    start_ms + slip.floor()
}

/// `spreadOneShotDue(dueMs, id, createdAtMs, config)`: a due time on a round minute moves only earlier, never before
/// its creation.
pub fn spread_one_shot_due(due_ms: f64, id: &str, created_at_ms: Option<f64>, config: &Value) -> f64 {
    if !truthy(config) {
        return due_ms;
    }
    let minute_mod = number_of(config, "one_shot_minute_mod");
    if minute_mod.is_nan() || minute_mod <= 0.0 {
        return due_ms;
    }
    if due_ms % MS_PER_MINUTE != 0.0 {
        return due_ms;
    }
    if (due_ms / MS_PER_MINUTE).floor() % minute_mod != 0.0 {
        return due_ms;
    }
    let floor_seconds = number_of(config, "one_shot_floor_seconds");
    let max_seconds = number_of(config, "one_shot_max_seconds");
    let early = (floor_seconds + fraction_of(id) * (max_seconds - floor_seconds)) * 1_000.0;
    let moved = due_ms - early.floor();
    match created_at_ms {
        Some(created) if moved < created => due_ms,
        _ => moved,
    }
}
