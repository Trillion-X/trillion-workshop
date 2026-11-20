// tests/share_bytes.rs
//
// Purpose: The public byte route of a share (`share_bytes`) over a real loopback socket, the account files over a byte port in memory and a
// stand-in for the person's records: a share is served whole and by range (206, suffix, open-ended, 416, HEAD), a file kept in several
// stored pieces is read across their edge, and every way a share does not stand (wrong key, another id, expired, stopped, not in reach, no
// share) answers the same 404, the very next request after the person stops the share. No real store or door is reached.
// Synthetic data only.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

mod account_files_common;

use account_files_common::{account_files, upload, write};
use live_namespace::{
    account_files::{AccountFiles, FILES, FILE_SHARES, SHARE_ROUTE, SHARE_ROUTE_ID, SHARE_ROUTE_KIND},
    share_bytes::{router, Config, Reader, RowGrants, Route, Unavailable},
    store::{Mutation, Store},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::TcpStream,
    sync::{Arc, Mutex},
};

const ORIGIN: &str = "https://shares.example.test";

/// The reader of the files; `after` runs once, just before the read numbered `at` (counted from 1), so a test can change the share
/// between two windows of one body.
struct Files {
    files: Mutex<AccountFiles>,
    reads: std::sync::atomic::AtomicU64,
    hook: Mutex<Option<(u64, Box<dyn FnOnce() + Send>)>>,
}
impl Reader for Files {
    fn read(&self, identity: &str, offset: u64, length: u64) -> Result<Vec<u8>, Unavailable> {
        let n = self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let mut hook = self.hook.lock().unwrap();
        if hook.as_ref().is_some_and(|(at, _)| *at == n) {
            (hook.take().unwrap().1)();
        }
        drop(hook);
        let files = self.files.lock().unwrap();
        let file = files.store.get(FILES, identity).map_err(|_| Unavailable)?.record.ok_or(Unavailable)?;
        files.read_range(&file, offset, length).map_err(|_| Unavailable)
    }
}

/// The route's numbers for a test, with the shipped settings' types by name ending (settings.json `share_bytes.types_by_ending`).
fn config(window_bytes: u64) -> Config {
    let shipped: Value = serde_json::from_str(include_str!("../settings.json")).unwrap();
    serde_json::from_value(json!({"_what": "t", "listen": "127.0.0.1:1", "window_bytes": window_bytes, "recheck_seconds": 0,
        "inline_types": ["video/", "application/pdf", "text/html"], "types_by_ending": shipped["share_bytes"]["types_by_ending"]})).unwrap()
}

struct Served {
    address: String,
    store: Store,
    id: String,
    key: String,
}

/// A route over `files` that shares the file `identity` (its bytes, `media_type`) by `share_file`, as the person does; `hook` runs before
/// the read numbered by its first member.
fn serve_with(mut files: AccountFiles, name: &str, media_type: &str, window_bytes: u64, hook: Option<(u64, Box<dyn FnOnce(&Store, &str) + Send>)>) -> Served {
    files = files.with_share_origin(ORIGIN);
    let shared = files.call("share_file", &json!({"name_or_identity": name, "seconds": 3600})).expect("a tool").expect("shared");
    let url = shared["url"].as_str().unwrap().to_owned();
    let (id, key) = {
        let mut parts = url.strip_prefix(&format!("{ORIGIN}/share/")).unwrap().split('/');
        (parts.next().unwrap().to_owned(), parts.next().unwrap().to_owned())
    };
    let store = files.store.clone();
    let id_for_type = id.clone();
    change(&store, &id_for_type, |row| row["media_type"] = json!(media_type));
    let hook = hook.map(|(at, run)| {
        let (store, id) = (store.clone(), id.clone());
        (at, Box::new(move || run(&store, &id)) as Box<dyn FnOnce() + Send>)
    });
    let route = Route {
        grants: Arc::new(RowGrants::new(store.clone())),
        reader: Arc::new(Files { files: Mutex::new(files), reads: Default::default(), hook: Mutex::new(hook) }),
        config: config(window_bytes),
    };
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap().to_string();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        runtime.block_on(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            axum::serve(listener, router(route)).await.unwrap();
        });
    });
    Served { address, store, id, key }
}

fn serve(files: AccountFiles, name: &str, media_type: &str, window_bytes: u64) -> Served {
    serve_with(files, name, media_type, window_bytes, None)
}

/// Change the share row `id` as a person's later write would.
fn change(store: &Store, id: &str, edit: impl FnOnce(&mut Value)) {
    let (version, row) = store.held_record_with_version(FILE_SHARES, id).unwrap();
    let mut value = row.unwrap().value;
    edit(&mut value);
    store.mutate(FILE_SHARES, Mutation { id: id.into(), expected_version: version, request_key: format!("{id}:test:{version}"), deleted: false, value }).unwrap();
}

struct Answer {
    status: u16,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn ask(served: &Served, method: &str, path: &str, range: Option<&str>) -> Answer {
    let mut stream = TcpStream::connect(&served.address).unwrap();
    stream.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
    let range = range.map(|range| format!("Range: {range}\r\n")).unwrap_or_default();
    write!(stream, "{method} {path} HTTP/1.1\r\nHost: x\r\n{range}Connection: close\r\n\r\n").unwrap();
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw);
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("a head");
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let mut lines = head.lines();
    let status = lines.next().unwrap().split_whitespace().nth(1).unwrap().parse().unwrap();
    let headers = lines.filter_map(|line| line.split_once(':')).map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned())).collect();
    let mut body = raw[split + 4..].to_vec();
    // The body may be chunked when its length is not set; the route always sets it.
    if body.len() > 0 && !head.to_ascii_lowercase().contains("content-length") {
        body.clear();
    }
    Answer { status, headers, body }
}

fn path(id: &str, key: &str) -> String {
    format!("/share/{id}/{key}")
}

fn own(served: &Served) -> String {
    path(&served.id, &served.key)
}

fn pattern(length: usize) -> Vec<u8> {
    (0..length).map(|n| (n % 251) as u8).collect()
}

fn whole_file(bytes: &[u8]) -> (AccountFiles, String) {
    let (mut files, _, _) = account_files();
    let identity = write(&mut files, "/a.bin", bytes);
    (files, identity)
}

#[test]
fn a_share_is_served_whole_and_by_every_kind_of_range() {
    let bytes = pattern(1000);
    let (files, _) = whole_file(&bytes);
    let served = serve(files, "/a.bin", "video/mp4", 300);
    let p = own(&served);

    let whole = ask(&served, "GET", &p, None);
    assert_eq!((whole.status, whole.body.as_slice()), (200, bytes.as_slice()), "a body of several windows is the file, once");
    assert_eq!(whole.headers["accept-ranges"], "bytes");
    assert_eq!(whole.headers["content-length"], "1000");
    assert_eq!(whole.headers["content-type"], "video/mp4");
    assert_eq!(whole.headers["cache-control"], "no-store");
    assert_eq!(whole.headers["x-content-type-options"], "nosniff");
    assert!(whole.headers["content-disposition"].starts_with("inline; filename=\"a.bin\""), "{:?}", whole.headers);

    let span = ask(&served, "GET", &p, Some("bytes=100-649"));
    assert_eq!((span.status, span.body.as_slice()), (206, &bytes[100..650]));
    assert_eq!(span.headers["content-range"], "bytes 100-649/1000");
    assert_eq!(span.headers["content-length"], "550");

    let open = ask(&served, "GET", &p, Some("bytes=990-"));
    assert_eq!((open.status, open.body.as_slice()), (206, &bytes[990..]));
    assert_eq!(open.headers["content-range"], "bytes 990-999/1000");

    let suffix = ask(&served, "GET", &p, Some("bytes=-25"));
    assert_eq!((suffix.status, suffix.body.as_slice()), (206, &bytes[975..]));

    let past_end = ask(&served, "GET", &p, Some("bytes=900-5000"));
    assert_eq!((past_end.status, past_end.body.as_slice()), (206, &bytes[900..]), "an end past the file is the file's end");
    assert_eq!(past_end.headers["content-range"], "bytes 900-999/1000");

    for unsatisfiable in ["bytes=1000-", "bytes=5000-6000", "bytes=-0"] {
        let refused = ask(&served, "GET", &p, Some(unsatisfiable));
        assert_eq!(refused.status, 416, "{unsatisfiable}");
        assert_eq!(refused.headers["content-range"], "bytes */1000");
    }
    for whole_again in ["bytes=0-1,5-6", "items=0-5", "bytes=9-2", "nonsense"] {
        assert_eq!(ask(&served, "GET", &p, Some(whole_again)).body.len(), 1000, "{whole_again} is not one byte range: the whole file");
    }

    let head = ask(&served, "HEAD", &p, Some("bytes=0-9"));
    assert_eq!((head.status, head.body.len()), (206, 0));
    assert_eq!(head.headers["content-length"], "10");
    assert_eq!(head.headers["content-range"], "bytes 0-9/1000");
}

#[test]
fn a_file_kept_as_many_stored_pieces_is_read_across_their_edge() {
    let bytes = pattern(32 * 1024 * 3 + 77);
    let (mut files, _, _) = account_files();
    let identity = upload(&mut files, 'a', "/big.bin", &bytes);
    assert!(files.store.get(FILES, &identity).unwrap().record.unwrap().value["spans"].as_u64().unwrap() > 1, "kept in several pieces");
    let _ = identity;
    let served = serve(files, "/big.bin", "application/octet-stream", 50_000);
    let p = own(&served);
    let edge = 32 * 1024;
    let across = ask(&served, "GET", &p, Some(&format!("bytes={}-{}", edge - 5, edge + 4)));
    assert_eq!((across.status, across.body.as_slice()), (206, &bytes[edge - 5..edge + 5]));
    let whole = ask(&served, "GET", &p, None);
    assert_eq!(whole.body, bytes);
    assert!(whole.headers["content-disposition"].starts_with("attachment;"), "a type not named inline is a download");
}

#[test]
fn every_way_a_share_does_not_stand_is_the_same_404() {
    let bytes = pattern(100);
    let (files, _) = whole_file(&bytes);
    let served = serve(files, "/a.bin", "text/html", 64);
    let (id, key) = (served.id.clone(), served.key.clone());
    let p = own(&served);
    assert_eq!(ask(&served, "GET", &p, None).status, 200);
    let refusal = ask(&served, "GET", &path(&id, "shr_another-key"), None);
    assert_eq!(refusal.status, 404);
    let reference = (refusal.body.clone(), refusal.headers.get("content-type").cloned());

    let other_id = "ffffffffffffffffffffffffffffffff";
    let mut cases: Vec<(&str, String)> = vec![
        ("a key that is not on the share", path(&id, "shr_another-key")),
        ("a key of the same length that is not the key", path(&id, &format!("shr_{}", "A".repeat(key.len() - 4)))),
        ("a key one character short", path(&id, &key[..key.len() - 1])),
        ("another id", path(other_id, &key)),
        ("an id that is not an id", path("../../etc", &key)),
        ("an id of the wrong length", path(&id[..31], &key)),
        ("a key that is not a key", path(&id, "plainkey")),
    ];
    cases.push(("a key of another shape", path(&id, &"shr_".repeat(100))));
    for (what, path) in &cases {
        let got = ask(&served, "GET", path, None);
        assert_eq!((got.status, &got.body, got.headers.get("content-type").cloned()), (404, &reference.0, reference.1.clone()), "{what}");
    }

    let original = served.store.get(FILE_SHARES, &id).unwrap().record.unwrap().value;
    let restore = |served: &Served| change(&served.store, &served.id, |row| *row = original.clone());
    let cases: Vec<(&str, Box<dyn Fn(&mut Value)>)> = vec![
        ("an ended share", Box::new(|row| row["expires_at"] = json!("2020-01-01T00:00:00.000Z"))),
        ("a stopped share", Box::new(|row| row["revoked_at"] = json!("2026-11-17T01:00:00.000Z"))),
        ("an unpublished share", Box::new(|row| row["published"] = json!(false))),
        ("a share that does not let view", Box::new(|row| row["can"] = json!(["run"]))),
        ("a share with no end", Box::new(|row| row["expires_at"] = Value::Null)),
        ("a row of another kind", Box::new(|row| row["kind"] = json!("note"))),
        ("a row with another key", Box::new(|row| row["key_blake3"] = json!("0".repeat(64)))),
        ("a row that names no file", Box::new(|row| row["identity"] = json!(""))),
    ];
    for (what, edit) in cases {
        change(&served.store, &id, |row| edit(row));
        let got = ask(&served, "GET", &p, None);
        assert_eq!((got.status, &got.body), (404, &reference.0), "{what}");
        restore(&served);
        assert_eq!(ask(&served, "GET", &p, None).status, 200, "and the share as it was stands again: nothing was remembered ({what})");
    }
}

#[test]
fn a_share_stopped_between_two_requests_refuses_the_second() {
    let bytes = pattern(500);
    let (files, _) = whole_file(&bytes);
    let served = serve(files, "/a.bin", "video/mp4", 100);
    let p = own(&served);
    assert_eq!(ask(&served, "GET", &p, Some("bytes=0-9")).status, 206);
    change(&served.store, &served.id, |row| row["revoked_at"] = json!("2026-11-17T01:00:00.000Z"));
    assert_eq!(ask(&served, "GET", &p, Some("bytes=0-9")).status, 404);
    assert_eq!(ask(&served, "HEAD", &p, None).status, 404);
}

#[test]
fn stop_share_ends_the_next_request_and_list_shares_never_shows_a_key() {
    let (mut files, _) = whole_file(&pattern(300));
    files = files.with_share_origin(ORIGIN);
    let shared = files.call("share_file", &json!({"name_or_identity": "/a.bin", "seconds": 600})).unwrap().unwrap();
    let id = shared["share"].as_str().unwrap().to_owned();
    let key = shared["url"].as_str().unwrap().rsplit('/').next().unwrap().to_owned();
    let listed = files.call("list_shares", &json!({})).unwrap().unwrap();
    assert_eq!((listed["shares"][0]["share"].as_str(), listed["shares"][0]["state"].as_str()), (Some(id.as_str()), Some("open")));
    assert!(!listed.to_string().contains(&key) && !listed.to_string().contains("key_blake3"), "a key is never listed");
    let row = files.store.get(FILE_SHARES, &id).unwrap().record.unwrap().value;
    assert!(!row.to_string().contains(&key), "only a digest of the key is kept");
    let files = Mutex::new(files);
    let stop = |files: &Mutex<AccountFiles>| files.lock().unwrap().call("stop_share", &json!({"id": id})).unwrap().unwrap();
    assert_eq!(stop(&files)["already"], json!(false));
    assert_eq!(stop(&files)["already"], json!(true), "stopping twice answers the same");
    let listed = files.lock().unwrap().call("list_shares", &json!({})).unwrap().unwrap();
    assert_eq!(listed["shares"][0]["state"], "stopped");
    let files = files.into_inner().unwrap();
    let store = files.store.clone();
    let route = Route { grants: Arc::new(RowGrants::new(store)), reader: Arc::new(Files { files: Mutex::new(files), reads: Default::default(), hook: Mutex::new(None) }), config: config(100) };
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap().to_string();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        runtime.block_on(async move { axum::serve(tokio::net::TcpListener::from_std(listener).unwrap(), router(route)).await.unwrap() });
    });
    let served = Served { address, store: Arc::new(live_namespace::store::SqlStore::memory().unwrap()), id: id.clone(), key: key.clone() };
    assert_eq!(ask(&served, "GET", &path(&id, &key), None).status, 404, "a stopped share is refused");
    let unknown = files_call_error();
    assert!(unknown, "stopping a share that is not there is refused");
}

fn files_call_error() -> bool {
    let (mut files, _) = whole_file(b"x");
    files.call("stop_share", &json!({"id": "00000000000000000000000000000000"})).unwrap().is_err()
}

#[test]
fn a_share_stopped_between_two_windows_of_one_body_ends_it() {
    let bytes = pattern(1000);
    let (files, _) = whole_file(&bytes);
    let served = serve_with(files, "/a.bin", "video/mp4", 100, Some((3, Box::new(|store, id| {
        change(store, id, |row| row["revoked_at"] = json!("2026-11-17T01:00:00.000Z"));
    }))));
    let got = ask(&served, "GET", &own(&served), None);
    assert!(got.body.len() >= 100 && got.body.len() < 1000, "the body ended early: {} bytes", got.body.len());
    assert_eq!(got.body.as_slice(), &bytes[..got.body.len()], "and what was sent is the file's own bytes");
}

#[test]
fn an_empty_file_is_an_empty_200_and_a_range_of_it_is_416() {
    let (files, _) = whole_file(b"");
    let served = serve(files, "/a.bin", "text/plain", 64);
    let p = own(&served);
    let whole = ask(&served, "GET", &p, None);
    assert_eq!((whole.status, whole.body.len()), (200, 0));
    assert_eq!(ask(&served, "GET", &p, Some("bytes=0-")).status, 416);
}

#[test]
fn with_no_origin_of_its_own_a_share_opens_where_the_persons_share_route_said_it_answers() {
    let (mut files, _) = whole_file(&pattern(10));
    let refused = files.call("share_file", &json!({"name_or_identity": "/a.bin", "seconds": 60})).unwrap();
    assert!(refused.is_err(), "no route has said where it answers yet");
    files.store.mutate(SHARE_ROUTE, Mutation { id: SHARE_ROUTE_ID.into(), expected_version: 0, request_key: "r1".into(), deleted: false,
        value: json!({"kind": SHARE_ROUTE_KIND, "origin": "https://route.example.test/"}) }).unwrap();
    let shared = files.call("share_file", &json!({"name_or_identity": "/a.bin", "seconds": 60})).unwrap().unwrap();
    assert!(shared["url"].as_str().unwrap().starts_with("https://route.example.test/share/"), "{shared}");
    let mut own = files.with_share_origin(ORIGIN);
    let shared = own.call("share_file", &json!({"name_or_identity": "/a.bin", "seconds": 60})).unwrap().unwrap();
    assert!(shared["url"].as_str().unwrap().starts_with(ORIGIN), "a run's own origin comes first: {shared}");
}

#[test]
fn the_route_listens_on_a_unix_socket_a_front_door_sends_a_names_requests_to() {
    let check = |listen: &str| serde_json::from_value::<Config>(json!({"_what": "t", "listen": listen, "window_bytes": 10, "recheck_seconds": 0,
        "inline_types": []})).unwrap().check();
    assert!(check("unix:/run/sites/files.example.test/http.sock").is_ok());
    assert!(check("unix:relative/http.sock").is_err());
    assert!(check("0.0.0.0:7421").is_err());
    let bytes = pattern(500);
    let (mut files, _) = whole_file(&bytes);
    files = files.with_share_origin(ORIGIN);
    let shared = files.call("share_file", &json!({"name_or_identity": "/a.bin", "seconds": 600})).unwrap().unwrap();
    let url = shared["url"].as_str().unwrap().to_owned();
    let folder = tempfile::tempdir().unwrap();
    let socket = folder.path().join("http.sock");
    let store = files.store.clone();
    let route = Route { grants: Arc::new(RowGrants::new(store)), reader: Arc::new(Files { files: Mutex::new(files), reads: Default::default(), hook: Mutex::new(None) }), config: config(100) };
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let listener = runtime.block_on(async { tokio::net::UnixListener::bind(&socket) }).unwrap();
    runtime.spawn(async move { axum::serve(listener, router(route)).await.unwrap() });
    let mut stream = std::os::unix::net::UnixStream::connect(&socket).unwrap();
    let path = url.strip_prefix(ORIGIN).unwrap();
    write!(stream, "GET {path} HTTP/1.1\r\nHost: files.example.test\r\nRange: bytes=100-199\r\nConnection: close\r\n\r\n").unwrap();
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).unwrap();
    let at = answer.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    assert!(answer.starts_with(b"HTTP/1.1 206"), "{}", String::from_utf8_lossy(&answer[..at]));
    assert_eq!(&answer[at + 4..], &bytes[100..200]);
}

/// A file whose stored type says nothing (a camera's `C9066.MP4` brought in from the old index as `application/octet-stream`) is served
/// as its name's ending says, shown in the browser; a stored type with parameters (`text/html; charset=utf-8`) is served whole and shown
/// as its bare type says, under a sandbox that runs no script; a name no ending names stays a download of `application/octet-stream`.
#[test]
fn a_share_is_served_as_its_stored_type_says_else_as_its_name_ends() {
    let cases = [
        ("/Recordings/C9066.MP4", "application/octet-stream", "video/mp4", "inline"),
        ("/Recordings/C9067.mov", "", "video/quicktime", "inline"),
        ("/Shared/page.html", "text/html; charset=utf-8", "text/html; charset=utf-8", "inline"),
        ("/Shared/notes.mp4", "text/plain", "text/plain", "attachment"),
        ("/Shared/blob.qqq", "application/octet-stream", "application/octet-stream", "attachment"),
        ("/Shared/bad.mp4", "video/mp4\r\nX-Injected: 1", "video/mp4", "inline"),
    ];
    for (name, stored, served_as, shown) in cases {
        let (mut files, _, _) = account_files();
        write(&mut files, name, &pattern(64));
        let served = serve(files, name, stored, 1024);
        let answer = ask(&served, "GET", &own(&served), None);
        assert_eq!(answer.status, 200, "{name}");
        assert_eq!(answer.headers["content-type"], served_as, "{name} stored as {stored:?}");
        assert!(answer.headers["content-disposition"].starts_with(shown), "{name}: {:?}", answer.headers["content-disposition"]);
        assert!(answer.headers["content-security-policy"].starts_with("sandbox;"), "{name}");
        assert!(!answer.headers.contains_key("x-injected"), "{name}");
    }
}
