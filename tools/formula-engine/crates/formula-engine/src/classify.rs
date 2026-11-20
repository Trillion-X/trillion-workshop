//! crates/formula-engine/src/classify.rs
//!
//! Purpose
//!   Give one record the label of the FIRST rule whose clauses all hold (tool:classify-a-record). The facts a rule
//!   reads are projections of the record (is it present, as a number, as an age in seconds, as it is); the rules,
//!   their labels, tones and severities are all in the request. Nothing here names a field, a label or a threshold.
//!
//! Request
//!   facts:  [{ key, path: [names or list positions], as: "present" | "number" | "age-seconds" | "value" }]
//!   rules:  [{ key, label, tone?, severity?, requires: [{ fact, op: "present" | "absent" | "gte" | "lte" | "eq", value? }] }]
//!   record: the object the facts are read from
//!   now_ms: the clock for "age-seconds" facts, required when one is declared (the engine never reads the clock here)
//!
//! Invariants
//!   - First match in rule order wins; no rule holding gives { result: null }.
//!   - "present" is true for a true flag, a number above zero, text with a non-space character, a non-empty list or
//!     object. "number" is the number (or numeric text) at the path, 0 when there is none. "age-seconds" is the whole
//!     seconds from the timestamp (milliseconds, or RFC 3339 text) to now_ms, never below 0, and 0 when there is none.
//!   - Each clause is a comparison row of the engine's own (is_true, is_false, equals, at_least, at_most) over its
//!     projected fact, compiled and evaluated like every other rule: present and absent are is_true and is_false of
//!     the fact's presence, eq is equals (both sides as numbers when both read as numbers), gte and lte are at_least
//!     and at_most of the two numbers. A clause the engine cannot finish does not hold.
//!   - An unfinished request (a rule with no key, label or clause, a clause naming an undeclared fact or an unlisted
//!     operator, an age fact with no now_ms) is refused with a sentence, never skipped or guessed.

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

use crate::{compiled, filter_with, sentence, Refused};
use ops_core::OpValue;

const OPERATIONS: [&str; 5] = ["present", "absent", "gte", "lte", "eq"];
const PROJECTIONS: [&str; 4] = ["present", "number", "age-seconds", "value"];

fn read_at<'a>(root: &'a Value, path: &[Value]) -> Option<&'a Value> {
    let mut at = root;
    for step in path {
        at = match at {
            Value::Array(items) => {
                let text = match step {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                };
                if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
                    return None;
                }
                items.get(text.parse::<usize>().ok()?)?
            }
            Value::Object(object) => object.get(step.as_str()?)?,
            _ => return None,
        };
    }
    Some(at)
}

fn present(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n > 0.0),
        Some(Value::String(text)) => !text.trim().is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(object)) => !object.is_empty(),
    }
}

fn number_of(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64().filter(|n| n.is_finite()),
        Value::String(text) if !text.trim().is_empty() => js_number(text.trim()),
        _ => None,
    }
}

/// JavaScript's Number() of trimmed text: decimal, exponent, hex, octal and binary forms and Infinity; None for NaN.
fn js_number(text: &str) -> Option<f64> {
    let lower = text.to_ascii_lowercase();
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(digits) = lower.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).ok().map(|n| n as f64);
        }
    }
    if text.contains("inf") || text.contains("nan") || text.contains("NaN") {
        return None;
    }
    let parsed = text.parse::<f64>().ok().or_else(|| match text {
        "Infinity" | "+Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        _ => None,
    })?;
    parsed.is_finite().then_some(parsed)
}

/// Milliseconds since the epoch of RFC 3339 / ISO text, as Date.parse reads the forms records hold.
fn parse_time(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let number = |from: usize, to: usize| -> Option<i64> { text.get(from..to)?.parse().ok() };
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (mut hour, mut minute, mut second, mut millis, mut offset_minutes) = (0i64, 0i64, 0i64, 0f64, 0i64);
    let mut rest = &text[10..];
    if let Some(time) = rest.strip_prefix('T').or_else(|| rest.strip_prefix(' ')) {
        hour = time.get(0..2)?.parse().ok()?;
        minute = time.get(3..5)?.parse().ok()?;
        rest = &time[5..];
        if let Some(seconds) = rest.strip_prefix(':') {
            second = seconds.get(0..2)?.parse().ok()?;
            rest = &seconds[2..];
            if let Some(fraction) = rest.strip_prefix('.') {
                let digits: String = fraction.chars().take_while(char::is_ascii_digit).collect();
                millis = format!("0.{digits}").parse::<f64>().ok()? * 1000.0;
                rest = &fraction[digits.len()..];
            }
        }
        if rest == "Z" || rest == "z" {
            rest = "";
        } else if let Some(sign) = rest.chars().next().filter(|c| *c == '+' || *c == '-') {
            let zone = &rest[1..];
            let (h, m) = (zone.get(0..2)?.parse::<i64>().ok()?, zone.get(zone.len() - 2..)?.parse::<i64>().ok()?);
            offset_minutes = (h * 60 + m) * if sign == '-' { -1 } else { 1 };
            rest = "";
        }
    }
    if !rest.is_empty() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds as f64 * 1000.0 + millis)
}

fn milliseconds_of(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64().filter(|n| n.is_finite()).map(f64::round),
        Value::String(text) => parse_time(text),
        _ => None,
    }
}

fn number_value(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 { json!(n as i64) } else { json!(n) }
}

fn project(record: &Value, fact: &Value, now_ms: f64) -> Value {
    let path = fact["path"].as_array().cloned().unwrap_or_default();
    let raw = read_at(record, &path);
    match fact["as"].as_str() {
        Some("present") => json!(present(raw)),
        Some("number") => number_value(number_of(raw).unwrap_or(0.0)),
        Some("age-seconds") => match milliseconds_of(raw) {
            None => json!(0),
            Some(started) => number_value(((now_ms - started).max(0.0) / 1000.0).round()),
        },
        _ => raw.cloned().unwrap_or(Value::Null),
    }
}

/// One clause as an engine rule over its own fact `c<n>`, with the value that fact holds for this record.
fn clause_rule(value: &Value, clause: &Value, at: usize) -> (Value, Value) {
    let field = format!("c{at}");
    let op = clause["op"].as_str().unwrap_or_default();
    match op {
        "present" | "absent" => (
            json!(present(Some(value))),
            json!({"kind": "rule", "field": field, "operator": if op == "present" { "is_true" } else { "is_false" }, "params": {}}),
        ),
        "eq" => {
            let (a, b) = (number_of(Some(value)), number_of(clause.get("value")));
            let both = a.is_some() && b.is_some();
            let fact = if both { number_value(a.unwrap()) } else { value.clone() };
            let params = match clause.get("value") {
                None => json!({}),
                Some(given) => json!({"value": if both { number_value(b.unwrap()) } else { given.clone() }}),
            };
            (fact, json!({"kind": "rule", "field": field, "operator": "equals", "params": params}))
        }
        _ => (
            number_of(Some(value)).map(number_value).unwrap_or(Value::Null),
            json!({"kind": "rule", "field": field, "operator": if op == "gte" { "at_least" } else { "at_most" },
                   "params": {"value": number_of(clause.get("value")).map(number_value)}}),
        ),
    }
}

fn rule_holds(rule: &Value, values: &HashMap<String, Value>) -> Result<bool, Refused> {
    let clauses = rule["requires"].as_array().cloned().unwrap_or_default();
    let parts: Vec<(Value, Value)> = clauses
        .iter()
        .enumerate()
        .map(|(at, clause)| clause_rule(clause["fact"].as_str().and_then(|key| values.get(key)).unwrap_or(&Value::Null), clause, at))
        .collect();
    let fields: Vec<Value> = (0..parts.len()).map(|at| json!({"id": format!("c{at}"), "kind": "fact"})).collect();
    let tree = json!({"kind": "group", "combinator": "and", "negate": false, "rules": parts.iter().map(|(_, rule)| rule.clone()).collect::<Vec<_>>()});
    let kept = compiled(Some(&tree), &fields, None)?;
    if !kept.incomplete.is_empty() {
        return Ok(false);
    }
    let row: Map<String, Value> = parts.into_iter().enumerate().map(|(at, (fact, _))| (format!("c{at}"), fact)).collect();
    match &kept.ready {
        None => Ok(true),
        Some(ready) => Ok(filter_with(ready, &[OpValue::from(Value::Object(row))], &crate::guards::now_ms)?.matches.len() == 1),
    }
}

fn need(ok: bool, words: impl Into<String>) -> Result<(), Refused> {
    if ok { Ok(()) } else { Err(sentence(words)) }
}

pub fn classify_record(request: &Value) -> Result<Value, Refused> {
    need(request.is_object(), "Send an object with facts, rules and a record.")?;
    need(request["record"].is_object(), "record must be the object the facts are read from.")?;
    let path_ok = |fact: &Value| match fact.get("path") {
        None => true,
        Some(path) => path.as_array().is_some_and(|steps| steps.iter().all(|step| step.is_string() || step.as_u64().is_some())),
    };
    let facts = request["facts"].as_array().filter(|facts| {
        facts.iter().all(|fact| {
            fact.is_object()
                && fact["key"].as_str().is_some_and(|key| !key.is_empty())
                && fact["as"].as_str().is_some_and(|projection| PROJECTIONS.contains(&projection))
                && path_ok(fact)
        })
    });
    let facts = facts.ok_or_else(|| sentence(format!("facts must be a list of {{ key, path, as }} with as one of {}.", PROJECTIONS.join(", "))))?;
    let keys: HashSet<&str> = facts.iter().filter_map(|fact| fact["key"].as_str()).collect();
    need(keys.len() == facts.len(), "two facts share a key; each fact key must be its own.")?;
    let rules = request["rules"].as_array().ok_or_else(|| sentence("rules must be a list of { key, label, tone?, severity?, requires }."))?;
    need(
        rules.iter().all(|rule| {
            rule.is_object()
                && rule["key"].as_str().is_some_and(|key| !key.trim().is_empty())
                && rule["label"].as_str().is_some_and(|label| !label.trim().is_empty())
                && rule["requires"].as_array().is_some_and(|requires| !requires.is_empty())
        }),
        "every rule needs a key, a label and at least one clause in requires.",
    )?;
    for rule in rules {
        for clause in rule["requires"].as_array().into_iter().flatten() {
            need(
                clause.is_object() && clause["op"].as_str().is_some_and(|op| OPERATIONS.contains(&op)),
                format!("rule {} has a clause whose op is not one of {}.", rule["key"], OPERATIONS.join(", ")),
            )?;
            need(
                clause["fact"].as_str().is_some_and(|fact| keys.contains(fact)),
                format!("rule {} reads the fact {}, which facts does not declare.", rule["key"], clause.get("fact").cloned().unwrap_or(Value::Null)),
            )?;
        }
    }
    let now = request.get("now_ms").filter(|now| !now.is_null());
    need(now.is_none_or(|now| now.as_f64().is_some_and(f64::is_finite)), "now_ms must be a number of milliseconds.")?;
    need(
        now.is_some() || !facts.iter().any(|fact| fact["as"].as_str() == Some("age-seconds")),
        "a fact read as age-seconds needs now_ms, the time to measure the age to.",
    )?;
    let now_ms = now.and_then(Value::as_f64).unwrap_or(f64::NAN);
    let values: HashMap<String, Value> =
        facts.iter().map(|fact| (fact["key"].as_str().unwrap_or_default().to_owned(), project(&request["record"], fact, now_ms))).collect();
    let words = |value: &Value| value.as_str().map(str::trim).filter(|text| !text.is_empty()).map(|text| json!(text)).unwrap_or(Value::Null);
    for rule in rules {
        if rule_holds(rule, &values)? {
            return Ok(json!({"result": {"key": rule["key"], "label": rule["label"], "tone": words(&rule["tone"]), "severity": words(&rule["severity"])}}));
        }
    }
    Ok(json!({"result": null}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_read_as_date_parse_reads_them() {
        assert_eq!(parse_time("1970-01-01T00:00:01Z"), Some(1000.0));
        assert_eq!(parse_time("2026-11-19T14:00:00-06:00"), Some(1_795_118_400_000.0));
        assert_eq!(parse_time("2026-11-19"), Some(1_795_046_400_000.0));
        assert_eq!(parse_time("2026-11-19T14:00:00.250Z"), Some(1_795_096_800_250.0));
        assert_eq!(parse_time("not a time"), None);
    }

    #[test]
    fn the_first_rule_that_holds_gives_its_label() {
        let request = json!({
            "facts": [{"key": "n", "path": ["count"], "as": "number"}, {"key": "seen", "path": ["seen"], "as": "present"}],
            "rules": [
                {"key": "many", "label": "Many", "tone": " warm ", "requires": [{"fact": "n", "op": "gte", "value": 10}]},
                {"key": "some", "label": "Some", "requires": [{"fact": "seen", "op": "present"}]}
            ],
            "record": {"count": "4", "seen": true}
        });
        assert_eq!(classify_record(&request).unwrap()["result"]["key"], "some");
        let mut many = request.clone();
        many["record"]["count"] = json!(12);
        assert_eq!(classify_record(&many).unwrap()["result"], json!({"key": "many", "label": "Many", "tone": "warm", "severity": null}));
    }
}
