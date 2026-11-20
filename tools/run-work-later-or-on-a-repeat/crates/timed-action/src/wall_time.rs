//! crates/timed-action/src/wall_time.rs
//!
//! Purpose
//!   Wall time in a named zone: the one place a local date and clock time ("2026-11-01", "09:00", "America/New_York")
//!   becomes an instant and back, and the one test of whether a zone name is a zone. This is the Rust reading of
//!   tools/wall-time/read-data/wall-time.mjs; the zone rules are jiff's bundled tz database, compiled in.
//!
//! Non-negotiable invariants
//!   - A zone is an IANA name the bundled database knows. Its syntax is the one wall-time.mjs accepts (ZONE_NAME); an
//!     offset ("+05:00"), an unknown abbreviation or an empty value is no zone, never UTC.
//!   - A local time the clocks skip is a gap; one that happens twice is a fold. The gap policy ('skip' | 'next-valid')
//!     and fold policy ('earlier' | 'later' | 'both') decide, exactly as resolveStart does in the TypeScript.
//!   - The offset of an instant is read from the zone at whole seconds and rounded to whole minutes, as the TypeScript
//!     reads it from Intl's formatted parts.
//!   - Pure: no clock is read and nothing is stored; the two caches only remember answers already computed.

use std::cell::RefCell;
use std::collections::HashMap;

use jiff::{tz::TimeZone, Timestamp};
use serde_json::Value;

use crate::date::{self, DAY_MS};
use crate::js::{self, Refused, Res};

/// A civil time: `{ date: 'YYYY-MM-DD', time: 'HH:MM' }`, as the text the TypeScript keeps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Civil {
    pub date: String,
    pub time: String,
}

/// One answer of resolveStart: the requested and resolved civil times, the instant (ms) and the fold it is.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub requested: Civil,
    pub resolved: Civil,
    pub instant_ms: f64,
    pub fold: Value,
}

const MAX_GAP_SEARCH_MINUTES: i64 = 2_160;
const INSTANTS_REMEMBERED: usize = 4_096;

thread_local! {
    static ZONES: RefCell<HashMap<String, Option<TimeZone>>> = RefCell::new(HashMap::new());
    static INSTANTS: RefCell<HashMap<(String, String, String), Vec<f64>>> = RefCell::new(HashMap::new());
}

fn segment_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '+' | '-')
}

/// wall-time.mjs ZONE_NAME: `^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$`, at most 80 characters.
fn zone_syntax(name: &str) -> bool {
    if name.len() > 80 || !name.is_ascii() {
        return false;
    }
    let mut segments = name.split('/');
    let first = segments.next().unwrap_or("");
    first.chars().next().is_some_and(|character| character.is_ascii_alphabetic())
        && first.chars().all(segment_char)
        && segments.all(|segment| !segment.is_empty() && segment.chars().all(segment_char))
}

/// The bundled zone a name names, or None.
fn zone(name: &str) -> Option<TimeZone> {
    if !zone_syntax(name) {
        return None;
    }
    ZONES.with(|cache| {
        cache
            .borrow_mut()
            .entry(name.to_string())
            .or_insert_with(|| TimeZone::get(name).ok())
            .clone()
    })
}

/// The zone a name names, or the RangeError Intl throws for a zone it does not know.
fn zone_or_range_error(name: &str) -> Res<TimeZone> {
    zone(name).ok_or_else(|| Refused::range_error(format!("Invalid time zone specified: {name}")))
}

/// `timeZoneName(value)`: the zone's name as the bundled database spells it, or None when the value is not a zone.
pub fn time_zone_name(value: &Value) -> Option<String> {
    let name = value.as_str()?;
    zone(name)?.iana_name().map(str::to_string)
}

/// Whether a text names a zone (wall-time.mjs timeZoneName(value) !== null).
pub fn is_zone(name: &str) -> bool {
    zone(name).is_some()
}

/// `parseDate(date)`: (year, month, day) of a YYYY-MM-DD text that is a real day, or None.
pub fn parse_date(text: &str) -> Option<(i64, i64, i64)> {
    let bytes = text.as_bytes();
    let digits_end = bytes.iter().position(|byte| !byte.is_ascii_digit()).unwrap_or(bytes.len());
    if digits_end < 4 || bytes.len() != digits_end + 6 {
        return None;
    }
    if bytes[digits_end] != b'-' || bytes[digits_end + 3] != b'-' {
        return None;
    }
    let two = |from: usize| -> Option<i64> {
        let pair = &bytes[from..from + 2];
        if pair.iter().all(u8::is_ascii_digit) {
            Some(i64::from(pair[0] - b'0') * 10 + i64::from(pair[1] - b'0'))
        } else {
            None
        }
    };
    let year: i64 = text[..digits_end].parse().ok()?;
    let month = two(digits_end + 1)?;
    let day = two(digits_end + 4)?;
    // Date.UTC maps years 0 to 99 to 1900 to 1999 and gives no valid date past 275760, so neither reads as a date.
    if !(100..=275_760).contains(&year) || !(1..=12).contains(&month) {
        return None;
    }
    if day < 1 || day > date::days_in_month(year, month) {
        return None;
    }
    // A day whose midnight is past the range of a Date is not a date either (Date.UTC gives NaN for it).
    if date::time_clip(date::utc(year, month, day, 0, 0, 0, 0)).is_nan() {
        return None;
    }
    Some((year, month, day))
}

/// `parseTime(time)`: (hour, minute) of an HH:MM text, or None.
pub fn parse_time(text: &str) -> Option<(i64, i64)> {
    let bytes = text.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return None;
    }
    let two = |from: usize| -> Option<i64> {
        let pair = &bytes[from..from + 2];
        if pair.iter().all(u8::is_ascii_digit) {
            Some(i64::from(pair[0] - b'0') * 10 + i64::from(pair[1] - b'0'))
        } else {
            None
        }
    };
    let hour = two(0)?;
    let minute = two(3)?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some((hour, minute))
}

/// `pad(value)`: two digits for a value under ten, otherwise the value's own text.
pub fn pad(value: i64) -> String {
    if value < 10 {
        format!("0{value}")
    } else {
        value.to_string()
    }
}

/// The calendar and clock fields of an instant in a zone.
#[derive(Debug, Clone, Copy)]
struct Fields {
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
}

/// The UTC offset (seconds) of the zone at a whole-second instant.
fn offset_seconds(zone: &TimeZone, seconds: i64) -> Res<i64> {
    let timestamp = Timestamp::from_second(seconds).map_err(|_| Refused::range_error("Invalid time value"))?;
    Ok(i64::from(zone.to_offset(timestamp).seconds()))
}

/// The local fields of an instant in a zone. The instant is clipped as a Date clips it and read at whole seconds.
fn fields_at(instant_ms: f64, zone: &TimeZone) -> Res<Fields> {
    let clipped = date::time_clip(instant_ms);
    if clipped.is_nan() {
        return Err(Refused::range_error("Invalid time value"));
    }
    let seconds = (clipped as i64).div_euclid(1_000);
    let local = seconds + offset_seconds(zone, seconds)?;
    let days = local.div_euclid(86_400);
    let remainder = local.rem_euclid(86_400);
    let (year, month, day) = date::civil_from_days(days);
    Ok(Fields {
        year,
        month,
        day,
        hour: remainder / 3_600,
        minute: remainder % 3_600 / 60,
        second: remainder % 60,
    })
}

fn civil_of(fields: Fields) -> Civil {
    Civil {
        date: format!("{}-{:02}-{:02}", fields.year, fields.month, fields.day),
        time: format!("{:02}:{:02}", fields.hour, fields.minute),
    }
}

/// `localParts(instantMs, timezone)`: the local date and time of an instant in a zone.
pub fn local_parts(instant_ms: f64, timezone: &str) -> Res<Civil> {
    let zone = zone_or_range_error(timezone)?;
    Ok(civil_of(fields_at(instant_ms, &zone)?))
}

/// `partsAt(instantMs, timezone)`: the parts Intl formats for an instant, keyed as the TypeScript keys them. Its
/// `literal` is the last literal part of the en-US pattern, the colon between minute and second.
pub fn parts_at(instant_ms: f64, timezone: &str) -> Res<Value> {
    let zone = zone_or_range_error(timezone)?;
    let f = fields_at(instant_ms, &zone)?;
    Ok(js::object(vec![
        ("month", Value::from(format!("{:02}", f.month))),
        ("literal", Value::from(":")),
        ("day", Value::from(format!("{:02}", f.day))),
        ("year", Value::from(f.year.to_string())),
        ("hour", Value::from(format!("{:02}", f.hour))),
        ("minute", Value::from(format!("{:02}", f.minute))),
        ("second", Value::from(format!("{:02}", f.second))),
    ]))
}

fn offset_minutes_of(zone: &TimeZone, instant_ms: f64) -> Res<f64> {
    let f = fields_at(instant_ms, zone)?;
    let as_utc = date::utc(f.year, f.month, f.day, f.hour, f.minute, f.second, 0);
    Ok(js::round((as_utc - instant_ms) / 60_000.0))
}

/// `timezoneOffsetMinutesAt(instantMs, timezone)`.
pub fn timezone_offset_minutes_at(instant_ms: f64, timezone: &str) -> Res<f64> {
    let zone = zone_or_range_error(timezone)?;
    offset_minutes_of(&zone, instant_ms)
}

/// `possibleInstants(civil, timezone)`: every instant (ms, ascending) at which the zone's clock reads the civil time.
pub fn possible_instants(civil: &Civil, timezone: &str) -> Res<Vec<f64>> {
    let (year, month, day) = parse_date(&civil.date)
        .ok_or_else(|| Refused::type_error("Cannot read properties of null (reading 'year')"))?;
    let (hour, minute) = parse_time(&civil.time)
        .ok_or_else(|| Refused::type_error("Cannot read properties of null (reading 'hour')"))?;
    let key = (timezone.to_string(), civil.date.clone(), civil.time.clone());
    if let Some(known) = INSTANTS.with(|cache| cache.borrow().get(&key).cloned()) {
        return Ok(known);
    }
    let zone = zone_or_range_error(timezone)?;
    let guess = date::utc(year, month, day, hour, minute, 0, 0);
    // Sample offsets across 72 hours around the guess, then keep each instant whose own clock reads the civil time.
    let mut offsets: Vec<f64> = Vec::new();
    for step in -36..=36 {
        let offset = offset_minutes_of(&zone, guess + f64::from(step) * 3_600_000.0)?;
        if !offsets.contains(&offset) {
            offsets.push(offset);
        }
    }
    let mut instants: Vec<f64> = Vec::new();
    for offset in offsets {
        let instant = guess - offset * 60_000.0;
        let local = civil_of(fields_at(instant, &zone)?);
        if local.date == civil.date && local.time == civil.time && !instants.contains(&instant) {
            instants.push(instant);
        }
    }
    instants.sort_by(f64::total_cmp);
    INSTANTS.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() >= INSTANTS_REMEMBERED {
            cache.clear();
        }
        cache.insert(key, instants.clone());
    });
    Ok(instants)
}

/// `addCivilMinutes(start, minutes)`.
pub fn add_civil_minutes(start: &Civil, minutes: f64) -> Res<Civil> {
    let (year, month, day) = parse_date(&start.date)
        .ok_or_else(|| Refused::type_error("Cannot read properties of null (reading 'year')"))?;
    let (hour, minute) = parse_time(&start.time)
        .ok_or_else(|| Refused::type_error("Cannot read properties of null (reading 'hour')"))?;
    let value = date::time_clip(date::utc(year, month, day, hour, minute, 0, 0) + minutes * 60_000.0);
    // A time past the range of a Date reads as NaN in the TypeScript (the text of toISOString is not written here).
    if value.is_nan() {
        return Ok(Civil { date: "NaN-NaN-NaN".to_string(), time: "NaN:NaN".to_string() });
    }
    let f = date::utc_fields(value);
    Ok(Civil {
        date: date::format_utc_date(value),
        time: format!("{:02}:{:02}", f.hour, f.minute),
    })
}

/// `addCivilDays(date, days)`.
pub fn add_civil_days(text: &str, days: f64) -> Res<String> {
    let (year, month, day) = parse_date(text)
        .ok_or_else(|| Refused::type_error("Cannot read properties of null (reading 'year')"))?;
    Ok(date::format_utc_date(date::utc(year, month, day, 0, 0, 0, 0) + days * DAY_MS))
}

/// `addCivilMonths(date, months)`: the same day that many months on; a day the month lacks is its last.
pub fn add_civil_months(text: &str, months: f64) -> Res<String> {
    let (year, month, day) = parse_date(text)
        .ok_or_else(|| Refused::type_error("Cannot read properties of null (reading 'year')"))?;
    let index = year * 12 + (month - 1) + months as i64;
    let next_year = index.div_euclid(12);
    let next_month = index.rem_euclid(12) + 1;
    // Date.UTC maps a year 0 to 99 to 1900 to 1999 when it finds the last day of the month; past the range of a Date
    // there is no last day, and the day reads as NaN.
    let last_day_year = if (0..=99).contains(&next_year) { next_year + 1900 } else { next_year };
    let last_day = date::utc(last_day_year, next_month, date::days_in_month(last_day_year, next_month), 0, 0, 0, 0);
    let day_text = if date::time_clip(last_day).is_nan() { "NaN".to_string() } else { pad(day.min(date::days_in_month(last_day_year, next_month))) };
    Ok(format!("{}-{}-{}", next_year, pad(next_month), day_text))
}

/// `weekday(date)`: 0 (Sunday) to 6 (Saturday).
pub fn weekday(text: &str) -> Res<i64> {
    let (year, month, day) = parse_date(text)
        .ok_or_else(|| Refused::type_error("Cannot read properties of null (reading 'year')"))?;
    Ok((date::days_from_civil(year, month, day) + 4).rem_euclid(7))
}

/// `resolveStart(requested, timezone, gap, fold)`: the instants a requested civil time is, under the gap and fold
/// policies. Empty when the time is in a gap and the policy skips it.
pub fn resolve_start(requested: &Civil, timezone: &str, gap: &Value, fold: &Value) -> Res<Vec<Resolved>> {
    let mut candidates = possible_instants(requested, timezone)?;
    let mut resolved = requested.clone();
    if candidates.is_empty() && gap.as_str() == Some("next-valid") {
        for minute in 1..=MAX_GAP_SEARCH_MINUTES {
            let probe = add_civil_minutes(requested, minute as f64)?;
            candidates = possible_instants(&probe, timezone)?;
            if !candidates.is_empty() {
                resolved = probe;
                break;
            }
        }
    }
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let entry = |instant_ms: f64, fold: Value| Resolved {
        requested: requested.clone(),
        resolved: resolved.clone(),
        instant_ms,
        fold,
    };
    if candidates.len() == 1 {
        return Ok(vec![entry(candidates[0], Value::from("unique"))]);
    }
    if fold.as_str() == Some("both") {
        return Ok(vec![
            entry(candidates[0], Value::from("earlier")),
            entry(candidates[candidates.len() - 1], Value::from("later")),
        ]);
    }
    let instant_ms = if fold.as_str() == Some("later") {
        candidates[candidates.len() - 1]
    } else {
        candidates[0]
    };
    Ok(vec![entry(instant_ms, fold.clone())])
}

/// `instantAt(date, time, zone, { gap, fold })`: the instant of a local date and time, or None for text that is not a
/// date, a time or a zone, or for a time the gap policy skips.
pub fn instant_at(text_date: &str, text_time: &str, zone_name: &str, gap: &Value, fold: &Value) -> Res<Option<f64>> {
    if parse_date(text_date).is_none() || parse_time(text_time).is_none() || !is_zone(zone_name) {
        return Ok(None);
    }
    let civil = Civil { date: text_date.to_string(), time: text_time.to_string() };
    Ok(resolve_start(&civil, zone_name, gap, fold)?.first().map(|start| start.instant_ms))
}
