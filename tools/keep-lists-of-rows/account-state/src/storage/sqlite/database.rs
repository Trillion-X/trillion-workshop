// Purpose: A database of any schema, one per addressed resource, behind the storage seam: the caller's own SQL (any
// DDL and DML, one statement per item) runs in one transaction per command, and the command commits only with its
// revision compare-and-swap, its request-key receipt and a current-rights check at commit, all in that same
// transaction. One SQLite file per database (`<root>/<BLAKE3 of the address>.sqlite`), so a commit writes only the pages
// it changed; nothing saves a whole image of the database per commit.
//
// Ported from old trillion `src/database-supply.mjs` (tag old-trillion-before-worker-retire), which ran PGlite and
// saved a full PostgreSQL data directory per commit through a snapshot owner's compare-and-swap. The operations,
// their order of checks and their refusals are the same: `provision`, `inspect`, `schema`, `read`, `write`, `query`,
// `transaction`, `lifecycle` (close, delete) and `reconcile`; the database is SQLite (so the SQL is SQLite's and
// parameters are `?`), and the receipts and revision live in owner tables of the same file, which the caller's SQL
// cannot reach (SQLite's authorizer refuses them, and refuses transaction control, savepoints and ATTACH).
//
// Non-Negotiable Invariants:
// - Rights are asked before each command and again at its commit (`at_commit`), and the check value the commit's rights check returns
//   must still be current inside the transaction; a refusal at either point rolls everything back.
// - A changing command names `expected_revision`; it runs only when that is the database's revision, and its commit moves
//   the revision by one. A read, inspect or schema names the revision it reads at, runs read-only and writes nothing.
// - A request key commits once: the same key with the same actor and input answers the first result without running the
//   SQL again; with anything else it is a conflict. The receipt is written in the same transaction as the change.
// - One statement per item: a second statement, transaction control, savepoints, ATTACH/DETACH and any name of the
//   owner tables (`_supply_*`) are refused before they run.
//
// Key Concepts:
// - `Rights`: the current resource rights owner (old `authorize` plus the snapshot owner's current check).
// - `Command`: who asks (actor, permit, request key) and for which address.
//
// Security Considerations:
// - The address never becomes a path: the file is named by its hash. The caller never sees the owner tables.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use content_crypto::advanced::blake3;
use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    params_from_iter,
    types::{Value as SqlValue, ValueRef},
    Connection, OpenFlags, OptionalExtension,
};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};

/// A refusal, with the old supply's code and status.
#[derive(Clone, Debug)]
pub struct DbError {
    pub cause: crate::refusal_cause::Cause,
    pub code: &'static str,
    pub status: u16,
    pub message: String,
}
impl DbError {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause.clone() }
}
crate::impl_caused!(DbError);
impl PartialEq for DbError {
    fn eq(&self, other: &Self) -> bool {
        self.code == other.code && self.status == other.status && self.message == other.message
    }
}
fn fail<T>(message: impl Into<String>, code: &'static str, status: u16, cause: crate::refusal_cause::Cause) -> Result<T, DbError> {
    Err(DbError { cause, code, status, message: message.into() })
}
fn invalid<T>(message: &str, cause: crate::refusal_cause::Cause) -> Result<T, DbError> {
    fail(message, "database_supply_invalid", 400, cause)
}
fn sql_failure(error: rusqlite::Error, cause: crate::refusal_cause::Cause) -> DbError {
    DbError { cause, code: "database_statement_failed", status: 400, message: error.to_string() }
}

/// What the rights owner is asked.
#[derive(Clone, Debug, PartialEq)]
pub struct Ask {
    pub address: String,
    pub actor: String,
    pub permit_id: String,
    pub request_key: String,
    pub operation: String,
    pub input: Value,
    pub expected_revision: Option<String>,
    pub at_commit: bool,
}
/// The current resource rights owner.
pub trait Rights {
    /// Returns the commit's check value when `at_commit`, or refuses.
    fn authorize(&self, ask: &Ask) -> Result<Option<Value>, DbError>;
    /// Whether a check value the commit check returned is still current, asked inside the commit's transaction.
    fn fence_current(&self, _fence: &Value, _address: &str, _request_key: &str) -> bool {
        true
    }
}
/// Who asks, for which database.
#[derive(Clone, Debug)]
pub struct Command {
    pub address: String,
    pub actor: String,
    pub permit_id: String,
    pub request_key: String,
}

const OPERATIONS: [&str; 8] = ["provision", "inspect", "schema", "read", "write", "query", "transaction", "lifecycle"];
const OWNER: &str = "_supply_";

/// The databases of one root folder.
pub struct DatabaseSupply<R: Rights> {
    root: PathBuf,
    rights: R,
    open: Entries,
}

type Entries = Mutex<HashMap<String, Arc<Mutex<Option<Open>>>>>;
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    idle_handles: usize,
}
fn idle_handles() -> Result<usize, DbError> {
    static SETTINGS: OnceLock<Option<Settings>> = OnceLock::new();
    SETTINGS.get_or_init(|| serde_json::from_slice::<Settings>(include_bytes!("database/settings.json"))
        .ok().filter(|settings| settings.idle_handles > 0))
        .as_ref().map(|settings| settings.idle_handles)
        .ok_or(DbError { cause: crate::cause!(), code: "database_unavailable", status: 503, message: "The database supply is unavailable.".into() })
}

/// An operation keeps its slot alive through opening, queueing and lifecycle
/// work. Idle slots may leave only after the last operation/queued waiter does.
struct EntryLease<'a> {
    entries: &'a Entries,
    address: &'a str,
    slot: Option<Arc<Mutex<Option<Open>>>>,
    idle_handles: usize,
}
impl Drop for EntryLease<'_> {
    fn drop(&mut self) {
        // No slot guard remains when this lease drops. Remove our own Arc
        // before judging which entries have no current/queued operation.
        drop(self.slot.take());
        let mut retired = Vec::new();
        {
            let Ok(mut entries) = self.entries.lock() else { return; };
            let mut names: Vec<_> = entries.keys().cloned().collect();
            // Prefer retaining the just-used handle; no clock or worker per
            // inactive address is needed to bound this small cache.
            names.sort_by_key(|name| name.as_str() == self.address);
            for name in names {
                let Some(slot) = entries.get(&name) else { continue; };
                if Arc::strong_count(slot) != 1 { continue; }
                let Ok(mut held) = slot.try_lock() else { continue; };
                if held.is_none() || entries.len() > self.idle_handles {
                    if let Some(open) = held.take() { retired.push(open); }
                    drop(held);
                    entries.remove(&name);
                }
            }
        }
        // Closing/checkpointing a retired connection performs I/O. It occurs
        // only after releasing the registry, never under the common hold.
        drop(retired);
    }
}

struct Open {
    db: Connection,
    /// Whether the statement running is the caller's (the authorizer refuses owner names and control then).
    caller: Arc<AtomicBool>,
}

fn revision_text(revision: i64) -> Option<String> {
    (revision > 0).then(|| format!("revision:{revision}"))
}
fn value_of(cell: ValueRef<'_>) -> Value {
    match cell {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => json!(n),
        ValueRef::Real(n) => json!(n),
        ValueRef::Text(text) => json!(String::from_utf8_lossy(text)),
        ValueRef::Blob(bytes) => {
            use base64::Engine as _;
            json!({ "base64": base64::engine::general_purpose::STANDARD.encode(bytes) })
        }
    }
}
fn bind(value: &Value) -> Result<SqlValue, DbError> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(flag) => SqlValue::Integer(i64::from(*flag)),
        Value::Number(number) => match number.as_i64() {
            Some(n) => SqlValue::Integer(n),
            None => SqlValue::Real(number.as_f64().unwrap_or_default()),
        },
        Value::String(text) => SqlValue::Text(text.clone()),
        other => SqlValue::Text(serde_json::to_string(other).map_err(|_| DbError { cause: crate::cause!(), code: "database_supply_invalid", status: 400, message: "Database operation values must be JSON serializable.".into() })?),
    })
}
fn params_of(input: &Value) -> Result<Vec<SqlValue>, DbError> {
    match input.get("params") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(values)) => values.iter().map(bind).collect(),
        Some(_) => invalid("Query parameters must be an array.", crate::cause!()),
    }
}

/// Whether the authorizer refuses an action of the caller's statement.
fn refused(action: &AuthAction<'_>) -> bool {
    let owner = |name: &str| name.starts_with(OWNER);
    match action {
        AuthAction::Transaction { .. } | AuthAction::Savepoint { .. } | AuthAction::Attach { .. } | AuthAction::Detach { .. } => true,
        AuthAction::Read { table_name, .. }
        | AuthAction::Insert { table_name }
        | AuthAction::Update { table_name, .. }
        | AuthAction::Delete { table_name }
        | AuthAction::CreateTable { table_name }
        | AuthAction::DropTable { table_name }
        | AuthAction::CreateTempTable { table_name }
        | AuthAction::DropTempTable { table_name }
        | AuthAction::AlterTable { table_name, .. }
        | AuthAction::Analyze { table_name }
        | AuthAction::CreateIndex { table_name, .. }
        | AuthAction::DropIndex { table_name, .. }
        | AuthAction::CreateTrigger { table_name, .. }
        | AuthAction::DropTrigger { table_name, .. }
        | AuthAction::CreateVtable { table_name, .. }
        | AuthAction::DropVtable { table_name, .. } => owner(table_name),
        AuthAction::CreateView { view_name } | AuthAction::DropView { view_name } => owner(view_name),
        _ => false,
    }
}

impl<R: Rights> DatabaseSupply<R> {
    pub fn new(root: impl Into<PathBuf>, rights: R) -> Self {
        DatabaseSupply { root: root.into(), rights, open: Mutex::new(HashMap::new()) }
    }

    fn path(&self, address: &str) -> PathBuf {
        self.root.join(format!("{}.sqlite", blake3::hash(address.as_bytes()).to_hex()))
    }
    /// Publish only a per-address slot under the registry lock. Opening, queued
    /// commands and lifecycle work all hold the same slot, never the registry.
    /// Queued callers retain their slot through close/delete. Eviction may
    /// remove a slot only after the final live/queued operation releases it.
    fn entry(&self, address: &str) -> Result<Arc<Mutex<Option<Open>>>, DbError> {
        let mut entries = self.open.lock().map_err(|_| Self::unavailable(crate::cause!()))?;
        Ok(entries.entry(address.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(None))).clone())
    }

    fn lease<'a>(&'a self, address: &'a str) -> Result<EntryLease<'a>, DbError> {
        let idle_handles = idle_handles()?;
        Ok(EntryLease { entries: &self.open, address, slot: Some(self.entry(address)?), idle_handles })
    }

    fn unavailable(cause: crate::refusal_cause::Cause) -> DbError {
        DbError { cause, code: "database_unavailable", status: 503, message: "The database supply is unavailable.".into() }
    }

    /// First open is single-flight for this identity. A failed initializer
    /// leaves the slot empty so the next caller can retry on that same slot.
    fn open_db(&self, address: &str, create: bool) -> Result<Open, DbError> {
        let path = self.path(address);
        if !create && !path.exists() {
            return fail("The database resource has not been provisioned.", "database_not_found", 404, crate::cause!());
        }
        let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|error| sql_failure(error, crate::cause!()))?;
        db.busy_timeout(std::time::Duration::from_secs(5)).map_err(|error| sql_failure(error, crate::cause!()))?;
        db.execute_batch(&format!(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;
             CREATE TABLE IF NOT EXISTS {OWNER}state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, name TEXT);
             CREATE TABLE IF NOT EXISTS {OWNER}commitments (request_key TEXT PRIMARY KEY, actor TEXT NOT NULL, input_identity TEXT NOT NULL, result TEXT NOT NULL, revision INTEGER NOT NULL);"
        )).map_err(|error| sql_failure(error, crate::cause!()))?;
        let caller = Arc::new(AtomicBool::new(false));
        let gate = caller.clone();
        db.authorizer(Some(move |context: AuthContext<'_>| {
            if gate.load(Ordering::Acquire) && refused(&context.action) { Authorization::Deny } else { Authorization::Allow }
        }));
        Ok(Open { db, caller })
    }

    /// The open connection of a database, opened (and with `create`, made) on first use.
    fn with_db<T>(&self, address: &str, create: bool, work: impl FnOnce(&Open) -> Result<T, DbError>) -> Result<T, DbError> {
        let entry = self.lease(address)?;
        let mut held = entry.slot.as_ref().expect("an operation retains its slot").lock().map_err(|_| Self::unavailable(crate::cause!()))?;
        if held.is_none() {
            *held = Some(self.open_db(address, create)?);
        }
        let answer = work(held.as_ref().expect("the slot was opened"));
        if !held.as_ref().expect("opened slot").db.is_autocommit() {
            // A failed COMMIT/ROLLBACK must not strand an open transaction in
            // the next caller's retained connection. Never publish success for
            // unfinished work; discard a source whose rollback is unconfirmed.
            if held.as_ref().expect("opened slot").db.execute_batch("ROLLBACK").is_err() {
                held.take();
                return Err(Self::unavailable(crate::cause!()));
            }
            if answer.is_ok() { return Err(Self::unavailable(crate::cause!())); }
        }
        answer
    }

    fn revision(db: &Connection) -> Result<i64, DbError> {
        Ok(db.query_row(&format!("SELECT revision FROM {OWNER}state WHERE id = 1"), [], |row| row.get(0)).optional().map_err(|error| sql_failure(error, crate::cause!()))?.unwrap_or(0))
    }
    fn identity(command: &Command, operation: &str, input: &Value) -> String {
        serde_json::to_string(&json!({ "actor": command.actor, "request_key": command.request_key, "operation": operation, "input": input, "expected_revision": input.get("expected_revision").cloned().unwrap_or(Value::Null) })).unwrap_or_default()
    }
    fn ask(command: &Command, operation: &str, input: &Value, at_commit: bool) -> Ask {
        Ask {
            address: command.address.clone(),
            actor: command.actor.clone(),
            permit_id: command.permit_id.clone(),
            request_key: command.request_key.clone(),
            operation: operation.to_string(),
            input: input.clone(),
            expected_revision: input.get("expected_revision").and_then(Value::as_str).map(str::to_owned),
            at_commit,
        }
    }

    /// One of the caller's statements: one statement only, run under the authorizer, its rows as JSON objects.
    fn statement(open: &Open, sql: &str, params: &[SqlValue], read_only: bool) -> Result<Value, DbError> {
        if sql.trim().is_empty() {
            return invalid("A statement is required.", crate::cause!());
        }
        if !super::first_write::single(sql) {
            return invalid("One statement is allowed per operation.", crate::cause!());
        }
        let before = open.db.total_changes();
        open.caller.store(true, Ordering::Release);
        let done = (|| {
            let mut statement = match open.db.prepare(sql) {
                Ok(statement) => statement,
                Err(rusqlite::Error::MultipleStatement) => return invalid("One statement is allowed per operation.", crate::cause!()),
                Err(rusqlite::Error::SqliteFailure(failure, message)) if failure.code == rusqlite::ErrorCode::AuthorizationForStatementDenied => {
                    let _ = message;
                    return fail("Transaction control, attached databases and the supply's own tables belong to the supply owner.", "database_supply_invalid", 400, crate::cause!());
                }
                Err(error) => return Err(sql_failure(error, crate::cause!())),
            };
            if read_only && !statement.readonly() {
                return fail("A read runs read-only.", "database_read_only", 400, crate::cause!());
            }
            let names: Vec<String> = statement.column_names().into_iter().map(str::to_owned).collect();
            let mut rows = statement.query(params_from_iter(params.iter())).map_err(|error| sql_failure(error, crate::cause!()))?;
            let mut found = Vec::new();
            while let Some(row) = rows.next().map_err(|error| sql_failure(error, crate::cause!()))? {
                let mut object = Map::new();
                for (at, name) in names.iter().enumerate() {
                    object.insert(name.clone(), value_of(row.get_ref(at).map_err(|error| sql_failure(error, crate::cause!()))?));
                }
                found.push(Value::Object(object));
            }
            drop(rows);
            let affected = open.db.total_changes() - before;
            Ok(json!({ "rows": found, "fields": names.iter().map(|name| json!({ "name": name })).collect::<Vec<_>>(), "affected_rows": affected }))
        })();
        open.caller.store(false, Ordering::Release);
        done
    }

    fn apply(open: &Open, operation: &str, input: &Value, command: &Command, read_only: bool) -> Result<Value, DbError> {
        let sql = |input: &Value| input.get("sql").and_then(Value::as_str).map(str::to_owned);
        match operation {
            "provision" => Ok(json!({ "resource": command.address, "name": input.get("name").cloned().unwrap_or(Value::Null), "state": "provisioned", "engine": "SQLite", "revision": "revision:1" })),
            "inspect" => {
                let rows = Self::statement_owner(open, &format!("SELECT name AS table_name, type AS relation_kind FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '{OWNER}%' ORDER BY name"))?;
                Ok(json!({ "engine": "SQLite", "schemas": rows }))
            }
            "schema" => {
                let schema = input.get("schema").and_then(Value::as_str).filter(|schema| !schema.trim().is_empty());
                let Some(schema) = schema else { return invalid("Name a schema to inspect.", crate::cause!()) };
                if schema != "main" {
                    return invalid("A SQLite database has one schema, main.", crate::cause!());
                }
                let rows = Self::statement_owner(open, &format!("SELECT m.name AS table_name, p.name AS column_name, p.cid + 1 AS ordinal_position, p.type AS data_type, CASE WHEN p.\"notnull\" THEN 'NO' ELSE 'YES' END AS is_nullable, p.dflt_value AS column_default FROM sqlite_schema m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND m.name NOT LIKE '{OWNER}%' ORDER BY m.name, p.cid"))?;
                Ok(json!({ "schema": schema, "columns": rows }))
            }
            "read" | "write" | "query" => {
                let Some(text) = sql(input) else { return invalid("A statement is required.", crate::cause!()) };
                Self::statement(open, &text, &params_of(input)?, read_only)
            }
            "transaction" => {
                let Some(statements) = input.get("statements").and_then(Value::as_array).filter(|list| !list.is_empty()) else {
                    return invalid("A transaction needs one or more statements.", crate::cause!());
                };
                let mut results = Vec::new();
                for item in statements {
                    let Some(text) = sql(item) else { return invalid("Each transaction item must be one statement.", crate::cause!()) };
                    results.push(Self::statement(open, &text, &params_of(item)?, false)?);
                }
                Ok(json!({ "results": results }))
            }
            _ => fail("The typed operation is not installed.", "capability_operation_unavailable", 404, crate::cause!()),
        }
    }
    fn statement_owner(open: &Open, sql: &str) -> Result<Value, DbError> {
        let mut statement = open.db.prepare(sql).map_err(|error| sql_failure(error, crate::cause!()))?;
        let names: Vec<String> = statement.column_names().into_iter().map(str::to_owned).collect();
        let mut rows = statement.query([]).map_err(|error| sql_failure(error, crate::cause!()))?;
        let mut found = Vec::new();
        while let Some(row) = rows.next().map_err(|error| sql_failure(error, crate::cause!()))? {
            let mut object = Map::new();
            for (at, name) in names.iter().enumerate() {
                object.insert(name.clone(), value_of(row.get_ref(at).map_err(|error| sql_failure(error, crate::cause!()))?));
            }
            found.push(Value::Object(object));
        }
        Ok(Value::Array(found))
    }

    /// Run one typed operation (old `invoke({ tool, input, task })`).
    pub fn invoke(&self, operation: &str, input: &Value, command: &Command) -> Result<Value, DbError> {
        if !input.is_object() || command.address.trim().is_empty() {
            return invalid("An addressed operation and object input are required.", crate::cause!());
        }
        if command.actor.is_empty() || command.request_key.is_empty() || command.permit_id.is_empty() {
            return fail("The typed operation must supply its current actor, permit and request key.", "database_supply_context_invalid", 403, crate::cause!());
        }
        if !OPERATIONS.contains(&operation) {
            return fail("The typed operation is not installed.", "capability_operation_unavailable", 404, crate::cause!());
        }
        if operation == "lifecycle" {
            return self.lifecycle(input, command);
        }
        let expected = input.get("expected_revision").and_then(Value::as_str).map(str::to_owned);
        self.rights.authorize(&Self::ask(command, operation, input, false))?;
        self.with_db(&command.address, operation == "provision", |open| {
            let read_only = matches!(operation, "read" | "inspect" | "schema");
            if read_only {
                open.db.execute_batch("BEGIN").map_err(|error| sql_failure(error, crate::cause!()))?;
                let done = (|| {
                    let current = revision_text(Self::revision(&open.db)?);
                    if current.is_none() {
                        return fail("The database resource has not been provisioned.", "database_not_found", 404, crate::cause!());
                    }
                    if expected != current {
                        return fail("The current revision differs from expected_revision.", "database_revision_conflict", 409, crate::cause!());
                    }
                    let output = Self::apply(open, operation, input, command, true)?;
                    self.rights.authorize(&Self::ask(command, operation, input, true))?;
                    Ok(output)
                })();
                // A read changes nothing: its transaction always ends without a write.
                open.db.execute_batch("ROLLBACK").map_err(|error| sql_failure(error, crate::cause!()))?;
                return done;
            }
            open.db.execute_batch("BEGIN IMMEDIATE").map_err(|error| sql_failure(error, crate::cause!()))?;
            let done = (|| {
                let binding = Self::identity(command, operation, input);
                let prior: Option<(String, String, String)> = open
                    .db
                    .query_row(&format!("SELECT actor, input_identity, result FROM {OWNER}commitments WHERE request_key = ?"), [&command.request_key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                    .optional()
                    .map_err(|error| sql_failure(error, crate::cause!()))?;
                if let Some((actor, identity, result)) = prior {
                    if actor != command.actor || identity != binding {
                        return fail("This request key already names another command.", "database_request_conflict", 409, crate::cause!());
                    }
                    return Ok((serde_json::from_str(&result).unwrap_or(Value::Null), false));
                }
                let revision = Self::revision(&open.db)?;
                if operation == "provision" && revision != 0 {
                    return fail("This database resource is already provisioned.", "database_already_provisioned", 409, crate::cause!());
                }
                if operation != "provision" && expected != revision_text(revision) {
                    return fail("The current revision differs from expected_revision.", "database_revision_conflict", 409, crate::cause!());
                }
                let output = Self::apply(open, operation, input, command, false)?;
                let fence = self.rights.authorize(&Self::ask(command, operation, input, true))?;
                let fence = fence.unwrap_or(Value::Null);
                if !self.rights.fence_current(&fence, &command.address, &command.request_key) {
                    return fail("The current permit fence was rejected at commit.", "database_permit_revoked", 403, crate::cause!());
                }
                let next = revision + 1;
                let name = if operation == "provision" { input.get("name").and_then(Value::as_str).map(str::to_owned) } else { None };
                open.db
                    .execute(&format!("INSERT INTO {OWNER}state (id, revision, name) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision"), rusqlite::params![next, name])
                    .map_err(|error| sql_failure(error, crate::cause!()))?;
                open.db
                    .execute(&format!("INSERT INTO {OWNER}commitments (request_key, actor, input_identity, result, revision) VALUES (?, ?, ?, ?, ?)"), rusqlite::params![command.request_key, command.actor, binding, output.to_string(), next])
                    .map_err(|error| sql_failure(error, crate::cause!()))?;
                Ok((output, true))
            })();
            match done {
                Ok((output, true)) => {
                    open.db.execute_batch("COMMIT").map_err(|_| DbError {
                        cause: crate::cause!(),
                        code: "database_commit_unconfirmed", status: 503,
                        message: Self::unavailable(crate::cause!()).message,
                    })?;
                    Ok(output)
                }
                Ok((output, false)) => {
                    open.db.execute_batch("ROLLBACK").map_err(|error| sql_failure(error, crate::cause!()))?;
                    Ok(output)
                }
                Err(error) => {
                    let _ = open.db.execute_batch("ROLLBACK");
                    Err(error)
                }
            }
        })
    }

    fn lifecycle(&self, input: &Value, command: &Command) -> Result<Value, DbError> {
        let action = input.get("action").and_then(Value::as_str).unwrap_or_default();
        match action {
            "close" => {
                self.rights.authorize(&Self::ask(command, "close", input, false))?;
                let revision = self.close(&command.address)?;
                Ok(json!({ "resource": command.address, "state": "closed", "revision": revision }))
            }
            "delete" => {
                let expected = input.get("expected_revision").and_then(Value::as_str).map(str::to_owned);
                let fence = self.rights.authorize(&Self::ask(command, "delete", input, true))?.unwrap_or(Value::Null);
                // Keep the address slot through compare, fence, close and removal.
                // A queued command cannot reopen the file between these steps.
                let entry = self.lease(&command.address)?;
                let mut held = entry.slot.as_ref().expect("an operation retains its slot").lock().map_err(|_| Self::unavailable(crate::cause!()))?;
                if held.is_none() {
                    *held = Some(self.open_db(&command.address, false)?);
                }
                let current = revision_text(Self::revision(&held.as_ref().expect("opened slot").db)?);
                if current != expected {
                    return fail("The database resource changed before deletion.", "database_revision_conflict", 409, crate::cause!());
                }
                if !self.rights.fence_current(&fence, &command.address, &command.request_key) {
                    return fail("The current permit fence was rejected.", "database_permit_revoked", 403, crate::cause!());
                }
                held.take();
                let path = self.path(&command.address);
                for suffix in ["", "-wal", "-shm"] {
                    let mut file = path.clone().into_os_string();
                    file.push(suffix);
                    let _ = std::fs::remove_file(PathBuf::from(file));
                }
                if path.exists() {
                    return fail("The database file was not removed.", "database_delete_unverified", 409, crate::cause!());
                }
                Ok(json!({ "resource": command.address, "state": "deleted" }))
            }
            _ => invalid("Supported lifecycle actions are close and delete.", crate::cause!()),
        }
    }

    /// Close one open database; answers the revision it was at (None when it was not open).
    pub fn close(&self, address: &str) -> Result<Option<String>, DbError> {
        let entry = self.lease(address)?;
        let mut held = entry.slot.as_ref().expect("an operation retains its slot").lock().map_err(|_| Self::unavailable(crate::cause!()))?;
        let revision = match held.as_ref() {
            Some(open) => revision_text(Self::revision(&open.db)?),
            None => None,
        };
        held.take();
        Ok(revision)
    }

    /// What became of a command (old `reconcile`): its receipt, read without running anything again.
    pub fn reconcile(&self, operation: &str, input: &Value, command: &Command) -> Result<Value, DbError> {
        self.rights.authorize(&Ask { operation: "reconcile".into(), ..Self::ask(command, operation, input, false) })?;
        let binding = Self::identity(command, operation, input);
        let receipt: Option<(String, String, String)> = self.with_db(&command.address, false, |open| {
            open.db
                .query_row(&format!("SELECT actor, input_identity, result FROM {OWNER}commitments WHERE request_key = ?"), [&command.request_key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .optional()
                .map_err(|error| sql_failure(error, crate::cause!()))
        })?;
        match receipt {
            None => Ok(json!({ "state": "not_sent" })),
            Some((actor, identity, _)) if actor != command.actor || identity != binding => fail("The original request key is committed to different input.", "database_request_conflict", 409, crate::cause!()),
            Some((_, _, result)) => Ok(json!({ "state": "completed", "output": serde_json::from_str::<Value>(&result).unwrap_or(Value::Null) })),
        }
    }
}

/// The typed operations that make one database callable from every installed door (old `pgliteDatabaseToolDescriptors`).
pub fn database_tool_descriptors() -> Vec<Value> {
    let input = |properties: Value, required: &[&str]| {
        let mut all = json!({ "resource_ref": { "type": "string", "minLength": 1 }, "expected_revision": { "type": ["string", "null"] } });
        if let (Some(all), Some(more)) = (all.as_object_mut(), properties.as_object()) {
            all.extend(more.clone());
        }
        let mut needed = vec!["resource_ref".to_string()];
        needed.extend(required.iter().map(|name| name.to_string()));
        json!({ "type": "object", "properties": all, "required": needed, "additionalProperties": false })
    };
    let statement = || json!({ "sql": { "type": "string", "minLength": 1 }, "params": { "type": "array", "items": {} } });
    let definitions = [
        ("provision", input(json!({ "name": { "type": "string" } }), &[]), "Provision one isolated database."),
        ("inspect", input(json!({}), &[]), "List the database's tables and views."),
        ("schema", input(json!({ "schema": { "type": "string", "minLength": 1 } }), &["schema"]), "Read the columns of the database's tables."),
        ("read", input(statement(), &["sql"]), "Run one parameterized read-only statement."),
        ("write", input(statement(), &["sql"]), "Run one statement that changes schema or rows."),
        ("query", input(statement(), &["sql"]), "Run one parameterized statement."),
        ("transaction", input(json!({ "statements": { "type": "array", "minItems": 1, "items": { "type": "object", "required": ["sql"], "properties": statement(), "additionalProperties": false } } }), &["statements"]), "Commit multiple statements atomically."),
        ("lifecycle", input(json!({ "action": { "enum": ["close", "delete"] } }), &["action"]), "Close or permanently delete this database."),
    ];
    definitions
        .into_iter()
        .map(|(operation, input_schema, description)| {
            json!({ "id": format!("tool:database-{operation}"), "label": format!("Database {operation}"), "description": description, "input_schema": input_schema,
                "output_schema": { "type": "object", "additionalProperties": true }, "invoke": { "implementation_ref": "native:sqlite-database", "operation": operation } })
        })
        .collect()
}

/// The contract an authoritative record transaction owner must meet (old `EEAF_TRANSACTION_AUTHORITY_CONTRACT`): a SQL
/// database does not meet it merely by having tables and transactions.
pub const AUTHORITY_CONTRACT: (&str, &str, &str) = ("trillion.eeaf-transaction-authority", "1", "all-or-none-with-durable-receipt");
pub const AUTHORITY_SEMANTICS: [&str; 7] = [
    "dynamic-schema-and-record-model",
    "record-identity-and-relationships",
    "current-state-and-version-history",
    "optimistic-conflict-detection",
    "current-rights-and-policy-at-commit",
    "attributed-erasures-and-retention",
    "idempotent-reconciliation-and-recovery",
];
/// Record transaction authority over a database: available only with a trusted verifier, and only while the verifier
/// answers the whole contract as current. A capability's own metadata never grants it.
pub struct TransactionAuthority<'v> {
    verify: Option<Box<dyn Fn(&Ask) -> Value + 'v>>,
}
impl<'v> TransactionAuthority<'v> {
    pub fn new(verify: Option<Box<dyn Fn(&Ask) -> Value + 'v>>) -> Self {
        TransactionAuthority { verify }
    }
    pub fn available(&self) -> bool {
        self.verify.is_some()
    }
    /// Whether the trusted verifier answers the contract as current for this command.
    pub fn check(&self, ask: &Ask) -> Result<(), DbError> {
        let Some(verify) = &self.verify else { return fail("No trusted current authority verifier is installed.", "eeaf_authority_unavailable", 409, crate::cause!()) };
        let answer = verify(ask);
        let semantics: Vec<&str> = answer.get("semantics").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        let verified = answer.get("authoritative") == Some(&json!(true))
            && answer.get("current") == Some(&json!(true))
            && answer.get("contract_id") == Some(&json!(AUTHORITY_CONTRACT.0))
            && answer.get("contract_revision") == Some(&json!(AUTHORITY_CONTRACT.1))
            && answer.get("atomicity") == Some(&json!(AUTHORITY_CONTRACT.2))
            && AUTHORITY_SEMANTICS.iter().all(|semantic| semantics.contains(semantic));
        if verified { Ok(()) } else { fail("The trusted owner did not verify current authoritative requirements.", "eeaf_authority_unavailable", 409, crate::cause!()) }
    }
}

#[cfg(test)]
#[path = "database_tests.rs"]
mod tests;
