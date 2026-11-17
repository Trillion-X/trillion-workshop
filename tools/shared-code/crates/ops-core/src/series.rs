//! Series operators for ops-core: what a list of numbers or dated entries says as a whole.
//!
//! The reductions a measure over rows needs and the element-wise operators cannot build, because
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
//! - `longest_streak(entries, period, times)`: the longest run of consecutive calendar periods, anywhere in the
//!   entries, in each of which at least `times` different UTC days have an entry (no `now`: the run need not
//!   reach the present).
//! - `variance(numbers)` and `standard_deviation(numbers)`: the population variance (the mean of the squared
//!   distances from the mean) and its square root; null when there are no numbers.
//! - `histogram(numbers, edges)`: how many of the numbers fall in each bin `[edges[i], edges[i + 1])`, one count
//!   per pair of neighbouring edges; a number is counted in the first bin that holds it, a number outside every
//!   bin in none.
//!
//! All are pure: no clock (`now` is an argument), no I/O, deterministic.

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

fn period_of(period: &OpValue, operation: &str) -> Result<Period, OpError> {
    match period.as_inner() {
        JsonValue::Null => Ok(Period::Day),
        JsonValue::String(s) if s == "day" => Ok(Period::Day),
        JsonValue::String(s) if s == "week" => Ok(Period::Week),
        JsonValue::String(s) if s == "month" => Ok(Period::Month),
        _ => Err(invalid(operation, "period must be day, week or month")),
    }
}

/// The target (days per period) and how many different UTC days hold an entry in each period, by its index.
type DaysPerPeriod = (f64, HashMap<i64, i64>);

/// How many different UTC days of each period (by its index) hold an entry; `None` when `times` is not a whole number of at least 1.
fn days_per_period(list: &[JsonValue], period: Period, times: &OpValue, operation: &str) -> Result<Option<DaysPerPeriod>, OpError> {
    let times = if times.is_null() { 1.0 } else { number_of(&times.as_inner()).ok_or_else(|| invalid(operation, "times must be a number"))? };
    if times < 1.0 || times.fract() != 0.0 {
        return Ok(None);
    }
    let days: HashSet<i64> = list.iter().filter_map(millis_of).map(|ms| ms.div_euclid(DAY_MS)).collect();
    let mut per_period: HashMap<i64, i64> = HashMap::new();
    for day in days {
        *per_period.entry(period_index(day, period)).or_insert(0) += 1;
    }
    Ok(Some((times, per_period)))
}

/// Consecutive periods that met the target, counting back from the period holding `now`.
pub fn streak(entries: &OpValue, period: &OpValue, times: &OpValue, now: &OpValue) -> Result<OpValue, OpError> {
    let Some(list) = entries.as_inner().as_array().cloned() else {
        return if entries.is_null() { Ok(OpValue::from_i64(0)) } else { Err(invalid("streak", "needs a list of dates")) };
    };
    let period = period_of(period, "streak")?;
    let Some((times, per_period)) = days_per_period(&list, period, times, "streak")? else {
        return Ok(OpValue::from_i64(0));
    };
    let now = millis_of(&now.as_inner()).ok_or_else(|| invalid("streak", "needs now: an ISO time or milliseconds"))?;
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

/// The longest run of consecutive periods that met the target, anywhere in the entries.
pub fn longest_streak(entries: &OpValue, period: &OpValue, times: &OpValue) -> Result<OpValue, OpError> {
    let Some(list) = entries.as_inner().as_array().cloned() else {
        return if entries.is_null() { Ok(OpValue::from_i64(0)) } else { Err(invalid("longest_streak", "needs a list of dates")) };
    };
    let period = period_of(period, "longest_streak")?;
    let Some((times, per_period)) = days_per_period(&list, period, times, "longest_streak")? else {
        return Ok(OpValue::from_i64(0));
    };
    let mut met: Vec<i64> = per_period.into_iter().filter(|(_, count)| *count as f64 >= times).map(|(index, _)| index).collect();
    met.sort_unstable();
    let (mut best, mut run) = (0, 0);
    for (place, index) in met.iter().enumerate() {
        run = if place > 0 && *index == met[place - 1] + 1 { run + 1 } else { 1 };
        best = best.max(run);
    }
    Ok(OpValue::from_i64(best))
}

fn numbers_in(values: &OpValue, operation: &str) -> Result<Option<Vec<f64>>, OpError> {
    let Some(items) = values.as_inner().as_array().cloned() else {
        return if values.is_null() { Ok(None) } else { Err(invalid(operation, "needs a list of numbers")) };
    };
    let numbers: Vec<f64> = items.iter().filter_map(number_of).collect();
    Ok(if numbers.is_empty() { None } else { Some(numbers) })
}

fn population_variance(numbers: &[f64]) -> f64 {
    let mean = numbers.iter().sum::<f64>() / numbers.len() as f64;
    numbers.iter().map(|n| (n - mean) * (n - mean)).sum::<f64>() / numbers.len() as f64
}

/// The population variance of the numbers in `values`; null when there are none.
pub fn variance(values: &OpValue) -> Result<OpValue, OpError> {
    Ok(numbers_in(values, "variance")?.map_or_else(OpValue::null, |numbers| OpValue::number(population_variance(&numbers))))
}

/// The population standard deviation of the numbers in `values`; null when there are none.
pub fn standard_deviation(values: &OpValue) -> Result<OpValue, OpError> {
    Ok(numbers_in(values, "standard_deviation")?.map_or_else(OpValue::null, |numbers| OpValue::number(population_variance(&numbers).sqrt())))
}

/// One count per bin `[edges[i], edges[i + 1])`: how many of the numbers in `values` fall in it (the first bin that holds a number counts it).
pub fn histogram(values: &OpValue, edges: &OpValue) -> Result<OpValue, OpError> {
    let Some(edge_list) = edges.as_inner().as_array().cloned() else {
        return Err(invalid("histogram", "needs edges: a list of numbers"));
    };
    let edge_numbers: Vec<f64> = edge_list.iter().map(number_of).collect::<Option<_>>().ok_or_else(|| invalid("histogram", "edges must all be numbers"))?;
    let numbers = numbers_in(values, "histogram")?.unwrap_or_default();
    let mut counts = vec![0_i64; edge_numbers.len().saturating_sub(1)];
    for number in numbers {
        if let Some(bin) = edge_numbers.windows(2).position(|pair| number >= pair[0] && number < pair[1]) {
            counts[bin] += 1;
        }
    }
    Ok(OpValue::from(JsonValue::Array(counts.into_iter().map(JsonValue::from).collect())))
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

    #[test]
    fn the_longest_streak_is_the_longest_run_anywhere_in_the_entries() {
        let longest = |entries: JsonValue, period: &str, times: i64| longest_streak(&v(entries), &v(json!(period)), &v(json!(times))).unwrap().as_inner().as_i64().unwrap();
        // Runs of 3 and 2 days, with a gap; the older run is the longer one.
        let log = json!(["2026-11-01", "2026-11-02T09:00:00Z", "2026-11-03", "2026-11-10", "2026-11-11", "2026-11-11T20:00:00Z"]);
        assert_eq!(longest(log.clone(), "day", 1), 3);
        assert_eq!(longest(log.clone(), "day", 2), 0);
        assert_eq!(longest(json!(["2026-11-13"]), "day", 1), 1);
        assert_eq!(longest(json!([]), "day", 1), 0);
        // Milliseconds are entries too (a habit log of day starts).
        assert_eq!(longest(json!([1_767_225_600_000i64, 1_767_312_000_000i64, 1_767_571_200_000i64]), "day", 1), 2);
        // Weeks of 11-02 (two days), 11-09 (two days), 11-16 (one day), then a missed week and 11-30 (two days).
        let weeks = json!(["2026-11-02", "2026-11-04", "2026-11-09", "2026-11-11", "2026-11-16", "2026-11-30", "2026-12-01"]);
        assert_eq!(longest(weeks.clone(), "week", 2), 2);
        assert_eq!(longest(weeks, "week", 1), 3);
        assert_eq!(longest(json!(["2026-11-03", "2026-12-20", "2027-01-02"]), "month", 1), 3);
        assert_eq!(longest(json!(["2026-11-03", "2027-01-02"]), "month", 1), 1);
        assert_eq!(longest(json!(["2026-11-03", "2026-12-20", "2027-01-02", "2027-02-01"]), "month", 1), 4);
        assert_eq!(longest(json!(["2026-11-13"]), "day", 0), 0);
        assert!(longest_streak(&v(json!(["2026-11-13"])), &v(json!("year")), &v(json!(1))).is_err());
        assert!(longest_streak(&v(json!(3)), &v(json!("day")), &v(json!(1))).is_err());
        assert_eq!(longest_streak(&v(json!(null)), &v(json!("day")), &v(json!(1))).unwrap().as_inner().as_i64(), Some(0));
    }

    #[test]
    fn variance_and_standard_deviation_are_the_population_ones() {
        let numbers = json!([2, 4, 4, 4, 5, 5, 7, 9]);
        assert_eq!(variance(&v(numbers.clone())).unwrap().as_inner().as_f64(), Some(4.0));
        assert_eq!(standard_deviation(&v(numbers)).unwrap().as_inner().as_f64(), Some(2.0));
        // Text that is a number counts; anything else is skipped.
        assert_eq!(variance(&v(json!([1, "3", null, "x"]))).unwrap().as_inner().as_f64(), Some(1.0));
        assert_eq!(variance(&v(json!([6]))).unwrap().as_inner().as_f64(), Some(0.0));
        assert!(variance(&v(json!([]))).unwrap().is_null());
        assert!(standard_deviation(&v(json!(["a"]))).unwrap().is_null());
        assert!(variance(&v(json!(null))).unwrap().is_null());
        assert!(variance(&v(json!(3))).is_err());
        assert!(standard_deviation(&v(json!({}))).is_err());
    }

    #[test]
    fn a_histogram_counts_each_number_in_the_first_bin_that_holds_it() {
        let counts = |numbers: JsonValue, edges: JsonValue| histogram(&v(numbers), &v(edges)).unwrap().as_inner();
        assert_eq!(counts(json!([0, 1, 5, 9, 10, 11, -1, "4", "x", null]), json!([0, 5, 10])), json!([3, 2]));
        // An edge belongs to the bin it starts; the last edge is outside every bin.
        assert_eq!(counts(json!([5, 10]), json!([0, 5, 10])), json!([0, 1]));
        assert_eq!(counts(json!([]), json!([0, 5, 10])), json!([0, 0]));
        assert_eq!(counts(json!(null), json!([0, 5])), json!([0]));
        assert_eq!(counts(json!([1, 2]), json!([])), json!([]));
        assert_eq!(counts(json!([1, 2]), json!([3])), json!([]));
        assert!(histogram(&v(json!([1])), &v(json!(null))).is_err());
        assert!(histogram(&v(json!([1])), &v(json!([0, "a"]))).is_err());
        assert!(histogram(&v(json!(7)), &v(json!([0, 5]))).is_err());
    }
}
