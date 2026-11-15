// src/storage/supplies/tests/roundtrips.rs
//
// Purpose: Measure, for one supply on a real server, the network round trips the record store makes per create,
// update, current read, as-of read, key-ordered pages and declared-order pages. The expanded test also measures
// actual product search, history, receipt replay, soft deletion, custody erasure, retention and cold reopen.
//
// Non-Negotiable Invariants:
// - The count is the supply's own wire counter, read before and after each call, with nothing else using the connection.
// - Each figure is the median of the calls measured, taken after a warm-up so statement preparation (a one-time cost
//   per statement text) is excluded and reported on its own.
//
// Key Concepts:
// - `STORAGE_SUPPLY` and `STORAGE_URL` choose the supply; one line of JSON per run is printed for the report.
//
// Security Considerations:
// - Scratch store names on a local throwaway server only. The expanded test refuses non-loopback endpoints.
// - Rounds are protocol requests, not provider billing units, and local latency is not cloud latency.
// - No native account, permission admission, file bytes or personal state is touched.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use local_engine::{
    records::{Mutation, Records},
    storage::record_store::{
        orders::Declared,
        settings::{shipped, Settings},
        Clock, RecordStore,
    },
};
use serde_json::json;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

#[derive(Clone)]
struct Manual(Arc<AtomicU64>);
impl Clock for Manual {
    fn now_ms(&self) -> i64 {
        self.0.fetch_add(1, Ordering::SeqCst) as i64
    }
}

/// The shipped settings plus one declared order, so the page of 100 in a declared order has something to follow.
fn settings() -> &'static Settings {
    let mut settings = shipped().expect("shipped settings").clone();
    settings.orders.push(Declared {
        why: "roundtrips".into(),
        order: "note/created_at".into(),
        kind: Some("note".into()),
        path: vec!["created_at".into()],
        then: Vec::new(),
        carry: Vec::new(),
    });
    Box::leak(Box::new(settings))
}

fn median(mut figures: Vec<u64>) -> u64 {
    figures.sort_unstable();
    figures[figures.len() / 2]
}

#[test]
fn round_trips_per_operation() {
    let kind = std::env::var("STORAGE_SUPPLY").expect("STORAGE_SUPPLY");
    let url = std::env::var("STORAGE_URL").expect("STORAGE_URL");
    let store_name = format!(
        "m{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() % 100_000_000)
    );
    let supply = storage_supplies::open(&kind, &url, &store_name)
        .unwrap_or_else(|error| panic!("{kind}: {error}"));
    let settings = settings();
    let mut store = RecordStore::with_settings(
        supply,
        Box::new(Manual(Arc::new(AtomicU64::new(1_800_000_000_000)))),
        settings,
        local_engine::storage::record_store::settings::Limits::fixed(1 << 20, 10 << 30),
    )
    .unwrap();
    let put = |id: &str, expected: i64, key: &str, value: serde_json::Value| Mutation {
        id: id.into(),
        expected_version: expected,
        request_key: key.into(),
        deleted: false,
        value,
    };
    let (a, r) = ("account", "own-records");

    // 300 notes so the pages have something to page, then the order is filled.
    for n in 0..300 {
        store.mutate(a, r, put(&format!("note:{n:03}"), 0, &format!("prefill{n}"), json!({"kind": "note", "created_at": 1_700_000_000_000u64 + n, "title": format!("note {n}")}))).unwrap();
    }
    while !store.fill_order(a, r, "note/created_at", 500).unwrap() {}

    let create = measure(&mut store, 20, &mut |store, n| {
        store
            .mutate(
                a,
                r,
                put(
                    &format!("fresh:{n}"),
                    0,
                    &format!("c{n}"),
                    json!({"kind": "other", "title": "fresh"}),
                ),
            )
            .unwrap();
    });
    // The version is tracked here, so reading it is not counted as part of the update.
    let version = std::cell::Cell::new(1);
    let update = measure(&mut store, 20, &mut |store, n| {
        store.mutate(a, r, put("note:001", version.get(), &format!("u{n}"), json!({"kind": "note", "created_at": 1_700_000_000_001u64, "title": format!("edit {n}")}))).unwrap();
        version.set(version.get() + 1);
    });
    let current = measure(&mut store, 20, &mut |store, _| {
        store.get(a, r, "note:002").unwrap();
    });
    let stamp = store
        .mutate(
            a,
            r,
            put(
                "note:003",
                1,
                "stamp",
                json!({"kind": "note", "created_at": 1_700_000_000_003u64, "title": "stamped"}),
            ),
        )
        .unwrap()
        .sequence;
    let as_of = measure(&mut store, 20, &mut |store, _| {
        store.as_of(a, r, "note:003", stamp).unwrap();
    });
    let list = measure(&mut store, 5, &mut |store, _| {
        assert_eq!(store.list_page(a, r, "", 100).unwrap().items.len(), 100);
    });
    let ordered = measure(&mut store, 5, &mut |store, _| {
        assert_eq!(
            store
                .ordered_page(a, r, "note/created_at", None, true, 100)
                .unwrap()
                .records
                .len(),
            100
        );
    });
    println!(
        "ROUNDTRIPS {}",
        json!({"supply": kind, "create": create.0, "update": update.0, "current_read": current.0, "as_of_read": as_of.0, "list_page_100": list.0, "ordered_page_100": ordered.0,
               "max": {"create": create.1, "update": update.1, "current_read": current.1, "as_of_read": as_of.1, "list_page_100": list.1, "ordered_page_100": ordered.1}})
    );
}

type Store = RecordStore<storage_supplies::Dynamic>;

/// The median and the largest number of round trips one call of `call` takes, after a warm-up call that prepares the
/// statements it uses. Calls are numbered so each writes a record of its own.
fn measure(store: &mut Store, calls: usize, call: &mut dyn FnMut(&mut Store, usize)) -> (u64, u64) {
    call(store, 10_000);
    let mut figures = Vec::new();
    for n in 0..calls {
        let before = store.storage().rounds();
        call(store, n);
        figures.push(store.storage().rounds() - before);
    }
    (
        median(figures.clone()),
        figures.into_iter().max().unwrap_or(0),
    )
}

/// Cost coverage against the current product APIs, rather than a separately implemented simulator.
/// This test needs a local disposable server. A supplied server is not a measurement of the hosted
/// AWS/Supabase service; only the actual product's protocol work is observed here.
#[test]
fn expanded_current_product_cost_probe() {
    let kind = std::env::var("STORAGE_SUPPLY").expect("STORAGE_SUPPLY");
    let url = std::env::var("STORAGE_URL").expect("STORAGE_URL");
    let loopback = if kind == "postgres" {
        url.split_whitespace().any(|part| part == "host=127.0.0.1")
    } else {
        // Any `scheme://` URL (http, redis, mongodb, mysql): the authority after the scheme names the host.
        url.split_once("://")
            .and_then(|(_, rest)| rest.split(['/', '?']).next())
            .map(|authority| authority.rsplit('@').next().unwrap_or(authority))
            .is_some_and(|host| {
                host.strip_prefix("127.0.0.1:")
                    .is_some_and(|port| port.parse::<u16>().is_ok())
            })
    };
    assert!(
        loopback,
        "cost probes require an explicit loopback disposable server"
    );
    let store_name = format!(
        "cost{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    );
    let settings = settings();
    let clock = Manual(Arc::new(AtomicU64::new(1_800_000_000_000)));
    let open = || {
        let start = std::time::Instant::now();
        let supply =
            storage_supplies::open(&kind, &url, &store_name).expect("open disposable supply");
        let mut store = RecordStore::with_settings(
            supply,
            Box::new(clock.clone()),
            settings,
            local_engine::storage::record_store::settings::Limits::fixed(1 << 20, 10 << 30),
        )
        .unwrap();
        let opened = json!({
            "rounds": store.storage().rounds(),
            "elapsed_us": start.elapsed().as_micros(),
            "provider_observations": store.storage().measurements().into_iter().map(observation_json).collect::<Vec<_>>(),
        });
        // Keep an owned value rather than returning an opener borrowing the store.
        let _ = &mut store;
        (store, opened)
    };
    let (mut store, initial_open) = open();
    let (a, r) = ("cost-account", "own-records");
    // 120 exercises an unflushed memory tail; 320 crosses the shipped 256-record
    // segment flush so the same methods also exercise persisted search data.
    let fixture_records = std::env::var("COST_PROBE_RECORDS")
        .ok()
        .map(|text| {
            text.parse::<u64>()
                .expect("COST_PROBE_RECORDS is an integer")
        })
        .unwrap_or(320);
    assert!((120..=5000).contains(&fixture_records));
    let put = |id: String, expected: i64, key: String, deleted: bool, value: serde_json::Value| {
        Mutation {
            id,
            expected_version: expected,
            request_key: key,
            deleted,
            value,
        }
    };
    for n in 0..fixture_records {
        store.mutate(a, r, put(format!("note:{n:03}"), 0, format!("prefill{n}"), false,
            json!({"kind":"note", "created_at":1_700_000_000_000u64+n, "title":format!("needle note {n}")}))).unwrap();
    }
    while !store.fill_order(a, r, "note/created_at", 500).unwrap() {}
    for n in 1..=20 {
        store.mutate(a, r, put("note:001".into(), n, format!("history{n}"), false,
            json!({"kind":"note", "created_at":1_700_000_000_001u64,"title":format!("needle history {n}")}))).unwrap();
    }
    let mut results = Vec::new();
    results.push(probe(&mut store, "create", 5, &mut |store, n| {
        let change = store.mutate(a, r, put(format!("fresh:{n}"), 0, format!("create{n}"), false,
            json!({"kind":"note","created_at":1_700_000_100_000u64+n as u64,"title":"needle fresh"})))?;
        assert_eq!(change.version, 1);
        Ok(json!({"version":change.version}))
    }));
    let version = std::cell::Cell::new(1);
    results.push(probe(&mut store, "update", 5, &mut |store, n| {
        let change = store.mutate(a, r, put("note:002".into(), version.get(), format!("update{n}"), false,
            json!({"kind":"note","created_at":1_700_000_000_002u64,"title":format!("needle update {n}")})))?;
        version.set(change.version);
        Ok(json!({"version":change.version}))
    }));
    results.push(probe(&mut store, "current_read", 5, &mut |store, _| {
        let read = store.get(a, r, "note:003")?;
        assert!(read.record.is_some());
        Ok(json!({"found":true}))
    }));
    let stamp = store.stamp(a, r).unwrap();
    results.push(probe(&mut store, "as_of_read", 5, &mut |store, _| {
        let read = store.as_of(a, r, "note:003", stamp)?;
        assert!(read.record.is_some());
        Ok(json!({"found":true}))
    }));
    for limit in [50, 100] {
        results.push(probe(
            &mut store,
            &format!("list_page_{limit}"),
            3,
            &mut |store, _| {
                let page = store.list_page(a, r, "", limit)?;
                assert_eq!(page.items.len(), limit);
                Ok(json!({"items":page.items.len()}))
            },
        ));
        results.push(probe(
            &mut store,
            &format!("ordered_page_{limit}"),
            3,
            &mut |store, _| {
                let page = store.ordered_page(a, r, "note/created_at", None, true, limit)?;
                assert_eq!(page.records.len(), limit);
                Ok(json!({"items":page.records.len()}))
            },
        ));
    }
    results.push(probe(
        &mut store,
        "search_one_field_limit20",
        3,
        &mut |store, _| {
            let found = store.search(a, r, Some("title"), "needle", 20)?;
            assert_eq!(found.records.len(), 20);
            Ok(json!({"items":found.records.len()}))
        },
    ));
    results.push(probe(
        &mut store,
        "search_all_fields_limit20",
        3,
        &mut |store, _| {
            let found = store.search(a, r, None, "needle", 20)?;
            assert_eq!(found.records.len(), 20);
            Ok(json!({"items":found.records.len()}))
        },
    ));
    results.push(probe(&mut store, "history_page20", 3, &mut |store, _| {
        let history = store.history(a, r, "note:001", None, 20)?;
        assert_eq!(history.versions.len(), 20);
        Ok(json!({"items":history.versions.len()}))
    }));
    let replay = put(
        "receipt-record".into(),
        0,
        "exact-retry".into(),
        false,
        json!({"kind":"note","title":"receipt"}),
    );
    let first = store.mutate(a, r, replay.clone()).unwrap();
    results.push(probe(
        &mut store,
        "receipt_retry_warm",
        5,
        &mut |store, _| {
            let again = store.mutate(a, r, replay.clone())?;
            assert_eq!(again, first);
            Ok(json!({"same_acknowledged_change":true,"version":again.version}))
        },
    ));
    results.push(probe(&mut store, "soft_delete", 5, &mut |store, n| {
        let id = format!("fresh:{n}");
        let change = store.mutate(
            a,
            r,
            put(
                id.clone(),
                1,
                format!("delete{n}"),
                true,
                serde_json::Value::Null,
            ),
        )?;
        assert!(change.deleted);
        // Readback is outside this operation's counted span, in its own probe below.
        Ok(json!({"deleted":change.deleted,"id":id}))
    }));
    results.push(probe(&mut store, "read_deleted", 3, &mut |store, _| {
        assert!(store.get(a, r, "fresh:0")?.record.is_none());
        Ok(json!({"hidden":true}))
    }));
    results.push(probe(
        &mut store,
        "erase_one_record_to_custody",
        3,
        &mut |store, n| {
            let erased = store.erase(a, r, &format!("note:{:03}", 10 + n))?;
            assert!(erased.is_some());
            Ok(json!({"custody_created":true}))
        },
    ));
    drop(store);
    let (mut store, cold_open) = open();
    results.push(probe(
        &mut store,
        "receipt_retry_after_reopen",
        1,
        &mut |store, _| {
            let again = store.mutate(a, r, replay.clone())?;
            assert_eq!(again, first);
            Ok(json!({"same_acknowledged_change":true,"version":again.version}))
        },
    ));
    drop(store);
    let (mut store, cold_search_open) = open();
    results.push(probe(
        &mut store,
        "first_search_after_reopen",
        1,
        &mut |store, _| {
            let found = store.search(a, r, None, "needle", 20)?;
            assert_eq!(found.records.len(), 20);
            Ok(json!({"items":found.records.len()}))
        },
    ));
    // Force the declared production retention window to pass. On remote supplies that cannot
    // overwrite removed bytes, custody remains inaccessible but retained; this is not called
    // successful physical destruction, even if history/tombstone expiry succeeds.
    clock
        .0
        .fetch_add(settings.undo_windows.records + 1, Ordering::SeqCst);
    results.push(probe(
        &mut store,
        "retire_after_undo_window",
        1,
        &mut |store, _| {
            let removed = store.retire(a, r)?;
            Ok(json!({"reported_rows_removed":removed}))
        },
    ));
    let retained = store
        .history(a, r, "note:001", None, 25)
        .unwrap()
        .versions
        .len();
    let no_double = store
        .get(a, r, "receipt-record")
        .unwrap()
        .record
        .unwrap()
        .version;
    assert_eq!(no_double, 1);
    println!(
        "PRODUCT_COST_PROBE {}",
        json!({
            "supply":kind,"fixture_records":fixture_records,"history_updates":20,"initial_open":initial_open,
            "cold_open":cold_open,"cold_search_open":cold_search_open,
            "undo_windows_records":settings.undo_windows.records,"history_versions_after_retire":retained,
            "results":results,
            "coverage":"actual product record store methods on a local disposable protocol server; no native account or network provider billing measured",
            "unmeasured":["provider billed units and invoice rounding","remote-region latency and throughput","Postgres server execution time and provider capacity","provider egress billing and backup bytes","native rights/admission and resource affinity","guaranteed physical destruction on remote supplies","concurrent multi-writer contention"]
        })
    );
}

/// The complete observed span for one product method, including its reads and failed attempts.
/// No warm-up is hidden: samples are emitted individually, so first-use/cache work is visible.
fn probe(
    store: &mut Store,
    name: &str,
    calls: usize,
    call: &mut dyn FnMut(
        &mut Store,
        usize,
    ) -> Result<serde_json::Value, local_engine::records::Error>,
) -> serde_json::Value {
    let mut samples = Vec::new();
    for n in 0..calls {
        let before = store.storage().rounds();
        let observations_before = store.storage().measurement_count();
        let start = std::time::Instant::now();
        let result = call(store, n);
        let elapsed = start.elapsed().as_micros();
        let rounds = store.storage().rounds() - before;
        let observations = store.storage().measurements_since(observations_before).into_iter().map(observation_json).collect::<Vec<_>>();
        let outcome = match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":format!("{error:?}")}),
        };
        samples.push(json!({"rounds":rounds,"elapsed_us":elapsed,"provider_observations":observations,"outcome":outcome}));
    }
    assert!(
        samples.iter().all(|sample| sample["outcome"]["ok"] == true),
        "product method {name} refused measured work: {}",
        serde_json::json!(samples)
    );
    let mut rounds: Vec<u64> = samples
        .iter()
        .map(|s| s["rounds"].as_u64().unwrap())
        .collect();
    rounds.sort_unstable();
    json!({"operation":name,"median_rounds":rounds[rounds.len()/2],"samples":samples})
}

fn observation_json(observation: storage_supplies::provider_units::Observation) -> serde_json::Value {
    use storage_supplies::provider_units::Quantity;
    fn number(value: Quantity<u64>) -> serde_json::Value {
        match value { Quantity::ProviderReported(v) => json!({"provider_reported":v}), Quantity::Measured(v) => json!({"measured":v}), Quantity::Inferred(v) => json!({"inferred":v}), Quantity::Unknown => serde_json::Value::Null }
    }
    fn floating(value: Quantity<f64>) -> serde_json::Value {
        match value { Quantity::ProviderReported(v) => json!({"provider_reported":v}), Quantity::Measured(v) => json!({"measured":v}), Quantity::Inferred(v) => json!({"inferred":v}), Quantity::Unknown => serde_json::Value::Null }
    }
    let status = match observation.response_status {
        Quantity::ProviderReported(v) => json!({"provider_reported":v}),
        Quantity::Measured(v) => json!({"measured":v}),
        Quantity::Inferred(v) => json!({"inferred":v}),
        Quantity::Unknown => serde_json::Value::Null,
    };
    json!({
        "provider":observation.provider,"operation":observation.operation,"scope":observation.scope,"unit":observation.unit,
        "source_revision":observation.source_revision,"started_unix_ms":observation.started_unix_ms,
        "client_elapsed_ms":observation.elapsed_ms,"server_time_ms":number(observation.server_time_ms),"response_status":status,
        "attempts":number(observation.attempts),"errors":number(observation.errors),"requests":number(observation.requests),
        "request_bytes":number(observation.request_bytes),"items":number(observation.items),"response_bytes":number(observation.response_bytes),
        "capacity_multiplier":floating(observation.capacity_multiplier),
        "consumed_capacity_units":floating(observation.consumed_capacity_units)
    })
}
