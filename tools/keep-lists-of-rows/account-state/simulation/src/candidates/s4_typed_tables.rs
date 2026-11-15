//! S4: one typed table per kind, compiled from the kind's model DATA, plus
//! S2's log module (plan 03 §2b). It is the X7 control: it tests whether a
//! table per kind (schema objects that grow with the kinds AIs create) costs
//! anything real against S2's fixed table count.
//!
//! A kind's model is compiled at its first save: every top-level field of
//! that value becomes a column (`text` for a string, `json` otherwise), every
//! list of at least `member_min` members becomes a child table (the parent
//! keeps its member count), and every declared index becomes a native SQLite
//! index (`kind_newest` on `seq`, `owner` on `owner_key`, `field` on its
//! column). Values that do not fit the compiled model go to an overflow JSON
//! column. The compiled models are DATA in `models`, read once per object
//! life; the DDL is charged to the save that introduced the kind.
//!
//! A point read does not know its kind, so it probes the kind tables in
//! model order (reads grow with the kind count). History, sealing, owner keys
//! and the O9 tail receipt are S2's log module with S2's row shape.

use local_engine::sqlite_work::WorkMeter;
use rusqlite::{
    params, params_from_iter, types::Value as Sql, Connection, OptionalExtension, Transaction,
    TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use workload_simulation::{
    Candidate, Capability, DetRng, Intent, Interrupt, Meters, Opened, Operation, Outcome, Reply,
    SimTime, Store, StoreContext, StoreError,
};

use super::kit::{self, capability, Done};
use super::layout::{self, IndexDecl, IndexOf};
use super::log::{self, Log, OwnerKey, CHANGE_LOG};
use super::receipts::{self, Answer, ReceiptParams, Ring};
use super::search::{self, Current, Search, SearchParams};
use crate::meter::{err, schema_changed, MeteredDb, ReadCause, Spans, SQLITE_METERS};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
    pub indexes: Vec<IndexDecl>,
    pub search: SearchParams,
    pub member_min: usize,
    pub generation_rows: u64,
    pub receipts: ReceiptParams,
}

pub fn classify(table: &str) -> &'static str {
    if let Some(c) = log::classify(table) {
        return c;
    }
    match table {
        "models" => "bookkeeping",
        t if t.starts_with("ix_") => "index",
        t if t.starts_with('k') && t[1..].starts_with(|c: char| c.is_ascii_digit()) => "record",
        t if search::is_search_table(t) => "search",
        _ => "unclassified",
    }
}

pub struct S4 {
    id: String,
    params: Params,
}

impl S4 {
    pub fn new(id: String, params: Value) -> Result<Self, StoreError> {
        let params: Params = serde_json::from_value(params).map_err(err)?;
        Search::new(params.search.clone(), PathBuf::new())?;
        params.receipts.check()?;
        if params.generation_rows == 0 || params.member_min == 0 {
            return Err(StoreError(
                "generation_rows and member_min must be >= 1".into(),
            ));
        }
        Ok(Self { id, params })
    }
}

/// A kind's compiled model.
#[derive(Clone, Debug, Deserialize, Serialize)]
struct Model {
    kind: String,
    table: String,
    fields: Vec<Field>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Field {
    name: String,
    col: String,
    shape: Shape,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Shape {
    Text,
    Json,
    /// Members in a child table; the column holds the member count.
    List {
        table: String,
    },
}

/// A value laid out on a model's row.
struct Row {
    cols: Vec<Sql>,
    extra: Sql,
    lists: Vec<(String, Vec<Value>)>,
}

impl Model {
    fn compile(n: usize, kind: &str, value: &Map<String, Value>, member_min: usize) -> Self {
        let safe: String = kind
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_lowercase()
                } else {
                    '_'
                }
            })
            .take(24)
            .collect();
        let table = format!("k{n}_{safe}");
        let fields = value
            .iter()
            .enumerate()
            .map(|(i, (name, v))| Field {
                name: name.clone(),
                col: format!("c{i}"),
                shape: match v {
                    Value::String(_) => Shape::Text,
                    Value::Array(a) if a.len() >= member_min => Shape::List {
                        table: format!("{table}__l{i}"),
                    },
                    _ => Shape::Json,
                },
            })
            .collect();
        Self {
            kind: kind.to_owned(),
            table,
            fields,
        }
    }

    fn ddl(&self, indexes: &[IndexDecl]) -> String {
        let cols: Vec<String> = self
            .fields
            .iter()
            .map(|f| match f.shape {
                Shape::List { .. } => format!("{} INTEGER", f.col),
                _ => format!("{} TEXT", f.col),
            })
            .collect();
        let mut sql = format!(
            "CREATE TABLE {t}(record_id TEXT PRIMARY KEY, version INTEGER NOT NULL, seq INTEGER NOT NULL,
               prev_seq INTEGER, owner_key TEXT NOT NULL, {cols}, extra TEXT, deleted INTEGER NOT NULL,
               receipts TEXT NOT NULL) WITHOUT ROWID;",
            t = self.table,
            cols = cols.join(", ")
        );
        for f in &self.fields {
            if let Shape::List { table } = &f.shape {
                sql.push_str(&format!(
                    "\nCREATE TABLE {table}(record_id TEXT NOT NULL, member_key INTEGER NOT NULL, body TEXT NOT NULL,
                       PRIMARY KEY(record_id, member_key)) WITHOUT ROWID;"
                ));
            }
        }
        for d in indexes {
            let on = match &d.of {
                IndexOf::KindNewest => Some("seq".to_owned()),
                IndexOf::Owner => Some("owner_key".to_owned()),
                IndexOf::Field { field } => self
                    .fields
                    .iter()
                    .find(|f| f.name == *field && !matches!(f.shape, Shape::List { .. }))
                    .map(|f| f.col.clone()),
            };
            if let Some(on) = on {
                sql.push_str(&format!(
                    "\nCREATE INDEX ix_{t}_{id} ON {t}({on}) WHERE deleted = 0;",
                    t = self.table,
                    id = d.id
                ));
            }
        }
        sql
    }

    /// Lay a whole value out on this model's columns.
    fn encode(&self, value: &Map<String, Value>) -> Result<Row, StoreError> {
        let mut rest = value.clone();
        let mut cols = Vec::with_capacity(self.fields.len());
        let mut lists = Vec::new();
        for f in &self.fields {
            let v = rest.remove(&f.name);
            let col = match (&f.shape, v) {
                (_, None) => Sql::Null,
                (Shape::Text, Some(Value::String(s))) => Sql::Text(s),
                (Shape::Json, Some(v)) => Sql::Text(serde_json::to_string(&v).map_err(err)?),
                (Shape::List { .. }, Some(Value::Array(a))) => {
                    let n = a.len() as i64;
                    lists.push((f.name.clone(), a));
                    Sql::Integer(n)
                }
                (_, Some(other)) => {
                    rest.insert(f.name.clone(), other);
                    Sql::Null
                }
            };
            cols.push(col);
        }
        let extra = if rest.is_empty() {
            Sql::Null
        } else {
            Sql::Text(serde_json::to_string(&rest).map_err(err)?)
        };
        Ok(Row { cols, extra, lists })
    }

    fn select(&self) -> String {
        let cols: Vec<&str> = self.fields.iter().map(|f| f.col.as_str()).collect();
        format!(
            "SELECT seq, owner_key, {}, extra, deleted, receipts FROM {} WHERE record_id = ?1",
            cols.join(", "),
            self.table
        )
    }

    fn list_table(&self, field: &str) -> Option<&str> {
        self.fields.iter().find_map(|f| match &f.shape {
            Shape::List { table } if f.name == field => Some(table.as_str()),
            _ => None,
        })
    }
}

/// One stored record: its scalar part, its member counts and stamps.
struct Found {
    model: usize,
    seq: i64,
    owner: String,
    /// Every field except child-table lists.
    scalars: Map<String, Value>,
    /// Child-table lists present on the record: (field, member count).
    counts: Vec<(String, i64)>,
    /// A tombstone: the record was deleted (no fields, no owner).
    deleted: bool,
    ring: Ring,
}

pub struct S4Store {
    db: Option<MeteredDb>,
    core: Core,
}

struct Core {
    path: PathBuf,
    params: Params,
    meter: WorkMeter,
    rng: DetRng,
    log: Log,
    models: Vec<Model>,
    search: Search,
}

impl Core {
    fn open_db(&mut self, create: bool) -> Result<(MeteredDb, Meters), StoreError> {
        let mut db = MeteredDb::open(&self.path, self.meter.clone(), classify)?;
        let mut spans = db.spans()?;
        if create {
            db.conn()
                .execute_batch(
                    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
                     CREATE TABLE models(n INTEGER PRIMARY KEY, kind TEXT NOT NULL UNIQUE, spec TEXT NOT NULL);",
                )
                .map_err(err)?;
            self.log.create(db.conn())?;
            self.search.create(db.conn())?;
            self.models.clear();
        } else {
            db.conn()
                .execute_batch("PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;")
                .map_err(err)?;
            self.log.recover(db.conn())?;
            let mut stmt = db
                .conn()
                .prepare("SELECT spec FROM models ORDER BY n")
                .map_err(err)?;
            let specs = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(err)?;
            drop(stmt);
            self.models = specs
                .iter()
                .map(|s| serde_json::from_str(s).map_err(err))
                .collect::<Result<_, _>>()?;
            spans.cut(ReadCause::Scoped("bookkeeping"))?;
            if let Some(after) = self.search.reopen(db.conn())? {
                let records = self.changed_since(db.conn(), after)?;
                self.search.fill(records);
            }
            spans.cut(ReadCause::Scoped("search"))?;
        }
        spans.cut(ReadCause::Scoped("bookkeeping"))?;
        let m = db.finish(spans)?;
        Ok((db, m))
    }

    /// Current records whose seq is above `after`: one range per kind table
    /// (its partial seq index when kind_newest is declared).
    fn changed_since(
        &self,
        conn: &Connection,
        after: i64,
    ) -> Result<Vec<(String, Current)>, StoreError> {
        let mut out = Vec::new();
        for m in &self.models {
            let ids: Vec<String> = {
                let mut stmt = conn
                    .prepare_cached(&format!(
                        "SELECT record_id FROM {} WHERE deleted = 0 AND seq > ?1",
                        m.table
                    ))
                    .map_err(err)?;
                let rows = stmt.query_map([after], |r| r.get(0)).map_err(err)?;
                rows.collect::<Result<_, _>>().map_err(err)?
            };
            for id in ids {
                if let Some(f) = self.find(conn, &id, Some(std::slice::from_ref(&m.kind)))? {
                    out.push((
                        id,
                        Current {
                            stamp: f.seq,
                            kind: m.kind.clone(),
                            value: Value::Object(f.scalars),
                        },
                    ));
                }
            }
        }
        Ok(out)
    }

    fn model_of(&self, kind: &str) -> Option<usize> {
        self.models.iter().position(|m| m.kind == kind)
    }

    /// Compile and create a new kind's table (DDL inside the save).
    fn compile(
        &mut self,
        tx: &Transaction,
        kind: &str,
        value: &Map<String, Value>,
    ) -> Result<usize, StoreError> {
        let model = Model::compile(self.models.len() + 1, kind, value, self.params.member_min);
        tx.execute_batch(&model.ddl(&self.params.indexes))
            .map_err(err)?;
        schema_changed(tx);
        tx.prepare_cached("INSERT INTO models(n, kind, spec) VALUES(?1, ?2, ?3)")
            .map_err(err)?
            .execute(params![
                self.models.len() as i64 + 1,
                kind,
                serde_json::to_string(&model).map_err(err)?
            ])
            .map_err(err)?;
        self.models.push(model);
        Ok(self.models.len() - 1)
    }

    /// The live record (a tombstone reads as absent).
    fn find(
        &self,
        tx: &Connection,
        key: &str,
        kinds: Option<&[String]>,
    ) -> Result<Option<Found>, StoreError> {
        Ok(self.row(tx, key, kinds)?.filter(|f| !f.deleted))
    }

    /// A record's row, live or tombstone.
    fn row(
        &self,
        tx: &Connection,
        key: &str,
        kinds: Option<&[String]>,
    ) -> Result<Option<Found>, StoreError> {
        find_in(&self.models, tx, key, kinds)
    }
}

/// Probe the kind tables (in model order, or only `kinds`) for a record's
/// row, live or tombstone.
fn find_in(
    models: &[Model],
    tx: &Connection,
    key: &str,
    kinds: Option<&[String]>,
) -> Result<Option<Found>, StoreError> {
    {
        for (i, m) in models.iter().enumerate() {
            if kinds.is_some_and(|k| !k.contains(&m.kind)) {
                continue;
            }
            let mut stmt = tx.prepare_cached(&m.select()).map_err(err)?;
            let row = stmt
                .query_row([key], |r| {
                    let mut cols = Vec::with_capacity(m.fields.len() + 5);
                    for c in 0..m.fields.len() + 5 {
                        cols.push(r.get::<_, Sql>(c)?);
                    }
                    Ok(cols)
                })
                .optional()
                .map_err(err)?;
            let Some(cols) = row else { continue };
            let seq = match cols[0] {
                Sql::Integer(s) => s,
                _ => 0,
            };
            let owner = match &cols[1] {
                Sql::Text(o) => o.clone(),
                _ => String::new(),
            };
            let mut scalars = Map::new();
            let mut counts = Vec::new();
            for (f, v) in m.fields.iter().zip(&cols[2..]) {
                match (&f.shape, v) {
                    (_, Sql::Null) => {}
                    (Shape::Text, Sql::Text(s)) => {
                        scalars.insert(f.name.clone(), Value::String(s.clone()));
                    }
                    (Shape::Json, Sql::Text(s)) => {
                        scalars.insert(f.name.clone(), serde_json::from_str(s).map_err(err)?);
                    }
                    (Shape::List { .. }, Sql::Integer(n)) => counts.push((f.name.clone(), *n)),
                    _ => {
                        return Err(StoreError(format!(
                            "{}: column {} has the wrong type",
                            m.table, f.col
                        )))
                    }
                }
            }
            if let Sql::Text(x) = &cols[m.fields.len() + 2] {
                let extra: Map<String, Value> = serde_json::from_str(x).map_err(err)?;
                scalars.extend(extra);
            }
            let n = m.fields.len();
            let ring = match &cols[n + 4] {
                Sql::Text(r) => Ring::parse(Some(r))?,
                _ => Ring::default(),
            };
            return Ok(Some(Found {
                model: i,
                seq,
                owner,
                scalars,
                counts,
                deleted: matches!(cols[n + 3], Sql::Integer(1)),
                ring,
            }));
        }
        Ok(None)
    }
}

impl Core {
    fn members(&self, tx: &Transaction, table: &str, key: &str) -> Result<Vec<Value>, StoreError> {
        let mut stmt = tx
            .prepare_cached(&format!(
                "SELECT body FROM {table} WHERE record_id = ?1 ORDER BY member_key"
            ))
            .map_err(err)?;
        let rows = stmt
            .query_map([key], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        rows.iter()
            .map(|b| serde_json::from_str(b).map_err(err))
            .collect()
    }

    /// Whole value: scalars plus every present child-table list.
    fn value(&self, tx: &Transaction, key: &str, f: &Found) -> Result<Value, StoreError> {
        let mut v = f.scalars.clone();
        let m = &self.models[f.model];
        for (field, _) in &f.counts {
            if let Some(t) = m.list_table(field) {
                v.insert(field.clone(), Value::Array(self.members(tx, t, key)?));
            }
        }
        Ok(Value::Object(v))
    }

    fn put_members(
        &self,
        tx: &Transaction,
        table: &str,
        key: &str,
        members: &[Value],
    ) -> Result<(), StoreError> {
        let mut stmt = tx
            .prepare_cached(&format!(
                "INSERT INTO {table}(record_id, member_key, body) VALUES(?1, ?2, ?3)"
            ))
            .map_err(err)?;
        for (i, m) in members.iter().enumerate() {
            stmt.execute(params![
                key,
                i as i64,
                serde_json::to_string(m).map_err(err)?
            ])
            .map_err(err)?;
        }
        Ok(())
    }

    fn drop_members(&self, tx: &Transaction, table: &str, key: &str) -> Result<(), StoreError> {
        tx.prepare_cached(&format!("DELETE FROM {table} WHERE record_id = ?1"))
            .map_err(err)?
            .execute([key])
            .map_err(err)?;
        Ok(())
    }

    /// Rewrite the record's row from its new scalar part (one UPDATE; native
    /// index entries change only where their column changed).
    fn write_row(
        &self,
        tx: &Transaction,
        op: &Operation,
        key: &str,
        model: usize,
        row: &Row,
        ring: &Ring,
    ) -> Result<(), StoreError> {
        let m = &self.models[model];
        let sets: Vec<String> = m
            .fields
            .iter()
            .enumerate()
            .map(|(i, f)| format!("{} = ?{}", f.col, i + 5))
            .collect();
        let sql = format!(
            "UPDATE {} SET version = version + 1, prev_seq = seq, seq = ?2, extra = ?3, receipts = ?4, {} WHERE record_id = ?1",
            m.table,
            sets.join(", ")
        );
        let mut values: Vec<Sql> = vec![
            Sql::Text(key.to_owned()),
            Sql::Integer(op.sequence as i64),
            row.extra.clone(),
            Sql::Text(ring.text()?),
        ];
        values.extend(row.cols.iter().cloned());
        tx.prepare_cached(&sql)
            .map_err(err)?
            .execute(params_from_iter(values.iter()))
            .map_err(err)?;
        Ok(())
    }

    fn log(
        &mut self,
        tx: &Transaction,
        op: &Operation,
        key: &str,
        sealing: Option<OwnerKey>,
        diff: &Value,
        meters: &mut Meters,
    ) -> Result<(), StoreError> {
        let plain = serde_json::to_vec(diff).map_err(err)?;
        let (kid, blob) = match sealing {
            Some((id, k)) => (
                Some(id),
                log::seal(&k, &log::op_nonce(op.sequence, op.attempt), &plain)?,
            ),
            None => (None, plain),
        };
        let at = op.at.iso8601();
        self.log.append(
            tx,
            &[
                "record_id",
                "tx",
                "actor",
                "app_time",
                "sys_time",
                "key_id",
                "diff",
            ],
            &[&key, &op.request_key, &op.actor, &at, &at, &kid, &blob],
            meters,
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn create(
        &mut self,
        tx: &Transaction,
        op: &Operation,
        key: &str,
        kind: &str,
        owner: &str,
        value: &Value,
        spans: &mut Spans,
        extra: &mut Meters,
    ) -> Result<(), StoreError> {
        let map = value.as_object().cloned().unwrap_or_default();
        let model = match self.model_of(kind) {
            Some(i) => i,
            None => {
                let i = self.compile(tx, kind, &map)?;
                spans.cut(ReadCause::Scoped("schema"))?;
                i
            }
        };
        let m = &self.models[model];
        let row = m.encode(&map)?;
        let cols: Vec<&str> = m.fields.iter().map(|f| f.col.as_str()).collect();
        let slots: Vec<String> = (0..cols.len()).map(|i| format!("?{}", i + 6)).collect();
        let sql = format!(
            "INSERT INTO {}(record_id, version, seq, prev_seq, owner_key, extra, deleted, receipts, {}) VALUES(?1, 1, ?2, NULL, ?3, ?4, 0, ?5, {})",
            m.table,
            cols.join(", "),
            slots.join(", ")
        );
        let mut values: Vec<Sql> = vec![
            Sql::Text(key.to_owned()),
            Sql::Integer(op.sequence as i64),
            Sql::Text(owner.to_owned()),
            row.extra.clone(),
            Sql::Text(
                Ring::default()
                    .after(&op.request_key, op.at.0, &self.params.receipts)
                    .text()?,
            ),
        ];
        values.extend(row.cols.iter().cloned());
        tx.prepare_cached(&sql)
            .map_err(err)?
            .execute(params_from_iter(values.iter()))
            .map_err(err)?;
        for (field, members) in &row.lists {
            if let Some(t) = m.list_table(field) {
                self.put_members(tx, t, key, members)?;
            }
        }
        spans.cut(ReadCause::Scoped("record"))?;
        self.search.changed(
            tx,
            key,
            op.sequence as i64,
            kind,
            None,
            Some(value),
            op.at.0,
            extra,
        )?;
        spans.cut(ReadCause::Scoped("search"))?;
        let k = log::owner_key(tx, &mut self.rng, owner)?;
        spans.cut(ReadCause::Scoped("bookkeeping"))?;
        self.log(
            tx,
            op,
            key,
            Some(k),
            &json!({"create": {"kind": kind, "value": value}}),
            extra,
        )?;
        spans.cut(ReadCause::Scoped("history"))?;
        Ok(())
    }

    /// Remove a record: a delete (`tombstone`: its order key and ring)
    /// turns the row into a tombstone that keeps the ring (fields and owner
    /// cleared, so the partial indexes drop it); owner erasure (None)
    /// deletes the row. Child rows go either way.
    #[allow(clippy::too_many_arguments)]
    fn remove(
        &mut self,
        tx: &Transaction,
        key: &str,
        f: &Found,
        tombstone: Option<(i64, &Ring)>,
        now: u64,
        spans: &mut Spans,
        extra: &mut Meters,
    ) -> Result<(), StoreError> {
        let m = &self.models[f.model];
        for (field, _) in &f.counts {
            if let Some(t) = m.list_table(field) {
                self.drop_members(tx, t, key)?;
            }
        }
        match tombstone {
            Some((seq, ring)) => {
                let clear: Vec<String> = m
                    .fields
                    .iter()
                    .map(|x| format!("{} = NULL", x.col))
                    .collect();
                tx.prepare_cached(&format!(
                    "UPDATE {} SET {}, extra = NULL, owner_key = '', deleted = 1, version = version + 1,
                     prev_seq = seq, seq = ?2, receipts = ?3 WHERE record_id = ?1",
                    m.table,
                    clear.join(", ")
                ))
                .map_err(err)?
                .execute(params![key, seq, ring.text()?])
                .map_err(err)?;
            }
            None => {
                tx.prepare_cached(&format!("DELETE FROM {} WHERE record_id = ?1", m.table))
                    .map_err(err)?
                    .execute([key])
                    .map_err(err)?;
            }
        }
        spans.cut(ReadCause::Scoped("record"))?;
        let kind = m.kind.clone();
        let stamp = tombstone.map_or(f.seq, |(s, _)| s);
        self.search.changed(
            tx,
            key,
            stamp,
            &kind,
            Some(&Value::Object(f.scalars.clone())),
            None,
            now,
            extra,
        )?;
        spans.cut(ReadCause::Scoped("search"))?;
        Ok(())
    }

    fn intent(
        &mut self,
        tx: &Transaction,
        op: &Operation,
        spans: &mut Spans,
        extra: &mut Meters,
    ) -> Result<Reply, StoreError> {
        let missing = || StoreError("record is absent".into());
        match &op.intent {
            Intent::Create {
                key,
                kind,
                owner,
                value,
            } => {
                self.create(tx, op, key, kind, owner, value, spans, extra)?;
                Ok(Reply::Nothing)
            }
            Intent::Read { key } => {
                let v = self
                    .find(tx, key, None)?
                    .map(|f| self.value(tx, key, &f))
                    .transpose()?;
                spans.cut(ReadCause::Scoped("record"))?;
                Ok(Reply::Value(v))
            }
            Intent::Update { key, field, value } => {
                let f = self.find(tx, key, None)?.ok_or_else(missing)?;
                spans.cut(ReadCause::Scoped("record"))?;
                let m = &self.models[f.model];
                let mut scalars = f.scalars.clone();
                let list = m.list_table(field).map(str::to_owned);
                let had_list = f.counts.iter().any(|(n, _)| n == field);
                if let Some(t) = &list {
                    if had_list {
                        self.drop_members(tx, t, key)?;
                    }
                }
                scalars.insert(field.clone(), value.clone());
                // Encode the new whole scalar part plus the present lists' counts.
                let mut whole = scalars.clone();
                for (n, c) in &f.counts {
                    if n != field {
                        whole.insert(n.clone(), Value::Array(vec![Value::Null; *c as usize]));
                    }
                }
                let row = m.encode(&whole)?;
                for (n, members) in &row.lists {
                    if n == field {
                        if let Some(t) = &list {
                            self.put_members(tx, t, key, members)?;
                        }
                    }
                }
                let ring = f
                    .ring
                    .after(&op.request_key, op.at.0, &self.params.receipts);
                self.write_row(tx, op, key, f.model, &row, &ring)?;
                spans.cut(ReadCause::Scoped("record"))?;
                let kind = m.kind.clone();
                self.search.changed(
                    tx,
                    key,
                    op.sequence as i64,
                    &kind,
                    Some(&Value::Object(f.scalars.clone())),
                    Some(&Value::Object(scalars)),
                    op.at.0,
                    extra,
                )?;
                spans.cut(ReadCause::Scoped("search"))?;
                let k = log::owner_key(tx, &mut self.rng, &f.owner)?;
                spans.cut(ReadCause::Scoped("bookkeeping"))?;
                self.log(tx, op, key, Some(k), &json!({"set": {field: value}}), extra)?;
                spans.cut(ReadCause::Scoped("history"))?;
                Ok(Reply::Nothing)
            }
            Intent::WriteMember {
                key,
                field,
                index,
                value,
            } => {
                let f = self.find(tx, key, None)?.ok_or_else(missing)?;
                spans.cut(ReadCause::Scoped("record"))?;
                let m = &self.models[f.model];
                let mut whole = f.scalars.clone();
                for (n, c) in &f.counts {
                    whole.insert(n.clone(), Value::Array(vec![Value::Null; *c as usize]));
                }
                match m
                    .list_table(field)
                    .filter(|_| f.counts.iter().any(|(n, _)| n == field))
                {
                    Some(t) => {
                        let n = tx
                            .prepare_cached(&format!(
                                "UPDATE {t} SET body = ?3 WHERE record_id = ?1 AND member_key = ?2"
                            ))
                            .map_err(err)?
                            .execute(params![
                                key,
                                *index as i64,
                                serde_json::to_string(value).map_err(err)?
                            ])
                            .map_err(err)?;
                        if n != 1 {
                            return Err(StoreError("member out of range".into()));
                        }
                    }
                    None => {
                        let slot = whole
                            .get_mut(field)
                            .and_then(Value::as_array_mut)
                            .and_then(|l| l.get_mut(*index as usize))
                            .ok_or_else(|| StoreError("member out of range".into()))?;
                        *slot = value.clone();
                    }
                }
                let row = m.encode(&whole)?;
                let kind = m.kind.clone();
                let ring = f
                    .ring
                    .after(&op.request_key, op.at.0, &self.params.receipts);
                self.write_row(tx, op, key, f.model, &row, &ring)?;
                spans.cut(ReadCause::Scoped("record"))?;
                // The version changed (its stamp), even though no searched text did.
                self.search.changed(
                    tx,
                    key,
                    op.sequence as i64,
                    &kind,
                    Some(&Value::Object(f.scalars.clone())),
                    Some(&Value::Object(f.scalars.clone())),
                    op.at.0,
                    extra,
                )?;
                spans.cut(ReadCause::Scoped("search"))?;
                let k = log::owner_key(tx, &mut self.rng, &f.owner)?;
                spans.cut(ReadCause::Scoped("bookkeeping"))?;
                self.log(
                    tx,
                    op,
                    key,
                    Some(k),
                    &json!({"member": {"field": field, "index": index, "value": value}}),
                    extra,
                )?;
                spans.cut(ReadCause::Scoped("history"))?;
                Ok(Reply::Nothing)
            }
            Intent::Delete { key } => {
                let f = self.find(tx, key, None)?.ok_or_else(missing)?;
                spans.cut(ReadCause::Scoped("record"))?;
                let ring = f
                    .ring
                    .after(&op.request_key, op.at.0, &self.params.receipts);
                self.remove(
                    tx,
                    key,
                    &f,
                    Some((op.sequence as i64, &ring)),
                    op.at.0,
                    spans,
                    extra,
                )?;
                let k = log::owner_key(tx, &mut self.rng, &f.owner)?;
                spans.cut(ReadCause::Scoped("bookkeeping"))?;
                self.log(tx, op, key, Some(k), &json!({"remove": true}), extra)?;
                spans.cut(ReadCause::Scoped("history"))?;
                Ok(Reply::Nothing)
            }
            Intent::List { kind, limit } => {
                let Some(i) = self.model_of(kind) else {
                    spans.cut(ReadCause::Scoped("index"))?;
                    return Ok(Reply::Keys(Vec::new()));
                };
                let declared =
                    layout::declared(&self.params.indexes, &IndexOf::KindNewest).is_some();
                let mut stmt = tx
                    .prepare_cached(&format!(
                        "SELECT record_id FROM {} WHERE deleted = 0 ORDER BY seq DESC LIMIT ?1",
                        self.models[i].table
                    ))
                    .map_err(err)?;
                let keys = stmt
                    .query_map([*limit as i64], |r| r.get(0))
                    .map_err(err)?
                    .collect::<Result<Vec<String>, _>>()
                    .map_err(err)?;
                spans.cut(ReadCause::Scoped(if declared { "index" } else { "scan" }))?;
                Ok(Reply::Keys(keys))
            }
            Intent::Search {
                kinds,
                field,
                word,
                limit,
            } => {
                let models = &self.models;
                let found = self.search.search(
                    tx,
                    field,
                    word,
                    kinds.as_deref(),
                    *limit,
                    op.at.0,
                    spans,
                    extra,
                    &mut |k| {
                        Ok(find_in(models, tx, k, None)?
                            .filter(|f| !f.deleted)
                            .map(|f| (f.seq, models[f.model].kind.clone())))
                    },
                )?;
                spans.cut(ReadCause::Scoped("search"))?;
                if let Some(keys) = found {
                    return Ok(Reply::Keys(keys));
                }
                let mut hits: Vec<(i64, String)> = Vec::new();
                for (i, m) in self.models.iter().enumerate() {
                    if kinds.as_ref().is_some_and(|k| !k.contains(&m.kind)) {
                        continue;
                    }
                    let ids: Vec<String> = {
                        let mut stmt = tx
                            .prepare_cached(&format!(
                                "SELECT record_id FROM {} WHERE deleted = 0",
                                m.table
                            ))
                            .map_err(err)?;
                        let rows = stmt.query_map([], |r| r.get(0)).map_err(err)?;
                        rows.collect::<Result<_, _>>().map_err(err)?
                    };
                    for id in ids {
                        if let Some(f) = self.find(tx, &id, Some(std::slice::from_ref(&m.kind)))? {
                            debug_assert_eq!(f.model, i);
                            if f.scalars
                                .get(field)
                                .and_then(Value::as_str)
                                .is_some_and(|t| workload_simulation::generate::has_word(t, word))
                            {
                                hits.push((f.seq, id));
                            }
                        }
                    }
                }
                spans.cut(ReadCause::Scoped("scan"))?;
                hits.sort_by(|a, b| b.0.cmp(&a.0));
                hits.truncate(*limit as usize);
                Ok(Reply::Keys(hits.into_iter().map(|(_, k)| k).collect()))
            }
            Intent::EraseOwner { owner } => {
                let mut erased = std::collections::BTreeSet::new();
                for i in 0..self.models.len() {
                    let ids: Vec<String> = {
                        let mut stmt = tx
                            .prepare_cached(&format!(
                                "SELECT record_id FROM {} WHERE owner_key = ?1 AND deleted = 0",
                                self.models[i].table
                            ))
                            .map_err(err)?;
                        let rows = stmt.query_map([owner], |r| r.get(0)).map_err(err)?;
                        rows.collect::<Result<_, _>>().map_err(err)?
                    };
                    spans.cut(ReadCause::Scoped("erasure"))?;
                    let kind = [self.models[i].kind.clone()];
                    for id in ids {
                        if let Some(f) = self.find(tx, &id, Some(&kind))? {
                            spans.cut(ReadCause::Scoped("record"))?;
                            self.remove(tx, &id, &f, None, op.at.0, spans, extra)?;
                            erased.insert(id);
                        }
                    }
                }
                self.search.erase(tx, &erased, extra)?;
                spans.cut(ReadCause::Scoped("search"))?;
                log::destroy_owner_key(tx, owner)?;
                spans.cut(ReadCause::Scoped("erasure"))?;
                self.log(tx, op, "", None, &json!({"erased_owner_key": true}), extra)?;
                spans.cut(ReadCause::Scoped("history"))?;
                Ok(Reply::Nothing)
            }
        }
    }

    /// A retry is answered by the receipt ring of the row it addresses
    /// (live or tombstone; the probe a point read already makes).
    fn receipt(&self, tx: &Transaction, op: &Operation) -> Result<bool, StoreError> {
        if op.attempt <= 1 {
            return Ok(false);
        }
        let Some(key) = receipts::addressed(&op.intent) else {
            return Ok(false);
        };
        let ring = self.row(tx, key, None)?.map(|f| f.ring);
        Ok(
            receipts::answer(ring.as_ref(), op, op.at.0, &self.params.receipts)?
                == Answer::Duplicate,
        )
    }
}

impl kit::Work for Core {
    fn path(&self) -> &Path {
        &self.path
    }
    fn reopen(&mut self) -> Result<(MeteredDb, Meters), StoreError> {
        self.open_db(false)
    }
    fn run(
        &mut self,
        db: &mut MeteredDb,
        op: &Operation,
        spans: &mut Spans,
    ) -> Result<Done, StoreError> {
        let mut extra = Meters::new();
        let models = self.models.len();
        let result = (|| {
            let tx = db
                .conn_mut()
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(err)?;
            let duplicate = self.receipt(&tx, op)?;
            spans.cut(ReadCause::Scoped("receipt"))?;
            if duplicate {
                tx.commit().map_err(err)?;
                return Ok((Reply::Nothing, true));
            }
            let reply = self.intent(&tx, op, spans, &mut extra)?;
            tx.commit().map_err(err)?;
            Ok((reply, false))
        })();
        if result.is_err() {
            // A kind compiled inside a rolled-back save does not exist.
            self.models.truncate(models);
            self.search.rollback();
        } else {
            self.search.commit();
        }
        result.map(|(reply, duplicate)| Done {
            reply,
            duplicate,
            extra,
        })
    }
}

impl Candidate for S4 {
    fn id(&self) -> &str {
        &self.id
    }
    fn about(&self) -> String {
        "S4: one typed table per kind compiled from its model at the kind's first save, native indexes, child tables for lists, S2's log module".into()
    }
    fn meters(&self) -> Vec<&'static str> {
        SQLITE_METERS.to_vec()
    }
    fn capabilities(&self) -> Vec<Capability> {
        vec![
            capability("point_read", true, "probe of each kind table in model order (no kind on a read)"),
            capability(
                "request_idempotency",
                true,
                "receipt ring in the record's row (the probe a point read makes); a delete leaves a tombstone row keeping it",
            ),
            capability("history_log", true, "S2's sealed log row per change"),
            capability("list_newest_by_kind", true, "native index on the kind table's seq"),
            capability(
                "search",
                true,
                Search::new(self.params.search.clone(), PathBuf::new())
                    .map_or("invalid", |s| s.note()),
            ),
            capability("erase_owner", true, "owner index of every kind table + destroy the owner key"),
            capability(
                "new_kind_without_ddl",
                false,
                "a new kind runs CREATE TABLE/INDEX inside the save that introduces it",
            ),
            capability("field_stamps_sync_undo_layers", false, "record-log modules not yet ported"),
            capability("fresh_rights_admission", false, "layer O2 not measured"),
        ]
    }
    fn params(&self) -> Value {
        serde_json::to_value(&self.params).unwrap_or(Value::Null)
    }
    fn open(&self, ctx: StoreContext) -> Result<Opened, StoreError> {
        let mut core = Core {
            path: ctx.dir.join("store.sqlite"),
            log: Log::new(
                &CHANGE_LOG,
                ctx.dir.join("archive"),
                self.params.generation_rows,
            ),
            params: self.params.clone(),
            meter: WorkMeter::new(),
            rng: ctx.rng,
            models: Vec::new(),
            search: Search::new(self.params.search.clone(), ctx.dir.join("search"))?,
        };
        let (db, meters) = core.open_db(true)?;
        Ok(Opened {
            store: Box::new(S4Store { db: Some(db), core }),
            meters,
        })
    }
}

impl Store for S4Store {
    fn load(&mut self, ops: &[Operation]) -> Result<Meters, StoreError> {
        let mut total = Meters::new();
        for chunk in ops.chunks(256) {
            let db = self.db.as_mut().ok_or_else(kit::crashed)?;
            let mut spans = db.spans()?;
            let mut extra = Meters::new();
            let core = &mut self.core;
            let models = core.models.len();
            let result = (|| {
                let tx = db
                    .conn_mut()
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(err)?;
                for op in chunk {
                    if let Intent::Create {
                        key,
                        kind,
                        owner,
                        value,
                    } = &op.intent
                    {
                        core.create(&tx, op, key, kind, owner, value, &mut spans, &mut extra)?;
                    }
                }
                tx.commit().map_err(err)
            })();
            if result.is_err() {
                core.models.truncate(models);
                core.search.rollback();
            } else {
                core.search.commit();
            }
            let m = db.finish(spans);
            result?;
            total.merge(&m?);
            total.merge(&extra);
        }
        Ok(total)
    }

    fn apply(&mut self, op: &Operation, fault: Option<Interrupt>) -> Outcome {
        kit::apply(&mut self.db, &mut self.core, op, fault)
    }

    fn alarm(&mut self, _now: SimTime) -> Result<Meters, StoreError> {
        Ok(Meters::new())
    }
    fn next_alarm(&self) -> Option<SimTime> {
        None
    }
    fn crash(&mut self) {
        kit::crash(&mut self.db);
        self.core.search.crash();
    }
    fn recover(&mut self) -> Result<Meters, StoreError> {
        let (db, m) = self.core.open_db(false)?;
        self.db = Some(db);
        Ok(m)
    }
    fn inspect(&mut self, key: &str) -> Result<Option<Value>, StoreError> {
        let db = self.db.as_ref().ok_or_else(kit::crashed)?;
        let tx = db.inspector().unchecked_transaction().map_err(err)?;
        self.core
            .find(&tx, key, None)?
            .map(|f| self.core.value(&tx, key, &f))
            .transpose()
    }
    fn gauges(&mut self) -> Result<Meters, StoreError> {
        self.db.as_ref().ok_or_else(kit::crashed)?.gauges()
    }
    fn files(&self) -> Vec<PathBuf> {
        let mut f = self.db.as_ref().map(|d| d.files()).unwrap_or_default();
        f.extend(self.core.log.files());
        f.extend(self.core.search.files());
        f
    }
}
