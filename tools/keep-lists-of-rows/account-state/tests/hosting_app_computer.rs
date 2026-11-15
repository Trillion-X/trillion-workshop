//! The Mac app's engine as a computer of its own account, beside a server (the person, Nov 5 7:25 AM PST: "we still coupled
//! to mac app").
//!
//! The Mac app's engine (`trillion-local native-serve`) runs here in this process, composed the way its start composes
//! it after the app's launch message (`Computer::hosting_at`: the vault root the app keeps given once, the computer key
//! the app keeps, the account's sign-in rows behind the copies' view, its own local routes, and its computer). The server
//! and a third computer that only keeps a copy and votes are `trillion-local serve` processes. All three reach one
//! forwarder over verified TLS, and the forwarder stores nothing.
//!
//! Why a third voter: a write commits only once more than half of the voters hold it, and after a writer is gone a
//! computer admits from its copy only while more than half of the voters vouch for it (src/account/computers/copies.rs).
//! With two voters, one off leaves one of two, never more than half: writes pause, and the one left stops admitting
//! (docs/placement-decision/stage-2-status.md, "Still open", the decided design for two voters). The third computer
//! keeps a sealed copy only: it never answers and never holds a sign-in row or the root.

#[path = "support/installed_tools.rs"]
mod installed_tools;
#[path = "support/signer.rs"]
mod signer;
#[path = "support/front_door.rs"]
mod front_door;
use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use serde_json::{json, Value};
use std::{
    fs,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc},
    time::{Duration, Instant},
};
use tower::ServiceExt as _;
use trillion_local::{
    account::computers::ComputerSigner,
    forwarder::gateway::Gateway,
    native_entry::computer::Computer,
    secrets::secrets_key::{self, ComputerKey},
};

const ORIGIN: &str = "https://computer.test";
/// The host the Mac app's own routes are reached at (its loopback listener's address, at the app).
const MAC_HOST: &str = "127.0.0.1:7199";

fn starting(row: &str) -> Value {
    let product: Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/account/rows/new-accounts.json"))).unwrap();
    product[row].clone()
}

/// The test's TLS root and the forwarder's certificate for `localhost` (as tests/computer_forwarder.rs makes them).
fn localhost_tls(folder: &Path) -> native_tls::Identity {
    let openssl = |args: &[&str]| {
        let done = std::process::Command::new("openssl").env("OPENSSL_CONF", folder.join("openssl.cnf")).args(args)
            .current_dir(folder).output().expect("the openssl command line makes the test's TLS root");
        assert!(done.status.success(), "{}", String::from_utf8_lossy(&done.stderr));
    };
    fs::write(folder.join("openssl.cnf"), "[req]\ndistinguished_name=dn\n[dn]\n").unwrap();
    openssl(&["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-sha256", "-keyout", "ca.key", "-out", "ca.pem",
        "-subj", "/CN=Hosting App Test Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
    openssl(&["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=localhost"]);
    fs::write(folder.join("leaf.ext"), "subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n").unwrap();
    openssl(&["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem",
        "-days", "1", "-sha256", "-extfile", "leaf.ext"]);
    openssl(&["pkcs8", "-topk8", "-nocrypt", "-in", "leaf.key", "-out", "leaf-pkcs8.key"]);
    let mut chain = fs::read(folder.join("leaf.pem")).unwrap();
    chain.extend_from_slice(&fs::read(folder.join("ca.pem")).unwrap());
    native_tls::Identity::from_pkcs8(&chain, &fs::read(folder.join("leaf-pkcs8.key")).unwrap()).unwrap()
}

/// A computer folder: its key (`byte`), its accounts folder and its config, reaching the forwarder at `forwarder`.
struct Peer {
    dir: PathBuf,
    key: PathBuf,
    config: PathBuf,
    id: String,
    port: u16,
    process: Option<std::process::Child>,
}

impl Peer {
    fn new(root: &Path, name: &str, byte: u8, forwarder: &str) -> Self {
        let dir = root.join(name);
        let accounts = dir.join("accounts");
        fs::create_dir_all(&accounts).unwrap();
        let key = dir.join("computer.key");
        fs::write(&key, base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [byte; 32])).unwrap();
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let config = dir.join("computer.json");
        fs::write(&config, json!({
            "listen": format!("127.0.0.1:{port}"),
            "accounts": accounts,
            "place_key_file": key,
            "public_origin": ORIGIN,
            "report": {"storage": {"keep_free_bytes": 0}, "reach": ORIGIN, "cost_per_month_cents": 0,
                "contained_tools": false, "takes_new_accounts": false},
            "router": forwarder,
            "sign_in": {"relying_party_drop_labels": 1, "max_body_bytes": 16384, "expired_rows_per_write": 100},
            // The account moves one computer at a time, so its copy rule asks one of each until the last edit.
            "new_accounts": {"copies": {"least_copy_keepers": 1, "least_voters": 1, "least_may_answer": 1, "least_always_on": 0},
                "copies_rules": starting("copies_rules")},
            "tools_at_start": false,
        }).to_string()).unwrap();
        let id = ComputerSigner::of(&ComputerKey::read(&key).unwrap()).unwrap().computer_id();
        Self { dir, key, config, id, port, process: None }
    }

    fn start(&mut self, trust: &Path) {
        let log = fs::File::create(self.dir.join("computer.log")).unwrap();
        let child = std::process::Command::new(env!("CARGO_BIN_EXE_trillion-local"))
            .arg("serve").arg(&self.config)
            .env("SSL_CERT_FILE", trust)
            .stdout(log.try_clone().unwrap()).stderr(log)
            .spawn().unwrap();
        self.process = Some(child);
        assert!(wait_listening(Duration::from_secs(60), self.port, || {}),
            "computer {} did not listen: {}", self.id, self.log());
    }

    fn stop(&mut self) {
        if let Some(mut child) = self.process.take() {
            unsafe { libc::kill(child.id() as i32, libc::SIGKILL) };
            let _ = child.wait();
        }
    }

    fn log(&self) -> String {
        fs::read_to_string(self.dir.join("computer.log")).unwrap_or_default()
    }

    fn account(&self, owner: &str) -> PathBuf {
        self.dir.join("accounts").join(owner)
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Run `trillion-local` with `args` as its own process and answer what it printed.
fn command(args: &[&str]) -> String {
    let done = std::process::Command::new(env!("CARGO_BIN_EXE_trillion-local")).args(args).output().unwrap();
    assert!(done.status.success(), "{args:?}: {}", String::from_utf8_lossy(&done.stderr));
    String::from_utf8(done.stdout).unwrap()
}

fn tool(id: u64, resource: &str, operation: &str, request_key: &str, input: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {"name": "run_resource_operation",
        "arguments": {"resource": resource, "operation": operation, "request_key": request_key, "input": input}}})
}

fn tool_ok(status: StatusCode, answer: &Value) -> bool {
    status == StatusCode::OK && answer["result"]["isError"] != json!(true) && answer["result"]["structuredContent"].is_object()
}

/// One MCP call on `routes` at `host` with `bearer`: its status, the computer that answered (`trillion-computer`, set by
/// the forwarder and by a computer's own listener) and its body.
fn mcp(rt: &tokio::runtime::Runtime, routes: &axum::Router, host: &str, path: &str, bearer: &str, body: &Value) -> (StatusCode, String, Value) {
    let request = Request::builder().method("POST").uri(path)
        .header(header::HOST, host)
        .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json, text/event-stream")
        .body(Body::from(body.to_string())).unwrap();
    rt.block_on(async {
        let response = routes.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let by = response.headers().get("trillion-computer").and_then(|value| value.to_str().ok()).unwrap_or("").to_owned();
        let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap_or_default();
        (status, by, serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into())))
    })
}

/// Read the ordinary MCP byte pages and verify the complete logical JSON answer.
/// Each page keeps its total, digest, responder and exact contiguous byte offset.
fn paged_mcp_read(
    call: &mut dyn FnMut(&Value) -> (StatusCode, String, Value), request: &Value,
) -> (StatusCode, String, Value, usize) {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use content_crypto::advanced::blake3;
    let mut request = request.clone();
    let mut bytes = Vec::new();
    let mut witness = None::<(u64, String, String)>;
    let mut pages = 0;
    loop {
        let (status, by, mut answer) = call(&request);
        if !tool_ok(status, &answer) {
            return (status, by, answer, pages);
        }
        let Some(page) = answer["result"]["structuredContent"].get("byte_page") else {
            assert_eq!(pages, 0, "a byte-paged answer cannot turn into an unpaged answer halfway through");
            return (status, by, answer, 1);
        };
        pages += 1;
        let total = page["total"].as_u64().unwrap();
        assert!(total <= 1 << 20, "the synthetic record stays within its one-record bound");
        let identity = (total, page["blake3"].as_str().unwrap().to_owned(), by.clone());
        if let Some(first) = &witness {
            assert_eq!(&identity, first, "every byte page is from the same complete answer and computer");
        } else {
            witness = Some(identity.clone());
        }
        assert_eq!(page["offset"].as_u64().unwrap() as usize, bytes.len());
        let part = STANDARD.decode(page["base64"].as_str().unwrap()).unwrap();
        assert!(!part.is_empty(), "a byte page makes progress");
        assert_eq!(page["length"].as_u64().unwrap() as usize, part.len());
        bytes.extend(part);
        if let Some(next) = page["next_after_byte"].as_u64() {
            assert_eq!(next as usize, bytes.len(), "the next page starts exactly after this page");
            request["params"]["arguments"]["input"]["after_byte"] = json!(next);
        } else {
            assert_eq!(bytes.len() as u64, total);
            assert_eq!(blake3::hash(&bytes).to_hex().as_str(), identity.1);
            answer["result"]["structuredContent"] = serde_json::from_slice(&bytes).unwrap();
            return (status, by, answer, pages);
        }
    }
}

/// One HTTP/1.1 POST to a computer's own listener at `port`: its status, the computer that answered and its body.
fn listener_mcp(port: u16, path: &str, bearer: &str, body: &Value) -> (StatusCode, String, Value) {
    listener_mcp_headers(port, "computer.test", path, &format!("Bearer {bearer}"), None, body)
}

/// The same real TCP request with explicit ingress headers for the Host, Origin and scheme controls.
fn listener_mcp_headers(port: u16, host: &str, path: &str, authorization: &str, origin: Option<&str>, body: &Value) -> (StatusCode, String, Value) {
    use std::io::{Read as _, Write as _};
    let body = body.to_string();
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else { return (StatusCode::SERVICE_UNAVAILABLE, String::new(), Value::Null) };
    stream.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    let origin = origin.map(|origin| format!("Origin: {origin}\r\n")).unwrap_or_default();
    write!(stream, "POST {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: {authorization}\r\n{origin}Content-Type: application/json\r\n\
        Accept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    let mut answer = String::new();
    let _ = stream.read_to_string(&mut answer);
    let status = answer.split_whitespace().nth(1).and_then(|code| code.parse().ok()).unwrap_or(0);
    let (head, text) = answer.split_once("\r\n\r\n").unwrap_or((&answer, ""));
    let by = head.lines().find_map(|line| line.strip_prefix("trillion-computer: ").or_else(|| line.strip_prefix("Trillion-Computer: ")))
        .unwrap_or("").trim().to_owned();
    let start = text.find('{').unwrap_or(0);
    let end = text.rfind('}').map_or(text.len(), |at| at + 1);
    (StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY), by, serde_json::from_str(&text[start..end]).unwrap_or(Value::Null))
}

/// Share the existing TCP-listener readiness poll between synthetic engines.
fn wait_listening(wait: Duration, port: u16, mut while_waiting: impl FnMut()) -> bool {
    let deadline = Instant::now() + wait;
    loop {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        while_waiting();
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Ask `call` again until `done` says its answer is the one waited for, or `wait` passes.
fn until(wait: Duration, call: &mut dyn FnMut() -> (StatusCode, String, Value), done: &dyn Fn(StatusCode, &Value) -> bool) -> (StatusCode, String, Value) {
    let deadline = Instant::now() + wait;
    loop {
        let (status, by, answer) = call();
        if done(status, &answer) || Instant::now() > deadline {
            return (status, by, answer);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// The Mac app's engine is one computer of its account, a server another: a write at each is read at both; with the
/// server off the Mac answers the account through the forwarder, and with the Mac off the server does, each with the
/// other's writes.
#[test]
fn the_mac_apps_engine_and_a_server_hold_one_account_and_either_answers_while_the_other_is_off() {
    let dir = tempfile::tempdir().unwrap();
    let tls = dir.path().join("tls");
    fs::create_dir_all(&tls).unwrap();
    let identity = localhost_tls(&tls);
    let trust = tls.join("ca.pem");
    // The Mac app's engine verifies the forwarder with this process's roots, as the servers do with theirs.
    std::env::set_var("SSL_CERT_FILE", &trust);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let forwarder_host: &'static str = Box::leak(format!("localhost:{}", listener.local_addr().unwrap().port()).into_boxed_str());
    let gateway = Arc::new(Gateway::with_computers(forwarder_host, std::sync::Arc::new(trillion_local::storage::time_source::RealClock)));
    let forwarder = gateway.http_route_table().unwrap();
    let serving = front_door::behind_tls(listener, identity, gateway.clone()).unwrap();
    let shutdown = Arc::new(AtomicBool::new(false));
    let ended = shutdown.clone();
    std::thread::spawn(move || serving.serve(ended));
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();

    // The account is made in the Mac's folder; the Mac app keeps its root (here: read once from the sealed file the
    // making left, which is then removed, as the Mac app's folder holds no sealed root) and its computer key.
    // Every computer, this process's and the server processes it starts, checks sign-ins against the test signer.
    signer::install();
    let mac = Peer::new(dir.path(), "mac", 71, forwarder_host);
    let mut server = Peer::new(dir.path(), "server", 72, forwarder_host);
    let mut third = Peer::new(dir.path(), "third", 73, forwarder_host);
    let created = command(&["account", "create", mac.config.to_str().unwrap()]);
    let words: Vec<&str> = created.split_whitespace().collect();
    let at = |name: &str| words.iter().position(|word| *word == name).map(|at| words[at + 1].to_owned()).unwrap();
    let (owner, address) = (at("owner"), at("address"));
    let folder = mac.account(&owner);
    installed_tools::install(&folder);
    let root = secrets_key::open_sealed(&folder, &mac.key).unwrap();
    fs::remove_file(secrets_key::sealed_file(&folder).unwrap()).unwrap();

    let hosted = Computer::hosting_at(&folder, ORIGIN, MAC_HOST, Some(forwarder_host.to_owned()), ComputerKey::read(&mac.key).unwrap(), root)
        .unwrap_or_else(|error| panic!("the Mac app's account did not open as a computer: {error}"));
    assert_eq!(hosted.computer.computer_id(), mac.id, "the Mac app's computer id is its kept computer key's");
    // The person signed in to the account (the test signer stands for the Better Auth Workshop tool).
    let key = signer::token(&address);
    let mac_stop: &'static AtomicBool = Box::leak(Box::new(AtomicBool::new(false)));
    hosted.computer.run_hosting(mac_stop);
    server.start(&trust);
    third.start(&trust);
    let logs = |server: &Peer, third: &Peer| format!("\nserver: {}\nthird: {}", server.log(), third.log());

    let through_forwarder = |body: &Value| mcp(&rt, &forwarder, forwarder_host, "/mcp", &key, body);
    let at_mac = |body: &Value| mcp(&rt, &hosted.local, MAC_HOST, "/mcp", &key, body);
    let account_path = format!("/a/{address}/mcp");
    let server_port = server.port;
    let at_server = |body: &Value| listener_mcp(server_port, &account_path, &key, body);
    let mut id = 0;
    let mut row = |input: Value| {
        id += 1;
        tool(id, "@sign-in", "sign-in:set-places", &format!("hosting-places-{id}"), input)
    };
    let write = |n: u32, words: &str| tool(100 + u64::from(n), "@own-records", "records:write", &format!("hosting-write-{n}"),
        json!({"records": [{"id": format!("hosting-note-{n}"), "type": "note", "value": {"words": words}}]}));
    let read = |n: u32, request: &str| tool(200 + u64::from(n), "@own-records", "records:read", request, json!({"id": format!("hosting-note-{n}")}));
    let says = |words: &'static str| move |status: StatusCode, answer: &Value| {
        tool_ok(status, answer) && answer["result"]["structuredContent"]["value"]["words"] == words
    };

    // The Mac app answers its account through the forwarder as a computer (its kept key's id), and its row names it.
    let (status, by, answer) = until(Duration::from_secs(30), &mut || through_forwarder(&row(json!({"op": "set",
        "keeps_copy": [mac.id], "may_answer": [mac.id], "voters": [mac.id]}))), &tool_ok);
    assert!(tool_ok(status, &answer), "the Mac app named no voter: {answer}{}", logs(&server, &third));
    assert_eq!(by, mac.id, "the forwarder reached the Mac app's computer");

    // The server joins by itself (may answer), then votes; the third keeps a copy only, then votes.
    for (input, what) in [
        (json!({"op": "add-computer", "computer": server.id, "may_answer": true}), "the server was not added"),
        (json!({"op": "add-computer", "computer": server.id, "may_answer": true, "voter": true}), "the server never became a voter"),
        (json!({"op": "add-computer", "computer": third.id, "may_answer": false}), "the third was not added"),
        (json!({"op": "add-computer", "computer": third.id, "may_answer": false, "voter": true}), "the third never became a voter"),
    ] {
        let body = row(input);
        let (status, _, answer) = until(Duration::from_secs(180), &mut || through_forwarder(&body), &tool_ok);
        assert!(tool_ok(status, &answer), "{what}: {answer}{}", logs(&server, &third));
    }
    assert!(server.account(&owner).is_dir() && third.account(&owner).is_dir(), "both joined by themselves{}", logs(&server, &third));

    // One write at each computer: at the Mac app's own routes (its window's MCP), then at the server's own listener once
    // the Mac hands its writer turn over.
    let (status, _, answer) = until(Duration::from_secs(60), &mut || at_mac(&write(1, "AT_MAC")), &tool_ok);
    assert!(tool_ok(status, &answer), "no write at the Mac app: {answer}{}", logs(&server, &third));
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        hosted.computer.hand_over_writer_turns();
        let (status, by, answer) = at_server(&write(2, "AT_SERVER"));
        if tool_ok(status, &answer) {
            assert_eq!(by, server.id);
            break;
        }
        assert!(Instant::now() < deadline, "no write at the server: {answer}{}", logs(&server, &third));
        std::thread::sleep(Duration::from_millis(500));
    }
    // Both read both.
    for (n, words) in [(1, "AT_MAC"), (2, "AT_SERVER")] {
        let (status, _, answer) = until(Duration::from_secs(60), &mut || at_mac(&read(n, &format!("mac-reads-{n}"))), &says(words));
        assert!(says(words)(status, &answer), "the Mac app does not read note {n}: {answer}{}", logs(&server, &third));
        let (status, by, answer) = until(Duration::from_secs(60), &mut || at_server(&read(n, &format!("server-reads-{n}"))), &says(words));
        assert!(says(words)(status, &answer), "the server does not read note {n}: {answer}{}", logs(&server, &third));
        assert_eq!(by, server.id);
    }

    // The server is off: the forwarder reaches the Mac app, which reads both and takes a write.
    server.stop();
    let (status, by, answer) = until(Duration::from_secs(120), &mut || through_forwarder(&read(2, "relay-reads-2-mac")), &says("AT_SERVER"));
    assert!(says("AT_SERVER")(status, &answer), "with the server off nobody answered: {answer}{}", logs(&server, &third));
    assert_eq!(by, mac.id, "with the server off the Mac app answered");
    let (status, by, answer) = until(Duration::from_secs(120), &mut || through_forwarder(&write(3, "SERVER_OFF")), &tool_ok);
    assert!(tool_ok(status, &answer), "no write with the server off: {answer}{}", logs(&server, &third));
    assert_eq!(by, mac.id);

    // The server is back and catches up; then the Mac app is off: the server answers, with the write made while it was off.
    server.start(&trust);
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let (status, _, answer) = at_server(&read(3, "server-catches-up"));
        if says("SERVER_OFF")(status, &answer) {
            break;
        }
        assert!(Instant::now() < deadline, "the server never caught up: {answer}{}", logs(&server, &third));
        std::thread::sleep(Duration::from_millis(500));
    }
    mac_stop.store(true, Ordering::Release);
    hosted.computer.hand_over_writer_turns();
    for (n, words) in [(1, "AT_MAC"), (3, "SERVER_OFF")] {
        let (status, by, answer) = until(Duration::from_secs(120), &mut || through_forwarder(&read(n, &format!("relay-reads-{n}-server"))), &says(words));
        assert!(says(words)(status, &answer), "with the Mac app off nobody answered note {n}: {answer}{}", logs(&server, &third));
        assert_eq!(by, server.id, "with the Mac app off the server answered");
    }
    let (status, by, answer) = until(Duration::from_secs(120), &mut || through_forwarder(&write(4, "MAC_OFF")), &tool_ok);
    assert!(tool_ok(status, &answer), "no write with the Mac app off: {answer}{}", logs(&server, &third));
    assert_eq!(by, server.id);
    assert!(!third.log().contains("event=door-composed"), "the third keeps a copy only{}", logs(&server, &third));
    shutdown.store(true, Ordering::Release);
}

/// Trusted synthetic source maintenance, like the original-result generation controls.
/// This never opens the person's account. Its only mutation runs while the test writer is stopped.
fn synthetic_records(folder: &Path) -> trillion_local::storage::record_store::RecordStore<
    trillion_local::storage::sqlite::Supply<rusqlite::Connection>,
> {
    use trillion_local::storage::{record_store::{RecordStore, RealClock, settings::Limits}, sqlite};
    let bounds = sqlite::Bounds {
        value_bytes: 2 * 1024 * 1024, work: u64::MAX / 2, deadline: Duration::MAX,
        spend: sqlite::Spend::EachOperation, cancel: None, busy: Duration::from_secs(5),
    };
    let supply = sqlite::open_owned(&folder.join("records.sqlite"), "record_store", bounds).unwrap();
    RecordStore::new(supply, Box::new(RealClock), Limits::fixed(1 << 20, 10 << 30)).unwrap()
}

/// An engine process for the synthetic account, used for both its first launch and its relaunch.
/// The harness gives it the same root the app would keep; no pending value is passed across this boundary.
fn reopened_hosting_engine() -> ! {
    let folder = PathBuf::from(std::env::var_os("TRILLION_REOPEN_FOLDER").unwrap());
    let key_file = PathBuf::from(std::env::var_os("TRILLION_REOPEN_KEY_FILE").unwrap());
    let forwarder = std::env::var("TRILLION_REOPEN_FORWARDER").unwrap();
    let port: u16 = std::env::var("TRILLION_REOPEN_PORT").unwrap().parse().unwrap();
    let host = std::env::var("TRILLION_REOPEN_HOST").unwrap_or_else(|_| "computer.test".into());
    let root = secrets_key::open_sealed(&folder, &key_file).unwrap();
    fs::remove_file(secrets_key::sealed_file(&folder).unwrap()).unwrap();
    let hosted = Computer::hosting_at(&folder, ORIGIN, &host, Some(forwarder),
        ComputerKey::read(&key_file).unwrap(), root).unwrap();
    let stop = Box::leak(Box::new(AtomicBool::new(false)));
    hosted.computer.run_hosting(stop);
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    // This inspection route exists only in this synthetic test process. It reads the real copies owner so the
    // orchestrator preserves the membership/turn assertions without retaining any engine object in its process.
    let computer = hosted.computer.clone();
    let app = hosted.local.route("/__test/copies", axum::routing::post(move || {
        let computer = computer.clone();
        async move {
            let account = computer.hosted_account().unwrap();
            let copies = account.running_copies().unwrap();
            let row = copies.row();
            axum::Json(json!({"row":{"may_answer":row.may_answer,"keeps_copy":row.copy_keepers,"voters":row.voters},"holding":copies.holding()}))
        }
    }));
    rt.block_on(async move {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        axum::serve(listener, app).await.unwrap();
    });
    panic!("the synthetic hosting engine unexpectedly ended");
}

struct ReopenedEngine(Option<std::process::Child>);
impl ReopenedEngine {
    fn start(folder: &Path, key: &Path, forwarder: &str, port: u16, host: &str, log: &Path, trust: &Path) -> Self {
        let output = fs::File::create(log).unwrap();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "hosting_loopback_reaches_the_remote_account_after_this_computer_is_removed", "--nocapture"])
            .env("TRILLION_HOSTING_REMOVED_ACCOUNT_TEST", "1")
            .env("TRILLION_REOPEN_FOLDER", folder).env("TRILLION_REOPEN_KEY_FILE", key)
            .env("TRILLION_REOPEN_FORWARDER", forwarder).env("TRILLION_REOPEN_PORT", port.to_string())
            .env("TRILLION_REOPEN_HOST", host).env("SSL_CERT_FILE", trust)
            .stdout(output.try_clone().unwrap()).stderr(output).spawn().unwrap();
        let mut engine = Self(Some(child));
        let listening = wait_listening(Duration::from_secs(60), port, || {
            let exited = engine.0.as_mut().unwrap().try_wait().unwrap();
            assert!(exited.is_none(), "the synthetic hosting engine did not listen: {}",
                fs::read_to_string(log).unwrap_or_default());
        });
        assert!(listening, "the synthetic hosting engine did not listen: {}",
            fs::read_to_string(log).unwrap_or_default());
        engine
    }
    fn stop(&mut self) {
        if let Some(mut child) = self.0.take() {
            // This is the synthetic child only. Waiting proves the old PID has ended before reopening its stores;
            // the real startup guard and recovery code remain responsible for the new process's admission.
            let _ = child.kill();
            assert!(child.wait().is_ok(), "the first synthetic engine must exit before relaunch");
        }
    }
}
impl Drop for ReopenedEngine {
    fn drop(&mut self) { self.stop(); }
}

/// The original loopback door still reaches an account whose signed row now names only a remote computer.
#[test]
#[ignore = "issues and turns off a personal key at the remote account (sign-in:issue-key, sign-in:turn-off-key), which left the engine with sign-in (Better Auth Workshop tool, Nov 13 2026)"]
fn hosting_loopback_reaches_the_remote_account_after_this_computer_is_removed() {
    // Each hosting app receives its root once per process. A child keeps this independent account isolated from
    // the other hosting test's root, sign-in registration and writer role.
    const CHILD: &str = "TRILLION_HOSTING_REMOVED_ACCOUNT_TEST";
    const TEST: &str = "hosting_loopback_reaches_the_remote_account_after_this_computer_is_removed";
    if std::env::var_os("TRILLION_REOPEN_FOLDER").is_some() {
        reopened_hosting_engine();
    }
    if std::env::var_os(CHILD).is_none() {
        let done = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"]).env(CHILD, "1").output().unwrap();
        assert!(done.status.success(), "the synthetic hosting app failed:\n{}\n{}",
            String::from_utf8_lossy(&done.stdout), String::from_utf8_lossy(&done.stderr));
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let tls = dir.path().join("tls");
    fs::create_dir_all(&tls).unwrap();
    let identity = localhost_tls(&tls);
    let trust = tls.join("ca.pem");
    std::env::set_var("SSL_CERT_FILE", &trust);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let forwarder_host: &'static str = Box::leak(format!("localhost:{}", listener.local_addr().unwrap().port()).into_boxed_str());
    let gateway = Arc::new(Gateway::with_computers(forwarder_host, std::sync::Arc::new(trillion_local::storage::time_source::RealClock)));
    let forwarder = gateway.http_route_table().unwrap();
    let serving = front_door::behind_tls(listener, identity, gateway.clone()).unwrap();
    let shutdown = Arc::new(AtomicBool::new(false));
    let ended = shutdown.clone();
    std::thread::spawn(move || serving.serve(ended));
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    signer::install();
    let mac = Peer::new(dir.path(), "hosting-app", 74, forwarder_host);
    let mut server = Peer::new(dir.path(), "account-home", 75, forwarder_host);
    let created = command(&["account", "create", mac.config.to_str().unwrap()]);
    let words: Vec<&str> = created.split_whitespace().collect();
    let at = |name: &str| words.iter().position(|word| *word == name).map(|at| words[at + 1].to_owned()).unwrap();
    let (owner, address) = (at("owner"), at("address"));
    let folder = mac.account(&owner);
    installed_tools::install(&folder);
    let sealed_root = fs::read(secrets_key::sealed_file(&folder).unwrap()).unwrap();
    let mut initial_engine = ReopenedEngine::start(&folder, &mac.key, forwarder_host, mac.port, MAC_HOST,
        &dir.path().join("initial-engine.log"), &trust);
    let key = signer::token(&address);
    server.start(&trust);
    let through_forwarder = |body: &Value| mcp(&rt, &forwarder, forwarder_host, "/mcp", &key, body);
    let at_mac = |body: &Value| listener_mcp_headers(mac.port, MAC_HOST, "/mcp", &format!("Bearer {key}"), None, body);
    let row = |n: u32, input: Value| tool(u64::from(n), "@sign-in", "sign-in:set-places", &format!("loopback-places-{n}"), input);
    for (n, input) in [
        (1, json!({"op": "set", "keeps_copy": [mac.id], "may_answer": [mac.id], "voters": [mac.id]})),
        (2, json!({"op": "add-computer", "computer": server.id, "may_answer": true})),
        (3, json!({"op": "add-computer", "computer": server.id, "may_answer": true, "voter": true})),
        (4, json!({"op": "set", "keeps_copy": [server.id], "may_answer": [server.id], "voters": [server.id]})),
    ] {
        let body = row(n, input);
        let (status, _, answer) = until(Duration::from_secs(180), &mut || through_forwarder(&body), &tool_ok);
        assert!(tool_ok(status, &answer), "the synthetic account move {n} failed: {answer}\n{}", server.log());
    }
    let moved = |status, copies: &Value| status == StatusCode::OK
        && copies["row"]["may_answer"].as_array().is_some_and(|ids| !ids.contains(&json!(mac.id)));
    let (status, _, copies) = until(Duration::from_secs(60), &mut ||
        listener_mcp_headers(mac.port, MAC_HOST, "/__test/copies", "Bearer synthetic-inspection", None, &json!({})), &moved);
    assert!(moved(status, &copies), "the hosting app never learned that its account moved away: {copies}");
    assert_eq!(copies["row"]["keeps_copy"], json!([server.id]));
    assert_eq!(copies["row"]["voters"], json!([server.id]));
    assert!(copies["holding"].is_null(), "the removed hosting app must hold no writer turn");
    let value = json!({"words": "a progress entry saved through the original local door"});
    let write = tool(10, "@own-records", "records:write", "loopback-remote-write",
        json!({"records": [{"id": "loopback-remote-note", "type": "note", "value": value}]}));
    for (host, origin, expected) in [
        ("another-computer.test", None, StatusCode::MISDIRECTED_REQUEST),
        (MAC_HOST, Some("https://another-computer.test"), StatusCode::FORBIDDEN),
    ] {
        let (status, _, _) = listener_mcp_headers(mac.port, host, "/mcp", &format!("Bearer {key}"), origin, &write);
        assert_eq!(status, expected, "the moved account's loopback door keeps its Host and Origin fences");
    }
    let (status, by, written) = at_mac(&write);
    assert!(tool_ok(status, &written), "the original local door refused its moved account's write: {written}\n{}", server.log());
    assert_ne!(by, server.id, "the hosting door retains and answers its local command");
    let first_receipt = written["result"]["structuredContent"].clone();
    if first_receipt["write_count"] != 1 {
        assert_eq!(first_receipt, json!({"accepted":true,"pending":true,"request_key":"loopback-remote-write"}),
            "before the remote writer claims its turn the local door returns its exact durable acceptance");
    }
    let read = tool(11, "@own-records", "records:read", "loopback-remote-read", json!({"id": "loopback-remote-note"}));
    // The very next local read sees the accepted value, without borrowing the remote read path.
    let (status, read_by, answer) = at_mac(&read);
    assert!(tool_ok(status, &answer), "the immediate local read-back failed: {answer}");
    assert_ne!(read_by, server.id, "the local provisional view is answered on this computer");
    assert_eq!(answer["result"]["structuredContent"]["value"], value);
    // A durable local acceptance can precede the new writer's claim. Only remote reads wait for
    // delivery; repeating the write here would hide a missing automatic settle after local acceptance.
    let says_value = |status, answer: &Value| tool_ok(status, answer)
        && answer["result"]["structuredContent"]["value"] == value;
    let (status, read_by, answer) = until(Duration::from_secs(120), &mut || through_forwarder(&read), &says_value);
    assert!(says_value(status, &answer), "the settled write's writer read-back failed: {answer}\n{}", server.log());
    assert_eq!(read_by, server.id);
    let canonical_receipt = |status, answer: &Value| tool_ok(status, answer)
        && answer["result"]["structuredContent"]["write_count"] == 1;
    let (status, retry_by, retried) = until(Duration::from_secs(60), &mut || at_mac(&write), &canonical_receipt);
    assert!(canonical_receipt(status, &retried), "same-key recovery never returned the writer's committed receipt: {retried}");
    assert_ne!(retry_by, server.id, "same-key recovery is retained locally");
    let expected = retried["result"]["structuredContent"].clone();
    if first_receipt["write_count"] == 1 {
        assert_eq!(expected, first_receipt, "an initially committed receipt is already the original result");
    }
    let (status, _, stable_retry) = at_mac(&write);
    assert!(canonical_receipt(status, &stable_retry), "committed receipt recovery regressed: {stable_retry}");
    assert_eq!(stable_retry["result"]["structuredContent"], expected,
        "once settled the original key always returns the same committed receipt");

    // A normal progress value can exceed one computer message after sealing. This must use
    // the same durable local command and dedicated settle multipart path, without truncation.
    let large_value = json!({"words":"m".repeat(80_000)});
    let large_write = tool(16, "@own-records", "records:write", "loopback-large-write", json!({"records":[{
        "id":"loopback-large-note", "type":"note", "value":large_value, "expected":null
    }]}));
    let large_read = tool(17, "@own-records", "records:read", "loopback-large-read", json!({"id":"loopback-large-note"}));
    let (status, _, large_accepted) = at_mac(&large_write);
    assert!(tool_ok(status, &large_accepted), "a large local command was refused before settlement: {large_accepted}");
    let (status, read_by, large_local, local_pages) = paged_mcp_read(&mut |body| at_mac(body), &large_read);
    assert!(tool_ok(status, &large_local), "the very next local read lost a large accepted value: {large_local}");
    assert_ne!(read_by, server.id, "the large accepted value is read from this computer's copy");
    assert!(local_pages > 1, "the synthetic value exercises actual MCP byte paging");
    assert_eq!(large_local["result"]["structuredContent"]["value"], large_value);
    let says_large = |status, answer: &Value| tool_ok(status, answer)
        && answer["result"]["structuredContent"]["value"] == large_value;
    let (status, read_by, large_remote) = until(Duration::from_secs(120), &mut || {
        let (status, by, answer, _) = paged_mcp_read(&mut |body| through_forwarder(body), &large_read);
        (status, by, answer)
    }, &says_large);
    assert!(says_large(status, &large_remote), "the complete large command never reached the writer: {large_remote}\n{}", server.log());
    assert_eq!(read_by, server.id);
    let (status, _, large_receipt) = until(Duration::from_secs(60), &mut || at_mac(&large_write), &canonical_receipt);
    assert!(canonical_receipt(status, &large_receipt), "the large command has no canonical keyed receipt: {large_receipt}");
    assert_eq!(at_mac(&large_write).2["result"], large_receipt["result"], "the large command's original key stays stable");

    // A writer rejects the original conditional command as a known conflict. The provisional
    // replacement is withdrawn; a same-key retry returns the same refusal rather than outcome-unknown.
    let conflict = tool(12, "@own-records", "records:write", "loopback-known-refusal", json!({"records":[{
        "id":"loopback-remote-note", "type":"note", "value":{"words":"must not replace"}, "expected":null
    }]}));
    let (status, _, refused) = at_mac(&conflict);
    assert_eq!(status, StatusCode::OK, "{refused}");
    assert_eq!(refused["result"]["isError"], true, "{refused}");
    assert_eq!(refused["result"]["structuredContent"]["code"], "original_command_conflict", "{refused}");
    assert!(!refused.to_string().contains("unknown"), "a known writer refusal is never outcome-unknown: {refused}");
    let (_, _, retry_refused) = at_mac(&conflict);
    assert_eq!(retry_refused["result"], refused["result"], "the exact refusal survives keyed recovery");
    let (status, _, after_refusal) = at_mac(&read);
    assert!(tool_ok(status, &after_refusal), "{after_refusal}");
    assert_eq!(after_refusal["result"]["structuredContent"]["value"], value,
        "a refused provisional change must not hide the accepted value");
    // Settling this computer's value must not freeze its local view forever. Another computer's
    // later write arrives through the copies' existing timer; only local reads follow that edit.
    let refresh_before = json!({"words":"the local computer's first value"});
    let refresh_after = json!({"words":"the writer's later multiplayer edit"});
    let refresh_write = tool(13, "@own-records", "records:write", "copy-refresh-local-write", json!({"records":[{
        "id":"copy-refresh-note", "type":"note", "value":refresh_before, "expected":null
    }]}));
    let refresh_read = tool(14, "@own-records", "records:read", "copy-refresh-local-read", json!({"id":"copy-refresh-note"}));
    let (status, _, first_refresh_write) = at_mac(&refresh_write);
    assert!(tool_ok(status, &first_refresh_write), "the local refresh fixture was refused: {first_refresh_write}");
    let (status, read_by, first_refresh_read) = at_mac(&refresh_read);
    assert!(tool_ok(status, &first_refresh_read), "the local refresh fixture did not read back: {first_refresh_read}");
    assert_ne!(read_by, server.id, "this computer answers its own accepted view");
    assert_eq!(first_refresh_read["result"]["structuredContent"]["value"], refresh_before);
    let remote_edit = tool(15, "@own-records", "records:write", "copy-refresh-writer-edit", json!({"records":[{
        "id":"copy-refresh-note", "type":"note", "value":refresh_after
    }]}));
    let (status, written_by, edited) = through_forwarder(&remote_edit);
    assert!(tool_ok(status, &edited), "the writer's later edit failed: {edited}");
    assert_eq!(written_by, server.id, "the later edit is made at the sole writer");
    let sees_later = |status, answer: &Value| tool_ok(status, answer)
        && answer["result"]["structuredContent"]["value"] == refresh_after;
    let (status, read_by, refreshed) = until(Duration::from_secs(120), &mut || at_mac(&refresh_read), &sees_later);
    assert!(sees_later(status, &refreshed), "the settled local projection hid the writer's later edit: {refreshed}\n{}", server.log());
    assert_ne!(read_by, server.id, "the copies' refreshed local view answers without forwarding this read");

    let issue = tool(20, "@sign-in", "sign-in:issue-key", "loopback-remote-key",
        json!({"name": "made only at the remote account", "scopes": ["records"]}));
    let (status, _, issued) = through_forwarder(&issue);
    assert!(tool_ok(status, &issued), "the remote account did not issue its synthetic key");
    let new_key = issued["result"]["structuredContent"]["key"].as_str().unwrap();
    let key_id = issued["result"]["structuredContent"]["id"].as_str().unwrap();
    let local_sign_in = rusqlite::Connection::open_with_flags(folder.join("sign-in.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let local_key_rows: i64 = local_sign_in.query_row("SELECT COUNT(*) FROM personal_keys WHERE id=?",
        [key_id], |row| row.get(0)).unwrap();
    assert_eq!(local_key_rows, 0, "the removed computer must not be this new key's admission source");
    let (status, read_by, answer) = listener_mcp_headers(mac.port, MAC_HOST, "/mcp", &format!("Bearer {new_key}"), None, &read);
    assert!(tool_ok(status, &answer), "the original local door blocked a key issued at the remote account");
    assert_eq!(read_by, server.id);
    assert_eq!(answer["result"]["structuredContent"]["value"], value);
    // This key has no copied local admission row and no provisional projection. Its large read
    // therefore crosses the actual writer read and sealed-reply multipart path through the local door.
    let (status, read_by, large_new_key_read, remote_pages) = paged_mcp_read(
        &mut |body| listener_mcp_headers(mac.port, MAC_HOST, "/mcp", &format!("Bearer {new_key}"), None, body), &large_read);
    assert!(tool_ok(status, &large_new_key_read), "the remote-only key's large read failed: {large_new_key_read}");
    assert_eq!(read_by, server.id, "the fresh key's large read is authenticated and answered by the actual writer");
    assert!(remote_pages > 1, "the remote-only read exercises real sealed paged replies");
    assert_eq!(large_new_key_read["result"]["structuredContent"]["value"], large_value);
    // HTTP authentication scheme names are case-insensitive, as at the original local MCP ingress.
    let (status, read_by, answer) = listener_mcp_headers(mac.port, MAC_HOST, "/mcp", &format!("bearer {new_key}"), None, &read);
    assert_eq!(status, StatusCode::OK, "a lowercase Bearer scheme reaches the remote account");
    assert_eq!(read_by, server.id);
    assert_eq!(answer["result"]["structuredContent"]["value"], value);
    let revoke = tool(21, "@sign-in", "sign-in:turn-off-key", "loopback-revoke-remote-key", json!({"id": key_id}));
    let (status, _, revoked) = through_forwarder(&revoke);
    assert!(tool_ok(status, &revoked), "the remote account did not revoke its synthetic key");
    assert_eq!(revoked["result"]["structuredContent"]["turned_off"], true);
    let (status, _, _) = listener_mcp_headers(mac.port, MAC_HOST, "/mcp", &format!("Bearer {new_key}"), None, &write);
    assert_eq!(status, StatusCode::UNAUTHORIZED, "the loopback door must honor the remote key's revocation");
    for (home, expected) in [(&folder, 0_i64), (&server.account(&owner), 1_i64)] {
        let records = rusqlite::Connection::open_with_flags(home.join("records.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        for id in ["loopback-remote-note", "loopback-large-note"] {
            let versions: i64 = records.query_row(
                "SELECT COUNT(*) FROM versions WHERE account=? AND resource='own-records' AND id=?",
                [owner.as_str(), id], |row| row.get(0)).unwrap();
            assert_eq!(versions, expected, "one writer business version of {id}; provisional local values do not invent committed versions");
        }
    }
    // Disconnect the sole writer. A local write must still be durable and visible on the next
    // read. Its request key and proposed value are kept before any writer can answer it.
    server.stop();
    let offline_value = json!({"words":"kept while the sole writer was unreachable"});
    let offline_write = tool(30, "@own-records", "records:write", "loopback-offline-write", json!({"records":[{
        "id":"loopback-offline-note", "type":"note", "value":offline_value, "expected":null
    }]}));
    let offline_read = tool(31, "@own-records", "records:read", "loopback-offline-read", json!({"id":"loopback-offline-note"}));
    let (status, _, pending) = at_mac(&offline_write);
    assert!(tool_ok(status, &pending), "the unreachable writer must not refuse local acceptance: {pending}");
    assert_eq!(pending["result"]["structuredContent"], json!({
        "accepted":true,"pending":true,"request_key":"loopback-offline-write"
    }));
    let (status, _, immediate) = at_mac(&offline_read);
    assert!(tool_ok(status, &immediate), "the next read must see the durable pending value: {immediate}");
    assert_eq!(immediate["result"]["structuredContent"]["value"], offline_value);

    // Stop all owners of this hosting engine. The next engine is an OS process with fresh
    // globals, opened from this same folder and key, while the writer is still unreachable.
    initial_engine.stop();
    fs::write(secrets_key::sealed_file(&folder).unwrap(), sealed_root).unwrap();
    let reopen_port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let _reopened = ReopenedEngine::start(&folder, &mac.key, forwarder_host, reopen_port, "computer.test",
        &dir.path().join("reopened-engine.log"), &trust);
    let at_reopened = |body: &Value| listener_mcp(reopen_port, "/mcp", &key, body);
    let (status, _, restored) = at_reopened(&offline_read);
    assert!(tool_ok(status, &restored), "the fresh engine lost the pending read: {restored}");
    assert_eq!(restored["result"]["structuredContent"]["value"], offline_value);
    let (status, _, recovered_pending) = at_reopened(&offline_write);
    assert!(tool_ok(status, &recovered_pending), "the fresh engine lost the original request key: {recovered_pending}");
    assert_eq!(recovered_pending["result"], pending["result"]);
    let (status, _, restored_refusal) = at_reopened(&conflict);
    assert_eq!(status, StatusCode::OK, "{restored_refusal}");
    assert_eq!(restored_refusal["result"], refused["result"],
        "a known writer refusal is recovered after relaunch even while the writer is absent");

    server.start(&trust);
    // Delivery resumes from the durable queue itself. Only reads are sent while waiting;
    // replaying the write here would hide a missing background outbox recovery path.
    let says_offline = |status, answer: &Value| tool_ok(status, answer)
        && answer["result"]["structuredContent"]["value"] == offline_value;
    let (status, _, delivered) = until(Duration::from_secs(120), &mut || through_forwarder(&offline_read), &says_offline);
    assert!(says_offline(status, &delivered), "the restarted engine never delivered its durable command: {delivered}\n{}", server.log());
    let (status, _, receipt) = at_reopened(&offline_write);
    assert!(tool_ok(status, &receipt), "the settled request did not recover: {receipt}");
    assert_eq!(receipt["result"]["structuredContent"]["write_count"], 1);
    assert_eq!(at_reopened(&offline_write).2["result"], receipt["result"], "a retry returns the one committed receipt");
    let records = rusqlite::Connection::open_with_flags(server.account(&owner).join("records.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let versions: i64 = records.query_row(
        "SELECT COUNT(*) FROM versions WHERE account=? AND resource='own-records' AND id='loopback-offline-note'",
        [&owner], |row| row.get(0)).unwrap();
    assert_eq!(versions, 1, "relaunch and same-key retries commit the business record exactly once");
    drop(records);

    // An unscoped pending command still belongs to the source generation at local acceptance.
    // Replacing that source while its sole writer is away must never silently rebind the command.
    server.stop();
    let stale_source_write = tool(40, "@own-records", "records:write", "pending-old-source", json!({"records":[{
        "id":"pending-source-replaced-note", "type":"note", "value":{"words":"belongs only to the old source"}, "expected":null
    }]}));
    let (status, _, accepted_old_source) = at_reopened(&stale_source_write);
    assert!(tool_ok(status, &accepted_old_source), "the old-source write was not kept: {accepted_old_source}");
    assert_eq!(accepted_old_source["result"]["structuredContent"]["pending"], true);
    let next_header = {
        use trillion_local::records::{Mutation, Records as _};
        let mut store = synthetic_records(&server.account(&owner));
        let (version, current) = store.held_record_with_version(&owner, "own-resource-identity", "1").unwrap();
        let mut header = current.unwrap().value;
        assert_eq!(header["generation"], 1, "the synthetic source starts in the accepted generation");
        header["generation"] = json!(2);
        store.mutate(&owner, "own-resource-identity", Mutation {
            id:"1".into(), expected_version:version, request_key:"synthetic-advance-source-generation".into(),
            deleted:false, value:header.clone(),
        }).unwrap();
        assert_eq!(store.current_record(&owner, "own-resource-identity", "1").unwrap().unwrap().value, header);
        header
    };
    server.start(&trust);
    let known_source_refusal = |status, answer: &Value| status == StatusCode::OK
        && answer["result"]["isError"] == true
        && answer["result"]["structuredContent"]["code"] == "original_command_conflict";
    let (status, _, source_refused) = until(Duration::from_secs(120), &mut || at_reopened(&stale_source_write), &known_source_refusal);
    assert!(known_source_refusal(status, &source_refused), "the writer silently rebound an old-source command: {source_refused}\n{}", server.log());
    assert!(!source_refused.to_string().contains("unknown"), "source replacement is a known no-effect refusal: {source_refused}");
    assert_eq!(at_reopened(&stale_source_write).2["result"], source_refused["result"],
        "the original request key retains its source refusal");
    let store = synthetic_records(&server.account(&owner));
    assert_eq!(store.current_record(&owner, "own-resource-identity", "1").unwrap().unwrap().value, next_header,
        "refusing the old command leaves generation two unchanged");
    assert!(store.current_record(&owner, "own-records", "pending-source-replaced-note").unwrap().is_none(),
        "the stale command must create no business record in the new source");
    let records = rusqlite::Connection::open_with_flags(server.account(&owner).join("records.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let versions: i64 = records.query_row(
        "SELECT COUNT(*) FROM versions WHERE account=? AND resource='own-records' AND id='pending-source-replaced-note'",
        [&owner], |row| row.get(0)).unwrap();
    assert_eq!(versions, 0, "the stale source request leaves no hidden business version");
    shutdown.store(true, Ordering::Release);
}
