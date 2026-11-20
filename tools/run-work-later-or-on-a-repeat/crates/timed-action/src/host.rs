//! crates/timed-action/src/host.rs
//!
//! Purpose
//!   The timed-action engine as a JavaScript host (a page, a Worker, a Node tool) calls it: plain objects in, plain
//!   objects out, through wasm-bindgen. Each export is one name of requests.rs, with the TypeScript's camelCase name.
//!   A value crosses as JSON text (the host's own JSON.stringify and JSON.parse). A refusal is thrown as the
//!   TypeScript throws it: an Error, TypeError or RangeError with the same words.

use serde_json::Value;
use wasm_bindgen::prelude::*;

use crate::js::{Kind, Refused};
use crate::requests;

fn thrown(refused: Refused) -> JsValue {
    let message = JsValue::from_str(&refused.message);
    match refused.kind {
        Kind::Error => js_sys::Error::new(&refused.message).into(),
        Kind::TypeError => js_sys::TypeError::new(&refused.message).into(),
        Kind::RangeError => {
            let _ = message;
            js_sys::RangeError::new(&refused.message).into()
        }
    }
}

fn read(request: &JsValue) -> Result<Value, JsValue> {
    if request.is_undefined() {
        return Ok(requests::request_or_empty(None));
    }
    let text = js_sys::JSON::stringify(request).map_err(|_| thrown(Refused::error("The request could not be read.")))?;
    let text: String = text.into();
    serde_json::from_str(&text).map_err(|error| thrown(Refused::error(format!("The request could not be read: {error}"))))
}

fn answer(name: &str, request: &JsValue) -> Result<JsValue, JsValue> {
    let value = read(request)?;
    let result = requests::call(name, &value).map_err(thrown)?;
    js_sys::JSON::parse(&result.to_string())
}

macro_rules! exports {
    ($($rust:ident => $name:literal),* $(,)?) => {
        $(
            #[wasm_bindgen(js_name = $name)]
            pub fn $rust(request: JsValue) -> Result<JsValue, JsValue> {
                answer($name, &request)
            }
        )*
    };
}

exports! {
    day_ms => "DAY_MS",
    time_zone_name => "timeZoneName",
    instant_at => "instantAt",
    wall_time_of => "wallTimeOf",
    pad => "pad",
    parse_date => "parseDate",
    parse_time => "parseTime",
    format_utc_date => "formatUtcDate",
    add_civil_days => "addCivilDays",
    add_civil_months => "addCivilMonths",
    add_civil_minutes => "addCivilMinutes",
    weekday => "weekday",
    parts_at => "partsAt",
    local_parts => "localParts",
    timezone_offset_minutes_at => "timezoneOffsetMinutesAt",
    possible_instants => "possibleInstants",
    resolve_start => "resolveStart",
    min_step_minutes => "MIN_STEP_MINUTES",
    recurring_occurrence_key => "recurringOccurrenceKey",
    materialize_recurring_windows => "materializeRecurringWindows",
    plan_recurring_windows => "planRecurringWindows",
    when_to_wake => "whenToWake",
    evaluate_due_scheduled_actions => "evaluateDueScheduledActions",
    action_operation => "actionOperation",
    receipt_key => "receiptKey",
    resolve_due_at => "resolveDueAt",
    fraction_of => "fractionOf",
    interval_ms_of => "intervalMsOf",
    spread_recurring_start => "spreadRecurringStart",
    spread_one_shot_due => "spreadOneShotDue",
    checked_working_hours => "checkedWorkingHours",
    quiet_hours_answer => "quietHoursAnswer",
    zone_drift => "zoneDrift",
    build_scheduled_action_record_write => "buildScheduledActionRecordWrite",
    build_scheduled_action_state_write => "buildScheduledActionStateWrite",
    build_replace_time_window_write => "buildReplaceTimeWindowWrite",
}
