// src/storage/record_store/keep.rs
//
// Purpose: How long a kind of records is kept, as a row the person edits, applied when the person's own schedule fires. A keep
// rule is one row of the rules kind (`settings.json` `keep.rule_kind`, a list of the person's) in the same store as the
// records it names. Its columns say which kind of record (`keeps_kind`), when a record of it has expired (`expire_when`: the
// formula engine's rule tree over the record's own values and `age_ms`, how long ago its newest write was), how many records
// one firing may destroy (`page`) and how many it may look at (`walk`). Nothing here says when to run: the person's wake
// declaration does (src/wake.rs), and its run asks the engine to apply a rule by id (`{keep: {rule}}`); no number is in this
// file, and a row that leaves a column out is refused with the column named, never given a default.
//
// Non-Negotiable Invariants:
// - A record leaves only through the store's one destruction (`erase_cascading`): it is unreachable at once, restorable
//   until the undo window ends, and its cascade (`settings.json` `erase_with`) goes with it. This file removes no row itself.
// - The condition is decided by the caller's formula evaluator (`Conditions`), never here: a row whose tree the evaluator
//   cannot compile, or a record it cannot decide, destroys nothing.
// - A step is bounded by the rule's own `page` and `walk`: it reads the store's current records oldest first by their newest
//   write (the `changed` order), resumes where the last step stopped, and never reads the whole store at once.
// - A disabled or missing rule, a rule that names the rules' own kind, and a rule with no `expire_when` destroy nothing: a
//   rule with no condition would keep nothing apart.
// - The person's edit of a rule's row applies at the next firing: the row is read again each time. The walk's resume point
//   is the caller's `Walks`, never written: a restart walks again from the oldest record, which only costs a walk.
//
// Key Concepts:
// - The age of a record is the stamp of its current version (`valid_from`, milliseconds << 16): a record nobody rewrote is
//   as old as its creation, so a rule needs no time field of the kind.
// - A sweep is the steps from the oldest record to the end of the store; the step that reaches the end ends it (`Kept::done`)
//   and the next step starts again from the oldest.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{text, unavailable, Bound, Field, Order, Range, RecordStore, Storage, Value, VERSIONS};
use crate::records::{Error, MAX_PAGE_ITEMS};
use serde::Deserialize;
use serde_json::{json, Value as Json};
use std::collections::HashMap;

/// The names a keep rule's row is read by (`settings.json` `keep`).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    #[serde(rename = "_what")]
    pub what: String,
    /// The record kind of a rule's row.
    pub rule_kind: String,
    /// The word a choice column holds for a rule that is on (a list has a choice column, not a true or false one); JSON true
    /// is on too.
    pub on_word: String,
    /// The columns of a rule's row.
    pub fields: Fields,
}

/// The column names of a rule's row.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Fields {
    pub enabled: String,
    pub kind: String,
    pub expire_when: String,
    pub page: String,
    pub walk: String,
    /// The fact a rule tree reads for how long ago a record's newest write was, in milliseconds.
    pub age_fact: String,
}

impl Settings {
    /// Whether every name holds.
    pub fn valid(&self) -> bool {
        let names = [&self.fields.enabled, &self.fields.kind, &self.fields.expire_when, &self.fields.page, &self.fields.walk, &self.fields.age_fact];
        !self.rule_kind.is_empty()
            && !self.on_word.is_empty()
            && names.iter().all(|name| !name.is_empty())
            && names.iter().enumerate().all(|(at, name)| names[..at].iter().all(|other| other != name))
    }
}

/// Decides a rule's condition. The formula engine's compiler and evaluator are the caller's (the host reads the operator DATA
/// of the installed Workshop); this file names no operator.
pub trait Conditions {
    /// The decision of `when` (`{tree, fields}`, as the formula engine's row filter takes them): given a record's value and
    /// its age in milliseconds (which the tree reads as the fact `age_fact`), whether the record has expired. None when
    /// `when` cannot be compiled.
    fn compile(&self, when: &Json, age_fact: &str) -> Option<Box<dyn FnMut(&Json, u64) -> bool>>;
}

/// One rule, read from its row.
#[derive(Clone, Debug, PartialEq)]
pub struct Rule {
    /// The id of the rule's row.
    pub id: String,
    /// The kind of record the rule keeps.
    pub kind: String,
    /// `{tree, fields}`: when a record of the kind has expired.
    pub when: Json,
    /// The most records one step destroys.
    pub page: usize,
    /// The most records one step looks at.
    pub walk: usize,
}

/// What a row of the rules kind came to: a rule that applies, a rule the person turned off, or the words of what is wrong
/// with it (the column and why).
#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    On(Rule),
    Off,
    Refused { id: String, field: String, why: &'static str },
}

fn whole(value: &Json, field: &str) -> Option<usize> {
    value.get(field).and_then(Json::as_u64).filter(|n| *n > 0).and_then(|n| usize::try_from(n).ok())
}

impl Row {
    /// Reads the row `id` holding `value`: its columns by the settings' names, none defaulted.
    pub fn read(settings: &Settings, id: &str, value: &Json) -> Row {
        let fields = &settings.fields;
        let refused = |field: &str, why: &'static str| Row::Refused { id: id.to_owned(), field: field.to_owned(), why };
        let on = match value.get(&fields.enabled) {
            Some(Json::Bool(on)) => *on,
            Some(Json::String(word)) => *word == settings.on_word,
            _ => false,
        };
        if !on {
            return Row::Off;
        }
        let Some(kind) = value.get(&fields.kind).and_then(Json::as_str).filter(|kind| !kind.is_empty()) else {
            return refused(&fields.kind, "names no kind");
        };
        if kind == settings.rule_kind {
            return refused(&fields.kind, "names the kind of the rules themselves");
        }
        // The condition is kept as the tree and its fields, or as the text of that object.
        let when = match value.get(&fields.expire_when) {
            Some(Json::String(text)) => serde_json::from_str::<Json>(text).ok(),
            Some(object @ Json::Object(_)) => Some(object.clone()),
            _ => None,
        };
        let Some(when) = when.filter(|when| when.get("tree").is_some_and(Json::is_object) && when.get("fields").is_some_and(Json::is_array)) else {
            return refused(&fields.expire_when, "is left out or is not a tree with its fields");
        };
        let Some(page) = whole(value, &fields.page).filter(|n| *n <= MAX_PAGE_ITEMS) else {
            return refused(&fields.page, "is not a whole number from one to the page size");
        };
        let Some(walk) = whole(value, &fields.walk).filter(|n| *n >= page) else {
            return refused(&fields.walk, "is not a whole number of at least the page");
        };
        Row::On(Rule { id: id.to_owned(), kind: kind.to_owned(), when, page, walk })
    }
}

/// What one step did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Kept {
    pub rule: String,
    /// Records destroyed, with those that went with them (`erase_with`).
    pub erased: u64,
    /// Records of any kind looked at.
    pub walked: u64,
    /// The step reached the end of the store: the next step starts again from the oldest record.
    pub done: bool,
}

impl Kept {
    /// The log line of a step.
    pub fn line(&self) -> Json {
        json!({"keep": {"rule": self.rule, "erased": self.erased, "walked": self.walked, "done": self.done}})
    }
}

impl Row {
    /// The log line of a row that cannot apply: its id, the column and why.
    pub fn line(&self) -> Option<Json> {
        match self {
            Row::Refused { id, field, why } => Some(json!({"keep": {"rule": id, "refused": field, "why": why}})),
            _ => None,
        }
    }
}

/// Where each rule's sweep stands, for the process: the stamp its next step resumes from. Not stored (see the invariants).
#[derive(Default)]
pub struct Walks {
    resume: HashMap<String, i64>,
}

/// What a firing of a rule came to.
#[derive(Clone, Debug, PartialEq)]
pub enum Applied {
    Stepped(Kept),
    /// The row is off or gone: nothing happened.
    Idle,
    Refused(Row),
}

impl<S: Storage + Send> RecordStore<S> {
    /// One firing of the rule whose row is `rule_id` in this store at `now_ms`: the row is read, its condition compiled by
    /// `conditions`, and one bounded step taken from where the rule's last firing stopped (`keep_walks`).
    pub fn keep_rule(&mut self, account: &str, resource: &str, rule_id: &str, now_ms: i64, conditions: &dyn Conditions) -> Result<Applied, Error> {
        let settings = &self.settings.keep;
        let Some(record) = self.current_record(account, resource, rule_id)? else { return Ok(Applied::Idle) };
        if self.kind_of(&record.value).as_deref() != Some(settings.rule_kind.as_str()) {
            return Ok(Applied::Idle);
        }
        match Row::read(settings, rule_id, &record.value) {
            Row::Off => Ok(Applied::Idle),
            row @ Row::Refused { .. } => Ok(Applied::Refused(row)),
            Row::On(rule) => {
                let Some(mut expired) = conditions.compile(&rule.when, &settings.fields.age_fact) else {
                    return Ok(Applied::Refused(Row::Refused { id: rule.id, field: settings.fields.expire_when.clone(), why: "cannot be compiled by the formula engine" }));
                };
                let mut walks = self.keep_walks.take();
                let stepped = self.keep_step(account, resource, &rule, now_ms, &mut *expired, &mut walks);
                *self.keep_walks.borrow_mut() = walks;
                stepped.map(Applied::Stepped)
            }
        }
    }

    /// One bounded step of `rule` at `now_ms`: the store's current records oldest first from where the last step stopped, up
    /// to the rule's `walk` of them; each of the rule's kind that `expired` decides (given its value and age) is destroyed,
    /// up to the rule's `page`.
    pub fn keep_step(&mut self, account: &str, resource: &str, rule: &Rule, now_ms: i64, expired: &mut dyn FnMut(&Json, u64) -> bool, walks: &mut Walks) -> Result<Kept, Error> {
        let from = walks.resume.get(&rule.id).copied().unwrap_or(0);
        let scope = vec![text(account), text(resource)];
        let mut start = scope.clone();
        start.push(Value::Integer(from));
        let range = Range { order: Order::Named("changed"), from: Bound::Included(start), to: Bound::Included(scope), reverse: false, limit: Some(rule.walk) };
        let rows = self
            .scan_rows(VERSIONS, &range, &[Field::whole("id"), Field::whole("valid_from"), Field::whole("kind"), Field::whole("deleted")])
            .map_err(unavailable)?;
        let walked = rows.len() as u64;
        let reached_end = rows.len() < rule.walk;
        let mut destroy = Vec::new();
        let mut last = from;
        for mut row in rows {
            let id = row.take(0).as_text().map(str::to_owned).ok_or(crate::cause!(Error::Unavailable))?;
            let at = row.take(1).as_integer().ok_or(crate::cause!(Error::Unavailable))?;
            let kind = row.take(2).as_text().map(str::to_owned);
            let gone = row.take(3).as_integer().unwrap_or(0) != 0;
            if destroy.len() >= rule.page {
                break;
            }
            last = at;
            if kind.as_deref() != Some(rule.kind.as_str()) || gone {
                continue;
            }
            let Some(record) = self.current_record(account, resource, &id)? else { continue };
            let age_ms = u64::try_from(now_ms.saturating_sub(super::stamp_ms(at) as i64)).unwrap_or(0);
            if expired(&record.value, age_ms) {
                destroy.push(id);
            }
        }
        let mut erased = 0;
        for id in &destroy {
            erased += self.erase_cascading(account, resource, id)?.len() as u64;
        }
        let done = reached_end && destroy.len() < rule.page;
        if done {
            walks.resume.remove(&rule.id);
        } else {
            // Past a run of records that share one stamp the walk would not move; step over them.
            let next = if last == from && walked as usize == rule.walk { last.saturating_add(1) } else { last };
            walks.resume.insert(rule.id.clone(), next);
        }
        Ok(Kept { rule: rule.id.clone(), erased, walked, done })
    }
}
