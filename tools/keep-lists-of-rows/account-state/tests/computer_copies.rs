//! Stage 2 proof, in process: one account held by three computers A, B and C, all three voting on the writer row, with A
//! the first writer. Each computer has its own records store file, its own sign-in rows (where its copy of the writer row
//! is kept) and its own session to a forwarder that runs in this process and stores nothing. Every message from
//! one computer to another (votes, the writer's pages, pulls, caught-up reports) is posted to the forwarder and
//! carried over the receiving computer's own session (`account/computers/messages.rs`), exactly as at a real forwarder; the
//! forwarder refuses a stale writer's late messages.
//!
//! The term clock is simulated (one shared clock, so the term can run out in a moment); the forwarder's own clock and
//! every computer's proof are real time. A computer is killed by closing its session and cutting its link; a network cut
//! is the same, healed by a new session.
//!
//! What it shows:
//! (a) with every computer up, each write is acknowledged (a second copy holds it before it commits) and every copy
//!     ends with the same records; a write at a computer that is not the writer is refused;
//! (b) A is killed in the middle of a write: after the term runs out B or C takes over with a majority; every
//!     acknowledged write is on the new writer exactly once and it answers from its own copy; the write that was not
//!     acknowledged is there once or not at all, and a retry never doubles it;
//! (c) A is cut off from B and C for longer than the term: A stops taking writes, B or C becomes the one writer, at
//!     no moment do two computers acknowledge writes, and after the cut heals A follows and every record has one version;
//! (d) with only two voters and a cut, writes pause: neither computer takes over;
//! (e) an AI's record, with its owner, reads the same from each computer;
//! (f) a deleted record and an erased one are gone at every copy, and the erased value stays in no copy's history;
//! (g) a computer whose clock is off by more than the margin (its proof carries its clock) cannot take the writer role;
//! (h) a computer that only holds a copy never gets the secrets key, and never takes the writer role; a computer that may answer
//!     gets the root sealed to its own key.
//!     The copy-only computer's files hold no plain record value or request key: the writer seals them for it under a
//!     key derived from the secrets key (src/account/computers/sealed.rs).
//! A retry after a takeover is answered with its first answer (b). The sign-in rows (a key turned off, an app
//! disconnected, a replayed refresh token) are proven in `src/account/computers/copies_tests.rs`: their functions are
//! the door's own and are not public.

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use serde_json::{json, Value};
use std::{
    net::{Shutdown, TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tower::ServiceExt as _;
use trillion_local::{
    account::computers::{
        copies::{sign_in_rows, Copies, CopiesConfig, Link, WriteRefused},
        messages::{Answer, Message, Post},
        AccountKey, KeptAccount, ComputerSigner, ComputersRow,
    },
    secrets::secrets_key::ComputerKey,
    forwarder::{gateway::Gateway, remote_connection_check::computer_route, session},
    records::Mutation,
    storage::record_store::settings::Limits,
};

const FORWARDER_HOST: &str = "forwarder.test";
/// The account's internal owner id: the account its records are kept under at every computer.
const OWNER: &str = "0aa0000000000000000000000000000000000000000000000000000000000001";
const USER: &str = "person";
const RESOURCE: &str = "own-records";

/// The numbers of `computers/settings.json` this test steps by.
struct Numbers {
    term_ms: i64,
    renew_every_ms: i64,
    clock_margin_ms: i64,
    message_path: String,
    computer_id_context: String,
}

fn settings() -> &'static Numbers {
    static NUMBERS: std::sync::OnceLock<Numbers> = std::sync::OnceLock::new();
    NUMBERS.get_or_init(|| {
        let data: Value = serde_json::from_str(include_str!("../src/account/computers/settings.json")).unwrap();
        Numbers {
            term_ms: data["term_ms"].as_i64().unwrap(),
            renew_every_ms: data["renew_every_ms"].as_i64().unwrap(),
            clock_margin_ms: data["clock_margin_ms"].as_i64().unwrap(),
            message_path: data["message_path"].as_str().unwrap().to_owned(),
            computer_id_context: data["computer_id_context"].as_str().unwrap().to_owned(),
        }
    })
}

fn real_clock() -> std::sync::Arc<dyn trillion_local::storage::time_source::Clock> {
    std::sync::Arc::new(trillion_local::storage::time_source::RealClock)
}

fn real_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

/// The forwarder: its HTTP route table, and a socket that admits computer sessions into it.
struct Forwarder {
    _gateway: Arc<Gateway>,
    http: axum::Router,
    sessions: std::net::SocketAddr,
    runtime: Arc<tokio::runtime::Runtime>,
}

fn forwarder() -> Forwarder {
    let gateway = Arc::new(Gateway::with_computers(FORWARDER_HOST, std::sync::Arc::new(trillion_local::storage::time_source::RealClock)));
    let http = gateway.http_route_table().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let sessions = listener.local_addr().unwrap();
    let admitting = gateway.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            timeouts(&stream);
            let admitting = admitting.clone();
            std::thread::spawn(move || {
                let _ = admitting.admit_mac_connection(stream);
            });
        }
    });
    let runtime = Arc::new(tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap());
    Forwarder { _gateway: gateway, http, sessions, runtime }
}

fn timeouts(stream: &TcpStream) {
    stream.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
    stream.set_write_timeout(Some(Duration::from_secs(20))).unwrap();
}

/// What a test does at a computer's link when a message goes out: pass it, or stop the computer there.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Hook {
    None,
    /// The next push is delivered, then the computer dies before the answer reaches it.
    DieAfterPush,
    /// The computer dies as the next push leaves; it never arrives.
    DieBeforePush,
}

/// A computer's link: a POST to the forwarder with the computer's own proof, unless the computer is down or cut off.
struct TestLink {
    address: String,
    signer: Arc<ComputerSigner>,
    http: axum::Router,
    runtime: Arc<tokio::runtime::Runtime>,
    down: Arc<AtomicBool>,
    hook: Mutex<Hook>,
    sent: AtomicUsize,
    /// How far this computer's clock is off: added to the time its proof carries.
    skew: AtomicI64,
}

impl TestLink {
    fn post(&self, to: &str, message: &Message) -> Option<Answer> {
        let (status, answer) = self.post_status(to, message);
        if status != StatusCode::OK {
            return None;
        }
        answer
    }

    /// The forwarder's status for one message, and the computer's answer.
    fn post_status(&self, to: &str, message: &Message) -> (StatusCode, Option<Answer>) {
        let body = serde_json::to_vec(&Post { message: message.clone() }).unwrap();
        let request = Request::builder()
            .method("POST")
            .uri(format!("/a/{}/{}/{to}", self.address, settings().message_path))
            .header(header::HOST, FORWARDER_HOST)
            .header(header::AUTHORIZATION, format!("Bearer {}", self.signer.message_credential(&self.address, real_now() + self.skew.load(Ordering::Acquire))))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap();
        let (status, bytes) = self.runtime.block_on(async {
            let response = self.http.clone().oneshot(request).await.unwrap();
            let status = response.status();
            (status, to_bytes(response.into_body(), 1 << 20).await.unwrap())
        });
        (status, serde_json::from_slice(&bytes).ok())
    }
}

impl Link for TestLink {
    fn send(&self, to: &str, message: &Message) -> Option<Answer> {
        if self.down.load(Ordering::Acquire) {
            return None;
        }
        self.sent.fetch_add(1, Ordering::Relaxed);
        let is_push = matches!(message, Message::Push { changes, .. } if !changes.is_empty());
        let hook = *self.hook.lock().unwrap();
        if is_push && hook == Hook::DieBeforePush {
            self.down.store(true, Ordering::Release);
            return None;
        }
        let answer = self.post(to, message);
        if is_push && hook == Hook::DieAfterPush {
            self.down.store(true, Ordering::Release);
            return None;
        }
        answer
    }
}

/// One computer: its id, its copies, its link and its open session.
struct TestComputer {
    name: &'static str,
    id: String,
    signer: Arc<ComputerSigner>,
    copies: Arc<Copies>,
    link: Arc<TestLink>,
    session: Mutex<Option<TcpStream>>,
    told: KeptAccount,
    _dir: PathBuf,
}

impl TestComputer {
    /// Open a new session to the forwarder and wait until the forwarder carries messages to it.
    fn connect(&self, forwarder: &Forwarder) {
        let credential = self.signer.session_credential(&self.copies.address().to_owned(), real_now());
        let (route, _) = computer_route(&credential, real_now()).unwrap();
        let stream = TcpStream::connect(forwarder.sessions).unwrap();
        timeouts(&stream);
        *self.session.lock().unwrap() = Some(stream.try_clone().unwrap());
        let copies = self.copies.clone();
        let told = self.told.clone();
        std::thread::spawn(move || {
            session::connect_mac_session_with_admission(stream, credential.as_bytes(), &[told], &route, real_clock(), || Ok(()),
                |bytes| copies.answer_message(bytes))
        });
    }

    /// Close the session and cut the link: the computer is dead, or cut off from the others.
    fn cut(&self) {
        self.link.down.store(true, Ordering::Release);
        if let Some(stream) = self.session.lock().unwrap().take() {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }

    fn heal(&self, forwarder: &Forwarder) {
        *self.link.hook.lock().unwrap() = Hook::None;
        self.link.down.store(false, Ordering::Release);
        self.connect(forwarder);
    }

    fn write(&self, id: &str, value: Value) -> Result<(), WriteRefused> {
        self.copies.write(|store| {
            store.mutate_local_with_check(OWNER, RESOURCE, Mutation {
                id: id.to_owned(), expected_version: 0, request_key: format!("write-{id}"), deleted: false, value,
            }, || Ok(()))
        }).map(|_| ())
    }

    /// The record `id` in this computer's own copy: its version and value.
    fn record(&self, id: &str) -> Option<(i64, Value)> {
        self.copies.read(RESOURCE, id).unwrap().record.map(|record| (record.version, record.value))
    }
}

/// One account at `count` computers, all copy keepers that may answer and vote, with the shared term clock `clock`.
struct World {
    forwarder: Forwarder,
    computers: Vec<TestComputer>,
    clock: Arc<AtomicI64>,
    _dir: tempfile::TempDir,
}

fn computer_key(byte: u8) -> ComputerKey {
    ComputerKey::from_bytes(vec![byte; 32]).unwrap()
}

fn world(count: usize) -> World {
    world_may_answer(count, count)
}

/// `world`, where only the first `may_answer` computers may answer (the rest only hold a copy and vote). Computer A holds
/// the secrets key; every computer keeps its own key and state folder for a root sent to it.
fn world_may_answer(count: usize, may_answer: usize) -> World {
    let dir = tempfile::tempdir().unwrap();
    let forwarder = forwarder();
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let account = AccountKey::generate().unwrap();
    let address = account.address();
    let names = ["A", "B", "C"];
    let signers: Vec<Arc<ComputerSigner>> = (0..count).map(|at| Arc::new(ComputerSigner::of(&computer_key(60 + at as u8)).unwrap())).collect();
    let ids: Vec<String> = signers.iter().map(|signer| signer.computer_id()).collect();
    let row = ComputersRow::sign_with_voters(&address, 1, &ids, &ids[..may_answer], &ids, &account).unwrap();
    let root = format!("nm_{}", "0".repeat(64));
    let told = KeptAccount { row: row.clone(), account_key: account.public_hex() };
    let mut computers = Vec::new();
    for at in 0..count {
        let folder = dir.path().join(names[at]);
        std::fs::create_dir_all(&folder).unwrap();
        let link = Arc::new(TestLink {
            address: address.clone(),
            signer: signers[at].clone(),
            http: forwarder.http.clone(),
            runtime: forwarder.runtime.clone(),
            down: Arc::new(AtomicBool::new(false)),
            hook: Mutex::new(Hook::None),
            sent: AtomicUsize::new(0),
            skew: AtomicI64::new(0),
        });
        let term_clock = clock.clone();
        let copies = Copies::new(CopiesConfig { stores: None,
            address: address.clone(),
            owner: OWNER.to_owned(),
            user: USER.to_owned(),
            computer: ids[at].clone(),
            row: row.clone(),
            records: folder.join("records.sqlite"),
            limits: Some(Limits::fixed(1 << 20, 1 << 30)),
            sign_in: sign_in_rows(&folder).unwrap(),
        }, link.clone(), Arc::new(move || term_clock.load(Ordering::Acquire))).unwrap();
        let held = (at == 0).then(|| {
            use trillion_local::secrets::secrets_key::{open_sent_key, seal_to_computer};
            open_sent_key(&seal_to_computer(root.as_bytes(), &ids[0]).unwrap(), &computer_key(60), &settings().computer_id_context).unwrap()
        });
        let copies = copies.with_secrets_key(Arc::new(computer_key(60 + at as u8)), folder.clone(), held);
        computers.push(TestComputer {
            name: names[at],
            id: ids[at].clone(),
            signer: signers[at].clone(),
            copies: Arc::new(copies),
            link,
            session: Mutex::new(None),
            told: told.clone(),
            _dir: folder,
        });
    }
    let world = World { forwarder, computers, clock, _dir: dir };
    for computer in &world.computers {
        computer.connect(&world.forwarder);
    }
    // Every computer can reach every other through the forwarder before the test starts.
    for from in &world.computers {
        for to in &world.computers {
            if from.id != to.id {
                wait_for(|| from.link.post(&to.id, &Message::Stamps).is_some(), "the forwarder carries messages between the computers");
            }
        }
    }
    world
}

fn wait_for(mut done: impl FnMut() -> bool, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !done() {
        assert!(Instant::now() < deadline, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

impl World {
    fn computer(&self, name: &str) -> &TestComputer {
        self.computers.iter().find(|computer| computer.name == name).unwrap()
    }

    fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::AcqRel);
    }

    /// One timer step at every live computer named, in order.
    fn tick(&self, names: &[&str]) {
        for name in names {
            self.computer(name).copies.tick();
        }
    }

    /// The computers that hold the writer role now.
    fn writers(&self) -> Vec<&'static str> {
        self.computers.iter().filter(|computer| computer.copies.holding().is_some()).map(|computer| computer.name).collect()
    }

    /// A becomes the writer, and the others follow it.
    fn start_with_a(&self) {
        self.tick(&["A"]);
        assert_eq!(self.writers(), vec!["A"], "A claims the writer role with every voter up");
        let others: Vec<&str> = self.computers.iter().map(|computer| computer.name).filter(|name| *name != "A").collect();
        self.tick(&others);
    }

    /// Step the term clock by `renew_every_ms` `steps` times, ticking the named computers each time.
    fn run(&self, steps: usize, names: &[&str]) {
        for _ in 0..steps {
            self.advance(settings().renew_every_ms);
            self.tick(names);
        }
    }

    /// Time enough for a term to run out on every voter and for every rank to claim.
    fn term_runs_out(&self) -> usize {
        let settings = settings();
        ((settings.term_ms + 2 * settings.clock_margin_ms) / settings.renew_every_ms) as usize + self.computers.len() + 1
    }
}

fn note(id: &str) -> Value {
    json!({"kind": "note", "text": format!("note {id}")})
}

/// Every record `ids` names is the same, at one version, in each computer named.
fn same_everywhere(world: &World, names: &[&str], ids: &[String]) {
    for id in ids {
        let first = world.computer(names[0]).record(id);
        for name in &names[1..] {
            assert_eq!(world.computer(name).record(id), first, "record {id} differs between {} and {name}", names[0]);
        }
        if let Some((version, _)) = first {
            assert_eq!(version, 1, "record {id} has one version");
        }
    }
}

#[test]
fn a_writes_are_acknowledged_while_every_computer_is_up() {
    let world = world(3);
    world.start_with_a();
    let a = world.computer("A");
    let mut ids = Vec::new();
    for n in 0..5 {
        let id = format!("up-{n}");
        a.write(&id, note(&id)).expect("acknowledged with every computer up");
        // Acknowledged means a second copy holds it already, before anyone pulls.
        let held = ["B", "C"].iter().filter(|name| world.computer(name).record(&id).is_some()).count();
        assert!(held >= 1, "an acknowledged write {id} is held by a second copy at once");
        ids.push(id);
    }
    // A write at a computer that is not the writer is refused: the account has one writer.
    assert_eq!(world.computer("B").write("at-b", note("at-b")), Err(trillion_local::cause!(WriteRefused::NotWriter)));
    // The other copy keepers pull the rest, and every copy ends the same.
    world.run(2, &["A", "B", "C"]);
    same_everywhere(&world, &["A", "B", "C"], &ids);
    assert_eq!(world.writers(), vec!["A"]);
}

/// Kill A in the middle of a write (`hook`), let the term run out, and check the takeover.
fn kill_in_the_middle(hook: Hook) {
    let world = world(3);
    world.start_with_a();
    let a = world.computer("A");
    let mut acknowledged = Vec::new();
    for n in 0..4 {
        let id = format!("acked-{n}");
        a.write(&id, note(&id)).unwrap();
        acknowledged.push(id);
    }
    // The write in the middle of which A dies is not acknowledged, and A keeps nothing of it.
    *a.link.hook.lock().unwrap() = hook;
    assert_eq!(a.write("cut-short", note("cut-short")), Err(trillion_local::cause!(WriteRefused::NotAcknowledged)));
    assert_eq!(a.record("cut-short"), None, "a write that was not acknowledged is never visible at the writer");
    a.cut();

    // Until the term runs out nobody takes over; then B or C does, with a majority of two.
    world.run(2, &["B", "C"]);
    assert!(world.writers().is_empty(), "nobody writes while A's term may still hold");
    world.run(world.term_runs_out(), &["B", "C"]);
    let writers = world.writers();
    assert_eq!(writers.len(), 1, "one new writer: {writers:?}");
    let writer = world.computer(writers[0]);
    let other = world.computer(if writers[0] == "B" { "C" } else { "B" });

    // Every acknowledged write is on the new writer exactly once, and it answers from its own copy.
    for id in &acknowledged {
        assert_eq!(writer.record(id), Some((1, note(id))), "acknowledged write {id} on the new writer {}", writer.name);
    }
    // The write that was not acknowledged is there once or not at all; a retry never doubles it.
    let before = writer.record("cut-short");
    match hook {
        Hook::DieBeforePush => assert_eq!(before, None, "it never left A"),
        Hook::DieAfterPush => assert_eq!(before, Some((1, note("cut-short"))), "a copy held it, and the new writer holds it or caught up from it"),
        Hook::None => unreachable!(),
    }
    let retry = writer.write("cut-short", note("cut-short"));
    match before {
        Some(_) => assert_eq!(retry, Ok(()), "a retry of a held write is answered with its first answer (its receipt travelled)"),
        None => assert_eq!(retry, Ok(()), "a retry of a lost write lands once"),
    }
    assert_eq!(writer.record("cut-short").map(|(version, _)| version), Some(1), "never doubled");

    // The new writer goes on with the remaining copy acknowledging.
    writer.write("after", note("after")).expect("acknowledged by the remaining copy");
    world.run(2, &[writer.name, other.name]);
    let mut ids = acknowledged.clone();
    ids.extend(["cut-short".to_owned(), "after".to_owned()]);
    same_everywhere(&world, &[writer.name, other.name], &ids);
}

#[test]
fn b_a_killed_writer_is_taken_over_and_every_acknowledged_write_is_there_once() {
    kill_in_the_middle(Hook::DieAfterPush);
    kill_in_the_middle(Hook::DieBeforePush);
}

#[test]
fn c_a_cut_writer_stops_one_new_writer_takes_over_and_the_heal_leaves_one_version() {
    let world = world(3);
    world.start_with_a();
    let mut ids = Vec::new();
    for n in 0..3 {
        let id = format!("before-{n}");
        world.computer("A").write(&id, note(&id)).unwrap();
        ids.push(id);
    }
    world.computer("A").cut();

    // Through the cut, longer than the term: at each step every computer tries to write. At no step do two computers
    // acknowledge, and A acknowledges nothing once it is cut off.
    let steps = 2 * world.term_runs_out();
    let mut by: Vec<&str> = Vec::new();
    for step in 0..steps {
        world.advance(settings().renew_every_ms);
        world.tick(&["A", "B", "C"]);
        let writers = world.writers();
        assert!(writers.len() <= 1, "step {step}: two computers hold the writer role: {writers:?}");
        let mut acknowledged = Vec::new();
        for name in ["A", "B", "C"] {
            let id = format!("cut-{step}-{name}");
            if world.computer(name).write(&id, note(&id)).is_ok() {
                acknowledged.push(name);
                ids.push(id);
            }
        }
        assert!(acknowledged.len() <= 1, "step {step}: two computers acknowledged writes: {acknowledged:?}");
        assert!(!acknowledged.contains(&"A"), "step {step}: the cut-off computer acknowledged a write");
        by.extend(acknowledged);
    }
    assert!(!by.is_empty(), "B or C took over and wrote during the cut");
    let writer = by[by.len() - 1];
    assert!(by.iter().all(|name| *name == writer), "one writer during the cut: {by:?}");

    // The cut heals: A follows the new writer, and every record has one version, the same at every computer.
    world.computer("A").heal(&world.forwarder);
    world.run(3, &["A", "B", "C"]);
    assert_eq!(world.writers(), vec![writer], "A comes back as a copy keeper that is not the writer");
    let (writer_id, _, _) = world.computer("A").copies.writer_row().unwrap();
    assert_eq!(writer_id, world.computer(writer).id, "A's copy of the writer row names the new writer");
    // A's late messages as the old writer (term 1) are refused for an older term: the forwarder refuses them, and so does a copy.
    let stale = Message::Push { term: 1, resource: RESOURCE.to_owned(), after: 0, changes: Vec::new(), base: 0 };
    let other = if writer == "B" { "C" } else { "B" };
    let (status, _) = world.computer("A").link.post_status(&world.computer(other).id, &stale);
    assert_eq!(status, StatusCode::CONFLICT, "the forwarder refuses a writer's message below the term it carried");
    assert_peer_refusal(world.computer(other).copies.answer(&world.computer("A").id, stale), "stale_writer");
    world.computer(writer).write("after-heal", note("after-heal")).unwrap();
    world.run(2, &["A", "B", "C"]);
    ids.push("after-heal".to_owned());
    same_everywhere(&world, &["A", "B", "C"], &ids);
    assert_eq!(world.computer("A").write("from-a", note("from-a")), Err(trillion_local::cause!(WriteRefused::NotWriter)));
}

#[test]
fn d_two_voters_with_a_cut_pause_writes_and_never_take_over() {
    let world = world(2);
    world.start_with_a();
    world.computer("A").write("two-1", note("two-1")).expect("acknowledged by B");
    world.computer("A").cut();
    for step in 0..2 * world.term_runs_out() {
        world.advance(settings().renew_every_ms);
        world.tick(&["A", "B"]);
        assert!(world.writers().is_empty() || step == 0, "step {step}: with two voters and a cut nobody holds the writer role: {:?}", world.writers());
        assert!(world.computer("A").write(&format!("a-{step}"), note("a")).is_err(), "step {step}: A pauses");
        assert_eq!(world.computer("B").write(&format!("b-{step}"), note("b")), Err(trillion_local::cause!(WriteRefused::NotWriter)), "step {step}: B does not take over");
    }
    // Once the cut heals, a writer is chosen again and writes go on.
    world.computer("A").heal(&world.forwarder);
    world.run(world.term_runs_out(), &["A", "B"]);
    let writers = world.writers();
    assert_eq!(writers.len(), 1, "{writers:?}");
    world.computer(writers[0]).write("two-2", note("two-2")).expect("writes go on after the heal");
}

#[test]
fn e_an_ais_owner_reads_the_same_from_each_computer() {
    let world = world(3);
    world.start_with_a();
    let ai = json!({"kind": "ai", "name": "assistant", "owner": {"person": "person-7", "by": "the credential that connected it"}});
    world.computer("A").write("ai:assistant", ai.clone()).unwrap();
    world.run(2, &["A", "B", "C"]);
    for name in ["A", "B", "C"] {
        let (version, value) = world.computer(name).record("ai:assistant").expect("the AI's record is at every computer");
        assert_eq!((version, &value), (1, &ai), "at {name}");
        assert_eq!(value["owner"]["person"], "person-7", "the AI's owner at {name}");
    }
}

#[test]
fn f_a_deleted_or_erased_record_is_gone_at_every_copy() {
    let world = world(3);
    world.start_with_a();
    let a = world.computer("A");
    a.write("deleted", note("deleted")).unwrap();
    a.copies.write(|store| store.mutate_local_with_check(OWNER, RESOURCE, Mutation {
        id: "deleted".to_owned(), expected_version: 1, request_key: "delete-it".to_owned(), deleted: true, value: Value::Null,
    }, || Ok(()))).unwrap();
    a.write("erased", json!({"kind": "note", "text": "a value nobody may keep"})).unwrap();
    let written = a.copies.stamp(RESOURCE);
    world.run(1, &["A", "B", "C"]);
    assert!(world.computer("B").record("erased").is_some() || world.computer("C").record("erased").is_some());
    a.copies.write(|store| store.erase(OWNER, RESOURCE, "erased")).unwrap();
    world.run(2, &["A", "B", "C"]);
    for name in ["A", "B", "C"] {
        let computer = world.computer(name);
        assert_eq!(computer.record("deleted"), None, "the deleted record is gone at {name}");
        assert_eq!(computer.record("erased"), None, "the erased record is gone at {name}");
        assert!(computer.copies.read_as_of(RESOURCE, "erased", written).unwrap().record.is_none(), "the erased value is in no history at {name}");
    }
}

#[test]
fn g_a_computer_whose_clock_is_off_cannot_take_the_writer_role() {
    let world = world(3);
    world.start_with_a();
    world.computer("A").cut();
    // C's clock is off by more than the margin: B refuses its votes, so with A gone C never holds the writer role.
    let c = world.computer("C");
    c.link.skew.store(5 * settings().clock_margin_ms, Ordering::Release);
    world.run(2 * world.term_runs_out(), &["C"]);
    assert!(world.writers().is_empty(), "a computer with a skewed clock never takes the writer role: {:?}", world.writers());
    // With its clock right again, it does.
    c.link.skew.store(0, Ordering::Release);
    world.run(world.term_runs_out(), &["C"]);
    assert_eq!(world.writers(), vec!["C"]);
}

#[test]
fn h_a_computer_that_only_holds_a_copy_never_gets_the_root_or_the_writer_role() {
    let world = world_may_answer(3, 2);
    world.start_with_a();
    world.computer("A").write("r1", note("r1")).unwrap();
    world.run(2, &["A", "B", "C"]);
    let sealed = |name: &str| trillion_local::secrets::secrets_key::sealed_file(&world.computer(name)._dir).unwrap().exists();
    assert!(world.computer("B").copies.holds_secrets_key() && sealed("B"), "B may answer: it gets the root, sealed to its own key");
    assert!(!world.computer("C").copies.holds_secrets_key() && !sealed("C"), "C only holds a copy: no root");
    // C holds the record, sealed: its version and stamp, never its value (nor its request key) in plain.
    let (version, kept) = world.computer("C").record("r1").expect("C holds the records");
    assert_eq!(version, 1);
    assert!(kept.get("sealed").is_some() && kept.get("text").is_none(), "C keeps the value sealed");
    assert_eq!(world.computer("C").copies.stamp(RESOURCE), world.computer("A").copies.stamp(RESOURCE));
    let files = |name: &str| -> Vec<u8> {
        std::fs::read_dir(&world.computer(name)._dir).unwrap().filter_map(|entry| entry.ok()).map(|entry| entry.path())
            .filter(|path| path.is_file()).flat_map(|path| std::fs::read(path).unwrap()).collect()
    };
    let holds = |bytes: &[u8], text: &str| bytes.windows(text.len()).any(|window| window == text.as_bytes());
    assert!(!holds(&files("C"), "note r1") && !holds(&files("C"), "write-r1"), "no plain value or request key in C's files");
    assert!(holds(&files("B"), "note r1"), "B may answer and keeps it plain");
    assert_eq!(world.computer("B").record("r1"), Some((1, note("r1"))));
    world.computer("A").cut();
    world.run(2 * world.term_runs_out(), &["C"]);
    assert!(world.writers().is_empty(), "C never claims");
    world.run(world.term_runs_out(), &["B", "C"]);
    assert_eq!(world.writers(), vec!["B"]);
}


fn assert_peer_refusal(answer: Answer, expected_code: &str) {
    let Answer::Refused { code, cause, .. } = answer else { panic!("expected a peer refusal") };
    assert_eq!(code, expected_code);
    assert!(!cause.file().is_empty());
    assert!(cause.line() > 0 && cause.column() > 0);
}
