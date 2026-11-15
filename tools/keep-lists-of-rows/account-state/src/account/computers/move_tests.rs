//! Moving an account from one computer to another while its reads keep may_answer (2026-11-03, lane where-accounts-live).
//!
//! Measured on two computers, A and B, moving a blank account from A to B with a read every 2-3 s through the forwarder:
//! 210 reads answered, 94 refused 401 and 79 answered 503, though A was live and may_answer throughout. Four defects,
//! each one a step of this test:
//! - the taken copy carries the account's key row and computers row, never its other rows; a row made at A by another
//!   process (writing A's rows directly) was never logged, so it never travelled, and B, sent the root, took calls
//!   without it;
//! - without a sent secrets key, B never caught up: no computer was ahead of it on the account's rows, so it made no rows pull and
//!   the root (which comes only on one) never came (503 for over 80 s);
//! - the forwarder sent the calls to B as soon as its session opened, though A was live;
//! - nothing checked B's copy against A's before B took calls (old trillion's carry read counts and identities back
//!   first, Trillion-X/trillion src/resource-state-carry.mjs).
//!
//! Here A and B each run their own copies, stores and account rows, with a link that calls the other computer's
//! `Copies::answer` directly (as `membership_tests.rs` does), and every read is routed by the forwarder's own choice
//! (`ConnectedComputers::current_route`, with each computer's session saying whether it is catching up, as a computer's
//! list of kept accounts does). One read a second of the shared clock, through every step of the move: add B, let it catch up,
//! make it a voter, move the writer, remove A. Not one read fails; B holds the same account rows as A (by count and
//! identity per family, `Log::census`); the row edits land; A is removed and does nothing more.

use super::{
    classify_booted,
    copies::{Copies, CopiesConfig, Link},
    edit, keep_public_key,
    messages::{Answer, Message},
    settings,
    rows_copy::{self, CopiedRows, Log},
    AccountKey, KeptAccount, Change, ComputersRow, Subject,
};
use crate::{
    account::rows::store::{Family, Row, Store},
    secrets::secrets_key::{self, ComputerKey},
    forwarder::connected_computers::{ConnectedComputers, TestComputer},
    records::Mutation,
    storage::record_store::settings::Limits,
};
use serde_json::json;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc, Mutex,
    },
};

pub(super) const OWNER: &str = "0cc0000000000000000000000000000000000000000000000000000000000005";
pub(super) const ACCOUNT: &str = "mover";
pub(super) const RESOURCE: &str = "own-records";
/// One read a second of the shared clock.
const READ_EVERY_MS: i64 = 1_000;

pub(super) struct Net {
    computers: Mutex<HashMap<String, Arc<Copies>>>,
    pub(super) down: Mutex<HashSet<String>>,
    /// The forwarder every message between computers goes through, and the account it carries them for.
    pub(super) forwarder: ConnectedComputers,
    address: String,
    /// The shared clock the forwarder carries writer terms at (the world's clock).
    clock: Arc<AtomicI64>,
}

struct NetLink {
    me: String,
    net: Arc<Net>,
}

impl Link for NetLink {
    fn send(&self, to: &str, message: &Message) -> Option<Answer> {
        {
            let down = self.net.down.lock().unwrap();
            if down.contains(&self.me) || down.contains(to) {
                return None;
            }
        }
        let computer = self.net.computers.lock().unwrap().get(to).cloned()?;
        let answer = computer.answer(&self.me, message.clone());
        // The forwarder learns the writer only from what it carries, as it does for every message (src/forwarder/gateway.rs
        // `pass_message`): a writer's message a copy took (a push applied, a renewal accepted), or a page the writer answered a
        // other copy keeper's pull of its feed with.
        let forwarder = &self.net.forwarder;
        match (message, &answer) {
            (Message::Push { term, .. }, Answer::Applied { .. }) => forwarder.note_writer(&self.net.address, &self.me, *term, self.net.clock.load(Ordering::Acquire)),
            (Message::Vote { ask, .. }, Answer::Vote { vote, .. }) if ask.term == ask.prior && vote.accepted =>
                forwarder.note_writer(&self.net.address, &self.me, ask.term, self.net.clock.load(Ordering::Acquire)),
            (Message::Pull { writer: true, .. }, Answer::Page { term, .. }) => forwarder.note_writer(&self.net.address, to, *term, self.net.clock.load(Ordering::Acquire)),
            _ => {}
        }
        Some(answer)
    }
}

pub(super) struct Computer {
    pub(super) id: String,
    pub(super) copies: Arc<Copies>,
    view: Arc<CopiedRows>,
    pub(super) raw: crate::account::rows::Shared,
    net: Arc<Net>,
    account_key: String,
}

impl Computer {
    /// The account's rows as its owners write them (through the copies).
    pub(super) fn store(&self) -> Store<'_> {
        Store::new(&*self.view)
    }

    /// The computer's own rows themselves, as another process at the computer writes them (outside the copies).
    pub(super) fn raw_store(&self) -> Store<'_> {
        Store::new(&*self.raw)
    }

    pub(super) fn census(&self) -> Vec<(String, u64, String)> {
        Log { raw: &*self.raw, owner: OWNER }.census().unwrap()
    }

    pub(super) fn write(&self, id: &str, text: &str) {
        let mutation = Mutation { id: id.to_owned(), expected_version: 0, request_key: format!("write-{id}"), deleted: false,
            value: json!({"kind": "note", "text": text}) };
        self.copies.write(|store| store.mutate_local_with_check(OWNER, RESOURCE, mutation, || Ok(())))
            .map(|_| ()).unwrap_or_else(|refused| panic!("the writer's write of {id} is acknowledged: {refused:?}"));
    }
}

/// What the forwarder sees of a computer: its session tells its copies' row and says whether it is catching up
/// (`Copies::answers_now`), and is live while the computer is not down.
struct Session(Arc<Computer>);

impl TestComputer for Session {
    fn told(&self) -> Vec<KeptAccount> {
        vec![KeptAccount { row: self.0.copies.row(), account_key: self.0.account_key.clone() }]
    }
    fn catching_up(&self, _address: &str) -> bool {
        !self.0.copies.answers_now()
    }
    fn live(&self) -> bool {
        !self.0.net.down.lock().unwrap().contains(&self.0.id) && !self.0.copies.removed()
    }
}

pub(super) struct World {
    pub(super) net: Arc<Net>,
    computers: Mutex<BTreeMap<&'static str, Arc<Computer>>>,
    ids: Vec<String>,
    keys: Vec<Arc<ComputerKey>>,
    pub(super) account: AccountKey,
    pub(super) clock: Arc<AtomicI64>,
    base: PathBuf,
    /// Every read: (clock, step, the computer that answered it or why it failed).
    pub(super) reads: Mutex<Vec<(i64, &'static str, Result<String, String>)>>,
    _dir: tempfile::TempDir,
}

pub(super) const NAMES: [&str; 3] = ["A", "B", "C"];

impl World {
    pub(super) fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let keys: Vec<Arc<ComputerKey>> = (0..NAMES.len() as u8).map(|at| Arc::new(ComputerKey::from_bytes(vec![90 + at; 32]).unwrap())).collect();
        let ids: Vec<String> = keys.iter().map(|key| super::ComputerSigner::of(key).unwrap().computer_id()).collect();
        let account = AccountKey::generate().unwrap();
        let clock = Arc::new(AtomicI64::new(5_000_000));
        World {
            net: Arc::new(Net { computers: Mutex::default(), down: Mutex::default(), forwarder: ConnectedComputers::new(), address: account.address(), clock: clock.clone() }),
            computers: Mutex::new(BTreeMap::new()),
            ids,
            keys,
            account,
            clock,
            base,
            reads: Mutex::new(Vec::new()),
            _dir: dir,
        }
    }

    pub(super) fn id(&self, name: &str) -> String {
        self.ids[NAMES.iter().position(|known| *known == name).unwrap()].clone()
    }

    pub(super) fn ids_of(&self, names: &[&str]) -> Vec<String> {
        names.iter().map(|name| self.id(name)).collect()
    }

    /// The folder computer `name` keeps its account in.
    pub(super) fn folder(&self, name: &str) -> PathBuf {
        self.base.join(name.to_lowercase())
    }

    pub(super) fn at(&self, name: &str) -> Arc<Computer> {
        self.computers.lock().unwrap()[name].clone()
    }

    /// Start computer `at` (0 is A) with `row`, as a full computer starts it: A with the account's secrets key; B as `computer join`
    /// leaves it, with the account's key row and its computers row and nothing else (no account row, no record, no root).
    pub(super) fn start(&self, at: usize, row: &ComputersRow, joining: bool, root: Option<&crate::secrets::SecretsKey>) -> Arc<Computer> {
        self.start_on(at, row, joining, root, None)
    }

    /// `start`, with the computer opening its records stores through `stores` (`copies::StoreOpener`) instead of SQLite
    /// files on its own disk: a computer whose storage its host lends (`hosted_computer_tests.rs`).
    pub(super) fn start_on(&self, at: usize, row: &ComputersRow, joining: bool, root: Option<&crate::secrets::SecretsKey>,
        stores: Option<Arc<dyn super::copies::StoreOpener>>) -> Arc<Computer> {
        let name = NAMES[at];
        let folder = self.base.join(name.to_lowercase());
        std::fs::create_dir_all(&folder).unwrap();
        let raw = crate::account::rows::open(&folder).unwrap();
        {
            let store = Store::new(&*raw);
            keep_public_key(&store, ACCOUNT, &self.account).unwrap();
            let kept = Row { id: Subject::Account(self.account.address()).row_id(), account: ACCOUNT.to_owned(), expires_at: 0, value: row.clone() };
            store.put(Family::Computers, &kept).unwrap();
            let ids: Vec<&str> = self.ids.iter().map(String::as_str).collect();
            classify_booted(&store, ACCOUNT, &ids);
        }
        let view = CopiedRows::new(raw.clone());
        let clock = self.clock.clone();
        let copies = Copies::new(
            CopiesConfig { user: "person".into(), stores,
                address: self.account.address(),
                owner: OWNER.to_owned(),
                computer: self.ids[at].clone(),
                row: row.clone(),
                records: folder.join("records.sqlite"),
                limits: Some(Limits::fixed(1 << 20, 1 << 30)),
                sign_in: raw.clone(),
            },
            Arc::new(NetLink { me: self.ids[at].clone(), net: self.net.clone() }),
            Arc::new(move || clock.load(Ordering::Acquire)),
        )
        .unwrap()
        .with_account_key(self.account.public_hex());
        let copies = if joining { copies.joining() } else { copies };
        let held = root.map(|secrets_key| {
            if !secrets_key::sealed_file(&folder).unwrap().exists() {
                secrets_key::write_sealed(&folder, secrets_key, &self.keys[at]).unwrap();
            }
            let held = secrets_key::open_sealed_with(&folder, &self.keys[at]).unwrap();
            assert_eq!(secrets_key::key_identity(&held).unwrap(), secrets_key::key_identity(secrets_key).unwrap(),
                "a restarted computer opens the same durable secrets key it was given");
            held
        });
        let copies = Arc::new(copies.with_secrets_key(self.keys[at].clone(), folder.clone(), held));
        view.attach(&copies);
        self.net.computers.lock().unwrap().insert(self.ids[at].clone(), copies.clone());
        let computer = Arc::new(Computer { id: self.ids[at].clone(), copies, view, raw, net: self.net.clone(), account_key: self.account.public_hex() });
        self.computers.lock().unwrap().insert(name, computer.clone());
        // Its session opens at the forwarder as soon as it starts.
        self.net.forwarder.live_for_test(&self.account.address(), &computer.id, Arc::new(Session(computer.clone())));
        computer
    }

    /// The owner's row edit at `computer` (the account routes' `sign-in:set-places`).
    pub(super) fn edit(&self, computer: &str, expected: u64, copy_keepers: &[&str], may_answer: &[&str], voters: &[&str]) -> Result<ComputersRow, super::Refused> {
        let change = Change { pursuit: None, expected_revision: expected, copy_keepers: self.ids_of(copy_keepers), may_answer: self.ids_of(may_answer),
            voters: self.ids_of(voters) };
        edit(&self.at(computer).store(), ACCOUNT, &Subject::Account(self.account.address()), &change, &self.account, &serde_json::Value::Null)
            .map(|row| row.value)
    }

    /// One second of the shared clock: each running computer's timer runs when its step is due (as `keep_copies` does),
    /// the forwarder learns the writer from the writer's messages it carries (its renewals and pages), and one read is
    /// routed and answered.
    pub(super) fn second(&self, step: &'static str, row: &str, record: &str) {
        let now = self.step();
        let answer = self.read(row, record);
        self.reads.lock().unwrap().push((now, step, answer));
    }

    /// One second of the shared clock with no read: each running computer's timer runs when its step is due, and never
    /// are two computers the writer at once. Answers the clock.
    pub(super) fn step(&self) -> i64 {
        let now = self.clock.fetch_add(READ_EVERY_MS, Ordering::AcqRel) + READ_EVERY_MS;
        let running: Vec<Arc<Computer>> = self.computers.lock().unwrap().values().cloned().collect();
        for computer in &running {
            if self.net.down.lock().unwrap().contains(&computer.id) || computer.copies.removed() {
                continue;
            }
            if computer.copies.next_step_ms() <= 0 {
                computer.copies.tick();
            }
        }
        let writers: Vec<&String> = running.iter().filter(|computer| computer.copies.holding().is_some()).map(|computer| &computer.id).collect();
        assert!(writers.len() <= 1, "two computers hold the writer role at once");
        now
    }

    /// One read as the forwarder carries it: the computer the forwarder chooses holds the account's row `row` in its own
    /// copy of the account's rows and reads the record from its own copy.
    pub(super) fn read(&self, row: &str, record: &str) -> Result<String, String> {
        let chosen = self.net.forwarder.chosen_for_test(&self.account.address()).ok_or("503: no computer answers")?;
        let computer = self.computers.lock().unwrap().values().find(|computer| computer.id == chosen).cloned().ok_or("no such computer")?;
        let name = NAMES[self.ids.iter().position(|id| *id == chosen).unwrap()];
        if !rows_copy::holds_list_row(&*computer.raw, row) {
            return Err(format!("missing at {name}: the account's row is not in its copy"));
        }
        match computer.copies.read(RESOURCE, record) {
            Ok(read) if read.record.is_some() => Ok(name.to_owned()),
            Ok(_) => Err(format!("404 at {name}: the record is not in its copy")),
            Err(error) => Err(format!("503 at {name}: {error:?}")),
        }
    }

    /// Seconds until `done` holds, at most `limit`, reading every second.
    pub(super) fn until(&self, step: &'static str, row: &str, record: &str, limit: usize, mut done: impl FnMut() -> bool) {
        for _ in 0..limit {
            if done() {
                return;
            }
            self.second(step, row, record);
        }
        assert!(done(), "{step}: not done within {limit} s");
    }

    /// `count` seconds, reading every second.
    pub(super) fn seconds(&self, step: &'static str, row: &str, record: &str, count: usize) {
        for _ in 0..count {
            self.second(step, row, record);
        }
    }

    pub(super) fn failed_reads(&self) -> Vec<(i64, &'static str, String)> {
        self.reads.lock().unwrap().iter().filter_map(|(at, step, answer)| answer.clone().err().map(|why| (*at, *step, why))).collect()
    }

    pub(super) fn answered_by(&self, step: &str) -> Vec<String> {
        self.reads.lock().unwrap().iter().filter(|(_, at, _)| *at == step).filter_map(|(_, _, answer)| answer.clone().ok()).collect()
    }
}

#[test]
fn an_account_moves_from_a_to_b_with_every_read_answered() {
    let world = World::new();
    let secrets_key = secrets_key::generate().unwrap();

    // The account lives at A alone: A holds, answers and is its only voter, and writes.
    let first = ComputersRow::sign_with_voters(&world.account.address(), 1, &world.ids_of(&["A"]), &world.ids_of(&["A"]),
        &world.ids_of(&["A"]), &world.account).unwrap();
    let a = world.start(0, &first, false, Some(&secrets_key));
    a.copies.tick();
    assert!(a.copies.holding().is_some(), "A writes for the account");
    a.write("note-1", "written at A before the move");
    a.store().insert(Family::Lists, &rows_copy::test_list_row(ACCOUNT, "door", "door")).unwrap();
    let record = "note-1";
    world.seconds("before", "door", record, 3);
    assert_eq!(world.answered_by("before").len(), 3, "A answers: {:?}", world.failed_reads());

    // 1. The owner names B a copy keeper that may answer (not a voter yet). A makes the edit as a rows change.
    let second = world.edit("A", 1, &["A", "B"], &["A", "B"], &["A"]).expect("the edit naming B lands at A");
    assert_eq!(second.revision, 2);
    // The row the reads need from here on, made at A while the move runs by another process, which writes A's rows
    // directly, never through A's copies (no log row is made for it there).
    a.raw_store().insert(Family::Lists, &rows_copy::test_list_row(ACCOUNT, "script", "script")).unwrap();
    let key = "script";
    // B starts as `computer join` leaves it: no account row but its key row and computers row, no record, and no root (no
    // `computer send-secrets-key`, the case that answered 503 for over 80 s).
    let b = world.start(1, &second, true, None);
    assert!(b.copies.read(RESOURCE, record).unwrap().record.is_none() && !b.copies.holds_secrets_key());
    assert!(!b.copies.answers_now(), "B takes no calls before it has caught up");
    // B joins on its first pull, before A's next step gives the row made outside its copies its log row (`copy_outside_changes`):
    // it has caught up once it holds that row too.
    world.until("b-catches-up", key, record, 30, || b.copies.joined() && b.copies.holds_secrets_key() && rows_copy::holds_list_row(&*b.raw, key));
    assert!(b.copies.read(RESOURCE, record).unwrap().record.is_some(), "B holds A's record");
    assert!(rows_copy::holds_list_row(&*b.raw, key), "B holds the row made at A outside its copies");
    assert_eq!(b.census(), a.census(), "B holds the same account rows as A, by count and identity");
    assert!(!b.copies.answers_now(), "B does not vote yet, so it takes no calls yet");
    assert!(world.answered_by("b-catches-up").iter().all(|name| name == "A"), "A answers while B catches up");

    // 2. The owner makes B a voter, once it has caught up (A refuses the edit until then).
    let mut third = None;
    world.until("b-votes", key, record, 30, || {
        third = third.take().or_else(|| world.edit("A", 2, &["A", "B"], &["A", "B"], &["A", "B"]).ok());
        third.is_some()
    });
    let third = third.unwrap();
    assert_eq!((third.revision, b.copies.row().revision), (3, 3), "the edit lands at A and at B");
    world.until("b-reads-back", key, record, 30, || b.copies.answers_now());

    // 3. The writer moves: the owner lets only B answer. A, no longer allowed to answer, gives the writer role up; B takes it.
    let mut fourth = None;
    world.until("writer-moves", key, record, 30, || {
        fourth = fourth.take().or_else(|| world.edit("A", 3, &["A", "B"], &["B"], &["A", "B"]).ok());
        fourth.is_some()
    });
    world.until("writer-moves", key, record, 60, || b.copies.holding().is_some());
    assert!(a.copies.holding().is_none() && !a.copies.answers_now());
    b.write("note-2", "written at B after the move");
    world.seconds("b-writes", key, "note-2", 3);
    assert_eq!(world.answered_by("b-writes"), vec!["B"; 3], "{:?}", world.failed_reads());

    // 4. A is removed: one voter step, made by B with A's word.
    let mut fifth = None;
    world.until("a-removed", key, record, 30, || {
        fifth = fifth.take().or_else(|| world.edit("B", 4, &["B"], &["B"], &["B"]).ok());
        fifth.is_some()
    });
    let fifth = fifth.unwrap();
    assert_eq!(fifth.revision, 5);
    world.until("a-removed", key, record, 30, || a.copies.removed());
    assert_eq!(b.copies.row(), fifth, "B holds the edited row");
    world.seconds("after", key, record, 10);
    assert_eq!(world.answered_by("after"), vec!["B"; 10]);

    // Not one read failed, through every step.
    let reads = world.reads.lock().unwrap().len();
    assert!(reads >= 20, "{reads} reads");
    assert_eq!(world.failed_reads(), Vec::new(), "every read is answered ({reads} reads)");
    let _ = settings();
}

/// The measured case of the 503s: the owner names A and B voters at once (an account with no voters may start with
/// any), B is not sent the root, and the account's rows were made at A by another process and not changed at A meanwhile
/// (so nothing at A logs them). Before: no computer was ahead of B on the account's rows (A had not claimed, so had
/// logged none), so B made no rows pull and the root never came; B could not count as caught up without it, so never
/// voted, and A could not claim without B's vote: nobody answered (503 for over 80 s). And a row made at the writer
/// outside its copies never travelled. Now B asks for the root, catches up and votes, A claims, and every account row
/// reaches B, a row made at A after A took the writer role included.
#[test]
fn a_computer_named_a_voter_at_once_without_the_root_joins_and_gets_every_account_row() {
    let world = World::new();
    let secrets_key = secrets_key::generate().unwrap();
    let both = world.ids_of(&["A", "B"]);
    let row = ComputersRow::sign_with_voters(&world.account.address(), 2, &both, &both, &both, &world.account).unwrap();
    let a = world.start(0, &row, false, Some(&secrets_key));
    a.raw_store().insert(Family::Lists, &rows_copy::test_list_row(ACCOUNT, "before", "before")).unwrap();
    let made_before = "before";
    let b = world.start(1, &row, true, None);
    for _ in 0..60 {
        if b.copies.joined() && b.copies.holds_secrets_key() && a.copies.holding().is_some() && b.copies.answers_now() {
            break;
        }
        world.second("join", made_before, "none");
    }
    assert!(b.copies.holds_secrets_key(), "B was given the root on a rows pull, with no `computer send-secrets-key`");
    assert!(b.copies.joined() && (a.copies.holding().is_some() || b.copies.holding().is_some()), "B caught up and voted, and one of them took the writer role");
    assert!(b.copies.answers_now(), "B's account rows read back the same as A's");
    assert!(rows_copy::holds_list_row(&*b.raw, made_before));

    // A row made at the writer outside its copies after it took the writer role, never changed at A: it reaches B.
    a.raw_store().insert(Family::Lists, &rows_copy::test_list_row(ACCOUNT, "after", "after")).unwrap();
    for _ in 0..10 {
        world.second("after", made_before, "none");
    }
    assert!(rows_copy::holds_list_row(&*b.raw, "after"), "the row made at A outside its copies reached B");
    assert_eq!(b.census(), a.census(), "B holds the same account rows as A, by count and identity");
}

#[test]
fn a_sole_voters_read_claims_no_turn_and_its_first_write_takes_it() {
    let world = World::new();
    let secrets_key = secrets_key::generate().unwrap();
    let first = ComputersRow::sign_with_voters(&world.account.address(), 1, &world.ids_of(&["A"]), &world.ids_of(&["A"]),
        &world.ids_of(&["A"]), &world.account).unwrap();
    let a = world.start(0, &first, false, Some(&secrets_key));
    // A read reaches the account on the request path: it is answered, and it claims nothing (the timer and the write claim).
    a.copies.wake();
    assert!(a.copies.holding().is_none(), "a read on the request path claims no writer turn");
    // The first write is refused without the turn and asks the timer for it; the timer's next pass takes it, and the write lands.
    let mutation = Mutation { id: "note-1".to_owned(), expected_version: 0, request_key: "write-note-1".to_owned(), deleted: false,
        value: json!({"kind": "note", "text": "the first write takes the turn"}) };
    let first_write = || a.copies.write(|store| store.mutate_local_with_check(OWNER, RESOURCE, mutation.clone(), || Ok(())));
    assert!(first_write().is_err(), "a write without the turn is refused");
    a.copies.tick();
    assert!(a.copies.holding().is_some(), "the timer takes the writer turn the write asked for");
    assert!(first_write().is_ok(), "the write lands once the turn is held");
}
