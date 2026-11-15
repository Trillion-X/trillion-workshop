//! S5: one versioned table. A save inserts exactly one row
//! `(resource, record_id, version DESC)` that is both the current value and
//! the history entry; reading current is one primary-key seek `LIMIT 1`;
//! history is the older versions in the same table; erasure is a range
//! delete by `(resource, record_id)`.
//!
//! Secondary access is opt-in DATA and counted separately, so results show
//! record cost with and without declared indexes:
//! - `kind_newest: true` adds `rec_kind_newest(resource, kind, version DESC)`
//!   (one more index entry per saved version);
//! - `search` is the shared search port (`search.rs`; layout is DATA).
//!
//! Without them, list/search/erase-by-owner scan the table (every version).
//! Retries (attempt > 1) are answered by the receipt ring inside the newest
//! version row (`receipts.rs`): one primary-key seek, flat over time. A
//! delete is a tombstone version, so its ring outlives the record.

use local_engine::sqlite_work::WorkMeter;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};
use workload_simulation::{
    Candidate, Capability, Intent, Interrupt, Meters, Opened, Operation, Outcome, Reply, SimTime,
    Store, StoreContext, StoreError,
};

use super::kit::{self, capability, Done};
use super::receipts::{self, Answer, ReceiptParams, Ring};
use super::search::{self, Current, Search, SearchParams};
use crate::meter::{err, MeteredDb, ReadCause, Spans, SQLITE_METERS};

const RESOURCE: &str = "r";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
    pub kind_newest: bool,
    pub search: SearchParams,
    pub receipts: ReceiptParams,
}

pub fn classify(name: &str) -> &'static str {
    match name {
        "rec" => "record",
        "rec_kind_newest" => "index",
        n if search::is_search_table(n) => "search",
        _ => "unclassified",
    }
}

pub struct S5 {
    id: String,
    params: Params,
}

impl S5 {
    pub fn new(id: String, params: Value) -> Result<Self, StoreError> {
        let params: Params = serde_json::from_value(params).map_err(err)?;
        params.receipts.check()?;
        Search::new(params.search.clone(), PathBuf::new())?;
        Ok(Self { id, params })
    }
}

pub struct S5Store {
    db: Option<MeteredDb>,
    core: Core,
}

struct Core {
    path: PathBuf,
    params: Params,
    meter: WorkMeter,
    search: Search,
}

/// The newest version of one record (a tombstone when `deleted`).
struct Latest {
    version: i64,
    kind: String,
    owner: String,
    deleted: bool,
    body: Option<Map<String, Value>>,
    ring: Ring,
}

impl Latest {
    fn value(&self) -> Value {
        Value::Object(self.body.clone().unwrap_or_default())
    }
}

fn latest(conn: &Connection, key: &str) -> Result<Option<Latest>, StoreError> {
    conn.prepare_cached(
        "SELECT version, kind, owner, deleted, body, receipts FROM rec WHERE resource = ?1 AND record_id = ?2 ORDER BY version DESC LIMIT 1",
    )
    .map_err(err)?
    .query_row(params![RESOURCE, key], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, bool>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, String>(5)?,
        ))
    })
    .optional()
    .map_err(err)?
    .map(|(version, kind, owner, deleted, body, ring)| {
        Ok(Latest {
            version,
            kind,
            owner,
            deleted,
            body: body.map(|b| serde_json::from_str(&b)).transpose().map_err(err)?,
            ring: Ring::parse(Some(&ring))?,
        })
    })
    .transpose()
}

fn current(conn: &Connection, key: &str) -> Result<Option<Latest>, StoreError> {
    Ok(latest(conn, key)?.filter(|l| !l.deleted))
}

/// Current records whose newest version is above `after`: through the
/// declared kind order when there is one (a seek per kind + the range),
/// otherwise a scan of every version.
fn changed_since(
    conn: &Connection,
    kind_newest: bool,
    after: i64,
) -> Result<Vec<(String, Current)>, StoreError> {
    let mut ids: BTreeSet<String> = BTreeSet::new();
    if kind_newest {
        let mut from = String::new();
        loop {
            let kind: Option<String> = conn
                .prepare_cached(
                    "SELECT kind FROM rec INDEXED BY rec_kind_newest WHERE resource = ?1 AND kind > ?2 ORDER BY kind LIMIT 1",
                )
                .map_err(err)?
                .query_row(params![RESOURCE, from], |r| r.get(0))
                .optional()
                .map_err(err)?;
            let Some(kind) = kind else { break };
            let mut stmt = conn
                .prepare_cached(
                    "SELECT record_id FROM rec INDEXED BY rec_kind_newest WHERE resource = ?1 AND kind = ?2 AND version > ?3",
                )
                .map_err(err)?;
            let rows = stmt
                .query_map(params![RESOURCE, kind, after], |r| r.get::<_, String>(0))
                .map_err(err)?;
            for id in rows {
                ids.insert(id.map_err(err)?);
            }
            from = kind;
        }
    } else {
        let mut stmt = conn
            .prepare_cached(
                "SELECT DISTINCT record_id FROM rec WHERE resource = ?1 AND version > ?2",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map(params![RESOURCE, after], |r| r.get::<_, String>(0))
            .map_err(err)?;
        for id in rows {
            ids.insert(id.map_err(err)?);
        }
    }
    let mut out = Vec::new();
    for id in ids {
        if let Some(l) = current(conn, &id)? {
            out.push((
                id,
                Current {
                    stamp: l.version,
                    kind: l.kind.clone(),
                    value: l.value(),
                },
            ));
        }
    }
    Ok(out)
}

impl Core {
    fn open_db(&mut self, create: bool) -> Result<(MeteredDb, Meters), StoreError> {
        let mut db = MeteredDb::open(&self.path, self.meter.clone(), classify)?;
        let mut spans = db.spans()?;
        db.conn()
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;",
            )
            .map_err(err)?;
        if create {
            db.conn()
                .execute_batch(
                    "CREATE TABLE rec(resource TEXT NOT NULL, record_id TEXT NOT NULL, version INTEGER NOT NULL,
                       kind TEXT NOT NULL, owner TEXT NOT NULL, deleted INTEGER NOT NULL, body TEXT,
                       receipts TEXT NOT NULL,
                       PRIMARY KEY(resource, record_id, version DESC)) WITHOUT ROWID;",
                )
                .map_err(err)?;
            if self.params.kind_newest {
                db.conn()
                    .execute_batch(
                        "CREATE INDEX rec_kind_newest ON rec(resource, kind, version DESC);",
                    )
                    .map_err(err)?;
            }
            self.search.create(db.conn())?;
            spans.cut(ReadCause::Scoped("bookkeeping"))?;
        } else {
            spans.cut(ReadCause::Scoped("bookkeeping"))?;
            if let Some(after) = self.search.reopen(db.conn())? {
                let records = changed_since(db.conn(), self.params.kind_newest, after)?;
                self.search.fill(records);
            }
            spans.cut(ReadCause::Scoped("search"))?;
        }
        let m = db.finish(spans)?;
        Ok((db, m))
    }

    fn insert(tx: &Transaction, op: &Operation, key: &str, l: &Latest) -> Result<(), StoreError> {
        let body = l
            .body
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(err)?;
        tx.prepare_cached(
            "INSERT INTO rec(resource, record_id, version, kind, owner, deleted, body, receipts)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )
        .map_err(err)?
        .execute(params![
            RESOURCE,
            key,
            op.sequence as i64,
            l.kind,
            l.owner,
            l.deleted,
            body,
            l.ring.text()?
        ])
        .map_err(err)?;
        Ok(())
    }

    /// A retry is answered by the ring of the newest version it addresses.
    fn receipt(&self, tx: &Transaction, op: &Operation) -> Result<bool, StoreError> {
        if op.attempt <= 1 {
            return Ok(false);
        }
        let Some(key) = receipts::addressed(&op.intent) else {
            return Ok(false);
        };
        let ring = latest(tx, key)?.map(|l| l.ring);
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
        let result = (|| {
            let tx = db
                .conn_mut()
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(err)?;
            let duplicate = self.receipt(&tx, op)?;
            spans.cut(ReadCause::Scoped("receipt"))?;
            let reply = if duplicate {
                Reply::Nothing
            } else {
                intent(&tx, op, &self.params, &mut self.search, spans, &mut extra)?
            };
            tx.commit().map_err(err)?;
            Ok((reply, duplicate))
        })();
        match &result {
            Ok(_) => self.search.commit(),
            Err(_) => self.search.rollback(),
        }
        result.map(|(reply, duplicate)| Done {
            reply,
            duplicate,
            extra,
        })
    }
}

/// The version row a change writes: the new state plus the advanced ring.
fn next(prev: Option<&Latest>, op: &Operation, p: &Params, l: Latest) -> Latest {
    let ring = prev.map(|x| x.ring.clone()).unwrap_or_default().after(
        &op.request_key,
        op.at.0,
        &p.receipts,
    );
    Latest { ring, ..l }
}

fn intent(
    tx: &Transaction,
    op: &Operation,
    p: &Params,
    search: &mut Search,
    spans: &mut Spans,
    extra: &mut Meters,
) -> Result<Reply, StoreError> {
    let missing = || StoreError("record is absent".into());
    let stamp = op.sequence as i64;
    let now = op.at.0;
    match &op.intent {
        Intent::Create {
            key,
            kind,
            owner,
            value,
        } => {
            let l = next(
                None,
                op,
                p,
                Latest {
                    version: stamp,
                    kind: kind.clone(),
                    owner: owner.clone(),
                    deleted: false,
                    body: value.as_object().cloned(),
                    ring: Ring::default(),
                },
            );
            Core::insert(tx, op, key, &l)?;
            spans.cut(ReadCause::Scoped("record"))?;
            search.changed(tx, key, stamp, kind, None, Some(value), now, extra)?;
            spans.cut(ReadCause::Scoped("search"))?;
            Ok(Reply::Nothing)
        }
        Intent::Read { key } => {
            let v = current(tx, key)?.map(|l| l.value());
            spans.cut(ReadCause::Scoped("record"))?;
            Ok(Reply::Value(v))
        }
        Intent::Update { key, field, value } => {
            let prev = current(tx, key)?.ok_or_else(missing)?;
            spans.cut(ReadCause::Scoped("record"))?;
            let mut body = prev.body.clone().unwrap_or_default();
            body.insert(field.clone(), value.clone());
            write_version(tx, op, p, search, key, &prev, body, spans, extra)?;
            Ok(Reply::Nothing)
        }
        Intent::WriteMember {
            key,
            field,
            index,
            value,
        } => {
            let prev = current(tx, key)?.ok_or_else(missing)?;
            spans.cut(ReadCause::Scoped("record"))?;
            let mut body = prev.body.clone().unwrap_or_default();
            let slot = body
                .get_mut(field)
                .and_then(Value::as_array_mut)
                .and_then(|a| a.get_mut(*index as usize))
                .ok_or_else(|| StoreError("member out of range".into()))?;
            *slot = value.clone();
            write_version(tx, op, p, search, key, &prev, body, spans, extra)?;
            Ok(Reply::Nothing)
        }
        Intent::Delete { key } => {
            let prev = current(tx, key)?.ok_or_else(missing)?;
            spans.cut(ReadCause::Scoped("record"))?;
            let l = next(
                Some(&prev),
                op,
                p,
                Latest {
                    version: stamp,
                    kind: prev.kind.clone(),
                    owner: prev.owner.clone(),
                    deleted: true,
                    body: None,
                    ring: Ring::default(),
                },
            );
            Core::insert(tx, op, key, &l)?;
            spans.cut(ReadCause::Scoped("record"))?;
            search.changed(
                tx,
                key,
                stamp,
                &prev.kind,
                Some(&prev.value()),
                None,
                now,
                extra,
            )?;
            spans.cut(ReadCause::Scoped("search"))?;
            Ok(Reply::Nothing)
        }
        Intent::List { kind, limit } => {
            let mut keys = Vec::new();
            if p.kind_newest {
                let mut seen = BTreeSet::new();
                let mut stmt = tx
                    .prepare_cached(
                        "SELECT record_id, deleted FROM rec INDEXED BY rec_kind_newest
                         WHERE resource = ?1 AND kind = ?2 ORDER BY version DESC",
                    )
                    .map_err(err)?;
                let mut rows = stmt.query(params![RESOURCE, kind]).map_err(err)?;
                while keys.len() < *limit as usize {
                    let Some(r) = rows.next().map_err(err)? else {
                        break;
                    };
                    let id: String = r.get(0).map_err(err)?;
                    if seen.insert(id.clone()) && !r.get::<_, bool>(1).map_err(err)? {
                        keys.push(id);
                    }
                }
                drop(rows);
                spans.cut(ReadCause::Scoped("index"))?;
            } else {
                let mut newest: Vec<(i64, String)> = Vec::new();
                let mut stmt = tx
                    .prepare_cached(
                        "SELECT record_id, version, kind, deleted FROM rec WHERE resource = ?1 ORDER BY record_id, version DESC",
                    )
                    .map_err(err)?;
                let mut rows = stmt.query([RESOURCE]).map_err(err)?;
                let mut last = String::new();
                while let Some(r) = rows.next().map_err(err)? {
                    let id: String = r.get(0).map_err(err)?;
                    if id == last {
                        continue;
                    }
                    last = id.clone();
                    if r.get::<_, String>(2).map_err(err)? == *kind
                        && !r.get::<_, bool>(3).map_err(err)?
                    {
                        newest.push((r.get(1).map_err(err)?, id));
                    }
                }
                drop(rows);
                newest.sort_by(|a, b| b.0.cmp(&a.0));
                keys = newest
                    .into_iter()
                    .take(*limit as usize)
                    .map(|(_, k)| k)
                    .collect();
                spans.cut(ReadCause::Scoped("scan"))?;
            }
            Ok(Reply::Keys(keys))
        }
        Intent::Search {
            kinds,
            field,
            word,
            limit,
        } => {
            let found = search.search(
                tx,
                field,
                word,
                kinds.as_deref(),
                *limit,
                now,
                spans,
                extra,
                &mut |k| Ok(current(tx, k)?.map(|l| (l.version, l.kind))),
            )?;
            spans.cut(ReadCause::Scoped("search"))?;
            if let Some(keys) = found {
                return Ok(Reply::Keys(keys));
            }
            let wanted = |kind: &str| kinds.as_ref().is_none_or(|k| k.iter().any(|x| x == kind));
            let mut hits: Vec<(i64, String)> = Vec::new();
            let mut stmt = tx
                .prepare_cached(
                    "SELECT record_id, version, kind, deleted, body FROM rec WHERE resource = ?1 ORDER BY record_id, version DESC",
                )
                .map_err(err)?;
            let mut rows = stmt.query([RESOURCE]).map_err(err)?;
            let mut last = String::new();
            while let Some(r) = rows.next().map_err(err)? {
                let id: String = r.get(0).map_err(err)?;
                if id == last {
                    continue;
                }
                last = id.clone();
                if r.get::<_, bool>(3).map_err(err)?
                    || !wanted(&r.get::<_, String>(2).map_err(err)?)
                {
                    continue;
                }
                let body: Value =
                    serde_json::from_str(&r.get::<_, String>(4).map_err(err)?).map_err(err)?;
                if body
                    .get(field)
                    .and_then(Value::as_str)
                    .is_some_and(|t| workload_simulation::generate::has_word(t, word))
                {
                    hits.push((r.get(1).map_err(err)?, id));
                }
            }
            drop(rows);
            spans.cut(ReadCause::Scoped("scan"))?;
            hits.sort_by(|a, b| b.0.cmp(&a.0));
            hits.truncate(*limit as usize);
            Ok(Reply::Keys(hits.into_iter().map(|(_, k)| k).collect()))
        }
        Intent::EraseOwner { owner } => {
            let mut stmt = tx
                .prepare_cached(
                    "SELECT DISTINCT record_id FROM rec WHERE resource = ?1 AND owner = ?2",
                )
                .map_err(err)?;
            let found: BTreeSet<String> = stmt
                .query_map(params![RESOURCE, owner], |r| r.get(0))
                .map_err(err)?
                .collect::<Result<_, _>>()
                .map_err(err)?;
            spans.cut(ReadCause::Scoped("erasure"))?;
            for id in &found {
                if let Some(l) = current(tx, id)? {
                    spans.cut(ReadCause::Scoped("record"))?;
                    search.changed(
                        tx,
                        id,
                        l.version,
                        &l.kind,
                        Some(&l.value()),
                        None,
                        now,
                        extra,
                    )?;
                    spans.cut(ReadCause::Scoped("search"))?;
                }
                tx.prepare_cached("DELETE FROM rec WHERE resource = ?1 AND record_id = ?2")
                    .map_err(err)?
                    .execute(params![RESOURCE, id])
                    .map_err(err)?;
                spans.cut(ReadCause::Scoped("record"))?;
            }
            search.erase(tx, &found, extra)?;
            spans.cut(ReadCause::Scoped("search"))?;
            Ok(Reply::Nothing)
        }
    }
}

/// A new version from `prev` with `body`, and its search change.
#[allow(clippy::too_many_arguments)]
fn write_version(
    tx: &Transaction,
    op: &Operation,
    p: &Params,
    search: &mut Search,
    key: &str,
    prev: &Latest,
    body: Map<String, Value>,
    spans: &mut Spans,
    extra: &mut Meters,
) -> Result<(), StoreError> {
    let stamp = op.sequence as i64;
    let l = next(
        Some(prev),
        op,
        p,
        Latest {
            version: stamp,
            kind: prev.kind.clone(),
            owner: prev.owner.clone(),
            deleted: false,
            body: Some(body),
            ring: Ring::default(),
        },
    );
    Core::insert(tx, op, key, &l)?;
    spans.cut(ReadCause::Scoped("record"))?;
    search.changed(
        tx,
        key,
        stamp,
        &prev.kind,
        Some(&prev.value()),
        Some(&l.value()),
        op.at.0,
        extra,
    )?;
    spans.cut(ReadCause::Scoped("search"))?;
    Ok(())
}

impl Candidate for S5 {
    fn id(&self) -> &str {
        &self.id
    }
    fn about(&self) -> String {
        "S5: one versioned row per save (current value = history entry), PK (resource, record_id, version DESC)".into()
    }
    fn meters(&self) -> Vec<&'static str> {
        SQLITE_METERS.to_vec()
    }
    fn capabilities(&self) -> Vec<Capability> {
        let c = capability;
        let search = Search::new(self.params.search.clone(), PathBuf::new());
        vec![
            c("point_read", true, "one primary-key seek LIMIT 1"),
            c(
                "history",
                true,
                "every version kept in the same table (no retirement)",
            ),
            c(
                "request_idempotency",
                true,
                "receipt ring in the newest version row (one seek; tombstone versions keep it after a delete)",
            ),
            c(
                "list_newest_by_kind",
                true,
                if self.params.kind_newest {
                    "declared rec_kind_newest index"
                } else {
                    "table scan"
                },
            ),
            c("search", true, search.map_or("invalid", |s| s.note())),
            c("erase_owner", true, "owner scan + range delete per record"),
            c(
                "history_retirement",
                false,
                "versions are never sealed or dropped",
            ),
            c(
                "field_stamps_sync_undo_layers",
                false,
                "record-log modules not ported",
            ),
            c("fresh_rights_admission", false, "layer O2 not measured"),
        ]
    }
    fn params(&self) -> Value {
        serde_json::to_value(&self.params).unwrap_or(Value::Null)
    }
    fn open(&self, ctx: StoreContext) -> Result<Opened, StoreError> {
        let mut core = Core {
            path: ctx.dir.join("store.sqlite"),
            params: self.params.clone(),
            meter: WorkMeter::new(),
            search: Search::new(self.params.search.clone(), ctx.dir.join("search"))?,
        };
        let (db, meters) = core.open_db(true)?;
        Ok(Opened {
            store: Box::new(S5Store { db: Some(db), core }),
            meters,
        })
    }
}

impl Store for S5Store {
    fn load(&mut self, ops: &[Operation]) -> Result<Meters, StoreError> {
        let mut total = Meters::new();
        for chunk in ops.chunks(256) {
            let db = self.db.as_mut().ok_or_else(kit::crashed)?;
            let mut spans = db.spans()?;
            let mut extra = Meters::new();
            let core = &mut self.core;
            let result = (|| {
                let tx = db
                    .conn_mut()
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(err)?;
                for op in chunk {
                    intent(
                        &tx,
                        op,
                        &core.params,
                        &mut core.search,
                        &mut spans,
                        &mut extra,
                    )?;
                }
                tx.commit().map_err(err)
            })();
            match &result {
                Ok(()) => core.search.commit(),
                Err(_) => core.search.rollback(),
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
        Ok(current(&tx, key)?.map(|l| l.value()))
    }
    fn gauges(&mut self) -> Result<Meters, StoreError> {
        self.db.as_ref().ok_or_else(kit::crashed)?.gauges()
    }
    fn files(&self) -> Vec<PathBuf> {
        let mut f = self.db.as_ref().map(|d| d.files()).unwrap_or_default();
        f.extend(self.core.search.files());
        f
    }
}
