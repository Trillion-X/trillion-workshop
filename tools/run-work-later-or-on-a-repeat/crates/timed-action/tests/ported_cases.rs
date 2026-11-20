//! crates/timed-action/tests/ported_cases.rs
//!
//! Purpose
//!   The cases the TypeScript tests cover, ported one for one (tools/run-work-later-or-on-a-repeat/test/*,
//!   tools/wall-time/test/wall-time.test.mjs, tools/run-work-later-or-on-a-repeat/test/timed-action/spread-fires.test.mjs),
//!   each asserting the same expected values. Every case goes through the one request table (requests::call), the
//!   same door the hosts use.

use serde_json::{json, Value};
use timed_action::requests::call;

fn ok(name: &str, request: Value) -> Value {
    match call(name, &request) {
        Ok(value) => value,
        Err(refused) => panic!("{name} refused: {}", refused.message),
    }
}

fn refusal(name: &str, request: Value) -> String {
    match call(name, &request) {
        Ok(value) => panic!("{name} answered {value}, expected a refusal"),
        Err(refused) => refused.message,
    }
}

fn proven(key: &str, at: &str) -> Value {
    json!({
        "occurrence_key": key,
        "materialization_key": key,
        "materialized_at": at,
        "owner_outcome": { "proven": true, "owner_ref": "tool:write-review", "proof_ref": format!("run:{at}"), "observed_at": at }
    })
}

fn monday_review() -> Value {
    json!({
        "schedule_id": "schedule:monday-review",
        "source_generation": 1,
        "schedule_revision": 1,
        "timezone": "America/New_York",
        "start_local_date": "2026-03-02",
        "cadence": { "unit": "week", "weekdays": [1] },
        "local_window": { "start": "09:00", "duration_minutes": 30 },
        "action": {
            "operation": "write-weekly-review",
            "owner_ref": "tool:write-review",
            "owner_dispatch": { "name": "tool:write-review", "input": {} },
            "completion": { "mode": "synchronous-owner-return" }
        }
    })
}

fn wake(now: &str, schedules: &Value, states: &Value) -> Value {
    ok("whenToWake", json!({ "now": now, "schedules": schedules, "occurrence_states": states }))
}

fn str_at<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_else(|| panic!("{key} is not text in {value}"))
}

// ---- wall-time.test.mjs -------------------------------------------------------------------------------------------

#[test]
fn a_zone_is_an_iana_name_kept_in_its_own_spelling_and_anything_else_is_no_zone() {
    let name = |value: Value| ok("timeZoneName", json!({ "value": value }));
    assert_eq!(name(json!("Europe/London")), json!("Europe/London"));
    assert_eq!(name(json!("UTC")), json!("UTC"));
    assert_eq!(name(json!("america/new_york")), json!("America/New_York"));
    for not in [
        json!("+05:00"),
        json!("-0800"),
        json!("GMT+5"),
        json!("Mars/Olympus"),
        json!("Not a zone"),
        json!(""),
        json!("   "),
        Value::Null,
        json!(5),
        json!("A".repeat(81)),
        json!("Europe/../London"),
    ] {
        assert_eq!(name(not.clone()), Value::Null, "{not}");
    }
}

#[test]
fn a_time_the_clocks_skip_moves_to_the_first_minute_that_exists_or_is_skipped_and_a_repeated_time_takes_either_instant() {
    let instant = |date: &str, time: &str, zone: &str, options: Value| {
        let answer = ok("instantAt", json!({ "date": date, "time": time, "zone": zone, "options": options }));
        match answer.as_f64() {
            Some(ms) => Value::from(timed_action::date::to_iso(ms).unwrap()),
            None => answer,
        }
    };
    assert_eq!(instant("2026-03-08", "02:30", "America/New_York", json!({})), json!("2026-03-08T07:00:00.000Z"));
    assert_eq!(instant("2026-03-08", "02:30", "America/New_York", json!({ "gap": "skip" })), Value::Null);
    assert_eq!(instant("2026-10-25", "01:30", "Europe/London", json!({})), json!("2026-10-25T00:30:00.000Z"));
    assert_eq!(instant("2026-10-25", "01:30", "Europe/London", json!({ "fold": "later" })), json!("2026-10-25T01:30:00.000Z"));
    assert_eq!(instant("2026-07-01", "09:00", "Asia/Kolkata", json!({})), json!("2026-07-01T03:30:00.000Z"));
    assert_eq!(instant("2026-10-04", "02:15", "Australia/Lord_Howe", json!({})), json!("2026-10-03T15:30:00.000Z"));
    assert_eq!(
        ok("wallTimeOf", json!({ "instantMs": timed_action::date::parse("2026-10-25T01:30:00Z"), "zone": "Europe/London" })),
        json!({ "date": "2026-10-25", "time": "01:30" })
    );
    assert_eq!(instant("2026-02-30", "09:00", "UTC", json!({})), Value::Null, "a day that is not one");
    assert_eq!(instant("2026-03-01", "09:00", "+05:00", json!({})), Value::Null, "an offset is not a zone");
}

#[test]
fn civil_dates_add_by_the_calendar_and_a_month_without_the_day_takes_its_last() {
    assert_eq!(ok("addCivilMonths", json!({ "date": "2026-01-31", "months": 1 })), json!("2026-02-28"));
    assert_eq!(ok("addCivilMonths", json!({ "date": "2028-01-31", "months": 1 })), json!("2028-02-29"));
    assert_eq!(ok("addCivilMonths", json!({ "date": "2026-11-30", "months": 3 })), json!("2027-02-28"));
    assert_eq!(ok("addCivilMonths", json!({ "date": "2026-01-15", "months": -2 })), json!("2025-11-15"));
    assert_eq!(ok("addCivilDays", json!({ "date": "2026-02-27", "days": 2 })), json!("2026-03-01"));
    assert_eq!(
        ok("addCivilMinutes", json!({ "start": { "date": "2026-12-31", "time": "23:30" }, "minutes": 45 })),
        json!({ "date": "2027-01-01", "time": "00:15" })
    );
    assert_eq!(ok("weekday", json!({ "date": "2026-10-25" })), json!(0));
    assert_eq!(ok("weekday", json!({ "date": "2026-10-26" })), json!(1));
}

// ---- when-to-wake.test.mjs ----------------------------------------------------------------------------------------

#[test]
fn an_alarm_loop_runs_a_weekly_schedule_at_0900_new_york_on_both_sides_of_the_clock_change() {
    let schedules = json!([monday_review()]);
    let mut states = json!([]);
    let mut ran = Vec::new();
    let mut alarm: Option<String> = None;
    let tick = |now: &str, states: &mut Value, alarm: &mut Option<String>, ran: &mut Vec<String>| {
        let answer = wake(now, &schedules, states);
        for occurrence in answer["recurring_due"].as_array().unwrap() {
            ran.push(str_at(occurrence, "start").to_string());
            let key = str_at(occurrence, "occurrence_key");
            let start = str_at(occurrence, "start");
            states.as_array_mut().unwrap().push(proven(key, start));
        }
        *alarm = answer["next_wake_at"].as_str().map(str::to_string);
        answer
    };
    let first = tick("2026-03-01T12:00:00Z", &mut states, &mut alarm, &mut ran);
    assert_eq!(first["recurring_due"], json!([]));
    assert_eq!(alarm.as_deref(), Some("2026-03-02T14:00:00.000Z"), "09:00 EST is 14:00 UTC");
    tick(alarm.clone().unwrap().as_str(), &mut states, &mut alarm, &mut ran);
    assert_eq!(alarm.as_deref(), Some("2026-03-09T13:00:00.000Z"), "after the change on 8 March, 09:00 EDT is 13:00 UTC");
    tick(alarm.clone().unwrap().as_str(), &mut states, &mut alarm, &mut ran);
    assert_eq!(ran, vec!["2026-03-02T14:00:00.000Z", "2026-03-09T13:00:00.000Z"]);
    assert_eq!(alarm.as_deref(), Some("2026-03-16T13:00:00.000Z"));
}

#[test]
fn an_occurrence_whose_owner_did_not_prove_its_outcome_stays_due_and_its_materialization_is_offered_once() {
    let schedules = json!([monday_review()]);
    let answer = wake("2026-03-02T14:05:00Z", &schedules, &json!([]));
    assert_eq!(answer["recurring_due"].as_array().unwrap().len(), 1);
    assert_eq!(answer["materializations"].as_array().unwrap().len(), 1);
    let key = str_at(&answer["recurring_due"][0], "occurrence_key").to_string();
    let retry = wake(
        "2026-03-02T15:00:00Z",
        &schedules,
        &json!([{ "occurrence_key": key, "materialization_key": key, "materialized_at": "2026-03-02T14:05:00Z" }]),
    );
    assert_eq!(str_at(&retry["recurring_due"][0], "occurrence_key"), key);
    assert_eq!(retry["recurring_due"][0]["retry_same_occurrence"], json!(true));
    assert_eq!(retry["materializations"], json!([]));
}

#[test]
fn the_runtime_wake_reducer_keeps_its_single_next_occurrence_contract() {
    let answer = wake("2026-03-01T12:00:00Z", &json!([monday_review()]), &json!([]));
    assert_eq!(answer["next_wake_at"], json!("2026-03-02T14:00:00.000Z"));
    assert_eq!(answer["recurring_due"], json!([]));
    assert!(answer.get("future_occurrences").is_none());
}

#[test]
fn a_time_that_does_not_exist_on_the_change_night_is_skipped_or_moved_to_the_next_valid_minute_as_the_schedule_says() {
    let nightly = json!({
        "schedule_id": "schedule:nightly", "source_generation": 1, "schedule_revision": 1, "timezone": "America/New_York",
        "start_local_date": "2026-03-08", "cadence": { "unit": "day" }, "local_window": { "start": "02:30", "duration_minutes": 10 },
        "action": monday_review()["action"].clone()
    });
    let skipped = wake("2026-03-08T05:00:00Z", &json!([nightly.clone()]), &json!([]));
    assert_eq!(skipped["skipped_resolutions"][0]["reason"], json!("dst_gap_skip"));
    assert_eq!(skipped["next_wake_at"], json!("2026-03-09T06:30:00.000Z"), "the next night, 02:30 EDT");
    let mut moved_schedule = nightly;
    moved_schedule["dst"] = json!({ "gap": "next-valid" });
    let moved = wake("2026-03-08T05:00:00Z", &json!([moved_schedule]), &json!([]));
    assert_eq!(moved["next_wake_at"], json!("2026-03-08T07:00:00.000Z"), "03:00 EDT, the first minute that exists");
}

#[test]
fn one_off_actions_are_due_once_their_window_opens_gone_once_a_receipt_names_them_and_the_earliest_one_ahead_sets_the_alarm() {
    let dispatch = json!({ "name": "tool:send-message", "input": { "to": "me" } });
    let graph = |now: &str, receipts: Value| {
        ok("whenToWake", json!({
            "now": now,
            "time_windows": [
                { "record_id": "remind-a", "time_window_id": "w-a", "start": "2026-03-10T09:00:00Z" },
                { "record_id": "remind-b", "time_window_id": "w-b", "start": "2026-03-12T09:00:00Z" },
                { "record_id": "remind-c", "time_window_id": "w-c", "start": "2026-03-11T09:00:00Z" }
            ],
            "actions": [
                { "record_id": "remind-a", "action_id": "send", "dispatch": dispatch },
                { "record_id": "remind-b", "action_id": "send", "dispatch": dispatch },
                { "record_id": "remind-c", "action_id": "send" }
            ],
            "receipts": receipts
        }))
    };
    let before = graph("2026-03-09T00:00:00Z", json!([]));
    assert_eq!(before["scheduled_due"], json!([]));
    assert_eq!(before["next_wake_at"], json!("2026-03-10T09:00:00.000Z"), "an action without its own dispatch never sets the alarm");
    let at = graph("2026-03-10T09:00:00.000Z", json!([]));
    let fired: Vec<&str> = at["scheduled_due"].as_array().unwrap().iter().map(|fire| str_at(fire, "record_id")).collect();
    assert_eq!(fired, vec!["remind-a"]);
    assert_eq!(at["next_wake_at"], json!("2026-03-12T09:00:00.000Z"));
    let done = graph("2026-03-10T10:00:00Z", json!([{ "record_id": "remind-a", "operation": "send" }]));
    assert_eq!(done["scheduled_due"], json!([]));
    assert_eq!(refusal("whenToWake", json!({ "now": "soon" })), "when-to-wake: `now` is not a time");
}

#[test]
fn resume_from_ms_a_schedule_first_seen_now_starts_from_now_and_a_caller_keeping_only_states_from_its_last_proof_stays_bounded() {
    let daily = json!({
        "schedule_id": "schedule:daily", "source_generation": 1, "schedule_revision": 1, "timezone": "America/New_York",
        "start_local_date": "2020-01-01", "cadence": { "unit": "day" }, "local_window": { "start": "09:00", "duration_minutes": 30 },
        "action": monday_review()["action"].clone()
    });
    let from = Value::from(1_772_712_000_000_i64); // 2026-03-05T12:00:00Z
    let first = ok("whenToWake", json!({ "now": from, "schedules": [daily], "resume_from_ms": from }));
    assert_eq!(first["recurring_due"], json!([]), "six years of past days are not caught up");
    assert_eq!(first["next_wake_at"], json!("2026-03-05T14:00:00.000Z"), "its first time from now: 09:00 New York that day");
    let mut states = json!([]);
    let mut resume = from.as_i64().unwrap();
    let mut ran = Vec::new();
    for now in ["2026-03-05T14:00:00Z", "2026-03-06T14:00:00Z", "2026-03-07T14:00:00Z", "2026-03-08T13:00:00Z"] {
        let answer = ok("whenToWake", json!({ "now": now, "schedules": [daily], "occurrence_states": states, "resume_from_ms": resume }));
        for occurrence in answer["recurring_due"].as_array().unwrap() {
            ran.push(str_at(occurrence, "start").to_string());
            states = json!([proven(str_at(occurrence, "occurrence_key"), str_at(occurrence, "start"))]);
            resume = timed_action::date::parse(str_at(occurrence, "start")) as i64;
        }
    }
    assert_eq!(ran, vec!["2026-03-05T14:00:00.000Z", "2026-03-06T14:00:00.000Z", "2026-03-07T14:00:00.000Z", "2026-03-08T13:00:00.000Z"]);
    let late = ok("whenToWake", json!({ "now": "2026-03-12T15:00:00Z", "schedules": [daily], "occurrence_states": states, "resume_from_ms": resume }));
    let summary: Vec<(String, i64)> = late["recurring_due"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| (str_at(o, "start").to_string(), o["missed_before"].as_i64().unwrap()))
        .collect();
    assert_eq!(summary, vec![("2026-03-12T13:00:00.000Z".to_string(), 3)]);
}

#[test]
fn any_cadence_asleep_for_a_year_runs_once_on_waking_and_says_how_many_times_it_missed_and_on_time_it_missed_none() {
    let zone = json!({ "source_generation": 1, "schedule_revision": 1, "timezone": "UTC", "start_local_date": "2025-01-01", "action": monday_review()["action"].clone() });
    let with = |id: &str, cadence: Value, window: Value| {
        let mut schedule = zone.clone();
        schedule["schedule_id"] = json!(id);
        schedule["cadence"] = cadence;
        schedule["local_window"] = window;
        schedule
    };
    let cases = [
        (with("schedule:every-6h", json!({ "unit": "hour", "interval": 6 }), json!({ "start": "00:00", "duration_minutes": 5 })), "2026-01-01T12:00:00.000Z", 1462),
        (with("schedule:daily", json!({ "unit": "day" }), json!({ "start": "09:00", "duration_minutes": 5 })), "2026-01-01T09:00:00.000Z", 365),
        (with("schedule:mondays", json!({ "unit": "week", "weekdays": [1] }), json!({ "start": "09:00", "duration_minutes": 5 })), "2025-12-29T09:00:00.000Z", 51),
    ];
    for (schedule, expected_start, expected_missed) in cases {
        let id = str_at(&schedule, "schedule_id").to_string();
        let woke = ok("whenToWake", json!({ "now": "2026-01-01T13:00:00Z", "schedules": [schedule.clone()], "resume_from_ms": 1_735_689_600_000_i64 }));
        let due = woke["recurring_due"].as_array().unwrap();
        assert_eq!(due.len(), 1, "{id}");
        assert_eq!(str_at(&due[0], "start"), expected_start, "{id}");
        assert_eq!(due[0]["missed_before"], json!(expected_missed), "{id}");
        let ran = &due[0];
        let kept_states = json!([proven(str_at(ran, "occurrence_key"), str_at(ran, "start"))]);
        let resume = timed_action::date::parse(str_at(ran, "start")) as i64;
        let next = ok("whenToWake", json!({ "now": "2026-01-01T13:00:00Z", "schedules": [schedule.clone()], "occurrence_states": kept_states, "resume_from_ms": resume }))["next_wake_at"]
            .as_str()
            .unwrap()
            .to_string();
        let next_ms = timed_action::date::parse(&next) as i64 + 60_000;
        let on_time = ok("whenToWake", json!({ "now": next_ms, "schedules": [schedule], "occurrence_states": kept_states, "resume_from_ms": resume }));
        let on_time_due = on_time["recurring_due"].as_array().unwrap();
        assert_eq!(on_time_due.len(), 1, "{id} on time");
        assert_eq!(str_at(&on_time_due[0], "start"), next, "{id} on time");
        assert_eq!(on_time_due[0]["missed_before"], json!(0), "{id} on time misses none");
    }
}

#[test]
fn asked_with_no_resume_point_a_schedule_begun_decades_ago_is_due_at_its_latest_time_not_where_the_scan_bound_ends() {
    let daily = json!({
        "schedule_id": "schedule:since-1970", "source_generation": 1, "schedule_revision": 1, "timezone": "UTC", "start_local_date": "1970-01-01",
        "cadence": { "unit": "day" }, "local_window": { "start": "14:00", "duration_minutes": 1 }, "action": monday_review()["action"].clone()
    });
    let asked = wake("2026-11-18T11:00:00Z", &json!([daily]), &json!([]));
    let due = asked["recurring_due"].as_array().unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(str_at(&due[0], "start"), "2026-11-17T14:00:00.000Z", "the latest time that has come");
    let missed = due[0]["missed_before"].as_i64().unwrap();
    assert!(missed > 4000, "{missed}");
    assert!(timed_action::date::parse(str_at(&due[0], "missed_since")) < timed_action::date::parse(str_at(&due[0], "start")));
    assert_eq!(asked["next_wake_at"], Value::Null);
}

#[test]
fn a_schedule_names_its_action_and_its_owner_and_nothing_about_how_the_owner_answers() {
    let mut bare = monday_review();
    bare["schedule_id"] = json!("schedule:no-completion");
    bare["action"].as_object_mut().unwrap().remove("completion");
    let answer = ok("whenToWake", json!({ "now": "2026-03-01T12:00:00Z", "schedules": [bare.clone()], "resume_from_ms": 1_772_366_400_000_i64 }));
    assert_eq!(answer["rejected_schedules"], json!([]), "a schedule with no completion is taken");
    assert_eq!(answer["next_wake_at"], json!("2026-03-02T14:00:00.000Z"));
    let mut kept = bare;
    kept["action"]["completion"] = json!({ "mode": "synchronous-owner-return" });
    let again = ok("whenToWake", json!({ "now": "2026-03-01T12:00:00Z", "schedules": [kept], "resume_from_ms": 1_772_366_400_000_i64 }));
    assert_eq!(again["next_wake_at"], answer["next_wake_at"]);
}

// ---- spread-fires.test.mjs ----------------------------------------------------------------------------------------

fn spread_config() -> Value {
    json!({ "recurring_frac": 0.1, "recurring_cap_seconds": 900, "one_shot_minute_mod": 30, "one_shot_floor_seconds": 0, "one_shot_max_seconds": 90 })
}

fn hourly(id: &str) -> Value {
    json!({
        "schedule_id": id, "source_generation": 1, "schedule_revision": 1, "timezone": "UTC", "start_local_date": "2026-03-02",
        "cadence": { "unit": "hour", "interval": 1 }, "local_window": { "start": "00:00", "duration_minutes": 5 },
        "action": { "operation": "tick", "owner_ref": "tool:t", "owner_dispatch": { "name": "tool:t", "input": {} }, "completion": { "mode": "synchronous-owner-return" } }
    })
}

#[test]
fn the_same_id_has_the_same_offset_every_wake_and_recurring_only_slips_later_within_the_cap() {
    let fraction = |id: &str| ok("fractionOf", json!({ "id": id })).as_f64().unwrap();
    assert_eq!(fraction("schedule:a"), fraction("schedule:a"));
    let at = timed_action::date::parse("2026-03-02T10:00:00Z");
    let slipped = ok("spreadRecurringStart", json!({ "startMs": at, "id": "schedule:a", "intervalMs": 3_600_000, "config": spread_config() })).as_f64().unwrap();
    assert!(slipped >= at && slipped - at <= f64::min(0.1 * 3_600_000.0, 900_000.0));
    assert_eq!(ok("spreadRecurringStart", json!({ "startMs": at, "id": "schedule:a", "intervalMs": 3_600_000, "config": null })).as_f64().unwrap(), at);
}

#[test]
fn a_one_off_on_a_round_minute_moves_only_earlier_and_never_before_its_creation() {
    let due = timed_action::date::parse("2026-03-02T15:00:00Z");
    let early = ok("spreadOneShotDue", json!({ "dueMs": due, "id": "rec:1", "createdAtMs": null, "config": spread_config() })).as_f64().unwrap();
    assert!(early <= due && due - early <= 90_000.0);
    assert_eq!(ok("spreadOneShotDue", json!({ "dueMs": due + 60_000.0, "id": "rec:1", "createdAtMs": null, "config": spread_config() })).as_f64().unwrap(), due + 60_000.0);
    assert_eq!(ok("spreadOneShotDue", json!({ "dueMs": due, "id": "rec:1", "createdAtMs": due - 1000.0, "config": spread_config() })).as_f64().unwrap(), due);
}

#[test]
fn when_to_wake_with_spread_the_recurring_fire_is_not_due_at_00_but_at_its_offset_and_without_spread_it_is() {
    let at = timed_action::date::parse("2026-03-02T10:00:00Z");
    let schedule = hourly("schedule:a");
    let plain = ok("whenToWake", json!({ "now": at, "schedules": [schedule.clone()] }));
    assert_eq!(plain["recurring_due"].as_array().unwrap().len(), 1);
    let offset = ok("spreadRecurringStart", json!({ "startMs": at, "id": "schedule:a", "intervalMs": 3_600_000, "config": spread_config() })).as_f64().unwrap();
    let held = ok("whenToWake", json!({ "now": at, "schedules": [schedule.clone()], "spread": spread_config() }));
    assert_eq!(held["recurring_due"].as_array().unwrap().len(), if offset > at { 0 } else { 1 });
    let later = ok("whenToWake", json!({ "now": offset, "schedules": [schedule], "spread": spread_config() }));
    assert_eq!(later["recurring_due"].as_array().unwrap().len(), 1);
}

#[test]
fn a_one_off_action_due_at_1500_fires_up_to_90s_earlier_under_spread_and_never_when_spread_is_off() {
    let due = "2026-03-02T15:00:00.000Z";
    let windows = json!({ "time_windows": [{ "record_id": "r1", "start": due }], "actions": [{ "record_id": "r1", "dispatch": { "name": "tool:x", "input": {} } }] });
    let due_ms = timed_action::date::parse(due);
    let early = due_ms - (ok("fractionOf", json!({ "id": "r1" })).as_f64().unwrap() * 90.0).floor() * 1000.0;
    let at = |now: f64, spread: Value| {
        let mut request = windows.clone();
        request["now"] = json!(now);
        request["spread"] = spread;
        ok("whenToWake", request)["scheduled_due"].as_array().unwrap().len()
    };
    assert_eq!(at(due_ms - 100_000.0, spread_config()), 0);
    assert_eq!(at(early, spread_config()), 1);
    assert_eq!(at(early, Value::Null), if early >= due_ms { 1 } else { 0 });
}

// ---- quiet-hours.test.mjs -----------------------------------------------------------------------------------------

fn ny() -> Value {
    json!({ "start": "09:00", "end": "17:00", "time_zone": "America/New_York", "weekdays": [1, 2, 3, 4, 5] })
}

fn quiet(hours: Value, at: &str, mode: Option<&str>, dismissed: Option<i64>) -> Value {
    let mut request = json!({ "hours": hours, "atMs": timed_action::date::parse(at), "dismissedPeriodStartMs": dismissed });
    if let Some(mode) = mode {
        request["mode"] = json!(mode);
    }
    ok("quietHoursAnswer", request)
}

#[test]
fn inside_working_hours_nothing_is_said_and_outside_the_persons_mode_decides() {
    assert_eq!(quiet(ny(), "2026-10-14T14:00:00Z", None, None)["quiet"], json!(false));
    let night = quiet(ny(), "2026-10-14T23:30:00Z", None, None);
    assert_eq!((night["quiet"].clone(), night["nudge"].clone(), night["send_silently"].clone()), (json!(true), json!(true), json!(false)));
    assert_eq!(night["period_start_ms"], json!(timed_action::date::parse("2026-10-14T21:00:00Z") as i64));
    assert_eq!(night["opens_at_ms"], json!(timed_action::date::parse("2026-10-15T13:00:00Z") as i64));
    assert_eq!(quiet(ny(), "2026-10-14T23:30:00Z", Some("auto_silent"), None)["send_silently"], json!(true));
    assert_eq!(quiet(ny(), "2026-10-14T23:30:00Z", Some("none"), None)["nudge"], json!(false));
    assert_eq!(quiet(Value::Null, "2026-10-14T23:30:00Z", None, None)["quiet"], json!(false));
}

#[test]
fn a_weekend_is_quiet_until_monday_morning() {
    let saturday = quiet(ny(), "2026-10-17T16:00:00Z", None, None);
    assert_eq!(saturday["quiet"], json!(true));
    assert_eq!(saturday["period_start_ms"], json!(timed_action::date::parse("2026-10-16T21:00:00Z") as i64));
    assert_eq!(saturday["opens_at_ms"], json!(timed_action::date::parse("2026-10-19T13:00:00Z") as i64));
}

#[test]
fn an_end_before_the_start_is_an_overnight_shift() {
    let night = json!({ "start": "22:00", "end": "06:00", "time_zone": "UTC" });
    assert_eq!(quiet(night.clone(), "2026-10-14T23:00:00Z", None, None)["quiet"], json!(false));
    assert_eq!(quiet(night.clone(), "2026-10-15T05:59:00Z", None, None)["quiet"], json!(false));
    let day = quiet(night, "2026-10-15T12:00:00Z", None, None);
    assert_eq!(
        (day["quiet"].clone(), day["period_start_ms"].clone(), day["opens_at_ms"].clone()),
        (json!(true), json!(timed_action::date::parse("2026-10-15T06:00:00Z") as i64), json!(timed_action::date::parse("2026-10-15T22:00:00Z") as i64))
    );
}

#[test]
fn a_dismissal_lasts_only_for_the_quiet_period_it_was_made_in() {
    let first = quiet(ny(), "2026-10-14T23:30:00Z", None, None);
    let start = first["period_start_ms"].as_i64();
    assert_eq!(quiet(ny(), "2026-10-15T01:00:00Z", Some("nudge"), start)["nudge"], json!(false), "same period: stays dismissed");
    assert_eq!(quiet(ny(), "2026-10-15T23:30:00Z", Some("nudge"), start)["nudge"], json!(true), "next evening: the notice returns");
}

#[test]
fn a_clock_change_moves_the_window_with_the_wall_clock_and_bad_input_is_refused() {
    assert_eq!(quiet(ny(), "2026-11-02T21:30:00Z", None, None)["quiet"], json!(false));
    assert_eq!(quiet(ny(), "2026-11-02T22:30:00Z", None, None)["quiet"], json!(true));
    let hours_words = "Working hours need start and end like 09:00 and a time zone like America/New_York.";
    let weekday_words = "Working weekdays are whole numbers from 0 (Sunday) to 6.";
    let cases = [
        (json!({ "start": "09:00", "end": "17:00", "time_zone": "Mars/Base" }), hours_words),
        (json!({ "start": "9am", "end": "17:00", "time_zone": "America/New_York" }), hours_words),
        (json!({ "start": "09:00", "end": "17:00", "time_zone": "America/New_York", "weekdays": [] }), weekday_words),
        (json!({ "start": "09:00", "end": "17:00", "time_zone": "America/New_York", "weekdays": [7] }), weekday_words),
    ];
    for (bad, words) in cases {
        assert_eq!(refusal("quietHoursAnswer", json!({ "hours": bad.clone(), "atMs": 0 })), words, "{bad}");
        assert_eq!(refusal("checkedWorkingHours", bad.clone()), words, "{bad}");
    }
    assert_eq!(refusal("quietHoursAnswer", json!({ "hours": ny(), "atMs": 0, "mode": "loud" })), "The mode is one of: none, nudge, auto_silent.");
}

// ---- zone-drift.test.mjs ------------------------------------------------------------------------------------------

#[test]
fn a_device_zone_different_from_the_planning_zone_is_asked_about_once() {
    let drift = |planning: &str, device: &str, asked: Value| {
        let mut request = json!({ "planningZone": planning, "deviceZone": device });
        if !asked.is_null() {
            request["askedZones"] = asked;
        }
        ok("zoneDrift", request)
    };
    assert_eq!(drift("America/New_York", "America/New_York", Value::Null), json!({ "planning_zone": "America/New_York", "device_zone": "America/New_York", "drifted": false, "ask": false }));
    assert_eq!(drift("America/New_York", "Europe/London", Value::Null), json!({ "planning_zone": "America/New_York", "device_zone": "Europe/London", "drifted": true, "ask": true }));
    assert_eq!(drift("America/New_York", "Europe/London", json!(["Europe/London"]))["ask"], json!(false));
    assert_eq!(drift("America/New_York", "Asia/Tokyo", json!(["Europe/London"]))["ask"], json!(true));
    assert_eq!(drift("America/New_York", "Europe/London", json!(["Europe/London"]))["drifted"], json!(true));
    assert!(call("zoneDrift", &json!({ "planningZone": "America/New_York", "deviceZone": "Mars/Base" })).is_err());
}

// ---- evaluate-due-scheduled-actions.test.ts (graph shape) and scheduled-action-commands.test.mjs ------------------

const NOW: &str = "2026-07-02T12:00:00Z";

fn customer_graph() -> Value {
    json!({
        "records": [{ "role": "record", "record_id": "cust-1", "owner_ref": "account:cust-1", "fields": { "title": "Jordan" } }],
        "time_windows": [{ "time_window_id": "tw-1", "record_id": "cust-1", "start": "2026-07-01T00:00:00Z" }],
        "actions": [{
            "action_id": "action:customer-follow-up.send-feedback-request",
            "record_id": "cust-1",
            "dispatch": { "name": "slot::workflow", "input": { "operation": "execute_definition", "definition_id": "action:customer-follow-up.send-feedback-request", "input": { "record_id": "cust-1" } } }
        }],
        "receipts": []
    })
}

fn evaluate_with(mut graph: Value, now: &str) -> Value {
    graph["now"] = json!(now);
    ok("evaluateDueScheduledActions", graph)
}

#[test]
fn a_due_action_fires_emitting_identity_and_operation_only() {
    let r = evaluate_with(customer_graph(), NOW);
    assert_eq!(r["due_count"], json!(1));
    assert_eq!(r["due"][0]["record_id"], json!("cust-1"));
    assert_eq!(r["due"][0]["operation"], json!("action:customer-follow-up.send-feedback-request"));
    assert_eq!(r["due"][0]["evaluated_at"], json!("2026-07-02T12:00:00.000Z"));
    for absent in ["target_ref", "owner_ref", "fields"] {
        assert!(r["due"][0].get(absent).is_none(), "{absent}");
    }
}

#[test]
fn a_due_action_is_skipped_before_its_window_and_when_a_receipt_names_it_and_fails_closed_without_a_window_or_dispatch() {
    let mut later = customer_graph();
    later["time_windows"] = json!([{ "time_window_id": "tw-1", "record_id": "cust-1", "start": "2026-07-10T00:00:00Z" }]);
    assert_eq!(evaluate_with(later, NOW)["due_count"], json!(0));
    let mut receipted = customer_graph();
    receipted["receipts"] = json!([{ "record_id": "cust-1", "operation": "action:customer-follow-up.send-feedback-request", "observed_at": NOW }]);
    let r = evaluate_with(receipted, NOW);
    assert_eq!((r["due_count"].clone(), r["already_fired_count"].clone()), (json!(0), json!(1)));
    let mut unscheduled = customer_graph();
    unscheduled["time_windows"] = json!([]);
    assert_eq!(evaluate_with(unscheduled, NOW)["due_count"], json!(0));
    let mut no_dispatch = customer_graph();
    no_dispatch["actions"] = json!([{ "action_id": "action:no-dispatch", "record_id": "cust-1" }]);
    let r = evaluate_with(no_dispatch, NOW);
    assert_eq!((r["due_count"].clone(), r["scanned_action_count"].clone()), (json!(0), json!(1)));
}

#[test]
fn a_second_action_on_the_same_record_fires_independently_of_the_first_receipt() {
    let dispatch = json!({ "name": "compute.process", "input": { "argv": ["node", "-e", ""] } });
    let mut g = customer_graph();
    g["actions"] = json!([
        { "action_id": "action:a", "record_id": "cust-1", "dispatch": dispatch },
        { "action_id": "action:b", "record_id": "cust-1", "dispatch": dispatch }
    ]);
    g["receipts"] = json!([{ "record_id": "cust-1", "operation": "action:a", "observed_at": NOW }]);
    let r = evaluate_with(g, NOW);
    assert_eq!(r["due_count"], json!(1));
    assert_eq!(r["due"][0]["operation"], json!("action:b"));
}

#[test]
fn receipts_suppress_only_the_exact_identity_pair_including_delimiter_bearing_identifiers() {
    let dispatch = json!({ "name": "slot::workflow", "input": {} });
    let g = json!({
        "time_windows": [
            { "record_id": "a|b", "start": "2026-07-01T00:00:00Z" },
            { "record_id": "a", "start": "2026-07-01T00:00:00Z" }
        ],
        "actions": [
            { "record_id": "a|b", "operation": "c", "dispatch": dispatch },
            { "record_id": "a", "operation": "b|c", "dispatch": dispatch }
        ],
        "receipts": [{ "record_id": "a|b", "operation": "c" }],
        "now": NOW
    });
    let result = ok("evaluateDueScheduledActions", g);
    let pairs: Vec<(String, String)> = result["due"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| (str_at(d, "record_id").to_string(), str_at(d, "operation").to_string()))
        .collect();
    assert_eq!(pairs, vec![("a".to_string(), "b|c".to_string())]);
    assert_ne!(
        call("receiptKey", &json!({ "record_id": "a", "operation": null })).unwrap(),
        call("receiptKey", &json!({ "record_id": "a", "operation": "" })).unwrap()
    );
}

#[test]
fn the_evaluator_throws_on_an_unparseable_now() {
    let mut g = customer_graph();
    g["now"] = json!("garbage");
    assert_eq!(refusal("evaluateDueScheduledActions", g), "evaluate-due-scheduled-actions: `now` is not a parseable timestamp");
}

#[test]
fn the_write_of_a_record_names_its_queryable_kind_paths_and_refuses_a_dispatch_less_action() {
    let dispatch = json!({ "name": "slot::workflow", "input": { "operation": "execute_definition", "definition_id": "action:content-distribution.run-publish-intent", "input": { "record_id": "work-a" } } });
    let created = ok("buildScheduledActionRecordWrite", json!({
        "record_id": "work-a",
        "fields": { "title": "Launch note" },
        "relationships": [{ "target_id": "target-1", "relation_role": "target" }],
        "time_window": { "time_window_id": "tw-a", "start": "2026-06-22T15:00:00.000Z" },
        "actions": [{ "action_id": "action-a", "dispatch": dispatch }]
    }));
    assert_eq!(created["operation"], json!("upsert-record"));
    let writes = created["writes"].as_array().unwrap();
    assert_eq!(writes.len(), 4);
    assert_eq!(created["receipt_preview"]["write_count"], json!(4));
    assert_eq!(created["receipt_preview"]["idempotency_key_material"], json!(["work-a", "upsert-record"]));
    for write in writes {
        let path = write["path"].as_array().unwrap();
        assert_eq!(path[0], json!("current-item"));
        assert_eq!(write["payload"]["kind"], path[1]);
    }
    let action = writes.iter().find(|w| w["payload"]["kind"] == json!("scheduled-action-action")).unwrap();
    assert_eq!(action["payload"]["dispatch"], dispatch);
    assert_eq!(action["payload"]["operation"], json!("action-a"));
    assert!(action["payload"].get("target_ref").is_none());
    assert_eq!(
        refusal("buildScheduledActionRecordWrite", json!({ "record_id": "work-x", "actions": [{ "action_id": "action-x" }] })),
        "action.dispatch is required"
    );
    let replaced = ok("buildReplaceTimeWindowWrite", json!({ "record_id": "work-a", "time_window": { "time_window_id": "tw-a-2", "start": "2026-06-23T15:00:00.000Z" } }));
    assert_eq!(replaced["operation"], json!("replace-time-window"));
    assert_eq!(replaced["writes"].as_array().unwrap().last().unwrap()["payload"]["time_window_id"], json!("tw-a-2"));
    let canceled = ok("buildScheduledActionStateWrite", json!({ "record_id": "work-a", "operation": "canceled", "observed_at": "2026-06-22T15:05:00.000Z", "reason_refs": ["reason-1"] }));
    assert_eq!(canceled["writes"][0]["payload"]["operation"], json!("canceled"));
    assert_eq!(canceled["receipt_preview"]["blocked_reason_refs"], json!(["reason-1"]));
    assert_eq!(canceled["writes"][0]["path"], json!(["current-item", "scheduled-action-receipt"]));
}
