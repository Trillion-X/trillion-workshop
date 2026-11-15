//! Synthetic M11 adoption histories. No personal account is opened.
use std::{
    cell::Cell as Counter,
    collections::HashSet,
    sync::{Arc, Mutex},
};
use trillion_local::storage::record_store_resources::carry::live_adopt::{
    self as adopt, Cell, Effect, Fence, FenceGuard, Limits, Plan, Selection,
};
use trillion_local::storage::{
    self, memory::Memory, Error, Intent, Range, Read, Result, Row, Storage, Value, When,
};

struct Authority(Arc<Mutex<HashSet<String>>>);
struct Held;
impl FenceGuard for Held {}
impl Fence for Authority {
    fn hold(&self, epoch: &str) -> Result<Box<dyn FenceGuard + '_>> {
        if self.0.lock().unwrap().contains(epoch) {
            Ok(Box::new(Held))
        } else {
            Err(trillion_local::cause!(Error::Moved))
        }
    }
}
impl adopt::portable::ActivationGuard for Held {
    fn mark_outcome_unknown(&self) {}
}
impl adopt::portable::TargetAuthority for Authority {
    fn hold_current(&self, incarnation: &str) -> Result<Box<dyn adopt::portable::ActivationGuard>> {
        self.hold(incarnation)?;
        Ok(Box::new(Held))
    }
}
fn authority() -> Authority {
    Authority(Arc::new(Mutex::new(
        ["source-1".into(), "target-2".into()].into(),
    )))
}
fn storage_bounds() -> storage::sqlite::Bounds {
    storage::sqlite::Bounds {
        value_bytes: 1024 * 1024,
        work: u64::MAX / 2,
        deadline: std::time::Duration::MAX,
        spend: storage::sqlite::Spend::EachOperation,
        cancel: None,
        busy: std::time::Duration::from_millis(50),
    }
}
fn limits() -> Limits {
    Limits {
        page_rows: 2,
        page_bytes: 700,
        commit_bytes: 4096,
        capture_bytes: 1024 * 1024,
    }
}
fn plan() -> Plan {
    Plan {
        slot: "command-closure".into(),
        move_id: "move-1".into(),
        source_incarnation: "source-1".into(),
        target_incarnation: "target-2".into(),
        selections: vec![
            Selection {
                family: "versions".into(),
                prefix: vec![Cell::Text("synthetic".into()), Cell::Text("domain".into())],
            },
            Selection {
                family: "kept_shared_objects".into(),
                prefix: vec![Cell::Text("synthetic".into()), Cell::Text("domain".into())],
            },
        ],
    }
}
fn effect(id: &str, version: i64) -> Effect {
    let row = vec![
        Cell::Text("synthetic".into()),
        Cell::Text("domain".into()),
        Cell::Text(id.into()),
        Cell::Integer(i64::MAX),
        Cell::Integer(version),
        Cell::Integer(version),
        Cell::Integer(0),
        Cell::Blob(vec![version as u8; 90]),
        Cell::Text(format!("receipt-{id}-{version}")),
        Cell::Text("synthetic-kind".into()),
    ];
    Effect {
        family: "versions".into(),
        key: row[..4].to_vec(),
        row: Some(row),
    }
}
fn key(id: &str) -> Vec<Value> {
    vec![
        "synthetic".into(),
        "domain".into(),
        id.into(),
        i64::MAX.into(),
    ]
}
fn raw(store: &dyn Storage, effect: &Effect) {
    let family = store.schema().family(&effect.family).unwrap();
    let row: Vec<_> = family
        .fields
        .iter()
        .map(String::as_str)
        .zip(effect.row.clone().unwrap().into_iter().map(Value::from))
        .collect();
    store.put(&effect.family, &row, When::Always).unwrap();
}
fn setup(source: &dyn Storage, target: &dyn Storage) -> (Plan, Authority) {
    let plan = plan();
    let authority = authority();
    for id in ["b", "d", "f", "h"] {
        raw(source, &effect(id, 1));
    }
    // Attached field-key/receipt/index material travels verbatim, never recreated as user writes.
    source
        .put(
            "kept_shared_objects",
            &[
                ("account", "synthetic".into()),
                ("resource", "domain".into()),
                ("id", "attached-key".into()),
                ("body", Value::Blob(vec![3, 7, 9])),
            ],
            When::New,
        )
        .unwrap();
    adopt::prepare(source, &plan, true, limits(), &authority).unwrap();
    adopt::prepare(target, &plan, false, limits(), &authority).unwrap();
    (plan, authority)
}
fn finish(source: &dyn Storage, target: &dyn Storage, plan: &Plan, authority: &Authority) {
    while adopt::copy_step(source, target, plan, limits(), authority).unwrap() {}
    adopt::seal(source, plan, authority).unwrap();
    while adopt::replay_step(source, target, plan, limits(), authority).unwrap() {}
    while adopt::verify_step(source, target, plan, limits(), authority).unwrap() {}
    adopt::activate(source, target, plan, limits(), authority).unwrap();
}
fn assert_value(store: &dyn Storage, id: &str, version: Option<i64>) {
    let got = store
        .get("versions", &key(id), &[Read::whole("version")])
        .unwrap();
    assert_eq!(got.map(|r| r.0[0].as_integer().unwrap()), version, "{id}");
}
#[test]
fn portable_turns_use_one_supply_preserve_late_complete_commands_and_retry_saved_cursors() {
    use adopt::portable::{self, Accepted};
    let source = Memory::open("record_store").unwrap();
    let target = Memory::open("record_store").unwrap();
    let (plan, authority) = setup(&source, &target);
    let request = portable::request(&target, &plan, limits(), &authority).unwrap().unwrap();
    let response = portable::export(&source, &plan, &request, limits(), &authority).unwrap();
    assert!(response.len() <= limits().commit_bytes);
    portable::accept(&target, &plan, &response, limits(), &authority).unwrap();
    assert_eq!(portable::accept(&target, &plan, &response, limits(), &authority).unwrap(), Accepted::Duplicate);
    let mut changed: portable::Response = serde_json::from_slice(&response).unwrap();
    changed.effects[0] = effect("forged", 9);
    assert!(portable::accept(&target, &plan, &serde_json::to_vec(&changed).unwrap(), limits(), &authority).is_err());
    let mut deleted = effect("b", 1); deleted.row = None;
    adopt::commit(&source, &plan, limits(), &authority, |_| Ok(vec![effect("a", 2), deleted, effect("d", 3)])).unwrap();
    let mut sealed = None;
    let mut turns = 0;
    while let Some(request) = portable::request(&target, &plan, limits(), &authority).unwrap() {
        assert!(turns < 100); turns += 1;
        let response = portable::export(&source, &plan, &request, limits(), &authority).unwrap();
        if matches!(portable::accept(&target, &plan, &response, limits(), &authority).unwrap(), Accepted::AwaitSeal { through: 1 }) {
            sealed = Some(portable::seal_reply(&source, &plan, limits(), &authority).unwrap());
        }
    }
    assert!(matches!(adopt::recover(&target, &plan, &authority).unwrap(), adopt::Progress::Ready { sealed_through: 1 }));
    let seal = sealed.unwrap();
    assert_eq!(portable::activate(&target, &plan, &seal, limits(), &authority, |_| Err(trillion_local::cause!(Error::Conflict))), Err(trillion_local::cause!(Error::Conflict)));
    assert!(matches!(adopt::recover(&target, &plan, &authority).unwrap(), adopt::Progress::Ready { .. }));
    portable::activate(&target, &plan, &seal, limits(), &authority, |_| Ok(())).unwrap();
    portable::activate(&target, &plan, &seal, limits(), &authority, |_| panic!("lost reply cannot rerun activation")).unwrap();
    assert_value(&target, "a", Some(2)); assert_value(&target, "b", None); assert_value(&target, "d", Some(3));
    assert!(adopt::commit(&source, &plan, limits(), &authority, |_| Ok(vec![effect("late", 9)])).is_err());
}

#[test]
fn portable_response_wrong_history_schema_oversize_and_missing_receipt_refuse() {
    use adopt::portable;
    let source = Memory::open("record_store").unwrap();
    let target = Memory::open("record_store").unwrap();
    let (plan, authority) = setup(&source, &target);
    let request = portable::request(&target, &plan, limits(), &authority).unwrap().unwrap();
    let mut wrong: portable::Request = serde_json::from_slice(&request).unwrap();
    wrong.shape.push('x');
    assert!(portable::export(&source, &plan, &serde_json::to_vec(&wrong).unwrap(), limits(), &authority).is_err());
    let mut wrong: portable::Request = serde_json::from_slice(&request).unwrap(); wrong.plan.move_id.push('x');
    assert!(portable::export(&source, &plan, &serde_json::to_vec(&wrong).unwrap(), limits(), &authority).is_err());
    assert_eq!(portable::accept(&target, &plan, &vec![0; limits().commit_bytes + 1], limits(), &authority), Err(trillion_local::cause!(Error::TooBig)));
    while let Some(request) = portable::request(&target, &plan, limits(), &authority).unwrap() {
        let response = portable::export(&source, &plan, &request, limits(), &authority).unwrap();
        if matches!(portable::accept(&target, &plan, &response, limits(), &authority).unwrap(), portable::Accepted::AwaitSeal { .. }) {
            portable::seal_reply(&source, &plan, limits(), &authority).unwrap();
            target.erase("kept_shared_objects", &Range::all()).unwrap();
            break;
        }
    }
    let mut refused = false;
    while let Some(request) = portable::request(&target, &plan, limits(), &authority).unwrap() {
        let response = portable::export(&source, &plan, &request, limits(), &authority).unwrap();
        if portable::accept(&target, &plan, &response, limits(), &authority).is_err() { refused = true; break; }
    }
    assert!(refused, "a missing protected closure row must block portable proof");
    assert!(!matches!(adopt::recover(&target, &plan, &authority).unwrap(), adopt::Progress::Active { .. }));
}

fn live_history(source: &dyn Storage, target: &dyn Storage) {
    let (plan, authority) = setup(source, target);
    assert!(adopt::copy_step(source, target, &plan, limits(), &authority).unwrap());
    let mut delete = effect("b", 1);
    delete.row = None;
    adopt::commit(source, &plan, limits(), &authority, |_| {
        Ok(vec![effect("a", 2), delete, effect("d", 3)])
    })
    .unwrap();
    assert_eq!(
        adopt::commit(target, &plan, limits(), &authority, |_| Ok(vec![effect(
            "wrong", 7
        )])),
        Err(trillion_local::cause!(Error::Moved))
    );
    finish(source, target, &plan, &authority);
    assert_value(target, "a", Some(2));
    assert_value(target, "b", None);
    assert_value(target, "d", Some(3));
    assert_eq!(
        target
            .get(
                "kept_shared_objects",
                &["synthetic".into(), "domain".into(), "attached-key".into()],
                &[Read::whole("body")]
            )
            .unwrap()
            .unwrap()
            .0,
        vec![Value::Blob(vec![3, 7, 9])]
    );
    assert_eq!(
        adopt::commit(source, &plan, limits(), &authority, |_| Ok(vec![effect(
            "late", 9
        )])),
        Err(trillion_local::cause!(Error::Moved))
    );
    // Lost activation reply recovers even after target-only writes; source never reopens.
    adopt::commit(target, &plan, limits(), &authority, |_| {
        Ok(vec![effect("target-only", 8)])
    })
    .unwrap();
    adopt::activate(source, target, &plan, limits(), &authority).unwrap();
    assert_value(target, "target-only", Some(8));
}
#[test]
fn insert_behind_cursor_delete_late_write_and_lost_activation_memory() {
    live_history(
        &Memory::open("record_store").unwrap(),
        &Memory::open("record_store").unwrap(),
    );
}
#[test]
fn same_histories_through_persistent_supply() {
    let dir = tempfile::tempdir().unwrap();
    let source = storage::sqlite::open_owned(
        &dir.path().canonicalize().unwrap().join("source"),
        "record_store",
        storage_bounds(),
    )
    .unwrap();
    let target = storage::sqlite::open_owned(
        &dir.path().canonicalize().unwrap().join("target"),
        "record_store",
        storage_bounds(),
    )
    .unwrap();
    live_history(&source, &target);
}

#[test]
fn disjoint_members_of_one_family_move_and_overlap_refuses() {
    let source = Memory::open("record_store").unwrap();
    let target = Memory::open("record_store").unwrap();
    let authority = authority();
    let mut plan = plan();
    plan.selections = ["a", "b"].iter().map(|id| Selection {
        family: "versions".into(),
        prefix: vec![Cell::Text("synthetic".into()), Cell::Text("domain".into()), Cell::Text((*id).into())],
    }).collect();
    raw(&source, &effect("a", 1)); raw(&source, &effect("b", 2)); raw(&source, &effect("outside", 3));
    adopt::prepare(&source, &plan, true, limits(), &authority).unwrap();
    adopt::prepare(&target, &plan, false, limits(), &authority).unwrap();
    adopt::commit(&source, &plan, limits(), &authority, |_| Ok(vec![effect("b", 4)])).unwrap();
    finish(&source, &target, &plan, &authority);
    assert_value(&target, "a", Some(1)); assert_value(&target, "b", Some(4)); assert_value(&target, "outside", None);
    let mut overlap = plan.clone(); overlap.slot = "overlap".into();
    overlap.selections.push(Selection { family: "versions".into(), prefix: vec![Cell::Text("synthetic".into())] });
    assert_eq!(adopt::prepare(&source, &overlap, true, limits(), &authority), Err(trillion_local::cause!(Error::Invalid)));
}

#[test]
fn complete_command_recorder_replays_final_images_and_discards_scope_rollback() {
    let source = Memory::open("record_store").unwrap();
    let target = Memory::open("record_store").unwrap();
    let authority = authority();
    let plan = adopt::complete_domain_plan(&source, "native-whole".into(), "whole-move".into(), "source-1".into(), "target-2".into());
    raw(&source, &effect("b", 1)); raw(&source, &effect("d", 1));
    adopt::prepare(&source, &plan, true, limits(), &authority).unwrap();
    adopt::prepare(&target, &plan, false, limits(), &authority).unwrap();
    adopt::copy_step(&source, &target, &plan, limits(), &authority).unwrap();
    let outer = storage::Scope::begin(&source, Intent::Write).unwrap();
    let capture = adopt::CommandCapture::begin(&source, &plan.slot, limits()).unwrap().unwrap();
    let records = adopt::Recording::new(&source); records.bind(Some(capture.clone()));
    raw(&records, &effect("a", 2));
    { let scope = storage::Scope::begin(&records, Intent::Nested).unwrap(); raw(&records, &effect("rolled-back", 9)); scope.rollback().unwrap(); }
    raw(&records, &effect("a", 3));
    let images = capture.final_effects(&source).unwrap();
    assert_eq!(images.len(), 1); assert_eq!(images[0], effect("a", 3));
    capture.flush(&source).unwrap(); outer.commit().unwrap();
    finish(&source, &target, &plan, &authority);
    assert_value(&target, "a", Some(3)); assert_value(&target, "rolled-back", None);
}

#[test]
fn complete_domain_ranges_transfer_every_family_through_the_persistent_supply() {
    let folder = tempfile::tempdir().unwrap();
    let root = folder.path().canonicalize().unwrap();
    let source = storage::sqlite::open_owned(&root.join("whole-source"), "record_store", storage_bounds()).unwrap();
    let target = storage::sqlite::open_owned(&root.join("whole-target"), "record_store", storage_bounds()).unwrap();
    let authority = authority();
    let plan = adopt::complete_domain_plan(&source, "whole-persistent".into(), "whole-persistent-move".into(), "source-1".into(), "target-2".into());
    raw(&source, &effect("whole-row", 1));
    adopt::prepare(&source, &plan, true, limits(), &authority).unwrap();
    adopt::prepare(&target, &plan, false, limits(), &authority).unwrap();
    finish(&source, &target, &plan, &authority);
    assert_value(&target, "whole-row", Some(1));
}

#[test]
fn complete_commit_log_is_atomic_retry_bound_and_floor_aware() {
    use trillion_local::storage::record_store_resources::carry::commit_log as commits;
    let source = Memory::open("record_store").unwrap();
    let target = Memory::open("record_store").unwrap();
    let outer = storage::Scope::begin(&source, Intent::Write).unwrap();
    raw(&source, &effect("effect", 1)); raw(&source, &effect("receipt", 1));
    let committed = commits::append_commit(&source, "stream", "original-command", &[effect("effect", 1), effect("receipt", 1)], limits()).unwrap();
    outer.commit().unwrap();
    assert_eq!(committed.sequence, 1);
    let page = commits::commits_after(&source, "stream", 0, limits()).unwrap();
    assert_eq!(page.commits, vec![committed.clone()]); assert!(!page.further);
    assert_eq!(commits::apply_commit(&target, "stream", &committed, limits()), Ok(1));
    assert_eq!(commits::apply_commit(&target, "stream", &committed, limits()), Ok(1));
    let mut changed = committed.clone(); changed.effects[0] = effect("effect", 2);
    assert_eq!(commits::apply_commit(&target, "stream", &changed, limits()), Err(trillion_local::cause!(Error::Conflict)));
    let mut gap = committed.clone(); gap.sequence = 3; gap.identity = "gap".into();
    assert_eq!(commits::apply_commit(&target, "stream", &gap, limits()), Err(trillion_local::cause!(Error::Conflict)));
    let mut invalid = committed.clone(); invalid.sequence = 2; invalid.identity = "invalid-second-key".into();
    invalid.effects[0] = effect("partial-must-rollback", 2); invalid.effects[1].key.clear();
    assert_eq!(commits::apply_commit(&target, "stream", &invalid, limits()), Err(trillion_local::cause!(Error::Invalid)));
    assert_value(&target, "partial-must-rollback", None);
    assert!(commits::commits_after(&target, "stream", 1, limits()).unwrap().commits.is_empty());
    assert_value(&target, "effect", Some(1)); assert_value(&target, "receipt", Some(1));
    assert_eq!(commits::trim_through(&source, "stream", 1, limits()), Ok(1));
    assert!(matches!(commits::commits_after(&source, "stream", 0, limits()), Err(Error::Moved(_))));
    let rolled = storage::Scope::begin(&source, Intent::Write).unwrap();
    raw(&source, &effect("never", 9));
    commits::append_commit(&source, "stream", "rolled-command", &[effect("never", 9)], limits()).unwrap();
    rolled.rollback().unwrap();
    assert_value(&source, "never", None);
    assert!(commits::commits_after(&source, "stream", 1, limits()).unwrap().commits.is_empty());
}

#[test]
fn opaque_group_retention_exposes_no_rows_and_requires_matching_materialization() {
    use trillion_local::storage::record_store_resources::carry::commit_log as commits;
    let target = Memory::open("record_store").unwrap();
    let commit = commits::CapturedCommit { sequence: 1, identity: "private-native-input-digest".into(), effects: vec![effect("private-row", 1)] };
    let digest = content_crypto::advanced::blake3::hash(&serde_json::to_vec(&commit).unwrap()).to_hex().to_string();
    let opaque = commits::OpaqueCommit { sequence: 1, digest, payload: vec![7, 4, 9, 2] };
    assert_eq!(commits::retain_opaque(&target, "private-stream", &opaque, limits()).unwrap(), commits::Frontiers { stored: 1, materialized: 0, retained_from: 1 });
    assert_eq!(commits::opaque_after(&target, "private-stream", 0, limits()).unwrap().commits, vec![opaque.clone()]);
    assert_value(&target, "private-row", None);
    assert!(!String::from_utf8(serde_json::to_vec(&opaque).unwrap()).unwrap().contains("private-native-input-digest"));
    assert!(matches!(commits::commits_after(&target, "private-stream", 0, limits()), Err(Error::Moved(_))));
    assert_eq!(commits::trim_opaque_through(&target, "private-stream", 1, limits()), Err(trillion_local::cause!(Error::Conflict)));
    let mut changed = commit.clone(); changed.effects[0] = effect("private-row", 2);
    assert_eq!(commits::materialize_opaque(&target, "private-stream", &changed, limits()), Err(trillion_local::cause!(Error::Conflict)));
    assert_value(&target, "private-row", None);
    assert_eq!(commits::materialize_opaque(&target, "private-stream", &commit, limits()).unwrap(), commits::Frontiers { stored: 1, materialized: 1, retained_from: 1 });
    assert_value(&target, "private-row", Some(1));
    assert_eq!(commits::trim_opaque_through(&target, "private-stream", 1, limits()), Ok(1));
}

#[test]
fn stream_bindings_are_immutable_and_startup_discovery_crosses_sparse_metadata() {
    use trillion_local::storage::record_store_resources::carry::commit_log as commits;
    let store = Memory::open("record_store").unwrap();
    commits::bind_stream(&store, "stream-a", b"synthetic-history-a", limits()).unwrap();
    commits::bind_stream(&store, "stream-b", b"synthetic-history-b", limits()).unwrap();
    commits::bind_stream(&store, "stream-a", b"synthetic-history-a", limits()).unwrap();
    assert_eq!(commits::bind_stream(&store, "stream-a", b"other-history", limits()), Err(trillion_local::cause!(Error::Conflict)));
    assert_eq!(commits::stream_binding(&store, "stream-a", limits()).unwrap(), Some(b"synthetic-history-a".to_vec()));
    let scope = storage::Scope::begin(&store, Intent::Write).unwrap();
    raw(&store, &effect("state-with-receipt-metadata", 1));
    commits::append_commit(&store, "stream-a", "with-metadata", &[effect("state-with-receipt-metadata", 1)], limits()).unwrap();
    scope.commit().unwrap();
    let mut after = None; let mut found = Vec::new();
    loop {
        let page = commits::bindings_after(&store, after.as_deref(), limits()).unwrap();
        found.extend(page.bindings.into_iter().map(|binding| binding.stream));
        match page.next { Some(next) => after = Some(next), None => break }
    }
    found.sort(); assert_eq!(found, vec!["stream-a", "stream-b"]);
    store.put("command_commit_state", &[("slot", "malformed-discovery-row".into()), ("body", Value::Blob(b"{}".to_vec()))], When::New).unwrap();
    let mut after = None; let mut refused = false;
    loop {
        match commits::bindings_after(&store, after.as_deref(), limits()) {
            Err(Error::Invalid(_)) => { refused = true; break; },
            Err(error) => panic!("wrong refusal {error:?}"),
            Ok(page) => match page.next { Some(next) => after = Some(next), None => break }
        }
    }
    assert!(refused, "unreadable/unknown metadata cannot prove an absence of bindings");
}

/// Fails one storage mutation, before or after its effect. An unknown commit
/// reply is injected AFTER the real close, rather than incorrectly rolling back.
struct Fault<'a> {
    store: &'a dyn Storage,
    remaining: Counter<usize>,
    after: bool,
    close: bool,
    moved: bool,
}
impl Fault<'_> {
    fn edge<T>(&self, work: impl FnOnce() -> Result<T>) -> Result<T> {
        let count = self.remaining.get();
        self.remaining.set(count.saturating_sub(1));
        if count == 1 && !self.after {
            return Err(trillion_local::cause!(Error::Interrupted));
        }
        let result = work()?;
        if count == 1 {
            return Err(trillion_local::cause!(Error::Interrupted));
        }
        Ok(result)
    }
}
impl Storage for Fault<'_> {
    fn schema(&self) -> &'static storage::Schema {
        self.store.schema()
    }
    fn get(&self, f: &str, k: &[Value], r: &[Read<'_>]) -> Result<Option<Row>> {
        self.store.get(f, k, r)
    }
    fn scan(&self, f: &str, q: &Range<'_>, r: &[Read<'_>]) -> Result<Vec<Row>> {
        self.store.scan(f, q, r)
    }
    fn put(&self, f: &str, r: &[(&str, Value)], w: When<'_>) -> Result<u64> {
        if self.close {
            self.store.put(f, r, w)
        } else {
            self.edge(|| self.store.put(f, r, w))
        }
    }
    fn erase(&self, f: &str, r: &Range<'_>) -> Result<u64> {
        if self.close {
            self.store.erase(f, r)
        } else {
            self.edge(|| self.store.erase(f, r))
        }
    }
    fn count(&self, f: &str, r: &Range<'_>) -> Result<u64> {
        self.store.count(f, r)
    }
    fn present(&self, f: &str) -> Result<bool> {
        self.store.present(f)
    }
    fn custody(&self) -> Result<()> {
        if self.moved {
            Err(trillion_local::cause!(Error::Moved))
        } else {
            self.store.custody()
        }
    }
    fn location(&self) -> Option<&str> {
        self.store.location()
    }
    fn scoped(&self) -> bool {
        self.store.scoped()
    }
    fn writing(&self) -> Result<bool> {
        self.store.writing()
    }
    fn changes(&self) -> u64 {
        self.store.changes()
    }
    fn mark(&self) -> Result<i64> {
        self.store.mark()
    }
    fn schema_mark(&self) -> Result<i64> {
        self.store.schema_mark()
    }
    fn allocated_bytes(&self) -> Result<u64> {
        self.store.allocated_bytes()
    }
    fn open_scope(&self, i: Intent) -> Result<()> {
        self.store.open_scope(i)
    }
    fn close_scope(&self, c: bool) -> Result<()> {
        if self.close && c {
            self.edge(|| self.store.close_scope(c))
        } else {
            self.store.close_scope(c)
        }
    }
}
#[test]
fn crash_each_effect_cursor_capture_seal_and_activation_edge() {
    for operation in [
        "prepare", "commit", "copy", "replay", "seal", "verify", "activate",
    ] {
        for after in [false, true] {
            for close in [false, true] {
                for edge in 1..=5 {
                    let source = Memory::open("record_store").unwrap();
                    let target = Memory::open("record_store").unwrap();
                    let (plan, authority) = setup(&source, &target);
                    adopt::commit(&source, &plan, limits(), &authority, |_| {
                        Ok(vec![effect("a", 2)])
                    })
                    .unwrap();
                    if ["replay", "verify", "activate"].contains(&operation) {
                        while adopt::copy_step(&source, &target, &plan, limits(), &authority)
                            .unwrap()
                        {}
                    }
                    if ["verify", "activate"].contains(&operation) {
                        adopt::seal(&source, &plan, &authority).unwrap();
                        while adopt::replay_step(&source, &target, &plan, limits(), &authority)
                            .unwrap()
                        {}
                    }
                    if operation == "activate" {
                        while adopt::verify_step(&source, &target, &plan, limits(), &authority)
                            .unwrap()
                        {}
                    }
                    let failing = if ["prepare", "commit", "seal"].contains(&operation) {
                        source.reopen()
                    } else {
                        target.reopen()
                    };
                    let fault = Fault {
                        store: &failing,
                        remaining: Counter::new(edge),
                        after,
                        close,
                        moved: false,
                    };
                    let _lost = match operation {
                        "prepare" => adopt::prepare(&fault, &plan, true, limits(), &authority),
                        "commit" => adopt::commit(&fault, &plan, limits(), &authority, |store| {
                            if store
                                .get("versions", &key("once"), &[Read::whole("version")])?
                                .is_some()
                            {
                                Ok(vec![])
                            } else {
                                Ok(vec![effect("once", 1)])
                            }
                        }),
                        "copy" => adopt::copy_step(&source, &fault, &plan, limits(), &authority)
                            .map(|_| ()),
                        "replay" => {
                            adopt::replay_step(&source, &fault, &plan, limits(), &authority)
                                .map(|_| ())
                        }
                        "seal" => adopt::seal(&fault, &plan, &authority).map(|_| ()),
                        "verify" => {
                            adopt::verify_step(&source, &fault, &plan, limits(), &authority)
                                .map(|_| ())
                        }
                        _ => adopt::activate(&source, &fault, &plan, limits(), &authority),
                    };
                    drop(fault);
                    drop(failing); // crash: unknown/uncommitted scope ends with the process handle
                    if operation == "commit" {
                        adopt::commit(&source, &plan, limits(), &authority, |store| {
                            if store
                                .get("versions", &key("once"), &[Read::whole("version")])?
                                .is_some()
                            {
                                Ok(vec![])
                            } else {
                                Ok(vec![effect("once", 1)])
                            }
                        })
                        .unwrap();
                    }
                    finish(&source, &target, &plan, &authority);
                    assert_value(&target, "a", Some(2));
                    if operation == "commit" {
                        assert_value(&target, "once", Some(1));
                    }
                }
            }
        }
    }
}
#[test]
fn extra_row_missing_receipt_and_stale_backup_cannot_activate() {
    for corruption in ["extra", "receipt"] {
        let source = Memory::open("record_store").unwrap();
        let target = Memory::open("record_store").unwrap();
        let (plan, authority) = setup(&source, &target);
        while adopt::copy_step(&source, &target, &plan, limits(), &authority).unwrap() {}
        adopt::seal(&source, &plan, &authority).unwrap();
        if corruption == "extra" {
            raw(&target, &effect("extra", 1));
        } else {
            target
                .put(
                    "versions",
                    &[
                        ("account", "synthetic".into()),
                        ("resource", "domain".into()),
                        ("id", "b".into()),
                        ("valid_to", i64::MAX.into()),
                        ("ring", Value::Null),
                    ],
                    When::Always,
                )
                .unwrap();
        }
        let mut failure = None;
        for _ in 0..32 {
            match adopt::verify_step(&source, &target, &plan, limits(), &authority) {
                Ok(true) => {}
                Ok(false) => break,
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }
        assert_eq!(failure, Some(trillion_local::cause!(Error::Conflict)));
        assert_eq!(
            adopt::activate(&source, &target, &plan, limits(), &authority),
            Err(trillion_local::cause!(Error::Conflict))
        );
    }
    let source = Memory::open("record_store").unwrap();
    let target = Memory::open("record_store").unwrap();
    let (plan, authority) = setup(&source, &target);
    authority.0.lock().unwrap().remove("source-1");
    assert_eq!(
        adopt::commit(&source, &plan, limits(), &authority, |_| Ok(vec![effect(
            "stale", 1
        )])),
        Err(trillion_local::cause!(Error::Moved))
    );
    assert_eq!(adopt::seal(&source, &plan, &authority), Err(trillion_local::cause!(Error::Moved)));
}
#[test]
fn oversized_capture_and_failed_cas_leave_effects_and_frontier_unchanged() {
    let source = Memory::open("record_store").unwrap();
    let target = Memory::open("record_store").unwrap();
    let (plan, authority) = setup(&source, &target);
    let mut bounded = limits();
    bounded.capture_bytes = bounded.commit_bytes;
    bounded.commit_bytes = 1;
    assert_eq!(
        adopt::commit(&source, &plan, bounded, &authority, |_| Ok(vec![effect(
            "overflow", 1
        )])),
        Err(trillion_local::cause!(Error::TooBig))
    );
    assert_value(&source, "overflow", None);
    assert_eq!(
        adopt::commit(&source, &plan, limits(), &authority, |_| Err(
            trillion_local::cause!(Error::Conflict)
        )),
        Err(trillion_local::cause!(Error::Conflict))
    );
    finish(&source, &target, &plan, &authority);
    assert_value(&target, "overflow", None);
}

#[test]
fn six_concurrent_source_writers_are_captured_once() {
    let source = Memory::open("record_store").unwrap();
    let target = Memory::open("record_store").unwrap();
    let (plan, authority) = setup(&source, &target);
    let mut workers = Vec::new();
    for worker in 0..6 {
        let store = source.reopen();
        let plan = plan.clone();
        let fence = Authority(authority.0.clone());
        workers.push(std::thread::spawn(move || {
            for write in 0..12 {
                let id = format!("writer-{worker}-{write}");
                let mut completed = false;
                for _ in 0..10000 {
                    let result = adopt::commit(&store, &plan, limits(), &fence, |_| {
                        Ok(vec![effect(&id, 1)])
                    });
                    match result {
                        Ok(()) => {
                            completed = true;
                            break;
                        }
                        Err(Error::Busy(_)) => std::thread::yield_now(),
                        other => panic!("unexpected writer result: {other:?}"),
                    }
                }
                assert!(completed, "bounded retry exhausted");
            }
        }));
    }
    for worker in workers {
        worker.join().unwrap();
    }
    finish(&source, &target, &plan, &authority);
    for worker in 0..6 {
        for write in 0..12 {
            assert_value(&target, &format!("writer-{worker}-{write}"), Some(1));
        }
    }
    assert_eq!(source.count("adopt_changes", &Range::all()).unwrap(), 72);
}

#[test]
fn zero_page_bound_cannot_prove_empty_or_drop_capture() {
    let source = Memory::open("record_store").unwrap();
    let target = Memory::open("record_store").unwrap();
    let (plan, authority) = setup(&source, &target);
    let mut zero = limits();
    zero.page_rows = 0;
    assert_eq!(
        adopt::copy_step(&source, &target, &plan, zero, &authority),
        Err(trillion_local::cause!(Error::Invalid))
    );
    assert_eq!(
        adopt::activate(&source, &target, &plan, zero, &authority),
        Err(trillion_local::cause!(Error::Invalid))
    );
}

fn once_command(store: &dyn Storage, plan: &Plan, fence: &Authority, binding: &str) -> Result<()> {
    adopt::commit(store, plan, limits(), fence, |store| {
        let receipt_key: Vec<Value> =
            vec!["synthetic".into(), "domain".into(), "request-key".into()];
        if let Some(row) = store.get("kept_shared_objects", &receipt_key, &[Read::whole("body")])? {
            return if row.0[0].as_text() == Some(binding) {
                Ok(vec![])
            } else {
                Err(trillion_local::cause!(Error::Conflict))
            };
        }
        let held = store.get("versions", &key("counter"), &[Read::whole("version")])?;
        let next = held.map_or(1, |r| r.0[0].as_integer().unwrap() + 1);
        Ok(vec![
            effect("counter", next),
            Effect {
                family: "kept_shared_objects".into(),
                key: vec![
                    Cell::Text("synthetic".into()),
                    Cell::Text("domain".into()),
                    Cell::Text("request-key".into()),
                ],
                row: Some(vec![
                    Cell::Text("synthetic".into()),
                    Cell::Text("domain".into()),
                    Cell::Text("request-key".into()),
                    Cell::Text(binding.into()),
                ]),
            },
        ])
    })
}
#[test]
fn same_request_and_changed_input_survive_real_file_reopens_and_activation() {
    let dir = tempfile::tempdir().unwrap();
    let source_path = dir.path().canonicalize().unwrap().join("source");
    let target_path = dir.path().canonicalize().unwrap().join("target");
    let open = |path: &std::path::Path| {
        storage::sqlite::open_owned(path, "record_store", storage_bounds()).unwrap()
    };
    let (plan, authority) = {
        let source = open(&source_path);
        let target = open(&target_path);
        let (plan, authority) = setup(&source, &target);
        once_command(&source, &plan, &authority, "original-input").unwrap();
        adopt::copy_step(&source, &target, &plan, limits(), &authority).unwrap();
        (plan, authority)
    };
    {
        let source = open(&source_path);
        let target = open(&target_path);
        once_command(&source, &plan, &authority, "original-input").unwrap();
        assert_eq!(
            once_command(&source, &plan, &authority, "changed-input"),
            Err(trillion_local::cause!(Error::Conflict))
        );
        while adopt::copy_step(&source, &target, &plan, limits(), &authority).unwrap() {}
        adopt::seal(&source, &plan, &authority).unwrap();
    }
    {
        let source = open(&source_path);
        let target = open(&target_path);
        assert_eq!(
            once_command(&source, &plan, &authority, "original-input"),
            Err(trillion_local::cause!(Error::Moved))
        );
        while adopt::replay_step(&source, &target, &plan, limits(), &authority).unwrap() {}
        while adopt::verify_step(&source, &target, &plan, limits(), &authority).unwrap() {}
        adopt::activate(&source, &target, &plan, limits(), &authority).unwrap();
    }
    let source = open(&source_path);
    let target = open(&target_path);
    adopt::activate(&source, &target, &plan, limits(), &authority).unwrap();
    once_command(&target, &plan, &authority, "original-input").unwrap();
    assert_eq!(
        once_command(&target, &plan, &authority, "changed-input"),
        Err(trillion_local::cause!(Error::Conflict))
    );
    assert_value(&target, "counter", Some(1));
}

#[test]
fn lost_activation_recovers_without_a_reachable_old_authority() {
    let source = Memory::open("record_store").unwrap();
    let target = Memory::open("record_store").unwrap();
    let (plan, authority) = setup(&source, &target);
    finish(&source, &target, &plan, &authority);
    authority.0.lock().unwrap().remove("source-1");
    assert_eq!(
        adopt::recover(&target, &plan, &authority).unwrap(),
        adopt::Progress::Active { sealed_through: 0 }
    );
    let mut other_move = plan.clone();
    other_move.move_id = "different".into();
    assert_eq!(
        adopt::recover(&target, &other_move, &authority),
        Err(trillion_local::cause!(Error::Moved))
    );
}

#[test]
fn initial_capture_and_target_preparation_crashes_resume_same_move() {
    for source_role in [false, true] {
        for after in [false, true] {
            for close in [false, true] {
                let source = Memory::open("record_store").unwrap();
                let target = Memory::open("record_store").unwrap();
                let plan = plan();
                let authority = authority();
                raw(&source, &effect("initial", 1));
                let store = if source_role {
                    source.reopen()
                } else {
                    target.reopen()
                };
                let fault = Fault {
                    store: &store,
                    remaining: Counter::new(1),
                    after,
                    close,
                    moved: false,
                };
                let _lost = adopt::prepare(&fault, &plan, source_role, limits(), &authority);
                drop(fault);
                drop(store);
                adopt::prepare(&source, &plan, true, limits(), &authority).unwrap();
                adopt::prepare(&target, &plan, false, limits(), &authority).unwrap();
                finish(&source, &target, &plan, &authority);
                assert_value(&target, "initial", Some(1));
            }
        }
    }
}
#[test]
fn every_copy_cursor_and_family_boundary_survives_a_lost_commit_reply() {
    let source = Memory::open("record_store").unwrap();
    let target = Memory::open("record_store").unwrap();
    let (plan, authority) = setup(&source, &target);
    let mut steps = 0;
    while adopt::recover(&target, &plan, &authority).unwrap() == adopt::Progress::Copying {
        let handle = target.reopen();
        let fault = Fault {
            store: &handle,
            remaining: Counter::new(1),
            after: true,
            close: true,
            moved: false,
        };
        assert_eq!(
            adopt::copy_step(&source, &fault, &plan, limits(), &authority),
            Err(trillion_local::cause!(Error::Interrupted))
        );
        drop(fault);
        drop(handle);
        steps += 1;
        assert!(steps < 32, "durable cursor must advance");
    }
    finish(&source, &target, &plan, &authority);
    for id in ["b", "d", "f", "h"] {
        assert_value(&target, id, Some(1));
    }
}

#[test]
fn every_verification_cursor_survives_lost_commit_reply_and_blocks_writers() {
    let source = Memory::open("record_store").unwrap();
    let target = Memory::open("record_store").unwrap();
    let (plan, authority) = setup(&source, &target);
    while adopt::copy_step(&source, &target, &plan, limits(), &authority).unwrap() {}
    adopt::seal(&source, &plan, &authority).unwrap();
    let mut steps = 0;
    loop {
        if matches!(
            adopt::recover(&target, &plan, &authority).unwrap(),
            adopt::Progress::Ready { .. }
        ) {
            break;
        }
        let handle = target.reopen();
        let fault = Fault {
            store: &handle,
            remaining: Counter::new(1),
            after: true,
            close: true,
            moved: false,
        };
        assert_eq!(
            adopt::verify_step(&source, &fault, &plan, limits(), &authority),
            Err(trillion_local::cause!(Error::Interrupted))
        );
        drop(fault);
        drop(handle);
        assert_eq!(
            adopt::commit(&target, &plan, limits(), &authority, |_| Ok(vec![effect(
                "too-early",
                1
            )])),
            Err(trillion_local::cause!(Error::Moved))
        );
        steps += 1;
        assert!(steps < 32);
    }
    adopt::activate(&source, &target, &plan, limits(), &authority).unwrap();
    assert_value(&target, "b", Some(1));
    assert_value(&target, "too-early", None);
}

#[test]
fn capture_ceiling_rolls_back_without_losing_history_tombstones_or_indexes() {
    let source = Memory::open("record_store").unwrap();
    let target = Memory::open("record_store").unwrap();
    let mut plan = plan();
    let authority = authority();
    plan.selections.push(Selection {
        family: "ordered".into(),
        prefix: vec![Cell::Text("synthetic".into()), Cell::Text("domain".into())],
    });
    let mut history = effect("history", 1);
    history.key[3] = Cell::Integer(20);
    history.row.as_mut().unwrap()[3] = Cell::Integer(20);
    raw(&source, &history);
    let mut tombstone = effect("gone", 2);
    tombstone.row.as_mut().unwrap()[6] = Cell::Integer(1);
    raw(&source, &tombstone);
    source
        .put(
            "ordered",
            &[
                ("account", "synthetic".into()),
                ("resource", "domain".into()),
                ("order", "test-order".into()),
                ("value", Value::Blob(vec![9, 4])),
                ("id", "index-id".into()),
            ],
            When::New,
        )
        .unwrap();
    adopt::prepare(&source, &plan, true, limits(), &authority).unwrap();
    adopt::prepare(&target, &plan, false, limits(), &authority).unwrap();
    let mut bounded = limits();
    bounded.capture_bytes = bounded.commit_bytes;
    let mut accepted = 0;
    for index in 0..100 {
        let id = format!("bounded-{index}");
        match adopt::commit(&source, &plan, bounded, &authority, |_| {
            Ok(vec![effect(&id, 1)])
        }) {
            Ok(()) => accepted += 1,
            Err(Error::TooBig(_)) => {
                assert_value(&source, &id, None);
                break;
            }
            other => panic!("unexpected capture outcome {other:?}"),
        }
    }
    assert!(
        accepted > 0 && accepted < 100,
        "the retained capture has a real ceiling"
    );
    assert_eq!(
        source.count("adopt_changes", &Range::all()).unwrap(),
        accepted
    );
    finish(&source, &target, &plan, &authority);
    for index in 0..accepted {
        assert_value(&target, &format!("bounded-{index}"), Some(1));
    }
    assert_value(&target, &format!("bounded-{accepted}"), None);
    let history_key: Vec<Value> = history.key.into_iter().map(Value::from).collect();
    assert_eq!(
        target
            .get(
                "versions",
                &history_key,
                &[Read::whole("version"), Read::whole("ring")]
            )
            .unwrap()
            .unwrap()
            .0,
        vec![Value::Integer(1), Value::Text("receipt-history-1".into())]
    );
    assert_eq!(
        target
            .get("versions", &key("gone"), &[Read::whole("deleted")])
            .unwrap()
            .unwrap()
            .0,
        vec![Value::Integer(1)]
    );
    assert!(target
        .get(
            "ordered",
            &[
                "synthetic".into(),
                "domain".into(),
                "test-order".into(),
                Value::Blob(vec![9, 4]),
                "index-id".into()
            ],
            &[Read::whole("id")]
        )
        .unwrap()
        .is_some());
}

#[test]
fn a_replaced_handle_cannot_supply_copy_proof_or_recover_activation() {
    let source = Memory::open("record_store").unwrap();
    let target = Memory::open("record_store").unwrap();
    let (plan, authority) = setup(&source, &target);
    let moved = Fault {
        store: &source,
        remaining: Counter::new(usize::MAX),
        after: false,
        close: false,
        moved: true,
    };
    assert_eq!(
        adopt::copy_step(&moved, &target, &plan, limits(), &authority),
        Err(trillion_local::cause!(Error::Moved))
    );
    finish(&source, &target, &plan, &authority);
    let moved = Fault {
        store: &target,
        remaining: Counter::new(usize::MAX),
        after: false,
        close: false,
        moved: true,
    };
    assert_eq!(adopt::recover(&moved, &plan, &authority), Err(trillion_local::cause!(Error::Moved)));
}
