//! crates/timed-action/src/date.rs
//!
//! Purpose
//!   The JavaScript Date rules the timed-action rules use, with no host clock and no host zone: a time is milliseconds
//!   since 1970 in UTC (an f64, integral once clipped), civil fields are proleptic Gregorian, Date.parse reads ISO-form
//!   text the way the TypeScript's runtime reads it, and toISOString writes it.
//!
//! Non-negotiable invariants
//!   - time_clip is the ECMAScript TimeClip: a time beyond 8.64e15 ms, or not finite, is NaN, and a fraction is dropped.
//!   - parse reads ECMAScript date-time text and the leniencies V8 shows (a day up to 31 rolls over, 24:00 is the next
//!     midnight, a space may stand for T, a lower-case z is UTC, fraction digits beyond three are dropped, an offset may
//!     omit its colon).
//!     Date-time text with no offset is UTC here. The TypeScript reads it in the host's zone; that is the reason zones
//!     are never host data in this engine.
//!   - Any other text is NaN, the value Date.parse gives for text it does not read.

use crate::js::{Refused, Res};

pub const DAY_MS: f64 = 86_400_000.0;
const MS_PER_HOUR: f64 = 3_600_000.0;
const MS_PER_MINUTE: f64 = 60_000.0;
const MAX_TIME: f64 = 8.64e15;

/// The ECMAScript TimeClip: NaN outside the range of a Date, otherwise the time with its fraction dropped.
pub fn time_clip(t: f64) -> f64 {
    if !t.is_finite() || t.abs() > MAX_TIME {
        return f64::NAN;
    }
    let whole = t.trunc();
    if whole == 0.0 {
        0.0
    } else {
        whole
    }
}

pub fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

pub fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 => {
            if is_leap_year(year) {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (month 1 to 12; a day past the month's end rolls over).
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The proleptic Gregorian (year, month 1 to 12, day) of a day count since 1970-01-01.
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `Date.UTC(year, month - 1, day, hour, minute, second, ms)` with month 1 to 12 (a day or hour past its end rolls over).
pub fn utc(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64, ms: i64) -> f64 {
    let days = days_from_civil(year, month, 1) + day - 1;
    (days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000 + ms) as f64
}

/// The UTC fields of a clipped time: year, month (1 to 12), day, hour, minute, second, millisecond.
pub struct Fields {
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
    pub millisecond: i64,
}

/// The UTC fields of a time already clipped to a whole number of milliseconds.
pub fn utc_fields(clipped: f64) -> Fields {
    let t = clipped as i64;
    let days = t.div_euclid(86_400_000);
    let rem = t.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    Fields {
        year,
        month,
        day,
        hour: rem / 3_600_000,
        minute: rem / 60_000 % 60,
        second: rem / 1000 % 60,
        millisecond: rem % 1000,
    }
}

/// `new Date(ms).toISOString()`; a time outside the range of a Date is a RangeError.
pub fn to_iso(ms: f64) -> Res<String> {
    let clipped = time_clip(ms);
    if clipped.is_nan() {
        return Err(Refused::range_error("Invalid time value"));
    }
    let f = utc_fields(clipped);
    let year = if (0..=9999).contains(&f.year) {
        format!("{:04}", f.year)
    } else if f.year < 0 {
        format!("-{:06}", -f.year)
    } else {
        format!("+{:06}", f.year)
    };
    Ok(format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        f.month, f.day, f.hour, f.minute, f.second, f.millisecond
    ))
}

/// `formatUtcDate(ms)`: the UTC calendar date of a time as YYYY-MM-DD; "NaN-NaN-NaN" for a time that is not one.
pub fn format_utc_date(ms: f64) -> String {
    let clipped = time_clip(ms);
    if clipped.is_nan() {
        return "NaN-NaN-NaN".to_string();
    }
    let f = utc_fields(clipped);
    format!("{}-{:02}-{:02}", f.year, f.month, f.day)
}

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn eat(&mut self, want: u8) -> bool {
        if self.peek() == Some(want) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    /// Exactly `count` decimal digits.
    fn digits(&mut self, count: usize) -> Option<i64> {
        let slice = self.bytes.get(self.at..self.at + count)?;
        if !slice.iter().all(u8::is_ascii_digit) {
            return None;
        }
        self.at += count;
        Some(slice.iter().fold(0_i64, |value, digit| value * 10 + i64::from(digit - b'0')))
    }

    fn at_end(&self) -> bool {
        self.at == self.bytes.len()
    }
}

/// `Date.parse(text)`: the time (ms) of ISO-form date-time text, or NaN for text this reader does not read.
pub fn parse(text: &str) -> f64 {
    parse_iso(text).unwrap_or(f64::NAN)
}

fn parse_iso(text: &str) -> Option<f64> {
    let mut cursor = Cursor { bytes: text.as_bytes(), at: 0 };
    let year = match cursor.peek()? {
        sign @ (b'+' | b'-') => {
            cursor.at += 1;
            let magnitude = cursor.digits(6)?;
            if sign == b'-' && magnitude == 0 {
                return None;
            }
            if sign == b'-' {
                -magnitude
            } else {
                magnitude
            }
        }
        _ => cursor.digits(4)?,
    };
    let mut month = 1;
    let mut day = 1;
    if cursor.eat(b'-') {
        month = cursor.digits(2)?;
        if cursor.eat(b'-') {
            day = cursor.digits(2)?;
        }
    }
    let (mut hour, mut minute, mut second, mut millisecond, mut offset_minutes) = (0, 0, 0, 0, 0);
    if !cursor.at_end() {
        if !(cursor.eat(b'T') || cursor.eat(b' ')) {
            return None;
        }
        hour = cursor.digits(2)?;
        if !cursor.eat(b':') {
            return None;
        }
        minute = cursor.digits(2)?;
        if cursor.eat(b':') {
            second = cursor.digits(2)?;
            if cursor.eat(b'.') {
                let start = cursor.at;
                while cursor.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                    cursor.at += 1;
                }
                let fraction = &cursor.bytes[start..cursor.at];
                if fraction.is_empty() {
                    return None;
                }
                let kept: String = fraction.iter().take(3).map(|byte| *byte as char).collect();
                millisecond = format!("{kept:0<3}").parse::<i64>().ok()?;
            }
        }
        if cursor.eat(b'Z') || cursor.eat(b'z') {
            offset_minutes = 0;
        } else if let Some(sign) = cursor.peek().filter(|byte| matches!(byte, b'+' | b'-')) {
            cursor.at += 1;
            let hours = cursor.digits(2)?;
            cursor.eat(b':');
            let minutes = cursor.digits(2)?;
            let magnitude = hours * 60 + minutes;
            offset_minutes = if sign == b'-' { -magnitude } else { magnitude };
        }
        if !cursor.at_end() {
            return None;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 24 || minute > 59 || second > 59 {
        return None;
    }
    if hour == 24 && (minute != 0 || second != 0 || millisecond != 0) {
        return None;
    }
    let days = days_from_civil(year, month, 1) + day - 1;
    let ms = days as f64 * DAY_MS
        + hour as f64 * MS_PER_HOUR
        + minute as f64 * MS_PER_MINUTE
        + second as f64 * 1000.0
        + millisecond as f64
        - offset_minutes as f64 * MS_PER_MINUTE;
    Some(time_clip(ms))
}
