//! Purpose: the record log's kept runs stay bounded however long it is written.
//! Every checkpoint publishes one run. Without merges the run count grows with
//! every checkpoint until each write's request-window range needs more cursor
//! workspace than `cache_bytes`, and every save is refused with
//! `Kept(Bounds("kept range cursor workspace exhausted..."))` (found by the
//! storage simulator: ordinary saves failed from day 7 with hourly checkpoints).
//! Invariants checked: every save and read succeeds; the run count stays under
//! the merge policy's bound; merge work happens only inside saves (a checkpoint
//! or a read never merges); a restart mid-merge resumes it.
//! Security: synthetic fixture scope, permissive admission, serde value text.
use rusqlite::Connection;
use serde_json::{json, Value};
use trillion_local::{
    kept_runs::Settings,
    record_log::{
        Admission, Context, Error, LogIds, Projected, RecordInput, RecordLog, Request, Scope,
        ValueText, Work,
    },
};

struct Text;
impl ValueText for Text {
    fn encode(&self, value: &Value) -> Result<String, Error> {
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
struct Ids(u64);
impl LogIds for Ids {
    fn next_log_id(&mut self) -> Option<String> {
        self.0 += 1;
        Some(format!("{:08x}-0000-7000-8000-000000000000", self.0))
    }
}
fn scope() -> Scope {
    Scope {
        account: "fixture-account".into(),
        resource: "fixture-resource".into(),
    }
}
/// Small pages and a small cursor workspace so the run-count limit is reached
/// in tens of checkpoints instead of the simulator's days.
fn settings() -> Settings {
    Settings {
        page_bytes: 4096,
        max_key_bytes: 1024,
        cache_bytes: 64 * 1024,
        ..Settings::default()
    }
}
const MINUTE_MS: i64 = 60_000;
/// Per-save projection reads stay flat however many saves came before: per
/// key a save looks up (each record, plus the request window's five keys).
const MAX_ROWS_PER_LOOKUP: u64 = 16;
const MAX_ENTRIES_PER_LOOKUP: u64 = 32;

struct Writer {
    log: RecordLog,
    ids: Ids,
    path: std::path::PathBuf,
    settings: Settings,
}
impl Writer {
    fn create(path: std::path::PathBuf, settings: Settings) -> Self {
        let log =
            RecordLog::create(Connection::open(&path).unwrap(), scope(), settings.clone()).unwrap();
        Self { log, ids: Ids(0), path, settings }
    }
    /// Drop the open store (a restart: memtable and in-memory merge filter are
    /// lost) and replay the journal tail.
    fn restart(&mut self) {
        self.log = RecordLog::reopen(
            Connection::open(&self.path).unwrap(),
            scope(),
            self.settings.clone(),
        )
        .unwrap();
        while !self.log.recover(&Text).unwrap() {}
    }
    fn save(&mut self, n: u64, ids: &[String], body: &str) -> Work {
        self.save_at(n, 1_000_000 + n as i64 * MINUTE_MS, ids, body)
    }
    fn save_at(&mut self, n: u64, at: i64, ids: &[String], body: &str) -> Work {
        let inputs: Vec<RecordInput> = ids
            .iter()
            .map(|id| RecordInput {
                id: id.clone(),
                record_type: "note".into(),
                value: Some(
                    [
                        ("title".to_string(), json!(format!("save {n}"))),
                        ("body".to_string(), json!(body)),
                    ]
                    .into_iter()
                    .collect(),
                ),
            })
            .collect();
        let request = Request {
            key: format!("request-{n}"),
            sent_at_ms: at,
        };
        let context = Context {
            actor: json!({"person": "fixture"}),
            application_time: "2026-10-27T12:00:00Z".into(),
            system_time: "2026-10-27T12:00:00Z".into(),
            accepted_at_ms: at,
        };
        let work = match self
            .log
            .write(&inputs, &request, &context, &Permit, &Text, &mut self.ids)
        {
            Ok(written) => written.work,
            Err(e) => panic!("save {n} refused: {e:?}"),
        };
        assert_eq!(work.maintenance_refused, None, "save {n}");
        let lookups = ids.len() as u64 + 5;
        assert!(work.selected.rows_fetched <= MAX_ROWS_PER_LOOKUP * lookups, "save {n}: {work:?}");
        assert!(work.selected.entries_examined <= MAX_ENTRIES_PER_LOOKUP * lookups, "save {n}: {work:?}");
        // Past the backlog bound: one paused group, one running backlog group,
        // and the runs that arrive while it runs (steps grow per run behind).
        let bound = self.settings.merge_backlog_runs + 2 * self.settings.fan_in;
        assert!(self.log.held().runs <= bound, "save {n}: {} runs", self.log.held().runs);
        work
    }
    fn title(&mut self, id: &str, n: u64) -> Option<Value> {
        let request = Request {
            key: format!("read-{n}"),
            sent_at_ms: 1_000_000 + n as i64 * MINUTE_MS,
        };
        let record = self.log.read(id, &request, &Permit, &Text).unwrap().record?;
        record.kept.value?.get("title").cloned()
    }
}

/// One save then one checkpoint, over and over: the shape of an hourly
/// checkpoint with little traffic, the worst case for run growth. Before
/// merges ran inside saves, save 38 was refused here.
#[test]
fn checkpoint_after_every_save_never_refuses_a_save() {
    let dir = tempfile::tempdir().unwrap();
    let mut writer = Writer::create(dir.path().join("records.sqlite"), settings());
    let mut merged = 0;
    for n in 0..1500u64 {
        let id = format!("record-{}", n % 40);
        let work = writer.save(n, std::slice::from_ref(&id), "");
        merged += work.maintenance.pages;
        // A checkpoint publishes exactly its own run and merges nothing.
        let runs = writer.log.held().runs;
        let flushed = writer.log.checkpoint(&Text).unwrap();
        assert_eq!(writer.log.held().runs, runs + usize::from(flushed.run.is_some()));
        // A read merges nothing either.
        assert_eq!(writer.title(&id, n), Some(json!(format!("save {n}"))));
        assert_eq!(writer.log.held().runs, runs + usize::from(flushed.run.is_some()));
    }
    assert!(merged > 0);
}

/// Multi-page runs, a slow pace (merges span many saves), a backlog bound at
/// `fan_in` (backlog groups pause running merges) and a restart every 97 saves
/// (in-progress and paused merges resume from their persisted cursors).
#[test]
fn merges_spanning_saves_survive_restarts_and_backlog_pauses() {
    let dir = tempfile::tempdir().unwrap();
    let settings = Settings {
        merge_pace: 1,
        merge_backlog_runs: 4,
        ..settings()
    };
    let mut writer = Writer::create(dir.path().join("records.sqlite"), settings);
    let body = "x".repeat(300);
    let (mut started, mut paused, mut completed) = (0, 0, 0);
    let mut latest = std::collections::BTreeMap::new();
    for n in 0..1200u64 {
        let ids: Vec<String> = (0..12).map(|i| format!("record-{}", (n * 7 + i) % 500)).collect();
        let work = writer.save(n, &ids, &body);
        started += usize::from(work.maintenance.started);
        paused += usize::from(work.maintenance.paused);
        completed += usize::from(work.maintenance.completed);
        for id in &ids {
            latest.insert(id.clone(), n);
        }
        if n % 3 == 0 {
            writer.log.checkpoint(&Text).unwrap();
        }
        if n % 97 == 96 {
            writer.restart();
        }
    }
    assert!(started > 0 && paused > 0 && completed > 0, "{started} {paused} {completed}");
    writer.restart();
    for (id, n) in latest {
        assert_eq!(writer.title(&id, 2000), Some(json!(format!("save {n}"))), "{id}");
    }
}

/// Ten saves a minute against the ten-minute request window: every save
/// removes the request keys that left the window, so their tombstones pile up
/// at the low end of the window's key range in runs that merge only rarely
/// with the runs holding the removed keys. A save must never walk them (before
/// the window kept its removed head, save 208 examined more than the bound).
#[test]
fn request_window_never_rescans_removed_requests() {
    let dir = tempfile::tempdir().unwrap();
    let mut writer = Writer::create(dir.path().join("records.sqlite"), settings());
    for n in 0..2500u64 {
        let id = format!("record-{}", n % 300);
        writer.save_at(n, 1_000_000 + n as i64 * 6_000, std::slice::from_ref(&id), "");
        if n % 4 == 3 {
            writer.log.checkpoint(&Text).unwrap();
        }
    }
}
