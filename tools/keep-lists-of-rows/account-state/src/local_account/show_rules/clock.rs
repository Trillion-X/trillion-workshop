//! GET clock adapter for `workspace_show_rules::ClockOwner`.
//!
//! Source contract: `src/show-rules-store.mjs` in the old Trillion repo,
//! `current` at line 270 filters with `!rule.until || Date.parse(rule.until) > at`.
//! The trait separately documents `show-rules.mjs::timeOf` for `time_of`.
//!
//! This adapter qualifies `Date.parse` only for explicit RFC3339 timestamps and
//! ISO calendar dates (UTC midnight). Other JavaScript Date.parse coercions and
//! legacy date spellings are unsupported and return `Error::Invalid`; they are
//! not silently interpreted using host locale. `facts`, `next_turn` and
//! `rule_turn` are outside GET expiry filtering and remain unavailable here.

use crate::{
    ecma_json::Value,
    workspace_show_rules::{ClockFacts, ClockOwner, Error, Result},
};
use std::time::{SystemTime, UNIX_EPOCH};

/// System wall clock plus the explicitly qualified expiry parser used by GET.
#[derive(Default)]
pub struct GetClock;

impl ClockOwner for GetClock {
    fn now_ms(&mut self) -> Result<i64> {
        i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?
                .as_millis(),
        )
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))
    }

    fn time_of(&mut self, _value: &Value) -> Result<Option<i64>> {
        // GET expiry uses date_parse. The separate show-rules.mjs timeOf
        // contract has not been implemented by this adapter.
        Err(crate::cause!(Error::Unavailable))
    }

    fn date_parse(&mut self, value: &Value) -> Result<Option<i64>> {
        let Value::String(value) = value else {
            // Date.parse coerces nonstrings; the supported Rust subset does not.
            return Err(crate::cause!(Error::Invalid));
        };
        let text = value.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        if let Ok(date) = chrono::NaiveDate::parse_from_str(&text, "%Y-%m-%d") {
            return date
                .and_hms_opt(0, 0, 0)
                .map(|at| Some(at.and_utc().timestamp_millis()))
                .ok_or(crate::cause!(Error::Invalid));
        }
        chrono::DateTime::parse_from_rfc3339(&text)
            .map(|at| Some(at.timestamp_millis()))
            .map_err(|error| crate::carry_cause!(Error::Invalid, error))
    }

    fn facts(&mut self, _now_ms: i64, _time_zone: Option<&str>) -> Result<ClockFacts> {
        Err(crate::cause!(Error::Unavailable))
    }

    fn next_turn(
        &mut self,
        _now_ms: i64,
        _turns: &str,
        _time_zone: Option<&str>,
    ) -> Result<Option<i64>> {
        Err(crate::cause!(Error::Unavailable))
    }

    fn rule_turn(
        &mut self,
        _now_ms: i64,
        _tree: &Value,
        _declarations: &[Value],
        _thing: &Value,
        _time_zone: Option<&str>,
    ) -> Result<Option<i64>> {
        Err(crate::cause!(Error::Unavailable))
    }
}
