
use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use serde_json::{json, Value};
use std::{
    net::{Shutdown, TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tower::ServiceExt as _;
use trillion_local::storage::time_source::Clock;
use trillion_local::{
    account::computers::{
        copies::{sign_in_rows, Copies, CopiesConfig, Link, WriteRefused},
        messages::{Answer, Message, Post},
        AccountKey, ComputerSigner, ComputersRow, KeptAccount,
    },
    forwarder::{gateway::Gateway, remote_connection_check::computer_route, session},
    records::Mutation,
    secrets::secrets_key::ComputerKey,
    storage::record_store::settings::Limits,
};

const FORWARDER_HOST: &str = "forwarder.test";
/// The account's internal owner id: the account its records are kept under at every computer.
const OWNER: &str = "0aa0000000000000000000000000000000000000000000000000000000000001";
const USER: &str = "person";
const RESOURCE: &str = "own-records";
/// The numbers of `tests/fixtures/answering-computers.json`.
#[allow(dead_code)] // shared by both answering targets; the real-time one uses only part of it
struct Fixture {
    rows: usize,
    slow_answer_ms: u64,
}

#[allow(dead_code)] // shared by both answering targets; the real-time one uses only part of it
fn fixture() -> &'static Fixture {
    static FIXTURE: std::sync::OnceLock<Fixture> = std::sync::OnceLock::new();
    FIXTURE.get_or_init(|| {
        let data: Value = serde_json::from_str(include_str!("../fixtures/answering-computers.json")).unwrap();
        Fixture { rows: data["rows"].as_u64().unwrap() as usize, slow_answer_ms: data["slow_answer_ms"].as_u64().unwrap() }
    })
}

/// The numbers of `src/account/computers/settings.json` this test steps by and bounds with.
struct Numbers {
    term_ms: i64,
    renew_every_ms: i64,
    clock_margin_ms: i64,
    message_wait_ms: u64,
    message_path: String,
    computer_id_context: String,
}

fn settings() -> &'static Numbers {
    static NUMBERS: std::sync::OnceLock<Numbers> = std::sync::OnceLock::new();
    NUMBERS.get_or_init(|| {
        let data: Value = serde_json::from_str(include_str!("../../src/account/computers/settings.json")).unwrap();
        Numbers {
            term_ms: data["term_ms"].as_i64().unwrap(),
            renew_every_ms: data["renew_every_ms"].as_i64().unwrap(),
            clock_margin_ms: data["clock_margin_ms"].as_i64().unwrap(),
            message_wait_ms: data["message_wait_ms"].as_u64().unwrap(),
            message_path: data["message_path"].as_str().unwrap().to_owned(),
            computer_id_context: data["computer_id_context"].as_str().unwrap().to_owned(),
        }
    })
}

/// The world's one clock: every proof, deadline and term reads it, and the test moves it.
struct WorldTime(Arc<AtomicI64>);

impl Clock for WorldTime {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::Acquire)
    }
    /// A wait advances the world's time instead of sleeping: an answer that takes `duration` takes that much of the world.
    fn wait(&self, duration: Duration) {
        self.0.fetch_add(duration.as_millis() as i64, Ordering::AcqRel);
    }
}

struct Forwarder {
    _gateway: Arc<Gateway>,
    http: axum::Router,
    sessions: std::net::SocketAddr,
    runtime: Arc<tokio::runtime::Runtime>,
}

fn forwarder(time: Arc<dyn Clock>) -> Forwarder {
    let gateway = Arc::new(Gateway::with_computers(FORWARDER_HOST, time));
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

/// A computer's link: a POST to the forwarder with the computer's own proof, unless the computer is down or paused.
struct TestLink {
    address: String,
    signer: Arc<ComputerSigner>,
    http: axum::Router,
    runtime: Arc<tokio::runtime::Runtime>,
    down: Arc<AtomicBool>,
    time: Arc<dyn Clock>,
}

impl TestLink {
    fn post(&self, to: &str, message: &Message) -> Option<Answer> {
        let body = serde_json::to_vec(&Post { message: message.clone() }).unwrap();
        let request = Request::builder()
            .method("POST")
            .uri(format!("/a/{}/{}/{to}", self.address, settings().message_path))
            .header(header::HOST, FORWARDER_HOST)
            .header(header::AUTHORIZATION, format!("Bearer {}", self.signer.message_credential(&self.address, self.time.now_ms())))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap();
        // A computer's link waits `message_wait_ms` for one message, as trillion-local's own link does
        // (src/native_entry/computer.rs): a paused computer costs that wait, never the session's socket timeout.
        let (status, bytes) = self.runtime.block_on(async {
            let wait = Duration::from_millis(settings().message_wait_ms);
            let answered = tokio::time::timeout(wait, async {
                let response = self.http.clone().oneshot(request).await.unwrap();
                let status = response.status();
                (status, to_bytes(response.into_body(), 1 << 20).await.unwrap())
            }).await;
            answered.unwrap_or((StatusCode::GATEWAY_TIMEOUT, Default::default()))
        });
        if status != StatusCode::OK {
            return None;
        }
        serde_json::from_slice(&bytes).ok()
    }
}

impl Link for TestLink {
    fn send(&self, to: &str, message: &Message) -> Option<Answer> {
        if self.down.load(Ordering::Acquire) {
            return None;
        }
        self.post(to, message)
    }
}

struct TestComputer {
    name: &'static str,
    id: String,
    signer: Arc<ComputerSigner>,
    copies: Arc<Copies>,
    link: Arc<TestLink>,
    session: Mutex<Option<TcpStream>>,
    told: KeptAccount,
    /// While set, the computer is paused: its session stays open but no message is answered, and it sends nothing.
    paused: Arc<(Mutex<bool>, std::sync::Condvar)>,
    /// How long the computer waits before it answers each message (ms); 0 answers at once.
    slow: Arc<AtomicU64>,
    _dir: PathBuf,
}

impl TestComputer {
    fn connect(&self, forwarder: &Forwarder, time: Arc<dyn Clock>) {
        let credential = self.signer.session_credential(self.copies.address(), time.now_ms());
        let (route, _) = computer_route(&credential, time.now_ms()).unwrap();
        let stream = TcpStream::connect(forwarder.sessions).unwrap();
        // A computer's session waits for the forwarder's next message as long as the session lasts: an idle session is not
        // a lost one (trillion-local reopens each at its lifetime, src/native_entry/computer.rs `keep_forwarder_sessions`).
        stream.set_write_timeout(Some(Duration::from_secs(20))).unwrap();
        *self.session.lock().unwrap() = Some(stream.try_clone().unwrap());
        let copies = self.copies.clone();
        let told = self.told.clone();
        let paused = self.paused.clone();
        let slow = self.slow.clone();
        let wait_clock = time.clone();
        std::thread::spawn(move || {
            let _ = session::connect_mac_session_with_admission(stream, credential.as_bytes(), &[told], &route, time, || Ok(()),
                |bytes| {
                    // A paused process answers nothing: the message waits here until the forwarder gives up on it.
                    let (lock, changed) = &*paused;
                    let mut held = lock.lock().unwrap();
                    while *held {
                        held = changed.wait(held).unwrap();
                    }
                    drop(held);
                    let slow = slow.load(Ordering::Acquire);
                    if slow > 0 {
                        wait_clock.wait(Duration::from_millis(slow as u64));
                    }
                    copies.answer_message(bytes)
                });
        });
    }

    /// Kill the computer: close its session and cut its link.
    #[allow(dead_code)] // shared by both answering targets; the real-time one uses only part of it
    fn kill(&self) {
        self.link.down.store(true, Ordering::Release);
        if let Some(stream) = self.session.lock().unwrap().take() {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }

    /// Pause the computer: it keeps its session but answers nothing and sends nothing.
    fn pause(&self) {
        *self.paused.0.lock().unwrap() = true;
        self.link.down.store(true, Ordering::Release);
    }

    fn write(&self, id: &str, value: Value) -> Result<(), WriteRefused> {
        self.copies.write(|store| {
            store.mutate_local_with_check(OWNER, RESOURCE, Mutation {
                id: id.to_owned(), expected_version: 0, request_key: format!("write-{id}"), deleted: false, value,
            }, || Ok(()))
        }).map(|_| ())
    }

    fn record(&self, id: &str) -> Option<(i64, Value)> {
        self.copies.read(RESOURCE, id).unwrap().record.map(|record| (record.version, record.value))
    }
}

impl Drop for TestComputer {
    fn drop(&mut self) {
        // Let a session thread blocked by a pause go.
        *self.paused.0.lock().unwrap() = false;
        self.paused.1.notify_all();
    }
}

/// One account at A, B and C: all three keep a copy and vote; A and B may answer, C only keeps a copy. A holds the
/// secrets key at the start.
struct World {
    forwarder: Forwarder,
    computers: Vec<TestComputer>,
    clock: Arc<AtomicI64>,
    _dir: tempfile::TempDir,
}

const NAMES: [&str; 3] = ["A", "B", "C"];
/// How many of `NAMES`, from the first, may answer.
const MAY_ANSWER: usize = 2;

fn computer_key(byte: u8) -> ComputerKey {
    ComputerKey::from_bytes(vec![byte; 32]).unwrap()
}

fn world() -> World {
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let time: Arc<dyn Clock> = Arc::new(WorldTime(clock.clone()));
    let forwarder = forwarder(time.clone());
    let account = AccountKey::generate().unwrap();
    let address = account.address();
    let signers: Vec<Arc<ComputerSigner>> =
        (0..NAMES.len()).map(|at| Arc::new(ComputerSigner::of(&computer_key(80 + at as u8)).unwrap())).collect();
    let ids: Vec<String> = signers.iter().map(|signer| signer.computer_id()).collect();
    let row = ComputersRow::sign_with_voters(&address, 1, &ids, &ids[..MAY_ANSWER], &ids, &account).unwrap();
    let root = format!("nm_{}", "0".repeat(64));
    let told = KeptAccount { row: row.clone(), account_key: account.public_hex() };
    let mut computers = Vec::new();
    for (at, name) in NAMES.iter().enumerate() {
        let folder = dir.path().join(name);
        std::fs::create_dir_all(&folder).unwrap();
        let link = Arc::new(TestLink {
            address: address.clone(),
            signer: signers[at].clone(),
            http: forwarder.http.clone(),
            runtime: forwarder.runtime.clone(),
            down: Arc::new(AtomicBool::new(false)),
            time: time.clone(),
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
            open_sent_key(&seal_to_computer(root.as_bytes(), &ids[0]).unwrap(), &computer_key(80), &settings().computer_id_context).unwrap()
        });
        let copies = copies.with_clock(time.clone()).with_secrets_key(Arc::new(computer_key(80 + at as u8)), folder.clone(), held);
        computers.push(TestComputer {
            name,
            id: ids[at].clone(),
            signer: signers[at].clone(),
            copies: Arc::new(copies),
            link,
            session: Mutex::new(None),
            told: told.clone(),
            paused: Arc::new((Mutex::new(false), std::sync::Condvar::new())),
            slow: Arc::new(AtomicU64::new(0)),
            _dir: folder,
        });
    }
    let world = World { forwarder, computers, clock, _dir: dir };
    for computer in &world.computers {
        computer.connect(&world.forwarder, time.clone());
    }
    for from in &world.computers {
        for to in &world.computers {
            if from.id != to.id {
                wait_for(|| from.link.post(&to.id, &Message::Stamps).is_some(), "the forwarder carries messages between the computers");
            }
        }
    }
    world
}

/// Retry `done` until it holds, yielding between tries. Each try is a real round trip through the forwarder, so the bound
/// is a count of tries, never a wall-clock deadline.
fn wait_for(mut done: impl FnMut() -> bool, what: &str) {
    for _ in 0..WAIT_TRIES {
        if done() {
            return;
        }
        std::thread::yield_now();
    }
    panic!("gave up: {what}");
}

const WAIT_TRIES: usize = 50_000;

impl World {
    fn computer(&self, name: &str) -> &TestComputer {
        self.computers.iter().find(|computer| computer.name == name).unwrap()
    }

    fn now(&self) -> i64 {
        self.clock.load(Ordering::Acquire)
    }

    #[allow(dead_code)] // shared by both answering targets; the real-time one uses only part of it
    fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::AcqRel);
    }

    fn tick(&self, names: &[&str]) {
        for name in names {
            self.computer(name).copies.tick();
        }
    }

    fn writers(&self, names: &[&str]) -> Vec<&'static str> {
        self.computers.iter().filter(|computer| names.contains(&computer.name) && computer.copies.holding().is_some())
            .map(|computer| computer.name).collect()
    }

    /// The computers that may answer the account.
    #[allow(dead_code)] // shared by both answering targets; the real-time one uses only part of it
    fn may_answer(&self) -> Vec<&TestComputer> {
        self.computers.iter().filter(|computer| computer.copies.may_answer()).collect()
    }

    /// A claims the writer turn, and the others follow it until each that may answer has caught up with it.
    fn start_with_a(&self) {
        self.tick(&["A"]);
        assert_eq!(self.writers(&NAMES), vec!["A"], "A claims the writer role with every voter up");
        self.tick(&["B", "C"]);
        assert!(self.computer("B").copies.answers_now(), "B may answer and has caught up with A");
        assert!(!self.computer("C").copies.may_answer(), "C only keeps a copy");
    }

    /// Step the term clock by `renew_every_ms` `steps` times, ticking the named computers each time.
    #[allow(dead_code)] // shared by both answering targets; the real-time one uses only part of it
    fn run(&self, steps: usize, names: &[&str]) {
        for _ in 0..steps {
            self.advance(settings().renew_every_ms);
            self.tick(names);
        }
    }

    /// Enough steps of `renew_every_ms` for a term to run out on every voter and for every rank to claim.
    #[allow(dead_code)] // shared by both answering targets; the real-time one uses only part of it
    fn term_runs_out(&self) -> usize {
        let numbers = settings();
        ((numbers.term_ms + 2 * numbers.clock_margin_ms) / numbers.renew_every_ms) as usize + self.computers.len() + 1
    }
}

#[allow(dead_code)] // shared by both answering targets; the real-time one uses only part of it
fn row(n: usize) -> (String, Value) {
    let id = format!("row-{n:03}");
    let value = json!({"kind": "note", "text": format!("acknowledged row {n}")});
    (id, value)
}
