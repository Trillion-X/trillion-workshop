// src/storage/memory.rs
//
// Purpose: The in-memory supply of the storage boundary: every `Storage` operation over ordered maps built from the
// same DATA declarations in `families.json`, so an owner's logic runs unchanged on memory and on SQLite (the
// conformance suite's first adapter, plan CP11 adapter C).
//
// Non-Negotiable Invariants:
// - The same contract as the SQLite supply: declared names only, SQLite's value order (NULL < numbers < text <
//   blob), row-value range bounds over an order's cursor fields (a prefix allowed; a NULL where the comparison would be decided answers nothing),
//   partial orders holding only the rows their `only` conditions match, bounded reads returning `Oversized`.
// - A scope is atomic: every row change inside it is undone, newest first, when it rolls back or when the handle is
//   dropped with the scope open (a crash). Committed state is shared by every handle `reopen` makes, so a restart is
//   a new handle on the same committed rows.
// - Handles are isolated as the SQLite supply's connections are (WAL): one handle at a time holds the write
//   reservation (a `Write` scope, or the first write of a `Read` scope), and every other handle's write is refused
//   with `Busy` while it is held, never interleaved with it. Another handle reads only committed rows, never the
//   held writer's changes; a `Read` scope reads the rows committed when it opened, whatever commits after. A write
//   inside a `Read` scope takes the reservation only while nothing has committed since the scope opened (otherwise
//   `Busy`, as SQLite answers a stale snapshot). Rows change where they are under the writer; the committed image of each
//   row it changed is kept beside them until it commits or rolls back, and so is the opening image of each row
//   changed under an open `Read` scope.
// - Removed rows leave the maps at once; `reclaim` has no free space to rewrite.
//
// Key Concepts:
// - `Memory`: one handle; `Memory::open(schema)` makes new empty storage, `reopen` another handle on it.
// - Per family: rows by primary key, one ordered map per named order (order fields, then the key), arrival positions.
//
// Security Considerations:
// - Test and simulation storage: nothing persists past the process, and nothing here is an account authority.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{Bound, Error, Family, Intent, Order, Range, Read, Result, Row, Schema, Storage, Value, When, ARRIVAL};
use std::{
    cell::{Cell, RefCell},
    cmp::Ordering,
    collections::BTreeMap,
    sync::{Arc, Mutex, MutexGuard},
};

/// SQLite's order of one value: NULL, then numbers (integers and reals compared by value), then text (bytewise),
/// then blobs (bytewise).
fn compare(left: &Value, right: &Value) -> Ordering {
    fn rank(value: &Value) -> u8 {
        match value {
            Value::Null => 0,
            Value::Integer(_) | Value::Real(_) => 1,
            Value::Text(_) => 2,
            Value::Blob(_) => 3,
            Value::Oversized(_) => 4,
        }
    }
    match (left, right) {
        (Value::Integer(a), Value::Integer(b)) => a.cmp(b),
        (Value::Integer(a), Value::Real(b)) => (*a as f64).total_cmp(b),
        (Value::Real(a), Value::Integer(b)) => a.total_cmp(&(*b as f64)),
        (Value::Real(a), Value::Real(b)) => a.total_cmp(b),
        (Value::Text(a), Value::Text(b)) => a.as_bytes().cmp(b.as_bytes()),
        (Value::Blob(a), Value::Blob(b)) => a.cmp(b),
        _ => rank(left).cmp(&rank(right)),
    }
}

/// A tuple of values in SQLite's order, compared element by element.
#[derive(Clone, Debug)]
struct Key(Vec<Value>);
impl PartialEq for Key {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Key {}
impl PartialOrd for Key {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Key {
    fn cmp(&self, other: &Self) -> Ordering {
        for (left, right) in self.0.iter().zip(&other.0) {
            match compare(left, right) {
                Ordering::Equal => {}
                unequal => return unequal,
            }
        }
        self.0.len().cmp(&other.0.len())
    }
}

/// One stored row: its arrival position and its values in declared field order.
#[derive(Clone, Debug)]
struct Stored {
    arrival: i64,
    values: Vec<Value>,
}

#[derive(Clone, Default)]
struct Table {
    rows: BTreeMap<Key, Stored>,
    /// Per named order: (order fields, then key fields) -> key.
    orders: BTreeMap<String, BTreeMap<Key, Key>>,
    /// Arrival position -> key (families declaring arrival order).
    arrivals: BTreeMap<i64, Key>,
    next_arrival: i64,
}

/// Earlier images of rows, per family: key -> the row it held (None: no row).
type Images = BTreeMap<String, BTreeMap<Key, Option<Stored>>>;

/// What a `Read` scope reads: the rows committed when it opened.
struct Snapshot {
    /// The commit count when the scope opened; a write inside the scope needs it unchanged.
    commits: i64,
    /// The opening image of every row changed since (or held changed by the writer when it opened).
    images: Images,
}

#[derive(Default)]
struct State {
    tables: BTreeMap<String, Table>,
    commits: i64,
    bytes: u64,
    /// The handle holding the write reservation.
    writer: Option<u64>,
    /// The committed image of every row the holding writer has changed in its open scope.
    held: Images,
    /// The open `Read` scopes by handle.
    snapshots: BTreeMap<u64, Snapshot>,
}

/// Record `before` as the earlier image of `key` unless one is already kept.
fn keep(images: &mut Images, family: &str, key: &Key, before: &Option<Stored>) {
    images.entry(family.to_owned()).or_default().entry(key.clone()).or_insert_with(|| before.clone());
}

/// Handle identities, so the shared state can tell the writer and each reader apart.
static HANDLES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// One undone change: the row a key held before (None: no row).
struct Undo {
    family: &'static Family,
    key: Key,
    before: Option<Stored>,
}

/// One in-memory storage handle.
pub struct Memory {
    state: Arc<Mutex<State>>,
    id: u64,
    schema: &'static Schema,
    /// Open scopes, outermost first: the intent and where its undo entries start.
    scopes: RefCell<Vec<(Intent, usize)>>,
    scope_ids: RefCell<Vec<u64>>,
    undo: RefCell<Vec<Undo>>,
    changes: Cell<u64>,
    /// Commits this handle made, so its mark moves only for other handles' commits (as SQLite's `data_version`).
    own_commits: Cell<i64>,
}

impl Memory {
    /// New empty storage holding every family of `schema`.
    pub fn open(schema: &str) -> Result<Self> {
        let schema = super::schema(schema)?;
        let mut state = State::default();
        for family in &schema.families {
            let mut table = Table::default();
            for name in family.orders.keys() {
                table.orders.insert(name.clone(), BTreeMap::new());
            }
            state.tables.insert(family.family.clone(), table);
        }
        Ok(Self::handle(Arc::new(Mutex::new(state)), schema))
    }

    /// Another handle on the same committed rows (a restart after this handle is dropped).
    pub fn reopen(&self) -> Self {
        Self::handle(self.state.clone(), self.schema)
    }

    fn handle(state: Arc<Mutex<State>>, schema: &'static Schema) -> Self {
        Self {
            state,
            id: HANDLES.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            schema,
            scopes: RefCell::new(Vec::new()),
            scope_ids: RefCell::new(Vec::new()),
            undo: RefCell::new(Vec::new()),
            changes: Cell::new(0),
            own_commits: Cell::new(0),
        }
    }

    /// Take or confirm the write reservation before a write: refused (`Busy`) while another handle holds it, or inside
    /// a `Read` scope whose rows are no longer the committed ones. Outside a scope a write is its own commit and takes
    /// nothing.
    fn claim(&self, state: &mut State) -> Result<()> {
        match state.writer {
            Some(holder) if holder == self.id => return Ok(()),
            Some(_) => return Err(crate::cause!(Error::Busy)),
            None => {}
        }
        if self.scopes.borrow().is_empty() {
            return Ok(());
        }
        if state.snapshots.get(&self.id).is_some_and(|snapshot| snapshot.commits != state.commits) {
            return Err(crate::cause!(Error::Busy));
        }
        state.snapshots.remove(&self.id);
        state.writer = Some(self.id);
        Ok(())
    }

    /// The earlier images this handle reads instead of the rows as they are: none for the writer; a `Read` scope's
    /// opening images; otherwise the committed images of the rows another handle holds changed.
    fn images<'s>(&self, state: &'s State) -> Option<&'s Images> {
        if state.writer == Some(self.id) {
            return None;
        }
        state.snapshots.get(&self.id).map(|snapshot| &snapshot.images).or(Some(&state.held))
    }

    /// The table of `family` as this handle reads it: as it is, or a copy with the earlier images put back when some
    /// rows of the family changed out of this handle's view.
    fn view<'s>(&self, state: &'s State, family: &'static Family) -> Result<std::borrow::Cow<'s, Table>> {
        let table = state.tables.get(&family.family).ok_or(crate::cause!(Error::Undeclared))?;
        let Some(images) = self.images(state).and_then(|images| images.get(&family.family)).filter(|rows| !rows.is_empty())
        else {
            return Ok(std::borrow::Cow::Borrowed(table));
        };
        let mut copy = table.clone();
        for (key, before) in images {
            place(family, &mut copy, key, before.clone());
        }
        Ok(std::borrow::Cow::Owned(copy))
    }

    fn state(&self) -> Result<MutexGuard<'_, State>> {
        self.state.lock().map_err(|error| crate::carry_cause!(Error::Unavailable, error))
    }

    fn family(&self, name: &str) -> Result<&'static Family> {
        self.schema.family(name)
    }

    /// Replace the row at `key` (None removes it), keeping orders, arrival and byte totals, and recording the undo
    /// entry while a scope is open.
    fn write(&self, state: &mut State, family: &'static Family, key: Key, row: Option<Vec<Value>>) -> Result<()> {
        let table = state.tables.get_mut(&family.family).ok_or(crate::cause!(Error::Undeclared))?;
        let arrival = match table.rows.get(&key) {
            Some(old) => old.arrival,
            None => {
                table.next_arrival += 1;
                table.next_arrival
            }
        };
        let before = place(family, table, &key, row.map(|values| Stored { arrival, values }));
        let removed = before.as_ref().map_or(0, |old| bytes(&old.values));
        let added = table.rows.get(&key).map_or(0, |new| bytes(&new.values));
        state.bytes = state.bytes.saturating_sub(removed).saturating_add(added);
        for (reader, snapshot) in state.snapshots.iter_mut() {
            if *reader != self.id {
                keep(&mut snapshot.images, &family.family, &key, &before);
            }
        }
        if self.scopes.borrow().is_empty() {
            // Outside a scope the write is its own commit.
            state.commits += 1;
            self.own_commits.set(self.own_commits.get() + 1);
        } else {
            if state.writer == Some(self.id) {
                keep(&mut state.held, &family.family, &key, &before);
            }
            self.undo.borrow_mut().push(Undo { family, key, before });
        }
        self.changes.set(self.changes.get() + 1);
        Ok(())
    }

    /// The keys of the rows a range selects, in walk order.
    fn select(&self, table: &Table, family: &'static Family, range: &Range<'_>) -> Result<Vec<Key>> {
        let (lower, upper) = if range.reverse { (&range.to, &range.from) } else { (&range.from, &range.to) };
        let limit = range.limit.unwrap_or(usize::MAX);
        let mut found = Vec::new();
        let mut take = |cursor: &[Value], key: &Key| -> Option<()> {
            if found.len() >= limit {
                return None;
            }
            match (meets(cursor, lower, true), meets(cursor, upper, false)) {
                (Meets::Yes, Meets::Yes) => found.push(key.clone()),
                // Decided to be past the far end in walk direction: stop. A row the bound cannot answer (a NULL decides
                // it) is only skipped; the rows after it may still be inside.
                (_, Meets::Beyond) if !range.reverse => return None,
                (Meets::Beyond, _) if range.reverse => return None,
                _ => {}
            }
            Some(())
        };
        let start = |bound: &Bound| match bound {
            Bound::Included(values) | Bound::Excluded(values) => Some(Key(values.clone())),
            Bound::Unbounded => None,
        };
        match range.order {
            Order::Key => walk(&table.rows, start(lower), range.reverse, upper, |key, _| take(&key.0, key)),
            Order::Named(name) => {
                let cursor = family.order(name)?.fields.len();
                let order = table.orders.get(name).ok_or(crate::cause!(Error::Undeclared))?;
                walk(order, start(lower), range.reverse, upper, |entry, key| take(&entry.0[..cursor], key))
            }
            Order::Arrival if family.arrival => {
                let first = start(lower).and_then(|key| key.0.first().and_then(Value::as_integer));
                let entries: Box<dyn Iterator<Item = (&i64, &Key)>> = match (range.reverse, first) {
                    (false, Some(first)) => Box::new(table.arrivals.range(first..)),
                    (false, None) => Box::new(table.arrivals.iter()),
                    (true, _) => Box::new(table.arrivals.iter().rev()),
                };
                for (position, key) in entries {
                    if take(&[Value::Integer(*position)], key).is_none() {
                        break;
                    }
                }
            }
            Order::Arrival => return Err(crate::cause!(Error::Undeclared)),
        }
        Ok(found)
    }
}

/// Walk an ordered map from `start` (forward) or from its end (reverse; an `Excluded` upper bound starts the walk
/// before every key extending it), until `visit` answers None.
fn walk<V>(
    map: &BTreeMap<Key, V>,
    start: Option<Key>,
    reverse: bool,
    upper: &Bound,
    mut visit: impl FnMut(&Key, &V) -> Option<()>,
) {
    use std::ops::Bound as Edge;
    let entries: Box<dyn Iterator<Item = (&Key, &V)>> = match (reverse, start, upper) {
        (false, Some(start), _) => Box::new(map.range((Edge::Included(start), Edge::Unbounded))),
        (false, None, _) => Box::new(map.iter()),
        (true, _, Bound::Excluded(values)) => {
            Box::new(map.range((Edge::Unbounded, Edge::Excluded(Key(values.clone())))).rev())
        }
        (true, _, _) => Box::new(map.iter().rev()),
    };
    for (key, value) in entries {
        if visit(key, value).is_none() {
            break;
        }
    }
}

/// How a cursor meets one end of a range.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Meets {
    /// The comparison holds.
    Yes,
    /// The comparison is decided and does not hold.
    Beyond,
    /// A NULL sits where the comparison would be decided, so there is no answer and the row is not selected.
    NoAnswer,
}

/// How a cursor meets one end of a range (an unbounded end always holds). SQLite's row-value comparison over the
/// bound's prefix: it is decided at the first position where the two sides differ, and a NULL on either side at a
/// position reached with every earlier position equal is no answer. A NULL after the deciding position does not matter.
fn meets(cursor: &[Value], bound: &Bound, lower: bool) -> Meets {
    let (values, inclusive) = match bound {
        Bound::Unbounded => return Meets::Yes,
        Bound::Included(values) => (values, true),
        Bound::Excluded(values) => (values, false),
    };
    if values.len() > cursor.len() {
        return Meets::NoAnswer;
    }
    for (row, edge) in cursor.iter().zip(values) {
        if row.is_null() || edge.is_null() {
            return Meets::NoAnswer;
        }
        match compare(row, edge) {
            Ordering::Equal => {}
            order if (order == Ordering::Greater) == lower => return Meets::Yes,
            _ => return Meets::Beyond,
        }
    }
    if inclusive {
        Meets::Yes
    } else {
        Meets::Beyond
    }
}

/// Whether a row belongs to a partial order.
fn holds(family: &Family, values: &[Value], only: &[super::Only]) -> bool {
    only.iter().all(|condition| {
        let at = family.fields.iter().position(|field| *field == condition.field);
        let value = at.and_then(|at| values.get(at)).unwrap_or(&Value::Null);
        let equal = match &condition.equals {
            serde_json::Value::Null => value.is_null(),
            serde_json::Value::String(text) => value.as_text() == Some(text.as_str()),
            other => other.as_i64().is_some_and(|number| value.as_integer() == Some(number)),
        };
        equal != condition.not
    })
}

/// Put `row` at `key` (None removes it) and keep every order and the arrival map; returns the row it replaced.
fn place(family: &Family, table: &mut Table, key: &Key, row: Option<Stored>) -> Option<Stored> {
    let entry = |values: &[Value], fields: &[String]| {
        let mut entry: Vec<Value> = fields
            .iter()
            .map(|field| {
                family.fields.iter().position(|known| known == field).map_or(Value::Null, |at| values[at].clone())
            })
            .collect();
        entry.extend(key.0.iter().cloned());
        Key(entry)
    };
    let before = table.rows.remove(key);
    if let Some(old) = &before {
        for (name, order) in &family.orders {
            if let Some(map) = table.orders.get_mut(name) {
                map.remove(&entry(&old.values, &order.fields));
            }
        }
        if family.arrival {
            table.arrivals.remove(&old.arrival);
        }
    }
    if let Some(new) = row {
        for (name, order) in &family.orders {
            if holds(family, &new.values, &order.only) {
                if let Some(map) = table.orders.get_mut(name) {
                    map.insert(entry(&new.values, &order.fields), key.clone());
                }
            }
        }
        if family.arrival {
            table.arrivals.insert(new.arrival, key.clone());
        }
        table.rows.insert(key.clone(), new);
    }
    before
}

/// SQLite's `octet_length` of a value (numbers by their text form); None for NULL.
fn octets(value: &Value) -> Option<usize> {
    match value {
        Value::Null => None,
        Value::Integer(number) => Some(number.to_string().len()),
        Value::Real(number) => Some(number.to_string().len()),
        Value::Text(text) => Some(text.len()),
        Value::Blob(blob) => Some(blob.len()),
        Value::Oversized(bytes) => Some(*bytes as usize),
    }
}
fn bytes(values: &[Value]) -> u64 {
    values.iter().map(|value| octets(value).unwrap_or(0) as u64).sum()
}

/// The requested reads of one stored row.
fn project(family: &Family, stored: &Stored, read: &[Read<'_>]) -> Result<Row> {
    if read.is_empty() {
        return Err(crate::cause!(Error::Invalid));
    }
    let mut values = Vec::with_capacity(read.len());
    for one in read {
        let value = if one.field == ARRIVAL {
            if !family.arrival {
                return Err(crate::cause!(Error::Undeclared));
            }
            Value::Integer(stored.arrival)
        } else {
            let at = family.fields.iter().position(|field| field == one.field).ok_or(crate::cause!(Error::Undeclared))?;
            stored.values[at].clone()
        };
        values.push(match (one.at_most, octets(&value)) {
            (Some(limit), Some(length)) if length > limit => Value::Oversized(length as u64),
            _ => value,
        });
    }
    Ok(Row(values))
}

impl Storage for Memory {
    fn schema(&self) -> &'static Schema {
        self.schema
    }

    fn get(&self, family: &str, key: &[Value], read: &[Read<'_>]) -> Result<Option<Row>> {
        let family = self.family(family)?;
        if key.len() != family.key.len() {
            return Err(crate::cause!(Error::Invalid));
        }
        let state = self.state()?;
        let table = state.tables.get(&family.family).ok_or(crate::cause!(Error::Undeclared))?;
        let key = Key(key.to_vec());
        let earlier = self.images(&state).and_then(|images| images.get(&family.family)).and_then(|rows| rows.get(&key));
        let stored = match earlier {
            Some(before) => before.as_ref(),
            None => table.rows.get(&key),
        };
        stored.map(|stored| project(family, stored, read)).transpose()
    }

    fn scan(&self, family: &str, range: &Range<'_>, read: &[Read<'_>]) -> Result<Vec<Row>> {
        let family = self.family(family)?;
        let state = self.state()?;
        let table = self.view(&state, family)?;
        let keys = self.select(&table, family, range)?;
        keys.iter()
            .map(|key| table.rows.get(key).ok_or(crate::cause!(Error::Unavailable)).and_then(|stored| project(family, stored, read)))
            .collect()
    }

    fn put(&self, family: &str, row: &[(&str, Value)], when: When<'_>) -> Result<u64> {
        let family = self.family(family)?;
        if row.iter().any(|(field, _)| !family.has(field)) {
            return Err(crate::cause!(Error::Undeclared));
        }
        if row.iter().any(|(_, value)| matches!(value, Value::Oversized(_))) {
            return Err(crate::cause!(Error::Invalid));
        }
        let mut key = Vec::with_capacity(family.key.len());
        for field in &family.key {
            key.push(row.iter().find(|(name, _)| name == field).map(|(_, value)| value.clone()).ok_or(crate::cause!(Error::Invalid))?);
        }
        let key = Key(key);
        let mut state = self.state()?;
        self.claim(&mut state)?;
        let table = state.tables.get(&family.family).ok_or(crate::cause!(Error::Undeclared))?;
        let existing = table.rows.get(&key).map(|stored| stored.values.clone());
        let assign = |mut values: Vec<Value>| {
            for (field, value) in row {
                if let Some(at) = family.fields.iter().position(|known| known == field) {
                    values[at] = value.clone();
                }
            }
            values
        };
        let next = match (when, existing) {
            (When::New, Some(_)) => return Err(crate::cause!(Error::Conflict)),
            (When::Absent, Some(_)) => return Ok(0),
            (When::Always, Some(values)) => assign(values),
            (When::Matches(conditions), existing) => {
                if row.iter().all(|(field, _)| family.key.iter().any(|key| key == field)) {
                    return Err(crate::cause!(Error::Invalid));
                }
                let Some(values) = existing else { return Ok(0) };
                for (field, expected) in conditions {
                    let at = family.fields.iter().position(|known| known == field).ok_or(crate::cause!(Error::Undeclared))?;
                    let same = if expected.is_null() {
                        values[at].is_null()
                    } else {
                        !values[at].is_null() && compare(&values[at], expected) == Ordering::Equal
                    };
                    if !same {
                        return Ok(0);
                    }
                }
                assign(values)
            }
            (When::New | When::Absent | When::Always, None) => assign(vec![Value::Null; family.fields.len()]),
        };
        self.write(&mut state, family, key, Some(next))?;
        Ok(1)
    }

    fn count(&self, family: &str, range: &Range<'_>) -> Result<u64> {
        let family = self.family(family)?;
        let state = self.state()?;
        let table = self.view(&state, family)?;
        Ok(self.select(&table, family, range)?.len() as u64)
    }

    fn erase(&self, family: &str, range: &Range<'_>) -> Result<u64> {
        let family = self.family(family)?;
        if range.limit.is_some() {
            return Err(crate::cause!(Error::Invalid));
        }
        let mut state = self.state()?;
        self.claim(&mut state)?;
        let table = state.tables.get(&family.family).ok_or(crate::cause!(Error::Undeclared))?;
        let keys = self.select(table, family, range)?;
        for key in &keys {
            self.write(&mut state, family, key.clone(), None)?;
        }
        Ok(keys.len() as u64)
    }

    fn present(&self, family: &str) -> Result<bool> {
        let family = self.family(family)?;
        Ok(self.state()?.tables.contains_key(&family.family))
    }

    fn prepare_declared_families(&self, names: &[&str]) -> Result<()> {
        if !self.scoped() || !self.writing()? {
            return Err(crate::cause!(Error::Unavailable));
        }
        // Shapes are interpreted from the immutable declaration on each call;
        // this supply has no delayed physical schema change to perform.
        for name in names {
            self.family(name)?;
        }
        self.custody()
    }

    fn custody(&self) -> Result<()> {
        Ok(())
    }

    fn location(&self) -> Option<&str> {
        None
    }

    fn scoped(&self) -> bool {
        !self.scopes.borrow().is_empty()
    }

    fn writing(&self) -> Result<bool> {
        Ok(self.scopes.borrow().first().is_some_and(|(intent, _)| *intent == Intent::Write))
    }

    fn changes(&self) -> u64 {
        self.changes.get()
    }

    /// Moves only when another handle commits (this handle's own commits are taken out), as SQLite's
    /// `data_version`: an owner caching what it read can keep its cache across its own writes.
    fn mark(&self) -> Result<i64> {
        Ok(self.state()?.commits - self.own_commits.get())
    }

    fn schema_mark(&self) -> Result<i64> {
        Ok(0)
    }

    fn allocated_bytes(&self) -> Result<u64> {
        Ok(self.state()?.bytes)
    }

    fn reclaim(&self) -> Result<()> {
        if self.scoped() {
            return Err(crate::cause!(Error::Invalid));
        }
        Ok(())
    }

    fn reclaim_step(&self, _pages: u64) -> Result<u64> {
        if self.scoped() {
            return Err(crate::cause!(Error::Invalid));
        }
        Ok(0)
    }

    fn checkpoint(&self) -> Result<super::Checkpoint> {
        self.custody()?;
        if !self.writing()? { return Err(crate::cause!(Error::Unavailable)); }
        self.open_scope(Intent::Nested)?;
        let scope = *self.scope_ids.borrow().last().ok_or(crate::cause!(Error::Unavailable))?;
        Ok(super::Checkpoint::new((self.id, scope)))
    }

    fn close_checkpoint(&self, checkpoint: super::Checkpoint, commit: bool) -> Result<()> {
        let (handle, scope) = checkpoint.take::<(u64, u64)>()?;
        if handle != self.id || self.scope_ids.borrow().last() != Some(&scope) {
            return Err(crate::cause!(Error::Unavailable));
        }
        self.close_scope(commit)
    }

    fn open_scope(&self, intent: Intent) -> Result<()> {
        let mut scopes = self.scopes.borrow_mut();
        match (intent, scopes.is_empty()) {
            (Intent::Nested, true) | (Intent::Read | Intent::Write, false) => return Err(crate::cause!(Error::Invalid)),
            _ => {}
        }
        let scope_id = super::checkpoint_number()?;
        let mut state = self.state()?;
        match intent {
            Intent::Write => match state.writer {
                Some(holder) if holder != self.id => return Err(crate::cause!(Error::Busy)),
                _ => state.writer = Some(self.id),
            },
            Intent::Read => {
                // The rows committed now: as they are, except those the holding writer changed, whose committed images
                // it keeps.
                let snapshot = Snapshot { commits: state.commits, images: state.held.clone() };
                state.snapshots.insert(self.id, snapshot);
            }
            Intent::Nested => {}
        }
        scopes.push((intent, self.undo.borrow().len()));
        self.scope_ids.borrow_mut().push(scope_id);
        Ok(())
    }

    fn close_scope(&self, commit: bool) -> Result<()> {
        let (_, start) = self.scopes.borrow_mut().pop().ok_or(crate::cause!(Error::Invalid))?;
        self.scope_ids.borrow_mut().pop().ok_or(crate::cause!(Error::Invalid))?;
        let outermost = self.scopes.borrow().is_empty();
        let mut state = self.state()?;
        if outermost {
            state.snapshots.remove(&self.id);
        }
        let holding = state.writer == Some(self.id);
        if commit {
            if outermost {
                self.undo.borrow_mut().clear();
                if holding {
                    state.commits += 1;
                    self.own_commits.set(self.own_commits.get() + 1);
                    state.held.clear();
                    state.writer = None;
                }
            }
            return Ok(());
        }
        let undone: Vec<Undo> = self.undo.borrow_mut().drain(start..).collect();
        for Undo { family, key, before } in undone.into_iter().rev() {
            let table = state.tables.get_mut(&family.family).ok_or(crate::cause!(Error::Undeclared))?;
            let added = before.as_ref().map_or(0, |row| bytes(&row.values));
            let after = place(family, table, &key, before);
            let removed = after.as_ref().map_or(0, |row| bytes(&row.values));
            state.bytes = state.bytes.saturating_sub(removed).saturating_add(added);
        }
        if outermost && holding {
            state.held.clear();
            state.writer = None;
        }
        Ok(())
    }
}

impl Drop for Memory {
    /// A handle dropped with a scope open is a crash: its uncommitted changes are undone.
    fn drop(&mut self) {
        while self.scoped() {
            if self.close_scope(false).is_err() {
                break;
            }
        }
    }
}
