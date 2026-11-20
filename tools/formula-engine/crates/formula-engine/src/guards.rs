//! crates/formula-engine/src/guards.rs
//!
//! Purpose
//!   The limits a formula is held to at the one door every evaluation passes: how deep and how large a binding may
//!   be, whether a pattern it compiles is safe, how much work one call may do, and how long it may run. A bad formula
//!   is refused in its own words instead of freezing the page or the store that asked.
//!
//! Non-negotiable invariants
//!   - Every limit and every refusal's words are DATA (rules/evaluation-guards.json); nothing here names a field, a
//!     list or a caller.
//!   - A binding is checked before it is evaluated: the walk is iterative (a deep binding cannot overflow this
//!     checker's stack) and stops at the first limit passed. A binding that contains itself cannot reach here: it has
//!     no JSON text, and the host boundary refuses it as `cycle` (src/host.rs).
//!   - The work budget (rows times the binding's weight) is known before the call starts, so it holds on every host,
//!     including one whose clock does not move while code runs. The clock budget is checked between row slices.
//!   - A refusal names its guard and limit; it never answers a partial result.

use serde::Deserialize;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::VecDeque;

#[derive(Deserialize)]
pub struct Limits {
    pub max_depth: usize,
    pub max_nodes: usize,
    pub max_work: u64,
    pub regex_weight: u64,
    pub regex_ops: Vec<RegexOp>,
    pub regex_chars: usize,
    pub regex_repeat_most: u64,
    pub regex_per_binding: usize,
    pub budget_ms: f64,
    pub rows_per_slice: usize,
    pub slow_ms: f64,
    pub slow_kept: usize,
    pub words: serde_json::Map<String, Value>,
}

#[derive(Deserialize)]
pub struct RegexOp {
    pub op: String,
    pub pattern: String,
}

/// One guard's refusal: which guard, its limit, and its words.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub guard: String,
    pub limit: Option<Value>,
    pub message: String,
}

impl Limits {
    /// The refusal of `guard`, its words filled from `values`.
    pub fn refusal(&self, guard: &str, values: &[(&str, Value)]) -> Refusal {
        let template = self.words.get(guard).and_then(Value::as_str).unwrap_or(guard);
        let mut message = String::new();
        let mut rest = template;
        while let Some(open) = rest.find('{') {
            message.push_str(&rest[..open]);
            let after = &rest[open + 1..];
            match after.find('}') {
                Some(close) if after[..close].chars().all(|c| c.is_alphanumeric() || c == '_') => {
                    let key = &after[..close];
                    if let Some((_, value)) = values.iter().find(|(name, _)| *name == key) {
                        message.push_str(&match value {
                            Value::String(text) => text.clone(),
                            other => other.to_string(),
                        });
                    }
                    rest = &after[close + 1..];
                }
                _ => {
                    message.push('{');
                    rest = after;
                }
            }
        }
        message.push_str(rest);
        let limit = values.iter().find(|(name, _)| *name == "limit").map(|(_, value)| value.clone());
        Refusal { guard: guard.to_owned(), limit, message }
    }

    /// Checks one binding before it is evaluated: its weight (its parts, a pattern op weighing regex_weight), or the
    /// refusal of the first limit it passes.
    pub fn check_binding(&self, binding: &Value) -> Result<u64, Refusal> {
        if !binding.is_object() && !binding.is_array() {
            return Ok(1);
        }
        let mut nodes = 0usize;
        let mut patterns = 0usize;
        let mut pending: Vec<(&Value, usize)> = vec![(binding, 1)];
        while let Some((value, depth)) = pending.pop() {
            nodes += 1;
            if nodes > self.max_nodes {
                return Err(self.refusal("too_large", &[("limit", self.max_nodes.into())]));
            }
            let children: Vec<&Value> = match value {
                Value::Object(object) => object.values().collect(),
                Value::Array(items) => items.iter().collect(),
                _ => continue,
            };
            if depth > self.max_depth {
                return Err(self.refusal("too_deep", &[("limit", self.max_depth.into())]));
            }
            if let Some(op) = value.get("op").and_then(Value::as_str) {
                if let Some(rule) = self.regex_ops.iter().find(|rule| rule.op == op) {
                    patterns += 1;
                    if patterns > self.regex_per_binding {
                        let why = format!("more than {} patterns", self.regex_per_binding);
                        return Err(self.refusal("unsafe_regex", &[("why", why.into())]));
                    }
                    if let Some(pattern) = value["args"][&rule.pattern].as_str() {
                        if pattern.chars().count() > self.regex_chars {
                            let why = format!("longer than {} characters", self.regex_chars);
                            return Err(self.refusal("unsafe_regex", &[("why", why.into())]));
                        }
                        if largest_repeat(pattern) > self.regex_repeat_most {
                            let why = format!("repeats something more than {} times", self.regex_repeat_most);
                            return Err(self.refusal("unsafe_regex", &[("why", why.into())]));
                        }
                    }
                }
            }
            pending.extend(children.into_iter().map(|child| (child, depth + 1)));
        }
        Ok(nodes as u64 + patterns as u64 * self.regex_weight)
    }

    /// Refuses a call whose work (rows times the binding's weight) is past max_work.
    pub fn check_work(&self, weight: u64, rows: usize) -> Result<(), Refusal> {
        let work = weight.saturating_mul(rows.max(1) as u64);
        if work > self.max_work {
            return Err(self.refusal("too_much_work", &[("work", work.into()), ("limit", self.max_work.into())]));
        }
        Ok(())
    }
}

/// The largest count a pattern repeats anything (`{n}`, `{n,}` or `{n,m}`), or 0.
fn largest_repeat(pattern: &str) -> u64 {
    let bytes = pattern.as_bytes();
    let mut largest = 0u64;
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'{' {
            let digits = |from: usize| -> (u64, usize) {
                let mut end = from;
                let mut value = 0u64;
                while end < bytes.len() && bytes[end].is_ascii_digit() {
                    value = value.saturating_mul(10).saturating_add(u64::from(bytes[end] - b'0'));
                    end += 1;
                }
                (value, end)
            };
            let (first, end) = digits(at + 1);
            if end > at + 1 {
                if bytes.get(end) == Some(&b'}') {
                    largest = largest.max(first);
                } else if bytes.get(end) == Some(&b',') {
                    let (second, close) = digits(end + 1);
                    if bytes.get(close) == Some(&b'}') {
                        largest = largest.max(first).max(second);
                    }
                }
            }
        }
        at += 1;
    }
    largest
}

/// The host's clock in ms, where it moves while code runs.
pub fn now_ms() -> f64 {
    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
    {
        js_sys::Date::now()
    }
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_secs_f64() * 1000.0).unwrap_or(0.0)
    }
}

thread_local! {
    /// The formulas that ran past budget_ms, by their JSON text, with the time they may run again; oldest first.
    static SLOW: RefCell<VecDeque<(String, f64)>> = const { RefCell::new(VecDeque::new()) };
}

/// The clock budget of one call over one binding: refused at the start while the binding is paused, checked between
/// slices, and noted at the end.
pub struct Budget<'a> {
    limits: &'a Limits,
    key: String,
    started: f64,
    clock: &'a dyn Fn() -> f64,
}

impl<'a> Budget<'a> {
    pub fn start(limits: &'a Limits, key: String, clock: &'a dyn Fn() -> f64) -> Result<Self, Refusal> {
        let now = clock();
        let paused = SLOW.with(|slow| {
            let mut slow = slow.borrow_mut();
            match slow.iter().position(|(held, _)| held == &key) {
                Some(at) if now < slow[at].1 => true,
                Some(at) => {
                    slow.remove(at);
                    false
                }
                None => false,
            }
        });
        if paused {
            return Err(limits.refusal("over_time", &[("limit", limits.budget_ms.into())]));
        }
        Ok(Budget { limits, key, started: now, clock })
    }

    /// Between slices: once past budget_ms the call stops and the formula is paused.
    pub fn between_slices(&self) -> Result<(), Refusal> {
        if (self.clock)() - self.started > self.limits.budget_ms {
            self.note();
            return Err(self.limits.refusal("over_time", &[("limit", self.limits.budget_ms.into())]));
        }
        Ok(())
    }

    /// At the end: a call past budget_ms pauses its formula for slow_ms.
    pub fn note(&self) {
        let now = (self.clock)();
        if now - self.started <= self.limits.budget_ms {
            return;
        }
        SLOW.with(|slow| {
            let mut slow = slow.borrow_mut();
            slow.retain(|(held, _)| held != &self.key);
            slow.push_back((self.key.clone(), now + self.limits.slow_ms));
            while slow.len() > self.limits.slow_kept {
                slow.pop_front();
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::Cell;

    fn limits() -> Limits {
        serde_json::from_str(crate::GUARDS).expect("evaluation-guards.json")
    }

    #[test]
    fn repeats_are_read_from_every_brace() {
        assert_eq!(largest_repeat("(a{1000}){1000}"), 1000);
        assert_eq!(largest_repeat("a{2,300}b{4,}"), 300);
        assert_eq!(largest_repeat("{x}"), 0);
    }

    #[test]
    fn deep_large_and_unsafe_bindings_are_refused() {
        let limits = limits();
        let mut deep = json!({"value": 1});
        for _ in 0..=limits.max_depth {
            deep = json!({"args": deep});
        }
        assert_eq!(limits.check_binding(&deep).unwrap_err().guard, "too_deep");
        let wide = json!({"transform": vec![json!({"op": "op:core.identity"}); limits.max_nodes]});
        assert_eq!(limits.check_binding(&wide).unwrap_err().guard, "too_large");
        let pattern = json!({"op": "op:core.text_regex_match", "args": {"pattern": "a".repeat(limits.regex_chars + 1)}});
        assert_eq!(limits.check_binding(&pattern).unwrap_err().guard, "unsafe_regex");
        assert_eq!(limits.check_work(1000, (limits.max_work / 1000) as usize + 1).unwrap_err().guard, "too_much_work");
    }

    #[test]
    fn a_call_past_its_budget_stops_between_slices_and_its_formula_is_paused() {
        let limits = limits();
        let now = Cell::new(1_000.0);
        let clock = || now.get();
        let budget = Budget::start(&limits, "slow".into(), &clock).unwrap();
        now.set(1_000.0 + limits.budget_ms + 1.0);
        assert_eq!(budget.between_slices().unwrap_err().guard, "over_time");
        assert_eq!(Budget::start(&limits, "slow".into(), &clock).err().unwrap().guard, "over_time");
        assert!(Budget::start(&limits, "other".into(), &clock).is_ok());
        now.set(now.get() + limits.slow_ms + 1.0);
        assert!(Budget::start(&limits, "slow".into(), &clock).is_ok(), "a paused formula runs again after slow_ms");
    }
}
