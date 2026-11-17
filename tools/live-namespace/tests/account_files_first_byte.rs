// tests/account_files_first_byte.rs
//
// Purpose: When the first byte of a raw span is handed on (read_file_span with `raw`): over the real S3 port, against a loopback
// store that answers a ranged read after a first-byte wait and then sends its body at a steady rate, as a network does. The span's
// answer (which the engine's door turns into the start of the raw body) must come with its first bytes, not after its last. Synthetic
// data only.

mod account_files_common;

use account_files_common::{origin, ACCOUNT, ORIGIN};
use live_namespace::{
    account_files::{chunk_copies::{ChunkCopies, Settings}, objects::{ObjectError, Secrets}, source_reads::Unmetered, AccountFiles, CallControl, ORIGINS},
    store::{Mutation, SqlStore, Store},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

/// How long the loopback store waits before it answers a ranged read, and how fast it then sends.
const FIRST_BYTE_WAIT: Duration = Duration::from_millis(50);
const SENT_AT_ONCE: usize = 256 * 1024;
const BETWEEN_SENDS: Duration = Duration::from_millis(5);

struct NoVault;
impl Secrets for NoVault {
    fn plain(&self, _: &str) -> Result<Zeroizing<String>, ObjectError> {
        Ok(Zeroizing::new("synthetic".into()))
    }
    fn sigv4_day_key(&self, _: &str, _: &str) -> Result<Zeroizing<Vec<u8>>, ObjectError> {
        Ok(Zeroizing::new(vec![0; 32]))
    }
    fn holds(&self, _: &str) -> Result<bool, ObjectError> {
        Ok(true)
    }
}

/// A loopback S3 store: PUT keeps an object by its path, HEAD answers its length, and a ranged GET answers after
/// `FIRST_BYTE_WAIT` and then sends `SENT_AT_ONCE` bytes every `BETWEEN_SENDS`.
fn loopback_store() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let objects: Arc<Mutex<HashMap<String, Arc<Vec<u8>>>>> = Arc::default();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let objects = objects.clone();
            std::thread::spawn(move || serve(stream, &objects));
        }
    });
    port
}

fn serve(stream: TcpStream, objects: &Mutex<HashMap<String, Arc<Vec<u8>>>>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut stream = stream;
    loop {
        let mut head = Vec::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                return;
            }
            if line == "\r\n" {
                break;
            }
            head.push(line.trim_end().to_owned());
        }
        let mut words = head[0].split(' ');
        let (method, path) = (words.next().unwrap().to_owned(), words.next().unwrap().split('?').next().unwrap().to_owned());
        let header = |name: &str| head.iter().find_map(|line| line.split_once(':').filter(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.trim().to_owned()));
        if header("expect").is_some_and(|expect| expect.eq_ignore_ascii_case("100-continue")) {
            stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").unwrap();
        }
        let length: usize = header("content-length").and_then(|value| value.parse().ok()).unwrap_or(0);
        let mut body = vec![0u8; length];
        reader.read_exact(&mut body).unwrap();
        let held = objects.lock().unwrap().get(&path).cloned();
        match (method.as_str(), held) {
            ("PUT", _) => {
                objects.lock().unwrap().insert(path, Arc::new(body));
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").unwrap();
            }
            ("HEAD", Some(bytes)) => stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", bytes.len()).as_bytes()).unwrap(),
            ("GET", Some(bytes)) => {
                let range = header("range").unwrap();
                let (from, to) = range.trim_start_matches("bytes=").split_once('-').unwrap();
                let (from, to): (usize, usize) = (from.parse().unwrap(), to.parse::<usize>().unwrap().min(bytes.len() - 1));
                std::thread::sleep(FIRST_BYTE_WAIT);
                let head = format!("HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {from}-{to}/{}\r\n\r\n", to - from + 1, bytes.len());
                stream.write_all(head.as_bytes()).unwrap();
                for piece in bytes[from..=to].chunks(SENT_AT_ONCE) {
                    if stream.write_all(piece).is_err() {
                        return;
                    }
                    std::thread::sleep(BETWEEN_SENDS);
                }
            }
            _ => stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").unwrap(),
        }
    }
}

fn control(answer_now: Arc<dyn Fn(&Value) + Send + Sync>, folder: &std::path::Path) -> CallControl {
    CallControl::new(Instant::now() + Duration::from_secs(120), Arc::new(|| true), Unmetered::new("account_files_first_byte").into())
        .with_byte_results(folder.to_path_buf(), "byte-results", answer_now)
}

#[test]
fn a_raw_span_answers_with_its_first_bytes_not_after_its_last() {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let port = loopback_store();
    let store: Store = Arc::new(SqlStore::memory().unwrap());
    let mut row = origin(true);
    row["reach"]["endpoint"] = json!({ "value": format!("http://127.0.0.1:{port}") });
    row["reach"]["secret"] = json!({ "held": "synthetic-secret" });
    store.mutate(ORIGINS, Mutation { id: ORIGIN.into(), expected_version: 0, request_key: "origin".into(), deleted: false, value: row }).unwrap();
    let folder = tempfile::tempdir().unwrap();
    let length = 32 * 1024 * 1024u64;
    let content: Vec<u8> = (0..length).map(|at| (at * 7 % 251) as u8).collect();
    let mut files = AccountFiles::open(store.clone(), ACCOUNT, Box::new(NoVault)).unwrap().with_control(control(Arc::new(|_: &Value| {}), folder.path()));
    let upload = "0123456789abcdef0123456789abcdef";
    files.call("write_file_start", &json!({ "upload_id": upload, "name": "/clip.bin", "byte_length": length })).unwrap().unwrap();
    for (at, piece) in content.chunks(16 * 1024 * 1024).enumerate() {
        let input = json!({ "upload_id": upload, "name": "/clip.bin", "offset": at * 16 * 1024 * 1024, "content_base64": STANDARD.encode(piece) });
        files.call("write_file_piece", &input).unwrap().unwrap();
    }
    files.call("write_file_finish", &json!({ "upload_id": upload, "name": "/clip.bin" })).unwrap().unwrap();

    // The tool reads with this computer's chunk copies on: the first read of a chunk goes to the store and is kept, a later one is
    // answered from the copy.
    let copies = ChunkCopies::open(&folder.path().join("chunk-copies"), Settings { folder: "chunk-copies".into(), keep_percent_of_free: 100,
        touches_before_fill: 2, touches_kept: 64, fill_bytes_most_per_call: 1 << 30 }, 1 << 40);
    for read in ["from the store", "from this computer's copy"] {
        let (first, whole) = first_and_last(&store, folder.path(), copies.clone(), length, &content);
        eprintln!("first-byte: a raw span of {length} bytes {read} answered at {} ms, its last byte written at {} ms", first.as_millis(), whole.as_millis());
        if read == "from the store" {
            assert!(first * 4 < whole, "the first bytes went on at {first:?}, long before the last at {whole:?}");
        }
    }
}

/// One raw span of the whole of `/clip.bin`: when its answer came (with its first bytes) and when its last byte was written.
fn first_and_last(store: &Store, folder: &std::path::Path, copies: Option<Arc<ChunkCopies>>, length: u64, content: &[u8]) -> (Duration, Duration) {
    let answered: Arc<Mutex<Option<(Instant, Value)>>> = Arc::default();
    let answer_now = {
        let answered = answered.clone();
        Arc::new(move |answer: &Value| *answered.lock().unwrap() = Some((Instant::now(), answer.clone()))) as Arc<dyn Fn(&Value) + Send + Sync>
    };
    let mut files = AccountFiles::open(store.clone(), ACCOUNT, Box::new(NoVault)).unwrap().with_chunk_copies(copies).with_control(control(answer_now, folder));
    let started = Instant::now();
    let answer = files.call("read_file_span", &json!({ "name_or_identity": "/clip.bin", "offset": 0, "length": length, "raw": true })).unwrap().unwrap();
    let whole = started.elapsed();
    let (at, early) = answered.lock().unwrap().clone().expect("the span answered at its first bytes");
    assert_eq!(early, answer, "the answer given at the first bytes is the call's answer");
    assert_eq!(answer["bytes"]["length"], json!(length));
    let written = std::fs::read(folder.join(answer["bytes"]["file"].as_str().unwrap())).unwrap();
    assert!(written == content, "the file is exactly the span");
    (at - started, whole)
}
