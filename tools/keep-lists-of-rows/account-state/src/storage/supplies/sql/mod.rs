// src/storage/supplies/sql/mod.rs
//
// Purpose: One `Storage` supply for every relational server, written once over a small `Wire` (run a statement, read
// rows, count round trips). Postgres, CockroachDB, MySQL and MariaDB each provide only a `Wire`; the families, keys,
// orders, partial orders, bounded reads, compare-and-set puts and scopes are built here from the DATA declarations.
//
// Non-Negotiable Invariants:
// - Every field is one byte column (`codec` ordered form for key and order fields, plain form for the rest), so the
//   server compares by memcmp and the contract's value order holds on a server that has no dynamic typing.
// - A declared name is quoted, never caller text; every value is a bound parameter or a hex literal built from DATA.
// - A write scope takes the writer reservation with one statement that also moves the commit mark: the row of
//   `_storage_meta` is updated first, and a second writer waits only the lock timeout and then gets `Busy`. The
//   opening statements are owed until the scope's first operation and travel in the same request as that operation,
//   so `Busy` is reported by the scope's first operation.
// - A failed statement leaves its scope usable (the contract's scope rule). On a server that aborts a whole transaction
//   at one failed statement (PostgreSQL, CockroachDB) every statement inside a scope runs between a savepoint and its
//   release in the same request, and a failure rolls back to the savepoint. A batch of writes is statements in one
//   request, each with its own savepoint, so a refusal leaves the writes before it done, as asked one at a time.
// - A partial order is a server partial index where the server has one (Postgres, CockroachDB), and an indexed
//   generated membership column where it has none (MySQL, MariaDB). Both answer the same scan.
// - No driver error type crosses this boundary: `Wire` implementations map their errors to `storage::Error`.
//
// Key Concepts:
// - `Dialect`: the few spellings that differ (placeholders, quoting, byte literals, upsert, savepoints).
// - `Wire`: the driver seam. `rounds` counts network round trips, so the cost of an operation is measured, not guessed.
//   Its `pipeline` runs several statements in one request, stopping at the first failure; `read_many` sends a mixed
//   list of gets and ranges that way (a run of gets of one family becomes one `IN` statement).
// - `Supply<W>`: the `Storage` implementation.
//
// Security Considerations:
// - Statements are built only from validated DATA names and bound values.
// - A connection that dies with a scope open rolls the scope back on the server: a dropped handle is a crash.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::layout::{layouts, FamilyLayout};
use local_engine::storage::{
    Bound, Error, Family, Intent, Order, Query, Range, Read, Reply, Result, Row, Schema, Storage, Value, When, Write, ARRIVAL,
};
use std::{
    cell::{Cell as Counter, RefCell},
    collections::{HashMap, HashSet},
    fmt::Write as _,
};

/// A bound statement parameter.
#[derive(Clone, Debug)]
pub enum Param {
    Bytes(Vec<u8>),
    Int(i64),
}

/// One result cell.
#[derive(Clone, Debug)]
pub enum Cell {
    Null,
    Bytes(Vec<u8>),
    Int(i64),
}

/// What a statement answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// Rows (a `SELECT`).
    Rows,
    /// The number of rows it changed or matched.
    Changed,
}

/// One statement of a pipeline: its text with the server's placeholders, the parameters they name in order of
/// appearance, and what it answers.
#[derive(Clone, Debug)]
pub struct Step {
    pub sql: String,
    pub params: Vec<Param>,
    pub shape: Shape,
}
impl Step {
    fn rows(sql: &Sql) -> Self {
        Self { sql: sql.text.clone(), params: sql.params.clone(), shape: Shape::Rows }
    }
    fn changed(sql: &Sql) -> Self {
        Self { sql: sql.text.clone(), params: sql.params.clone(), shape: Shape::Changed }
    }
    /// A statement with no parameters that answers a count (scope control).
    fn plain(sql: impl Into<String>) -> Self {
        Self { sql: sql.into(), params: Vec::new(), shape: Shape::Changed }
    }
}

/// What a pipeline's statement answered, in the order the statements were sent.
#[derive(Clone, Debug)]
pub enum Answer {
    Rows(Vec<Vec<Cell>>),
    Changed(u64),
}

/// The server flavors a `Wire` can speak to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    Postgres,
    Cockroach,
    MySql,
    MariaDb,
    /// SQLite and its servers (libSQL).
    Sqlite,
}
impl Dialect {
    fn postgres_family(self) -> bool {
        matches!(self, Self::Postgres | Self::Cockroach)
    }
    /// Placeholders are numbered (`$1`); the others are positional (`?`).
    fn numbered(self) -> bool {
        self.postgres_family()
    }
    /// The server has partial indexes and `ON CONFLICT` upserts.
    fn conflict_style(self) -> bool {
        self.postgres_family() || self == Self::Sqlite
    }
    /// The function that counts a byte column's bytes.
    fn length(self) -> &'static str {
        if self == Self::Sqlite {
            "length"
        } else {
            "octet_length"
        }
    }
    fn quote(self, name: &str) -> String {
        if self.conflict_style() {
            format!("\"{name}\"")
        } else {
            format!("`{name}`")
        }
    }
    /// A byte string as a literal of the server's byte type.
    fn literal(self, bytes: &[u8]) -> String {
        let mut hex = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            let _ = write!(hex, "{byte:02x}");
        }
        if self.postgres_family() {
            format!("'\\x{hex}'::bytea")
        } else {
            format!("x'{hex}'")
        }
    }
}

/// The driver seam of a relational supply.
pub trait Wire {
    fn dialect(&self) -> Dialect;
    /// Run the statements in order, in one network round trip where the protocol allows several statements in a
    /// request (a wire may split a very large request into more). The first failure ends the run: the statements
    /// after it do not run, and the error is returned. One answer per statement otherwise.
    fn pipeline(&self, steps: &[Step]) -> Result<Vec<Answer>>;
    /// Run statements that take no parameters and return nothing (DDL, maintenance).
    fn script(&self, statements: &[String]) -> Result<()>;
    /// Network round trips made so far.
    fn rounds(&self) -> u64;
    /// Provider-unit observations for actual wire requests, when the driver
    /// exposes them. This does not estimate server capacity from round trips.
    fn measurements(&self) -> Vec<crate::provider_units::Observation> { Vec::new() }
    fn measurement_count(&self) -> usize { self.measurements().len() }
    fn measurements_since(&self, index: usize) -> Vec<crate::provider_units::Observation> { self.measurements().into_iter().skip(index).collect() }
    /// Where the data lives, without credentials.
    fn place(&self) -> String;
}

/// The cursor columns of an order: the quoted name and, for a declared field, its position in the family.
type Columns = Vec<(String, Option<usize>)>;

/// A statement being built: its text and the parameters its placeholders name, in order of appearance.
struct Sql {
    dialect: Dialect,
    text: String,
    params: Vec<Param>,
}
impl Sql {
    fn new(dialect: Dialect) -> Self {
        Self { dialect, text: String::new(), params: Vec::new() }
    }
    fn text(&mut self, text: &str) -> &mut Self {
        self.text.push_str(text);
        self
    }
    fn param(&mut self, param: Param) -> &mut Self {
        self.params.push(param);
        if self.dialect.numbered() {
            let _ = write!(self.text, "${}", self.params.len());
        } else {
            self.text.push('?');
        }
        self
    }
}

const META: &str = "_storage_meta";
/// The savepoint each statement runs inside on a server that aborts a transaction at one failed statement.
const UNIT: &str = "storage_unit";
/// The savepoint that marks the end of a scope's opening on the other servers.
const OPENED: &str = "storage_opened";
/// Most bound parameters one statement carries (the smallest limit of the servers here is SQLite's 32,766).
const PARAMETERS: usize = 10_000;
/// MySQL and MariaDB refuse an index key above 3072 bytes; ordered columns share what a family's widest index leaves.
const KEY_BUDGET: usize = 3000;

/// One relational handle implementing `Storage`.
pub struct Supply<W: Wire> {
    wire: W,
    dialect: Dialect,
    schema: &'static Schema,
    layouts: Vec<FamilyLayout>,
    /// Open scopes, outermost first.
    scopes: RefCell<Vec<Intent>>,
    /// The outermost scope's opening statements, not sent yet: they go out with the scope's first operation.
    owed: RefCell<Option<Intent>>,
    /// The byte total of the meta row as of the last request in this scope that changed rows. A request that changes
    /// rows also reads it (one more statement in the same request), so `allocated_bytes` right after a write costs no
    /// round trip. Unknown (None) when a scope opens, after a failure and after a nested rollback.
    bytes: Counter<Option<i64>>,
    changes: Counter<u64>,
    /// Write scopes this handle committed, each of which moved the meta row's commit count by one: `mark` takes them
    /// out, so it moves only for other handles' commits (as SQLite's `data_version`).
    own_commits: Counter<i64>,
    uid: Vec<u8>,
    place: String,
    /// A close that failed leaves the server transaction unknown: later closes are refused.
    failed: Counter<bool>,
}

impl<W: Wire> Supply<W> {
    /// Open the schema on this connection, creating its tables, indexes and meta row if they do not exist yet.
    pub fn open(wire: W, schema: &str) -> Result<Self> {
        let schema = local_engine::storage::schema(schema)?;
        let dialect = wire.dialect();
        let layouts = layouts(schema);
        let place = wire.place();
        let mut supply = Self {
            wire,
            dialect,
            schema,
            layouts,
            scopes: RefCell::new(Vec::new()),
            owed: RefCell::new(None),
            bytes: Counter::new(None),
            changes: Counter::new(0),
            own_commits: Counter::new(0),
            uid: Vec::new(),
            place,
            failed: Counter::new(false),
        };
        // Servers that retry-or-abort concurrent schema changes (CockroachDB) may refuse a first attempt.
        let mut attempt = 0;
        while let Err(error) = supply.create() {
            attempt += 1;
            if !matches!(error, Error::Busy(_)) || attempt >= 8 {
                return Err(error);
            }
            std::thread::sleep(std::time::Duration::from_millis(100 * attempt));
        }
        supply.uid = supply.read_uid()?;
        Ok(supply)
    }

    /// Network round trips made through this handle's connection so far.
    pub fn rounds(&self) -> u64 {
        self.wire.rounds()
    }

    /// Provider-unit observations captured by the underlying wire adapter.
    pub fn measurements(&self) -> Vec<crate::provider_units::Observation> { self.wire.measurements() }
    pub fn measurement_count(&self) -> usize { self.wire.measurement_count() }
    pub fn measurements_since(&self, index: usize) -> Vec<crate::provider_units::Observation> { self.wire.measurements_since(index) }

    fn q(&self, name: &str) -> String {
        self.dialect.quote(name)
    }

    fn key_width(&self) -> usize {
        let parts = self
            .schema
            .families
            .iter()
            .map(|family| family.key.len().max(family.orders.values().map(|order| order.fields.len() + family.key.len()).max().unwrap_or(0)))
            .max()
            .unwrap_or(1);
        (KEY_BUDGET / parts).min(700)
    }

    fn member(&self, order: &str) -> String {
        self.q(&format!("@member_{order}"))
    }

    /// The `only` conditions of a partial order as SQL over the family's columns.
    fn only_sql(&self, layout: &FamilyLayout, only: &[local_engine::storage::Only]) -> Result<String> {
        let mut parts = Vec::new();
        for condition in only {
            let (at, bytes) = layout.condition(condition)?;
            parts.push(format!(
                "{} {} {}",
                self.q(&layout.family.fields[at]),
                if condition.not { "<>" } else { "=" },
                self.dialect.literal(&bytes)
            ));
        }
        Ok(parts.join(" AND "))
    }

    /// The statements that make every declared family of the schema.
    fn ddl(&self) -> Result<Vec<String>> {
        let mut statements = Vec::new();
        let width = self.key_width();
        let postgres = self.dialect.postgres_family();
        let sqlite = self.dialect == Dialect::Sqlite;
        statements.push(if postgres {
            format!(
                "CREATE TABLE IF NOT EXISTS {META}(id integer PRIMARY KEY, uid bytea NOT NULL, commits bigint NOT NULL, bytes bigint NOT NULL)"
            )
        } else if sqlite {
            format!("CREATE TABLE IF NOT EXISTS {META}(id INTEGER PRIMARY KEY, uid BLOB NOT NULL, commits INTEGER NOT NULL, bytes INTEGER NOT NULL)")
        } else {
            format!(
                "CREATE TABLE IF NOT EXISTS {META}(id INT PRIMARY KEY, uid VARBINARY(64) NOT NULL, commits BIGINT NOT NULL, bytes BIGINT NOT NULL) ENGINE=InnoDB"
            )
        });
        for layout in &self.layouts {
            let family = layout.family;
            let table = self.q(&family.family);
            let mut columns = Vec::new();
            for (at, field) in family.fields.iter().enumerate() {
                let kind = match (postgres, sqlite, layout.is_ordered(at)) {
                    (true, _, _) => "bytea".to_string(),
                    (_, true, _) => "BLOB".to_string(),
                    (_, _, true) => format!("VARBINARY({width})"),
                    (_, _, false) => "LONGBLOB".to_string(),
                };
                columns.push(format!("{} {kind} NOT NULL", self.q(field)));
            }
            if family.arrival {
                columns.push(if postgres {
                    format!("{} bigint GENERATED ALWAYS AS IDENTITY UNIQUE", self.q("@arrival"))
                } else if sqlite {
                    format!("{} INTEGER PRIMARY KEY AUTOINCREMENT", self.q("@arrival"))
                } else {
                    format!("{} BIGINT NOT NULL AUTO_INCREMENT UNIQUE", self.q("@arrival"))
                });
            }
            let key: Vec<String> = family.key.iter().map(|field| self.q(field)).collect();
            let mut inline = Vec::new();
            let mut after = Vec::new();
            for (name, order) in &family.orders {
                let cursor: Vec<String> = order.fields.iter().map(|field| self.q(field)).collect();
                let only = self.only_sql(layout, &order.only)?;
                let index = self.q(&format!("{}__{name}", family.family));
                if self.dialect.conflict_style() {
                    let predicate = if only.is_empty() { String::new() } else { format!(" WHERE {only}") };
                    after.push(format!(
                        "CREATE INDEX IF NOT EXISTS {index} ON {table}({}){predicate}",
                        cursor.join(",")
                    ));
                } else if only.is_empty() {
                    inline.push(format!("KEY {index}({})", cursor.join(",")));
                } else {
                    let member = self.member(name);
                    columns.push(format!("{member} TINYINT GENERATED ALWAYS AS ({only}) VIRTUAL"));
                    inline.push(format!("KEY {index}({member},{})", cursor.join(",")));
                }
            }
            let mut body = columns;
            body.push(format!("{}({})", if sqlite && family.arrival { "UNIQUE" } else { "PRIMARY KEY" }, key.join(",")));
            body.extend(inline);
            statements.push(format!(
                "CREATE TABLE IF NOT EXISTS {table}({}){}",
                body.join(","),
                if postgres {
                    ""
                } else if sqlite {
                    if family.arrival { "" } else { " WITHOUT ROWID" }
                } else {
                    " ENGINE=InnoDB"
                }
            ));
            statements.extend(after);
            if self.dialect == Dialect::Postgres {
                // Row bodies are stored as written, so the bytes a budget counts are the bytes a record holds.
                for (at, field) in family.fields.iter().enumerate() {
                    if !layout.is_ordered(at) {
                        statements.push(format!("ALTER TABLE {table} ALTER COLUMN {} SET STORAGE EXTERNAL", self.q(field)));
                    }
                }
            }
            statements.extend(self.counting(family));
        }
        Ok(statements)
    }

    /// The statements that keep `_storage_meta.bytes` equal to the bytes the family's columns hold: after every row
    /// insert, update and delete, the row's column bytes are added or taken away inside the same transaction, so a
    /// rolled-back scope takes its bytes back and the total is read in one round trip. A server's own catalog sizes are
    /// not used: MySQL and MariaDB refresh theirs lazily and leave out large values stored off the row.
    fn counting(&self, family: &Family) -> Vec<String> {
        let size = |row: &str| -> String {
            family
                .fields
                .iter()
                .map(|field| format!("{}({row}{})", self.dialect.length(), self.q(field)))
                .collect::<Vec<_>>()
                .join(" + ")
        };
        let table = self.q(&family.family);
        let name = |event: &str| self.q(&format!("{}__bytes_{event}", family.family));
        if self.dialect.postgres_family() {
            let function = self.q(&format!("{}__bytes", family.family));
            vec![
                format!(
                    "CREATE OR REPLACE FUNCTION {function}() RETURNS trigger AS $$ BEGIN IF TG_OP = 'INSERT' THEN UPDATE {META} SET bytes = bytes + ({}) WHERE id = 1; RETURN NEW; ELSIF TG_OP = 'DELETE' THEN UPDATE {META} SET bytes = bytes - ({}) WHERE id = 1; RETURN OLD; ELSE UPDATE {META} SET bytes = bytes + ({}) - ({}) WHERE id = 1; RETURN NEW; END IF; END $$ LANGUAGE plpgsql",
                    size("NEW."),
                    size("OLD."),
                    size("NEW."),
                    size("OLD.")
                ),
                format!("DROP TRIGGER IF EXISTS {} ON {table}", name("all")),
                format!("CREATE TRIGGER {} AFTER INSERT OR UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION {function}()", name("all")),
            ]
        } else if self.dialect == Dialect::Sqlite {
            vec![
                format!("CREATE TRIGGER IF NOT EXISTS {} AFTER INSERT ON {table} BEGIN UPDATE {META} SET bytes = bytes + ({}) WHERE id = 1; END", name("insert"), size("NEW.")),
                format!("CREATE TRIGGER IF NOT EXISTS {} AFTER DELETE ON {table} BEGIN UPDATE {META} SET bytes = bytes - ({}) WHERE id = 1; END", name("delete"), size("OLD.")),
                format!(
                    "CREATE TRIGGER IF NOT EXISTS {} AFTER UPDATE ON {table} BEGIN UPDATE {META} SET bytes = bytes + ({}) - ({}) WHERE id = 1; END",
                    name("update"),
                    size("NEW."),
                    size("OLD.")
                ),
            ]
        } else {
            vec![
                format!("DROP TRIGGER IF EXISTS {}", name("insert")),
                format!("CREATE TRIGGER {} AFTER INSERT ON {table} FOR EACH ROW UPDATE {META} SET bytes = bytes + ({}) WHERE id = 1", name("insert"), size("NEW.")),
                format!("DROP TRIGGER IF EXISTS {}", name("delete")),
                format!("CREATE TRIGGER {} AFTER DELETE ON {table} FOR EACH ROW UPDATE {META} SET bytes = bytes - ({}) WHERE id = 1", name("delete"), size("OLD.")),
                format!("DROP TRIGGER IF EXISTS {}", name("update")),
                format!(
                    "CREATE TRIGGER {} AFTER UPDATE ON {table} FOR EACH ROW UPDATE {META} SET bytes = bytes + ({}) - ({}) WHERE id = 1",
                    name("update"),
                    size("NEW."),
                    size("OLD.")
                ),
            ]
        }
    }

    /// Make the schema on this connection when its meta row is not there. Every statement is idempotent and the meta
    /// row comes last, so a first attempt that failed part way (a server that does not run a batch of schema changes
    /// as one transaction) is finished by the next attempt, and the row's existence means every table exists.
    fn create(&self) -> Result<()> {
        if self.exists(META)? && !self.ask(&format!("SELECT 1 FROM {META} WHERE id = 1"))?.is_empty() {
            return Ok(());
        }
        let mut uid = format!(
            "{}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()),
            std::thread::current().id()
        )
        .into_bytes();
        uid.truncate(60);
        for statement in self.ddl()? {
            self.wire.script(&[statement])?;
        }
        let ignore = match self.dialect {
            Dialect::MySql | Dialect::MariaDb => ("INSERT IGNORE", ""),
            Dialect::Sqlite => ("INSERT OR IGNORE", ""),
            Dialect::Postgres | Dialect::Cockroach => ("INSERT", " ON CONFLICT DO NOTHING"),
        };
        self.wire.script(&[format!(
            "{} INTO {META}(id, uid, commits, bytes) VALUES(1, {}, 0, 0){}",
            ignore.0,
            self.dialect.literal(&uid),
            ignore.1
        )])
    }

    fn read_uid(&self) -> Result<Vec<u8>> {
        let rows = self.ask(&format!("SELECT uid FROM {META} WHERE id = 1"))?;
        match rows.into_iter().next().and_then(|mut row| row.pop()) {
            Some(Cell::Bytes(uid)) => Ok(uid),
            _ => Err(local_engine::cause!(Error::Moved)),
        }
    }

    fn exists(&self, table: &str) -> Result<bool> {
        // `table` is a validated DATA identifier or the fixed meta name, never caller text.
        let sql = if self.dialect == Dialect::Sqlite {
            format!("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '{table}'")
        } else {
            let scope = if self.dialect.postgres_family() { "current_schema()" } else { "DATABASE()" };
            format!("SELECT 1 FROM information_schema.tables WHERE table_schema = {scope} AND table_name = '{table}'")
        };
        Ok(!self.ask(&sql)?.is_empty())
    }

    /// A read with no parameters, outside any scope's statements (identity, schema and meta checks).
    fn ask(&self, sql: &str) -> Result<Vec<Vec<Cell>>> {
        let step = Step { sql: sql.to_owned(), params: Vec::new(), shape: Shape::Rows };
        match self.wire.pipeline(&[step])?.pop() {
            Some(Answer::Rows(rows)) => Ok(rows),
            _ => Err(local_engine::cause!(Error::Unavailable)),
        }
    }

    fn family(&self, name: &str) -> Result<&FamilyLayout> {
        self.layouts.iter().find(|layout| layout.family.family == name).ok_or(local_engine::cause!(Error::Undeclared))
    }

    fn usable(&self) -> Result<()> {
        if self.failed.get() {
            Err(local_engine::cause!(Error::Unavailable))
        } else {
            Ok(())
        }
    }

    /// The cursor columns of an order and, for a partial order, its row condition.
    fn cursor(&self, layout: &FamilyLayout, order: Order<'_>) -> Result<(Columns, String)> {
        let family = layout.family;
        match order {
            Order::Key => Ok((
                family.key.iter().map(|field| Ok((self.q(field), Some(layout.index(field)?)))).collect::<Result<_>>()?,
                String::new(),
            )),
            Order::Named(name) => {
                let order = family.order(name)?;
                let condition = if order.only.is_empty() {
                    String::new()
                } else if self.dialect.conflict_style() {
                    self.only_sql(layout, &order.only)?
                } else {
                    format!("{} = 1", self.member(name))
                };
                Ok((
                    order.fields.iter().map(|field| Ok((self.q(field), Some(layout.index(field)?)))).collect::<Result<_>>()?,
                    condition,
                ))
            }
            Order::Arrival if family.arrival => Ok((vec![(self.q("@arrival"), None)], String::new())),
            Order::Arrival => Err(local_engine::cause!(Error::Undeclared)),
        }
    }

    /// Append the WHERE clause of a range to `sql` (nothing when it selects the whole order). Returns the cursor
    /// columns and whether the range is empty by construction (a bound holding NULL is satisfied by no row).
    fn range_sql(&self, layout: &FamilyLayout, range: &Range<'_>, sql: &mut Sql) -> Result<(Vec<String>, bool)> {
        let (cursor, condition) = self.cursor(layout, range.order)?;
        let names: Vec<String> = cursor.iter().map(|(name, _)| name.clone()).collect();
        let (lower, upper) = if range.reverse { (&range.to, &range.from) } else { (&range.from, &range.to) };
        let mut bounds: Vec<(&str, &[Value])> = Vec::new();
        for (bound, below) in [(lower, false), (upper, true)] {
            let (values, inclusive) = match bound {
                Bound::Unbounded => continue,
                Bound::Included(values) => (values, true),
                Bound::Excluded(values) => (values, false),
            };
            if values.is_empty() || values.len() > cursor.len() {
                return Err(local_engine::cause!(Error::Invalid));
            }
            // A row-value comparison is decided by the first position where the two sides differ, and a NULL on either
            // side is no answer. So a NULL in the bound ends what the bound can say: the rows it selects are those the
            // values before the NULL decide strictly, and a NULL first value selects nothing.
            let (values, inclusive) = match values.iter().position(Value::is_null) {
                Some(0) => return Ok((names, true)),
                Some(at) => (&values[..at], false),
                None => (&values[..], inclusive),
            };
            bounds.push((
                match (below, inclusive) {
                    (false, true) => ">=",
                    (false, false) => ">",
                    (true, true) => "<=",
                    (true, false) => "<",
                },
                values,
            ));
        }
        let mut joined = false;
        let mut join = |sql: &mut Sql| {
            sql.text(if joined { " AND " } else { " WHERE " });
            joined = true;
        };
        if !condition.is_empty() {
            join(sql);
            sql.text(&condition);
        }
        for (operator, values) in &bounds {
            join(sql);
            sql.text(&format!("({}) {operator} (", names[..values.len()].join(",")));
            for (at, one) in values.iter().enumerate() {
                if at > 0 {
                    sql.text(",");
                }
                sql.param(match cursor[at].1 {
                    Some(field) => Param::Bytes(layout.encode(field, one)?),
                    None => Param::Int(one.as_integer().ok_or(local_engine::cause!(Error::Invalid))?),
                });
            }
            sql.text(")");
        }
        // A row-value comparison is decided at the first position where the row and the bound differ, and a NULL there
        // is no answer, so such a row is refused: for a bound `v1..vn` the rows whose first `i - 1` fields equal
        // `v1..v(i-1)` and whose field `i` is NULL. A stored NULL is the lowest byte string, so the comparison alone
        // would let it through below a bound.
        for (_, values) in &bounds {
            for at in 0..values.len() {
                let Some(field) = cursor[at].1 else { continue };
                let mut refused = Vec::with_capacity(at + 1);
                for earlier in 0..at {
                    let Some(earlier_field) = cursor[earlier].1 else { continue };
                    refused.push(format!("{} = {}", names[earlier], self.dialect.literal(&layout.encode(earlier_field, &values[earlier])?)));
                }
                refused.push(format!("{} = {}", names[at], self.dialect.literal(&layout.encode(field, &Value::Null)?)));
                join(sql);
                sql.text(&format!("NOT ({})", refused.join(" AND ")));
            }
        }
        Ok((names, false))
    }

    fn select_columns(&self, layout: &FamilyLayout, read: &[Read<'_>]) -> Result<String> {
        if read.is_empty() {
            return Err(local_engine::cause!(Error::Invalid));
        }
        let mut text = String::new();
        for (at, one) in read.iter().enumerate() {
            if at > 0 {
                text.push(',');
            }
            let name = if one.field == ARRIVAL {
                if !layout.family.arrival {
                    return Err(local_engine::cause!(Error::Undeclared));
                }
                self.q("@arrival")
            } else {
                layout.index(one.field)?;
                self.q(one.field)
            };
            match one.at_most {
                // A plain text or blob of `n` bytes is stored in `n + 5` (a five-byte header), so the server withholds
                // a longer one and says how long it is. A number is nine bytes and always comes back, so its decimal
                // length can be compared here. An ordered column is a key or order field, short by the server's own
                // index limit, so it always comes back whole and is compared here too.
                Some(bytes) if one.field != ARRIVAL && !layout.is_ordered(layout.index(one.field)?) => {
                    let _ = write!(text, "CASE WHEN {0}({name}) <= {1} THEN {name} END,{0}({name})", self.dialect.length(), (bytes + 5).max(9));
                }
                _ => text.push_str(&name),
            }
        }
        Ok(text)
    }

    fn decode_row(&self, layout: &FamilyLayout, read: &[Read<'_>], cells: Vec<Cell>) -> Result<Row> {
        let mut cells = cells.into_iter();
        let mut values = Vec::with_capacity(read.len());
        for one in read {
            let cell = cells.next().ok_or(local_engine::cause!(Error::Unavailable))?;
            if one.field == ARRIVAL {
                values.push(match cell {
                    Cell::Int(position) => Value::Integer(position),
                    _ => return Err(local_engine::cause!(Error::Unavailable)),
                });
                continue;
            }
            let at = layout.index(one.field)?;
            let length = if one.at_most.is_some() && !layout.is_ordered(at) {
                match cells.next() {
                    Some(Cell::Int(length)) => Some(length.max(0) as u64),
                    _ => return Err(local_engine::cause!(Error::Unavailable)),
                }
            } else {
                None
            };
            values.push(match (cell, one.at_most, length) {
                (Cell::Bytes(bytes), limit, _) => {
                    let value = layout.decode(at, &bytes)?;
                    match (limit, stored_octets(&value)) {
                        (Some(limit), Some(octets)) if octets > limit => Value::Oversized(octets as u64),
                        _ => value,
                    }
                }
                (Cell::Null, Some(_), Some(length)) => Value::Oversized(length.saturating_sub(5)),
                (Cell::Null, _, _) => Value::Null,
                (Cell::Int(_), _, _) => return Err(local_engine::cause!(Error::Unavailable)),
            });
        }
        Ok(Row(values))
    }

    fn key_params(&self, layout: &FamilyLayout, key: &[Value]) -> Result<Vec<Param>> {
        if key.len() != layout.family.key.len() {
            return Err(local_engine::cause!(Error::Invalid));
        }
        layout
            .family
            .key
            .iter()
            .zip(key)
            .map(|(field, one)| Ok(Param::Bytes(layout.encode(layout.index(field)?, one)?)))
            .collect()
    }

    fn key_equals(&self, layout: &FamilyLayout, key: &[Value], sql: &mut Sql) -> Result<()> {
        for (at, (field, param)) in layout.family.key.iter().zip(self.key_params(layout, key)?).enumerate() {
            if at > 0 {
                sql.text(" AND ");
            }
            sql.text(&format!("{}=", self.q(field)));
            sql.param(param);
        }
        Ok(())
    }

    /// The statement of a put, after the checks that refuse it before any statement is sent.
    fn put_step(&self, family: &str, row: &[(&str, Value)], when: When<'_>) -> Result<Step> {
        let layout = self.family(family)?;
        let family = layout.family;
        for (field, one) in row {
            if !family.has(field) {
                return Err(local_engine::cause!(Error::Undeclared));
            }
            if matches!(one, Value::Oversized(_)) {
                return Err(local_engine::cause!(Error::Invalid));
            }
        }
        if !family.key.iter().all(|key| row.iter().any(|(field, _)| field == key)) {
            return Err(local_engine::cause!(Error::Invalid));
        }
        let table = self.q(&family.family);
        let is_key = |field: &str| family.key.iter().any(|key| key == field);
        let encode = |field: &str, one: &Value| -> Result<Param> { Ok(Param::Bytes(layout.encode(layout.index(field)?, one)?)) };
        let mut sql = Sql::new(self.dialect);
        if let When::Matches(conditions) = when {
            let changed: Vec<&(&str, Value)> = row.iter().filter(|(field, _)| !is_key(field)).collect();
            if changed.is_empty() {
                return Err(local_engine::cause!(Error::Invalid));
            }
            sql.text(&format!("UPDATE {table} SET "));
            for (at, (field, one)) in changed.iter().enumerate() {
                if at > 0 {
                    sql.text(",");
                }
                sql.text(&format!("{}=", self.q(field)));
                sql.param(encode(field, one)?);
            }
            sql.text(" WHERE ");
            let mut first = true;
            for (field, one) in row.iter().filter(|(field, _)| is_key(field)) {
                if !first {
                    sql.text(" AND ");
                }
                first = false;
                sql.text(&format!("{}=", self.q(field)));
                sql.param(encode(field, one)?);
            }
            for (field, one) in conditions {
                if !family.has(field) {
                    return Err(local_engine::cause!(Error::Undeclared));
                }
                // A NULL condition matches a NULL field; both are the one-byte NULL form.
                sql.text(&format!(" AND {}=", self.q(field)));
                sql.param(encode(field, one)?);
            }
            return Ok(Step::changed(&sql));
        }
        let given = |field: &str| row.iter().find(|(name, _)| *name == field).map(|(_, one)| one);
        let mut names = Vec::new();
        let mut values = Vec::new();
        for (at, field) in family.fields.iter().enumerate() {
            names.push(self.q(field));
            values.push(match given(field) {
                Some(one) => Param::Bytes(layout.encode(at, one)?),
                None => Param::Bytes(layout.encode(at, &Value::Null)?),
            });
        }
        let postgres = self.dialect.conflict_style();
        let keys: Vec<String> = family.key.iter().map(|key| self.q(key)).collect();
        let set: Vec<&String> = family.fields.iter().filter(|field| !is_key(field) && given(field).is_some()).collect();
        match when {
            // A key somebody holds is a unique violation, which the server reports as `Conflict`.
            When::New => {
                sql.text(&format!("INSERT INTO {table}({}) VALUES(", names.join(",")));
                push_values(&mut sql, values);
                sql.text(")");
            }
            When::Absent if postgres => {
                sql.text(&format!("INSERT INTO {table}({}) VALUES(", names.join(",")));
                push_values(&mut sql, values);
                sql.text(") ON CONFLICT DO NOTHING");
            }
            When::Absent => {
                sql.text(&format!("INSERT INTO {table}({}) SELECT ", names.join(",")));
                push_values(&mut sql, values);
                sql.text(&format!(" FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM {table} WHERE "));
                let key: Vec<Value> = family
                    .key
                    .iter()
                    .map(|field| given(field).cloned().ok_or(local_engine::cause!(Error::Invalid)))
                    .collect::<Result<_>>()?;
                self.key_equals(layout, &key, &mut sql)?;
                sql.text(")");
            }
            When::Always => {
                sql.text(&format!("INSERT INTO {table}({}) VALUES(", names.join(",")));
                push_values(&mut sql, values);
                sql.text(")");
                if postgres {
                    if set.is_empty() {
                        sql.text(&format!(" ON CONFLICT({}) DO NOTHING", keys.join(",")));
                    } else {
                        let update: Vec<String> = set.iter().map(|field| format!("{0}=excluded.{0}", self.q(field))).collect();
                        sql.text(&format!(" ON CONFLICT({}) DO UPDATE SET {}", keys.join(","), update.join(",")));
                    }
                } else {
                    let update: Vec<String> = if set.is_empty() {
                        vec![format!("{0}={0}", keys[0])]
                    } else {
                        set.iter().map(|field| format!("{0}=VALUES({0})", self.q(field))).collect()
                    };
                    sql.text(&format!(" ON DUPLICATE KEY UPDATE {}", update.join(",")));
                }
            }
            When::Matches(_) => unreachable!("handled above"),
        }
        Ok(Step::changed(&sql))
    }

    /// The statement of an erase, or None when the range is empty by construction.
    fn erase_step(&self, family: &str, range: &Range<'_>) -> Result<Option<Step>> {
        let layout = self.family(family)?;
        if range.limit.is_some() {
            return Err(local_engine::cause!(Error::Invalid));
        }
        let mut sql = Sql::new(self.dialect);
        sql.text(&format!("DELETE FROM {}", self.q(family)));
        let (_, empty) = self.range_sql(layout, range, &mut sql)?;
        Ok((!empty).then(|| Step::changed(&sql)))
    }

    /// One column of the meta row, read inside the open scope.
    fn meta(&self, column: &str) -> Result<Option<Cell>> {
        let mut sql = Sql::new(self.dialect);
        sql.text(&format!("SELECT {column} FROM {META} WHERE id = 1"));
        Ok(self.query(&sql)?.pop().and_then(|mut row| row.pop()))
    }

    /// Send a batch of writes in one request; the rows each changed (a put's count is 0 or 1). A write the supply
    /// refuses before any statement (an undeclared field) ends the batch there, after the writes before it were sent.
    fn write_steps(&self, writes: &[Write<'_>]) -> Result<Vec<u64>> {
        let mut steps = Vec::with_capacity(writes.len());
        // Per write: the position of its statement, and whether it is a put (whose count is at most one).
        let mut plan: Vec<Option<(usize, bool)>> = Vec::with_capacity(writes.len());
        let mut refused = None;
        for write in writes {
            let built = match write {
                Write::Put { family, row, when } => self.put_step(family, row, *when).map(|step| Some((step, true))),
                Write::Erase { family, range } => self.erase_step(family, range).map(|step| step.map(|step| (step, false))),
            };
            match built {
                Ok(Some((step, put))) => {
                    plan.push(Some((steps.len(), put)));
                    steps.push(step);
                }
                Ok(None) => plan.push(None),
                Err(error) => {
                    refused = Some(error);
                    break;
                }
            }
        }
        let changed = if steps.is_empty() { Ok(Vec::new()) } else { self.change(steps) };
        if let Some(error) = refused {
            return Err(changed.err().unwrap_or(error));
        }
        let changed = changed?;
        let done: Vec<u64> = plan
            .into_iter()
            .map(|at| at.map_or(0, |(at, put)| if put { changed[at].min(1) } else { changed[at] }))
            .collect();
        self.changes.set(self.changes.get() + done.iter().sum::<u64>());
        Ok(done)
    }

    /// The `SELECT` of a range with its order and limit, or None when its bounds leave it empty.
    fn scan_sql(&self, layout: &FamilyLayout, family: &str, range: &Range<'_>, read: &[Read<'_>]) -> Result<Option<Sql>> {
        let mut sql = Sql::new(self.dialect);
        sql.text(&format!("SELECT {} FROM {}", self.select_columns(layout, read)?, self.q(family)));
        let (cursor, empty) = self.range_sql(layout, range, &mut sql)?;
        if empty {
            return Ok(None);
        }
        let direction = if range.reverse { " DESC" } else { "" };
        // Rows that tie on an order's fields come back in key order, as the other supplies return them.
        let mut order: Vec<String> = cursor.iter().map(|name| format!("{name}{direction}")).collect();
        if matches!(range.order, Order::Named(_)) {
            for field in &layout.family.key {
                let name = self.q(field);
                if !cursor.contains(&name) {
                    order.push(format!("{name}{direction}"));
                }
            }
        }
        sql.text(&format!(" ORDER BY {}", order.join(",")));
        if let Some(limit) = range.limit {
            sql.text(&format!(" LIMIT {limit}"));
        }
        Ok(Some(sql))
    }

    fn rows_of(&self, layout: &FamilyLayout, sql: &Sql, read: &[Read<'_>]) -> Result<Vec<Row>> {
        self.query(sql)?.into_iter().map(|cells| self.decode_row(layout, read, cells)).collect()
    }

    /// Run one `SELECT` in the open scope (or on its own when none is open).
    fn query(&self, sql: &Sql) -> Result<Vec<Vec<Cell>>> {
        match self.execute(vec![Step::rows(sql)])?.pop() {
            Some(Answer::Rows(rows)) => Ok(rows),
            _ => Err(local_engine::cause!(Error::Unavailable)),
        }
    }

    /// The statements that open an outermost scope of `intent`.
    fn opening(&self, intent: Intent) -> Vec<Step> {
        match intent {
            Intent::Read if self.dialect.postgres_family() => vec![Step::plain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")],
            Intent::Read if self.dialect == Dialect::Sqlite => vec![Step::plain("BEGIN")],
            Intent::Read => vec![Step::plain("START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT")],
            Intent::Write => vec![
                Step::plain(if self.dialect == Dialect::Sqlite { "BEGIN IMMEDIATE" } else { "BEGIN" }),
                Step::plain(format!("UPDATE {META} SET commits = commits + 1 WHERE id = 1")),
            ],
            Intent::Nested => Vec::new(),
        }
    }

    /// Run statements in the open scope, in one request, in order; the first failure ends the run and the statements
    /// before it stay done. A scope's owed opening goes first in the same request. A failed statement changes nothing
    /// and leaves the scope usable: on a server that aborts the whole transaction at one failed statement (PostgreSQL,
    /// CockroachDB) each statement runs between a savepoint and its release and a failure rolls back to that
    /// savepoint; on the others the server undoes the failed statement itself, and a savepoint marks only the end of
    /// the opening, so that a failure can tell whether the opening completed.
    fn execute(&self, steps: Vec<Step>) -> Result<Vec<Answer>> {
        self.usable()?;
        let owed = self.owed.borrow_mut().take();
        let each = self.scoped() && self.dialect.postgres_family();
        let opened = owed.is_some() && !each;
        let mut sent = owed.map(|intent| self.opening(intent)).unwrap_or_default();
        if opened {
            sent.push(Step::plain(format!("SAVEPOINT {OPENED}")));
        }
        let mut answered = Vec::with_capacity(steps.len() + 1);
        // A request that changes rows in a scope also reads the byte total they leave.
        let changing = self.scoped() && steps.iter().any(|step| step.shape == Shape::Changed);
        let steps = steps.into_iter().chain(changing.then(|| {
            let mut sql = Sql::new(self.dialect);
            sql.text(&format!("SELECT bytes FROM {META} WHERE id = 1"));
            Step::rows(&sql)
        }));
        for step in steps {
            if each {
                sent.push(Step::plain(format!("SAVEPOINT {UNIT}")));
            }
            answered.push(sent.len());
            sent.push(step);
            if each {
                sent.push(Step::plain(format!("RELEASE SAVEPOINT {UNIT}")));
            }
        }
        if opened {
            sent.push(Step::plain(format!("RELEASE SAVEPOINT {OPENED}")));
        }
        match self.wire.pipeline(&sent) {
            Ok(answers) => {
                let mut answers: Vec<Option<Answer>> = answers.into_iter().map(Some).collect();
                let mut answered: Vec<Answer> =
                    answered.into_iter().map(|at| answers.get_mut(at).and_then(Option::take).ok_or(local_engine::cause!(Error::Unavailable))).collect::<Result<_>>()?;
                if changing {
                    let total = match answered.pop() {
                        Some(Answer::Rows(rows)) => rows.into_iter().next().and_then(|row| row.into_iter().next()),
                        _ => None,
                    };
                    match total {
                        Some(Cell::Int(bytes)) => self.bytes.set(Some(bytes)),
                        _ => return Err(local_engine::cause!(Error::Unavailable)),
                    }
                }
                Ok(answered)
            }
            Err(error) => {
                self.bytes.set(None);
                let mended = if each {
                    self.wire.pipeline(&[Step::plain(format!("ROLLBACK TO SAVEPOINT {UNIT}")), Step::plain(format!("RELEASE SAVEPOINT {UNIT}"))]).is_ok()
                } else if opened {
                    self.wire.pipeline(&[Step::plain(format!("RELEASE SAVEPOINT {OPENED}"))]).is_ok()
                } else {
                    true
                };
                if !mended {
                    match owed {
                        // The opening did not complete: end whatever it began and owe it again, so the scope is as it was.
                        Some(intent) => {
                            let _ = self.wire.pipeline(&[Step::plain("ROLLBACK")]);
                            *self.owed.borrow_mut() = Some(intent);
                        }
                        // The transaction is in a state this handle cannot know: nothing more runs on it.
                        None => self.failed.set(true),
                    }
                }
                Err(error)
            }
        }
    }

    /// Run the changing statements `steps`; the rows each changed or matched.
    fn change(&self, steps: Vec<Step>) -> Result<Vec<u64>> {
        self.execute(steps)?
            .into_iter()
            .map(|answer| match answer {
                Answer::Changed(rows) => Ok(rows),
                Answer::Rows(_) => Err(local_engine::cause!(Error::Unavailable)),
            })
            .collect()
    }
}

/// SQLite's `octet_length` of a value (numbers by their text form); None for NULL.
fn stored_octets(value: &Value) -> Option<usize> {
    match value {
        Value::Null => None,
        Value::Integer(number) => Some(number.to_string().len()),
        Value::Real(number) => Some(number.to_string().len()),
        Value::Text(text) => Some(text.len()),
        Value::Blob(blob) => Some(blob.len()),
        Value::Oversized(bytes) => Some(*bytes as usize),
    }
}

impl<W: Wire> Storage for Supply<W> {
    fn schema(&self) -> &'static Schema {
        self.schema
    }

    fn get(&self, family: &str, key: &[Value], read: &[Read<'_>]) -> Result<Option<Row>> {
        let layout = self.family(family)?;
        let mut sql = Sql::new(self.dialect);
        sql.text(&format!("SELECT {} FROM {} WHERE ", self.select_columns(layout, read)?, self.q(family)));
        self.key_equals(layout, key, &mut sql)?;
        sql.text(" LIMIT 1");
        Ok(self.rows_of(layout, &sql, read)?.pop())
    }

    fn scan(&self, family: &str, range: &Range<'_>, read: &[Read<'_>]) -> Result<Vec<Row>> {
        let layout = self.family(family)?;
        match self.scan_sql(layout, family, range, read)? {
            Some(sql) => self.rows_of(layout, &sql, read),
            None => Ok(Vec::new()),
        }
    }

    /// The reads as statements in one request, answers in the order asked. A run of point gets of one family with
    /// the same read comes back from one statement per `PARAMETERS` keys (the key columns ride along with the read
    /// columns, so a row finds its place among the keys asked); every range is one statement.
    fn read_many(&self, queries: &[Query<'_>]) -> Result<Vec<Reply>> {
        /// Where one group of queries' answers come from.
        enum Plan<'q> {
            /// Point gets: each key's bytes in the order asked, and the statements that read them.
            Gets { layout: &'q FamilyLayout, read: &'q [Read<'q>], asked: Vec<Vec<Vec<u8>>>, first: usize, statements: usize },
            /// A range: its statement, or none when the range is empty by its bounds.
            Scan { layout: &'q FamilyLayout, read: &'q [Read<'q>], at: Option<usize> },
        }
        let mut steps = Vec::new();
        let mut plans = Vec::new();
        let mut at = 0;
        while at < queries.len() {
            match &queries[at] {
                Query::Scan { family, range, read } => {
                    let layout = self.family(family)?;
                    let sql = self.scan_sql(layout, family, range, read)?;
                    let step = sql.map(|sql| {
                        steps.push(Step::rows(&sql));
                        steps.len() - 1
                    });
                    plans.push(Plan::Scan { layout, read, at: step });
                    at += 1;
                }
                Query::Get { family, read, .. } => {
                    let layout = self.family(family)?;
                    let width = layout.family.key.len();
                    let mut asked: Vec<Vec<Vec<u8>>> = Vec::new();
                    while let Some(Query::Get { family: next, key, read: next_read }) = queries.get(at) {
                        if next != family || next_read != read {
                            break;
                        }
                        asked.push(self.key_params(layout, key)?.into_iter().map(|param| match param {
                            Param::Bytes(bytes) => bytes,
                            Param::Int(number) => number.to_be_bytes().to_vec(),
                        }).collect());
                        at += 1;
                    }
                    let mut once = HashSet::new();
                    let distinct: Vec<&Vec<Vec<u8>>> = asked.iter().filter(|key| once.insert(*key)).collect();
                    let key_columns: Vec<String> = layout.family.key.iter().map(|field| self.q(field)).collect();
                    let columns = format!("{},{}", key_columns.join(","), self.select_columns(layout, read)?);
                    let first = steps.len();
                    for chunk in distinct.chunks((PARAMETERS / width).max(1)) {
                        let mut sql = Sql::new(self.dialect);
                        sql.text(&format!("SELECT {columns} FROM {} WHERE ", self.q(family)));
                        // A one-field key is a plain `IN`; a longer one compares as a row value.
                        sql.text(&if width == 1 { key_columns[0].clone() } else { format!("({})", key_columns.join(",")) });
                        sql.text(" IN (");
                        for (place, key) in chunk.iter().enumerate() {
                            if place > 0 {
                                sql.text(",");
                            }
                            if width > 1 {
                                sql.text("(");
                            }
                            push_values(&mut sql, key.iter().cloned().map(Param::Bytes).collect());
                            if width > 1 {
                                sql.text(")");
                            }
                        }
                        sql.text(")");
                        steps.push(Step::rows(&sql));
                    }
                    plans.push(Plan::Gets { layout, read, asked, first, statements: steps.len() - first });
                }
            }
        }
        let mut answers = if steps.is_empty() { Vec::new() } else { self.execute(steps)? };
        let mut replies = Vec::with_capacity(queries.len());
        for plan in plans {
            match plan {
                Plan::Scan { layout, read, at } => {
                    let rows = match at {
                        Some(at) => match std::mem::replace(&mut answers[at], Answer::Changed(0)) {
                            Answer::Rows(rows) => rows.into_iter().map(|cells| self.decode_row(layout, read, cells)).collect::<Result<_>>()?,
                            Answer::Changed(_) => return Err(local_engine::cause!(Error::Unavailable)),
                        },
                        None => Vec::new(),
                    };
                    replies.push(Reply::Rows(rows));
                }
                Plan::Gets { layout, read, asked, first, statements } => {
                    let width = layout.family.key.len();
                    let mut found: HashMap<Vec<Vec<u8>>, Row> = HashMap::with_capacity(asked.len());
                    for answer in &mut answers[first..first + statements] {
                        let Answer::Rows(rows) = std::mem::replace(answer, Answer::Changed(0)) else { return Err(local_engine::cause!(Error::Unavailable)) };
                        for mut cells in rows {
                            let read_cells = cells.split_off(width.min(cells.len()));
                            let key = cells
                                .into_iter()
                                .map(|cell| match cell {
                                    Cell::Bytes(bytes) => Ok(bytes),
                                    _ => Err(local_engine::cause!(Error::Unavailable)),
                                })
                                .collect::<Result<Vec<_>>>()?;
                            found.insert(key, self.decode_row(layout, read, read_cells)?);
                        }
                    }
                    replies.extend(asked.iter().map(|key| Reply::Row(found.get(key).cloned())));
                }
            }
        }
        Ok(replies)
    }

    /// The writes as statements in one request. Outside a scope they are asked one at a time, as the contract says
    /// of a put or an erase outside a scope.
    fn write_many(&self, writes: &[Write<'_>]) -> Result<Vec<u64>> {
        if !self.scoped() {
            return writes
                .iter()
                .map(|write| match write {
                    Write::Put { family, row, when } => self.put(family, row, *when),
                    Write::Erase { family, range } => self.erase(family, range),
                })
                .collect();
        }
        self.write_steps(writes)
    }

    fn put(&self, family: &str, row: &[(&str, Value)], when: When<'_>) -> Result<u64> {
        let step = self.put_step(family, row, when)?;
        let changed = match self.change(vec![step]) {
            Ok(changed) => changed.first().copied().unwrap_or(0).min(1),
            Err(Error::Conflict(_)) if matches!(when, When::Absent) => 0,
            Err(error) => return Err(error),
        };
        self.changes.set(self.changes.get() + changed);
        Ok(changed)
    }

    fn count(&self, family: &str, range: &Range<'_>) -> Result<u64> {
        let layout = self.family(family)?;
        let mut sql = Sql::new(self.dialect);
        sql.text(&format!("SELECT 1 FROM {}", self.q(family)));
        let (_, empty) = self.range_sql(layout, range, &mut sql)?;
        if empty {
            return Ok(0);
        }
        if let Some(limit) = range.limit {
            sql.text(&format!(" LIMIT {limit}"));
        }
        sql.text = format!("SELECT count(*) FROM ({}) counted", sql.text);
        match self.query(&sql)?.pop().and_then(|mut row| row.pop()) {
            Some(Cell::Int(count)) => u64::try_from(count).map_err(|error| local_engine::carry_cause!(Error::Unavailable, error)),
            _ => Err(local_engine::cause!(Error::Unavailable)),
        }
    }

    fn erase(&self, family: &str, range: &Range<'_>) -> Result<u64> {
        let Some(step) = self.erase_step(family, range)? else { return Ok(0) };
        let removed = self.change(vec![step])?.first().copied().unwrap_or(0);
        self.changes.set(self.changes.get() + removed);
        Ok(removed)
    }

    fn present(&self, family: &str) -> Result<bool> {
        let layout = self.family(family)?;
        self.exists(&layout.family.family)
    }

    fn custody(&self) -> Result<()> {
        if self.read_uid()? == self.uid {
            Ok(())
        } else {
            Err(local_engine::cause!(Error::Moved))
        }
    }

    fn location(&self) -> Option<&str> {
        Some(&self.place)
    }

    fn scoped(&self) -> bool {
        !self.scopes.borrow().is_empty()
    }

    fn writing(&self) -> Result<bool> {
        Ok(self.scopes.borrow().first().is_some_and(|intent| *intent == Intent::Write))
    }

    fn changes(&self) -> u64 {
        self.changes.get()
    }

    /// Moves only when another handle commits. A write scope's opening moves the commit count at once (that update
    /// takes the reservation), so inside an outermost write scope the count read holds this scope's own step, which is
    /// taken out with this handle's earlier commits.
    fn mark(&self) -> Result<i64> {
        let commits = match self.meta("commits")? {
            Some(Cell::Int(commits)) => commits,
            _ => return Err(local_engine::cause!(Error::Unavailable)),
        };
        let open = i64::from(self.scopes.borrow().first() == Some(&Intent::Write));
        Ok(commits - self.own_commits.get() - open)
    }

    fn schema_mark(&self) -> Result<i64> {
        Ok(0)
    }

    fn allocated_bytes(&self) -> Result<u64> {
        if let (true, Some(bytes)) = (self.scoped(), self.bytes.get()) {
            return u64::try_from(bytes).map_err(|error| local_engine::carry_cause!(Error::Unavailable, error));
        }
        match self.meta("bytes")? {
            Some(Cell::Int(bytes)) => u64::try_from(bytes).map_err(|error| local_engine::carry_cause!(Error::Unavailable, error)),
            _ => Err(local_engine::cause!(Error::Unavailable)),
        }
    }

    fn reclaim(&self) -> Result<()> {
        if self.scoped() {
            return Err(local_engine::cause!(Error::Invalid));
        }
        match self.dialect {
            // The server can rewrite a table; it cannot rewrite the logs it keeps beside it.
            Dialect::Postgres => self.wire.script(
                &self.schema.families.iter().map(|family| format!("VACUUM FULL {}", self.q(&family.family))).collect::<Vec<_>>(),
            ),
            Dialect::MySql | Dialect::MariaDb => self.wire.script(
                &self.schema.families.iter().map(|family| format!("OPTIMIZE TABLE {}", self.q(&family.family))).collect::<Vec<_>>(),
            ),
            Dialect::Sqlite => self.wire.script(&["VACUUM".to_string()]),
            Dialect::Cockroach => Err(local_engine::cause!(Error::Unavailable)),
        }
    }

    fn open_scope(&self, intent: Intent) -> Result<()> {
        self.usable()?;
        let depth = self.scopes.borrow().len();
        match (intent, depth) {
            (Intent::Nested, 0) | (Intent::Read | Intent::Write, 1..) => return Err(local_engine::cause!(Error::Invalid)),
            _ => {}
        }
        if intent == Intent::Nested {
            // The outer scope's opening, if still owed, goes in the same request as the savepoint.
            let owed = self.owed.borrow_mut().take();
            let mut sent = owed.map(|outer| self.opening(outer)).unwrap_or_default();
            sent.push(Step::plain(format!("SAVEPOINT storage_nested_{depth}")));
            if let Err(error) = self.wire.pipeline(&sent) {
                match owed {
                    Some(outer) => {
                        let _ = self.wire.pipeline(&[Step::plain("ROLLBACK")]);
                        *self.owed.borrow_mut() = Some(outer);
                    }
                    None => self.failed.set(true),
                }
                return Err(error);
            }
        } else {
            // Nothing is sent: the opening travels with the scope's first operation.
            *self.owed.borrow_mut() = Some(intent);
            self.bytes.set(None);
        }
        self.scopes.borrow_mut().push(intent);
        Ok(())
    }

    fn close_scope(&self, commit: bool) -> Result<()> {
        self.usable()?;
        let depth = self.scopes.borrow().len();
        if depth == 0 {
            return Err(local_engine::cause!(Error::Invalid));
        }
        let statements: Vec<Step> = if depth > 1 {
            let name = format!("storage_nested_{}", depth - 1);
            if commit {
                vec![Step::plain(format!("RELEASE SAVEPOINT {name}"))]
            } else {
                vec![Step::plain(format!("ROLLBACK TO SAVEPOINT {name}")), Step::plain(format!("RELEASE SAVEPOINT {name}"))]
            }
        } else {
            match self.owed.borrow_mut().take() {
                // Never opened on the server: a write that commits opens, takes the reservation and commits in one
                // request; anything else has nothing to end.
                Some(Intent::Write) if commit => {
                    let mut sent = self.opening(Intent::Write);
                    sent.push(Step::plain("COMMIT"));
                    sent
                }
                Some(_) => Vec::new(),
                None => vec![Step::plain(if commit { "COMMIT" } else { "ROLLBACK" })],
            }
        };
        // An outermost write scope that commits on the server moves the commit count by one.
        let counted = depth == 1 && commit && self.scopes.borrow().first() == Some(&Intent::Write) && !statements.is_empty();
        let ended = if statements.is_empty() { Ok(Vec::new()) } else { self.wire.pipeline(&statements) };
        self.bytes.set(None);
        match ended {
            Ok(_) => {
                if counted {
                    self.own_commits.set(self.own_commits.get() + 1);
                }
                self.scopes.borrow_mut().pop();
                Ok(())
            }
            Err(error) => {
                self.failed.set(true);
                Err(error)
            }
        }
    }
}

fn push_values(sql: &mut Sql, values: Vec<Param>) {
    for (at, value) in values.into_iter().enumerate() {
        if at > 0 {
            sql.text(",");
        }
        sql.param(value);
    }
}

/// A statement with its parameters written into the text, for the protocols that carry several statements in one text
/// request. Every literal is a hex byte string or a number built from a `Param`, never caller text.
pub fn inline(dialect: Dialect, step: &Step) -> String {
    let literal = |param: &Param| match param {
        Param::Bytes(bytes) => dialect.literal(bytes),
        Param::Int(number) => number.to_string(),
    };
    let mut text = String::with_capacity(step.sql.len() + step.params.iter().map(|param| if let Param::Bytes(bytes) = param { bytes.len() * 2 + 12 } else { 20 }).sum::<usize>());
    let mut chars = step.sql.chars().peekable();
    let mut next = 0;
    // Backtick and single-quote spans hold names and strings, never placeholders.
    let mut quote: Option<char> = None;
    while let Some(one) = chars.next() {
        match (quote, one) {
            (Some(open), _) if one == open => {
                quote = None;
                text.push(one);
            }
            (Some(_), _) => text.push(one),
            (None, '`' | '\'') => {
                quote = Some(one);
                text.push(one);
            }
            (None, '$') if dialect.numbered() && chars.peek().is_some_and(char::is_ascii_digit) => {
                let mut digits = String::new();
                while let Some(digit) = chars.next_if(char::is_ascii_digit) {
                    digits.push(digit);
                }
                let at: usize = digits.parse().unwrap_or(0);
                text.push_str(&step.params.get(at.wrapping_sub(1)).map(literal).unwrap_or_default());
            }
            (None, '?') if !dialect.numbered() => {
                text.push_str(&step.params.get(next).map(literal).unwrap_or_default());
                next += 1;
            }
            (None, _) => text.push(one),
        }
    }
    text
}

/// A result cell from a server's text form: NULL, a hex byte string (`\x...`, how PostgreSQL writes `bytea`), or a number.
pub fn text_cell(text: Option<&str>) -> Result<Cell> {
    let Some(text) = text else { return Ok(Cell::Null) };
    match text.strip_prefix("\\x") {
        Some(hex) => {
            if hex.len() % 2 != 0 {
                return Err(local_engine::cause!(Error::Unavailable));
            }
            (0..hex.len() / 2)
                .map(|at| u8::from_str_radix(&hex[at * 2..at * 2 + 2], 16).map_err(|error| local_engine::carry_cause!(Error::Unavailable, error)))
                .collect::<Result<Vec<u8>>>()
                .map(Cell::Bytes)
        }
        None => text.parse().map(Cell::Int).map_err(|error| local_engine::carry_cause!(Error::Unavailable, error)),
    }
}
