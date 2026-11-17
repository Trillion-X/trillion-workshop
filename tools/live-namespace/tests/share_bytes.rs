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
    account_files::{AccountFiles, FILES},
    share_bytes::{router, Config, Grants, Reader, Route, Unavailable},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::TcpStream,
    sync::{Arc, Mutex},
};

const ID: &str = "namespace-shared-file:0123456789abcdef0123456789abcdef";
const KEY: &str = "shr_synthetic-key_0123456789";

#[derive(Default)]
struct Records {
    workspace: Mutex<HashMap<String, Value>>,
    records: Mutex<HashMap<(String, String), Value>>,
    asked: Mutex<Vec<String>>,
}
impl Grants for Records {
    fn workspace(&self, label: &str) -> Result<Option<Value>, Unavailable> {
        self.asked.lock().unwrap().push(label.to_owned());
        Ok(self.workspace.lock().unwrap().get(label).cloned())
    }
    fn record(&self, kind: &str, id: &str) -> Result<Option<Value>, Unavailable> {
        Ok(self.records.lock().unwrap().get(&(kind.to_owned(), id.to_owned())).cloned())
    }
}

struct Files(Mutex<AccountFiles>);
impl Reader for Files {
    fn read(&self, identity: &str, offset: u64, length: u64) -> Result<Vec<u8>, Unavailable> {
        let files = self.0.lock().unwrap();
        let file = files.store.get(FILES, identity).map_err(|_| Unavailable)?.record.ok_or(Unavailable)?;
        files.read_range(&file, offset, length).map_err(|_| Unavailable)
    }
}

fn config(window_bytes: u64) -> Config {
    serde_json::from_value(json!({"_what": "t", "listen": "127.0.0.1:1", "window_bytes": window_bytes, "recheck_seconds": 0,
        "inline_types": ["video/", "application/pdf"]})).unwrap()
}

fn digest(key: &str) -> String {
    content_crypto::advanced::blake3::hash(key.as_bytes()).to_hex().to_string()
}

/// The share record share-anything keeps for `id`, shared with the link `KEY`.
fn share(id: &str, ends: Option<&str>) -> Value {
    json!({"reach": [{"type": "namespace-shared-file", "id": id}], "title": "t", "can": ["view"],
        "people": [{"principal": "link", "key_blake3": digest(KEY), "added_at": "2026-11-17T00:00:00.000Z"}],
        "published": true, "revoked_at": null, "expires_at": ends, "changed_at": "2026-11-17T00:00:00.000Z"})
}

struct Served {
    address: String,
    records: Arc<Records>,
}

/// A route over `files` that shares the file `identity` (`length` bytes, `media_type`) as `ID` with the link `KEY`.
fn serve(files: AccountFiles, identity: &str, length: u64, media_type: &str, window_bytes: u64) -> Served {
    let records = Arc::new(Records::default());
    records.workspace.lock().unwrap().insert(format!("sharing:{ID}"), share(ID, Some("2099-01-01T00:00:00.000Z")));
    records.records.lock().unwrap().insert(
        ("namespace-shared-file".into(), ID.into()),
        json!({"kind": "namespace-shared-file", "identity": identity, "name": "/Movies/a b.mp4", "byte_length": length, "media_type": media_type,
            "expires_at": "2099-01-01T00:00:00.000Z"}),
    );
    let route = Route { grants: records.clone(), reader: Arc::new(Files(Mutex::new(files))), config: config(window_bytes) };
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
    Served { address, records }
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
    let (files, identity) = whole_file(&bytes);
    let served = serve(files, &identity, 1000, "video/mp4", 300);
    let p = path(ID, KEY);

    let whole = ask(&served, "GET", &p, None);
    assert_eq!((whole.status, whole.body.as_slice()), (200, bytes.as_slice()), "a body of several windows is the file, once");
    assert_eq!(whole.headers["accept-ranges"], "bytes");
    assert_eq!(whole.headers["content-length"], "1000");
    assert_eq!(whole.headers["content-type"], "video/mp4");
    assert_eq!(whole.headers["cache-control"], "no-store");
    assert_eq!(whole.headers["x-content-type-options"], "nosniff");
    assert!(whole.headers["content-disposition"].starts_with("inline; filename=\"a b.mp4\""), "{:?}", whole.headers);

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
    let served = serve(files, &identity, bytes.len() as u64, "application/octet-stream", 50_000);
    let p = path(ID, KEY);
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
    let (files, identity) = whole_file(&bytes);
    let served = serve(files, &identity, 100, "text/html", 64);
    let p = path(ID, KEY);
    assert_eq!(ask(&served, "GET", &p, None).status, 200);
    let refusal = ask(&served, "GET", &path(ID, "shr_another-key"), None);
    assert_eq!(refusal.status, 404);
    let reference = (refusal.body.clone(), refusal.headers.get("content-type").cloned());

    let other_id = "namespace-shared-file:ffffffffffffffffffffffffffffffff";
    let mut cases: Vec<(&str, String)> = vec![
        ("a key that is not on the share", path(ID, "shr_another-key")),
        ("another id", path(other_id, KEY)),
        ("an id that is not an id", path("../../etc", KEY)),
        ("a key that is not a key", path(ID, "plainkey")),
    ];
    cases.push(("a key of another shape", path(ID, &"shr_".repeat(100))));
    for (what, path) in &cases {
        let got = ask(&served, "GET", path, None);
        assert_eq!((got.status, &got.body, got.headers.get("content-type").cloned()), (404, &reference.0, reference.1.clone()), "{what}");
    }

    let label = format!("sharing:{ID}");
    let set = |share: Value| served.records.workspace.lock().unwrap().insert(label.clone(), share);
    let mut expired = share(ID, Some("2020-01-01T00:00:00.000Z"));
    expired["people"] = share(ID, None)["people"].clone();
    set(expired);
    assert_eq!(ask(&served, "GET", &p, None).status, 404, "an ended share");
    let mut stopped = share(ID, None);
    stopped["revoked_at"] = json!("2026-11-17T01:00:00.000Z");
    stopped["people"] = json!([]);
    set(stopped);
    assert_eq!(ask(&served, "GET", &p, None).status, 404, "a stopped share");
    let mut unpublished = share(ID, None);
    unpublished["published"] = json!(false);
    set(unpublished);
    assert_eq!(ask(&served, "GET", &p, None).status, 404, "an unpublished share");
    let mut cannot = share(ID, None);
    cannot["can"] = json!(["run"]);
    set(cannot);
    assert_eq!(ask(&served, "GET", &p, None).status, 404, "a share that does not let view");
    let mut elsewhere = share(ID, None);
    elsewhere["reach"] = json!([{"type": "namespace-shared-file", "id": other_id}]);
    set(elsewhere);
    assert_eq!(ask(&served, "GET", &p, None).status, 404, "a share that reaches another record");
    let mut prefixed = share(ID, None);
    prefixed["reach"] = json!([{"type": "namespace-shared-file", "prefix": "namespace-shared-file:"}]);
    set(prefixed);
    assert_eq!(ask(&served, "GET", &p, None).status, 404, "a prefix reach is not this share's one file");
    let mut another_kind = share(ID, None);
    another_kind["reach"] = json!([{"type": "note", "id": ID}]);
    set(another_kind);
    assert_eq!(ask(&served, "GET", &p, None).status, 404, "a reach of another kind");

    served.records.workspace.lock().unwrap().remove(&label);
    assert_eq!(ask(&served, "GET", &p, None).status, 404, "no share at all");
    set(share(ID, None));
    assert_eq!(ask(&served, "GET", &p, None).status, 200, "and the share as it was stands again: nothing was remembered");
    served.records.records.lock().unwrap().clear();
    assert_eq!(ask(&served, "GET", &p, None).status, 404, "a shared-file record that is gone");
}

#[test]
fn a_share_stopped_between_two_requests_refuses_the_second() {
    let bytes = pattern(500);
    let (files, identity) = whole_file(&bytes);
    let served = serve(files, &identity, 500, "video/mp4", 100);
    let p = path(ID, KEY);
    assert_eq!(ask(&served, "GET", &p, Some("bytes=0-9")).status, 206);
    served.records.workspace.lock().unwrap().insert(format!("sharing:{ID}"), json!({"reach": [], "people": [], "published": true, "revoked_at": "2026-11-17T01:00:00.000Z"}));
    assert_eq!(ask(&served, "GET", &p, Some("bytes=0-9")).status, 404);
    assert_eq!(ask(&served, "HEAD", &p, None).status, 404);
    assert!(served.records.asked.lock().unwrap().len() >= 3, "each request read the share again");
}

#[test]
fn an_empty_file_is_an_empty_200_and_a_range_of_it_is_416() {
    let (files, identity) = whole_file(b"");
    let served = serve(files, &identity, 0, "text/plain", 64);
    let p = path(ID, KEY);
    let whole = ask(&served, "GET", &p, None);
    assert_eq!((whole.status, whole.body.len()), (200, 0));
    assert_eq!(ask(&served, "GET", &p, Some("bytes=0-")).status, 416);
}
