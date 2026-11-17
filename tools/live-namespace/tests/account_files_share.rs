// tests/account_files_share.rs
//
// Purpose: The one admitted byte handle of the real byte owner (`S3Objects`, SigV4 over plain HTTP) against a stand-in
// S3-compatible store on the loopback address, and the account files' shares: a read with no byte check sends nothing; a
// metered allowance refuses before dispatch when it cannot cover a read or a write and otherwise takes exactly the
// requested bytes; its refill runs off the request path; the explicit unmetered constructor still reads; metering's
// p99 cost over an in-memory read stays within a stated tolerance; a share without its grant-aware delivery owner is
// refused rather than minted as a provider URL.
// Invariants: the stand-in logs every request line it receives. No real store is reached: the endpoint is 127.0.0.1.
// Key concepts: `live_namespace::account_files::{objects::S3Objects, source_reads::{Admission, Allowance, Unmetered},
// CallControl, AccountFiles::share_file}`.
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc, Condvar, Mutex},
    time::{Duration, Instant},
};
use live_namespace::{
    account_files::{
        counters::Registry,
        objects::{Secrets, ObjectError, Objects, Origin, Reach, S3Objects, Source},
        source_reads::{Admission, Allowance, Chunk, Supply, Unmetered},
        CallControl, AccountFiles, AccountFilesError, ORIGINS, SHARES,
    },
    records::{Mutation, Records},
    storage::{
        memory::Memory,
        record_store::{settings, RecordStore, RealClock},
    },
};
use zeroize::Zeroizing;

/// A stand-in for the hold owner: answers `grants` chunks, then refuses; after `open_first` holds it blocks until
/// released (`gate`), as a hold owner whose store is slow or stuck would.
#[derive(Default)]
struct Lessor {
    grants: AtomicUsize,
    held: AtomicUsize,
    settled: Mutex<Vec<u64>>,
    /// (blocking from this hold on, released, a hold is waiting)
    gate: Option<(usize, Mutex<bool>, Condvar, AtomicBool)>,
}
struct Held(Arc<Lessor>);
impl Chunk for Held {
    fn settle(self: Box<Self>, consumed: u64) -> Result<(), ObjectError> {
        self.0.settled.lock().unwrap().push(consumed);
        Ok(())
    }
}
struct Supplied(Arc<Lessor>);
impl Supply for Supplied {
    fn hold(&self, _bytes: u64) -> Result<Box<dyn Chunk>, ObjectError> {
        let lessor = &self.0;
        if let Some((from, released, wake, waiting)) = &lessor.gate {
            if lessor.held.load(Ordering::SeqCst) >= *from {
                waiting.store(true, Ordering::SeqCst);
                let mut open = released.lock().unwrap();
                while !*open { open = wake.wait(open).unwrap(); }
            }
        }
        if lessor.grants.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)).is_err() {
            return Err(ObjectError::Unavailable("synthetic lessor has nothing left".into(), live_namespace::cause!()));
        }
        lessor.held.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(Held(lessor.clone())))
    }
}
fn allowance(lessor: &Arc<Lessor>, chunk: u64, low_water: u64, registry: &Registry) -> Arc<Allowance> {
    Allowance::open(Arc::new(Supplied(lessor.clone())), chunk, low_water, registry).unwrap()
}
fn lessor(grants: usize) -> Arc<Lessor> {
    Arc::new(Lessor { grants: AtomicUsize::new(grants), ..Default::default() })
}
fn control(admission: Admission) -> CallControl {
    CallControl::new(Instant::now() + Duration::from_secs(10), Arc::new(|| true), admission)
}
fn gets(kept: &Kept) -> usize {
    kept.requests.lock().unwrap().iter().filter(|line| line.starts_with("GET ")).count()
}
fn puts(kept: &Kept) -> usize {
    kept.requests.lock().unwrap().iter().filter(|line| line.starts_with("PUT ")).count()
}

/// The account's files as trillion-local opens them (`AccountFiles::open`: the origin records in the store, the port built
/// inside the account files with no byte check of its own), over one stand-in store.
fn opened(endpoint: &str) -> (AccountFiles<Memory>, Vec<(String, Origin)>) {
    let mut store = record_store();
    store.mutate(ACCOUNT, ORIGINS, Mutation { id: "stand-in".into(), expected_version: 0, request_key: "origin".into(),
        deleted: false, value: serde_json::to_value(origin(endpoint)).unwrap() }).unwrap();
    let account_files = AccountFiles::open(store, ACCOUNT, Box::new(Vault(HashMap::new()))).unwrap();
    let origins = account_files.origins().unwrap();
    (account_files, origins)
}

/// A port over one stand-in store whose every byte request is admitted by the byte check it is given.
fn admitted_objects(endpoint: &str, admission: Admission, current: Arc<dyn Fn() -> bool + Send + Sync>) -> S3Objects {
    // The port's own fallback is never used here: the control always names a byte check.
    let mut objects = S3Objects::unmetered(vec![("stand-in".into(), origin(endpoint))], Box::new(Vault(HashMap::new())),
        "account_files_share stand-in port; its control names the admission").unwrap();
    objects.set_control(CallControl::new(Instant::now() + Duration::from_secs(5), current, admission));
    objects
}

#[test]
fn a_read_or_write_with_no_admission_or_a_live_control_naming_none_sends_no_request() {
    let (endpoint, kept) = stand_in();
    let (mut account_files, origins) = opened(&endpoint);
    // A write with no byte check is refused before its PUT, under the default control and a control naming none.
    for control in [CallControl::default(), control(Admission::none())] {
        account_files = account_files.with_control(control);
        let answer = account_files.write_file("/a.txt", b"0123456789", "text/plain", &origins);
        assert!(matches!(&answer, Err(AccountFilesError::Objects(ObjectError::Unavailable(why, _), _)) if why.contains("write admission")), "{answer:?}");
    }
    assert!(kept.requests.lock().unwrap().is_empty(), "no write reached the store");
    // Kept under a named unmetered byte check, then read with none.
    account_files = account_files.with_control(control(Unmetered::new("account_files_share keeps the file a refused read names").into()));
    account_files.write_file("/a.txt", b"0123456789", "text/plain", &origins).unwrap();
    assert_eq!(puts(&kept), 1);
    for control in [CallControl::default(), control(Admission::none())] {
        account_files = account_files.with_control(control);
        for tool in ["read_file", "show_file"] {
            let answer = account_files.call(tool, &json!({"name_or_identity": "/a.txt"})).unwrap();
            assert!(matches!(&answer, Err(AccountFilesError::Objects(ObjectError::Unavailable(why, _), _)) if why.contains("read admission")), "{answer:?}");
        }
    }
    assert_eq!(gets(&kept), 0, "no read reached the store");
    assert_eq!(kept.requests.lock().unwrap().len(), 1, "only the admitted write's PUT");
}

#[test]
fn an_exhausted_allowance_refuses_before_dispatch_and_a_funded_read_takes_exactly_its_bytes() {
    let (endpoint, kept) = stand_in();
    let registry = Registry::default();
    let lessor = lessor(1);
    let allowance = allowance(&lessor, 100, 0, &registry);
    let (account_files, origins) = opened(&endpoint);
    let bytes: Vec<u8> = (0..200u8).map(|n| b'a' + n % 26).collect();
    // Kept under a named unmetered byte check before the metered control applies.
    let mut account_files = account_files.with_control(control(Unmetered::new("account_files_share keeps the file a metered read takes").into()));
    let identity = account_files.write_file("/a.txt", &bytes, "text/plain", &origins).unwrap()["identity"].as_str().unwrap().to_owned();
    let account_files = account_files.with_control(control(allowance.clone().into()));
    let file = account_files.store.get(ACCOUNT, live_namespace::account_files::FILES, &identity).unwrap().record.unwrap();

    assert_eq!(account_files.read_range(&file, 2, 4).unwrap(), &bytes[2..6]);
    assert_eq!(allowance.resident(), 96, "exactly the requested bytes were taken");
    assert_eq!(gets(&kept), 1);
    assert_eq!(registry.snapshot()["namespace.bytes.metered.read_observed"], 4, "the payload, without response headers");

    // 97 bytes cannot be covered by the 96 left, and no further chunk is granted: refused before any request.
    assert!(account_files.read_range(&file, 0, 97).is_err());
    assert_eq!(gets(&kept), 1, "the store was never asked");
    assert_eq!(allowance.resident(), 96, "a refusal takes nothing");
    assert_eq!(registry.snapshot()["namespace.bytes.metered.refused"], 1);
    // An offset past its bound is refused before the byte check and before any request.
    let objects = admitted_objects(&endpoint, allowance.clone().into(), Arc::new(|| true));
    assert!(objects.read("stand-in", "one", u64::MAX, 2).is_err());
    assert_eq!(allowance.resident(), 96);
    assert_eq!(gets(&kept), 1);
}

#[test]
fn writes_are_metered_the_same_way() {
    let (endpoint, kept) = stand_in();
    let registry = Registry::default();
    let allowance = allowance(&lessor(1), 10, 0, &registry);
    let (account_files, origins) = opened(&endpoint);
    let mut account_files = account_files.with_control(control(allowance.clone().into()));
    account_files.write_file("/a.txt", b"four", "text/plain", &origins).unwrap();
    assert_eq!(allowance.resident(), 6, "exactly the written bytes were taken");
    assert_eq!(puts(&kept), 1);
    assert_eq!(registry.snapshot()["namespace.bytes.metered.written"], 4);
    let refused = account_files.write_file("/b.txt", b"seven b", "text/plain", &origins);
    assert!(refused.is_err(), "{refused:?}");
    assert_eq!(puts(&kept), 1, "the store was never asked");
    assert_eq!(allowance.resident(), 6);
    assert!(account_files.find_file("/b.txt").is_err(), "nothing was named");
    // The streamed write of the same port is admitted the same way.
    let objects = admitted_objects(&endpoint, allowance.clone().into(), Arc::new(|| true));
    let body = vec![1u8; 7];
    let answer = objects.write_stream("stand-in", "big", live_namespace::account_files::objects::Body {
        length: 7, sha256: Sha256::digest(&body).into(), bytes: &mut body.as_slice() }, "application/octet-stream");
    assert!(answer.is_err());
    assert_eq!(puts(&kept), 1);
}

#[test]
fn refill_and_settlement_run_off_the_request_path() {
    let (endpoint, kept) = stand_in();
    kept.objects.lock().unwrap().insert("/bucket/one".into(), vec![7; 64]);
    let registry = Registry::default();
    // The first chunk is granted; every later hold blocks until released.
    let lessor = Arc::new(Lessor { grants: AtomicUsize::new(3), gate: Some((1, Mutex::new(false), Condvar::new(), AtomicBool::new(false))), ..Default::default() });
    let allowance = allowance(&lessor, 64, 60, &registry);
    let objects = admitted_objects(&endpoint, allowance.clone().into(), Arc::new(|| true));
    let started = Instant::now();
    assert_eq!(objects.read("stand-in", "one", 0, 8).unwrap(), vec![7; 8]);
    // The balance fell below its low-water mark: the refill thread is now stuck in its hold.
    let (_, released, wake, waiting) = lessor.gate.as_ref().unwrap();
    while !waiting.load(Ordering::SeqCst) {
        assert!(started.elapsed() < Duration::from_secs(5), "the refill was asked for");
        std::thread::sleep(Duration::from_millis(1));
    }
    for _ in 0..5 {
        assert_eq!(objects.read("stand-in", "one", 8, 8).unwrap(), vec![7; 8], "a funded read never waits on the hold");
    }
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(allowance.resident(), 64 - 48);
    assert_eq!(lessor.held.load(Ordering::SeqCst), 1, "the second hold is still blocked");
    *released.lock().unwrap() = true;
    wake.notify_all();
    while allowance.resident() < 64 {
        assert!(started.elapsed() < Duration::from_secs(5), "the refill lands off the path");
        std::thread::sleep(Duration::from_millis(1));
    }
    // Settlement is the thread's too: once the first chunk is used up it is settled, whole, by that thread.
    while lessor.settled.lock().unwrap().is_empty() {
        assert_eq!(objects.read("stand-in", "one", 0, 16).unwrap().len(), 16);
        assert!(started.elapsed() < Duration::from_secs(5), "the used-up chunk is settled");
    }
    assert_eq!(lessor.settled.lock().unwrap()[0], 64);
}

#[test]
fn a_dropped_allowance_settles_its_remaining_chunk_as_consumed() {
    let lessor = lessor(1);
    let allowance = allowance(&lessor, 1000, 0, &Registry::default());
    Admission::from(allowance.clone()).admit_write(10).unwrap();
    drop(allowance);
    let started = Instant::now();
    while lessor.settled.lock().unwrap().is_empty() {
        assert!(started.elapsed() < Duration::from_secs(5), "the dropped handle's chunk is settled");
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(lessor.settled.lock().unwrap().as_slice(), &[1000], "the unused 990 bytes count as consumed, never as unused");
}

#[test]
fn the_explicit_unmetered_constructor_still_reads() {
    let (endpoint, kept) = stand_in();
    kept.objects.lock().unwrap().insert("/bucket/one".into(), b"0123456789".to_vec());
    let objects = S3Objects::unmetered(vec![("stand-in".into(), origin(&endpoint))], Box::new(Vault(HashMap::new())),
        "account_files_share unmetered constructor test").unwrap();
    assert_eq!(objects.read("stand-in", "one", 2, 4).unwrap(), b"2345");
    let (mut account_files, origins) = account_files(&endpoint);
    account_files.write_file("/a.txt", b"unmetered", "text/plain", &origins).unwrap();
    let mut account_files = account_files.until(Instant::now() + Duration::from_secs(5));
    let read = account_files.call("read_file", &json!({"name_or_identity": "/a.txt"})).unwrap().unwrap();
    assert_eq!(read["content"], "unmetered");
    assert_eq!(gets(&kept), 2);
}

/// The admitted handle counts the account's own stored and source bytes, and a flush adds them to the account's own
/// day row, which `usage_days` reads back with the store's stored level. A handle with no byte check counts nothing.
#[test]
fn the_admitted_handle_counts_the_accounts_stored_and_source_bytes_into_its_own_day_row() {
    use live_namespace::account_files::usage::{self, Counts, Meters};
    let (endpoint, kept) = stand_in();
    // The account routes' own port (`AccountFiles::open`): no unmetered fallback, so the control's byte check is the only one.
    let (account_files, origins) = opened(&endpoint);
    let meters = Meters::default();
    let tally = meters.tally(std::path::Path::new("/synthetic-state"), ACCOUNT);
    let mut account_files = account_files.with_control(control(Unmetered::new("account_files_share usage count").into()).counting(tally.clone()));
    account_files.write_file("/a.txt", b"0123456789", "text/plain", &origins).unwrap();
    let read = account_files.call("read_file", &json!({"name_or_identity": "/a.txt", "offset": 2, "length": 4})).unwrap().unwrap();
    assert_eq!(read["content"], "2345");
    assert_eq!(gets(&kept), 1);
    assert_eq!(tally.peek(), Counts { stored_bytes_written: 10, source_bytes_read: 4, work_ms: 0, tool_runs: 0, ..Counts::default() });
    tally.worked(25);

    let day = usage::add_to_day(&mut account_files.store, ACCOUNT, "2026-11-03", "2026-11-03T21:00:00.000Z", &tally.peek()).unwrap();
    assert_eq!((day["stored_bytes"].as_u64(), day["stored_bytes_written"].as_u64(), day["source_bytes_read"].as_u64(), day["work_ms"].as_u64()),
        (Some(10), Some(10), Some(4), Some(25)));
    let page = account_files.call("usage_days", &json!({})).unwrap().unwrap();
    assert_eq!(page["days"][0]["day"], "2026-11-03");
    assert_eq!(page["days"][0]["source_bytes_read"], 4);
    assert_eq!(page["stored_bytes_now"], 10);
    assert!(page["days"][0].get("price").is_none() && page["days"][0].get("margin").is_none(), "no price in the engine's rows");

    // No byte check: nothing is sent, so nothing is counted.
    let idle = meters.tally(std::path::Path::new("/synthetic-state"), "idle-account");
    let mut refused = account_files.with_control(control(Admission::none()).counting(idle.clone()));
    assert!(refused.call("read_file", &json!({"name_or_identity": "/a.txt"})).unwrap().is_err());
    assert_eq!(idle.peek(), Counts::default());
}

/// A store stat (HEAD) or key listing carries no file bytes, but asks the same admission as a read: with none it is
/// refused before any request; a metered allowance takes the listing's bound and gets back what the answer did not
/// carry; and each one is the account's own usage count (`stat_requests`, `list_requests`, `listed_bytes`).
#[test]
fn listing_and_stat_requests_are_admitted_and_metered() {
    use live_namespace::account_files::usage::Meters;
    let (endpoint, kept) = stand_in();
    let (account_files, origins) = opened(&endpoint);
    let mut account_files = account_files.with_control(control(Unmetered::new("account_files_share keeps a file to stat").into()));
    account_files.write_file("/a.txt", b"0123456789", "text/plain", &origins).unwrap();
    let requests = kept.requests.lock().unwrap().len();

    let registry = Registry::default();
    let lessor = lessor(4);
    let funded = allowance(&lessor, 16 << 20, 0, &registry);
    let meters = Meters::default();
    let tally = meters.tally(std::path::Path::new("/synthetic-state"), ACCOUNT);
    let metered = Admission::from(funded.clone()).counting(tally.clone());
    let mut objects = S3Objects::unmetered(vec![("stand-in".into(), origin(&endpoint))], Box::new(Vault(HashMap::new())),
        "account_files_share lookups; its control names the admission").unwrap();
    // The control names a metered allowance, so the port's named fallback is never used.
    objects.set_control(control(metered));
    let key = kept.objects.lock().unwrap().keys().next().unwrap().strip_prefix("/bucket/").unwrap().replace("%3A", ":");
    let before = funded.resident();
    assert_eq!(objects.stat("stand-in", &key).unwrap().map(|stat| stat.length), Some(10));
    assert_eq!(funded.resident(), before, "a HEAD carries no body bytes");
    let listing = objects.list("stand-in", "", "", 10).unwrap();
    assert_eq!(listing.objects.len(), 1);
    let carried = registry.snapshot()["namespace.bytes.metered.listed_bytes"];
    assert!(carried > 0 && carried < 1024, "{carried}");
    assert_eq!(funded.resident(), before - carried, "the listing's bound was taken and all it did not carry given back");
    assert_eq!(registry.snapshot()["namespace.bytes.metered.stat_requests"], 1);
    assert_eq!(registry.snapshot()["namespace.bytes.metered.list_requests"], 1);
    let counts = tally.peek();
    assert_eq!((counts.stat_requests, counts.list_requests, counts.listed_bytes), (1, 1, carried));
    assert_eq!(kept.requests.lock().unwrap().len(), requests + 2);

    // An allowance that cannot cover the listing's bound refuses it before any request.
    let small = Admission::from(allowance(&lessor, 1024, 0, &registry));
    objects.set_control(control(small));
    assert!(objects.list("stand-in", "", "", 10).is_err());
    assert_eq!(kept.requests.lock().unwrap().len(), requests + 2, "no request was sent");
}

/// No admission refuses a stat and a listing (the door's own port asks it before any request, as for a read).
#[test]
fn a_stat_or_listing_with_no_admission_is_refused() {
    use live_namespace::account_files::source_reads::Lookup;
    assert!(Admission::none().admit_lookup(Lookup::Stat, 0).is_err());
    assert!(Admission::none().admit_lookup(Lookup::List, 1).is_err());
    assert!(Admission::from(Unmetered::new("account_files_share lookups unmetered")).admit_lookup(Lookup::List, 1).is_ok());
}

/// A deterministic in-memory port that admits every read through its control, as the real byte owner does.
struct Memory64 {
    bytes: Vec<u8>,
    control: CallControl,
}
impl Objects for Memory64 {
    fn set_control(&mut self, control: CallControl) { self.control = control; }
    fn read(&self, origin: &str, _: &str, offset: u64, length: u64) -> Result<Vec<u8>, ObjectError> {
        use live_namespace::account_files::source_reads::{ReadOutcome, SourceRead, SourceReadObservation};
        let admission = self.control.admission();
        admission.admit_read(&SourceRead { origin: origin.to_owned(), offset, requested_bytes: length })?;
        let bytes = self.bytes[offset as usize..(offset + length) as usize].to_vec();
        admission.observed_read(&SourceReadObservation { request_started: true, response_status: Some(206),
            source_body_bytes_observed: Some(length), bytes_returned: length, outcome: ReadOutcome::Complete });
        Ok(bytes)
    }
    fn write(&self, _: &str, _: &str, _: &[u8], _: &str) -> Result<(), ObjectError> { unreachable!() }
    fn write_stream(&self, _: &str, _: &str, _: live_namespace::account_files::objects::Body<'_>, _: &str) -> Result<(), ObjectError> { unreachable!() }
    fn stat(&self, _: &str, _: &str) -> Result<Option<live_namespace::account_files::objects::Stat>, ObjectError> { unreachable!() }
    fn list(&self, _: &str, _: &str, _: &str, _: usize) -> Result<live_namespace::account_files::objects::Listing, ObjectError> { unreachable!() }
}

/// The p99 of the same in-memory 4 KiB read with a metered allowance (refilled off the path every 16,384 reads) and with
/// a no-op (named unmetered) byte check, interleaved over many iterations, differs by at most `TOLERANCE`.
#[test]
fn metering_adds_at_most_a_small_tolerance_to_the_p99_of_an_in_memory_read() {
    const TOLERANCE: Duration = Duration::from_micros(5);
    const ITERATIONS: usize = 50_000;
    const READ: u64 = 4096;
    let bytes = vec![3u8; 64 * 1024];
    // 64 MiB chunks refilled below 48 MiB: 12,288 reads (milliseconds) of headroom while the refill thread is
    // scheduled on a busy machine; the run still crosses the low-water mark and refills off the path.
    let allowance = allowance(&lessor(usize::MAX), 64 * 1024 * 1024, 48 * 1024 * 1024, &Registry::default());
    let mut metered = Memory64 { bytes: bytes.clone(), control: CallControl::default() };
    metered.set_control(control(allowance.clone().into()));
    let mut unmetered = Memory64 { bytes, control: CallControl::default() };
    unmetered.set_control(control(Unmetered::new("account_files_share p99 baseline").into()));
    let (mut with, mut without) = (Vec::with_capacity(ITERATIONS), Vec::with_capacity(ITERATIONS));
    for round in 0..ITERATIONS + 1_000 {
        let offset = (round as u64 * READ) % (64 * 1024);
        let at = Instant::now();
        let a = metered.read("o", "k", offset, READ).expect("a funded read");
        let metered_took = at.elapsed();
        let at = Instant::now();
        let b = unmetered.read("o", "k", offset, READ).unwrap();
        let unmetered_took = at.elapsed();
        assert_eq!(a, b);
        if round >= 1_000 { with.push(metered_took); without.push(unmetered_took); }
    }
    let p99 = |samples: &mut Vec<Duration>| { samples.sort_unstable(); samples[samples.len() * 99 / 100] };
    let (with, without) = (p99(&mut with), p99(&mut without));
    eprintln!("p99 metered {with:?}, unmetered {without:?}, tolerance {TOLERANCE:?}");
    assert!(with <= without + TOLERANCE, "metered p99 {with:?} vs unmetered {without:?}");
}

#[test]
fn cancelled_partial_source_read_keeps_received_payload_and_no_returned_bytes() {
    let current = Arc::new(AtomicBool::new(true));
    let (endpoint, server) = response_once(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 20\r\nContent-Range: bytes 0-19/20\r\n\r\nfirst".to_vec(), Some(current.clone()));
    let registry = Registry::default();
    let allowance = allowance(&lessor(1), 100, 0, &registry);
    let objects = admitted_objects(&endpoint, allowance.clone().into(), Arc::new(move || current.load(Ordering::Acquire)));
    assert!(objects.read("stand-in", "one", 0, 20).is_err());
    server.join().unwrap();
    let counted = registry.snapshot();
    assert!(counted["namespace.bytes.metered.read_observed"] >= 5, "received payload is counted: {counted:?}");
    assert_eq!(counted["namespace.bytes.metered.read_failed"], 1);
    assert_eq!(allowance.resident(), 80, "the admitted range stays consumed");
}

#[test]
fn incomplete_response_head_is_unknown_not_zero_and_whole_object_response_is_refused() {
    for (response, unknown) in [
        (b"HTTP/1.1 206".to_vec(), 1),
        (b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\ndata".to_vec(), 0),
    ] {
        let (endpoint, server) = response_once(response, None);
        let registry = Registry::default();
        let allowance = allowance(&lessor(1), 100, 0, &registry);
        let objects = admitted_objects(&endpoint, allowance.into(), Arc::new(|| true));
        assert!(objects.read("stand-in", "one", 0, 2).is_err());
        server.join().unwrap();
        let counted = registry.snapshot();
        assert_eq!(counted["namespace.bytes.metered.read_failed"], 1);
        assert_eq!(counted["namespace.bytes.metered.read_unknown"], unknown, "{counted:?}");
        if unknown == 1 { assert_eq!(counted["namespace.bytes.metered.read_observed"], 0, "unknown is never a measured zero"); }
    }
}

#[test]
fn a_share_with_no_delivery_owner_is_refused_rather_than_minting_a_provider_url() {
    let (endpoint, kept) = stand_in();
    let (mut account_files, origins) = account_files(&endpoint);
    account_files.write_file("/a.txt", b"data", "text/plain", &origins).unwrap();
    let before = kept.requests.lock().unwrap().len();
    let answer = account_files.call("share_file", &json!({ "name_or_identity": "/a.txt", "seconds": 600 })).unwrap();
    assert!(matches!(&answer, Err(AccountFilesError::Invalid(why, _)) if why.contains("delivery owner")), "{answer:?}");
    assert_eq!(kept.requests.lock().unwrap().len(), before, "nothing reached the store");
    assert!(account_files.store.list_page(ACCOUNT, SHARES, "", 100).unwrap().items.is_empty(), "nothing audited");
}

#[test]
fn a_mediated_chunked_share_audits_only_its_grant() {
    use live_namespace::account_files::{FILES, FILE_KIND};
    let (endpoint, _) = stand_in();
    let (mut account_files, _) = account_files(&endpoint);
    let identity = format!("1f:{}", "b".repeat(64));
    account_files.store.mutate(ACCOUNT, FILES, Mutation { id: identity.clone(), expected_version: 0,
        request_key: "synthetic-chunk-share".into(), deleted: false,
        value: json!({"kind":FILE_KIND,"byte_length":9,"media_type":"text/plain","spans":2,"names":[]}) }).unwrap();
    let minted = Arc::new(Mutex::new(Vec::new()));
    account_files = account_files.with_share_delivery(Arc::new(GrantDelivery { minted: minted.clone(), current: None }));
    let shared = account_files.share_file(&identity, 60).unwrap();
    let calls = minted.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0.identity, identity);
    assert_eq!(calls[0].0.byte_length, 9);
    assert_eq!(calls[0].1, 60);
    let audit = account_files.store.list_page(ACCOUNT, SHARES, "", 100).unwrap();
    assert_eq!(audit.items.len(), 1);
    assert_eq!(audit.items[0].value["grant_id"], "sharing:synthetic");
    assert_eq!(audit.items[0].value["delivery"], "grant-bound");
    assert_eq!(audit.items[0].value["identity"], identity);
    assert!(audit.items[0].value.get("origin").is_none());
    assert!(!audit.items[0].value.to_string().contains("synthetic-bearer"));
    assert!(shared["url"].as_str().unwrap().contains("synthetic-bearer"));
}

/// One deliberately malformed or partial response, with no real supplier.
fn response_once(response: Vec<u8>, withdraw: Option<Arc<std::sync::atomic::AtomicBool>>) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        loop { line.clear(); reader.read_line(&mut line).unwrap(); if line == "\r\n" { break; } }
        stream.write_all(&response).unwrap();
        stream.flush().unwrap();
        if let Some(current) = withdraw {
            std::thread::sleep(std::time::Duration::from_millis(50));
            current.store(false, std::sync::atomic::Ordering::Release);
            // The blocked read sees physical bytes before its fresh rights
            // check refuses; their count must not disappear with that error.
            let _ = stream.write_all(b"later");
        }
    });
    (endpoint, server)
}

#[test]
fn mediated_share_withdrawal_during_mint_never_returns_or_audits_url() {
    let (endpoint, _) = stand_in();
    let (mut account_files, origins) = account_files(&endpoint);
    account_files.write_file("/a.txt", b"data", "text/plain", &origins).unwrap();
    let current = Arc::new(AtomicBool::new(true));
    let witness = current.clone();
    account_files = account_files.until(Instant::now() + Duration::from_secs(5))
        .while_current(Arc::new(move || witness.load(Ordering::Acquire)))
        .with_share_delivery(Arc::new(GrantDelivery { minted: Arc::default(), current: Some(current) }));
    assert!(account_files.share_file("/a.txt", 60).is_err());
    assert!(account_files.store.list_page(ACCOUNT, SHARES, "", 100).unwrap().items.is_empty());
}

#[test]
fn a_share_asks_for_its_seconds_within_their_bounds() {
    let (endpoint, _) = stand_in();
    let (mut account_files, origins) = account_files(&endpoint);
    account_files.write_file("/a.txt", b"x", "text/plain", &origins).unwrap();
    for input in [
        json!({ "name_or_identity": "/a.txt" }),
        json!({ "name_or_identity": "/a.txt", "seconds": 0 }),
        json!({ "name_or_identity": "/a.txt", "seconds": 604801 }),
    ] {
        let answer: Result<Value, _> = account_files.call("share_file", &input).unwrap();
        assert!(matches!(answer, Err(AccountFilesError::Invalid(_, _))), "{input}: {answer:?}");
    }
    let missing = account_files.call("share_file", &json!({ "name_or_identity": "/none.txt", "seconds": 60 })).unwrap();
    assert!(matches!(missing, Err(AccountFilesError::NotFound(_))), "{missing:?}");
}

/// Real TCP PUT, with a real run capability dropped by its source reader
/// between body chunks. No later chunk may be sent; accepted earlier bytes
/// are not claimed to have been undone at the remote object owner.
#[test]
fn account_files_socket_stops_put_chunks_when_the_run_drops() {
    use live_namespace::account_files::objects::Body;
    use std::sync::atomic::{AtomicBool, Ordering};
    struct SourceBytes { bytes: std::io::Cursor<Vec<u8>>, capability: Option<Arc<AtomicBool>>, reads: usize }
    impl Read for SourceBytes {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            self.reads += 1;
            if self.reads == 2 { if let Some(current) = self.capability.take() { current.store(false, Ordering::SeqCst); } }
            self.bytes.read(out)
        }
    }
    for revoke in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new(); let mut length = 0;
            reader.read_line(&mut line).unwrap(); assert!(line.starts_with("PUT "));
            loop {
                line.clear(); reader.read_line(&mut line).unwrap();
                if line == "\r\n" { break; }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length: ") { length = value.trim().parse::<usize>().unwrap(); }
            }
            let mut received = 0; let mut bytes = [0; 8192];
            while received < length {
                let read = reader.read(&mut bytes).unwrap(); if read == 0 { break; }
                received += read;
            }
            if received == length { reader.get_mut().write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").unwrap(); }
            (received, length)
        });
        let capability = Arc::new(AtomicBool::new(true));
        let current: Arc<dyn Fn() -> bool + Send + Sync> = { let capability = capability.clone(); Arc::new(move || capability.load(Ordering::SeqCst)) };
        let control = CallControl::new(Instant::now() + Duration::from_secs(5), current, Admission::none());
        let dropping = if revoke { Some(capability) } else { None };
        let mut source = SourceBytes { bytes: std::io::Cursor::new(vec![42; 512 * 1024]), capability: dropping, reads: 0 };
        let mut objects = S3Objects::unmetered(vec![("stand-in".into(), origin(&endpoint))], Box::new(Vault(HashMap::new())), "account_files_share PUT withdrawal test").unwrap();
        objects.set_control(control);
        let answer = objects.write_stream("stand-in", "one", Body { length: 512 * 1024,
            sha256: Sha256::digest(vec![42; 512 * 1024]).into(), bytes: &mut source }, "application/octet-stream");
        let (received, length) = server.join().unwrap();
        if revoke { assert!(answer.is_err()); assert!(received > 0 && received < length); }
        else { assert!(answer.is_ok(), "{answer:?}"); assert_eq!(received, length); }
    }
}

const ACCOUNT: &str = "account-a";
/// A synthetic secret for the stand-in store; it opens nothing real.
const SECRET: &str = "stand-in-secret-for-tests-only";

/// What the stand-in store keeps (path -> bytes) and every request line it received.
#[derive(Default)]
struct Kept {
    objects: Mutex<HashMap<String, Vec<u8>>>,
    requests: Mutex<Vec<String>>,
}

/// A stand-in S3-compatible store on the loopback address: PUT keeps a body, HEAD answers its length, GET with a
/// `Range` answers 206 with that range, GET without one answers 200 with the whole object. It checks no signature
/// (the clone proof does that against a real S3-compatible server).
fn stand_in() -> (String, Arc<Kept>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let kept = Arc::new(Kept::default());
    let held = kept.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            answer(stream, &held);
        }
    });
    (format!("http://{address}"), kept)
}

fn answer(stream: TcpStream, kept: &Kept) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let mut headers = HashMap::new();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).unwrap();
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    kept.requests.lock().unwrap().push(line.trim_end().to_owned());
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or_default(), parts.next().unwrap_or_default());
    let path = target.split('?').next().unwrap_or_default().to_owned();
    let mut out = stream;
    let mut reply = |status: &str, extra: String, body: &[u8]| {
        let head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n", body.len());
        out.write_all(head.as_bytes()).unwrap();
        out.write_all(body).unwrap();
    };
    match method {
        "PUT" => {
            let length: usize = headers.get("content-length").and_then(|value| value.parse().ok()).unwrap_or(0);
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            kept.objects.lock().unwrap().insert(path, body);
            reply("200 OK", String::new(), b"");
        }
        "HEAD" => match kept.objects.lock().unwrap().get(&path) {
            Some(bytes) => {
                let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len());
                out.write_all(head.as_bytes()).unwrap();
            }
            None => reply("404 Not Found", String::new(), b""),
        },
        _ if target.contains("list-type=2") => {
            let objects = kept.objects.lock().unwrap();
            let contents: String = objects.iter().map(|(key, bytes)| format!("<Contents><Key>{}</Key><Size>{}</Size></Contents>",
                key.strip_prefix("/bucket/").unwrap_or(key), bytes.len())).collect();
            reply("200 OK", String::new(), format!("<ListBucketResult><IsTruncated>false</IsTruncated>{contents}</ListBucketResult>").as_bytes());
        }
        _ => {
            let objects = kept.objects.lock().unwrap();
            let Some(bytes) = objects.get(&path) else { return reply("404 Not Found", String::new(), b"") };
            match headers.get("range").and_then(|range| range.strip_prefix("bytes=")).and_then(|span| span.split_once('-')) {
                Some((from, to)) => {
                    let (from, to): (usize, usize) = (from.parse().unwrap(), to.parse::<usize>().unwrap().min(bytes.len() - 1));
                    reply("206 Partial Content", format!("Content-Range: bytes {from}-{to}/{}\r\n", bytes.len()), &bytes[from..=to]);
                }
                None => reply("200 OK", String::new(), bytes),
            }
        }
    }
}

/// The vault as the byte owner needs it: plain facts by name and the SigV4 day key of the one synthetic secret.
struct Vault(HashMap<String, String>);
impl Secrets for Vault {
    fn plain(&self, name: &str) -> Result<Zeroizing<String>, ObjectError> {
        self.0.get(name).map(|value| Zeroizing::new(value.clone())).ok_or_else(|| ObjectError::NotHeld(name.into(), live_namespace::cause!()))
    }
    fn sigv4_day_key(&self, name: &str, day: &str) -> Result<Zeroizing<Vec<u8>>, ObjectError> {
        if name != "stand-in-secret" {
            return Err(ObjectError::NotHeld(name.into(), live_namespace::cause!()));
        }
        let mut mac = Hmac::<Sha256>::new_from_slice(format!("AWS4{SECRET}").as_bytes()).unwrap();
        mac.update(day.as_bytes());
        Ok(Zeroizing::new(mac.finalize().into_bytes().to_vec()))
    }
    fn holds(&self, name: &str) -> Result<bool, ObjectError> {
        Ok(self.0.contains_key(name) || name == "stand-in-secret")
    }
}

fn origin(endpoint: &str) -> Origin {
    Origin {
        kind: "namespace-origin".into(),
        rank: 1,
        takes_new_bytes: true,
        file_key_prefix: "people/p/files/".into(),
        bound_to: None,
        reach: Reach {
            key_id: Source::Value("stand-in-key".into()),
            secret: Source::Held("stand-in-secret".into()),
            bucket: Source::Value("bucket".into()),
            endpoint: Source::Value(endpoint.into()),
            region: Source::Value("r-1".into()),
        },
    }
}

fn record_store() -> RecordStore<Memory> {
    let limits = settings::Limits::fixed(1 << 20, 10 << 30);
    RecordStore::new(Memory::open("record_store").unwrap(), Box::new(RealClock), limits).unwrap()
}

/// The account's files over one stand-in store through the named unmetered port, and that store's origins.
fn account_files(endpoint: &str) -> (AccountFiles<Memory>, Vec<(String, Origin)>) {
    let origins = vec![("stand-in".to_owned(), origin(endpoint))];
    let objects = S3Objects::unmetered(origins.clone(), Box::new(Vault(HashMap::new())), "account_files_share stand-in account files").unwrap();
    (AccountFiles::with_objects(record_store(), ACCOUNT, Box::new(objects)), origins)
}

/// A configured bridge receives immutable identity and metadata only. Provider
/// origin/key and the bearer URL never become an independent share policy here.
struct GrantDelivery {
    minted: Arc<Mutex<Vec<(live_namespace::account_files::share_delivery::ShareFile, u64)>>>,
    current: Option<Arc<std::sync::atomic::AtomicBool>>,
}
impl live_namespace::account_files::share_delivery::ShareDelivery for GrantDelivery {
    fn mint(&self, file: &live_namespace::account_files::share_delivery::ShareFile, seconds: u64)
        -> Result<live_namespace::account_files::share_delivery::SharedDelivery, ObjectError> {
        self.minted.lock().unwrap().push((file.clone(), seconds));
        if let Some(current) = &self.current { current.store(false, std::sync::atomic::Ordering::Release); }
        Ok(live_namespace::account_files::share_delivery::SharedDelivery {
            url: "https://files.example.invalid/share/synthetic-bearer".into(), grant_id: "sharing:synthetic".into(),
        })
    }
}

#[test]
fn explicit_binary_encoding_keeps_control_byte_windows_inside_the_real_transport_bound() {
    let (endpoint, kept) = stand_in();
    let (mut account_files, origins) = account_files(&endpoint);
    let data = vec![7u8; 32768];
    account_files.write_file("/control.bin", &data, "application/octet-stream", &origins).unwrap();
    let answer = account_files
        .call("read_file", &json!({"name_or_identity":"/control.bin","length":32768,"encoding":"base64"}))
        .unwrap()
        .unwrap();
    assert_eq!(answer["encoding"], "base64");
    assert_eq!(answer["bytes_returned"], 32768);
    assert!(serde_json::to_vec(&answer).unwrap().len() < 65_536);
    let count = kept.requests.lock().unwrap().len();
    assert!(account_files.call("read_file", &json!({"name_or_identity":"/control.bin","length":32768,"encoding":3})).unwrap().is_err());
    assert_eq!(kept.requests.lock().unwrap().len(), count, "invalid encoding performs no source read");
}
