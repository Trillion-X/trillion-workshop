//! crates/timed-action/src/when_to_wake.rs
//!
//! Purpose
//!   One call a wake makes. It reads the person's schedule DATA (recurring schedules with their occurrence state, and
//!   one-off scheduled actions with their windows and receipts), and answers three things: what is due now, which
//!   recurring occurrences to record before running them, and when to wake next. The alarm is the only clock; both
//!   reductions it composes stay pure. This is the Rust reading of do-work/when-to-wake.ts.
//!
//! Non-negotiable invariants
//!   1. `now` is given (ISO text or epoch milliseconds); nothing here reads a clock, so a replayed wake gives the same
//!      answer.
//!   2. A recurring occurrence is due once its start has come and stays due until its owner's outcome is proven
//!      (recurring::materialize keeps it active); a one-off action is due once its window has come and until a receipt
//!      names it (evaluate::evaluate).
//!   3. next_wake_at is the earliest start still ahead, counting what is due now as done: the occurrence after each due
//!      recurring one, recurring occurrences not yet due, and unfired one-off actions that carry their dispatch; null
//!      when nothing is ahead.
//!   4. Nothing here names a schedule, action or owner; each row carries its own dispatch.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::date;
use crate::evaluate::{self, action_operation, fired_keys, receipt_key, resolve_due_at, window_by_record};
use crate::js::{self, get, get_opt, key_of, list, to_str, to_str_opt, truthy, Refused, Res};
use crate::recurring::{self, MaterializeInput, Materialized};
use crate::spread;

/// The windows and the spread config a wake reads, after the spread has moved them.
struct Spread<'a> {
    config: &'a Value,
    interval_by_schedule: HashMap<String, f64>,
}

impl Spread<'_> {
    fn active(&self) -> bool {
        truthy(self.config)
    }

    /// `spreadStart(occurrence)`: the occurrence's start moved by its spread (only when a spread is set).
    fn start_of(&self, occurrence: &Value) -> Res<Value> {
        if !self.active() {
            return Ok(occurrence.clone());
        }
        let schedule_id = to_str_opt(get_opt(occurrence, "schedule_id"));
        let interval = self.interval_by_schedule.get(&schedule_id).copied().unwrap_or(0.0);
        let start_ms = recurring::start_ms_of(occurrence);
        let moved = spread::spread_recurring_start(start_ms, &schedule_id, interval, self.config);
        Ok(recurring::with_field(occurrence.clone(), "start", Value::from(date::to_iso(moved)?)))
    }
}

/// `createdAtOf(window)`: the window's created_at as ms, or None when it is not a time.
fn created_at_of(window: &Value) -> Option<f64> {
    let created_text = match get(window, "created_at") {
        Value::Null => Value::from(""),
        value => value.clone(),
    };
    let created = date::parse(&to_str(&created_text));
    created.is_finite().then_some(created)
}

/// `whenToWake(input)`: the answer of one wake, as JSON.
pub fn when_to_wake(input: &Value) -> Res<Value> {
    let now_value = get_opt(input, "now");
    let now_ms = match now_value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        other => date::parse(&to_str_opt(other)),
    };
    if !now_ms.is_finite() {
        return Err(Refused::error("when-to-wake: `now` is not a time"));
    }
    let now = date::to_iso(now_ms)?;

    let schedules = list(get(input, "schedules"));
    let occurrence_states = list(get(input, "occurrence_states"));
    let max_days = get_opt(input, "max_calendar_scan_days");
    let resume = get(input, "resume_from_ms").as_f64().filter(|x| x.is_finite());
    let recurring = recurring::materialize(&MaterializeInput {
        schedules,
        occurrence_states,
        max_calendar_scan_days: max_days,
        now_ms: Some(now_ms),
        resume_from_ms: resume,
    })?;

    // With a spread config, a recurring occurrence starts a share of its interval later; the one-off windows below are
    // moved only earlier. The reductions then see the spread times, so due and next wake agree.
    let spread_config = get(input, "spread");
    let mut interval_by_schedule = HashMap::new();
    for schedule in schedules {
        if schedule.is_null() {
            return Err(Refused::type_error("Cannot read properties of null (reading 'schedule_id')"));
        }
        if let Some(id) = js::text(get(schedule, "schedule_id")) {
            interval_by_schedule.insert(id.to_string(), spread::interval_ms_of(get(schedule, "cadence")));
        }
    }
    let spread = Spread { config: spread_config, interval_by_schedule };

    let mut active = Vec::with_capacity(recurring.active_occurrences.len());
    for occurrence in &recurring.active_occurrences {
        active.push(spread.start_of(occurrence)?);
    }
    let recurring_due: Vec<Value> = active
        .iter()
        .filter(|occurrence| recurring::start_ms_of(occurrence) <= now_ms)
        .cloned()
        .collect();
    let due_keys: HashSet<String> = recurring_due
        .iter()
        .map(|occurrence| to_str(get(occurrence, "occurrence_key")))
        .collect();
    // The occurrences that follow once what is due now is done: the same reduction with each due occurrence proven.
    let after_due: Vec<Value> = if recurring_due.is_empty() {
        active
    } else {
        let mut states: Vec<Value> = occurrence_states.to_vec();
        let mut seen = HashSet::new();
        for occurrence in &recurring_due {
            let key = to_str(get(occurrence, "occurrence_key"));
            if seen.insert(key.clone()) {
                states.push(js::object(vec![
                    ("occurrence_key", Value::from(key)),
                    (
                        "owner_outcome",
                        js::object(vec![
                            ("proven", Value::Bool(true)),
                            ("owner_ref", Value::from("when-to-wake")),
                            ("proof_ref", Value::from("counted-as-done")),
                            ("observed_at", Value::from(now.clone())),
                        ]),
                    ),
                ]));
            }
        }
        let again: Materialized = recurring::materialize(&MaterializeInput {
            schedules,
            occurrence_states: &states,
            max_calendar_scan_days: max_days,
            now_ms: Some(now_ms),
            resume_from_ms: resume,
        })?;
        let mut moved = Vec::with_capacity(again.active_occurrences.len());
        for occurrence in &again.active_occurrences {
            moved.push(spread.start_of(occurrence)?);
        }
        moved
    };
    let mut ahead: Vec<f64> = after_due
        .iter()
        .map(recurring::start_ms_of)
        .filter(|start| *start > now_ms)
        .collect();

    let time_windows = spread_time_windows(list(get(input, "time_windows")), &spread)?;
    let actions = list(get(input, "actions"));
    let receipts = list(get(input, "receipts"));
    let scheduled = evaluate::evaluate(&time_windows, actions, receipts, date::time_clip(now_ms))?;

    let windows = window_by_record(&time_windows);
    let fired = fired_keys(receipts);
    for action in actions {
        let record_id = get(action, "record_id");
        if record_id.is_null() || !evaluate::dispatch_named(action) {
            continue;
        }
        if fired.contains(&receipt_key(record_id, &action_operation(action))) {
            continue;
        }
        let window = key_of(Some(record_id)).and_then(|key| windows.get(&key).copied());
        let due_at = resolve_due_at(window);
        let due_ms = if due_at.is_null() { f64::NAN } else { date::parse(&to_str(&due_at)) };
        if due_ms > now_ms {
            ahead.push(due_ms);
        }
    }

    let next_wake_at = match ahead.iter().copied().reduce(f64::min) {
        Some(earliest) => Value::from(date::to_iso(earliest)?),
        None => Value::Null,
    };
    let due_materializations: Vec<Value> = recurring
        .materializations
        .iter()
        .filter(|materialization| due_keys.contains(&to_str(get(materialization, "materialization_key"))))
        .cloned()
        .collect();
    Ok(js::object(vec![
        ("now", Value::from(now)),
        ("recurring_due", Value::Array(recurring_due)),
        ("materializations", Value::Array(due_materializations)),
        ("scheduled_due", Value::Array(scheduled.due)),
        ("next_wake_at", next_wake_at),
        ("rejected_schedules", Value::Array(recurring.rejected_schedules)),
        ("skipped_resolutions", Value::Array(recurring.skipped_resolutions)),
    ]))
}

/// The one-off windows with their due_at moved by the spread (only when a spread is set and the window has a due time).
fn spread_time_windows(windows: &[Value], spread: &Spread<'_>) -> Res<Vec<Value>> {
    let mut out = Vec::with_capacity(windows.len());
    for window in windows {
        let due_ms = date::parse(&to_str(&match resolve_due_at(Some(window)) {
            Value::Null => Value::from(""),
            due => due,
        }));
        if !spread.active() || !due_ms.is_finite() {
            out.push(window.clone());
            continue;
        }
        let record_id = to_str_opt(get_opt(window, "record_id"));
        let moved = spread::spread_one_shot_due(due_ms, &record_id, created_at_of(window), spread.config);
        out.push(recurring::with_field(window.clone(), "due_at", Value::from(date::to_iso(moved)?)));
    }
    Ok(out)
}
