// tests/module_computer.rs
//
// Purpose: the proof that a computer whose host runs trillion-local as a WebAssembly module holds and answers for an
// account, and that moving the account there is one placement-row edit. Two computers hold one test account:
//   - "local": trillion-local's record store on a file in this process, serving its change feed over HTTP (the writer);
//   - "module": the module computer (src/native_entry/module_computer) under a local host program, its record store on the
//     object's own SQL storage (the copy keeper).
// It checks, in order: the row names local writer and module copy keeper; a write at the copy keeper is refused; writes on
// the local writer are acknowledged only once the copy keeper's own copy holds them; the copy keeper catches up; the old
// writer is killed in the middle of writing; the writer row is moved to the module computer (one row edit, revision 2); a
// stale row edit is refused; the module computer answers reads and writes from its own copy, with version conflicts and
// a retry that lands once; every acknowledged write is on the module copy exactly once; and after the host program
// is stopped and started again the module copy still holds all of it.
//
// It needs the host program, so it is ignored unless asked for: build the module first
// (`worker-build --release --out-dir ../../../target/module-computer` in src/native_entry/module_computer), then run
// `TRILLION_HOST_PROGRAM=<path to wrangler> cargo test --test module_computer -- --ignored --nocapture`.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{BufRead, BufReader, Read as _, Write as _},
    net::{TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use trillion_local::{
    records::{Mutation, Records},
    storage::{
        record_store::{settings::Limits, RecordStore, RealClock},
        sqlite::{self, Bounds, Connection, Spend, Supply},
    },
};

type Store = RecordStore<Supply<Connection>>;

const ACCOUNT: &str = "proofaccount";
const RESOURCE: &str = "own-records";
const PORT: u16 = 8787;

/// One HTTP/1.1 request; answers the status and the body. The body ends at its Content-Length or its last chunk: a
/// server may keep the connection open after it.
fn http(method: &str, url: &str, body: Option<&Value>) -> (u16, Value) {
    let rest = url.strip_prefix("http://").unwrap();
    let (host, path) = rest.split_at(rest.find('/').unwrap());
    let mut stream = TcpStream::connect(host).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    let body = body.map(|body| body.to_string()).unwrap_or_default();
    write!(stream, "{method} {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let status = line.split_whitespace().nth(1).unwrap().parse().unwrap();
    let (mut length, mut chunked) = (None, false);
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).unwrap();
        if header == "\r\n" || header.is_empty() {
            break;
        }
        let lower = header.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            length = value.trim().parse::<usize>().ok();
        }
        if lower.starts_with("transfer-encoding:") && lower.contains("chunked") {
            chunked = true;
        }
    }
    let mut bytes = Vec::new();
    if chunked {
        loop {
            let mut size = String::new();
            reader.read_line(&mut size).unwrap();
            let size = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
            if size == 0 {
                break;
            }
            let mut chunk = vec![0; size + 2];
            reader.read_exact(&mut chunk).unwrap();
            bytes.extend_from_slice(&chunk[..size]);
        }
    } else if let Some(length) = length {
        bytes.resize(length, 0);
        reader.read_exact(&mut bytes).unwrap();
    } else {
        reader.read_to_end(&mut bytes).unwrap();
    }
    let text = String::from_utf8(bytes).unwrap();
    (status, serde_json::from_str(&text).unwrap_or(Value::String(text)))
}

/// The local computer: its record store and its feed, served until it is killed.
struct Local {
    store: Arc<Mutex<Option<Store>>>,
    killed: Arc<AtomicBool>,
    reach: String,
}
impl Local {
    fn start(path: &std::path::Path) -> Self {
        let bounds = Bounds { value_bytes: 64 << 20, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::EachOperation, cancel: None, busy: Duration::from_secs(5) };
        let store = RecordStore::new(sqlite::open_owned(path, "record_store", bounds).unwrap(), Box::new(RealClock), Limits::fixed(2 << 20, 1 << 30)).unwrap();
        let store = Arc::new(Mutex::new(Some(store)));
        let killed = Arc::new(AtomicBool::new(false));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let reach = format!("http://{}", listener.local_addr().unwrap());
        let (served, dead) = (store.clone(), killed.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                if dead.load(Ordering::SeqCst) {
                    // A killed computer answers nothing: the connection is dropped.
                    continue;
                }
                let served = served.clone();
                // Each connection on its own thread: a connection opened ahead of its request holds nobody else up.
                std::thread::spawn(move || answer(stream, &served));
            }
        });
        Self { store, killed, reach }
    }
    fn write(&self, mutation: Mutation) -> trillion_local::records::Change {
        self.store.lock().unwrap().as_mut().unwrap().mutate(ACCOUNT, RESOURCE, mutation).unwrap()
    }
    /// The computer dies: it answers nothing more and its store is gone.
    fn kill(&self) {
        self.killed.store(true, Ordering::SeqCst);
        self.store.lock().unwrap().take();
    }
}

/// Answer one request on `stream` from the local computer's store: its feed and its history pages.
fn answer(mut stream: TcpStream, served: &Mutex<Option<Store>>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut line = String::new();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" {
            break;
        }
    }
    let target = line.split_whitespace().nth(1).unwrap_or("/").to_string();
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let query: BTreeMap<&str, &str> = query.split('&').filter_map(|pair| pair.split_once('=')).collect();
    let number = |name: &str| query.get(name).and_then(|value| value.parse::<i64>().ok()).unwrap_or(0);
    let guard = served.lock().unwrap();
    let body = match (guard.as_ref(), path.split('/').collect::<Vec<_>>().as_slice()) {
        (Some(store), ["", "a", account, "feed", resource]) => {
            let (changes, more) = store.carried_page(account, resource, number("after"), number("limit").clamp(1, 1000) as usize, 8).unwrap();
            Some(json!({ "term": 1, "base": 0, "changes": changes, "more": more }))
        }
        (Some(store), ["", "a", account, "history", resource]) => {
            let id = query.get("id").copied().unwrap_or_default();
            let (versions, more, kept) = store
                .history_page(account, resource, id, number("version"), number("since"), number("before"), number("limit").clamp(1, 1000) as usize)
                .unwrap();
            Some(json!({ "term": 1, "base": 0, "versions": versions, "more": more, "kept": kept }))
        }
        _ => None,
    };
    drop(guard);
    let (status, text) = match body {
        Some(body) => ("200 OK", body.to_string()),
        None => ("404 Not Found", "{}".to_string()),
    };
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
}

/// The host program serving the module computer, with its objects' storage kept in `state`.
fn start_host_program(state: &std::path::Path) -> Child {
    let program = std::env::var("TRILLION_HOST_PROGRAM").expect("TRILLION_HOST_PROGRAM names the host program's command");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    assert!(root.join("target/module-computer/index.js").exists(), "build the module first (see this file's header)");
    let child = Command::new(program)
        .current_dir(root.join("tests/module_computer"))
        .args(["dev", "--port", &PORT.to_string(), "--ip", "127.0.0.1", "--persist-to"])
        .arg(state)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let started = Instant::now();
    while TcpStream::connect(("127.0.0.1", PORT)).is_err() || http("GET", &module("report"), None).0 != 200 {
        assert!(started.elapsed() < Duration::from_secs(90), "the host program did not start");
        std::thread::sleep(Duration::from_millis(300));
    }
    child
}
/// The host program, stopped when the test ends however it ends, so a failed run leaves no host program holding the port.
struct HostProgram(Option<Child>);
impl Drop for HostProgram {
    fn drop(&mut self) {
        if let Some(child) = self.0.take() {
            stop_host_program(child);
        }
    }
}

fn stop_host_program(mut child: Child) {
    let _ = Command::new("kill").arg("-TERM").arg(child.id().to_string()).status();
    let _ = child.wait();
    // The host program's own workers outlive its command; the port is free once they are gone.
    let _ = Command::new("pkill").args(["-f", "workerd serve"]).status();
    let started = Instant::now();
    while TcpStream::connect(("127.0.0.1", PORT)).is_ok() && started.elapsed() < Duration::from_secs(20) {
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn module(rest: &str) -> String {
    format!("http://127.0.0.1:{PORT}/a/{ACCOUNT}/{rest}")
}
fn note(id: &str, expected_version: i64, request: &str) -> Mutation {
    Mutation {
        id: id.into(),
        expected_version,
        request_key: request.into(),
        deleted: false,
        // 2^53 + 1: a value no host number holds, so a rounded integer anywhere on the way shows.
        value: json!({ "kind": "note", "text": format!("{id} v{}", expected_version + 1), "wide": 9_007_199_254_740_993_i64 }),
    }
}
/// Retries of a follow the host program answered 503 (it restarted its worker mid-request and asks for the request
/// again). A follow is safe to send again: each page applies whole or not at all.
static FOLLOW_RETRIES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
fn follow() -> i64 {
    for _ in 0..3 {
        let (status, body) = http("POST", &module(&format!("follow/{RESOURCE}")), None);
        if status == 503 {
            FOLLOW_RETRIES.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(500));
            continue;
        }
        assert_eq!(status, 200, "follow: {body}");
        return body["stamp"].as_i64().unwrap();
    }
    panic!("a follow was refused three times");
}

#[test]
#[ignore = "needs the host program: TRILLION_HOST_PROGRAM and a module build (see the header)"]
fn an_account_moves_to_the_module_computer_with_one_row_edit_and_keeps_every_acknowledged_write() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("host-state");
    let local = Local::start(&dir.path().join("local.sqlite"));
    let mut host = HostProgram(Some(start_host_program(&state)));
    let computers = json!({ "local": local.reach, "module": format!("http://127.0.0.1:{PORT}") });

    // 1. The row: local writes, the module computer follows.
    let (status, body) = http("PUT", &module("placement"), Some(&json!({ "expected_revision": 0, "row": { "revision": 1, "writer": "local", "copy_keepers": ["module"], "computers": computers } })));
    assert_eq!(status, 200, "{body}");
    assert_eq!((body["holds"].clone(), body["writer"].clone()), (json!(true), json!(false)));
    let (report_status, report) = http("GET", &module("report"), None);
    assert_eq!(report_status, 200);
    assert_eq!(report["takes_new_accounts"], json!(false));
    eprintln!("module computer reports {report}");

    // 2. A write at the copy keeper is refused: the row names another writer.
    let (status, body) = http("POST", &module(&format!("records/{RESOURCE}")), Some(&serde_json::to_value(note("refused", 0, "r0")).unwrap()));
    assert_eq!((status, body["refused"].clone()), (409, json!("not_writer")));

    // 3. Writes on the local writer, each acknowledged only once the module copy holds it (its stamp reaches it).
    let mut acknowledged: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    let mut unacknowledged = Vec::new();
    let started = Instant::now();
    let (mut follows, mut written) = (0, 0);
    for batch in 0..20 {
        let mut pending = Vec::new();
        for n in 0..10 {
            let id = format!("r{:03}", batch * 10 + n);
            let change = local.write(note(&id, 0, &format!("{id}-0")));
            written += 1;
            pending.push(change);
        }
        // Every fourth record gets a second version, so versions in between travel too.
        if batch % 4 == 0 {
            for n in 0..3 {
                let id = format!("r{:03}", batch * 10 + n);
                pending.push(local.write(note(&id, 1, &format!("{id}-1"))));
                written += 1;
            }
        }
        let stamp = follow();
        follows += 1;
        for change in pending {
            assert!(change.sequence <= stamp, "the copy's stamp {stamp} is behind {}", change.sequence);
            acknowledged.insert(change.id.clone(), (change.version, change.sequence));
        }
    }
    let caught_up = started.elapsed();
    eprintln!("{written} writes on the local writer, {} records acknowledged through {follows} follows in {caught_up:?} ({} follows sent again after a 503)",
        acknowledged.len(), FOLLOW_RETRIES.load(Ordering::SeqCst));

    // 4. The old writer is killed in the middle of writing: its last writes are committed on it, never pulled, never
    //    acknowledged.
    for n in 0..5 {
        let change = local.write(note(&format!("cut{n}"), 0, &format!("cut{n}")));
        unacknowledged.push(change.id);
    }
    local.kill();
    let (status, _) = http("POST", &module(&format!("follow/{RESOURCE}")), None);
    assert_ne!(status, 200, "a follow from a dead writer answers no stamp");

    // 5. Move the writer row: one edit, revision 2. A stale edit (naming revision 1 again) is refused.
    let moved = json!({ "expected_revision": 1, "row": { "revision": 2, "writer": "module", "copy_keepers": ["local"], "computers": computers } });
    let (status, body) = http("PUT", &module("placement"), Some(&moved));
    assert_eq!((status, body["writer"].clone()), (200, json!(true)), "{body}");
    let (status, body) = http("PUT", &module("placement"), Some(&moved));
    assert_eq!((status, body["refused"].clone()), (409, json!("stale_row")));

    // 6. Every acknowledged write is on the module copy exactly once, at its version, read from its own copy.
    let check_copy = |label: &str, acknowledged: &BTreeMap<String, (i64, i64)>| {
        // Every list page, from the module computer's own copy.
        let (mut ids, mut after, mut pages) = (Vec::<String>::new(), String::new(), 0);
        loop {
            let (status, page) = http("GET", &module(&format!("records/{RESOURCE}?after={after}")), None);
            assert_eq!(status, 200, "{page}");
            pages += 1;
            ids.extend(page["items"].as_array().unwrap().iter().map(|item| item["id"].as_str().unwrap().to_owned()));
            match page["next"].as_str() {
                Some(next) => after = next.to_owned(),
                None => break,
            }
        }
        let unique: BTreeSet<&str> = ids.iter().map(String::as_str).collect();
        assert_eq!(unique.len(), ids.len(), "{label}: a record appears twice");
        let mut reads = 0;
        for (id, (version, _)) in acknowledged {
            let (status, read) = http("GET", &module(&format!("records/{RESOURCE}/{id}")), None);
            assert_eq!(status, 200);
            assert_eq!(read["record"]["version"].as_i64(), Some(*version), "{label}: {id}");
            assert_eq!(read["record"]["value"]["wide"], json!(9_007_199_254_740_993_i64), "{label}: {id} came back rounded");
            assert_eq!(read["computer"], json!("module"));
            reads += 1;
        }
        for id in &unacknowledged {
            assert!(!unique.contains(id.as_str()), "{label}: {id} was never acknowledged");
        }
        eprintln!("{label}: {} acknowledged records on the module copy, each once ({} listed in {pages} pages, {} duplicates), {reads} reads answered, {} unacknowledged writes absent",
            acknowledged.len(), ids.len(), ids.len() - unique.len(), unacknowledged.len());
        assert_eq!(ids.len(), acknowledged.len());
    };
    check_copy("after the move", &acknowledged);

    // 7. The module computer writes now: a new record, a new version, a stale version is a conflict, a retry lands once.
    let mut module_writes = 0;
    let (status, change) = http("POST", &module(&format!("records/{RESOURCE}")), Some(&serde_json::to_value(note("after-move", 0, "am-0")).unwrap()));
    assert_eq!((status, change["version"].as_i64()), (200, Some(1)), "{change}");
    module_writes += 1;
    let (version, _) = acknowledged["r000"];
    let (status, change) = http("POST", &module(&format!("records/{RESOURCE}")), Some(&serde_json::to_value(note("r000", version, "r000-moved")).unwrap()));
    assert_eq!((status, change["version"].as_i64()), (200, Some(version + 1)), "{change}");
    module_writes += 1;
    let (status, retry) = http("POST", &module(&format!("records/{RESOURCE}")), Some(&serde_json::to_value(note("r000", version, "r000-moved")).unwrap()));
    assert_eq!((status, retry["sequence"].clone()), (200, change["sequence"].clone()), "a retry lands once");
    let (status, stale) = http("POST", &module(&format!("records/{RESOURCE}")), Some(&serde_json::to_value(note("r000", version, "r000-stale")).unwrap()));
    assert_eq!((status, stale["refused"].clone()), (409, json!("record_conflict")));
    acknowledged.insert("after-move".into(), (1, 0));
    acknowledged.insert("r000".into(), (version + 1, 0));
    eprintln!("the module computer answered {module_writes} writes as writer, one retry landed once, one stale version was a conflict");

    // 8. The module computer's host stops and starts again: its copy is durable.
    stop_host_program(host.0.take().unwrap());
    host.0 = Some(start_host_program(&state));
    check_copy("after the host restarted", &acknowledged);
    let (status, row) = http("GET", &module("placement"), None);
    assert_eq!((status, row["revision"].clone(), row["writer"].clone()), (200, json!(2), json!("module")));
    drop(host);
}
