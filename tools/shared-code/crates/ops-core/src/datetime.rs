//! DateTime operators for the Architect Platform
//!
//! This module provides pure functions for date/time operations,
//! extracted from the formula-engine's RewriteRule implementations.
//!
//! # Date/Time Format
//!
//! - Dates are represented as ISO 8601 strings: "YYYY-MM-DD"
//! - DateTimes are represented as RFC 3339 strings: "2024-01-15T10:30:00Z"
//! - Timestamps are milliseconds since Unix epoch
//!
//! # Null Propagation
//!
//! All operators propagate null: `date_add(null, _, _) = null`

use crate::{EvalContext, OpError, OpValue};
use chrono::{
    DateTime, Datelike, Duration, NaiveDate, NaiveTime, TimeZone, Timelike, Utc, Weekday,
};
use chrono_tz::Tz;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;

// ============================================================================
// DateTime Extraction Capability
// ============================================================================

/// Type alias for a datetime extraction function closure.
type DateTimeExtractFn = Arc<dyn Fn(&OpValue) -> Result<OpValue, OpError> + Send + Sync>;

/// DateTime extraction capability with registered extraction units (year, month, day, etc.).
///
/// This struct holds type-erased closures for each registered datetime extraction unit.
/// Adding a new unit requires registering a closure — no new function definitions needed.
#[derive(Clone)]
pub struct DateTimeExtractCapability {
    extractors: HashMap<String, DateTimeExtractFn>,
}

impl DateTimeExtractCapability {
    /// Create a new DateTimeExtractCapability with all built-in units registered.
    pub fn new() -> Self {
        let mut cap = Self {
            extractors: HashMap::new(),
        };
        cap.register_builtin_units();
        cap
    }

    /// Register a custom datetime extraction unit.
    pub fn register(&mut self, unit: String, extract_fn: DateTimeExtractFn) {
        self.extractors.insert(unit, extract_fn);
    }

    /// Get the list of available units.
    pub fn available_units(&self) -> Vec<String> {
        let mut units: Vec<_> = self.extractors.keys().cloned().collect();
        units.sort();
        units
    }

    /// Register all built-in datetime extraction units.
    fn register_builtin_units(&mut self) {
        // Year
        self.register(
            "year".to_string(),
            Arc::new(|datetime| {
                if datetime.is_null() {
                    return Ok(OpValue::null());
                }

                let dt_str = datetime.as_str("extract:year")?;
                let year_val = if is_date_only(dt_str) {
                    parse_naive_date(dt_str)?.year()
                } else {
                    parse_rfc3339_to_utc(dt_str)?.year()
                };

                Ok(OpValue::number(year_val as f64))
            }),
        );

        // Month
        self.register(
            "month".to_string(),
            Arc::new(|datetime| {
                if datetime.is_null() {
                    return Ok(OpValue::null());
                }

                let dt_str = datetime.as_str("extract:month")?;
                let month_val = if is_date_only(dt_str) {
                    parse_naive_date(dt_str)?.month()
                } else {
                    parse_rfc3339_to_utc(dt_str)?.month()
                };

                Ok(OpValue::number(month_val as f64))
            }),
        );

        // Day
        self.register(
            "day".to_string(),
            Arc::new(|datetime| {
                if datetime.is_null() {
                    return Ok(OpValue::null());
                }

                let dt_str = datetime.as_str("extract:day")?;
                let day_val = if is_date_only(dt_str) {
                    parse_naive_date(dt_str)?.day()
                } else {
                    parse_rfc3339_to_utc(dt_str)?.day()
                };

                Ok(OpValue::number(day_val as f64))
            }),
        );

        // Hour
        self.register(
            "hour".to_string(),
            Arc::new(|datetime| {
                if datetime.is_null() {
                    return Ok(OpValue::null());
                }

                let dt_str = datetime.as_str("extract:hour")?;
                let utc = parse_rfc3339_to_utc(dt_str)?;

                Ok(OpValue::number(utc.hour() as f64))
            }),
        );

        // Minute
        self.register(
            "minute".to_string(),
            Arc::new(|datetime| {
                if datetime.is_null() {
                    return Ok(OpValue::null());
                }

                let dt_str = datetime.as_str("extract:minute")?;
                let utc = parse_rfc3339_to_utc(dt_str)?;

                Ok(OpValue::number(utc.minute() as f64))
            }),
        );

        // Second
        self.register(
            "second".to_string(),
            Arc::new(|datetime| {
                if datetime.is_null() {
                    return Ok(OpValue::null());
                }

                let dt_str = datetime.as_str("extract:second")?;
                let utc = parse_rfc3339_to_utc(dt_str)?;

                Ok(OpValue::number(utc.second() as f64))
            }),
        );

        // Weekday (0=Sunday, 6=Saturday)
        self.register(
            "weekday".to_string(),
            Arc::new(|datetime| {
                if datetime.is_null() {
                    return Ok(OpValue::null());
                }

                let dt_str = datetime.as_str("extract:weekday")?;
                let weekday_val = if is_date_only(dt_str) {
                    parse_naive_date(dt_str)?.weekday()
                } else {
                    parse_rfc3339_to_utc(dt_str)?.weekday()
                };

                // chrono's Weekday: Mon=0...Sun=6, but we want Sun=0...Sat=6
                let weekday_num = match weekday_val {
                    Weekday::Sun => 0,
                    Weekday::Mon => 1,
                    Weekday::Tue => 2,
                    Weekday::Wed => 3,
                    Weekday::Thu => 4,
                    Weekday::Fri => 5,
                    Weekday::Sat => 6,
                };

                Ok(OpValue::number(weekday_num as f64))
            }),
        );

        // Timestamp (milliseconds since epoch)
        self.register(
            "timestamp".to_string(),
            Arc::new(|datetime| {
                if datetime.is_null() {
                    return Ok(OpValue::null());
                }

                let dt_str = datetime.as_str("extract:timestamp")?;
                let utc = parse_rfc3339_to_utc(dt_str)?;
                let timestamp_ms = utc.timestamp_millis() as f64;

                Ok(OpValue::number(timestamp_ms))
            }),
        );
    }

    /// Extract a component from a datetime using the specified unit.
    pub fn extract(&self, datetime: &OpValue, unit: &str) -> Result<OpValue, OpError> {
        match self.extractors.get(unit) {
            Some(extract_fn) => extract_fn(datetime),
            None => {
                let available = self.available_units();
                Err(OpError::InvalidArgument {
                    operation: "extract".to_string(),
                    reason: format!(
                        "Unit '{}' not registered. Available units: {}",
                        unit,
                        available.join(", ")
                    ),
                })
            }
        }
    }
}

impl Default for DateTimeExtractCapability {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for DateTimeExtractCapability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DateTimeExtractCapability")
            .field("available_units", &self.available_units())
            .finish()
    }
}

// ============================================================================
// Core DateTime Functions
// ============================================================================

/// Extract a datetime component using the specified unit.
///
/// Available units: "year", "month", "day", "hour", "minute", "second", "weekday", "timestamp"
///
/// Null propagation: `extract(null, _) = null`
pub fn extract(datetime: &OpValue, unit: &OpValue, ctx: &EvalContext) -> Result<OpValue, OpError> {
    let cap = ctx
        .capabilities
        .get::<DateTimeExtractCapability>()
        .ok_or_else(|| OpError::InvalidOperation {
            operation: "extract".to_string(),
            reason: "DateTimeExtractCapability not registered in context".to_string(),
        })?;

    let unit_str = unit.as_str("extract")?;
    cap.extract(datetime, unit_str)
}

/// Get the current timestamp.
///
/// Returns the current UTC time as an RFC 3339 string.
///
/// Note: In production, this should receive a deterministic timestamp
/// from the evaluation context for reproducibility.
pub fn now(_ctx: &EvalContext) -> Result<OpValue, OpError> {
    let now = Utc::now();
    Ok(OpValue::string(to_rfc3339(now)))
}

/// Get the current timestamp with a specific timezone.
///
/// Returns the current time in the specified timezone as an RFC 3339 string.
pub fn now_tz(timezone: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    if timezone.is_null() {
        return Ok(OpValue::null());
    }

    let tz_str = timezone.as_str("now_tz")?;
    let tz = parse_tz(tz_str)?;
    let now = Utc::now();
    let local = utc_to_tz(now, tz);
    Ok(OpValue::string(to_rfc3339(local)))
}

/// Add a duration to a date/datetime.
///
/// - datetime: RFC 3339 string
/// - amount: Number of units to add (can be negative)
/// - unit: "milliseconds", "seconds", "minutes", "hours", "days", "weeks", "months", "years"
///
/// Null propagation: `date_add(null, _, _) = null`
pub fn date_add(
    datetime: &OpValue,
    amount: &OpValue,
    unit: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    if datetime.is_null() || amount.is_null() || unit.is_null() {
        return Ok(OpValue::null());
    }

    let dt_str = datetime.as_str("date_add")?;
    let amount_val = amount.as_f64("date_add")?.round() as i64;
    let unit_str = unit.as_str("date_add")?;

    let utc = parse_rfc3339_to_utc(dt_str)?;
    let parsed_unit = parse_unit(unit_str)?;

    let new_utc = match parsed_unit {
        "ms" => utc + Duration::milliseconds(amount_val),
        "s" => utc + Duration::seconds(amount_val),
        "m" => utc + Duration::minutes(amount_val),
        "h" => utc + Duration::hours(amount_val),
        "d" => utc + Duration::days(amount_val),
        "w" => utc + Duration::weeks(amount_val),
        "mo" => {
            let naive = utc.naive_utc();
            let months = chrono::Months::new(amount_val.unsigned_abs() as u32);
            let shifted = if amount_val >= 0 {
                naive.checked_add_months(months)
            } else {
                naive.checked_sub_months(months)
            }
            .ok_or_else(|| OpError::NumericOverflow {
                operation: "date_add".to_string(),
                details: "month arithmetic overflow".to_string(),
            })?;
            DateTime::<Utc>::from_naive_utc_and_offset(shifted, Utc)
        }
        "y" => {
            let naive = utc.naive_utc();
            let year_months = (amount_val * 12).unsigned_abs() as u32;
            let months = chrono::Months::new(year_months);
            let shifted = if amount_val >= 0 {
                naive.checked_add_months(months)
            } else {
                naive.checked_sub_months(months)
            }
            .ok_or_else(|| OpError::NumericOverflow {
                operation: "date_add".to_string(),
                details: "year arithmetic overflow".to_string(),
            })?;
            DateTime::<Utc>::from_naive_utc_and_offset(shifted, Utc)
        }
        _ => unreachable!(),
    };

    Ok(OpValue::string(to_rfc3339(new_utc)))
}

/// Calculate the difference between two dates/datetimes.
///
/// - start: RFC 3339 string
/// - end: RFC 3339 string
/// - unit: "milliseconds", "seconds", "minutes", "hours", "days", "weeks", "months", "years"
///
/// Returns the difference (end - start) in the specified unit.
///
/// Null propagation: `date_diff(null, _, _) = null`
pub fn date_diff(
    start: &OpValue,
    end: &OpValue,
    unit: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    if start.is_null() || end.is_null() || unit.is_null() {
        return Ok(OpValue::null());
    }

    let start_str = start.as_str("date_diff")?;
    let end_str = end.as_str("date_diff")?;
    let unit_str = unit.as_str("date_diff")?;

    let start_utc = parse_rfc3339_to_utc(start_str)?;
    let end_utc = parse_rfc3339_to_utc(end_str)?;
    let parsed_unit = parse_unit(unit_str)?;

    let diff = match parsed_unit {
        "ms" => (end_utc - start_utc).num_milliseconds() as f64,
        "s" => (end_utc - start_utc).num_seconds() as f64,
        "m" => (end_utc - start_utc).num_minutes() as f64,
        "h" => (end_utc - start_utc).num_hours() as f64,
        "d" => (end_utc - start_utc).num_days() as f64,
        "w" => (end_utc - start_utc).num_weeks() as f64,
        "mo" => {
            // Approximate month calculation
            let years_diff = end_utc.year() - start_utc.year();
            let months_diff = end_utc.month() as i32 - start_utc.month() as i32;
            (years_diff * 12 + months_diff) as f64
        }
        "y" => (end_utc.year() - start_utc.year()) as f64,
        _ => unreachable!(),
    };

    Ok(OpValue::number(diff))
}

/// Format a datetime using a format string.
///
/// - datetime: RFC 3339 string
/// - format: chrono format string (e.g., "%Y-%m-%d", "%H:%M:%S")
///
/// Null propagation: `format_date(null, _) = null`
pub fn format_date(
    datetime: &OpValue,
    format: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    if datetime.is_null() || format.is_null() {
        return Ok(OpValue::null());
    }

    let dt_str = datetime.as_str("format_date")?;
    let format_str = format.as_str("format_date")?;

    let utc = parse_rfc3339_to_utc(dt_str)?;
    let formatted = utc.format(format_str).to_string();

    Ok(OpValue::string(formatted))
}

/// Format a datetime with timezone.
///
/// - datetime: RFC 3339 string
/// - format: chrono format string
/// - timezone: IANA timezone string (e.g., "America/New_York")
pub fn format_date_tz(
    datetime: &OpValue,
    format: &OpValue,
    timezone: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    if datetime.is_null() || format.is_null() {
        return Ok(OpValue::null());
    }

    let dt_str = datetime.as_str("format_date_tz")?;
    let format_str = format.as_str("format_date_tz")?;

    let utc = parse_rfc3339_to_utc(dt_str)?;

    let formatted = if timezone.is_null() {
        utc.format(format_str).to_string()
    } else {
        let tz_str = timezone.as_str("format_date_tz")?;
        let tz = parse_tz(tz_str)?;
        let local = utc_to_tz(utc, tz);
        local.naive_local().format(format_str).to_string()
    };

    Ok(OpValue::string(formatted))
}

// ============================================================================
// Date Component Extraction (OLD FUNCTIONS DELETED — Use extract() with unit parameter)
// ============================================================================

// ============================================================================
// Timestamp Conversion
// ============================================================================

/// Convert a datetime to a Unix timestamp (milliseconds since epoch).
pub fn timestamp(datetime: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    if datetime.is_null() {
        return Ok(OpValue::null());
    }

    let dt_str = datetime.as_str("timestamp")?;
    let utc = parse_rfc3339_to_utc(dt_str)?;
    let timestamp_ms = utc.timestamp_millis() as f64;

    Ok(OpValue::number(timestamp_ms))
}

/// Convert a Unix timestamp (milliseconds) to a datetime string.
pub fn from_timestamp(milliseconds: &OpValue, _ctx: &EvalContext) -> Result<OpValue, OpError> {
    if milliseconds.is_null() {
        return Ok(OpValue::null());
    }

    let ms = milliseconds.as_f64("from_timestamp")?.round() as i64;
    let utc =
        DateTime::<Utc>::from_timestamp_millis(ms).ok_or_else(|| OpError::InvalidArgument {
            operation: "from_timestamp".to_string(),
            reason: "invalid timestamp".to_string(),
        })?;

    Ok(OpValue::string(to_rfc3339(utc)))
}

/// Convert a Unix timestamp (milliseconds) to a datetime string with timezone.
pub fn from_timestamp_tz(
    milliseconds: &OpValue,
    timezone: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    if milliseconds.is_null() {
        return Ok(OpValue::null());
    }

    let ms = milliseconds.as_f64("from_timestamp_tz")?.round() as i64;
    let utc =
        DateTime::<Utc>::from_timestamp_millis(ms).ok_or_else(|| OpError::InvalidArgument {
            operation: "from_timestamp_tz".to_string(),
            reason: "invalid timestamp".to_string(),
        })?;

    if timezone.is_null() {
        return Ok(OpValue::string(to_rfc3339(utc)));
    }

    let tz_str = timezone.as_str("from_timestamp_tz")?;
    let tz = parse_tz(tz_str)?;
    let local = utc_to_tz(utc, tz);

    Ok(OpValue::string(to_rfc3339(local)))
}

// ============================================================================
// Date Construction
// ============================================================================

/// Construct a date from year, month, day.
///
/// Returns a date string in ISO 8601 format: "YYYY-MM-DD"
pub fn make_date(
    year_val: &OpValue,
    month_val: &OpValue,
    day_val: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    if year_val.is_null() || month_val.is_null() || day_val.is_null() {
        return Ok(OpValue::null());
    }

    let y = year_val.as_f64("make_date")?.round() as i32;
    let m = month_val.as_f64("make_date")?.round() as u32;
    let d = day_val.as_f64("make_date")?.round() as u32;

    let date = NaiveDate::from_ymd_opt(y, m, d).ok_or_else(|| OpError::InvalidArgument {
        operation: "make_date".to_string(),
        reason: format!("invalid date components: year={} month={} day={}", y, m, d),
    })?;

    Ok(OpValue::string(date.format("%Y-%m-%d").to_string()))
}

/// Construct a time from hour, minute, second.
///
/// Returns a time string in format: "HH:MM:SS"
pub fn make_time(
    hour_val: &OpValue,
    minute_val: &OpValue,
    second_val: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    if hour_val.is_null() || minute_val.is_null() || second_val.is_null() {
        return Ok(OpValue::null());
    }

    let h = hour_val.as_f64("make_time")?.round() as u32;
    let m = minute_val.as_f64("make_time")?.round() as u32;
    let s = second_val.as_f64("make_time")?.round() as u32;

    let time = NaiveTime::from_hms_opt(h, m, s).ok_or_else(|| OpError::InvalidArgument {
        operation: "make_time".to_string(),
        reason: format!(
            "invalid time components: hour={} minute={} second={}",
            h, m, s
        ),
    })?;

    Ok(OpValue::string(time.format("%H:%M:%S").to_string()))
}

// ============================================================================
// Additional DateTime Functions (Missing from initial implementation)
// ============================================================================

/// Convert a datetime from one timezone to another.
///
/// - datetime: RFC 3339 string or date string
/// - from_tz: Source IANA timezone
/// - to_tz: Target IANA timezone
///
/// Null propagation: `convert_tz(null, _, _) = null`
pub fn convert_tz(
    datetime: &OpValue,
    from_tz: &OpValue,
    to_tz: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    if datetime.is_null() || from_tz.is_null() || to_tz.is_null() {
        return Ok(OpValue::null());
    }

    let dt_str = datetime.as_str("convert_tz")?;
    let from_tz_str = from_tz.as_str("convert_tz")?;
    let to_tz_str = to_tz.as_str("convert_tz")?;

    let from = parse_tz(from_tz_str)?;
    let to = parse_tz(to_tz_str)?;

    // Parse as naive datetime first, then apply from_tz
    let naive = if is_date_only(dt_str) {
        // Date only, add midnight time
        let date = parse_naive_date(dt_str)?;
        date.and_hms_opt(0, 0, 0).unwrap()
    } else if dt_str.contains('T') || dt_str.contains(' ') {
        // Parse as datetime
        parse_rfc3339_to_utc(dt_str)?.naive_utc()
    } else {
        return Err(OpError::InvalidArgument {
            operation: "convert_tz".to_string(),
            reason: "invalid datetime format".to_string(),
        });
    };

    // Convert through UTC to handle DST properly
    let from_dt =
        from.from_local_datetime(&naive)
            .single()
            .ok_or_else(|| OpError::InvalidArgument {
                operation: "convert_tz".to_string(),
                reason: "ambiguous or invalid local time in source timezone".to_string(),
            })?;

    let utc = from_dt.with_timezone(&Utc);
    let to_dt = utc_to_tz(utc, to);

    Ok(OpValue::string(to_rfc3339(to_dt)))
}

/// Calculate the number of working days between two dates.
///
/// - start_date: Start date (RFC 3339 or YYYY-MM-DD)
/// - end_date: End date (RFC 3339 or YYYY-MM-DD)
/// - holidays: Optional array of holiday dates to exclude
///
/// Null propagation: `workdays(null, _, _) = null`
pub fn workdays(
    start_date: &OpValue,
    end_date: &OpValue,
    holidays: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    if start_date.is_null() || end_date.is_null() {
        return Ok(OpValue::null());
    }

    let start_str = start_date.as_str("workdays")?;
    let end_str = end_date.as_str("workdays")?;

    let start = if is_date_only(start_str) {
        parse_naive_date(start_str)?
    } else {
        parse_rfc3339_to_utc(start_str)?.date_naive()
    };

    let end = if is_date_only(end_str) {
        parse_naive_date(end_str)?
    } else {
        parse_rfc3339_to_utc(end_str)?.date_naive()
    };

    if start > end {
        return Ok(OpValue::number(0.0));
    }

    // Parse holidays
    let holidays_set: std::collections::HashSet<NaiveDate> = if holidays.is_null() {
        std::collections::HashSet::new()
    } else {
        let arr = holidays.as_array("workdays")?;
        arr.iter()
            .filter_map(|v| {
                OpValue::from_arc(std::sync::Arc::clone(v))
                    .as_str("workdays")
                    .ok()
                    .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            })
            .collect()
    };

    // Calculate workdays
    let num_days = (end - start).num_days() + 1;
    let num_weeks = num_days / 7;
    let mut workdays = num_weeks * 5;

    let mut current = start + Duration::try_weeks(num_weeks).unwrap_or(Duration::zero());
    while current <= end {
        let weekday = current.weekday();
        if weekday != chrono::Weekday::Sat && weekday != chrono::Weekday::Sun {
            workdays += 1;
        }
        current += Duration::try_days(1).unwrap();
    }

    // Subtract holidays that fall on a workday
    for holiday in holidays_set {
        if holiday >= start && holiday <= end {
            let weekday = holiday.weekday();
            if weekday != chrono::Weekday::Sat && weekday != chrono::Weekday::Sun {
                workdays -= 1;
            }
        }
    }

    Ok(OpValue::number(workdays as f64))
}

/// Get the start of a time unit for a datetime.
///
/// - datetime: RFC 3339 string
/// - unit: "year", "month", "week", "day", "hour", "minute"
/// - timezone: Optional IANA timezone. The unit is read on that zone's wall clock, so the start of a New York day is
///   its local midnight, and the answer is written with that zone's offset.
///
/// Null propagation: `start_of(null, _) = null`
pub fn start_of(
    datetime: &OpValue,
    unit: &OpValue,
    timezone: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    unit_bound(datetime, unit, timezone, false, "start_of")
}

/// Get the end of a time unit for a datetime: its last whole second.
///
/// - datetime: RFC 3339 string
/// - unit: "year", "month", "week", "day", "hour", "minute"
/// - timezone: Optional IANA timezone, read the same way as in `start_of`
///
/// Null propagation: `end_of(null, _) = null`
pub fn end_of(
    datetime: &OpValue,
    unit: &OpValue,
    timezone: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    unit_bound(datetime, unit, timezone, true, "end_of")
}

/// The first (or last whole) second of the unit holding `datetime`, worked out on the zone's wall clock. A wall time
/// the zone skips (a clock change at midnight) moves to the first instant the zone has after it for a start, and to
/// the last one before it for an end.
fn unit_bound(
    datetime: &OpValue,
    unit: &OpValue,
    timezone: &OpValue,
    at_end: bool,
    operation: &str,
) -> Result<OpValue, OpError> {
    if datetime.is_null() || unit.is_null() {
        return Ok(OpValue::null());
    }

    let dt_str = datetime.as_str(operation)?;
    let unit_str = unit.as_str(operation)?;
    let parsed_unit = parse_unit(unit_str)?;
    let utc = parse_rfc3339_to_utc(dt_str)?;
    let tz = if timezone.is_null() { None } else { Some(parse_tz(timezone.as_str(operation)?)?) };
    let wall = match tz {
        Some(zone) => utc_to_tz(utc, zone).naive_local(),
        None => utc.naive_utc(),
    };

    let date = wall.date();
    let (first_day, last_day) = match parsed_unit {
        "y" => (
            NaiveDate::from_ymd_opt(date.year(), 1, 1),
            NaiveDate::from_ymd_opt(date.year(), 12, 31),
        ),
        "mo" => (
            NaiveDate::from_ymd_opt(date.year(), date.month(), 1),
            NaiveDate::from_ymd_opt(date.year(), date.month(), days_in_month(date.year(), date.month())),
        ),
        "w" => {
            let monday = date - Duration::days(date.weekday().num_days_from_monday() as i64);
            (Some(monday), Some(monday + Duration::days(6)))
        }
        "d" | "h" | "m" => (Some(date), Some(date)),
        _ => {
            return Err(OpError::InvalidArgument {
                operation: operation.to_string(),
                reason: format!(
                    "invalid unit for {operation}. Use year, month, week, day, hour, minute"
                ),
            })
        }
    };
    let (hour, minute) = (wall.hour(), wall.minute());
    let bound = match (parsed_unit, at_end) {
        ("h", false) => first_day.and_then(|d| d.and_hms_opt(hour, 0, 0)),
        ("h", true) => last_day.and_then(|d| d.and_hms_opt(hour, 59, 59)),
        ("m", false) => first_day.and_then(|d| d.and_hms_opt(hour, minute, 0)),
        ("m", true) => last_day.and_then(|d| d.and_hms_opt(hour, minute, 59)),
        (_, false) => first_day.and_then(|d| d.and_hms_opt(0, 0, 0)),
        (_, true) => last_day.and_then(|d| d.and_hms_opt(23, 59, 59)),
    }
    .ok_or_else(|| OpError::InvalidArgument {
        operation: operation.to_string(),
        reason: format!("no {unit_str} bound for {dt_str}"),
    })?;

    let Some(zone) = tz else {
        return Ok(OpValue::string(to_rfc3339(Utc.from_utc_datetime(&bound))));
    };
    // A skipped wall time is stepped over a minute at a time; no zone skips more than a day.
    let step = Duration::minutes(if at_end { -1 } else { 1 });
    let mut wall_bound = bound;
    for _ in 0..=24 * 60 {
        let resolved = zone.from_local_datetime(&wall_bound);
        let instant = if at_end { resolved.latest() } else { resolved.earliest() };
        if let Some(instant) = instant {
            let instant = if at_end { instant.with_second(59).unwrap_or(instant) } else { instant };
            return Ok(OpValue::string(to_rfc3339(instant)));
        }
        wall_bound += step;
    }
    Err(OpError::InvalidArgument {
        operation: operation.to_string(),
        reason: format!("{} has no wall time near {bound}", zone.name()),
    })
}

/// Construct a full datetime from components.
///
/// - year, month, day, hour, minute, second: Numeric components
/// - timezone: Optional IANA timezone
///
/// Returns RFC 3339 datetime string.
///
/// Null propagation: `make_datetime(null, ...) = null`
#[allow(clippy::too_many_arguments)]
pub fn make_datetime(
    year_val: &OpValue,
    month_val: &OpValue,
    day_val: &OpValue,
    hour_val: &OpValue,
    minute_val: &OpValue,
    second_val: &OpValue,
    timezone: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    if year_val.is_null()
        || month_val.is_null()
        || day_val.is_null()
        || hour_val.is_null()
        || minute_val.is_null()
        || second_val.is_null()
    {
        return Ok(OpValue::null());
    }

    let y = year_val.as_f64("make_datetime")?.round() as i32;
    let mo = month_val.as_f64("make_datetime")?.round() as u32;
    let d = day_val.as_f64("make_datetime")?.round() as u32;
    let h = hour_val.as_f64("make_datetime")?.round() as u32;
    let mi = minute_val.as_f64("make_datetime")?.round() as u32;
    let s = second_val.as_f64("make_datetime")?.round() as u32;

    let naive_dt = NaiveDate::from_ymd_opt(y, mo, d)
        .and_then(|date| date.and_hms_opt(h, mi, s))
        .ok_or_else(|| OpError::InvalidArgument {
            operation: "make_datetime".to_string(),
            reason: format!(
                "invalid datetime components: {}-{:02}-{:02} {:02}:{:02}:{:02}",
                y, mo, d, h, mi, s
            ),
        })?;

    let utc_dt = if timezone.is_null() {
        Utc.from_utc_datetime(&naive_dt)
    } else {
        let tz_str = timezone.as_str("make_datetime")?;
        let tz = parse_tz(tz_str)?;
        let local_dt =
            tz.from_local_datetime(&naive_dt)
                .single()
                .ok_or_else(|| OpError::InvalidArgument {
                    operation: "make_datetime".to_string(),
                    reason: "ambiguous or invalid local time in specified timezone".to_string(),
                })?;
        local_dt.with_timezone(&Utc)
    };

    Ok(OpValue::string(to_rfc3339(utc_dt)))
}

/// Format only the time part of a datetime.
///
/// - datetime: RFC 3339 string
/// - format: chrono format string
/// - timezone: Optional IANA timezone
///
/// Null propagation: `format_time(null, _) = null`
pub fn format_time(
    datetime: &OpValue,
    format: &OpValue,
    timezone: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    if datetime.is_null() || format.is_null() {
        return Ok(OpValue::null());
    }

    let dt_str = datetime.as_str("format_time")?;
    let format_str = format.as_str("format_time")?;

    let utc = parse_rfc3339_to_utc(dt_str)?;

    let time_to_format = if timezone.is_null() {
        utc.time()
    } else {
        let tz_str = timezone.as_str("format_time")?;
        let tz = parse_tz(tz_str)?;
        utc_to_tz(utc, tz).time()
    };

    let formatted = time_to_format.format(format_str).to_string();
    Ok(OpValue::string(formatted))
}

/// Get the day of the week for a date/datetime.
///
/// Returns 1=Sunday, 2=Monday, ..., 7=Saturday (spreadsheet standard).
///
/// Null propagation: `weekday(null) = null`
pub fn weekday(
    datetime: &OpValue,
    timezone: &OpValue,
    _ctx: &EvalContext,
) -> Result<OpValue, OpError> {
    if datetime.is_null() {
        return Ok(OpValue::null());
    }

    let dt_str = datetime.as_str("weekday")?;

    let wd = if is_date_only(dt_str) {
        // Date format YYYY-MM-DD
        parse_naive_date(dt_str)?.weekday()
    } else {
        // RFC3339 datetime format - handle timezone if provided
        let utc = parse_rfc3339_to_utc(dt_str)?;
        if !timezone.is_null() {
            let tz_str = timezone.as_str("weekday")?;
            let tz = parse_tz(tz_str)?;
            utc_to_tz(utc, tz).weekday()
        } else {
            utc.weekday()
        }
    };

    // Convert chrono weekday to spreadsheet standard (1=Sunday, 7=Saturday)
    let weekday_num = match wd {
        chrono::Weekday::Sun => 1,
        chrono::Weekday::Mon => 2,
        chrono::Weekday::Tue => 3,
        chrono::Weekday::Wed => 4,
        chrono::Weekday::Thu => 5,
        chrono::Weekday::Fri => 6,
        chrono::Weekday::Sat => 7,
    };

    Ok(OpValue::number(weekday_num as f64))
}

/// Get the user's timezone from context.
///
/// Note: In production, this should receive the user's timezone from the evaluation context.
/// For now, returns a default value.
pub fn user_tz(_ctx: &EvalContext) -> Result<OpValue, OpError> {
    // In production, this would come from the EvalContext
    // For now, return UTC as default
    Ok(OpValue::string("UTC".to_string()))
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Calculate days in a given month, accounting for leap years.
fn days_in_month(year: i32, month: u32) -> u32 {
    let next_month = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let first = NaiveDate::from_ymd_opt(next_month.0, next_month.1, 1).unwrap();
    let prev_last = first - Duration::try_days(1).unwrap();
    prev_last.day()
}

/// Parse timezone string with proper error handling.
fn parse_tz(s: &str) -> Result<Tz, OpError> {
    Tz::from_str(s).map_err(|_| OpError::InvalidArgument {
        operation: "parse_tz".to_string(),
        reason: format!("unknown or unsupported timezone: {}", s),
    })
}

/// Parse RFC 3339 datetime string to UTC.
fn parse_rfc3339_to_utc(s: &str) -> Result<DateTime<Utc>, OpError> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|_| OpError::InvalidArgument {
            operation: "parse_datetime".to_string(),
            reason: format!("invalid RFC 3339 datetime: {}", s),
        })
}

/// Parse date string in YYYY-MM-DD format.
fn parse_naive_date(s: &str) -> Result<NaiveDate, OpError> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| OpError::InvalidArgument {
        operation: "parse_date".to_string(),
        reason: format!("invalid date (expected YYYY-MM-DD): {}", s),
    })
}

/// Check if a string looks like a date-only format (YYYY-MM-DD).
fn is_date_only(s: &str) -> bool {
    s.len() == 10 && s.chars().nth(4) == Some('-') && s.chars().nth(7) == Some('-')
}

/// Format datetime to RFC 3339 string.
fn to_rfc3339<T: TimeZone>(dt: DateTime<T>) -> String
where
    T::Offset: std::fmt::Display,
{
    dt.to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true)
}

/// Convert UTC datetime to specified timezone.
fn utc_to_tz(utc: DateTime<Utc>, tz: Tz) -> DateTime<Tz> {
    tz.from_utc_datetime(&utc.naive_utc())
}

/// Parse time unit with validation.
fn parse_unit(s: &str) -> Result<&'static str, OpError> {
    match s.to_ascii_lowercase().as_str() {
        "millisecond" | "milliseconds" | "ms" => Ok("ms"),
        "second" | "seconds" | "s" => Ok("s"),
        "minute" | "minutes" | "m" => Ok("m"),
        "hour" | "hours" | "h" => Ok("h"),
        "day" | "days" | "d" => Ok("d"),
        "week" | "weeks" | "w" => Ok("w"),
        "month" | "months" => Ok("mo"),
        "year" | "years" => Ok("y"),
        other => Err(OpError::InvalidArgument {
            operation: "parse_unit".to_string(),
            reason: format!("unsupported time unit: {}", other),
        }),
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx() -> EvalContext {
        EvalContext::strict()
    }

    // --- date_add tests ---

    #[test]
    fn test_date_add_days() {
        let dt = OpValue::from(json!("2024-01-15T00:00:00Z"));
        let amount = OpValue::from(json!(5));
        let unit = OpValue::from(json!("days"));
        let result = date_add(&dt, &amount, &unit, &ctx()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "2024-01-20T00:00:00Z");
    }

    #[test]
    fn test_date_add_months() {
        let dt = OpValue::from(json!("2024-01-15T00:00:00Z"));
        let amount = OpValue::from(json!(2));
        let unit = OpValue::from(json!("months"));
        let result = date_add(&dt, &amount, &unit, &ctx()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "2024-03-15T00:00:00Z");
    }

    #[test]
    fn test_date_add_negative() {
        let dt = OpValue::from(json!("2024-01-15T00:00:00Z"));
        let amount = OpValue::from(json!(-10));
        let unit = OpValue::from(json!("days"));
        let result = date_add(&dt, &amount, &unit, &ctx()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "2024-01-05T00:00:00Z");
    }

    #[test]
    fn test_date_add_null() {
        let dt = OpValue::null();
        let amount = OpValue::from(json!(5));
        let unit = OpValue::from(json!("days"));
        let result = date_add(&dt, &amount, &unit, &ctx()).unwrap();
        assert!(result.is_null());
    }

    // --- date_diff tests ---

    #[test]
    fn test_date_diff_days() {
        let start = OpValue::from(json!("2024-01-15T00:00:00Z"));
        let end = OpValue::from(json!("2024-01-20T00:00:00Z"));
        let unit = OpValue::from(json!("days"));
        let result = date_diff(&start, &end, &unit, &ctx()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 5.0);
    }

    #[test]
    fn test_date_diff_hours() {
        let start = OpValue::from(json!("2024-01-15T00:00:00Z"));
        let end = OpValue::from(json!("2024-01-15T12:00:00Z"));
        let unit = OpValue::from(json!("hours"));
        let result = date_diff(&start, &end, &unit, &ctx()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 12.0);
    }

    #[test]
    fn test_date_diff_null() {
        let start = OpValue::null();
        let end = OpValue::from(json!("2024-01-20T00:00:00Z"));
        let unit = OpValue::from(json!("days"));
        let result = date_diff(&start, &end, &unit, &ctx()).unwrap();
        assert!(result.is_null());
    }

    // --- format_date tests ---

    #[test]
    fn test_format_date() {
        let dt = OpValue::from(json!("2024-01-15T10:30:00Z"));
        let format = OpValue::from(json!("%Y-%m-%d"));
        let result = format_date(&dt, &format, &ctx()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "2024-01-15");
    }

    #[test]
    fn test_format_date_time_only() {
        let dt = OpValue::from(json!("2024-01-15T10:30:45Z"));
        let format = OpValue::from(json!("%H:%M:%S"));
        let result = format_date(&dt, &format, &ctx()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "10:30:45");
    }

    #[test]
    fn test_format_date_null() {
        let dt = OpValue::null();
        let format = OpValue::from(json!("%Y-%m-%d"));
        let result = format_date(&dt, &format, &ctx()).unwrap();
        assert!(result.is_null());
    }

    // --- Component extraction tests ---

    #[test]
    fn test_extract_year() {
        let dt = OpValue::from(json!("2024-01-15T10:30:00Z"));
        let unit = OpValue::string("year");
        let result = extract(&dt, &unit, &ctx()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 2024.0);
    }

    #[test]
    fn test_extract_month() {
        let dt = OpValue::from(json!("2024-03-15T10:30:00Z"));
        let unit = OpValue::string("month");
        let result = extract(&dt, &unit, &ctx()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 3.0);
    }

    #[test]
    fn test_extract_day() {
        let dt = OpValue::from(json!("2024-01-25T10:30:00Z"));
        let unit = OpValue::string("day");
        let result = extract(&dt, &unit, &ctx()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 25.0);
    }

    #[test]
    fn test_extract_hour() {
        let dt = OpValue::from(json!("2024-01-15T14:30:00Z"));
        let unit = OpValue::string("hour");
        let result = extract(&dt, &unit, &ctx()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 14.0);
    }

    #[test]
    fn test_extract_minute() {
        let dt = OpValue::from(json!("2024-01-15T10:45:00Z"));
        let unit = OpValue::string("minute");
        let result = extract(&dt, &unit, &ctx()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 45.0);
    }

    #[test]
    fn test_extract_second() {
        let dt = OpValue::from(json!("2024-01-15T10:30:59Z"));
        let unit = OpValue::string("second");
        let result = extract(&dt, &unit, &ctx()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 59.0);
    }

    // --- Date-only parsing ---

    #[test]
    fn test_extract_year_date_only() {
        let dt = OpValue::from(json!("2024-07-20"));
        let unit = OpValue::string("year");
        let result = extract(&dt, &unit, &ctx()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 2024.0);
    }

    #[test]
    fn test_extract_month_date_only() {
        let dt = OpValue::from(json!("2024-07-20"));
        let unit = OpValue::string("month");
        let result = extract(&dt, &unit, &ctx()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 7.0);
    }

    // --- Timestamp tests ---

    #[test]
    fn test_timestamp() {
        let dt = OpValue::from(json!("1970-01-01T00:00:01Z"));
        let result = timestamp(&dt, &ctx()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 1000.0); // 1 second = 1000 ms
    }

    #[test]
    fn test_from_timestamp() {
        let ms = OpValue::from(json!(0));
        let result = from_timestamp(&ms, &ctx()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "1970-01-01T00:00:00Z");
    }

    // --- Construction tests ---

    #[test]
    fn test_make_date() {
        let y = OpValue::from(json!(2024));
        let m = OpValue::from(json!(7));
        let d = OpValue::from(json!(15));
        let result = make_date(&y, &m, &d, &ctx()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "2024-07-15");
    }

    #[test]
    fn test_make_date_invalid() {
        let y = OpValue::from(json!(2024));
        let m = OpValue::from(json!(13)); // Invalid month
        let d = OpValue::from(json!(15));
        let result = make_date(&y, &m, &d, &ctx());
        assert!(matches!(result, Err(OpError::InvalidArgument { .. })));
    }

    #[test]
    fn test_make_time() {
        let h = OpValue::from(json!(10));
        let m = OpValue::from(json!(30));
        let s = OpValue::from(json!(45));
        let result = make_time(&h, &m, &s, &ctx()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "10:30:45");
    }

    #[test]
    fn test_make_time_invalid() {
        let h = OpValue::from(json!(25)); // Invalid hour
        let m = OpValue::from(json!(30));
        let s = OpValue::from(json!(45));
        let result = make_time(&h, &m, &s, &ctx());
        assert!(matches!(result, Err(OpError::InvalidArgument { .. })));
    }

    // --- convert_tz tests ---

    #[test]
    fn test_convert_tz() {
        // Convert from UTC to America/New_York (EST = UTC-5)
        let dt = OpValue::from(json!("2024-01-15T12:00:00Z"));
        let from_tz = OpValue::from(json!("UTC"));
        let to_tz = OpValue::from(json!("America/New_York"));
        let result = convert_tz(&dt, &from_tz, &to_tz, &ctx()).unwrap();
        // In January, NY is EST (UTC-5), so 12:00 UTC = 07:00 EST
        let result_str = result.as_str("test").unwrap();
        assert!(result_str.contains("07:00:00"));
    }

    #[test]
    fn test_convert_tz_null() {
        let dt = OpValue::null();
        let from_tz = OpValue::from(json!("UTC"));
        let to_tz = OpValue::from(json!("America/New_York"));
        let result = convert_tz(&dt, &from_tz, &to_tz, &ctx()).unwrap();
        assert!(result.is_null());
    }

    // --- workdays tests ---

    #[test]
    fn test_workdays_basic() {
        // Monday Jan 15 to Friday Jan 19, 2024 = 5 workdays
        let start = OpValue::from(json!("2024-01-15"));
        let end = OpValue::from(json!("2024-01-19"));
        let holidays = OpValue::null();
        let result = workdays(&start, &end, &holidays, &ctx()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 5.0);
    }

    #[test]
    fn test_workdays_with_weekend() {
        // Monday Jan 15 to Monday Jan 22, 2024 = 6 workdays (skip Sat/Sun)
        let start = OpValue::from(json!("2024-01-15"));
        let end = OpValue::from(json!("2024-01-22"));
        let holidays = OpValue::null();
        let result = workdays(&start, &end, &holidays, &ctx()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 6.0);
    }

    #[test]
    fn test_workdays_with_holidays() {
        // Monday Jan 15 to Friday Jan 19, 2024, with Wed as holiday = 4 workdays
        let start = OpValue::from(json!("2024-01-15"));
        let end = OpValue::from(json!("2024-01-19"));
        let holidays = OpValue::from(json!(["2024-01-17"]));
        let result = workdays(&start, &end, &holidays, &ctx()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 4.0);
    }

    #[test]
    fn test_workdays_null() {
        let start = OpValue::null();
        let end = OpValue::from(json!("2024-01-19"));
        let holidays = OpValue::null();
        let result = workdays(&start, &end, &holidays, &ctx()).unwrap();
        assert!(result.is_null());
    }

    // --- start_of tests ---

    #[test]
    fn test_start_of_day() {
        let dt = OpValue::from(json!("2024-01-15T14:30:45Z"));
        let unit = OpValue::from(json!("day"));
        let tz = OpValue::null();
        let result = start_of(&dt, &unit, &tz, &ctx()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "2024-01-15T00:00:00Z");
    }

    #[test]
    fn test_start_of_month() {
        let dt = OpValue::from(json!("2024-01-15T14:30:45Z"));
        let unit = OpValue::from(json!("month"));
        let tz = OpValue::null();
        let result = start_of(&dt, &unit, &tz, &ctx()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "2024-01-01T00:00:00Z");
    }

    #[test]
    fn test_start_of_year() {
        let dt = OpValue::from(json!("2024-06-15T14:30:45Z"));
        let unit = OpValue::from(json!("year"));
        let tz = OpValue::null();
        let result = start_of(&dt, &unit, &tz, &ctx()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "2024-01-01T00:00:00Z");
    }

    #[test]
    fn test_start_of_null() {
        let dt = OpValue::null();
        let unit = OpValue::from(json!("day"));
        let tz = OpValue::null();
        let result = start_of(&dt, &unit, &tz, &ctx()).unwrap();
        assert!(result.is_null());
    }

    // --- end_of tests ---

    #[test]
    fn test_end_of_day() {
        let dt = OpValue::from(json!("2024-01-15T14:30:45Z"));
        let unit = OpValue::from(json!("day"));
        let tz = OpValue::null();
        let result = end_of(&dt, &unit, &tz, &ctx()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "2024-01-15T23:59:59Z");
    }

    #[test]
    fn test_end_of_month() {
        let dt = OpValue::from(json!("2024-01-15T14:30:45Z"));
        let unit = OpValue::from(json!("month"));
        let tz = OpValue::null();
        let result = end_of(&dt, &unit, &tz, &ctx()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "2024-01-31T23:59:59Z");
    }

    #[test]
    fn test_end_of_month_february_leap() {
        let dt = OpValue::from(json!("2024-02-15T14:30:45Z")); // 2024 is a leap year
        let unit = OpValue::from(json!("month"));
        let tz = OpValue::null();
        let result = end_of(&dt, &unit, &tz, &ctx()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "2024-02-29T23:59:59Z");
    }

    #[test]
    fn test_end_of_year() {
        let dt = OpValue::from(json!("2024-06-15T14:30:45Z"));
        let unit = OpValue::from(json!("year"));
        let tz = OpValue::null();
        let result = end_of(&dt, &unit, &tz, &ctx()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "2024-12-31T23:59:59Z");
    }

    #[test]
    fn test_start_and_end_of_day_read_the_zone_wall_clock() {
        let dt = OpValue::from(json!("2024-01-16T02:30:00Z")); // 9:30 PM on Jan 15 in New York
        let unit = OpValue::from(json!("day"));
        let tz = OpValue::from(json!("America/New_York"));
        let start = start_of(&dt, &unit, &tz, &ctx()).unwrap();
        assert_eq!(start.as_str("test").unwrap(), "2024-01-15T00:00:00-05:00");
        let end = end_of(&dt, &unit, &tz, &ctx()).unwrap();
        assert_eq!(end.as_str("test").unwrap(), "2024-01-15T23:59:59-05:00");
        let week = start_of(&dt, &OpValue::from(json!("week")), &tz, &ctx()).unwrap();
        assert_eq!(week.as_str("test").unwrap(), "2024-01-15T00:00:00-05:00");
    }

    #[test]
    fn test_start_of_day_when_the_zone_skips_midnight() {
        // Havana moved its clocks from 00:00 to 01:00 on 2024-03-10, so that day starts at 01:00.
        let dt = OpValue::from(json!("2024-03-10T15:00:00Z"));
        let tz = OpValue::from(json!("America/Havana"));
        let start = start_of(&dt, &OpValue::from(json!("day")), &tz, &ctx()).unwrap();
        assert_eq!(start.as_str("test").unwrap(), "2024-03-10T01:00:00-04:00");
        let end = end_of(&OpValue::from(json!("2024-03-09T15:00:00Z")), &OpValue::from(json!("day")), &tz, &ctx()).unwrap();
        assert_eq!(end.as_str("test").unwrap(), "2024-03-09T23:59:59-05:00");
    }

    // --- make_datetime tests ---

    #[test]
    fn test_make_datetime() {
        let y = OpValue::from(json!(2024));
        let mo = OpValue::from(json!(7));
        let d = OpValue::from(json!(15));
        let h = OpValue::from(json!(10));
        let mi = OpValue::from(json!(30));
        let s = OpValue::from(json!(45));
        let tz = OpValue::null();
        let result = make_datetime(&y, &mo, &d, &h, &mi, &s, &tz, &ctx()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "2024-07-15T10:30:45Z");
    }

    #[test]
    fn test_make_datetime_invalid() {
        let y = OpValue::from(json!(2024));
        let mo = OpValue::from(json!(13)); // Invalid month
        let d = OpValue::from(json!(15));
        let h = OpValue::from(json!(10));
        let mi = OpValue::from(json!(30));
        let s = OpValue::from(json!(45));
        let tz = OpValue::null();
        let result = make_datetime(&y, &mo, &d, &h, &mi, &s, &tz, &ctx());
        assert!(matches!(result, Err(OpError::InvalidArgument { .. })));
    }

    #[test]
    fn test_make_datetime_null() {
        let y = OpValue::null();
        let mo = OpValue::from(json!(7));
        let d = OpValue::from(json!(15));
        let h = OpValue::from(json!(10));
        let mi = OpValue::from(json!(30));
        let s = OpValue::from(json!(45));
        let tz = OpValue::null();
        let result = make_datetime(&y, &mo, &d, &h, &mi, &s, &tz, &ctx()).unwrap();
        assert!(result.is_null());
    }

    // --- format_time tests ---

    #[test]
    fn test_format_time() {
        let dt = OpValue::from(json!("2024-01-15T10:30:45Z"));
        let format = OpValue::from(json!("%H:%M"));
        let tz = OpValue::null();
        let result = format_time(&dt, &format, &tz, &ctx()).unwrap();
        assert_eq!(result.as_str("test").unwrap(), "10:30");
    }

    #[test]
    fn test_format_time_null() {
        let dt = OpValue::null();
        let format = OpValue::from(json!("%H:%M"));
        let tz = OpValue::null();
        let result = format_time(&dt, &format, &tz, &ctx()).unwrap();
        assert!(result.is_null());
    }

    // --- weekday tests ---

    #[test]
    fn test_weekday_monday() {
        // 2024-01-15 is a Monday
        let dt = OpValue::from(json!("2024-01-15"));
        let tz = OpValue::null();
        let result = weekday(&dt, &tz, &ctx()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 2.0); // 1=Sunday, 2=Monday
    }

    #[test]
    fn test_weekday_sunday() {
        // 2024-01-14 is a Sunday
        let dt = OpValue::from(json!("2024-01-14"));
        let tz = OpValue::null();
        let result = weekday(&dt, &tz, &ctx()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 1.0); // 1=Sunday
    }

    #[test]
    fn test_weekday_saturday() {
        // 2024-01-20 is a Saturday
        let dt = OpValue::from(json!("2024-01-20"));
        let tz = OpValue::null();
        let result = weekday(&dt, &tz, &ctx()).unwrap();
        assert_eq!(result.as_f64("test").unwrap(), 7.0); // 7=Saturday
    }

    #[test]
    fn test_weekday_null() {
        let dt = OpValue::null();
        let tz = OpValue::null();
        let result = weekday(&dt, &tz, &ctx()).unwrap();
        assert!(result.is_null());
    }

    // --- user_tz tests ---

    #[test]
    fn test_user_tz() {
        let result = user_tz(&ctx()).unwrap();
        // Default is UTC
        assert_eq!(result.as_str("test").unwrap(), "UTC");
    }
}
