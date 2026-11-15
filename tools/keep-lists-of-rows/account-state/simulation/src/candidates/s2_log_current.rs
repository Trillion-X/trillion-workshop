//! S2: log row + current row in one transaction, one generic declared index
//! table, member rows for large lists, history sealed per owner key and
//! retired by generation (plan 03 §2b). S3 is this adapter plus a cold tier
//! (`s3_tiered`), which takes over the current-row reads and writes.
//!
//! Schema (compiled, fixed table count whatever the number of kinds — O1):
//! - `cur(record_id PK, kind, body, version, seq, prev_seq, owner_key, lists)` WITHOUT ROWID
//! - `mem(record_id, list_id, member_key, body, seq)` WITHOUT ROWID: list members
//! - `idx(index_id, value, record_id)` WITHOUT ROWID: every declared index (DATA)
//! - the shared log module (`log`): `owner_keys`, `generations` and
//!   `log_g<gen>(seq, record_id, tx, actor, app_time, sys_time, key_id, diff)`.
//!   `diff` is sealed with the owner's key, so erasure = destroy the key +
//!   delete the current/member/index/search rows.
//! - optional `words` word-row table (shared `search` module).
//!
//! Retries (attempt > 1) are answered by the receipt ring inside the record's
//! current row (`receipts.rs`): one seek, flat over time. A delete leaves a
//! tombstone current row (no body, no owner) that keeps the ring.

use local_engine::sqlite_work::WorkMeter;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use workload_simulation::{
    Candidate, Capability, DetRng, Intent, Interrupt, Meters, Opened, Operation, Outcome, Reply,
    SimTime, Store, StoreContext, StoreError,
};

use super::kit::{self, capability, Done};
use super::layout::{self, EraseLookup, IndexDecl, IndexOf};
use super::log::{self, Log, OwnerKey, CHANGE_LOG};
use super::receipts::{self, Answer, ReceiptParams, Ring};
use super::s3_tiered::{Loc, Tier, TierParams};
use super::search::{self, Current, Search, SearchParams};
use crate::meter::{err, MeteredDb, ReadCause, Spans, SQLITE_METERS};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
    pub indexes: Vec<IndexDecl>,
    pub search: SearchParams,
    /// Lists with at least this many members are stored as member rows.
    pub member_min: usize,
    pub generation_rows: u64,
    pub receipts: ReceiptParams,
    pub erase_lookup: EraseLookup,
    /// S3 only: the cold tier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<TierParams>,
}

pub fn classify(table: &str) -> &'static str {
    if let Some(c) = log::classify(table).or_else(|| super::s3_tiered::classify(table)) {
        return c;
    }
    match table {
        "cur" | "mem" => "record",
        "idx" => "index",
        t if search::is_search_table(t) => "search",
        _ => "unclassified",
    }
}

pub struct S2 {
    id: String,
    params: Params,
}

impl S2 {
    pub fn new(id: String, params: Value) -> Result<Self, StoreError> {
        let s = Self::checked(id, params)?;
        if s.params.tier.is_some() {
            return Err(StoreError(
                "a tier makes this S3: use adapter s3_tiered".into(),
            ));
        }
        Ok(s)
    }

    /// Validated params shared by S2 and S3.
    pub fn checked(id: String, params: Value) -> Result<Self, StoreError> {
        let params: Params = serde_json::from_value(params).map_err(err)?;
        if params.erase_lookup == EraseLookup::OwnerIndex
            && layout::declared(&params.indexes, &IndexOf::Owner).is_none()
        {
            return Err(StoreError(
                "erase_lookup owner_index needs an owner index declaration".into(),
            ));
        }
        Search::new(params.search.clone(), PathBuf::new())?;
        params.receipts.check()?;
        if params.generation_rows == 0 || params.member_min == 0 {
            return Err(StoreError(
                "generation_rows and member_min must be >= 1".into(),
            ));
        }
        Ok(Self { id, params })
    }

    pub fn params_of(&self) -> &Params {
        &self.params
    }
}

/// One current row as stored. `members` is filled only for a cold record
/// (its member lists travel inside its cold entry, not in `mem`).
pub struct Cur {
    pub kind: String,
    pub body: Map<String, Value>,
    pub lists: Vec<String>,
    pub seq: i64,
    pub owner: String,
    pub members: Option<Vec<(String, Vec<Value>)>>,
    pub ring: Ring,
}

impl Cur {
    /// Whole current value: body plus member lists.
    pub fn value(&self, conn: &Connection, key: &str) -> Result<Value, StoreError> {
        match &self.members {
            Some(lists) => {
                let mut v = self.body.clone();
                for (list, items) in lists {
                    v.insert(list.clone(), Value::Array(items.clone()));
                }
                Ok(Value::Object(v))
            }
            None => layout::assemble(conn, key, &self.body, &self.lists),
        }
    }
}

/// How a removed current row ends.
pub enum Removal<'a> {
    /// Delete: the row becomes a tombstone (no body, no owner) keeping its
    /// receipt ring; `seq` is the deleting change's order key.
    Tombstone { seq: i64, ring: &'a Ring },
    /// Owner erasure: every copy goes.
    Erase,
}

pub struct S2Store {
    db: Option<MeteredDb>,
    core: Core,
}

struct Core {
    path: PathBuf,
    params: Params,
    meter: WorkMeter,
    rng: DetRng,
    log: Log,
    tier: Option<Tier>,
    search: Search,
}

/// The current row (`live`) or any row including a tombstone.
fn read_cur(conn: &Connection, key: &str, live: bool) -> Result<Option<Cur>, StoreError> {
    conn.prepare_cached(
        "SELECT kind, body, lists, seq, owner_key, deleted, receipts FROM cur WHERE record_id = ?1",
    )
    .map_err(err)?
    .query_row([key], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, bool>(5)?,
            r.get::<_, String>(6)?,
        ))
    })
    .optional()
    .map_err(err)?
    .filter(|row| !(live && row.5))
    .map(|(kind, body, lists, seq, owner, _, ring)| {
        Ok(Cur {
            kind,
            body: serde_json::from_str(&body).map_err(err)?,
            lists: layout::parse_lists(lists)?,
            seq,
            owner,
            members: None,
            ring: Ring::parse(Some(&ring))?,
        })
    })
    .transpose()
}

/// The live current row: hot first, then (S3) the cold tier.
fn live(
    conn: &Connection,
    tier: Option<&Tier>,
    key: &str,
    for_write: bool,
    extra: &mut Meters,
) -> Result<Option<(Cur, Loc)>, StoreError> {
    match tier {
        None => Ok(read_cur(conn, key, true)?.map(|c| (c, Loc::Hot(0)))),
        Some(t) => t.get(conn, key, for_write, extra),
    }
}

impl Core {
    fn open_db(&mut self, create: bool) -> Result<(MeteredDb, Meters), StoreError> {
        let mut db = MeteredDb::open(&self.path, self.meter.clone(), classify)?;
        let mut spans = db.spans()?;
        let mut extra = Meters::new();
        if create {
            db.conn()
                .execute_batch(
                    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;",
                )
                .map_err(err)?;
            match &mut self.tier {
                None => db
                    .conn()
                    .execute_batch(
                        "CREATE TABLE cur(record_id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL,
                       version INTEGER NOT NULL, seq INTEGER NOT NULL, prev_seq INTEGER,
                       owner_key TEXT NOT NULL, lists TEXT, deleted INTEGER NOT NULL, receipts TEXT NOT NULL) WITHOUT ROWID;",
                    )
                    .map_err(err)?,
                Some(t) => t.create(db.conn())?,
            }
            db.conn()
                .execute_batch(&format!("{}\n{}", layout::MEM_DDL, layout::IDX_DDL))
                .map_err(err)?;
            self.log.create(db.conn())?;
            self.search.create(db.conn())?;
            spans.cut(ReadCause::Scoped("bookkeeping"))?;
        } else {
            db.conn()
                .execute_batch("PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;")
                .map_err(err)?;
            self.log.recover(db.conn())?;
            if let Some(t) = &mut self.tier {
                t.recover(db.conn(), &mut extra)?;
            }
            spans.cut(ReadCause::Scoped("bookkeeping"))?;
            if let Some(after) = self.search.reopen(db.conn())? {
                let records = self.changed_since(db.conn(), after, &mut extra)?;
                self.search.fill(records);
            }
            spans.cut(ReadCause::Scoped("search"))?;
        }
        let mut m = db.finish(spans)?;
        m.merge(&extra);
        Ok((db, m))
    }

    /// Current records whose order key is above `after` (search tail rebuild).
    fn changed_since(
        &self,
        conn: &Connection,
        after: i64,
        extra: &mut Meters,
    ) -> Result<Vec<(String, Current)>, StoreError> {
        let ids: Vec<String> = match layout::declared(&self.params.indexes, &IndexOf::KindNewest) {
            Some(d) => layout::changed_since(conn, &d.id, after)?,
            None => {
                let mut stmt = conn
                    .prepare_cached("SELECT record_id FROM cur WHERE deleted = 0 AND seq > ?1")
                    .map_err(err)?;
                let rows = stmt.query_map([after], |r| r.get(0)).map_err(err)?;
                rows.collect::<Result<_, _>>().map_err(err)?
            }
        };
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some((c, _)) = live(conn, self.tier.as_ref(), &id, false, extra)? {
                out.push((
                    id,
                    Current {
                        stamp: c.seq,
                        kind: c.kind,
                        value: Value::Object(c.body),
                    },
                ));
            }
        }
        Ok(out)
    }

    fn index_values(
        &self,
        kind: &str,
        body: &Map<String, Value>,
        seq: i64,
    ) -> Vec<(String, String)> {
        layout::index_values(&self.params.indexes, kind, body, seq)
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

    /// A retry is answered by the ring of the row it addresses.
    fn receipt(&self, tx: &Transaction, op: &Operation) -> Result<bool, StoreError> {
        if op.attempt <= 1 {
            return Ok(false);
        }
        let Some(key) = receipts::addressed(&op.intent) else {
            return Ok(false);
        };
        let ring = match &self.tier {
            None => read_cur(tx, key, false)?.map(|c| c.ring),
            Some(t) => t.ring(tx, key)?,
        };
        Ok(
            receipts::answer(ring.as_ref(), op, op.at.0, &self.params.receipts)?
                == Answer::Duplicate,
        )
    }

    /// The ring a change by `op` leaves on a row whose ring was `prev`.
    fn ring_after(&self, prev: &Ring, op: &Operation) -> Ring {
        prev.after(&op.request_key, op.at.0, &self.params.receipts)
    }
}

impl kit::Work for Core {
    fn path(&self) -> &Path {
        &self.path
    }
    fn reopen(&mut self) -> Result<(MeteredDb, Meters), StoreError> {
        self.open_db(false)
    }

    /// Execute one operation inside its own transaction.
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
            if duplicate {
                tx.commit().map_err(err)?;
                return Ok((Reply::Nothing, true));
            }
            if kit::mutating(&op.intent) {
                if let Some(t) = &mut self.tier {
                    t.step(&tx, op.at, &mut self.rng, &mut extra)?;
                    spans.cut(ReadCause::Scoped("maintenance"))?;
                }
            }
            let reply = self.intent(&tx, op, spans, &mut extra)?;
            tx.commit().map_err(err)?;
            Ok((reply, false))
        })();
        self.settle(result.is_ok());
        result.map(|(reply, duplicate)| Done {
            reply,
            duplicate,
            extra,
        })
    }
}

impl Core {
    /// The transaction ended: staged volatile state becomes state or goes.
    fn settle(&mut self, committed: bool) {
        if let Some(t) = &mut self.tier {
            if committed {
                t.commit()
            } else {
                t.rollback()
            }
        }
        if committed {
            self.search.commit()
        } else {
            self.search.rollback()
        }
    }

    fn intent(
        &mut self,
        tx: &Transaction,
        op: &Operation,
        spans: &mut Spans,
        extra: &mut Meters,
    ) -> Result<Reply, StoreError> {
        let missing = || StoreError("record is absent".into());
        let now = op.at.0;
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
                let cur = live(tx, self.tier.as_ref(), key, false, extra)?;
                let v = cur.map(|(c, _)| c.value(tx, key)).transpose()?;
                spans.cut(ReadCause::Scoped("record"))?;
                Ok(Reply::Value(v))
            }
            Intent::Update { key, field, value } => {
                let (cur, loc) =
                    live(tx, self.tier.as_ref(), key, true, extra)?.ok_or_else(missing)?;
                spans.cut(ReadCause::Scoped("record"))?;
                if cur.lists.contains(field) {
                    tx.execute(
                        "DELETE FROM mem WHERE record_id = ?1 AND list_id = ?2",
                        params![key, field],
                    )
                    .map_err(err)?;
                    layout::put_members(
                        tx,
                        key,
                        field,
                        value.as_array().map(Vec::as_slice).unwrap_or(&[]),
                        op,
                    )?;
                }
                let mut body = cur.body.clone();
                if !cur.lists.contains(field) {
                    body.insert(field.clone(), value.clone());
                }
                self.bump(tx, op, key, &cur, &loc, &body, spans, extra)?;
                let k = log::owner_key(tx, &mut self.rng, &cur.owner)?;
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
                let (cur, loc) =
                    live(tx, self.tier.as_ref(), key, true, extra)?.ok_or_else(missing)?;
                spans.cut(ReadCause::Scoped("record"))?;
                let mut body = cur.body.clone();
                if cur.lists.contains(field) {
                    let n = tx
                        .prepare_cached(
                            "UPDATE mem SET body = ?4, seq = ?5 WHERE record_id = ?1 AND list_id = ?2 AND member_key = ?3",
                        )
                        .map_err(err)?
                        .execute(params![
                            key,
                            field,
                            *index as i64,
                            serde_json::to_string(value).map_err(err)?,
                            op.sequence as i64
                        ])
                        .map_err(err)?;
                    if n != 1 {
                        return Err(StoreError("member out of range".into()));
                    }
                } else {
                    let slot = body
                        .get_mut(field)
                        .and_then(Value::as_array_mut)
                        .and_then(|l| l.get_mut(*index as usize))
                        .ok_or_else(|| StoreError("member out of range".into()))?;
                    *slot = value.clone();
                }
                self.bump(tx, op, key, &cur, &loc, &body, spans, extra)?;
                let k = log::owner_key(tx, &mut self.rng, &cur.owner)?;
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
                let (cur, loc) =
                    live(tx, self.tier.as_ref(), key, false, extra)?.ok_or_else(missing)?;
                spans.cut(ReadCause::Scoped("record"))?;
                let ring = self.ring_after(&cur.ring, op);
                self.remove(
                    tx,
                    key,
                    &cur,
                    &loc,
                    Removal::Tombstone {
                        seq: op.sequence as i64,
                        ring: &ring,
                    },
                    now,
                    spans,
                    extra,
                )?;
                let k = log::owner_key(tx, &mut self.rng, &cur.owner)?;
                spans.cut(ReadCause::Scoped("bookkeeping"))?;
                self.log(tx, op, key, Some(k), &json!({"remove": true}), extra)?;
                spans.cut(ReadCause::Scoped("history"))?;
                Ok(Reply::Nothing)
            }
            Intent::List { kind, limit } => {
                let keys = if let Some(d) =
                    layout::declared(&self.params.indexes, &IndexOf::KindNewest)
                {
                    let keys = layout::newest_of_kind(tx, &d.id, kind, *limit)?;
                    spans.cut(ReadCause::Scoped("index"))?;
                    keys
                } else {
                    let mut stmt = tx
                        .prepare_cached(
                            "SELECT record_id FROM cur WHERE kind = ?1 AND deleted = 0 ORDER BY seq DESC LIMIT ?2",
                        )
                        .map_err(err)?;
                    let rows = stmt
                        .query_map(params![kind, *limit as i64], |r| r.get(0))
                        .map_err(err)?;
                    let keys = rows.collect::<Result<Vec<String>, _>>().map_err(err)?;
                    spans.cut(ReadCause::Scoped("scan"))?;
                    keys
                };
                Ok(Reply::Keys(keys))
            }
            Intent::Search {
                kinds,
                field,
                word,
                limit,
            } => {
                let tier = self.tier.as_ref();
                let mut probes = Meters::new();
                let found = self.search.search(
                    tx,
                    field,
                    word,
                    kinds.as_deref(),
                    *limit,
                    now,
                    spans,
                    extra,
                    &mut |k| {
                        Ok(live(tx, tier, k, false, &mut probes)?.map(|(c, _)| (c.seq, c.kind)))
                    },
                )?;
                extra.merge(&probes);
                spans.cut(ReadCause::Scoped("search"))?;
                if let Some(keys) = found {
                    return Ok(Reply::Keys(keys));
                }
                let mut hits: Vec<(i64, String)> = Vec::new();
                let mut stmt = tx
                    .prepare_cached(
                        "SELECT record_id, kind, body, seq FROM cur WHERE deleted = 0 ORDER BY seq DESC",
                    )
                    .map_err(err)?;
                let mut rows = stmt.query([]).map_err(err)?;
                while let Some(r) = rows.next().map_err(err)? {
                    if hits.len() >= *limit as usize {
                        break;
                    }
                    let kind: String = r.get(1).map_err(err)?;
                    if kinds.as_ref().is_some_and(|k| !k.contains(&kind)) {
                        continue;
                    }
                    let body: Value =
                        serde_json::from_str(&r.get::<_, String>(2).map_err(err)?).map_err(err)?;
                    if body
                        .get(field)
                        .and_then(Value::as_str)
                        .is_some_and(|t| workload_simulation::generate::has_word(t, word))
                    {
                        hits.push((r.get(3).map_err(err)?, r.get(0).map_err(err)?));
                    }
                }
                spans.cut(ReadCause::Scoped("scan"))?;
                Ok(Reply::Keys(hits.into_iter().map(|(_, k)| k).collect()))
            }
            Intent::EraseOwner { owner } => {
                let keys: Vec<String> = match self.params.erase_lookup {
                    EraseLookup::OwnerIndex => {
                        let id = layout::declared(&self.params.indexes, &IndexOf::Owner)
                            .map(|d| d.id.clone())
                            .unwrap_or_default();
                        layout::index_keys(tx, &id, owner)?
                    }
                    EraseLookup::Scan => {
                        let mut stmt = tx
                            .prepare_cached("SELECT record_id FROM cur WHERE owner_key = ?1")
                            .map_err(err)?;
                        let rows = stmt.query_map([owner], |r| r.get(0)).map_err(err)?;
                        rows.collect::<Result<_, _>>().map_err(err)?
                    }
                };
                spans.cut(ReadCause::Scoped("erasure"))?;
                for key in &keys {
                    if let Some((cur, loc)) = live(tx, self.tier.as_ref(), key, false, extra)? {
                        spans.cut(ReadCause::Scoped("record"))?;
                        self.remove(tx, key, &cur, &loc, Removal::Erase, now, spans, extra)?;
                    }
                }
                self.search.erase(tx, &keys.into_iter().collect(), extra)?;
                spans.cut(ReadCause::Scoped("search"))?;
                log::destroy_owner_key(tx, owner)?;
                spans.cut(ReadCause::Scoped("erasure"))?;
                // Tombstone: unsealed, names no owner, records only that a key was destroyed.
                self.log(tx, op, "", None, &json!({"erased_owner_key": true}), extra)?;
                spans.cut(ReadCause::Scoped("history"))?;
                Ok(Reply::Nothing)
            }
        }
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
        let (body, lists) = layout::split(value, self.params.member_min);
        let names = layout::list_names(&lists)?;
        let text = serde_json::to_string(&body).map_err(err)?;
        let ring = self.ring_after(&Ring::default(), op).text()?;
        match &self.tier {
            None => {
                tx.prepare_cached(
                    "INSERT INTO cur(record_id, kind, body, version, seq, prev_seq, owner_key, lists, deleted, receipts)
                     VALUES(?1, ?2, ?3, 1, ?4, NULL, ?5, ?6, 0, ?7)",
                )
                .map_err(err)?
                .execute(params![key, kind, text, op.sequence as i64, owner, names, ring])
                .map_err(err)?;
            }
            Some(t) => t.insert(tx, op, key, kind, &text, owner, names.as_deref(), &ring)?,
        }
        for (name, members) in &lists {
            layout::put_members(tx, key, name, members, op)?;
        }
        spans.cut(ReadCause::Scoped("record"))?;
        layout::put_index(tx, &self.index_values(kind, &body, op.sequence as i64), key)?;
        spans.cut(ReadCause::Scoped("index"))?;
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

    /// New version of the current row + the index entries whose value
    /// changed + its search change.
    #[allow(clippy::too_many_arguments)]
    fn bump(
        &mut self,
        tx: &Transaction,
        op: &Operation,
        key: &str,
        cur: &Cur,
        loc: &Loc,
        body: &Map<String, Value>,
        spans: &mut Spans,
        extra: &mut Meters,
    ) -> Result<(), StoreError> {
        let text = serde_json::to_string(body).map_err(err)?;
        let ring = self.ring_after(&cur.ring, op).text()?;
        match &self.tier {
            None => {
                tx.prepare_cached("UPDATE cur SET body = ?2, version = version + 1, prev_seq = seq, seq = ?3, receipts = ?4 WHERE record_id = ?1")
                    .map_err(err)?
                    .execute(params![key, text, op.sequence as i64, ring])
                    .map_err(err)?;
            }
            Some(t) => t.rewrite(tx, op, key, loc, &text, &ring)?,
        }
        spans.cut(ReadCause::Scoped("record"))?;
        layout::move_index(
            tx,
            &self.index_values(&cur.kind, &cur.body, cur.seq),
            &self.index_values(&cur.kind, body, op.sequence as i64),
            key,
        )?;
        spans.cut(ReadCause::Scoped("index"))?;
        self.search.changed(
            tx,
            key,
            op.sequence as i64,
            &cur.kind,
            Some(&Value::Object(cur.body.clone())),
            Some(&Value::Object(body.clone())),
            op.at.0,
            extra,
        )?;
        spans.cut(ReadCause::Scoped("search"))?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn remove(
        &mut self,
        tx: &Transaction,
        key: &str,
        cur: &Cur,
        loc: &Loc,
        how: Removal<'_>,
        now: u64,
        spans: &mut Spans,
        extra: &mut Meters,
    ) -> Result<(), StoreError> {
        if !cur.lists.is_empty() && cur.members.is_none() {
            tx.execute("DELETE FROM mem WHERE record_id = ?1", [key])
                .map_err(err)?;
        }
        let stamp = match &how {
            Removal::Tombstone { seq, .. } => *seq,
            Removal::Erase => cur.seq,
        };
        match &mut self.tier {
            None => match &how {
                Removal::Tombstone { seq, ring } => {
                    tx.prepare_cached(
                        "UPDATE cur SET body = '{}', lists = NULL, owner_key = '', deleted = 1,
                         version = version + 1, prev_seq = seq, seq = ?2, receipts = ?3 WHERE record_id = ?1",
                    )
                    .map_err(err)?
                    .execute(params![key, seq, ring.text()?])
                    .map_err(err)?;
                }
                Removal::Erase => {
                    tx.prepare_cached("DELETE FROM cur WHERE record_id = ?1")
                        .map_err(err)?
                        .execute([key])
                        .map_err(err)?;
                }
            },
            Some(t) => t.remove(tx, key, loc, &how, now)?,
        }
        spans.cut(ReadCause::Scoped("record"))?;
        layout::drop_index(tx, &self.index_values(&cur.kind, &cur.body, cur.seq), key)?;
        spans.cut(ReadCause::Scoped("index"))?;
        self.search.changed(
            tx,
            key,
            stamp,
            &cur.kind,
            Some(&Value::Object(cur.body.clone())),
            None,
            now,
            extra,
        )?;
        spans.cut(ReadCause::Scoped("search"))?;
        Ok(())
    }
}

impl S2 {
    pub fn capabilities_of(&self) -> Vec<Capability> {
        let search = Search::new(self.params.search.clone(), PathBuf::new());
        vec![
            capability(
                "point_read",
                true,
                "one current-row seek (+ member rows for large lists)",
            ),
            capability(
                "request_idempotency",
                true,
                "receipt ring in the current row (one seek); a delete leaves a tombstone row keeping it",
            ),
            capability(
                "history_log",
                true,
                "sealed log row per change; prev_seq version chain",
            ),
            capability(
                "list_newest_by_kind",
                true,
                "kind_newest entries in idx (or a scan when undeclared)",
            ),
            capability("search", true, search.map_or("invalid", |s| s.note())),
            capability(
                "erase_owner",
                true,
                "delete current/member/index/search rows + destroy the owner key",
            ),
            capability(
                "field_stamps_sync_undo_layers",
                false,
                "record-log modules not yet ported onto cur/log",
            ),
            capability("fresh_rights_admission", false, "layer O2 not measured"),
        ]
    }

    pub fn open_store(&self, ctx: StoreContext) -> Result<Opened, StoreError> {
        let mut core = Core {
            path: ctx.dir.join("store.sqlite"),
            log: Log::new(
                &CHANGE_LOG,
                ctx.dir.join("archive"),
                self.params.generation_rows,
            ),
            tier: self
                .params
                .tier
                .clone()
                .map(|p| Tier::new(p, ctx.dir.join("cold"))),
            search: Search::new(self.params.search.clone(), ctx.dir.join("search"))?,
            params: self.params.clone(),
            meter: WorkMeter::new(),
            rng: ctx.rng,
        };
        let (db, meters) = core.open_db(true)?;
        Ok(Opened {
            store: Box::new(S2Store { db: Some(db), core }),
            meters,
        })
    }
}

impl Candidate for S2 {
    fn id(&self) -> &str {
        &self.id
    }
    fn about(&self) -> String {
        "S2: log row + current row per save, generic declared index table, member rows, sealed history generations".into()
    }
    fn meters(&self) -> Vec<&'static str> {
        SQLITE_METERS.to_vec()
    }
    fn capabilities(&self) -> Vec<Capability> {
        self.capabilities_of()
    }
    fn params(&self) -> Value {
        serde_json::to_value(&self.params).unwrap_or(Value::Null)
    }
    fn open(&self, ctx: StoreContext) -> Result<Opened, StoreError> {
        self.open_store(ctx)
    }
}

impl Store for S2Store {
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
            core.settle(result.is_ok());
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
        if let Some(t) = &mut self.core.tier {
            t.crash();
        }
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
        let mut unmetered = Meters::new();
        let cur = live(&tx, self.core.tier.as_ref(), key, false, &mut unmetered)?;
        cur.map(|(c, _)| c.value(&tx, key)).transpose()
    }
    fn gauges(&mut self) -> Result<Meters, StoreError> {
        self.db.as_ref().ok_or_else(kit::crashed)?.gauges()
    }
    fn files(&self) -> Vec<PathBuf> {
        let mut f = self.db.as_ref().map(|d| d.files()).unwrap_or_default();
        f.extend(self.core.log.files());
        if let Some(t) = &self.core.tier {
            f.extend(t.files());
        }
        f.extend(self.core.search.files());
        f
    }
}
