//! Series operators for ops-core: what a list of numbers or dated entries says as a whole.
//!
//! Three reductions a measure over rows needs and the element-wise operators cannot build, because
//! none of them can sort numbers, count entries per calendar period or step back through periods:
//!
//! - `quantile(numbers, q)`: the q-th quantile by linear interpolation between order statistics
//!   (type 7: numpy's default and Excel's PERCENTILE.INC). `q` outside 0..1 is clamped; text that is an exact
//!   decimal counts as a number (the strict arithmetic operators answer in text); other values are skipped.
//! - `weighted_count(items, weights, default)`: the sum of `weights[item]` over the items, `default` (1 when
//!   absent) for an item the map does not name. With the default it is a plain count of the items.
//! - `streak(entries, period, times, now)`: consecutive calendar periods, counting back from the one holding
//!   `now`, in which at least `times` different UTC days have an entry. An entry is an ISO date or time (a
//!   zone is honoured) or milliseconds since the epoch. Weeks start on Monday and months are calendar
//!   months, both in UTC. The period holding `now` counts when it already met the target; when it has not,
//!   the streak is anchored at the previous period instead of breaking, so a period in progress never
//!   penalises. No entry in the anchor period gives 0.
//!
//! All three are pure: no clock (`now` is an argument), no I/O, deterministic.

use crate::{OpError, OpValue};
use chrono::{DateTime, Datelike, NaiveDate};
use serde_json::Value as JsonValue;
use std::collections::{HashMap, HashSet};

const DAY_MS: i64 = 86_400_000;

fn invalid(operation: &str, reason: &str) -> OpError {
    OpError::InvalidArgument { operation: operation.to_string(), reason: reason.to_string() }
}

fn number_of(value: &JsonValue) -> Option<f64> {
    match value {
        JsonValue::Number(n) => n.as_f64().filter(|f| f.is_finite()),
        JsonValue::String(s) if !s.trim().is_empty() => s.trim().parse::<f64>().ok().filter(|f| f.is_finite()),
        _ => None,
    }
}

/// The q-th quantile of the numbers in `values`; null when there are none.
pub fn quantile(values: &OpValue, q: &OpValue) -> Result<OpValue, OpError> {
    let Some(items) = values.as_inner().as_array().cloned() else {
        return if values.is_null() { Ok(OpValue::null()) } else { Err(invalid("quantile", "needs a list of numbers")) };
    };
    let mut numbers: Vec<f64> = items.iter().filter_map(number_of).collect();
    if numbers.is_empty() {
        return Ok(OpValue::null());
    }
    numbers.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let q = if q.is_null() { 0.5 } else { number_of(&q.as_inner()).unwrap_or(0.5) }.clamp(0.0, 1.0);
    let position = q * (numbers.len() - 1) as f64;
    let (low, high) = (position.floor() as usize, position.ceil() as usize);
    Ok(OpValue::number(numbers[low] + (position - low as f64) * (numbers[high] - numbers[low])))
}

/// The sum of the weight of each item.
pub fn weighted_count(items: &OpValue, weights: &OpValue, default: &OpValue) -> Result<OpValue, OpError> {
    let Some(list) = items.as_inner().as_array().cloned() else {
        return if items.is_null() { Ok(OpValue::null()) } else { Err(invalid("weighted_count", "needs a list")) };
    };
    let weights = weights.as_inner();
    let weights = weights.as_object();
    let fallback = if default.is_null() { 1.0 } else { number_of(&default.as_inner()).ok_or_else(|| invalid("weighted_count", "default must be a number"))? };
    let mut total = 0.0;
    for item in &list {
        let key = match item {
            JsonValue::String(s) => s.clone(),
            JsonValue::Null => continue,
            other => other.to_string(),
        };
        total += weights.and_then(|map| map.get(&key)).and_then(number_of).unwrap_or(fallback);
    }
    Ok(OpValue::number(total))
}

#[derive(Clone, Copy, PartialEq)]
enum Period {
    Day,
    Week,
    Month,
}

/// Milliseconds since the epoch of an ISO date, an ISO time or a number of milliseconds.
fn millis_of(value: &JsonValue) -> Option<i64> {
    match value {
        JsonValue::Number(n) => n.as_f64().filter(|f| f.is_finite()).map(|f| f.floor() as i64),
        JsonValue::String(s) => {
            let s = s.trim();
            if let Ok(time) = DateTime::parse_from_rfc3339(s) {
                return Some(time.timestamp_millis());
            }
            let date = NaiveDate::parse_from_str(s.get(..10)?, "%Y-%m-%d").ok()?;
            Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis())
        }
        _ => None,
    }
}

/// The index of the period holding the UTC day `day` (days since the epoch): consecutive periods have consecutive indexes.
fn period_index(day: i64, period: Period) -> i64 {
    match period {
        Period::Day => day,
        // The epoch day (1970-01-01) was a Thursday, so a Monday-first week index shifts the day by 3.
        Period::Week => (day + 3).div_euclid(7),
        Period::Month => {
            let date = DateTime::from_timestamp(day * DAY_MS / 1000, 0).map(|time| time.date_naive()).unwrap_or_default();
            i64::from(date.year()) * 12 + i64::from(date.month0())
        }
    }
}

/// Consecutive periods that met the target, counting back from the period holding `now`.
pub fn streak(entries: &OpValue, period: &OpValue, times: &OpValue, now: &OpValue) -> Result<OpValue, OpError> {
    let Some(list) = entries.as_inner().as_array().cloned() else {
        return if entries.is_null() { Ok(OpValue::from_i64(0)) } else { Err(invalid("streak", "needs a list of dates")) };
    };
    let period = match period.as_inner() {
        JsonValue::Null => Period::Day,
        JsonValue::String(s) if s == "day" => Period::Day,
        JsonValue::String(s) if s == "week" => Period::Week,
        JsonValue::String(s) if s == "month" => Period::Month,
        _ => return Err(invalid("streak", "period must be day, week or month")),
    };
    let times = if times.is_null() { 1.0 } else { number_of(&times.as_inner()).ok_or_else(|| invalid("streak", "times must be a number"))? };
    if times < 1.0 || times.fract() != 0.0 {
        return Ok(OpValue::from_i64(0));
    }
    let now = millis_of(&now.as_inner()).ok_or_else(|| invalid("streak", "needs now: an ISO time or milliseconds"))?;
    let days: HashSet<i64> = list.iter().filter_map(millis_of).map(|ms| ms.div_euclid(DAY_MS)).collect();
    let mut per_period: HashMap<i64, i64> = HashMap::new();
    for day in days {
        *per_period.entry(period_index(day, period)).or_insert(0) += 1;
    }
    let met = |index: i64| per_period.get(&index).is_some_and(|count| *count as f64 >= times);
    let current = period_index(now.div_euclid(DAY_MS), period);
    let anchor = if met(current) { current } else { current - 1 };
    let mut run = 0;
    let mut index = anchor;
    while met(index) {
        run += 1;
        index -= 1;
    }
    Ok(OpValue::from_i64(run))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v(value: JsonValue) -> OpValue {
        OpValue::from(value)
    }

    fn quantile_of(numbers: JsonValue, q: JsonValue) -> JsonValue {
        quantile(&v(numbers), &v(q)).unwrap().as_inner()
    }

    #[test]
    fn quantile_interpolates_like_the_retired_measure_op() {
        // Values and answers of the retired measure-ops quantile (type 7 over the sorted numbers).
        let numbers = json!([5, 1, 9, 3, 7]);
        assert_eq!(quantile_of(numbers.clone(), json!(0.5)).as_f64(), Some(5.0));
        assert_eq!(quantile_of(numbers.clone(), json!(0.0)).as_f64(), Some(1.0));
        assert_eq!(quantile_of(numbers.clone(), json!(1.0)).as_f64(), Some(9.0));
        assert!((quantile_of(numbers.clone(), json!(0.9)).as_f64().unwrap() - 8.2).abs() < 1e-9);
        assert_eq!(quantile_of(json!([1, 2, 3, 4]), json!(0.5)).as_f64(), Some(2.5));
        assert_eq!(quantile_of(numbers.clone(), json!(7.0)).as_f64(), Some(9.0));
        assert_eq!(quantile_of(numbers, json!(null)).as_f64(), Some(5.0));
        assert_eq!(quantile_of(json!([4]), json!(0.3)).as_f64(), Some(4.0));
    }

    #[test]
    fn quantile_skips_what_is_not_a_number_and_answers_null_for_none() {
        assert_eq!(quantile_of(json!([1, null, "x", "3", 5]), json!(0.5)).as_f64(), Some(3.0));
        assert!(quantile_of(json!([]), json!(0.5)).is_null());
        assert!(quantile_of(json!(["a"]), json!(0.5)).is_null());
        assert!(quantile(&v(json!(null)), &v(json!(0.5))).unwrap().is_null());
        assert!(quantile(&v(json!(3)), &v(json!(0.5))).is_err());
    }

    #[test]
    fn weighted_count_adds_the_weight_of_each_item() {
        let weights = json!({"goal": 3, "assist": 2});
        let count = |items: JsonValue, default: JsonValue| weighted_count(&v(items), &v(weights.clone()), &v(default)).unwrap().as_inner().as_f64();
        assert_eq!(count(json!(["goal", "assist", "goal", "pass"]), json!(null)), Some(9.0));
        assert_eq!(count(json!(["goal", "pass"]), json!(0)), Some(3.0));
        assert_eq!(count(json!([]), json!(null)), Some(0.0));
        assert_eq!(weighted_count(&v(json!(["a", "b"])), &v(json!(null)), &v(json!(null))).unwrap().as_inner().as_f64(), Some(2.0));
    }

    fn streak_of(entries: JsonValue, period: &str, times: i64, now: &str) -> i64 {
        streak(&v(entries), &v(json!(period)), &v(json!(times)), &v(json!(now))).unwrap().as_inner().as_i64().unwrap()
    }

    #[test]
    fn a_daily_streak_counts_back_from_today_and_forgives_a_day_in_progress() {
        let run = json!(["2026-11-10", "2026-11-11T09:00:00Z", "2026-11-12", "2026-11-13"]);
        assert_eq!(streak_of(run.clone(), "day", 1, "2026-11-13T20:00:00Z"), 4);
        // Today not yet logged: the run that ended yesterday still stands.
        assert_eq!(streak_of(run.clone(), "day", 1, "2026-11-14T08:00:00Z"), 4);
        // A missed day breaks it.
        assert_eq!(streak_of(run.clone(), "day", 1, "2026-11-15T08:00:00Z"), 0);
        // Two entries on one day are one day.
        assert_eq!(streak_of(json!(["2026-11-13", "2026-11-13T05:00:00Z"]), "day", 1, "2026-11-13"), 1);
        assert_eq!(streak_of(json!([]), "day", 1, "2026-11-13"), 0);
    }

    #[test]
    fn a_weekly_streak_needs_the_target_in_each_monday_first_week() {
        // 2026-11-09 is a Monday. Weeks of 11-02 (two days), 11-09 (three days), the week of 11-16 has one so far.
        let log = json!(["2026-11-02", "2026-11-04", "2026-11-09", "2026-11-11", "2026-11-13", "2026-11-16"]);
        assert_eq!(streak_of(log.clone(), "week", 2, "2026-11-17"), 2);
        assert_eq!(streak_of(log.clone(), "week", 3, "2026-11-17"), 1);
        assert_eq!(streak_of(log.clone(), "week", 3, "2026-11-15"), 1);
        // Sunday 11-15 still belongs to the week that began on Monday 11-09.
        assert_eq!(streak_of(json!(["2026-11-15", "2026-11-08"]), "week", 1, "2026-11-15"), 2);
    }

    #[test]
    fn a_monthly_streak_wraps_over_the_new_year() {
        let log = json!(["2026-11-03", "2026-12-20", "2027-01-02"]);
        assert_eq!(streak_of(log.clone(), "month", 1, "2027-01-15"), 3);
        assert_eq!(streak_of(log, "month", 2, "2027-01-15"), 0);
        assert_eq!(streak_of(json!([1_767_225_600_000i64]), "month", 1, "2026-01-05"), 1);
        assert_eq!(streak_of(json!([1_767_225_600_000i64]), "month", 1, "2026-03-05"), 0);
    }

    #[test]
    fn a_malformed_request_is_refused_or_answers_zero() {
        assert!(streak(&v(json!(["2026-11-13"])), &v(json!("year")), &v(json!(1)), &v(json!("2026-11-13"))).is_err());
        assert!(streak(&v(json!(["2026-11-13"])), &v(json!("day")), &v(json!(1)), &v(json!(null))).is_err());
        assert_eq!(streak_of(json!(["2026-11-13"]), "day", 0, "2026-11-13"), 0);
        assert_eq!(streak(&v(json!(null)), &v(json!("day")), &v(json!(1)), &v(json!("2026-11-13"))).unwrap().as_inner().as_i64(), Some(0));
    }
}
