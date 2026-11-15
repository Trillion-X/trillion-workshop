//! The native harness of the computer-forwarder tests: the test clock, the one computer key every test names, the
//! forwarder (its HTTP route table and its session socket), a computer's folder config, an account made through the
//! command line and signed in by the test signer (support/signer.rs), and the listener's own requests.

#[path = "signer.rs"]
mod signer;

use crate::test_time::clock;
use axum::body::{to_bytes, Body};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use axum::http::{header, Method, Request, StatusCode};
use serde_json::{json, Value};
use std::{
    fs,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tower::ServiceExt as _;
use trillion_local::{
    forwarder::gateway::Gateway,
    native_entry::computer::Computer,
};

/// The tokio executor the tests drive the forwarder and computers on.
pub type Executor = tokio::runtime::Runtime;

/// The forwarder's axum route table.
pub type RouteTable = axum::Router;

pub const FORWARDER_HOST: &str = "forwarder.test";

thread_local! {
    /// The public host the MCP calls of this thread name (`mcp_call`): a test whose forwarder listens on another host sets it.
    pub static CALL_HOST: std::cell::Cell<&'static str> = const { std::cell::Cell::new(FORWARDER_HOST) };
}

/// The temporary folder by its real path: on macOS `/var` is a symlink, and SQLite's no-follow open refuses any path
/// through a link, so a state folder made under `/var/folders` could not open its sign-in database.
pub fn canonical_temp() -> std::path::PathBuf {
    std::env::temp_dir().canonicalize().expect("the temporary folder has a real path")
}

pub fn shared_computer_key() -> PathBuf {
    static KEY_DIR: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
    KEY_DIR
        .get_or_init(|| tempfile::tempdir_in(canonical_temp()).unwrap())
        .path()
        .join("computer.key")
}

/// Two dispatch threads for a test's calls into the forwarder.
pub fn two_threads() -> Executor {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
}

/// The system's clock, as the harness's `now_ms` reads it: a forwarder that checks proofs at it runs on real time.
pub fn real_clock() -> std::sync::Arc<dyn trillion_local::storage::time_source::Clock> {
    std::sync::Arc::new(trillion_local::storage::time_source::RealClock)
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// A computer folder: its accounts folder and its config, with a free-space floor of zero, sealed to the key file `key`
/// (written when absent).
pub fn computer_config(dir: &Path, key: &Path) -> PathBuf {
    // The computer checks sign-ins against the test signer's keys from its first request.
    signer::install();
    let accounts = dir.join("accounts");
    fs::create_dir_all(&accounts).unwrap();
    if !key.exists() {
        fs::write(
            key,
            STANDARD.encode([42u8; 32]),
        )
        .unwrap();
    }
    let config = dir.join("computer.json");
    fs::write(&config, json!({
        "listen": "127.0.0.1:7199",
        "accounts": accounts,
        "place_key_file": key,
        "public_origin": "https://computer.test",
        "report": {"storage": {"keep_free_bytes": 0}, "reach": "https://computer.test", "cost_per_month_cents": 0,
            "contained_tools": false, "takes_new_accounts": true},
        "sign_in": {"relying_party_drop_labels": 1, "max_body_bytes": 16384, "expired_rows_per_write": 100},
        "new_accounts": {"copies": starting("copies"), "copies_rules": starting("copies_rules")},
        // Offline: each test installs the fixture tools itself (support/installed_tools.rs).
        "tools_at_start": false,
    }).to_string()).unwrap();
    config
}

/// One of the starting rows of src/account/rows/new-accounts.json (the copy rule's: `copies`, `copies_rules`).
pub fn starting(row: &str) -> Value {
    let product: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/account/rows/new-accounts.json"
    )))
    .unwrap();
    product[row].clone()
}

/// Run a command-line entry and answer what it printed.
pub fn run(
    command: fn(&[String], &mut dyn std::io::Write) -> Result<(), Box<dyn std::error::Error>>,
    args: &[&str],
) -> String {
    clock().drive(|| {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let mut out = Vec::new();
    command(&args, &mut out).unwrap_or_else(|error| panic!("{args:?}: {error}"));
    String::from_utf8(out).unwrap()
    }, Duration::from_secs(60), false)
}

/// A forwarder in this process: its HTTP forwarder, and a socket that admits computer sessions into it.
pub struct Forwarder {
    pub gateway: Arc<Gateway>,
    pub http: RouteTable,
    pub sessions: std::net::SocketAddr,
    pub admissions: std::sync::mpsc::Receiver<()>,
}

pub fn start_forwarder() -> Forwarder {
    start_forwarder_from(Gateway::with_computers(FORWARDER_HOST, real_clock()))
}

/// A forwarder in this process built from `gateway`.
pub fn start_forwarder_from(gateway: Gateway) -> Forwarder {
    let gateway = Arc::new(gateway);
    let http = gateway.http_route_table().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let sessions = listener.local_addr().unwrap();
    let (admitted, admissions) = std::sync::mpsc::channel();
    let admitting = gateway.clone();
    let progress = clock();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            timeouts(&stream);
            let _ = admitting.admit_mac_connection(stream);
            admitted.send(()).ok();
            progress.changed();
        }
    });
    Forwarder {
        gateway,
        http,
        sessions,
        admissions,
    }
}

pub fn timeouts(stream: &TcpStream) {
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(30)))
        .unwrap();
}

/// One JSON-RPC MCP call at the forwarder with `bearer`: status, the challenge header and the body.
/// The forwarder's public host is this thread's `CALL_HOST` (the shared test host unless a test sets another).
pub fn mcp_call(
    executor: &Executor,
    http: &RouteTable,
    bearer: &str,
    body: &Value,
) -> (StatusCode, Option<String>, Value) {
    let request = Request::builder()
        .method("POST")
        .uri("/mcp")
        .header(header::HOST, CALL_HOST.with(|host| host.get()))
        .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json, text/event-stream")
        .body(Body::from(body.to_string()))
        .unwrap();
    let clock = clock();
    clock.drive(|| executor.block_on(async {
        let response = http.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let challenge = response
            .headers()
            .get(header::WWW_AUTHENTICATE)
            .map(|value| value.to_str().unwrap().to_owned());
        // A body that breaks on its way (the computer's session ended mid-answer, or the answer was withheld) is an aborted
        // transfer: the client sees an incomplete response, never an empty complete one.
        let answer = match to_bytes(response.into_body(), 1 << 20).await {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into())),
            Err(_) => json!({"transfer": "aborted"}),
        };
        (status, challenge, answer)
    }), Duration::from_secs(30), false)
}

/// The MCP call that reads the account's own computers row through its account routes.
pub fn read_computers() -> Value {
    json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
        "name": "run_resource_operation",
        "arguments": {"resource": "@sign-in", "operation": "sign-in:places", "request_key": "read-computers-1", "input": {}},
    }})
}

pub static STOP: AtomicBool = AtomicBool::new(false);

/// An account made at the computer `config`: its internal owner id and its address.
pub fn create(config: &Path) -> (String, String) {
    let created = run(
        trillion_local::account::create::command,
        &["create", config.to_str().unwrap()],
    );
    let words: Vec<&str> = created.split_whitespace().collect();
    let at = |name: &str| {
        words
            .iter()
            .position(|word| *word == name)
            .map(|at| words[at + 1].to_owned())
            .unwrap()
    };
    let (owner, address) = (at("owner"), at("address"));
    assert_eq!((owner.len(), address.len()), (64, 64), "{created}");
    assert_ne!(
        owner, address,
        "the owner id is the account's own; the address comes from its key"
    );
    (owner, address)
}

/// A person signed in to the account at `address`: the token Better Auth signs (support/signer.rs), which the account's
/// door checks by its signature.
pub fn sign_in_token(address: &str) -> String {
    signer::token(address)
}

/// Open the computer's session for the account at `address` to the forwarder's session socket.
pub fn connect(computer: &Arc<Computer>, address: &str, sessions: std::net::SocketAddr) {
    let computer = computer.clone();
    let address = address.to_owned();
    std::thread::spawn(move || {
        let stream = TcpStream::connect(sessions).unwrap();
        timeouts(&stream);
        computer.serve_forwarder_session(&address, stream, &STOP)
    });
}

/// One MCP call, repeated while the forwarder has no live computer yet.
pub fn call_when_up(
    executor: &Executor,
    http: &RouteTable,
    key: &str,
    body: &Value,
) -> (StatusCode, Value) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let (status, _, answer) = mcp_call(executor, http, key, body);
        if status != StatusCode::SERVICE_UNAVAILABLE || Instant::now() > deadline {
            return (status, answer);
        }
        clock().progress(deadline, Duration::from_millis(50));
    }
}

/// One request to the computer's own listener with extra headers: its status and body text.
pub fn listener_with(
    executor: &Executor,
    app: &RouteTable,
    method: Method,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&Value>,
) -> (StatusCode, String) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::HOST, "computer.test");
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let body = match body {
        Some(value) => {
            request = request.header(header::CONTENT_TYPE, "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    let request = request.body(body).unwrap();
    executor.block_on(async {
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        // A body that breaks on its way (the computer's session ended mid-answer) reads as an answer with no body.
        let bytes = to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap_or_default();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    })
}

/// One request to the computer's own listener: its status and body text. `origin` is the page's origin (the sign-up
/// routes refuse another), and `body` is sent as JSON.
pub fn listener(
    executor: &Executor,
    app: &RouteTable,
    method: Method,
    path: &str,
    origin: Option<&str>,
    body: Option<&Value>,
) -> (StatusCode, String) {
    match origin {
        Some(origin) => listener_with(
            executor,
            app,
            method,
            path,
            &[(header::ORIGIN.as_str(), origin)],
            body,
        ),
        None => listener_with(executor, app, method, path, &[], body),
    }
}

/// One tool call of the account's own door: `resource` and `operation` with `input`, under `request_key`.
pub fn tool(id: u64, resource: &str, operation: &str, request_key: &str, input: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {"name": "run_resource_operation",
        "arguments": {"resource": resource, "operation": operation, "request_key": request_key, "input": input}}})
}

/// The account's host kind for `computer`, set through the door's own `sign-in:set-host-kind`. A computer the account
/// names for the first time has no row, so its revision is 0. `kind` is what the scenario means: `my-device` answers
/// and votes, `rented-host` only syncs and votes (src/account/computers/settings.json `host_kinds`).
pub fn set_host_kind(id: u64, computer: &str, kind: &str) -> Value {
    tool(id, "@sign-in", "sign-in:set-host-kind", &format!("host-kind-{id}"), host_kind_input(computer, kind))
}

/// The input of `sign-in:set-host-kind` for a computer with no row yet (see `set_host_kind`).
pub fn host_kind_input(computer: &str, kind: &str) -> Value {
    json!({"computer": computer, "kind": kind, "expected_revision": 0})
}
