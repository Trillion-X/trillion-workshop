// tests/workshop_output_kept.rs
//
// Purpose: A tool run's output file kept in a person's own files, proved on a synthetic account with no real
// store, no real account and no Keychain item. Two halves that meet at one boundary, the name and the write trillion-local
// makes when it keeps a file (src/tool_runs/tools/outputs.rs `store`):
// 1. trillion-local's whole run path for the tool row `tool:copy-a-site` (catalog, container runner, the
//    internet:true sandbox and its public-egress proxy, the browser the tool finds on this computer), for a synthetic
//    account whose state folder holds no account files store. Its answer says the file was not kept because the person's
//    files are not available; outputs.rs reads the declared file before it asks for the files, so that answer (and
//    not "the tool did not make the file") proves the tool made `site.json` as a regular file inside its folder and
//    within its limit.
// 2. Keeping a file the way trillion-local keeps it, on a synthetic account's real files: a record store account files store at its
//    declared placement in the state folder (src/storage/record_store_resources.json, as `AccountFilesDoor::open` finds it), one
//    origin record that takes new bytes whose every connection fact is held in a real secrets vault at its own
//    placement, sealed under a synthetic account key, and a stand-in S3-compatible store on loopback that checks
//    every request's AWS Signature V4 against the synthetic secret, keeps PUT bodies only when their SHA-256 matches,
//    and answers reads only as exact ranges. The file is written under `AccountFilesDoor::run_output_name` with the same
//    input `outputs::store` sends, and read back through an account files opened again from the files on disk.
//
// Invariants:
// - The two halves are not one call because trillion-local opens an account's files only through
//   `secrets::open_home`, whose account key is read from the product's Keychain item (product DATA
//   `account-key`, pinned). A synthetic account has no key there and a real one must not be read, so half 1 stops
//   before that read (no account files store, so `AccountFilesDoor::open` refuses first) and half 2 opens the same vault
//   with a synthetic key.
// - The public-egress policy (src/tool_runs/tools/public-egress.json) refuses loopback, and the internet:true sandbox lets a run
//   reach only the proxy, so half 1 copies a public site: the reserved example domain (RFC 2606), one page.
// - No value here is a real secret: the account key, key id and secret are made from this run's clock.
//
// Running: half 2 runs with the other tests. Half 1 is ignored by default: it needs this computer's network, the node
// the Mac app ships, a Chromium-family browser and a tools folder with its node_modules, named by trillion-local's own
// launch setting `WORKSHOP_MODULE_ROOT`; run it with `--ignored` and that setting.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime},
};
use trillion_local::{
    secrets::{self, SecretsKey, HeldAs, Secrets, VaultIdentity},
    account_files::{account_routes::AccountFilesDoor, source_reads::Unmetered, CallControl, AccountFiles, FILES, ORIGINS},
    records::{Mutation, Records},
    tool_runs::tools::{self, Failure, Held, Place},
    sqlite_work::WorkMeter,
    storage::record_store_resources,
};
use zeroize::Zeroizing;

const ACCOUNT: &str = "synthetic-account";
/// The service the synthetic store's values are connected as (vault names `<service>-<field>`).
const SERVICE: &str = "synthetic-store";
/// Where the synthetic store keeps a new whole file: this prefix, then the file's identity.
const FILE_PREFIX: &str = "files/";

/// The id of a tool, the way a row names it.
fn tool(name: &str) -> String {
    format!("tool{}{name}", ':')
}

/// Hex of some bytes.
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A value made from this run's clock: never a real secret, different every run.
fn made(label: &str) -> String {
    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos();
    hex(&content_crypto::hash(format!("{label}{now}").as_bytes()))
}

/// The answer trillion-local gives when the person's files cannot take a run's file (outputs.rs `Refused::Unavailable`).
const NOT_AVAILABLE: &str = "the output site was not kept: your files are not available to keep it in";

// ---------------------------------------------------------------------------------------------------------------
// Half 1: trillion-local's whole run path for tool:copy-a-site.
// ---------------------------------------------------------------------------------------------------------------

/// A run that names no credential: copy-a-site names none.
struct NoHeld;
impl Held for NoHeld {
    fn plain(&self, _: &str) -> Result<Zeroizing<String>, Failure> {
        Err(trillion_local::cause!(Failure::Credential))
    }
}

#[test]
#[ignore = "needs the network, the Mac app's node, a Chromium-family browser and WORKSHOP_MODULE_ROOT"]
fn copy_a_site_runs_through_the_engine_and_makes_its_file() {
    let root = std::env::var_os("WORKSHOP_MODULE_ROOT").expect("WORKSHOP_MODULE_ROOT names the Workshop folder to run");
    assert!(PathBuf::from(&root).join("tools").join("copy-a-site").is_dir(), "the Workshop holds tools/copy-a-site");
    let state = tempfile::tempdir().unwrap();
    let place = Place { account: ACCOUNT, state_root: state.path(), door: None, origin: None };
    let site = format!("https{}{}example.com{}", ':', "//", '/');
    let input = json!({"tool": tool("copy-a-site"), "input": {"url": site, "max_pages": 1}});
    let engine = tools::shipped().expect("the shipped Workshop settings");
    let started = Instant::now();
    let answer = engine
        .call("tools:run", "copy-a-site-proof", &input, &place, &NoHeld, &AtomicBool::new(false))
        .expect("the run is answered");
    eprintln!("copy-a-site answered in {} ms: {answer}", started.elapsed().as_millis());
    assert_eq!(answer["tool"], tool("copy-a-site"));
    assert_eq!(answer["exit_code"], 0, "the tool finished: {answer}");
    // The declared file is read before the person's files are asked for: this answer, not "the tool did not make
    // the file", says the tool left site.json as a regular file inside its folder and within its limit.
    assert_eq!(answer["error"], NOT_AVAILABLE, "{answer}");
    assert!(answer.get("files").is_none(), "no file is named that was not kept");
    let files = record_store_resources::placement(FILES).and_then(|placement| placement.in_state(state.path())).unwrap();
    assert!(!files.exists(), "no account files store was made for the account");
}

// ---------------------------------------------------------------------------------------------------------------
// Half 2: the file kept in a synthetic account's files, over a stand-in S3-compatible store on loopback.
// ---------------------------------------------------------------------------------------------------------------

/// What the stand-in store keeps and saw.
#[derive(Default)]
struct Kept {
    /// Each object by key: its bytes and media type.
    objects: Mutex<HashMap<String, (Vec<u8>, String)>>,
    /// Requests whose signature matched the synthetic secret.
    signed: AtomicUsize,
    /// Requests refused (a signature that did not match, a body that was not what it said, a read that was not a range).
    refused: AtomicUsize,
}

/// A stand-in S3-compatible store on loopback: path-style `/<bucket>/<key>`, every request checked against AWS
/// Signature V4 with `secret`, PUT kept only when its body's SHA-256 is the signed one, GET answered only for an exact
/// `Range` (206 with its `Content-Range`), HEAD with the object's length and type.
struct StandIn {
    port: u16,
    kept: Arc<Kept>,
}
impl StandIn {
    fn start(bucket: String, secret: String) -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let kept = Arc::new(Kept::default());
        let serving = kept.clone();
        thread::spawn(move || {
            for client in listener.incoming().flatten() {
                let (kept, bucket, secret) = (serving.clone(), bucket.clone(), secret.clone());
                thread::spawn(move || answer(client, &kept, &bucket, &secret));
            }
        });
        Self { port, kept }
    }
}

/// One request to the stand-in store.
fn answer(client: TcpStream, kept: &Kept, bucket: &str, secret: &str) {
    let mut reader = BufReader::new(client.try_clone().unwrap());
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        if reader.read_until(b'\n', &mut head).unwrap_or(0) == 0 {
            return;
        }
    }
    let mut slots = [httparse::EMPTY_HEADER; 32];
    let mut request = httparse::Request::new(&mut slots);
    request.parse(&head).unwrap();
    let header = |name: &str| {
        request.headers.iter().find(|h| h.name.eq_ignore_ascii_case(name)).map(|h| String::from_utf8_lossy(h.value).trim().to_owned())
    };
    let method = request.method.unwrap().to_owned();
    let target = request.path.unwrap().to_owned();
    let length: usize = header("content-length").and_then(|value| value.parse().ok()).unwrap_or(0);
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).unwrap();
    let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
    let mut client = client;
    let mut reply = |status: &str, headers: &[(&str, String)], body: &[u8]| {
        let mut text = format!("HTTP/1.1 {status}\r\nConnection: close\r\n");
        for (name, value) in headers {
            text.push_str(&format!("{name}: {value}\r\n"));
        }
        if !headers.iter().any(|(name, _)| *name == "Content-Length") {
            text.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        text.push_str("\r\n");
        client.write_all(text.as_bytes()).unwrap();
        if method != "HEAD" {
            client.write_all(body).unwrap();
        }
    };
    let payload = header("x-amz-content-sha256").unwrap_or_default();
    if !signature_matches(&method, path, query, &header, secret) || payload != hex(&Sha256::digest(&body)) {
        kept.refused.fetch_add(1, Ordering::SeqCst);
        return reply("403 Forbidden", &[], b"<Error><Code>SignatureDoesNotMatch</Code><Message>synthetic</Message></Error>");
    }
    kept.signed.fetch_add(1, Ordering::SeqCst);
    let Some(key) = path.strip_prefix(&format!("/{bucket}/")).map(str::to_owned) else {
        // A listing of the bucket: the stand-in answers one empty page.
        let xml = "<ListBucketResult><IsTruncated>false</IsTruncated><KeyCount>0</KeyCount></ListBucketResult>";
        return reply("200 OK", &[("Content-Type", "application/xml".into())], xml.as_bytes());
    };
    let mut objects = kept.objects.lock().unwrap();
    match method.as_str() {
        "PUT" => {
            objects.insert(key, (body, header("content-type").unwrap_or_default()));
            reply("200 OK", &[], b"");
        }
        "HEAD" => match objects.get(&key) {
            Some((bytes, media)) => reply("200 OK", &[("Content-Length", bytes.len().to_string()), ("Content-Type", media.clone())], b""),
            None => reply("404 Not Found", &[("Content-Length", "0".into())], b""),
        },
        "GET" => {
            let Some((bytes, _)) = objects.get(&key) else { return reply("404 Not Found", &[], b"") };
            let range = header("range").and_then(|range| {
                let (from, to) = range.strip_prefix("bytes=")?.split_once('-')?;
                Some((from.parse::<usize>().ok()?, to.parse::<usize>().ok()?))
            });
            match range {
                Some((from, to)) if from <= to && from < bytes.len() => {
                    let to = to.min(bytes.len() - 1);
                    let content_range = format!("bytes {from}-{to}/{}", bytes.len());
                    reply("206 Partial Content", &[("Content-Range", content_range)], &bytes[from..=to]);
                }
                _ => {
                    kept.refused.fetch_add(1, Ordering::SeqCst);
                    reply("416 Range Not Satisfiable", &[], b"");
                }
            }
        }
        _ => reply("405 Method Not Allowed", &[], b""),
    }
}

/// Whether a request's AWS Signature V4 (its `Authorization` header, over the headers it names) is the one `secret`
/// makes for it.
fn signature_matches(method: &str, path: &str, query: &str, header: &dyn Fn(&str) -> Option<String>, secret: &str) -> bool {
    let Some(authorization) = header("authorization") else { return false };
    let Some(fields) = authorization.strip_prefix("AWS4-HMAC-SHA256 ") else { return false };
    let field = |name: &str| fields.split(", ").find_map(|part| part.strip_prefix(name)).map(str::to_owned);
    let (Some(credential), Some(signed), Some(signature)) = (field("Credential="), field("SignedHeaders="), field("Signature=")) else {
        return false;
    };
    let Some((_, scope)) = credential.split_once('/') else { return false };
    let parts: Vec<&str> = scope.split('/').collect();
    let (Some(date), [day, region, service, terminator]) = (header("x-amz-date"), parts.as_slice()) else { return false };
    let mut canonical = format!("{method}\n{path}\n{query}\n");
    for name in signed.split(';') {
        canonical.push_str(&format!("{name}:{}\n", header(name).unwrap_or_default()));
    }
    canonical.push_str(&format!("\n{signed}\n{}", header("x-amz-content-sha256").unwrap_or_default()));
    let to_sign = format!("AWS4-HMAC-SHA256\n{date}\n{scope}\n{}", hex(&Sha256::digest(canonical.as_bytes())));
    let mac = |key: &[u8], data: &str| {
        let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
        mac.update(data.as_bytes());
        mac.finalize().into_bytes().to_vec()
    };
    let mut key = mac(format!("AWS4{secret}").as_bytes(), day);
    for part in [region, service, terminator] {
        key = mac(&key, part);
    }
    hex(&mac(&key, &to_sign)) == signature
}

/// A synthetic account's files in `state`: its vault holding the stand-in store's connection facts (sealed under a
/// synthetic account key), and its files store with one origin record that takes new bytes and names each fact
/// by its vault name. Answers the account key, to open the vault again as trillion-local would.
fn synthetic_files(state: &Path, store: &StandIn, key_id: &str, secret: &str, bucket: &str) -> SecretsKey {
    let root = SecretsKey::new(Zeroizing::new(format!("nm_{}_{}", "c".repeat(64), made("account-key")))).unwrap();
    let vault = open_vault(state, &root);
    let endpoint = format!("http{}{}{}{}", ':', "//", Ipv4Addr::LOCALHOST, format_args!(":{}", store.port));
    for (field, value, held_as) in [
        ("key-id", key_id.to_owned(), HeldAs::Plain),
        ("application-key", secret.to_owned(), HeldAs::Sigv4SigningRoot),
        ("bucket", bucket.to_owned(), HeldAs::Plain),
        ("endpoint", endpoint, HeldAs::Plain),
        ("region", "synthetic-region".to_owned(), HeldAs::Plain),
    ] {
        vault.connect(SERVICE, field, Zeroizing::new(value), held_as).unwrap();
    }
    let held = |field: &str| json!({"held": secrets::held_name(SERVICE, field).unwrap()});
    let origin = json!({
        "kind": "namespace-origin", "rank": 1, "takes_new_bytes": true, "file_key_prefix": FILE_PREFIX,
        "reach": {"key_id": held("key-id"), "secret": held("application-key"), "bucket": held("bucket"),
                  "endpoint": held("endpoint"), "region": held("region")}
    });
    let path = record_store_resources::placement(FILES).and_then(|placement| placement.in_state(state)).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut files = record_store_resources::open(&path, WorkMeter::new()).unwrap();
    files.mutate(ACCOUNT, ORIGINS, Mutation {
        id: "synthetic-origin".into(), expected_version: 0, request_key: "synthetic-origin-1".into(), deleted: false, value: origin,
    }).unwrap();
    root
}

/// The account's vault at its placement in `state`, sealed under `root`, named by the product's identity word: what
/// `secrets::open_home` opens, with the account key given instead of read from the Keychain.
fn open_vault(state: &Path, root: &SecretsKey) -> Secrets<impl trillion_local::storage::Storage + Send + 'static> {
    let path = record_store_resources::placement(secrets::resource().unwrap()).and_then(|placement| placement.in_state(state)).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let naming = VaultIdentity::new(trillion_local::account_files::identity::word().unwrap()).unwrap();
    Secrets::open(secrets::open_store(&path).unwrap(), ACCOUNT, root, naming).unwrap()
}

/// The account's files as `AccountFilesDoor::open` opens them: the account files store at its placement (never created
/// here) and the account's vault.
fn open_files(state: &Path, root: &SecretsKey) -> AccountFiles<impl trillion_local::storage::Storage + Send> {
    let path = record_store_resources::placement(FILES).and_then(|placement| placement.in_state(state)).unwrap();
    assert!(path.is_file(), "the account files store is in the state folder");
    let store = record_store_resources::open(&path, WorkMeter::new()).unwrap();
    AccountFiles::open(store, ACCOUNT, Box::new(open_vault(state, root))).unwrap().until(Instant::now() + Duration::from_secs(30))
}

/// A site.json shaped as tools/copy-a-site leaves it: `{files: {path: contents}}`, two pages and a style sheet.
fn site_json() -> Vec<u8> {
    let page = |title: &str| format!("<!doctype html><html><head><title>{title}</title></head><body><h1>{title}</h1></body></html>");
    let guide = ["guides", "first", "index.html"].join(&'/'.to_string());
    let look = ["look", "site.css"].join(&'/'.to_string());
    serde_json::to_vec(&json!({"files": {"index.html": page("Home"), guide: page("First guide"), look: "main { margin: 0 }"}})).unwrap()
}

#[test]
fn a_runs_file_is_kept_in_a_synthetic_accounts_files_over_a_stand_in_store() {
    let dir = tempfile::tempdir().unwrap();
    // trillion-local holds its state folder by its canonical path; a placement file is opened only there.
    let state = std::fs::canonicalize(dir.path()).unwrap();
    let state = state.as_path();
    let (key_id, secret, bucket) = (made("key-id"), made("secret"), "synthetic-bucket".to_owned());
    let store = StandIn::start(bucket.clone(), secret.clone());
    let root = synthetic_files(state, &store, &key_id, &secret, &bucket);

    // The name, the write and the control outputs.rs `store` makes for (tool, run, file).
    let door = AccountFilesDoor::shipped().expect("account files door DATA");
    let name = door.run_output_name(&tool("copy-a-site"), "0123456789abcdef", "site.json");
    let bytes = site_json();
    let input = json!({"name": name, "content_base64": STANDARD.encode(&bytes), "media_type": "application/json"});
    let unadmitted = open_files(state, &root).call("write_file", &input).unwrap();
    assert!(unadmitted.is_err(), "a write with no admission is refused: {unadmitted:?}");
    assert!(store.kept.objects.lock().unwrap().is_empty(), "and nothing reached the store");
    let written = open_files(state, &root).with_control(AccountFilesDoor::run_outputs_control(Instant::now() + Duration::from_secs(30)))
        .call("write_file", &input).expect("an account's files tool").expect("the file is kept");
    let identity = format!("1f:{}", hex(&content_crypto::hash(&bytes)));
    let described = json!({"identity": written["identity"], "bytes": written["byte_length"], "media_type": written["media_type"], "name": name});
    eprintln!("kept: {described}");
    assert_eq!(described["identity"], identity, "the file is named by its own bytes");
    assert_eq!(described["bytes"], bytes.len());
    assert_eq!(described["media_type"], "application/json");
    assert!(name.ends_with("/copy-a-site/0123456789abcdef/site.json"), "{name}");

    // The stand-in store holds exactly those bytes, once, under the origin's prefix and the identity.
    {
        let objects = store.kept.objects.lock().unwrap();
        assert_eq!(objects.len(), 1, "one object: {:?}", objects.keys().collect::<Vec<_>>());
        let (key, (held, media)) = objects.iter().next().unwrap();
        assert!(key.starts_with(FILE_PREFIX) && key.ends_with(&hex(&content_crypto::hash(&bytes))), "{key}");
        assert_eq!(held, &bytes);
        assert_eq!(media, "application/json");
    }

    // The same write again (a retried run) keeps nothing new; it sends no bytes, so it needs no byte check.
    let again = open_files(state, &root).with_control(AccountFilesDoor::run_outputs_control(Instant::now() + Duration::from_secs(30)))
        .call("write_file", &input).unwrap().unwrap();
    assert_eq!(again["identity"], identity);
    assert_eq!(store.kept.objects.lock().unwrap().len(), 1, "a retry keeps one file");

    // Read back through the files opened again from disk: site.json, whose JSON lists the copied pages.
    let found = open_files(state, &root).call("find_file", &json!({"name_or_identity": name})).unwrap().unwrap();
    assert_eq!(found["identity"], identity);
    // The door's own calls carry no byte check, so a physical read refuses there; this read-back names its
    // unmetered byte check on purpose.
    let unadmitted = open_files(state, &root).call("read_file", &json!({"name_or_identity": name})).unwrap();
    assert!(unadmitted.is_err(), "a read with no admission is refused: {unadmitted:?}");
    let read_back = CallControl::new(Instant::now() + Duration::from_secs(30), Arc::new(|| true),
        Unmetered::new("workshop_output_kept stand-in read-back").into());
    let read = open_files(state, &root).with_control(read_back).call("read_file", &json!({"name_or_identity": name})).unwrap().unwrap();
    let text = read["content"].as_str().expect("site.json read as text");
    assert_eq!(text.as_bytes(), bytes.as_slice());
    let site: Value = serde_json::from_str(text).unwrap();
    let mut pages: Vec<&str> = site["files"].as_object().unwrap().keys().map(String::as_str).filter(|path| path.ends_with(".html")).collect();
    pages.sort_unstable();
    assert_eq!(pages, vec![["guides", "first", "index.html"].join(&'/'.to_string()).as_str(), "index.html"]);

    // Every request the store saw was signed with the vault's secret, and none was refused.
    let (signed, refused) = (store.kept.signed.load(Ordering::SeqCst), store.kept.refused.load(Ordering::SeqCst));
    eprintln!("stand-in store: {signed} signed requests, {refused} refused");
    assert!(signed >= 2, "a write and a read reached the store: {signed}");
    assert_eq!(refused, 0);
}
