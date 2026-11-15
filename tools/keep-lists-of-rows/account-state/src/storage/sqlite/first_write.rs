// Purpose: Tables made by the first statement that writes to them, not when the store opens. A store declares its schema
// as it opens (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`); on a new store each declaration is a write,
// most for tables nothing ever writes to. Over the SQL seam a SQL-speaking supply hands its statements through
// (`FirstWrite::exec(text, params)`), such a declaration for a table that does not exist yet is kept and made, with its
// declared indexes, just before the first statement that changes it. Until then the table reads as empty.
//
// Ported one to one from old trillion `src/hosts/schema-on-first-write.mjs` (tag old-trillion-before-worker-retire).
// The family supply (`sqlite.rs`) keeps the same rule for a family whose DATA row says `"made": "first_write"`; this file
// is the rule for a supply that runs SQL text (the arbitrary-schema database supply, `database.rs`).
//
// Non-Negotiable Invariants:
// 1. Only a declaration of a table that does not exist is kept (one `pragma_table_info` lookup, no rows read). An existing
//    table, a table made any other way, and a statement the seam cannot classify run unchanged.
// 2. A kept table answers exactly as an empty table would:
//    - a SELECT (or a WITH that changes nothing) naming it reads it as an empty table of its declared columns (a common
//      table expression of the same name, columns and `rowid`, holding no row), with any `INDEXED BY` of its indexes
//      dropped;
//    - an UPDATE or DELETE whose target it is changes nothing and runs nothing;
//    - an INSERT or REPLACE into it makes it (and its indexes) first, in the same transaction as the write;
//    - every other statement naming it (ALTER, CREATE TRIGGER or VIEW, an index made without IF NOT EXISTS, PRAGMA, a
//      read of sqlite_master or a pragma table, or a bound text equal to its name) makes it first, so what such a
//      statement sees is the declared schema;
//    - a read of the schema that lists tables (sqlite_master, sqlite_schema, pragma_table_list) without naming one makes
//      first every kept table it would list: a SELECT over sqlite_master or sqlite_schema is asked once of a catalogue
//      holding only the kept tables and their indexes (no stored row read), and the kept tables named in its answer are
//      made (all of them when it answers rows naming none); any other such read makes every kept table. So a lookup of
//      one other table's name makes nothing, and every list holds every declared table it would hold.
// 3. `DROP TABLE IF EXISTS` of a kept table forgets the declaration and runs nothing.
// 4. A table made here and taken back by a rollback is made again by the first statement that finds it missing; each
//    declaration is kept for the seam's life, so "no such table" for a declared table never reaches the caller.
// 5. A seam is made over a connection, never over another seam (`FirstWrite::over(&Connection)`), so wrapping twice
//    cannot happen; one seam per connection holds every declaration of that store.
//
// Key Concepts:
// - `declared`: every kept table (name -> create text, columns, indexes), kept for the seam's life.
// - `waiting`: the kept tables not yet made (lower-cased name -> name); `index_table`: each kept index's table.
//
// Security Considerations:
// - Values are always bound; the only text the seam writes itself is quoted names and quoted literals of the kept
//   declarations (the catalogue a listing read is asked of).
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it, or from weakening an invariant above.

use rusqlite::{params_from_iter, types::Value as SqlValue, Connection};
use regex::Regex;
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::OnceLock,
};

/// One answered row: each column's name and value, in order.
pub type Answer = Vec<(String, SqlValue)>;

struct Table {
    create: String,
    columns: Vec<String>,
    /// index name -> its create text, in declaration order.
    indexes: Vec<(String, String)>,
}

#[derive(Default)]
struct State {
    declared: HashMap<String, Table>,
    waiting: BTreeMap<String, String>,
    index_table: HashMap<String, String>,
}

/// The SQL seam of one connection, making declared tables on their first write.
pub struct FirstWrite<'c> {
    db: &'c Connection,
    state: RefCell<State>,
}

struct Patterns {
    create_table: Regex,
    create_index: Regex,
    drop_table: Regex,
    insert_into: Regex,
    change: Regex,
    select: Regex,
    with: Regex,
    changes: Regex,
    introspects: Regex,
    lists_tables: Regex,
    lists_otherwise: Regex,
    missing: Regex,
    words: Regex,
    constraint: Regex,
    column: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| {
        let name = r#"(?:main\.)?["`\[]?([A-Za-z_][\w$]*)["`\]]?"#;
        let r = |text: &str| Regex::new(text).expect("first-write pattern");
        Patterns {
            create_table: r(&format!(r"(?i)^\s*create\s+table\s+if\s+not\s+exists\s+{name}\s*\(")),
            create_index: r(&format!(r"(?i)^\s*create\s+(?:unique\s+)?index\s+if\s+not\s+exists\s+{name}\s+on\s+{name}")),
            drop_table: r(&format!(r"(?i)^\s*drop\s+table\s+if\s+exists\s+{name}\s*;?\s*$")),
            insert_into: r(&format!(r"(?i)^\s*(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into)\s+{name}")),
            change: r(&format!(r"(?i)^\s*(?:update(?:\s+or\s+\w+)?|delete\s+from)\s+{name}")),
            select: r(r"(?i)^\s*select\b"),
            with: r(r"(?i)^\s*with\s+(?:recursive\s+)?"),
            changes: r(r"(?i)\b(?:insert|update|delete|replace)\b"),
            introspects: r(r"(?i)\b(?:sqlite_master|sqlite_schema|pragma\w*)\b"),
            lists_tables: r(r"(?i)\b(?:sqlite_master|sqlite_schema|pragma_table_list)\b|\bpragma\s+table_list\b"),
            // A listing the kept-table catalogue cannot stand in for: a pragma list, or the catalogue named through its schema.
            lists_otherwise: r(r#"(?i)\bpragma_table_list\b|\bpragma\s+table_list\b|\b(?:main|temp)\s*\.\s*["`\[]?sqlite_(?:master|schema)\b"#),
            missing: r(r"no such (?:table|index): (?:main\.)?([A-Za-z_][\w$]*)"),
            words: r(r"[A-Za-z_][\w$]*"),
            constraint: r(r"(?i)^\s*(?:constraint|primary|unique|check|foreign)\b"),
            column: r(r#"^\s*(?:"((?:[^"]|"")+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][\w$]*))"#),
        }
    })
}

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}
/// A statement read with more common table expressions: merged into its own WITH when it has one.
fn with_ctes(body: &str, ctes: &str) -> String {
    match patterns().with.find(body) {
        Some(prefix) => format!("{}{ctes}, {}", &body[..prefix.end()], &body[prefix.end()..]),
        None => format!("WITH {ctes} {body}"),
    }
}

/// Walks `text` from `at`, quotes and brackets respected, calling step(char, index, depth) outside quotes (and once more
/// at the end, with `None`) until it says stop.
fn walk<T>(text: &str, at: usize, mut depth: i32, mut step: impl FnMut(Option<char>, usize, i32) -> Option<T>) -> Option<T> {
    let mut quote: Option<char> = None;
    let chars: Vec<(usize, char)> = text[at..].char_indices().map(|(i, c)| (i + at, c)).collect();
    for (i, c) in chars.iter().copied().map(|(i, c)| (i, Some(c))).chain(std::iter::once((text.len(), None))) {
        if let Some(q) = quote {
            if c == Some(q) {
                quote = None;
            }
            continue;
        }
        match c {
            Some('\'' | '"' | '`') => quote = c,
            Some('[') => quote = Some(']'),
            _ => {
                if c == Some('(') {
                    depth += 1;
                } else if c == Some(')') {
                    depth -= 1;
                }
                if let Some(answer) = step(c, i, depth) {
                    return Some(answer);
                }
            }
        }
    }
    None
}
/// The text from `at` (just past an opening bracket) to its closing bracket; None when it never closes.
fn bracketed(text: &str, at: usize) -> Option<String> {
    walk(text, at, 1, |c, i, depth| (c == Some(')') && depth == 0).then(|| text[at..i].to_string()))
}
/// One statement only: a second statement after a top-level `;` is not classified.
pub(crate) fn single(text: &str) -> bool {
    walk(text, 0, 0, |c, i, _| (c == Some(';') && !text[i + 1..].trim().is_empty()).then_some(false)).unwrap_or(true)
}
/// The column names a CREATE TABLE body declares, in order (table constraints left out); None when it cannot be read.
fn columns_of(body: &str) -> Option<Vec<String>> {
    let mut items = Vec::new();
    let mut start = 0;
    walk::<()>(body, 0, 0, |c, i, depth| {
        if (c == Some(',') && depth == 0) || c.is_none() {
            items.push(body[start..i].to_string());
            start = i + 1;
        }
        None
    });
    let mut columns = Vec::new();
    for item in items {
        if patterns().constraint.is_match(&item) {
            continue;
        }
        let name = patterns().column.captures(&item)?;
        columns.push(
            name.get(1)
                .map(|m| m.as_str().replace("\"\"", "\""))
                .or_else(|| name.get(2).map(|m| m.as_str().to_string()))
                .or_else(|| name.get(3).map(|m| m.as_str().to_string()))
                .or_else(|| name.get(4).map(|m| m.as_str().to_string()))?,
        );
    }
    (!columns.is_empty()).then_some(columns)
}

/// Run one statement on the connection itself: its rows, each column named.
pub fn exec_raw(db: &Connection, text: &str, params: &[SqlValue]) -> rusqlite::Result<Vec<Answer>> {
    if !single(text) && params.is_empty() {
        db.execute_batch(text)?;
        return Ok(Vec::new());
    }
    let mut statement = db.prepare(text)?;
    let names: Vec<String> = statement.column_names().into_iter().map(str::to_string).collect();
    let mut rows = statement.query(params_from_iter(params.iter()))?;
    let mut answer = Vec::new();
    while let Some(row) = rows.next()? {
        let mut one = Vec::with_capacity(names.len());
        for (at, name) in names.iter().enumerate() {
            one.push((name.clone(), row.get::<_, SqlValue>(at)?));
        }
        answer.push(one);
    }
    Ok(answer)
}

fn nothing(db: &Connection) -> rusqlite::Result<Vec<Answer>> {
    exec_raw(db, "SELECT 1 WHERE 0", &[])
}

fn text_of(value: &SqlValue) -> Option<&str> {
    match value {
        SqlValue::Text(text) => Some(text),
        _ => None,
    }
}

impl<'c> FirstWrite<'c> {
    /// The seam over one connection; it keeps the connection's declarations for its life.
    pub fn over(db: &'c Connection) -> Self {
        FirstWrite { db, state: RefCell::new(State::default()) }
    }
    /// The connection under the seam.
    pub fn connection(&self) -> &'c Connection {
        self.db
    }
    /// Whether any kept table is still not made.
    pub fn waiting(&self) -> bool {
        !self.state.borrow().waiting.is_empty()
    }

    fn waiting_name(&self, name: &str) -> Option<String> {
        self.state.borrow().waiting.get(&name.to_lowercase()).cloned()
    }

    fn make(&self, name: &str) -> rusqlite::Result<()> {
        let (create, indexes) = {
            let state = self.state.borrow();
            let table = &state.declared[name];
            (table.create.clone(), table.indexes.iter().map(|(_, text)| text.clone()).collect::<Vec<_>>())
        };
        exec_raw(self.db, &create, &[])?;
        for text in indexes {
            exec_raw(self.db, &text, &[])?;
        }
        self.state.borrow_mut().waiting.remove(&name.to_lowercase());
        Ok(())
    }

    /// The kept tables a statement names, by a word of its text or a bound text equal to the name.
    fn named(&self, text: &str, params: &[SqlValue]) -> BTreeSet<String> {
        let mut found = BTreeSet::new();
        for word in patterns().words.find_iter(text) {
            let word = word.as_str();
            let table = self.waiting_name(word).or_else(|| {
                let owner = self.state.borrow().index_table.get(&word.to_lowercase()).cloned();
                owner.and_then(|owner| self.waiting_name(&owner))
            });
            if let Some(table) = table {
                found.insert(table);
            }
        }
        for value in params {
            if let Some(table) = text_of(value).and_then(|text| self.waiting_name(text)) {
                found.insert(table);
            }
        }
        found
    }

    fn bound(&self, params: &[SqlValue], tables: &BTreeSet<String>) -> bool {
        params.iter().any(|value| text_of(value).and_then(|text| self.waiting_name(text)).is_some_and(|name| tables.contains(&name)))
    }

    /// Each kept table read as an empty table of its declared columns, with INDEXED BY its indexes dropped.
    fn shadowed(&self, text: &str, tables: &BTreeSet<String>) -> String {
        let state = self.state.borrow();
        let ctes = tables
            .iter()
            .map(|name| {
                let columns = &state.declared[name].columns;
                let mut all = columns.clone();
                if !columns.iter().any(|column| column.eq_ignore_ascii_case("rowid")) {
                    all.push("rowid".into());
                }
                format!(
                    "{}({}) AS (SELECT {} WHERE 0)",
                    quoted(name),
                    all.iter().map(|c| quoted(c)).collect::<Vec<_>>().join(", "),
                    all.iter().map(|_| "NULL").collect::<Vec<_>>().join(", ")
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        let mut body = text.to_string();
        for name in tables {
            for (index, _) in &state.declared[name].indexes {
                let pattern = Regex::new(&format!(r#"(?i)\bindexed\s+by\s+["`\[]?{}["`\]]?"#, regex::escape(index))).expect("index pattern");
                body = pattern.replace_all(&body, "").into_owned();
            }
        }
        with_ctes(&body, &ctes)
    }

    /// The kept tables a read of the schema naming none of them would list: the read asked once of a catalogue of only
    /// the kept tables and their indexes, the tables named in its answer; every kept table when it answers rows naming
    /// none, or when it is not a read of sqlite_master or sqlite_schema the catalogue can stand in for.
    fn listed(&self, text: &str, params: &[SqlValue]) -> Vec<String> {
        let p = patterns();
        let all: Vec<String> = self.state.borrow().waiting.values().cloned().collect();
        if p.lists_otherwise.is_match(text) || !(p.select.is_match(text) || p.with.is_match(text)) || p.changes.is_match(text) {
            return all;
        }
        let mut entries: Vec<(&str, String, String, String)> = Vec::new();
        {
            let state = self.state.borrow();
            for name in &all {
                let table = &state.declared[name];
                entries.push(("table", name.clone(), name.clone(), table.create.clone()));
                for (index, create) in &table.indexes {
                    entries.push(("index", index.clone(), name.clone(), create.clone()));
                }
            }
        }
        let values = entries
            .iter()
            .map(|(kind, name, table, create)| format!("({}, {}, {}, 0, {})", literal(kind), literal(name), literal(table), literal(create)))
            .collect::<Vec<_>>()
            .join(", ");
        let catalogue = format!(
            "sqlite_master(type, name, tbl_name, rootpage, sql) AS (VALUES {values}), sqlite_schema(type, name, tbl_name, rootpage, sql) AS (SELECT * FROM sqlite_master)"
        );
        let Ok(answer) = exec_raw(self.db, &with_ctes(text, &catalogue), params) else { return all };
        if answer.is_empty() {
            return Vec::new();
        }
        let owners: HashMap<&str, &str> = entries.iter().map(|(_, name, table, _)| (name.as_str(), table.as_str())).collect();
        let named: BTreeSet<String> = answer
            .iter()
            .flat_map(|row| row.iter().filter_map(|(_, value)| text_of(value)))
            .filter_map(|value| owners.get(value).map(|table| table.to_string()))
            .collect();
        if named.is_empty() { all } else { named.into_iter().collect() }
    }

    fn run(&self, text: &str, params: &[SqlValue]) -> rusqlite::Result<Vec<Answer>> {
        let p = patterns();
        if !self.waiting() || !single(text) {
            return exec_raw(self.db, text, params);
        }
        let mut tables = self.named(text, params);
        // A read of the schema that lists tables without naming one sees every declared table it would list: those are made.
        if tables.is_empty() && p.lists_tables.is_match(text) {
            for name in self.listed(text, params) {
                self.make(&name)?;
            }
        }
        if tables.is_empty() {
            return exec_raw(self.db, text, params);
        }
        let make_all = |tables: &BTreeSet<String>| -> rusqlite::Result<Vec<Answer>> {
            for name in tables {
                self.make(name)?;
            }
            exec_raw(self.db, text, params)
        };
        if p.introspects.is_match(text) || self.bound(params, &tables) {
            return make_all(&tables);
        }
        let change = p.change.captures(text);
        if let Some(change) = &change {
            if self.waiting_name(&change[1]).is_some() {
                return nothing(self.db);
            }
        }
        if let Some(insert) = p.insert_into.captures(text) {
            if let Some(target) = self.waiting_name(&insert[1]) {
                self.make(&target)?;
                tables.remove(&target);
            }
            return if tables.is_empty() { exec_raw(self.db, text, params) } else { exec_raw(self.db, &self.shadowed(text, &tables), params) };
        }
        let reads = change.is_none() && (p.select.is_match(text) || (p.with.is_match(text) && !p.changes.is_match(text)));
        if reads { exec_raw(self.db, &self.shadowed(text, &tables), params) } else { make_all(&tables) }
    }

    /// Run one statement through the seam.
    pub fn exec(&self, text: &str, params: &[SqlValue]) -> rusqlite::Result<Vec<Answer>> {
        let p = patterns();
        let one = single(text);
        if let Some(table) = one.then(|| p.create_table.captures(text)).flatten() {
            let name = table[1].to_string();
            if self.waiting_name(&name).is_some() {
                return nothing(self.db);
            }
            let declared = self.state.borrow().declared.contains_key(&name);
            let body = if declared { None } else { bracketed(text, table.get(0).map_or(0, |m| m.end())) };
            let columns = body.as_deref().and_then(columns_of);
            let exists = || exec_raw(self.db, "SELECT 1 FROM pragma_table_info(?) LIMIT 1", &[SqlValue::Text(name.clone())]).map(|rows| !rows.is_empty());
            let Some(columns) = columns else { return exec_raw(self.db, text, params) };
            if !params.is_empty() || exists()? {
                return exec_raw(self.db, text, params);
            }
            let mut state = self.state.borrow_mut();
            state.declared.insert(name.clone(), Table { create: text.to_string(), columns, indexes: Vec::new() });
            state.waiting.insert(name.to_lowercase(), name);
            drop(state);
            return nothing(self.db);
        }
        if let Some(index) = one.then(|| p.create_index.captures(text)).flatten() {
            if params.is_empty() {
                if let Some(owner) = self.waiting_name(&index[2]) {
                    let mut state = self.state.borrow_mut();
                    let indexes = &mut state.declared.get_mut(&owner).expect("kept table").indexes;
                    indexes.retain(|(name, _)| name != &index[1]);
                    indexes.push((index[1].to_string(), text.to_string()));
                    state.index_table.insert(index[1].to_lowercase(), owner);
                    drop(state);
                    return nothing(self.db);
                }
            }
        }
        if let Some(drop_table) = p.drop_table.captures(text) {
            if let Some(name) = self.waiting_name(&drop_table[1]) {
                let mut state = self.state.borrow_mut();
                state.waiting.remove(&name.to_lowercase());
                state.declared.remove(&name);
                drop(state);
                return nothing(self.db);
            }
        }
        match self.run(text, params) {
            Ok(answer) => Ok(answer),
            Err(error) => {
                // A table made here that a rollback took back is made again, once, for the statement that found it missing.
                let message = error.to_string();
                let Some(missing) = p.missing.captures(&message).map(|m| m[1].to_string()) else { return Err(error) };
                let name = {
                    let state = self.state.borrow();
                    if state.declared.contains_key(&missing) { Some(missing.clone()) } else { state.index_table.get(&missing.to_lowercase()).cloned() }
                };
                match name {
                    Some(name) if self.state.borrow().declared.contains_key(&name) => {
                        self.make(&name)?;
                        self.run(text, params)
                    }
                    _ => Err(error),
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "first_write_tests.rs"]
mod tests;
