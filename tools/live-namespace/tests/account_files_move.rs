// tests/account_files_move.rs
//
// Purpose: Emptying one store into another (`account_files::moves`) over a record store in memory and an in-memory byte port
// with two stores: the dry run's counts and its silence (no request, no write), a full move (chunks, a whole file
// larger than one ranged read, chunked files relabelled, a key no record names, a key the destination already held,
// sent again because a copy is never read back),
// new bytes refused by the emptied store, the audit and the retirement, refusal of bytes that do not match their
// identity, a stopped run finished by a second one (a key whose PUT landed before the stop refused its HEAD is sent once more) (a refusal of access stops the whole
// run), and small keys packed per group into archives with manifests whose every member reads back as it was.
// Invariants: the port serves only exact ranges and counts every request per key, so a test passes only if each key
// is read in bounded ranges and sent at most once.
// Key concepts: `live_namespace::account_files::moves::{Mover, Plan, audit, retire}`.
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use content_crypto::advanced;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    io::Read,
    sync::{Arc, Mutex},
};
use live_namespace::{
    account_files::{
        moves::{audit, carry_keys, import_proofs, moved_scope, pack_keys, pack_plan, packs, plan_of, plan_of_packs, retire, work_list, Mover, Phase, Plan, Route, PACKED_ROOT, UPLOAD_PROOF},
        objects::{Body, Listing, ObjectError, Objects, Stat, MAX_RANGE_BYTES},
        AccountFiles, CHUNKS, FILES, ORIGINS, SPANS, UPLOADS,
    },
    store::{Mutation, SqlStore, Store},
};

const ACCOUNT: &str = "account-a";
const FROM: &str = "landing";
const TO: &str = "archive";

/// Two stores in memory: (origin, key) -> bytes, with every request counted and optional faults.
#[derive(Default)]
struct Stores {
    objects: Mutex<BTreeMap<(String, String), Vec<u8>>>,
    /// (origin, method) -> requests.
    requests: Mutex<HashMap<(String, &'static str), u64>>,
    /// key -> PUTs of it.
    puts: Mutex<HashMap<String, u64>>,
    /// PUTs refused after this many have been kept (a run that stops part way).
    puts_allowed: Mutex<Option<u64>>,
}
#[derive(Clone)]
struct Port(Arc<Stores>);
impl Port {
    fn count(&self, origin: &str, method: &'static str) {
        *self.0.requests.lock().unwrap().entry((origin.to_owned(), method)).or_default() += 1;
    }
    fn held(&self, origin: &str, key: &str) -> Option<Vec<u8>> {
        self.0.objects.lock().unwrap().get(&(origin.to_owned(), key.to_owned())).cloned()
    }
    fn put(&self, origin: &str, key: &str, bytes: Vec<u8>) {
        self.0.objects.lock().unwrap().insert((origin.to_owned(), key.to_owned()), bytes);
    }
    fn requests(&self) -> u64 {
        self.0.requests.lock().unwrap().values().sum()
    }
}
impl Objects for Port {
    /// A stand-in in memory sends no request, so it only keeps the control.
    fn set_control(&mut self, _: live_namespace::account_files::CallControl) {}
    fn read(&self, origin: &str, key: &str, offset: u64, length: u64) -> Result<Vec<u8>, ObjectError> {
        self.count(origin, "GET");
        assert!((1..=MAX_RANGE_BYTES).contains(&length), "every read is one bounded range");
        let objects = self.0.objects.lock().unwrap();
        let bytes = objects.get(&(origin.to_owned(), key.to_owned())).ok_or(ObjectError::Refused(404, live_namespace::cause!()))?;
        if offset + length > bytes.len() as u64 {
            return Err(ObjectError::Refused(416, live_namespace::cause!()));
        }
        Ok(bytes[offset as usize..(offset + length) as usize].to_vec())
    }
    fn write(&self, origin: &str, key: &str, bytes: &[u8], media_type: &str) -> Result<(), ObjectError> {
        let mut reader = bytes;
        self.write_stream(origin, key, Body { length: bytes.len() as u64, sha256: [0; 32], bytes: &mut reader }, media_type)
    }
    fn write_stream(&self, origin: &str, key: &str, body: Body<'_>, _: &str) -> Result<(), ObjectError> {
        self.count(origin, "PUT");
        {
            let mut allowed = self.0.puts_allowed.lock().unwrap();
            if let Some(left) = allowed.as_mut() {
                if *left == 0 {
                    return Err(ObjectError::Refused(403, live_namespace::cause!()));
                }
                *left -= 1;
            }
        }
        let mut bytes = Vec::new();
        body.bytes.take(body.length).read_to_end(&mut bytes).map_err(|error| ObjectError::Unavailable(error.to_string(), live_namespace::cause!()))?;
        assert_eq!(bytes.len() as u64, body.length);
        *self.0.puts.lock().unwrap().entry(key.to_owned()).or_default() += 1;
        self.put(origin, key, bytes);
        Ok(())
    }
    fn stat(&self, origin: &str, key: &str) -> Result<Option<Stat>, ObjectError> {
        self.count(origin, "HEAD");
        let objects = self.0.objects.lock().unwrap();
        Ok(objects.get(&(origin.to_owned(), key.to_owned())).map(|bytes| Stat { length: bytes.len() as u64, media_type: Some("application/octet-stream".into()) }))
    }
    fn list(&self, origin: &str, prefix: &str, after: &str, limit: usize) -> Result<Listing, ObjectError> {
        self.count(origin, "LIST");
        let objects = self.0.objects.lock().unwrap();
        let mut keys = objects
            .iter()
            .filter(|((held, key), _)| held == origin && key.starts_with(prefix) && key.as_str() > after)
            .map(|((_, key), bytes)| (key.clone(), bytes.len() as u64));
        let page: Vec<(String, u64)> = keys.by_ref().take(limit).collect();
        Ok(Listing { more: keys.next().is_some(), objects: page })
    }
}

fn id(bytes: &[u8]) -> String {
    format!("1f:{}", advanced::blake3::hash(bytes).to_hex())
}

fn origin(rank: u32) -> Value {
    json!({
        "kind": "namespace-origin", "rank": rank, "file_key_prefix": "people/p/files/",
        "reach": { "key_id": {"held": "k"}, "secret": {"held": "s"}, "bucket": {"value": "b"},
                   "endpoint": {"value": "https://s3.example.test"}, "region": {"value": "r"} }
    })
}

/// What the world holds before a move.
struct World {
    port: Port,
    store: Store,
    /// Every key whose bytes must end at `TO`, with its bytes.
    expected: BTreeMap<String, Vec<u8>>,
    big_file: String,
    split_file: String,
}

fn chunk_record(store: &Store, port: &Port, at: &str, bytes: &[u8]) -> String {
    let chunk = id(bytes);
    let key = format!("people/p/chunks/{chunk}");
    seed(&store, CHUNKS, &[(chunk.clone(), json!({ "kind": "namespace-chunk", "byte_length": bytes.len(), "origin": at, "key": key }))]);
    port.put(at, &key, bytes.to_vec());
    chunk
}

fn file_record(store: &Store, identity: &str, at: &str, key: &str, length: usize, spans: usize) {
    let value = json!({
        "kind": "namespace-file", "byte_length": length, "media_type": "video/mp4", "origin": at, "key": key,
        "stored_at": "2026-10-01T00:00:00.000Z", "checked_at": "2026-10-01T00:00:00.000Z", "spans": spans, "aliases": [], "names": [],
    });
    seed(&store, FILES, &[(identity.to_owned(), value)]);
}

/// A landing store holding: two chunks of a file kept wholly in chunks there, one landing chunk of a file whose other
/// chunk is already in the archive, a small whole file, a whole file one byte past two ranged reads, a key no record
/// names, and a chunk the archive already holds; plus one upload that never finished.
fn world() -> World {
    let port = Port(Arc::new(Stores::default()));
    let store: Store = Arc::new(SqlStore::memory().unwrap());
    seed(&store, ORIGINS, &[(FROM.into(), origin(1)), (TO.into(), origin(2))]);
    let mut expected = BTreeMap::new();

    let (first, second, third, archived) = (vec![1u8; 700], vec![2u8; 900], vec![3u8; 400], vec![4u8; 300]);
    let mut spans = Vec::new();
    for (bytes, at) in [(&first, FROM), (&second, FROM), (&third, FROM), (&archived, TO)] {
        let chunk = chunk_record(&store, &port, at, bytes);
        expected.insert(format!("people/p/chunks/{chunk}"), bytes.clone());
        spans.push(chunk);
    }
    let whole_in_chunks = id(&[first.clone(), second.clone()].concat());
    file_record(&store, &whole_in_chunks, FROM, "", 1600, 2);
    seed(&store, SPANS, &[(whole_in_chunks.clone(), json!({ "kind": "namespace-spans", "spans": [
        {"offset": 0, "length": 700, "chunk": spans[0]}, {"offset": 700, "length": 900, "chunk": spans[1]}] }))]);
    let split = id(&[third.clone(), archived.clone()].concat());
    file_record(&store, &split, FROM, "", 700, 2);
    seed(&store, SPANS, &[(split.clone(), json!({ "kind": "namespace-spans", "spans": [
        {"offset": 0, "length": 400, "chunk": spans[2]}, {"offset": 400, "length": 300, "chunk": spans[3]}] }))]);

    let note = b"a small whole file".to_vec();
    let big: Vec<u8> = (0..(2 * MAX_RANGE_BYTES + 1)).map(|n| (n % 253) as u8).collect();
    let mut big_file = String::new();
    for bytes in [&note, &big] {
        let identity = id(bytes);
        let key = format!("people/p/files/{identity}");
        file_record(&store, &identity, FROM, &key, bytes.len(), 0);
        port.put(FROM, &key, bytes.clone());
        expected.insert(key, bytes.clone());
        big_file = identity;
    }

    // Kept by the hosted Worker beside the files, named by no record.
    let history = b"{\"history\":1}\n".to_vec();
    port.put(FROM, "people/p/record-history/0001.jsonl", history.clone());
    expected.insert("people/p/record-history/0001.jsonl".into(), history);
    // The archive's chunk, also still in the landing store (a move the Worker finished but never cleaned up).
    port.put(FROM, &format!("people/p/chunks/{}", spans[3]), archived.clone());

    seed(&store, UPLOADS, &[("up:1".into(), json!({ "kind": "namespace-upload", "byte_length": 5000, "origin": FROM }))]);
    World { port, store, expected, big_file, split_file: split }
}

/// Put `rows` (id, value) into `scope` as new rows.
fn seed(store: &Store, scope: &str, rows: &[(String, serde_json::Value)]) {
    for (id, value) in rows {
        store.mutate(scope, Mutation { id: id.clone(), expected_version: 0, request_key: format!("seed:{id}"), deleted: false, value: value.clone() }).unwrap();
    }
}

fn plan(dry_run: bool) -> Plan {
    Plan { from: FROM.into(), to: TO.into(), concurrency: 3, unnamed_keys: true, dry_run, records_only: false, budget: None }
}

fn quiet(_: &str, _: &Phase) {}

fn origin_of(store: &Store, scope: &str, id: &str) -> String {
    store.get(scope, id).unwrap().record.unwrap().value["origin"].as_str().unwrap().to_owned()
}

#[test]
fn a_dry_run_counts_from_records_and_sends_nothing() {
    let world = world();
    let report = Mover::new(&world.store, plan(true)).run(&world.port, &quiet).unwrap();
    assert_eq!(world.port.requests(), 0, "a dry run sends no request");
    assert_eq!(report.phases["chunks"].items, 3);
    assert_eq!(report.phases["chunks"].bytes, 700 + 900 + 400);
    assert_eq!(report.phases["whole_files"].items, 2);
    assert_eq!(report.phases["whole_files"].bytes, 18 + 2 * MAX_RANGE_BYTES + 1);
    assert_eq!(report.phases["chunked_files"].items, 2);
    assert_eq!(report.uploads_naming_from, 1);
    // The big file is three ranged reads, read twice at the landing store (hash, then stream); nothing is read back.
    assert_eq!(report.requests[&format!("{FROM} GET")], 3 + 1 + 3 * 2);
    assert_eq!(report.requests[&format!("{TO} PUT")], 5);
    assert_eq!(report.requests[&format!("{TO} HEAD")], 5, "one HEAD of each key's length after its PUT");
    assert!(!report.requests.contains_key(&format!("{TO} GET")) && !report.bytes.contains_key(&format!("{TO} read")), "a copy is never read back");
    let landing = world.store.get(ORIGINS, FROM).unwrap().record.unwrap();
    assert_eq!(landing.version, 1, "a dry run writes no record");
    assert_eq!(origin_of(&world.store, CHUNKS, &id(&[1u8; 700])), FROM);
}

#[test]
fn a_move_proves_every_key_rewrites_records_and_retires_the_emptied_store() {
    let world = world();
    let report = Mover::new(&world.store, plan(false)).run(&world.port, &quiet).unwrap();
    assert_eq!(report.failed, 0, "{:?}", report.failures);
    for (key, bytes) in &world.expected {
        assert_eq!(world.port.held(TO, key).as_ref(), Some(bytes), "{key} is at the archive with its bytes");
    }
    assert!(world.port.0.puts.lock().unwrap().values().all(|puts| *puts == 1), "no key is sent twice");
    assert_eq!(report.phases["chunks"].copied, 3);
    assert_eq!(report.phases["chunks"].records_rewritten, 3);
    assert_eq!(report.phases["whole_files"].copied, 2);
    assert_eq!(report.phases["chunked_files"].records_rewritten, 2);
    assert_eq!(report.phases["unnamed_keys"].copied, 2, "the history key, and the chunk the archive already held (sent again: proving it there would mean reading it back)");
    assert!(!report.requests.contains_key(&format!("{TO} GET")), "a copy is never read back: {:?}", report.requests);
    assert_eq!(origin_of(&world.store, FILES, &world.big_file), TO);
    assert_eq!(origin_of(&world.store, FILES, &world.split_file), TO, "a file whose every chunk is at the archive names it");
    let proof = world.store.get(&moved_scope(FROM), &format!("people/p/files/{}", world.big_file)).unwrap().record.unwrap();
    assert_eq!(proof.value["proof"], UPLOAD_PROOF);
    assert_eq!(proof.value["blake3"], world.big_file.trim_start_matches("1f:"));

    // The emptied store takes no new bytes, though it ranks first and accepts writes.
    let origins = {
        let page = world.store.list_page(ORIGINS, "", 10).unwrap();
        page.items.into_iter().map(|record| (record.id, serde_json::from_value(record.value).unwrap())).collect::<Vec<_>>()
    };
    let audited = audit(&world.store, &world.port, FROM, &mut |_, _, _| {}).unwrap();
    assert!(audited.complete, "{audited:?}");
    assert_eq!(audited.listed, 7);
    assert_eq!(audited.proved, 7);
    retire(&world.store, &world.port, FROM, &mut |_, _, _| {}).unwrap();
    assert!(world.store.get(ORIGINS, FROM).unwrap().record.is_none(), "the emptied store's origin is gone");

    let mut account_files = AccountFiles::with_objects(world.store, ACCOUNT, Box::new(world.port.clone()));
    let wrote = account_files.write_file("/new.txt", b"after the move", "text/plain", &origins).unwrap();
    assert!(world.port.held(TO, &format!("people/p/files/{}", wrote["identity"].as_str().unwrap())).is_some());
    let summary = account_files.files_summary().unwrap();
    assert_eq!(summary["by_origin"][FROM]["files"].as_i64().unwrap_or(0), 0, "{summary}");
    assert_eq!(summary["by_origin"][TO]["files"], 5);
    let read = account_files.read_file(&world.split_file, 390, Some(20)).unwrap();
    assert_eq!(read["bytes_returned"], 20);
}

#[test]
fn bytes_that_do_not_match_their_identity_are_never_sent() {
    let world = world();
    let chunk = id(&[2u8; 900]);
    world.port.put(FROM, &format!("people/p/chunks/{chunk}"), vec![9u8; 900]);
    let report = Mover::new(&world.store, plan(false)).run(&world.port, &quiet).unwrap();
    // Refused once through its chunk record and once more through the store's listing, which names the same key.
    assert_eq!(report.failed, 2);
    let key = format!("people/p/chunks/{chunk}");
    assert!(report.failures.iter().all(|failed| failed.key == key && failed.why.contains("not to the identity")), "{:?}", report.failures);
    assert!(world.port.held(TO, &format!("people/p/chunks/{chunk}")).is_none(), "refused bytes never reach the archive");
    assert_eq!(origin_of(&world.store, CHUNKS, &chunk), FROM);
    let audited = audit(&world.store, &world.port, FROM, &mut |_, _, _| {}).unwrap();
    assert!(!audited.complete);
    assert_eq!(audited.unproved, 1);
    assert!(retire(&world.store, &world.port, FROM, &mut |_, _, _| {}).is_err(), "an incomplete audit refuses retirement");
}

#[test]
fn a_stopped_run_is_finished_by_the_next_without_sending_a_key_twice() {
    let world = world();
    *world.port.0.puts_allowed.lock().unwrap() = Some(2);
    let first = Mover::new(&world.store, plan(false)).run(&world.port, &quiet).unwrap();
    assert!(first.failed > 0);
    assert!(first.budget_spent.as_deref().is_some_and(|why| why.contains("403")), "a refusal of access stops the whole run: {first:?}");
    *world.port.0.puts_allowed.lock().unwrap() = None;
    let second = Mover::new(&world.store, plan(false)).run(&world.port, &quiet).unwrap();
    assert_eq!(second.failed, 0, "{:?}", second.failures);
    let copied = |report: &live_namespace::account_files::moves::Report| report.phases.values().map(|phase| phase.copied).sum::<u64>();
    assert_eq!(copied(&first) + copied(&second), 7, "5 named keys, the history key and the archive's own chunk, each proved once");
    // A key whose PUT landed just before the stop refused its HEAD is unproved, so the next run sends it once more.
    assert!(world.port.0.puts.lock().unwrap().values().all(|puts| *puts <= 2));
    assert!(audit(&world.store, &world.port, FROM, &mut |_, _, _| {}).unwrap().complete);
    let third = Mover::new(&world.store, plan(false)).run(&world.port, &quiet).unwrap();
    assert_eq!(copied(&third), 0, "a finished move has nothing left to send");
}

#[test]
fn a_budget_is_a_hard_stop() {
    let world = world();
    // Room for the first chunk's requests only: the run stops at the cap and sends nothing past it.
    let budget = [(format!("{FROM} GET"), 1), (format!("{FROM} read"), 700), (format!("{TO} PUT"), 1), (format!("{TO} written"), 700), (format!("{TO} HEAD"), 1)]
        .into_iter()
        .collect();
    let plan = Plan { concurrency: 1, budget: Some(budget), ..plan(false) };
    let report = Mover::new(&world.store, plan).run(&world.port, &quiet).unwrap();
    assert!(report.budget_spent.is_some(), "{report:?}");
    assert_eq!(world.port.0.puts.lock().unwrap().len(), 1, "one key was sent before the cap");
    for (counter, used) in &report.requests {
        assert!(*used <= 1, "{counter} passed its cap: {used}");
    }
}

#[test]
fn a_copier_without_records_proves_keys_that_the_store_then_imports() {
    let world = world();
    let (keys, listed) = work_list(&world.store, &world.port, FROM, true, &mut |_, _, _| {}).unwrap();
    assert_eq!(listed, 7);
    assert_eq!(keys.len(), 7, "3 chunks, 2 whole files, the history key, and the archive's chunk the landing store still lists");
    let (planned, budget) = plan_of(&keys, FROM, TO, 110);
    assert!(budget.iter().all(|(name, cap)| *cap >= planned[name]));
    let mut lines = Vec::new();
    let carried = carry_keys(&world.port, Route { from: FROM, to: TO, width: 3 }, Some(budget), keys, |line, _, _| lines.push(line.clone()));
    assert_eq!(carried.failed, 0, "{:?}", carried.failures);
    assert_eq!(carried.budget_spent, None);
    assert_eq!(lines.len(), 7);
    assert_eq!(import_proofs(&world.store, FROM, lines.clone()).unwrap(), (7, 0, 0));
    assert_eq!(import_proofs(&world.store, FROM, lines).unwrap(), (0, 7, 0), "importing again changes nothing");
    let requests_before = world.port.requests();
    let records_only = Plan { records_only: true, unnamed_keys: false, budget: Some(BTreeMap::new()), ..plan(false) };
    let report = Mover::new(&world.store, records_only).run(&world.port, &quiet).unwrap();
    assert_eq!(report.failed, 0);
    assert_eq!(world.port.requests(), requests_before, "a records-only run sends no request");
    assert_eq!(report.phases["chunks"].already_proved, 3);
    assert_eq!(report.phases["chunks"].records_rewritten, 3);
    assert_eq!(report.phases["chunked_files"].records_rewritten, 2);
    assert!(audit(&world.store, &world.port, FROM, &mut |_, _, _| {}).unwrap().complete);
}

/// The vault of the local test server: its throwaway root key (`src/storage/supplies/servers/servers.sh`), answered
/// the way the secrets vault answers (plain facts by name, the SigV4 day key of the secret).
struct TestVault;
impl live_namespace::account_files::objects::Secrets for TestVault {
    fn plain(&self, name: &str) -> Result<zeroize::Zeroizing<String>, ObjectError> {
        match name {
            "k" => Ok(zeroize::Zeroizing::new("minio".into())),
            other => Err(ObjectError::NotHeld(other.into(), live_namespace::cause!())),
        }
    }
    fn sigv4_day_key(&self, name: &str, day: &str) -> Result<zeroize::Zeroizing<Vec<u8>>, ObjectError> {
        use hmac::Mac as _;
        if name != "s" {
            return Err(ObjectError::NotHeld(name.into(), live_namespace::cause!()));
        }
        let mut mac = <hmac::Hmac<sha2::Sha256> as hmac::Mac>::new_from_slice(b"AWS4miniosecret").unwrap();
        mac.update(day.as_bytes());
        Ok(zeroize::Zeroizing::new(mac.finalize().into_bytes().to_vec()))
    }
    fn holds(&self, name: &str) -> Result<bool, ObjectError> {
        Ok(matches!(name, "k" | "s"))
    }
}

/// The same move against a real S3-compatible server on loopback (MinIO: `src/storage/supplies/servers/servers.sh up
/// minio`, or `NAMESPACE_S3_TEST_ENDPOINT`): SigV4 with query strings, HEAD, listing with `start-after` and URL-encoded
/// keys (a key with a space and a plus), a PUT streamed from ranged reads under its signed SHA-256, and HEAD-of-length
/// proofs over HTTP. Run with
/// `--ignored` once the server is up.
#[test]
#[ignore = "needs a local S3-compatible server: src/storage/supplies/servers/servers.sh up minio"]
fn a_move_between_two_buckets_of_a_real_s3_server() {
    use live_namespace::account_files::objects::{Origin, S3Objects};
    let endpoint = std::env::var("NAMESPACE_S3_TEST_ENDPOINT").unwrap_or_else(|_| "http://127.0.0.1:19000".into());
    let run = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
    let origins: Vec<(String, Origin)> = [(FROM, 1), (TO, 2)]
        .into_iter()
        .map(|(id, rank)| {
            let value = json!({
                "kind": "namespace-origin", "rank": rank, "file_key_prefix": "people/p/files/",
                "reach": { "key_id": {"held": "k"}, "secret": {"held": "s"}, "bucket": {"value": format!("{id}-{run}")},
                           "endpoint": {"value": endpoint}, "region": {"value": "us-east-1"} }
            });
            (id.to_owned(), serde_json::from_value(value).unwrap())
        })
        .collect();
    let s3 = S3Objects::unmetered(origins, Box::new(TestVault), "account_files_move real-server test").unwrap();
    let mut world = world();
    world.port.put(FROM, "people/p/record history/a+b c.jsonl", b"{\"history\":2}\n".to_vec());
    world.expected.insert("people/p/record history/a+b c.jsonl".into(), b"{\"history\":2}\n".to_vec());
    for origin in [FROM, TO] {
        // An empty key is the bucket itself: this PUT creates it.
        s3.write(origin, "", &[], "application/octet-stream").unwrap();
    }
    let prefilled: Vec<((String, String), Vec<u8>)> = world.port.0.objects.lock().unwrap().iter().map(|(at, bytes)| (at.clone(), bytes.clone())).collect();
    for ((origin, key), bytes) in &prefilled {
        s3.write(origin, key, bytes, "application/octet-stream").unwrap();
    }
    let listed = s3.list(FROM, "", "", 3).unwrap();
    assert_eq!(listed.objects.len(), 3);
    assert!(listed.more);
    let rest = s3.list(FROM, "", &listed.objects[2].0, 1000).unwrap();
    assert!(!rest.more);
    assert!(rest.objects.iter().chain(&listed.objects).any(|(key, _)| key == "people/p/record history/a+b c.jsonl"), "{rest:?}");

    let report = Mover::new(&world.store, plan(false)).run(&s3, &quiet).unwrap();
    assert_eq!(report.failed, 0, "{:?}", report.failures);
    assert_eq!(report.phases["unnamed_keys"].copied, 3);
    for (key, bytes) in &world.expected {
        assert_eq!(s3.stat(TO, key).unwrap().map(|stat| stat.length), Some(bytes.len() as u64), "{key}");
        let mut there = Vec::new();
        let mut at = 0u64;
        while at < bytes.len() as u64 {
            let take = MAX_RANGE_BYTES.min(bytes.len() as u64 - at);
            there.extend(s3.read(TO, key, at, take).unwrap());
            at += take;
        }
        assert!(&there == bytes, "{key} holds its bytes at the archive bucket");
    }
    let audited = audit(&world.store, &s3, FROM, &mut |_, _, _| {}).unwrap();
    assert!(audited.complete, "{audited:?}");
    assert_eq!(audited.listed, 8);

    // Listing by level: the root holds one prefix; a person's level holds its four kinds of key.
    let root = s3.list_level(FROM, "", "").unwrap().expect("an S3 server lists by level");
    assert_eq!((root.objects.len(), root.prefixes.as_slice(), root.next.as_deref()), (0, ["people/".to_owned()].as_slice(), None));
    let person = s3.list_level(FROM, "people/p/", "").unwrap().unwrap();
    assert_eq!(person.prefixes, ["people/p/chunks/", "people/p/files/", "people/p/record history/", "people/p/record-history/"]);
    // More keys than one page at one level: the level walk follows its continuation token, then they are packed.
    for at in 0..1005 {
        s3.write(FROM, &format!("stores/many/{at:04}"), format!("{at}").as_bytes(), "application/octet-stream").unwrap();
    }
    let first = s3.list_level(FROM, "stores/many/", "").unwrap().unwrap();
    assert_eq!(first.objects.len(), 1000);
    let second = s3.list_level(FROM, "stores/many/", first.next.as_deref().expect("a continuation token")).unwrap().unwrap();
    assert_eq!((second.objects.len(), second.next), (5, None));
    let (keys, listed) = work_list(&world.store, &s3, FROM, true, &mut |_, _, _| {}).unwrap();
    assert_eq!((keys.len(), listed), (1005, 1013), "only the new keys are unproved");
    let packs = pack_plan(keys.into_iter().filter(packs).collect());
    let (_, budget) = plan_of_packs(&packs, FROM, TO, 110).unwrap();
    let mut lines = Vec::new();
    let carried = pack_keys(&s3, FROM, TO, 8, Some(budget), packs, |line, _, _| lines.push(line.clone()));
    assert_eq!((carried.proved, carried.failed, carried.budget_spent), (1005, 0, None), "{:?}", carried.failures);
    assert_eq!(import_proofs(&world.store, FROM, lines).unwrap(), (1005, 0, 0));
    assert!(audit(&world.store, &s3, FROM, &mut |_, _, _| {}).unwrap().complete);

    // The one proof of a copy rests on this: the store refuses a body whose bytes do not hash to the SHA-256
    // signed into the PUT, and keeps nothing.
    let body = b"the bytes that were read".to_vec();
    let mut reader = body.as_slice();
    let signed: [u8; 32] = <sha2::Sha256 as sha2::Digest>::digest(b"other bytes").into();
    assert!(s3.write_stream(TO, "checksum/refused", Body { length: body.len() as u64, sha256: signed, bytes: &mut reader }, "application/octet-stream").is_err());
    assert_eq!(s3.stat(TO, "checksum/refused").unwrap(), None);

    // A denial carries the store's reason (its error Code), so a bad key and a spending cap can be told apart.
    let unknown_key: Vec<(String, Origin)> = [FROM]
        .into_iter()
        .map(|id| {
            let value = json!({
                "kind": "namespace-origin", "rank": 1, "file_key_prefix": "people/p/files/",
                "reach": { "key_id": {"value": "not-a-key"}, "secret": {"held": "s"}, "bucket": {"value": format!("{id}-{run}")},
                           "endpoint": {"value": endpoint}, "region": {"value": "us-east-1"} }
            });
            (id.to_owned(), serde_json::from_value(value).unwrap())
        })
        .collect();
    let denied = S3Objects::unmetered(unknown_key, Box::new(TestVault), "account_files_move real-server test").unwrap().read(FROM, "stores/many/0000", 0, 1).unwrap_err();
    assert!(matches!(&denied, ObjectError::Denied(403, why, _) if why.contains("InvalidAccessKeyId")), "{denied}");
}

#[test]
fn small_keys_are_packed_per_group_and_every_member_is_its_slice_of_its_archive() {
    let mut world = world();
    // Keys no record names, in two groups, one of them empty, and a third group holding only an empty key.
    let small = [
        ("people/p/record-history/0002.jsonl", b"{\"history\":2}\n".to_vec()),
        ("people/p/record-history/0003.jsonl", Vec::new()),
        ("stores/s1/resources/a.json", b"{\"a\":1}".to_vec()),
        ("stores/s2/empty", Vec::new()),
    ];
    for (key, bytes) in &small {
        world.port.put(FROM, key, bytes.clone());
        world.expected.insert((*key).to_owned(), bytes.clone());
    }
    let (keys, _) = work_list(&world.store, &world.port, FROM, true, &mut |_, _, _| {}).unwrap();
    let (unnamed, named): (Vec<_>, Vec<_>) = keys.into_iter().partition(packs);
    assert_eq!(unnamed.len(), 6, "the history key, the archive's chunk the landing store still lists, and the four small keys");
    let packs = pack_plan(unnamed);
    assert_eq!(packs.iter().map(|pack| pack.group.as_str()).collect::<Vec<_>>(), ["people/p/", "stores/s1/", "stores/s2/"]);
    let (planned, budget) = plan_of_packs(&packs, FROM, TO, 110).unwrap();
    assert_eq!(planned[&format!("{FROM} GET")], 4, "an empty key is never read");
    let mut lines = Vec::new();
    let carried = pack_keys(&world.port, FROM, TO, 4, Some(budget), packs, |line, _, _| lines.push(line.clone()));
    assert_eq!((carried.proved, carried.failed, carried.budget_spent.clone()), (6, 0, None), "{:?}", carried.failures);
    for (counter, used) in carried.requests.iter().chain(&carried.bytes) {
        assert!(*used <= planned[counter], "{counter} passed its plan: {used} > {}", planned[counter]);
    }
    // Every member is its slice of its archive at TO, and its manifest lists it with its BLAKE3.
    for line in &lines {
        let packed = line.packed.as_ref().expect("a packed line");
        let manifest: Value = serde_json::from_slice(&world.port.held(TO, &packed.manifest).unwrap()).unwrap();
        let member = manifest["members"].as_array().unwrap().iter().find(|member| member["key"] == line.key.as_str()).unwrap();
        assert_eq!(member["blake3"], line.blake3.as_str());
        let bytes = &world.expected[&line.key];
        assert_eq!(line.blake3, advanced::blake3::hash(bytes).to_hex().as_str());
        match &packed.archive {
            Some(archive) => {
                assert!(archive.starts_with(&format!("{PACKED_ROOT}{FROM}/")));
                let held = world.port.held(TO, archive).unwrap();
                assert_eq!(&held[packed.offset as usize..packed.offset as usize + bytes.len()], bytes.as_slice());
            }
            None => assert!(bytes.is_empty(), "only an empty key is kept by its manifest alone"),
        }
        // (The archive's chunk was in the archive store from the start.)
        if !line.key.contains("/chunks/") {
            assert!(world.port.held(TO, &line.key).is_none(), "a packed key is not kept under its own key");
        }
    }
    let carried = carry_keys(&world.port, Route { from: FROM, to: TO, width: 3 }, None, named, |line, _, _| lines.push(line.clone()));
    assert_eq!(carried.failed, 0, "{:?}", carried.failures);
    let (written, _, refused) = import_proofs(&world.store, FROM, lines).unwrap();
    assert_eq!((written, refused), (11, 0));
    let packed_proof = world.store.get(&moved_scope(FROM), "stores/s2/empty").unwrap().record.unwrap();
    assert!(packed_proof.value["in"]["manifest"].as_str().is_some() && packed_proof.value["in"]["archive"].is_null());
    let report = Mover::new(&world.store, plan(false)).run(&world.port, &quiet).unwrap();
    assert_eq!(report.failed, 0);
    assert!(audit(&world.store, &world.port, FROM, &mut |_, _, _| {}).unwrap().complete);
}

#[test]
fn a_records_only_run_leaves_unproved_keys_and_sends_nothing() {
    let world = world();
    let records_only = Plan { records_only: true, unnamed_keys: false, budget: Some(BTreeMap::new()), ..plan(false) };
    let report = Mover::new(&world.store, records_only).run(&world.port, &quiet).unwrap();
    assert_eq!(world.port.requests(), 0, "no request at all");
    assert_eq!((report.failed, report.budget_spent), (0, None));
    assert_eq!(report.phases["chunks"].unproved + report.phases["whole_files"].unproved, 5, "3 chunks and 2 whole files are left");
    assert_eq!(report.phases.values().map(|phase| phase.records_rewritten).sum::<u64>(), 0);
}

#[test]
fn a_copier_reads_nothing_back_and_its_proofs_import() {
    let world = world();
    let (keys, _) = work_list(&world.store, &world.port, FROM, true, &mut |_, _, _| {}).unwrap();
    let (planned, budget) = plan_of(&keys, FROM, TO, 110);
    assert!(!planned.contains_key(&format!("{TO} GET")) && !planned.contains_key(&format!("{TO} read")), "no read-back is planned");
    let mut lines = Vec::new();
    let carried = carry_keys(&world.port, Route { from: FROM, to: TO, width: 3 }, Some(budget), keys, |line, _, _| lines.push(line.clone()));
    assert_eq!((carried.failed, carried.budget_spent.clone()), (0, None), "{:?}", carried.failures);
    assert!(!carried.requests.contains_key(&format!("{TO} GET")), "nothing was read back: {:?}", carried.requests);
    assert!(lines.iter().all(|line| line.proof == UPLOAD_PROOF));
    for line in &lines {
        assert_eq!(world.port.held(TO, &line.key).as_deref(), Some(world.expected[&line.key].as_slice()));
        assert_eq!(line.blake3, advanced::blake3::hash(&world.expected[&line.key]).to_hex().as_str());
    }
    assert_eq!(import_proofs(&world.store, FROM, lines).unwrap(), (7, 0, 0));
    let records_only = Plan { records_only: true, unnamed_keys: false, budget: Some(BTreeMap::new()), ..plan(false) };
    assert_eq!(Mover::new(&world.store, records_only).run(&world.port, &quiet).unwrap().failed, 0);
    assert!(audit(&world.store, &world.port, FROM, &mut |_, _, _| {}).unwrap().complete);
}
