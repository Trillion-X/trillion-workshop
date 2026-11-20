//! crates/timed-action/src/requests.rs
//!
//! Purpose
//!   The one table of what the engine answers: each export's name (the TypeScript's camelCase name) and the request it
//!   takes. Positional arguments of the TypeScript functions are named fields of the request, with the TypeScript's
//!   parameter names. Both hosts call this table: src/host.rs (wasm-bindgen exports) and src/main.rs (the WASI command).
//!
//! Non-negotiable invariants
//!   - An unknown name is refused; no export is silently missing.
//!   - A request reads its fields as the TypeScript reads its arguments (ToNumber, ToString, truthiness), so the same
//!     request gives the same answer in either host.

use serde_json::Value;

use crate::date::DAY_MS;
use crate::evaluate;
use crate::js::{self, get, get_opt, to_number, to_number_opt, to_str_opt, Refused, Res};
use crate::quiet_hours;
use crate::recurring::{self, MaterializeInput, PlanInput};
use crate::records;
use crate::spread;
use crate::wall_time::{self, Civil, Resolved};
use crate::when_to_wake;
use crate::zone_drift;

/// The names this engine answers, in the order of the TypeScript exports.
pub const NAMES: &[&str] = &[
    "DAY_MS",
    "timeZoneName",
    "instantAt",
    "wallTimeOf",
    "pad",
    "parseDate",
    "parseTime",
    "formatUtcDate",
    "addCivilDays",
    "addCivilMonths",
    "addCivilMinutes",
    "weekday",
    "partsAt",
    "localParts",
    "timezoneOffsetMinutesAt",
    "possibleInstants",
    "resolveStart",
    "MIN_STEP_MINUTES",
    "recurringOccurrenceKey",
    "materializeRecurringWindows",
    "planRecurringWindows",
    "whenToWake",
    "evaluateDueScheduledActions",
    "actionOperation",
    "receiptKey",
    "resolveDueAt",
    "fractionOf",
    "intervalMsOf",
    "spreadRecurringStart",
    "spreadOneShotDue",
    "checkedWorkingHours",
    "quietHoursAnswer",
    "zoneDrift",
    "buildScheduledActionRecordWrite",
    "buildScheduledActionStateWrite",
    "buildReplaceTimeWindowWrite",
];

/// A civil time read from a request field: `{ date, time }`.
fn civil_arg(request: &Value, key: &str) -> Civil {
    let value = get(request, key);
    Civil {
        date: to_str_opt(get_opt(value, "date")),
        time: to_str_opt(get_opt(value, "time")),
    }
}

fn text_arg(request: &Value, key: &str) -> String {
    to_str_opt(get_opt(request, key))
}

fn number_arg(request: &Value, key: &str) -> f64 {
    to_number_opt(get_opt(request, key))
}

fn civil_json(civil: &Civil) -> Value {
    js::object(vec![("date", Value::from(civil.date.clone())), ("time", Value::from(civil.time.clone()))])
}

fn resolved_json(resolved: &Resolved) -> Value {
    js::object(vec![
        ("requested", civil_json(&resolved.requested)),
        ("resolved", civil_json(&resolved.resolved)),
        ("instant_ms", js::num(resolved.instant_ms)),
        ("fold", resolved.fold.clone()),
    ])
}

/// The `options` of instantAt with its defaults: a missing gap is 'next-valid', a missing fold is 'earlier'.
fn instant_options(request: &Value) -> (Value, Value) {
    let options = get(request, "options");
    let gap = get_opt(options, "gap").cloned().unwrap_or_else(|| Value::from("next-valid"));
    let fold = get_opt(options, "fold").cloned().unwrap_or_else(|| Value::from("earlier"));
    (gap, fold)
}

/// `pad(value)`: a number below ten gets a leading zero, as the TypeScript's `value < 10 ? '0' + value : String(value)`.
fn pad_text(request: &Value) -> String {
    let value = get_opt(request, "value");
    if to_number_opt(value) < 10.0 {
        format!("0{}", to_str_opt(value))
    } else {
        to_str_opt(value)
    }
}

/// Answers one export. `request` is the object the caller sends (an absent request is an empty object).
pub fn call(name: &str, request: &Value) -> Res<Value> {
    match name {
        "DAY_MS" => Ok(js::num(DAY_MS)),
        "MIN_STEP_MINUTES" => Ok(js::num(recurring::MIN_STEP_MINUTES)),
        "timeZoneName" => Ok(wall_time::time_zone_name(get(request, "value")).map_or(Value::Null, Value::from)),
        "instantAt" => {
            let (gap, fold) = instant_options(request);
            let instant = wall_time::instant_at(
                &text_arg(request, "date"),
                &text_arg(request, "time"),
                &text_arg(request, "zone"),
                &gap,
                &fold,
            )?;
            Ok(instant.map_or(Value::Null, js::num))
        }
        "wallTimeOf" => {
            let civil = wall_time::local_parts(number_arg(request, "instantMs"), &text_arg(request, "zone"))?;
            Ok(civil_json(&civil))
        }
        "pad" => Ok(Value::from(pad_text(request))),
        "parseDate" => Ok(match wall_time::parse_date(&text_arg(request, "date")) {
            Some((year, month, day)) => js::object(vec![
                ("year", js::num(year as f64)),
                ("month", js::num(month as f64)),
                ("day", js::num(day as f64)),
            ]),
            None => Value::Null,
        }),
        "parseTime" => Ok(match wall_time::parse_time(&text_arg(request, "time")) {
            Some((hour, minute)) => js::object(vec![("hour", js::num(hour as f64)), ("minute", js::num(minute as f64))]),
            None => Value::Null,
        }),
        "formatUtcDate" => Ok(Value::from(crate::date::format_utc_date(number_arg(request, "ms")))),
        "addCivilDays" => Ok(Value::from(wall_time::add_civil_days(
            &text_arg(request, "date"),
            number_arg(request, "days"),
        )?)),
        "addCivilMonths" => Ok(Value::from(wall_time::add_civil_months(
            &text_arg(request, "date"),
            number_arg(request, "months"),
        )?)),
        "addCivilMinutes" => {
            let start = civil_arg(request, "start");
            Ok(civil_json(&wall_time::add_civil_minutes(&start, number_arg(request, "minutes"))?))
        }
        "weekday" => Ok(js::num(wall_time::weekday(&text_arg(request, "date"))? as f64)),
        "partsAt" => wall_time::parts_at(number_arg(request, "instantMs"), &text_arg(request, "timezone")),
        "localParts" => Ok(civil_json(&wall_time::local_parts(
            number_arg(request, "instantMs"),
            &text_arg(request, "timezone"),
        )?)),
        "timezoneOffsetMinutesAt" => Ok(js::num(wall_time::timezone_offset_minutes_at(
            number_arg(request, "instantMs"),
            &text_arg(request, "timezone"),
        )?)),
        "possibleInstants" => {
            let civil = civil_arg(request, "civil");
            let instants = wall_time::possible_instants(&civil, &text_arg(request, "timezone"))?;
            Ok(Value::Array(instants.into_iter().map(js::num).collect()))
        }
        "resolveStart" => {
            let requested = civil_arg(request, "requested");
            let gap = get_opt(request, "gap").cloned().unwrap_or(Value::Null);
            let fold = get_opt(request, "fold").cloned().unwrap_or(Value::Null);
            let starts = wall_time::resolve_start(&requested, &text_arg(request, "timezone"), &gap, &fold)?;
            Ok(Value::Array(starts.iter().map(resolved_json).collect()))
        }
        "recurringOccurrenceKey" => {
            let identity = request;
            let fields = [
                get(identity, "schedule_id").clone(),
                Value::from(to_str_opt(get_opt(identity, "source_generation"))),
                Value::from(to_str_opt(get_opt(identity, "schedule_revision"))),
                get(identity, "timezone").clone(),
                civil_field(identity, "requested_start", "date"),
                civil_field(identity, "requested_start", "time"),
                civil_field(identity, "requested_end", "date"),
                civil_field(identity, "requested_end", "time"),
                civil_field(identity, "resolved_start", "date"),
                civil_field(identity, "resolved_start", "time"),
                civil_field(identity, "resolved_end", "date"),
                civil_field(identity, "resolved_end", "time"),
                get(identity, "fold").clone(),
            ];
            Ok(Value::from(recurring::occurrence_key(&fields)))
        }
        "materializeRecurringWindows" => {
            let input = materialize_input(request);
            Ok(recurring::materialize(&input)?.to_value())
        }
        "planRecurringWindows" => {
            let schedules = js::list(get(request, "schedules"));
            if get(request, "schedules").as_array().is_none() {
                return Err(Refused::error("plan-recurring-windows: `schedules` must be a list"));
            }
            let now_ms = match get_opt(request, "now") {
                Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
                other => crate::date::parse(&to_str_opt(other)),
            };
            if !now_ms.is_finite() {
                return Err(Refused::error("plan-recurring-windows: `now` is not a time"));
            }
            let plan = PlanInput {
                now_ms,
                schedules,
                max_occurrences_per_schedule: match get(request, "max_occurrences_per_schedule") {
                    Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
                    _ => f64::NAN,
                },
                max_calendar_scan_days: get_opt(request, "max_calendar_scan_days"),
            };
            recurring::plan(&plan)
        }
        "whenToWake" => when_to_wake::when_to_wake(request),
        "evaluateDueScheduledActions" => {
            let (windows, actions, receipts) = evaluate::graph_of(request);
            let now_ms = evaluate::now_of(request)?;
            Ok(evaluate::evaluate(windows, actions, receipts, now_ms)?.to_value())
        }
        "actionOperation" => Ok(evaluate::action_operation(request)),
        "receiptKey" => Ok(Value::from(evaluate::receipt_key(
            get(request, "record_id"),
            get(request, "operation"),
        ))),
        "resolveDueAt" => Ok(evaluate::resolve_due_at(Some(request))),
        "fractionOf" => Ok(js::num(spread::fraction_of(&text_arg(request, "id")))),
        "intervalMsOf" => Ok(js::num(spread::interval_ms_of(request))),
        "spreadRecurringStart" => Ok(js::num(spread::spread_recurring_start(
            number_arg(request, "startMs"),
            &text_arg(request, "id"),
            number_arg(request, "intervalMs"),
            get(request, "config"),
        ))),
        "spreadOneShotDue" => {
            let created = get_opt(request, "createdAtMs").filter(|value| !value.is_null()).map(to_number);
            Ok(js::num(spread::spread_one_shot_due(
                number_arg(request, "dueMs"),
                &text_arg(request, "id"),
                created,
                get(request, "config"),
            )))
        }
        "checkedWorkingHours" => Ok(quiet_hours::checked_working_hours(request)?.to_value()),
        "quietHoursAnswer" => {
            let dismissed = get_opt(request, "dismissedPeriodStartMs").and_then(Value::as_f64);
            let mode = get_opt(request, "mode");
            quiet_hours::quiet_hours_answer(
                get(request, "hours"),
                number_arg(request, "atMs"),
                mode,
                dismissed,
            )
        }
        "zoneDrift" => zone_drift::zone_drift(
            get(request, "planningZone"),
            get(request, "deviceZone"),
            get_opt(request, "askedZones"),
        ),
        "buildScheduledActionRecordWrite" => records::build_record_write(request),
        "buildScheduledActionStateWrite" => records::build_state_write(request),
        "buildReplaceTimeWindowWrite" => records::build_replace_time_window_write(request),
        other => Err(Refused::error(format!("Unknown request: {other}."))),
    }
}

/// One field of a civil time inside an identity object (`identity[key][part]`).
fn civil_field(identity: &Value, key: &str, part: &str) -> Value {
    get(get(identity, key), part).clone()
}

/// The materializeRecurringWindows input read from a request.
fn materialize_input(request: &Value) -> MaterializeInput<'_> {
    MaterializeInput {
        schedules: js::list(get(request, "schedules")),
        occurrence_states: js::list(get(request, "occurrence_states")),
        max_calendar_scan_days: get_opt(request, "max_calendar_scan_days"),
        now_ms: get(request, "now_ms").as_f64().filter(|x| x.is_finite()),
        resume_from_ms: get(request, "resume_from_ms").as_f64().filter(|x| x.is_finite()),
    }
}

/// The request a host gave when it gave none: an empty object, as the optional argument reads.
pub fn request_or_empty(request: Option<Value>) -> Value {
    request.unwrap_or_else(|| Value::Object(serde_json::Map::new()))
}
