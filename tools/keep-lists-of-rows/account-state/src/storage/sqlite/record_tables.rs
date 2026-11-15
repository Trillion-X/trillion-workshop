// Purpose: Typed SQL tables per declared kind: a kind whose declaration says it is a table (`"table": true`,
// `customer_declared` or `declared_by`, DATA per kind) gets one physical table (`rt_<hash>`) with one typed column per
// declared field (`f_<hash>`) and one partial index per declared index, kept beside the record store as a projection; the
// record's whole JSON value stays authoritative. Fields are added by ALTER TABLE ADD COLUMN, a type change is a new
// generation (a new column; values already saved keep their JSON), the physical column limit compacts retired
// generations, and every schema change is a dated history row.
//
// Ported one to one from old trillion `parts/record-log/do-work/record-tables.mjs` (tag old-trillion-before-worker-retire,
// 464 lines). Each kind's current layout is also laid out as a family made while the program runs (`storage::runtime_family`) of the
// schema the store's supply runs, so the generic `Storage` operations read the typed table by key like any DATA row.
//
// Non-Negotiable Invariants:
// - Names are hashes of the kind, field and generation (`rt_`, `f_`, `rti_` + BLAKE3 hex), so no kind or field text
//   reaches a statement as an identifier; values are bound, and the field names an expression needs are hex literals.
// - Only a kind its declaration marks as a table qualifies; a declared value of the wrong type is refused before any SQL.
// - A table holds at most 100 physical columns (7 base + 93 fields); at the limit a retired generation or a removed
//   field's column is dropped (its values live on in the record JSON), never a live one.
// - An unchanged value does not rewrite its row: the upsert updates only when the value, the tombstone or a typed cell
//   differs.
// - Schema changes are made in the caller's transaction, so a rollback takes the table, its metadata and its history
//   back together; `forget_ready` drops what this owner remembered of them.
// - Index keys order by the JSON spelling of each value, then the record id, the same tuple order the packed record
//   indexes use, so paging and ties agree.
//
// Key Concepts:
// - `Kind`: a kind declaration as DATA: `type`, `properties` (field -> type name), `indexes`, and what marks it a table.
//
// Security Considerations:
// - Injection-shaped kind and field names stay data: they are hashed into names and hex-encoded into literals.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::first_write::{exec_raw, Answer};
use content_crypto::advanced::blake3;
use rusqlite::{types::Value as SqlValue, Connection};
use serde_json::{json, Map, Value};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet, HashSet},
};

const KINDS: &str = "_record_tables_kinds";
const FIELDS: &str = "_record_tables_fields";
const HISTORY: &str = "_record_tables_history";
const INDEXES: &str = "_record_tables_indexes";
/// The most rows (and characters of their values) one statement writes to a kind's table.
const PUT_ROWS: usize = 64;
const PUT_CHARS: usize = 512 * 1024;
/// How a typed table is laid out: WITHOUT ROWID, so a row saved is one write (its _id is the table's own key).
pub const LAYOUT: &str = "without-rowid-canonical-json-index-order";
const BASE_COLUMNS: [&str; 7] = ["_id", "_deleted", "_changed_at", "_transaction_id", "_actor", "_value_json", "_index_values"];
const COLUMN_LIMIT: usize = 100;
pub const ACTIVE_FIELD_LIMIT: usize = COLUMN_LIMIT - BASE_COLUMNS.len();

fn q(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
fn text_literal(value: &str) -> String {
    let hex: String = value.bytes().map(|byte| format!("{byte:02X}")).collect();
    format!("CAST(X'{hex}' AS TEXT)")
}
fn hash(value: &str) -> String {
    blake3::hash(value.as_bytes()).to_hex().to_string()
}
fn js(value: &Value) -> String {
    serde_json::to_string(value).expect("JSON text")
}
pub fn table_name(kind: &str) -> String {
    format!("rt_{}", hash(&js(&json!(["kind", kind]))))
}
fn field_column(kind: &str, field: &str, generation: i64) -> String {
    format!("f_{}", hash(&js(&json!(["field", kind, field, generation]))))
}
fn type_name(raw: &str) -> &'static str {
    match raw {
        "text" | "string" | "id" | "date" | "file" => "text",
        "number" => "number",
        "boolean" => "boolean",
        "list" | "texts" | "numbers" | "objects" | "row-ids" => "list",
        _ => "json",
    }
}
fn affinity(kind: &str) -> &'static str {
    match kind {
        "text" => "TEXT",
        "number" => "REAL",
        "boolean" => "INTEGER",
        _ => "TEXT",
    }
}

/// A refusal of a kind's schema or a value against it (old `RecordTableSchemaError`).
#[derive(Debug)]
pub enum TableError {
    Schema { cause: crate::refusal_cause::Cause, message: String, limit: Option<usize> },
    Sql(String, crate::refusal_cause::Cause),
    Invalid(&'static str, crate::refusal_cause::Cause),
}
impl TableError {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Schema { cause, .. } => cause.clone(),
            Self::Sql(_, cause) => cause.clone(),
            Self::Invalid(_, cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(TableError);


impl PartialEq for TableError {
    fn eq(&self, other: &Self) -> bool {
        match (self,other) {
            (Self::Schema { message: a0, limit: a1, .. }, Self::Schema { message: b0, limit: b1, .. }) => a0 == b0 && a1 == b1,
            (Self::Sql(a0, _),Self::Sql(b0, _)) => a0 == b0,
            (Self::Invalid(a0, _),Self::Invalid(b0, _)) => a0 == b0,
            _ => false,
        }
    }
}

impl From<rusqlite::Error> for TableError {
    #[track_caller]
    fn from(error: rusqlite::Error) -> Self {
        Self::Sql(error.to_string(), crate::cause!(caller_site: Self::Sql))
    }
}
type Result<T> = std::result::Result<T, TableError>;

/// Who, when and in which transaction a change was made.
#[derive(Clone, Debug, Default)]
pub struct Context {
    pub at: Option<String>,
    pub transaction_id: Option<String>,
    pub actor: Option<Value>,
    /// False skips the declared-type check of a put (old `context.validate === false`).
    pub skip_validate: bool,
}
struct Stamp {
    changed_at: String,
    transaction_id: Option<String>,
    actor: Option<String>,
}
fn stamp(context: &Context) -> Stamp {
    Stamp {
        changed_at: context.at.clone().unwrap_or_else(|| {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
            format!("{}", now.as_millis())
        }),
        transaction_id: context.transaction_id.clone(),
        actor: context.actor.as_ref().map(js),
    }
}

fn property_type(shape: &Value, value_kinds: &Map<String, Value>) -> &'static str {
    let shape = match shape {
        Value::String(name) => value_kinds.get(name).cloned().unwrap_or_else(|| shape.clone()),
        other => other.clone(),
    };
    let raw = match &shape {
        Value::String(name) => name.clone(),
        Value::Object(object) => match object.get("is").and_then(Value::as_str) {
            Some(is) => is.to_string(),
            None if object.get("list_of").is_some_and(|list| !list.is_null()) => "list".into(),
            None => "json".into(),
        },
        _ => "json".into(),
    };
    type_name(&raw)
}

fn encode(value: Option<&Value>, kind: &str, field: &str) -> Result<SqlValue> {
    let Some(value) = value.filter(|value| !value.is_null()) else { return Ok(SqlValue::Null) };
    match (kind, value) {
        ("text", Value::String(text)) => Ok(SqlValue::Text(text.clone())),
        ("number", Value::Number(number)) if number.as_f64().is_some_and(f64::is_finite) => Ok(SqlValue::Real(number.as_f64().unwrap_or_default())),
        ("boolean", Value::Bool(flag)) => Ok(SqlValue::Integer(i64::from(*flag))),
        ("list", Value::Array(_)) | ("json", _) => Ok(SqlValue::Text(js(value))),
        _ => Err(TableError::Schema { message: format!("Field {field} must have the declared {kind} value type."), limit: None, cause: crate::cause!() }),
    }
}
fn decode(value: &SqlValue, kind: &str) -> Value {
    match value {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(n) if kind == "boolean" => Value::Bool(*n == 1),
        SqlValue::Text(text) if kind == "list" || kind == "json" => serde_json::from_str(text).unwrap_or(Value::Null),
        SqlValue::Text(text) => json!(text),
        SqlValue::Integer(n) => json!(n),
        SqlValue::Real(n) => json!(n),
        SqlValue::Blob(_) => Value::Null,
    }
}

/// One field row of the metadata.
#[derive(Clone, Debug)]
pub struct FieldRow {
    pub field: String,
    pub generation: i64,
    pub value_type: String,
    pub column_name: String,
    pub declared: bool,
}
fn index_key_expression(field: &FieldRow) -> String {
    // Keep the original JSON spelling: SQLite REAL values can turn 1 into 1.0, which changes bytewise tuple order.
    format!("json_extract({}, {})", q("_index_values"), text_literal(&format!("$.\"{}\"", field.column_name)))
}

/// One kind's table as `ensure` left it.
pub struct Ensured {
    pub table: String,
    pub declared: Vec<(String, &'static str)>,
    pub fields: BTreeMap<String, FieldRow>,
}
/// One field of a schema answer.
#[derive(Debug, PartialEq)]
pub struct SchemaField {
    pub field: String,
    pub value_type: String,
    pub column: Option<String>,
}
/// What `schema` answers for a kind.
#[derive(Debug)]
pub struct KindSchema {
    pub table: String,
    pub fields: Vec<SchemaField>,
    pub statements: Vec<String>,
}
/// One saved row.
#[derive(Debug, PartialEq)]
pub struct TableRow {
    pub id: String,
    pub value: Value,
    pub changed_at: Option<String>,
    pub transaction_id: Option<String>,
    pub actor: Option<Value>,
}
/// One schema history row.
#[derive(Debug, PartialEq)]
pub struct HistoryRow {
    pub sequence: i64,
    pub kind: String,
    pub event: String,
    pub field: Option<String>,
    pub old_type: Option<String>,
    pub new_type: Option<String>,
    pub changed_at: String,
}
/// A schema change as it is made (old `onSchemaChange`).
#[derive(Clone, Debug, PartialEq)]
pub struct Change {
    pub kind: String,
    pub event: String,
    pub field: Option<String>,
}
/// An index walk (old `scanIndex` options).
#[derive(Default)]
pub struct IndexScan {
    pub equal: Vec<Value>,
    pub from: Option<Value>,
    pub to: Option<Value>,
    pub after: Option<Value>,
    pub after_id: Option<String>,
    pub before: Option<Value>,
    pub starts_with: Option<String>,
    pub id_from: Option<String>,
    pub id_to: Option<String>,
    pub reverse: bool,
    pub limit: usize,
}

fn cell<'a>(row: &'a Answer, name: &str) -> &'a SqlValue {
    row.iter().find(|(column, _)| column == name).map(|(_, value)| value).unwrap_or(&SqlValue::Null)
}
fn cell_text(row: &Answer, name: &str) -> Option<String> {
    match cell(row, name) {
        SqlValue::Text(text) => Some(text.clone()),
        _ => None,
    }
}
fn cell_int(row: &Answer, name: &str) -> i64 {
    match cell(row, name) {
        SqlValue::Integer(n) => *n,
        _ => 0,
    }
}
fn t(text: &str) -> SqlValue {
    SqlValue::Text(text.into())
}

/// The typed tables of one connection. `kind_of` answers a kind's declaration (DATA), None for no such kind.
pub struct RecordTables<'c> {
    db: &'c Connection,
    kind_of: Box<dyn Fn(&str) -> Option<Value> + 'c>,
    value_kinds: Map<String, Value>,
    on_change: Option<Box<dyn Fn(&Change) + 'c>>,
    /// The schema of the store whose supply reads the typed tables through the generic operations.
    family_schema: Option<String>,
    laid_out: RefCell<HashSet<String>>,
    present: RefCell<HashSet<String>>,
}

impl<'c> RecordTables<'c> {
    pub fn new(db: &'c Connection, kind_of: impl Fn(&str) -> Option<Value> + 'c) -> Self {
        RecordTables { db, kind_of: Box::new(kind_of), value_kinds: Map::new(), on_change: None, family_schema: None, laid_out: Default::default(), present: Default::default() }
    }
    pub fn with_value_kinds(mut self, value_kinds: Map<String, Value>) -> Self {
        self.value_kinds = value_kinds;
        self
    }
    pub fn on_change(mut self, hear: impl Fn(&Change) + 'c) -> Self {
        self.on_change = Some(Box::new(hear));
        self
    }
    /// Lay out each ensured kind as a family of `schema` made while the program runs (`storage::runtime_family`).
    pub fn as_families_of(mut self, schema: &str) -> Self {
        self.family_schema = Some(schema.to_string());
        self
    }
    /// Forget what this owner remembered of the tables (a rollback took them back).
    pub fn forget_ready(&self) {
        self.present.borrow_mut().clear();
        self.laid_out.borrow_mut().clear();
    }

    fn exec(&self, text: &str, params: &[SqlValue]) -> Result<Vec<Answer>> {
        Ok(exec_raw(self.db, text, params)?)
    }
    fn table_ready(&self, name: &str) -> Result<bool> {
        if self.present.borrow().contains(name) {
            return Ok(true);
        }
        if self.exec("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", &[t(name)])?.is_empty() {
            return Ok(false);
        }
        self.present.borrow_mut().insert(name.to_string());
        Ok(true)
    }
    fn create_table(&self, table: &str, columns: &[(String, &str)]) -> Result<()> {
        let extra: String = columns.iter().map(|(name, kind)| format!(", {} {kind}", q(name))).collect();
        self.exec(&format!("CREATE TABLE {} (_id TEXT PRIMARY KEY NOT NULL, _deleted INTEGER NOT NULL DEFAULT 0, _changed_at TEXT, _transaction_id TEXT, _actor TEXT, _value_json TEXT NOT NULL DEFAULT '{{}}', _index_values TEXT NOT NULL DEFAULT '{{}}'{extra}) WITHOUT ROWID", q(table)), &[])?;
        Ok(())
    }
    fn create_metadata(&self) -> Result<()> {
        self.exec(&format!("CREATE TABLE IF NOT EXISTS {} (kind TEXT PRIMARY KEY, table_name TEXT NOT NULL UNIQUE)", q(KINDS)), &[])?;
        self.exec(&format!("CREATE TABLE IF NOT EXISTS {} (kind TEXT NOT NULL, field TEXT NOT NULL, generation INTEGER NOT NULL, value_type TEXT NOT NULL, column_name TEXT NOT NULL, declared INTEGER NOT NULL, PRIMARY KEY(kind, field, generation), UNIQUE(kind, column_name))", q(FIELDS)), &[])?;
        self.exec(&format!("CREATE TABLE IF NOT EXISTS {} (kind TEXT NOT NULL, index_name TEXT NOT NULL, definition TEXT NOT NULL, physical_name TEXT NOT NULL UNIQUE, PRIMARY KEY(kind, index_name, definition))", q(INDEXES)), &[])?;
        self.exec(&format!("CREATE TABLE IF NOT EXISTS {} (sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, changed_at TEXT NOT NULL, transaction_id TEXT, actor TEXT, event TEXT NOT NULL, field TEXT, old_type TEXT, new_type TEXT)", q(HISTORY)), &[])?;
        Ok(())
    }
    fn event(&self, kind: &str, name: &str, context: &Context, field: Option<&str>, old_type: Option<&str>, new_type: Option<&str>) -> Result<()> {
        let at = stamp(context);
        let opt = |value: Option<&str>| value.map_or(SqlValue::Null, t);
        self.exec(
            &format!("INSERT INTO {} (kind, changed_at, transaction_id, actor, event, field, old_type, new_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", q(HISTORY)),
            &[t(kind), t(&at.changed_at), opt(at.transaction_id.as_deref()), opt(at.actor.as_deref()), t(name), opt(field), opt(old_type), opt(new_type)],
        )?;
        if let Some(hear) = &self.on_change {
            hear(&Change { kind: kind.to_string(), event: name.to_string(), field: field.map(str::to_owned) });
        }
        Ok(())
    }

    /// The declaration of a kind that qualifies as a table.
    fn require_kind(&self, kind: &str) -> Result<Value> {
        if kind.is_empty() {
            return Err(TableError::Invalid("A record kind type is required.", crate::cause!()));
        }
        let declared = (self.kind_of)(kind).unwrap_or(Value::Null);
        let qualifies = declared.get("declared_by").is_some_and(|by| !by.is_null() && by != &json!(false) && by != &json!(""))
            || declared.get("table") == Some(&json!(true))
            || declared.get("customer_declared") == Some(&json!(true));
        if !qualifies {
            return Err(TableError::Schema { message: format!("Record kind {kind} is not customer-declared."), limit: None, cause: crate::cause!() });
        }
        if !declared.get("properties").is_some_and(Value::is_object) {
            return Err(TableError::Schema { message: format!("Record kind {kind} has no declared properties."), limit: None, cause: crate::cause!() });
        }
        Ok(declared)
    }
    fn declared_fields(&self, declaration: &Value) -> Vec<(String, &'static str)> {
        declaration["properties"].as_object().map(|properties| properties.iter().map(|(field, shape)| (field.clone(), property_type(shape, &self.value_kinds))).collect()).unwrap_or_default()
    }

    fn latest_fields(&self, kind: &str) -> Result<BTreeMap<String, FieldRow>> {
        let mut result = BTreeMap::new();
        if !self.table_ready(FIELDS)? {
            return Ok(result);
        }
        for row in self.exec(&format!("SELECT field, generation, value_type, column_name, declared FROM {} WHERE kind = ? ORDER BY field, generation", q(FIELDS)), &[t(kind)])? {
            let field = FieldRow {
                field: cell_text(&row, "field").unwrap_or_default(),
                generation: cell_int(&row, "generation"),
                value_type: cell_text(&row, "value_type").unwrap_or_default(),
                column_name: cell_text(&row, "column_name").unwrap_or_default(),
                declared: cell_int(&row, "declared") != 0,
            };
            result.insert(field.field.clone(), field);
        }
        Ok(result)
    }
    fn registered(&self, kind: &str) -> Result<Option<String>> {
        if !self.table_ready(KINDS)? {
            return Ok(None);
        }
        Ok(self.exec(&format!("SELECT table_name FROM {} WHERE kind = ?", q(KINDS)), &[t(kind)])?.first().and_then(|row| cell_text(row, "table_name")))
    }
    fn table_columns(&self, table: &str) -> Result<Vec<String>> {
        Ok(self.exec(&format!("PRAGMA table_info({})", q(table)), &[])?.iter().filter_map(|row| cell_text(row, "name")).collect())
    }

    /// Make or change the kind's table to its declaration, in the caller's transaction.
    pub fn ensure(&self, kind: &str, context: &Context) -> Result<Ensured> {
        self.create_metadata()?;
        let declaration = self.require_kind(kind)?;
        let table = table_name(kind);
        let declared = self.declared_fields(&declaration);
        if declared.iter().any(|(field, _)| field.is_empty()) {
            return Err(TableError::Schema { message: format!("Record kind {kind} declares an empty field name."), limit: None, cause: crate::cause!() });
        }
        let registered = self.exec(&format!("SELECT table_name FROM {} WHERE kind = ?", q(KINDS)), &[t(kind)])?.first().and_then(|row| cell_text(row, "table_name"));
        if registered.as_ref().is_some_and(|known| known != &table) {
            return Err(TableError::Schema { message: format!("Stored table identity for {kind} is inconsistent."), limit: None, cause: crate::cause!() });
        }
        if registered.is_none() {
            if let Some(collision) = self.exec(&format!("SELECT kind FROM {} WHERE table_name = ?", q(KINDS)), &[t(&table)])?.first().and_then(|row| cell_text(row, "kind")) {
                return Err(TableError::Schema { message: format!("Table-name collision between {kind} and {collision}."), limit: None, cause: crate::cause!() });
            }
            if declared.len() > ACTIVE_FIELD_LIMIT {
                return Err(TableError::Schema { cause: crate::cause!(), message: format!("This database supports at most {ACTIVE_FIELD_LIMIT} active table fields."), limit: Some(ACTIVE_FIELD_LIMIT) });
            }
            // A fresh kind has no earlier generations: its complete initial layout is declared once.
            let columns: Vec<(String, &str)> = declared.iter().map(|(field, kind_type)| (field_column(kind, field, 0), affinity(kind_type))).collect();
            self.create_table(&table, &columns)?;
            self.exec(&format!("INSERT INTO {} (kind, table_name) VALUES (?, ?)", q(KINDS)), &[t(kind), t(&table)])?;
            self.present.borrow_mut().insert(KINDS.into());
            self.event(kind, "kind_added", context, None, None, None)?;
        } else if !self.laid_out.borrow().contains(&table) {
            // A table made before LAYOUT (a rowid table) is made again WITHOUT ROWID with the same columns, empty.
            let made = self.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", &[t(&table)])?.first().and_then(|row| cell_text(row, "sql")).unwrap_or_default();
            let columns = self.table_columns(&table)?;
            if !made.trim_end().to_ascii_uppercase().ends_with("WITHOUT ROWID") || !columns.iter().any(|column| column == "_index_values") {
                let info = self.exec(&format!("PRAGMA table_info({})", q(&table)), &[])?;
                let kept: Vec<(String, String)> = info.iter().filter_map(|row| Some((cell_text(row, "name")?, cell_text(row, "type").unwrap_or_default()))).filter(|(name, _)| !BASE_COLUMNS.contains(&name.as_str())).collect();
                self.exec(&format!("DROP TABLE IF EXISTS {}", q(&table)), &[])?;
                let kept: Vec<(String, &str)> = kept.iter().map(|(name, kind_type)| (name.clone(), kind_type.as_str())).collect();
                self.create_table(&table, &kept)?;
                self.exec(&format!("DELETE FROM {} WHERE kind = ?", q(INDEXES)), &[t(kind)])?;
                self.event(kind, "table_rebuilt", context, None, None, None)?;
            }
        }
        self.laid_out.borrow_mut().insert(table.clone());

        let mut previous_fields = self.latest_fields(kind)?;
        let declared_names: BTreeSet<&str> = declared.iter().map(|(field, _)| field.as_str()).collect();
        let add_column = |column: &str, kind_type: &str, previous_fields: &BTreeMap<String, FieldRow>| -> Result<()> {
            let physical = self.table_columns(&table)?;
            if physical.len() >= COLUMN_LIMIT {
                // At the physical limit, an older generation or a removed field's column is compacted: full values keep it.
                let live: HashSet<String> = declared_names.iter().filter_map(|field| previous_fields.get(*field).map(|row| row.column_name.clone())).collect();
                let retired = self
                    .exec(&format!("SELECT column_name FROM {} WHERE kind = ? ORDER BY field, generation", q(FIELDS)), &[t(kind)])?
                    .iter()
                    .filter_map(|row| cell_text(row, "column_name"))
                    .find(|name| !live.contains(name) && physical.contains(name));
                let Some(retired) = retired else {
                    return Err(TableError::Schema { cause: crate::cause!(), message: format!("This database supports at most {ACTIVE_FIELD_LIMIT} active table fields."), limit: Some(ACTIVE_FIELD_LIMIT) });
                };
                for index in self.exec(&format!("SELECT physical_name FROM {} WHERE kind = ?", q(INDEXES)), &[t(kind)])? {
                    self.exec(&format!("DROP INDEX IF EXISTS {}", q(&cell_text(&index, "physical_name").unwrap_or_default())), &[])?;
                }
                self.exec(&format!("DELETE FROM {} WHERE kind = ?", q(INDEXES)), &[t(kind)])?;
                self.exec(&format!("ALTER TABLE {} DROP COLUMN {}", q(&table), q(&retired)), &[])?;
            }
            self.exec(&format!("ALTER TABLE {} ADD COLUMN {} {}", q(&table), q(column), affinity(kind_type)), &[])?;
            Ok(())
        };

        for (field, kind_type) in &declared {
            let Some(previous) = previous_fields.get(field).cloned() else {
                let column = field_column(kind, field, 0);
                if registered.is_some() {
                    add_column(&column, kind_type, &previous_fields)?;
                }
                self.exec(&format!("INSERT INTO {} (kind, field, generation, value_type, column_name, declared) VALUES (?, ?, 0, ?, ?, 1)", q(FIELDS)), &[t(kind), t(field), t(kind_type), t(&column)])?;
                self.event(kind, "field_added", context, Some(field), None, Some(kind_type))?;
                previous_fields.insert(field.clone(), FieldRow { field: field.clone(), generation: 0, value_type: kind_type.to_string(), column_name: column, declared: true });
                continue;
            };
            if previous.value_type != *kind_type {
                let generation = previous.generation + 1;
                let column = field_column(kind, field, generation);
                // This generation replaces its predecessor; the predecessor can be compacted at the physical limit.
                previous_fields.insert(field.clone(), FieldRow { column_name: column.clone(), ..previous.clone() });
                add_column(&column, kind_type, &previous_fields)?;
                self.exec(&format!("INSERT INTO {} (kind, field, generation, value_type, column_name, declared) VALUES (?, ?, ?, ?, ?, 1)", q(FIELDS)), &[t(kind), t(field), SqlValue::Integer(generation), t(kind_type), t(&column)])?;
                self.event(kind, "field_type_changed", context, Some(field), Some(&previous.value_type), Some(kind_type))?;
                previous_fields.insert(field.clone(), FieldRow { field: field.clone(), generation, value_type: kind_type.to_string(), column_name: column, declared: true });
            } else if !previous.declared {
                if !self.table_columns(&table)?.contains(&previous.column_name) {
                    add_column(&previous.column_name, kind_type, &previous_fields)?;
                }
                self.exec(&format!("UPDATE {} SET declared = 1 WHERE kind = ? AND field = ? AND generation = ?", q(FIELDS)), &[t(kind), t(field), SqlValue::Integer(previous.generation)])?;
                self.event(kind, "field_restored", context, Some(field), None, Some(kind_type))?;
            }
        }
        for (field, previous) in &previous_fields {
            if previous.declared && !declared_names.contains(field.as_str()) {
                self.exec(&format!("UPDATE {} SET declared = 0 WHERE kind = ? AND field = ? AND generation = ?", q(FIELDS)), &[t(kind), t(field), SqlValue::Integer(previous.generation)])?;
                self.event(kind, "field_removed", context, Some(field), Some(&previous.value_type), None)?;
            }
        }

        let fields = self.latest_fields(kind)?;
        let mut desired = HashSet::new();
        for index in declaration.get("indexes").and_then(Value::as_array).cloned().unwrap_or_default() {
            let name = index.get("name").and_then(Value::as_str).filter(|name| !name.is_empty());
            let index_fields: Vec<String> = index.get("fields").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default();
            let Some(name) = name.filter(|_| !index_fields.is_empty()) else {
                return Err(TableError::Schema { message: format!("An index of {kind} needs a name and at least one field."), limit: None, cause: crate::cause!() });
            };
            let mut columns = Vec::new();
            let mut keys = Vec::new();
            for field in &index_fields {
                if !declared_names.contains(field.as_str()) {
                    return Err(TableError::Schema { message: format!("Index {name} on {kind} names undeclared field {field}."), limit: None, cause: crate::cause!() });
                }
                columns.push(fields[field].column_name.clone());
                keys.push(index_key_expression(&fields[field]));
            }
            let definition = js(&json!({ "fields": index_fields, "columns": columns, "keys": keys }));
            desired.insert((name.to_string(), definition.clone()));
            for old in self.exec(&format!("SELECT definition, physical_name FROM {} WHERE kind = ? AND index_name = ? AND definition <> ?", q(INDEXES)), &[t(kind), t(name), t(&definition)])? {
                self.exec(&format!("DROP INDEX IF EXISTS {}", q(&cell_text(&old, "physical_name").unwrap_or_default())), &[])?;
                self.exec(&format!("DELETE FROM {} WHERE kind = ? AND index_name = ? AND definition = ?", q(INDEXES)), &[t(kind), t(name), t(&cell_text(&old, "definition").unwrap_or_default())])?;
            }
            let exists = !self.exec(&format!("SELECT physical_name FROM {} WHERE kind = ? AND index_name = ? AND definition = ?", q(INDEXES)), &[t(kind), t(name), t(&definition)])?.is_empty();
            if !exists {
                let physical = format!("rti_{}", hash(&js(&json!([kind, name, definition]))));
                if !self.exec(&format!("SELECT kind FROM {} WHERE physical_name = ?", q(INDEXES)), &[t(&physical)])?.is_empty() {
                    return Err(TableError::Schema { message: format!("Index-name collision for {kind}.{name}."), limit: None, cause: crate::cause!() });
                }
                self.exec(&format!("CREATE INDEX {} ON {} ({}, _id) WHERE _deleted = 0", q(&physical), q(&table), keys.join(", ")), &[])?;
                self.exec(&format!("INSERT INTO {} (kind, index_name, definition, physical_name) VALUES (?, ?, ?, ?)", q(INDEXES)), &[t(kind), t(name), t(&definition), t(&physical)])?;
                self.event(kind, "index_added", context, Some(name), None, None)?;
            }
        }
        for old in self.exec(&format!("SELECT index_name, definition, physical_name FROM {} WHERE kind = ?", q(INDEXES)), &[t(kind)])? {
            let key = (cell_text(&old, "index_name").unwrap_or_default(), cell_text(&old, "definition").unwrap_or_default());
            if desired.contains(&key) {
                continue;
            }
            self.exec(&format!("DROP INDEX IF EXISTS {}", q(&cell_text(&old, "physical_name").unwrap_or_default())), &[])?;
            self.exec(&format!("DELETE FROM {} WHERE kind = ? AND index_name = ? AND definition = ?", q(INDEXES)), &[t(kind), t(&key.0), t(&key.1)])?;
            self.event(kind, "index_removed", context, Some(&key.0), None, None)?;
        }
        if let Some(schema) = &self.family_schema {
            let mut columns: Vec<String> = BASE_COLUMNS.iter().map(|name| name.to_string()).collect();
            columns.extend(declared.iter().filter_map(|(field, _)| fields.get(field).map(|row| row.column_name.clone())));
            let family = crate::storage::Family {
                family: table.clone(),
                key: vec!["_id".into()],
                fields: columns,
                orders: BTreeMap::new(),
                arrival: false,
                readers: vec!["src/storage/sqlite/record_tables.rs".into()],
                made: crate::storage::Made::Open,
            };
            crate::storage::runtime_family(schema, family).map_err(|_| TableError::Invalid("the kind's table cannot be laid out as a family", crate::cause!()))?;
        }
        Ok(Ensured { table, declared, fields })
    }

    /// The kind's schema as declared and as laid out, without writing anything.
    pub fn schema(&self, kind: &str) -> Result<KindSchema> {
        let declaration = self.require_kind(kind)?;
        let declared = self.declared_fields(&declaration);
        if !self.table_ready(KINDS)? {
            return Ok(KindSchema { table: table_name(kind), fields: declared.into_iter().map(|(field, value_type)| SchemaField { field, value_type: value_type.into(), column: None }).collect(), statements: Vec::new() });
        }
        let registered = self.registered(kind)?;
        let fields = self.latest_fields(kind)?;
        let table = registered.clone().unwrap_or_else(|| table_name(kind));
        let statements = if registered.is_some() {
            self.exec("SELECT type, sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type DESC, name", &[t(&table)])?.iter().filter_map(|row| cell_text(row, "sql")).collect()
        } else {
            Vec::new()
        };
        Ok(KindSchema {
            table,
            fields: declared.into_iter().map(|(field, value_type)| SchemaField { column: fields.get(&field).map(|row| row.column_name.clone()), field, value_type: value_type.into() }).collect(),
            statements,
        })
    }

    /// Records of kinds written to their tables, PUT_ROWS (or PUT_CHARS of their values) a statement.
    pub fn put_many(&self, records: &[(&str, &str, &Value)], context: &Context) -> Result<()> {
        let mut by_kind: BTreeMap<&str, Vec<(&str, &Value)>> = BTreeMap::new();
        let mut order: Vec<&str> = Vec::new();
        for (id, kind, value) in records {
            if id.is_empty() || kind.is_empty() || !value.is_object() {
                return Err(TableError::Invalid("put needs { id, type, value } with an object value.", crate::cause!()));
            }
        }
        for (id, kind, value) in records {
            let declaration = self.require_kind(kind)?;
            if !context.skip_validate {
                for (field, kind_type) in self.declared_fields(&declaration) {
                    encode(value.get(&field), kind_type, &field)?;
                }
            }
            if !by_kind.contains_key(kind) {
                order.push(kind);
            }
            by_kind.entry(kind).or_default().push((id, value));
        }
        let at = stamp(context);
        for kind in order {
            let current = self.ensure(kind, context)?;
            let fields: Vec<&(String, &str)> = current.declared.iter().collect();
            let column = |field: &str| current.fields[field].column_name.clone();
            let mut columns: Vec<String> = BASE_COLUMNS.iter().map(|name| name.to_string()).collect();
            columns.extend(fields.iter().map(|(field, _)| column(field)));
            let accepted = |kind_type: &str| match kind_type {
                "text" => "'text'",
                "number" => "'integer', 'real'",
                "boolean" => "'true', 'false'",
                "list" => "'array'",
                _ => "'object', 'array', 'text', 'integer', 'real', 'true', 'false'",
            };
            let typed: Vec<String> = fields
                .iter()
                .map(|(field, kind_type)| format!("(SELECT CASE WHEN j.type = 'null' OR j.type IN ({}) THEN j.value ELSE NULL END FROM json_each(source.doc) AS j WHERE j.key = {})", accepted(kind_type), text_literal(field)))
                .collect();
            let assignments: Vec<String> = columns[1..].iter().map(|column| format!("{0} = excluded.{0}", q(column))).collect();
            let changed: Vec<String> = fields.iter().map(|(field, _)| format!("{0}.{1} IS NOT excluded.{1}", q(&current.table), q(&column(field)))).collect();
            let query = format!(
                "WITH source(id, doc, changed_at, transaction_id, actor, index_values) AS (SELECT json_extract(given.value, '$[0]'), json_extract(given.value, '$[1]'), ?, ?, ?, json_extract(given.value, '$[2]') FROM json_each(?) AS given) INSERT INTO {table} ({cols}) SELECT source.id, 0, source.changed_at, source.transaction_id, source.actor, source.doc, source.index_values{typed} FROM source WHERE 1 ON CONFLICT(_id) DO UPDATE SET {assign} WHERE {table}._deleted <> excluded._deleted OR {table}._value_json IS NOT excluded._value_json{changed}",
                table = q(&current.table),
                cols = columns.iter().map(|c| q(c)).collect::<Vec<_>>().join(", "),
                typed = if typed.is_empty() { String::new() } else { format!(", {}", typed.join(", ")) },
                assign = assignments.join(", "),
                changed = if changed.is_empty() { String::new() } else { format!(" OR {}", changed.join(" OR ")) },
            );
            let opt = |value: &Option<String>| value.as_ref().map_or(SqlValue::Null, |text| t(text));
            let mut rows: Vec<Value> = Vec::new();
            let mut chars = 0usize;
            let flush = |rows: &mut Vec<Value>, chars: &mut usize| -> Result<()> {
                if !rows.is_empty() {
                    self.exec(&query, &[t(&at.changed_at), opt(&at.transaction_id), opt(&at.actor), t(&js(&Value::Array(std::mem::take(rows))))])?;
                }
                *chars = 0;
                Ok(())
            };
            for (id, value) in &by_kind[kind] {
                let doc = js(value);
                let index_values: Map<String, Value> = fields
                    .iter()
                    .filter_map(|(field, _)| value.get(field.as_str()).map(|one| (column(field), json!(js(one)))))
                    .collect();
                let index_values = js(&Value::Object(index_values));
                let size = id.len() + doc.len() + index_values.len();
                if !rows.is_empty() && (rows.len() >= PUT_ROWS || chars + size > PUT_CHARS) {
                    flush(&mut rows, &mut chars)?;
                }
                rows.push(json!([id, doc, index_values]));
                chars += size;
            }
            flush(&mut rows, &mut chars)?;
        }
        Ok(())
    }
    pub fn put(&self, id: &str, kind: &str, value: &Value, context: &Context) -> Result<()> {
        self.put_many(&[(id, kind, value)], context)
    }

    /// A record leaves its kind's table as a tombstone; answers whether a live row was there.
    pub fn remove(&self, id: &str, kind: &str, context: &Context) -> Result<bool> {
        if id.is_empty() {
            return Err(TableError::Invalid("remove needs an id and an optional type.", crate::cause!()));
        }
        let Some(table) = self.registered(kind)? else { return Ok(false) };
        if self.exec(&format!("SELECT 1 AS present FROM {} WHERE _id = ? AND _deleted = 0", q(&table)), &[t(id)])?.is_empty() {
            return Ok(false);
        }
        let at = stamp(context);
        let opt = |value: &Option<String>| value.as_ref().map_or(SqlValue::Null, |text| t(text));
        self.exec(&format!("UPDATE {} SET _deleted = 1, _changed_at = ?, _transaction_id = ?, _actor = ? WHERE _id = ? AND _deleted = 0", q(&table)), &[t(&at.changed_at), opt(&at.transaction_id), opt(&at.actor), t(id)])?;
        Ok(true)
    }

    fn row_of(row: &Answer) -> TableRow {
        TableRow {
            id: cell_text(row, "_id").unwrap_or_default(),
            // SQLite affinities can coerce retained values after a declaration changes: the saved JSON is returned exactly.
            value: cell_text(row, "_value_json").and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_else(|| json!({})),
            changed_at: cell_text(row, "_changed_at"),
            transaction_id: cell_text(row, "_transaction_id"),
            actor: cell_text(row, "_actor").and_then(|text| serde_json::from_str(&text).ok()),
        }
    }
    pub fn read(&self, id: &str, kind: &str) -> Result<Option<TableRow>> {
        let Some(table) = self.registered(kind)? else { return Ok(None) };
        Ok(self.exec(&format!("SELECT * FROM {} WHERE _id = ? AND _deleted = 0", q(&table)), &[t(id)])?.first().map(Self::row_of))
    }
    pub fn rows(&self, kind: &str, after: Option<&str>, limit: usize) -> Result<Vec<TableRow>> {
        if !(1..=1000).contains(&limit) {
            return Err(TableError::Invalid("rows limit must be between 1 and 1000.", crate::cause!()));
        }
        let Some(table) = self.registered(kind)? else { return Ok(Vec::new()) };
        let found = match after {
            None => self.exec(&format!("SELECT * FROM {} WHERE _deleted = 0 ORDER BY _id LIMIT ?", q(&table)), &[SqlValue::Integer(limit as i64)])?,
            Some(after) => self.exec(&format!("SELECT * FROM {} WHERE _deleted = 0 AND _id > ? ORDER BY _id LIMIT ?", q(&table)), &[t(after), SqlValue::Integer(limit as i64)])?,
        };
        Ok(found.iter().map(Self::row_of).collect())
    }

    /// A declared index walked on the typed table: ids and the indexed values, in JSON-spelling order, then id.
    pub fn scan_index(&self, kind: &str, name: &str, scan: &IndexScan) -> Result<Vec<(String, Vec<Value>)>> {
        if scan.limit > 1000 {
            return Err(TableError::Invalid("Index scan limit must be between 0 and 1000.", crate::cause!()));
        }
        let declaration = self.require_kind(kind)?;
        let index = declaration.get("indexes").and_then(Value::as_array).and_then(|list| list.iter().find(|index| index.get("name").and_then(Value::as_str) == Some(name)).cloned());
        let Some(index) = index else { return Err(TableError::Invalid("No index of that name is declared for the kind.", crate::cause!())) };
        let index_fields: Vec<String> = index["fields"].as_array().map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default();
        if scan.equal.len() > index_fields.len() {
            return Err(TableError::Invalid("The index has fewer fields than the equality prefix.", crate::cause!()));
        }
        if scan.after_id.is_some() && (scan.after.is_none() || index_fields.len() != scan.equal.len() + 1 || scan.from.is_some() || scan.starts_with.is_some()) {
            return Err(TableError::Invalid("after_id needs an exclusive value and record id for the final index field.", crate::cause!()));
        }
        let Some(table) = self.registered(kind)? else { return Ok(Vec::new()) };
        let current = self.latest_fields(kind)?;
        let fields: Vec<FieldRow> = index_fields.iter().map(|field| current.get(field).filter(|row| row.declared).cloned()).collect::<Option<_>>().ok_or_else(|| TableError::Schema { message: format!("Index {name} on {kind} has an unavailable field."), limit: None, cause: crate::cause!() })?;
        let expressions: Vec<String> = fields.iter().map(index_key_expression).collect();
        let mut condition = vec!["_deleted = 0".to_string()];
        condition.extend(fields.iter().map(|field| format!("{} IS NOT NULL", q(&field.column_name))));
        let mut params = Vec::new();
        for (at, value) in scan.equal.iter().enumerate() {
            condition.push(format!("{} = ?", expressions[at]));
            params.push(t(&js(value)));
        }
        if scan.equal.len() < fields.len() {
            let expression = &expressions[scan.equal.len()];
            let after = if scan.after_id.is_none() { scan.after.as_ref() } else { None };
            for (operator, value) in [(">=", scan.from.as_ref()), (">", after), ("<=", scan.to.as_ref()), ("<", scan.before.as_ref())] {
                if let Some(value) = value {
                    condition.push(format!("{expression} {operator} ?"));
                    params.push(t(&js(value)));
                }
            }
            if let (Some(after_id), Some(after)) = (&scan.after_id, &scan.after) {
                condition.push(format!("({expression} > ? OR ({expression} = ? AND _id > ?))"));
                params.extend([t(&js(after)), t(&js(after)), t(after_id)]);
            }
            if let Some(prefix) = &scan.starts_with {
                if fields[scan.equal.len()].value_type != "text" {
                    return Err(TableError::Invalid("Index startsWith needs a text field.", crate::cause!()));
                }
                let spelled = js(&json!(prefix));
                let prefix = &spelled[..spelled.len() - 1];
                condition.push(format!("substr({expression}, 1, length(?)) = ?"));
                params.extend([t(prefix), t(prefix)]);
            }
        } else {
            if let Some(from) = &scan.id_from {
                condition.push("_id >= ?".into());
                params.push(t(from));
            }
            if let Some(to) = &scan.id_to {
                condition.push("_id < ?".into());
                params.push(t(to));
            }
        }
        let direction = if scan.reverse { "DESC" } else { "ASC" };
        let order: Vec<String> = expressions.iter().map(|expression| format!("{expression} {direction}")).chain(std::iter::once(format!("_id {direction}"))).collect();
        let columns: Vec<String> = fields.iter().enumerate().map(|(at, field)| format!("{} AS v{at}", q(&field.column_name))).collect();
        params.push(SqlValue::Integer(scan.limit as i64));
        let found = self.exec(&format!("SELECT _id AS id, {} FROM {} WHERE {} ORDER BY {} LIMIT ?", columns.join(", "), q(&table), condition.join(" AND "), order.join(", ")), &params)?;
        Ok(found.iter().map(|row| (cell_text(row, "id").unwrap_or_default(), fields.iter().enumerate().map(|(at, field)| decode(cell(row, &format!("v{at}")), &field.value_type)).collect())).collect())
    }

    /// Schema changes in order, after `after`, of one kind or all.
    pub fn schema_history(&self, kind: Option<&str>, after: i64, limit: usize) -> Result<Vec<HistoryRow>> {
        if after < 0 || !(1..=1000).contains(&limit) {
            return Err(TableError::Invalid("schemaHistory needs a non-negative cursor and a limit from 1 to 1000.", crate::cause!()));
        }
        if !self.table_ready(HISTORY)? {
            return Ok(Vec::new());
        }
        let found = match kind {
            None => self.exec(&format!("SELECT * FROM {} WHERE sequence > ? ORDER BY sequence LIMIT ?", q(HISTORY)), &[SqlValue::Integer(after), SqlValue::Integer(limit as i64)])?,
            Some(kind) => self.exec(&format!("SELECT * FROM {} WHERE kind = ? AND sequence > ? ORDER BY sequence LIMIT ?", q(HISTORY)), &[t(kind), SqlValue::Integer(after), SqlValue::Integer(limit as i64)])?,
        };
        Ok(found
            .iter()
            .map(|row| HistoryRow {
                sequence: cell_int(row, "sequence"),
                kind: cell_text(row, "kind").unwrap_or_default(),
                event: cell_text(row, "event").unwrap_or_default(),
                field: cell_text(row, "field"),
                old_type: cell_text(row, "old_type"),
                new_type: cell_text(row, "new_type"),
                changed_at: cell_text(row, "changed_at").unwrap_or_default(),
            })
            .collect())
    }
    /// The last schema change's sequence, 0 when none was made.
    pub fn last_sequence(&self) -> Result<i64> {
        if !self.table_ready(HISTORY)? {
            return Ok(0);
        }
        Ok(self.exec(&format!("SELECT MAX(sequence) AS last FROM {}", q(HISTORY)), &[])?.first().map_or(0, |row| cell_int(row, "last")))
    }
    /// Every table this owner made, by exact registered name.
    pub fn tables(&self) -> Result<Vec<String>> {
        let present: Vec<String> = self
            .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?)", &[t(KINDS), t(FIELDS), t(HISTORY), t(INDEXES)])?
            .iter()
            .filter_map(|row| cell_text(row, "name"))
            .collect();
        if !present.iter().any(|name| name == KINDS) {
            return Ok(present);
        }
        let mut names: Vec<String> = self.exec(&format!("SELECT table_name FROM {} ORDER BY kind", q(KINDS)), &[])?.iter().filter_map(|row| cell_text(row, "table_name")).collect();
        names.extend(present);
        Ok(names)
    }
}

#[cfg(test)]
#[path = "record_tables_tests.rs"]
mod tests;
