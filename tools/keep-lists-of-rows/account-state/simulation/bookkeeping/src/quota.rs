//! The account's quota owner: reservations (permits), the holds stopping budgets count, the usage counters refusals
//! read, and the priced day plan billing reads. Two counter layouts: main's (one usage row per budget window, one hold
//! row per stopping budget, day and subject, one priced-day row) and the floor's (one ledger row per account and day
//! holding that day's hourly and daily usage, its holds and its priced dollars), so a settlement writes each row once.

use super::data::Protocol;
use super::world::{Step, TxEnd, World, DAY, HOUR, O, PLAN_CAP_PER_DAY};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const PERMITS: &str = "resource_budget_permits";

/// One assignment a reservation asks for: dollars of `subject`'s use (counted against the hourly use budget, and
/// against the plan's daily cap when it is store work) and a paid run's price (against the paid ceiling).
#[derive(Clone, Debug)]
pub struct Ask {
    pub subject: String,
    pub amount: f64,
    pub paid: f64,
    pub store_work: bool,
}

/// What one settlement charges and counts, unit by unit; `escrow` is counted against limits and never charged.
#[derive(Clone, Debug, Default)]
pub struct Settlement {
    pub event: String,
    pub items: Vec<(usize, f64, f64)>,
    pub escrow: Vec<(String, f64)>,
}

impl Settlement {
    pub fn to_json(&self) -> Value {
        json!({"event": self.event, "items": self.items, "escrow": self.escrow})
    }
    pub fn from_json(value: &Value) -> Settlement {
        let items = value["items"].as_array().map(|a| a.iter().map(|i| (i[0].as_u64().unwrap_or(0) as usize, i[1].as_f64().unwrap_or(0.0), i[2].as_f64().unwrap_or(0.0))).collect()).unwrap_or_default();
        let escrow = value["escrow"].as_array().map(|a| a.iter().map(|i| (i[0].as_str().unwrap_or("").to_owned(), i[1].as_f64().unwrap_or(0.0))).collect()).unwrap_or_default();
        Settlement { event: value["event"].as_str().unwrap_or("").to_owned(), items, escrow }
    }
}

pub fn asks_json(asks: &[Ask]) -> Value {
    Value::Array(asks.iter().map(|a| json!({"subject": a.subject, "amount": a.amount, "paid": a.paid, "store": a.store_work})).collect())
}

pub fn asks_of(value: &Value) -> Vec<Ask> {
    value.as_array().map(|a| a.iter().map(|x| Ask { subject: x["subject"].as_str().unwrap_or("").to_owned(), amount: x["amount"].as_f64().unwrap_or(0.0),
        paid: x["paid"].as_f64().unwrap_or(0.0), store_work: x["store"].as_bool().unwrap_or(false) }).collect()).unwrap_or_default()
}

/// One counter the quota keeps.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Counter {
    /// Use of `subject` in hour `hour`.
    Hour { hour: u64, subject: String },
    /// Use of `subject` on day `day` (`*` is every store-work subject; `paid:<s>` a paid subject's prices).
    Day { day: u64, subject: String },
    /// What a stopping budget holds for work in flight: `plan` (the daily cap) or `paid:<subject>` on day `day`.
    Held { day: u64, budget: String },
    /// The priced dollars of day `day`.
    Dollars { day: u64 },
}

impl Counter {
    fn day(&self) -> u64 {
        match self {
            Counter::Hour { hour, .. } => hour * HOUR / DAY,
            Counter::Day { day, .. } | Counter::Held { day, .. } | Counter::Dollars { day } => *day,
        }
    }
}

/// The holds of `asks` on `day`: the plan's cap for store work, the paid ceiling for prices.
fn holds(asks: &[Ask], sign: f64, day: u64, into: &mut BTreeMap<Counter, f64>) {
    let store: f64 = asks.iter().filter(|a| a.store_work).map(|a| a.amount).sum();
    if store > 0.0 {
        *into.entry(Counter::Held { day, budget: "plan".into() }).or_default() += store * sign;
    }
    for a in asks.iter().filter(|a| a.paid > 0.0) {
        *into.entry(Counter::Held { day, budget: format!("paid:{}", a.subject) }).or_default() += a.paid * sign;
    }
}

impl World {
    fn ledger(&self) -> bool {
        self.protocol() == Protocol::Envelope
    }

    /// Where a counter lives: (table, row key, path inside the row).
    fn place(&self, c: &Counter) -> (&'static str, String, Vec<String>) {
        if self.ledger() {
            let path = match c {
                Counter::Hour { hour, subject } => vec!["h".into(), hour.to_string(), subject.clone()],
                Counter::Day { subject, .. } => vec!["d".into(), subject.clone()],
                Counter::Held { budget, .. } => vec!["held".into(), budget.clone()],
                Counter::Dollars { .. } => vec!["dollars".into()],
            };
            return ("resource_budget_ledger", c.day().to_string(), path);
        }
        match c {
            Counter::Hour { hour, subject } => ("resource_budget_window_usage", format!("h:{hour}"), vec![subject.clone()]),
            Counter::Day { day, subject } => ("resource_budget_window_usage", format!("d:{day}"), vec![subject.clone()]),
            Counter::Held { day, budget } => ("resource_budget_reserved", format!("{budget}|{day}"), Vec::new()),
            Counter::Dollars { day } => ("resource_budget_days", day.to_string(), Vec::new()),
        }
    }

    fn counter(&self, c: &Counter) -> f64 {
        let (table, key, path) = self.place(c);
        let mut at = self.objects[O::Quota as usize].db.get(table, &key);
        for part in &path {
            at = at.and_then(|v| v.get(part));
        }
        at.and_then(Value::as_f64).unwrap_or(0.0)
    }

    /// Apply counter changes, writing each row they touch once (never below zero).
    fn add(&mut self, changes: BTreeMap<Counter, f64>) {
        let mut rows: BTreeMap<(&'static str, String), Value> = BTreeMap::new();
        for (c, delta) in changes {
            if delta.abs() < 1e-15 {
                continue;
            }
            let (table, key, path) = self.place(&c);
            let next = (self.counter(&c) + delta).max(0.0);
            let row = rows.entry((table, key.clone())).or_insert_with(|| self.objects[O::Quota as usize].db.get(table, &key).cloned().unwrap_or(Value::Null));
            if path.is_empty() {
                *row = json!(next);
                continue;
            }
            let mut at = row;
            for part in &path {
                if !at.is_object() {
                    *at = json!({});
                }
                at = at.as_object_mut().map(|o| o.entry(part.clone()).or_insert(Value::Null)).expect("an object row");
            }
            *at = json!(next);
        }
        for ((table, key), value) in rows {
            self.objects[O::Quota as usize].db.put(table, &key, value);
        }
    }

    /// Whether `asks` fit the stopping budgets now: the plan's daily cap over store work and the paid ceiling. A batch
    /// reserved for work nobody asked for yet (`speculative`) may take only half of a stopping budget.
    fn fits(&self, asks: &[Ask], speculative: bool) -> bool {
        let day = self.now / DAY;
        let ceiling = self.objects[O::Quota as usize].db.get("resource_budget_policy", "1").and_then(|p| p["paid_ceiling"].as_f64()).unwrap_or(0.0);
        let share = if speculative { 0.5 } else { 1.0 };
        let mut asked = BTreeMap::new();
        holds(asks, 1.0, day, &mut asked);
        asked.into_iter().filter(|(_, amount)| *amount > 1e-12).all(|(c, amount)| {
            let Counter::Held { budget, .. } = &c else { return true };
            let (used, limit) = match budget.strip_prefix("paid:") {
                Some(subject) => (self.counter(&Counter::Day { day, subject: format!("paid:{subject}") }), ceiling),
                None => (self.counter(&Counter::Day { day, subject: "*".into() }), PLAN_CAP_PER_DAY),
            };
            used + self.counter(&c) + amount <= limit * share + 1e-9
        })
    }

    /// Reserve `asks` under permit `id` (one row) and hold what stopping budgets count. Err answers a refusal; Ok the
    /// transaction's end (a retry of the same id answers Done and writes nothing).
    pub fn quota_reserve(&mut self, id: &str, asks: &[Ask], speculative: bool) -> Result<TxEnd, Step> {
        self.touch(O::Quota);
        if self.objects[O::Quota as usize].db.get(PERMITS, id).is_some() {
            return Ok(TxEnd::Done);
        }
        if !self.fits(asks, speculative) {
            return Err(Step::Refused("reserve", "budget_reached"));
        }
        let day = self.now / DAY;
        self.objects[O::Quota as usize].db.put(PERMITS, id, json!({"state": "pending", "hour": self.now / HOUR, "day": day, "asks": asks_json(asks), "settled": null}));
        let mut changes = BTreeMap::new();
        holds(asks, 1.0, day, &mut changes);
        self.add(changes);
        Ok(self.end_tx(O::Quota))
    }

    /// Add `asks` to a pending permit (an envelope's top-up): its row and the holds change, no new permit.
    pub fn quota_top_up(&mut self, id: &str, asks: &[Ask], marker: &str, speculative: bool) -> Result<TxEnd, Step> {
        self.touch(O::Quota);
        let Some(permit) = self.objects[O::Quota as usize].db.get(PERMITS, id).cloned() else { return Err(Step::Retry) };
        if permit["top_ups"].as_array().is_some_and(|t| t.iter().any(|m| m == marker)) {
            return Ok(TxEnd::Done);
        }
        if !self.fits(asks, speculative) {
            return Err(Step::Refused("reserve", "budget_reached"));
        }
        let day = permit["day"].as_u64().unwrap_or(self.now / DAY);
        self.objects[O::Quota as usize].db.update(PERMITS, id, |p| {
            let mut all = asks_of(&p["asks"]);
            all.extend(asks.iter().cloned());
            p["asks"] = asks_json(&all);
            let mut markers = p["top_ups"].as_array().cloned().unwrap_or_default();
            markers.push(json!(marker));
            p["top_ups"] = Value::Array(markers);
        });
        let mut changes = BTreeMap::new();
        holds(asks, 1.0, day, &mut changes);
        self.add(changes);
        Ok(self.end_tx(O::Quota))
    }

    /// The day a permit's holds count on: work admitted under it settles to that day's budgets.
    pub fn hold_day(&self, id: &str) -> Option<u64> {
        self.objects[O::Quota as usize].db.get(PERMITS, id).and_then(|p| p["day"].as_u64())
    }

    /// What a pending permit holds now (an envelope's reservation and its top-ups), read without writing.
    pub fn quota_asks(&mut self, id: &str) -> Vec<Ask> {
        self.touch(O::Quota);
        self.objects[O::Quota as usize].db.get(PERMITS, id).map(|p| asks_of(&p["asks"])).unwrap_or_default()
    }

    /// Settle permit `id` with `s` (idempotent by its event), and, for a roll, reserve `next` on the same row in the
    /// same transaction: `next` is (speculative asks, which may take half of a stopping budget; exact asks of the command
    /// waiting on the roll, which may take the rest; the roll's marker).
    pub fn quota_settle(&mut self, id: &str, s: &Settlement, next: Option<(&[Ask], &[Ask], &str)>) -> Result<TxEnd, Step> {
        self.touch(O::Quota);
        let Some(permit) = self.objects[O::Quota as usize].db.get(PERMITS, id).cloned() else { return Ok(TxEnd::Done) };
        let rolled = next.is_some_and(|(_, _, marker)| permit["rolled"] == json!(marker));
        if permit["settled"] == json!(s.event) || rolled {
            return Ok(TxEnd::Done);
        }
        let old = asks_of(&permit["asks"]);
        let (hour, day) = (permit["hour"].as_u64().unwrap_or(0), permit["day"].as_u64().unwrap_or(0));
        let mut changes: BTreeMap<Counter, f64> = BTreeMap::new();
        let mut charged = 0.0;
        for &(unit, charge, limit) in &s.items {
            let u = &self.units[unit];
            let subject = u.subject.clone();
            let (store, paid) = (!u.read, u.price > 0.0 && u.committed && !u.read);
            let price = u.price;
            *changes.entry(Counter::Hour { hour, subject: subject.clone() }).or_default() += limit;
            *changes.entry(Counter::Day { day, subject: subject.clone() }).or_default() += limit;
            if store {
                *changes.entry(Counter::Day { day, subject: "*".into() }).or_default() += limit;
            }
            if paid {
                *changes.entry(Counter::Day { day, subject: format!("paid:{subject}") }).or_default() += price;
            }
            charged += charge;
        }
        for (subject, amount) in &s.escrow {
            *changes.entry(Counter::Hour { hour, subject: subject.clone() }).or_default() += amount;
            *changes.entry(Counter::Day { day, subject: subject.clone() }).or_default() += amount;
        }
        if charged > 0.0 {
            *changes.entry(Counter::Dollars { day }).or_default() += charged;
        }
        holds(&old, -1.0, day, &mut changes);
        let event = s.event.clone();
        match next {
            Some((spec, exact, marker)) => {
                // The next reservation is checked against the counters as this settlement leaves them (its use counted, its
                // holds given back); the check's trial writes are undone and every row is then written once.
                let all: Vec<Ask> = spec.iter().chain(exact).cloned().collect();
                self.add(changes.clone());
                let fit = self.fits(spec, true) && self.fits(&all, false);
                self.objects[O::Quota as usize].db.rollback();
                if !fit {
                    return Err(Step::Refused("reserve", "budget_reached"));
                }
                let next_day = self.now / DAY;
                let asks = all;
                holds(&asks, 1.0, next_day, &mut changes);
                self.objects[O::Quota as usize].db.put(PERMITS, id, json!({"state": "pending", "hour": self.now / HOUR, "day": next_day,
                    "asks": asks_json(&asks), "settled": event, "rolled": marker}));
            }
            None => {
                self.objects[O::Quota as usize].db.update(PERMITS, id, |p| {
                    p["state"] = json!("settled");
                    p["settled"] = json!(event);
                });
            }
        }
        self.add(changes);
        let end = self.end_tx(O::Quota);
        if end.committed() {
            for &(unit, charge, limit) in &s.items {
                let u = &mut self.units[unit];
                u.settled += 1;
                u.charged += charge;
                u.limits += limit;
            }
        }
        Ok(end)
    }
}
