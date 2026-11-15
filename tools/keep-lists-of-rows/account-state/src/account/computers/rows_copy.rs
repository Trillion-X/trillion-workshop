//! The account's own rows (`account/rows/families.json`: the computers rows, family `places`, and the account's lists,
//! family `lists`) at every computer that may answer it.
//!
//! These rows say who holds the account (the computers row), how many copies it keeps (the copy rule's rows) and what it
//! may use (its limits row), so every computer that may answer reads the same ones. This file keeps them in step. It has
//! two parts:
//!
//! - **The copy log** (`Log`), in the computer's own rows (family `places`): one row per account row that ever changed,
//!   id `copy_prefix` + family + `:` + id, holding the newest change of that row (`RowChange`: its stamp and the row
//!   after it, or `None` when it is gone). A counter row (`copied_row`) holds the computer's rows stamp and the newest
//!   writer term it took row changes from. A gone row keeps its log row (the tombstone), so a copy that was away learns
//!   of the removal. A page of the feed is every log row after a stamp, oldest first.
//! - **The account's view** (`CopiedRows`), the storage the account's owners read and write its rows through. With no
//!   copies running it passes everything through. With copies running (`attach`) it sends every change of a copied row to
//!   the account's copies (`Copies::rows_write`), which make it only at the writer and only as one unit with its
//!   acknowledgement. The writer row copy and the log itself pass through.
//!
//! The rules live in `copies.rs` (who may write, the acknowledgement); this file only moves rows. A computer that holds
//! a copy but may not answer gets none of these rows: `copies.rs` never sends them there.

use super::{
    copies::Copies,
    messages::{RowBody, RowChange},
    settings,
};
use crate::account::rows::store::Family;
use crate::storage::{Bound, Error, Intent, Order, Range, Read, Result, Row, Schema, Storage, Value, When};
use std::sync::{Arc, OnceLock, Weak};

/// The family every log row and the counter row live in: the computers rows.
pub(crate) fn computers() -> &'static str {
    Family::Computers.name()
}

/// Whether `family` is one of the account's own row families, every one of which travels.
fn kept_family(family: &str) -> bool {
    Family::ALL.iter().any(|kept| kept.name() == family)
}

/// Whether the row `id` of `family` travels to the other computers that may answer: every row of the account's own
/// families but the copies' own bookkeeping (the writer row, the log rows and the counter row).
pub(crate) fn copied(family: &str, id: &str) -> bool {
    if !kept_family(family) {
        return false;
    }
    let settings = settings();
    family != computers() || !(id.starts_with(&settings.writer_row_prefix) || id.starts_with(&settings.copy_prefix) || id == settings.copied_row)
}

/// The counter row: this computer's rows stamp, the newest writer term it took row changes from (or took itself), and
/// that term's base (the rows stamp its writer held when it took it).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Counter {
    pub stamp: u64,
    #[serde(rename = "lease")] pub term: u64,
    #[serde(default)]
    pub base: u64,
}

/// The copy log and the copied rows over the computer's own rows storage (never the account's view).
pub(crate) struct Log<'a> {
    pub raw: &'a dyn Storage,
    pub owner: &'a str,
}

fn exact(id: &str) -> Range<'static> {
    Range { order: Order::Key, from: Bound::Included(vec![Value::from(id)]), to: Bound::Included(vec![Value::from(id)]), reverse: false, limit: None }
}

fn text_of(value: Value) -> Result<String> {
    match value {
        Value::Text(text) => Ok(text),
        _ => Err(crate::cause!(Error::Invalid)),
    }
}

impl Log<'_> {
    /// The row `id` of `family` as it is stored (expired or not).
    pub fn row(&self, family: &str, id: &str) -> Result<Option<RowBody>> {
        let read = [Read::whole("account"), Read::whole("expires_at"), Read::whole("value")];
        let Some(mut row) = self.raw.get(family, &[Value::from(id)], &read)? else { return Ok(None) };
        let account = text_of(row.take(0))?;
        let expires_at = row.take(1).as_integer().ok_or(crate::cause!(Error::Invalid))?;
        let value = text_of(row.take(2))?;
        Ok(Some(RowBody { account, expires_at, value }))
    }

    fn put_row(&self, family: &str, id: &str, body: &RowBody) -> Result<()> {
        let row = [
            ("id", Value::from(id)),
            ("account", Value::from(body.account.as_str())),
            ("expires_at", Value::Integer(body.expires_at)),
            ("value", Value::Text(body.value.clone())),
        ];
        self.raw.put(family, &row, When::Always).map(|_| ())
    }

    fn remove_row(&self, family: &str, id: &str) -> Result<()> {
        self.raw.erase(family, &exact(id)).map(|_| ())
    }

    pub fn counter(&self) -> Result<Counter> {
        Ok(match self.row(computers(), &settings().copied_row)? {
            Some(body) => serde_json::from_str(&body.value).map_err(|error| crate::carry_cause!(Error::Invalid, error))?,
            None => Counter::default(),
        })
    }

    pub fn set_counter(&self, counter: Counter) -> Result<()> {
        let value = serde_json::to_string(&counter).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        self.put_row(computers(), &settings().copied_row, &RowBody { account: self.owner.to_string(), expires_at: 0, value })
    }

    fn log_id(family: &str, id: &str) -> String {
        format!("{}{family}:{id}", settings().copy_prefix)
    }

    /// The log row of `family`/`id`, when the row ever changed here.
    pub fn logged(&self, family: &str, id: &str) -> Result<Option<RowChange>> {
        self.row(computers(), &Self::log_id(family, id))?
            .map(|body| serde_json::from_str(&body.value).map_err(|error| crate::carry_cause!(Error::Invalid, error)))
            .transpose()
    }

    /// Write one change: the row itself (or its removal) and its log row. The counter is the caller's.
    pub fn apply(&self, change: &RowChange) -> Result<()> {
        if !copied(&change.family, &change.id) {
            return Err(crate::cause!(Error::Invalid));
        }
        match &change.row {
            Some(body) => self.put_row(&change.family, &change.id, body)?,
            None => self.remove_row(&change.family, &change.id)?,
        }
        let value = serde_json::to_string(change).map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        self.put_row(computers(), &Self::log_id(&change.family, &change.id), &RowBody { account: self.owner.to_string(), expires_at: 0, value })
    }

    /// Every log row, in stamp order.
    pub fn all(&self) -> Result<Vec<RowChange>> {
        let prefix = &settings().copy_prefix;
        let read = [Read::whole("id"), Read::whole("value")];
        let mut found = Vec::new();
        for mut row in self.raw.scan(computers(), &Range::all(), &read)? {
            let id = text_of(row.take(0))?;
            if id.starts_with(prefix.as_str()) {
                found.push(serde_json::from_str::<RowChange>(&text_of(row.take(1))?).map_err(|error| crate::carry_cause!(Error::Invalid, error))?);
            }
        }
        found.sort_by_key(|change| change.seq);
        Ok(found)
    }

    /// One page of the feed: log rows after `after`, oldest first, at most `limit`; and whether more follow.
    pub fn page(&self, after: u64, limit: usize) -> Result<(Vec<RowChange>, bool)> {
        let mut changes: Vec<RowChange> = self.all()?.into_iter().filter(|change| change.seq > after).collect();
        let more = changes.len() > limit;
        changes.truncate(limit);
        Ok((changes, more))
    }

    /// The ids of every copied row this computer holds, by family.
    pub fn copied_rows(&self) -> Result<Vec<(String, String)>> {
        let mut found = Vec::new();
        for family in Family::ALL {
            let family = family.name();
            for mut row in self.raw.scan(family, &Range::all(), &[Read::whole("id")])? {
                let id = text_of(row.take(0))?;
                if copied(family, &id) {
                    found.push((family.to_string(), id));
                }
            }
        }
        Ok(found)
    }

    /// Give every copied row that has no log row one, stamped after the counter (a computer that becomes the writer does
    /// this first, so its feed holds every row it has, including rows made before copies ran). The writer also does this
    /// on each of its timer steps (`copies.rs` `tick`): a row made at the writer's folder outside its copies gets its log
    /// row then, and so travels. Outside the computers rows (whose change is a change of who holds the account, made only
    /// through the writer's acknowledged edit), a row whose value differs from its log row, or that is gone while its log
    /// row holds it, gets a new log row too. Answers the new stamp.
    pub fn log_unlogged_rows(&self) -> Result<u64> {
        let mut counter = self.counter()?;
        for (family, id, row) in self.unlogged()? {
            counter.stamp += 1;
            self.apply(&RowChange { seq: counter.stamp, family, id, row })?;
        }
        self.set_counter(counter)?;
        Ok(counter.stamp)
    }

    /// The changes of copied rows made at this computer outside its copies, as `log_unlogged_rows` would log them: each
    /// copied row with no log row, or (outside the computers rows) whose value differs from its log row, with its body;
    /// and each row its log row holds that is gone (`None`). Read only. Empty when every copied row travelled.
    pub fn unlogged(&self) -> Result<Vec<(String, String, Option<RowBody>)>> {
        let mut found = Vec::new();
        let held = self.copied_rows()?;
        for (family, id) in &held {
            let Some(body) = self.row(family, id)? else { continue };
            match self.logged(family, id)? {
                None => {}
                Some(logged) if family != computers() && logged.row.as_ref() != Some(&body) => {}
                Some(_) => continue,
            }
            found.push((family.clone(), id.clone(), Some(body)));
        }
        let held: std::collections::HashSet<(String, String)> = held.into_iter().collect();
        for change in self.all()? {
            if change.family == computers() || change.row.is_none() || held.contains(&(change.family.clone(), change.id.clone())) {
                continue;
            }
            found.push((change.family, change.id, None));
        }
        Ok(found)
    }

    /// The read-back of this computer's copied rows, as old trillion read a carried copy back before it switched
    /// (Trillion-X/trillion src/resource-state-carry.mjs: counts and identities): for each copied family, in name order,
    /// how many rows this computer holds and the BLAKE3 of their ids in order.
    pub fn census(&self) -> Result<Vec<(String, u64, String)>> {
        let mut by_family: std::collections::BTreeMap<String, Vec<String>> =
            Family::ALL.iter().map(|family| (family.name().to_string(), Vec::new())).collect();
        for (family, id) in self.copied_rows()? {
            by_family.entry(family).or_default().push(id);
        }
        Ok(by_family.into_iter().map(|(family, mut ids)| {
            ids.sort();
            let mut hasher = content_crypto::advanced::blake3::Hasher::new();
            for id in &ids {
                hasher.update(id.as_bytes());
                hasher.update(&[0]);
            }
            (family, ids.len() as u64, hasher.finalize().to_hex().to_string())
        }).collect())
    }

    /// After a copy started again from nothing (`copies.rs`, a writer whose history does not hold this copy's): remove
    /// every copied row and log row the writer's feed did not name (`kept`).
    pub fn drop_unnamed(&self, kept: &std::collections::HashSet<(String, String)>) -> Result<usize> {
        let mut dropped = 0;
        for (family, id) in self.copied_rows()? {
            if !kept.contains(&(family.clone(), id.clone())) {
                self.remove_row(&family, &id)?;
                dropped += 1;
            }
        }
        for change in self.all()? {
            if !kept.contains(&(change.family.clone(), change.id.clone())) {
                self.remove_row(computers(), &Self::log_id(&change.family, &change.id))?;
            }
        }
        Ok(dropped)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The account's view.

/// What the account's owner asked to change, as the copies take it.
#[derive(Clone, Debug)]
pub(crate) enum Expect {
    /// Replace or make the row.
    Any,
    /// Make the row only when it is not there; when it is, the change is refused as a conflict (`When::New`).
    New,
    /// Make the row only when it is not there; when it is, nothing changes (`When::Absent`).
    Absent,
    /// Change the row only while its stored value is still this text (`When::Matches` on `value`).
    Value(String),
}

/// One change the account's owner asked for: the row of `family`/`id` after it (`None`: removed), and what must hold first.
#[derive(Clone, Debug)]
pub(crate) struct Asked {
    pub family: String,
    pub id: String,
    pub row: Option<RowBody>,
    pub expect: Expect,
}

/// The storage the account's own rows are kept in at a computer: see the module doc.
pub(crate) struct CopiedRows {
    raw: Arc<dyn Storage + Send + Sync>,
    copies: OnceLock<Weak<Copies>>,
    /// A row of the computers family was written while no copies ran: the account's row may name voters now, so its
    /// copies start before the next request is answered (`take_computers_written`), not on the computer's next step.
    computers_written: std::sync::atomic::AtomicBool,
}

impl CopiedRows {
    /// The account's view over the computer's own rows storage `raw`. Until copies attach, it passes everything through.
    pub(crate) fn new(raw: Arc<dyn Storage + Send + Sync>) -> Arc<Self> {
        Arc::new(CopiedRows { raw, copies: OnceLock::new(), computers_written: std::sync::atomic::AtomicBool::new(false) })
    }

    /// The computer's own rows storage, under this view (the copies keep their writer row and log there).
    pub(crate) fn raw(&self) -> &Arc<dyn Storage + Send + Sync> {
        &self.raw
    }

    /// Send every later change of a copied row through `copies`. Only the first attach counts.
    pub(crate) fn attach(&self, copies: &Arc<Copies>) {
        let _ = self.copies.set(Arc::downgrade(copies));
    }

    /// Whether a row of the computers family was written since this was last asked while no copies ran (see
    /// `computers_written`).
    pub(crate) fn take_computers_written(&self) -> bool {
        self.computers_written.swap(false, std::sync::atomic::Ordering::AcqRel)
    }

    fn running(&self) -> Option<Arc<Copies>> {
        self.copies.get().and_then(Weak::upgrade)
    }

    fn put_asked(&self, family: &str, row: &[(&str, Value)], when: When<'_>) -> Result<Option<Asked>> {
        let field = |name: &str| row.iter().find(|(field, _)| *field == name).map(|(_, value)| value.clone());
        let Some(Value::Text(id)) = field("id") else { return Ok(None) };
        if !copied(family, &id) {
            return Ok(None);
        }
        let (Some(Value::Text(account)), Some(Value::Integer(expires_at)), Some(Value::Text(value))) = (field("account"), field("expires_at"), field("value")) else {
            return Err(crate::cause!(Error::Invalid));
        };
        let expect = match when {
            When::Always => Expect::Any,
            When::New => Expect::New,
            When::Absent => Expect::Absent,
            When::Matches(fields) => match fields {
                [("value", Value::Text(expected))] => Expect::Value(expected.clone()),
                _ => return Err(crate::cause!(Error::Invalid)),
            },
        };
        Ok(Some(Asked { family: family.to_string(), id, row: Some(RowBody { account, expires_at, value }), expect }))
    }
}

impl Storage for CopiedRows {
    fn schema(&self) -> &'static Schema {
        self.raw.schema()
    }

    fn get(&self, family: &str, key: &[Value], read: &[Read<'_>]) -> Result<Option<Row>> {
        self.raw.get(family, key, read)
    }

    fn scan(&self, family: &str, range: &Range<'_>, read: &[Read<'_>]) -> Result<Vec<Row>> {
        self.raw.scan(family, range, read)
    }

    fn put(&self, family: &str, row: &[(&str, Value)], when: When<'_>) -> Result<u64> {
        let Some(copies) = self.running() else {
            let put = self.raw.put(family, row, when)?;
            if family == computers() {
                self.computers_written.store(true, std::sync::atomic::Ordering::Release);
            }
            return Ok(put);
        };
        match self.put_asked(family, row, when)? {
            Some(asked) => copies.rows_write(vec![asked]),
            None => self.raw.put(family, row, when),
        }
    }

    fn count(&self, family: &str, range: &Range<'_>) -> Result<u64> {
        self.raw.count(family, range)
    }

    fn erase(&self, family: &str, range: &Range<'_>) -> Result<u64> {
        let Some(copies) = self.running() else { return self.raw.erase(family, range) };
        if !kept_family(family) {
            return self.raw.erase(family, range);
        }
        let mut asked = Vec::new();
        let mut kept = Vec::new();
        for mut row in self.raw.scan(family, range, &[Read::whole("id")])? {
            let id = text_of(row.take(0))?;
            if copied(family, &id) {
                asked.push(Asked { family: family.to_string(), id, row: None, expect: Expect::Any });
            } else {
                kept.push(id);
            }
        }
        let mut removed = 0;
        for id in kept {
            removed += self.raw.erase(family, &exact(&id))?;
        }
        if !asked.is_empty() {
            removed += copies.rows_write(asked)?;
        }
        Ok(removed)
    }

    fn present(&self, family: &str) -> Result<bool> {
        self.raw.present(family)
    }
    fn custody(&self) -> Result<()> {
        self.raw.custody()
    }
    fn location(&self) -> Option<&str> {
        None
    }
    fn scoped(&self) -> bool {
        self.raw.scoped()
    }
    fn writing(&self) -> Result<bool> {
        self.raw.writing()
    }
    fn changes(&self) -> u64 {
        self.raw.changes()
    }
    fn mark(&self) -> Result<i64> {
        self.raw.mark()
    }
    fn schema_mark(&self) -> Result<i64> {
        self.raw.schema_mark()
    }
    fn allocated_bytes(&self) -> Result<u64> {
        self.raw.allocated_bytes()
    }
    fn open_scope(&self, intent: Intent) -> Result<()> {
        // A scope would hold changes of copied rows back from the copies: none is opened over this view while copies run.
        if self.running().is_some() {
            return Err(crate::cause!(Error::Unavailable));
        }
        self.raw.open_scope(intent)
    }
    fn close_scope(&self, commit: bool) -> Result<()> {
        self.raw.close_scope(commit)
    }
}

/// A test's payload: one row of the account's lists (family `lists`), the kind of row the copies tests change.
#[cfg(test)]
pub(crate) fn test_list_row(account: &str, id: &str, text: &str) -> crate::account::rows::store::Row<serde_json::Value> {
    crate::account::rows::store::Row { id: id.into(), account: account.into(), expires_at: 0, value: serde_json::json!({ "text": text }) }
}

/// Whether a computer's own rows `raw` hold the list row `id` (a test's read, past the account's view).
#[cfg(test)]
pub(crate) fn holds_list_row(raw: &dyn Storage, id: &str) -> bool {
    crate::account::rows::store::Store::new(raw).get::<serde_json::Value>(Family::Lists, id).unwrap().is_some()
}
