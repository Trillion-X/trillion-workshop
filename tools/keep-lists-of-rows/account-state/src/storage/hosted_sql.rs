// Purpose: The hosted-SQL supply of the storage boundary: every `Storage` operation over a SQLite database that a
// computer's host lends only through one statement call (`HostSql::exec`: a statement, its bound values, the rows it
// answers), with no transaction statements, no PRAGMA, no VACUUM and no file. A computer whose storage is such a database
// (a host that hands each running object its own SQLite and runs that object's synchronous work as one atomic unit)
// keeps an account's record store here through the same `Storage` seam the disk and memory supplies implement.
//
// Non-Negotiable Invariants:
// - Only the statement call reaches the database. Every statement is built from validated DATA names (`families.json`);
//   values are always bound parameters. A partial order's `only` condition is the one literal, as in `sqlite.rs`.
// - No statement opens, commits or rolls back a transaction, sets a PRAGMA or vacuums: the host refuses them. The host
//   decides atomicity (`HostSql::hold` / `release` bracket a scope; a host whose objects run each synchronous turn as
//   one unit does nothing there). A scope's rollback is this supply's own undo journal: before a write in a scope
//   changes a row, the row's whole prior image is read, and a rollback writes every image back newest first. So a
//   rollback never depends on the host offering one, and a crash in the middle of a scope is the host's: what it had
//   not made durable is gone with the turn.
// - Values cross the host as `Cell`s only (null, a 64-bit float, text, bytes), which every host language carries
//   exactly. A 64-bit integer never crosses as a number: it is bound as its decimal text under `+CAST(? AS INTEGER)` (no affinity, so an index serves it) and
//   read back as `CAST(field AS TEXT)` beside `typeof(field)`, so a stamp above 2^53 reads back exactly.
// - A put or an erase answers the rows it changed from the statement's own `RETURNING` rows, not from a host counter
//   (a host's written-rows counter also counts index entries).
// - A failed statement changes nothing and leaves the scope usable; a failed undo marks the scope failed and every
//   later operation is refused, so no write of a scope that could not be rolled back commits alone.
// - A bounded read never materializes an oversized value: `CASE WHEN octet_length(f)<=n THEN f END` plus the length.
//
// Key Concepts:
// - `HostSql`: the host's statement call and the few facts only the host knows (`mark`, `bytes`, `custody`,
//   `overwrites_removed`). The computer's adapter implements it over its host's API; `sqlite::hosted_stand_in` implements
//   it natively over a file with the same refusals, so `cargo test` runs this supply's conformance on any computer.
// - `Supply<H>`: the `Storage` implementation, with its undo journal and scope depth.
//
// Security Considerations:
// - Errors leave as `storage::Error`; nothing the host says about a failure is disclosed through them.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{Bound, Error, Family, Intent, Order, Range, Read, Result, Row, Schema, Storage, Value, When, ARRIVAL};
use std::{
    cell::{Cell as Flag, RefCell},
    fmt::Write as _,
};

/// One value as it crosses the host's statement call.
#[derive(Clone, Debug, PartialEq)]
pub enum Cell {
    Null,
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

/// The SQLite a host lends a computer: one statement call, and what only the host knows about its database.
pub trait HostSql {
    /// Run one statement with its bound values; every row it answers, its cells in column order.
    fn exec(&self, sql: &str, bind: &[Cell]) -> Result<Vec<Vec<Cell>>>;
    /// A scope opens: a host that needs a bracket for atomicity or isolation takes it (`Busy` when another handle holds
    /// the write reservation). A host that runs each turn of its object as one atomic unit does nothing.
    fn hold(&self, intent: Intent) -> Result<()>;
    /// The outermost scope closed (its undo, if any, already written): the host lets the bracket go and keeps what
    /// was written.
    fn release(&self) -> Result<()>;
    /// A mark that moves whenever another handle commits to this database (`Storage::mark`). A host whose database has
    /// one handle answers a constant.
    fn mark(&self) -> Result<i64>;
    /// The bytes the database occupies.
    fn bytes(&self) -> Result<u64>;
    /// The lent database is still the one opened.
    fn custody(&self) -> Result<()>;
    /// Whether a removal overwrites the removed bytes as it commits (`Storage::overwrites_removed`). A host that does
    /// not say answers false, and the record store keeps a destroyed record in custody.
    fn overwrites_removed(&self) -> bool;
}

/// Rows changed in a scope, with the image each had before (None: the row did not exist).
#[derive(Debug)]
struct Undo {
    family: &'static Family,
    key: Vec<Value>,
    before: Option<Vec<Value>>,
}

/// One hosted SQLite database implementing `Storage`.
pub struct Supply<H: HostSql> {
    host: H,
    schema: &'static Schema,
    value_bytes: usize,
    /// Open scopes: the outermost first, each with the journal length it opened at.
    scopes: RefCell<Vec<(Intent, usize)>>,
    journal: RefCell<Vec<Undo>>,
    failed: Flag<bool>,
    changes: Flag<u64>,
}

/// Open the hosted database for `schema` and create every declared family it does not hold yet. `value_bytes` bounds
/// one stored value (the host's own bound may be lower).
pub fn open<H: HostSql>(host: H, schema: &str, value_bytes: usize) -> Result<Supply<H>> {
    let schema = super::schema(schema)?;
    for statement in declared_tables(schema)? {
        host.exec(&statement, &[])?;
    }
    Ok(Supply {
        host,
        schema,
        value_bytes,
        scopes: RefCell::new(Vec::new()),
        journal: RefCell::new(Vec::new()),
        failed: Flag::new(false),
        changes: Flag::new(0),
    })
}

fn quoted(name: &str) -> String {
    format!("\"{name}\"")
}

/// The statements that create every declared family of a schema not there yet, one statement each: a table keyed by
/// the declared key (`WITHOUT ROWID`, or a rowid table with a unique key index when the family keeps arrival order)
/// and one index per named order, partial when the order declares `only` conditions. The same shape as `sqlite.rs`.
fn declared_tables(schema: &Schema) -> Result<Vec<String>> {
    let mut statements = Vec::new();
    for family in &schema.families {
        let table = quoted(&family.family);
        let fields: Vec<String> = family.fields.iter().map(|field| quoted(field)).collect();
        let key: Vec<String> = family.key.iter().map(|field| quoted(field)).collect();
        if family.arrival {
            statements.push(format!("CREATE TABLE IF NOT EXISTS {table}({})", fields.join(",")));
            statements.push(format!(
                "CREATE UNIQUE INDEX IF NOT EXISTS {} ON {table}({})",
                quoted(&format!("{}__key", family.family)),
                key.join(",")
            ));
        } else {
            statements.push(format!("CREATE TABLE IF NOT EXISTS {table}({},PRIMARY KEY({})) WITHOUT ROWID", fields.join(","), key.join(",")));
        }
        for (name, order) in &family.orders {
            let columns: Vec<String> = order.fields.iter().map(|field| quoted(field)).collect();
            let only = order.only.iter().map(|condition| only_condition(condition, None)).collect::<Result<Vec<_>>>()?;
            statements.push(format!(
                "CREATE INDEX IF NOT EXISTS {} ON {table}({}){}",
                quoted(&format!("{}__{name}", family.family)),
                columns.join(","),
                if only.is_empty() { String::new() } else { format!(" WHERE {}", only.join(" AND ")) }
            ));
        }
    }
    Ok(statements)
}

fn only_condition(condition: &super::Only, table: Option<&str>) -> Result<String> {
    let literal = match &condition.equals {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::String(text) => format!("'{}'", text.replace('\'', "''")),
        other => other.as_i64().ok_or(crate::cause!(Error::Undeclared))?.to_string(),
    };
    let field = match table {
        Some(table) => format!("{}.{}", quoted(table), quoted(&condition.field)),
        None => quoted(&condition.field),
    };
    Ok(format!("{field} IS {}{literal}", if condition.not { "NOT " } else { "" }))
}

/// A statement under construction: its text and its bound cells, each hole numbered by its position.
#[derive(Default)]
struct Sql {
    text: String,
    bind: Vec<Cell>,
}
impl Sql {
    /// The hole for one value. An integer travels as its decimal text and is cast back inside the statement.
    fn hole(&mut self, value: &Value) -> Result<String> {
        let (cell, integer) = match value {
            Value::Null => (Cell::Null, false),
            Value::Integer(v) => (Cell::Text(v.to_string()), true),
            Value::Real(v) => (Cell::Real(*v), false),
            Value::Text(v) => (Cell::Text(v.clone()), false),
            Value::Blob(v) => (Cell::Blob(v.clone()), false),
            Value::Oversized(_) => return Err(crate::cause!(Error::Invalid)),
        };
        self.bind.push(cell);
        let at = self.bind.len();
        // `+` drops the cast's INTEGER affinity: a comparison whose sides differ in affinity from the (typeless) column
        // cannot use an index, so a bare cast turned every integer bound into a scan of the whole key prefix (an exit
        // step read every replaced version of a resource, measured 2026-11-04: writes grew linearly with history).
        Ok(if integer { format!("+CAST(?{at} AS INTEGER)") } else { format!("?{at}") })
    }
    fn count(&mut self, n: usize) -> Result<String> {
        self.hole(&Value::Integer(i64::try_from(n).map_err(|error| crate::carry_cause!(Error::Invalid, error))?))
    }
}

/// The result columns of one field: its type, then its value with an integer as text.
fn exact(expression: &str) -> String {
    format!("typeof({expression}),CASE WHEN typeof({expression})='integer' THEN CAST({expression} AS TEXT) ELSE {expression} END")
}
/// The column text of one stored field of a family (`@arrival` is the rowid).
fn field_expression(family: &Family, field: &str) -> Result<String> {
    if field == ARRIVAL {
        if !family.arrival {
            return Err(crate::cause!(Error::Undeclared));
        }
        return Ok(format!("{}.rowid", quoted(&family.family)));
    }
    if !family.has(field) {
        return Err(crate::cause!(Error::Undeclared));
    }
    Ok(format!("{}.{}", quoted(&family.family), quoted(field)))
}
/// The result-column text of the requested reads: two columns a field (type, value), a third for a bounded read's
/// stored length, and the value left out (NULL) when it is longer than the bound.
fn columns(family: &Family, read: &[Read<'_>]) -> Result<String> {
    if read.is_empty() {
        return Err(crate::cause!(Error::Invalid));
    }
    let mut parts = Vec::with_capacity(read.len());
    for one in read {
        let field = field_expression(family, one.field)?;
        parts.push(match one.at_most {
            None => exact(&field),
            Some(bytes) => format!(
                "typeof({field}),CASE WHEN octet_length({field})<={bytes} THEN CASE WHEN typeof({field})='integer' THEN CAST({field} AS TEXT) ELSE {field} END END,CAST(octet_length({field}) AS TEXT)"
            ),
        });
    }
    Ok(parts.join(","))
}
/// One cell pair (type, value) back as a stored value.
fn value(kind: &Cell, cell: Cell) -> Result<Value> {
    let Cell::Text(kind) = kind else { return Err(crate::cause!(Error::Unavailable)) };
    Ok(match (kind.as_str(), cell) {
        ("null", _) => Value::Null,
        ("integer", Cell::Text(text)) => Value::Integer(text.parse().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?),
        ("real", Cell::Real(v)) => Value::Real(v),
        ("text", Cell::Text(v)) => Value::Text(v),
        ("blob", Cell::Blob(v)) => Value::Blob(v),
        // An empty blob may come back from a host as an empty array of bytes or as nothing at all.
        ("blob", Cell::Null) => Value::Blob(Vec::new()),
        _ => return Err(crate::cause!(Error::Unavailable)),
    })
}
fn decode(cells: Vec<Cell>, read: &[Read<'_>]) -> Result<Row> {
    let mut cells = cells.into_iter();
    let mut next = || cells.next().ok_or(crate::cause!(Error::Unavailable));
    let mut values = Vec::with_capacity(read.len());
    for one in read {
        let kind = next()?;
        let cell = next()?;
        if one.at_most.is_none() {
            values.push(value(&kind, cell)?);
            continue;
        }
        let length = next()?;
        values.push(match (&kind, cell) {
            (Cell::Text(kind), _) if kind == "null" => Value::Null,
            (_, Cell::Null) => match length {
                Cell::Text(bytes) => Value::Oversized(bytes.parse().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?),
                _ => return Err(crate::cause!(Error::Unavailable)),
            },
            (kind, cell) => value(kind, cell)?,
        });
    }
    Ok(Row(values))
}

/// The quoted cursor fields of an order and the conditions of a partial order.
fn cursor(family: &Family, order: Order<'_>) -> Result<(Vec<String>, Vec<String>)> {
    let field = |name: &str| format!("{}.{}", quoted(&family.family), quoted(name));
    match order {
        Order::Key => Ok((family.key.iter().map(|name| field(name)).collect(), Vec::new())),
        Order::Named(name) => {
            let order = family.order(name)?;
            let only = order.only.iter().map(|condition| only_condition(condition, Some(&family.family))).collect::<Result<Vec<_>>>()?;
            Ok((order.fields.iter().map(|name| field(name)).collect(), only))
        }
        Order::Arrival if family.arrival => Ok((vec![field("rowid")], Vec::new())),
        Order::Arrival => Err(crate::cause!(Error::Undeclared)),
    }
}
/// The WHERE text of a range (without ORDER BY or LIMIT), and its cursor fields.
fn range_condition(family: &Family, range: &Range<'_>, sql: &mut Sql) -> Result<(String, Vec<String>)> {
    let (fields, only) = cursor(family, range.order)?;
    let (lower, upper) = if range.reverse { (&range.to, &range.from) } else { (&range.from, &range.to) };
    let mut parts = Vec::new();
    for (bound, below) in [(lower, false), (upper, true)] {
        let (values, inclusive) = match bound {
            Bound::Unbounded => continue,
            Bound::Included(values) => (values, true),
            Bound::Excluded(values) => (values, false),
        };
        if values.is_empty() || values.len() > fields.len() {
            return Err(crate::cause!(Error::Invalid));
        }
        let operator = match (below, inclusive) {
            (false, true) => ">=",
            (false, false) => ">",
            (true, true) => "<=",
            (true, false) => "<",
        };
        let holes = values.iter().map(|one| sql.hole(one)).collect::<Result<Vec<_>>>()?;
        parts.push(format!("({}){operator}({})", fields[..values.len()].join(","), holes.join(",")));
    }
    parts.extend(only);
    let condition = if parts.is_empty() { String::new() } else { format!(" WHERE {}", parts.join(" AND ")) };
    Ok((condition, fields))
}
/// The WHERE text naming one row by its full key.
fn key_condition(family: &Family, key: &[Value], sql: &mut Sql) -> Result<String> {
    if key.len() != family.key.len() {
        return Err(crate::cause!(Error::Invalid));
    }
    let mut parts = Vec::with_capacity(key.len());
    for (field, one) in family.key.iter().zip(key) {
        let hole = sql.hole(one)?;
        parts.push(format!("{}.{}={hole}", quoted(&family.family), quoted(field)));
    }
    Ok(parts.join(" AND "))
}
/// Every stored field of a family, in declared order, with the rowid last for an arrival family: a row's whole image.
fn image_reads(family: &Family) -> Vec<Read<'_>> {
    let mut read: Vec<Read<'_>> = family.fields.iter().map(|field| Read::whole(field)).collect();
    if family.arrival {
        read.push(Read::whole(ARRIVAL));
    }
    read
}

impl<H: HostSql> Supply<H> {
    /// The host this supply runs on.
    pub fn host(&self) -> &H {
        &self.host
    }
    fn family(&self, name: &str) -> Result<&'static Family> {
        self.schema.family(name)
    }
    fn usable(&self) -> Result<()> {
        if self.failed.get() { Err(crate::cause!(Error::Unavailable)) } else { Ok(()) }
    }
    fn journaling(&self) -> bool {
        self.scopes.borrow().first().is_some_and(|(intent, _)| *intent == Intent::Write)
    }
    fn rows(&self, sql: &Sql, read: &[Read<'_>]) -> Result<Vec<Row>> {
        self.usable()?;
        self.host.exec(&sql.text, &sql.bind)?.into_iter().map(|cells| decode(cells, read)).collect()
    }
    /// Run a write statement ending in `RETURNING 1` and answer how many rows it changed.
    fn changed(&self, sql: &Sql) -> Result<u64> {
        self.usable()?;
        let n = self.host.exec(&sql.text, &sql.bind)?.len() as u64;
        self.changes.set(self.changes.get() + n);
        Ok(n)
    }
    fn check_bound(&self, value: &Value) -> Result<()> {
        let bytes = match value {
            Value::Text(text) => text.len(),
            Value::Blob(bytes) => bytes.len(),
            _ => 0,
        };
        if bytes > self.value_bytes { Err(crate::cause!(Error::TooBig)) } else { Ok(()) }
    }
    /// The whole image of the row at `key`, for the journal.
    fn image(&self, family: &'static Family, key: &[Value]) -> Result<Option<Vec<Value>>> {
        let read = image_reads(family);
        let mut sql = Sql::default();
        let condition = key_condition(family, key, &mut sql)?;
        sql.text = format!("SELECT {} FROM {} WHERE {condition} LIMIT 1", columns(family, &read)?, quoted(&family.family));
        Ok(self.rows(&sql, &read)?.pop().map(|row| row.0))
    }
    /// The key of a whole row image.
    fn key_of(family: &Family, image: &[Value]) -> Vec<Value> {
        family.key.iter().map(|key| image[family.fields.iter().position(|field| field == key).expect("a key field is declared")].clone()).collect()
    }
    /// Write every journal entry after `mark` back, newest first. A failure leaves the supply refusing everything.
    fn undo_to(&self, mark: usize) -> Result<()> {
        let undone: Vec<Undo> = self.journal.borrow_mut().drain(mark..).rev().collect();
        for entry in undone {
            let family = entry.family;
            let mut sql = Sql::default();
            let condition = key_condition(family, &entry.key, &mut sql)?;
            sql.text = format!("DELETE FROM {} WHERE {condition}", quoted(&family.family));
            let result = self.host.exec(&sql.text, &sql.bind).and_then(|_| {
                let Some(before) = entry.before else { return Ok(()) };
                let mut sql = Sql::default();
                let mut names: Vec<String> = family.fields.iter().map(|field| quoted(field)).collect();
                if family.arrival {
                    names.push("rowid".to_string());
                }
                let holes = before.iter().map(|one| sql.hole(one)).collect::<Result<Vec<_>>>()?;
                sql.text = format!("INSERT INTO {}({}) VALUES({})", quoted(&family.family), names.join(","), holes.join(","));
                self.host.exec(&sql.text, &sql.bind).map(|_| ())
            });
            if result.is_err() {
                self.failed.set(true);
                return Err(crate::cause!(Error::Unavailable));
            }
        }
        Ok(())
    }
}

impl<H: HostSql> Storage for Supply<H> {
    fn schema(&self) -> &'static Schema {
        self.schema
    }

    fn get(&self, family: &str, key: &[Value], read: &[Read<'_>]) -> Result<Option<Row>> {
        let family = self.family(family)?;
        let mut sql = Sql::default();
        let condition = key_condition(family, key, &mut sql)?;
        sql.text = format!("SELECT {} FROM {} WHERE {condition} LIMIT 1", columns(family, read)?, quoted(&family.family));
        Ok(self.rows(&sql, read)?.pop())
    }

    fn scan(&self, family: &str, range: &Range<'_>, read: &[Read<'_>]) -> Result<Vec<Row>> {
        let family = self.family(family)?;
        let columns = columns(family, read)?;
        let mut sql = Sql::default();
        let (condition, fields) = range_condition(family, range, &mut sql)?;
        let direction = if range.reverse { " DESC" } else { "" };
        let order: Vec<String> = fields.iter().map(|field| format!("{field}{direction}")).collect();
        sql.text = format!("SELECT {columns} FROM {}{condition} ORDER BY {}", quoted(&family.family), order.join(","));
        if let Some(limit) = range.limit {
            let hole = sql.count(limit)?;
            let _ = write!(sql.text, " LIMIT {hole}");
        }
        self.rows(&sql, read)
    }

    fn put(&self, family: &str, row: &[(&str, Value)], when: When<'_>) -> Result<u64> {
        let family = self.family(family)?;
        if row.iter().any(|(field, _)| !family.has(field)) {
            return Err(crate::cause!(Error::Undeclared));
        }
        if !family.key.iter().all(|key| row.iter().any(|(field, _)| field == key)) {
            return Err(crate::cause!(Error::Invalid));
        }
        for (_, value) in row {
            self.check_bound(value)?;
        }
        let is_key = |field: &str| family.key.iter().any(|key| key == field);
        let key: Vec<Value> = family.key.iter().map(|key| row.iter().find(|(field, _)| field == key).expect("checked above").1.clone()).collect();
        let table = quoted(&family.family);
        let mut sql = Sql::default();
        if let When::Matches(conditions) = when {
            let mut set = Vec::new();
            for (field, one) in row.iter().filter(|(field, _)| !is_key(field)) {
                let hole = sql.hole(one)?;
                set.push(format!("{}={hole}", quoted(field)));
            }
            if set.is_empty() {
                return Err(crate::cause!(Error::Invalid));
            }
            let mut matched = vec![key_condition(family, &key, &mut sql)?];
            for (field, one) in conditions {
                if !family.has(field) {
                    return Err(crate::cause!(Error::Undeclared));
                }
                if one.is_null() {
                    matched.push(format!("{table}.{} IS NULL", quoted(field)));
                } else {
                    let hole = sql.hole(one)?;
                    matched.push(format!("{table}.{}={hole}", quoted(field)));
                }
            }
            sql.text = format!("UPDATE {table} SET {} WHERE {} RETURNING 1", set.join(","), matched.join(" AND "));
        } else {
            let mut names = Vec::with_capacity(row.len());
            let mut holes = Vec::with_capacity(row.len());
            for (field, one) in row {
                holes.push(sql.hole(one)?);
                names.push(quoted(field));
            }
            let insert = format!("INTO {table}({}) VALUES({})", names.join(","), holes.join(","));
            sql.text = match when {
                When::New => format!("INSERT {insert} RETURNING 1"),
                When::Absent => format!("INSERT OR IGNORE {insert} RETURNING 1"),
                When::Always => {
                    let keys: Vec<String> = family.key.iter().map(|key| quoted(key)).collect();
                    let set: Vec<String> =
                        row.iter().filter(|(field, _)| !is_key(field)).map(|(field, _)| format!("{0}=excluded.{0}", quoted(field))).collect();
                    if set.is_empty() {
                        format!("INSERT {insert} ON CONFLICT({}) DO NOTHING RETURNING 1", keys.join(","))
                    } else {
                        format!("INSERT {insert} ON CONFLICT({}) DO UPDATE SET {} RETURNING 1", keys.join(","), set.join(","))
                    }
                }
                When::Matches(_) => unreachable!("handled above"),
            };
        }
        let before = if self.journaling() { Some(self.image(family, &key)?) } else { None };
        let changed = self.changed(&sql)?;
        if let (Some(before), true) = (before, changed > 0) {
            self.journal.borrow_mut().push(Undo { family, key, before });
        }
        Ok(changed)
    }

    fn count(&self, family: &str, range: &Range<'_>) -> Result<u64> {
        let family = self.family(family)?;
        let mut sql = Sql::default();
        let (condition, _) = range_condition(family, range, &mut sql)?;
        let mut source = format!("SELECT 1 FROM {}{condition}", quoted(&family.family));
        if let Some(limit) = range.limit {
            let hole = sql.count(limit)?;
            let _ = write!(source, " LIMIT {hole}");
        }
        sql.text = format!("SELECT CAST(count(*) AS TEXT) FROM ({source})");
        self.usable()?;
        match self.host.exec(&sql.text, &sql.bind)?.pop().and_then(|mut row| row.pop()) {
            Some(Cell::Text(n)) => n.parse().map_err(|error| crate::carry_cause!(Error::Unavailable, error)),
            _ => Err(crate::cause!(Error::Unavailable)),
        }
    }

    fn erase(&self, family: &str, range: &Range<'_>) -> Result<u64> {
        let family = self.family(family)?;
        if range.limit.is_some() {
            return Err(crate::cause!(Error::Invalid));
        }
        if self.journaling() {
            let read = image_reads(family);
            let columns = columns(family, &read)?;
            let mut sql = Sql::default();
            let (condition, _) = range_condition(family, range, &mut sql)?;
            sql.text = format!("SELECT {columns} FROM {}{condition}", quoted(&family.family));
            let images = self.rows(&sql, &read)?;
            let mut sql = Sql::default();
            let (condition, _) = range_condition(family, range, &mut sql)?;
            sql.text = format!("DELETE FROM {}{condition} RETURNING 1", quoted(&family.family));
            let changed = self.changed(&sql)?;
            let mut journal = self.journal.borrow_mut();
            for Row(image) in images {
                journal.push(Undo { family, key: Self::key_of(family, &image), before: Some(image) });
            }
            return Ok(changed);
        }
        let mut sql = Sql::default();
        let (condition, _) = range_condition(family, range, &mut sql)?;
        sql.text = format!("DELETE FROM {}{condition} RETURNING 1", quoted(&family.family));
        self.changed(&sql)
    }

    fn present(&self, family: &str) -> Result<bool> {
        let family = self.family(family)?;
        self.usable()?;
        let rows = self.host.exec("SELECT type FROM sqlite_master WHERE name=?1", &[Cell::Text(family.family.clone())])?;
        match rows.first().and_then(|row| row.first()) {
            None => Ok(false),
            Some(Cell::Text(kind)) if kind == "table" => Ok(true),
            _ => Err(crate::cause!(Error::Unavailable)),
        }
    }

    fn custody(&self) -> Result<()> {
        self.usable()?;
        self.host.custody()
    }

    fn location(&self) -> Option<&str> {
        None
    }

    fn scoped(&self) -> bool {
        !self.scopes.borrow().is_empty()
    }

    fn writing(&self) -> Result<bool> {
        Ok(self.journaling())
    }

    fn changes(&self) -> u64 {
        self.changes.get()
    }

    fn mark(&self) -> Result<i64> {
        self.usable()?;
        self.host.mark()
    }

    fn schema_mark(&self) -> Result<i64> {
        // The declared shape is the catalogue's text: a family added, altered or dropped changes its count or length.
        self.usable()?;
        let rows = self.host.exec("SELECT CAST(count(*) AS TEXT),CAST(coalesce(sum(length(sql)),0) AS TEXT) FROM sqlite_master", &[])?;
        let number = |cell: Option<&Cell>| match cell {
            Some(Cell::Text(n)) => n.parse::<i64>().map_err(|error| crate::carry_cause!(Error::Unavailable, error)),
            _ => Err(crate::cause!(Error::Unavailable)),
        };
        let row = rows.first().ok_or(crate::cause!(Error::Unavailable))?;
        Ok(number(row.first())?.wrapping_mul(1 << 32).wrapping_add(number(row.get(1))?))
    }

    fn allocated_bytes(&self) -> Result<u64> {
        self.usable()?;
        self.host.bytes()
    }

    fn overwrites_removed(&self) -> Result<bool> {
        self.usable()?;
        Ok(self.host.overwrites_removed())
    }

    fn open_scope(&self, intent: Intent) -> Result<()> {
        self.usable()?;
        let mut scopes = self.scopes.borrow_mut();
        match (intent, scopes.len()) {
            (Intent::Nested, 0) | (Intent::Read | Intent::Write, 1..) => return Err(crate::cause!(Error::Invalid)),
            (Intent::Nested, _) => {}
            (_, _) => self.host.hold(intent)?,
        }
        scopes.push((intent, self.journal.borrow().len()));
        Ok(())
    }

    fn close_scope(&self, commit: bool) -> Result<()> {
        self.usable()?;
        let Some((_, mark)) = self.scopes.borrow().last().copied() else { return Err(crate::cause!(Error::Invalid)) };
        if !commit {
            self.undo_to(mark)?;
        }
        let mut scopes = self.scopes.borrow_mut();
        scopes.pop();
        if scopes.is_empty() {
            self.journal.borrow_mut().clear();
            if self.host.release().is_err() {
                self.failed.set(true);
                return Err(crate::cause!(Error::Unavailable));
            }
        }
        Ok(())
    }
}
