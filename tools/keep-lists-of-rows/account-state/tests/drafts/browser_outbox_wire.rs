// Exercise the canonical browser outbox over real HTTP against the existing
// selected-account workspace forwarder. The process-local cookie and Host are
// synthetic fixture inputs; no installed account or browser is involved.
use super::{browser_fixture, browser_http_observed_at, state};
use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{Method, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tokio::task::JoinHandle;

const NODE: &str = "/opt/homebrew/bin/node";
const ROUTE: &str = "/work/api/records";

#[derive(Clone)]
struct Probe {
    database: PathBuf,
    post_keys: Arc<Mutex<Vec<Option<String>>>>,
    first_commit: Arc<Mutex<Option<FirstCommit>>>,
    failed_once: Arc<AtomicBool>,
}

struct FirstCommit {
    handler_status: u16,
    written: Option<u64>,
    state: (String, i64, i64),
}

fn database_state(path: &Path) -> rusqlite::Result<(String, i64, i64)> {
    let db = rusqlite::Connection::open(path)?;
    let board = db.query_row(
        "SELECT value FROM workspace_records WHERE label='saved-board'",
        [],
        |row| row.get(0),
    )?;
    let log = db.query_row("SELECT COUNT(*) FROM record_log", [], |row| row.get(0))?;
    let commands = db.query_row(
        "SELECT COUNT(*) FROM resource_behavior_commands",
        [],
        |row| row.get(0),
    )?;
    Ok((board, log, commands))
}

async fn lose_first_reply(
    State(probe): State<Probe>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if request.method() != Method::POST || request.uri().path() != ROUTE {
        return next.run(request).await;
    }
    let request_key = request
        .headers()
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    probe.post_keys.lock().unwrap().push(request_key);

    let response = next.run(request).await;
    if !probe.failed_once.swap(true, Ordering::SeqCst) {
        // Consume the actual streaming handler body before reporting the lost
        // reply: this drives the original owner's commit and final receipt.
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let committed = database_state(&probe.database).unwrap();
        *probe.first_commit.lock().unwrap() = Some(FirstCommit {
            handler_status: status.as_u16(),
            written: body["written"].as_u64(),
            state: committed,
        });
        if status != StatusCode::OK || body["written"].as_u64() != Some(1) {
            return (status, "fixture handler did not accept the write").into_response();
        }
        return (StatusCode::SERVICE_UNAVAILABLE, "synthetic lost reply").into_response();
    }
    response
}

struct ServerGuard(JoinHandle<()>);

impl Drop for ServerGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

const CLIENT: &str = r#"
import { pathToFileURL } from 'node:url';

const source = process.env.OUTBOX_TEST_SOURCE;
const base = process.env.OUTBOX_TEST_BASE;
const fixtureOrigin = base;
const nativeFetch = globalThis.fetch;
const posts = [];
let firstReply;
let releaseFirstReply;
firstReply = new Promise(resolve => { releaseFirstReply = resolve; });

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, base);
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set('origin', fixtureOrigin);
  headers.set('cookie', `nm_session=${'b'.repeat(64)}`);
  const response = await nativeFetch(url, { ...init, headers });
  if ((init.method ?? 'GET').toUpperCase() === 'POST') {
    posts.push({ status: response.status, key: headers.get('idempotency-key') });
    if (posts.length === 1) releaseFirstReply(response.status);
  }
  return response;
};

const withDeadline = async (promise, milliseconds) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('client deadline')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

let stage = 'import';
let client;
let stop;
let summary;
let exitCode = 0;
try {
  client = await import(pathToFileURL(source).href);
  let resolveAccepted;
  let rejectAccepted;
  const accepted = new Promise((resolve, reject) => {
    resolveAccepted = resolve;
    rejectAccepted = reject;
  });
  stop = client.onQuietWriteAccepted((writes, result) => {
    if (writes.length !== 1 || result?.written !== 1) {
      rejectAccepted(new Error('unexpected acceptance receipt'));
      return;
    }
    resolveAccepted({ acceptedWrites: writes.length, written: result.written });
  });

  const generation = client.sendQuietly({
    key: 'wire-outbox-saved-board',
    path: '/work/api/records',
    body: {
      writes: [{ address_label: 'saved-board', payload: { items: ['written'] } }],
      conflict_policy: 'retry',
    },
  });
  if (!Number.isSafeInteger(generation)) throw new Error('outbox did not queue the write');
  client.sendQuietWritesNow();

  stage = 'first-response';
  const firstStatus = await withDeadline(firstReply, 8000);
  if (firstStatus !== 503) throw new Error('first fixture request was not the accepted lost reply');
  await new Promise(resolve => setTimeout(resolve, 25));
  client.sendQuietWritesNow();
  stage = 'retry-acceptance';
  const receipt = await withDeadline(accepted, 12000);
  stop();

  stage = 'saved-read';
  const read = await fetch('/work/api/records?label=saved-board', { method: 'GET' });
  const saved = await read.json();
  const savedMatches = read.status === 200
    && saved?.records?.['saved-board']?.items?.length === 1
    && saved.records['saved-board'].items[0] === 'written';
  if (firstStatus !== 503 || posts.length !== 2 || !savedMatches) {
    throw new Error('wire recovery did not match the expected result');
  }
  const keysMatch = typeof posts[0].key === 'string'
    && posts[0].key.length > 0
    && posts[0].key.length <= 512
    && posts[0].key === posts[1].key;
  summary = {
    firstStatus,
    acceptedWrites: receipt.acceptedWrites,
    written: receipt.written,
    getStatus: read.status,
    savedMatches,
    postCount: posts.length,
    keysMatch,
  };
  if (!keysMatch) exitCode = 1;
} catch (error) {
  // No cookie, request body, error message, source words or opaque key enters diagnostics.
  summary = { clientFailed: true, stage, kind: error?.name ?? 'Error', postCount: posts.length, statuses: posts.map(post => post.status) };
  exitCode = 1;
} finally {
  stop?.();
  client?.keepQuietWritesIn(null);
  client?.readOnlyPage();
}
// This is a bounded CLI consumer. Flush its public summary, then close its
// transport handles rather than leaving idle fetch/outbox handles alive.
await new Promise(resolve => process.stdout.write(JSON.stringify(summary) + '\n', resolve));
process.exit(exitCode);
"#;

fn run_node_client(base: &str, source: &Path) -> std::io::Result<Output> {
    let mut child = Command::new(NODE)
        .args([
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            CLIENT,
        ])
        .env("OUTBOX_TEST_BASE", base)
        .env("OUTBOX_TEST_SOURCE", source)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match child.try_wait()? {
            Some(_) => return child.wait_with_output(),
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                // Reap our child and retain only its already-sanitized stdout.
                return child.wait_with_output();
            }
            None => thread::sleep(Duration::from_millis(20)),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn canonical_quiet_outbox_retries_actual_selected_http_write_with_same_key() {
    let (fixture, selected, _) = browser_fixture();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = browser_http_observed_at(&fixture, selected, &base).0;
    let probe = Probe {
        database: fixture.root.join("records.sqlite"),
        post_keys: Arc::new(Mutex::new(Vec::new())),
        first_commit: Arc::new(Mutex::new(None)),
        failed_once: Arc::new(AtomicBool::new(false)),
    };
    let app = app.layer(middleware::from_fn_with_state(
        probe.clone(),
        lose_first_reply,
    ));
    let server = ServerGuard(tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    }));

    // Import the source owner's file itself; resolve its real package imports
    // from the Trillion checkout rather than copying or stubbing the outbox.
    let source = std::env::var_os("TRILLION_QUIET_WRITES_SOURCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("OLD_APP_ROOT").expect("OLD_APP_ROOT names the old app's checkout")).join("src/workspace/quiet-writes.ts")
        })
        .canonicalize()
        .expect("canonical Trillion quiet-write source");
    let child = tokio::task::spawn_blocking(move || run_node_client(&base, &source));
    let output = tokio::time::timeout(Duration::from_secs(18), child)
        .await
        .expect("Node client task deadline")
        .expect("Node client worker")
        .expect("bounded Node client process");
    let result: Value = serde_json::from_slice(&output.stdout)
        .expect("Node client emits only its synthetic result summary");
    let observed_posts = probe.post_keys.lock().unwrap().len();
    let first_status = probe
        .first_commit
        .lock()
        .unwrap()
        .as_ref()
        .map(|first| first.handler_status);
    assert!(output.status.success(), "Node client summary={result}, server_posts={observed_posts}, first_handler_status={first_status:?}");
    assert_eq!(result["clientFailed"], Value::Null);
    assert_eq!(result["firstStatus"], 503);
    assert_eq!(result["acceptedWrites"], 1);
    assert_eq!(result["written"], 1);
    assert_eq!(result["getStatus"], 200);
    assert_eq!(result["savedMatches"], true);
    assert_eq!(result["postCount"], 2);
    assert_eq!(result["keysMatch"], true);

    let keys = probe.post_keys.lock().unwrap().clone();
    assert_eq!(keys.len(), 2, "two actual POSTs reached the Rust handler");
    let [Some(first_key), Some(retry_key)] = keys.as_slice() else {
        panic!("both actual POSTs must carry an idempotency key");
    };
    assert!(!first_key.is_empty() && first_key.len() <= 512);
    assert!(first_key.bytes().all(|byte| byte.is_ascii_graphic()));
    assert_eq!(first_key, retry_key);

    let first = probe
        .first_commit
        .lock()
        .unwrap()
        .take()
        .expect("first response was dropped only after handler completion");
    assert_eq!(first.handler_status, StatusCode::OK.as_u16());
    assert_eq!(first.written, Some(1));
    let board: Value = serde_json::from_str(&first.state.0).unwrap();
    assert_eq!(board, json!({"items":["written"]}));
    assert!(
        first.state.1 > 0,
        "first request committed the original record log"
    );
    assert_eq!(
        first.state.2, 1,
        "first request created one original journal row"
    );
    assert_eq!(
        state(&fixture),
        first.state,
        "retry added no second effect or row"
    );

    drop(server);
}
