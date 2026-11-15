// Concurrent writes of the account's own records: requests that arrive together on one selected account each commit
// or answer a definite refusal; none is answered `original_workspace_source_unavailable` (not_started) merely because
// another command held the account's write transaction. Same fixture as controls.rs; every record word is synthetic.

fn answer_of(reply: &Value) -> Value {
    reply["result"]["structuredContent"].clone()
}

fn one_note(value: Value) -> Value {
    json!([{"id":"note:behind","type":"note","value":value}])
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_own_record_writes_each_commit_rather_than_answer_source_unavailable() {
    let fixture = Fixture::new();
    let app = route_table(&fixture);
    let before = state(&fixture);
    let writes = (0..8).map(|n| {
        let (app, token) = (app.clone(), fixture.token.clone());
        tokio::spawn(async move {
            let records = json!([{"id":format!("note:together-{n}"),"type":"note","value":{"words":format!("TOGETHER-{n}")}}]);
            reply(&app, records_request(Some(&token), &format!("together-{n}"), records)).await.1
        })
    });
    let answers: Vec<Value> = futures::future::join_all(writes).await.into_iter().map(Result::unwrap).collect();
    for answer in &answers {
        assert_eq!(answer_of(answer), json!({"changed":true,"write_count":1}), "{answer}");
    }
    let after = state(&fixture);
    assert!(after.0 > before.0, "the writes kept their records");
    assert_eq!(after.1, before.1 + 8, "each write kept one command record");
}

/// Hold the write lock of the account's records file on another connection (another process, a startup copy) until
/// the answer of `released` is ready, then for `after` more.
fn hold_write_lock(fixture: &Fixture, after: std::time::Duration)
    -> (std::sync::mpsc::Sender<()>, std::thread::JoinHandle<()>) {
    let path = fixture.root.join("records.sqlite");
    let (held, release) = (std::sync::mpsc::channel::<()>(), std::sync::mpsc::channel::<()>());
    let lock_owner = std::thread::spawn(move || {
        let other = Connection::open(path).unwrap();
        other.execute_batch("BEGIN IMMEDIATE").unwrap();
        held.0.send(()).unwrap();
        release.1.recv().unwrap();
        std::thread::sleep(after);
        other.execute_batch("ROLLBACK").unwrap();
    });
    held.1.recv().unwrap();
    (release.0, lock_owner)
}

/// A write that arrives while another connection briefly holds the file's write lock waits for it and commits once,
/// instead of answering `original_workspace_source_unavailable` (not_started). Before, the command's first
/// transaction did not wait at all (`busy_timeout(0)`).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_write_waits_for_a_write_lock_another_connection_briefly_holds() {
    let fixture = Fixture::new();
    let app = route_table(&fixture);
    let before = state(&fixture);
    let (release, lock_owner) = hold_write_lock(&fixture, std::time::Duration::from_millis(100));
    let pending = {
        let (app, token) = (app.clone(), fixture.token.clone());
        tokio::spawn(async move {
            reply(&app, records_request(Some(&token), "behind-lock", one_note(json!({"words":"BEHIND"})))).await.1
        })
    };
    release.send(()).unwrap();
    let answer = pending.await.unwrap();
    lock_owner.join().unwrap();
    assert_eq!(answer_of(&answer), json!({"changed":true,"write_count":1}), "{answer}");
    assert_eq!(state(&fixture).1, before.1 + 1, "one command record");
    // The same request again answers its saved receipt and writes nothing more.
    let after = state(&fixture);
    let (_, again) = reply(&app, records_request(Some(&fixture.token), "behind-lock", one_note(json!({"words":"BEHIND"})))).await;
    assert_eq!(answer_of(&again), answer_of(&answer), "{again}");
    assert_eq!(state(&fixture), after);
}

/// The wait is bounded: a lock held past it answers not_started and writes nothing, and the same request after the
/// lock is given up commits once.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_write_lock_held_past_the_wait_answers_not_started_and_writes_nothing() {
    let fixture = Fixture::new();
    let app = route_table(&fixture);
    let before = state(&fixture);
    let (release, lock_owner) = hold_write_lock(&fixture, std::time::Duration::from_millis(1_800));
    release.send(()).unwrap();
    let (_, refused) = reply(&app, records_request(Some(&fixture.token), "past-lock", one_note(json!({"words":"PAST"})))).await;
    assert_eq!(refused["result"]["isError"], true, "{refused}");
    assert_eq!(answer_of(&refused)["outcome"], "not_started", "{refused}");
    assert_eq!(state(&fixture), before, "a write refused at the lock writes nothing");
    lock_owner.join().unwrap();
    let (_, written) = reply(&app, records_request(Some(&fixture.token), "past-lock", one_note(json!({"words":"PAST"})))).await;
    assert_eq!(answer_of(&written), json!({"changed":true,"write_count":1}), "{written}");
    assert_eq!(state(&fixture).1, before.1 + 1, "one command record");
}

/// The primary account mutex represents a long read elsewhere in the process. A record write has a separate
/// request-owned command context; this test never releases that read until the real MCP write and readback answer.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_records_write_finishes_while_a_long_read_holds_the_primary_account() {
    let fixture = Fixture::new();
    let owner = Arc::new(Mutex::new(fixture.selected()));
    let admission = Arc::new(Mutex::new(owner.lock().unwrap().admission_owner().unwrap()));
    let app = crate::native_boot::mcp_local::route_table_with_admission(
        owner.clone(),
        admission,
        sign_in(&owner),
        "127.0.0.1:28788".into(),
    )
    .unwrap();
    let write = crate::record_write_model::write_command::Command::shipped()
        .unwrap()
        .operation();
    let read = crate::record_value::account_routes::Door::shipped()
        .unwrap()
        .read_operation();
    // Warm the actual sign-in's use-note path before the independent owner is exercised.
    let (_, first) = reply(
        &app,
        records_request(
            Some(&fixture.token),
            "before-primary-hold",
            json!([{"id":"note:before-hold","type":"note","value":{"words":"BEFORE"}}]),
        ),
    )
    .await;
    assert_eq!(
        answer_of(&first),
        json!({"changed":true,"write_count":1}),
        "{first}"
    );
    let held = owner.lock().unwrap();
    let started = std::time::Instant::now();
    let input = json!({"records":[{"id":"note:held-write","type":"note","value":{"words":"DURABLE_WHILE_HELD"}}]});
    let (_, written) = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        reply(
            &app,
            door_request(&fixture.token, "while-primary-held", write, input.clone()),
        ),
    )
    .await
    .expect("a records write waited for the primary account's mutex");
    assert_eq!(
        answer_of(&written),
        json!({"changed":true,"write_count":1}),
        "{written}"
    );
    let (_, readback) = reply(
        &app,
        door_request(
            &fixture.token,
            "held-write-readback",
            read,
            json!({"id":"note:held-write","type":"note"}),
        ),
    )
    .await;
    assert_eq!(
        answer_of(&readback)["value"]["words"],
        "DURABLE_WHILE_HELD",
        "{readback}"
    );
    let (_, duplicate) = reply(
        &app,
        door_request(&fixture.token, "while-primary-held", write, input),
    )
    .await;
    assert_eq!(answer_of(&duplicate), answer_of(&written), "{duplicate}");
    println!(
        "records-write primary-owner-held: committed=1 duplicate=1 readback=1 elapsed_ms={:.3}",
        started.elapsed().as_secs_f64() * 1000.0
    );
    drop(held);
}

/// Exercise the actual admitted MCP reader and command consumer together, not just storage handles. Each successful
/// receipt is followed by an authoritative record read; concurrent read load continues until all writes finish.
async fn records_write_load(list_pages: bool) {
    let fixture = Fixture::new();
    let owner = Arc::new(Mutex::new(fixture.selected()));
    let admission = Arc::new(Mutex::new(owner.lock().unwrap().admission_owner().unwrap()));
    let app = crate::native_boot::mcp_local::route_table_with_admission(
        owner.clone(),
        admission,
        sign_in(&owner),
        "127.0.0.1:28788".into(),
    )
    .unwrap();
    let read = crate::record_value::account_routes::Door::shipped()
        .unwrap()
        .read_operation();
    let list = crate::record_value::account_routes::Door::shipped().unwrap().list_operation();
    let seed_rows = 128;
    let seeds = (0..seed_rows).map(|index| json!({"id":format!("note:load-seed-{index:03}"),"type":"note","value":{"words":"READ_LOAD"}})).collect::<Vec<_>>();
    let (_, seeded) = reply(
        &app,
        records_request(
            Some(&fixture.token),
            "load-seed",
            json!(seeds),
        ),
    )
    .await;
    assert_eq!(
        answer_of(&seeded),
        json!({"changed":true,"write_count":seed_rows}),
        "{seeded}"
    );
    if list_pages {
        // Admit one list read before the measured overlap. Cold parallel catalogue initialization is a separate
        // observed base/candidate failure, recorded in docs/list-write-concurrency.md.
        let (_, warm) = reply(&app, door_request(&fixture.token, "list-before-load", list, json!({"type":"note","limit":16}))).await;
        assert_eq!(answer_of(&warm)["records"].as_array().unwrap().len(), 16, "{warm}");
    }
    let readers = 8;
    let writes = 24;
    let barrier = Arc::new(tokio::sync::Barrier::new(readers + 1));
    let finished = Arc::new(AtomicBool::new(false));
    let mut tasks = Vec::new();
    for reader in 0..readers {
        let (app, token, barrier, finished) = (
            app.clone(),
            fixture.token.clone(),
            barrier.clone(),
            finished.clone(),
        );
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            let mut count = 0;
            while !finished.load(std::sync::atomic::Ordering::Acquire) || count == 0 {
                let (_, answer) = reply(
                    &app,
                    door_request(
                        &token,
                        &format!("load-read-{reader}-{count}"),
                        if !list_pages || reader % 2 == 0 { read } else { list },
                        if !list_pages || reader % 2 == 0 { json!({"id":"note:load-seed-000","type":"note"}) } else { json!({"type":"note","limit":16}) },
                    ),
                )
                .await;
                if !list_pages || reader % 2 == 0 {
                    assert_eq!(answer_of(&answer)["value"]["words"], "READ_LOAD", "{answer}");
                } else {
                    let answer = answer_of(&answer);
                    let rows = answer["records"].as_array().unwrap_or_else(|| panic!("the admitted list read returns its page: {answer}"));
                    assert_eq!(rows.len(), 16);
                    assert!(rows.iter().all(|row| row["value"]["words"].as_str().is_some_and(|words| words=="READ_LOAD" || words.starts_with("WRITE-"))));
                }
                count += 1;
                tokio::task::yield_now().await;
            }
            count
        }));
    }
    barrier.wait().await;
    let started = std::time::Instant::now();
    let mut elapsed = Vec::new();
    for index in 0..writes {
        let began = std::time::Instant::now();
        let (_, answer) = reply(&app, records_request(Some(&fixture.token), &format!("load-write-{index}"),
            json!([{"id":format!("note:load-{index}"),"type":"note","value":{"words":format!("WRITE-{index}")}}]))).await;
        elapsed.push(began.elapsed());
        assert_eq!(
            answer_of(&answer),
            json!({"changed":true,"write_count":1}),
            "{answer}"
        );
    }
    finished.store(true, std::sync::atomic::Ordering::Release);
    let mut completed_reads = 0;
    for task in tasks {
        completed_reads += task.await.unwrap();
    }
    for index in 0..writes {
        let (_, answer) = reply(
            &app,
            door_request(
                &fixture.token,
                &format!("load-check-{index}"),
                read,
                json!({"id":format!("note:load-{index}"),"type":"note"}),
            ),
        )
        .await;
        assert_eq!(
            answer_of(&answer)["value"]["words"],
            format!("WRITE-{index}"),
            "{answer}"
        );
    }
    elapsed.sort_unstable();
    let list_readers = if list_pages { readers/2 } else { 0 };
    let point_readers = readers-list_readers;
    println!("records-write read-load: readers={readers} list_readers={list_readers} point_readers={point_readers} seed_rows={seed_rows} reads={completed_reads} writes={writes} durable_readbacks={writes} write_p50_ms={:.3} write_max_ms={:.3} elapsed_ms={:.3}",
        elapsed[elapsed.len()/2].as_secs_f64()*1000.0,
        elapsed.last().unwrap().as_secs_f64()*1000.0, started.elapsed().as_secs_f64()*1000.0);
    assert!(completed_reads >= readers);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn records_writes_land_with_many_admitted_reads_running() {
    records_write_load(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn records_writes_land_with_many_admitted_list_pages_running() {
    records_write_load(true).await;
}

/// A personal deletion committed after a caused command but before it answers remains an outside change. It must
/// not be swallowed by the run's own-change marker when independent command contexts execute concurrently.
#[tokio::test(flavor = "multi_thread")]
async fn a_caused_write_never_claims_another_callers_concurrent_removal() {
    let fixture = Fixture::new();
    let selected = Arc::new(Mutex::new(fixture.selected()));
    let app = crate::native_boot::mcp_local::route_table(selected.clone(), "127.0.0.1:28788".into()).unwrap();
    let write = crate::record_write_model::write_command::Command::shipped().unwrap().operation();
    for id in ["note-woken", "note-woken-outside"] {
        let (_, made) = reply(&app, door_request(&fixture.token, &format!("setup-{id}"), write,
            json!({"records":[{"id":id,"type":"note","value":{"words":"synthetic"}}]}))).await;
        assert_eq!(answer_of(&made), json!({"changed":true,"write_count":1}), "{made}");
    }
    let waker = crate::wake::Waker::shipped().unwrap();
    let rows = vec![crate::wake::Row { origin: crate::wake::Origin::Engine, tool: "remover".into(),
        wakes: json!([{"id":"on-woken","on":{"record":{"resource":"own-records","prefix":"note-woken"}},
            "budget":{"steps":10,"wall_ms":60_000}}]) }];
    let wakes = waker.declared(&rows).unwrap();
    let remover = Remover { app: &app, token: &fixture.token, runs: std::cell::Cell::new(0) };
    let session = fixture.session.clone();
    let tick = || tokio::task::block_in_place(|| {
        let mut source = OwnSource { selected: &selected, session: &session };
        waker.tick(OWNER, &mut source, &crate::storage::record_store::RealClock, &remover, &wakes).unwrap()
    });
    assert_eq!(tick().admitted, 0);
    let (_, trigger) = reply(&app, door_request(&fixture.token, "trigger-concurrent-removal", write,
        json!({"records":[{"id":"note-woken","type":"note","value":{"words":"trigger"}}]}))).await;
    assert_eq!(answer_of(&trigger), json!({"changed":true,"write_count":1}), "{trigger}");
    let (other_app, token, runtime) = (app.clone(), fixture.token.clone(), tokio::runtime::Handle::current());
    crate::local_account::record_writer::native_command_context::AFTER_COMMIT.lock().unwrap().push((
        fixture.root.join("records.sqlite"), Box::new(move || {
            let (_, outside) = runtime.block_on(reply(&other_app, door_request(&token, "outside-removal-between-commit-and-answer", write,
                json!({"records":[{"id":"note-woken-outside","type":"note","value":null}]}))));
            assert_eq!(answer_of(&outside), json!({"changed":true,"write_count":1}), "{outside}");
        })
    ));
    assert_eq!(tick().admitted, 1, "the trigger runs the remover");
    assert_eq!(tick().admitted, 1, "the concurrent personal removal remains an outside change");
    assert_eq!(tick().admitted, 0, "the run's own removal is still suppressed");
}

/// A new account has not warmed a generic read. The first request after a
/// confirmed command must return the exact record without a caller retry.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn first_read_after_successful_write_returns_the_record_on_a_cold_account() {
    for n in 0..10 {
        let fixture = Fixture::new();
        let app = route_table(&fixture);
        let value = json!({"words":format!("COLD_FIRST_READ_{n}")});
        let (_, wrote) = reply(&app, records_request(Some(&fixture.token), "cold-write", one_note(value.clone()))).await;
        assert_eq!(answer_of(&wrote), json!({"changed":true,"write_count":1}), "{wrote}");
        let (_, read) = reply(&app, door_call(&fixture.token, "first-read", "@own-records", "records:read", json!({"id":"note:behind"}))).await;
        assert_eq!(read["result"]["isError"], false, "first read {n}: {read}");
        assert_eq!(answer_of(&read)["value"], value, "first read {n}: {read}");
    }
}

/// The real read owner must have its installed disclosure policy when startup
/// returns. Delay the actual model installation rather than prewarming a read.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn first_read_after_startup_waits_for_the_required_policy_install() {
    let fixture = Fixture::new();
    let tools = fixture.root.join("workshop");
    let carried = fixture.root.join("carried-tools");
    fs::rename(&tools, &carried).unwrap();
    let root = fixture.root.clone();
    let (began, started) = std::sync::mpsc::channel();
    let (release, proceed) = std::sync::mpsc::channel();
    let mut startup = tokio::task::spawn_blocking(move || {
        crate::native_entry::computer::start_tools(true, move || {
            began.send(()).unwrap();
            proceed.recv().unwrap();
            fs::rename(root.join("carried-tools"), root.join("workshop")).unwrap();
        }, || {})
    });
    started.recv().unwrap();
    let returned = tokio::time::timeout(std::time::Duration::from_millis(100), &mut startup).await;
    let returned_early = returned.is_ok();
    release.send(()).unwrap();
    let maintenance = match returned {
        Ok(result) => result.unwrap(),
        Err(_) => startup.await.unwrap(),
    };
    maintenance.join().unwrap();
    let app = route_table(&fixture);
    let value = json!({"words":"FIRST_READ_AFTER_REQUIRED_SETUP"});
    let (_, wrote) = reply(&app, records_request(Some(&fixture.token), "startup-write", one_note(value.clone()))).await;
    let (_, read) = reply(&app, door_call(&fixture.token, "startup-first-read", "@own-records", "records:read", json!({"id":"note:behind"}))).await;
    assert!(!returned_early, "startup returned while its required record policy was still absent");
    assert_eq!(answer_of(&wrote), json!({"changed":true,"write_count":1}), "{wrote}");
    assert_eq!(read["result"]["isError"], false, "the first read needs no retry: {read}");
    assert_eq!(answer_of(&read)["value"], value, "{read}");
}

/// First setup is required; maintenance must stay independent of foreground
/// reads. Keep maintenance blocked through the confirmed write and first read.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn background_tool_maintenance_does_not_hold_the_first_read() {
    let fixture = Fixture::new();
    let (release, proceed) = std::sync::mpsc::channel();
    let maintenance = crate::native_entry::computer::start_tools(true, || {}, move || { proceed.recv().unwrap(); });
    let app = route_table(&fixture);
    let value = json!({"words":"READ_WHILE_MAINTENANCE_WAITS"});
    let (_, wrote) = reply(&app, records_request(Some(&fixture.token), "maintenance-write", one_note(value.clone()))).await;
    let (_, read) = reply(&app, door_call(&fixture.token, "maintenance-first-read", "@own-records", "records:read", json!({"id":"note:behind"}))).await;
    release.send(()).unwrap();
    maintenance.join().unwrap();
    assert_eq!(answer_of(&wrote), json!({"changed":true,"write_count":1}), "{wrote}");
    assert_eq!(read["result"]["isError"], false, "{read}");
    assert_eq!(answer_of(&read)["value"], value, "{read}");
}

/// One existing account can wait on an unavailable peer while another account
/// starts, writes and reads. The computer must start its listener and follower
/// before existing-account recovery finishes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resumed_account_recovery_does_not_hold_another_accounts_first_read() {
    let fixture = Fixture::new();
    let (began, started) = std::sync::mpsc::channel();
    let (release, proceed) = std::sync::mpsc::channel();
    let mut resumed = tokio::task::spawn_blocking(move || {
        crate::native_entry::computer::start_tools(false, move || {
            began.send(()).unwrap();
            proceed.recv().unwrap();
        }, || {})
    });
    started.recv().unwrap();
    let returned = tokio::time::timeout(std::time::Duration::from_secs(1), &mut resumed).await;
    let app = route_table(&fixture);
    let value = json!({"words":"OTHER_ACCOUNT_RECOVERY_IS_INDEPENDENT"});
    let (_, wrote) = reply(&app, records_request(Some(&fixture.token), "resumed-other-write", one_note(value.clone()))).await;
    let (_, read) = reply(&app, door_call(&fixture.token, "resumed-other-first-read", "@own-records", "records:read", json!({"id":"note:behind"}))).await;
    release.send(()).unwrap();
    let returned_while_recovery_waited = returned.is_ok();
    let maintenance = match returned {
        Ok(result) => result.unwrap(),
        Err(_) => resumed.await.unwrap(),
    };
    maintenance.join().unwrap();
    assert!(returned_while_recovery_waited, "one account's recovery held the computer's startup");
    assert_eq!(answer_of(&wrote), json!({"changed":true,"write_count":1}), "{wrote}");
    assert_eq!(read["result"]["isError"], false, "{read}");
    assert_eq!(answer_of(&read)["value"], value, "{read}");
}


/// M08: one retained MCP client writes while a separately opened client reads.
/// Each read has a new request/disclosure and needs no causal token or retry.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn immediate_tool_reads_include_100_acknowledged_creates_updates_and_deletes() {
    let fixture = Fixture::new();
    // Two endpoint clients of one selected authority. Opening a second full
    // startup owner would correctly trip the account's single-owner lock.
    let owner = Arc::new(Mutex::new(fixture.selected()));
    let writer = crate::native_boot::mcp_local::route_table(owner.clone(), "127.0.0.1:28788".into()).unwrap();
    let reader = crate::native_boot::mcp_local::route_table(owner, "127.0.0.1:28788".into()).unwrap();
    for n in 0..100 {
        for (phase, value) in [
            ("create", json!({"words":format!("created-{n}")})),
            ("update", json!({"words":format!("updated-{n}")})),
            ("delete", Value::Null),
        ] {
            let (_, wrote) = reply(&writer, records_request(Some(&fixture.token),
                &format!("m08-{phase}-{n}"), one_note(value.clone()))).await;
            assert_eq!(wrote["result"]["isError"], false, "{phase} {n}: {wrote}");
            assert_eq!(answer_of(&wrote), json!({"changed":true,"write_count":1}));
            let (_, read) = reply(&reader, door_call(&fixture.token, &format!("m08-read-{phase}-{n}"),
                "@own-records", "records:read", json!({"id":"note:behind"}))).await;
            assert_eq!(read["result"]["isError"], false, "{phase} {n}: {read}");
            let one = answer_of(&read);
            if value.is_null() {
                assert_eq!(one["id"], "note:behind", "deleted {n}: {one}");
                assert_eq!(one.get("value"), Some(&Value::Null), "deleted {n}: {one}");
            } else {
                assert_eq!(one["value"], value, "{phase} {n}: {one}");
            }
        }
    }
    // These routes offer tokenless current reads, not arbitrary replica/history
    // positions. Untrusted causal-looking evidence is refused, never ignored.
    for evidence in [
        json!({"resource":"another-resource","history":"another-history","position":1}),
        json!({"resource":"@own-records","history":"unknown","position":u64::MAX}),
    ] {
        let (_, refused) = reply(&reader, door_call(&fixture.token, "m08-untrusted-floor",
            "@own-records", "records:read", json!({"id":"note:behind", "after":evidence}))).await;
        assert_eq!(refused["result"]["isError"], true, "{refused}");
    }
}
