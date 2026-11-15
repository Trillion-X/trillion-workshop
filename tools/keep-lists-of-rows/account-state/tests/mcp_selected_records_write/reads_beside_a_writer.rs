// Every read the account routes answer, with the account's own owner held by a long write past the read's whole
// deadline. A read's answer waits on no writer: not the result of an earlier write, not a workspace label, not the
// connection rows a tool run reads. Synthetic account and words only.

const HELD_FOR: std::time::Duration = std::time::Duration::from_millis(1_500);

fn beside_a_writer() -> (Fixture, Arc<Mutex<crate::native_boot::SelectedAccount>>, axum::Router) {
    let fixture = Fixture::new();
    let owner = Arc::new(Mutex::new(fixture.selected()));
    let admission = Arc::new(Mutex::new(owner.lock().unwrap().admission_owner().unwrap()));
    let app = crate::native_boot::mcp_local::route_table_with_admission(
        owner.clone(), admission, sign_in(&owner), "127.0.0.1:28788".into()).unwrap();
    (fixture, owner, app)
}

/// The result of an earlier write is read again while the owner is held, as the record's own write is recovered after a
/// timeout: it answers the saved receipt, not `selected_owner_unavailable`.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn a_write_result_read_answers_while_the_owner_is_held() {
    let (fixture, owner, app) = beside_a_writer();
    let input = json!({"records":[{"id":"result-1","type":"note","value":{"words":"HELD"},"expected":null}]});
    let (_, written) = reply(&app, door_request(&fixture.token, "original", "records:write", input.clone())).await;
    assert_eq!(written["result"]["isError"], false, "{written}");

    let held = owner.lock().unwrap();
    let started = std::time::Instant::now();
    let asked = json!({"request_key":"original","operation":"records:write","input":input});
    let (_, read) = reply(&app, door_request(&fixture.token, "delivery", "records:result", asked)).await;
    assert_eq!(read["result"], written["result"], "{read}");
    assert!(started.elapsed() < HELD_FOR, "a result read waited on the account owner: {:?}", started.elapsed());
    drop(held);
}

/// A run's exact workspace label is read while the owner is held.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn a_workspace_read_answers_while_the_owner_is_held() {
    use crate::account_rights::run_capability::{mint, Rights};
    let (fixture, owner, app) = beside_a_writer();
    let own = "workspace-probe:own";
    let raw = json!([{"id":"theme-a","tokens":{"surface":"paper"}}]);
    shared_fixture_record(&fixture, own, Some(raw.clone()));
    let capability = mint(OWNER, fixture.token.as_bytes(),
        Rights::declared(&json!({"fd":3,"rights":[{"kind":"@own-records","id":own,"operations":["workspace:read"]}]})).unwrap(),
        None, std::time::Duration::from_secs(60)).unwrap();
    let token = capability.token().to_owned();
    let selection = json!({"selection":{"labels":[own],"prefixes":[]}});
    let (_, first) = reply(&app, door_request(&token, "first", "workspace:read", selection.clone())).await;
    assert_eq!(first["result"]["structuredContent"]["status"], 200, "{first}");

    let held = owner.lock().unwrap();
    let started = std::time::Instant::now();
    let (_, read) = reply(&app, door_request(&token, "held", "workspace:read", selection)).await;
    assert_eq!(read["result"]["structuredContent"]["status"], 200, "{read}");
    assert!(started.elapsed() < HELD_FOR, "a workspace read waited on the account owner: {:?}", started.elapsed());
    drop(held);
}

/// The connection rows a tool run reads answer while the owner is held: the read is not queued behind the writer.
#[test]
fn the_connection_rows_a_tool_run_reads_answer_while_the_owner_is_held() {
    use crate::tool_runs::tools::connection_names::{OwnerRows, Rows};
    let fixture = Fixture::new();
    let owner = Arc::new(Mutex::new(fixture.selected()));
    let admission = Arc::new(Mutex::new(owner.lock().unwrap().admission_owner().unwrap()));
    let rows = OwnerRows { owner: Arc::downgrade(&admission) };
    let held = owner.lock().unwrap();
    let (answered, heard) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || { let _ = answered.send(rows.rows().is_some()); });
    let in_time = heard.recv_timeout(HELD_FOR);
    drop(held);
    reader.join().unwrap();
    assert_eq!(in_time, Ok(true), "the connection rows waited on the account owner");
}

/// A decision call of a case with many evidence rows is about 150 sequential reads at the door. Held by a long write, the
/// whole run answers, each read well inside its deadline.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn a_hundred_and_fifty_sequential_reads_answer_while_the_owner_is_held() {
    let (fixture, owner, app) = beside_a_writer();
    let door = crate::record_value::account_routes::Door::shipped().unwrap();
    let (read, write) = (door.read_operation(), crate::record_write_model::write_command::Command::shipped().unwrap().operation());
    let note = json!({"records":[{"id":"note-1","type":"note","value":{"words":"HELD"}}]});
    let (_, made) = reply(&app, door_request(&fixture.token, "kept", write, note)).await;
    assert_eq!(made["result"]["isError"], false, "{made}");
    let (_, first) = reply(&app, door_request(&fixture.token, "first", read, json!({"id":"note-1","type":"note"}))).await;
    assert_eq!(first["result"]["isError"], false, "{first}");

    let held = owner.lock().unwrap();
    let started = std::time::Instant::now();
    for n in 0..150 {
        let (_, one) = reply(&app, door_request(&fixture.token, &format!("held-{n}"), read, json!({"id":"note-1","type":"note"}))).await;
        assert_eq!(one["result"]["structuredContent"]["value"]["words"], "HELD", "read {n}: {one}");
    }
    assert!(started.elapsed() < std::time::Duration::from_secs(10), "150 reads took {:?} beside a held owner", started.elapsed());
    drop(held);
}

/// A real bulk write (many records in batches through the account's own writer) runs while reads of the account answer
/// beside it: records:read, records:list and a result read each answer inside their deadline for the whole write.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reads_answer_beside_a_real_bulk_write() {
    let (fixture, _owner, app) = beside_a_writer();
    let door = crate::record_value::account_routes::Door::shipped().unwrap();
    let (read, list, write) = (door.read_operation(), door.list_operation(),
        crate::record_write_model::write_command::Command::shipped().unwrap().operation());
    let seed = json!({"records":[{"id":"note-0","type":"note","value":{"words":"SEED"},"expected":null}]});
    let (_, made) = reply(&app, door_request(&fixture.token, "seed", write, seed.clone())).await;
    assert_eq!(made["result"]["isError"], false, "{made}");

    let writing = {
        let (app, token) = (app.clone(), fixture.token.clone());
        tokio::spawn(async move {
            for batch in 0..40 {
                let records: Vec<Value> = (0..50).map(|n| json!({"id":format!("note-{batch}-{n}"),"type":"note","value":{"words":"BULK"}})).collect();
                let (_, answered) = reply(&app, door_request(&token, &format!("bulk-{batch}"), write, json!({"records":records}))).await;
                assert_eq!(answered["result"]["isError"], false, "batch {batch}: {answered}");
            }
        })
    };
    let mut slowest = std::time::Duration::ZERO;
    let mut reads = 0;
    while !writing.is_finished() {
        let started = std::time::Instant::now();
        let (_, one) = reply(&app, door_request(&fixture.token, &format!("r-{reads}"), read, json!({"id":"note-0","type":"note"}))).await;
        assert_eq!(one["result"]["structuredContent"]["value"]["words"], "SEED", "read {reads}: {one}");
        let (_, page) = reply(&app, door_request(&fixture.token, &format!("l-{reads}"), list, json!({"type":"note","limit":5}))).await;
        assert_eq!(page["result"]["isError"], false, "list {reads}: {page}");
        let (_, result) = reply(&app, door_request(&fixture.token, &format!("x-{reads}"), "records:result",
            json!({"request_key":"seed","operation":write,"input":seed}))).await;
        assert_eq!(result["result"]["isError"], false, "result {reads}: {result}");
        slowest = slowest.max(started.elapsed());
        reads += 1;
        // The sign-in's own limit is 1200 calls in 60 s; a round is three calls.
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    writing.await.unwrap();
    assert!(reads > 5, "only {reads} read rounds ran beside the write");
    assert!(slowest < std::time::Duration::from_secs(5), "a read round took {slowest:?} beside a bulk write ({reads} rounds)");
    eprintln!("bulk write of 2000 records: {reads} read rounds beside it, slowest {slowest:?}");
}

/// A list or a read that names a `record:` kind answers over an AI's road. Every such call first reads that kind's
/// `home:` row (records-routes.json `_homes`); that read keeps its own answer custody, so the call's own custody is
/// registered once and its answer leaves (it was refused at answer time, body_custody_refused, 2026-11-14).
#[tokio::test]
async fn a_list_and_a_typed_read_of_a_record_kind_answer() {
    let (fixture, _owner, app) = beside_a_writer();
    let row = json!({"records":[{"id":"record:probe:one","type":"record:probe","value":{"words":"HOMED"},"expected":null}]});
    let (_, written) = reply(&app, door_request(&fixture.token, "kind-write", "records:write", row)).await;
    assert_eq!(written["result"]["isError"], false, "{written}");
    let (_, listed) = reply(&app, door_request(&fixture.token, "kind-list", "records:list", json!({"type":"record:probe"}))).await;
    assert_eq!(listed["result"]["isError"], false, "{listed}");
    assert_eq!(listed["result"]["structuredContent"]["records"][0]["id"], "record:probe:one", "{listed}");
    let (_, read) = reply(&app, door_request(&fixture.token, "kind-read", "records:read",
        json!({"id":"record:probe:one","type":"record:probe"}))).await;
    assert_eq!(read["result"]["isError"], false, "{read}");
    assert_eq!(read["result"]["structuredContent"]["value"]["words"], "HOMED", "{read}");
}
