//! Declared search, one port for every candidate. The layout is DATA
//! (`candidates/<id>.json` `search.layout`), never a code fork:
//!
//! - `scan`: no index; the candidate scans its current rows.
//! - `word_rows`: one row per distinct (field, word, record) in a WITHOUT
//!   ROWID table, written inside the save (N rows per create, the words that
//!   left or arrived per edit).
//! - `term_row`: one packed row per record holding its distinct terms,
//!   replaced when its terms change (1 row instead of N); a search scans the
//!   term rows.
//! - `inverted`: postings for the changes not yet persisted live in memory
//!   (the tail, 0 rows per save); with `persist`, the tail is written as one
//!   packed segment (a header row + parts of about `part_bytes`) inside the
//!   write that fills it (`flush_records`) or finds it older than
//!   `flush_seconds`, and the newest `fan_in` segments of one level merge
//!   into one segment of the next level inside that same write. No alarm.
//!   `place: rows` keeps parts as rows; `place: archive` keeps each segment's
//!   parts as one object (PUT per segment, ranged GET per part read).
//!   Without `persist` the index is memory only and is rebuilt from the
//!   records on every cold start.
//!
//! Exactness. The tail always holds the newest version of every record
//! changed after the newest persisted segment (`hi`), with its own stamp, so
//! a search sees every current version. A posting from a segment is
//! accepted only when the record's current stamp equals the posting's stamp
//! (one current-row read): stale and deleted postings never reach a result.
//! A cold start rebuilds the tail from the candidate's records whose current
//! stamp is above `hi`. Searches read the tail (memory), one part per
//! segment until `limit` results are confirmed, and one current row per
//! confirmed result.
//!
//! Why not FTS5: any FTS5 insert or query leaves trillion-local's
//! `sqlite_work` observation `Incomplete`, so its work cannot be measured by
//! the canonical meter (README "Findings").

use rusqlite::{params, Connection, OptionalExtension};
use content_crypto::advanced::blake3;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::PathBuf,
    rc::Rc,
};
use workload_simulation::{Meters, StoreError};

use crate::meter::{
    err, ReadCause, Spans, ARCHIVE_BYTES, ARCHIVE_GETS, ARCHIVE_PUTS, SEARCH_LAG_MS,
    SEARCH_TAIL_ENTRIES,
};

const WORDS: &str = "words";
const TERMS: &str = "terms";
const SEGS: &str = "sx_seg";
const PARTS: &str = "sx_part";

/// Write cause of a table this module owns.
pub fn is_search_table(table: &str) -> bool {
    matches!(table, WORDS | TERMS | SEGS | PARTS)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "layout", rename_all = "snake_case", deny_unknown_fields)]
pub enum SearchParams {
    Scan,
    WordRows {
        fields: Vec<String>,
    },
    TermRow {
        fields: Vec<String>,
    },
    Inverted {
        fields: Vec<String>,
        persist: Option<Persist>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Persist {
    /// Records in the tail that make the next write persist it.
    pub flush_records: u32,
    /// Age of the oldest tail change that makes the next write persist it.
    pub flush_seconds: u64,
    /// Target encoded bytes of one part.
    pub part_bytes: usize,
    /// Segments of one level merged into one of the next level.
    pub fan_in: usize,
    pub place: Place,
    /// Decoded parts kept in memory between searches (0 = none).
    pub cache_bytes: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Place {
    Rows,
    Archive,
}

/// The current version of one record as the candidate stores it.
pub struct Current {
    pub stamp: i64,
    pub kind: String,
    pub value: Value,
}

/// (field, word).
type Term = (String, String);

/// Distinct (field, word) pairs of the declared fields of `value`.
pub fn tokens(fields: &[String], value: &Value) -> BTreeSet<Term> {
    fields
        .iter()
        .flat_map(|f| {
            value
                .get(f)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .split(' ')
                .filter(|w| !w.is_empty())
                .map(move |w| (f.clone(), w.to_owned()))
        })
        .collect()
}

/// One posting: a record version holding the term.
#[derive(Clone, Debug, Deserialize, Serialize)]
struct Post {
    s: i64,
    k: String,
    c: String,
}

/// Terms of one part, sorted; postings newest stamp first.
type Part = Vec<(Term, Vec<Post>)>;

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PartRef {
    first: Term,
    offset: usize,
    len: usize,
}

/// One persisted segment: every change with stamp in (lo, hi].
#[derive(Clone, Debug, Deserialize, Serialize)]
struct Seg {
    id: i64,
    level: u32,
    lo: i64,
    hi: i64,
    /// Archive object holding the parts (`place: archive`).
    object: Option<String>,
    parts: Vec<PartRef>,
    /// Every record changed inside the segment and its newest stamp there.
    covers: BTreeMap<String, i64>,
}

impl Seg {
    /// Index of the part that would hold `term`.
    fn part_of(&self, term: &Term) -> Option<usize> {
        let n = self.parts.partition_point(|p| &p.first <= term);
        n.checked_sub(1)
    }
}

#[derive(Clone, Debug)]
struct TailEntry {
    stamp: i64,
    kind: String,
    /// None: the record was deleted.
    terms: Option<BTreeSet<Term>>,
}

/// Undo of one in-memory change, applied newest first on rollback.
enum Undo {
    Tail(String, Option<TailEntry>),
    Since(Option<u64>),
    Segs(Vec<Seg>, i64),
}

/// Decoded parts by (segment, part), least recently used evicted first.
#[derive(Default)]
struct Cache {
    budget: usize,
    bytes: usize,
    tick: u64,
    parts: HashMap<(i64, usize), (Rc<Part>, usize, u64)>,
    order: BTreeMap<u64, (i64, usize)>,
}

impl Cache {
    fn get(&mut self, k: (i64, usize)) -> Option<Rc<Part>> {
        let (part, _, t) = self.parts.get_mut(&k)?;
        self.order.remove(t);
        self.tick += 1;
        *t = self.tick;
        self.order.insert(self.tick, k);
        Some(part.clone())
    }
    fn put(&mut self, k: (i64, usize), part: Rc<Part>, bytes: usize) {
        if self.budget == 0 || bytes > self.budget {
            return;
        }
        self.drop_part(k);
        while self.bytes + bytes > self.budget {
            let Some((_, old)) = self.order.pop_first() else {
                break;
            };
            if let Some((_, b, _)) = self.parts.remove(&old) {
                self.bytes -= b;
            }
        }
        self.tick += 1;
        self.parts.insert(k, (part, bytes, self.tick));
        self.order.insert(self.tick, k);
        self.bytes += bytes;
    }
    fn drop_part(&mut self, k: (i64, usize)) {
        if let Some((_, b, t)) = self.parts.remove(&k) {
            self.order.remove(&t);
            self.bytes -= b;
        }
    }
    fn drop_seg(&mut self, seg: i64) {
        let keys: Vec<_> = self.parts.keys().filter(|k| k.0 == seg).copied().collect();
        for k in keys {
            self.drop_part(k);
        }
    }
    fn clear(&mut self) {
        self.parts.clear();
        self.order.clear();
        self.bytes = 0;
    }
}

/// The in-memory side of the `inverted` layout.
#[derive(Default)]
struct Inverted {
    tail: BTreeMap<String, TailEntry>,
    /// Commit time of the oldest tail change (ms).
    since: Option<u64>,
    /// Persisted segments, oldest first (disjoint stamp ranges).
    segs: Vec<Seg>,
    next_seg: i64,
    undo: Vec<Undo>,
    /// Archive objects written by the open transaction / to delete on commit.
    written: Vec<PathBuf>,
    retired: Vec<PathBuf>,
    cache: Cache,
}

pub struct Search {
    p: SearchParams,
    dir: PathBuf,
    inv: Inverted,
}

/// A search that asks the candidate for a record's current (stamp, kind).
pub type CurrentOf<'a> = dyn FnMut(&str) -> Result<Option<(i64, String)>, StoreError> + 'a;

impl Search {
    /// `dir` holds archive objects (`place: archive`).
    pub fn new(p: SearchParams, dir: PathBuf) -> Result<Self, StoreError> {
        match &p {
            SearchParams::Scan => {}
            SearchParams::WordRows { fields }
            | SearchParams::TermRow { fields }
            | SearchParams::Inverted { fields, .. } => {
                if fields.is_empty() {
                    return Err(StoreError("declared search needs fields".into()));
                }
            }
        }
        if let SearchParams::Inverted {
            persist: Some(s), ..
        } = &p
        {
            if s.flush_records == 0 || s.part_bytes == 0 || s.fan_in < 2 {
                return Err(StoreError(
                    "persist needs flush_records >= 1, part_bytes >= 1, fan_in >= 2".into(),
                ));
            }
        }
        let mut inv = Inverted::default();
        inv.cache.budget = persist(&p).map_or(0, |s| s.cache_bytes);
        inv.next_seg = 1;
        Ok(Self { p, dir, inv })
    }

    pub fn params(&self) -> &SearchParams {
        &self.p
    }

    /// True when the candidate must answer searches by scanning its rows.
    pub fn scans(&self) -> bool {
        self.p == SearchParams::Scan
    }

    fn fields(&self) -> &[String] {
        match &self.p {
            SearchParams::Scan => &[],
            SearchParams::WordRows { fields }
            | SearchParams::TermRow { fields }
            | SearchParams::Inverted { fields, .. } => fields,
        }
    }

    /// Capability note for the candidate's capability list.
    pub fn note(&self) -> &'static str {
        match &self.p {
            SearchParams::Scan => "scan of current rows",
            SearchParams::WordRows { .. } => "declared word rows (one row per word)",
            SearchParams::TermRow { .. } => "one packed term row per record; search scans term rows",
            SearchParams::Inverted { persist: None, .. } => {
                "in-memory inverted index rebuilt from the records on cold start; 0 rows per save"
            }
            SearchParams::Inverted {
                persist: Some(p), ..
            } => match p.place {
                Place::Rows => "in-memory tail + packed segments as rows, flushed and merged inside writes",
                Place::Archive => "in-memory tail + packed segments as archive objects, flushed and merged inside writes",
            },
        }
    }

    pub fn create(&mut self, conn: &Connection) -> Result<(), StoreError> {
        let ddl = match &self.p {
            SearchParams::Scan => return Ok(()),
            SearchParams::WordRows { .. } => {
                "CREATE TABLE words(field TEXT NOT NULL, word TEXT NOT NULL, record_id TEXT NOT NULL,
                   PRIMARY KEY(field, word, record_id)) WITHOUT ROWID;"
            }
            SearchParams::TermRow { .. } => {
                "CREATE TABLE terms(record_id TEXT PRIMARY KEY, body TEXT NOT NULL) WITHOUT ROWID;"
            }
            SearchParams::Inverted { persist: None, .. } => "",
            SearchParams::Inverted {
                persist: Some(_), ..
            } => {
                "CREATE TABLE sx_seg(seg INTEGER PRIMARY KEY, meta TEXT NOT NULL);
                 CREATE TABLE sx_part(seg INTEGER NOT NULL, n INTEGER NOT NULL, body BLOB NOT NULL,
                   PRIMARY KEY(seg, n)) WITHOUT ROWID;"
            }
        };
        conn.execute_batch(ddl).map_err(err)?;
        self.inv = Inverted {
            next_seg: 1,
            cache: Cache {
                budget: self.inv.cache.budget,
                ..Cache::default()
            },
            ..Inverted::default()
        };
        Ok(())
    }

    /// Reload the persisted segments after a reopen. Returns the stamp above
    /// which the candidate must hand its current records to [`Self::fill`]
    /// (None: this layout keeps no volatile state).
    pub fn reopen(&mut self, conn: &Connection) -> Result<Option<i64>, StoreError> {
        let SearchParams::Inverted { persist, .. } = &self.p else {
            return Ok(None);
        };
        self.inv.tail.clear();
        self.inv.since = None;
        self.inv.undo.clear();
        self.inv.written.clear();
        self.inv.retired.clear();
        self.inv.cache.clear();
        self.inv.segs.clear();
        self.inv.next_seg = 1;
        if persist.is_some() {
            let mut stmt = conn
                .prepare("SELECT meta FROM sx_seg ORDER BY seg")
                .map_err(err)?;
            let metas = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(err)?;
            for m in metas {
                let seg: Seg = serde_json::from_str(&m).map_err(err)?;
                self.inv.next_seg = self.inv.next_seg.max(seg.id + 1);
                self.inv.segs.push(seg);
            }
            // Objects a write wrote before the process died, never committed.
            self.delete_unreferenced(self.files());
        }
        Ok(Some(self.watermark()))
    }

    /// The candidate's current records changed after [`Self::reopen`]'s
    /// stamp. Their commit times are not kept, so the tail's age restarts at
    /// the next change (`since`).
    pub fn fill(&mut self, records: Vec<(String, Current)>) {
        let fields = self.fields().to_vec();
        for (key, c) in records {
            self.inv.tail.insert(
                key,
                TailEntry {
                    stamp: c.stamp,
                    kind: c.kind,
                    terms: Some(tokens(&fields, &c.value)),
                },
            );
        }
    }

    fn watermark(&self) -> i64 {
        self.inv.segs.last().map_or(i64::MIN, |s| s.hi)
    }

    /// One version change of `key`: `before` None = create, `after` None =
    /// delete. Every version change calls this (the inverted layout needs
    /// the new stamp even when the searched text did not change).
    #[allow(clippy::too_many_arguments)]
    pub fn changed(
        &mut self,
        conn: &Connection,
        key: &str,
        stamp: i64,
        kind: &str,
        before: Option<&Value>,
        after: Option<&Value>,
        now_ms: u64,
        meters: &mut Meters,
    ) -> Result<(), StoreError> {
        let fields = self.fields().to_vec();
        let old = before.map(|v| tokens(&fields, v)).unwrap_or_default();
        let new = after.map(|v| tokens(&fields, v)).unwrap_or_default();
        match &self.p {
            SearchParams::Scan => Ok(()),
            SearchParams::WordRows { .. } => {
                let mut del = conn
                    .prepare_cached(
                        "DELETE FROM words WHERE field = ?1 AND word = ?2 AND record_id = ?3",
                    )
                    .map_err(err)?;
                for (f, w) in old.difference(&new) {
                    del.execute(params![f, w, key]).map_err(err)?;
                }
                let mut ins = conn
                    .prepare_cached("INSERT INTO words(field, word, record_id) VALUES(?1, ?2, ?3)")
                    .map_err(err)?;
                for (f, w) in new.difference(&old) {
                    ins.execute(params![f, w, key]).map_err(err)?;
                }
                Ok(())
            }
            SearchParams::TermRow { .. } => {
                match (before, after) {
                    (_, None) => {
                        conn.prepare_cached("DELETE FROM terms WHERE record_id = ?1")
                            .map_err(err)?
                            .execute([key])
                            .map_err(err)?;
                    }
                    (None, Some(_)) => {
                        conn.prepare_cached("INSERT INTO terms(record_id, body) VALUES(?1, ?2)")
                            .map_err(err)?
                            .execute(params![key, serde_json::to_string(&new).map_err(err)?])
                            .map_err(err)?;
                    }
                    (Some(_), Some(_)) if old != new => {
                        conn.prepare_cached("UPDATE terms SET body = ?2 WHERE record_id = ?1")
                            .map_err(err)?
                            .execute(params![key, serde_json::to_string(&new).map_err(err)?])
                            .map_err(err)?;
                    }
                    _ => {}
                }
                Ok(())
            }
            SearchParams::Inverted { persist, .. } => {
                let persist = persist.clone();
                let prev = self.inv.tail.insert(
                    key.to_owned(),
                    TailEntry {
                        stamp,
                        kind: kind.to_owned(),
                        terms: after.map(|_| new),
                    },
                );
                self.inv.undo.push(Undo::Tail(key.to_owned(), prev));
                if self.inv.since.is_none() {
                    self.inv.undo.push(Undo::Since(None));
                    self.inv.since = Some(now_ms);
                }
                if let Some(p) = persist {
                    let age_ms = now_ms.saturating_sub(self.inv.since.unwrap_or(now_ms));
                    if self.inv.tail.len() >= p.flush_records as usize
                        || age_ms >= p.flush_seconds.saturating_mul(1000)
                    {
                        self.flush(conn, &p, meters)?;
                    }
                }
                Ok(())
            }
        }
    }

    /// Owner erasure: no posting, term or covered id of `keys` may remain.
    /// The candidate has already called [`Self::changed`] with `after` None
    /// for each key.
    pub fn erase(
        &mut self,
        conn: &Connection,
        keys: &BTreeSet<String>,
        meters: &mut Meters,
    ) -> Result<(), StoreError> {
        let SearchParams::Inverted { persist, .. } = &self.p else {
            return Ok(());
        };
        let persist = persist.clone();
        for k in keys {
            if let Some(prev) = self.inv.tail.remove(k) {
                self.inv.undo.push(Undo::Tail(k.clone(), Some(prev)));
            }
        }
        let Some(p) = persist else {
            return Ok(());
        };
        let touched: Vec<usize> = self
            .inv
            .segs
            .iter()
            .enumerate()
            .filter(|(_, s)| keys.iter().any(|k| s.covers.contains_key(k)))
            .map(|(i, _)| i)
            .collect();
        if touched.is_empty() {
            return Ok(());
        }
        self.inv
            .undo
            .push(Undo::Segs(self.inv.segs.clone(), self.inv.next_seg));
        for i in touched {
            let old = self.inv.segs[i].clone();
            let mut postings = self.postings(conn, &old, &p, meters)?;
            for posts in postings.values_mut() {
                posts.retain(|post| !keys.contains(&post.k));
            }
            postings.retain(|_, posts| !posts.is_empty());
            let mut covers = old.covers.clone();
            covers.retain(|k, _| !keys.contains(k));
            self.drop_seg(conn, &old)?;
            let seg = self.write_seg(
                conn,
                old.id,
                old.level,
                (old.lo, old.hi),
                postings,
                covers,
                &p,
                meters,
            )?;
            self.inv.segs[i] = seg;
        }
        Ok(())
    }

    /// Persist the tail as one level-0 segment, then merge while the newest
    /// `fan_in` segments share a level.
    fn flush(
        &mut self,
        conn: &Connection,
        p: &Persist,
        meters: &mut Meters,
    ) -> Result<(), StoreError> {
        if self.inv.tail.is_empty() {
            return Ok(());
        }
        self.inv
            .undo
            .push(Undo::Segs(self.inv.segs.clone(), self.inv.next_seg));
        let lo = self.watermark();
        let hi = self.inv.tail.values().map(|e| e.stamp).max().unwrap_or(lo);
        let mut postings: BTreeMap<Term, Vec<Post>> = BTreeMap::new();
        let mut covers = BTreeMap::new();
        let tail = std::mem::take(&mut self.inv.tail);
        for (k, e) in &tail {
            covers.insert(k.clone(), e.stamp);
            for t in e.terms.iter().flatten() {
                postings.entry(t.clone()).or_default().push(Post {
                    s: e.stamp,
                    k: k.clone(),
                    c: e.kind.clone(),
                });
            }
        }
        for posts in postings.values_mut() {
            posts.sort_by(|a, b| b.s.cmp(&a.s));
        }
        for (k, e) in tail {
            self.inv.undo.push(Undo::Tail(k, Some(e)));
        }
        self.inv.undo.push(Undo::Since(self.inv.since.take()));
        let id = self.inv.next_seg;
        self.inv.next_seg += 1;
        let seg = self.write_seg(conn, id, 0, (lo, hi), postings, covers, p, meters)?;
        self.inv.segs.push(seg);
        while self.inv.segs.len() >= p.fan_in {
            let n = self.inv.segs.len();
            let level = self.inv.segs[n - 1].level;
            if self.inv.segs[n - p.fan_in..]
                .iter()
                .any(|s| s.level != level)
            {
                break;
            }
            let group = self.inv.segs.split_off(n - p.fan_in);
            let oldest = self.inv.segs.is_empty();
            let mut merged: BTreeMap<Term, Vec<Post>> = BTreeMap::new();
            let mut covers: BTreeMap<String, i64> = BTreeMap::new();
            for s in group.iter().rev() {
                let newer: BTreeSet<String> = covers.keys().cloned().collect();
                for (t, posts) in self.postings(conn, s, p, meters)? {
                    let keep: Vec<Post> = posts
                        .into_iter()
                        .filter(|x| !newer.contains(&x.k))
                        .collect();
                    if !keep.is_empty() {
                        merged.entry(t).or_default().extend(keep);
                    }
                }
                for (k, st) in &s.covers {
                    covers.entry(k.clone()).or_insert(*st);
                }
            }
            for posts in merged.values_mut() {
                posts.sort_by(|a, b| b.s.cmp(&a.s));
            }
            if oldest {
                // Nothing older to shadow: a covered id with no posting is not needed.
                let posted: BTreeSet<&String> = merged.values().flatten().map(|x| &x.k).collect();
                covers.retain(|k, _| posted.contains(k));
            }
            for s in &group {
                self.drop_seg(conn, s)?;
            }
            let id = self.inv.next_seg;
            self.inv.next_seg += 1;
            let range = (group[0].lo, group[group.len() - 1].hi);
            let seg = self.write_seg(conn, id, level + 1, range, merged, covers, p, meters)?;
            self.inv.segs.push(seg);
        }
        Ok(())
    }

    /// Write one segment's parts and header.
    #[allow(clippy::too_many_arguments)]
    fn write_seg(
        &mut self,
        conn: &Connection,
        id: i64,
        level: u32,
        (lo, hi): (i64, i64),
        postings: BTreeMap<Term, Vec<Post>>,
        covers: BTreeMap<String, i64>,
        p: &Persist,
        meters: &mut Meters,
    ) -> Result<Seg, StoreError> {
        let mut bodies: Vec<(Term, Vec<u8>)> = Vec::new();
        let mut part: Part = Vec::new();
        let mut bytes = 0usize;
        let mut close = |part: &mut Part, bytes: &mut usize| -> Result<(), StoreError> {
            if let Some(first) = part.first().map(|(t, _)| t.clone()) {
                bodies.push((first, serde_json::to_vec(&*part).map_err(err)?));
            }
            part.clear();
            *bytes = 0;
            Ok(())
        };
        for (t, posts) in postings {
            bytes += t.0.len()
                + t.1.len()
                + posts
                    .iter()
                    .map(|x| x.k.len() + x.c.len() + 24)
                    .sum::<usize>();
            part.push((t, posts));
            if bytes >= p.part_bytes {
                close(&mut part, &mut bytes)?;
            }
        }
        close(&mut part, &mut bytes)?;
        let mut parts = Vec::with_capacity(bodies.len());
        let mut object = None;
        match p.place {
            Place::Rows => {
                let mut stmt = conn
                    .prepare_cached("INSERT INTO sx_part(seg, n, body) VALUES(?1, ?2, ?3)")
                    .map_err(err)?;
                for (n, (first, body)) in bodies.into_iter().enumerate() {
                    stmt.execute(params![id, n as i64, body]).map_err(err)?;
                    parts.push(PartRef {
                        first,
                        offset: 0,
                        len: 0,
                    });
                }
            }
            Place::Archive => {
                std::fs::create_dir_all(&self.dir).map_err(err)?;
                let mut all = Vec::new();
                for (first, body) in bodies {
                    parts.push(PartRef {
                        first,
                        offset: all.len(),
                        len: body.len(),
                    });
                    all.extend(body);
                }
                // Content-addressed: a rewrite never overwrites a committed object.
                let name = format!("seg-{}.bin", blake3::hash(&all).to_hex());
                let path = self.dir.join(&name);
                std::fs::write(&path, &all).map_err(err)?;
                meters.add(ARCHIVE_PUTS, 1);
                meters.add(ARCHIVE_BYTES, all.len() as u64);
                self.inv.written.push(path);
                object = Some(name);
            }
        }
        let seg = Seg {
            id,
            level,
            lo,
            hi,
            object,
            parts,
            covers,
        };
        conn.prepare_cached("INSERT INTO sx_seg(seg, meta) VALUES(?1, ?2)")
            .map_err(err)?
            .execute(params![id, serde_json::to_string(&seg).map_err(err)?])
            .map_err(err)?;
        Ok(seg)
    }

    fn drop_seg(&mut self, conn: &Connection, s: &Seg) -> Result<(), StoreError> {
        conn.prepare_cached("DELETE FROM sx_part WHERE seg = ?1")
            .map_err(err)?
            .execute([s.id])
            .map_err(err)?;
        conn.prepare_cached("DELETE FROM sx_seg WHERE seg = ?1")
            .map_err(err)?
            .execute([s.id])
            .map_err(err)?;
        if let Some(o) = &s.object {
            self.inv.retired.push(self.dir.join(o));
        }
        self.inv.cache.drop_seg(s.id);
        Ok(())
    }

    /// One part of a segment (memory cache, else one row read or one GET).
    fn part(
        &mut self,
        conn: &Connection,
        s: &Seg,
        n: usize,
        meters: &mut Meters,
    ) -> Result<Rc<Part>, StoreError> {
        if let Some(hit) = self.inv.cache.get((s.id, n)) {
            return Ok(hit);
        }
        let body: Vec<u8> = match &s.object {
            None => conn
                .prepare_cached("SELECT body FROM sx_part WHERE seg = ?1 AND n = ?2")
                .map_err(err)?
                .query_row(params![s.id, n as i64], |r| r.get(0))
                .optional()
                .map_err(err)?
                .ok_or_else(|| StoreError(format!("search segment {} lacks part {n}", s.id)))?,
            Some(o) => {
                let r = &s.parts[n];
                let all = std::fs::read(self.dir.join(o)).map_err(err)?;
                meters.add(ARCHIVE_GETS, 1);
                all.get(r.offset..r.offset + r.len)
                    .ok_or_else(|| StoreError(format!("search object {o} is short")))?
                    .to_vec()
            }
        };
        let part: Rc<Part> = Rc::new(serde_json::from_slice(&body).map_err(err)?);
        self.inv.cache.put((s.id, n), part.clone(), body.len());
        Ok(part)
    }

    /// Every posting of a segment (merge and erasure read whole segments).
    fn postings(
        &mut self,
        conn: &Connection,
        s: &Seg,
        p: &Persist,
        meters: &mut Meters,
    ) -> Result<BTreeMap<Term, Vec<Post>>, StoreError> {
        let mut out = BTreeMap::new();
        match (&s.object, p.place) {
            (Some(o), _) => {
                let all = std::fs::read(self.dir.join(o)).map_err(err)?;
                meters.add(ARCHIVE_GETS, 1);
                for r in &s.parts {
                    let part: Part = serde_json::from_slice(
                        all.get(r.offset..r.offset + r.len)
                            .ok_or_else(|| StoreError(format!("search object {o} is short")))?,
                    )
                    .map_err(err)?;
                    out.extend(part);
                }
            }
            (None, _) => {
                for n in 0..s.parts.len() {
                    out.extend(self.part(conn, s, n, meters)?.iter().cloned());
                }
            }
        }
        Ok(out)
    }

    /// Newest `limit` records whose current `field` holds `word`, newest
    /// stamp first. None: this layout scans (the candidate answers).
    #[allow(clippy::too_many_arguments)]
    pub fn search(
        &mut self,
        conn: &Connection,
        field: &str,
        word: &str,
        kinds: Option<&[String]>,
        limit: u32,
        now_ms: u64,
        spans: &mut Spans,
        meters: &mut Meters,
        current: &mut CurrentOf<'_>,
    ) -> Result<Option<Vec<String>>, StoreError> {
        if !matches!(self.p, SearchParams::Scan) && !self.fields().iter().any(|f| f == field) {
            return Err(StoreError(format!(
                "field {field} is not declared searchable"
            )));
        }
        let wanted = |kind: &str| kinds.is_none_or(|k| k.iter().any(|x| x == kind));
        let limit = limit as usize;
        let term: Term = (field.to_owned(), word.to_owned());
        let mut hits: Vec<(i64, String)> = Vec::new();
        match &self.p {
            SearchParams::Scan => return Ok(None),
            SearchParams::WordRows { .. } => {
                let keys: Vec<String> = conn
                    .prepare_cached("SELECT record_id FROM words WHERE field = ?1 AND word = ?2")
                    .map_err(err)?
                    .query_map(params![field, word], |r| r.get(0))
                    .map_err(err)?
                    .collect::<Result<_, _>>()
                    .map_err(err)?;
                spans.cut(ReadCause::Scoped("search"))?;
                for k in keys {
                    if let Some((s, kind)) = current(&k)? {
                        if wanted(&kind) {
                            hits.push((s, k));
                        }
                    }
                }
                spans.cut(ReadCause::Scoped("record"))?;
            }
            SearchParams::TermRow { .. } => {
                let mut matching = Vec::new();
                {
                    let mut stmt = conn
                        .prepare_cached("SELECT record_id, body FROM terms")
                        .map_err(err)?;
                    let mut rows = stmt.query([]).map_err(err)?;
                    while let Some(r) = rows.next().map_err(err)? {
                        let terms: BTreeSet<Term> =
                            serde_json::from_str(&r.get::<_, String>(1).map_err(err)?)
                                .map_err(err)?;
                        if terms.contains(&term) {
                            matching.push(r.get::<_, String>(0).map_err(err)?);
                        }
                    }
                }
                spans.cut(ReadCause::Scoped("search"))?;
                for k in matching {
                    if let Some((s, kind)) = current(&k)? {
                        if wanted(&kind) {
                            hits.push((s, k));
                        }
                    }
                }
                spans.cut(ReadCause::Scoped("record"))?;
            }
            SearchParams::Inverted { persist, .. } => {
                let persist = persist.clone();
                meters.add(SEARCH_TAIL_ENTRIES, self.inv.tail.len() as u64);
                meters.add(
                    SEARCH_LAG_MS,
                    self.inv.since.map_or(0, |s| now_ms.saturating_sub(s)),
                );
                let mut seen: BTreeSet<String> = BTreeSet::new();
                for (k, e) in &self.inv.tail {
                    seen.insert(k.clone());
                    if e.terms.as_ref().is_some_and(|t| t.contains(&term)) && wanted(&e.kind) {
                        hits.push((e.stamp, k.clone()));
                    }
                }
                hits.sort_by(|a, b| b.0.cmp(&a.0));
                if persist.is_some() {
                    let segs = self.inv.segs.clone();
                    'segments: for s in segs.iter().rev() {
                        if hits.len() >= limit {
                            break;
                        }
                        if let Some(n) = s.part_of(&term) {
                            let part = self.part(conn, s, n, meters)?;
                            spans.cut(ReadCause::Scoped("search"))?;
                            if let Ok(i) = part.binary_search_by(|(t, _)| t.cmp(&term)) {
                                for post in &part[i].1 {
                                    if seen.contains(&post.k) || !wanted(&post.c) {
                                        continue;
                                    }
                                    seen.insert(post.k.clone());
                                    if current(&post.k)?.is_some_and(|(st, _)| st == post.s) {
                                        hits.push((post.s, post.k.clone()));
                                        if hits.len() >= limit {
                                            spans.cut(ReadCause::Scoped("record"))?;
                                            break 'segments;
                                        }
                                    }
                                }
                                spans.cut(ReadCause::Scoped("record"))?;
                            }
                        }
                        seen.extend(s.covers.keys().cloned());
                    }
                }
            }
        }
        hits.sort_by(|a, b| b.0.cmp(&a.0));
        hits.truncate(limit);
        Ok(Some(hits.into_iter().map(|(_, k)| k).collect()))
    }

    /// Archive objects the current segments name.
    fn referenced(&self) -> BTreeSet<PathBuf> {
        self.inv
            .segs
            .iter()
            .filter_map(|s| s.object.as_ref().map(|o| self.dir.join(o)))
            .collect()
    }

    /// Delete `paths` that no current segment names.
    fn delete_unreferenced(&self, paths: Vec<PathBuf>) {
        let keep = self.referenced();
        for path in paths {
            if !keep.contains(&path) {
                // Unreferenced: a replaced object or one an uncommitted write left.
                let _ = std::fs::remove_file(path);
            }
        }
    }

    /// The transaction committed: forget its undo, delete retired objects.
    pub fn commit(&mut self) {
        self.inv.undo.clear();
        self.inv.written.clear();
        let retired = std::mem::take(&mut self.inv.retired);
        self.delete_unreferenced(retired);
    }

    /// The transaction rolled back: restore memory, delete its new objects.
    pub fn rollback(&mut self) {
        while let Some(u) = self.inv.undo.pop() {
            match u {
                Undo::Tail(k, Some(e)) => {
                    self.inv.tail.insert(k, e);
                }
                Undo::Tail(k, None) => {
                    self.inv.tail.remove(&k);
                }
                Undo::Since(s) => self.inv.since = s,
                Undo::Segs(segs, next) => {
                    self.inv.segs = segs;
                    self.inv.next_seg = next;
                }
            }
        }
        let written = std::mem::take(&mut self.inv.written);
        self.delete_unreferenced(written);
        self.inv.retired.clear();
        self.inv.cache.clear();
    }

    /// Process death: every volatile structure is gone until reopen (which
    /// deletes the objects no committed header names).
    pub fn crash(&mut self) {
        self.inv.tail.clear();
        self.inv.since = None;
        self.inv.segs.clear();
        self.inv.undo.clear();
        self.inv.written.clear();
        self.inv.retired.clear();
        self.inv.cache.clear();
    }

    /// Archive objects (erasure residue scan).
    pub fn files(&self) -> Vec<PathBuf> {
        match std::fs::read_dir(&self.dir) {
            Ok(dir) => {
                let mut f: Vec<PathBuf> = dir.filter_map(|e| e.ok().map(|e| e.path())).collect();
                f.sort();
                f
            }
            Err(_) => Vec::new(),
        }
    }
}

fn persist(p: &SearchParams) -> Option<&Persist> {
    match p {
        SearchParams::Inverted {
            persist: Some(s), ..
        } => Some(s),
        _ => None,
    }
}
