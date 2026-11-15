//! The durable side of one simulated object: named tables of JSON rows whose
//! writes are counted as SQLite counts changed rows (`total_changes`: an
//! insert, an update or a delete of one row is one), applied inside a
//! transaction that a fault can roll back.

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// One object's tables. Every write of an open transaction is undone by
/// [`Db::rollback`]; [`Db::commit`] answers the rows each table changed.
#[derive(Default)]
pub struct Db {
    tables: BTreeMap<&'static str, BTreeMap<String, Value>>,
    undo: Vec<(&'static str, String, Option<Value>)>,
    changed: BTreeMap<&'static str, u64>,
    /// A secondary index per table on one field (the model's own lookup aid; an index entry is not a row).
    indexed: BTreeMap<&'static str, Vec<&'static str>>,
    index: BTreeMap<(&'static str, &'static str), BTreeSet<(String, String)>>,
}

/// A field value as an index key: text as it is, a whole number padded so text order is number order.
fn index_key(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => n.as_u64().map(|n| format!("{n:020}")),
        _ => None,
    }
}

impl Db {
    /// Keep `table` indexed on `field`.
    pub fn index_on(&mut self, table: &'static str, field: &'static str) {
        self.indexed.entry(table).or_default().push(field);
    }

    /// Keys of `table`'s rows whose indexed field equals `value`.
    pub fn keys_by(&self, table: &'static str, field: &'static str, value: &str) -> Vec<String> {
        let Some(set) = self.index.get(&(table, field)) else { return Vec::new() };
        set.range((value.to_owned(), String::new())..).take_while(|(v, _)| v == value).map(|(_, k)| k.clone()).collect()
    }

    /// Keys of `table`'s rows whose indexed whole-number field is above `from`, in order.
    pub fn keys_above(&self, table: &'static str, field: &'static str, from: u64) -> Vec<String> {
        let Some(set) = self.index.get(&(table, field)) else { return Vec::new() };
        set.range((format!("{:020}", from.saturating_add(1)), String::new())..).map(|(_, k)| k.clone()).collect()
    }

    /// Every row change goes through here, so the indexes follow writes and rollbacks alike.
    fn set(&mut self, table: &'static str, key: &str, value: Option<Value>) -> Option<Value> {
        let rows = self.tables.entry(table).or_default();
        let old = match value {
            Some(v) => rows.insert(key.to_owned(), v),
            None => rows.remove(key),
        };
        let new = self.tables.get(table).and_then(|r| r.get(key)).cloned();
        for field in self.indexed.get(table).cloned().unwrap_or_default() {
            let set = self.index.entry((table, field)).or_default();
            if let Some(k) = old.as_ref().and_then(|o| index_key(&o[field])) {
                set.remove(&(k, key.to_owned()));
            }
            if let Some(k) = new.as_ref().and_then(|n| index_key(&n[field])) {
                set.insert((k, key.to_owned()));
            }
        }
        old
    }

    pub fn get(&self, table: &'static str, key: &str) -> Option<&Value> {
        self.tables.get(table).and_then(|rows| rows.get(key))
    }

    pub fn rows(&self, table: &'static str) -> impl Iterator<Item = (&String, &Value)> {
        self.tables.get(table).into_iter().flat_map(|rows| rows.iter())
    }

    /// Insert or replace one row: one changed row.
    pub fn put(&mut self, table: &'static str, key: &str, value: Value) {
        let old = self.set(table, key, Some(value));
        self.undo.push((table, key.to_owned(), old));
        *self.changed.entry(table).or_default() += 1;
    }

    /// Change one existing row's fields: one changed row. Answers false when there is no such row.
    pub fn update(&mut self, table: &'static str, key: &str, change: impl FnOnce(&mut Value)) -> bool {
        let Some(mut value) = self.get(table, key).cloned() else { return false };
        change(&mut value);
        self.put(table, key, value);
        true
    }

    /// Give a row a new key in one statement (`UPDATE ... SET key = ?`): one changed row.
    pub fn rekey(&mut self, table: &'static str, from: &str, to: &str, change: impl FnOnce(&mut Value)) -> bool {
        let Some(mut value) = self.set(table, from, None) else { return false };
        self.undo.push((table, from.to_owned(), Some(value.clone())));
        change(&mut value);
        let old = self.set(table, to, Some(value));
        self.undo.push((table, to.to_owned(), old));
        *self.changed.entry(table).or_default() += 1;
        true
    }

    pub fn delete(&mut self, table: &'static str, key: &str) {
        if self.get(table, key).is_none() {
            return;
        }
        if let Some(old) = self.set(table, key, None) {
            self.undo.push((table, key.to_owned(), Some(old)));
            *self.changed.entry(table).or_default() += 1;
        }
    }

    /// Count `n` rows of `table` written by work this model keeps no rows for (the domain's own records).
    pub fn written(&mut self, table: &'static str, n: u64) {
        if n > 0 {
            *self.changed.entry(table).or_default() += n;
        }
    }

    /// Whether the open transaction has written nothing (it then has no commit for a fault to hit).
    pub fn is_clean(&self) -> bool {
        self.undo.is_empty() && self.changed.is_empty()
    }

    pub fn rollback(&mut self) {
        while let Some((table, key, old)) = self.undo.pop() {
            self.set(table, &key, old);
        }
        self.changed.clear();
    }

    pub fn commit(&mut self) -> BTreeMap<&'static str, u64> {
        self.undo.clear();
        std::mem::take(&mut self.changed)
    }
}

/// Deterministic generator (SplitMix64): the same seed gives the same run.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed ^ 0x9E37_79B9_7F4A_7C15)
    }
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    pub fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    pub fn chance(&mut self, p: f64) -> bool {
        p > 0.0 && self.unit() < p
    }
    pub fn between(&mut self, min: u64, max: u64) -> u64 {
        if max <= min {
            min
        } else {
            min + self.next() % (max - min + 1)
        }
    }
}
