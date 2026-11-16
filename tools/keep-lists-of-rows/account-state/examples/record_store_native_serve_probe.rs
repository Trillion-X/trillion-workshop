// examples/record_store_native_serve_probe.rs
//
// Purpose: Drive the own-records read shapes of the six native-serve startup requests (viewer, show-rules, screens,
// pursuits, needs-you-hold, decisions) through the old SQL store and through the record store on a CLONE of an account,
// and print each request's statements, rows, bytes and milliseconds on both, side by side. This proves the switch
// before Native applies it: the same reads, the same answers (digest compared), and what each costs.
// Invariants: never a live state (the running app's state lock refuses it); the old object is opened readonly in one read
// snapshot; the record store is a migrated copy (`examples/record_store_migrate.rs`), only read once its declared orders are
// filled (`RecordStore::fill_order`, a one-time step for a store migrated before an order was declared).
// Key concepts: the read shapes come from the request sources (src/local_account/{pursuits_read, hold_screen,
// decision_screen_source}.rs as they stood, src/workspace_pursuits/current.rs): point reads by id and id pages by type. Viewer
// reads no own record, show-rules reads `workspace_records`, screens reads `workshop_*`: the switch leaves them as they
// are. Cost is counted at each store's storage edge: every SQL statement (old) or ordered seek (record store), every row it
// returned and the bytes of the cells in those rows.
// Security: stdout holds counts, digests and timings only; no id, value or key.
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
//
// Usage: record_store_native_serve_probe STATE OBJECT_SQLITE_RELATIVE RECORD_STORE_SQLITE OLD_BOUNDS
// OLD_BOUNDS is `request` (the old reader's request defaults, `Bounds::default()`) or `largest` (the largest it
// accepts, as the migration uses).

use rusqlite::{types::Value as SqlParam, OpenFlags};
use content_crypto::advanced::blake3;
use serde::Serialize;
use serde_json::Value as Json;
use std::{
    cell::Cell,
    collections::BTreeSet,
    path::PathBuf,
    rc::Rc,
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant},
};
use trillion_local::{
    ecma_json::{self, JsString},
    import::{ImportError, ImportResult, QueryRows, QueryTiming, ReadLimits, SqlValue},
    legacy_kept::{LegacyKept, Limits},
    legacy_records::{
        ids::{IdsLimits, IdsRequest},
        Bounds, LegacyRecords, StoredRecord,
    },
    record_source::{catalogue_point, BoundedRecordSql, QueryBudget, ReadSourceState, SnapshotRecordSql},
    records::{Error, MAX_PAGE_ITEMS},
    storage::{
        record_store::{
            migrate::digest,
            native::{stored_form, CurrentRecords, RecordStoreCurrent},
            settings,
        },
        record_store_resources,
        sqlite::{self, Spend},
        Intent, Range, Read, Result as StorageResult, Row, Schema, Storage, Value, When,
    },
};

/// What one side did for one request.
#[derive(Clone, Copy, Debug, Default, Serialize)]
struct Counts {
    statements: u64,
    rows: u64,
    bytes: u64,
}
impl Counts {
    fn add_rows(&mut self, rows: impl Iterator<Item = usize>) {
        self.statements += 1;
        for bytes in rows {
            self.rows += 1;
            self.bytes += bytes as u64;
        }
    }
    fn since(self, start: Counts) -> Counts {
        Counts {
            statements: self.statements - start.statements,
            rows: self.rows - start.rows,
            bytes: self.bytes - start.bytes,
        }
    }
}

fn sql_cell_bytes(value: &SqlValue) -> usize {
    match value {
        SqlValue::Null => 0,
        SqlValue::Integer(_) | SqlValue::RealBits(_) => 8,
        SqlValue::Text(bytes) | SqlValue::Blob(bytes) => bytes.len(),
    }
}
fn storage_cell_bytes(value: &Value) -> usize {
    match value {
        Value::Null => 0,
        Value::Integer(_) | Value::Real(_) => 8,
        Value::Text(text) => text.len(),
        Value::Blob(bytes) => bytes.len(),
        Value::Oversized(bytes) => *bytes as usize,
    }
}

/// The old SQL store's source, counting every statement it runs, the rows it returns and their cell bytes.
struct MeteredSql<S> {
    inner: S,
    counts: Rc<Cell<Counts>>,
}
impl<S> MeteredSql<S> {
    fn count(&self, rows: ImportResult<QueryRows>) -> ImportResult<QueryRows> {
        if let Ok(rows) = &rows {
            let mut counts = self.counts.get();
            counts.add_rows(rows.rows.iter().map(|row| row.iter().map(sql_cell_bytes).sum()));
            self.counts.set(counts);
        }
        rows
    }
}
impl<S: BoundedRecordSql> BoundedRecordSql for MeteredSql<S> {
    fn read_source_state(&mut self) -> ImportResult<ReadSourceState> {
        self.inner.read_source_state()
    }
    fn read_limits(&self) -> Option<&ReadLimits> {
        self.inner.read_limits()
    }
    fn query(&mut self, sql: &str, params: &[SqlParam]) -> ImportResult<QueryRows> {
        let rows = self.inner.query(sql, params);
        self.count(rows)
    }
    fn query_with_budget(&mut self, sql: &str, params: &[SqlParam], budget: QueryBudget) -> ImportResult<QueryRows> {
        let rows = self.inner.query_with_budget(sql, params, budget);
        self.count(rows)
    }
    fn supports_ordered_prefix(&self) -> bool {
        self.inner.supports_ordered_prefix()
    }
    fn query_ordered_prefix_with_budget(
        &mut self,
        sql: &str,
        params: &[SqlParam],
        budget: QueryBudget,
    ) -> ImportResult<QueryRows> {
        let rows = self.inner.query_ordered_prefix_with_budget(sql, params, budget);
        self.count(rows)
    }
    fn query_reusable_with_budget(
        &mut self,
        sql: &str,
        params: &[SqlParam],
        budget: QueryBudget,
    ) -> ImportResult<QueryRows> {
        let rows = self.inner.query_reusable_with_budget(sql, params, budget);
        self.count(rows)
    }
    fn query_checkpoint_with_budget(
        &mut self,
        sql: &str,
        params: &[SqlParam],
        budget: QueryBudget,
    ) -> ImportResult<QueryRows> {
        let rows = self.inner.query_checkpoint_with_budget(sql, params, budget);
        self.count(rows)
    }
    fn main_table_exists(&mut self, name: &str, budget: QueryBudget) -> catalogue_point::Probe {
        let mut counts = self.counts.get();
        counts.statements += 1;
        self.counts.set(counts);
        self.inner.main_table_exists(name, budget)
    }
    fn last_query_timing(&self) -> Option<QueryTiming> {
        self.inner.last_query_timing()
    }
}

/// The record store supply, counting every ordered seek, the rows it returns and their cell bytes.
struct MeteredStorage<S> {
    inner: S,
    counts: Cell<Counts>,
}
impl<S> MeteredStorage<S> {
    fn count(&self, rows: &[Row]) {
        let mut counts = self.counts.get();
        counts.add_rows(rows.iter().map(|row| row.0.iter().map(storage_cell_bytes).sum()));
        self.counts.set(counts);
    }
}
impl<S: Storage> Storage for MeteredStorage<S> {
    fn schema(&self) -> &'static Schema {
        self.inner.schema()
    }
    fn get(&self, family: &str, key: &[Value], read: &[Read<'_>]) -> StorageResult<Option<Row>> {
        let row = self.inner.get(family, key, read)?;
        self.count(row.as_slice());
        Ok(row)
    }
    fn scan(&self, family: &str, range: &Range<'_>, read: &[Read<'_>]) -> StorageResult<Vec<Row>> {
        let rows = self.inner.scan(family, range, read)?;
        self.count(&rows);
        Ok(rows)
    }
    fn put(&self, family: &str, row: &[(&str, Value)], when: When<'_>) -> StorageResult<u64> {
        self.inner.put(family, row, when)
    }
    fn count(&self, family: &str, range: &Range<'_>) -> StorageResult<u64> {
        self.inner.count(family, range)
    }
    fn erase(&self, family: &str, range: &Range<'_>) -> StorageResult<u64> {
        self.inner.erase(family, range)
    }
    fn present(&self, family: &str) -> StorageResult<bool> {
        self.inner.present(family)
    }
    fn custody(&self) -> StorageResult<()> {
        self.inner.custody()
    }
    fn location(&self) -> Option<&str> {
        self.inner.location()
    }
    fn scoped(&self) -> bool {
        self.inner.scoped()
    }
    fn writing(&self) -> StorageResult<bool> {
        self.inner.writing()
    }
    fn changes(&self) -> u64 {
        self.inner.changes()
    }
    fn mark(&self) -> StorageResult<i64> {
        self.inner.mark()
    }
    fn schema_mark(&self) -> StorageResult<i64> {
        self.inner.schema_mark()
    }
    fn allocated_bytes(&self) -> StorageResult<u64> {
        self.inner.allocated_bytes()
    }
    fn reclaim(&self) -> StorageResult<()> {
        self.inner.reclaim()
    }
    fn open_scope(&self, intent: Intent) -> StorageResult<()> {
        self.inner.open_scope(intent)
    }
    fn close_scope(&self, commit: bool) -> StorageResult<()> {
        self.inner.close_scope(commit)
    }
}

/// The two reads every request shape is made of, on one store.
trait Side {
    fn point(&mut self, id: &str) -> Result<Option<StoredRecord>, String>;
    /// One page of a type's ids, newest id first, strictly before `before`, only ids starting with `prefix`.
    fn ids(&mut self, kind: &str, prefix: &str, before: Option<&str>, limit: usize)
        -> Result<(Vec<String>, Option<String>), String>;
    /// The first `limit` records of a declared field order, highest value first.
    fn ordered(&mut self, order: &str, limit: usize) -> Result<Vec<StoredRecord>, String>;
    fn counts(&self) -> Counts;
}

struct Old<S: BoundedRecordSql> {
    records: LegacyRecords<MeteredSql<S>>,
    kept: LegacyKept,
    ids_limits: IdsLimits,
    counts: Rc<Cell<Counts>>,
}
impl<S: BoundedRecordSql> Side for Old<S> {
    fn point(&mut self, id: &str) -> Result<Option<StoredRecord>, String> {
        self.records.read_stored(id, &self.kept).map_err(|error| {
            self.records.last_read_diagnostic().map_or_else(|| format!("{error}"), |seen| format!("{error}: {seen}"))
        })
    }
    fn ids(&mut self, kind: &str, prefix: &str, before: Option<&str>, limit: usize)
        -> Result<(Vec<String>, Option<String>), String> {
        let (prefix, before) = (JsString::from(prefix), before.map(JsString::from));
        let request = IdsRequest { record_type: kind, prefix: &prefix, before: before.as_ref(), limit };
        self.records
            .ids_of_type(request, self.ids_limits, &self.kept)
            .map(|page| (page.ids, page.next))
            .map_err(|error| {
                self.records.last_read_diagnostic().map_or_else(|| format!("{error}"), |seen| format!("{error}: {seen}"))
            })
    }
    fn ordered(&mut self, _: &str, _: usize) -> Result<Vec<StoredRecord>, String> {
        Err("the old engine's field index needs Native's index readiness owner; its order is checked separately".into())
    }
    fn counts(&self) -> Counts {
        self.counts.get()
    }
}

struct New<S: Storage + Send> {
    seam: RecordStoreCurrent<MeteredStorage<S>>,
}
impl<S: Storage + Send> Side for New<S> {
    fn point(&mut self, id: &str) -> Result<Option<StoredRecord>, String> {
        self.seam.stored(id).map_err(|error: Error| format!("{error:?}"))
    }
    fn ids(&mut self, kind: &str, prefix: &str, before: Option<&str>, limit: usize)
        -> Result<(Vec<String>, Option<String>), String> {
        // Newest id first: start below the prefix's end (or the cursor), stop at the first id outside the prefix.
        let end = format!("{prefix}\u{10ffff}");
        let start = before.map_or(end.as_str(), |before| before.min(end.as_str()));
        // One logical page larger than the store's page bound is read as several pages.
        let (account, resource) = (self.seam.account.clone(), self.seam.resource.clone());
        let mut cursor = start.to_owned();
        let mut all = Vec::new();
        loop {
            let want = (limit - all.len()).min(MAX_PAGE_ITEMS);
            let (ids, next) = self
                .seam
                .store
                .ids_of_kind(&account, &resource, kind, Some(&cursor), want)
                .map_err(|error| format!("{error:?}"))?;
            let inside = ids.iter().take_while(|id| id.starts_with(prefix)).count();
            let left = inside < ids.len();
            all.extend(ids.into_iter().take(inside));
            match next {
                Some(next) if !left && all.len() < limit => cursor = next,
                Some(next) if !left => return Ok((all, Some(next))),
                _ => return Ok((all, None)),
            }
        }
    }
    fn ordered(&mut self, order: &str, limit: usize) -> Result<Vec<StoredRecord>, String> {
        let (account, resource) = (self.seam.account.clone(), self.seam.resource.clone());
        let page = self.seam.store.ordered_page(&account, &resource, order, None, true, limit).map_err(|error| format!("{error:?}"))?;
        page.records.iter().map(|record| stored_form(&record.id, &record.value).map_err(|error| format!("{error:?}"))).collect()
    }
    fn counts(&self) -> Counts {
        self.seam.store.storage().counts.get()
    }
}

/// The old SQL store reading every record itself, with each id page taken from the record store run of the same request (the
/// old public id pages refuse this account even at their largest bounds).
struct OldWithIds<'a, S: BoundedRecordSql> {
    old: &'a mut Old<S>,
    pages: std::vec::IntoIter<(Vec<String>, Option<String>)>,
    ordered: std::vec::IntoIter<Vec<String>>,
}
impl<S: BoundedRecordSql> Side for OldWithIds<'_, S> {
    fn point(&mut self, id: &str) -> Result<Option<StoredRecord>, String> {
        self.old.point(id)
    }
    fn ids(&mut self, _: &str, _: &str, _: Option<&str>, _: usize) -> Result<(Vec<String>, Option<String>), String> {
        self.pages.next().ok_or_else(|| "the record store run made fewer id pages".to_owned())
    }
    fn ordered(&mut self, _: &str, _: usize) -> Result<Vec<StoredRecord>, String> {
        let ids = self.ordered.next().ok_or_else(|| "the record store run made fewer ordered pages".to_owned())?;
        let mut records = Vec::with_capacity(ids.len());
        for id in ids {
            records.push(self.old.point(&id)?.ok_or("an ordered record is absent in the old engine")?);
        }
        Ok(records)
    }
    fn counts(&self) -> Counts {
        self.old.counts()
    }
}

/// A side that keeps every id page it answers, to hand the same pages to the old SQL store.
struct Recording<'a> {
    side: &'a mut dyn Side,
    pages: Vec<(Vec<String>, Option<String>)>,
    ordered: Vec<Vec<String>>,
}
impl Side for Recording<'_> {
    fn point(&mut self, id: &str) -> Result<Option<StoredRecord>, String> {
        self.side.point(id)
    }
    fn ids(&mut self, kind: &str, prefix: &str, before: Option<&str>, limit: usize)
        -> Result<(Vec<String>, Option<String>), String> {
        let page = self.side.ids(kind, prefix, before, limit)?;
        self.pages.push(page.clone());
        Ok(page)
    }
    fn ordered(&mut self, order: &str, limit: usize) -> Result<Vec<StoredRecord>, String> {
        let records = self.side.ordered(order, limit)?;
        self.ordered.push(records.iter().map(|record| record.id.clone()).collect());
        Ok(records)
    }
    fn counts(&self) -> Counts {
        self.side.counts()
    }
}

/// One request on one side.
#[derive(Debug, Default, Serialize)]
struct Measured {
    #[serde(flatten)]
    counts: Counts,
    ms: f64,
    records: u64,
    /// BLAKE3 over the digests of every record read, in read order: equal on both sides when the answers are equal.
    answer: String,
    refused: Option<String>,
}

struct Run<'a> {
    side: &'a mut dyn Side,
    hasher: blake3::Hasher,
    records: u64,
}
impl Run<'_> {
    fn ordered(&mut self, order: &str, limit: usize) -> Result<Vec<StoredRecord>, String> {
        let records = self.side.ordered(order, limit)?;
        for record in &records {
            self.records += 1;
            self.hasher.update(&digest(record));
        }
        Ok(records)
    }
    fn point(&mut self, id: &str) -> Result<Option<StoredRecord>, String> {
        let record = self.side.point(id)?;
        match &record {
            Some(record) => {
                self.records += 1;
                self.hasher.update(&digest(record));
            }
            None => {
                self.hasher.update(b"absent");
            }
        }
        Ok(record)
    }
    fn ids(&mut self, kind: &str, prefix: &str, before: Option<&str>, limit: usize)
        -> Result<(Vec<String>, Option<String>), String> {
        let (ids, next) = self.side.ids(kind, prefix, before, limit)?;
        for id in &ids {
            self.hasher.update(id.as_bytes());
            self.hasher.update(b"\0");
        }
        Ok((ids, next))
    }
}

fn measure(side: &mut dyn Side, shape: impl FnOnce(&mut Run<'_>) -> Result<(), String>) -> Measured {
    let start = side.counts();
    let started = Instant::now();
    let mut run = Run { side, hasher: blake3::Hasher::new(), records: 0 };
    let refused = shape(&mut run).err();
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    let (records, answer) = (run.records, run.hasher.finalize().to_hex().to_string());
    Measured { counts: side.counts().since(start), ms, records, answer, refused }
}

fn value(record: &StoredRecord) -> Json {
    serde_json::from_str(&record.value_json).unwrap_or(Json::Null)
}

/// pursuits (src/workspace_pursuits/current.rs, src/local_account/pursuits_read.rs): the two space settings, every
/// pursuit id in pages of 64, each pursuit and its record scope, then the relay setting.
fn pursuits(run: &mut Run<'_>) -> Result<(), String> {
    run.point("setting:pursuit_spaces")?;
    run.point("setting:archived_spaces")?;
    let mut before: Option<String> = None;
    loop {
        let (ids, next) = run.ids("pursuit", "", before.as_deref(), 64)?;
        for id in &ids {
            run.point(id)?;
            run.point(&format!("record-scope:{id}"))?;
        }
        match next {
            Some(next) => before = Some(next),
            None => break,
        }
    }
    run.point("setting:network_relay")?;
    Ok(())
}

/// needs-you-hold (src/local_account/hold_screen.rs as it stood; the hold is now trillion-workshop tools/hold-one-thing-until-done): the hold setting.
fn hold(run: &mut Run<'_>) -> Result<(), String> {
    run.point("setting:needs_you_hold").map(drop)
}

/// decisions (the shape trillion-local's decision screen read before it moved to the tool tool:see-my-decisions): 100 decisions, their steps and calls when kept apart,
/// the pursuits they cite, a page of 101 pursuits (100 read with their scopes), the plan existence check and the agent
/// work settings. The 100 decisions are the newest by `created_at` (record store's declared order `decision/created_at`, the
/// old screen's index; `decision_order` checks that order against the old SQL store's own records).
fn decisions(run: &mut Run<'_>) -> Result<(), String> {
    let roots = run.ordered("decision/created_at", 100)?;
    let mut cited = BTreeSet::new();
    for record in &roots {
        let id = &record.id;
        let fields = value(record);
        if fields.get("guidance").is_none() {
            if let Some(Json::Array(steps)) = fields.get("answered_steps") {
                for at in 0..steps.len() {
                    run.point(&format!("decision-step:{id}:{at:03}"))?;
                }
            }
        }
        if fields.get("calls").is_none() {
            if let Some(count) = fields.get("call_count").and_then(Json::as_u64) {
                for at in 0..count.min(4096) {
                    run.point(&format!("decision-call:{id}:{at:06}"))?;
                }
            }
        }
        if let Some(Json::Object(cites)) = fields.get("cited_pursuits") {
            cited.extend(cites.keys().cloned());
        }
    }
    for id in &cited {
        run.point(id)?;
    }
    let (pursuits, _) = run.ids("pursuit", "", None, 101)?;
    for id in pursuits.iter().take(100) {
        run.point(id)?;
        run.point(&format!("record-scope:{id}"))?;
    }
    let (plans, _) = run.ids("plan", "", None, 1)?;
    if !plans.is_empty() {
        return Err("a plan exists: the plan/updated_at page needs a declared order on record store".into());
    }
    let (work, _) = run.ids("setting", "setting:agent-work:", None, 4096)?;
    for id in &work {
        run.point(id)?;
    }
    Ok(())
}

/// The declared order `decision/created_at` on record store against the old SQL store's index order rebuilt from the old
/// store's own reading of every decision: the field's ECMA JSON text by UTF-16 code unit, then id, highest first.
#[derive(Serialize)]
struct OrderCheck {
    decisions: usize,
    with_created_at: usize,
    #[serde(rename = "record_store_ordered")] record_store_ordered: usize,
    same_order: bool,
    first_difference_at: Option<usize>,
    old_ms: f64,
    /// The 100 newest decisions by created_at on record store alone: one scan plus one get per record.
    newest_100: Counts,
    newest_100_ms: f64,
}

fn decision_order<O: BoundedRecordSql, N: Storage + Send>(old: &mut Old<O>, new: &mut New<N>) -> Result<OrderCheck, String> {
    let (account, resource) = (new.seam.account.clone(), new.seam.resource.clone());
    let store = &new.seam.store;
    let mut ids = Vec::new();
    let mut before: Option<String> = None;
    loop {
        let (page, next) = store.ids_of_kind(&account, &resource, "decision", before.as_deref(), MAX_PAGE_ITEMS).map_err(|error| format!("{error:?}"))?;
        ids.extend(page);
        match next {
            Some(next) => before = Some(next),
            None => break,
        }
    }
    let (before_page, page_started) = (new.counts(), Instant::now());
    let page = new.seam.store.ordered_page(&account, &resource, "decision/created_at", None, true, 100).map_err(|error| format!("{error:?}"))?;
    let (newest_100, newest_100_ms) = (new.counts().since(before_page), page_started.elapsed().as_secs_f64() * 1000.0);
    let newest: Vec<String> = page.records.into_iter().map(|record| record.id).collect();
    let store = &new.seam.store;
    let started = Instant::now();
    let mut keyed = Vec::new();
    for id in &ids {
        let record = old.point(id)?.ok_or("a decision is absent in the old engine")?;
        let document = ecma_json::parse(record.value_json.as_bytes(), ecma_json::Limits::default()).map_err(|error| format!("{error:?}"))?;
        let ecma_json::Value::Object(fields) = &document else { continue };
        let Some(at) = fields.get(&JsString::from("created_at")) else { continue };
        keyed.push((ecma_json::stringify(at, ecma_json::Limits::default()).map_err(|error| format!("{error:?}"))?, id.clone()));
    }
    let old_ms = started.elapsed().as_secs_f64() * 1000.0;
    keyed.sort_by(|a, b| b.0.encode_utf16().cmp(a.0.encode_utf16()).then_with(|| b.1.encode_utf16().cmp(a.1.encode_utf16())));
    let expected: Vec<String> = keyed.into_iter().map(|(_, id)| id).collect();
    let mut ordered = Vec::new();
    let mut cursor = None;
    loop {
        let page = store.ordered_page(&account, &resource, "decision/created_at", cursor.as_ref(), true, MAX_PAGE_ITEMS).map_err(|error| format!("{error:?}"))?;
        ordered.extend(page.records.into_iter().map(|record| record.id));
        match page.next {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    if newest[..] != expected[..newest.len().min(expected.len())] {
        return Err("the newest 100 page differs from the old index order".into());
    }
    let first_difference_at = expected.iter().zip(&ordered).position(|(a, b)| a != b).or((expected.len() != ordered.len()).then(|| expected.len().min(ordered.len())));
    Ok(OrderCheck {
        decisions: ids.len(),
        with_created_at: expected.len(),
        record_store_ordered: ordered.len(),
        same_order: first_difference_at.is_none(),
        first_difference_at,
        old_ms,
        newest_100,
        newest_100_ms,
    })
}

#[derive(Serialize)]
struct Request {
    request: &'static str,
    reads_own_records: bool,
    note: &'static str,
    old: Option<Measured>,
    /// The old SQL store reading the same records with record store's id pages (its own id pages refused or not).
    #[serde(rename = "old_with_record_store_ids")] old_with_record_store_ids: Option<Measured>,
    #[serde(rename = "record_store")] record_store: Option<Measured>,
    /// record store's answer equals the old SQL store's reading of the same records.
    same_answer: Option<bool>,
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [state, relative, record_store, old_bounds] = args.as_slice() else {
        return Err("usage: record_store_native_serve_probe STATE OBJECT_SQLITE_RELATIVE RECORD_STORE_SQLITE OLD_BOUNDS".into());
    };
    let state = std::fs::canonicalize(state)?;
    if state.join("local-runtime.lock").exists() {
        return Err("the state has a runtime ownership lock; probe a quiescent clone".into());
    }
    let receipt: serde_json::Value = serde_json::from_slice(&std::fs::read(state.join("restore-receipt.json"))?)?;
    let owner = receipt["account"]["ownerId"].as_str().ok_or("receipt account")?.to_owned();

    // The old SQL store at its request allowances, over one readonly snapshot whose witness refuses any change.
    let path = state.join(relative);
    let seen = std::fs::metadata(&path)?;
    let witness = {
        let path = path.clone();
        move || -> ImportResult<()> {
            let now = std::fs::metadata(&path)?;
            if now.len() != seen.len() || now.modified()? != seen.modified()? {
                return Err(ImportError::Refused("the probed source changed during the read", trillion_local::cause!()));
            }
            Ok(())
        }
    };
    let connection = rusqlite::Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    let limits = ReadLimits { elapsed: Duration::from_secs(30), ..ReadLimits::default() };
    let snapshot = SnapshotRecordSql::begin(connection, limits, witness, Arc::new(AtomicBool::new(false)))?;
    let (old_bounds, ids_limits) = match old_bounds.as_str() {
        "request" => (Bounds::default(), IdsLimits::default()),
        "largest" => (
            Bounds { statements: 4096, rows: 30_000, bytes: 32 * 1024 * 1024, elapsed: Duration::from_secs(30) },
            IdsLimits {
                dirty_ids: 4096,
                held_bytes: 32 * 1024 * 1024,
                checkpoint_entries: 1_000_000,
                checkpoint_pages: 65_536,
                output_bytes: 32 * 1024 * 1024,
            },
        ),
        _ => return Err("OLD_BOUNDS is request or largest".into()),
    };
    let counts = Rc::new(Cell::new(Counts::default()));
    let metered = MeteredSql { inner: snapshot, counts: counts.clone() };
    let records = LegacyRecords::open_source(metered, old_bounds).map_err(|error| format!("old records: {error}"))?;
    let kept = LegacyKept::new(Limits::default()).map_err(|_| "kept limits")?;
    let mut old = Old { records, kept, ids_limits, counts };

    // The migrated record store copy with the native host's limits.
    let record_store_path = std::fs::canonicalize(PathBuf::from(record_store))?;
    let bounds = sqlite::Bounds {
        value_bytes: 64 * 1024 * 1024,
        work: u64::MAX / 2,
        deadline: Duration::MAX,
        spend: Spend::EachOperation,
        cancel: None,
        busy: Duration::from_secs(5),
    };
    let supply = sqlite::open_owned(&record_store_path, "record_store", bounds)?;
    let store = record_store_resources::native(MeteredStorage { inner: supply, counts: Cell::new(Counts::default()) }, &record_store_path)?;
    let mut new = New { seam: RecordStoreCurrent::new(store, &owner, "own-records") };
    // A store migrated before an order was declared fills it once (`fill_order`), a bounded step at a time.
    let (filling, mut steps) = (Instant::now(), 0);
    for declared in &settings::shipped().ok_or("shipped settings")?.orders {
        loop {
            steps += 1;
            if new.seam.store.fill_order(&owner, "own-records", &declared.order, MAX_PAGE_ITEMS)? {
                break;
            }
        }
    }
    let fill = serde_json::json!({ "steps": steps, "ms": filling.elapsed().as_secs_f64() * 1000.0 });

    let mut report = vec![
        Request { request: "viewer", reads_own_records: false, note: "session, gate and receipt settings only (src/workspace_startup.rs)", old: None, old_with_record_store_ids: None, record_store: None, same_answer: None },
        Request { request: "show-rules", reads_own_records: false, note: "workspace_records table or app_kv (src/local_account/show_rules.rs); unchanged by the switch", old: None, old_with_record_store_ids: None, record_store: None, same_answer: None },
        Request { request: "screens", reads_own_records: false, note: "workshop_current/workshop_facts tables (src/local_account/tool_fact_page.rs); unchanged by the switch", old: None, old_with_record_store_ids: None, record_store: None, same_answer: None },
    ];
    type Shape = fn(&mut Run<'_>) -> Result<(), String>;
    let shapes: [(&'static str, &'static str, Shape); 3] = [
        ("pursuits", "space settings, every pursuit (pages of 64) with its record scope, relay setting", pursuits),
        ("needs-you-hold", "setting:needs_you_hold", hold),
        ("decisions", "100 newest decisions by id with steps, calls and cited pursuits; 101 pursuits; plan existence; agent-work settings", decisions),
    ];
    for (request, note, shape) in shapes {
        let old_measured = measure(&mut old, shape);
        let mut recording = Recording { side: &mut new, pages: Vec::new(), ordered: Vec::new() };
        let new_measured = measure(&mut recording, shape);
        let (pages, ordered) = (recording.pages.into_iter(), recording.ordered.into_iter());
        let with_ids = measure(&mut OldWithIds { old: &mut old, pages, ordered }, shape);
        let same = with_ids.refused.is_none() && new_measured.refused.is_none();
        let same_answer = same.then(|| with_ids.answer == new_measured.answer);
        report.push(Request {
            request,
            reads_own_records: true,
            note,
            old: Some(old_measured),
            old_with_record_store_ids: Some(with_ids),
            record_store: Some(new_measured),
            same_answer,
        });
    }
    let order = decision_order(&mut old, &mut new).map_err(|error| format!("decision order check: {error}"))?;
    println!("{}", serde_json::to_string_pretty(&serde_json::json!({ "requests": report, "decision_order": order, "order_fill": fill }))?);
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("record_store_native_serve_probe refused: {error}");
        std::process::exit(1);
    }
}
