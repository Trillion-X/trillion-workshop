//! crates/timed-action/src/quiet_hours.rs
//!
//! Purpose
//!   Whether a moment is inside a person's working hours, and what a sender should be told when it is not: the
//!   quiet-hours answer a composer reads before writing to that person. Pure: no clock, no store. This is the Rust
//!   reading of do-work/quiet-hours.ts; its modes are the DATA file do-work/quiet-hours.json, read into the build.
//!
//! Non-negotiable invariants
//!   1. Working hours are a local wall-clock window in the person's own zone. An end not after the start is an
//!      overnight shift: the window runs into the next local day. Clock changes follow wall_time.rs.
//!   2. An unknown zone, a malformed time or a bad weekday list is refused (TypeError), never read as UTC or as
//!      always open.
//!   3. What a mode does is DATA (quiet-hours.json); nothing here names a mode.
//!   4. A dismissed notice lasts only for the quiet period it was dismissed in.
//!   5. Quiet hours are advice to the sender. Nothing here blocks a message.

use std::sync::OnceLock;

use serde_json::Value;

use crate::date::DAY_MS;
use crate::js::{self, get, get_opt, to_str, to_str_opt, truthy, Refused, Res};
use crate::wall_time;

/// The DATA this module reads: the default mode and the modes a person can choose.
const QUIET_HOURS_DATA: &str = include_str!("../../../do-work/quiet-hours.json");

fn data() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| serde_json::from_str(QUIET_HOURS_DATA).unwrap_or(Value::Null))
}

fn modes() -> &'static Value {
    get(data(), "modes")
}

/// Working hours as checkedWorkingHours returns them: the zone's canonical name and the weekdays, sorted and unique.
pub struct Working {
    pub start: Value,
    pub end: Value,
    pub start_text: String,
    pub end_text: String,
    pub time_zone: String,
    pub weekdays: Vec<i64>,
}

/// `checkedWorkingHours(hours)`.
pub fn checked_working_hours(hours: &Value) -> Res<Working> {
    let zone = wall_time::time_zone_name(get(hours, "time_zone"));
    let start_text = to_str_opt(get_opt(hours, "start"));
    let end_text = to_str_opt(get_opt(hours, "end"));
    let (Some(zone), true, true) = (
        zone,
        wall_time::parse_time(&start_text).is_some(),
        wall_time::parse_time(&end_text).is_some(),
    ) else {
        return Err(Refused::type_error(
            "Working hours need start and end like 09:00 and a time zone like America/New_York.",
        ));
    };
    let days: Vec<Value> = match get(hours, "weekdays") {
        Value::Null => (0..=6).map(Value::from).collect(),
        Value::Array(items) => items.clone(),
        _ => Vec::new(),
    };
    let whole_day = |day: &Value| js::as_integer(day).filter(|value| (0.0..=6.0).contains(value));
    if days.is_empty() || days.iter().any(|day| whole_day(day).is_none()) {
        return Err(Refused::type_error("Working weekdays are whole numbers from 0 (Sunday) to 6."));
    }
    let mut weekdays: Vec<i64> = days.iter().filter_map(whole_day).map(|day| day as i64).collect();
    weekdays.sort_unstable();
    weekdays.dedup();
    Ok(Working {
        start: get(hours, "start").clone(),
        end: get(hours, "end").clone(),
        start_text,
        end_text,
        time_zone: zone,
        weekdays,
    })
}

impl Working {
    /// `checked` as the TypeScript returns it, for the caller that writes it as JSON.
    pub fn to_value(&self) -> Value {
        js::object(vec![
            ("start", self.start.clone()),
            ("end", self.end.clone()),
            ("time_zone", Value::from(self.time_zone.clone())),
            ("weekdays", Value::Array(self.weekdays.iter().map(|day| Value::from(*day)).collect())),
        ])
    }
}

/// The working windows that can touch an instant: those starting the local day before, the same day and the next.
fn windows_around(hours: &Working, at_ms: f64) -> Res<Vec<(f64, f64)>> {
    let today = wall_time::local_parts(at_ms, &hours.time_zone)?.date;
    let overnight = hours.end_text <= hours.start_text;
    let mut found = Vec::new();
    for offset in [-1.0, 0.0, 1.0] {
        let day = wall_time::add_civil_days(&today, offset)?;
        if !hours.weekdays.contains(&wall_time::weekday(&day)?) {
            continue;
        }
        let next_valid = Value::from("next-valid");
        let earlier = Value::from("earlier");
        let from = wall_time::instant_at(&day, &hours.start_text, &hours.time_zone, &next_valid, &earlier)?;
        let to_day = if overnight { wall_time::add_civil_days(&day, 1.0)? } else { day.clone() };
        let to = wall_time::instant_at(&to_day, &hours.end_text, &hours.time_zone, &next_valid, &earlier)?;
        if let (Some(from), Some(to)) = (from, to) {
            if to > from {
                found.push((from, to));
            }
        }
    }
    Ok(found)
}

/// `quietHoursAnswer(hours, atMs, mode, dismissedPeriodStartMs)`.
pub fn quiet_hours_answer(hours: &Value, at_ms: f64, mode: Option<&Value>, dismissed: Option<f64>) -> Res<Value> {
    let mode_key = match mode {
        Some(value) => to_str(value),
        None => get(data(), "default_mode").as_str().unwrap_or_default().to_string(),
    };
    let row = get(modes(), &mode_key);
    if row.is_null() {
        let names: Vec<&str> = modes()
            .as_object()
            .map(|object| object.keys().map(String::as_str).collect())
            .unwrap_or_default();
        return Err(Refused::type_error(format!("The mode is one of: {}.", names.join(", "))));
    }
    let nudge_mode = truthy(get(row, "nudge"));
    let silent_mode = truthy(get(row, "silent"));
    if !truthy(hours) {
        return Ok(quiet_answer_none());
    }
    let checked = checked_working_hours(hours)?;
    let mut windows = Vec::new();
    windows.extend(windows_around(&checked, at_ms - DAY_MS)?);
    windows.extend(windows_around(&checked, at_ms)?);
    windows.extend(windows_around(&checked, at_ms + DAY_MS)?);
    windows.sort_by(|left, right| left.0.total_cmp(&right.0));
    if windows.iter().any(|(from, to)| *from <= at_ms && at_ms < *to) {
        return Ok(quiet_answer_none());
    }
    let before = windows.iter().rev().find(|(_, to)| *to <= at_ms);
    let after = windows.iter().find(|(from, _)| *from > at_ms);
    let start = before.map(|(_, to)| *to);
    let dismissed_this_period = start.is_some() && dismissed == start;
    Ok(js::object(vec![
        ("quiet", Value::Bool(true)),
        ("period_start_ms", start.map_or(Value::Null, js::num)),
        ("opens_at_ms", after.map_or(Value::Null, |(from, _)| js::num(*from))),
        ("nudge", Value::Bool(nudge_mode && !dismissed_this_period)),
        ("send_silently", Value::Bool(silent_mode)),
    ]))
}

fn quiet_answer_none() -> Value {
    js::object(vec![
        ("quiet", Value::Bool(false)),
        ("period_start_ms", Value::Null),
        ("opens_at_ms", Value::Null),
        ("nudge", Value::Bool(false)),
        ("send_silently", Value::Bool(false)),
    ])
}
