//! crates/timed-action/src/recurring.rs
//!
//! Purpose
//!   timed-action's recurrence reducers, as pure DATA reductions. They own recurring window identity and progression,
//!   never clocks or effects: a caller gives schedule DATA plus durable occurrence state, and the answer names the
//!   occurrences that are due, the materialization intents to persist (compare-and-exchange on occurrence_key), and
//!   the occurrences that are still ahead. This is the Rust reading of do-work/materialize-recurring-windows.ts.
//!
//! Non-negotiable invariants
//!   1. A schedule is validated by the same rules, in the same order, and refused with the same reason words.
//!   2. A recurring occurrence's identity is the text timed-action.recurring-window::<encoded JSON of its 13 identity
//!      parts>; two schedules that differ in any part never share an occurrence_key.
//!   3. Schedules are visited in ICU collation order of their ids (collation.rs), so the answer lists them as the
//!      TypeScript does.
//!   4. A schedule that was asleep runs once on waking, for its latest time, and says how many it passed over.

use std::collections::HashMap;

use serde_json::Value;

use crate::collation::locale_compare;
use crate::date;
use crate::js::{self, as_integer, encode_uri_component, get, get_opt, identity_text, json_text, list, text, to_str, to_str_opt, truthy, Refused, Res};
use crate::wall_time::{self, Civil, Resolved};

/// Nothing repeats more often than this: a schedule is work someone's account pays for on every run.
pub const MIN_STEP_MINUTES: f64 = 5.0;
const DAY_MINUTES: i64 = 1_440;
const MAX_CALENDAR_SCAN_DAYS: f64 = 4_096.0;
const MAX_PLANNED_OCCURRENCES_PER_SCHEDULE: f64 = 1_000.0;

/// A schedule that passed every rule of scheduleError, read into the values the reducers use.
struct Valid<'a> {
    raw: &'a Value,
    schedule_id: String,
    schedule_id_value: Value,
    generation: String,
    revision: String,
    timezone: String,
    timezone_value: Value,
    start_date: String,
    start_time: String,
    duration: i64,
    unit: &'static str,
    interval: i64,
    weekdays: Vec<i64>,
    gap: Value,
    fold: Value,
    label: Value,
    step: Option<i64>,
}

/// `schedule.dst?.gap ?? 'skip'` and `schedule.dst?.fold ?? 'earlier'`: a set value is kept as the schedule wrote it.
fn policy(schedule: &Value, key: &str, default: &str) -> Value {
    match get(get(schedule, "dst"), key) {
        Value::Null => Value::from(default),
        set => set.clone(),
    }
}

/// `stepMinutes(schedule)`: how many minutes apart a schedule that repeats within the day runs; None for one that runs
/// once a day or week.
fn step_minutes(unit: &str, interval: i64) -> Option<i64> {
    match unit {
        "minute" => Some(interval),
        "hour" => Some(60 * interval),
        _ => None,
    }
}

/// The reason a schedule is refused, or the schedule read into its values (scheduleError, in its order).
fn validate(schedule: &Value) -> Result<Valid<'_>, &'static str> {
    let schedule_id = match text(get(schedule, "schedule_id")) {
        Some(id) => id.to_string(),
        None => return Err("missing_identity_component"),
    };
    let generation = identity_text(get(schedule, "source_generation"));
    let revision = identity_text(get(schedule, "schedule_revision"));
    let (Some(generation), Some(revision)) = (generation, revision) else {
        return Err("missing_identity_component");
    };
    let local = get(schedule, "local_window");
    let start_date = to_str_opt(get_opt(schedule, "start_local_date"));
    let start_time = to_str_opt(get_opt(local, "start"));
    if wall_time::parse_date(&start_date).is_none() || wall_time::parse_time(&start_time).is_none() {
        return Err("invalid_local_window");
    }
    let duration = match as_integer(get(local, "duration_minutes")) {
        Some(minutes) if minutes > 0.0 && minutes <= 10_080.0 => minutes as i64,
        _ => return Err("invalid_duration"),
    };
    let cadence = get(schedule, "cadence");
    let interval = match get(cadence, "interval") {
        Value::Null => 1,
        other => match as_integer(other) {
            Some(value) if value > 0.0 && value <= 512.0 => value as i64,
            _ => return Err("invalid_interval"),
        },
    };
    let unit: &'static str = match get(cadence, "unit").as_str() {
        Some("minute") => "minute",
        Some("hour") => "hour",
        Some("day") => "day",
        Some("week") => "week",
        _ => return Err("invalid_cadence_unit"),
    };
    let step = step_minutes(unit, interval);
    if let Some(minutes) = step {
        if !(MIN_STEP_MINUTES as i64..=DAY_MINUTES).contains(&minutes) {
            return Err("invalid_interval");
        }
    }
    let weekdays = list(get(cadence, "weekdays"));
    if unit == "week"
        && (weekdays.is_empty()
            || weekdays
                .iter()
                .any(|value| !matches!(as_integer(value), Some(day) if (0.0..=6.0).contains(&day))))
    {
        return Err("invalid_weekdays");
    }
    let dst = get(schedule, "dst");
    let gap = get(dst, "gap");
    if truthy(gap) && gap.as_str() != Some("skip") && gap.as_str() != Some("next-valid") {
        return Err("invalid_gap_policy");
    }
    let fold = get(dst, "fold");
    if truthy(fold) && !matches!(fold.as_str(), Some("earlier" | "later" | "both")) {
        return Err("invalid_fold_policy");
    }
    let action = get(schedule, "action");
    if text(get(action, "operation")).is_none()
        || text(get(action, "owner_ref")).is_none()
        || text(get(get(action, "owner_dispatch"), "name")).is_none()
    {
        return Err("invalid_action_owner");
    }
    let timezone = match wall_time::time_zone_name(get(schedule, "timezone")) {
        Some(_) => to_str(get(schedule, "timezone")),
        None => return Err("invalid_timezone"),
    };
    let weekday_values: Vec<i64> = weekdays
        .iter()
        .filter_map(as_integer)
        .map(|day| day as i64)
        .collect();
    Ok(Valid {
        raw: schedule,
        schedule_id_value: Value::from(schedule_id.clone()),
        schedule_id,
        generation,
        revision,
        timezone_value: get(schedule, "timezone").clone(),
        timezone,
        start_date,
        start_time,
        duration,
        unit,
        interval,
        weekdays: weekday_values,
        gap: policy(schedule, "gap", "skip"),
        fold: policy(schedule, "fold", "earlier"),
        label: text(get(schedule, "label"))
            .or_else(|| text(get(schedule, "title")))
            .or_else(|| text(get(schedule, "name")))
            .map_or(Value::Null, Value::from),
        step,
    })
}

/// `requestedTimes(schedule)`: the local times a schedule asks for on one date, earliest first.
fn requested_times(schedule: &Valid<'_>) -> Vec<String> {
    match schedule.step {
        None => vec![schedule.start_time.clone()],
        Some(step) => {
            let (hour, minute) = wall_time::parse_time(&schedule.start_time).unwrap_or((0, 0));
            let first = (hour * 60 + minute) % step;
            let mut times = Vec::new();
            let mut at = first;
            while at < DAY_MINUTES {
                times.push(format!("{:02}:{:02}", at / 60, at % 60));
                at += step;
            }
            times
        }
    }
}

/// Whole civil days from `from` to `to` (YYYY-MM-DD), negative when `to` is earlier.
fn civil_days_between(from: &str, to: &str) -> Res<i64> {
    let (fy, fm, fd) = wall_time::parse_date(from)
        .ok_or_else(|| Refused::type_error("Cannot read properties of null (reading 'year')"))?;
    let (ty, tm, td) = wall_time::parse_date(to)
        .ok_or_else(|| Refused::type_error("Cannot read properties of null (reading 'year')"))?;
    Ok(date::days_from_civil(ty, tm, td) - date::days_from_civil(fy, fm, fd))
}

/// `isCandidateDate(schedule, date, offsetDays)`.
fn is_candidate_date(schedule: &Valid<'_>, date: &str, offset_days: i64) -> Res<bool> {
    if schedule.step.is_some() {
        return Ok(true);
    }
    if schedule.unit == "day" {
        return Ok(offset_days % schedule.interval == 0);
    }
    // A Sunday-anchored week index, the same on every host.
    let (sy, sm, sd) = wall_time::parse_date(&schedule.start_date)
        .ok_or_else(|| Refused::type_error("Cannot read properties of null (reading 'year')"))?;
    let start_day = date::days_from_civil(sy, sm, sd);
    let start_week = start_day - wall_time::weekday(&schedule.start_date)?;
    let candidate_day = {
        let (cy, cm, cd) = wall_time::parse_date(date)
            .ok_or_else(|| Refused::type_error("Cannot read properties of null (reading 'year')"))?;
        date::days_from_civil(cy, cm, cd)
    };
    let candidate_week = candidate_day - wall_time::weekday(date)?;
    let week_index = (candidate_week - start_week).div_euclid(7);
    Ok(week_index >= 0
        && week_index % schedule.interval == 0
        && schedule.weekdays.contains(&wall_time::weekday(date)?))
}

/// `recurringOccurrenceKey(identity)` over the 13 identity parts in their order.
pub fn occurrence_key(parts: &[Value]) -> String {
    format!(
        "timed-action.recurring-window::{}",
        encode_uri_component(&json_text(&Value::Array(parts.to_vec())))
    )
}

fn civil_value(civil: &Civil) -> Value {
    js::object(vec![("date", Value::from(civil.date.clone())), ("time", Value::from(civil.time.clone()))])
}

/// The occurrence key of one resolved instance of a requested time.
fn key_for(schedule: &Valid<'_>, requested_start: &Civil, requested_end: &Civil, resolved: &Resolved, resolved_end: &Civil) -> String {
    occurrence_key(&[
        schedule.schedule_id_value.clone(),
        Value::from(schedule.generation.clone()),
        Value::from(schedule.revision.clone()),
        schedule.timezone_value.clone(),
        Value::from(requested_start.date.clone()),
        Value::from(requested_start.time.clone()),
        Value::from(requested_end.date.clone()),
        Value::from(requested_end.time.clone()),
        Value::from(resolved.resolved.date.clone()),
        Value::from(resolved.resolved.time.clone()),
        Value::from(resolved_end.date.clone()),
        Value::from(resolved_end.time.clone()),
        resolved.fold.clone(),
    ])
}

/// One resolved instance of a requested local window.
#[derive(Clone)]
struct Candidate {
    start: Resolved,
    resolved_end: Civil,
    key: String,
}

/// A held time: the candidates of one requested local window.
struct Held {
    candidates: Vec<Candidate>,
    requested_start: Civil,
    requested_end: Civil,
}

fn owner_outcome_proven(state: &Value) -> bool {
    let outcome = get(state, "owner_outcome");
    get(outcome, "proven") == &Value::Bool(true)
        && text(get(outcome, "owner_ref")).is_some()
        && text(get(outcome, "proof_ref")).is_some()
        && text(get(outcome, "observed_at")).is_some()
}

fn materialization_committed(state: &Value) -> bool {
    get(state, "materialization_key") == get(state, "occurrence_key")
        && text(get(state, "materialized_at")).is_some()
}

/// The inputs of materializeRecurringWindows, as the reducers read them.
pub struct MaterializeInput<'a> {
    pub schedules: &'a [Value],
    pub occurrence_states: &'a [Value],
    pub max_calendar_scan_days: Option<&'a Value>,
    pub now_ms: Option<f64>,
    pub resume_from_ms: Option<f64>,
}

/// The answer of materializeRecurringWindows, as lists of JSON values.
pub struct Materialized {
    pub materializations: Vec<Value>,
    pub active_occurrences: Vec<Value>,
    pub rejected_schedules: Vec<Value>,
    pub skipped_resolutions: Vec<Value>,
}

impl Materialized {
    pub fn to_value(&self) -> Value {
        js::object(vec![
            ("schema", Value::from("timed-action.recurring-window-materialization.v1")),
            ("materializations", Value::Array(self.materializations.clone())),
            ("active_occurrences", Value::Array(self.active_occurrences.clone())),
            ("rejected_schedules", Value::Array(self.rejected_schedules.clone())),
            ("skipped_resolutions", Value::Array(self.skipped_resolutions.clone())),
        ])
    }
}

/// `maxDays`: a whole positive scan bound, at most MAX_CALENDAR_SCAN_DAYS.
fn scan_bound(value: Option<&Value>) -> f64 {
    match value.and_then(as_integer) {
        Some(days) if days > 0.0 => days.min(MAX_CALENDAR_SCAN_DAYS),
        _ => MAX_CALENDAR_SCAN_DAYS,
    }
}

/// The schedule id a sort and a rejection read: `String(schedule?.schedule_id ?? '')`.
fn schedule_id_text(schedule: &Value) -> String {
    match get(schedule, "schedule_id") {
        Value::Null => String::new(),
        value => to_str(value),
    }
}

/// Schedules sorted by ICU collation of their ids, stable as Array.prototype.sort is.
fn sorted_schedules(schedules: &[Value]) -> Vec<&Value> {
    let mut sorted: Vec<&Value> = schedules.iter().collect();
    sorted.sort_by(|left, right| locale_compare(&schedule_id_text(left), &schedule_id_text(right)));
    sorted
}

/// The occurrence states recorded under one key.
fn states_of<'m, 'v>(states_by_key: &'m HashMap<String, Vec<&'v Value>>, key: &str) -> &'m [&'v Value] {
    states_by_key.get(key).map_or(&[], Vec::as_slice)
}

/// The count of each schedule id among schedules whose id is text.
fn id_counts(schedules: &[Value]) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for schedule in schedules {
        if let Some(id) = text(get(schedule, "schedule_id")) {
            *counts.entry(id.to_string()).or_insert(0) += 1;
        }
    }
    counts
}

/// `materializeRecurringWindows(input)`.
pub fn materialize(input: &MaterializeInput<'_>) -> Res<Materialized> {
    let max_days = scan_bound(input.max_calendar_scan_days);
    let counts = id_counts(input.schedules);
    let mut states_by_key: HashMap<String, Vec<&Value>> = HashMap::new();
    for state in input.occurrence_states {
        if let Some(key) = text(get(state, "occurrence_key")) {
            states_by_key.entry(key.to_string()).or_default().push(state);
        }
    }

    let mut out = Materialized {
        materializations: Vec::new(),
        active_occurrences: Vec::new(),
        rejected_schedules: Vec::new(),
        skipped_resolutions: Vec::new(),
    };
    for raw in sorted_schedules(input.schedules) {
        let schedule = match validate(raw) {
            Ok(schedule) => schedule,
            Err(reason) => {
                out.rejected_schedules.push(js::object(vec![
                    ("schedule_id", Value::from(schedule_id_text(raw))),
                    ("reason", Value::from(reason)),
                ]));
                continue;
            }
        };
        if counts.get(&schedule.schedule_id).copied().unwrap_or(0) != 1 {
            out.rejected_schedules.push(js::object(vec![
                ("schedule_id", Value::from(schedule.schedule_id.clone())),
                ("reason", Value::from("conflicting_schedule_id")),
            ]));
            continue;
        }
        materialize_one(input, &schedule, &states_by_key, max_days, &mut out)?;
    }
    Ok(out)
}

fn materialize_one(
    input: &MaterializeInput<'_>,
    schedule: &Valid<'_>,
    states_by_key: &HashMap<String, Vec<&Value>>,
    max_days: f64,
    out: &mut Materialized,
) -> Res<()> {
    let times = requested_times(schedule);
    let passed = |candidate: &Candidate| {
        states_of(states_by_key, &candidate.key).iter().any(|state| owner_outcome_proven(state))
            || input.resume_from_ms.is_some_and(|resume| candidate.start.instant_ms < resume)
    };
    let max_days = max_days as i64;
    let mut selected = false;
    let mut held: Option<Held> = None;
    let mut missed: i64 = 0;
    let mut missed_since: Option<String> = None;
    let resume_date = match input.resume_from_ms {
        Some(resume) => Some(wall_time::local_parts(resume, &schedule.timezone)?.date),
        None => None,
    };
    let now_offset = match input.now_ms {
        Some(now) => Some(civil_days_between(&schedule.start_date, &wall_time::local_parts(now, &schedule.timezone)?.date)?),
        None => None,
    };
    let from_resume = match &resume_date {
        Some(date) => civil_days_between(&schedule.start_date, date)? - 1,
        None => 0,
    };
    let from_now = match now_offset {
        Some(offset) => offset - max_days + 2,
        None => 0,
    };
    let first_offset = 0.max(from_resume).max(from_now);
    for offset in first_offset..first_offset + max_days {
        if selected {
            break;
        }
        let date = wall_time::add_civil_days(&schedule.start_date, offset as f64)?;
        if !is_candidate_date(schedule, &date, offset)? {
            continue;
        }
        for requested_time in &times {
            if selected {
                break;
            }
            let requested_start = Civil { date: date.clone(), time: requested_time.clone() };
            let requested_end = wall_time::add_civil_minutes(&requested_start, schedule.duration as f64)?;
            let starts = wall_time::resolve_start(&requested_start, &schedule.timezone, &schedule.gap, &schedule.fold)?;
            if starts.is_empty() {
                out.skipped_resolutions.push(js::object(vec![
                    ("schedule_id", schedule.schedule_id_value.clone()),
                    ("requested_start", civil_value(&requested_start)),
                    ("timezone", schedule.timezone_value.clone()),
                    ("reason", Value::from("dst_gap_skip")),
                ]));
                continue;
            }
            let mut candidates = Vec::with_capacity(starts.len());
            for start in starts {
                let resolved_end = wall_time::add_civil_minutes(&start.resolved, schedule.duration as f64)?;
                let key = key_for(schedule, &requested_start, &requested_end, &start, &resolved_end);
                candidates.push(Candidate { start, resolved_end, key });
            }
            // A fold configured as both is one local window with two branches: neither is passed over until both are proven.
            if candidates.iter().all(passed) {
                continue;
            }
            if let Some(previous) = held.take() {
                if let Some(now) = input.now_ms {
                    if candidates.iter().any(|candidate| candidate.start.instant_ms <= now) {
                        if missed_since.is_none() {
                            let earliest = previous
                                .candidates
                                .iter()
                                .map(|candidate| candidate.start.instant_ms)
                                .fold(f64::INFINITY, f64::min);
                            missed_since = Some(date::to_iso(earliest)?);
                        }
                        held = Some(Held { candidates, requested_start, requested_end });
                        missed += 1;
                        continue;
                    }
                }
                held = Some(previous);
                selected = true;
                break;
            }
            let dispatched = candidates
                .iter()
                .any(|candidate| states_of(states_by_key, &candidate.key).iter().any(|state| materialization_committed(state)));
            held = Some(Held { candidates, requested_start, requested_end });
            if dispatched || input.now_ms.is_none() {
                selected = true;
            }
        }
    }
    if let Some(Held { candidates, requested_start, requested_end }) = held {
        selected = true;
        for candidate in &candidates {
            if passed(candidate) {
                continue;
            }
            let committed = states_of(states_by_key, &candidate.key).iter().any(|state| materialization_committed(state));
            let start_ms = candidate.start.instant_ms;
            let occurrence = js::object(vec![
                ("occurrence_key", Value::from(candidate.key.clone())),
                ("schedule_id", schedule.schedule_id_value.clone()),
                ("schedule_label", schedule.label.clone()),
                ("source_generation", Value::from(schedule.generation.clone())),
                ("schedule_revision", Value::from(schedule.revision.clone())),
                ("timezone", schedule.timezone_value.clone()),
                (
                    "requested_local_window",
                    js::object(vec![("start", civil_value(&requested_start)), ("end", civil_value(&requested_end))]),
                ),
                (
                    "resolved_local_window",
                    js::object(vec![
                        ("start", civil_value(&candidate.start.resolved)),
                        ("end", civil_value(&candidate.resolved_end)),
                        ("fold", candidate.start.fold.clone()),
                    ]),
                ),
                ("start", Value::from(date::to_iso(start_ms)?)),
                ("end", Value::from(date::to_iso(start_ms + schedule.duration as f64 * 60_000.0)?)),
                ("action", get(schedule.raw, "action").clone()),
                ("missed_before", js::num(missed as f64)),
                ("missed_since", missed_since.clone().map_or(Value::Null, Value::from)),
            ]);
            if !committed {
                out.materializations.push(js::object(vec![
                    ("kind", Value::from("recurring-window-materialization")),
                    ("materialization_key", Value::from(candidate.key.clone())),
                    ("compare_exchange_key", Value::from(candidate.key.clone())),
                    ("occurrence", occurrence.clone()),
                    (
                        "initial_state",
                        js::object(vec![
                            ("occurrence_key", Value::from(candidate.key.clone())),
                            ("materialization_key", Value::from(candidate.key.clone())),
                            ("materialized_at", Value::Null),
                        ]),
                    ),
                ]));
            }
            out.active_occurrences.push(with_field(occurrence, "retry_same_occurrence", Value::Bool(committed)));
        }
    }
    if !selected {
        out.rejected_schedules.push(js::object(vec![
            ("schedule_id", Value::from(schedule.schedule_id.clone())),
            ("reason", Value::from("scan_limit_without_unresolved_occurrence")),
        ]));
    }
    Ok(())
}

/// An object with one more key at its end (`{ ...object, key: value }`).
pub fn with_field(object: Value, key: &str, value: Value) -> Value {
    let mut object = object;
    if let Value::Object(map) = &mut object {
        map.insert(key.to_string(), value);
    }
    object
}

/// The identity of an occurrence's time for the reducers: its ms, as Date.parse reads its ISO text.
pub fn start_ms_of(occurrence: &Value) -> f64 {
    date::parse(&to_str_opt(get_opt(occurrence, "start")))
}

/// `planRecurringWindows(input)`: bounded future recurrence slots for planning and previews, with coverage.
pub struct PlanInput<'a> {
    pub now_ms: f64,
    pub schedules: &'a [Value],
    pub max_occurrences_per_schedule: f64,
    pub max_calendar_scan_days: Option<&'a Value>,
}

pub fn plan(input: &PlanInput<'_>) -> Res<Value> {
    let count_limit = input.max_occurrences_per_schedule;
    if !(count_limit.fract() == 0.0 && (1.0..=MAX_PLANNED_OCCURRENCES_PER_SCHEDULE).contains(&count_limit)) {
        return Err(Refused::error(format!(
            "plan-recurring-windows: max_occurrences_per_schedule must be an integer from 1 to {}",
            MAX_PLANNED_OCCURRENCES_PER_SCHEDULE as i64
        )));
    }
    let scan_limit = scan_bound(input.max_calendar_scan_days) as i64;
    let counts = id_counts(input.schedules);
    let mut future: Vec<Value> = Vec::new();
    let mut rejected: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    let mut coverage: Vec<Value> = Vec::new();
    let now_ms = input.now_ms;
    for raw in sorted_schedules(input.schedules) {
        let schedule = match validate(raw) {
            Ok(schedule) => schedule,
            Err(reason) => {
                rejected.push(js::object(vec![
                    ("schedule_id", Value::from(schedule_id_text(raw))),
                    ("reason", Value::from(reason)),
                ]));
                continue;
            }
        };
        if counts.get(&schedule.schedule_id).copied().unwrap_or(0) != 1 {
            rejected.push(js::object(vec![
                ("schedule_id", Value::from(schedule.schedule_id.clone())),
                ("reason", Value::from("conflicting_schedule_id")),
            ]));
            continue;
        }
        plan_one(&schedule, now_ms, count_limit as i64, scan_limit, &mut future, &mut skipped, &mut coverage)?;
    }
    future.sort_by(|left, right| {
        let text_of = |value: &Value, key: &str| to_str(get(value, key));
        locale_compare(&text_of(left, "start"), &text_of(right, "start"))
            .then_with(|| locale_compare(&text_of(left, "schedule_id"), &text_of(right, "schedule_id")))
            .then_with(|| locale_compare(&text_of(left, "occurrence_key"), &text_of(right, "occurrence_key")))
    });
    Ok(js::object(vec![
        ("schema", Value::from("timed-action.recurring-window-plan.v1")),
        ("now", Value::from(date::to_iso(now_ms)?)),
        ("max_occurrences_per_schedule", js::num(count_limit)),
        ("max_calendar_scan_days", js::num(scan_limit as f64)),
        ("future_occurrences", Value::Array(future)),
        ("rejected_schedules", Value::Array(rejected)),
        ("skipped_resolutions", Value::Array(skipped)),
        ("coverage", Value::Array(coverage)),
    ]))
}

fn plan_one(
    schedule: &Valid<'_>,
    now_ms: f64,
    count_limit: i64,
    scan_limit: i64,
    future: &mut Vec<Value>,
    skipped: &mut Vec<Value>,
    coverage: &mut Vec<Value>,
) -> Res<()> {
    let times = requested_times(schedule);
    let now_date = wall_time::local_parts(now_ms, &schedule.timezone)?.date;
    let (ny, nm, nd) = wall_time::parse_date(&now_date)
        .ok_or_else(|| Refused::type_error("Cannot read properties of null (reading 'year')"))?;
    let first_offset = 0.max(civil_days_between(&schedule.start_date, &format!("{ny:04}-{nm:02}-{nd:02}"))?);
    let before = future.len() as i64;
    let mut scanned_days = 0_i64;
    let mut through_date: Option<String> = None;
    let mut reached_count_limit = false;
    let mut window_omitted = false;
    'scan: for scan_offset in 0..scan_limit {
        let offset = first_offset + scan_offset;
        let date = wall_time::add_civil_days(&schedule.start_date, offset as f64)?;
        scanned_days += 1;
        through_date = Some(date.clone());
        if !is_candidate_date(schedule, &date, offset)? {
            continue;
        }
        for requested_time in &times {
            let requested_start = Civil { date: date.clone(), time: requested_time.clone() };
            let requested_end = wall_time::add_civil_minutes(&requested_start, schedule.duration as f64)?;
            let starts = wall_time::resolve_start(&requested_start, &schedule.timezone, &schedule.gap, &schedule.fold)?;
            if starts.is_empty() {
                skipped.push(js::object(vec![
                    ("schedule_id", schedule.schedule_id_value.clone()),
                    ("requested_start", civil_value(&requested_start)),
                    ("timezone", schedule.timezone_value.clone()),
                    ("reason", Value::from("dst_gap_skip")),
                ]));
                continue;
            }
            let mut candidates = Vec::new();
            for start in starts {
                if start.instant_ms <= now_ms {
                    continue;
                }
                let resolved_end = wall_time::add_civil_minutes(&start.resolved, schedule.duration as f64)?;
                let key = key_for(schedule, &requested_start, &requested_end, &start, &resolved_end);
                candidates.push(Candidate { start, resolved_end, key });
            }
            let remaining = count_limit - (future.len() as i64 - before);
            // `both` is one requested local window with two branches; it is kept whole or not at all.
            if candidates.len() as i64 > remaining {
                reached_count_limit = true;
                window_omitted = true;
                break 'scan;
            }
            for candidate in candidates {
                future.push(js::object(vec![
                    ("occurrence_key", Value::from(candidate.key.clone())),
                    ("schedule_id", schedule.schedule_id_value.clone()),
                    ("schedule_label", schedule.label.clone()),
                    ("source_generation", Value::from(schedule.generation.clone())),
                    ("schedule_revision", Value::from(schedule.revision.clone())),
                    ("timezone", schedule.timezone_value.clone()),
                    (
                        "requested_local_window",
                        js::object(vec![("start", civil_value(&requested_start)), ("end", civil_value(&requested_end))]),
                    ),
                    (
                        "resolved_local_window",
                        js::object(vec![
                            ("start", civil_value(&candidate.start.resolved)),
                            ("end", civil_value(&candidate.resolved_end)),
                            ("fold", candidate.start.fold.clone()),
                        ]),
                    ),
                    ("start", Value::from(date::to_iso(candidate.start.instant_ms)?)),
                    (
                        "end",
                        Value::from(date::to_iso(candidate.start.instant_ms + schedule.duration as f64 * 60_000.0)?),
                    ),
                    ("action", get(schedule.raw, "action").clone()),
                ]));
                if future.len() as i64 - before == count_limit {
                    reached_count_limit = true;
                    break 'scan;
                }
            }
        }
    }
    let returned = future.len() as i64 - before;
    let scanned_out = scanned_days == scan_limit && !reached_count_limit;
    let stopped_by = if window_omitted {
        "count_limit_before_complete_local_window"
    } else if reached_count_limit {
        "count_limit"
    } else if scanned_out {
        "scan_limit"
    } else {
        "no_future_occurrence_in_scan"
    };
    coverage.push(js::object(vec![
        ("schedule_id", schedule.schedule_id_value.clone()),
        ("requested_count", js::num(count_limit as f64)),
        ("returned_count", js::num(returned as f64)),
        ("scanned_days", js::num(scanned_days as f64)),
        ("scanned_through_local_date", through_date.map_or(Value::Null, Value::from)),
        ("count_limit_reached", Value::Bool(reached_count_limit)),
        ("scan_limit_reached", Value::Bool(scanned_out)),
        ("local_window_omitted_for_count_limit", Value::Bool(window_omitted)),
        ("recurrence_exhausted", Value::Bool(false)),
        ("requested_count_reached", Value::Bool(returned == count_limit)),
        ("stopped_by", Value::from(stopped_by)),
        ("minimum_step_minutes", schedule.step.map_or(Value::Null, |step| js::num(step as f64))),
    ]));
    Ok(())
}
