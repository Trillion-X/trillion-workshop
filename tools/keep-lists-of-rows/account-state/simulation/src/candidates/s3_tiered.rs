//! S3: S2 plus hot/cold tiering (plan 03 §2b, K16). Hot records stay in S2's
//! tables; a record not written for `cold_after_days` moves into a cold page
//! (one file per eviction, an R2 object on the provider) and leaves the hot
//! store. Every declared index entry and word row stays hot, so lists,
//! search and owner lookup still find cold records; a point read of a cold
//! record is one archive GET.
//!
//! Two eviction variants (params, one adapter):
//! - `delete`: one `cur` table with a `changed_ms` column. A write that finds
//!   the eviction step due (`every_seconds`) scans the next `scan_rows` hot
//!   rows from an in-memory cursor and evicts the cold ones: 1 row write per
//!   evicted record (+ 1 per member row) and one page PUT.
//! - `epoch`: current rows live in `cur_e<n>`, one table per
//!   `cold_after_days` of simulated time. Writes go to the newest epoch, reads
//!   probe the two hot epochs newest first. The first write of a new epoch
//!   seals every older epoch: live rows not shadowed by a newer copy go into a
//!   page, then the table is DROPPED (0 row writes; member rows of evicted
//!   records are still deleted one by one). A record goes cold after between
//!   one and two epochs without a write.
//!
//! Cold entries are sealed with the owner's key (a BLAKE3-derived subkey), so
//! owner erasure needs no page rewrite. Each page starts with its record ids
//! (not secret); the in-memory locator (id -> newest page) is rebuilt from
//! them on recovery, one GET per page. Deleting a record that has a cold copy
//! writes one `gone` row so the copy cannot come back. In-memory changes of a
//! transaction are staged and applied only when it commits.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use content_crypto::advanced::blake3;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};
use workload_simulation::{
    Candidate, Capability, DetRng, Meters, Opened, Operation, SimTime, StoreContext, StoreError,
};

use super::kit::capability;
use super::layout::{self, EraseLookup, IndexOf};
use super::log;
use super::receipts::Ring;
use super::s2_log_current::{Cur, Removal, S2};
use super::search::SearchParams;
use crate::meter::{err, schema_changed, ARCHIVE_BYTES, ARCHIVE_GETS, ARCHIVE_PUTS, SQLITE_METERS};

const DAY_MS: u64 = 86_400_000;
const COLUMNS: &str = "record_id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL,
                       version INTEGER NOT NULL, seq INTEGER NOT NULL, prev_seq INTEGER,
                       owner_key TEXT NOT NULL, lists TEXT, deleted INTEGER NOT NULL, receipts TEXT NOT NULL";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TierParams {
    pub cold_after_days: u32,
    pub eviction: Eviction,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Eviction {
    Delete { every_seconds: u64, scan_rows: u32 },
    Epoch,
}

pub fn classify(table: &str) -> Option<&'static str> {
    match table {
        "gone" => Some("record"),
        t if t.starts_with("cur_e") => Some("record"),
        _ => None,
    }
}

/// Where the current version lives. `Hot(i)`: the i-th hot table, newest
/// first (S2 has one). `Cold`: a cold page entry.
pub enum Loc {
    Hot(usize),
    Cold(Box<ColdRow>),
}

/// What a cold entry carries besides the value.
pub struct ColdRow {
    kind: String,
    owner: String,
    version: i64,
    seq: i64,
    lists: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    kind: String,
    owner: String,
    version: i64,
    seq: i64,
    lists: Vec<String>,
    body: Map<String, Value>,
    members: Vec<(String, Vec<Value>)>,
}

pub struct Tier {
    p: TierParams,
    dir: PathBuf,
    /// Record id -> newest page holding a copy.
    locator: BTreeMap<String, u64>,
    gone: BTreeSet<String>,
    next_page: u64,
    /// Hot epochs, oldest first (`epoch` variant).
    epochs: Vec<u64>,
    cursor: String,
    next_evict_ms: u64,
    staged: Staged,
}

#[derive(Default)]
struct Staged {
    locate: BTreeMap<String, u64>,
    gone: BTreeSet<String>,
    forget: BTreeSet<String>,
    epochs: Option<Vec<u64>>,
    pages: Vec<PathBuf>,
}

impl Tier {
    pub fn new(p: TierParams, dir: PathBuf) -> Self {
        Self {
            p,
            dir,
            locator: BTreeMap::new(),
            gone: BTreeSet::new(),
            next_page: 1,
            epochs: vec![0],
            cursor: String::new(),
            next_evict_ms: 0,
            staged: Staged::default(),
        }
    }

    fn epoch_ms(&self) -> u64 {
        u64::from(self.p.cold_after_days.max(1)) * DAY_MS
    }

    fn epochs(&self) -> &[u64] {
        self.staged.epochs.as_deref().unwrap_or(&self.epochs)
    }

    /// Hot tables, newest first.
    fn hot(&self) -> Vec<String> {
        match self.p.eviction {
            Eviction::Delete { .. } => vec!["cur".into()],
            Eviction::Epoch => self
                .epochs()
                .iter()
                .rev()
                .map(|e| format!("cur_e{e}"))
                .collect(),
        }
    }

    fn deleting(&self) -> bool {
        matches!(self.p.eviction, Eviction::Delete { .. })
    }

    pub fn create(&mut self, conn: &Connection) -> Result<(), StoreError> {
        let table = if self.deleting() {
            format!("CREATE TABLE cur({COLUMNS}, changed_ms INTEGER NOT NULL) WITHOUT ROWID;")
        } else {
            format!("CREATE TABLE cur_e0({COLUMNS}) WITHOUT ROWID;")
        };
        conn.execute_batch(&format!(
            "{table}\nCREATE TABLE gone(record_id TEXT PRIMARY KEY, receipts TEXT NOT NULL) WITHOUT ROWID;"
        ))
        .map_err(err)
    }

    /// Rebuild the volatile state: hot epochs, gone ids, the page locator.
    pub fn recover(&mut self, conn: &Connection, meters: &mut Meters) -> Result<(), StoreError> {
        self.staged = Staged::default();
        self.cursor.clear();
        self.next_evict_ms = 0;
        if !self.deleting() {
            let mut stmt = conn
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cur_e%'",
                )
                .map_err(err)?;
            let names = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(err)?;
            let mut epochs: Vec<u64> = names
                .iter()
                .filter_map(|n| n.strip_prefix("cur_e")?.parse().ok())
                .collect();
            epochs.sort_unstable();
            self.epochs = epochs;
        }
        let mut stmt = conn.prepare("SELECT record_id FROM gone").map_err(err)?;
        self.gone = stmt
            .query_map([], |r| r.get(0))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        self.locator.clear();
        self.next_page = 1;
        for (page, path) in self.pages() {
            let bytes = std::fs::read(&path).map_err(err)?;
            meters.add(ARCHIVE_GETS, 1);
            let first = bytes.split(|b| *b == b'\n').next().unwrap_or_default();
            let ids: Vec<String> = serde_json::from_slice(first).map_err(err)?;
            for id in ids {
                self.locator.insert(id, page);
            }
            self.next_page = page + 1;
        }
        Ok(())
    }

    /// Page files, oldest first.
    fn pages(&self) -> Vec<(u64, PathBuf)> {
        let mut out: Vec<(u64, PathBuf)> = std::fs::read_dir(&self.dir)
            .map(|d| {
                d.filter_map(|e| {
                    let path = e.ok()?.path();
                    let n = path
                        .file_name()?
                        .to_str()?
                        .strip_prefix("cold-")?
                        .strip_suffix(".page")?
                        .parse()
                        .ok()?;
                    Some((n, path))
                })
                .collect()
            })
            .unwrap_or_default();
        out.sort();
        out
    }

    fn page_path(&self, page: u64) -> PathBuf {
        self.dir.join(format!("cold-{page:08}.page"))
    }

    fn locate(&self, key: &str) -> Option<u64> {
        if self.staged.gone.contains(key)
            || self.staged.forget.contains(key)
            || self.gone.contains(key)
        {
            return None;
        }
        self.staged
            .locate
            .get(key)
            .or_else(|| self.locator.get(key))
            .copied()
    }

    /// The current row: hot tables newest first, then the cold page. With
    /// `for_write`, a cold record's member rows are written back to `mem`.
    pub fn get(
        &self,
        tx: &Connection,
        key: &str,
        for_write: bool,
        meters: &mut Meters,
    ) -> Result<Option<(Cur, Loc)>, StoreError> {
        for (i, t) in self.hot().iter().enumerate() {
            let row = tx
                .prepare_cached(&format!(
                    "SELECT kind, body, lists, seq, owner_key, deleted, receipts FROM {t} WHERE record_id = ?1"
                ))
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
                .map_err(err)?;
            if let Some((kind, body, lists, seq, owner, deleted, ring)) = row {
                if deleted {
                    // A tombstone is the newest state: older copies are dead.
                    return Ok(None);
                }
                let cur = Cur {
                    kind,
                    body: serde_json::from_str(&body).map_err(err)?,
                    lists: layout::parse_lists(lists)?,
                    seq,
                    owner,
                    members: None,
                    ring: Ring::parse(Some(&ring))?,
                };
                return Ok(Some((cur, Loc::Hot(i))));
            }
        }
        let Some(page) = self.locate(key) else {
            return Ok(None);
        };
        let Some(e) = self.read_entry(tx, page, key, meters)? else {
            return Ok(None);
        };
        let row = ColdRow {
            kind: e.kind.clone(),
            owner: e.owner.clone(),
            version: e.version,
            seq: e.seq,
            lists: if e.lists.is_empty() {
                None
            } else {
                Some(serde_json::to_string(&e.lists).map_err(err)?)
            },
        };
        let members = if for_write {
            let mut stmt = tx
                .prepare_cached("INSERT INTO mem(record_id, list_id, member_key, body, seq) VALUES(?1, ?2, ?3, ?4, ?5)")
                .map_err(err)?;
            for (list, items) in &e.members {
                for (i, m) in items.iter().enumerate() {
                    stmt.execute(params![
                        key,
                        list,
                        i as i64,
                        serde_json::to_string(m).map_err(err)?,
                        e.seq
                    ])
                    .map_err(err)?;
                }
            }
            None
        } else {
            Some(e.members)
        };
        let cur = Cur {
            kind: e.kind,
            body: e.body,
            lists: e.lists,
            seq: e.seq,
            owner: e.owner,
            members,
            // Cold after `cold_after_days`, longer than the receipt window: every
            // receipt it held has expired.
            ring: Ring::default(),
        };
        Ok(Some((cur, Loc::Cold(Box::new(row)))))
    }

    /// One cold entry; none when its owner's key was destroyed.
    fn read_entry(
        &self,
        tx: &Connection,
        page: u64,
        key: &str,
        meters: &mut Meters,
    ) -> Result<Option<Entry>, StoreError> {
        let bytes = std::fs::read(self.page_path(page)).map_err(err)?;
        meters.add(ARCHIVE_GETS, 1);
        let mut lines = bytes.split(|b| *b == b'\n');
        let ids: Vec<String> =
            serde_json::from_slice(lines.next().unwrap_or_default()).map_err(err)?;
        let i = ids
            .iter()
            .position(|id| id == key)
            .ok_or_else(|| StoreError(format!("cold page {page} lacks {key}")))?;
        let line = lines
            .nth(i)
            .ok_or_else(|| StoreError(format!("cold page {page} is short")))?;
        let (key_id, sealed): (i64, String) = serde_json::from_slice(line).map_err(err)?;
        let Some(k) = log::key_by_id(tx, key_id)? else {
            return Ok(None);
        };
        let sealed = unhex(&sealed)?;
        let plain = log::open(&subkey(&k), &nonce(page, i), &sealed)?;
        serde_json::from_slice(&plain).map(Some).map_err(err)
    }

    /// The receipt ring of the row a retry addresses: the newest hot row
    /// (live or tombstone), else the `gone` row of a deleted cold record.
    /// A live cold record's receipts have all expired (no ring).
    pub fn ring(&self, conn: &Connection, key: &str) -> Result<Option<Ring>, StoreError> {
        for t in self.hot() {
            let ring: Option<String> = conn
                .prepare_cached(&format!("SELECT receipts FROM {t} WHERE record_id = ?1"))
                .map_err(err)?
                .query_row([key], |r| r.get(0))
                .optional()
                .map_err(err)?;
            if let Some(r) = ring {
                return Ring::parse(Some(&r)).map(Some);
            }
        }
        let gone: Option<String> = conn
            .prepare_cached("SELECT receipts FROM gone WHERE record_id = ?1")
            .map_err(err)?
            .query_row([key], |r| r.get(0))
            .optional()
            .map_err(err)?;
        gone.map(|r| Ring::parse(Some(&r))).transpose()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn insert(
        &self,
        tx: &Transaction,
        op: &Operation,
        key: &str,
        kind: &str,
        body: &str,
        owner: &str,
        lists: Option<&str>,
        ring: &str,
    ) -> Result<(), StoreError> {
        let t = &self.hot()[0];
        let (changed, slot) = if self.deleting() {
            (", changed_ms", ", ?8")
        } else {
            ("", "")
        };
        let mut stmt = tx
            .prepare_cached(&format!(
                "INSERT INTO {t}(record_id, kind, body, version, seq, prev_seq, owner_key, lists, deleted, receipts{changed})
                 VALUES(?1, ?2, ?3, 1, ?4, NULL, ?5, ?6, 0, ?7{slot})"
            ))
            .map_err(err)?;
        let seq = op.sequence as i64;
        if self.deleting() {
            stmt.execute(params![
                key,
                kind,
                body,
                seq,
                owner,
                lists,
                ring,
                op.at.0 as i64
            ])
        } else {
            stmt.execute(params![key, kind, body, seq, owner, lists, ring])
        }
        .map_err(err)?;
        Ok(())
    }

    /// New current version: in place when it is in the newest hot table,
    /// otherwise one insert into it (the older copy is shadowed).
    pub fn rewrite(
        &self,
        tx: &Transaction,
        op: &Operation,
        key: &str,
        loc: &Loc,
        body: &str,
        ring: &str,
    ) -> Result<(), StoreError> {
        let hot = self.hot();
        let t = &hot[0];
        let seq = op.sequence as i64;
        let now = op.at.0 as i64;
        let deleting = self.deleting();
        let (changed, slot) = if deleting {
            (", changed_ms", ", ?6")
        } else {
            ("", "")
        };
        match loc {
            Loc::Hot(0) => {
                let set = if deleting { ", changed_ms = ?5" } else { "" };
                let mut stmt = tx
                    .prepare_cached(&format!(
                        "UPDATE {t} SET body = ?2, version = version + 1, prev_seq = seq, seq = ?3, receipts = ?4{set} WHERE record_id = ?1"
                    ))
                    .map_err(err)?;
                if deleting {
                    stmt.execute(params![key, body, seq, ring, now])
                } else {
                    stmt.execute(params![key, body, seq, ring])
                }
                .map_err(err)?;
            }
            Loc::Hot(i) => {
                tx.prepare_cached(&format!(
                    "INSERT INTO {t}(record_id, kind, body, version, seq, prev_seq, owner_key, lists, deleted, receipts)
                     SELECT record_id, kind, ?2, version + 1, ?3, seq, owner_key, lists, 0, ?4 FROM {old} WHERE record_id = ?1",
                    old = hot[*i]
                ))
                .map_err(err)?
                .execute(params![key, body, seq, ring])
                .map_err(err)?;
            }
            Loc::Cold(c) => {
                let mut stmt = tx
                    .prepare_cached(&format!(
                        "INSERT INTO {t}(record_id, kind, body, version, seq, prev_seq, owner_key, lists, deleted, receipts{changed})
                         VALUES(?1, ?2, ?3, ?4, ?5, ?7, ?8, ?9, 0, ?10{slot})"
                    ))
                    .map_err(err)?;
                let (v, prev) = (c.version + 1, c.seq);
                if deleting {
                    stmt.execute(params![
                        key, c.kind, body, v, seq, now, prev, c.owner, c.lists, ring
                    ])
                } else {
                    stmt.execute(params![
                        key,
                        c.kind,
                        body,
                        v,
                        seq,
                        None::<i64>,
                        prev,
                        c.owner,
                        c.lists,
                        ring
                    ])
                }
                .map_err(err)?;
            }
        }
        Ok(())
    }

    /// Remove a record. A delete turns its newest hot row into a tombstone
    /// in place (removing older hot copies), or, when a cold copy exists,
    /// writes the `gone` row that blocks the copy and keeps the ring. Owner
    /// erasure removes every hot copy and forgets the cold copy (sealed
    /// under the destroyed key).
    pub fn remove(
        &mut self,
        tx: &Transaction,
        key: &str,
        loc: &Loc,
        how: &Removal<'_>,
        now: u64,
    ) -> Result<(), StoreError> {
        let hot = self.hot();
        let from = match loc {
            Loc::Hot(i) => *i,
            Loc::Cold(_) => hot.len(),
        };
        let cold = self.locate(key).is_some();
        let keep = match how {
            Removal::Tombstone { .. } if !cold && from < hot.len() => Some(from),
            _ => None,
        };
        for (i, t) in hot.iter().enumerate().skip(from) {
            if Some(i) == keep {
                continue;
            }
            tx.prepare_cached(&format!("DELETE FROM {t} WHERE record_id = ?1"))
                .map_err(err)?
                .execute([key])
                .map_err(err)?;
        }
        match how {
            Removal::Erase => {
                if cold {
                    self.staged.forget.insert(key.to_owned());
                }
            }
            Removal::Tombstone { seq, ring } => {
                if let Some(i) = keep {
                    let set = if self.deleting() {
                        ", changed_ms = ?4"
                    } else {
                        ""
                    };
                    let mut stmt = tx
                        .prepare_cached(&format!(
                            "UPDATE {t} SET body = '{{}}', lists = NULL, owner_key = '', deleted = 1,
                             version = version + 1, prev_seq = seq, seq = ?2, receipts = ?3{set} WHERE record_id = ?1",
                            t = hot[i]
                        ))
                        .map_err(err)?;
                    if self.deleting() {
                        stmt.execute(params![key, seq, ring.text()?, now as i64])
                    } else {
                        stmt.execute(params![key, seq, ring.text()?])
                    }
                    .map_err(err)?;
                } else {
                    tx.prepare_cached("INSERT INTO gone(record_id, receipts) VALUES(?1, ?2)")
                        .map_err(err)?
                        .execute(params![key, ring.text()?])
                        .map_err(err)?;
                    self.staged.gone.insert(key.to_owned());
                }
            }
        }
        Ok(())
    }

    /// The bounded eviction step, inside a write that already happens.
    pub fn step(
        &mut self,
        tx: &Transaction,
        now: SimTime,
        rng: &mut DetRng,
        meters: &mut Meters,
    ) -> Result<(), StoreError> {
        match self.p.eviction.clone() {
            Eviction::Delete {
                every_seconds,
                scan_rows,
            } => self.evict_scan(tx, now, every_seconds, scan_rows, rng, meters),
            Eviction::Epoch => self.roll_epoch(tx, now, rng, meters),
        }
    }

    fn evict_scan(
        &mut self,
        tx: &Transaction,
        now: SimTime,
        every_seconds: u64,
        scan_rows: u32,
        rng: &mut DetRng,
        meters: &mut Meters,
    ) -> Result<(), StoreError> {
        let cold_ms = u64::from(self.p.cold_after_days) * DAY_MS;
        if now.0 < self.next_evict_ms || now.0 < cold_ms {
            return Ok(());
        }
        self.next_evict_ms = now.0 + every_seconds * 1000;
        let cutoff = (now.0 - cold_ms) as i64;
        let rows = {
            let mut stmt = tx
                .prepare_cached(
                    "SELECT record_id, kind, body, version, seq, owner_key, lists, changed_ms, deleted FROM cur
                     WHERE record_id > ?1 ORDER BY record_id LIMIT ?2",
                )
                .map_err(err)?;
            let rows = stmt
                .query_map(params![self.cursor, scan_rows], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, Option<String>>(6)?,
                        r.get::<_, i64>(7)?,
                        r.get::<_, bool>(8)?,
                    ))
                })
                .map_err(err)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(err)?
        };
        self.cursor = if rows.len() < scan_rows as usize {
            String::new()
        } else {
            rows.last().map(|r| r.0.clone()).unwrap_or_default()
        };
        let mut entries = Vec::new();
        for (id, kind, body, version, seq, owner, lists, changed, deleted) in rows {
            if changed >= cutoff {
                continue;
            }
            if deleted {
                // Its receipts expired (window < cold_after_days): nothing to keep.
                tx.prepare_cached("DELETE FROM cur WHERE record_id = ?1")
                    .map_err(err)?
                    .execute([&id])
                    .map_err(err)?;
                continue;
            }
            let lists = layout::parse_lists(lists)?;
            let members = if lists.is_empty() {
                Vec::new()
            } else {
                let m = layout::members(tx, &id)?;
                tx.execute("DELETE FROM mem WHERE record_id = ?1", [&id])
                    .map_err(err)?;
                m
            };
            tx.prepare_cached("DELETE FROM cur WHERE record_id = ?1")
                .map_err(err)?
                .execute([&id])
                .map_err(err)?;
            entries.push((
                id,
                Entry {
                    kind,
                    owner,
                    version,
                    seq,
                    lists,
                    body: serde_json::from_str(&body).map_err(err)?,
                    members,
                },
            ));
        }
        self.write_page(tx, entries, rng, meters)
    }

    fn roll_epoch(
        &mut self,
        tx: &Transaction,
        now: SimTime,
        rng: &mut DetRng,
        meters: &mut Meters,
    ) -> Result<(), StoreError> {
        let e_now = now.0 / self.epoch_ms();
        let mut epochs = self.epochs().to_vec();
        if epochs.last().is_some_and(|e| *e >= e_now) {
            return Ok(());
        }
        tx.execute_batch(&format!(
            "CREATE TABLE cur_e{e_now}({COLUMNS}) WITHOUT ROWID;"
        ))
        .map_err(err)?;
        schema_changed(tx);
        epochs.push(e_now);
        while epochs.len() > 2 {
            let e = epochs.remove(0);
            let rows = {
                let mut stmt = tx
                    .prepare(&format!(
                        "SELECT record_id, kind, body, version, seq, owner_key, lists FROM cur_e{e} WHERE deleted = 0 ORDER BY record_id"
                    ))
                    .map_err(err)?;
                let rows = stmt
                    .query_map([], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, i64>(3)?,
                            r.get::<_, i64>(4)?,
                            r.get::<_, String>(5)?,
                            r.get::<_, Option<String>>(6)?,
                        ))
                    })
                    .map_err(err)?;
                rows.collect::<Result<Vec<_>, _>>().map_err(err)?
            };
            let mut entries = Vec::new();
            for (id, kind, body, version, seq, owner, lists) in rows {
                let mut shadowed = false;
                for newer in &epochs {
                    shadowed |= tx
                        .prepare_cached(&format!("SELECT 1 FROM cur_e{newer} WHERE record_id = ?1"))
                        .map_err(err)?
                        .query_row([&id], |_| Ok(()))
                        .optional()
                        .map_err(err)?
                        .is_some();
                }
                if shadowed {
                    continue;
                }
                let lists = layout::parse_lists(lists)?;
                let members = if lists.is_empty() {
                    Vec::new()
                } else {
                    let m = layout::members(tx, &id)?;
                    tx.execute("DELETE FROM mem WHERE record_id = ?1", [&id])
                        .map_err(err)?;
                    m
                };
                entries.push((
                    id,
                    Entry {
                        kind,
                        owner,
                        version,
                        seq,
                        lists,
                        body: serde_json::from_str(&body).map_err(err)?,
                        members,
                    },
                ));
            }
            self.write_page(tx, entries, rng, meters)?;
            tx.execute_batch(&format!("DROP TABLE cur_e{e};"))
                .map_err(err)?;
            schema_changed(tx);
        }
        self.staged.epochs = Some(epochs);
        Ok(())
    }

    /// Seal entries into one page file (an R2 PUT), staged until commit.
    fn write_page(
        &mut self,
        tx: &Transaction,
        entries: Vec<(String, Entry)>,
        rng: &mut DetRng,
        meters: &mut Meters,
    ) -> Result<(), StoreError> {
        if entries.is_empty() {
            return Ok(());
        }
        let page = self.next_page;
        self.next_page += 1;
        let ids: Vec<&String> = entries.iter().map(|(id, _)| id).collect();
        let mut bytes = serde_json::to_vec(&ids).map_err(err)?;
        for (i, (_, e)) in entries.iter().enumerate() {
            let (key_id, k) = log::owner_key(tx, rng, &e.owner)?;
            let plain = serde_json::to_vec(e).map_err(err)?;
            let sealed = log::seal(&subkey(&k), &nonce(page, i), &plain)?;
            bytes.push(b'\n');
            bytes.extend(serde_json::to_vec(&json!([key_id, hex(&sealed)])).map_err(err)?);
        }
        std::fs::create_dir_all(&self.dir).map_err(err)?;
        let path = self.page_path(page);
        std::fs::write(&path, &bytes).map_err(err)?;
        meters.add(ARCHIVE_PUTS, 1);
        meters.add(ARCHIVE_BYTES, bytes.len() as u64);
        for (id, _) in entries {
            self.staged.locate.insert(id, page);
        }
        self.staged.pages.push(path);
        Ok(())
    }

    /// The transaction committed: its staged changes become state.
    pub fn commit(&mut self) {
        let s = std::mem::take(&mut self.staged);
        for (id, page) in s.locate {
            self.locator.insert(id, page);
        }
        for id in s.forget {
            self.locator.remove(&id);
        }
        self.gone.extend(s.gone);
        if let Some(e) = s.epochs {
            self.epochs = e;
        }
    }

    /// The transaction rolled back: forget its staging and its page files.
    pub fn rollback(&mut self) {
        let s = std::mem::take(&mut self.staged);
        for p in s.pages {
            // A page left behind by a failed delete only shadows hot rows.
            let _ = std::fs::remove_file(p);
        }
        self.next_page = self.pages().last().map_or(1, |(n, _)| n + 1);
    }

    pub fn crash(&mut self) {
        self.staged = Staged::default();
    }

    pub fn files(&self) -> Vec<PathBuf> {
        self.pages().into_iter().map(|(_, p)| p).collect()
    }
}

fn subkey(owner_key: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 32];
    k.copy_from_slice(&owner_key[..32.min(owner_key.len())]);
    *blake3::keyed_hash(&k, b"storage-sim cold page").as_bytes()
}

fn nonce(page: u64, i: usize) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[..8].copy_from_slice(&page.to_le_bytes());
    n[8..].copy_from_slice(&(i as u32).to_le_bytes());
    n
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Result<Vec<u8>, StoreError> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2).unwrap_or("zz"), 16).map_err(err))
        .collect()
}

/// S3 = the S2 adapter with a cold tier.
pub struct S3 {
    inner: S2,
}

impl S3 {
    pub fn new(id: String, params: Value) -> Result<Self, StoreError> {
        let inner = S2::checked(id, params)?;
        let p = inner.params_of();
        if p.tier.is_none() {
            return Err(StoreError("S3 needs a tier block".into()));
        }
        // Cold records are reachable only through hot declared entries.
        if layout::declared(&p.indexes, &IndexOf::KindNewest).is_none()
            || p.erase_lookup != EraseLookup::OwnerIndex
            || p.search == SearchParams::Scan
        {
            return Err(StoreError(
                "S3 needs declared kind_newest + owner indexes and a declared search: scans cannot see cold records".into(),
            ));
        }
        let cold_ms = p
            .tier
            .as_ref()
            .map_or(0, |t| u64::from(t.cold_after_days) * DAY_MS);
        if p.receipts.window_ms >= cold_ms {
            return Err(StoreError(
                "the receipt window must be shorter than cold_after_days (cold rows keep no receipts)".into(),
            ));
        }
        Ok(Self { inner })
    }
}

impl Candidate for S3 {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn about(&self) -> String {
        "S3: S2 plus a cold tier (sealed cold pages, hot index and word rows, delete or epoch eviction inside writes)".into()
    }
    fn meters(&self) -> Vec<&'static str> {
        SQLITE_METERS.to_vec()
    }
    fn capabilities(&self) -> Vec<Capability> {
        let mut c = self.inner.capabilities_of();
        c.push(capability(
            "cold_tier",
            true,
            "records idle for cold_after_days move to sealed cold pages; one archive GET per cold read",
        ));
        c
    }
    fn params(&self) -> Value {
        self.inner.params()
    }
    fn open(&self, ctx: StoreContext) -> Result<Opened, StoreError> {
        self.inner.open_store(ctx)
    }
}
