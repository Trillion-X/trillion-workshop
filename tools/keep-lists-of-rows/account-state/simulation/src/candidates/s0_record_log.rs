//! S0 (record layer): today's Rust record engine exactly as it exists —
//! `local_engine::record_log::RecordLog` over `kept_runs`, one store per
//! resource, metered through `sqlite_work` on the same connection.
//!
//! Scope of this reference, stated so nobody reads more into it:
//! - It is the RECORD LAYER of S0 only. S0's measured overhead families
//!   (quota/grants, runtime catalogue, per-query policy SQL, command
//!   lifecycle) live outside `RecordLog` and are not simulated here.
//! - `RecordLog` exposes no list/range, search or erase-by-owner API (its
//!   `KeptRuns` is private and `record_indexes` is not wired into it), so
//!   those intents are reported `unsupported` with that reason, never zero.
//! - Admission is a permissive fixture: fresh-rights work (layer O2) is not
//!   measured for any candidate.
//!
//! Params (`candidates/s0-*.json`): `alarm` = null (no alarm) or
//! `{"every_seconds": N, "rearm": "always" | "while_pending"}`. `always`
//! models today's free-running maintenance wake; `while_pending` arms only
//! when an unflushed memtable exists (layer O6). `memtable_bytes` overrides
//! the kept-runs memtable capacity.
//!
//! The engine merges kept runs inside its writes (`KeptRuns::maintain`), so
//! both S0 and S1 (`s1_record_log`, which reuses this store with no alarm)
//! report `merge_pages`, `merge_steps`, `maintenance_refused` per operation and
//! the `kept_runs` gauge (runs summed over stores).

use local_engine::{
    kept_runs::Settings,
    record_log::{
        self, Admission, Context, LogIds, Projected, RecordInput, RecordLog, Request, Scope,
        ValueText,
    },
    record_stamps::Fields,
    sqlite_work::WorkMeter,
};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use workload_simulation::{
    Candidate, Capability, Intent, Interrupt, Meters, Opened, Operation, Outcome, Reply, SimTime,
    Store, StoreContext, StoreError,
};

use crate::meter::{err, MeteredDb, ReadCause, SQLITE_METERS};

/// RecordLog's Display masks storage causes ("outcome unknown"); the Debug
/// form keeps the SQLite/kept-runs cause, which carries no record values.
fn engine_err(e: record_log::Error) -> StoreError {
    StoreError(format!("{e}: {e:?}"))
}

/// `RecordLog`'s contract for `ReplayRequired`: the journal tail since the last
/// published run is longer than one call replays (after a rolled-back write
/// the projection is rebuilt from that marker), so the caller runs `recover`
/// until it reports done and calls again. A host does the same.
fn caught_up<T>(
    log: &mut RecordLog,
    mut call: impl FnMut(&mut RecordLog) -> record_log::Result<T>,
) -> Result<T, StoreError> {
    match call(log) {
        Err(record_log::Error::ReplayRequired) => {
            while !log.recover(&Text).map_err(engine_err)? {}
            call(log).map_err(engine_err)
        }
        other => other.map_err(engine_err),
    }
}

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
    #[serde(default)]
    pub alarm: Option<AlarmPolicy>,
    #[serde(default)]
    pub memtable_bytes: Option<usize>,
}

#[derive(Clone, Copy, Debug, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct AlarmPolicy {
    pub every_seconds: u64,
    pub rearm: Rearm,
}

#[derive(Clone, Copy, Debug, Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Rearm {
    Always,
    WhilePending,
}

pub struct S0 {
    id: String,
    params: Params,
}

impl S0 {
    pub fn new(id: String, params: Value) -> Result<Self, StoreError> {
        Ok(Self {
            id,
            params: serde_json::from_value(params).map_err(err)?,
        })
    }
}

/// Per-operation meters from `record_log::Work.maintenance`, beside the SQLite ones.
pub const MERGE_PAGES: &str = "merge_pages";
pub const MERGE_STEPS: &str = "merge_steps";
pub const MAINTENANCE_REFUSED: &str = "maintenance_refused";
/// Gauge: kept runs held, summed over stores.
pub const KEPT_RUNS: &str = "kept_runs";

/// Where a table's written rows go in the cause split.
pub fn classify(table: &str) -> &'static str {
    match table {
        "record_log" => "record",
        "record_log_binding" => "bookkeeping",
        t if t.starts_with("record_keys_run_") || t == "record_keys_big" => "page_flush",
        t if t.starts_with("record_keys") => "maintenance",
        _ => "unclassified",
    }
}

struct Text;
impl ValueText for Text {
    fn encode(&self, value: &Value) -> record_log::Result<String> {
        Ok(serde_json::to_string(value)?)
    }
}
struct Permit;
impl Admission for Permit {
    fn assert_current(&self, _: &Scope, _: &Request, _: &str) -> bool {
        true
    }
    fn validate_prepared(
        &self,
        _: &Scope,
        _: &[RecordInput],
        _: &std::collections::BTreeMap<String, Option<Projected>>,
    ) -> bool {
        true
    }
}

/// Canonical UUIDv7 identities from simulated time and the store sequence:
/// 48-bit Unix ms, version 7, 12 bits of sequence, variant 8, 62 bits more.
struct Ids {
    ms: u64,
    seq: u64,
    n: u64,
}
impl LogIds for Ids {
    fn next_log_id(&mut self) -> Option<String> {
        let s = self.seq.wrapping_mul(16).wrapping_add(self.n);
        self.n += 1;
        Some(format!(
            "{:08x}-{:04x}-7{:03x}-8{:03x}-{:012x}",
            self.ms >> 16,
            self.ms & 0xffff,
            s & 0xfff,
            (s >> 12) & 0xfff,
            (s >> 24) & 0xffff_ffff_ffff
        ))
    }
}

fn scope(index: u32) -> Scope {
    Scope {
        account: "simulated-account".into(),
        resource: format!("simulated-resource-{index}"),
    }
}

fn fields(value: &Value) -> Fields {
    value
        .as_object()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

fn as_value(p: Option<Projected>) -> Option<Value> {
    let fields = p?.kept.value?;
    Some(Value::Object(
        fields
            .iter()
            .map(|(k, v)| (k.to_owned(), v.clone()))
            .collect::<Map<_, _>>(),
    ))
}

/// Field order: the engine (borrowing the handle) drops before its owner.
struct Engine {
    log: RecordLog,
    db: MeteredDb,
}

pub struct S0Store {
    engine: Option<Engine>,
    inspector: Option<RecordLog>,
    path: PathBuf,
    scope: Scope,
    settings: Settings,
    meter: WorkMeter,
    alarm: Option<AlarmPolicy>,
    pending: bool,
    next_alarm: Option<SimTime>,
    /// Latest simulated time this store has seen (re-arming after recovery).
    now: SimTime,
    /// Merge work reported by writes since the operation's meters were last cut.
    maintenance: Meters,
}

impl Drop for S0Store {
    fn drop(&mut self) {
        self.teardown();
    }
}

impl S0Store {
    fn open_engine(&self, create: bool) -> Result<(Engine, Meters), StoreError> {
        let db = MeteredDb::open(&self.path, self.meter.clone(), classify)?;
        let mut spans = db.spans()?;
        // SAFETY: `Engine` drops `log` before `db`, and teardown releases hooks first.
        let borrowed = unsafe { db.borrowed_connection()? };
        let mut log = if create {
            RecordLog::create(borrowed, self.scope.clone(), self.settings.clone())
        } else {
            RecordLog::reopen(borrowed, self.scope.clone(), self.settings.clone())
        }
        .map_err(err)?;
        if !create {
            while !log.recover(&Text).map_err(err)? {}
        }
        let mut engine = Engine { log, db };
        spans.cut(ReadCause::Families)?;
        let m = engine.db.finish(spans)?;
        Ok((engine, m))
    }

    fn teardown(&mut self) {
        self.inspector = None;
        if let Some(e) = self.engine.take() {
            e.db.release_hooks();
            drop(e);
        }
    }

    fn engine(&mut self) -> Result<&mut Engine, StoreError> {
        self.engine
            .as_mut()
            .ok_or_else(|| StoreError("store is crashed".into()))
    }

    fn request(op: &Operation) -> Request {
        Request {
            key: op.request_key.clone(),
            sent_at_ms: op.at.unix_ms() as i64,
        }
    }

    fn write(&mut self, op: &Operation, records: Vec<RecordInput>) -> Result<bool, StoreError> {
        let ctx = Context {
            actor: json!({"actor": op.actor}),
            application_time: op.at.iso8601(),
            system_time: op.at.iso8601(),
            accepted_at_ms: op.at.unix_ms() as i64,
        };
        let mut ids = Ids {
            ms: op.at.unix_ms(),
            seq: op.sequence,
            n: 0,
        };
        let r = Self::request(op);
        let e = self.engine()?;
        let w = caught_up(&mut e.log, |log| {
            log.write(&records, &r, &ctx, &Permit, &Text, &mut ids)
        })?;
        self.pending = w.work.pending_memtable_bytes_after > 0;
        let m = &w.work.maintenance;
        self.maintenance.add(MERGE_PAGES, m.pages as u64);
        self.maintenance
            .add(MERGE_STEPS, u64::from(m.pages > 0 || m.entries > 0));
        self.maintenance.add(
            MAINTENANCE_REFUSED,
            u64::from(w.work.maintenance_refused.is_some()),
        );
        Ok(w.duplicate)
    }

    /// Current (kind, value) through the measured engine.
    fn read(&mut self, op: &Operation, key: &str) -> Result<Option<(String, Value)>, StoreError> {
        let r = Request {
            key: format!("{}-read-{key}", op.request_key),
            sent_at_ms: op.at.unix_ms() as i64,
        };
        let e = self.engine()?;
        let p = caught_up(&mut e.log, |log| log.read(key, &r, &Permit, &Text))?.record;
        let kind = p
            .as_ref()
            .and_then(|p| p.kept.record_type.clone())
            .unwrap_or_default();
        Ok(as_value(p).map(|v| (kind, v)))
    }

    /// After a write: arm a wake only if none is armed and the policy wants one
    /// (a DO arms `setAlarm` once, it does not move it on every write).
    fn after_write(&mut self, now: SimTime) {
        self.now = now;
        if self.next_alarm.is_none() {
            if let Some(a) = self.alarm {
                if a.rearm == Rearm::Always || self.pending {
                    self.next_alarm = Some(now.plus_ms(a.every_seconds * 1000));
                }
            }
        }
    }

    /// After a wake: the free-running policy always re-arms; the
    /// work-triggered policy re-arms only while unflushed records remain.
    fn after_wake(&mut self, now: SimTime) {
        self.now = now;
        self.next_alarm = self.alarm.and_then(|a| {
            (a.rearm == Rearm::Always || self.pending).then(|| now.plus_ms(a.every_seconds * 1000))
        });
    }

    fn run(&mut self, op: &Operation) -> Result<(Reply, bool), StoreError> {
        let missing = || StoreError("record is absent".into());
        let one = |id: &str, kind: String, value: Option<&Value>| {
            vec![RecordInput {
                id: id.to_owned(),
                record_type: kind,
                value: value.map(fields),
            }]
        };
        Ok(match &op.intent {
            Intent::Create {
                key, kind, value, ..
            } => (
                Reply::Nothing,
                self.write(op, one(key, kind.clone(), Some(value)))?,
            ),
            Intent::Read { key } => (Reply::Value(self.read(op, key)?.map(|(_, v)| v)), false),
            Intent::Update { key, field, value } => {
                let (kind, mut next) = self.read(op, key)?.ok_or_else(missing)?;
                next[field.as_str()] = value.clone();
                (Reply::Nothing, self.write(op, one(key, kind, Some(&next)))?)
            }
            Intent::WriteMember {
                key,
                field,
                index,
                value,
            } => {
                let (kind, mut next) = self.read(op, key)?.ok_or_else(missing)?;
                let slot = next
                    .get_mut(field.as_str())
                    .and_then(Value::as_array_mut)
                    .and_then(|l| l.get_mut(*index as usize))
                    .ok_or_else(|| StoreError("member out of range".into()))?;
                *slot = value.clone();
                (Reply::Nothing, self.write(op, one(key, kind, Some(&next)))?)
            }
            // Named by id alone, so a retry after a committed removal reaches
            // the engine's request receipt instead of a read of a gone record.
            Intent::Delete { key } => (
                Reply::Nothing,
                self.write(op, vec![RecordInput::remove(key.as_str())])?,
            ),
            Intent::List { .. } | Intent::Search { .. } | Intent::EraseOwner { .. } => {
                return Err(StoreError("unsupported intent reached the engine".into()))
            }
        })
    }
}

impl Candidate for S0 {
    fn id(&self) -> &str {
        &self.id
    }
    fn about(&self) -> String {
        "S0 record layer: record_log::RecordLog + kept_runs of the parent crate, one store per resource"
            .into()
    }
    fn meters(&self) -> Vec<&'static str> {
        meters()
    }
    fn capabilities(&self) -> Vec<Capability> {
        capabilities()
    }
    fn params(&self) -> Value {
        serde_json::to_value(&self.params).unwrap_or(Value::Null)
    }
    fn open(&self, ctx: StoreContext) -> Result<Opened, StoreError> {
        let mut settings = Settings::default();
        if let Some(b) = self.params.memtable_bytes {
            settings.memtable_bytes = b;
        }
        open(settings, self.params.alarm, ctx)
    }
}

/// The SQLite meters plus the record log's merge meters.
pub fn meters() -> Vec<&'static str> {
    let mut m = SQLITE_METERS.to_vec();
    m.extend([MERGE_PAGES, MERGE_STEPS, MAINTENANCE_REFUSED, KEPT_RUNS]);
    m
}

/// What the record log can and cannot do, shared by every candidate over it.
pub fn capabilities() -> Vec<Capability> {
    let c = |name: &str, supported: bool, note: &str| Capability {
        name: name.into(),
        supported,
        note: note.into(),
    };
    vec![
        c("point_read", true, "RecordLog::read"),
        c(
            "whole_and_delta_writes",
            true,
            "RecordLog::write builds delta envelopes",
        ),
        c(
            "request_idempotency",
            true,
            "10-minute request receipts in kept keys",
        ),
        c(
            "field_stamps_history_log",
            true,
            "journal envelopes with prior/was/stamps",
        ),
        c(
            "list_newest_by_kind",
            false,
            "RecordLog has no public range; KeptRuns is private",
        ),
        c(
            "search",
            false,
            "no word index; record_indexes is not wired into RecordLog",
        ),
        c(
            "erase_owner",
            false,
            "no owner lookup; append-only journal keeps every envelope",
        ),
        c(
            "fresh_rights_admission",
            false,
            "fixture admission; layer O2 not measured",
        ),
    ]
}

/// One record-log store per resource. `alarm` = None arms no wake ever: the
/// memtable is published when full and runs merge inside writes.
pub fn open(
    settings: Settings,
    alarm: Option<AlarmPolicy>,
    ctx: StoreContext,
) -> Result<Opened, StoreError> {
    let mut store = S0Store {
        engine: None,
        inspector: None,
        path: ctx.dir.join("store.sqlite"),
        scope: scope(ctx.index),
        settings,
        meter: WorkMeter::new(),
        alarm,
        pending: false,
        next_alarm: None,
        now: SimTime(0),
        maintenance: Meters::new(),
    };
    let (engine, meters) = store.open_engine(true)?;
    store.engine = Some(engine);
    store.after_write(SimTime(0));
    Ok(Opened {
        store: Box::new(store),
        meters,
    })
}

impl Store for S0Store {
    fn load(&mut self, ops: &[Operation]) -> Result<Meters, StoreError> {
        let mut spans = self.engine()?.db.spans()?;
        // Groups of <= 256 records and <= half the 8 MiB bound; each group is
        // one write under the request key of its first record.
        let mut group: Vec<RecordInput> = Vec::new();
        let mut first: Option<&Operation> = None;
        let mut bytes = 0usize;
        for op in ops {
            if let Intent::Create {
                key, kind, value, ..
            } = &op.intent
            {
                let size = serde_json::to_vec(value).map_err(err)?.len();
                if !group.is_empty()
                    && (group.len() == record_log::MAX_BATCH_RECORDS
                        || bytes + size > record_log::MAX_BATCH_BYTES / 2)
                {
                    let head = first.take().expect("group has a first record");
                    self.write(head, std::mem::take(&mut group))?;
                    bytes = 0;
                }
                first.get_or_insert(op);
                bytes += size;
                group.push(RecordInput {
                    id: key.clone(),
                    record_type: kind.clone(),
                    value: Some(fields(value)),
                });
            }
        }
        if let Some(head) = first {
            self.write(head, group)?;
        }
        spans.cut(ReadCause::Families)?;
        let mut m = self.engine()?.db.finish(spans)?;
        m.merge(&std::mem::take(&mut self.maintenance));
        Ok(m)
    }

    fn apply(&mut self, op: &Operation, fault: Option<Interrupt>) -> Outcome {
        if matches!(
            op.intent,
            Intent::List { .. } | Intent::Search { .. } | Intent::EraseOwner { .. }
        ) {
            return Outcome::Unsupported {
                reason: "RecordLog exposes no list/search/erase-by-owner (KeptRuns private, record_indexes not wired)"
                    .into(),
            };
        }
        let mut spans = match self.engine().and_then(|e| e.db.spans()) {
            Ok(s) => s,
            Err(e) => {
                return Outcome::Failed {
                    error: e.0,
                    meters: Meters::new(),
                }
            }
        };
        if let Ok(e) = self.engine() {
            e.db.arm(fault);
        }
        let result = self.run(op);
        let mut interrupted = false;
        let maintenance = std::mem::take(&mut self.maintenance);
        let meters = match self.engine() {
            Ok(e) => {
                interrupted = e.db.disarm();
                match spans
                    .cut(ReadCause::Families)
                    .and_then(|_| e.db.finish(spans))
                {
                    Ok(mut m) => {
                        m.merge(&maintenance);
                        m
                    }
                    Err(c) => {
                        return Outcome::Failed {
                            error: c.0,
                            meters: Meters::new(),
                        }
                    }
                }
            }
            Err(_) => Meters::new(),
        };
        if interrupted && result.is_err() {
            return Outcome::Failed {
                error: "interrupted mid-statement".into(),
                meters,
            };
        }
        if !matches!(op.intent, Intent::Read { .. }) {
            self.after_write(op.at);
        }
        match result {
            Ok((reply, duplicate)) => Outcome::Acked {
                reply,
                duplicate,
                meters,
            },
            Err(e) => Outcome::Failed { error: e.0, meters },
        }
    }

    fn alarm(&mut self, now: SimTime) -> Result<Meters, StoreError> {
        let mut m = Meters::new();
        if self.pending {
            let e = self.engine()?;
            let mut spans = e.db.spans()?;
            caught_up(&mut e.log, |log| log.checkpoint_measured(&Text))?;
            spans.cut(ReadCause::Families)?;
            m = e.db.finish(spans)?;
            self.pending = false;
        }
        self.after_wake(now);
        Ok(m)
    }

    fn next_alarm(&self) -> Option<SimTime> {
        self.next_alarm
    }

    fn crash(&mut self) {
        self.teardown();
    }

    fn recover(&mut self) -> Result<Meters, StoreError> {
        let (engine, meters) = self.open_engine(false)?;
        self.engine = Some(engine);
        // The replayed tail lives in the memtable again until flushed.
        self.pending = true;
        self.after_write(self.now);
        Ok(meters)
    }

    fn inspect(&mut self, key: &str) -> Result<Option<Value>, StoreError> {
        // A separate connection and RecordLog: sees exactly the committed log,
        // and never warms or perturbs the measured engine's caches.
        if self.inspector.is_none() {
            let c = Connection::open(&self.path).map_err(err)?;
            self.inspector =
                Some(RecordLog::reopen(c, self.scope.clone(), self.settings.clone()).map_err(err)?);
        }
        let log = self.inspector.as_mut().expect("opened");
        let request = Request {
            key: format!("oracle-{key}"),
            sent_at_ms: 0,
        };
        loop {
            match log.read(key, &request, &Permit, &Text) {
                Ok(r) => return Ok(as_value(r.record)),
                Err(record_log::Error::ReplayRequired) => {
                    while !log.recover(&Text).map_err(err)? {}
                }
                Err(e) => return Err(err(e)),
            }
        }
    }

    fn gauges(&mut self) -> Result<Meters, StoreError> {
        let e = self.engine()?;
        let mut m = e.db.gauges()?;
        m.add(KEPT_RUNS, e.log.held().runs as u64);
        Ok(m)
    }

    fn files(&self) -> Vec<PathBuf> {
        self.engine
            .as_ref()
            .map(|e| e.db.files())
            .unwrap_or_default()
    }
}
