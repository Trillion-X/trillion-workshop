//! The person's own page puts a file in, lists it, reads a byte range back and removes it at
//! /work/api/files/<operation> (src/server/owner-routes.json, the row named after the account files' resource),
//! through the same call an AI's key makes (`call_while`). The account is the fixture's
//! synthetic one; its secrets key is sealed to a synthetic computer key in its state folder, and its one store is a
//! loopback stand-in kept in this test's scratch folder (it answers exact ranges and keeps whole PUTs; it does not
//! check signatures, which src/account_files/objects.rs and examples/account_files_standin.rs prove apart). A request
//! with no session is refused and reaches no store.
use super::*;
use base64::prelude::*;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::atomic::{AtomicUsize, Ordering},
};
use trillion_local::account_files::objects::{Origin, Reach, Source};

const SERVICE: &str = "page-standin";
const FIELD: &str = "application-key";

/// The stand-in store: whole PUTs kept by key, exact `Range` GETs answered 206, HEAD with the length.
struct Standin {
    port: u16,
    objects: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    requests: Arc<AtomicUsize>,
}
fn standin() -> Standin {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let objects: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::default();
    let requests = Arc::new(AtomicUsize::new(0));
    let (kept, counted) = (objects.clone(), requests.clone());
    std::thread::spawn(move || {
        for client in listener.incoming().flatten() {
            let (kept, counted) = (kept.clone(), counted.clone());
            std::thread::spawn(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                let mut reader = BufReader::new(client.try_clone().unwrap());
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    if reader.read_until(b'\n', &mut head).unwrap_or(0) == 0 {
                        return;
                    }
                }
                let mut room = [httparse::EMPTY_HEADER; 32];
                let mut request = httparse::Request::new(&mut room);
                request.parse(&head).unwrap();
                let header = |name: &str| request.headers.iter().find(|h| h.name.eq_ignore_ascii_case(name))
                    .map(|h| String::from_utf8_lossy(h.value).trim().to_owned());
                let method = request.method.unwrap().to_owned();
                let key = request.path.unwrap().split('?').next().unwrap().to_owned();
                let length: usize = header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
                let mut body = vec![0u8; length];
                reader.read_exact(&mut body).unwrap();
                let mut client = client;
                let mut reply = |status: &str, headers: Vec<(String, String)>, body: &[u8]| {
                    let mut text = format!("HTTP/1.1 {status}\r\nConnection: close\r\n");
                    for (name, value) in &headers {
                        text.push_str(&format!("{name}: {value}\r\n"));
                    }
                    if !headers.iter().any(|(name, _)| name == "Content-Length") {
                        text.push_str(&format!("Content-Length: {}\r\n", body.len()));
                    }
                    text.push_str("\r\n");
                    client.write_all(text.as_bytes()).unwrap();
                    if method != "HEAD" {
                        client.write_all(body).unwrap();
                    }
                };
                let held = kept.lock().unwrap().get(&key).cloned();
                match (method.as_str(), held) {
                    ("PUT", _) => {
                        kept.lock().unwrap().insert(key, body);
                        reply("200 OK", vec![], b"");
                    }
                    ("HEAD", Some(bytes)) => reply("200 OK", vec![("Content-Length".into(), bytes.len().to_string())], b""),
                    ("GET", Some(bytes)) => {
                        let range = header("range").and_then(|range| {
                            let (from, to) = range.strip_prefix("bytes=")?.split_once('-')?;
                            Some((from.parse::<usize>().ok()?, to.parse::<usize>().ok()?))
                        });
                        match range {
                            Some((from, to)) if from <= to && to < bytes.len() => reply("206 Partial Content",
                                vec![("Content-Range".into(), format!("bytes {from}-{to}/{}", bytes.len()))], &bytes[from..=to]),
                            _ => reply("416 Range Not Satisfiable", vec![], b""),
                        }
                    }
                    _ => reply("404 Not Found", vec![], b""),
                }
            });
        }
    });
    Standin { port, objects, requests }
}

/// The fixture account's files: its secrets key sealed to a synthetic computer key (the computer's key source), the
/// stand-in's secret held in its vault, and its files store with the stand-in as its one store taking new bytes.
fn account_files(f: &Fixture, standin: &Standin) {
    use trillion_local::secrets::{self, secrets_key};
    let state = f.records.parent().unwrap().to_owned();
    let key_file = state.parent().unwrap().join("computer.key");
    fs::write(&key_file, BASE64_STANDARD.encode([7u8; 32])).unwrap();
    // One choice per process: every test here that opens a vault reads the computer's key file it names.
    let _ = secrets_key::choose_source(secrets_key::SecretsKeySource::Computer { key_file: key_file.clone() });
    let secrets_key::SecretsKeySource::Computer { key_file: chosen } = secrets_key::source() else { panic!("the computer key source") };
    let computer = secrets_key::ComputerKey::read(&chosen).unwrap();
    secrets_key::write_sealed(&state, &secrets_key::generate().unwrap(), &computer).unwrap();
    let vault = secrets::open_home(&state, OWNER_ID).unwrap();
    vault.connect(SERVICE, FIELD, zeroize::Zeroizing::new("synthetic-secret".into()), secrets::HeldAs::Sigv4SigningRoot).unwrap();
    let path = trillion_local::storage::record_store_resources::placement(trillion_local::account_files::FILES)
        .and_then(|placement| placement.in_state(&state)).unwrap();
    let mut store = trillion_local::storage::record_store_resources::open(&path, trillion_local::sqlite_work::WorkMeter::new()).unwrap();
    let origin = Origin {
        kind: trillion_local::account_files::ORIGIN_KIND.into(), rank: 0, takes_new_bytes: true, file_key_prefix: "files/".into(), bound_to: None,
        reach: Reach {
            key_id: Source::Value("synthetic-key".into()),
            secret: Source::Held(secrets::held_name(SERVICE, FIELD).unwrap()),
            bucket: Source::Value("synthetic".into()),
            endpoint: Source::Value(format!("http://127.0.0.1:{}", standin.port)),
            region: Source::Value("us-east-1".into()),
        },
    };
    use trillion_local::records::Records;
    store.mutate(OWNER_ID, trillion_local::account_files::ORIGINS, trillion_local::records::Mutation {
        id: "standin".into(), expected_version: 0, request_key: "fixture-origin".into(), deleted: false,
        value: serde_json::to_value(&origin).unwrap(),
    }).unwrap();
}

async fn answered(f: &Fixture, request: Request<Body>) -> (StatusCode, Value) {
    let response = f.app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 4 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// A page read: GET /work/api/files/<operation>?input=<JSON>.
async fn read(f: &Fixture, operation: &str, input: Value) -> Value {
    let query = url::form_urlencoded::Serializer::new(String::new()).append_pair("input", &input.to_string()).finish();
    let (status, answer) = answered(f, request("GET", &format!("/work/api/files/{operation}?{query}"), None)).await;
    assert_eq!(status, StatusCode::OK, "{operation}: {answer}");
    answer
}

/// A page change: POST /work/api/files/<operation> with the input as its body.
async fn change(f: &Fixture, operation: &str, input: Value) -> Value {
    let mut post = request("POST", &format!("/work/api/files/{operation}"), Some(&input.to_string()));
    post.headers_mut().insert(header::ORIGIN, ORIGIN.parse().unwrap());
    post.headers_mut().insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    let key = format!("files-page-{}", blake3::hash(input.to_string().as_bytes()).to_hex());
    post.headers_mut().insert("x-trillion-request-key", key[..60].parse().unwrap());
    let (status, answer) = answered(f, post).await;
    assert_eq!(status, StatusCode::OK, "{operation}: {answer}");
    answer
}

#[tokio::test]
async fn the_page_puts_a_file_in_in_pieces_lists_it_reads_a_range_back_and_removes_it() {
    let f = Fixture::new(&[]);
    let store = standin();
    account_files(&f, &store);
    let bytes: Vec<u8> = (0..1_100_000u32).map(|at| (at.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
    let name = "/Synthetic page files/clip.bin";
    let upload_id = "0123456789abcdef0123456789abcdef";
    let started = change(&f, "write_file_start", json!({"upload_id": upload_id, "name": name,
        "byte_length": bytes.len(), "media_type": "application/octet-stream"})).await;
    assert_eq!(started["upload_id"], upload_id, "{started}");
    let mut pieces = 0;
    for (ordinal, piece) in bytes.chunks(32 * 1024).enumerate() {
        change(&f, "write_file_piece", json!({"upload_id": upload_id, "name": name, "offset": ordinal * 32 * 1024,
            "content_base64": BASE64_STANDARD.encode(piece)})).await;
        pieces += 1;
    }
    assert!(pieces > 32, "over 1 MB in pieces");
    let finished = change(&f, "write_file_finish", json!({"upload_id": upload_id, "name": name})).await;
    let identity = format!("1f:{}", blake3::hash(&bytes).to_hex());
    assert_eq!(finished["identity"], identity, "{finished}");
    assert!(finished.get("recent_use_not_kept").is_none(), "{finished}");

    let listed = read(&f, "list_files", json!({"folder": "/Synthetic page files"})).await;
    let names: Vec<&str> = listed["names"].as_array().unwrap().iter().filter_map(|row| row["name"].as_str()).collect();
    assert_eq!(names, vec![name], "{listed}");
    assert_eq!(listed["names"][0]["byte_length"], bytes.len());

    let range = read(&f, "read_file", json!({"name_or_identity": name, "offset": 500_000, "length": 70_000, "encoding": "base64"})).await;
    assert_eq!(range["bytes_returned"], 70_000, "{range}");
    let back = BASE64_STANDARD.decode(range["content"].as_str().unwrap()).unwrap();
    assert_eq!(back, bytes[500_000..570_000], "the range read back is the range put in");
    read(&f, "read_file", json!({"name_or_identity": name, "length": 16, "encoding": "base64"})).await;

    let recent = read(&f, "recent_files", json!({})).await;
    assert_eq!(recent["items"][0]["identity"], identity, "{recent}");
    assert_eq!(recent["items"][0]["name"], name);
    assert_eq!(recent["items"][0]["last_kind"], "opened", "the read from the start is the newest use");
    assert!(recent["items"][0]["kinds"]["edited"].is_string(), "the finished write kept edited: {recent}");
    assert_eq!(recent["said"], "1 file used, newest first.");

    let facts = change(&f, "set_file_facts", json!({"identity": identity, "facts": {"client": "Synthetic client", "camera": "none"}})).await;
    assert_eq!(facts["changed"], true, "{facts}");
    change(&f, "set_file_facts", json!({"identity": identity, "facts": {"camera": null}})).await;
    let kept = read(&f, "read_file_results", json!({"identity": identity, "kind": "facts"})).await;
    assert_eq!(kept["results"][0]["value"], json!({"client": "Synthetic client"}), "the facts are the file's result of kind facts: {kept}");

    let removed = change(&f, "set_aside", json!({"name": name})).await;
    assert!(removed.get("next_after").is_some(), "{removed}");
    let listed = read(&f, "list_files", json!({"folder": "/Synthetic page files"})).await;
    assert_eq!(listed["names"], json!([]), "{listed}");
    let aside = read(&f, "list_set_aside", json!({"folder": "/Synthetic page files"})).await;
    assert_eq!(aside["names"][0]["name"], name, "{aside}");
    assert!(store.objects.lock().unwrap().len() >= pieces, "each piece's bytes were kept in the store");

    // A request with no session is refused and reaches no store.
    let before = store.requests.load(Ordering::SeqCst);
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("input", &json!({"name_or_identity": identity, "length": 16}).to_string()).finish();
    let signed_out = Request::builder().method("GET").uri(format!("/work/api/files/read_file?{query}"))
        .header(header::HOST, AUTHORITY).body(Body::empty()).unwrap();
    let (status, answer) = answered(&f, signed_out).await;
    assert!(matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN), "{status} {answer}");
    let mut post = Request::builder().method("POST").uri("/work/api/files/write_file").header(header::HOST, AUTHORITY)
        .header(header::ORIGIN, ORIGIN).header(header::CONTENT_TYPE, "application/json").header("x-trillion-request-key", "signed-out-write")
        .body(Body::from(json!({"name": "/Synthetic page files/not.txt", "text": "no"}).to_string())).unwrap();
    post.headers_mut().remove(header::COOKIE);
    let (status, answer) = answered(&f, post).await;
    assert!(matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN), "{status} {answer}");
    assert_eq!(store.requests.load(Ordering::SeqCst), before, "a signed-out request reached no store");
}

#[tokio::test]
async fn the_page_reaches_only_the_files_operations_by_their_own_method() {
    let f = Fixture::new(&[]);
    // A change is not a GET, a read is not a POST, and an operation the files do not answer is refused.
    let (status, _) = answered(&f, request("GET", "/work/api/files/write_file?input=%7B%7D", None)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let mut post = request("POST", "/work/api/files/list_files", Some("{}"));
    post.headers_mut().insert(header::ORIGIN, ORIGIN.parse().unwrap());
    post.headers_mut().insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    post.headers_mut().insert("x-trillion-request-key", "files-page-wrong-method".parse().unwrap());
    let (status, _) = answered(&f, post).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = answered(&f, request("GET", "/work/api/files/remove_everything", None)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}
