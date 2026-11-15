//! Contract test of the real product adapter, including cold reopen and true
//! missing-meter disclosure. It never contacts a provider or a customer account.
use serde_json::json;
use std::{collections::BTreeMap, path::PathBuf};
use workload_simulation::{run, CostModel, FaultProfile, RunConfig, Workload};

#[test]
fn actual_product_crud_search_and_cold_reopen_match_reference_model() {
    let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let shape = json!({"fields":[{"name":"text","shape":{"words":{"min":3,"max":8}}}]});
    let w:Workload=serde_json::from_value(json!({
        "format":"workload-simulation-workload/1","name":"actual-product-contract","about":"actual product CRUD, lists, search, lost-response retries and cold reopen", "stores":1,"owners":2,"vocabulary":30,
        "initial":[{"kind":"note","count":12,"value":shape}],
        "operations":[
            {"name":"create","per_day":15,"intent":{"create":{"kind":"note","value":shape}}},
            {"name":"update","per_day":15,"intent":{"update":{"target":{"kind":"note","pick":"uniform"},"field":"text","value":{"words":{"min":3,"max":8}}}}},
            {"name":"read","per_day":20,"intent":{"read":{"target":{"pick":"uniform"}}}},
            {"name":"list","per_day":5,"intent":{"list":{"kind":"note","limit":10}}},
            {"name":"search","per_day":5,"intent":{"search":{"field":"text","limit":10}}},
            {"name":"delete","per_day":3,"intent":{"delete":{"target":{"kind":"note","pick":"uniform"}}}},
            {"name":"restart","per_day":3,"intent":{"evict":{}}}
        ]
    })).unwrap();
    w.validate().unwrap();
    let c = storage_sim::candidates::load(&home.join("candidates"), "product-s2h-current")
        .expect("the DATA-defined production candidate adapter loads");
    assert!(
        !c.meters().contains(&"index_entries_written"),
        "unmeasured indexes must not be priced as zero"
    );
    let folder = tempfile::tempdir().unwrap();
    let config = RunConfig {
        seed: 42,
        days: 2,
        rate_scale: 1.0,
        faults: FaultProfile::load(&home.join("faults/none.json")).unwrap(),
        cost_models: vec![CostModel::load(
            &home.join("cost-models/mac-local-sqlite.json"),
            &BTreeMap::new(),
        )
        .unwrap()],
        work_dir: folder.path().to_path_buf(),
        seed_records: vec![],
        final_sample: 200,
    };
    let r = run(c.as_ref(), &w, &config).unwrap().0;
    let rows_returned = r
        .meter_definitions
        .iter()
        .find(|definition| definition.name == "rows_returned")
        .expect("product meters have declared physical units");
    assert_eq!(rows_returned.unit.as_deref(), Some("sqlite_row_returned"));
    assert_eq!(
        rows_returned.metric_kind,
        workload_simulation::candidate::MeterMetricKind::CounterDelta
    );
    assert_eq!(
        rows_returned.aggregation,
        workload_simulation::candidate::MeterAggregation::Sum
    );
    for (name, stats) in &r.totals {
        assert_eq!(
            stats.failed,
            0,
            "{name}: {}",
            serde_json::to_string(stats).unwrap()
        );
        assert_eq!(
            stats.unsupported, 0,
            "{name}: unsupported work must be explicit"
        );
        assert!(
            stats.acked > 0,
            "{name}: a passing oracle over no successful requests proves nothing"
        );
    }
    let i = &r.invariants;
    assert_eq!(
        i.reads_wrong + i.lists_wrong + i.final_wrong + i.lost_acknowledged_writes,
        0,
        "{}",
        serde_json::to_string(&r).unwrap()
    );
    assert!(r.totals["create"].meters.get("table_rows_written") > 0);
    assert_eq!(
        r.totals["read"].meters.get("table_rows_written"),
        0,
        "reads must write no record rows"
    );
}

#[test]
fn receipt_history_and_delete_survive_actual_product_reopen() {
    use storage_sim::candidates::product_s2h::ProductStore;
    use workload_simulation::{ExtendedIntent, Intent, Operation, Outcome, Reply, SimTime, Store};
    let dir = tempfile::tempdir().unwrap();
    let (mut store, opened) = ProductStore::open_at(dir.path().join("product.sqlite")).unwrap();
    assert!(opened.get("sql_statements") > 0);
    let make = |sequence, request: &str, intent| Operation {
        request_key: request.into(),
        attempt: 1,
        at: SimTime(sequence * 1000),
        actor: "client".into(),
        sequence,
        intent,
    };
    let create = make(
        1,
        "create-original",
        Intent::Create {
            key: "k".into(),
            kind: "note".into(),
            owner: "o".into(),
            value: json!({"text":"original value"}),
        },
    );
    assert!(matches!(store.apply(&create, None), Outcome::Acked { .. }));
    store.crash();
    store.recover().unwrap();
    let mut retry = create.clone();
    retry.attempt = 2;
    assert!(matches!(store.apply(&retry, None), Outcome::Acked { .. }));
    let update = make(
        2,
        "update-original",
        Intent::Update {
            key: "k".into(),
            field: "text".into(),
            value: json!("new value"),
        },
    );
    assert!(matches!(store.apply(&update, None), Outcome::Acked { .. }));
    assert_eq!(
        store.inspect("k").unwrap(),
        Some(json!({"text":"new value"}))
    );
    let back = Operation {
        request_key: "history".into(),
        attempt: 1,
        at: SimTime(3000),
        actor: "client".into(),
        sequence: 3,
        intent: ExtendedIntent::ReadAsOf {
            key: "k".into(),
            back: 1,
        },
    };
    assert!(
        matches!(store.apply_extended(&back,None),Outcome::Acked {reply:Reply::Value(Some(v)),..} if v==json!({"text":"original value"}))
    );
    store.crash();
    store.recover().unwrap();
    let mut retry = update.clone();
    retry.attempt = 2;
    assert!(matches!(store.apply(&retry, None), Outcome::Acked { .. }));
    let delete = make(4, "delete-original", Intent::Delete { key: "k".into() });
    assert!(matches!(store.apply(&delete, None), Outcome::Acked { .. }));
    store.crash();
    store.recover().unwrap();
    let mut retry = delete;
    retry.attempt = 2;
    assert!(matches!(store.apply(&retry, None), Outcome::Acked { .. }));
    assert_eq!(store.inspect("k").unwrap(), None);
    let fault = workload_simulation::Interrupt { after_vm_steps: 1 };
    assert!(matches!(
        store.apply(&create, Some(fault)),
        Outcome::Unsupported { .. }
    ));
}

#[test]
fn bounded_page_operation_matches_product_cursor_reads_and_failure_controls() {
    use storage_sim::candidates::product_s2h::ProductStore;
    use workload_simulation::{
        ExtendedIntent, Intent, Operation, Outcome, Reply, SimTime, Store,
    };

    let dir = tempfile::tempdir().unwrap();
    let (mut store, _) = ProductStore::open_at(dir.path().join("pages.sqlite")).unwrap();
    let creates: Vec<_> = (0..12)
        .map(|n| Operation {
            request_key: format!("seed-{n}"),
            attempt: 1,
            at: SimTime(n * 1000),
            actor: "fixture".into(),
            sequence: n + 1,
            intent: Intent::Create {
                key: format!("row-{n:02}"),
                kind: "note".into(),
                owner: "synthetic-owner".into(),
                value: json!({"title":format!("fixture {n}")}),
            },
        })
        .collect();
    store.load(&creates).unwrap();

    let page = |request_key: &str, after: &str, attempt| Operation {
        request_key: request_key.into(),
        attempt,
        at: SimTime(20_000),
        actor: "fixture".into(),
        sequence: 20,
        intent: ExtendedIntent::ListPage {
            after: after.into(),
            limit: 5,
        },
    };
    let first_request = page("first-page", "", 1);
    let first = store.apply_extended(&first_request, None);
    let (first_keys, mut cursor, first_meters) = match first {
        Outcome::Acked {
            reply: Reply::PageKeys { keys, next },
            meters,
            ..
        } => (keys, next, meters),
        other => panic!("first page must be acknowledged: {other:?}"),
    };
    assert_eq!(first_keys, (0..5).map(|n| format!("row-{n:02}")).collect::<Vec<_>>());
    assert_eq!(cursor.as_deref(), Some("row-04"));
    assert!(first_meters.get("sql_statements") <= 1);
    assert!(first_meters.get("scan_visits") <= 7);

    let mut keys = first_keys;
    let mut page_no = 1;
    while let Some(after) = cursor.take() {
        page_no += 1;
        match store.apply_extended(&page(&format!("page-{page_no}"), &after, 1), None) {
            Outcome::Acked {
                reply: Reply::PageKeys { keys: next_keys, next },
                ..
            } => {
                keys.extend(next_keys);
                cursor = next;
            }
            other => panic!("continuation page must be acknowledged: {other:?}"),
        }
    }
    assert_eq!(page_no, 3);
    assert_eq!(keys.len(), 12);
    assert_eq!(keys.iter().collect::<std::collections::BTreeSet<_>>().len(), 12);

    assert!(matches!(
        store.apply_extended(&page("beyond-end", "zzzz", 1), None),
        Outcome::Acked { reply: Reply::PageKeys { keys, next: None }, .. } if keys.is_empty()
    ));
    store.crash();
    assert!(matches!(
        store.apply_extended(&page("failed-while-crashed", "", 1), None),
        Outcome::Failed { .. }
    ));
    store.recover().unwrap();
    assert!(matches!(
        store.apply_extended(&page("failed-while-crashed", "", 2), None),
        Outcome::Acked { reply: Reply::PageKeys { keys, next: Some(_)}, .. } if keys.len() == 5
    ));
    assert!(matches!(
        store.apply_extended(
            &page("unsupported-fault", "", 1),
            Some(workload_simulation::Interrupt { after_vm_steps: 1 })
        ),
        Outcome::Unsupported { .. }
    ));

    let empty_dir = tempfile::tempdir().unwrap();
    let (mut empty, _) = ProductStore::open_at(empty_dir.path().join("empty.sqlite")).unwrap();
    assert!(matches!(
        empty.apply_extended(&page("empty-store", "", 1), None),
        Outcome::Acked { reply: Reply::PageKeys { keys, next: None }, .. } if keys.is_empty()
    ));
}

/// Direct physical-page comparison, separate from the simulator's newest-change
/// List intent. The fixture is synthetic; it matches the historical row count,
/// not personal record contents. Each side calls the same product API.
#[test]
fn actual_product_bounded_page_and_fetch_all_work() {
    use local_engine::{
        records::{Mutation, Records},
        sqlite_work::WorkMeter,
        storage::{
            s2h::{
                settings::{self, Volume},
                Clock, S2h,
            },
            sqlite, Storage,
        },
    };
    use std::{
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc,
        },
        time::Duration,
    };
    struct Tick(Arc<AtomicU64>);
    impl Clock for Tick {
        fn now_ms(&self) -> u64 {
            self.0.fetch_add(1, Ordering::SeqCst)
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let path = directory
        .path()
        .canonicalize()
        .unwrap()
        .join("pages.sqlite");
    let meter = WorkMeter::new();
    let supply = sqlite::open_owned_observed(
        &path,
        "s2h_records",
        sqlite::Bounds {
            value_bytes: 64 * 1024 * 1024,
            work: u64::MAX,
            deadline: Duration::MAX,
            spend: sqlite::Spend::EachOperation,
            cancel: None,
            busy: Duration::from_secs(2),
        },
        meter.clone(),
    )
    .unwrap();
    let volume = Volume {
        store_bytes: supply.allocated_bytes().unwrap(),
        free_bytes: settings::volume_free_bytes(&path).unwrap(),
    };
    let limits = settings::shipped()
        .unwrap()
        .limits("native", Some(volume))
        .unwrap();
    let mut store = S2h::new(
        supply,
        Box::new(Tick(Arc::new(AtomicU64::new(1_800_000_000_000)))),
        limits,
    )
    .unwrap();
    for n in 0..12180 {
        store.mutate("page-account", "own-records", Mutation {
            id: format!("row-{n:08}"), expected_version: 0, request_key: format!("seed-{n}"),
            deleted: false, value: json!({"kind":"note","title":format!("fixture {n}"),"text":"synthetic record content"}),
        }).unwrap();
    }
    let before = meter.snapshot().unwrap().work;
    let first = store
        .list_page("page-account", "own-records", "", 50)
        .unwrap();
    let bounded = meter.snapshot().unwrap().work;
    assert_eq!(first.items.len(), 50);
    let prefix: Vec<_> = first.items.iter().map(|r| r.id.clone()).collect();
    let mut after = String::new();
    let mut all = Vec::new();
    let mut calls = 0u64;
    loop {
        let page = store
            .list_page("page-account", "own-records", &after, 50)
            .unwrap();
        calls += 1;
        all.extend(page.items.into_iter().map(|r| r.id));
        match page.next {
            Some(next) => after = next,
            None => break,
        }
    }
    let full = meter.snapshot().unwrap().work;
    assert_eq!(all.len(), 12180);
    assert_eq!(&all[..50], prefix.as_slice());
    assert_eq!(bounded.rows_written, before.rows_written);
    assert_eq!(full.rows_written, bounded.rows_written);
    let result = json!({
        "fixture_records":12180,"page_size":50,"scope":"direct actual product list_page API; not complete UI/admission requests",
        "first_page":{"calls":1,"records":50,"sql_statements":bounded.sql_statements-before.sql_statements,"scan_visits":bounded.sqlite_scan_visits-before.sqlite_scan_visits,"rows_written":0},
        "fetch_all":{"calls":calls,"records":all.len(),"sql_statements":full.sql_statements-bounded.sql_statements,"scan_visits":full.sqlite_scan_visits-bounded.sqlite_scan_visits,"rows_written":0}
    });
    assert!(
        full.sqlite_scan_visits - bounded.sqlite_scan_visits
            > bounded.sqlite_scan_visits - before.sqlite_scan_visits
    );
    println!("PRODUCT_PAGE_WORK {result}");
}
