//! record store: one current row per record, plus a history row written only when a
//! version is replaced (the plan's leading candidate, §5a; the shape of the
//! SQL:2011 system-versioned temporal tables of SQL Server, Db2 and MariaDB).
//! A create writes exactly 1 durable row plus its declared index entries.
//!
//! Schema (fixed table count whatever the number of kinds):
//! - `cur(record_id PK, kind, body, at, actor, receipts, prev_at, owner_key,
//!   lists, recent, deleted)` WITHOUT ROWID. `at` is the commit stamp: a
//!   hybrid logical clock (ms << 16 | counter) minted by the single writer
//!   inside the write, unique and increasing per object. `actor` and the
//!   newest entry of the `receipts` ring stamp the newest version; the ring
//!   answers retries (`receipts.rs`, 0 receipt rows). A delete leaves a
//!   tombstone row (no body, no owner) that keeps the ring.
//! - `mem`, `idx` and the search port's tables: the shared layout and search parts.
//! - the shared log module with the record store row: `log_g<n>(at PK, record_id, op,
//!   prev_at, actor, cause, born_at, born_actor, born_cause, key_id,
//!   before)`. `before` is the REVERSE diff of the replaced version (old
//!   values of the changed fields; the whole body for a delete), sealed with
//!   the owner's key. `born_*` are filled only on a record's first log row,
//!   so creator stamps survive the overwrite of `cur`.
//! - `high_water(id = 1, at)`: the newest committed stamp that no reader
//!   order otherwise shows (window-accepted creates, sealed generations).
//!
//! Variants are params (`order`, `in_row_versions`):
//! - `order: exact` declares a durable order: `kind_newest` entries keyed by
//!   `at` in `idx` (+1 entry per create, +2 per replace).
//! - `order: coarse` keeps no order index. "Newest of a kind" merges two
//!   ranges newest first: the log by `at` (replacements, deletes, late
//!   creates) and `cur` by id (creates never replaced). Engine keys sort in
//!   mint order, so a create whose key sorts above every committed key and
//!   whose commit stamp is within `skew_window_ms` of its mint time is in the
//!   id range at 0 extra rows; when its stamp's millisecond differs from the
//!   mint time it also upserts the high-water row (+1). Any other create is a
//!   late create: one `late-create` log row (+1), and `cur.prev_at` points to
//!   it. When the open generation's log is exhausted before the list is full
//!   and older generations were sealed, the list falls back to a scan.
//! - `in_row_versions: N` (N >= 2, exact order only) keeps the last reverse
//!   diffs inside `cur.recent` and writes one log row per N replacements:
//!   1 + 1/N rows per update. Refused with `coarse`: unflushed in-row
//!   changes are invisible to the log range that coarse lists read.

use local_engine::sqlite_work::WorkMeter;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};
use workload_simulation::{
    Candidate, Capability, DetRng, Intent, Interrupt, Meters, Opened, Operation, Outcome, Reply,
    SimTime, Store, StoreContext, StoreError,
};

use super::kit::{self, capability, Done};
use super::layout::{self, EraseLookup, IndexDecl, IndexOf};
use super::log::{self, Log, LogShape};
use super::receipts::{self, Answer, ReceiptParams, Ring};
use super::search::{self, Current, Search, SearchParams};
use crate::meter::{err, MeteredDb, ReadCause, Spans, SQLITE_METERS};

/// The record store history row: reverse diff keyed by the replacing commit stamp.
pub const REPLACED_LOG: LogShape = LogShape {
    key: "at",
    columns: "at INTEGER PRIMARY KEY, record_id TEXT NOT NULL, op TEXT NOT NULL, prev_at INTEGER,
           actor TEXT NOT NULL, cause TEXT NOT NULL, born_at INTEGER, born_actor TEXT, born_cause TEXT,
           key_id INTEGER, before BLOB",
    archived: &[
        "at",
        "record_id",
        "op",
        "prev_at",
        "actor",
        "cause",
        "born_at",
        "born_actor",
        "born_cause",
        "key_id",
        "before",
    ],
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
    pub order: Order,
    /// 0 = every replacement writes its log row; N >= 2 batches N in `cur`.
    pub in_row_versions: u32,
    pub indexes: Vec<IndexDecl>,
    pub search: SearchParams,
    pub member_min: usize,
    pub generation_rows: u64,
    pub erase_lookup: EraseLookup,
    pub receipts: ReceiptParams,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Order {
    Exact,
    Coarse { skew_window_ms: u64 },
}

pub fn classify(table: &str) -> &'static str {
    if let Some(c) = log::classify(table) {
        return c;
    }
    match table {
        "cur" | "mem" => "record",
        "idx" => "index",
        "high_water" => "bookkeeping",
        t if search::is_search_table(t) => "search",
        _ => "unclassified",
    }
}

pub struct record store {
    id: String,
    params: Params,
}

impl record store {
    pub fn new(id: String, params: Value) -> Result<Self, StoreError> {
        let params: Params = serde_json::from_value(params).map_err(err)?;
        let kind_newest = layout::declared(&params.indexes, &IndexOf::KindNewest).is_some();
        match params.order {
            Order::Exact if !kind_newest => {
                return Err(StoreError(
                    "order exact is the declared kind_newest index; declare it".into(),
                ))
            }
            Order::Coarse { .. } if kind_newest => {
                return Err(StoreError(
                    "order coarse keeps no order index; remove kind_newest".into(),
                ))
            }
            Order::Coarse { .. } if params.in_row_versions > 0 => {
                return Err(StoreError(
                    "in-row history defers log rows, which coarse lists read; use order exact"
                        .into(),
                ))
            }
            _ => {}
        }
        if params.in_row_versions == 1 {
            return Err(StoreError(
                "in_row_versions is 0 (off) or >= 2 (1 is the plain log)".into(),
            ));
        }
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
}

/// The newest version of one record as stored (a tombstone when deleted).
struct Cur {
    kind: String,
    body: Map<String, Value>,
    at: i64,
    actor: String,
    prev_at: Option<i64>,
    owner: String,
    lists: Vec<String>,
    recent: Vec<Value>,
    /// Receipt ring; its newest entry is the request that wrote this version.
    ring: Ring,
}

impl Cur {
    /// The request key that wrote this version.
    fn cause(&self) -> String {
        self.ring
            .newest()
            .map(|r| r.request.clone())
            .unwrap_or_default()
    }

    /// The creator's stamps, needed by the record's first log row only:
    /// the oldest batched entry's stamps when in-row history holds some.
    fn born(&self) -> Option<(i64, String, String)> {
        if self.prev_at.is_some() {
            return None;
        }
        let stamp = |e: &Value| -> Option<(i64, String, String)> {
            Some((
                e.get("at")?.as_i64()?,
                e.get("actor")?.as_str()?.to_owned(),
                e.get("cause")?.as_str()?.to_owned(),
            ))
        };
        self.recent
            .first()
            .and_then(stamp)
            .or_else(|| Some((self.at, self.actor.clone(), self.cause())))
    }
}

/// The live current row, or (`live` false) any row including a tombstone.
fn read_cur(conn: &Connection, key: &str, live: bool) -> Result<Option<Cur>, StoreError> {
    conn.prepare_cached(
        "SELECT kind, body, at, actor, receipts, prev_at, owner_key, lists, recent, deleted FROM cur WHERE record_id = ?1",
    )
    .map_err(err)?
    .query_row([key], |r| {
        Ok((
            (
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ),
            (
                r.get::<_, Option<i64>>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, Option<String>>(8)?,
                r.get::<_, bool>(9)?,
            ),
        ))
    })
    .optional()
    .map_err(err)?
    .filter(|(_, b)| !(live && b.4))
    .map(|((kind, body, at, actor, ring), (prev_at, owner, lists, recent, _))| {
        Ok(Cur {
            kind,
            body: serde_json::from_str(&body).map_err(err)?,
            at,
            actor,
            prev_at,
            owner,
            lists: layout::parse_lists(lists)?,
            recent: recent
                .map(|r| serde_json::from_str(&r))
                .transpose()
                .map_err(err)?
                .unwrap_or_default(),
            ring: Ring::parse(Some(&ring))?,
        })
    })
    .transpose()
}

fn ms(at: i64) -> u64 {
    (at >> 16) as u64
}

pub struct RecordStore {
    db: Option<MeteredDb>,
    core: Core,
}

struct Core {
    path: PathBuf,
    params: Params,
    meter: WorkMeter,
    rng: DetRng,
    log: Log,
    /// Newest committed stamp (volatile; rebuilt on reopen).
    last_at: i64,
    /// Coarse order: the highest key in the id-ordered range.
    hw_key: String,
    search: Search,
}

impl Core {
    fn open_db(&mut self, create: bool) -> Result<(MeteredDb, Meters), StoreError> {
        let mut db = MeteredDb::open(&self.path, self.meter.clone(), classify)?;
        let mut spans = db.spans()?;
        if create {
            db.conn()
                .execute_batch(&format!(
                    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
                     CREATE TABLE cur(record_id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL,
                       at INTEGER NOT NULL, actor TEXT NOT NULL, receipts TEXT NOT NULL, prev_at INTEGER,
                       owner_key TEXT NOT NULL, lists TEXT, recent TEXT, deleted INTEGER NOT NULL) WITHOUT ROWID;
                     {}\n{}
                     CREATE TABLE high_water(id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL);",
                    layout::MEM_DDL,
                    layout::IDX_DDL
                ))
                .map_err(err)?;
            self.log.create(db.conn())?;
            self.search.create(db.conn())?;
            self.last_at = 0;
            self.hw_key.clear();
        } else {
            db.conn()
                .execute_batch("PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;")
                .map_err(err)?;
            self.log.recover(db.conn())?;
            self.recover_stamps(db.conn())?;
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

    /// Current records whose commit stamp is above `after`: the declared
    /// kind order when there is one, else a scan of the current rows.
    fn changed_since(
        &self,
        conn: &Connection,
        after: i64,
    ) -> Result<Vec<(String, Current)>, StoreError> {
        let ids: Vec<String> = match layout::declared(&self.params.indexes, &IndexOf::KindNewest) {
            Some(d) => layout::changed_since(conn, &d.id, after)?,
            None => {
                let mut stmt = conn
                    .prepare_cached("SELECT record_id FROM cur WHERE deleted = 0 AND at > ?1")
                    .map_err(err)?;
                let rows = stmt.query_map([after], |r| r.get(0)).map_err(err)?;
                rows.collect::<Result<_, _>>().map_err(err)?
            }
        };
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(c) = read_cur(conn, &id, true)? {
                out.push((
                    id,
                    Current {
                        stamp: c.at,
                        kind: c.kind,
                        value: Value::Object(c.body),
                    },
                ));
            }
        }
        Ok(out)
    }

    /// Cold start: `last_at` = the max of every stamp an ordered reader
    /// reads (log keys, the newest id-range create, the high-water row and,
    /// with an exact order, the newest entry of each kind). Nothing adds a
    /// window, so stamps never drift ahead of the clock.
    fn recover_stamps(&mut self, conn: &rusqlite::Connection) -> Result<(), StoreError> {
        let one = |sql: &str| -> Result<Option<i64>, StoreError> {
            conn.query_row(sql, [], |r| r.get::<_, Option<i64>>(0))
                .optional()
                .map(Option::flatten)
                .map_err(err)
        };
        let mut last = one(&format!("SELECT max(at) FROM {}", self.log.table()))?.unwrap_or(0);
        last = last.max(one("SELECT at FROM high_water WHERE id = 1")?.unwrap_or(0));
        let newest: Option<(String, i64)> = conn
            .query_row(
                "SELECT record_id, at FROM cur ORDER BY record_id DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(err)?;
        if let Some((key, at)) = newest {
            last = last.max(at);
            self.hw_key = key;
        } else {
            self.hw_key.clear();
        }
        if let Some(d) = layout::declared(&self.params.indexes, &IndexOf::KindNewest) {
            // Skip scan: the last entry of each kind, one seek per kind.
            for kind in layout::kinds_of(conn, &d.id)? {
                let top: Option<String> = conn
                    .query_row(
                        "SELECT max(value) FROM idx WHERE index_id = ?1 AND value >= ?2 AND value < ?3",
                        params![d.id, format!("{kind}\u{1}"), format!("{kind}\u{2}")],
                        |r| r.get(0),
                    )
                    .map_err(err)?;
                if let Some(at) = top
                    .as_deref()
                    .and_then(|t| t.rsplit('\u{1}').next())
                    .and_then(|t| t.parse::<i64>().ok())
                {
                    last = last.max(at);
                }
            }
        }
        self.last_at = last;
        Ok(())
    }

    /// Mint the commit stamp inside the write.
    fn stamp(&mut self, now: SimTime) -> i64 {
        let at = ((now.0 as i64) << 16).max(self.last_at + 1);
        self.last_at = at;
        at
    }

    fn index_values(
        &self,
        kind: &str,
        body: &Map<String, Value>,
        at: i64,
    ) -> Vec<(String, String)> {
        layout::index_values(&self.params.indexes, kind, body, at)
    }

    /// One history row; `born` is the creator's stamps when this is the
    /// record's first log row.
    #[allow(clippy::too_many_arguments)]
    fn log(
        &mut self,
        tx: &Transaction,
        op: &Operation,
        at: i64,
        key: &str,
        kind_of_row: &str,
        prev_at: Option<i64>,
        born: Option<(i64, &str, &str)>,
        sealing: Option<log::OwnerKey>,
        before: &Value,
        meters: &mut Meters,
    ) -> Result<(), StoreError> {
        let plain = serde_json::to_vec(before).map_err(err)?;
        let (kid, blob) = match sealing {
            Some((id, k)) => (
                Some(id),
                log::seal(&k, &log::op_nonce(op.sequence, op.attempt), &plain)?,
            ),
            None => (None, plain),
        };
        let (born_at, born_actor, born_cause) = match born {
            Some((a, ac, c)) => (Some(a), Some(ac), Some(c)),
            None => (None, None, None),
        };
        let sealed = self.log.append(
            tx,
            &[
                "at",
                "record_id",
                "op",
                "prev_at",
                "actor",
                "cause",
                "born_at",
                "born_actor",
                "born_cause",
                "key_id",
                "before",
            ],
            &[
                &at,
                &key,
                &kind_of_row,
                &prev_at,
                &op.actor,
                &op.request_key,
                &born_at,
                &born_actor,
                &born_cause,
                &kid,
                &blob,
            ],
            meters,
        )?;
        if sealed {
            // The generation was sealed and dropped: keep its newest stamp visible.
            self.raise_high_water(tx, at)?;
        }
        Ok(())
    }

    fn raise_high_water(&self, tx: &Transaction, at: i64) -> Result<(), StoreError> {
        tx.prepare_cached(
            "INSERT INTO high_water(id, at) VALUES(1, ?1) ON CONFLICT(id) DO UPDATE SET at = max(at, excluded.at)",
        )
        .map_err(err)?
        .execute([at])
        .map_err(err)?;
        Ok(())
    }

    /// A retry is answered by the receipt ring of the row it addresses
    /// (live or tombstone): one seek.
    fn receipt(&self, tx: &Transaction, op: &Operation) -> Result<bool, StoreError> {
        if op.attempt <= 1 {
            return Ok(false);
        }
        let Some(key) = receipts::addressed(&op.intent) else {
            return Ok(false);
        };
        let ring = read_cur(tx, key, false)?.map(|c| c.ring);
        Ok(
            receipts::answer(ring.as_ref(), op, op.at.0, &self.params.receipts)?
                == Answer::Duplicate,
        )
    }

    /// The ring a change committed at `at` by `op` leaves on a row.
    fn ring_after(&self, prev: &Ring, op: &Operation, at: i64) -> Ring {
        prev.after(&op.request_key, ms(at), &self.params.receipts)
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
        let at = self.stamp(op.at);
        let (body, lists) = layout::split(value, self.params.member_min);
        // Coarse order: is this create inside the id-ordered range?
        let late = match &self.params.order {
            Order::Exact => false,
            Order::Coarse { skew_window_ms } => {
                let in_order = self.hw_key.is_empty() || key > self.hw_key.as_str();
                let skew = ms(at).saturating_sub(op.at.0);
                !(in_order && skew <= *skew_window_ms)
            }
        };
        tx.prepare_cached(
            "INSERT INTO cur(record_id, kind, body, at, actor, receipts, prev_at, owner_key, lists, recent, deleted)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, 0)",
        )
        .map_err(err)?
        .execute(params![
            key,
            kind,
            serde_json::to_string(&body).map_err(err)?,
            at,
            op.actor,
            self.ring_after(&Ring::default(), op, at).text()?,
            if late { Some(at) } else { None },
            owner,
            layout::list_names(&lists)?
        ])
        .map_err(err)?;
        for (name, members) in &lists {
            layout::put_members(tx, key, name, members, op)?;
        }
        spans.cut(ReadCause::Scoped("record"))?;
        layout::put_index(tx, &self.index_values(kind, &body, at), key)?;
        spans.cut(ReadCause::Scoped("index"))?;
        self.search
            .changed(tx, key, at, kind, None, Some(value), op.at.0, extra)?;
        spans.cut(ReadCause::Scoped("search"))?;
        if let Order::Coarse { .. } = self.params.order {
            if late {
                self.log(
                    tx,
                    op,
                    at,
                    key,
                    "late-create",
                    None,
                    Some((at, &op.actor, &op.request_key)),
                    None,
                    &Value::Null,
                    extra,
                )?;
                spans.cut(ReadCause::Scoped("history"))?;
            } else {
                if ms(at) != op.at.0 {
                    // Window-accepted: its committed stamp is not its id's time.
                    self.raise_high_water(tx, at)?;
                    spans.cut(ReadCause::Scoped("bookkeeping"))?;
                }
                self.hw_key = key.to_owned();
            }
        }
        Ok(())
    }

    /// Replace the current version: the new `cur`, the moved index entries,
    /// and the reverse diff (as a log row, or batched in `cur.recent`).
    #[allow(clippy::too_many_arguments)]
    fn replace(
        &mut self,
        tx: &Transaction,
        op: &Operation,
        key: &str,
        cur: &Cur,
        body: &Map<String, Value>,
        before: Value,
        spans: &mut Spans,
        extra: &mut Meters,
    ) -> Result<(), StoreError> {
        let at = self.stamp(op.at);
        let entry =
            json!({"at": cur.at, "actor": cur.actor, "cause": cur.cause(), "before": before});
        let n = self.params.in_row_versions as usize;
        let mut recent = cur.recent.clone();
        let flush = if n >= 2 {
            recent.push(entry);
            recent.len() >= n
        } else {
            true
        };
        let prev_at = if flush { Some(at) } else { cur.prev_at };
        tx.prepare_cached(
            "UPDATE cur SET body = ?2, at = ?3, actor = ?4, receipts = ?5, prev_at = ?6, recent = ?7 WHERE record_id = ?1",
        )
        .map_err(err)?
        .execute(params![
            key,
            serde_json::to_string(body).map_err(err)?,
            at,
            op.actor,
            self.ring_after(&cur.ring, op, at).text()?,
            prev_at,
            if flush || recent.is_empty() {
                None
            } else {
                Some(serde_json::to_string(&recent).map_err(err)?)
            }
        ])
        .map_err(err)?;
        spans.cut(ReadCause::Scoped("record"))?;
        layout::move_index(
            tx,
            &self.index_values(&cur.kind, &cur.body, cur.at),
            &self.index_values(&cur.kind, body, at),
            key,
        )?;
        spans.cut(ReadCause::Scoped("index"))?;
        self.search.changed(
            tx,
            key,
            at,
            &cur.kind,
            Some(&Value::Object(cur.body.clone())),
            Some(&Value::Object(body.clone())),
            op.at.0,
            extra,
        )?;
        spans.cut(ReadCause::Scoped("search"))?;
        if flush {
            let k = log::owner_key(tx, &mut self.rng, &cur.owner)?;
            spans.cut(ReadCause::Scoped("bookkeeping"))?;
            let (row, payload) = if n >= 2 {
                ("batch", Value::Array(recent))
            } else {
                ("update", before)
            };
            self.write_replaced(tx, op, at, key, cur, row, k, &payload, extra)?;
            spans.cut(ReadCause::Scoped("history"))?;
        }
        Ok(())
    }

    /// A log row replacing (or deleting) `cur`'s version. The record's first
    /// log row carries its creator's stamps.
    #[allow(clippy::too_many_arguments)]
    fn write_replaced(
        &mut self,
        tx: &Transaction,
        op: &Operation,
        at: i64,
        key: &str,
        cur: &Cur,
        row: &str,
        k: log::OwnerKey,
        payload: &Value,
        extra: &mut Meters,
    ) -> Result<(), StoreError> {
        let born = cur.born();
        let born_ref = born
            .as_ref()
            .map(|(a, ac, c)| (*a, ac.as_str(), c.as_str()));
        self.log(
            tx,
            op,
            at,
            key,
            row,
            cur.prev_at,
            born_ref,
            Some(k),
            payload,
            extra,
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
        let (last_at, hw_key) = (self.last_at, self.hw_key.clone());
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
                self.intent(&tx, op, spans, &mut extra)?
            };
            tx.commit().map_err(err)?;
            Ok((reply, duplicate))
        })();
        if result.is_err() {
            // Nothing committed: the volatile order state goes back too.
            self.last_at = last_at;
            self.hw_key = hw_key;
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

impl Core {
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
                let v = read_cur(tx, key, true)?
                    .map(|c| layout::assemble(tx, key, &c.body, &c.lists))
                    .transpose()?;
                spans.cut(ReadCause::Scoped("record"))?;
                Ok(Reply::Value(v))
            }
            Intent::Update { key, field, value } => {
                let cur = read_cur(tx, key, true)?.ok_or_else(missing)?;
                spans.cut(ReadCause::Scoped("record"))?;
                let mut body = cur.body.clone();
                let before = if cur.lists.contains(field) {
                    let old: Vec<Value> = layout::members(tx, key)?
                        .into_iter()
                        .find(|(l, _)| l == field)
                        .map(|(_, m)| m)
                        .unwrap_or_default();
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
                    json!({ field: old })
                } else {
                    let old = body.insert(field.clone(), value.clone());
                    json!({ field: old })
                };
                self.replace(tx, op, key, &cur, &body, before, spans, extra)?;
                Ok(Reply::Nothing)
            }
            Intent::WriteMember {
                key,
                field,
                index,
                value,
            } => {
                let cur = read_cur(tx, key, true)?.ok_or_else(missing)?;
                spans.cut(ReadCause::Scoped("record"))?;
                let mut body = cur.body.clone();
                let old = if cur.lists.contains(field) {
                    let old: Option<String> = tx
                        .prepare_cached(
                            "SELECT body FROM mem WHERE record_id = ?1 AND list_id = ?2 AND member_key = ?3",
                        )
                        .map_err(err)?
                        .query_row(params![key, field, *index as i64], |r| r.get(0))
                        .optional()
                        .map_err(err)?;
                    let old = old.ok_or_else(|| StoreError("member out of range".into()))?;
                    tx.prepare_cached(
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
                    serde_json::from_str(&old).map_err(err)?
                } else {
                    let slot = body
                        .get_mut(field)
                        .and_then(Value::as_array_mut)
                        .and_then(|l| l.get_mut(*index as usize))
                        .ok_or_else(|| StoreError("member out of range".into()))?;
                    std::mem::replace(slot, value.clone())
                };
                let before = json!({"member": {"field": field, "index": index, "old": old}});
                self.replace(tx, op, key, &cur, &body, before, spans, extra)?;
                Ok(Reply::Nothing)
            }
            Intent::Delete { key } => {
                let cur = read_cur(tx, key, true)?.ok_or_else(missing)?;
                spans.cut(ReadCause::Scoped("record"))?;
                let whole = layout::assemble(tx, key, &cur.body, &cur.lists)?;
                let at = self.stamp(op.at);
                let ring = self.ring_after(&cur.ring, op, at);
                self.remove(tx, key, &cur, Some((at, &ring)), op.at.0, spans, extra)?;
                let k = log::owner_key(tx, &mut self.rng, &cur.owner)?;
                spans.cut(ReadCause::Scoped("bookkeeping"))?;
                let payload = json!({"body": whole, "recent": cur.recent});
                self.write_replaced(tx, op, at, key, &cur, "delete", k, &payload, extra)?;
                spans.cut(ReadCause::Scoped("history"))?;
                Ok(Reply::Nothing)
            }
            Intent::List { kind, limit } => {
                let keys = match &self.params.order {
                    Order::Exact => {
                        let d = layout::declared(&self.params.indexes, &IndexOf::KindNewest)
                            .ok_or_else(|| StoreError("order exact without kind_newest".into()))?;
                        let keys = layout::newest_of_kind(tx, &d.id, kind, *limit)?;
                        spans.cut(ReadCause::Scoped("index"))?;
                        keys
                    }
                    Order::Coarse { .. } => self.coarse_newest(tx, kind, *limit, spans)?,
                };
                Ok(Reply::Keys(keys))
            }
            Intent::Search {
                kinds,
                field,
                word,
                limit,
            } => {
                let found = self.search.search(
                    tx,
                    field,
                    word,
                    kinds.as_deref(),
                    *limit,
                    op.at.0,
                    spans,
                    extra,
                    &mut |k| Ok(read_cur(tx, k, true)?.map(|c| (c.at, c.kind))),
                )?;
                spans.cut(ReadCause::Scoped("search"))?;
                if let Some(keys) = found {
                    return Ok(Reply::Keys(keys));
                }
                let mut hits: Vec<(i64, String)> = Vec::new();
                let mut stmt = tx
                    .prepare_cached("SELECT record_id, kind, body, at FROM cur WHERE deleted = 0")
                    .map_err(err)?;
                let mut rows = stmt.query([]).map_err(err)?;
                while let Some(r) = rows.next().map_err(err)? {
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
                drop(rows);
                spans.cut(ReadCause::Scoped("scan"))?;
                hits.sort_by(|a, b| b.0.cmp(&a.0));
                hits.truncate(*limit as usize);
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
                    if let Some(cur) = read_cur(tx, key, true)? {
                        spans.cut(ReadCause::Scoped("record"))?;
                        self.remove(tx, key, &cur, None, op.at.0, spans, extra)?;
                    }
                }
                self.search
                    .erase(tx, &keys.iter().cloned().collect(), extra)?;
                spans.cut(ReadCause::Scoped("search"))?;
                log::destroy_owner_key(tx, owner)?;
                spans.cut(ReadCause::Scoped("erasure"))?;
                // Tombstone: unsealed, names no owner or record.
                let at = self.stamp(op.at);
                self.log(
                    tx,
                    op,
                    at,
                    "",
                    "erase-owner-key",
                    None,
                    None,
                    None,
                    &Value::Null,
                    extra,
                )?;
                spans.cut(ReadCause::Scoped("history"))?;
                Ok(Reply::Nothing)
            }
        }
    }

    /// Remove a record. `tombstone` (a delete: its commit stamp and ring)
    /// turns the current row into a tombstone that keeps the ring (no body,
    /// no owner; `prev_at` set, so coarse lists skip it); None (owner
    /// erasure) deletes the row.
    #[allow(clippy::too_many_arguments)]
    fn remove(
        &mut self,
        tx: &Transaction,
        key: &str,
        cur: &Cur,
        tombstone: Option<(i64, &Ring)>,
        now: u64,
        spans: &mut Spans,
        extra: &mut Meters,
    ) -> Result<(), StoreError> {
        if !cur.lists.is_empty() {
            tx.execute("DELETE FROM mem WHERE record_id = ?1", [key])
                .map_err(err)?;
        }
        match tombstone {
            Some((at, ring)) => {
                tx.prepare_cached(
                    "UPDATE cur SET body = '{}', lists = NULL, recent = NULL, owner_key = '', deleted = 1,
                     at = ?2, prev_at = ?2, receipts = ?3 WHERE record_id = ?1",
                )
                .map_err(err)?
                .execute(params![key, at, ring.text()?])
                .map_err(err)?;
            }
            None => {
                tx.prepare_cached("DELETE FROM cur WHERE record_id = ?1")
                    .map_err(err)?
                    .execute([key])
                    .map_err(err)?;
            }
        }
        spans.cut(ReadCause::Scoped("record"))?;
        layout::drop_index(tx, &self.index_values(&cur.kind, &cur.body, cur.at), key)?;
        spans.cut(ReadCause::Scoped("index"))?;
        let stamp = tombstone.map_or(cur.at, |(at, _)| at);
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

    /// Newest `limit` records of `kind` by last change, with no order index:
    /// merge the log (by `at`) and the id range of never-replaced creates.
    fn coarse_newest(
        &self,
        tx: &Transaction,
        kind: &str,
        limit: u32,
        spans: &mut Spans,
    ) -> Result<Vec<String>, StoreError> {
        let mut out: Vec<String> = Vec::new();
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut log_stmt = tx
            .prepare_cached(&format!(
                "SELECT at, record_id FROM {} ORDER BY at DESC",
                self.log.table()
            ))
            .map_err(err)?;
        let mut cur_stmt = tx
            .prepare_cached("SELECT record_id, kind, at, prev_at FROM cur ORDER BY record_id DESC")
            .map_err(err)?;
        let mut look = tx
            .prepare_cached("SELECT kind, at FROM cur WHERE record_id = ?1 AND deleted = 0")
            .map_err(err)?;
        let mut logs = log_stmt.query([]).map_err(err)?;
        let mut curs = cur_stmt.query([]).map_err(err)?;
        let next_log =
            |rows: &mut rusqlite::Rows<'_>| -> Result<Option<(i64, String)>, StoreError> {
                rows.next()
                    .map_err(err)?
                    .map(|r| Ok((r.get(0).map_err(err)?, r.get(1).map_err(err)?)))
                    .transpose()
            };
        // Creates never replaced, newest first (prev_at is null only for them).
        let next_create =
            |rows: &mut rusqlite::Rows<'_>| -> Result<Option<(i64, String, String)>, StoreError> {
                while let Some(r) = rows.next().map_err(err)? {
                    if r.get::<_, Option<i64>>(3).map_err(err)?.is_none() {
                        return Ok(Some((
                            r.get(2).map_err(err)?,
                            r.get(0).map_err(err)?,
                            r.get(1).map_err(err)?,
                        )));
                    }
                }
                Ok(None)
            };
        let mut a = next_log(&mut logs)?;
        let mut b = next_create(&mut curs)?;
        while out.len() < limit as usize {
            let take_log = match (&a, &b) {
                (None, None) => break,
                (Some(_), None) => true,
                (None, Some(_)) => false,
                (Some((la, _)), Some((ba, _, _))) => la > ba,
            };
            if take_log {
                let (at, id) = a.take().unwrap_or_default();
                if !id.is_empty() && !seen.contains(&id) {
                    let now: Option<(String, i64)> = look
                        .query_row([&id], |r| Ok((r.get(0)?, r.get(1)?)))
                        .optional()
                        .map_err(err)?;
                    if let Some((k, cur_at)) = now {
                        if cur_at == at {
                            seen.insert(id.clone());
                            if k == kind {
                                out.push(id);
                            }
                        }
                    }
                }
                a = next_log(&mut logs)?;
            } else {
                let (_, id, k) = b.take().unwrap_or_default();
                if seen.insert(id.clone()) && k == kind {
                    out.push(id);
                }
                b = next_create(&mut curs)?;
            }
        }
        drop(logs);
        drop(curs);
        let sealed_before = self.log.table() != "log_g1";
        if out.len() < limit as usize && sealed_before {
            // Replacements older than the open generation: scan current rows.
            spans.cut(ReadCause::Scoped("index"))?;
            let mut stmt = tx
                .prepare_cached(
                    "SELECT record_id FROM cur WHERE kind = ?1 AND deleted = 0 ORDER BY at DESC LIMIT ?2",
                )
                .map_err(err)?;
            let rows = stmt
                .query_map(params![kind, limit as i64], |r| r.get(0))
                .map_err(err)?;
            let keys = rows.collect::<Result<Vec<String>, _>>().map_err(err)?;
            spans.cut(ReadCause::Scoped("scan"))?;
            return Ok(keys);
        }
        spans.cut(ReadCause::Scoped("index"))?;
        Ok(out)
    }
}

impl Candidate for record store {
    fn id(&self) -> &str {
        &self.id
    }
    fn about(&self) -> String {
        "record store: one current row per record + a reverse-diff history row only when a version is replaced; commit stamps minted in the write".into()
    }
    fn meters(&self) -> Vec<&'static str> {
        SQLITE_METERS.to_vec()
    }
    fn capabilities(&self) -> Vec<Capability> {
        vec![
            capability("point_read", true, "one current-row seek (+ member rows for large lists)"),
            capability(
                "request_idempotency",
                true,
                "receipt ring in the current row (one seek, 0 receipt rows); a delete leaves a tombstone row keeping it",
            ),
            capability(
                "history_log",
                true,
                "reverse diff per replaced version, prev_at chain, creator stamps on the first row; sealed per owner key",
            ),
            capability(
                "list_newest_by_kind",
                true,
                match self.params.order {
                    Order::Exact => "declared kind_newest entries keyed by commit stamp",
                    Order::Coarse { .. } => "merge of the log stamp range and the id range of unreplaced creates",
                },
            ),
            capability(
                "search",
                true,
                Search::new(self.params.search.clone(), PathBuf::new())
                    .map_or("invalid", |s| s.note()),
            ),
            capability(
                "erase_owner",
                true,
                "delete current/member/index/search rows + destroy the owner key",
            ),
            capability("field_stamps_sync_undo_layers", false, "record-log modules not yet ported onto cur/log"),
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
                &REPLACED_LOG,
                ctx.dir.join("archive"),
                self.params.generation_rows,
            ),
            params: self.params.clone(),
            meter: WorkMeter::new(),
            rng: ctx.rng,
            last_at: 0,
            hw_key: String::new(),
            search: Search::new(self.params.search.clone(), ctx.dir.join("search"))?,
        };
        let (db, meters) = core.open_db(true)?;
        Ok(Opened {
            store: Box::new(RecordStore { db: Some(db), core }),
            meters,
        })
    }
}

impl Store for RecordStore {
    fn load(&mut self, ops: &[Operation]) -> Result<Meters, StoreError> {
        let mut total = Meters::new();
        for chunk in ops.chunks(256) {
            let db = self.db.as_mut().ok_or_else(kit::crashed)?;
            let mut spans = db.spans()?;
            let mut extra = Meters::new();
            let core = &mut self.core;
            let (last_at, hw_key) = (core.last_at, core.hw_key.clone());
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
                core.last_at = last_at;
                core.hw_key = hw_key;
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
        read_cur(&tx, key, true)?
            .map(|c| layout::assemble(&tx, key, &c.body, &c.lists))
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
