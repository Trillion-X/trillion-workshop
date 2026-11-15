//! Controls for LocalAccount live heads through the real selected owner: the
//! told tail and the own-records record store scope stamp.
use super::*;
use http_body::Body as _;
use rusqlite::{Connection, params};
use std::{future::poll_fn, io::Write, pin::Pin};
use trillion_local::kept_runs::{KeptRuns, Settings as KeptSettings};
use trillion_local::workspace_heads;

const TOLD: &str = "told-the-person";


fn put_log_row(
    db: &Connection,
    table: &str,
    id: &str,
    tx: &str,
    part: i64,
    parts: i64,
    envelopes: &str,
) {
    db.execute(
        &format!("INSERT INTO {table}(id,transaction_id,actor_context,application_time,system_time,part,parts,envelopes) VALUES(?,?,'{{}}','valid','system',?,?,?)"),
        params![id, tx, part, parts, envelopes],
    )
    .unwrap();
}

fn install_record_owner(f: &Fixture, told: Value, log_id: &str) {
    let db = Connection::open(&f.records).unwrap();
    db.execute_batch(
        "CREATE TABLE record_log(id TEXT,transaction_id TEXT,actor_context TEXT,application_time TEXT,system_time TEXT,part INTEGER,parts INTEGER,envelopes TEXT,keys TEXT);
         CREATE TABLE record_erasable_keys(record_id TEXT PRIMARY KEY,key BLOB,erased_at TEXT,erased_fields TEXT);",
    )
    .unwrap();
    let tx = db.unchecked_transaction().unwrap();
    let mut runs = KeptRuns::create(&tx, "record_keys", KeptSettings::default()).unwrap();
    tx.execute(
        "INSERT INTO record_keys_meta(key,value) VALUES('engine','\"record-log\"')",
        [],
    )
    .unwrap();
    runs.put(
        &format!("i\0{TOLD}"),
        json!(["kept-list", "told-sequence", told]),
    )
    .unwrap();
    runs.flush(&tx, &json!(0)).unwrap();
    put_log_row(&tx, "record_log", log_id, "tx-open", 0, 1, "[]");
    tx.commit().unwrap();
}

async fn admitted(f: &Fixture) -> (axum::response::Response, DomainContext) {
    let response = f
        .app
        .clone()
        .oneshot(request("GET", "/work/api/records", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let context = f
        .adapter
        .head_context
        .lock()
        .unwrap()
        .take()
        .expect("real adapter authorization must retain the request context");
    (response, context)
}

fn heads(
    f: &Fixture,
    context: &DomainContext,
    output: &mut impl Write,
) -> Result<workspace_heads::Work, workspace_heads::Error> {
    f.owner
        .lock()
        .unwrap()
        .workspace_heads_to(&context.session, context.permit.clone(), output)
}

fn message(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap()
}

#[tokio::test]
async fn cold_and_repeated_heads_keep_ceiling_and_use_real_told_and_own_records_stamp() {
    for (told, log_id, expected_told) in [
        (
            json!({"items":[{"seq":3},{"seq":8}]}),
            "01234567-89ab-7cde-8f01-234567890abc",
            8,
        ),
        (
            json!({"seqs":[1,4,6]}),
            "01234567-89ab-7cde-8f01-234567890abc",
            6,
        ),
        (
            json!({"items":[{"seq":11}]}),
            "01234567-89ab-7cde-8f01-234567890abc",
            11,
        ),
    ] {
        let f = Fixture::new(&[("kept", "true")]);
        install_record_owner(&f, told, log_id);
        let (_response, context) = admitted(&f).await;
        let mut first = Vec::new();
        heads(&f, &context, &mut first).unwrap();
        let first = message(&first);
        assert_eq!(first["revision"], 1);
        assert_eq!(first["heads"]["told"], expected_told);
        assert_eq!(first["heads"]["records"], own_records_stamp(&f.records));
        let mut repeated = Vec::new();
        heads(&f, &context, &mut repeated).unwrap();
        assert_eq!(message(&repeated)["revision"], 1);
        let db = Connection::open(&f.records).unwrap();
        let store =
            trillion_local::workspace_store::lend_store(&db, trillion_local::storage::sqlite::Access::Read).unwrap();
        let (_, ceiling) = store.held_record_with_version(OWNER_ID, "screen-revision", "1").unwrap();
        assert_eq!(ceiling.unwrap().value["revision"], 1025);
    }
}

/// Another writer changes told-the-person in the account's own records (record store):
/// one compare-and-set write of its stored value, moving the scope stamp.
fn external_commit(f: &Fixture, new_told: Value) {
    let db = Connection::open(&f.records).unwrap();
    let mut store =
        trillion_local::workspace_store::lend_store(&db, trillion_local::storage::sqlite::Access::Write).unwrap();
    let (version, record) = store.held_record_with_version(OWNER_ID, "own-records", TOLD).unwrap();
    let mut body = record.expect("the first start filled told-the-person").value;
    body["stored"] = json!(new_told.to_string());
    store
        .mutate_local_with_check(
            OWNER_ID,
            "own-records",
            trillion_local::records::Mutation {
                id: TOLD.into(),
                expected_version: version,
                request_key: "external-told".into(),
                deleted: false,
                value: body,
            },
            || Ok(()),
        )
        .unwrap();
}

#[tokio::test]
async fn external_wal_commit_advances_next_revision_and_both_live_heads() {
    let f = Fixture::new(&[("kept", "true")]);
    install_record_owner(
        &f,
        json!({"items":[{"seq":4}]}),
        "01234567-89ab-7cde-8f01-234567890abc",
    );
    let (_response, context) = admitted(&f).await;
    let mut first = Vec::new();
    heads(&f, &context, &mut first).unwrap();
    assert_eq!(message(&first)["revision"], 1);

    let before = own_records_stamp(&f.records);
    external_commit(&f, json!({"items":[{"seq":9}]}));
    let mut next = Vec::new();
    heads(&f, &context, &mut next).unwrap();
    let next = message(&next);
    assert_eq!(next["revision"], 2);
    assert_eq!(next["heads"]["told"], 9);
    assert_ne!(next["heads"]["records"], before);
    assert_eq!(next["heads"]["records"], own_records_stamp(&f.records));
}

#[tokio::test]
async fn cancelled_permit_refuses_before_any_head_bytes() {
    let f = Fixture::new(&[("kept", "true")]);
    install_record_owner(
        &f,
        json!({"items":[{"seq":1}]}),
        "01234567-89ab-7cde-8f01-234567890abc",
    );
    let (_response, context) = admitted(&f).await;
    context.permit.cancel();
    let mut output = Vec::new();
    assert!(heads(&f, &context, &mut output).is_err());
    assert!(output.is_empty());
}

#[tokio::test]
async fn replacement_of_the_selected_record_file_refuses_the_retained_handle() {
    let f = Fixture::new(&[("kept", "true")]);
    install_record_owner(
        &f,
        json!({"items":[{"seq":1}]}),
        "01234567-89ab-7cde-8f01-234567890abc",
    );
    let (_response, context) = admitted(&f).await;
    let mut first = Vec::new();
    heads(&f, &context, &mut first).unwrap();
    let moved = f.records.with_extension("sqlite.saved");
    fs::rename(&f.records, &moved).unwrap();
    fs::copy(&moved, &f.records).unwrap();
    let mut output = Vec::new();
    assert!(heads(&f, &context, &mut output).is_err());
    assert!(output.is_empty());
}

/// Exercise the configured startup route through Axum's real request path and
/// leave the successful body pending so callers can change authority first.
async fn route_heads(f: &Fixture) -> (axum::response::Response, DomainContext) {
    let response = f
        .app
        .clone()
        .oneshot(request("GET", "/work/api/screen-revision", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let context = f
        .adapter
        .head_context
        .lock()
        .unwrap()
        .take()
        .expect("screen-revision route must authorize through the real adapter");
    (response, context)
}

async fn assert_no_head_data_message(response: axum::response::Response) {
    let mut body = response.into_body();
    let first = poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)).await;
    assert!(
        matches!(first, Some(Err(_))),
        "revoked pending response must refuse its FIRST message"
    );
    assert!(
        poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
            .await
            .is_none()
    );
}

#[tokio::test]
async fn screen_revision_route_delivers_real_told_and_own_records_stamp_heads() {
    let f = Fixture::new(&[("kept", "true")]);
    install_record_owner(
        &f,
        json!({"items":[{"seq":8}]}),
        "01234567-89ab-7cde-8f01-234567890abc",
    );
    let (response, _context) = route_heads(&f).await;
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "application/json; charset=utf-8"
    );
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let bytes = to_bytes(response.into_body(), 65_536).await.unwrap();
    let body = message(&bytes);
    assert_eq!(body["revision"], 1);
    assert_eq!(body["heads"]["told"], 8);
    assert_eq!(body["heads"]["records"], own_records_stamp(&f.records));
}

#[tokio::test]
async fn screen_revision_body_is_not_disclosed_after_permit_cancellation() {
    let f = Fixture::new(&[("kept", "true")]);
    install_record_owner(
        &f,
        json!({"items":[{"seq":8}]}),
        "01234567-89ab-7cde-8f01-234567890abc",
    );
    let (response, context) = route_heads(&f).await;
    context.permit.cancel();
    assert_no_head_data_message(response).await;
}

#[tokio::test]
async fn screen_revision_body_is_not_disclosed_after_selected_file_replacement() {
    let f = Fixture::new(&[("kept", "true")]);
    install_record_owner(
        &f,
        json!({"items":[{"seq":8}]}),
        "01234567-89ab-7cde-8f01-234567890abc",
    );
    let (response, _context) = route_heads(&f).await;
    let moved = f.records.with_extension("sqlite.saved");
    fs::rename(&f.records, &moved).unwrap();
    fs::copy(&moved, &f.records).unwrap();
    assert_no_head_data_message(response).await;
}


/// The live socket (/work/live) on the account's change notifier: it opens on the current revision and stream
/// position, and a durable write elsewhere reaches it as one message with the next revision and the written record's id,
/// never its value. The first message carries the hello. A `ping` is answered `pong`, and a numbered request is
/// answered by its number with the owner's epoch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_durable_write_reaches_an_open_live_socket_as_its_id_and_the_next_revision() {
    use tungstenite::{client::IntoClientRequest, Message};
    LIVE.with(|flag| flag.set(true));
    let f = Fixture::new(&[("kept", "true")]);
    install_record_owner(&f, json!({"items":[{"seq":3}]}), "01234567-89ab-7cde-8f01-234567890abc");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = f.app.clone();
    tokio::spawn(async move { axum::serve(listener, app).await });

    let connect = tokio::task::spawn_blocking(move || {
        let stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(std::time::Duration::from_secs(20))).unwrap();
        let mut request = format!("ws://{AUTHORITY}/work/live").into_client_request().unwrap();
        request.headers_mut().insert(header::COOKIE, format!("nm_session={TOKEN}").parse().unwrap());
        request.headers_mut().insert(header::ORIGIN, ORIGIN.parse().unwrap());
        let (mut socket, response) = tungstenite::client::client(request, stream).unwrap();
        assert_eq!(response.status(), 101);
        let first = socket.read().unwrap().into_text().unwrap().to_string();
        (socket, first)
    });
    let (mut socket, first) = connect.await.unwrap();
    let first: Value = serde_json::from_str(&first).unwrap();
    let revision = first["revision"].as_u64().expect("the open message carries the current revision");
    assert!(first["epoch"].as_str().is_some_and(|epoch| epoch.len() == 32), "{first}");
    assert!(first["seq"].is_u64(), "{first}");
    assert!(first.get("writes").is_none(), "nothing changed since the socket opened: {first}");
    // The first message carries the hello: the owner's epoch, and no instruction while every shipped boot row is off.
    assert_eq!(first["hello"], json!({"epoch": first["epoch"]}), "{first}");

    // A numbered request is answered on the same socket by its number, with the owner's epoch.
    let (mut socket, acked) = tokio::task::spawn_blocking(move || {
        socket.send(Message::text(r#"{"id":41,"type":"subscribe","ids":["a","b","a"]}"#)).unwrap();
        loop {
            let reply: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
            if reply.get("reply_to").is_some() {
                break (socket, reply);
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(acked["reply_to"], 41, "{acked}");
    assert_eq!(acked["epoch"], first["epoch"], "{acked}");
    assert_eq!(acked["acked"], json!(["a", "b"]), "{acked}");
    assert_eq!(acked["dropped"], 0, "{acked}");

    // Old src/live-protocol.mjs:150-160 and src/live-scopes.mjs: a catch-up of a kind answers the ids of that kind
    // changed after the number, and a window of it the newest ids, each read under the socket's own admission.
    let kind = {
        let db = Connection::open(&f.records).unwrap();
        let store = trillion_local::workspace_store::lend_store(&db, trillion_local::storage::sqlite::Access::Read).unwrap();
        let (_, record) = store.held_record_with_version(OWNER_ID, "own-records", TOLD).unwrap();
        record.unwrap().value["kind"].as_str().unwrap().to_owned()
    };
    let asks = [
        format!(r#"{{"id":42,"type":"catch_up","scope":"{kind}","after":0}}"#),
        format!(r#"{{"id":43,"type":"window","list":"{kind}","from":0,"to":10}}"#),
    ];
    let (mut socket, replies) = tokio::task::spawn_blocking(move || {
        let mut replies = Vec::new();
        for ask in asks {
            socket.send(Message::text(ask)).unwrap();
            loop {
                let reply: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
                if reply.get("reply_to").is_some() {
                    replies.push(reply);
                    break;
                }
            }
        }
        (socket, replies)
    })
    .await
    .unwrap();
    assert_eq!(replies[0]["scope"], kind.as_str(), "{}", replies[0]);
    assert!(replies[0]["items"].as_array().unwrap().contains(&json!(TOLD)), "{}", replies[0]);
    assert!(replies[0]["through"].as_i64().unwrap() > 0, "{}", replies[0]);
    assert!(replies[1]["rows"].as_array().unwrap().contains(&json!({"id": TOLD})), "{}", replies[1]);
    assert!(!replies.iter().any(|reply| reply.to_string().contains("\"items\":[{")), "ids only, never a value");

    external_commit(&f, json!({"items":[{"seq":3},{"seq":9}]}));

    let (mut socket, second) = tokio::task::spawn_blocking(move || {
        let second = socket.read().unwrap().into_text().unwrap().to_string();
        (socket, second)
    })
    .await
    .unwrap();
    let message: Value = serde_json::from_str(&second).unwrap();
    assert_eq!(message["revision"], revision + 1, "{message}");
    assert_eq!(message["epoch"], first["epoch"]);
    assert!(message.get("hello").is_none(), "only the first message carries the hello: {message}");
    // A scope the socket caught up on rides in each later message as its newest number, past the one it caught up to.
    assert!(message["counters"][kind.as_str()].as_i64().unwrap() > replies[0]["through"].as_i64().unwrap(), "{message}");
    // The notifier is the account's, and every fixture in this process is the same account, so other tests' writes
    // may add steps and ids: the position moves on and this write's id is among the ones named.
    assert!(message["seq"].as_u64().unwrap() > first["seq"].as_u64().unwrap(), "{message}");
    let named = message["writes"]["records"].as_array().expect("the message names what changed");
    assert!(named.contains(&json!({"id": TOLD, "fields": null})), "{message}");
    assert!(named.iter().all(|record| record.as_object().is_some_and(|record| record.len() == 2)), "{message}");
    assert!(!second.contains("external-told"), "a message carries no write's request key or value: {second}");

    // A write in a resource no browser session reads (the account's command records) is never named, not even by id:
    // the next message names only the readable record written after it.
    let db = Connection::open(&f.records).unwrap();
    let mut store =
        trillion_local::workspace_store::lend_store(&db, trillion_local::storage::sqlite::Access::Write).unwrap();
    let (version, _) = store.held_record_with_version(OWNER_ID, "own-commands", "execution:outside-the-session").unwrap();
    store
        .mutate_local_with_check(
            OWNER_ID,
            "own-commands",
            trillion_local::records::Mutation {
                id: "execution:outside-the-session".into(),
                expected_version: version,
                request_key: "outside-the-session".into(),
                deleted: false,
                value: json!({"stored": "OUTSIDE_THE_SESSION"}),
            },
            || Ok(()),
        )
        .unwrap();
    // The readable write after it, under its own request key.
    let (version, record) = store.held_record_with_version(OWNER_ID, "own-records", TOLD).unwrap();
    let mut body = record.unwrap().value;
    body["stored"] = json!(json!({"items":[{"seq":3},{"seq":9},{"seq":12}]}).to_string());
    store
        .mutate_local_with_check(
            OWNER_ID,
            "own-records",
            trillion_local::records::Mutation {
                id: TOLD.into(),
                expected_version: version,
                request_key: "live-told-again".into(),
                deleted: false,
                value: body,
            },
            || Ok(()),
        )
        .unwrap();
    drop(store);
    drop(db);
    let (mut socket, third) = tokio::task::spawn_blocking(move || {
        let mut messages = Vec::new();
        // The command write may make a message of its own (the revision moved) before the readable one arrives.
        while !messages.iter().any(|message: &String| message.contains(TOLD)) {
            messages.push(socket.read().unwrap().into_text().unwrap().to_string());
        }
        (socket, messages.join("\n"))
    })
    .await
    .unwrap();
    assert!(!third.contains("outside-the-session") && !third.contains("OUTSIDE_THE_SESSION"), "{third}");

    let pong = tokio::task::spawn_blocking(move || {
        socket.send(Message::text("ping")).unwrap();
        // Messages other tests' writes cause on the shared account may come first; the answer to the ping follows.
        loop {
            let text = socket.read().unwrap().into_text().unwrap().to_string();
            if !text.starts_with('{') {
                break text;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(pong, "pong");
}

// ---- Ported from old trillion tests deleted by Trillion-X/trillion #243 (tag old-trillion-before-worker-retire,
// b6ae0ebf81): test/screen-revision-worker-route.test.mjs, test/screen-revision-worker-negative.test.mjs and
// test/screen-revision-worker-issued-viewer-negative.test.mjs. The old bundled Worker's /work/api/screen-revision (the
// KV browser session, AccountControl admission, RecordBook readNativeWorkLiveHeads) is this native host's route over
// the account's own sign-in and live heads: the fixture's browser session, the real adapter's `authorize` (the old
// admission of `presentation:read` on `@own-records`), and the heads read. The old former-owner stand-in (a Proxy
// that threw) has no counterpart: no former owner exists to be reached.

/// The screen-revision GET with this fixture's session, with or without its same Origin.
fn screen_revision_request(origin: bool) -> Request<Body> {
    let mut request = request("GET", "/work/api/screen-revision", None);
    if origin {
        request.headers_mut().insert(header::ORIGIN, ORIGIN.parse().unwrap());
    }
    request.headers_mut().insert(header::ACCEPT, "application/json".parse().unwrap());
    request
}

/// Ported from old test/screen-revision-worker-route.test.mjs, "actual Worker screen revision GET without Origin /
/// with same Origin reaches existing native heads": both answer 200 with the heads read, admitted once through the
/// real adapter for the browser's own session (`session:<blake3 of the cookie>`).
#[tokio::test]
async fn old_screen_revision_worker_route_a_get_with_or_without_its_origin_reaches_the_heads() {
    for origin in [false, true] {
        let f = Fixture::new(&[("kept", "true")]);
        install_record_owner(&f, json!({"items":[{"seq":8}]}), "01234567-89ab-7cde-8f01-234567890abc");
        let response = f.app.clone().oneshot(screen_revision_request(origin)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "with origin {origin}: the browser GET reaches the heads");
        let context = f.adapter.head_context.lock().unwrap().take().expect("admitted once through the real adapter");
        assert_eq!(context.session.session_id, f.session_id, "admitted for the browser's own session");
        assert_eq!(context.head.uri.path(), "/work/api/screen-revision");
        let bytes = to_bytes(response.into_body(), 65_536).await.unwrap();
        let body = message(&bytes);
        assert_eq!(body["revision"], 1, "with origin {origin}: {body}");
        assert_eq!(body["heads"]["told"], 8, "with origin {origin}: {body}");
    }
}

/// Ported from old test/screen-revision-worker-issued-viewer-negative.test.mjs, "actual Worker refuses an
/// actual-issuer expired view-as session before current grant and head dispatch", in what has an owner here: a
/// session cookie no live session row backs (an expired one is never answered: sessions.rs `current`) is refused 401
/// before any admission or heads read. (The old body `error: "Sign in again."` is not this route's body, `{"error":
/// "current sign-in required"}`; it is named in the port report.) The view-as issuer itself (old src/view-as.mjs startLook, its grant setup read)
/// is parked, not running (trillion-workshop tools/let-someone-look-at-my-trillion-read/from-old-trillion).
#[tokio::test]
async fn old_screen_revision_worker_issued_viewer_negative_a_session_no_live_row_backs_is_refused_before_heads() {
    let f = Fixture::new(&[("kept", "true")]);
    install_record_owner(&f, json!({"items":[{"seq":8}]}), "01234567-89ab-7cde-8f01-234567890abc");
    let mut request = screen_revision_request(true);
    request.headers_mut().insert(header::COOKIE, "nm_session=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".parse().unwrap());
    let response = f.app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(f.adapter.head_context.lock().unwrap().take().is_none(), "no admission and no heads read");
}

/// Real browser socket, addressed writes and native read adapter: equal local
/// IDs in independent histories stay separate in catch-up, windows and notices.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_live_socket_keeps_its_complete_history_through_reads_notices_and_reconnect() {
    use tungstenite::{client::IntoClientRequest, Message};
    LIVE.with(|flag|flag.set(true));
    let f=records_write_controls::canonical_started_fixture();
    let history=|id|json!({"id":id,"incarnation":"first","generation":1});
    async fn write_history(f:&Fixture,key:&str,mut scope:Value,create:bool,id:&str) {
        if create { scope["create"]=json!(true); }
        let input=json!({"scope":scope,"records":[{"id":id,"type":"note","value":{"text":"synthetic socket row"}}]});
        let mut post=request("POST","/work/api/records",Some(&input.to_string()));
        post.headers_mut().insert(header::ORIGIN,ORIGIN.parse().unwrap());
        post.headers_mut().insert(header::CONTENT_TYPE,"application/json".parse().unwrap());
        post.headers_mut().insert("x-trillion-request-key",key.parse().unwrap());
        let response=f.app.clone().oneshot(post).await.unwrap();
        let status=response.status();
        let bytes=to_bytes(response.into_body(),1<<20).await.unwrap();
        assert_eq!(status,StatusCode::OK,"{}",String::from_utf8_lossy(&bytes));
    }
    write_history(&f,"socket-a-create",history("socket-a"),true,"same-id").await;
    write_history(&f,"socket-b-create",history("socket-b"),true,"same-id").await;
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port=listener.local_addr().unwrap().port();
    let app=f.app.clone();
    let server=tokio::spawn(async move { axum::serve(listener,app).await });
    let open=move |scope:Value,resume:Option<(String,u64)>| {
        let stream=std::net::TcpStream::connect(("127.0.0.1",port)).unwrap();
        stream.set_read_timeout(Some(std::time::Duration::from_secs(20))).unwrap();
        let mut query=url::form_urlencoded::Serializer::new(String::new());
        query.append_pair("history",&scope.to_string());
        if let Some((epoch,after))=resume { query.append_pair("epoch",&epoch).append_pair("after",&after.to_string()); }
        let mut request=format!("ws://{AUTHORITY}/work/live?{}",query.finish()).into_client_request().unwrap();
        request.headers_mut().insert(header::COOKIE,format!("nm_session={TOKEN}").parse().unwrap());
        request.headers_mut().insert(header::ORIGIN,ORIGIN.parse().unwrap());
        let (mut socket,response)=tungstenite::client::client(request,stream).unwrap();
        assert_eq!(response.status(),101);
        let first:Value=serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
        (socket,first)
    };
    let (mut socket,first)=tokio::task::spawn_blocking(move ||open(json!({"id":"socket-a","incarnation":"first","generation":1}),None)).await.unwrap();
    assert_eq!(first["history"],history("socket-a"));
    let original_epoch=first["epoch"].as_str().unwrap().to_owned();
    let original_seq=first["seq"].as_u64().unwrap();
    let (returned,replies)=tokio::task::spawn_blocking(move || {
        let mut replies=Vec::new();
        for (id,kind) in [(71,"catch_up"),(72,"window")] {
            socket.send(Message::text(json!({"id":id,"type":kind,"scope":"note","list":"note","after":0,"from":0,"to":20}).to_string())).unwrap();
            loop { let reply:Value=serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap(); if reply["reply_to"]==id { replies.push(reply); break; } }
        }
        (socket,replies)
    }).await.unwrap();
    socket=returned;
    assert_eq!(replies[0]["history"],history("socket-a"));
    assert_eq!(replies[0]["items"],json!(["same-id"]));
    assert_eq!(replies[1]["history"],history("socket-a"));
    assert_eq!(replies[1]["rows"],json!([{"id":"same-id"}]));
    write_history(&f,"socket-b-next",history("socket-b"),false,"b-only").await;
    write_history(&f,"socket-a-next",history("socket-a"),false,"a-only").await;
    let (socket,seen)=tokio::task::spawn_blocking(move || {
        let mut seen=Vec::new();
        loop {
            let message:Value=serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
            assert!(!message.to_string().contains("b-only"),"{message}");
            let reached=message["writes"]["records"].as_array().is_some_and(|rows|rows.iter().any(|row|row["id"]=="a-only"));
            seen.push(message); if reached { break; }
        }
        (socket,seen)
    }).await.unwrap();
    assert!(seen.iter().all(|message|message["history"]==history("socket-a")));
    drop(socket);
    // A numeric cursor from A is not a resume cursor in B, even when the
    // supplies produced the same local numbers and IDs.
    let (mut other,reconnected)=tokio::task::spawn_blocking(move ||open(json!({"id":"socket-b","incarnation":"first","generation":1}),Some((original_epoch,original_seq)))).await.unwrap();
    assert_eq!(reconnected["history"],history("socket-b"));
    assert_ne!(reconnected["epoch"],first["epoch"]);
    assert!(reconnected.get("writes").is_none(),"another history cannot replay A's cursor: {reconnected}");
    let b_window=tokio::task::spawn_blocking(move || {
        other.send(Message::text(json!({"id":73,"type":"window","list":"note","from":0,"to":20}).to_string())).unwrap();
        let reply=loop { let reply:Value=serde_json::from_str(other.read().unwrap().to_text().unwrap()).unwrap(); if reply["reply_to"]==73 { break reply; } };
        let _=other.close(None); reply
    }).await.unwrap();
    assert_eq!(b_window["history"],history("socket-b"));
    let rows=b_window["rows"].as_array().unwrap();
    assert_eq!(rows.len(),2);
    assert!(rows.contains(&json!({"id":"same-id"})) && rows.contains(&json!({"id":"b-only"})),"{b_window}");
    assert!(!rows.contains(&json!({"id":"a-only"})),"{b_window}");
    server.abort();
}

/// Old trillion src/placed-lists.mjs:10-41 selects the addressed list before
/// its live read. Exercise that consumer with a real current-writer exchange,
/// then keep its old plaintext header while its replica becomes copy-only.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_live_history_reads_a_current_replica_but_never_its_unmaterialized_plaintext() {
    use std::{collections::HashMap, sync::atomic::{AtomicBool, AtomicUsize, Ordering}, time::{Duration, Instant}};
    use trillion_local::{account::computers::{AccountKey, ComputersRow, ComputerSigner,
        copies::{self, Copies, CopiesConfig, Link}, messages::{Answer, Message as CopyMessage}},
        secrets::secrets_key::{self, ComputerKey}, storage::{memory::Memory, sqlite,
        record_store::settings::Limits as RecordLimits,
        record_store_resources::{StateResources, domains, carry::{live_adopt, commit_log::{self, opaque_map}}}}};
    use tungstenite::{client::IntoClientRequest, Message};
    #[derive(Default)]
    struct Network { peers: Mutex<HashMap<String, Arc<Copies>>>, current: AtomicUsize }
    struct Wire { me: String, network: Arc<Network> }
    impl Link for Wire {
        fn send(&self, to: &str, message: &CopyMessage) -> Option<Answer> {
            if matches!(message, CopyMessage::Group {request: trillion_local::account::computers::messages::GroupRequest::Current {..}}) {
                self.network.current.fetch_add(1, Ordering::AcqRel);
            }
            let peer = self.network.peers.lock().unwrap().get(to).cloned()?;
            Some(peer.answer(&self.me, message.clone()))
        }
    }
    let owner = content_crypto::advanced::blake3::hash(b"synthetic-live-replica-freshness-control").to_hex().to_string();
    LIVE.with(|flag| flag.set(true));
    let f = records_write_controls::canonical_started_fixture_for_owner(&owner);
    let input = json!({"scope":{"id":"live-replica-control","incarnation":"first","generation":1,"create":true},
        "records":[{"id":"never-disclose-stale","type":"note","value":{"text":"synthetic private live row"}}]});
    let mut post = request("POST", "/work/api/records", Some(&input.to_string()));
    post.headers_mut().insert(header::ORIGIN, ORIGIN.parse().unwrap());
    post.headers_mut().insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    post.headers_mut().insert("x-trillion-request-key", "live-replica-create".parse().unwrap());
    let response = f.app.clone().oneshot(post).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));

    let account = AccountKey::generate().unwrap();
    let keys: Vec<_> = (0..2).map(|at| Arc::new(ComputerKey::from_bytes(vec![71 + at; 32]).unwrap())).collect();
    let ids: Vec<_> = keys.iter().map(|key| ComputerSigner::of(key).unwrap().computer_id()).collect();
    let row = ComputersRow::sign_with_voters(&account.address(), 1, &ids, &ids, &ids[..1], &account).unwrap();
    let network = Arc::new(Network::default());
    let root = secrets_key::generate().unwrap();
    let source = f._temp.path().join("source-computer");
    fs::create_dir_all(&source).unwrap();
    let mut peers = Vec::new();
    for at in 0..2 {
        let state = if at == 0 { source.clone() } else { f.records.parent().unwrap().to_path_buf() };
        let sign_in = f._temp.path().join(format!("copy-sign-in-{at}"));
        fs::create_dir_all(&sign_in).unwrap();
        let held = secrets_key::open(&secrets_key::seal(&root, &keys[at]).unwrap(), &keys[at]).unwrap();
        let peer = Arc::new(Copies::new(CopiesConfig { address: account.address(), owner: owner.clone(), user: f.user.clone(),
            computer: ids[at].clone(), row: row.clone(), records: state.join("records.sqlite"),
            limits: Some(RecordLimits::fixed(1 << 20, 1 << 30)),
            sign_in: copies::sign_in_rows(&sign_in).unwrap(), stores: None },
            Arc::new(Wire {me: ids[at].clone(), network: network.clone()}), Arc::new(||1_000_000)).unwrap()
            .with_state(state.clone()).with_secrets_key(keys[at].clone(), state, Some(held)).with_account_key(account.public_hex()));
        network.peers.lock().unwrap().insert(ids[at].clone(), peer.clone());
        peers.push(peer);
    }
    peers[0].tick();
    assert!(peers[0].holding().is_some(), "the real source must hold the writer turn");
    peers[1].tick();
    assert!(peers[1].holding().is_none(), "the browser reads at the replica");
    copies::register(&peers[1]);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = f.app.clone();
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let open = move || {
        let stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        let query = url::form_urlencoded::Serializer::new(String::new()).append_pair("history", &json!({"id":"live-replica-control","incarnation":"first","generation":1}).to_string()).finish();
        let mut request = format!("ws://{AUTHORITY}/work/live?{query}").into_client_request().unwrap();
        request.headers_mut().insert(header::COOKIE, format!("nm_session={TOKEN}").parse().unwrap());
        request.headers_mut().insert(header::ORIGIN, ORIGIN.parse().unwrap());
        let (socket, response) = tungstenite::client::client(request, stream).unwrap();
        assert_eq!(response.status(), 101);
        socket
    };
    let (socket, reply) = tokio::task::spawn_blocking(move || {
        let mut socket = open();
        let first: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(first["history"]["id"], "live-replica-control", "{first}");
        socket.send(Message::text(r#"{"id":81,"type":"window","list":"note","from":0,"to":20}"#)).unwrap();
        let reply = loop { let reply: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap(); if reply["reply_to"] == 81 {break reply;} };
        (socket, reply)
    }).await.unwrap();
    assert_eq!(reply["rows"], json!([{"id":"never-disclose-stale"}]));
    assert!(network.current.load(Ordering::Acquire) >= 2, "hello and window must ask the actual writer");

    let resources = Arc::new(StateResources::new(f.records.parent().unwrap(), trillion_local::sqlite_work::WorkMeter::new()).unwrap());
    let selected: domains::Selection = serde_json::from_value(json!({"id":"live-replica-control","incarnation":"first","generation":1})).unwrap();
    let domain = domains::Bound::new(resources, &owner, selected.clone(), 1).unwrap();
    let stream = live_adopt::command_slot(&owner, &json!(selected.identity())).unwrap();
    let limits = live_adopt::Limits {page_rows:2,page_bytes:2048,commit_bytes:8192,capture_bytes:1<<20};
    // Advance only the actual writer's physical stream. Its frame records
    // real postimages through the same recorder and commit-log owner used by
    // a native command; the replica retains its complete, readable cut zero.
    let source_resources = Arc::new(StateResources::new(&source, trillion_local::sqlite_work::WorkMeter::new()).unwrap());
    let mut source_selection = selected.clone();
    source_selection.create = true;
    let source_domain = domains::Bound::new(source_resources, &owner, source_selection, 1).unwrap();
    {
        let writer = source_domain.writer().unwrap();
        let held = writer.lend(Arc::new(AtomicBool::new(false)), Instant::now()+Duration::from_secs(20)).unwrap();
        let transaction = held.begin(sqlite::TransactionBehavior::Immediate).unwrap();
        let raw = sqlite::lend(&transaction, "record_store", sqlite::Access::Write).unwrap();
        let capture = live_adopt::CommandCapture::unbound(&raw, limits);
        let recording = live_adopt::Recording::new(raw);
        recording.bind(Some(capture.clone()));
        let mut store = trillion_local::storage::record_store::RecordStore::new(recording,
            Box::new(trillion_local::storage::record_store::RealClock), RecordLimits::fixed(1 << 20, 1 << 30)).unwrap();
        store.mutate_local_with_check(&owner, "own-resource-identity", trillion_local::records::Mutation {
            id:"command-domain".into(), expected_version:0, request_key:"synthetic-source-history".into(),
            deleted:false, value:json!(selected.identity()),
        }, ||Ok(())).unwrap();
        let effects = capture.final_effects(store.storage()).unwrap();
        assert!(!effects.is_empty(), "the actual source frame must have real physical postimages");
        commit_log::bind_stream(store.storage(), &stream, &serde_json::to_vec(&(&owner, selected.identity())).unwrap(), limits).unwrap();
        let frame = commit_log::append_commit(store.storage(), &stream, "synthetic-source-command", &effects, limits).unwrap();
        assert_eq!(frame.sequence, 1);
        let front = commit_log::frontiers(store.storage(), &stream, limits).unwrap();
        assert_eq!((front.stored, front.materialized), (1, 1));
        drop(store); transaction.commit().unwrap();
    }
    let (socket, stale) = tokio::task::spawn_blocking(move || {
        let mut socket = socket;
        socket.send(Message::text(r#"{"id":83,"type":"window","list":"note","from":0,"to":20}"#)).unwrap();
        let reply = loop { let reply: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap(); if reply["reply_to"] == 83 {break reply;} };
        (socket, reply)
    }).await.unwrap();
    assert!(stale.get("error").is_some() && stale.get("rows").is_none(), "source cut one cannot disclose the old complete replica cut zero: {stale}");
    assert!(!stale.to_string().contains("never-disclose-stale"), "{stale}");
    // The refusal is one text frame naming its code and cause, then the numeric Close the code always had.
    let (stale_refusal, stale_open) = tokio::task::spawn_blocking(move || {let mut socket = open(); (socket.read().unwrap(), socket.read().unwrap())}).await.unwrap();
    let refusal: Value = serde_json::from_str(stale_refusal.to_text().unwrap()).unwrap();
    assert_eq!(refusal["code"], 1011, "{refusal}");
    assert!(refusal["cause"].as_str().unwrap().starts_with("trillion_local::local_account::own_records@"), "{refusal}");
    assert!(matches!(stale_open, Message::Close(_)), "a stale complete replica must refuse before its hello: {stale_open:?}");

    let empty = Memory::open("record_store").unwrap();
    let mut snapshot = opaque_map::PhysicalSnapshot::begin(&empty, &stream, "synthetic-key", "zero-cut", limits).unwrap();
    let page = snapshot.page(&mut |_,_|panic!("no source rows at the zero cut")).unwrap();
    let seal = snapshot.seal().unwrap();
    {
        let writer = domain.writer().unwrap();
        let held = writer.lend(Arc::new(AtomicBool::new(false)), Instant::now()+Duration::from_secs(20)).unwrap();
        let transaction = held.begin(sqlite::TransactionBehavior::Immediate).unwrap();
        let storage = sqlite::lend(&transaction, "record_store", sqlite::Access::Write).unwrap();
        opaque_map::begin_map_bootstrap(&storage, &stream, &seal.head, limits).unwrap();
        opaque_map::append_map_page(&storage, &stream, &page, limits).unwrap();
        opaque_map::finish_map_bootstrap(&storage, &stream, &seal, limits).unwrap();
        drop(storage); transaction.commit().unwrap();
    }
    let refused = tokio::task::spawn_blocking(move || {
        let mut socket = socket;
        socket.send(Message::text(r#"{"id":82,"type":"window","list":"note","from":0,"to":20}"#)).unwrap();
        let reply = loop { let reply: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap(); if reply["reply_to"] == 82 {break reply;} };
        let _ = socket.close(None); reply
    }).await.unwrap();
    assert!(refused.get("rows").is_none() && refused.get("items").is_none(), "{refused}");
    assert!(!refused.to_string().contains("never-disclose-stale"), "{refused}");
    // The refusal is one text frame naming its code and cause, then the numeric Close the code always had.
    let (first_refusal, first_after) = tokio::task::spawn_blocking(move || {let mut socket = open(); (socket.read().unwrap(), socket.read().unwrap())}).await.unwrap();
    let refusal: Value = serde_json::from_str(first_refusal.to_text().unwrap()).unwrap();
    assert_eq!(refusal["code"], 1011, "{refusal}");
    assert!(refusal["cause"].as_str().unwrap().starts_with("trillion_local::local_account::own_records@"), "{refusal}");
    assert!(matches!(first_after, Message::Close(_)), "a reconnect must refuse before its hello: {first_after:?}");
    server.abort();
}

/// After boot, the folder holding the account's records is swapped for a link to another folder holding a copy of the same
/// file. The held heads must refuse: the record book is held by its own file identity, and the name now reaches another one.
#[tokio::test]
async fn a_folder_swapped_for_a_link_after_boot_refuses_the_held_heads() {
    let f = Fixture::new(&[("kept", "true")]);
    install_record_owner(&f, json!({"items":[{"seq":3}]}), "01234567-89ab-7cde-8f01-234567890abc");
    let (_response, context) = admitted(&f).await;
    let mut first = Vec::new();
    heads(&f, &context, &mut first).unwrap();
    assert_eq!(message(&first)["revision"], 1);

    let state = f.records.parent().unwrap().to_path_buf();
    let aside = state.with_file_name("state-aside");
    let copy_folder = state.with_file_name("state-copy");
    // Every file of the account is copied, so only the identity of the records file can differ.
    assert!(std::process::Command::new("cp").arg("-R").arg(&state).arg(&copy_folder).status().unwrap().success());
    fs::rename(&state, &aside).unwrap();
    std::os::unix::fs::symlink(&copy_folder, &state).unwrap();

    let mut swapped = Vec::new();
    let outcome = heads(&f, &context, &mut swapped);
    assert!(matches!(outcome, Err(workspace_heads::Error::SourceChanged(_))), "the identity check refuses the swapped records file: {outcome:?}");
    assert!(swapped.is_empty(), "no head bytes leave before the refusal");
}
